/**
 * Private, local gateway control transport.
 *
 * Every byte received here is untrusted even though the socket lives inside a
 * same-UID state directory. The directory permissions are the authentication
 * boundary; this module still validates every frame and field before calling a
 * handler. It deliberately never logs, stores, or reflects task IDs or message
 * text.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  gatewayPublicSnapshotLimits,
} from "./types.js";
import type {
  GatewayAccounting,
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicAvailablePeerSnapshot,
  PublicConnectorSnapshot,
  PublicRouteSnapshot,
  RouteCounters,
  SafeGatewayAlert,
} from "./types.js";

export const GATEWAY_CONTROL_PROTOCOL_VERSION = 1 as const;
export const GATEWAY_CONTROL_MAX_FRAME_BYTES = 32 * 1024;
export const GATEWAY_CONTROL_MAX_RESPONSE_BYTES = 256 * 1024;
export const GATEWAY_CONTROL_MAX_MESSAGE_BYTES = 16 * 1024;
export const GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS = 3_000;
export const GATEWAY_CONTROL_MAX_CONNECTIONS = 32;

const MAX_SOCKET_PATH_BYTES = 100;
const MAX_REPLY_ADDRESS_BYTES = 256;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const DEFAULT_HOST_ID = "this-mac";
const DEFAULT_BUSY_POLICY = "queue";

const ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{16,64}$/;
const DELIVERY_TOKEN_PATTERN = /^dlv_[A-Za-z0-9_-]{24}$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTOCOL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const MESSAGE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const gatewayControlMethods = [
  "health",
  "register_codex",
  "unregister_codex",
  "select_claude",
  "unselect_claude",
  "list_snapshot",
  "observe_snapshot",
  "delivery_status",
  "send_to_claude",
  "send_to_codex",
  "reply",
  "refresh_dashboard",
] as const;

export type GatewayControlMethod = (typeof gatewayControlMethods)[number];
export type GatewayBusyPolicy = "queue";

export type RegisterCodexParams = {
  alias: string;
  threadId: string;
  hostId?: string;
  busyPolicy?: GatewayBusyPolicy;
  succeedsAlias?: string;
};

export type ValidatedRegisterCodexParams = {
  alias: string;
  threadId: string;
  hostId: string;
  busyPolicy: GatewayBusyPolicy;
  succeedsAlias?: string;
};

export type UnregisterCodexParams = {
  alias: string;
  threadId: string;
};

export type SelectClaudeParams = {
  /** Latest name@host or native Claude session UUID. */
  alias: string;
};

export type SendToClaudeParams = {
  fromAlias: string;
  threadId: string;
  /** Latest name@host or native Claude session UUID. */
  toAlias: string;
  text: string;
  expectsReply?: boolean;
};

export type ValidatedSendToClaudeParams = {
  fromAlias: string;
  threadId: string;
  toAlias: string;
  text: string;
  expectsReply: boolean;
};

export type SendToCodexParams = {
  fromAlias: string;
  toAlias: string;
  text: string;
  replyAddress?: string;
  expectsReply?: boolean;
};

export type ValidatedSendToCodexParams = {
  fromAlias: string;
  toAlias: string;
  text: string;
  replyAddress?: string;
  expectsReply: boolean;
};

export type GatewayReplyCaller =
  | {
      kind: "codex";
      alias: string;
      threadId: string;
    }
  | {
      kind: "claude";
      alias: string;
      replyAddress?: string;
    };

export type ValidatedGatewayReplyCaller = GatewayReplyCaller;

export type ReplyParams = {
  conversationId: string;
  text: string;
  caller: GatewayReplyCaller;
};

export type DeliveryStatusParams = {
  token: string;
};

export type GatewayControlRequest =
  | {
      protocolVersion: 1;
      method: "health";
      params: Record<string, never>;
    }
  | {
      protocolVersion: 1;
      method: "register_codex";
      params: RegisterCodexParams;
    }
  | {
      protocolVersion: 1;
      method: "unregister_codex";
      params: UnregisterCodexParams;
    }
  | {
      protocolVersion: 1;
      method: "select_claude";
      params: SelectClaudeParams;
    }
  | {
      protocolVersion: 1;
      method: "unselect_claude";
      params: SelectClaudeParams;
    }
  | {
      protocolVersion: 1;
      method: "list_snapshot";
      params: Record<string, never>;
    }
  | {
      protocolVersion: 1;
      method: "observe_snapshot";
      params: Record<string, never>;
    }
  | {
      protocolVersion: 1;
      method: "delivery_status";
      params: DeliveryStatusParams;
    }
  | {
      protocolVersion: 1;
      method: "send_to_claude";
      params: SendToClaudeParams;
    }
  | {
      protocolVersion: 1;
      method: "send_to_codex";
      params: SendToCodexParams;
    }
  | {
      protocolVersion: 1;
      method: "reply";
      params: ReplyParams;
    }
  | {
      protocolVersion: 1;
      method: "refresh_dashboard";
      params: Record<string, never>;
    };

type ValidatedGatewayControlRequest =
  | Extract<GatewayControlRequest, { method: "health" }>
  | {
      protocolVersion: 1;
      method: "register_codex";
      params: ValidatedRegisterCodexParams;
    }
  | Extract<GatewayControlRequest, { method: "unregister_codex" }>
  | Extract<GatewayControlRequest, { method: "select_claude" }>
  | Extract<GatewayControlRequest, { method: "unselect_claude" }>
  | Extract<GatewayControlRequest, { method: "list_snapshot" }>
  | Extract<GatewayControlRequest, { method: "observe_snapshot" }>
  | Extract<GatewayControlRequest, { method: "delivery_status" }>
  | {
      protocolVersion: 1;
      method: "send_to_claude";
      params: ValidatedSendToClaudeParams;
    }
  | {
      protocolVersion: 1;
      method: "send_to_codex";
      params: ValidatedSendToCodexParams;
    }
  | {
      protocolVersion: 1;
      method: "reply";
      params: ReplyParams;
    }
  | Extract<GatewayControlRequest, { method: "refresh_dashboard" }>;

