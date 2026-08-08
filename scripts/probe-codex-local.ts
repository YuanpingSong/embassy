import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

const AUTHORIZATION_ENV = "EMBASSY_RUN_CODEX_LOCAL_PROBE";
const THREAD_ID_ENV = "CODEX_THREAD_ID";

const MAX_PROXY_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_STDERR_BYTES = 64 * 1024;
const MAX_PROTOCOL_MESSAGES = 256;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const TERMINATE_TIMEOUT_MS = 750;

type ErrorCode =
  | "PROBE_NOT_AUTHORIZED"
  | "CURRENT_THREAD_UNAVAILABLE"
  | "HOME_INVALID"
  | "MANAGED_CODEX_UNAVAILABLE"
  | "MANAGED_CODEX_INVALID"
  | "SPAWN_FAILED"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "WEBSOCKET_UPGRADE_REJECTED"
  | "WEBSOCKET_PROTOCOL_ERROR"
  | "INITIALIZE_REJECTED"
  | "LIST_INVALID_PARAMS"
  | "LIST_METHOD_UNAVAILABLE"
  | "LIST_REJECTED"
  | "LIST_SCHEMA_MISMATCH"
  | "CURRENT_TASK_NOT_LOADED"
  | "CLEANUP_FAILED";

type CleanupMode = "forced" | "graceful" | "not_started" | "unconfirmed";

type ProbeResult = {
  cleanupConfirmed: boolean;
  cleanupMode: CleanupMode;
  connected: boolean;
  currentTaskLoaded: boolean;
  loadedListValidated: boolean;
  loadedThreadCount: number | null;
} & (
  | {
      ok: true;
    }
  | {
      code: ErrorCode;
      ok: false;
    }
);

type ProtocolObservation = {
  currentTaskLoaded: boolean;
  loadedThreadCount: number;
};

class SafeProbeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "SafeProbeError";
    this.code = code;
  }
}

export function managedCodexBinaryPath(home: string): string {
  return path.join(home, ".codex", "packages", "standalone", "current", "codex");
}

export function validateLocalProbeHome(
  suppliedHome: string | undefined,
  loginHome: string,
): string {
  const home = suppliedHome ?? "";
  if (
    home.length === 0 ||
    home.length > 4_096 ||
    home.includes("\0") ||
    !path.isAbsolute(home) ||
    path.normalize(home) !== home ||
    path.parse(home).root === home ||
    loginHome.length === 0 ||
    loginHome.length > 4_096 ||
    loginHome.includes("\0") ||
    !path.isAbsolute(loginHome) ||
    path.normalize(loginHome) !== loginHome ||
    path.parse(loginHome).root === loginHome ||
    home !== loginHome
  ) {
    throw new SafeProbeError("HOME_INVALID");
  }
  return home;
}

function validateHome(source: NodeJS.ProcessEnv): string {
  let loginHome: string;
  try {
    // Unlike os.homedir(), userInfo() is backed by the OS account database and
    // does not prefer a caller-selected HOME environment variable.
    loginHome = userInfo().homedir;
  } catch {
    throw new SafeProbeError("HOME_INVALID");
  }
  return validateLocalProbeHome(source.HOME, loginHome);
}

function readAuthorizedThreadId(source: NodeJS.ProcessEnv): string {
  if (source[AUTHORIZATION_ENV] !== "1") {
    throw new SafeProbeError("PROBE_NOT_AUTHORIZED");
  }
  const threadId = source[THREAD_ID_ENV] ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      threadId,
    )
  ) {
    throw new SafeProbeError("CURRENT_THREAD_UNAVAILABLE");
  }
  return threadId;
}

