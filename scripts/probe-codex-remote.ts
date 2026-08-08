import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

const AUTHORIZATION_ENV = "CLAUDE_BRIDGE_RUN_CODEX_REMOTE_PROBE";
const ALLOWLIST_ENV = "CLAUDE_BRIDGE_CODEX_REMOTE_PROBE_ALLOWED_HOSTS";
const HOST_ENV = "CLAUDE_BRIDGE_CODEX_REMOTE_PROBE_HOST";

const MAX_PRE_MARKER_BYTES = 64 * 1024;
const MAX_PROXY_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_STDERR_BYTES = 64 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const TERMINATE_TIMEOUT_MS = 750;

type ErrorCode =
  | "PROBE_NOT_AUTHORIZED"
  | "HOST_NOT_ALLOWLISTED"
  | "HOST_INVALID"
  | "DESKTOP_PROXY_NOT_FOUND"
  | "DESKTOP_PROXY_AMBIGUOUS"
  | "SSH_UNAVAILABLE"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "WEBSOCKET_UPGRADE_REJECTED"
  | "WEBSOCKET_PROTOCOL_ERROR"
  | "INITIALIZE_REJECTED"
  | "LIST_INVALID_PARAMS"
  | "LIST_METHOD_UNAVAILABLE"
  | "LIST_REJECTED"
  | "LIST_SCHEMA_MISMATCH"
  | "CLEANUP_FAILED";

type ProbeSuccess = {
  cleanupMode: "forced" | "graceful";
  cleanupConfirmed: true;
  connected: true;
  desktopProxyStillAlive: true;
  gracefulCloseConfirmed: boolean;
  host: string;
  loadedListValidated: true;
  loadedThreadCount: number;
  loadedTaskStateObserved: boolean;
  ok: true;
  warningCode:
    | "GRACEFUL_CLOSE_NOT_CONFIRMED"
    | "GRACEFUL_PROCESS_EXIT_NOT_CONFIRMED"
    | null;
};

type ProbeFailure = {
  cleanupConfirmed: boolean;
  code: ErrorCode;
  connected: boolean;
  desktopProxyStillAlive: boolean;
  host: string | null;
  ok: false;
};

class SafeProbeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "SafeProbeError";
    this.code = code;
  }
}

type ProcessRow = {
  executable: string;
  pid: number;
  ppid: number;
};

function parseProcessRows(): ProcessRow[] {
  const stdout = execFileSync("/bin/ps", ["-x", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2_000,
  });

  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      continue;
    }
    rows.push({
      executable: match[3],
      pid: Number(match[1]),
      ppid: Number(match[2]),
    });
  }
  return rows;
}

function readProcessCommand(pid: number): string {
  return execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 2_000,
  }).trim();
}

export function commandHasExactToken(command: string, token: string): boolean {
  return command.split(/\s+/u).includes(token);
}

export function commandIsDesktopProxy(command: string, host: string): boolean {
  const tokens = command.split(/\s+/u);
  const hostIndex = tokens.indexOf(host);
  const appServerIndex = tokens.indexOf("app-server", hostIndex + 1);
  const proxyIndex = tokens.findIndex(
    (token, index) => index > appServerIndex && /^proxy['"]?$/u.test(token),
  );
  return (
    tokens[0] === "/usr/bin/ssh" &&
    hostIndex > 0 &&
    appServerIndex > hostIndex &&
    proxyIndex > appServerIndex
  );
}

type DesktopProxyIdentity = {
  desktopPid: number;
  proxyPid: number;
};

function findDesktopProxy(host: string): DesktopProxyIdentity {
  const rows = parseProcessRows();
  const desktopPids = new Set(
    rows
      .filter(
        (row) => row.executable === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      )
      .map((row) => row.pid),
  );
  const candidates = rows
    .filter((row) => row.executable === "/usr/bin/ssh" && desktopPids.has(row.ppid))
    .flatMap((row) => {
      const command = readProcessCommand(row.pid);
      return commandIsDesktopProxy(command, host)
        ? [{ desktopPid: row.ppid, proxyPid: row.pid }]
        : [];
    });

  if (candidates.length === 0) {
    throw new SafeProbeError("DESKTOP_PROXY_NOT_FOUND");
  }
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new SafeProbeError("DESKTOP_PROXY_AMBIGUOUS");
  }
  return candidates[0];
}