export type GatewayDecisionCode =
  | "ok"
  | "not_found"
  | "conflict"
  | "route_mismatch"
  | "busy"
  | "unavailable"
  | "rejected";

export type GatewayDecision =
  | { accepted: true; code: "ok" }
  | {
      accepted: false;
      code: Exclude<GatewayDecisionCode, "ok">;
    };

export type GatewaySendResult =
  | {
      accepted: true;
      code: "ok";
      conversationId: string;
      deliveryToken: string;
    }
  | {
      accepted: false;
      code: Exclude<GatewayDecisionCode, "ok">;
    };

export type GatewayHealthResult = {
  status: "ok" | "degraded";
  /** Coarse controller activity clock; not a semantic snapshot revision. */
  revision: number;
};

export type GatewayRefreshResult = GatewayDecision & {
  revision: number;
};

export type GatewayDeliveryStatusState =
  | "queued"
  | "stalled"
  | "delivered"
  | "unconfirmed"
  | "expired"
  | "failed"
  | "ambiguous"
  | "cancelled";

export type GatewayDeliveryStatusResult =
  | { found: false }
  | {
      found: true;
      state: GatewayDeliveryStatusState;
      terminal: boolean;
      updatedAt: string;
      deadlineAt: string;
      pendingForMs?: number;
      safeErrorCode?: string;
    };

export type GatewaySnapshot = GatewayPublicSnapshot;

/**
 * One atomic, read-only public observation. `snapshotRevision` is distinct
 * from the coarse controller revision returned by `health`: it resets with
 * the gateway process and changes only when public snapshot semantics change.
 */
export type GatewaySnapshotObservation = {
  snapshotRevision: number;
  snapshot: GatewaySnapshot;
};

type ResultByMethod = {
  health: GatewayHealthResult;
  register_codex: GatewayDecision;
  unregister_codex: GatewayDecision;
  select_claude: GatewayDecision;
  unselect_claude: GatewayDecision;
  list_snapshot: GatewaySnapshot;
  observe_snapshot: GatewaySnapshotObservation;
  delivery_status: GatewayDeliveryStatusResult;
  send_to_claude: GatewaySendResult;
  send_to_codex: GatewaySendResult;
  reply: GatewaySendResult;
  refresh_dashboard: GatewayRefreshResult;
};

type MaybePromise<T> = T | Promise<T>;

export type GatewayControlHandlers = {
  health: () => MaybePromise<GatewayHealthResult>;
  registerCodex: (
    params: Readonly<ValidatedRegisterCodexParams>,
  ) => MaybePromise<GatewayDecision>;
  unregisterCodex: (
    params: Readonly<UnregisterCodexParams>,
  ) => MaybePromise<GatewayDecision>;
  selectClaude: (
    params: Readonly<SelectClaudeParams>,
  ) => MaybePromise<GatewayDecision>;
  unselectClaude: (
    params: Readonly<SelectClaudeParams>,
  ) => MaybePromise<GatewayDecision>;
  listSnapshot: () => MaybePromise<GatewaySnapshot>;
  observeSnapshot: () => MaybePromise<GatewaySnapshotObservation>;
  deliveryStatus: (
    params: Readonly<DeliveryStatusParams>,
  ) => MaybePromise<GatewayDeliveryStatusResult>;
  sendToClaude: (
    params: Readonly<ValidatedSendToClaudeParams>,
  ) => MaybePromise<GatewaySendResult>;
  sendToCodex: (
    params: Readonly<ValidatedSendToCodexParams>,
  ) => MaybePromise<GatewaySendResult>;
  reply: (params: Readonly<ReplyParams>) => MaybePromise<GatewaySendResult>;
  refreshDashboard: () => MaybePromise<GatewayRefreshResult>;
};

export type GatewayWireErrorCode =
  | "INVALID_JSON"
  | "FRAME_TOO_LARGE"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_METHOD"
  | "MULTIPLE_FRAMES"
  | "SERVER_BUSY"
  | "REQUEST_TIMEOUT"
  | "HANDLER_FAILURE"
  | "INVALID_HANDLER_RESPONSE"
  | "RESPONSE_TOO_LARGE";

export type GatewayControlErrorResponse = {
  protocolVersion: 1;
  ok: false;
  error: {
    code: GatewayWireErrorCode;
    message: string;
  };
};

export type GatewayControlSuccessResponse<
  M extends GatewayControlMethod = GatewayControlMethod,
> = {
  protocolVersion: 1;
  ok: true;
  result: ResultByMethod[M];
};

export type GatewayControlResponse<
  M extends GatewayControlMethod = GatewayControlMethod,
> = GatewayControlSuccessResponse<M> | GatewayControlErrorResponse;

const WIRE_ERROR_MESSAGES: Record<GatewayWireErrorCode, string> = {
  INVALID_JSON: "The control frame is not valid JSON.",
  FRAME_TOO_LARGE: "The control frame exceeds the size limit.",
  INVALID_REQUEST: "The control request is invalid.",
  UNSUPPORTED_VERSION: "The control protocol version is unsupported.",
  UNKNOWN_METHOD: "The control method is unsupported.",
  MULTIPLE_FRAMES: "Only one control request is allowed per connection.",
  SERVER_BUSY: "The gateway control server is at its connection limit.",
  REQUEST_TIMEOUT: "The control request timed out.",
  HANDLER_FAILURE: "The gateway could not complete the control request.",
  INVALID_HANDLER_RESPONSE: "The gateway produced an invalid control response.",
  RESPONSE_TOO_LARGE: "The control response exceeds the size limit.",
};

export class GatewayControlTransportError extends Error {
  readonly code: string;
  readonly ambiguous: boolean;
  readonly recoverable: boolean;

  constructor(code: string, message: string, ambiguous = false) {
    super(message);
    this.name = "GatewayControlTransportError";
    this.code = code;
    this.ambiguous = ambiguous;
    this.recoverable = !ambiguous;
  }
}

class ProtocolFault extends Error {
  readonly code: GatewayWireErrorCode;

