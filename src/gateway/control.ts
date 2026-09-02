/** Private, bounded JSONL control transport over one same-user Unix socket. */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rename, rmdir, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  CONNECTOR_OBSERVATION_STALE_AFTER_MS,
  GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  gatewayProviders,
  gatewayPublicSnapshotLimits,
  isGatewayProvider,
  isMessageDirection,
  isPublicRegistryObservationSnapshot,
} from "./types.js";
import type {
  DeadlinePressureSnapshot,
  GatewayAccounting,
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicAvailablePeerSnapshot,
  PublicConnectorSnapshot,
  PublicConsentEdgeSnapshot,
  PublicGatewayActivityEvent,
  PublicProgressWatchEventSnapshot,
  PublicProgressWatchSnapshot,
  PublicRouteSnapshot,
  RouteCounters,
  SafeGatewayAlert,
} from "./types.js";
import { decodePeerParams, decodePeerResult, type PeerCatalogResult,
  type PeerHandoffParams, type PeerHandoffResult } from "./peer-protocol.js";
import { isPeerMailboxAwaitResult, type PeerMailboxAwaitResult } from "./peer-mailbox.js";

export const GATEWAY_CONTROL_PROTOCOL_VERSION = 2 as const;
export const GATEWAY_CONTROL_MAX_FRAME_BYTES = 32 * 1024;
export const GATEWAY_CONTROL_MAX_RESPONSE_BYTES = 256 * 1024;
export const GATEWAY_CONTROL_MAX_MESSAGE_BYTES = 16 * 1024;
export const GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS = 3_000;
export const GATEWAY_CONTROL_MAX_CONNECTIONS = 32;

const MAX_SOCKET_PATH_BYTES = 100;
const MAX_REPLY_ADDRESS_BYTES = 256;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{16,64}$/;
const DELIVERY_TOKEN_PATTERN = /^dlv_[A-Za-z0-9_-]{24}$/;
const PEER_TOKEN_PATTERN = /^peer_[A-Za-z0-9_-]{32}$/;
const PEER_RECEIPT_PATTERN = /^prc_[A-Za-z0-9_-]{24}$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTOCOL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const MESSAGE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const CONVERSATION_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const gatewayControlMethods = [
  "health", "register_codex", "unregister_codex",
  "select_claude", "unselect_claude", "pair", "unpair", "list_snapshot",
  "observe_snapshot", "delivery_status", "untrack", "send", "reply",
  "refresh_discovery", "peer_catalog", "peer_handoff",
  "register_peer", "unregister_peer", "await_peer", "peer_receipt",
] as const;
export type GatewayControlMethod = (typeof gatewayControlMethods)[number];
export type GatewayBusyPolicy = "queue";

export type RegisterCodexParams = {
  alias: string; threadId: string; hostId: string; busyPolicy: GatewayBusyPolicy;
  succeedsAlias?: string;
};
export type ValidatedRegisterCodexParams = {
  alias: string; threadId: string; hostId: string; busyPolicy: GatewayBusyPolicy;
  succeedsAlias?: string;
};
export type UnregisterCodexParams = { alias: string; threadId: string };
export type SelectClaudeParams = { alias: string };
export type PairParams = {
  aliases: readonly [string, string];
};
type SendBase = { fromAlias: string; toAlias: string; text: string; expectsReply?: boolean; trackIdleMinutes?: number };
type ValidatedSendBase = Omit<SendBase, "expectsReply"> & { expectsReply: boolean };
export type SendParams = SendBase & (
  | { threadId: string; replyAddress?: never; peerToken?: never }
  | { replyAddress: string; threadId?: never; peerToken?: never }
  | { peerToken: string; threadId?: never; replyAddress?: never }
);
export type ValidatedSendParams = ValidatedSendBase & (
  | { threadId: string; replyAddress?: never; peerToken?: never }
  | { replyAddress: string; threadId?: never; peerToken?: never }
  | { peerToken: string; threadId?: never; replyAddress?: never }
);
export type GatewayReplyCaller =
  | { kind: "codex"; alias: string; threadId: string }
  | { kind: "claude"; alias: string; replyAddress?: string }
  | { kind: "peer"; alias: string; token: string };
export type ReplyParams = {
  conversationId: string; text: string; caller: GatewayReplyCaller;
  trackIdleMinutes?: number;
};
export type UntrackParams = { conversationId: string };
export type DeliveryStatusParams = { token: string };
export type PeerCatalogParams = { peerHost: string };
export type PeerHandoffControlParams = { peerHost: string; handoff: PeerHandoffParams };
export type RegisterPeerParams = { alias: string; token?: string };
export type PeerPrincipalParams = { alias: string; token: string };
export type PeerReceiptParams = PeerPrincipalParams & { receipt: string };

type RequestParams = {
  health: Record<string, never>; register_codex: RegisterCodexParams;
  unregister_codex: UnregisterCodexParams;
  select_claude: SelectClaudeParams; unselect_claude: SelectClaudeParams;
  pair: PairParams; unpair: PairParams; list_snapshot: Record<string, never>;
  observe_snapshot: Record<string, never>; delivery_status: DeliveryStatusParams;
  untrack: UntrackParams; send: SendParams; reply: ReplyParams;
  refresh_discovery: Record<string, never>; peer_catalog: PeerCatalogParams;
  peer_handoff: PeerHandoffControlParams;
  register_peer: RegisterPeerParams; unregister_peer: PeerPrincipalParams;
  await_peer: PeerPrincipalParams; peer_receipt: PeerReceiptParams;
};
type ValidatedParams = Omit<RequestParams, "register_codex" | "send"> & {
  register_codex: ValidatedRegisterCodexParams;
  send: ValidatedSendParams;
};
export type GatewayControlRequest = {
  [M in GatewayControlMethod]: { protocolVersion: typeof GATEWAY_CONTROL_PROTOCOL_VERSION; method: M; params: RequestParams[M] }
}[GatewayControlMethod];
type ValidatedGatewayControlRequest = {
  [M in GatewayControlMethod]: { protocolVersion: typeof GATEWAY_CONTROL_PROTOCOL_VERSION; method: M; params: ValidatedParams[M] }
}[GatewayControlMethod];

export type GatewayDecisionCode =
  | "ok" | "not_found" | "conflict" | "watch_owner_conflict" | "route_mismatch"
  | "busy" | "unavailable" | "rejected";