function desktopProxyIsStillAlive(identity: DesktopProxyIdentity, host: string): boolean {
  try {
    const rows = parseProcessRows();
    const desktop = rows.find((row) => row.pid === identity.desktopPid);
    const proxy = rows.find((row) => row.pid === identity.proxyPid);
    if (
      desktop?.executable !== "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" ||
      proxy?.executable !== "/usr/bin/ssh" ||
      proxy.ppid !== identity.desktopPid
    ) {
      return false;
    }
    return commandIsDesktopProxy(readProcessCommand(identity.proxyPid), host);
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function octalEscape(value: Buffer): string {
  return [...value].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
}

function buildRemoteCommand(marker: Buffer): string {
  const pathSetup = 'PATH="${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH';
  const payload = `printf '%b' ${shellQuote(octalEscape(marker))}; ${pathSetup}; exec codex app-server proxy`;
  const executePayload = 'exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"';
  const cshPayload = [
    "set loginsh=1",
    "if ( -r /etc/csh.login ) source /etc/csh.login",
    "if ( -r ~/.login ) source ~/.login",
    executePayload,
  ].join("; ");
  const defaultPayload = [
    'CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"',
    "export CODEX_HOME",
    executePayload,
  ].join("; ");

  const wrapper = [
    'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then exit 127; fi;',
    'CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD;',
    'case "${SHELL##*/}" in',
    `csh|tcsh) exec "$SHELL" -i -c ${shellQuote(cshPayload)} ;;`,
    `nu) exec "$SHELL" -l -i -c ${shellQuote("exec /bin/sh -c $env.CODEX_REMOTE_PAYLOAD")} ;;`,
    `fish|xonsh) exec "$SHELL" -l -i -c ${shellQuote(executePayload)} ;;`,
    `*) exec "$SHELL" -l -i -c ${shellQuote(defaultPayload)} ;;`,
    "esac",
  ].join(" ");

  return `sh -c ${shellQuote(wrapper)} sh ${shellQuote(payload)}`;
}

export function buildProbeSshEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LC_ALL: "C",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "SSH_AUTH_SOCK"] as const) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      environment[key] = value;
    }
  }
  return environment;
}

export function buildProbeSshArguments(host: string, remoteCommand: string): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "SendEnv=-*",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ConnectTimeout=7",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "LogLevel=ERROR",
    host,
    remoteCommand,
  ];
}

class MarkerFilteredDuplex extends Duplex {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly marker: Buffer;
  private markerFound = false;
  private pending = Buffer.alloc(0);
  private stdoutBytes = 0;

  constructor(child: ChildProcessWithoutNullStreams, marker: Buffer) {
    super();
    this.child = child;
    this.marker = marker;
    // The probe attaches its protocol listeners immediately after construction,
    // but this sink also makes any same-tick child/pipe failure non-fatal.
    this.on("error", () => undefined);

    child.stdout.pause();
    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(Buffer.from(chunk));
    });
    child.stdout.on("end", () => {
      this.push(null);
    });
    child.stdout.on("error", (error) => {
      this.destroy(error);
    });
    child.stdin.on("error", (error) => {
      this.destroy(error);
    });
    child.on("error", (error) => {
      this.destroy(error);
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
      callback(new SafeProbeError("SSH_UNAVAILABLE"));
      return;
    }
    this.child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
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
    if (callback !== undefined) {
      this.once("timeout", callback);
    }
    return this;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > MAX_PROXY_STDOUT_BYTES) {
      this.destroy(new SafeProbeError("OUTPUT_LIMIT"));
      return;
    }

    if (this.markerFound) {
      if (!this.push(chunk)) {
        this.child.stdout.pause();
      }
      return;
    }

    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > MAX_PRE_MARKER_BYTES) {
      this.destroy(new SafeProbeError("OUTPUT_LIMIT"));
      return;
    }

    const markerIndex = this.pending.indexOf(this.marker);
    if (markerIndex < 0) {
      return;
    }

    this.markerFound = true;
    const remaining = this.pending.subarray(markerIndex + this.marker.length);
    this.pending = Buffer.alloc(0);
    if (remaining.length > 0 && !this.push(remaining)) {
      this.child.stdout.pause();
    }
  }
}