  constructor(code: GatewayWireErrorCode) {
    super(WIRE_ERROR_MESSAGES[code]);
    this.name = "ProtocolFault";
    this.code = code;
  }
}

type SocketIdentity = {
  dev: number;
  ino: number;
};

export type GatewayControlServer = {
  readonly socketPath: string;
  readonly closed: boolean;
  close: () => Promise<void>;
};

export type StartGatewayControlServerOptions = {
  stateDir: string;
  socketPath: string;
  handlers: GatewayControlHandlers;
  requestTimeoutMs?: number;
};

export function createGatewayConversationId(): string {
  return `conv_${randomBytes(18).toString("base64url")}`;
}

export function isGatewayAlias(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

export function isClaudeSessionSelector(value: string): boolean {
  return isGatewayAlias(value) || UUID_PATTERN.test(value);
}

export function isGatewayHostId(value: string): boolean {
  return HOST_PATTERN.test(value);
}

export function isGatewayConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

export function isGatewayDeliveryToken(value: string): boolean {
  return DELIVERY_TOKEN_PATTERN.test(value);
}

export function isGatewayReplyAddress(value: string): boolean {
  if (
    value.includes("\0") ||
    !value.startsWith("uds:") ||
    Buffer.byteLength(value, "utf8") > MAX_REPLY_ADDRESS_BYTES
  ) {
    return false;
  }
  const socketPath = value.slice(4);
  return (
    path.isAbsolute(socketPath) &&
    path.resolve(socketPath) === socketPath &&
    Buffer.byteLength(socketPath, "utf8") <= MAX_SOCKET_PATH_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    ownKeys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_REVISION
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isAlias(value: unknown): value is string {
  return typeof value === "string" && isGatewayAlias(value);
}

function isHostId(value: unknown): value is string {
  return typeof value === "string" && isGatewayHostId(value);
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && isGatewayConversationId(value);
}

function isMessageText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= GATEWAY_CONTROL_MAX_MESSAGE_BYTES
  );
}

function normalizeReplyCaller(value: unknown): GatewayReplyCaller {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ProtocolFault("INVALID_REQUEST");
  }
  if (value.kind === "codex") {
    if (
      !hasExactKeys(value, ["kind", "alias", "threadId"]) ||
      !isAlias(value.alias) ||
      !isUuid(value.threadId)
    ) {
      throw new ProtocolFault("INVALID_REQUEST");
    }
    return {
      kind: "codex",
      alias: value.alias,
      threadId: value.threadId.toLowerCase(),
    };
  }
  if (value.kind === "claude") {
    if (
      !hasExactKeys(value, ["kind", "alias"], ["replyAddress"]) ||
      !isAlias(value.alias) ||
      (value.replyAddress !== undefined &&
        (typeof value.replyAddress !== "string" ||
          !isGatewayReplyAddress(value.replyAddress)))
    ) {
      throw new ProtocolFault("INVALID_REQUEST");
    }
    return {
      kind: "claude",
      alias: value.alias,
      ...(value.replyAddress === undefined
        ? {}
        : { replyAddress: value.replyAddress }),
    };
  }
  throw new ProtocolFault("INVALID_REQUEST");
}

function normalizeParams(
  method: GatewayControlMethod,
  value: unknown,
): ValidatedGatewayControlRequest["params"] {
  if (!isRecord(value)) throw new ProtocolFault("INVALID_REQUEST");

  switch (method) {
    case "health":
    case "list_snapshot":
    case "observe_snapshot":
    case "refresh_dashboard":
      if (!hasExactKeys(value, [])) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {};
    case "delivery_status": {
      if (
        !hasExactKeys(value, ["token"]) ||
        typeof value.token !== "string" ||
        !isGatewayDeliveryToken(value.token)
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return { token: value.token };
    }
    case "register_codex": {
      if (
        !hasExactKeys(
          value,
          ["alias", "threadId"],
          ["hostId", "busyPolicy", "succeedsAlias"],
        ) ||
        !isAlias(value.alias) ||
        !value.alias.startsWith("codex-") ||
        !isUuid(value.threadId) ||
        (value.hostId !== undefined && !isHostId(value.hostId)) ||
        (value.busyPolicy !== undefined &&
          value.busyPolicy !== "queue") ||
        (value.succeedsAlias !== undefined &&
          (!isAlias(value.succeedsAlias) ||
            !value.succeedsAlias.startsWith("codex-")))
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      const hostId = value.hostId ?? DEFAULT_HOST_ID;
      if (
        !value.alias.endsWith(`@${hostId}`) ||
        (value.succeedsAlias !== undefined &&
          (value.succeedsAlias === value.alias ||
            !value.succeedsAlias.endsWith(`@${hostId}`)))
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        alias: value.alias,
        threadId: value.threadId.toLowerCase(),
        hostId,
        busyPolicy: value.busyPolicy ?? DEFAULT_BUSY_POLICY,
        ...(value.succeedsAlias === undefined
          ? {}
          : { succeedsAlias: value.succeedsAlias }),
      };
    }
    case "unregister_codex": {
      if (
        !hasExactKeys(value, ["alias", "threadId"]) ||
        !isAlias(value.alias) ||
        !value.alias.startsWith("codex-") ||
        !isUuid(value.threadId)
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        alias: value.alias,
        threadId: value.threadId.toLowerCase(),
      };
    }
    case "select_claude":
    case "unselect_claude": {
      if (
        !hasExactKeys(value, ["alias"]) ||
        typeof value.alias !== "string" ||
        !isClaudeSessionSelector(value.alias)
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        alias: UUID_PATTERN.test(value.alias)
          ? value.alias.toLowerCase()
          : value.alias,
      };
    }
    case "send_to_claude": {
      if (
        !hasExactKeys(
          value,
          ["fromAlias", "threadId", "toAlias", "text"],
          ["expectsReply"],
        ) ||
        !isAlias(value.fromAlias) ||
        !isUuid(value.threadId) ||
        (typeof value.toAlias !== "string" ||
          !isClaudeSessionSelector(value.toAlias)) ||
        !isMessageText(value.text) ||
        (value.expectsReply !== undefined &&
          typeof value.expectsReply !== "boolean")
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        fromAlias: value.fromAlias,
        threadId: value.threadId.toLowerCase(),
        toAlias: UUID_PATTERN.test(value.toAlias)
          ? value.toAlias.toLowerCase()
          : value.toAlias,
        text: value.text,
        expectsReply: value.expectsReply ?? false,
      };
    }
    case "send_to_codex": {
      if (
        !hasExactKeys(
          value,
          ["fromAlias", "toAlias", "text"],
          ["replyAddress", "expectsReply"],
        ) ||
        !isAlias(value.fromAlias) ||
        !isAlias(value.toAlias) ||
        !isMessageText(value.text) ||
        (value.replyAddress !== undefined &&
          (typeof value.replyAddress !== "string" ||
            !isGatewayReplyAddress(value.replyAddress))) ||
        (value.expectsReply !== undefined &&
          typeof value.expectsReply !== "boolean")
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        fromAlias: value.fromAlias,
        toAlias: value.toAlias,
        text: value.text,
        ...(value.replyAddress === undefined
          ? {}
          : { replyAddress: value.replyAddress }),
        expectsReply: value.expectsReply ?? false,
      };
    }
    case "reply": {
      if (
        !hasExactKeys(value, ["conversationId", "text", "caller"]) ||
        !isConversationId(value.conversationId) ||
        !isMessageText(value.text)
      ) {
        throw new ProtocolFault("INVALID_REQUEST");
      }
      return {
        conversationId: value.conversationId,
        text: value.text,
        caller: normalizeReplyCaller(value.caller),
      };
    }
  }
}

function parseRequestObject(value: unknown): ValidatedGatewayControlRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "method", "params"])
  ) {
    throw new ProtocolFault("INVALID_REQUEST");
  }
  if (value.protocolVersion !== GATEWAY_CONTROL_PROTOCOL_VERSION) {
    throw new ProtocolFault("UNSUPPORTED_VERSION");
  }
  if (
    typeof value.method !== "string" ||
    !(gatewayControlMethods as readonly string[]).includes(value.method)
  ) {
    throw new ProtocolFault("UNKNOWN_METHOD");
  }
  const method = value.method as GatewayControlMethod;
  const params = normalizeParams(method, value.params);
  return {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    method,
    params,
  } as ValidatedGatewayControlRequest;
}