export type GatewayDecision =
  | { accepted: true; code: "ok" }
  | { accepted: false; code: Exclude<GatewayDecisionCode, "ok">; ownerHost?: string };
export type GatewaySendResult =
  | { accepted: true; code: "ok"; conversationId: string; deliveryToken: string }
  | { accepted: false; code: Exclude<GatewayDecisionCode, "ok"> };
export type GatewayHealthResult = { status: "ok" | "degraded"; revision: number };
export type GatewayRefreshResult = GatewayDecision & { revision: number };
export type GatewayDeliveryStatusState =
  | "queued" | "stalled" | "delivered" | "unconfirmed" | "expired" | "failed"
  | "ambiguous" | "cancelled";
export type GatewayDeliveryStatusResult =
  | { found: false }
  | {
      found: true; state: GatewayDeliveryStatusState; terminal: boolean;
      updatedAt: string; deadlineAt: string; pendingForMs?: number;
      safeErrorCode?: string;
    };
export type GatewaySnapshot = GatewayPublicSnapshot;
export type GatewaySnapshotObservation = { snapshotRevision: number; snapshot: GatewaySnapshot };
export type GatewayRegisterPeerResult = GatewayDecision | { accepted: true; code: "ok"; token: string };

type ResultByMethod = {
  health: GatewayHealthResult; register_codex: GatewayDecision;
  unregister_codex: GatewayDecision;
  select_claude: GatewayDecision; unselect_claude: GatewayDecision;
  pair: GatewayDecision; unpair: GatewayDecision; list_snapshot: GatewaySnapshot;
  observe_snapshot: GatewaySnapshotObservation; delivery_status: GatewayDeliveryStatusResult;
  untrack: GatewayDecision; send: GatewaySendResult; reply: GatewaySendResult;
  refresh_discovery: GatewayRefreshResult; peer_catalog: PeerCatalogResult;
  peer_handoff: PeerHandoffResult;
  register_peer: GatewayRegisterPeerResult; unregister_peer: GatewayDecision;
  await_peer: PeerMailboxAwaitResult; peer_receipt: GatewayDecision;
};
type MaybePromise<T> = T | Promise<T>;
export type GatewayControlHandlers = {
  health: () => MaybePromise<GatewayHealthResult>;
  registerCodex: (params: Readonly<ValidatedRegisterCodexParams>) => MaybePromise<GatewayDecision>;
  unregisterCodex: (params: Readonly<UnregisterCodexParams>) => MaybePromise<GatewayDecision>;
  selectClaude: (params: Readonly<SelectClaudeParams>) => MaybePromise<GatewayDecision>;
  unselectClaude: (params: Readonly<SelectClaudeParams>) => MaybePromise<GatewayDecision>;
  pair: (params: Readonly<PairParams>) => MaybePromise<GatewayDecision>;
  unpair: (params: Readonly<PairParams>) => MaybePromise<GatewayDecision>;
  listSnapshot: () => MaybePromise<GatewaySnapshot>;
  observeSnapshot: () => MaybePromise<GatewaySnapshotObservation>;
  deliveryStatus: (params: Readonly<DeliveryStatusParams>) => MaybePromise<GatewayDeliveryStatusResult>;
  untrack: (params: Readonly<UntrackParams>) => MaybePromise<GatewayDecision>;
  send: (params: Readonly<ValidatedSendParams>) => MaybePromise<GatewaySendResult>;
  reply: (params: Readonly<ReplyParams>) => MaybePromise<GatewaySendResult>;
  refreshDiscovery: () => MaybePromise<GatewayRefreshResult>;
  peerCatalog?: (params: Readonly<PeerCatalogParams>) => MaybePromise<PeerCatalogResult>;
  peerHandoff?: (params: Readonly<PeerHandoffControlParams>) => MaybePromise<PeerHandoffResult>;
  registerPeer: (params: Readonly<RegisterPeerParams>) => MaybePromise<GatewayRegisterPeerResult>;
  unregisterPeer: (params: Readonly<PeerPrincipalParams>) => MaybePromise<GatewayDecision>;
  awaitPeer: (params: Readonly<PeerPrincipalParams>) => MaybePromise<PeerMailboxAwaitResult>;
  peerReceipt: (params: Readonly<PeerReceiptParams>) => MaybePromise<GatewayDecision>;
};

export type GatewayWireErrorCode =
  | "INVALID_JSON" | "FRAME_TOO_LARGE" | "INVALID_REQUEST" | "UNSUPPORTED_VERSION"
  | "UNKNOWN_METHOD" | "MULTIPLE_FRAMES" | "SERVER_BUSY" | "REQUEST_TIMEOUT"
  | "HANDLER_FAILURE" | "INVALID_HANDLER_RESPONSE" | "RESPONSE_TOO_LARGE";
export type GatewayControlErrorResponse = {
  protocolVersion: typeof GATEWAY_CONTROL_PROTOCOL_VERSION; ok: false; error: { code: GatewayWireErrorCode; message: string };
};
export type GatewayControlSuccessResponse<M extends GatewayControlMethod = GatewayControlMethod> = {
  protocolVersion: typeof GATEWAY_CONTROL_PROTOCOL_VERSION; ok: true; result: ResultByMethod[M];
};
export type GatewayControlResponse<M extends GatewayControlMethod = GatewayControlMethod> =
  GatewayControlSuccessResponse<M> | GatewayControlErrorResponse;

