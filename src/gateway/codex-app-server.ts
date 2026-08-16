import { Buffer } from "node:buffer";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";

import WebSocket from "ws";
import { sharesCompatibilityMajor } from "./compatibility.js";

/**
 * Stable App Server methods reviewed for the gateway's first writable version.
 *
 * `turn/steer` is exposed only through the exact Claude-to-Codex `STEER:`
 * contract. It queues input at the attested next tool-call boundary and never
 * authorizes an interrupt or a generic/public JSON-RPC escape hatch.
 */
export const CODEX_APP_SERVER_V1_METHODS = [
  "account/rateLimits/read",
  "model/list",
  "thread/archive",
  "thread/loaded/list",
  "thread/resume",
  "thread/start",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export const CODEX_PROBE_MODEL_PREFERENCE = ["gpt-5.6-luna"] as const;
export const CODEX_PROBE_EFFORT = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const CODEX_WRITE_PROBE_INPUT = "Reply with exactly OK. Do not use tools." as const;

type CodexProbeEffort = (typeof CODEX_PROBE_EFFORT)[number];

/** Exact App Server builds whose writable v2 schema was reviewed. */
export const CODEX_APP_SERVER_WRITABLE_VERSIONS = ["0.147.0"] as const;

export type CodexAppServerV1Method =
  (typeof CODEX_APP_SERVER_V1_METHODS)[number];

export type CodexRouteStatus =
  | "unknown"
  | "not_loaded"
  | "idle"
  | "starting"
  | "active"
  | "waiting_approval"
  | "interrupting"
  | "system_error"
  | "uncertain"
  | "stale";

export type CodexConnectorConnectionState =
  | "connecting"
  | "ready"
  | "closed"
  | "faulted";

export type CodexRouteIdentity = {
  endpointGeneration: string;
  threadId: string;
};

/**
 * Version/generation evidence supplied by the attach-only transport owner.
 * App Server's initialize result does not currently negotiate a protocol
 * version, so writable construction requires a separately attested tested
 * schema and write surface.
 * The attestation expires with any endpoint generation or binary change.
 */
export type CodexEndpointCompatibilityAttestation = {
  appServerVersion: string;
  endpointGeneration: string;
  protocol: "app-server-v2-stable";
  /** Internal marker for a read-only replacement probe; it never enables writes. */
  observedSchemaCandidate?: true;
  steering: {
    method: "turn/steer";
    requestSchema: "expected-turn-id-text-v1";
    deliveryBoundary: "next-tool-call-boundary";
  };
};

/**
 * Compare-and-swap guard for every route operation. A caller must obtain a
 * fresh guard after any request or notification changes route state.
 */
export type CodexRouteGuard = CodexRouteIdentity & {
  activeTurnId: string | null;
  revision: number;
  status: CodexRouteStatus;
  writableReady: boolean;
};

/** Safe dashboard/controller projection. It deliberately omits provider IDs. */
export type CodexConnectorObservation = {
  connection: CodexConnectorConnectionState;
  eventSequence: number;
  hasActiveTurn: boolean;
  queueDepth: number;
  requestInFlight: boolean;
  routeStatus: CodexRouteStatus;
  writableReady: boolean;
  writeBlockCode: CodexWriteBlockCode | null;
};

export type CodexWriteBlockCode = "WRITES_DISABLED";

export type CodexTurnOutcome = "completed" | "failed" | "interrupted";
export type CodexDeliveryOutcome =
  | CodexTurnOutcome
  | "abandoned"
  | "ambiguous"
  | "expired";

export type CodexConnectorEventKind =
  | "connection_ready"
  | "connection_closed"
  | "protocol_fault"
  | "request_started"
  | "thread_observed"
  | "thread_resumed"
  | "thread_unsubscribed"
  | "route_status_changed"
  | "route_write_blocked"
  | "message_queued"
  | "queued_messages_cancelled"
  | "turn_starting"
  | "turn_started"
  | "turn_steered"
  | "turn_interrupt_requested"
  | "turn_completed"
  | "approval_waiting"
  | "server_request_ignored"
  | "server_warning";

export type CodexConnectorEventDetails = {
  droppedMessages?: number;
  errorCode?: CodexConnectorErrorCode;
  loadedThreadCount?: number;
  messageBytes?: number;
  operation?: CodexAppServerV1Method | "initialize";
  selectedThreadLoaded?: boolean;
  turnOutcome?: CodexTurnOutcome;
};

/**
 * Normalized operational event. Raw prompts, output, tool data, paths, thread
 * IDs, turn IDs, JSON-RPC payloads, and server error strings never enter it.
 */
export type CodexConnectorEvent = CodexConnectorObservation & {
  details?: CodexConnectorEventDetails;
  kind: CodexConnectorEventKind;
  timestamp: string;
};

export type CodexConnectorErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_ROUTE"
  | "STALE_ENDPOINT"
  | "ROUTE_CAS_MISMATCH"
  | "ROUTE_NOT_READY"
  | "THREAD_NOT_OBSERVED"
  | "ROUTE_BUSY"
  | "TURN_NOT_OWNED"
  | "WRITES_DISABLED"
  | "INPUT_INVALID"
  | "QUEUE_FULL"
  | "MESSAGE_DUPLICATE"
  | "MESSAGE_CAPACITY"
  | "METHOD_NOT_ALLOWED"
  | "CONNECTOR_CLOSED"
  | "REQUEST_TIMEOUT"
  | "RPC_REJECTED"
  | "RESULT_SCHEMA_MISMATCH"
  | "TRANSPORT_WRITE_FAILED"
  | "TRANSPORT_CLOSED"
  | "PROTOCOL_ERROR";

export type CodexWriteCompatibilityProbeErrorCode =
  | "CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE"
  | "CODEX_WRITE_PROBE_MODEL_REROUTED"
  | "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED"
  | "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED"
  | "CODEX_WRITE_PROBE_TIMEOUT"
  | "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED"
  | "CODEX_WRITE_PROBE_RATE_LIMIT_CONSTRAINED";

export type CodexWriteCompatibilityProbeResult =
  | {
      archivedThreadCount: 1;
      outcome: "pass";
      settingsEchoObserved: boolean;
      tokenCount: number;
    }
  | {
      archivedThreadCount?: 1;
      outcome: "fail";
      safeErrorCode: CodexWriteCompatibilityProbeErrorCode;
      settingsEchoObserved: boolean;
      tokenCount?: number;
    };

export function codexWriteProbeFailure(
  safeErrorCode: CodexWriteCompatibilityProbeErrorCode,
  evidence: Partial<Pick<CodexWriteCompatibilityProbeResult,
    "archivedThreadCount" | "settingsEchoObserved" | "tokenCount">> = {},
): Extract<CodexWriteCompatibilityProbeResult, { outcome: "fail" }> {
  return {
    ...(evidence.archivedThreadCount === 1 ? { archivedThreadCount: 1 } : {}),
    outcome: "fail",
    safeErrorCode,
    settingsEchoObserved: evidence.settingsEchoObserved ?? false,
    ...(evidence.tokenCount === undefined
      ? {}
      : { tokenCount: evidence.tokenCount }),
  };
}

export class CodexConnectorError extends Error {
  readonly ambiguous: boolean;
  readonly code: CodexConnectorErrorCode;

  constructor(code: CodexConnectorErrorCode, ambiguous = false) {
    super(code);
    this.name = "CodexConnectorError";
    this.code = code;
    this.ambiguous = ambiguous;
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
  setKeepAlive: (enable?: boolean, initialDelay?: number) => SocketCompatibleDuplex;
  setNoDelay: (noDelay?: boolean) => SocketCompatibleDuplex;
  setTimeout: (
    timeout: number,
    callback?: () => void,
  ) => SocketCompatibleDuplex;
};

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_WATCHDOG_MS = 2 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUE_DEPTH = 32;
const DEFAULT_MAX_MESSAGE_IDS = 4_096;
const DEFAULT_MAX_DEADLINE_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/**
 * WebSocket client over a caller-owned, socket-compatible Duplex. The caller
 * remains responsible for spawning, bounding, and terminating its exact local
 * or SSH proxy process; this adapter never discovers or signals App Server.
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
      throw new CodexConnectorError("INVALID_CONFIGURATION");
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
    // uncaught exception before/after connector listeners are installed.
    socket.on("error", () => undefined);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: CodexConnectorError) => {
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
        finish(new CodexConnectorError("TRANSPORT_CLOSED"));
      const onUnexpectedResponse = () =>
        finish(new CodexConnectorError("PROTOCOL_ERROR"));
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
      throw new CodexConnectorError("TRANSPORT_CLOSED");
    }
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) {
      throw new CodexConnectorError("INPUT_INVALID");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, (error) => {
        if (error == null) resolve();
        else reject(new CodexConnectorError("TRANSPORT_WRITE_FAILED", true));
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

type ClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexAppServerConnectorOptions = {
  clientInfo?: ClientInfo;
  compatibility: CodexEndpointCompatibilityAttestation;
  maxDeadlineMs?: number;
  maxFrameBytes?: number;
  maxInputBytes?: number;
  maxMessageIds?: number;
  maxQueueDepth?: number;
  maxReplyBytes?: number;
  now?: () => Date;
  onEvent?: (event: CodexConnectorEvent) => void;
  onTurnResult?: (result: CodexTransientTurnResult) => void;
  requestTimeoutMs?: number;
  /** Enables only the closed disposable-thread probe API and its notifications. */
  writeCompatibilityProbe?: true;
  turnWatchdogMs?: number;
  route: CodexRouteIdentity;
  transport: CodexAppServerTransport;
  /** Immutable outer authorization; monitor-only connectors set this false. */
  writesEnabled: boolean;
};

export type CodexWriteCompatibilityProbeInput = {
  cwd: string;
  forbiddenThreadIds: readonly string[];
};

export type CodexMessageInput = {
  deadlineAt: string;
  messageId: string;
  steer?: true;
  text: string;
};

export type CodexMessageDisposition = {
  disposition: "deferred" | "expired" | "queued" | "started" | "steered";
  observation: CodexConnectorObservation;
};

/**
 * Ephemeral reply handoff. `text` is never copied into connector observations
 * or events and is discarded immediately after this synchronous callback.
 */
export type CodexTransientTurnResult = {
  messageId: string;
  outcome: CodexDeliveryOutcome;
  replyCode: "REPLY_TOO_LARGE" | "REPLY_UNAVAILABLE" | null;
  text: string | null;
};

export type CodexLoadedObservation = {
  loadedThreadCount: number;
  observation: CodexConnectorObservation;
  selectedThreadLoaded: boolean;
};

export type CodexUnsubscribeResult = {
  observation: CodexConnectorObservation;
  status: "notLoaded" | "notSubscribed" | "unsubscribed";
};

type PendingRequest = {
  method: CodexAppServerV1Method | "initialize";
  reject: (error: CodexConnectorError) => void;
  resolve: (result: unknown) => void;
  timer: NodeJS.Timeout;
};

type QueuedMessage = {
  byteLength: number;
  deadlineAtMs: number;
  messageId: string;
  text: string;
};

const V1_METHOD_SET = new Set<string>(CODEX_APP_SERVER_V1_METHODS);
const PROBE_ONLY_METHODS = new Set<string>([
  "account/rateLimits/read", "model/list", "thread/archive", "thread/start",
]);

const OUTPUT_NOTIFICATION_OPT_OUTS = [
  "item/started",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "turn/diff/updated",
  "turn/plan/updated",
] as const;

const PROBE_PASSIVE_ITEM_TYPES = new Set(["agentMessage", "reasoning", "userMessage"]);
const PROBE_TOOL_NOTIFICATION_METHODS = new Set([
  "item/autoApprovalReview/completed", "item/autoApprovalReview/started",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
]);
const MAX_PROBE_TOKEN_COUNT = 1_000_000_000;

type ProbePhase = "awaiting_start" | "started" | "item_completed" | "terminal";

type ProbeRuntime = {
  expectedCwd: string;
  expectedEffort: CodexProbeEffort;
  expectedModel: string;
  failCode: CodexWriteCompatibilityProbeErrorCode | null;
  phase: ProbePhase;
  resolveTurn: (() => void) | null;
  settingsEchoObserved: boolean;
  settingsThreadId: string | null;
  threadId: string | null;
  tokenCount: number | null;
  turnId: string | null;
};

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function positiveInteger(
  value: number,
  code: CodexConnectorErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CodexConnectorError(code);
  }
  return value;
}