function parseRequestFrame(frame: Buffer): ValidatedGatewayControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw new ProtocolFault("INVALID_JSON");
  }
  return parseRequestObject(parsed);
}

function isDecision(value: unknown): value is GatewayDecision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["accepted", "code"]) ||
    typeof value.accepted !== "boolean" ||
    typeof value.code !== "string"
  ) {
    return false;
  }
  if (value.accepted) return value.code === "ok";
  return (
    value.code === "not_found" ||
    value.code === "conflict" ||
    value.code === "route_mismatch" ||
    value.code === "busy" ||
    value.code === "unavailable" ||
    value.code === "rejected"
  );
}

function isHealthResult(value: unknown): value is GatewayHealthResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["status", "revision"]) &&
    (value.status === "ok" || value.status === "degraded") &&
    isNonNegativeInteger(value.revision)
  );
}

function isSendResult(value: unknown): value is GatewaySendResult {
  if (!isRecord(value)) return false;
  if (value.accepted === true) {
    return (
      hasExactKeys(value, [
        "accepted",
        "code",
        "conversationId",
        "deliveryToken",
      ]) &&
      value.code === "ok" &&
      isConversationId(value.conversationId) &&
      typeof value.deliveryToken === "string" &&
      isGatewayDeliveryToken(value.deliveryToken)
    );
  }
  return isDecision(value);
}

function isRefreshResult(value: unknown): value is GatewayRefreshResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["accepted", "code", "revision"]) ||
    !isNonNegativeInteger(value.revision)
  ) {
    return false;
  }
  const decision = { accepted: value.accepted, code: value.code };
  return isDecision(decision);
}

function isProvider(value: unknown): value is "codex" | "claude" {
  return value === "codex" || value === "claude";
}

function isConnectorHealth(value: unknown): boolean {
  return (
    value === "offline" ||
    value === "connecting" ||
    value === "healthy" ||
    value === "degraded" ||
    value === "incompatible"
  );
}

function isCompatibility(value: unknown): boolean {
  return (
    value === "unknown" ||
    value === "compatible" ||
    value === "incompatible" ||
    value === "expired"
  );
}

function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value);
}

const TERMINAL_DELIVERY_STATUS_STATES = new Set<GatewayDeliveryStatusState>([
  "delivered",
  "unconfirmed",
  "expired",
  "failed",
  "ambiguous",
  "cancelled",
]);

function isDeliveryStatusState(
  value: unknown,
): value is GatewayDeliveryStatusState {
  return (
    value === "queued" ||
    value === "stalled" ||
    value === "delivered" ||
    value === "unconfirmed" ||
    value === "expired" ||
    value === "failed" ||
    value === "ambiguous" ||
    value === "cancelled"
  );
}

function isDeliveryStatusResult(
  value: unknown,
): value is GatewayDeliveryStatusResult {
  if (!isRecord(value) || typeof value.found !== "boolean") return false;
  if (!value.found) return hasExactKeys(value, ["found"]);
  if (
    !hasExactKeys(
      value,
      ["found", "state", "terminal", "updatedAt", "deadlineAt"],
      ["pendingForMs", "safeErrorCode"],
    ) ||
    !isDeliveryStatusState(value.state) ||
    typeof value.terminal !== "boolean" ||
    value.terminal !== TERMINAL_DELIVERY_STATUS_STATES.has(value.state) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isIsoTimestamp(value.deadlineAt) ||
    (value.pendingForMs !== undefined &&
      !isNonNegativeInteger(value.pendingForMs)) ||
    (value.safeErrorCode !== undefined && !isSafeCode(value.safeErrorCode))
  ) {
    return false;
  }
  return true;
}