function parseAllowedHost(): string {
  if (process.env[AUTHORIZATION_ENV] !== "1") {
    throw new SafeProbeError("PROBE_NOT_AUTHORIZED");
  }

  const host = process.env[HOST_ENV]?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host)) {
    throw new SafeProbeError("HOST_INVALID");
  }

  const allowlist = new Set(
    (process.env[ALLOWLIST_ENV] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  if (!allowlist.has(host)) {
    throw new SafeProbeError("HOST_NOT_ALLOWLISTED");
  }
  return host;
}

function safeCode(error: unknown, connected: boolean): ErrorCode {
  if (error instanceof SafeProbeError) {
    return error.code;
  }
  if (!connected) {
    return "WEBSOCKET_UPGRADE_REJECTED";
  }
  return "WEBSOCKET_PROTOCOL_ERROR";
}

export function buildLoadedThreadListRequest(): string {
  return JSON.stringify({
    id: 1,
    method: "thread/loaded/list",
    params: {},
  });
}

export function classifyLoadedThreadListError(error: unknown): ErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === -32601) {
      return "LIST_METHOD_UNAVAILABLE";
    }
    if (error.code === -32602) {
      return "LIST_INVALID_PARAMS";
    }
  }
  return "LIST_REJECTED";
}

export function classifyProbeObservationOutcome(input: {
  cleanupConfirmed: boolean;
  desktopProxyStillAlive: boolean;
  gracefulCleanupConfirmed: boolean;
  loadedThreadCount: number | null;
}): "failed" | "forced" | "graceful" {
  if (
    input.loadedThreadCount === null ||
    !input.cleanupConfirmed ||
    !input.desktopProxyStillAlive
  ) {
    return "failed";
  }
  return input.gracefulCleanupConfirmed ? "graceful" : "forced";
}

function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(result);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

