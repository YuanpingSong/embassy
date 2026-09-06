import { chmod, lstat, mkdtemp, realpath, rename, rmdir, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";

const DEFAULT_REQUEST_BYTES = 256 * 1024;
const DEFAULT_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_CONNECTIONS = 32;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const LOCAL_CONTROL_VERSION = 6 as const;

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  UNSUPPORTED_PLATFORM: "Unix-domain gateway control sockets are unavailable.",
  INVALID_STATE_DIR: "The gateway state directory is invalid.",
  INSECURE_STATE_DIR: "The gateway state directory is not private to this user.",
  INVALID_SOCKET_PATH: "The gateway control socket path is invalid.",
  UNSAFE_SOCKET_TARGET: "The gateway control socket target is unsafe.",
  SOCKET_IN_USE: "The gateway control socket is already served by a live process.",
  SOCKET_PROBE_FAILED: "The gateway control socket could not be checked safely.",
  SOCKET_BIND_FAILED: "The gateway control socket could not be bound.",
  SOCKET_PERMISSION_FAILED: "The gateway control socket permissions could not be secured.",
  SOCKET_CLEANUP_CONFLICT: "The gateway control socket path changed during cleanup.",
  CONTROL_CONNECT_FAILED: "The gateway control socket could not be reached.",
  CONTROL_CONNECT_DENIED: "The gateway control socket connection was denied by local policy.",
  CONTROL_SOCKET_MISSING: "The gateway control socket does not exist at the configured path.",
  CONTROL_SOCKET_UNSAFE: "The gateway control socket is unsafe.",
  CONTROL_LISTENER_UNAVAILABLE: "Nothing is listening on the gateway control socket.",
  CONTROL_TIMEOUT: "The gateway control request timed out.",
  CONTROL_RESPONSE_TOO_LARGE: "The gateway control response exceeds the client limit.",
  CONTROL_INVALID_RESPONSE: "The gateway returned an invalid control response.",
  CONTROL_VERSION_MISMATCH: "The gateway control protocol version does not match this client.",
  CONTROL_CONNECTION_CLOSED: "The gateway closed before returning a control response.",
  CONTROL_WRITE_OUTCOME_AMBIGUOUS: "The gateway may have applied the control mutation before the response was lost; do not retry automatically.",
  INVALID_JSON: "The control frame is not valid JSON.",
  FRAME_TOO_LARGE: "The control frame exceeds the size limit.",
  INVALID_REQUEST: "The control request is invalid.",
  UNSUPPORTED_VERSION: "The control protocol version is unsupported.",
  MULTIPLE_FRAMES: "Only one control request is allowed per connection.",
  REQUEST_TIMEOUT: "The control request timed out.",
  SERVER_BUSY: "The gateway control server is at its connection limit.",
  HANDLER_FAILURE: "The gateway could not complete the control request.",
  INVALID_HANDLER_RESPONSE: "The gateway produced an invalid control response.",
  RESPONSE_TOO_LARGE: "The control response exceeds the size limit.",
});

export class LocalControlError extends Error {
  readonly ambiguous: boolean;
  readonly recoverable: boolean;
  constructor(readonly code: string, ambiguous = false) {
    super(MESSAGES[code] ?? "The gateway control transport failed.");
    this.name = "LocalControlError";
    this.ambiguous = ambiguous;
    this.recoverable = !ambiguous;
  }
}

type WireResponse = Readonly<{ protocolVersion: typeof LOCAL_CONTROL_VERSION; ok: true; result: unknown }> |
  Readonly<{ protocolVersion: typeof LOCAL_CONTROL_VERSION; ok: false; error: Readonly<{ code: string }> }>;
type FrameFailure = "closed" | "error" | "timeout" | "too_large" | "multiple";
class FrameFault extends Error {
  constructor(readonly kind: FrameFailure, readonly systemCode?: string) { super(kind); }
}
type SocketIdentity = Readonly<{ dev: number; ino: number }>;
type ProtectedReplacement = Readonly<{ directory: string; backupPath: string }>;

const failure = (code: string): WireResponse => ({ protocolVersion: LOCAL_CONTROL_VERSION, ok: false, error: { code } });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sameIdentity = (value: { dev: number; ino: number }, identity: SocketIdentity): boolean =>
  value.dev === identity.dev && value.ino === identity.ino;
const errno = (error: unknown): string | undefined => object(error) && typeof error.code === "string"
  ? error.code : undefined;

function limits(requestBytes?: number, responseBytes?: number): { request: number; response: number } {
  const request = requestBytes ?? DEFAULT_REQUEST_BYTES;
  const response = responseBytes ?? DEFAULT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(request) || request < 256 || request > MAX_DOCUMENT_BYTES ||
    !Number.isSafeInteger(response) || response < 256 || response > MAX_DOCUMENT_BYTES) {
    throw new LocalControlError("INVALID_SOCKET_PATH");
  }
  return { request, response };
}