function isRouteCounters(value: unknown): value is RouteCounters {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "accepted",
      "delivered",
      "unconfirmed",
      "failed",
      "ambiguous",
      "expired",
      "cancelled",
      "abandoned",
      "rejected",
      "bytesAccepted",
    ])
  ) {
    return false;
  }
  return Object.values(value).every(isNonNegativeInteger);
}

function isConnectorSnapshot(
  value: unknown,
): value is PublicConnectorSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "provider",
        "host",
        "health",
        "compatibility",
        "protocol",
        "protocolVersion",
      ],
      ["lastSeenAt", "safeErrorCode"],
    ) &&
    isProvider(value.provider) &&
    isHostId(value.host) &&
    isConnectorHealth(value.health) &&
    isCompatibility(value.compatibility) &&
    typeof value.protocol === "string" &&
    PROTOCOL_PATTERN.test(value.protocol) &&
    typeof value.protocolVersion === "string" &&
    PROTOCOL_VERSION_PATTERN.test(value.protocolVersion) &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isRouteSnapshot(value: unknown): value is PublicRouteSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "alias",
        "provider",
        "host",
        "enabled",
        "state",
        "compatibility",
        "busyPolicy",
        "queueDepth",
        "counters",
      ],
      ["lastSeenAt", "oldestQueuedAt", "safeErrorCode"],
    ) &&
    isAlias(value.alias) &&
    isProvider(value.provider) &&
    isHostId(value.host) &&
    value.alias.endsWith(`@${value.host}`) &&
    typeof value.enabled === "boolean" &&
    (value.state === "stale" ||
      value.state === "idle" ||
      value.state === "busy" ||
      value.state === "awaiting_approval" ||
      value.state === "offline" ||
      value.state === "incompatible" ||
      value.state === "disabled") &&
    isCompatibility(value.compatibility) &&
    value.busyPolicy === "queue" &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    isNonNegativeInteger(value.queueDepth) &&
    (value.oldestQueuedAt === undefined
      ? value.queueDepth === 0
      : value.queueDepth > 0 && isIsoTimestamp(value.oldestQueuedAt)) &&
    isRouteCounters(value.counters) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isAvailablePeerSnapshot(
  value: unknown,
): value is PublicAvailablePeerSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "alias",
        "provider",
        "host",
        "state",
        "compatibility",
        "selected",
      ],
      ["lastSeenAt", "safeErrorCode"],
    ) &&
    isAlias(value.alias) &&
    value.provider === "claude" &&
    isHostId(value.host) &&
    value.alias.endsWith(`@${value.host}`) &&
    (value.state === "idle" ||
      value.state === "busy" ||
      value.state === "awaiting_approval" ||
      value.state === "offline" ||
      value.state === "incompatible") &&
    isCompatibility(value.compatibility) &&
    typeof value.selected === "boolean" &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isNormalizedMessageEvent(
  value: unknown,
): value is NormalizedMessageEvent {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        "sequence",
        "timestamp",
        "messageIdSuffix",
        "direction",
        "sourceAlias",
        "targetAlias",
        "state",
        "bytes",
        "hopCount",
      ],
      ["latencyMs", "safeErrorCode"],
    ) &&
    isNonNegativeInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    (value.direction === "codex_to_claude" ||
      value.direction === "claude_to_codex") &&
    isAlias(value.sourceAlias) &&
    isAlias(value.targetAlias) &&
    (value.state === "queued" ||
      value.state === "duplicate" ||
      value.state === "dispatching" ||
      value.state === "transport_written" ||
      value.state === "held" ||
      value.state === "delivered" ||
      value.state === "unconfirmed" ||
      value.state === "failed" ||
      value.state === "ambiguous" ||
      value.state === "expired" ||
      value.state === "cancelled" ||
      value.state === "abandoned" ||
      value.state === "rejected") &&
    isNonNegativeInteger(value.bytes) &&
    isNonNegativeInteger(value.hopCount) &&
    (value.latencyMs === undefined || isNonNegativeInteger(value.latencyMs)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isAccounting(value: unknown): value is GatewayAccounting {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "accepted",
      "duplicates",
      "delivered",
      "unconfirmed",
      "failed",
      "ambiguous",
      "expired",
      "cancelled",
      "abandoned",
      "rejected",
      "bytesAccepted",
      "queuedBytes",
    ])
  ) {
    return false;
  }
  return Object.values(value).every(isNonNegativeInteger);
}

function isSafeAlert(value: unknown): value is SafeGatewayAlert {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "severity", "timestamp"], [
      "provider",
      "host",
      "alias",
    ]) &&
    isSafeCode(value.code) &&
    (value.severity === "info" ||
      value.severity === "warning" ||
      value.severity === "error") &&
    isIsoTimestamp(value.timestamp) &&
    (value.provider === undefined || isProvider(value.provider)) &&
    (value.host === undefined || isHostId(value.host)) &&
    (value.alias === undefined || isAlias(value.alias))
  );
}

function isSnapshotTruncation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "connectors",
      "availablePeers",
      "routes",
      "messages",
      "alerts",
    ]) &&
    isNonNegativeInteger(value.connectors) &&
    isNonNegativeInteger(value.availablePeers) &&
    isNonNegativeInteger(value.routes) &&
    isNonNegativeInteger(value.messages) &&
    isNonNegativeInteger(value.alerts)
  );
}