export function buildLocalProbeChildEnvironment(
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
    if (value !== undefined && value.length > 0 && value.length <= 256) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function validateManagedCodexBinary(home: string): Promise<string> {
  const binary = managedCodexBinaryPath(home);
  const currentLink = path.join(
    home,
    ".codex",
    "packages",
    "standalone",
    "current",
  );
  const releasesDirectory = path.join(
    home,
    ".codex",
    "packages",
    "standalone",
    "releases",
  );

  let resolvedBinary: string;
  let resolvedCurrent: string;
  let resolvedReleasesDirectory: string;
  try {
    const releasesMetadata = await lstat(releasesDirectory);
    const currentMetadata = await lstat(currentLink);
    if (!releasesMetadata.isDirectory() || !currentMetadata.isSymbolicLink()) {
      throw new SafeProbeError("MANAGED_CODEX_INVALID");
    }
    resolvedReleasesDirectory = await realpath(releasesDirectory);
    resolvedCurrent = await realpath(currentLink);
    resolvedBinary = await realpath(binary);
  } catch (error) {
    if (error instanceof SafeProbeError) throw error;
    throw new SafeProbeError("MANAGED_CODEX_UNAVAILABLE");
  }

  const releasesPrefix = `${resolvedReleasesDirectory}${path.sep}`;
  const currentPrefix = `${resolvedCurrent}${path.sep}`;
  if (
    !resolvedCurrent.startsWith(releasesPrefix) ||
    !resolvedBinary.startsWith(currentPrefix)
  ) {
    throw new SafeProbeError("MANAGED_CODEX_INVALID");
  }

  try {
    const metadata = await stat(resolvedBinary);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (currentUid !== undefined && metadata.uid !== currentUid) ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new SafeProbeError("MANAGED_CODEX_INVALID");
    }
    await access(resolvedBinary, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof SafeProbeError) throw error;
    throw new SafeProbeError("MANAGED_CODEX_INVALID");
  }

  // Spawn the immutable versioned path observed above. A concurrent change to
  // the mutable `current` symlink therefore cannot redirect execution after
  // validation.
  return resolvedBinary;
}

class BoundedChildDuplex extends Duplex {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBytes = 0;
  failureCode: ErrorCode | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    super();
    this.child = child;
    // WebSocket installs its own error handler immediately after this stream is
    // created. This sink also makes a same-tick child failure non-fatal.
    this.on("error", () => undefined);

    child.stdout.pause();
    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > MAX_PROXY_STDOUT_BYTES) {
        this.failureCode = "OUTPUT_LIMIT";
        this.destroy(new SafeProbeError("OUTPUT_LIMIT"));
        return;
      }
      if (!this.push(chunk)) {
        child.stdout.pause();
      }
    });
    child.stdout.on("end", () => this.push(null));
    child.stdout.on("error", () => {
      this.destroy(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    });
    child.stdin.on("error", () => {
      this.destroy(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    });
    child.on("error", () => {
      this.destroy(new SafeProbeError("SPAWN_FAILED"));
    });
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
      callback(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
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
    if (callback !== undefined) this.once("timeout", callback);
    return this;
  }
}

export function buildLocalInitializeRequest(): string {
  return JSON.stringify({
    id: 0,
    method: "initialize",
    params: {
      clientInfo: {
        name: "agent_embassy_local_probe",
        title: "Embassy Local Probe",
        version: "1.0.0",
      },
    },
  });
}

export function buildLocalInitializedNotification(): string {
  return JSON.stringify({ method: "initialized", params: {} });
}

export function buildLocalLoadedThreadListRequest(): string {
  return JSON.stringify({
    id: 1,
    method: "thread/loaded/list",
    params: {},
  });
}

function classifyLoadedThreadListError(error: unknown): ErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === -32601) return "LIST_METHOD_UNAVAILABLE";
    if (error.code === -32602) return "LIST_INVALID_PARAMS";
  }
  return "LIST_REJECTED";
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

