import { createHash } from "node:crypto";
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import {
  CODEX_APP_SERVER_WRITABLE_VERSIONS,
  WebSocketDuplexTransport,
  type CodexAppServerTransport,
  type CodexEndpointCompatibilityAttestation,
  type SocketCompatibleDuplex,
  type WebSocketDuplexTransportOptions,
} from "./codex-app-server.js";
import {
  sharesCompatibilityMajor,
  type CompatibilityPolicy,
} from "./compatibility.js";

const APP_SERVER_CONTROL_DIRECTORY = "app-server-control";
const APP_SERVER_CONTROL_SOCKET = "app-server-control.sock";
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_SPAWN_TIMEOUT_MS = 5_000;
const DEFAULT_GRACEFUL_EXIT_MS = 2_000;
const DEFAULT_SIGNAL_TIMEOUT_MS = 750;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;

export type LocalCodexTransportErrorCode =
  | "HOME_INVALID"
  | "MANAGED_CODEX_UNAVAILABLE"
  | "MANAGED_CODEX_INVALID"
  | "LOCAL_APP_SERVER_NOT_RUNNING"
  | "LOCAL_APP_SERVER_ENDPOINT_UNSAFE"
  | "APP_SERVER_VERSION_MISMATCH"
  | "ENDPOINT_GENERATION_CHANGED"
  | "SPAWN_FAILED"
  | "SPAWN_TIMEOUT"
  | "PROXY_STDERR_LIMIT"
  | "TRANSPORT_CONNECT_FAILED"
  | "CLEANUP_FAILED"
  | "FACTORY_CLOSED"
  | "INVALID_CONFIGURATION";

export class LocalCodexTransportError extends Error {
  readonly code: LocalCodexTransportErrorCode;

  constructor(code: LocalCodexTransportErrorCode) {
    super(code);
    this.name = "LocalCodexTransportError";
    this.code = code;
  }
}

export type ManagedLocalCodexInstallation = {
  appServerVersion: string;
  binaryPath: string;
  controlSocketPath: string;
  endpointGeneration: string;
  home: string;
};

export type ManagedCodexRuntimeTarget = {
  platform: string;
  architecture: string;
};

export type LocalCodexTransportFactoryOptions = {
  /** Reviewed installed App Server schema/version. Never inferred from stdout. */
  appServerVersion: string;
  compatibilityPolicy?: CompatibilityPolicy;
  environment?: NodeJS.ProcessEnv;
  gracefulExitMs?: number;
  hostId?: string;
  maxStderrBytes?: number;
  signalTimeoutMs?: number;
  spawnTimeoutMs?: number;
  webSocket?: WebSocketDuplexTransportOptions;
  /** Must remain false until the separate writable fanout/schema gate passes. */
  writableProtocolAttested?: boolean;
};

type ProxyChild = Pick<
  ChildProcessWithoutNullStreams,
  | "exitCode"
  | "kill"
  | "off"
  | "on"
  | "once"
  | "pid"
  | "signalCode"
  | "stderr"
  | "stdin"
  | "stdout"
>;

type SpawnProxy = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ProxyChild;

type KillProcess = (
  pid: number,
  signal?: NodeJS.Signals | number,
) => true;

export type LocalCodexTransportDependencies = {
  connectWebSocket?: (
    stream: SocketCompatibleDuplex,
    options: WebSocketDuplexTransportOptions,
  ) => Promise<CodexAppServerTransport>;
  killProcess?: KillProcess;
  loginHome?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  spawn?: SpawnProxy;
};

export type LocalCodexOwnedTransport = CodexAppServerTransport & {
  readonly cleanupConfirmed: boolean;
};

declare const localCodexSchemaCompatibilityBrand: unique symbol;
declare const localCodexWriteCompatibilityBrand: unique symbol;

export type LocalCodexSchemaCompatibilityAttestation =
  CodexEndpointCompatibilityAttestation & {
    readonly [localCodexSchemaCompatibilityBrand]: true;
  };