export function isGatewaySnapshot(value: unknown): value is GatewaySnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "generatedAt",
      "health",
      "connectors",
      "availablePeers",
      "routes",
      "messages",
      "accounting",
      "alerts",
      "truncation",
    ]) ||
    value.schemaVersion !== 1 ||
    !isIsoTimestamp(value.generatedAt) ||
    !isConnectorHealth(value.health) ||
    !Array.isArray(value.connectors) ||
    value.connectors.length > gatewayPublicSnapshotLimits.connectors ||
    !value.connectors.every(isConnectorSnapshot) ||
    !Array.isArray(value.availablePeers) ||
    value.availablePeers.length > gatewayPublicSnapshotLimits.availablePeers ||
    !value.availablePeers.every(isAvailablePeerSnapshot) ||
    !Array.isArray(value.routes) ||
    value.routes.length > gatewayPublicSnapshotLimits.routes ||
    !value.routes.every(isRouteSnapshot) ||
    !Array.isArray(value.messages) ||
    value.messages.length > gatewayPublicSnapshotLimits.messages ||
    !value.messages.every(isNormalizedMessageEvent) ||
    !isAccounting(value.accounting) ||
    !Array.isArray(value.alerts) ||
    value.alerts.length > gatewayPublicSnapshotLimits.alerts ||
    !value.alerts.every(isSafeAlert) ||
    !isSnapshotTruncation(value.truncation)
  ) {
    return false;
  }

  const connectorKeys = value.connectors.map(
    (connector) => `${connector.provider}@${connector.host}`,
  );
  const aliases = value.routes.map((route) => route.alias);
  const peerAliases = value.availablePeers.map((peer) => peer.alias);
  return (
    new Set(connectorKeys).size === connectorKeys.length &&
    new Set(aliases).size === aliases.length &&
    new Set(peerAliases).size === peerAliases.length &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <=
      GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET
  );
}

function isSnapshotObservation(
  value: unknown,
): value is GatewaySnapshotObservation {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["snapshotRevision", "snapshot"]) &&
    isNonNegativeInteger(value.snapshotRevision) &&
    isGatewaySnapshot(value.snapshot)
  );
}

function isResultForMethod<M extends GatewayControlMethod>(
  method: M,
  value: unknown,
): value is ResultByMethod[M] {
  switch (method) {
    case "health":
      return isHealthResult(value);
    case "register_codex":
    case "unregister_codex":
    case "select_claude":
    case "unselect_claude":
      return isDecision(value);
    case "list_snapshot":
      return isGatewaySnapshot(value);
    case "observe_snapshot":
      return isSnapshotObservation(value);
    case "delivery_status":
      return isDeliveryStatusResult(value);
    case "send_to_claude":
    case "send_to_codex":
    case "reply":
      return isSendResult(value);
    case "refresh_dashboard":
      return isRefreshResult(value);
  }
}

function errorResponse(
  code: GatewayWireErrorCode,
): GatewayControlErrorResponse {
  return {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    ok: false,
    error: { code, message: WIRE_ERROR_MESSAGES[code] },
  };
}

async function dispatch(
  request: ValidatedGatewayControlRequest,
  handlers: GatewayControlHandlers,
): Promise<GatewayControlResponse> {
  let result: unknown;
  try {
    switch (request.method) {
      case "health":
        result = await handlers.health();
        break;
      case "register_codex":
        result = await handlers.registerCodex(request.params);
        break;
      case "unregister_codex":
        result = await handlers.unregisterCodex(request.params);
        break;
      case "select_claude":
        result = await handlers.selectClaude(request.params);
        break;
      case "unselect_claude":
        result = await handlers.unselectClaude(request.params);
        break;
      case "list_snapshot":
        result = await handlers.listSnapshot();
        break;
      case "observe_snapshot":
        result = await handlers.observeSnapshot();
        break;
      case "delivery_status":
        result = await handlers.deliveryStatus(request.params);
        break;
      case "send_to_claude":
        result = await handlers.sendToClaude(request.params);
        break;
      case "send_to_codex":
        result = await handlers.sendToCodex(request.params);
        break;
      case "reply":
        result = await handlers.reply(request.params);
        break;
      case "refresh_dashboard":
        result = await handlers.refreshDashboard();
        break;
    }
  } catch {
    return errorResponse("HANDLER_FAILURE");
  }

  if (!isResultForMethod(request.method, result)) {
    return errorResponse("INVALID_HANDLER_RESPONSE");
  }
  return {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    ok: true,
    result,
  } as GatewayControlSuccessResponse;
}

function serializeResponse(response: GatewayControlResponse): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
  if (encoded.length <= GATEWAY_CONTROL_MAX_RESPONSE_BYTES) return encoded;
  return Buffer.from(
    `${JSON.stringify(errorResponse("RESPONSE_TOO_LARGE"))}\n`,
    "utf8",
  );
}

function respond(socket: Socket, response: GatewayControlResponse): void {
  if (socket.destroyed) return;
  let encoded: Buffer;
  try {
    encoded = serializeResponse(response);
  } catch {
    encoded = Buffer.from(
      `${JSON.stringify(errorResponse("INVALID_HANDLER_RESPONSE"))}\n`,
      "utf8",
    );
  }
  socket.end(encoded);
}

function handleConnection(
  socket: Socket,
  handlers: GatewayControlHandlers,
  requestTimeoutMs: number,
): void {
  let buffered = Buffer.alloc(0);
  let completed = false;

  const complete = (response: GatewayControlResponse): void => {
    if (completed) return;
    completed = true;
    socket.pause();
    socket.setTimeout(0);
    respond(socket, response);
  };

  socket.setTimeout(requestTimeoutMs);
  socket.once("timeout", () => complete(errorResponse("REQUEST_TIMEOUT")));
  socket.on("error", () => {
    completed = true;
  });
  socket.on("data", (chunk: Buffer) => {
    if (completed) return;
    if (buffered.length + chunk.length > GATEWAY_CONTROL_MAX_FRAME_BYTES) {
      complete(errorResponse("FRAME_TOO_LARGE"));
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) return;

    const trailing = buffered.subarray(newline + 1).toString("utf8");
    if (trailing.trim().length > 0) {
      complete(errorResponse("MULTIPLE_FRAMES"));
      return;
    }

    const frame = buffered.subarray(0, newline);
    let request: ValidatedGatewayControlRequest;
    try {
      request = parseRequestFrame(frame);
    } catch (error) {
      const code =
        error instanceof ProtocolFault ? error.code : "INVALID_REQUEST";
      complete(errorResponse(code));
      return;
    }
    completed = true;
    socket.pause();
    socket.setTimeout(0);
    void dispatch(request, handlers).then(
      (response) => respond(socket, response),
      () => respond(socket, errorResponse("HANDLER_FAILURE")),
    );
  });
  socket.once("end", () => {
    if (!completed) socket.destroy();
  });
}