function probeProcessGroupExists(processGroupId: number): boolean {
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

async function waitForProbeProcessGroupGone(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (probeProcessGroupExists(processGroupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function ownsProbeProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
): boolean {
  return (
    child.pid === processGroupId &&
    processGroupId > 1 &&
    processGroupId !== process.pid
  );
}

export function signalProbeProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  if (!ownsProbeProcessGroup(child, processGroupId)) {
    return false;
  }
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

export async function terminateProbeProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
): Promise<boolean> {
  if (!ownsProbeProcessGroup(child, processGroupId)) {
    return false;
  }
  child.stdin.destroy();
  let groupGone = !probeProcessGroupExists(processGroupId);
  if (!groupGone) {
    signalProbeProcessGroup(child, processGroupId, "SIGTERM");
    groupGone = await waitForProbeProcessGroupGone(processGroupId, TERMINATE_TIMEOUT_MS);
    if (!groupGone) {
      signalProbeProcessGroup(child, processGroupId, "SIGKILL");
      groupGone = await waitForProbeProcessGroupGone(
        processGroupId,
        TERMINATE_TIMEOUT_MS,
      );
    }
  }
  const childClosed = await waitForChildClose(child, TERMINATE_TIMEOUT_MS);
  return childClosed && groupGone;
}

async function runProtocol(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let initialized = false;
    let settled = false;
    let messageCount = 0;

    const finish = (error: SafeProbeError | null, count?: number) => {
      if (settled) return;
      settled = true;
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onPrematureClose);
      if (error !== null) {
        reject(error);
      } else if (count !== undefined) {
        resolve(count);
      } else {
        reject(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
      }
    };

    const onError = () => finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    const onPrematureClose = () => finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      messageCount += 1;
      if (isBinary || messageCount > 256) {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }

      let message: unknown;
      try {
        const bytes = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data);
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

      if (record.method !== undefined && record.id !== undefined) {
        finish(new SafeProbeError("WEBSOCKET_PROTOCOL_ERROR"));
        return;
      }

      if (record.id === 0 && !initialized) {
        if (record.error !== undefined || typeof record.result !== "object" || record.result === null) {
          finish(new SafeProbeError("INITIALIZE_REJECTED"));
          return;
        }
        initialized = true;
        try {
          socket.send(JSON.stringify({ method: "initialized", params: {} }));
          socket.send(buildLoadedThreadListRequest());
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
        const result = record.result;
        if (record.error !== undefined) {
          finish(new SafeProbeError(classifyLoadedThreadListError(record.error)));
          return;
        }
        if (typeof result !== "object" || result === null) {
          finish(new SafeProbeError("LIST_SCHEMA_MISMATCH"));
          return;
        }
        const data = (result as Record<string, unknown>).data;
        if (!Array.isArray(data) || !data.every((item) => typeof item === "string")) {
          finish(new SafeProbeError("LIST_SCHEMA_MISMATCH"));
          return;
        }
        finish(null, data.length);
      }
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onPrematureClose);
    socket.send(
      JSON.stringify({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "claude_agent_bridge_probe",
            title: "Claude Agent Bridge Probe",
            version: "0.1.0",
          },
        },
      }),
    );
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
    const onError = () => finish(new SafeProbeError("SSH_UNAVAILABLE"));
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function openWebSocket(stream: MarkerFilteredDuplex): Promise<WebSocket> {
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
    const onError = () => finish(new SafeProbeError("WEBSOCKET_UPGRADE_REJECTED"));
    const onUnexpectedResponse = () =>
      finish(new SafeProbeError("WEBSOCKET_UPGRADE_REJECTED"));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: SafeProbeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onClose = () => finish();
    const onError = () => finish(new SafeProbeError("CLEANUP_FAILED"));
    const timer = setTimeout(
      () => finish(new SafeProbeError("CLEANUP_FAILED")),
      CLOSE_TIMEOUT_MS,
    );
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.close(1000);
  });
}

function terminateWebSocket(socket: WebSocket | null): void {
  socket?.terminate();
}

function destroyProbeStream(stream: MarkerFilteredDuplex | null): void {
  stream?.destroy();
}