function validOpaqueId(value: string, maximumLength = 256): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function validUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function parseLoadedThreadIds(value: unknown): string[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    (value.nextCursor !== undefined && value.nextCursor !== null)
  ) {
    return null;
  }
  if (
    value.data.length > 100_000 ||
    !value.data.every(
      (threadId) => typeof threadId === "string" && validOpaqueId(threadId),
    ) ||
    new Set(value.data).size !== value.data.length
  ) {
    return null;
  }
  return value.data;
}

function rateLimitConstrained(value: unknown): boolean | null {
  if (!isRecord(value) || !isRecord(value.rateLimits)) return null;
  const byLimit = value.rateLimitsByLimitId;
  const snapshot =
    isRecord(byLimit) && isRecord(byLimit.codex)
      ? byLimit.codex
      : value.rateLimits;
  const percent = (container: unknown, key: string): number | null => {
    if (container === null || container === undefined) return Number.NaN;
    if (!isRecord(container) || !Number.isSafeInteger(container[key])) return null;
    const result = container[key] as number;
    return result >= 0 && result <= 100 ? result : null;
  };
  const remaining = percent(snapshot.individualLimit, "remainingPercent");
  const primary = percent(snapshot.primary, "usedPercent");
  const secondary = percent(snapshot.secondary, "usedPercent");
  if ([remaining, primary, secondary].includes(null)) return null;
  if (
    (snapshot.rateLimitReachedType !== null &&
      snapshot.rateLimitReachedType !== undefined) ||
    snapshot.spendControlReached === true
  ) {
    return true;
  }
  if (
    snapshot.spendControlReached !== null &&
    snapshot.spendControlReached !== undefined &&
    snapshot.spendControlReached !== false
  ) {
    return null;
  }
  return (
    (!Number.isNaN(remaining) && (remaining as number) <= 5) ||
    (!Number.isNaN(primary) && (primary as number) >= 95) ||
    (!Number.isNaN(secondary) && (secondary as number) >= 95)
  );
}

function validateRoute(route: CodexRouteIdentity): CodexRouteIdentity {
  if (
    !validOpaqueId(route.threadId) ||
    !validOpaqueId(route.endpointGeneration, 128)
  ) {
    throw new CodexConnectorError("INVALID_ROUTE");
  }
  return { ...route };
}

function validateClientInfo(clientInfo: ClientInfo): ClientInfo {
  const values = [clientInfo.name, clientInfo.title, clientInfo.version];
  if (
    values.some(
      (value) =>
        value.length === 0 ||
        value.length > 128 ||
        value.includes("\0") ||
        /[\r\n]/u.test(value),
    )
  ) {
    throw new CodexConnectorError("INVALID_CONFIGURATION");
  }
  return { ...clientInfo };
}

function validateCompatibility(
  compatibility: CodexEndpointCompatibilityAttestation,
  route: CodexRouteIdentity,
): CodexEndpointCompatibilityAttestation {
  if (
    compatibility.endpointGeneration !== route.endpointGeneration ||
    compatibility.protocol !== "app-server-v2-stable" ||
    compatibility.steering?.method !== "turn/steer" ||
    compatibility.steering.requestSchema !== "expected-turn-id-text-v1" ||
    compatibility.steering.deliveryBoundary !== "next-tool-call-boundary" ||
    !(
      CODEX_APP_SERVER_WRITABLE_VERSIONS.some(
        (version) => version === compatibility.appServerVersion,
      ) ||
      (compatibility.observedSchemaCandidate === true &&
        CODEX_APP_SERVER_WRITABLE_VERSIONS.some((version) =>
          sharesCompatibilityMajor(version, compatibility.appServerVersion),
        ))
    )
  ) {
    throw new CodexConnectorError("INVALID_CONFIGURATION");
  }
  return { ...compatibility, steering: { ...compatibility.steering } };
}

function parseRouteStatus(value: unknown): CodexRouteStatus | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "notLoaded") return "not_loaded";
  if (value.type === "idle") return "idle";
  if (value.type === "systemError") return "system_error";
  if (value.type !== "active") return null;
  if (value.activeFlags === undefined) return "active";
  if (
    !Array.isArray(value.activeFlags) ||
    value.activeFlags.length > 32 ||
    !value.activeFlags.every(
      (flag) => typeof flag === "string" && flag.length <= 128,
    )
  ) {
    return null;
  }
  return value.activeFlags.includes("waitingOnApproval")
    ? "waiting_approval"
    : "active";
}

function parseTurn(value: unknown): {
  id: string;
  status: string;
} | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !validOpaqueId(value.id) ||
    typeof value.status !== "string" ||
    value.status.length > 64
  ) {
    return null;
  }
  return { id: value.id, status: value.status };
}

/**
 * One connection, one exact opted-in Codex route, one endpoint generation.
 * Reconnection creates a new connector/generation; this object never retries
 * an ambiguous write or silently rebinds a stale route.
 */
export class CodexAppServerConnector {
  static async connect(
    options: CodexAppServerConnectorOptions,
  ): Promise<CodexAppServerConnector> {
    const connector = new CodexAppServerConnector(options);
    await connector.initialize();
    return connector;
  }

  private readonly acceptedMessageIds = new Set<string>();
  private activeMessageId: string | null = null;
  private activeTurnId: string | null = null;
  private connection: CodexConnectorConnectionState = "connecting";
  private drainScheduled = false;
  private eventSequence = 0;
  private expectedClose = false;
  private faulting = false;
  private consecutiveRequestTimeouts = 0;
  private inFlightMethod: CodexAppServerV1Method | null = null;
  private initializeRequested = false;
  private initialized = false;
  private lastCompletedTurnId: string | null = null;
  private nextRequestId = 1;
  private ownsActiveTurn = false;
  private readonly pending = new Map<number, PendingRequest>();
  private probeAttempted = false;
  private probeRuntime: ProbeRuntime | null = null;
  private readonly queue: QueuedMessage[] = [];
  private revision = 0;
  private routeStatus: CodexRouteStatus = "unknown";
  private selectedThreadObserved = false;
  private statusEpoch = 0;
  private transientReply: string | null = null;
  private transientReplyTooLarge = false;
  private turnWatchdogTimer: NodeJS.Timeout | undefined;
  private readonly unlisten: Array<() => void> = [];

  private readonly clientInfo: ClientInfo;
  private readonly compatibility: CodexEndpointCompatibilityAttestation;
  private readonly maxDeadlineMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxInputBytes: number;
  private readonly maxMessageIds: number;
  private readonly maxQueueDepth: number;
  private readonly maxReplyBytes: number;
  private readonly now: () => Date;
  private readonly onEvent: ((event: CodexConnectorEvent) => void) | undefined;
  private readonly onTurnResult:
    | ((result: CodexTransientTurnResult) => void)
    | undefined;
  private readonly requestTimeoutMs: number;
  private readonly turnWatchdogMs: number;
  private readonly route: CodexRouteIdentity;
  private readonly transport: CodexAppServerTransport;
  private readonly writeCompatibilityProbe: boolean;
  private readonly writesEnabled: boolean;