const WIRE_ERROR_MESSAGES: Record<GatewayWireErrorCode, string> = {
  INVALID_JSON: "The control frame is not valid JSON.", FRAME_TOO_LARGE: "The control frame exceeds the size limit.",
  INVALID_REQUEST: "The control request is invalid.", UNSUPPORTED_VERSION: "The control protocol version is unsupported.",
  UNKNOWN_METHOD: "The control method is unsupported.", MULTIPLE_FRAMES: "Only one control request is allowed per connection.",
  SERVER_BUSY: "The gateway control server is at its connection limit.", REQUEST_TIMEOUT: "The control request timed out.",
  HANDLER_FAILURE: "The gateway could not complete the control request.", INVALID_HANDLER_RESPONSE: "The gateway produced an invalid control response.",
  RESPONSE_TOO_LARGE: "The control response exceeds the size limit.",
};
const TRANSPORT_MESSAGES: Record<string, string> = {
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
  CONTROL_LISTENER_UNAVAILABLE: "Nothing is listening on the gateway control socket.",
  CONTROL_TIMEOUT: "The gateway control request timed out.",
  CONTROL_RESPONSE_TOO_LARGE: "The gateway control response exceeds the client limit.",
  CONTROL_INVALID_RESPONSE: "The gateway returned an invalid control response. Restart the broker, then retry.",
  CONTROL_VERSION_MISMATCH: "The gateway control protocol version does not match this client.",
  CONTROL_CONNECTION_CLOSED: "The gateway closed before returning a control response.",
  CONTROL_OUTCOME_AMBIGUOUS: "The gateway may have applied the control mutation before the response was lost; do not retry automatically.",
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

function controlTransportError(
  code: string,
  ambiguous = false,
): GatewayControlTransportError {
  return new GatewayControlTransportError(
    code,
    TRANSPORT_MESSAGES[code] ?? "The gateway control transport failed.",
    ambiguous,
  );
}
function invalid(): never { throw new ProtocolFault("INVALID_REQUEST"); }

export function createGatewayConversationId(): string {
  return `conv_${randomBytes(18).toString("base64url")}`;
}
export function isGatewayAlias(value: string): boolean { return ALIAS_PATTERN.test(value); }
export function isClaudeSessionSelector(value: string): boolean {
  return isGatewayAlias(value) || UUID_PATTERN.test(value);
}
export function isGatewayHostId(value: string): boolean { return HOST_PATTERN.test(value); }
export function isGatewayConversationId(value: string): boolean { return CONVERSATION_ID_PATTERN.test(value); }
export function isGatewayDeliveryToken(value: string): boolean { return DELIVERY_TOKEN_PATTERN.test(value); }
export function isGatewayReplyAddress(value: string): boolean {
  if (value.includes("\0") || !value.startsWith("uds:") ||
      Buffer.byteLength(value, "utf8") > MAX_REPLY_ADDRESS_BYTES) return false;
  const socketPath = value.slice(4);
  return path.isAbsolute(socketPath) && path.resolve(socketPath) === socketPath &&
    Buffer.byteLength(socketPath, "utf8") <= MAX_SOCKET_PATH_BYTES;
}

type JsonRecord = Record<string, unknown>;
type Check = (value: unknown) => boolean;
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

function isTrackIdleMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 24 * 60
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

function isMessageText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= GATEWAY_CONTROL_MAX_MESSAGE_BYTES
  );
}
const exact = hasExactKeys;
const nonNegative = isNonNegativeInteger;
const trackMinutes = isTrackIdleMinutes;
const iso = isIsoTimestamp;
const uuid = isUuid;
const alias = isAlias;
const host = isHostId;
function shape(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): value is JsonRecord {
  if (!isRecord(value) || !exact(value, Object.keys(required), Object.keys(optional))) return false;
  return Object.entries(required).every(([key, check]) => check(value[key])) &&
    Object.entries(optional).every(([key, check]) => value[key] === undefined || check(value[key]));
}
function oneOf<T extends readonly unknown[]>(...values: T): Check { return (value) => values.includes(value); }
function arrayOf(value: unknown, maximum: number, check: Check): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && value.every(check); }
function positive(value: unknown): value is number { return nonNegative(value) && value > 0; }
function safeCode(value: unknown): value is string { return typeof value === "string" && SAFE_CODE_PATTERN.test(value); }
const messageText = isMessageText;
const peerToken: Check = (value) => typeof value === "string" && PEER_TOKEN_PATTERN.test(value);
const peerAlias: Check = (value) => alias(value) && (value as string).startsWith("peer-");

function emptyParams(value: unknown): Record<string, never> {
  if (!isRecord(value) || !exact(value, [])) invalid(); return {};
}
function decodePeerCatalog(value: unknown): PeerCatalogParams {
  if (!shape(value, { peerHost: host })) invalid();
  return { peerHost: value.peerHost as string };
}
function decodePeerHandoff(value: unknown): PeerHandoffControlParams {
  if (!isRecord(value) || !exact(value, ["peerHost", "handoff"]) || !host(value.peerHost)) invalid();
  try { return { peerHost: value.peerHost, handoff: decodePeerParams("handoff", value.handoff) }; }
  catch { return invalid(); }
}
function decodeRegisterPeer(value: unknown): RegisterPeerParams {
  if (!shape(value, { alias: peerAlias }, { token: peerToken })) invalid();
  return { alias: value.alias as string, ...(value.token === undefined ? {} : { token: value.token as string }) };
}
function decodePeerPrincipal(value: unknown): PeerPrincipalParams {
  if (!shape(value, { alias: peerAlias, token: peerToken })) invalid();
  return { alias: value.alias as string, token: value.token as string };
}
function decodePeerReceipt(value: unknown): PeerReceiptParams {
  if (!shape(value, { alias: peerAlias, token: peerToken,
    receipt: (item) => typeof item === "string" && PEER_RECEIPT_PATTERN.test(item) })) invalid();
  return { alias: value.alias as string, token: value.token as string, receipt: value.receipt as string };
}
const isPeerCatalog = (value: unknown): boolean => {
  try { decodePeerResult("catalog/get", value); return true; } catch { return false; }
};
const isPeerHandoffResult = (value: unknown): boolean => {
  try { decodePeerResult("handoff", value); return true; } catch { return false; }
};
function decodeRegister(value: unknown): ValidatedRegisterCodexParams {
  if (!isRecord(value) || !exact(value, ["alias", "threadId", "hostId", "busyPolicy"], ["succeedsAlias"]) ||
      !alias(value.alias) || !value.alias.startsWith("codex-") || !uuid(value.threadId) ||
      !host(value.hostId) || value.busyPolicy !== "queue" ||
      (value.succeedsAlias !== undefined && (!alias(value.succeedsAlias) || !value.succeedsAlias.startsWith("codex-")))) invalid();
  if (!value.alias.endsWith(`@${value.hostId}`) ||
      (value.succeedsAlias !== undefined &&
       (value.succeedsAlias === value.alias || !value.succeedsAlias.endsWith(`@${value.hostId}`)))) invalid();
  return { alias: value.alias, threadId: value.threadId.toLowerCase(), hostId: value.hostId,
    busyPolicy: value.busyPolicy, ...(value.succeedsAlias === undefined ? {} : { succeedsAlias: value.succeedsAlias }) };
}
function decodeUnregister(value: unknown): UnregisterCodexParams {
  if (!shape(value, { alias, threadId: uuid }) || !(value.alias as string).startsWith("codex-")) invalid();
  return { alias: value.alias as string, threadId: (value.threadId as string).toLowerCase() }; }