async function probe(host: string): Promise<ProbeSuccess | ProbeFailure> {
  const desktopProxy = findDesktopProxy(host);
  const marker = randomBytes(16);
  const child = spawn(
    "/usr/bin/ssh",
    buildProbeSshArguments(host, buildRemoteCommand(marker)),
    {
      detached: true,
      env: buildProbeSshEnvironment(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderrBytes = 0;
  let stderrFailure: ErrorCode | null = null;
  let connected = false;
  let cleanupConfirmed = false;
  let gracefulCloseConfirmed = false;
  let loadedThreadCount: number | null = null;
  let socket: WebSocket | null = null;
  let stream: MarkerFilteredDuplex | null = null;
  let processGroupId: number | null = null;

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_PROXY_STDERR_BYTES) {
      stderrFailure = "OUTPUT_LIMIT";
      stream?.destroy(new SafeProbeError("OUTPUT_LIMIT"));
    }
  });
  child.stderr.on("error", () => {
    stderrFailure = "SSH_UNAVAILABLE";
    stream?.destroy(new SafeProbeError("SSH_UNAVAILABLE"));
  });

  let deadline: NodeJS.Timeout | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      reject(new SafeProbeError("TIMEOUT"));
      socket?.terminate();
      stream?.destroy(new SafeProbeError("TIMEOUT"));
    }, PROBE_TIMEOUT_MS);
  });

  try {
    const operation = async (): Promise<number> => {
      await waitForSpawn(child);
      if (child.pid === undefined) {
        throw new SafeProbeError("SSH_UNAVAILABLE");
      }
      processGroupId = child.pid;
      stream = new MarkerFilteredDuplex(child, marker);
      if (stderrFailure !== null) {
        throw new SafeProbeError(stderrFailure);
      }
      socket = await openWebSocket(stream);
      connected = true;
      loadedThreadCount = await runProtocol(socket);
      await closeWebSocket(socket);
      gracefulCloseConfirmed = true;
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      const [childClosed, groupGone] = await Promise.all([
        waitForChildClose(child, CLOSE_TIMEOUT_MS),
        waitForProbeProcessGroupGone(processGroupId, CLOSE_TIMEOUT_MS),
      ]);
      cleanupConfirmed = childClosed && groupGone;
      if (!cleanupConfirmed) {
        throw new SafeProbeError("CLEANUP_FAILED");
      }
      return loadedThreadCount;
    };

    const observedThreadCount = await Promise.race([operation(), timedOut]);
    const desktopProxyStillAlive = desktopProxyIsStillAlive(desktopProxy, host);

    if (!cleanupConfirmed || !desktopProxyStillAlive) {
      return {
        cleanupConfirmed,
        code: "CLEANUP_FAILED",
        connected,
        desktopProxyStillAlive,
        host,
        ok: false,
      };
    }

    return {
      cleanupMode: "graceful",
      cleanupConfirmed: true,
      connected: true,
      desktopProxyStillAlive: true,
      gracefulCloseConfirmed: true,
      host,
      loadedListValidated: true,
      loadedThreadCount: observedThreadCount,
      loadedTaskStateObserved: observedThreadCount > 0,
      ok: true,
      warningCode: null,
    };
  } catch (error) {
    terminateWebSocket(socket);
    destroyProbeStream(stream);
    const cleanupGroupId = processGroupId ?? child.pid ?? null;
    if (cleanupGroupId !== null) {
      processGroupId = cleanupGroupId;
    }
    cleanupConfirmed =
      cleanupGroupId === null
        ? await waitForChildClose(child, TERMINATE_TIMEOUT_MS)
        : await terminateProbeProcessGroup(child, cleanupGroupId);
    const desktopProxyStillAlive = desktopProxyIsStillAlive(desktopProxy, host);
    const observationOutcome = classifyProbeObservationOutcome({
      cleanupConfirmed,
      desktopProxyStillAlive,
      gracefulCleanupConfirmed: false,
      loadedThreadCount,
    });
    if (observationOutcome === "forced" && loadedThreadCount !== null) {
      return {
        cleanupMode: "forced",
        cleanupConfirmed: true,
        connected: true,
        desktopProxyStillAlive: true,
        gracefulCloseConfirmed,
        host,
        loadedListValidated: true,
        loadedThreadCount,
        loadedTaskStateObserved: loadedThreadCount > 0,
        ok: true,
        warningCode: gracefulCloseConfirmed
          ? "GRACEFUL_PROCESS_EXIT_NOT_CONFIRMED"
          : "GRACEFUL_CLOSE_NOT_CONFIRMED",
      };
    }
    return {
      cleanupConfirmed,
      code: safeCode(error, connected),
      connected,
      desktopProxyStillAlive,
      host,
      ok: false,
    };
  } finally {
    if (deadline !== null) {
      clearTimeout(deadline);
    }
    if (!cleanupConfirmed) {
      const finalGroupId = processGroupId ?? child.pid ?? null;
      if (finalGroupId !== null) {
        cleanupConfirmed = await terminateProbeProcessGroup(child, finalGroupId);
      }
    }
  }
}

async function main(): Promise<void> {
  let host: string | null = null;
  let result: ProbeSuccess | ProbeFailure;
  try {
    host = parseAllowedHost();
    result = await probe(host);
  } catch (error) {
    result = {
      cleanupConfirmed: true,
      code: safeCode(error, false),
      connected: false,
      desktopProxyStillAlive: false,
      host,
      ok: false,
    };
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