export type LocalCodexWriteCompatibilityAttestation =
  CodexEndpointCompatibilityAttestation & {
    readonly [localCodexWriteCompatibilityBrand]: true;
  };

export type LocalCodexTransportFactory = {
  readonly appServerVersion: string;
  readonly compatibilityPolicy: CompatibilityPolicy;
  /** Exact reviewed monitor schema; this does not authorize a turn write. */
  readonly schemaCompatibility: LocalCodexSchemaCompatibilityAttestation;
  /** Null until the separate writable notification/fanout gate is attested. */
  readonly writeCompatibility: LocalCodexWriteCompatibilityAttestation | null;
  readonly endpointGeneration: string;
  readonly hostId: string;
  readonly protocol: "codex-app-server";
  readonly protocolVersion: string;
  /** False in this build until the explicit writable notification gate runs. */
  readonly writableReady: boolean;
  close: () => Promise<void>;
  connectTransport: () => Promise<LocalCodexOwnedTransport>;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new LocalCodexTransportError("INVALID_CONFIGURATION");
  }
  return candidate;
}

export function validateLocalCodexHome(
  suppliedHome: string | undefined,
  loginHome: string,
): string {
  const valid = (value: string): boolean =>
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.parse(value).root !== value;
  if (!valid(suppliedHome ?? "") || !valid(loginHome) || suppliedHome !== loginHome) {
    throw new LocalCodexTransportError("HOME_INVALID");
  }
  return loginHome;
}