function decodeSelection(value: unknown): SelectClaudeParams {
  if (!isRecord(value) || !exact(value, ["alias"]) ||
      typeof value.alias !== "string" || !isClaudeSessionSelector(value.alias)) invalid();
  return { alias: UUID_PATTERN.test(value.alias) ? value.alias.toLowerCase() : value.alias };
}
function decodePair(value: unknown): PairParams {
  if (!isRecord(value) || !exact(value, ["aliases"]) || !Array.isArray(value.aliases) ||
      value.aliases.length !== 2 || !alias(value.aliases[0]) || !alias(value.aliases[1]) ||
      value.aliases[0] === value.aliases[1]) invalid();
  return { aliases: [value.aliases[0], value.aliases[1]] };
}
function decodeSend(value: unknown): ValidatedSendParams {
  if (!isRecord(value) || !exact(value, ["fromAlias", "toAlias", "text"],
    ["threadId", "replyAddress", "peerToken", "expectsReply", "trackIdleMinutes"]) ||
      !alias(value.fromAlias) || typeof value.toAlias !== "string" || !isClaudeSessionSelector(value.toAlias) ||
      !messageText(value.text) || [value.threadId, value.replyAddress, value.peerToken].filter((item) => item !== undefined).length !== 1 ||
      (value.threadId !== undefined && !uuid(value.threadId)) ||
      (value.replyAddress !== undefined && (typeof value.replyAddress !== "string" || !isGatewayReplyAddress(value.replyAddress))) ||
      (value.peerToken !== undefined && !peerToken(value.peerToken)) ||
      (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") ||
      (value.trackIdleMinutes !== undefined && !trackMinutes(value.trackIdleMinutes))) invalid();
  const authority = value.threadId !== undefined ? { threadId: (value.threadId as string).toLowerCase() }
    : value.replyAddress !== undefined ? { replyAddress: value.replyAddress as string }
    : { peerToken: value.peerToken as string };
  return { fromAlias: value.fromAlias, toAlias: UUID_PATTERN.test(value.toAlias) ? value.toAlias.toLowerCase() : value.toAlias,
    text: value.text, ...authority, expectsReply: value.expectsReply === true,
    ...(value.trackIdleMinutes === undefined ? {} : { trackIdleMinutes: value.trackIdleMinutes }) } as ValidatedSendParams;
}
function normalizeReplyCaller(value: unknown): GatewayReplyCaller {
  if (!isRecord(value)) invalid();
  if (value.kind === "codex" && shape(value, { kind: oneOf("codex"), alias, threadId: uuid }))
    return { kind: "codex", alias: value.alias as string,
      threadId: (value.threadId as string).toLowerCase() };
  if (value.kind === "claude" && isRecord(value) && exact(value, ["kind", "alias"], ["replyAddress"]) &&
      alias(value.alias) && (value.replyAddress === undefined ||
      (typeof value.replyAddress === "string" && isGatewayReplyAddress(value.replyAddress))))
    return { kind: "claude", alias: value.alias,
      ...(value.replyAddress === undefined ? {} : { replyAddress: value.replyAddress }) };
  if (value.kind === "peer" && shape(value, { kind: oneOf("peer"), alias: peerAlias, token: peerToken }))
    return { kind: "peer", alias: value.alias as string, token: value.token as string };
  return invalid();
}
function decodeReply(value: unknown): ReplyParams {
  if (!isRecord(value) || !exact(value, ["conversationId", "text", "caller"], ["trackIdleMinutes"]) ||
      typeof value.conversationId !== "string" || !isGatewayConversationId(value.conversationId) ||
      !messageText(value.text) ||
      (value.trackIdleMinutes !== undefined && !trackMinutes(value.trackIdleMinutes))) invalid();
  return { conversationId: value.conversationId, text: value.text, caller: normalizeReplyCaller(value.caller),
    ...(value.trackIdleMinutes === undefined ? {} : { trackIdleMinutes: value.trackIdleMinutes }) };
}
function decodeDeliveryStatus(value: unknown): DeliveryStatusParams {
  if (!shape(value, { token: (item) => typeof item === "string" && DELIVERY_TOKEN_PATTERN.test(item) })) invalid();
  return { token: value.token as string }; }
function decodeUntrack(value: unknown): UntrackParams {
  if (!shape(value, { conversationId: (item) => typeof item === "string" && CONVERSATION_ID_PATTERN.test(item) })) invalid();
  return { conversationId: value.conversationId as string }; }

function isDecision(value: unknown): value is GatewayDecision {
  return shape(value, { accepted: (item) => typeof item === "boolean", code: oneOf(
    "ok", "not_found", "conflict", "watch_owner_conflict", "route_mismatch", "busy", "unavailable", "rejected",
  ) }, { ownerHost: host }) && (value.accepted === true
    ? value.code === "ok" && value.ownerHost === undefined
    : value.code !== "ok" && (value.ownerHost === undefined || value.code === "conflict"));
}
function isRegisterPeerResult(value: unknown): value is GatewayRegisterPeerResult {
  return isDecision(value) || shape(value, { accepted: oneOf(true), code: oneOf("ok"), token: peerToken });
}
function isHealthResult(value: unknown): value is GatewayHealthResult {
  return shape(value, { status: oneOf("ok", "degraded"), revision: nonNegative }); }
function isSendResult(value: unknown): value is GatewaySendResult {
  if (!isRecord(value) || value.accepted !== true) return isDecision(value);
  return shape(value, { accepted: oneOf(true), code: oneOf("ok"),
    conversationId: (item) => typeof item === "string" && CONVERSATION_ID_PATTERN.test(item),
    deliveryToken: (item) => typeof item === "string" && DELIVERY_TOKEN_PATTERN.test(item) });
}
function isRefreshResult(value: unknown): value is GatewayRefreshResult {
  return shape(value, { accepted: (item) => typeof item === "boolean", code: oneOf(
    "ok", "not_found", "conflict", "watch_owner_conflict", "route_mismatch", "busy", "unavailable", "rejected",
  ), revision: nonNegative }) && isDecision({ accepted: value.accepted, code: value.code });
}
const TERMINAL = new Set<GatewayDeliveryStatusState>(["delivered", "unconfirmed", "expired", "failed", "ambiguous", "cancelled"]);
function isDeliveryStatusResult(value: unknown): value is GatewayDeliveryStatusResult {
  if (!isRecord(value) || typeof value.found !== "boolean") return false;
  if (!value.found) return exact(value, ["found"]);
  return shape(value, { found: oneOf(true), state: oneOf(
    "queued", "stalled", "delivered", "unconfirmed", "expired", "failed", "ambiguous", "cancelled",
  ), terminal: (item) => typeof item === "boolean", updatedAt: iso, deadlineAt: iso },
  { pendingForMs: nonNegative, safeErrorCode: safeCode }) && value.terminal === TERMINAL.has(value.state as GatewayDeliveryStatusState);
}
function isRouteCounters(value: unknown): value is RouteCounters {
  const keys = ["accepted", "delivered", "unconfirmed", "failed", "ambiguous", "expired",
    "cancelled", "abandoned", "rejected", "bytesAccepted"];
  return isRecord(value) && exact(value, keys) && keys.every((key) => nonNegative(value[key])); }
const isConnectorHealth = oneOf("offline", "connecting", "healthy", "degraded");
function isConnectorSnapshot(value: unknown): value is PublicConnectorSnapshot {
  if (!shape(value, { provider: isGatewayProvider, host, health: isConnectorHealth,
    protocol: (item) => typeof item === "string" && PROTOCOL_PATTERN.test(item),
    protocolVersion: (item) => typeof item === "string" && PROTOCOL_VERSION_PATTERN.test(item) },
  { lastSeenAt: iso, observationAgeMs: nonNegative, safeErrorCode: safeCode,
    registry: isPublicRegistryObservationSnapshot, codexDoctor: (item) => shape(item, {
      conditions: (rows) => Array.isArray(rows) && rows.length > 0 && rows.length <= 2 &&
        rows.every(oneOf("split_brain", "orphaned", "attached", "observation_stale", "managed_layout_missing", "unknown")),
    }) })) return false;
  return (value.codexDoctor === undefined || value.provider === "codex") &&
    (value.registry === undefined || value.provider === "claude"); }
function isRouteSnapshot(value: unknown): value is PublicRouteSnapshot {
  if (!shape(value, { alias, provider: isGatewayProvider, host, enabled: (item) => typeof item === "boolean",
    state: oneOf("stale", "idle", "busy", "awaiting_approval", "offline", "disabled"),
    busyPolicy: oneOf("queue"), queueDepth: nonNegative, counters: isRouteCounters },
  { lastSeenAt: iso, oldestQueuedAt: iso, safeErrorCode: safeCode, mutable: (item) => typeof item === "boolean" })) return false;
  const row = value as unknown as PublicRouteSnapshot;
  return row.alias.endsWith(`@${row.host}`) &&
    (row.oldestQueuedAt === undefined ? row.queueDepth === 0 : row.queueDepth > 0); }
function compareConsentEndpoints(left: { alias: string; provider: string }, right: { alias: string; provider: string }): number {
  return gatewayProviders.indexOf(left.provider as (typeof gatewayProviders)[number]) -
    gatewayProviders.indexOf(right.provider as (typeof gatewayProviders)[number]) || left.alias.localeCompare(right.alias); }
function isConsentEdgeSnapshot(value: unknown): value is PublicConsentEdgeSnapshot {
  const endpoint = (item: unknown): item is { alias: string; provider: (typeof gatewayProviders)[number] } =>
    shape(item, { alias, provider: isGatewayProvider });
  if (!shape(value, { endpoints: (rows) => Array.isArray(rows) && rows.length === 2 && rows.every(endpoint),
    host, counters: isRouteCounters }, { mutable: (item) => typeof item === "boolean" })) return false;
  const [left, right] = value.endpoints as [{ alias: string; provider: string }, { alias: string; provider: string }];
  const hosts = [left.alias.slice(left.alias.lastIndexOf("@") + 1), right.alias.slice(right.alias.lastIndexOf("@") + 1)];
  return left.alias !== right.alias && compareConsentEndpoints(left, right) < 0 &&
    (left.provider !== right.provider || hosts[0] !== hosts[1]) && value.host === [...hosts].sort()[0]; }
function isAvailablePeerSnapshot(value: unknown): value is PublicAvailablePeerSnapshot {
  return shape(value, { alias, provider: oneOf("claude"), host,
    state: oneOf("idle", "busy", "awaiting_approval", "offline"),
    validated: (item) => typeof item === "boolean", selected: (item) => typeof item === "boolean" },
  { lastSeenAt: iso, safeErrorCode: safeCode }) &&
    (value.alias as string).endsWith(`@${String(value.host)}`); }
function isNormalizedMessageEvent(value: unknown): value is NormalizedMessageEvent {
  if (!shape(value, { sequence: nonNegative, timestamp: iso,
    messageIdSuffix: (item) => typeof item === "string" && MESSAGE_SUFFIX_PATTERN.test(item),
    direction: isMessageDirection, sourceAlias: alias, targetAlias: alias,
    state: oneOf("queued", "duplicate", "dispatching", "transport_written", "held", "delivered",
      "unconfirmed", "failed", "ambiguous", "expired", "cancelled", "abandoned", "rejected"),
    bytes: nonNegative },
  { conversationIdSuffix: (item) => typeof item === "string" && CONVERSATION_SUFFIX_PATTERN.test(item),
    body: (item) => typeof item === "string" && item.length > 0 && !item.includes("\0"),
    latencyMs: nonNegative, safeErrorCode: safeCode, steer: oneOf(true) })) return false;
  return value.body === undefined || Buffer.byteLength(value.body as string, "utf8") === value.bytes; }
function isAccounting(value: unknown): value is GatewayAccounting {
  const keys = ["accepted", "duplicates", "delivered", "unconfirmed", "failed", "ambiguous",
    "expired", "cancelled", "abandoned", "rejected", "bytesAccepted", "queuedBytes"];
  return isRecord(value) && exact(value, keys) && keys.every((key) => nonNegative(value[key])); }
function isSafeAlert(value: unknown): value is SafeGatewayAlert {
  return shape(value, { code: safeCode, severity: oneOf("info", "warning", "error"), timestamp: iso },
    { provider: isGatewayProvider, host, alias }); }
function isProgressWatchSnapshot(value: unknown): value is PublicProgressWatchSnapshot {
  return shape(value, {
    conversationIdSuffix: (item) => typeof item === "string" && CONVERSATION_SUFFIX_PATTERN.test(item),
    ownerAlias: alias, workerAlias: alias, lastActivityAt: iso, nextActionAt: iso,
    nudgeCount: oneOf(0, 1, 2),
  }) && value.ownerAlias !== value.workerAlias; }
function isProgressWatchEventSnapshot(value: unknown): value is PublicProgressWatchEventSnapshot {
  if (!shape(value, { sequence: nonNegative, timestamp: iso,
    conversationIdSuffix: (item) => typeof item === "string" && CONVERSATION_SUFFIX_PATTERN.test(item),
    ownerAlias: alias, workerAlias: alias, kind: oneOf("opened", "replaced", "settled"),
    actor: oneOf("owner", "worker", "operator", "gateway", "unknown") },
  { reason: oneOf("done", "untracked", "idle_timeout", "tracking_disabled", "endpoint_retired", "pair_removed") })) return false;
  if (value.kind === "opened") return value.actor === "owner" && value.reason === undefined;
  if (value.kind === "replaced") return (value.actor === "owner" || value.actor === "unknown") && value.reason === undefined;
  return (value.reason === "done" && (value.actor === "owner" || value.actor === "worker")) ||
    (value.reason === "untracked" && value.actor === "operator") ||
    ((value.reason === "idle_timeout" || value.reason === "tracking_disabled") && value.actor === "gateway") ||
    (value.reason === "endpoint_retired" && (value.actor === "gateway" || value.actor === "operator")) ||
    (value.reason === "pair_removed" && value.actor === "operator"); }
function isGatewayActivityEvent(value: unknown): value is PublicGatewayActivityEvent {
  if (!shape(value, { sequence: positive, timestamp: iso,
    kind: oneOf("discovery", "selection", "registration", "pairing", "watch"),
    action: oneOf("discovery_refreshed", "claude_selected", "claude_unselected", "codex_registered",
      "codex_succeeded", "codex_unregistered", "routes_paired", "routes_unpaired", "watch_ended"),
    outcome: oneOf("accepted", "rejected"), aliases: (rows) => arrayOf(rows, 2, alias),
    operatorAction: oneOf(true) }, { safeErrorCode: safeCode })) return false;
  const allowed: Record<string, readonly string[]> = {
    discovery: ["discovery_refreshed"], selection: ["claude_selected", "claude_unselected"],
    registration: ["codex_registered", "codex_succeeded", "codex_unregistered"],
    pairing: ["routes_paired", "routes_unpaired"], watch: ["watch_ended"],
  };
  return new Set(value.aliases as string[]).size === (value.aliases as string[]).length &&
    (allowed[value.kind as string]?.includes(value.action as string) ?? false); }
function isDeadlinePressure(value: unknown): value is DeadlinePressureSnapshot {
  const names = ["under_1m", "1m_to_5m", "5m_to_15m", "15m_to_60m", "over_60m"];
  if (!shape(value, { configuredDeadlineMs: positive, terminalEvents: nonNegative,
    expiredEvents: nonNegative, buckets: (rows) => Array.isArray(rows) && rows.length === names.length },
  { retainedSince: iso }) || Number(value.expiredEvents) > Number(value.terminalEvents)) return false;
  const rows = value.buckets as unknown[];
  if (!rows.every((row, index) => shape(row, { bucket: oneOf(names[index]), settled: nonNegative, expired: nonNegative }) &&
      (row.expired as number) <= (row.settled as number))) return false;
  return rows.reduce<number>((sum, row) => sum + Number((row as JsonRecord).settled), 0) === value.terminalEvents &&
    rows.reduce<number>((sum, row) => sum + Number((row as JsonRecord).expired), 0) === value.expiredEvents; }
function isSnapshotTruncation(value: unknown): boolean {
  const required = ["connectors", "availablePeers", "routes", "consentEdges", "messages", "alerts"];
  const optional = ["progressWatches", "progressWatchEvents", "activityEvents"];
  return isRecord(value) && exact(value, required, optional) &&
    [...required, ...optional].every((key) => value[key] === undefined || nonNegative(value[key])); }
export function isGatewaySnapshot(value: unknown): value is GatewaySnapshot {
  if (!shape(value, { schemaVersion: oneOf(2), generatedAt: iso, inboundMode: oneOf("paired", "open"),
    health: isConnectorHealth,
    connectors: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.connectors, isConnectorSnapshot),
    availablePeers: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.availablePeers, isAvailablePeerSnapshot),
    routes: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.routes, isRouteSnapshot),
    consentEdges: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.consentEdges, isConsentEdgeSnapshot),
    messages: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.messages, isNormalizedMessageEvent),
    accounting: isAccounting, alerts: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.alerts, isSafeAlert),
    truncation: isSnapshotTruncation },
  { progressWatches: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.progressWatches, isProgressWatchSnapshot),
    progressWatchEvents: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.progressWatchEvents, isProgressWatchEventSnapshot),
    activityEvents: (rows) => arrayOf(rows, gatewayPublicSnapshotLimits.activityEvents, isGatewayActivityEvent),
    deadlinePressure: isDeadlinePressure })) return false;
  const snapshot = value as unknown as GatewaySnapshot;
  const unique = (rows: readonly string[]) => new Set(rows).size === rows.length;
  const generated = Date.parse(snapshot.generatedAt);
  const connectorKeys = snapshot.connectors.map((row) => `${row.provider}@${row.host}`);
  const aliases = snapshot.routes.map((row) => row.alias);
  const peers = snapshot.availablePeers.map((row) => row.alias);
  const edgeKeys = snapshot.consentEdges.map((row) => `${row.endpoints[0].alias}\0${row.endpoints[1].alias}`);
  const routeByAlias = new Map(snapshot.routes.map((row) => [row.alias, row]));
  const honest = snapshot.connectors.every((row) => {
    const seen = row.lastSeenAt === undefined ? undefined : Date.parse(row.lastSeenAt);
    const age = seen === undefined ? undefined : Math.min(MAX_REVISION, Math.max(0, generated - seen));
    return (row.observationAgeMs === undefined || row.observationAgeMs === age) &&
      (row.health !== "healthy" || (age !== undefined && age <= CONNECTOR_OBSERVATION_STALE_AFTER_MS));
  });
  return honest && unique(connectorKeys) && unique(aliases) && unique(peers) && unique(edgeKeys) &&
    snapshot.consentEdges.every((edge) => edge.endpoints.every((endpoint) =>
      routeByAlias.get(endpoint.alias)?.provider === endpoint.provider)) &&
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET;
}
function isSnapshotObservation(value: unknown): value is GatewaySnapshotObservation {
  return shape(value, { snapshotRevision: nonNegative, snapshot: isGatewaySnapshot });
}

