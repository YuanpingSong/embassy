import type { ClaudePeerInboundProgress } from "./claude-peer.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import type { GatewayAdapterDispatchResult } from "./service.js";
import { gatewayRegistrationIngressPrefixes, isGatewayProvider, type GatewayProvider, type LogicalRouteBinding } from "./types.js";

export const CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION = 1 as const;
export const CLAUDE_NATIVE_HELPER_MAX_IPC_BYTES = 128 * 1024;
export const CLAUDE_NATIVE_HELPER_MAX_REQUESTS = 64;
export const CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS = 5_000;

export type ClaudeNativeHelperRegistration = Readonly<{
  alias: string; sourceProvider: GatewayProvider; cwd: string;
}>;
export type ClaudeNativeHelperInitialization = Readonly<{
  protocolVersion: 1; type: "initialize"; requestId: string;
  runtime: AttestedClaudePeerRuntime; hostId: string;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number; registration: ClaudeNativeHelperRegistration;
}>;
export type ClaudeNativeHelperCommand =
  | Readonly<{ method: "prepare_dispatch"; binding: LogicalRouteBinding;
      authorization: "selected_route" | "native_reply"; stateRoot?: string;
      messageId: string; sourceAlias: string; sourceProvider: GatewayProvider;
      targetAlias: string; conversationId: string; text: string;
      expectsReply: boolean; deadlineAt: string }>
  | Readonly<{ method: "perform_dispatch" | "cancel_dispatch"; preparationId: string }>
  | Readonly<{ method: "update_inbound_status"; receiptHandle: string;
      status: "held" | "delivered" | "denied" | "expired"; diagnosticCode?: string }>
  | Readonly<{ method: "notify_inbound_progress"; receiptHandle: string;
      progress: ClaudePeerInboundProgress }>
  | Readonly<{ method: "release_inbound_receipt"; receiptHandle: string }>
  | Readonly<{ method: "update_status"; alias: string; status: "idle" | "busy" | "waiting" }>
  | Readonly<{ method: "unadvertise"; alias: string }>
  | Readonly<{ method: "close" }>;
export type ClaudeNativeHelperParentMessage = ClaudeNativeHelperInitialization | Readonly<{
  protocolVersion: 1; type: "request"; requestId: string; command: ClaudeNativeHelperCommand;
}>;
export type ClaudeNativeHelperEvent =
  | Readonly<{ event: "claude_message"; value: Readonly<{ routeHandle: string;
      sourceAlias: string; targetAlias: string; text: string; receiptHandle?: string }> }>
  | Readonly<{ event: "protocol_notice"; value: Readonly<{ code: string }> }>;
export type ClaudeNativeHelperResult =
  | Readonly<{ generation: string }>
  | Readonly<{ preparationId: string; frameBytes: number; sha256: string }>
  | GatewayAdapterDispatchResult | Readonly<{ released: boolean }> | Readonly<{ ok: true }>;
export type ClaudeNativeHelperChildMessage =
  | Readonly<{ protocolVersion: 1; type: "response"; requestId: string; ok: true;
      result: ClaudeNativeHelperResult }>
  | Readonly<{ protocolVersion: 1; type: "response"; requestId: string; ok: false;
      error: Readonly<{ code: string; recoverable: boolean }> }>
  | Readonly<{ protocolVersion: 1; type: "event"; value: ClaudeNativeHelperEvent }>;

const SAFE = /^[A-Z][A-Z0-9_]{0,95}$/;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION = /^conv_[A-Za-z0-9_-]{16,64}$/;
const PREPARATION = /^prep_[A-Za-z0-9_-]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STATES = ["delivered", "unconfirmed", "failed", "ambiguous", "expired", "cancelled"];
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4_096): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const source = (alias: unknown, provider: unknown): boolean => typeof alias === "string" && ALIAS.test(alias) &&
  isGatewayProvider(provider) && gatewayRegistrationIngressPrefixes[provider] !== undefined &&
  alias.startsWith(gatewayRegistrationIngressPrefixes[provider]!);