export async function runLocalProbeProtocol(
  socket: WebSocket,
  currentThreadId: string,
): Promise<ProtocolObservation> {
  return new Promise<ProtocolObservation>((resolve, reject) => {
    let initialized = false;
    let settled = false;
    let messageCount = 0;

    const finish = (
      error: SafeProbeError | null,
      observation?: ProtocolObservation,
    ) => {
      if (settled) return;
      settled = true;
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onPrematureClose);
      if (error !== null) reject(error);
      else if (observation !== undefined) resolve(observation);
      else reject(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    };

    const onError = () => finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    const onPrematureClose = () =>
      finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      messageCount += 1;
      if (isBinary || messageCount > MAX_PROTOCOL_MESSAGES) {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }

      let message: unknown;
      try {
        const bytes = rawDataToBuffer(data);
        if (bytes.length > MAX_WEBSOCKET_PAYLOAD_BYTES) {
          finish(new SafeProbeError("OUTPUT_LIMIT"));
          return;
        }
        message = JSON.parse(bytes.toString("utf8"));
      } catch {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }

      if (typeof message !== "object" || message === null) {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }
      const record = message as Record<string, unknown>;

      // The feasibility probe never answers server-initiated requests.
      if (record.method !== undefined && record.id !== undefined) {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }

      // Notifications are ignored. They are bounded by both message count and
      // byte limits and are never logged or persisted.
      if (record.id === undefined) return;

      if (record.id === 0 && !initialized) {
        if (
          record.error !== undefined ||
          typeof record.result !== "object" ||
          record.result === null
        ) {
          finish(new SafeProbeError("INITIALIZE_REJECTED"));
          return;
        }
        initialized = true;
        try {
          socket.send(buildLocalInitializedNotification());
          socket.send(buildLocalLoadedThreadListRequest());
        } catch {
          finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        }
        return;
      }

      if (record.id === 1) {
        if (!initialized) {
          finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
          return;
        }
        if (record.error !== undefined) {
          finish(new SafeProbeError(classifyLoadedThreadListError(record.error)));
          return;
        }
        if (typeof record.result !== "object" || record.result === null) {
          finish(new SafeProbeError("LIST_SCHEMA_MISMATCH"));
          return;
        }
        const data = (record.result as Record<string, unknown>).data;
        if (
          !Array.isArray(data) ||
          data.length > 100_000 ||
          !data.every(
            (item) =>
              typeof item === "string" && item.length > 0 && item.length <= 128,
          )
        ) {
          finish(new SafeProbeError("LIST_SCHEMA_MISMATCH"));
          return;
        }
        finish(null, {
          currentTaskLoaded: data.includes(currentThreadId),
          loadedThreadCount: data.length,
        });
      }
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onPrematureClose);
    try {
      socket.send(buildLocalInitializeRequest());
    } catch {
      finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    }
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: SafeProbeError) => {
      if (settled) return;
      settled = true;
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = () => finish();
    const onError = () => finish(new SafeProbeError("SPAWN_FAILED"));
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function openWebSocket(stream: BoundedChildDuplex): Promise<WebSocket> {
  const socket = new WebSocket("ws://localhost/rpc", {
    createConnection: () => {
      queueMicrotask(() => stream.emit("connect"));
      return stream as never;
    },
    followRedirects: false,
    handshakeTimeout: 5_000,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  socket.on("error", () => undefined);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: SafeProbeError) => {
      if (settled) return;
      settled = true;
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpectedResponse);
      if (error === undefined) resolve(socket);
      else reject(error);
    };
    const onOpen = () => finish();
    const onError = () =>
      finish(new SafeProbeError("WEBSOCKET_UPGRADE_REJECTED"));
    const onUnexpectedResponse = () =>
      finish(new SafeProbeError("WEBSOCKET_UPGRADE_REJECTED"));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
}

function closeWebSocket(socket: WebSocket): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), CLOSE_TIMEOUT_MS);
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.close(1000);
  });
}

function terminateWebSocket(socket: WebSocket | null): void {
  socket?.terminate();
}

function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
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

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function waitForProcessGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function ownsProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
): boolean {
  return child.pid === processGroupId && processGroupId > 1 && processGroupId !== process.pid;
}

export function signalLocalProbeProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  if (!ownsProcessGroup(child, processGroupId)) return false;
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export async function terminateLocalProbeProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
): Promise<boolean> {
  if (!ownsProcessGroup(child, processGroupId)) return false;
  child.stdin.destroy();
  let groupGone = !processGroupExists(processGroupId);
  if (!groupGone) {
    signalLocalProbeProcessGroup(child, processGroupId, "SIGTERM");
    groupGone = await waitForProcessGroupGone(processGroupId, TERMINATE_TIMEOUT_MS);
    if (!groupGone) {
      signalLocalProbeProcessGroup(child, processGroupId, "SIGKILL");
      groupGone = await waitForProcessGroupGone(
        processGroupId,
        TERMINATE_TIMEOUT_MS,
      );
    }
  }
  const childClosed = await waitForChildClose(child, TERMINATE_TIMEOUT_MS);
  return childClosed && groupGone;
}

function safeCode(error: unknown, connected: boolean): ErrorCode {
  if (error instanceof SafeProbeError) return error.code;
  return connected ? "WEBSOCKET_PROTOCOL_ERROR" : "WEBSOCKET_UPGRADE_REJECTED";
}

function baseResult(): Omit<ProbeResult, "code" | "ok"> {
  return {
    cleanupConfirmed: true,
    cleanupMode: "not_started",
    connected: false,
    currentTaskLoaded: false,
    loadedListValidated: false,
    loadedThreadCount: null,
  };
}