function controlTransportError(
  code: string,
  ambiguous = false,
): GatewayControlTransportError {
  const messages: Record<string, string> = {
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
    CONTROL_TIMEOUT: "The gateway control request timed out.",
    CONTROL_RESPONSE_TOO_LARGE: "The gateway control response exceeds the client limit.",
    CONTROL_INVALID_RESPONSE: "The gateway returned an invalid control response.",
    CONTROL_CONNECTION_CLOSED: "The gateway closed before returning a control response.",
    CONTROL_OUTCOME_AMBIGUOUS:
      "The gateway may have applied the control mutation before the response was lost; do not retry automatically.",
  };
  return new GatewayControlTransportError(
    code,
    messages[code] ?? "The gateway control transport failed.",
    ambiguous,
  );
}

function isNonIdempotentControlMethod(method: GatewayControlMethod): boolean {
  return (
    method === "register_codex" ||
    method === "unregister_codex" ||
    method === "select_claude" ||
    method === "unselect_claude" ||
    method === "send_to_claude" ||
    method === "send_to_codex" ||
    method === "reply"
  );
}

async function optionalLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateSocketLocation(
  stateDir: string,
  socketPath: string,
): Promise<void> {
  if (process.platform === "win32") {
    throw controlTransportError("UNSUPPORTED_PLATFORM");
  }
  if (
    !path.isAbsolute(stateDir) ||
    path.resolve(stateDir) !== stateDir ||
    !path.isAbsolute(socketPath) ||
    path.resolve(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }

  let stateInfo;
  try {
    stateInfo = await lstat(stateDir);
  } catch {
    throw controlTransportError("INVALID_STATE_DIR");
  }
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    throw controlTransportError("INVALID_STATE_DIR");
  }
  const getuid = process.getuid;
  if (
    (getuid !== undefined && stateInfo.uid !== getuid.call(process)) ||
    (stateInfo.mode & 0o077) !== 0
  ) {
    throw controlTransportError("INSECURE_STATE_DIR");
  }

  let stateReal: string;
  let parentReal: string;
  try {
    [stateReal, parentReal] = await Promise.all([
      realpath(stateDir),
      realpath(path.dirname(socketPath)),
    ]);
  } catch {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }
  if (
    socketPath === stateDir ||
    (parentReal !== stateReal &&
      !parentReal.startsWith(`${stateReal}${path.sep}`))
  ) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("timeout", () =>
      finish(() => reject(controlTransportError("SOCKET_PROBE_FAILED"))),
    );
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        finish(() => resolve(false));
      } else {
        finish(() => reject(controlTransportError("SOCKET_PROBE_FAILED")));
      }
    });
  });
}

function sameIdentity(
  info: { dev: number; ino: number },
  identity: SocketIdentity,
): boolean {
  return info.dev === identity.dev && info.ino === identity.ino;
}

async function prepareSocketTarget(socketPath: string): Promise<void> {
  let existing;
  try {
    existing = await optionalLstat(socketPath);
  } catch {
    throw controlTransportError("UNSAFE_SOCKET_TARGET");
  }
  if (!existing) return;
  if (existing.isSymbolicLink() || !existing.isSocket()) {
    throw controlTransportError("UNSAFE_SOCKET_TARGET");
  }
  const identity = { dev: existing.dev, ino: existing.ino };
  if (await socketIsLive(socketPath)) {
    throw controlTransportError("SOCKET_IN_USE");
  }

  let current;
  try {
    current = await lstat(socketPath);
  } catch {
    throw controlTransportError("UNSAFE_SOCKET_TARGET");
  }
  if (!current.isSocket() || !sameIdentity(current, identity)) {
    throw controlTransportError("UNSAFE_SOCKET_TARGET");
  }
  try {
    await unlink(socketPath);
  } catch {
    throw controlTransportError("UNSAFE_SOCKET_TARGET");
  }
}

async function closeNativeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function removeOwnedSocket(
  socketPath: string,
  identity: SocketIdentity,
): Promise<void> {
  let current;
  try {
    current = await optionalLstat(socketPath);
  } catch {
    return;
  }
  if (!current) return;
  if (!current.isSocket() || !sameIdentity(current, identity)) return;
  try {
    await unlink(socketPath);
  } catch {
    // The server is already closed. A failed best-effort exact unlink must not
    // broaden cleanup to any replacement path.
  }
}

type ProtectedSocketReplacement = {
  directory: string;
  backupPath: string;
};