export function buildLocalCodexProxyEnvironment(
  home: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: path.join(home, ".codex"),
    HOME: home,
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of ["USER", "LOGNAME"] as const) {
    const value = source[key];
    if (
      value !== undefined &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes("\0") &&
      !/[\r\n]/.test(value)
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

function assertOwnedPrivate(
  metadata: { mode: number; uid: number },
  exactMode: number | undefined,
): void {
  const uid = process.getuid?.();
  if (
    (uid !== undefined && metadata.uid !== uid) ||
    (exactMode === undefined
      ? (metadata.mode & 0o022) !== 0
      : (metadata.mode & 0o777) !== exactMode)
  ) {
    throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
  }
}

function managedCodexTargetTriple(
  target: ManagedCodexRuntimeTarget,
): string | undefined {
  if (target.platform !== "darwin") return undefined;
  if (target.architecture === "arm64") return "aarch64-apple-darwin";
  if (target.architecture === "x64") return "x86_64-apple-darwin";
  return undefined;
}

async function resolveObservedManagedLocalCodexInstallation(
  home: string,
  certifiedVersion: string,
  runtimeTarget: ManagedCodexRuntimeTarget,
): Promise<ManagedLocalCodexInstallation> {
  const currentLink = path.join(
    home,
    ".codex",
    "packages",
    "standalone",
    "current",
  );
  let releaseLeaf: string;
  try {
    releaseLeaf = path.basename(await realpath(currentLink));
  } catch {
    throw new LocalCodexTransportError("MANAGED_CODEX_UNAVAILABLE");
  }
  const targetTriple = managedCodexTargetTriple(runtimeTarget);
  const observedVersion =
    targetTriple !== undefined && releaseLeaf.endsWith(`-${targetTriple}`)
      ? releaseLeaf.slice(0, -1 - targetTriple.length)
      : releaseLeaf;
  if (!sharesCompatibilityMajor(certifiedVersion, observedVersion)) {
    throw new LocalCodexTransportError("APP_SERVER_VERSION_MISMATCH");
  }
  return await resolveManagedLocalCodexInstallation(
    home,
    observedVersion,
    runtimeTarget,
  );
}

export async function resolveManagedLocalCodexInstallation(
  home: string,
  appServerVersion: string,
  runtimeTarget: ManagedCodexRuntimeTarget = {
    platform: process.platform,
    architecture: process.arch,
  },
): Promise<ManagedLocalCodexInstallation> {
  if (!VERSION_PATTERN.test(appServerVersion)) {
    throw new LocalCodexTransportError("INVALID_CONFIGURATION");
  }
  const standalone = path.join(home, ".codex", "packages", "standalone");
  const currentLink = path.join(standalone, "current");
  const releasesDirectory = path.join(standalone, "releases");
  const currentBinary = path.join(currentLink, "codex");
  let resolvedReleases: string;
  let resolvedCurrent: string;
  let resolvedBinary: string;
  try {
    const releasesMetadata = await lstat(releasesDirectory);
    const currentMetadata = await lstat(currentLink);
    if (!releasesMetadata.isDirectory() || !currentMetadata.isSymbolicLink()) {
      throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
    }
    assertOwnedPrivate(releasesMetadata, undefined);
    if (
      typeof process.getuid === "function" &&
      currentMetadata.uid !== process.getuid()
    ) {
      throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
    }
    resolvedReleases = await realpath(releasesDirectory);
    resolvedCurrent = await realpath(currentLink);
    resolvedBinary = await realpath(currentBinary);
  } catch (error) {
    if (error instanceof LocalCodexTransportError) throw error;
    throw new LocalCodexTransportError("MANAGED_CODEX_UNAVAILABLE");
  }
  const releasesPrefix = `${resolvedReleases}${path.sep}`;
  const currentPrefix = `${resolvedCurrent}${path.sep}`;
  if (
    !resolvedCurrent.startsWith(releasesPrefix) ||
    path.dirname(resolvedCurrent) !== resolvedReleases ||
    !resolvedBinary.startsWith(currentPrefix)
  ) {
    throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
  }
  // Managed packages use either the version alone or the version plus the
  // exact target triple for this runtime. Never accept a caller-invented
  // suffix or a binary for a different architecture.
  const targetTriple = managedCodexTargetTriple(runtimeTarget);
  const allowedReleaseLeaves = new Set([
    appServerVersion,
    ...(targetTriple === undefined
      ? []
      : [`${appServerVersion}-${targetTriple}`]),
  ]);
  const releaseLeaf = path.basename(resolvedCurrent);
  if (!allowedReleaseLeaves.has(releaseLeaf)) {
    throw new LocalCodexTransportError("APP_SERVER_VERSION_MISMATCH");
  }

  let binaryMetadata;
  try {
    const releaseMetadata = await lstat(resolvedCurrent);
    if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
      throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
    }
    assertOwnedPrivate(releaseMetadata, undefined);
    binaryMetadata = await stat(resolvedBinary);
    if (!binaryMetadata.isFile()) {
      throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
    }
    assertOwnedPrivate(binaryMetadata, undefined);
    await access(resolvedBinary, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof LocalCodexTransportError) throw error;
    throw new LocalCodexTransportError("MANAGED_CODEX_INVALID");
  }

  const controlDirectory = path.join(
    home,
    ".codex",
    APP_SERVER_CONTROL_DIRECTORY,
  );
  const controlSocketPath = path.join(
    controlDirectory,
    APP_SERVER_CONTROL_SOCKET,
  );
  let socketMetadata;
  try {
    const directoryMetadata = await lstat(controlDirectory);
    socketMetadata = await lstat(controlSocketPath);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      socketMetadata.isSymbolicLink() ||
      !socketMetadata.isSocket()
    ) {
      throw new LocalCodexTransportError("LOCAL_APP_SERVER_ENDPOINT_UNSAFE");
    }
    assertOwnedPrivate(directoryMetadata, 0o700);
    assertOwnedPrivate(socketMetadata, 0o600);
  } catch (error) {
    if (error instanceof LocalCodexTransportError) {
      if (error.code === "MANAGED_CODEX_INVALID") {
        throw new LocalCodexTransportError("LOCAL_APP_SERVER_ENDPOINT_UNSAFE");
      }
      throw error;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new LocalCodexTransportError("LOCAL_APP_SERVER_NOT_RUNNING");
    }
    throw new LocalCodexTransportError("LOCAL_APP_SERVER_ENDPOINT_UNSAFE");
  }
  const endpointGeneration = `local_${createHash("sha256")
    .update(appServerVersion)
    .update("\0")
    .update(releaseLeaf)
    .update("\0")
    .update(String(binaryMetadata.dev))
    .update(":")
    .update(String(binaryMetadata.ino))
    .update(":")
    .update(String(binaryMetadata.size))
    .update(":")
    .update(String(binaryMetadata.birthtimeMs))
    .update(":")
    .update(String(binaryMetadata.ctimeMs))
    .update("\0")
    .update(String(socketMetadata.dev))
    .update(":")
    .update(String(socketMetadata.ino))
    .update(":")
    .update(String(socketMetadata.birthtimeMs))
    .update(":")
    .update(String(socketMetadata.ctimeMs))
    .digest("hex")
    .slice(0, 32)}`;
  return {
    appServerVersion,
    binaryPath: resolvedBinary,
    controlSocketPath,
    endpointGeneration,
    home,
  };
}