async function probe(source: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let currentThreadId: string;
  let home: string;
  let binary: string;
  try {
    currentThreadId = readAuthorizedThreadId(source);
    home = validateHome(source);
    binary = await validateManagedCodexBinary(home);
  } catch (error) {
    return {
      ...baseResult(),
      code: safeCode(error, false),
      ok: false,
    };
  }

  const child = spawn(binary, ["app-server", "proxy"], {
    cwd: path.parse(home).root,
    detached: true,
    env: buildLocalProbeChildEnvironment(home, source),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let processGroupId = child.pid ?? null;
  const stream = new BoundedChildDuplex(child);
  let socket: WebSocket | null = null;
  let connected = false;
  let observation: ProtocolObservation | null = null;
  let failureCode: ErrorCode | null = null;
  let stderrBytes = 0;
  let stderrFailure: ErrorCode | null = null;

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_PROXY_STDERR_BYTES) {
      stderrFailure = "OUTPUT_LIMIT";
      stream.destroy(new SafeProbeError("OUTPUT_LIMIT"));
    }
  });
  child.stderr.on("error", () => {
    stderrFailure = "WEBSOCKET_PROTOCOL_ERROR";
    stream.destroy(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
  });

  let timedOut = false;
  let deadline: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      timedOut = true;
      socket?.terminate();
      stream.destroy(new SafeProbeError("TIMEOUT"));
      reject(new SafeProbeError("TIMEOUT"));
    }, PROBE_TIMEOUT_MS);
  });

  try {
    const operation = async (): Promise<ProtocolObservation> => {
      await waitForSpawn(child);
      if (child.pid === undefined) throw new SafeProbeError("SPAWN_FAILED");
      processGroupId = child.pid;
      socket = await openWebSocket(stream);
      connected = true;
      return runLocalProbeProtocol(socket, currentThreadId);
    };
    observation = await Promise.race([operation(), timeout]);
  } catch (error) {
    failureCode = timedOut
      ? "TIMEOUT"
      : stream.failureCode ?? stderrFailure ?? safeCode(error, connected);
  } finally {
    if (deadline !== null) clearTimeout(deadline);
  }

  let cleanupMode: CleanupMode = "forced";
  let cleanupConfirmed = false;
  if (observation !== null && socket !== null) {
    const websocketClosed = await closeWebSocket(socket);
    if (websocketClosed) {
      if (!child.stdin.destroyed) child.stdin.end();
      const groupId = processGroupId;
      if (groupId !== null) {
        const [childClosed, groupGone] = await Promise.all([
          waitForChildClose(child, CLOSE_TIMEOUT_MS),
          waitForProcessGroupGone(groupId, CLOSE_TIMEOUT_MS),
        ]);
        cleanupConfirmed = childClosed && groupGone;
        if (cleanupConfirmed) cleanupMode = "graceful";
      }
    }
  }

  if (!cleanupConfirmed) {
    terminateWebSocket(socket);
    stream.destroy();
    const groupId = processGroupId ?? child.pid ?? null;
    cleanupConfirmed =
      groupId === null
        ? await waitForChildClose(child, TERMINATE_TIMEOUT_MS)
        : await terminateLocalProbeProcessGroup(child, groupId);
    cleanupMode = cleanupConfirmed ? "forced" : "unconfirmed";
  }

  if (!cleanupConfirmed) {
    return {
      cleanupConfirmed: false,
      cleanupMode,
      code: "CLEANUP_FAILED",
      connected,
      currentTaskLoaded: observation?.currentTaskLoaded ?? false,
      loadedListValidated: observation !== null,
      loadedThreadCount: observation?.loadedThreadCount ?? null,
      ok: false,
    };
  }

  if (observation === null) {
    return {
      cleanupConfirmed: true,
      cleanupMode,
      code: failureCode ?? "WEBSOCKET_PROTOCOL_ERROR",
      connected,
      currentTaskLoaded: false,
      loadedListValidated: false,
      loadedThreadCount: null,
      ok: false,
    };
  }

  if (!observation.currentTaskLoaded) {
    return {
      cleanupConfirmed: true,
      cleanupMode,
      code: "CURRENT_TASK_NOT_LOADED",
      connected: true,
      currentTaskLoaded: false,
      loadedListValidated: true,
      loadedThreadCount: observation.loadedThreadCount,
      ok: false,
    };
  }

  return {
    cleanupConfirmed: true,
    cleanupMode,
    connected: true,
    currentTaskLoaded: true,
    loadedListValidated: true,
    loadedThreadCount: observation.loadedThreadCount,
    ok: true,
  };
}

async function main(): Promise<void> {
  const result = await probe(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
