import type { ClaudePeerInboundProgress } from "./claude-peer.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import type { DashboardLocale } from "./locale.js";
import type { GatewayAdapterDispatchResult } from "./service.js";
import {
  isGatewayProvider,
  type GatewayProvider,
  type LogicalRouteBinding,
} from "./types.js";

export const CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION = 1 as const;
// A valid raw 16 KiB dispatch can expand to nearly 96 KiB when JSON escapes
// control characters. Keep the private IPC frame bounded while carrying that
// exact reviewed raw-body maximum without changing the provider wire limit.
export const CLAUDE_NATIVE_HELPER_MAX_IPC_BYTES = 128 * 1024;
export const CLAUDE_NATIVE_HELPER_MAX_REQUESTS = 64;
export const CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS = 5_000;

export type ClaudeNativeHelperRegistration = Readonly<{
  alias: string;
  sourceProvider: GatewayProvider;
  cwd: string;
}>;

export type ClaudeNativeHelperInitialization = Readonly<{
  protocolVersion: 1;
  type: "initialize";
  requestId: string;
  runtime: AttestedClaudePeerRuntime;
  hostId: "this-mac";
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number;
  registration: ClaudeNativeHelperRegistration;
}>;

export type ClaudeNativeHelperCommand =
  | Readonly<{
      method: "authorize_route";
      alias: string;
      routeHandle: string;
      stateRoot: string;
    }>
  | Readonly<{
      method: "release_route";
      routeHandle: string;
    }>
  | Readonly<{
      method: "prepare_dispatch";
      binding: LogicalRouteBinding;
      authorization: "selected_route" | "native_reply";
      messageId: string;
      sourceAlias: string;
      sourceProvider: GatewayProvider;
      targetAlias: string;
      conversationId: string;
      text: string;
      expectsReply: boolean;
      deadlineAt: string;
      progressWatchActive?: true;
    }>
  | Readonly<{
      method: "perform_dispatch";
      preparationId: string;
    }>
  | Readonly<{
      method: "cancel_dispatch";
      preparationId: string;
    }>
  | Readonly<{
      method: "update_inbound_status";
      receiptHandle: string;
      status: "held" | "delivered" | "denied" | "expired";
      diagnosticCode?: string;
    }>
  | Readonly<{
      method: "notify_inbound_progress";
      receiptHandle: string;
      progress: ClaudePeerInboundProgress;
    }>
  | Readonly<{
      method: "release_inbound_receipt";
      receiptHandle: string;
    }>
  | Readonly<{
      method: "update_status";
      alias: string;
      status: "idle" | "busy" | "waiting";
    }>
  | Readonly<{
      method: "unadvertise";
      alias: string;
    }>
  | Readonly<{ method: "close" }>;

export type ClaudeNativeHelperRequest = Readonly<{
  protocolVersion: 1;
  type: "request";
  requestId: string;
  command: ClaudeNativeHelperCommand;
}>;

export type ClaudeNativeHelperParentMessage =
  | ClaudeNativeHelperInitialization
  | ClaudeNativeHelperRequest;

export type ClaudeNativeHelperEvent =
  | Readonly<{
      event: "claude_reply";
      value: Readonly<{
        routeHandle: string;
        text: string;
      }>;
    }>
  | Readonly<{
      event: "claude_message";
      value: Readonly<{
        routeHandle: string;
        sourceAlias: string;
        targetAlias: string;
        text: string;
        receiptHandle?: string;
      }>;
    }>
  | Readonly<{
      event: "protocol_notice";
      value: Readonly<{ code: string }>;
    }>;

export type ClaudeNativeHelperResult =
  | Readonly<{ generation: string }>
  | Readonly<{
      preparationId: string;
      frameBytes: number;
      sha256: string;
    }>
  | GatewayAdapterDispatchResult
  | Readonly<{ released: boolean }>
  | Readonly<{ ok: true }>;

export type ClaudeNativeHelperChildMessage =
  | Readonly<{
      protocolVersion: 1;
      type: "response";
      requestId: string;
      ok: true;
      result: ClaudeNativeHelperResult;
    }>
  | Readonly<{
      protocolVersion: 1;
      type: "response";
      requestId: string;
      ok: false;
      error: Readonly<{ code: string; recoverable: boolean }>;
    }>
  | Readonly<{
      protocolVersion: 1;
      type: "event";
      value: ClaudeNativeHelperEvent;
    }>;

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const GENERATION = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{16,64}$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREPARATION_ID = /^prep_[A-Za-z0-9_-]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function provider(value: unknown): value is GatewayProvider {
  return isGatewayProvider(value);
}

function binding(value: unknown): value is LogicalRouteBinding {
  return (
    record(value) &&
    exact(value, ["provider", "hostId", "routeHandle", "registrationId"]) &&
    provider(value.provider) &&
    value.hostId === "this-mac" &&
    typeof value.routeHandle === "string" &&
    ROUTE.test(value.routeHandle) &&
    boundedString(value.registrationId, 256)
  );
}