type Decoder = (value: unknown) => unknown;
type Descriptor = { handler: keyof GatewayControlHandlers; decode: Decoder; result: Check; mutation: boolean };
const descriptors = {
  health: { handler: "health", decode: emptyParams, result: isHealthResult, mutation: false }, register_codex: { handler: "registerCodex", decode: decodeRegister, result: isDecision, mutation: true },
  unregister_codex: { handler: "unregisterCodex", decode: decodeUnregister, result: isDecision, mutation: true },
  select_claude: { handler: "selectClaude", decode: decodeSelection, result: isDecision, mutation: true }, unselect_claude: { handler: "unselectClaude", decode: decodeSelection, result: isDecision, mutation: true },
  pair: { handler: "pair", decode: decodePair, result: isDecision, mutation: true }, unpair: { handler: "unpair", decode: decodePair, result: isDecision, mutation: true },
  list_snapshot: { handler: "listSnapshot", decode: emptyParams, result: isGatewaySnapshot, mutation: false }, observe_snapshot: { handler: "observeSnapshot", decode: emptyParams, result: isSnapshotObservation, mutation: false },
  delivery_status: { handler: "deliveryStatus", decode: decodeDeliveryStatus, result: isDeliveryStatusResult, mutation: false }, untrack: { handler: "untrack", decode: decodeUntrack, result: isDecision, mutation: false },
  send: { handler: "send", decode: decodeSend, result: isSendResult, mutation: true },
  reply: { handler: "reply", decode: decodeReply, result: isSendResult, mutation: true }, refresh_discovery: { handler: "refreshDiscovery", decode: emptyParams, result: isRefreshResult, mutation: false },
  peer_catalog: { handler: "peerCatalog", decode: decodePeerCatalog, result: isPeerCatalog, mutation: false },
  peer_handoff: { handler: "peerHandoff", decode: decodePeerHandoff, result: isPeerHandoffResult, mutation: true },
  register_peer: { handler: "registerPeer", decode: decodeRegisterPeer, result: isRegisterPeerResult, mutation: true },
  unregister_peer: { handler: "unregisterPeer", decode: decodePeerPrincipal, result: isDecision, mutation: true },
  await_peer: { handler: "awaitPeer", decode: decodePeerPrincipal, result: isPeerMailboxAwaitResult, mutation: false },
  peer_receipt: { handler: "peerReceipt", decode: decodePeerReceipt, result: isDecision, mutation: true },
} satisfies Record<GatewayControlMethod, Descriptor>;