function assertSocketPath(socketPath: string): void {
  if (!path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new LocalControlError("INVALID_SOCKET_PATH");
  }
}

async function validateLocation(stateDir: string, socketPath: string, client = false): Promise<void> {
  if (process.platform === "win32") throw new LocalControlError("UNSUPPORTED_PLATFORM");
  assertSocketPath(socketPath);
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) {
    throw new LocalControlError("INVALID_SOCKET_PATH");
  }
  let state;
  try { state = await lstat(stateDir); }
  catch (error) {
    if (client && (errno(error) === "EPERM" || errno(error) === "EACCES")) {
      throw new LocalControlError("CONTROL_CONNECT_DENIED");
    }
    throw new LocalControlError("INVALID_STATE_DIR");
  }
  if (state.isSymbolicLink() || !state.isDirectory()) throw new LocalControlError("INVALID_STATE_DIR");
  const uid = process.getuid?.call(process);
  if (uid !== undefined && state.uid !== uid || (state.mode & 0o777) !== 0o700) {
    throw new LocalControlError("INSECURE_STATE_DIR");
  }
  let stateReal: string, parentReal: string;
  try { [stateReal, parentReal] = await Promise.all([realpath(stateDir), realpath(path.dirname(socketPath))]); }
  catch { throw new LocalControlError("INVALID_SOCKET_PATH"); }
  if (socketPath === stateDir || parentReal !== stateReal && !parentReal.startsWith(`${stateReal}${path.sep}`)) {
    throw new LocalControlError("INVALID_SOCKET_PATH");
  }
}

async function optionalLstat(target: string) {
  try { return await lstat(target); }
  catch (error) { if (errno(error) === "ENOENT") return undefined; throw error; }
}

function readOneFrame(socket: Socket, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0), settled = false;
    const finish = (value: Buffer | FrameFault): void => {
      if (settled) return;
      settled = true;
      socket.pause();
      socket.off("data", onData); socket.off("end", onEnd); socket.off("timeout", onTimeout);
      value instanceof FrameFault ? reject(value) : resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      if (buffered.length + chunk.length > maximum) return finish(new FrameFault("too_large"));
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      if (buffered.subarray(newline + 1).toString("utf8").trim().length > 0) {
        return finish(new FrameFault("multiple"));
      }
      finish(buffered.subarray(0, newline));
    };
    const onEnd = (): void => finish(new FrameFault("closed"));
    const onTimeout = (): void => finish(new FrameFault("timeout"));
    socket.on("data", onData); socket.once("end", onEnd); socket.once("timeout", onTimeout);
    socket.once("error", (error: NodeJS.ErrnoException) => finish(new FrameFault("error", error.code)));
  });
}

function decode(frame: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); }
  catch { throw new LocalControlError("INVALID_JSON"); }
}

function serialize(response: WireResponse, maximum: number): Buffer {
  try {
    if (response.ok && response.result === undefined) return serialize(failure("INVALID_HANDLER_RESPONSE"), maximum);
    const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (encoded.length <= maximum) return encoded;
    return Buffer.from(`${JSON.stringify(failure("RESPONSE_TOO_LARGE"))}\n`, "utf8");
  } catch {
    return Buffer.from(`${JSON.stringify(failure("INVALID_HANDLER_RESPONSE"))}\n`, "utf8");
  }
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true; socket.destroy(); operation();
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("timeout", () => finish(() => reject(new LocalControlError("SOCKET_PROBE_FAILED"))));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(() => resolve(false));
      else finish(() => reject(new LocalControlError("SOCKET_PROBE_FAILED")));
    });
  });
}

async function prepareTarget(socketPath: string): Promise<void> {
  let existing;
  try { existing = await optionalLstat(socketPath); }
  catch { throw new LocalControlError("UNSAFE_SOCKET_TARGET"); }
  if (existing === undefined) return;
  if (existing.isSymbolicLink() || !existing.isSocket()) throw new LocalControlError("UNSAFE_SOCKET_TARGET");
  const identity = { dev: existing.dev, ino: existing.ino };
  if (await socketIsLive(socketPath)) throw new LocalControlError("SOCKET_IN_USE");
  let current;
  try { current = await lstat(socketPath); }
  catch { throw new LocalControlError("UNSAFE_SOCKET_TARGET"); }
  if (!current.isSocket() || !sameIdentity(current, identity)) throw new LocalControlError("UNSAFE_SOCKET_TARGET");
  try { await unlink(socketPath); }
  catch { throw new LocalControlError("UNSAFE_SOCKET_TARGET"); }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
}