function registration(value: unknown): value is ClaudeNativeHelperRegistration {
  return (
    record(value) &&
    exact(value, ["alias", "sourceProvider", "cwd"]) &&
    typeof value.alias === "string" &&
    ALIAS.test(value.alias) &&
    provider(value.sourceProvider) &&
    typeof value.cwd === "string" &&
    value.cwd.startsWith("/") &&
    value.cwd.length <= 4_096 &&
    !value.cwd.includes("\0")
  );
}

function runtime(value: unknown): value is AttestedClaudePeerRuntime {
  return (
    record(value) &&
    exact(value, [
      "claudeExecutable",
      "claudeCodeVersion",
      "sessionsDir",
      "socketDir",
    ]) &&
    boundedString(value.claudeExecutable, 4_096) &&
    value.claudeExecutable.startsWith("/") &&
    boundedString(value.claudeCodeVersion, 64) &&
    boundedString(value.sessionsDir, 4_096) &&
    value.sessionsDir.startsWith("/") &&
    boundedString(value.socketDir, 4_096) &&
    value.socketDir.startsWith("/")
  );
}

function command(value: unknown): value is ClaudeNativeHelperCommand {
  if (!record(value) || typeof value.method !== "string") return false;
  switch (value.method) {
    case "close":
      return exact(value, ["method"]);
    case "authorize_route":
      return (
        exact(value, ["method", "alias", "routeHandle", "stateRoot"]) &&
        typeof value.alias === "string" &&
        ALIAS.test(value.alias) &&
        typeof value.routeHandle === "string" &&
        UUID.test(value.routeHandle) &&
        boundedString(value.stateRoot, 4_096) &&
        value.stateRoot.startsWith("/")
      );
    case "release_route":
      return (
        exact(value, ["method", "routeHandle"]) &&
        typeof value.routeHandle === "string" &&
        UUID.test(value.routeHandle)
      );
    case "prepare_dispatch":
      return (
        exact(
          value,
          [
            "method",
            "binding",
            "authorization",
            "messageId",
            "sourceAlias",
            "sourceProvider",
            "targetAlias",
            "conversationId",
            "text",
            "expectsReply",
            "deadlineAt",
          ],
          ["progressWatchActive"],
        ) &&
        binding(value.binding) &&
        (value.authorization === "selected_route" ||
          value.authorization === "native_reply") &&
        boundedString(value.messageId, 256) &&
        typeof value.sourceAlias === "string" &&
        ALIAS.test(value.sourceAlias) &&
        provider(value.sourceProvider) &&
        typeof value.targetAlias === "string" &&
        ALIAS.test(value.targetAlias) &&
        typeof value.conversationId === "string" &&
        CONVERSATION_ID.test(value.conversationId) &&
        typeof value.text === "string" &&
        Buffer.byteLength(value.text, "utf8") <= 16 * 1024 &&
        typeof value.expectsReply === "boolean" &&
        iso(value.deadlineAt) &&
        (value.progressWatchActive === undefined ||
          value.progressWatchActive === true)
      );
    case "perform_dispatch":
    case "cancel_dispatch":
      return (
        exact(value, ["method", "preparationId"]) &&
        typeof value.preparationId === "string" &&
        PREPARATION_ID.test(value.preparationId)
      );
    case "update_inbound_status":
      return (
        exact(
          value,
          ["method", "receiptHandle", "status"],
          ["diagnosticCode"],
        ) &&
        boundedString(value.receiptHandle, 256) &&
        ["held", "delivered", "denied", "expired"].includes(
          String(value.status),
        ) &&
        (value.diagnosticCode === undefined ||
          (typeof value.diagnosticCode === "string" &&
            SAFE_CODE.test(value.diagnosticCode)))
      );
    case "notify_inbound_progress":
      return (
        exact(value, ["method", "receiptHandle", "progress"]) &&
        boundedString(value.receiptHandle, 256) &&
        record(value.progress) &&
        exact(value.progress, ["kind", "reason", "queuedForMs"]) &&
        value.progress.kind === "stall" &&
        [
          "ROUTE_BUSY",
          "ROUTE_UNAVAILABLE",
          "AWAITING_EXTERNAL_APPROVAL",
        ].includes(String(value.progress.reason)) &&
        Number.isSafeInteger(value.progress.queuedForMs) &&
        Number(value.progress.queuedForMs) >= 0
      );
    case "release_inbound_receipt":
      return (
        exact(value, ["method", "receiptHandle"]) &&
        boundedString(value.receiptHandle, 256)
      );
    case "update_status":
      return (
        exact(value, ["method", "alias", "status"]) &&
        typeof value.alias === "string" &&
        ALIAS.test(value.alias) &&
        ["idle", "busy", "waiting"].includes(String(value.status))
      );
    case "unadvertise":
      return (
        exact(value, ["method", "alias"]) &&
        typeof value.alias === "string" &&
        ALIAS.test(value.alias)
      );
    default:
      return false;
  }
}