function parseRequestObject(value: unknown): ValidatedGatewayControlRequest {
  if (!isRecord(value) || !exact(value, ["protocolVersion", "method", "params"])) invalid();
  if (value.protocolVersion !== GATEWAY_CONTROL_PROTOCOL_VERSION) throw new ProtocolFault("UNSUPPORTED_VERSION");
  if (typeof value.method !== "string" || !Object.hasOwn(descriptors, value.method))
    throw new ProtocolFault("UNKNOWN_METHOD");
  const method = value.method as GatewayControlMethod;
  return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method, params: descriptors[method].decode(value.params) } as ValidatedGatewayControlRequest;
}
function decodeJson(frame: Buffer, invalidCode: GatewayWireErrorCode): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); }
  catch { throw new ProtocolFault(invalidCode); } }
function errorResponse(code: GatewayWireErrorCode): GatewayControlErrorResponse {
  return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: false, error: { code, message: WIRE_ERROR_MESSAGES[code] } }; }
async function dispatch(
  request: ValidatedGatewayControlRequest, handlers: GatewayControlHandlers,
): Promise<GatewayControlResponse> {
  const descriptor = descriptors[request.method]; const handler = handlers[descriptor.handler] as unknown as (params?: unknown) => MaybePromise<unknown>;
  try {
    const result = await (Object.keys(request.params).length === 0 ? handler() : handler(request.params));
    return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result } as GatewayControlSuccessResponse;
  } catch { return errorResponse("HANDLER_FAILURE"); }
}
function serializeResponse(response: GatewayControlResponse): Buffer {
  try {
    const encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8"); return encoded.length <= GATEWAY_CONTROL_MAX_RESPONSE_BYTES ? encoded : Buffer.from(`${JSON.stringify(errorResponse("RESPONSE_TOO_LARGE"))}\n`);
  } catch { return Buffer.from(`${JSON.stringify(errorResponse("INVALID_HANDLER_RESPONSE"))}\n`); } }