async function protectSocketReplacement(
  socketPath: string,
  identity: SocketIdentity,
): Promise<ProtectedSocketReplacement | undefined> {
  let current;
  try {
    current = await optionalLstat(socketPath);
  } catch {
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
  if (!current || sameIdentity(current, identity)) return undefined;

  let directory: string;
  try {
    directory = await mkdtemp(
      path.join(path.dirname(socketPath), ".gateway-control-close-"),
    );
  } catch {
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
  const backupPath = path.join(directory, "replacement");
  try {
    await rename(socketPath, backupPath);
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
  return { directory, backupPath };
}

async function restoreSocketReplacement(
  socketPath: string,
  replacement: ProtectedSocketReplacement | undefined,
): Promise<void> {
  if (!replacement) return;
  let current;
  try {
    current = await optionalLstat(socketPath);
  } catch {
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
  if (current) {
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
  try {
    await rename(replacement.backupPath, socketPath);
    await rmdir(replacement.directory);
  } catch {
    throw controlTransportError("SOCKET_CLEANUP_CONFLICT");
  }
}

function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 50 && value <= 30_000;
}

export async function startGatewayControlServer(
  options: StartGatewayControlServerOptions,
): Promise<GatewayControlServer> {
  await validateSocketLocation(options.stateDir, options.socketPath);
  await prepareSocketTarget(options.socketPath);
  const requestTimeoutMs =
    options.requestTimeoutMs ?? GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
  if (!validTimeout(requestTimeoutMs)) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }

  const connections = new Set<Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    // Directory ownership proves same-user access, not that every caller is a
    // trusted agent. Bound idle and in-flight peers before allocating parser or
    // handler state so a local peer cannot grow this set without limit.
    if (connections.size >= GATEWAY_CONTROL_MAX_CONNECTIONS) {
      socket.once("error", () => socket.destroy());
      socket.end(serializeResponse(errorResponse("SERVER_BUSY")), () =>
        socket.destroy(),
      );
      return;
    }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    handleConnection(socket, options.handlers, requestTimeoutMs);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => reject(controlTransportError("SOCKET_BIND_FAILED"));
      server.once("error", onError);
      server.listen(options.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await closeNativeServer(server);
    throw error;
  }

  let identity: SocketIdentity | undefined;
  try {
    const info = await lstat(options.socketPath);
    if (!info.isSocket()) throw new Error("not a socket");
    identity = { dev: info.dev, ino: info.ino };
    await chmod(options.socketPath, 0o600);
    const secured = await lstat(options.socketPath);
    if (
      !secured.isSocket() ||
      !sameIdentity(secured, identity) ||
      (secured.mode & 0o777) !== 0o600
    ) {
      throw new Error("socket identity changed");
    }
  } catch {
    for (const connection of connections) connection.destroy();
    await closeNativeServer(server);
    if (identity) await removeOwnedSocket(options.socketPath, identity);
    throw controlTransportError("SOCKET_PERMISSION_FAILED");
  }

  const ownedIdentity = identity;

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const replacement = await protectSocketReplacement(
        options.socketPath,
        ownedIdentity,
      );
      for (const connection of connections) connection.destroy();
      await closeNativeServer(server);
      await removeOwnedSocket(options.socketPath, ownedIdentity);
      await restoreSocketReplacement(options.socketPath, replacement);
      closed = true;
    })();
    return closePromise;
  };

  return {
    socketPath: options.socketPath,
    get closed() {
      return closed;
    },
    close,
  };
}

function validateResponseForMethod<M extends GatewayControlMethod>(
  method: M,
  value: unknown,
): GatewayControlResponse<M> {
  if (!isRecord(value) || value.protocolVersion !== 1) {
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  }
  if (value.ok === false) {
    if (
      !hasExactKeys(value, ["protocolVersion", "ok", "error"]) ||
      !isRecord(value.error) ||
      !hasExactKeys(value.error, ["code", "message"]) ||
      typeof value.error.code !== "string" ||
      !Object.hasOwn(WIRE_ERROR_MESSAGES, value.error.code) ||
      value.error.message !==
        WIRE_ERROR_MESSAGES[value.error.code as GatewayWireErrorCode]
    ) {
      throw controlTransportError("CONTROL_INVALID_RESPONSE");
    }
    return value as GatewayControlErrorResponse;
  }
  if (
    value.ok !== true ||
    !hasExactKeys(value, ["protocolVersion", "ok", "result"]) ||
    !isResultForMethod(method, value.result)
  ) {
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  }
  return value as GatewayControlSuccessResponse<M>;
}

export type SendGatewayControlRequestOptions<
  M extends GatewayControlMethod,
> = {
  socketPath: string;
  request: Extract<GatewayControlRequest, { method: M }>;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export async function sendGatewayControlRequest<
  M extends GatewayControlMethod,
>(
  options: SendGatewayControlRequestOptions<M>,
): Promise<GatewayControlResponse<M>> {
  if (
    !path.isAbsolute(options.socketPath) ||
    path.resolve(options.socketPath) !== options.socketPath ||
    Buffer.byteLength(options.socketPath, "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }
  const timeoutMs = options.timeoutMs ?? GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? GATEWAY_CONTROL_MAX_RESPONSE_BYTES;
  if (
    !validTimeout(timeoutMs) ||
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 256 ||
    maxResponseBytes > GATEWAY_CONTROL_MAX_RESPONSE_BYTES
  ) {
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  }

  const normalized = parseRequestObject(options.request);
  if (normalized.method !== options.request.method) {
    throw new ProtocolFault("INVALID_REQUEST");
  }
  const requestFrame = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  if (requestFrame.length > GATEWAY_CONTROL_MAX_FRAME_BYTES) {
    throw new ProtocolFault("FRAME_TOO_LARGE");
  }

  return await new Promise<GatewayControlResponse<M>>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false;
    let writeStarted = false;
    let buffered = Buffer.alloc(0);
    const mutation = isNonIdempotentControlMethod(normalized.method);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        mutation && writeStarted
          ? controlTransportError("CONTROL_OUTCOME_AMBIGUOUS", true)
          : error,
      );
    };
    const succeed = (response: GatewayControlResponse<M>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(response);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      // From this point onward the peer may receive and execute all or part of
      // the frame. Losing the response to a mutation is therefore ambiguous,
      // never a safe retry signal.
      writeStarted = true;
      socket.write(requestFrame);
    });
    socket.once("timeout", () => fail(controlTransportError("CONTROL_TIMEOUT")));
    socket.once("error", () =>
      fail(controlTransportError("CONTROL_CONNECT_FAILED")),
    );
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (buffered.length + chunk.length > maxResponseBytes) {
        fail(controlTransportError("CONTROL_RESPONSE_TOO_LARGE"));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      if (buffered.subarray(newline + 1).toString("utf8").trim().length > 0) {
        fail(controlTransportError("CONTROL_INVALID_RESPONSE"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffered.subarray(0, newline),
          ),
        );
      } catch {
        fail(controlTransportError("CONTROL_INVALID_RESPONSE"));
        return;
      }
      try {
        succeed(validateResponseForMethod(options.request.method, parsed));
      } catch {
        fail(controlTransportError("CONTROL_INVALID_RESPONSE"));
      }
    });
    socket.once("close", () => {
      if (!settled) {
        fail(controlTransportError("CONTROL_CONNECTION_CLOSED"));
      }
    });
  });
}