function exact(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(v, key)) &&
    Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
}
function route(v: unknown): v is LogicalRouteBinding {
  return rec(v) && exact(v, ["provider", "hostId", "routeHandle", "registrationId"]) &&
    v.provider === "claude" && typeof v.hostId === "string" && HOST.test(v.hostId) &&
    typeof v.routeHandle === "string" && UUID.test(v.routeHandle) && str(v.registrationId, 256);
}
function command(v: unknown): v is ClaudeNativeHelperCommand {
  if (!rec(v) || typeof v.method !== "string") return false;
  if (v.method === "close") return exact(v, ["method"]);
  if (v.method === "perform_dispatch" || v.method === "cancel_dispatch")
    return exact(v, ["method", "preparationId"]) && typeof v.preparationId === "string" && PREPARATION.test(v.preparationId);
  if (v.method === "prepare_dispatch") {
    const selected = v.authorization === "selected_route";
    return exact(v, ["method", "binding", "authorization", "messageId", "sourceAlias", "sourceProvider",
      "targetAlias", "conversationId", "text", "expectsReply", "deadlineAt"], ["stateRoot"]) &&
      route(v.binding) && (selected || v.authorization === "native_reply") && str(v.messageId, 256) &&
      source(v.sourceAlias, v.sourceProvider) &&
      typeof v.targetAlias === "string" && ALIAS.test(v.targetAlias) &&
      typeof v.conversationId === "string" && CONVERSATION.test(v.conversationId) &&
      typeof v.text === "string" && Buffer.byteLength(v.text) <= 16 * 1024 && typeof v.expectsReply === "boolean" &&
      typeof v.deadlineAt === "string" && Number.isFinite(Date.parse(v.deadlineAt)) &&
      (selected ? str(v.stateRoot) && v.stateRoot.startsWith("/") : v.stateRoot === undefined);
  }
  if (v.method === "update_inbound_status") return exact(v, ["method", "receiptHandle", "status"], ["diagnosticCode"]) &&
    str(v.receiptHandle, 256) && ["held", "delivered", "denied", "expired"].includes(String(v.status)) &&
    (v.diagnosticCode === undefined || typeof v.diagnosticCode === "string" && SAFE.test(v.diagnosticCode));
  if (v.method === "notify_inbound_progress") return exact(v, ["method", "receiptHandle", "progress"]) &&
    str(v.receiptHandle, 256) && rec(v.progress) && exact(v.progress, ["kind", "reason", "queuedForMs"]) &&
    v.progress.kind === "stall" && ["ROUTE_BUSY", "ROUTE_UNAVAILABLE", "AWAITING_EXTERNAL_APPROVAL"].includes(String(v.progress.reason)) &&
    Number.isSafeInteger(v.progress.queuedForMs) && Number(v.progress.queuedForMs) >= 0;
  if (v.method === "release_inbound_receipt") return exact(v, ["method", "receiptHandle"]) && str(v.receiptHandle, 256);
  if (v.method === "update_status") return exact(v, ["method", "alias", "status"]) && typeof v.alias === "string" &&
    ALIAS.test(v.alias) && ["idle", "busy", "waiting"].includes(String(v.status));
  return v.method === "unadvertise" && exact(v, ["method", "alias"]) && typeof v.alias === "string" && ALIAS.test(v.alias);
}
export function isClaudeNativeHelperParentMessage(v: unknown): v is ClaudeNativeHelperParentMessage {
  if (!rec(v) || v.protocolVersion !== 1 || typeof v.requestId !== "string" || !ID.test(v.requestId)) return false;
  if (v.type === "request") return exact(v, ["protocolVersion", "type", "requestId", "command"]) && command(v.command);
  if (v.type !== "initialize" || !exact(v, ["protocolVersion", "type", "requestId", "runtime", "hostId",
    "deliveryNotices", "maxPendingMessages", "registration"]) || !rec(v.runtime) || !rec(v.registration)) return false;
  return exact(v.runtime, ["sessionsDir", "socketDir"]) && str(v.runtime.sessionsDir) && v.runtime.sessionsDir.startsWith("/") &&
    str(v.runtime.socketDir) && v.runtime.socketDir.startsWith("/") && typeof v.hostId === "string" && HOST.test(v.hostId) &&
    ["merged", "verbose", "quiet"].includes(String(v.deliveryNotices)) &&
    Number.isSafeInteger(v.maxPendingMessages) && Number(v.maxPendingMessages) >= 1 && Number(v.maxPendingMessages) <= 4_096 &&
    exact(v.registration, ["alias", "sourceProvider", "cwd"]) && source(v.registration.alias, v.registration.sourceProvider) &&
    str(v.registration.cwd) && v.registration.cwd.startsWith("/");
}
function result(v: unknown): v is ClaudeNativeHelperResult {
  if (!rec(v)) return false;
  if (exact(v, ["ok"])) return v.ok === true;
  if (exact(v, ["released"])) return typeof v.released === "boolean";
  if (exact(v, ["generation"])) return str(v.generation, 64);
  if (exact(v, ["preparationId", "frameBytes", "sha256"])) return typeof v.preparationId === "string" &&
    PREPARATION.test(v.preparationId) && Number.isSafeInteger(v.frameBytes) && Number(v.frameBytes) > 0 &&
    Number(v.frameBytes) <= 1024 * 1024 + 1 && typeof v.sha256 === "string" && SHA256.test(v.sha256);
  return exact(v, ["state"], ["safeErrorCode", "replyText"]) && STATES.includes(String(v.state)) &&
    (v.safeErrorCode === undefined || typeof v.safeErrorCode === "string" && SAFE.test(v.safeErrorCode)) &&
    (v.replyText === undefined || typeof v.replyText === "string" && Buffer.byteLength(v.replyText) <= 64 * 1024);
}
export function isClaudeNativeHelperChildMessage(v: unknown): v is ClaudeNativeHelperChildMessage {
  if (!rec(v) || v.protocolVersion !== 1) return false;
  if (v.type === "response") return typeof v.requestId === "string" && ID.test(v.requestId) && typeof v.ok === "boolean" &&
    (v.ok ? exact(v, ["protocolVersion", "type", "requestId", "ok", "result"]) && result(v.result) :
      exact(v, ["protocolVersion", "type", "requestId", "ok", "error"]) && rec(v.error) &&
      exact(v.error, ["code", "recoverable"]) && typeof v.error.code === "string" && SAFE.test(v.error.code) && typeof v.error.recoverable === "boolean");
  if (v.type !== "event" || !exact(v, ["protocolVersion", "type", "value"]) || !rec(v.value) ||
    !exact(v.value, ["event", "value"]) || !rec(v.value.value)) return false;
  const value = v.value.value;
  if (v.value.event === "protocol_notice") return exact(value, ["code"]) && typeof value.code === "string" && SAFE.test(value.code);
  return v.value.event === "claude_message" && exact(value, ["routeHandle", "sourceAlias", "targetAlias", "text"], ["receiptHandle"]) &&
    typeof value.routeHandle === "string" && UUID.test(value.routeHandle) && typeof value.sourceAlias === "string" &&
    ALIAS.test(value.sourceAlias) && typeof value.targetAlias === "string" && ALIAS.test(value.targetAlias) &&
    typeof value.text === "string" && Buffer.byteLength(value.text) <= 16 * 1024 &&
    (value.receiptHandle === undefined || str(value.receiptHandle, 256));
}
export function assertClaudeNativeHelperIpcSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > CLAUDE_NATIVE_HELPER_MAX_IPC_BYTES) throw new RangeError("CLAUDE_NATIVE_HELPER_IPC_TOO_LARGE");
}