async function removeOwned(socketPath: string, identity: SocketIdentity): Promise<void> {
  let current;
  try { current = await optionalLstat(socketPath); } catch { return; }
  if (current?.isSocket() && sameIdentity(current, identity)) await unlink(socketPath).catch(() => undefined);
}

async function protectReplacement(socketPath: string, identity: SocketIdentity): Promise<ProtectedReplacement | undefined> {
  let current;
  try { current = await optionalLstat(socketPath); }
  catch { throw new LocalControlError("SOCKET_CLEANUP_CONFLICT"); }
  if (current === undefined || sameIdentity(current, identity)) return undefined;
  let directory: string;
  try { directory = await mkdtemp(path.join(path.dirname(socketPath), ".gateway-control-close-")); }
  catch { throw new LocalControlError("SOCKET_CLEANUP_CONFLICT"); }
  const backupPath = path.join(directory, "replacement");
  try { await rename(socketPath, backupPath); }
  catch (error) {
    await rmdir(directory).catch(() => undefined);
    if (errno(error) === "ENOENT") return undefined;
    throw new LocalControlError("SOCKET_CLEANUP_CONFLICT");
  }
  return { directory, backupPath };
}

async function restoreReplacement(socketPath: string, replacement: ProtectedReplacement | undefined): Promise<void> {
  if (replacement === undefined) return;
  let current;
  try { current = await optionalLstat(socketPath); }
  catch { throw new LocalControlError("SOCKET_CLEANUP_CONFLICT"); }
  if (current !== undefined) throw new LocalControlError("SOCKET_CLEANUP_CONFLICT");
  try { await rename(replacement.backupPath, socketPath); await rmdir(replacement.directory); }
  catch { throw new LocalControlError("SOCKET_CLEANUP_CONFLICT"); }
}

export async function serveLocalControl(options: Readonly<{
  stateDir: string; socketPath: string; handle: (input: unknown) => Promise<unknown>;
  requestBytes?: number; responseBytes?: number;
}>): Promise<{ close(): Promise<void> }> {
  const maximum = limits(options.requestBytes, options.responseBytes);
  await validateLocation(options.stateDir, options.socketPath);
  await prepareTarget(options.socketPath);
  const connections = new Set<Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= MAX_CONNECTIONS) {
      socket.once("error", () => socket.destroy());
      socket.end(serialize(failure("SERVER_BUSY"), maximum.response), () => socket.destroy());
      return;
    }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setTimeout(DEFAULT_TIMEOUT_MS);
    void readOneFrame(socket, maximum.request).then(async (frame) => {
      socket.setTimeout(0);
      let input: unknown;
      try {
        const request = decode(frame);
        if (!object(request) || !Number.isSafeInteger(request.protocolVersion)) throw new LocalControlError("INVALID_REQUEST");
        if (request.protocolVersion !== LOCAL_CONTROL_VERSION) throw new LocalControlError("UNSUPPORTED_VERSION");
        if (Object.keys(request).length !== 2 || !Object.hasOwn(request, "input")) throw new LocalControlError("INVALID_REQUEST");
        input = request.input;
      }
      catch (error) {
        socket.end(serialize(failure(error instanceof LocalControlError ? error.code : "INVALID_JSON"), maximum.response));
        return;
      }
      let response: WireResponse;
      try { response = { protocolVersion: LOCAL_CONTROL_VERSION, ok: true, result: await options.handle(input) }; }
      catch { response = failure("HANDLER_FAILURE"); }
      socket.end(serialize(response, maximum.response));
    }, (error: unknown) => {
      const kind = error instanceof FrameFault ? error.kind : "error";
      const code = kind === "too_large" ? "FRAME_TOO_LARGE" : kind === "multiple" ? "MULTIPLE_FRAMES"
        : kind === "timeout" ? "REQUEST_TIMEOUT" : undefined;
      if (code === undefined) socket.destroy(); else socket.end(serialize(failure(code), maximum.response));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new LocalControlError("SOCKET_BIND_FAILED"));
      server.once("error", failed);
      server.listen(options.socketPath, () => { server.off("error", failed); resolve(); });
    });
  } catch (error) { await closeServer(server); throw error; }
  let identity: SocketIdentity | undefined;
  try {
    const info = await lstat(options.socketPath);
    if (!info.isSocket()) throw new Error();
    identity = { dev: info.dev, ino: info.ino };
    await chmod(options.socketPath, 0o600);
    const secured = await lstat(options.socketPath);
    if (!secured.isSocket() || !sameIdentity(secured, identity) || (secured.mode & 0o777) !== 0o600) throw new Error();
  } catch {
    for (const socket of connections) socket.destroy();
    await closeServer(server);
    if (identity !== undefined) await removeOwned(options.socketPath, identity);
    throw new LocalControlError("SOCKET_PERMISSION_FAILED");
  }
  const owned = identity;
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= (async () => {
    const replacement = await protectReplacement(options.socketPath, owned);
    for (const socket of connections) socket.destroy();
    await closeServer(server);
    await removeOwned(options.socketPath, owned);
    await restoreReplacement(options.socketPath, replacement);
  })() };
}

