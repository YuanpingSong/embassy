import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";

import WebSocket from "ws";

export type CodexAppServerTransportErrorCode =
  | "INPUT_INVALID"
  | "INVALID_CONFIGURATION"
  | "PROTOCOL_ERROR"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_WRITE_FAILED";

export class CodexAppServerTransportError extends Error {
  constructor(
    readonly code: CodexAppServerTransportErrorCode,
    readonly ambiguous = false,
  ) {
    super(code);
    this.name = "CodexAppServerTransportError";
  }
}

export type CodexAppServerTransport = {
  close: () => Promise<void>;
  onClose: (listener: () => void) => () => void;
  onError: (listener: () => void) => () => void;
  onMessage: (listener: (payload: string) => void) => () => void;
  send: (payload: string) => Promise<void>;
};

export type WebSocketDuplexTransportOptions = {
  closeTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxFrameBytes?: number;
};

/** Minimal net.Socket surface used by Node's WebSocket HTTP upgrade client. */
export type SocketCompatibleDuplex = Duplex & {
  setKeepAlive: (
    enable?: boolean,
    initialDelay?: number,
  ) => SocketCompatibleDuplex;
  setNoDelay: (noDelay?: boolean) => SocketCompatibleDuplex;
  setTimeout: (
    timeout: number,
    callback?: () => void,
  ) => SocketCompatibleDuplex;
};

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

function positiveInteger(
  value: number,
  code: CodexAppServerTransportErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CodexAppServerTransportError(code);
  }
  return value;
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/**
 * WebSocket client over a caller-owned, socket-compatible Duplex. The caller
 * remains responsible for spawning, bounding, and terminating its exact local
 * proxy process; this adapter never discovers or signals App Server.
 */
export class WebSocketDuplexTransport implements CodexAppServerTransport {
  static async connect(
    stream: SocketCompatibleDuplex,
    options: WebSocketDuplexTransportOptions = {},
  ): Promise<WebSocketDuplexTransport> {
    const maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "INVALID_CONFIGURATION",
    );
    const handshakeTimeoutMs = positiveInteger(
      options.handshakeTimeoutMs ?? 5_000,
      "INVALID_CONFIGURATION",
    );
    const closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? 2_000,
      "INVALID_CONFIGURATION",
    );
    const heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "INVALID_CONFIGURATION",
    );
    const heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      "INVALID_CONFIGURATION",
    );
    if (heartbeatTimeoutMs >= heartbeatIntervalMs) {
      throw new CodexAppServerTransportError("INVALID_CONFIGURATION");
    }

    const socket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => {
        stream.setNoDelay(true);
        stream.setKeepAlive(true, heartbeatIntervalMs);
        queueMicrotask(() => stream.emit("connect"));
        return stream as never;
      },
      followRedirects: false,
      handshakeTimeout: handshakeTimeoutMs,
      maxPayload: maxFrameBytes,
      perMessageDeflate: false,
    });
    // A permanent sink prevents an EventEmitter error from becoming an
    // uncaught exception before/after operation listeners are installed.
    socket.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: CodexAppServerTransportError) => {
        if (settled) return;
        settled = true;
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpectedResponse);
        if (error === undefined) resolve();
        else {
          socket.terminate();
          reject(error);
        }
      };
      const onOpen = () => finish();
      const onError = () =>
        finish(new CodexAppServerTransportError("TRANSPORT_CLOSED"));
      const onUnexpectedResponse = () =>
        finish(new CodexAppServerTransportError("PROTOCOL_ERROR"));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpectedResponse);
    });

    return new WebSocketDuplexTransport(
      socket,
      maxFrameBytes,
      closeTimeoutMs,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
    );
  }

  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(payload: string) => void>();
  private heartbeatInterval: NodeJS.Timeout | undefined;
  private heartbeatTimeout: NodeJS.Timeout | undefined;
  private heartbeatFailed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly maxFrameBytes: number,
    private readonly closeTimeoutMs: number,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    private readonly heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  ) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.emitError();
        socket.terminate();
        return;
      }
      const bytes = rawDataToBuffer(data);
      if (bytes.length > this.maxFrameBytes) {
        this.emitError();
        socket.terminate();
        return;
      }
      const payload = bytes.toString("utf8");
      for (const listener of this.messageListeners) listener(payload);
    });
    socket.on("pong", () => {
      if (this.heartbeatTimeout !== undefined) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = undefined;
      }
    });
    socket.on("error", () => this.failHeartbeat());
    socket.on("close", () => {
      this.stopHeartbeat();
      for (const listener of this.closeListeners) listener();
    });
    this.heartbeatInterval = setInterval(
      () => this.sendHeartbeat(),
      heartbeatIntervalMs,
    );
    this.heartbeatInterval.unref();
  }

  onMessage(listener: (payload: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async send(payload: string): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new CodexAppServerTransportError("TRANSPORT_CLOSED");
    }
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) {
      throw new CodexAppServerTransportError("INPUT_INVALID");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, (error) => {
        if (error == null) resolve();
        else {
          reject(
            new CodexAppServerTransportError(
              "TRANSPORT_WRITE_FAILED",
              true,
            ),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.off("close", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, this.closeTimeoutMs);
      this.socket.once("close", finish);
      this.socket.close(1000);
    });
  }

  private emitError(): void {
    for (const listener of this.errorListeners) listener();
  }

  private sendHeartbeat(): void {
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.heartbeatFailed ||
      this.heartbeatTimeout !== undefined
    ) {
      return;
    }
    try {
      this.socket.ping(undefined, undefined, (error) => {
        if (error != null) this.failHeartbeat();
      });
    } catch {
      this.failHeartbeat();
      return;
    }
    if (this.heartbeatFailed) return;
    this.heartbeatTimeout = setTimeout(
      () => this.failHeartbeat(),
      this.heartbeatTimeoutMs,
    );
    this.heartbeatTimeout.unref();
  }

  private failHeartbeat(): void {
    if (this.heartbeatFailed) return;
    this.heartbeatFailed = true;
    this.stopHeartbeat();
    this.emitError();
    this.socket.terminate();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.heartbeatTimeout !== undefined) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }
}