export function isClaudeNativeHelperParentMessage(
  value: unknown,
): value is ClaudeNativeHelperParentMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "initialize") {
    return (
      exact(value, [
        "protocolVersion",
        "type",
        "requestId",
        "runtime",
        "hostId",
        "locale",
        "deliveryNotices",
        "maxPendingMessages",
        "registration",
      ]) &&
      typeof value.requestId === "string" &&
      REQUEST_ID.test(value.requestId) &&
      runtime(value.runtime) &&
      value.hostId === "this-mac" &&
      (value.locale === "en" || value.locale === "zh-CN") &&
      ["merged", "verbose", "quiet"].includes(String(value.deliveryNotices)) &&
      Number.isSafeInteger(value.maxPendingMessages) &&
      Number(value.maxPendingMessages) >= 1 &&
      Number(value.maxPendingMessages) <= 4_096 &&
      registration(value.registration)
    );
  }
  return (
    value.type === "request" &&
    exact(value, ["protocolVersion", "type", "requestId", "command"]) &&
    typeof value.requestId === "string" &&
    REQUEST_ID.test(value.requestId) &&
    command(value.command)
  );
}

export function isClaudeNativeHelperChildMessage(
  value: unknown,
): value is ClaudeNativeHelperChildMessage {
  if (!record(value) || value.protocolVersion !== 1) return false;
  if (value.type === "event") {
    if (!exact(value, ["protocolVersion", "type", "value"]) || !record(value.value)) {
      return false;
    }
    const event = value.value;
    if (!exact(event, ["event", "value"]) || !record(event.value)) return false;
    if (event.event === "claude_reply") {
      return (
        exact(event.value, ["routeHandle", "text"]) &&
        typeof event.value.routeHandle === "string" &&
        UUID.test(event.value.routeHandle) &&
        typeof event.value.text === "string" &&
        Buffer.byteLength(event.value.text, "utf8") <= 16 * 1024
      );
    }
    if (event.event === "claude_message") {
      return (
        exact(
          event.value,
          ["routeHandle", "sourceAlias", "targetAlias", "text"],
          ["receiptHandle"],
        ) &&
        typeof event.value.routeHandle === "string" &&
        UUID.test(event.value.routeHandle) &&
        typeof event.value.sourceAlias === "string" &&
        ALIAS.test(event.value.sourceAlias) &&
        typeof event.value.targetAlias === "string" &&
        ALIAS.test(event.value.targetAlias) &&
        typeof event.value.text === "string" &&
        Buffer.byteLength(event.value.text, "utf8") <= 16 * 1024 &&
        (event.value.receiptHandle === undefined ||
          boundedString(event.value.receiptHandle, 256))
      );
    }
    return (
      event.event === "protocol_notice" &&
      exact(event.value, ["code"]) &&
      typeof event.value.code === "string" &&
      SAFE_CODE.test(event.value.code)
    );
  }
  if (
    value.type !== "response" ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) {
    return (
      exact(value, ["protocolVersion", "type", "requestId", "ok", "result"]) &&
      helperResult(value.result)
    );
  }
  return (
    exact(value, ["protocolVersion", "type", "requestId", "ok", "error"]) &&
    record(value.error) &&
    exact(value.error, ["code", "recoverable"]) &&
    typeof value.error.code === "string" &&
    SAFE_CODE.test(value.error.code) &&
    typeof value.error.recoverable === "boolean"
  );
}

function helperResult(value: unknown): value is ClaudeNativeHelperResult {
  if (!record(value)) return false;
  if (
    exact(value, ["generation"]) &&
    typeof value.generation === "string" &&
    GENERATION.test(value.generation)
  ) {
    return true;
  }
  if (exact(value, ["ok"]) && value.ok === true) return true;
  if (
    exact(value, ["preparationId", "frameBytes", "sha256"]) &&
    typeof value.preparationId === "string" &&
    PREPARATION_ID.test(value.preparationId) &&
    Number.isSafeInteger(value.frameBytes) &&
    Number(value.frameBytes) > 0 &&
    Number(value.frameBytes) <= 1024 * 1024 + 1 &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256)
  ) {
    return true;
  }
  if (exact(value, ["released"]) && typeof value.released === "boolean") {
    return true;
  }
  if (
    !exact(
      value,
      ["state"],
      ["safeErrorCode", "replyText"],
    ) ||
    ![
      "delivered",
      "unconfirmed",
      "failed",
      "ambiguous",
      "expired",
      "cancelled",
    ].includes(String(value.state)) ||
    (value.safeErrorCode !== undefined &&
      (typeof value.safeErrorCode !== "string" ||
        !SAFE_CODE.test(value.safeErrorCode))) ||
    (value.replyText !== undefined &&
      (typeof value.replyText !== "string" ||
        Buffer.byteLength(value.replyText, "utf8") > 64 * 1024))
  ) {
    return false;
  }
  return true;
}

export function assertClaudeNativeHelperIpcSize(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    CLAUDE_NATIVE_HELPER_MAX_IPC_BYTES
  ) {
    throw new RangeError("CLAUDE_NATIVE_HELPER_IPC_TOO_LARGE");
  }
}