export async function requestLocalControl(options: Readonly<{
  stateDir: string; socketPath: string; request: unknown; mutating: boolean;
  timeoutMs?: number;
}>): Promise<unknown> {
  const maximum = limits();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 90_000) {
    throw new LocalControlError("CONTROL_INVALID_RESPONSE");
  }
  await validateLocation(options.stateDir, options.socketPath, true);
  let socketInfo;
  try { socketInfo = await lstat(options.socketPath); }
  catch (error) {
    const code = errno(error);
    throw new LocalControlError(code === "EPERM" || code === "EACCES" ? "CONTROL_CONNECT_DENIED"
      : code === "ENOENT" ? "CONTROL_SOCKET_MISSING" : "CONTROL_CONNECT_FAILED");
  }
  const uid = process.getuid?.call(process);
  if (!socketInfo.isSocket() || socketInfo.isSymbolicLink() || (socketInfo.mode & 0o777) !== 0o600 ||
    uid !== undefined && socketInfo.uid !== uid) throw new LocalControlError("CONTROL_SOCKET_UNSAFE");
  let frame: Buffer;
  try {
    if (options.request === undefined) throw new TypeError("not JSON");
    const encoded = JSON.stringify({ protocolVersion: LOCAL_CONTROL_VERSION, input: options.request });
    if (encoded === undefined) throw new TypeError("not JSON");
    frame = Buffer.from(`${encoded}\n`, "utf8");
  }
  catch { throw new LocalControlError("CONTROL_INVALID_RESPONSE"); }
  if (frame.length > maximum.request) throw new LocalControlError("FRAME_TOO_LARGE");
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false, writeStarted = false;
    const fail = (error: LocalControlError): void => {
      if (settled) return;
      settled = true; socket.destroy();
      reject(options.mutating && writeStarted
        ? new LocalControlError("CONTROL_WRITE_OUTCOME_AMBIGUOUS", true) : error);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => { writeStarted = true; socket.write(frame); });
    void readOneFrame(socket, maximum.response).then((responseFrame) => {
      try {
        const value = decode(responseFrame);
        if (!object(value) || !Number.isSafeInteger(value.protocolVersion)) {
          throw new LocalControlError("CONTROL_INVALID_RESPONSE");
        }
        if (value.protocolVersion !== LOCAL_CONTROL_VERSION) throw new LocalControlError("CONTROL_VERSION_MISMATCH");
        if (typeof value.ok !== "boolean" ||
          value.ok && (Object.keys(value).length !== 3 || !Object.hasOwn(value, "result")) ||
          !value.ok && (Object.keys(value).length !== 3 || !object(value.error) ||
            Object.keys(value.error).length !== 1 || typeof value.error.code !== "string" || !Object.hasOwn(MESSAGES, value.error.code))) {
          throw new LocalControlError("CONTROL_INVALID_RESPONSE");
        }
        if (value.ok === false) {
          const code = (value.error as { code: string }).code;
          if (["HANDLER_FAILURE", "INVALID_HANDLER_RESPONSE", "RESPONSE_TOO_LARGE"].includes(code)) {
            fail(new LocalControlError(code));
          } else if (!settled) { settled = true; socket.destroy(); reject(new LocalControlError(code)); }
          return;
        }
        if (!settled) { settled = true; socket.destroy(); resolve(value.result); }
      } catch (error) {
        fail(error instanceof LocalControlError && error.code === "CONTROL_VERSION_MISMATCH"
          ? error : new LocalControlError("CONTROL_INVALID_RESPONSE"));
      }
    }, (error: unknown) => {
      const kind = error instanceof FrameFault ? error.kind : "error";
      const systemCode = !writeStarted && error instanceof FrameFault ? error.systemCode : undefined;
      const code = kind === "timeout" ? "CONTROL_TIMEOUT" : kind === "too_large" ? "CONTROL_RESPONSE_TOO_LARGE"
        : kind === "closed" ? "CONTROL_CONNECTION_CLOSED" : systemCode === "EPERM" || systemCode === "EACCES"
          ? "CONTROL_CONNECT_DENIED" : systemCode === "ENOENT" ? "CONTROL_SOCKET_MISSING"
            : systemCode === "ECONNREFUSED" ? "CONTROL_LISTENER_UNAVAILABLE" : "CONTROL_CONNECT_FAILED";
      fail(new LocalControlError(code));
    });
  });
}