type FrameFailure = "closed" | "error" | "timeout" | "too_large" | "multiple";
class FrameFault extends Error {
  constructor(readonly kind: FrameFailure, readonly systemCode?: string) { super(kind); }
}
function readOneFrame(socket: Socket, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0); let settled = false;
    const finish = (value: Buffer | FrameFault): void => {
      if (settled) return; settled = true; socket.pause();
      socket.off("data", onData); socket.off("end", onEnd); socket.off("timeout", onTimeout);
      value instanceof FrameFault ? reject(value) : resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      if (buffered.length + chunk.length > maximum) return finish(new FrameFault("too_large"));
      buffered = Buffer.concat([buffered, chunk]); const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      if (buffered.subarray(newline + 1).toString("utf8").trim().length > 0)
        return finish(new FrameFault("multiple"));
      finish(buffered.subarray(0, newline));
    };
    const onEnd = (): void => finish(new FrameFault("closed")); const onTimeout = (): void => finish(new FrameFault("timeout"));
    socket.on("data", onData); socket.once("end", onEnd); socket.once("timeout", onTimeout);
    socket.once("error", (error: NodeJS.ErrnoException) => finish(new FrameFault("error", error.code)));
  });
}
function respond(socket: Socket, response: GatewayControlResponse): void {
  if (!socket.destroyed) socket.end(serializeResponse(response)); }