class ChildProxyDuplex extends Duplex implements SocketCompatibleDuplex {
  constructor(private readonly child: ProxyChild) {
    super();
    this.on("error", () => undefined);
    child.stdout.pause();
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.on("end", () => this.push(null));
    child.stdout.on("error", () =>
      this.destroy(new LocalCodexTransportError("TRANSPORT_CONNECT_FAILED")),
    );
    child.stdin.on("error", () =>
      this.destroy(new LocalCodexTransportError("TRANSPORT_CONNECT_FAILED")),
    );
    child.on("error", () =>
      this.destroy(new LocalCodexTransportError("SPAWN_FAILED")),
    );
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.child.stdin.writable) {
      callback(new LocalCodexTransportError("TRANSPORT_CONNECT_FAILED"));
      return;
    }
    this.child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    callback(error);
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }
}

function waitForSpawn(child: ProxyChild, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: LocalCodexTransportError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onError = () => finish(new LocalCodexTransportError("SPAWN_FAILED"));
    const timer = setTimeout(
      () => finish(new LocalCodexTransportError("SPAWN_TIMEOUT")),
      timeoutMs,
    );
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function groupExists(processGroupId: number, killProcess: KillProcess): boolean {
  try {
    killProcess(-processGroupId, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error && "code" in error && error.code === "ESRCH"
    );
  }
}

async function waitForGroupGone(
  processGroupId: number,
  timeoutMs: number,
  killProcess: KillProcess,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(processGroupId, killProcess)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

function waitForChildClose(child: ProxyChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

export async function terminateOwnedLocalProxy(
  child: ProxyChild,
  processGroupId: number,
  options: {
    gracefulExitMs: number;
    killProcess?: KillProcess;
    signalTimeoutMs: number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<boolean> {
  if (
    child.pid !== processGroupId ||
    processGroupId <= 1 ||
    processGroupId === process.pid
  ) {
    return false;
  }
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  child.stdin.end();
  let groupGone = await waitForGroupGone(
    processGroupId,
    options.gracefulExitMs,
    killProcess,
    sleep,
  );
  if (!groupGone) {
    try {
      killProcess(-processGroupId, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        return false;
      }
    }
    groupGone = await waitForGroupGone(
      processGroupId,
      options.signalTimeoutMs,
      killProcess,
      sleep,
    );
  }
  if (!groupGone) {
    try {
      killProcess(-processGroupId, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        return false;
      }
    }
    groupGone = await waitForGroupGone(
      processGroupId,
      options.signalTimeoutMs,
      killProcess,
      sleep,
    );
  }
  const childClosed = await waitForChildClose(child, options.signalTimeoutMs);
  return groupGone && childClosed;
}

class OwnedTransport implements LocalCodexOwnedTransport {
  private closePromise: Promise<void> | undefined;
  cleanupConfirmed = false;

  constructor(
    private readonly delegate: CodexAppServerTransport,
    private readonly child: ProxyChild,
    private readonly stream: ChildProxyDuplex,
    private readonly cleanup: () => Promise<boolean>,
    private readonly onFinished: (cleanupConfirmed: boolean) => void,
  ) {
    delegate.onClose(() => {
      void this.close().catch(() => undefined);
    });
    delegate.onError(() => {
      void this.close().catch(() => undefined);
    });
  }

  send(payload: string): Promise<void> {
    return this.delegate.send(payload);
  }

  onMessage(listener: (payload: string) => void): () => void {
    return this.delegate.onMessage(listener);
  }

  onClose(listener: () => void): () => void {
    return this.delegate.onClose(listener);
  }

  onError(listener: () => void): () => void {
    return this.delegate.onError(listener);
  }

  close(): Promise<void> {
    // Defer closeOnce until after closePromise is assigned so a synchronous
    // delegate close callback cannot re-enter cleanup.
    this.closePromise ??= Promise.resolve().then(() => this.closeOnce());
    return this.closePromise;
  }

  failClosed(): void {
    this.stream.destroy(new LocalCodexTransportError("PROXY_STDERR_LIMIT"));
    void this.close();
  }

  private async closeOnce(): Promise<void> {
    try {
      await this.delegate.close().catch(() => undefined);
      this.stream.end();
      this.cleanupConfirmed = await this.cleanup();
      if (!this.cleanupConfirmed) {
        throw new LocalCodexTransportError("CLEANUP_FAILED");
      }
    } finally {
      this.child.stderr.destroy();
      this.onFinished(this.cleanupConfirmed);
    }
  }
}

class Factory implements LocalCodexTransportFactory {
  readonly protocol = "codex-app-server" as const;
  readonly protocolVersion: string;
  readonly schemaCompatibility: LocalCodexSchemaCompatibilityAttestation;
  readonly writeCompatibility: LocalCodexWriteCompatibilityAttestation | null;
  readonly endpointGeneration: string;
  readonly appServerVersion: string;
  readonly compatibilityPolicy: CompatibilityPolicy;
  readonly hostId: string;
  readonly writableReady: boolean;
  private closed = false;
  private readonly active = new Set<OwnedTransport>();

  constructor(
    private readonly installation: ManagedLocalCodexInstallation,
    private readonly options: Required<
      Pick<
        LocalCodexTransportFactoryOptions,
        | "gracefulExitMs"
        | "maxStderrBytes"
        | "signalTimeoutMs"
        | "spawnTimeoutMs"
      >
    > &
      LocalCodexTransportFactoryOptions,
    private readonly dependencies: Required<LocalCodexTransportDependencies>,
  ) {
    this.endpointGeneration = installation.endpointGeneration;
    this.appServerVersion = installation.appServerVersion;
    this.compatibilityPolicy = options.compatibilityPolicy ?? "strict";
    this.protocolVersion = installation.appServerVersion;
    this.hostId = options.hostId ?? "this-mac";
    this.writableReady = options.writableProtocolAttested === true;
    const compatibility = {
      appServerVersion: this.appServerVersion,
      endpointGeneration: this.endpointGeneration,
      protocol: "app-server-v2-stable" as const,
      ...(CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
        this.appServerVersion as (typeof CODEX_APP_SERVER_WRITABLE_VERSIONS)[number],
      )
        ? {}
        : { observedSchemaCandidate: true as const }),
      steering: {
        method: "turn/steer" as const,
        requestSchema: "expected-turn-id-text-v1" as const,
        deliveryBoundary: "next-tool-call-boundary" as const,
      },
    };
    this.schemaCompatibility =
      compatibility as LocalCodexSchemaCompatibilityAttestation;
    this.writeCompatibility = this.writableReady
      ? (compatibility as LocalCodexWriteCompatibilityAttestation)
      : null;
  }

  async connectTransport(): Promise<LocalCodexOwnedTransport> {
    if (this.closed) throw new LocalCodexTransportError("FACTORY_CLOSED");
    const current = await resolveManagedLocalCodexInstallation(
      this.installation.home,
      this.installation.appServerVersion,
    );
    if (
      current.endpointGeneration !== this.installation.endpointGeneration ||
      current.binaryPath !== this.installation.binaryPath
    ) {
      throw new LocalCodexTransportError("ENDPOINT_GENERATION_CHANGED");
    }
    let child: ProxyChild;
    try {
      child = this.dependencies.spawn(
        this.installation.binaryPath,
        ["app-server", "proxy"],
        {
          cwd: path.parse(this.installation.home).root,
          detached: true,
          env: buildLocalCodexProxyEnvironment(
            this.installation.home,
            this.options.environment ?? process.env,
          ),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new LocalCodexTransportError("SPAWN_FAILED");
    }
    const processGroupId = child.pid;
    if (
      processGroupId === undefined ||
      processGroupId <= 1 ||
      processGroupId === process.pid
    ) {
      child.kill("SIGKILL");
      throw new LocalCodexTransportError("SPAWN_FAILED");
    }
    const stream = new ChildProxyDuplex(child);
    let stderrBytes = 0;
    let owned: OwnedTransport | undefined;
    let stderrExceeded = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (!stderrExceeded && stderrBytes > this.options.maxStderrBytes) {
        stderrExceeded = true;
        if (owned) owned.failClosed();
        else stream.destroy(new LocalCodexTransportError("PROXY_STDERR_LIMIT"));
      }
    });
    const cleanup = () =>
      terminateOwnedLocalProxy(child, processGroupId, {
        gracefulExitMs: this.options.gracefulExitMs,
        killProcess: this.dependencies.killProcess,
        signalTimeoutMs: this.options.signalTimeoutMs,
        sleep: this.dependencies.sleep,
      });
    let connectedTransport: CodexAppServerTransport | undefined;
    try {
      await waitForSpawn(child, this.options.spawnTimeoutMs);
      if (stderrExceeded) {
        throw new LocalCodexTransportError("PROXY_STDERR_LIMIT");
      }
      connectedTransport = await this.dependencies.connectWebSocket(
        stream,
        this.options.webSocket ?? {},
      );
      if (stderrExceeded) {
        throw new LocalCodexTransportError("PROXY_STDERR_LIMIT");
      }
      // The managed release or already-running App Server endpoint may be
      // replaced while the proxy handshake is in flight. Re-attest after the
      // handshake and never return a transport bound across generations.
      const postHandshake = await resolveManagedLocalCodexInstallation(
        this.installation.home,
        this.installation.appServerVersion,
      );
      if (
        postHandshake.endpointGeneration !==
          this.installation.endpointGeneration ||
        postHandshake.binaryPath !== this.installation.binaryPath
      ) {
        throw new LocalCodexTransportError("ENDPOINT_GENERATION_CHANGED");
      }
      if (stderrExceeded) {
        throw new LocalCodexTransportError("PROXY_STDERR_LIMIT");
      }
      owned = new OwnedTransport(
        connectedTransport,
        child,
        stream,
        cleanup,
        (cleanupConfirmed) => {
          if (owned && cleanupConfirmed) this.active.delete(owned);
        },
      );
      this.active.add(owned);
      return owned;
    } catch (error) {
      await connectedTransport?.close().catch(() => undefined);
      stream.destroy();
      const cleaned = await cleanup();
      child.stderr.destroy();
      if (!cleaned) throw new LocalCodexTransportError("CLEANUP_FAILED");
      if (error instanceof LocalCodexTransportError) throw error;
      throw new LocalCodexTransportError("TRANSPORT_CONNECT_FAILED");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.active].map((transport) => transport.close()),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new LocalCodexTransportError("CLEANUP_FAILED");
    }
  }
}

async function createLocalCodexTransportFactoryForResolution(
  options: LocalCodexTransportFactoryOptions,
  dependencies: LocalCodexTransportDependencies,
  resolution: "startup" | "refresh_candidate",
): Promise<LocalCodexTransportFactory> {
  if (
    !VERSION_PATTERN.test(options.appServerVersion) ||
    !HOST_PATTERN.test(options.hostId ?? "this-mac")
  ) {
    throw new LocalCodexTransportError("INVALID_CONFIGURATION");
  }
  const source = options.environment ?? process.env;
  const loginHome = (dependencies.loginHome ?? (() => userInfo().homedir))();
  const home = validateLocalCodexHome(source.HOME, loginHome);
  const runtimeTarget = {
    platform: process.platform,
    architecture: process.arch,
  };
  let installation: ManagedLocalCodexInstallation;
  try {
    installation = await resolveManagedLocalCodexInstallation(
      home,
      options.appServerVersion,
      runtimeTarget,
    );
  } catch (error) {
    if (
      (resolution !== "refresh_candidate" &&
        options.compatibilityPolicy !== "observed") ||
      !(error instanceof LocalCodexTransportError) ||
      error.code !== "APP_SERVER_VERSION_MISMATCH"
    ) {
      throw error;
    }
    installation = await resolveObservedManagedLocalCodexInstallation(
      home,
      options.appServerVersion,
      runtimeTarget,
    );
  }
  const normalizedOptions = {
    ...options,
    gracefulExitMs: positiveInteger(
      options.gracefulExitMs,
      DEFAULT_GRACEFUL_EXIT_MS,
    ),
    maxStderrBytes: positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
    ),
    signalTimeoutMs: positiveInteger(
      options.signalTimeoutMs,
      DEFAULT_SIGNAL_TIMEOUT_MS,
    ),
    spawnTimeoutMs: positiveInteger(
      options.spawnTimeoutMs,
      DEFAULT_SPAWN_TIMEOUT_MS,
    ),
  };
  const normalizedDependencies: Required<LocalCodexTransportDependencies> = {
    connectWebSocket:
      dependencies.connectWebSocket ?? WebSocketDuplexTransport.connect,
    killProcess: dependencies.killProcess ?? process.kill.bind(process),
    loginHome: dependencies.loginHome ?? (() => userInfo().homedir),
    sleep:
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    spawn:
      dependencies.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams),
  };
  return new Factory(
    installation,
    normalizedOptions,
    normalizedDependencies,
  );
}

/**
 * Resolve the startup factory under the configured admission policy. Strict
 * startup remains pinned to the exact reviewed build; observed startup may
 * inspect a same-major schema candidate before the provider admits it.
 */
export async function createLocalCodexTransportFactory(
  options: LocalCodexTransportFactoryOptions,
  dependencies: LocalCodexTransportDependencies = {},
): Promise<LocalCodexTransportFactory> {
  return await createLocalCodexTransportFactoryForResolution(
    options,
    dependencies,
    "startup",
  );
}

/**
 * Resolve only a replacement endpoint candidate after an already-admitted
 * factory reports a generation change. This narrow path may inspect the
 * currently installed same-major numeric build even under strict policy so
 * the provider can run its four read-only probes and record an incompatible
 * attestation. It does not relax normal startup admission or provider writes.
 */
export async function createLocalCodexRefreshCandidateTransportFactory(
  options: LocalCodexTransportFactoryOptions,
  dependencies: LocalCodexTransportDependencies = {},
): Promise<LocalCodexTransportFactory> {
  return await createLocalCodexTransportFactoryForResolution(
    options,
    dependencies,
    "refresh_candidate",
  );
}