  private constructor(options: CodexAppServerConnectorOptions) {
    this.route = validateRoute(options.route);
    this.compatibility = validateCompatibility(options.compatibility, this.route);
    if (typeof options.writesEnabled !== "boolean") {
      throw new CodexConnectorError("INVALID_CONFIGURATION");
    }
    if (
      options.writesEnabled &&
      !CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
        options.compatibility.appServerVersion as (typeof CODEX_APP_SERVER_WRITABLE_VERSIONS)[number],
      )
    ) {
      throw new CodexConnectorError("INVALID_CONFIGURATION");
    }
    this.writesEnabled = options.writesEnabled;
    this.writeCompatibilityProbe = options.writeCompatibilityProbe === true;
    this.transport = options.transport;
    this.clientInfo = validateClientInfo(
      options.clientInfo ?? {
        name: "agent_embassy_gateway",
        title: "Embassy Gateway",
        version: "1.5.0",
      },
    );
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "INVALID_CONFIGURATION",
    );
    this.maxDeadlineMs = positiveInteger(
      options.maxDeadlineMs ?? DEFAULT_MAX_DEADLINE_MS,
      "INVALID_CONFIGURATION",
    );
    this.maxInputBytes = positiveInteger(
      options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      "INVALID_CONFIGURATION",
    );
    this.maxMessageIds = positiveInteger(
      options.maxMessageIds ?? DEFAULT_MAX_MESSAGE_IDS,
      "INVALID_CONFIGURATION",
    );
    this.maxQueueDepth = positiveInteger(
      options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
      "INVALID_CONFIGURATION",
    );
    this.maxReplyBytes = positiveInteger(
      options.maxReplyBytes ?? DEFAULT_MAX_INPUT_BYTES,
      "INVALID_CONFIGURATION",
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "INVALID_CONFIGURATION",
    );
    this.turnWatchdogMs = positiveInteger(
      options.turnWatchdogMs ?? DEFAULT_TURN_WATCHDOG_MS,
      "INVALID_CONFIGURATION",
    );
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.onTurnResult = options.onTurnResult;

    this.unlisten.push(
      this.transport.onMessage((payload) => this.handlePayload(payload)),
      this.transport.onClose(() => this.handleDisconnect()),
      this.transport.onError(() => this.protocolFault("TRANSPORT_CLOSED")),
    );
  }

  observation(): CodexConnectorObservation {
    const writeBlockCode = this.currentWriteBlockCode();
    return {
      connection: this.connection,
      eventSequence: this.eventSequence,
      hasActiveTurn: this.activeTurnId !== null,
      queueDepth: this.queue.length,
      requestInFlight: this.inFlightMethod !== null,
      routeStatus: this.routeStatus,
      writableReady: this.isWritableReady(),
      writeBlockCode,
    };
  }

  guard(): CodexRouteGuard {
    const writableReady = this.isWritableReady();
    return {
      ...this.route,
      activeTurnId: this.activeTurnId,
      revision: this.revision,
      status: this.routeStatus,
      writableReady,
    };
  }

  async observeLoadedThread(
    guard: CodexRouteGuard,
  ): Promise<CodexLoadedObservation> {
    this.assertGuard(guard);
    this.assertReady();
    this.assertNoRequest();
    this.beginRequest("thread/loaded/list");
    try {
      const result = await this.request("thread/loaded/list", {});
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
      }
      const data = result.data;
      if (
        data.length > 100_000 ||
        !data.every(
          (item) => typeof item === "string" && validOpaqueId(item),
        )
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
      }
      const selectedThreadMatches = data.reduce(
        (count, item) => count + (item === this.route.threadId ? 1 : 0),
        0,
      );
      if (selectedThreadMatches > 1) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
      }
      const selectedThreadLoaded = selectedThreadMatches === 1;
      if (this.selectedThreadObserved !== selectedThreadLoaded) {
        this.selectedThreadObserved = selectedThreadLoaded;
        this.bumpRevision();
      }
      if (!selectedThreadLoaded) {
        if (
          this.routeStatus === "active" ||
          this.routeStatus === "waiting_approval" ||
          this.routeStatus === "interrupting" ||
          this.activeTurnId !== null
        ) {
          throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
        }
        this.setRouteStatus("not_loaded");
      }
      const loadedObservation = {
        loadedThreadCount: data.length,
        selectedThreadLoaded,
      };
      this.emit("thread_observed", {
        loadedThreadCount: data.length,
        selectedThreadLoaded,
      });
      this.finishRequest("thread/loaded/list");
      return { ...loadedObservation, observation: this.observation() };
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      if (normalized.ambiguous && this.connection === "ready") {
        this.settleActiveDelivery("ambiguous");
        this.setRouteStatus("uncertain");
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      this.finishRequest("thread/loaded/list");
    }
  }

  async resumeThread(guard: CodexRouteGuard): Promise<CodexConnectorObservation> {
    this.assertGuard(guard);
    this.assertReady();
    this.assertNoRequest();
    if (!this.selectedThreadObserved) {
      throw new CodexConnectorError("THREAD_NOT_OBSERVED");
    }
    if (
      this.routeStatus !== "unknown" &&
      this.routeStatus !== "not_loaded" &&
      !(
        this.currentWriteBlockCode() !== null &&
        this.routeStatus === "idle" &&
        this.activeTurnId === null
      )
    ) {
      throw new CodexConnectorError("ROUTE_BUSY");
    }
    const statusEpoch = this.statusEpoch;
    this.beginRequest("thread/resume");
    try {
      const result = await this.request("thread/resume", {
        excludeTurns: true,
        threadId: this.route.threadId,
      });
      if (
        !isRecord(result) ||
        !isRecord(result.thread) ||
        !Array.isArray(result.thread.turns) ||
        result.thread.turns.length !== 0
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (result.thread.id !== this.route.threadId) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (this.statusEpoch === statusEpoch) {
        const status = parseRouteStatus(result.thread.status);
        if (status === null) {
          // A response without status proves subscription but not idleness. Do
          // not guess; queued/model actions remain fail-closed until status is
          // observed.
          this.setRouteStatus("unknown");
        } else {
          this.setRouteStatus(status);
        }
      }
      this.emit("thread_resumed");
      const writeBlockCode = this.currentWriteBlockCode();
      if (writeBlockCode !== null) {
        this.emit("route_write_blocked", { errorCode: writeBlockCode });
      }
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      if (normalized.ambiguous && this.connection === "ready") {
        this.setRouteStatus("uncertain");
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      this.finishRequest("thread/resume");
    }
    return this.observation();
  }

  async unsubscribeThread(
    guard: CodexRouteGuard,
  ): Promise<CodexUnsubscribeResult> {
    this.assertGuard(guard);
    this.assertReady();
    this.assertNoRequest();
    if (
      this.activeTurnId !== null ||
      this.routeStatus === "active" ||
      this.routeStatus === "waiting_approval" ||
      this.routeStatus === "starting" ||
      this.routeStatus === "interrupting"
    ) {
      throw new CodexConnectorError("ROUTE_BUSY");
    }
    this.dropQueuedMessages();
    this.beginRequest("thread/unsubscribe");
    try {
      const result = await this.request("thread/unsubscribe", {
        threadId: this.route.threadId,
      });
      if (
        !isRecord(result) ||
        (result.status !== "unsubscribed" &&
          result.status !== "notSubscribed" &&
          result.status !== "notLoaded")
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
      }
      this.setRouteStatus("not_loaded");
      this.selectedThreadObserved = false;
      this.emit("thread_unsubscribed");
      const status = result.status;
      this.finishRequest("thread/unsubscribe");
      return { observation: this.observation(), status };
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      if (normalized.ambiguous && this.connection === "ready") {
        this.setRouteStatus("uncertain");
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      this.finishRequest("thread/unsubscribe");
    }
  }

  /**
   * Drop only this exact route's transient queued bodies. Route disable and
   * unregister paths use this before releasing broker ownership.
   */
  cancelQueuedMessages(guard: CodexRouteGuard): CodexConnectorObservation {
    this.assertGuard(guard);
    this.assertReady();
    const droppedMessages = this.dropQueuedMessages();
    this.emit("queued_messages_cancelled", { droppedMessages });
    return this.observation();
  }

  async submitMessage(
    guard: CodexRouteGuard,
    input: CodexMessageInput,
  ): Promise<CodexMessageDisposition> {
    this.assertGuard(guard);
    this.assertReady();
    if (!this.selectedThreadObserved) {
      throw new CodexConnectorError("THREAD_NOT_OBSERVED");
    }
    if (input.steer === true && this.routeStatus === "active") {
      this.assertWritableReady();
      const message = this.validateMessage(input);
      if (this.activeTurnId === null || this.inFlightMethod !== null) {
        this.acceptedMessageIds.delete(message.messageId);
        return { disposition: "deferred", observation: this.observation() };
      }
      const disposition = await this.steerMessage(message);
      return { disposition, observation: this.observation() };
    }
    if (
      this.routeStatus === "starting" ||
      this.routeStatus === "active" ||
      this.routeStatus === "waiting_approval" ||
      this.routeStatus === "interrupting"
    ) {
      this.assertWritableReady();
      const message = this.validateMessage(input);
      if (input.steer === true) {
        this.acceptedMessageIds.delete(message.messageId);
        return { disposition: "deferred", observation: this.observation() };
      }
      this.enqueue(message);
      return { disposition: "queued", observation: this.observation() };
    }
    this.assertWritableReady();
    const message = this.validateMessage(input);
    if (this.routeStatus !== "idle") {
      this.acceptedMessageIds.delete(message.messageId);
      throw new CodexConnectorError("ROUTE_NOT_READY");
    }

    const disposition = await this.startMessage(message);
    return { disposition, observation: this.observation() };
  }

  /**
   * Interrupt only a connector-originated turn whose exact ID is present in a
   * fresh CAS guard. The method clears queued work and never targets a Desktop
   * or user-originated active turn.
   */
  async interruptOwnedTurn(
    guard: CodexRouteGuard,
  ): Promise<CodexConnectorObservation> {
    this.assertGuard(guard);
    this.assertReady();
    this.assertNoRequest();
    if (!this.selectedThreadObserved) {
      throw new CodexConnectorError("THREAD_NOT_OBSERVED");
    }
    if (
      !this.ownsActiveTurn ||
      this.activeTurnId === null ||
      guard.activeTurnId !== this.activeTurnId ||
      (this.routeStatus !== "active" &&
        this.routeStatus !== "waiting_approval")
    ) {
      throw new CodexConnectorError("TURN_NOT_OWNED");
    }

    const turnId = this.activeTurnId;
    const droppedMessages = this.dropQueuedMessages();
    this.beginRequest("turn/interrupt");
    try {
      const result = await this.request("turn/interrupt", {
        threadId: this.route.threadId,
        turnId,
      });
      if (!isRecord(result)) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      // A completion notification can win the race with the response.
      if (this.activeTurnId === turnId && this.ownsActiveTurn) {
        this.setRouteStatus("interrupting");
      }
      this.emit("turn_interrupt_requested", { droppedMessages });
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      if (normalized.ambiguous && this.connection === "ready") {
        this.settleActiveDelivery("ambiguous");
        this.activeTurnId = null;
        this.setRouteStatus("uncertain");
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      this.finishRequest("turn/interrupt");
    }
    return this.observation();
  }

  async close(): Promise<void> {
    if (this.connection === "closed" || this.connection === "faulted") return;
    this.clearTurnWatchdog();
    this.expectedClose = true;
    try {
      await this.transport.close();
    } finally {
      this.handleDisconnect();
    }
  }

  /**
   * Run the one fixed disposable-thread write probe. The method never exposes
   * JSON-RPC, native IDs, content, or route state, and every failure settles as
   * a safe result so compatibility discovery cannot take down the broker.
   */
  async runWriteCompatibilityProbe(
    input: CodexWriteCompatibilityProbeInput,
  ): Promise<CodexWriteCompatibilityProbeResult> {
    if (this.probeAttempted) {
      return codexWriteProbeFailure("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
    }
    this.probeAttempted = true;
    let threadId: string | null = null;
    let archivedThreadCount: 1 | undefined;
    let result: CodexWriteCompatibilityProbeResult = codexWriteProbeFailure(
      "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
    );
    try {
      if (
        !this.writeCompatibilityProbe ||
        this.connection !== "ready" ||
        this.inFlightMethod !== null ||
        this.pending.size !== 0 ||
        !isAbsolute(input.cwd) ||
        !Array.isArray(input.forbiddenThreadIds) ||
        !input.forbiddenThreadIds.every(
          (value) => typeof value === "string" && validOpaqueId(value),
        )
      ) {
        return result;
      }
      const beforeStat = await stat(input.cwd, { bigint: true });
      const beforeEntries = await readdir(input.cwd);
      if (
        !beforeStat.isDirectory() ||
        beforeStat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (beforeStat.mode & 0o777n) !== 0o700n ||
        beforeEntries.length !== 0
      ) {
        return result;
      }

      const limits = rateLimitConstrained(
        await this.request("account/rateLimits/read", null),
      );
      if (limits === null) return result;
      if (limits) {
        return codexWriteProbeFailure(
          "CODEX_WRITE_PROBE_RATE_LIMIT_CONSTRAINED",
        );
      }

      const selection = this.selectProbeModel(
        await this.request("model/list", {
          includeHidden: true,
          limit: 100,
        }).catch(() => null),
      );
      if (selection === null) {
        return codexWriteProbeFailure(
          "CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE",
        );
      }
      const [model, effort] = selection;

      const loadedBefore = parseLoadedThreadIds(
        await this.request("thread/loaded/list", {}),
      );
      if (loadedBefore === null) return result;
      const runtime: ProbeRuntime = {
        expectedCwd: input.cwd,
        expectedEffort: effort,
        expectedModel: model,
        failCode: null,
        phase: "awaiting_start",
        resolveTurn: null,
        settingsEchoObserved: false,
        settingsThreadId: null,
        threadId: null,
        tokenCount: null,
        turnId: null,
      };
      this.probeRuntime = runtime;
      const started = await this.request("thread/start", {
        allowProviderModelFallback: false,
        approvalPolicy: "never",
        cwd: input.cwd,
        dynamicTools: [],
        environments: [],
        ephemeral: false,
        model,
        runtimeWorkspaceRoots: [],
        sandbox: "read-only",
        selectedCapabilityRoots: [],
      });
      const candidateThreadId = this.probeCleanupThreadId(
        started,
        loadedBefore,
        input.forbiddenThreadIds,
      );
      if (
        candidateThreadId === null ||
        !this.validateProbeThread(
          started,
          input.cwd,
          model,
          candidateThreadId,
        )
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      threadId = candidateThreadId;
      runtime.threadId = candidateThreadId;
      if (
        runtime.settingsThreadId !== null &&
        runtime.settingsThreadId !== candidateThreadId
      ) {
        runtime.failCode = "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED";
      }
      if (runtime.failCode === null) {
        const turnResult = await this.request("turn/start", {
          approvalPolicy: "never",
          cwd: input.cwd,
          effort,
          environments: [],
          input: [{ text: CODEX_WRITE_PROBE_INPUT, type: "text" }],
          model,
          runtimeWorkspaceRoots: [],
          sandboxPolicy: { networkAccess: false, type: "readOnly" },
          threadId,
        });
        const turn = isRecord(turnResult) ? parseTurn(turnResult.turn) : null;
        if (
          turn === null ||
          !isRecord(turnResult) ||
          !isRecord(turnResult.turn) ||
          !Array.isArray(turnResult.turn.items) ||
          (turn.status !== "inProgress" && turn.status !== "completed")
        ) {
          throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
        }
        if (runtime.turnId !== null && runtime.turnId !== turn.id) {
          throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
        }
        runtime.turnId = turn.id;
        await this.waitForProbeTurn(runtime);
      }
      if (runtime.failCode !== null) {
        result = codexWriteProbeFailure(runtime.failCode, {
          settingsEchoObserved: runtime.settingsEchoObserved,
          ...(runtime.tokenCount === null
            ? {}
            : { tokenCount: runtime.tokenCount }),
        });
      } else if (
        runtime.phase === "terminal" &&
        runtime.tokenCount !== null
      ) {
        const afterStat = await stat(input.cwd, { bigint: true });
        const afterEntries = await readdir(input.cwd);
        if (
          afterEntries.length === 0 &&
          afterStat.dev === beforeStat.dev &&
          afterStat.ino === beforeStat.ino &&
          afterStat.mtimeNs === beforeStat.mtimeNs &&
          afterStat.uid === beforeStat.uid &&
          afterStat.mode === beforeStat.mode
        ) {
          result = {
            archivedThreadCount: 1,
            outcome: "pass",
            settingsEchoObserved: runtime.settingsEchoObserved,
            tokenCount: runtime.tokenCount,
          };
        } else {
          result = codexWriteProbeFailure(
            "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED",
            {
              settingsEchoObserved: runtime.settingsEchoObserved,
              tokenCount: runtime.tokenCount,
            },
          );
        }
      }
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      const runtime = this.probeRuntime;
      result = codexWriteProbeFailure(
        normalized.code === "REQUEST_TIMEOUT"
          ? "CODEX_WRITE_PROBE_TIMEOUT"
          : "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
        {
          settingsEchoObserved: runtime?.settingsEchoObserved ?? false,
          ...(runtime?.tokenCount === null || runtime?.tokenCount === undefined
            ? {}
            : { tokenCount: runtime.tokenCount }),
        },
      );
    } finally {
      const runtime = this.probeRuntime;
      if (
        threadId !== null &&
        runtime !== null &&
        runtime.turnId !== null &&
        (result.outcome === "fail" || runtime.failCode !== null)
      ) {
        try {
          await this.request("turn/interrupt", {
            threadId,
            turnId: runtime.turnId,
          });
        } catch {
          // Archival remains the one required cleanup proof below.
        }
      }
      let cleanupUnconfirmed = runtime !== null && threadId === null;
      if (threadId !== null) {
        try {
          const archived = await this.request("thread/archive", { threadId });
          if (!isRecord(archived) || Object.keys(archived).length !== 0) {
            throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
          }
          archivedThreadCount = 1;
          const unsubscribed = await this.request("thread/unsubscribe", {
            threadId,
          });
          if (
            !isRecord(unsubscribed) ||
            (unsubscribed.status !== "unsubscribed" &&
              unsubscribed.status !== "notSubscribed" &&
              unsubscribed.status !== "notLoaded")
          ) {
            throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
          }
          const loadedAfter = parseLoadedThreadIds(
            await this.request("thread/loaded/list", {}),
          );
          if (loadedAfter === null || loadedAfter.includes(threadId)) {
            throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
          }
        } catch {
          cleanupUnconfirmed = true;
        }
      }
      const tokenCount = runtime?.tokenCount ?? result.tokenCount;
      const evidence = {
        ...(archivedThreadCount === undefined ? {} : { archivedThreadCount }),
        settingsEchoObserved:
          runtime?.settingsEchoObserved ?? result.settingsEchoObserved,
        ...(tokenCount === undefined ? {} : { tokenCount }),
      };
      if (cleanupUnconfirmed || (result.outcome === "pass" && archivedThreadCount !== 1)) {
        result = codexWriteProbeFailure(
          "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
          evidence,
        );
      } else if (runtime?.failCode !== null && runtime?.failCode !== undefined) {
        result = codexWriteProbeFailure(runtime.failCode, evidence);
      }
      if (result.outcome === "fail") {
        result = codexWriteProbeFailure(result.safeErrorCode, evidence);
      }
      this.probeRuntime = null;
    }
    return result;
  }

  private selectProbeModel(value: unknown): readonly [string, CodexProbeEffort] | null {
    if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 100) {
      return null;
    }
    const data: unknown[] = value.data;
    for (const model of CODEX_PROBE_MODEL_PREFERENCE) {
      const candidate = data.find(
        (entry) =>
          isRecord(entry) &&
          entry.model === model &&
          entry.hidden === false,
      );
      if (!isRecord(candidate) || !Array.isArray(candidate.supportedReasoningEfforts)) {
        continue;
      }
      const supported: unknown[] = candidate.supportedReasoningEfforts;
      const effort = CODEX_PROBE_EFFORT.find((preference) =>
        supported.some(
          (option) =>
            isRecord(option) && option.reasoningEffort === preference,
        ),
      );
      if (effort !== undefined) return [model, effort];
    }
    return null;
  }

  private probeCleanupThreadId(
    value: unknown,
    loadedBefore: readonly string[],
    forbiddenThreadIds: readonly string[],
  ): string | null {
    if (
      !isRecord(value) ||
      !isRecord(value.thread) ||
      typeof value.thread.id !== "string" ||
      !validUuidV7(value.thread.id) ||
      value.thread.id === this.route.threadId ||
      loadedBefore.includes(value.thread.id) ||
      forbiddenThreadIds.includes(value.thread.id)
    ) {
      return null;
    }
    return value.thread.id;
  }

  private validateProbeThread(
    value: unknown,
    cwd: string,
    model: string,
    threadId: string,
  ): boolean {
    if (!isRecord(value) || !isRecord(value.thread)) return false;
    const roots = value.runtimeWorkspaceRoots;
    const networkAccess = isRecord(value.sandbox)
      ? value.sandbox.networkAccess
      : undefined;
    return (
      value.approvalPolicy === "never" &&
      value.cwd === cwd &&
      value.model === model &&
      isRecord(value.sandbox) &&
      value.sandbox.type === "readOnly" &&
      (networkAccess === undefined || networkAccess === false) &&
      (roots === undefined || (Array.isArray(roots) && roots.length === 0)) &&
      value.thread.id === threadId &&
      value.thread.cwd === cwd &&
      value.thread.ephemeral === false &&
      isRecord(value.thread.status) &&
      value.thread.status.type === "idle" &&
      Array.isArray(value.thread.turns) &&
      value.thread.turns.length === 0
    );
  }

  private async waitForProbeTurn(runtime: ProbeRuntime): Promise<void> {
    if (
      runtime.failCode !== null ||
      (runtime.phase === "terminal" && runtime.tokenCount !== null)
    ) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      runtime.resolveTurn = resolve;
      timer = setTimeout(resolve, this.turnWatchdogMs);
    });
    runtime.resolveTurn = null;
    if (timer !== undefined) clearTimeout(timer);
    if (
      runtime.failCode === null &&
      !(runtime.phase === "terminal" && runtime.tokenCount !== null)
    ) {
      runtime.failCode = "CODEX_WRITE_PROBE_TIMEOUT";
    }
  }

  private settleProbeRuntime(): void {
    const runtime = this.probeRuntime;
    if (runtime === null || runtime.resolveTurn === null) return;
    if (
      runtime.failCode !== null ||
      (runtime.phase === "terminal" && runtime.tokenCount !== null)
    ) {
      runtime.resolveTurn();
    }
  }

  private settleProbeConnectionLoss(): void {
    if (this.probeRuntime === null) return;
    this.probeRuntime.failCode ??= "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED";
    this.settleProbeRuntime();
  }

  private async initialize(): Promise<void> {
    try {
      const result = await this.request("initialize", {
        capabilities: {
          // `thread/resume.excludeTurns` is field-gated behind this capability
          // in the exactly attested 0.147.0 schema. The client method allowlist
          // remains closed and exposes no experimental method.
          experimentalApi: true,
          optOutNotificationMethods: OUTPUT_NOTIFICATION_OPT_OUTS.filter(
            (method) =>
              method !== "item/started" || !this.writeCompatibilityProbe,
          ),
        },
        clientInfo: this.clientInfo,
      });
      if (!isRecord(result)) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH");
      }
      await this.transport.send(
        JSON.stringify({ method: "initialized", params: {} }),
      );
      this.initialized = true;
      this.connection = "ready";
      this.bumpRevision();
      this.emit("connection_ready");
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      this.protocolFault(normalized.code);
      throw normalized;
    }
  }

  private validateMessage(input: CodexMessageInput): QueuedMessage {
    if (
      !validOpaqueId(input.messageId, 128) ||
      typeof input.text !== "string" ||
      input.text.trim().length === 0 ||
      input.text.includes("\0")
    ) {
      throw new CodexConnectorError("INPUT_INVALID");
    }
    const nowMs = this.now().getTime();
    const deadlineAtMs =
      typeof input.deadlineAt === "string"
        ? Date.parse(input.deadlineAt)
        : Number.NaN;
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(deadlineAtMs) ||
      new Date(deadlineAtMs).toISOString() !== input.deadlineAt ||
      deadlineAtMs <= nowMs ||
      deadlineAtMs > nowMs + this.maxDeadlineMs
    ) {
      throw new CodexConnectorError("INPUT_INVALID");
    }
    const byteLength = Buffer.byteLength(input.text, "utf8");
    if (byteLength === 0 || byteLength > this.maxInputBytes) {
      throw new CodexConnectorError("INPUT_INVALID");
    }
    if (this.acceptedMessageIds.has(input.messageId)) {
      throw new CodexConnectorError("MESSAGE_DUPLICATE");
    }
    if (this.acceptedMessageIds.size >= this.maxMessageIds) {
      throw new CodexConnectorError("MESSAGE_CAPACITY");
    }
    this.acceptedMessageIds.add(input.messageId);
    return {
      byteLength,
      deadlineAtMs,
      messageId: input.messageId,
      text: input.text,
    };
  }

  private enqueue(message: QueuedMessage): void {
    if (this.queue.length >= this.maxQueueDepth) {
      this.acceptedMessageIds.delete(message.messageId);
      throw new CodexConnectorError("QUEUE_FULL");
    }
    this.queue.push(message);
    this.bumpRevision();
    this.emit("message_queued", { messageBytes: message.byteLength });
  }

  private async startMessage(
    message: QueuedMessage,
  ): Promise<"expired" | "started"> {
    this.assertNoRequest();
    this.assertWritableReady();
    if (this.messageExpired(message)) {
      this.expireMessage(message);
      return "expired";
    }

    // Reserve queue order while the host-local lease is being revalidated,
    // but do not claim turn ownership until immediately before the RPC write.
    this.activeMessageId = message.messageId;
    this.ownsActiveTurn = false;
    this.transientReply = null;
    this.transientReplyTooLarge = false;
    this.setRouteStatus("starting");
    let requestBegan = false;
    try {
      await this.refreshExactRouteBoundary();
      if (this.messageExpired(message)) {
        this.activeMessageId = null;
        this.acceptedMessageIds.delete(message.messageId);
        if (this.routeStatus === "starting") this.setRouteStatus("idle");
        this.settleDelivery(message.messageId, "expired");
        return "expired";
      }
      if (
        this.connection !== "ready" ||
        this.routeStatus !== "starting" ||
        this.activeMessageId !== message.messageId
      ) {
        throw new CodexConnectorError("ROUTE_NOT_READY");
      }

      const statusEpoch = this.statusEpoch;
      this.ownsActiveTurn = true;
      this.emit("turn_starting", { messageBytes: message.byteLength });
      this.beginRequest("turn/start");
      requestBegan = true;
      const result = await this.request("turn/start", {
        input: [{ text: message.text, type: "text" }],
        threadId: this.route.threadId,
      });
      if (!isRecord(result)) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      const turn = parseTurn(result.turn);
      if (turn === null || turn.status !== "inProgress") {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (this.activeTurnId !== null && this.activeTurnId !== turn.id) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (this.lastCompletedTurnId === turn.id) {
        // A very fast turn may complete before its start response is handled.
        // Never resurrect it or retry; the completion notification is final.
        return "started";
      }
      this.activeTurnId = turn.id;
      this.ownsActiveTurn = true;
      if (this.statusEpoch === statusEpoch || this.routeStatus === "starting") {
        this.setRouteStatus("active");
      }
      this.emit("turn_started", { messageBytes: message.byteLength });
      this.armTurnWatchdog();
      return "started";
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      const noObservedTurn = this.activeTurnId === null;
      if (this.connection !== "ready") {
        // The transport close/fault already settled the reserved delivery.
      } else if (!normalized.ambiguous && noObservedTurn) {
        this.settleDelivery(
          message.messageId,
          "failed",
          null,
          "REPLY_UNAVAILABLE",
        );
        this.activeMessageId = null;
        this.ownsActiveTurn = false;
        this.acceptedMessageIds.delete(message.messageId);
        if (
          normalized.code !== "ROUTE_NOT_READY" ||
          this.routeStatus === "starting"
        ) {
          // A clean JSON-RPC rejection may represent a concurrent Desktop
          // state change. Stop the queue until authoritative state is observed.
          this.setRouteStatus("system_error");
        }
      } else {
        this.settleActiveDelivery("ambiguous");
        this.activeTurnId = null;
        this.setRouteStatus("uncertain");
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      if (requestBegan) this.finishRequest("turn/start");
    }
  }

  /**
   * Add one exact input to the currently observed active turn. App Server owns
   * the temporal boundary: the attested method applies it at the next tool-call
   * boundary, never by interrupting an in-progress generation.
   */
  private async steerMessage(
    message: QueuedMessage,
  ): Promise<"deferred" | "expired" | "steered"> {
    this.assertNoRequest();
    this.assertWritableReady();
    if (this.messageExpired(message)) {
      this.expireMessage(message);
      return "expired";
    }
    if (this.routeStatus !== "active" || this.activeTurnId === null) {
      this.acceptedMessageIds.delete(message.messageId);
      return "deferred";
    }
    const expectedTurnId = this.activeTurnId;
    this.beginRequest("turn/steer");
    try {
      const result = await this.request("turn/steer", {
        expectedTurnId,
        input: [{ text: message.text, type: "text" }],
        threadId: this.route.threadId,
      });
      if (
        !isRecord(result) ||
        Object.keys(result).length !== 1 ||
        typeof result.turnId !== "string" ||
        result.turnId !== expectedTurnId
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (
        this.activeTurnId !== null &&
        this.activeTurnId !== expectedTurnId
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      this.acceptedMessageIds.delete(message.messageId);
      this.emit("turn_steered", { messageBytes: message.byteLength });
      return "steered";
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      this.acceptedMessageIds.delete(message.messageId);
      if (!normalized.ambiguous && normalized.code === "RPC_REJECTED") {
        return "deferred";
      }
      this.handleActionError(normalized);
      throw normalized;
    } finally {
      this.finishRequest("turn/steer");
    }
  }

  private scheduleDrain(): void {
    this.dropExpiredQueuedMessages();
    if (
      this.drainScheduled ||
      this.connection !== "ready" ||
      this.routeStatus !== "idle" ||
      this.currentWriteBlockCode() !== null ||
      this.inFlightMethod !== null ||
      this.queue.length === 0
    ) {
      return;
    }
    // Leave the body in the queue until the microtask commits the start. This
    // keeps it visible to exact-route cancellation/close in the completion ->
    // drain scheduling window.
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.dropExpiredQueuedMessages();
      if (
        this.connection !== "ready" ||
        this.routeStatus !== "idle" ||
        this.currentWriteBlockCode() !== null ||
        this.inFlightMethod !== null ||
        this.queue.length === 0
      ) {
        return;
      }
      const message = this.queue.shift();
      if (message === undefined) return;
      this.bumpRevision();
      void this.startMessage(message).then(
        (disposition) => {
          if (disposition === "expired") this.scheduleDrain();
        },
        () => undefined,
      );
    });
  }

  private assertGuard(guard: CodexRouteGuard): void {
    if (
      guard.threadId !== this.route.threadId ||
      guard.endpointGeneration !== this.route.endpointGeneration
    ) {
      throw new CodexConnectorError("STALE_ENDPOINT");
    }
    if (
      guard.revision !== this.revision ||
      guard.status !== this.routeStatus ||
      guard.activeTurnId !== this.activeTurnId ||
      guard.writableReady !== this.isWritableReady()
    ) {
      throw new CodexConnectorError("ROUTE_CAS_MISMATCH");
    }
  }

  private assertReady(): void {
    if (
      !this.initialized ||
      this.connection !== "ready" ||
      this.routeStatus === "stale"
    ) {
      throw new CodexConnectorError("CONNECTOR_CLOSED");
    }
  }

  private assertNoRequest(): void {
    if (this.inFlightMethod !== null) {
      throw new CodexConnectorError("ROUTE_BUSY");
    }
  }

  private currentWriteBlockCode(): CodexWriteBlockCode | null {
    return this.writesEnabled ? null : "WRITES_DISABLED";
  }

  private isWritableReady(): boolean {
    return this.connection === "ready" && this.currentWriteBlockCode() === null;
  }

  private assertWritableReady(): void {
    const code = this.currentWriteBlockCode();
    if (code !== null) throw new CodexConnectorError(code);
  }

  /**
   * Refresh the exact thread on this same connection immediately before a
   * `turn/start`. This confirms the registered task is still the observed idle
   * route without reading history or changing its native approval/sandbox
   * policy.
   */
  private async refreshExactRouteBoundary(): Promise<void> {
    this.assertWritableReady();
    if (
      this.routeStatus !== "starting" ||
      this.activeMessageId === null ||
      this.activeTurnId !== null ||
      this.ownsActiveTurn
    ) {
      throw new CodexConnectorError("ROUTE_NOT_READY");
    }

    const statusEpoch = this.statusEpoch;
    this.beginRequest("thread/resume");
    try {
      const result = await this.request("thread/resume", {
        excludeTurns: true,
        threadId: this.route.threadId,
      });
      if (
        !isRecord(result) ||
        !isRecord(result.thread) ||
        result.thread.id !== this.route.threadId ||
        !Array.isArray(result.thread.turns) ||
        result.thread.turns.length !== 0
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      const refreshedStatus = parseRouteStatus(result.thread.status);
      if (refreshedStatus === null) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (refreshedStatus !== "idle") {
        this.setRouteStatus(refreshedStatus);
        throw new CodexConnectorError("ROUTE_NOT_READY");
      }
      this.assertWritableReady();
      if (
        this.statusEpoch !== statusEpoch ||
        this.routeStatus !== "starting" ||
        this.activeMessageId === null ||
        this.activeTurnId !== null ||
        this.ownsActiveTurn
      ) {
        throw new CodexConnectorError("ROUTE_NOT_READY");
      }
    } finally {
      this.finishRequest("thread/resume");
    }
  }

  private messageExpired(message: QueuedMessage): boolean {
    const nowMs = this.now().getTime();
    return !Number.isFinite(nowMs) || nowMs >= message.deadlineAtMs;
  }

  private expireMessage(message: QueuedMessage): void {
    this.acceptedMessageIds.delete(message.messageId);
    this.settleDelivery(message.messageId, "expired");
  }

  private dropExpiredQueuedMessages(): void {
    let dropped = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const message = this.queue[index];
      if (message === undefined || !this.messageExpired(message)) continue;
      this.queue.splice(index, 1);
      this.expireMessage(message);
      dropped += 1;
    }
    if (dropped > 0) this.bumpRevision();
  }

  private beginRequest(method: CodexAppServerV1Method): void {
    if (!V1_METHOD_SET.has(method) || this.inFlightMethod !== null) {
      throw new CodexConnectorError("ROUTE_BUSY");
    }
    this.inFlightMethod = method;
    this.bumpRevision();
    this.emit("request_started", { operation: method });
  }

  private finishRequest(method: CodexAppServerV1Method): void {
    if (this.inFlightMethod !== method) return;
    this.inFlightMethod = null;
    this.bumpRevision();
    if (this.routeStatus === "idle") this.scheduleDrain();
  }

  private request(
    method: CodexAppServerV1Method | "initialize",
    params: Record<string, unknown> | null,
  ): Promise<unknown> {
    if (method !== "initialize" && !V1_METHOD_SET.has(method)) {
      return Promise.reject(new CodexConnectorError("METHOD_NOT_ALLOWED"));
    }
    if (
      method !== "initialize" &&
      PROBE_ONLY_METHODS.has(method) &&
      !this.writeCompatibilityProbe
    ) {
      return Promise.reject(new CodexConnectorError("METHOD_NOT_ALLOWED"));
    }
    if (method === "initialize") {
      if (this.initializeRequested || this.connection !== "connecting") {
        return Promise.reject(new CodexConnectorError("METHOD_NOT_ALLOWED"));
      }
      this.initializeRequested = true;
    } else if (!this.initialized) {
      return Promise.reject(new CodexConnectorError("CONNECTOR_CLOSED"));
    }
    if (this.connection === "closed" || this.connection === "faulted") {
      return Promise.reject(new CodexConnectorError("CONNECTOR_CLOSED"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) {
      return Promise.reject(new CodexConnectorError("PROTOCOL_ERROR"));
    }
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) {
      return Promise.reject(new CodexConnectorError("INPUT_INVALID"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        this.consecutiveRequestTimeouts += 1;
        pending.reject(new CodexConnectorError("REQUEST_TIMEOUT", true));
        if (this.consecutiveRequestTimeouts >= 2) {
          queueMicrotask(() => {
            if (this.connection === "ready") {
              this.protocolFault("REQUEST_TIMEOUT");
            }
          });
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, reject, resolve, timer });
      let write: Promise<void>;
      try {
        write = this.transport.send(payload);
      } catch {
        write = Promise.reject(
          new CodexConnectorError("TRANSPORT_WRITE_FAILED", true),
        );
      }
      void write.catch(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new CodexConnectorError("TRANSPORT_WRITE_FAILED", true),
        );
      });
    });
  }

  private handlePayload(payload: string): void {
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    if (!isRecord(parsed)) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }

    if (typeof parsed.method === "string") {
      if (parsed.id === undefined) this.handleNotification(parsed.method, parsed.params);
      else this.handleServerRequest(parsed.method, parsed.params);
      return;
    }
    if (parsed.id === undefined) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    if (!Number.isSafeInteger(parsed.id) || typeof parsed.id !== "number") {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");
    if (hasResult === hasError) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    this.consecutiveRequestTimeouts = 0;
    if (hasError) {
      if (
        !isRecord(parsed.error) ||
        typeof parsed.error.code !== "number" ||
        !Number.isSafeInteger(parsed.error.code)
      ) {
        pending.reject(new CodexConnectorError("PROTOCOL_ERROR", true));
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      // Deliberately discard the server's free-form error message/data.
      pending.reject(new CodexConnectorError("RPC_REJECTED"));
      return;
    }
    pending.resolve(parsed.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.handleProbeNotification(method, params)) return;
    if (method === "item/completed") {
      this.handleCompletedItem(params);
      return;
    }

    if (method === "thread/settings/updated") {
      if (!isRecord(params) || typeof params.threadId !== "string") {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (params.threadId !== this.route.threadId) return;
      // Native settings remain owned by Codex. Registration is the Embassy
      // reachability boundary, so a settings update neither blocks the route
      // nor drops already accepted messages.
      return;
    }

    if (method === "thread/status/changed") {
      if (!isRecord(params) || typeof params.threadId !== "string") {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (params.threadId !== this.route.threadId) return;
      const status = parseRouteStatus(params.status);
      if (status === null) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      const reservedRefreshInFlight =
        this.routeStatus === "starting" &&
        this.activeMessageId !== null &&
        this.activeTurnId === null &&
        !this.ownsActiveTurn &&
        this.inFlightMethod === "thread/resume";
      const ownedStartInFlight =
        this.activeMessageId !== null &&
        this.activeTurnId === null &&
        this.ownsActiveTurn &&
        this.inFlightMethod === "turn/start";
      if (
        status === "idle" &&
        (reservedRefreshInFlight || ownedStartInFlight)
      ) {
        // This idle belongs to the external turn whose completion released the
        // queue. Do not let it invalidate the exact refresh epoch or reopen the
        // drain while the reserved message crosses the refresh/start boundary.
        return;
      }
      this.statusEpoch += 1;
      if (status === "idle" && this.activeTurnId !== null) {
        // Wait for the correlated turn/completed notification before draining.
        return;
      }
      if (status === "not_loaded") {
        this.clearTurnWatchdog();
        this.selectedThreadObserved = false;
        this.settleActiveDelivery("ambiguous");
        this.activeTurnId = null;
        this.activeMessageId = null;
        this.ownsActiveTurn = false;
        this.clearTransientReply();
        this.dropQueuedMessages();
      }
      if (
        status === "active" &&
        this.routeStatus === "interrupting" &&
        this.activeTurnId !== null
      ) {
        return;
      }
      this.setRouteStatus(status);
      if (
        (status === "active" || status === "waiting_approval") &&
        this.ownsActiveTurn &&
        this.activeTurnId !== null
      ) {
        this.armTurnWatchdog();
      }
      this.emit(
        status === "waiting_approval"
          ? "approval_waiting"
          : "route_status_changed",
      );
      if (status === "idle") this.scheduleDrain();
      return;
    }

    if (method === "thread/closed") {
      if (!isRecord(params) || typeof params.threadId !== "string") {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (params.threadId !== this.route.threadId) return;
      this.settleActiveDelivery("ambiguous");
      this.clearTurnWatchdog();
      this.activeTurnId = null;
      this.selectedThreadObserved = false;
      this.activeMessageId = null;
      this.ownsActiveTurn = false;
      this.clearTransientReply();
      this.dropQueuedMessages();
      this.setRouteStatus("not_loaded");
      this.emit("route_status_changed");
      return;
    }

    if (method === "turn/started") {
      if (
        !isRecord(params) ||
        typeof params.threadId !== "string"
      ) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (params.threadId !== this.route.threadId) return;
      const turn = parseTurn(params.turn);
      if (
        turn === null ||
        turn.status !== "inProgress"
      ) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (!this.ownsActiveTurn && this.activeMessageId === null) {
        if (this.lastCompletedTurnId === turn.id) return;
        if (this.activeTurnId !== null && this.activeTurnId !== turn.id) {
          this.protocolFault("PROTOCOL_ERROR");
          return;
        }
        this.activeTurnId = turn.id;
        this.setRouteStatus("active");
        this.emit("turn_started");
        return;
      }
      if (!this.ownsActiveTurn || this.activeMessageId === null) {
        return;
      }
      if (this.lastCompletedTurnId === turn.id) return;
      if (this.activeTurnId !== null && this.activeTurnId !== turn.id) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      this.activeTurnId = turn.id;
      this.ownsActiveTurn =
        this.ownsActiveTurn && this.activeMessageId !== null;
      this.setRouteStatus("active");
      this.emit("turn_started");
      this.armTurnWatchdog();
      return;
    }

    if (method === "turn/completed") {
      if (
        !isRecord(params) ||
        typeof params.threadId !== "string"
      ) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (params.threadId !== this.route.threadId) return;
      const turn = parseTurn(params.turn);
      if (
        turn === null ||
        (turn.status !== "completed" &&
          turn.status !== "failed" &&
          turn.status !== "interrupted")
      ) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      const outcome = turn.status as CodexTurnOutcome;
      this.clearTurnWatchdog();
      if (!this.ownsActiveTurn || this.activeMessageId === null) {
        // An approval request from another client records the external turn ID
        // so Embassy can wait without answering it. Its terminal notification
        // must release that observation and any queued Embassy work, while
        // never claiming or settling the external turn as gateway-owned.
        if (this.ownsActiveTurn || this.activeMessageId !== null) {
          this.protocolFault("PROTOCOL_ERROR");
          return;
        }
        if (this.activeTurnId === null) return;
        if (this.activeTurnId !== turn.id) {
          this.protocolFault("PROTOCOL_ERROR");
          return;
        }
        this.activeTurnId = null;
        this.lastCompletedTurnId = turn.id;
        this.clearTransientReply();
        this.setRouteStatus(outcome === "failed" ? "system_error" : "idle");
        this.emit("turn_completed", { turnOutcome: outcome });
        if (outcome !== "failed") this.scheduleDrain();
        return;
      }
      if (this.activeTurnId === null) return;
      if (this.activeTurnId !== turn.id) {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      const messageId = this.activeMessageId;
      const reply = this.transientReply;
      const replyTooLarge = this.transientReplyTooLarge;
      this.activeTurnId = null;
      this.lastCompletedTurnId = turn.id;
      this.activeMessageId = null;
      this.ownsActiveTurn = false;
      this.clearTransientReply();
      this.setRouteStatus(outcome === "failed" ? "system_error" : "idle");
      this.emit("turn_completed", { turnOutcome: outcome });
      if (messageId !== null) {
        const text = outcome === "completed" && !replyTooLarge ? reply : null;
        const replyCode = replyTooLarge
          ? "REPLY_TOO_LARGE"
          : text === null
            ? "REPLY_UNAVAILABLE"
            : null;
        this.settleDelivery(messageId, outcome, text, replyCode);
      }
      if (outcome !== "failed") this.scheduleDrain();
      return;
    }

    if (method === "serverRequest/resolved") {
      if (!isRecord(params) || typeof params.threadId !== "string") {
        this.protocolFault("PROTOCOL_ERROR");
        return;
      }
      if (
        params.threadId === this.route.threadId &&
        this.routeStatus === "waiting_approval"
      ) {
        this.setRouteStatus("active");
        this.emit("route_status_changed");
      }
      return;
    }

    if (method === "warning" || method === "configWarning") {
      this.emit("server_warning");
    }
    // Every other notification is ignored after the global frame bound. Raw
    // item/model/tool payloads are neither normalized nor retained.
  }

  private handleServerRequest(method: string, params: unknown): void {
    if (
      this.probeRuntime !== null &&
      isRecord(params) &&
      params.threadId === this.probeRuntime.threadId
    ) {
      this.probeRuntime.failCode ??=
        "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED";
      this.settleProbeRuntime();
      return;
    }
    if (!APPROVAL_REQUEST_METHODS.has(method)) {
      this.emit("server_request_ignored");
      return;
    }
    if (
      !isRecord(params) ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      !validOpaqueId(params.turnId)
    ) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    if (params.threadId !== this.route.threadId) return;
    if (this.activeTurnId !== null && this.activeTurnId !== params.turnId) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    this.activeTurnId = params.turnId;
    // Do not acquire ownership merely by observing another client's approval.
    this.setRouteStatus("waiting_approval");
    this.emit("approval_waiting");
    // Intentionally no JSON-RPC response: the gateway is not an approval UI or
    // authority. The owning Desktop client must resolve the request.
  }

  private handleProbeNotification(method: string, params: unknown): boolean {
    const runtime = this.probeRuntime;
    if (runtime === null) return false;
    const fail = (code: CodexWriteCompatibilityProbeErrorCode): void => {
      runtime.failCode ??= code;
      this.settleProbeRuntime();
    };
    if (method === "model/rerouted") {
      fail("CODEX_WRITE_PROBE_MODEL_REROUTED");
      return true;
    }
    if (!isRecord(params)) return false;
    const observeTurnId = (value: unknown): boolean => {
      if (typeof value !== "string" || !validOpaqueId(value)) return false;
      if (runtime.turnId !== null && runtime.turnId !== value) return false;
      runtime.turnId = value;
      return true;
    };
    if (method === "thread/settings/updated") {
      runtime.settingsEchoObserved = true;
      const settingsThreadId = params.threadId;
      const settings = params.threadSettings;
      const sandbox = isRecord(settings) ? settings.sandboxPolicy : null;
      if (
        typeof settingsThreadId !== "string" ||
        !validUuidV7(settingsThreadId) ||
        (runtime.threadId !== null && runtime.threadId !== settingsThreadId) ||
        (runtime.settingsThreadId !== null &&
          runtime.settingsThreadId !== settingsThreadId) ||
        !isRecord(settings) ||
        settings.cwd !== runtime.expectedCwd ||
        settings.model !== runtime.expectedModel ||
        settings.approvalPolicy !== "never" ||
        (settings.effort !== undefined &&
          settings.effort !== runtime.expectedEffort) ||
        !isRecord(sandbox) ||
        sandbox.type !== "readOnly" ||
        (sandbox.networkAccess !== undefined &&
          sandbox.networkAccess !== false)
      ) {
        fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
      } else {
        runtime.settingsThreadId = settingsThreadId;
      }
      return true;
    }
    if (runtime.threadId === null || params.threadId !== runtime.threadId) {
      return false;
    }
    if (PROBE_TOOL_NOTIFICATION_METHODS.has(method)) {
      fail("CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED");
      return true;
    }
    if (method === "thread/tokenUsage/updated") {
      const totalTokens =
        observeTurnId(params.turnId) &&
        isRecord(params.tokenUsage) &&
        isRecord(params.tokenUsage.last)
          ? params.tokenUsage.last.totalTokens
          : null;
      if (
        !Number.isSafeInteger(totalTokens) ||
        (totalTokens as number) < 0 ||
        (totalTokens as number) > MAX_PROBE_TOKEN_COUNT
      ) {
        fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
      } else {
        runtime.tokenCount = totalTokens as number;
        this.settleProbeRuntime();
      }
      return true;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = parseTurn(params.turn);
      if (
        turn === null ||
        !isRecord(params.turn) ||
        !Array.isArray(params.turn.items) ||
        !observeTurnId(turn.id)
      ) {
        fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
      } else if (method === "turn/started") {
        if (
          turn.status !== "inProgress" ||
          runtime.phase !== "awaiting_start"
        ) {
          fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
        } else {
          runtime.phase = "started";
        }
      } else if (
        turn.status === "completed" &&
        runtime.phase === "item_completed"
      ) {
        runtime.phase = "terminal";
        this.settleProbeRuntime();
      } else {
        fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
      }
      return true;
    }
    if (method === "item/started" || method === "item/completed") {
      const observedAt =
        method === "item/started" ? params.startedAtMs : params.completedAtMs;
      const itemType = isRecord(params.item) ? params.item.type : null;
      if (
        typeof itemType === "string" &&
        !PROBE_PASSIVE_ITEM_TYPES.has(itemType)
      ) {
        fail("CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED");
        return true;
      }
      if (
        !observeTurnId(params.turnId) ||
        !isRecord(params.item) ||
        typeof itemType !== "string" ||
        !Number.isSafeInteger(observedAt) ||
        (observedAt as number) < 0 ||
        (runtime.phase !== "started" && runtime.phase !== "item_completed")
      ) {
        fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
      } else if (
        method === "item/completed" &&
        itemType === "agentMessage"
      ) {
        if (runtime.phase !== "started") {
          fail("CODEX_WRITE_PROBE_THREAD_SETUP_FAILED");
        } else {
          runtime.phase = "item_completed";
        }
      }
      return true;
    }
    return false;
  }

  private handleCompletedItem(params: unknown): void {
    if (
      !isRecord(params) ||
      typeof params.threadId !== "string"
    ) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }
    if (params.threadId !== this.route.threadId) return;
    if (
      typeof params.turnId !== "string" ||
      !validOpaqueId(params.turnId) ||
      !isRecord(params.item) ||
      typeof params.item.type !== "string" ||
      !validOpaqueId(params.item.type, 128)
    ) {
      this.protocolFault("PROTOCOL_ERROR");
      return;
    }

    if (
      !this.ownsActiveTurn &&
      this.activeMessageId === null &&
      this.activeTurnId === null &&
      this.routeStatus === "active" &&
      this.lastCompletedTurnId !== params.turnId
    ) {
      // `thread/resume` deliberately excludes turn history, so attaching to a
      // turn that another client already started proves only `active` status.
      // A subsequent item/completed notification is a bounded protocol frame
      // that carries the exact current turn ID. Adopt only that ID so a
      // queued STEER can target the next tool-call boundary; retain no item.
      this.activeTurnId = params.turnId;
      this.bumpRevision();
      this.emit("turn_started");
      return;
    }

    if (
      !this.ownsActiveTurn ||
      this.activeMessageId === null ||
      this.activeTurnId === null
    ) {
      return;
    }
    if (params.turnId !== this.activeTurnId) {
      return;
    }
    const item = params.item;
    if (item.type !== "agentMessage") return;
    if (item.phase !== undefined && item.phase !== "final_answer") return;
    if (typeof item.text !== "string" || item.text.includes("\0")) return;
    const replyBytes = Buffer.byteLength(item.text, "utf8");
    if (replyBytes === 0) return;
    if (replyBytes > this.maxReplyBytes) {
      this.transientReply = null;
      this.transientReplyTooLarge = true;
      return;
    }
    this.transientReply = item.text;
    this.transientReplyTooLarge = false;
    this.armTurnWatchdog();
  }

  private clearTransientReply(): void {
    this.transientReply = null;
    this.transientReplyTooLarge = false;
  }

  private settleDelivery(
    messageId: string,
    outcome: CodexDeliveryOutcome,
    text: string | null = null,
    replyCode: CodexTransientTurnResult["replyCode"] = "REPLY_UNAVAILABLE",
  ): void {
    try {
      this.onTurnResult?.({ messageId, outcome, replyCode, text });
    } catch {
      // Delivery consumers cannot alter transport or route state. Any reply
      // text is dropped immediately after this synchronous handoff.
    }
  }

  private settleActiveDelivery(outcome: "abandoned" | "ambiguous"): void {
    this.clearTurnWatchdog();
    if (this.activeMessageId !== null) {
      this.settleDelivery(this.activeMessageId, outcome);
    }
    this.activeMessageId = null;
    this.ownsActiveTurn = false;
    this.clearTransientReply();
  }

  private setRouteStatus(status: CodexRouteStatus): void {
    if (this.routeStatus === status) return;
    this.routeStatus = status;
    this.bumpRevision();
  }

  private bumpRevision(): void {
    this.revision += 1;
    if (!Number.isSafeInteger(this.revision)) {
      this.protocolFault("PROTOCOL_ERROR");
    }
  }

  private emit(
    kind: CodexConnectorEventKind,
    details?: CodexConnectorEventDetails,
  ): void {
    this.eventSequence += 1;
    const event: CodexConnectorEvent = {
      ...this.observation(),
      kind,
      timestamp: this.now().toISOString(),
      ...(details === undefined ? {} : { details }),
    };
    try {
      this.onEvent?.(event);
    } catch {
      // Monitoring consumers cannot affect routing or protocol state.
    }
  }

  private dropQueuedMessages(): number {
    const dropped = this.queue.length;
    for (const message of this.queue) {
      this.settleDelivery(message.messageId, "abandoned");
    }
    this.queue.length = 0;
    if (dropped > 0) this.bumpRevision();
    return dropped;
  }

  private normalizeError(
    error: unknown,
    ambiguousFallback: boolean,
  ): CodexConnectorError {
    return error instanceof CodexConnectorError
      ? error
      : new CodexConnectorError("PROTOCOL_ERROR", ambiguousFallback);
  }

  private handleActionError(error: unknown): void {
    const normalized = this.normalizeError(error, true);
    if (
      normalized.code === "PROTOCOL_ERROR" ||
      normalized.code === "RESULT_SCHEMA_MISMATCH" ||
      normalized.code === "TRANSPORT_WRITE_FAILED" ||
      normalized.code === "TRANSPORT_CLOSED"
    ) {
      this.protocolFault(normalized.code);
    }
  }

  private rejectPending(code: CodexConnectorErrorCode): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new CodexConnectorError(code, true));
    }
  }

  private protocolFault(code: CodexConnectorErrorCode): void {
    if (this.faulting || this.connection === "faulted") return;
    this.faulting = true;
    this.connection = "faulted";
    this.settleProbeConnectionLoss();
    this.initialized = false;
    this.routeStatus = "stale";
    this.selectedThreadObserved = false;
    this.clearTurnWatchdog();
    this.settleActiveDelivery("ambiguous");
    this.activeTurnId = null;
    const droppedMessages = this.dropQueuedMessages();
    this.inFlightMethod = null;
    this.bumpRevision();
    this.rejectPending(code);
    this.emit("protocol_fault", { droppedMessages, errorCode: code });
    void this.transport.close().catch(() => undefined);
    for (const remove of this.unlisten.splice(0)) remove();
    this.faulting = false;
  }

  private handleDisconnect(): void {
    if (this.connection === "closed" || this.connection === "faulted") return;
    this.connection = "closed";
    this.settleProbeConnectionLoss();
    this.initialized = false;
    this.routeStatus = "stale";
    this.selectedThreadObserved = false;
    this.clearTurnWatchdog();
    this.settleActiveDelivery("ambiguous");
    this.activeTurnId = null;
    const droppedMessages = this.dropQueuedMessages();
    this.inFlightMethod = null;
    this.bumpRevision();
    this.rejectPending("TRANSPORT_CLOSED");
    this.emit("connection_closed", {
      droppedMessages,
      ...(!this.expectedClose ? { errorCode: "TRANSPORT_CLOSED" as const } : {}),
    });
    for (const remove of this.unlisten.splice(0)) remove();
  }

  private armTurnWatchdog(delayMs = this.turnWatchdogMs): void {
    this.clearTurnWatchdog();
    if (
      this.connection !== "ready" ||
      !this.ownsActiveTurn ||
      this.activeMessageId === null ||
      this.activeTurnId === null
    ) {
      return;
    }
    this.turnWatchdogTimer = setTimeout(() => {
      this.turnWatchdogTimer = undefined;
      void this.probeOwnedTurnStatus();
    }, delayMs);
    this.turnWatchdogTimer.unref();
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdogTimer === undefined) return;
    clearTimeout(this.turnWatchdogTimer);
    this.turnWatchdogTimer = undefined;
  }

  private async probeOwnedTurnStatus(): Promise<void> {
    if (
      this.connection !== "ready" ||
      !this.ownsActiveTurn ||
      this.activeMessageId === null ||
      this.activeTurnId === null
    ) {
      return;
    }
    if (this.inFlightMethod !== null) {
      this.armTurnWatchdog(
        Math.min(this.turnWatchdogMs, this.requestTimeoutMs),
      );
      return;
    }

    const watchedMessageId = this.activeMessageId;
    const watchedTurnId = this.activeTurnId;
    this.beginRequest("thread/resume");
    try {
      const result = await this.request("thread/resume", {
        excludeTurns: true,
        threadId: this.route.threadId,
      });
      if (
        !isRecord(result) ||
        !isRecord(result.thread) ||
        result.thread.id !== this.route.threadId ||
        !Array.isArray(result.thread.turns) ||
        result.thread.turns.length !== 0
      ) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      const status = parseRouteStatus(result.thread.status);
      if (status === null) {
        throw new CodexConnectorError("RESULT_SCHEMA_MISMATCH", true);
      }
      if (
        !this.ownsActiveTurn ||
        this.activeMessageId !== watchedMessageId ||
        this.activeTurnId !== watchedTurnId
      ) {
        return;
      }
      if (status === "active" || status === "waiting_approval") {
        this.setRouteStatus(status);
        this.emit(
          status === "waiting_approval"
            ? "approval_waiting"
            : "route_status_changed",
        );
        this.armTurnWatchdog();
        return;
      }

      this.settleActiveDelivery("ambiguous");
      this.activeTurnId = null;
      if (status === "not_loaded") this.selectedThreadObserved = false;
      this.setRouteStatus(status);
      this.emit("route_status_changed");
      if (status === "idle") this.scheduleDrain();
    } catch (error) {
      const normalized = this.normalizeError(error, true);
      this.handleActionError(normalized);
      if (
        this.connection === "ready" &&
        this.ownsActiveTurn &&
        this.activeMessageId === watchedMessageId &&
        this.activeTurnId === watchedTurnId
      ) {
        this.armTurnWatchdog();
      }
    } finally {
      this.finishRequest("thread/resume");
    }
  }
}