function handleConnection(socket: Socket, handlers: GatewayControlHandlers, timeoutMs: number): void {
  socket.setTimeout(timeoutMs);
  void readOneFrame(socket, GATEWAY_CONTROL_MAX_FRAME_BYTES).then(async (frame) => {
    socket.setTimeout(0);
    let request: ValidatedGatewayControlRequest;
    try { request = parseRequestObject(decodeJson(frame, "INVALID_JSON")); }
    catch (error) {
      respond(socket, errorResponse(error instanceof ProtocolFault ? error.code : "INVALID_REQUEST"));
      return;
    }
    respond(socket, await dispatch(request, handlers));
  }, (error: unknown) => {
    const kind = error instanceof FrameFault ? error.kind : "error";
    if (kind === "too_large") respond(socket, errorResponse("FRAME_TOO_LARGE"));
    else if (kind === "multiple") respond(socket, errorResponse("MULTIPLE_FRAMES"));
    else if (kind === "timeout") respond(socket, errorResponse("REQUEST_TIMEOUT"));
    else socket.destroy();
  });
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

async function optionalLstat(target: string) {
  try { return await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; }
}

function assertSocketPath(socketPath: string): void {
  if (
    !path.isAbsolute(socketPath) ||
    path.resolve(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }
}

async function validateSocketLocation(
  stateDir: string,
  socketPath: string,
): Promise<void> {
  if (process.platform === "win32") {
    throw controlTransportError("UNSUPPORTED_PLATFORM");
  }
  assertSocketPath(socketPath);
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) {
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
    // Never broaden cleanup to a replacement path.
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

export async function startGatewayControlServer(
  options: StartGatewayControlServerOptions,
): Promise<GatewayControlServer> {
  await validateSocketLocation(options.stateDir, options.socketPath);
  await prepareSocketTarget(options.socketPath);
  const requestTimeoutMs =
    options.requestTimeoutMs ?? GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 50 ||
    requestTimeoutMs > 30_000
  ) {
    throw controlTransportError("INVALID_SOCKET_PATH");
  }

  const connections = new Set<Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
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
    for (const socket of connections) socket.destroy();
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
      for (const socket of connections) socket.destroy();
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

function decodeResponse<M extends GatewayControlMethod>(method: M, params: RequestParams[M], value: unknown): GatewayControlResponse<M> {
  if (!isRecord(value) || !Number.isSafeInteger(value.protocolVersion)) throw controlTransportError("CONTROL_INVALID_RESPONSE");
  if (value.protocolVersion !== GATEWAY_CONTROL_PROTOCOL_VERSION) throw controlTransportError("CONTROL_VERSION_MISMATCH");
  if (value.ok === false) {
    if (!shape(value, { protocolVersion: oneOf(GATEWAY_CONTROL_PROTOCOL_VERSION), ok: oneOf(false), error: (item) =>
      shape(item, { code: (code) => typeof code === "string" && Object.hasOwn(WIRE_ERROR_MESSAGES, code),
        message: (message) => typeof message === "string" }) }) ||
      !isRecord(value.error) || value.error.message !== WIRE_ERROR_MESSAGES[value.error.code as GatewayWireErrorCode])
      throw controlTransportError("CONTROL_INVALID_RESPONSE");
    return value as GatewayControlErrorResponse;
  }
  if (!shape(value, { protocolVersion: oneOf(GATEWAY_CONTROL_PROTOCOL_VERSION), ok: oneOf(true), result: descriptors[method].result }))
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  if (method === "register_peer" && isRecord(value.result) && value.result.accepted === true &&
      Object.hasOwn(params, "token") === Object.hasOwn(value.result, "token"))
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  if (method === "await_peer" && isRecord(value.result) && value.result.state === "message" &&
      (JSON.parse(value.result.frame as string) as { result: { toAlias: string } }).result.toAlias !==
        (params as PeerPrincipalParams).alias)
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  return value as GatewayControlSuccessResponse<M>;
}
export type SendGatewayControlRequestOptions<M extends GatewayControlMethod> = {
  socketPath: string; request: Extract<GatewayControlRequest, { method: M }>;
  timeoutMs?: number; maxResponseBytes?: number;
};
export async function sendGatewayControlRequest<M extends GatewayControlMethod>(
  options: SendGatewayControlRequestOptions<M>,
): Promise<GatewayControlResponse<M>> {
  assertSocketPath(options.socketPath);
  const timeout = options.timeoutMs ?? GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
  const maximum = options.maxResponseBytes ?? GATEWAY_CONTROL_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 90_000 ||
      !Number.isInteger(maximum) || maximum < 256 || maximum > GATEWAY_CONTROL_MAX_RESPONSE_BYTES)
    throw controlTransportError("CONTROL_INVALID_RESPONSE");
  const request = parseRequestObject(options.request);
  const frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (frame.length > GATEWAY_CONTROL_MAX_FRAME_BYTES) throw new ProtocolFault("FRAME_TOO_LARGE");
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false; let writeStarted = false;
    const mutation = descriptors[request.method].mutation;
    const fail = (error: Error): void => {
      if (settled) return; settled = true; socket.destroy();
      reject(mutation && writeStarted ? controlTransportError("CONTROL_OUTCOME_AMBIGUOUS", true) : error);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => { writeStarted = true; socket.write(frame); });
    void readOneFrame(socket, maximum).then((responseFrame) => {
      try {
        const response = decodeResponse(options.request.method, request.params as RequestParams[M], decodeJson(responseFrame, "INVALID_JSON"));
        if (!settled) { settled = true; socket.destroy(); resolve(response); }
      } catch (error) { fail(error instanceof GatewayControlTransportError
        ? error : controlTransportError("CONTROL_INVALID_RESPONSE")); }
    }, (error: unknown) => {
      const kind = error instanceof FrameFault ? error.kind : "error";
      const systemCode = !writeStarted && error instanceof FrameFault ? error.systemCode : undefined;
      const code = kind === "timeout" ? "CONTROL_TIMEOUT" :
        kind === "too_large" ? "CONTROL_RESPONSE_TOO_LARGE" :
          kind === "closed" ? "CONTROL_CONNECTION_CLOSED" :
            systemCode === "EPERM" || systemCode === "EACCES"
              ? "CONTROL_CONNECT_DENIED" : systemCode === "ENOENT"
                ? "CONTROL_SOCKET_MISSING" : systemCode === "ECONNREFUSED"
                  ? "CONTROL_LISTENER_UNAVAILABLE" : "CONTROL_CONNECT_FAILED";
      fail(controlTransportError(code));
    });
  });
}
