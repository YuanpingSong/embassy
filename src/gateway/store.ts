import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import type { GatewayConfig } from "./config.js";
import { deliveryStates, directionId, gatewayActivityActions, gatewayActivityKinds,
  gatewayProviders, gatewayPublicSnapshotLimits, gatewayRegistrationIngressPrefixes,
  parseDirection, projectGatewayPublicSnapshot, routeRegistrationModes } from "./types.js";
import type { AcceptMessageInput, AcceptMessageResult, AuthorizeMessageInput,
  AuthorizeMessageResult, DedupeRecord, DeliveryState, EnqueueMessageInput,
  EnqueueMessageResult, EnqueueNativeIngressInput, EnqueueNativeReplyInput,
  GatewayAccounting, GatewayConsentEdgeRecord, GatewayConsentEndpoint,
  GatewayLegacyMessageActivity, GatewayMessageRecord, GatewayMessageState,
  GatewayPersistedState, GatewayPreparedWriteEvidence, GatewayPrivateRouteInspection,
  GatewayPublicSnapshot, GatewayRouteRecord, GatewayRuntimeActivity,
  GatewayStoreDependencies, LogicalRouteBinding, MessageDirection, NormalizedMessageEvent,
  PublicConsentEdgeSnapshot, PublicGatewayActivityEvent, PublicRouteSnapshot,
  RegisterRouteInput, RemoveRouteAtomicResult, ReplaceCodexRegistrationAtomicInput,
  ReplaceCodexRegistrationAtomicResult, ReserveMessageResult, ResolvePrewriteAttemptInput,
  ResolvePrewriteAttemptResult, RouteCounters, SettleAttemptInput,
  SettleAttemptForShutdownInput, SettleAttemptForShutdownResult, SettleAttemptResult,
  SettleQueuedMessageForShutdownInput, SettleQueuedMessageForShutdownResult,
  TerminalDeliveryOutcome, TerminalMessageSettlement } from "./types.js";
const STATE_MARKER = ".agent-embassy-state";
const STATE_MARKER_CONTENT = "agent-embassy-state-v1\n";
const STATE_FILE = "gateway-state.json";
const CONTROLLER_LOCK = ".gateway-controller.lock";
const MAX_MARKER_FILE_BYTES = 128;
const MAX_LOCK_FILE_BYTES = 4 * 1024;
export const GATEWAY_MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETAINED_BODY_BYTES = 1 * 1024 * 1024;
const ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PRIVATE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MESSAGE_ID_PATTERN =
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const CONVERSATION_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// New/public tokens are exact 24-character handles. The wider private read
// bound keeps pre-release v3 artifacts written before that correction bootable.
const DELIVERY_TOKEN_PATTERN = /^dlv_[A-Za-z0-9_-]{24,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDERS = new Set<string>(gatewayProviders);
const REGISTRATION_MODES = new Set<string>(routeRegistrationModes);
class PostRenamePersistenceError extends BridgeError {
  constructor() {
    super(
      "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
      "The installed state commit could not be verified. The controller was disabled and requires recovery.",
    );
    this.name = "PostRenamePersistenceError";
  }
}
class CommitAndThrow {
  constructor(readonly error: BridgeError) {}
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[], optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 35 &&
    Number.isFinite(Date.parse(value))
  );
}
function isPrivateToken(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_TOKEN_PATTERN.test(value);
}
function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value);
}
function isProvider(value: unknown): boolean {
  return typeof value === "string" && PROVIDERS.has(value);
}
function isLogicalBinding(value: unknown): value is LogicalRouteBinding {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["provider", "hostId", "routeHandle", "registrationId"]) &&
    isProvider(value.provider) &&
    typeof value.hostId === "string" &&
    HOST_PATTERN.test(value.hostId) &&
    isPrivateToken(value.routeHandle) &&
    isPrivateToken(value.registrationId)
  );
}
function isCounters(value: unknown): value is RouteCounters {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["accepted", "delivered", "unconfirmed", "failed",
      "ambiguous", "expired", "cancelled", "abandoned", "rejected", "bytesAccepted"])
  ) {
    return false;
  }
  return Object.values(value).every(isNonNegativeInteger);
}
function isRoute(value: unknown): value is GatewayRouteRecord {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "alias",
      "binding",
      "registrationMode",
      "enabled",
      "busyPolicy",
      "registeredAt",
      "updatedAt",
      "counters",
    ]) &&
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    isLogicalBinding(value.binding) &&
    typeof value.registrationMode === "string" &&
    REGISTRATION_MODES.has(value.registrationMode) &&
    typeof value.enabled === "boolean" &&
    (value.busyPolicy === "queue" || value.busyPolicy === "refuse") &&
    isIsoTimestamp(value.registeredAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isCounters(value.counters)
  );
}
function isConsentEndpoint(value: unknown): value is GatewayConsentEndpoint {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["alias", "provider", "registrationId"]) &&
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    isProvider(value.provider) &&
    isPrivateToken(value.registrationId)
  );
}
function compareConsentEndpoints(
  left: GatewayConsentEndpoint, right: GatewayConsentEndpoint,
): number {
  const providerOrder =
    gatewayProviders.indexOf(left.provider) -
    gatewayProviders.indexOf(right.provider);
  return providerOrder !== 0 ? providerOrder : left.alias.localeCompare(right.alias);
}
function canonicalConsentEndpoints(
  left: GatewayRouteRecord, right: GatewayRouteRecord,
): readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] {
  const endpoints: [GatewayConsentEndpoint, GatewayConsentEndpoint] = [
    {
      alias: left.alias, provider: left.binding.provider,
      registrationId: left.binding.registrationId,
    },
    {
      alias: right.alias, provider: right.binding.provider,
      registrationId: right.binding.registrationId,
    },
  ];
  endpoints.sort(compareConsentEndpoints);
  return endpoints;
}
function consentKey(
  endpoints: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint],
): string {
  return endpoints
    .map((endpoint) =>
      [endpoint.provider, endpoint.alias, endpoint.registrationId].join("\0"),
    )
    .join("\0");
}
function sameConsent(
  left: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null,
  right: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return consentKey(left) === consentKey(right);
}
function isConsentEdge(value: unknown): value is GatewayConsentEdgeRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["endpoints", "createdAt", "updatedAt", "counters"]) ||
    !Array.isArray(value.endpoints) ||
    value.endpoints.length !== 2 ||
    !value.endpoints.every(isConsentEndpoint)
  ) {
    return false;
  }
  const endpoints = value.endpoints as unknown as readonly [
    GatewayConsentEndpoint,
    GatewayConsentEndpoint,
  ];
  return (
    compareConsentEndpoints(endpoints[0], endpoints[1]) < 0 &&
    endpoints[0].provider !== endpoints[1].provider &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isCounters(value.counters)
  );
}
function isPrepared(value: unknown): value is GatewayPreparedWriteEvidence {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["kind", "bodyBytes", "bodySha256", "frameBytes", "sha256"]) &&
    (value.kind === "claude_mailbox" ||
      value.kind === "codex_turn_start" ||
      value.kind === "codex_turn_steer" ||
      value.kind === "acp_prompt") &&
    isPositiveInteger(value.bodyBytes) &&
    typeof value.bodySha256 === "string" &&
    SHA256_PATTERN.test(value.bodySha256) &&
    isPositiveInteger(value.frameBytes) &&
    value.frameBytes >= value.bodyBytes &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256)
  );
}
function expectedPreparedKind(
  message: Pick<GatewayMessageRecord, "direction" | "steer">,
): GatewayPreparedWriteEvidence["kind"] {
  const target = parseDirection(message.direction)!.targetProvider;
  if (target === "claude") return "claude_mailbox";
  if (target === "codex") {
    return message.steer === true ? "codex_turn_steer" : "codex_turn_start";
  }
  return "acp_prompt";
}
function isAttemptAuthority(value: Record<string, unknown>): boolean {
  return (
    typeof value.attemptId === "string" &&
    isPrivateToken(value.attemptId) &&
    isPositiveInteger(value.attemptCount) &&
    typeof value.targetRegistrationId === "string" &&
    isPrivateToken(value.targetRegistrationId) &&
    (value.sourceRegistrationId === null ||
      isPrivateToken(value.sourceRegistrationId)) &&
    (value.consentEdge === null ||
      (Array.isArray(value.consentEdge) &&
        value.consentEdge.length === 2 &&
        value.consentEdge.every(isConsentEndpoint) &&
        compareConsentEndpoints(
          value.consentEdge[0] as GatewayConsentEndpoint,
          value.consentEdge[1] as GatewayConsentEndpoint,
        ) < 0))
  );
}
function isMessageState(value: unknown): value is GatewayMessageState {
  if (!isObject(value) || typeof value.phase !== "string") return false;
  if (value.phase === "queued") {
    return hasOnlyKeys(value, ["phase", "attemptCount"]) &&
      isNonNegativeInteger(value.attemptCount);
  }
  if (value.phase === "reserved") {
    return (
      hasOnlyKeys(value, ["phase", "attemptId", "attemptCount", "targetRegistrationId",
        "sourceRegistrationId", "consentEdge", "reservedAt"]) &&
      isAttemptAuthority(value) &&
      isIsoTimestamp(value.reservedAt)
    );
  }
  if (value.phase === "armed") {
    return (
      hasOnlyKeys(value, ["phase", "attemptId", "attemptCount", "targetRegistrationId",
        "sourceRegistrationId", "consentEdge", "armedAt", "prepared"]) &&
      isAttemptAuthority(value) &&
      isIsoTimestamp(value.armedAt) &&
      isPrepared(value.prepared)
    );
  }
  if (value.phase === "accepted") {
    return (
      hasOnlyKeys(value, ["phase", "attemptId", "attemptCount", "targetRegistrationId",
        "sourceRegistrationId", "consentEdge", "acceptedAt", "prepared", "lossOutcome"]) &&
      isAttemptAuthority(value) &&
      isIsoTimestamp(value.acceptedAt) &&
      isPrepared(value.prepared) &&
      (value.lossOutcome === "unconfirmed" || value.lossOutcome === "ambiguous")
    );
  }
  return (
    value.phase === "terminal" &&
    hasOnlyKeys(
      value,
      ["phase", "outcome", "terminalAt", "latencyMs"],
      ["safeErrorCode"],
    ) &&
    [
      "delivered",
      "unconfirmed",
      "failed",
      "ambiguous",
      "expired",
      "cancelled",
      "abandoned",
    ].includes(String(value.outcome)) &&
    isIsoTimestamp(value.terminalAt) &&
    isNonNegativeInteger(value.latencyMs) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}
function isMessage(value: unknown): value is GatewayMessageRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      ["sequence", "messageId", "messageIdSuffix", "direction", "sourceAlias",
        "targetAlias", "enqueuedAt", "deadlineAt", "bytes", "sourceRegistrationId",
        "targetRegistrationId", "consentEdge", "state"],
      ["conversationIdSuffix", "deliveryToken", "body", "pair", "transientTarget", "steer"],
    )
  ) {
    return false;
  }
  return (
    isPositiveInteger(value.sequence) &&
    typeof value.messageId === "string" &&
    MESSAGE_ID_PATTERN.test(value.messageId) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    value.messageIdSuffix ===
      value.messageId.replaceAll("-", "").slice(-8).toLowerCase() &&
    parseDirection(value.direction) !== undefined &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    isIsoTimestamp(value.enqueuedAt) &&
    isIsoTimestamp(value.deadlineAt) &&
    isPositiveInteger(value.bytes) &&
    (value.body === undefined ||
      (typeof value.body === "string" &&
        value.body.length > 0 &&
        !value.body.includes("\u0000") &&
        Buffer.byteLength(value.body, "utf8") === value.bytes)) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    (value.deliveryToken === undefined ||
      (typeof value.deliveryToken === "string" &&
        DELIVERY_TOKEN_PATTERN.test(value.deliveryToken))) &&
    (value.pair === undefined || value.pair === true) &&
    (value.transientTarget === undefined || value.transientTarget === true) &&
    (value.steer === undefined || value.steer === true) &&
    (value.sourceRegistrationId === null ||
      isPrivateToken(value.sourceRegistrationId)) &&
    (value.targetRegistrationId === null ||
      isPrivateToken(value.targetRegistrationId)) &&
    (value.consentEdge === null ||
      (Array.isArray(value.consentEdge) &&
        value.consentEdge.length === 2 &&
        value.consentEdge.every(isConsentEndpoint) &&
        compareConsentEndpoints(
          value.consentEdge[0] as GatewayConsentEndpoint,
          value.consentEdge[1] as GatewayConsentEndpoint,
        ) < 0)) &&
    isMessageState(value.state) &&
    (value.state.phase === "terminal" ||
      value.state.attemptCount <=
        1 +
          Math.max(
            0,
            Math.ceil(
              (Date.parse(value.deadlineAt as string) -
                Date.parse(value.enqueuedAt as string)) /
                500,
            ),
          )) &&
    (value.state.phase === "terminal" ||
      (value.targetRegistrationId !== null && value.body !== undefined))
  );
}
function isDedupe(value: unknown): value is DedupeRecord {
  return (
    isObject(value) &&
    hasOnlyKeys(
      value,
      ["fingerprint", "messageIdSuffix", "sourceAlias", "targetAlias", "direction",
        "firstSeenAt", "expiresAt"],
      ["conversationIdSuffix", "pair"],
    ) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.fingerprint) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    parseDirection(value.direction) !== undefined &&
    isIsoTimestamp(value.firstSeenAt) &&
    isIsoTimestamp(value.expiresAt) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    (value.pair === undefined || value.pair === true)
  );
}
function isAccounting(value: unknown): value is GatewayAccounting {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["accepted", "duplicates", "delivered", "unconfirmed", "failed",
      "ambiguous", "expired", "cancelled", "abandoned", "rejected", "bytesAccepted", "queuedBytes"]) &&
    Object.values(value).every(isNonNegativeInteger)
  );
}
function isNormalizedEvent(value: unknown): value is NormalizedMessageEvent {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      ["sequence", "timestamp", "messageIdSuffix", "direction", "sourceAlias",
        "targetAlias", "state", "bytes"],
      ["conversationIdSuffix", "body", "steer", "latencyMs", "safeErrorCode"],
    )
  ) {
    return false;
  }
  return (
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    parseDirection(value.direction) !== undefined &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    deliveryStates.includes(value.state as DeliveryState) &&
    isPositiveInteger(value.bytes) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    (value.body === undefined ||
      (typeof value.body === "string" &&
        value.body.length > 0 &&
        !value.body.includes("\u0000") &&
        Buffer.byteLength(value.body, "utf8") === value.bytes)) &&
    (value.steer === undefined || value.steer === true) &&
    (value.latencyMs === undefined || isNonNegativeInteger(value.latencyMs)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}
function isRuntimeActivity(value: unknown): value is GatewayRuntimeActivity {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["type", "event"]) ||
    value.type !== "activity" ||
    !isObject(value.event) ||
    !hasOnlyKeys(
      value.event,
      ["sequence", "timestamp", "kind", "action", "outcome", "aliases", "operatorAction"],
      ["safeErrorCode"],
    )
  ) {
    return false;
  }
  const event = value.event;
  return (
    isPositiveInteger(event.sequence) &&
    isIsoTimestamp(event.timestamp) &&
    gatewayActivityKinds.includes(
      event.kind as (typeof gatewayActivityKinds)[number],
    ) &&
    gatewayActivityActions.includes(
      event.action as (typeof gatewayActivityActions)[number],
    ) &&
    (event.outcome === "accepted" || event.outcome === "rejected") &&
    Array.isArray(event.aliases) &&
    event.aliases.length <= 2 &&
    event.aliases.every(
      (alias) => typeof alias === "string" && ALIAS_PATTERN.test(alias),
    ) &&
    typeof event.operatorAction === "boolean" &&
    (event.safeErrorCode === undefined || isSafeCode(event.safeErrorCode))
  );
}
function isLegacyActivity(value: unknown): value is GatewayLegacyMessageActivity {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["type", "event"]) &&
    value.type === "legacy_message" &&
    isNormalizedEvent(value.event)
  );
}
export function isGatewayPersistedStateV3(value: unknown): value is GatewayPersistedState {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "commit", "createdAt", "updatedAt", "eventSequence",
      "routes", "consentEdges", "messages", "dedupe", "rateBuckets", "activity", "accounting"]) ||
    value.schemaVersion !== 3 ||
    !isObject(value.commit) ||
    !hasOnlyKeys(value.commit, ["sequence", "id"]) ||
    !isNonNegativeInteger(value.commit.sequence) ||
    !isPrivateToken(value.commit.id) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isNonNegativeInteger(value.eventSequence) ||
    !Array.isArray(value.routes) ||
    !value.routes.every(isRoute) ||
    !Array.isArray(value.consentEdges) ||
    !value.consentEdges.every(isConsentEdge) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage) ||
    !Array.isArray(value.dedupe) ||
    !value.dedupe.every(isDedupe) ||
    !Array.isArray(value.rateBuckets) ||
    !value.rateBuckets.every((bucket) => isObject(bucket) &&
      hasOnlyKeys(bucket, ["sourceAlias", "windowStartedAt", "count"]) &&
      typeof bucket.sourceAlias === "string" && ALIAS_PATTERN.test(bucket.sourceAlias) &&
      isIsoTimestamp(bucket.windowStartedAt) && isNonNegativeInteger(bucket.count)) ||
    !Array.isArray(value.activity) ||
    !value.activity.every(
      (entry) => isLegacyActivity(entry) || isRuntimeActivity(entry),
    ) ||
    !isAccounting(value.accounting)
  ) {
    return false;
  }
  const state = value as unknown as GatewayPersistedState;
  const routesByAlias = new Map(state.routes.map((route) => [route.alias, route]));
  const registrationIds = state.routes.map((route) => route.binding.registrationId);
  const routeTargets = state.routes.map((route) =>
    [route.binding.provider, route.binding.hostId, route.binding.routeHandle].join("\0"));
  const edgeKeys = state.consentEdges.map((edge) => consentKey(edge.endpoints));
  const messages = state.messages;
  const activitySequences = state.activity.map((entry) => entry.event.sequence);
  const active = messages.filter((message) => message.state.phase !== "terminal");
  const queuedBytes = messages
    .filter((message) => message.state.phase === "queued")
    .reduce((total, message) => total + message.bytes, 0);
  const tokens = messages.flatMap((message) => message.deliveryToken ?? []);
  const attempts = messages.filter((message) =>
    message.state.phase !== "queued" && message.state.phase !== "terminal");
  const attemptIds = attempts.map((message) =>
    (message.state as Exclude<GatewayMessageState, { phase: "queued" } | { phase: "terminal" }>).attemptId);
  if (
    routesByAlias.size !== state.routes.length ||
    new Set(registrationIds).size !== registrationIds.length ||
    new Set(routeTargets).size !== routeTargets.length ||
    new Set(edgeKeys).size !== edgeKeys.length ||
    new Set(messages.map((message) => message.messageId)).size !== messages.length ||
    new Set(tokens).size !== tokens.length ||
    new Set(attemptIds).size !== attempts.length ||
    state.accounting.queuedBytes !== queuedBytes ||
    messages.some((message) => message.sequence > state.eventSequence) ||
    activitySequences.some((sequence) => sequence > state.eventSequence) ||
    new Set([...messages.map((message) => message.sequence), ...activitySequences]).size !==
      messages.length + activitySequences.length ||
    new Set(state.dedupe.map((entry) => entry.fingerprint)).size !== state.dedupe.length ||
    new Set(state.rateBuckets.map((entry) => entry.sourceAlias)).size !== state.rateBuckets.length
  ) {
    return false;
  }
  for (const message of messages) {
    const direction = parseDirection(message.direction)!;
    if (
      (message.pair === true) !== (message.consentEdge !== null) ||
      (message.sourceRegistrationId === null &&
        (direction.sourceProvider !== "claude" || message.pair === true)) ||
      (message.transientTarget === true &&
        (direction.targetProvider !== "claude" ||
          message.pair === true ||
          message.sourceRegistrationId === null))
    ) {
      return false;
    }
    if (message.consentEdge !== null) {
      const source = message.consentEdge.find((endpoint) => endpoint.alias === message.sourceAlias);
      const target = message.consentEdge.find((endpoint) => endpoint.alias === message.targetAlias);
      if (
        source?.provider !== direction.sourceProvider ||
        target?.provider !== direction.targetProvider ||
        source.registrationId !== message.sourceRegistrationId ||
        target.registrationId !== message.targetRegistrationId
      ) {
        return false;
      }
    }
  }
  for (const route of state.routes) {
    if (
      !route.alias.endsWith(`@${route.binding.hostId}`) ||
      (route.binding.provider === "claude"
        ? route.registrationMode !== "selected_live_peer"
        : route.registrationMode !== "explicit_opt_in")
    ) {
      return false;
    }
    const prefix = gatewayRegistrationIngressPrefixes[route.binding.provider];
    if (prefix !== undefined && !route.alias.startsWith(prefix)) return false;
  }
  for (const edge of state.consentEdges) {
    const [leftEndpoint, rightEndpoint] = edge.endpoints;
    const left = routesByAlias.get(leftEndpoint.alias);
    const right = routesByAlias.get(rightEndpoint.alias);
    if (
      left?.binding.registrationId !== leftEndpoint.registrationId ||
      right?.binding.registrationId !== rightEndpoint.registrationId ||
      left.binding.provider !== leftEndpoint.provider ||
      right.binding.provider !== rightEndpoint.provider ||
      left.binding.hostId !== right.binding.hostId
    ) {
      return false;
    }
  }
  for (const message of active) {
    const target = routesByAlias.get(message.targetAlias);
    const source = routesByAlias.get(message.sourceAlias);
    const direction = parseDirection(message.direction)!;
    if (
      message.targetRegistrationId === null ||
      (message.transientTarget !== true &&
        (target?.binding.registrationId !== message.targetRegistrationId ||
          target.binding.provider !== direction.targetProvider)) ||
      (message.transientTarget === true && direction.targetProvider !== "claude")
    ) {
      return false;
    }
    if (message.sourceRegistrationId !== null) {
      if (
        source?.binding.registrationId !== message.sourceRegistrationId ||
        source.binding.provider !== direction.sourceProvider ||
        (target !== undefined && source.binding.hostId !== target.binding.hostId)
      ) {
        return false;
      }
    } else if (
      direction.sourceProvider !== "claude" ||
      target === undefined ||
      aliasHost(message.sourceAlias) !== target.binding.hostId
    ) {
      return false;
    }
    if (message.transientTarget === true) {
      if (
        message.pair === true ||
        message.consentEdge !== null ||
        message.sourceRegistrationId === null ||
        source === undefined ||
        aliasHost(message.targetAlias) !== source.binding.hostId
      ) {
        return false;
      }
    }
    if (message.pair === true) {
      if (
        message.consentEdge === null ||
        source === undefined ||
        target === undefined ||
        !sameConsent(message.consentEdge, canonicalConsentEndpoints(source, target)) ||
        !state.consentEdges.some((edge) => sameConsent(edge.endpoints, message.consentEdge))
      ) {
        return false;
      }
    } else if (message.consentEdge !== null) {
      return false;
    }
    if (
      (message.state.phase === "reserved" ||
        message.state.phase === "armed" ||
        message.state.phase === "accepted") &&
      (message.state.sourceRegistrationId !== message.sourceRegistrationId ||
        message.state.targetRegistrationId !== message.targetRegistrationId ||
        !sameConsent(message.state.consentEdge, message.consentEdge))
    ) {
      return false;
    }
    if (
      (message.state.phase === "armed" ||
        message.state.phase === "accepted") &&
      (message.state.prepared.kind !== expectedPreparedKind(message) ||
        message.state.prepared.bodyBytes !== message.bytes ||
        message.state.prepared.bodySha256 !==
          createHash("sha256").update(message.body!, "utf8").digest("hex"))
    ) {
      return false;
    }
  }
  return true;
}
function emptyCounters(): RouteCounters {
  return {
    accepted: 0, delivered: 0,
    unconfirmed: 0, failed: 0,
    ambiguous: 0, expired: 0,
    cancelled: 0, abandoned: 0,
    rejected: 0, bytesAccepted: 0,
  };
}
function emptyAccounting(): GatewayAccounting {
  return {
    accepted: 0, duplicates: 0,
    delivered: 0, unconfirmed: 0,
    failed: 0, ambiguous: 0,
    expired: 0, cancelled: 0,
    abandoned: 0, rejected: 0,
    bytesAccepted: 0, queuedBytes: 0,
  };
}
function routeRecord(input: RegisterRouteInput, now: Date): GatewayRouteRecord {
  const timestamp = now.toISOString();
  return { alias: input.alias, binding: { ...input.binding }, registrationMode: input.registrationMode,
    enabled: true, busyPolicy: "queue", registeredAt: timestamp, updatedAt: timestamp, counters: emptyCounters() };
}
function terminalState(
  outcome: TerminalDeliveryOutcome, now: Date,
  enqueuedAt: string,
  safeErrorCode?: string,
): Extract<GatewayMessageState, { phase: "terminal" }> {
  return {
    phase: "terminal",
    outcome,
    terminalAt: now.toISOString(),
    latencyMs: Math.max(0, now.getTime() - Date.parse(enqueuedAt)),
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
  };
}
function sameBinding(left: LogicalRouteBinding, right: LogicalRouteBinding): boolean {
  return (
    left.provider === right.provider &&
    left.hostId === right.hostId &&
    left.routeHandle === right.routeHandle &&
    left.registrationId === right.registrationId
  );
}
function aliasHost(alias: string): string {
  return alias.slice(alias.lastIndexOf("@") + 1);
}
async function assertNoSymlinkComponents(candidate: string): Promise<void> {
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new BridgeError("UNSAFE_GATEWAY_STATE_DIRECTORY", "The gateway state path cannot contain symbolic links.");
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
async function canonicalFuturePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(cursor, parts[index]!);
    try {
      cursor = await realpath(next);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return path.join(cursor, ...parts.slice(index));
      }
      throw error;
    }
  }
  return cursor;
}
type ConsentEdgeInput = Readonly<{
  aliases: readonly [string, string];   expectedRegistrationIds: readonly [string, string];
}>;
export class GatewayStore {
  readonly config: GatewayConfig;
  rootDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly afterStateFileRename:
    | (() => void | Promise<void>)
    | undefined;
  private readonly renameStateFile: (source: string, target: string) => Promise<void>;
  private readonly mutex = new KeyedMutex();
  private state: GatewayPersistedState | undefined;
  private lockHandle: FileHandle | undefined;
  private lockToken: string | undefined;
  private persistenceDeferred = false;
  constructor(config: GatewayConfig, dependencies: GatewayStoreDependencies = {}) {
    this.config = config;
    this.rootDir = path.resolve(config.stateDir);
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.renameStateFile = dependencies.renameStateFile ?? rename;
    this.afterStateFileRename = dependencies.afterStateFileRename;
  }
  get stateFilePath(): string {
    return path.join(this.rootDir, STATE_FILE);
  }
  async initialize(
    options: Readonly<{ deferPersistence?: boolean }> = {},
  ): Promise<void> {
    await this.mutex.run("gateway", async () => {
      if (this.state !== undefined) return;
      this.rootDir = await this.prepareOwnedDirectory();
      await this.acquireLock();
      try {
        const now = this.now();
        const loaded = await this.loadStateFile();
        this.state = loaded ?? {
          schemaVersion: 3,
          commit: { sequence: 0, id: this.randomId() },
          createdAt: now.toISOString(), updatedAt: now.toISOString(),
          eventSequence: 0, routes: [],
          consentEdges: [], messages: [],
          dedupe: [], rateBuckets: [],
          activity: [], accounting: emptyAccounting(),
        };
        this.assertConfiguredBounds(this.state);
        this.recoverAfterRestart(now);
        this.prune(this.state, now);
        if (loaded !== undefined) {
          this.state.commit = {
            sequence: this.state.commit.sequence + 1, id: this.randomId(),
          };
          this.state.updatedAt = now.toISOString();
        }
        this.persistenceDeferred = options.deferPersistence === true;
        if (!this.persistenceDeferred) await this.persist();
      } catch (error) {
        this.state = undefined;
        this.persistenceDeferred = false;
        await this.releaseControllerLock();
        throw error;
      }
    });
  }
  async commitInitialization(): Promise<void> {
    await this.mutex.run("gateway", async () => {
      this.requireState();
      if (!this.persistenceDeferred) return;
      await this.persist(true);
      this.persistenceDeferred = false;
    });
  }
  async close(): Promise<void> {
    await this.mutex.run("gateway", async () => {
      this.state = undefined;
      this.persistenceDeferred = false;
      await this.releaseControllerLock();
    });
  }
  async inspectPrivateRoutes(): Promise<GatewayPrivateRouteInspection[]> {
    return this.read((state) =>
      state.routes.map((route) => ({
        alias: route.alias, binding: { ...route.binding },
        registrationMode: route.registrationMode, enabled: route.enabled,
      })),
    );
  }
  async listLogicalRoutes(): Promise<GatewayPrivateRouteInspection[]> {
    return this.inspectPrivateRoutes();
  }
  async inspectPrivateRoute(
    alias: string,
  ): Promise<GatewayPrivateRouteInspection | undefined> {
    return this.read((state) => {
      const route = state.routes.find((candidate) => candidate.alias === alias);
      return route === undefined
        ? undefined
        : {
            alias: route.alias, binding: { ...route.binding },
            registrationMode: route.registrationMode, enabled: route.enabled,
          };
    });
  }
  async registerRoute(input: RegisterRouteInput): Promise<void> {
    await this.mutate((state, now) => {
      this.validateRouteInput(input);
      const byAlias = state.routes.find((route) => route.alias === input.alias);
      if (byAlias !== undefined) {
        if (
          sameBinding(byAlias.binding, input.binding) &&
          byAlias.registrationMode === input.registrationMode
        ) {
          byAlias.enabled = true;
          byAlias.updatedAt = now.toISOString();
          return;
        }
        throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "The route alias already belongs to another logical registration.");
      }
      if (
        state.routes.some(
          (route) =>
            route.binding.registrationId === input.binding.registrationId ||
            (route.binding.provider === input.binding.provider &&
              route.binding.hostId === input.binding.hostId &&
              route.binding.routeHandle === input.binding.routeHandle),
        )
      ) {
        throw new BridgeError("ROUTE_IDENTITY_ALREADY_REGISTERED", "The logical provider identity is already registered under another alias.");
      }
      if (state.routes.length >= this.config.limits.maxRoutes) {
        throw new BridgeError("ROUTE_CAPACITY_REACHED", "The bounded logical route inventory is full.", true);
      }
      state.routes.push(routeRecord(input, now));
    });
  }
  async removeOwnedRouteAtomic(
    input: Readonly<{
      alias: string;
      binding: LogicalRouteBinding;
      activity?: Readonly<{ operatorAction: boolean }>;
    }>,
  ): Promise<RemoveRouteAtomicResult> {
    return this.mutate((state, now) => {
      if (!ALIAS_PATTERN.test(input.alias) || !isLogicalBinding(input.binding)) {
        throw new BridgeError("INVALID_ROUTE_BINDING", "The exact-owned route cleanup authority is malformed.");
      }
      const route = state.routes.find((candidate) => candidate.alias === input.alias);
      if (route === undefined || !sameBinding(route.binding, input.binding)) {
        return { removed: false, settlements: [] };
      }
      if (
        input.activity !== undefined &&
        route.binding.provider !== "codex" &&
        route.binding.provider !== "claude"
      ) {
        throw new BridgeError("INVALID_ROUTE_BINDING", "Only exact Codex unregister or Claude unselection has public activity.");
      }
      const settlements = this.terminalizeRegistration(
        state,
        route.binding.registrationId,
        now,
      );
      this.removeRegistrationMetadata(state, route);
      if (input.activity !== undefined) {
        this.appendRuntimeActivity(state, now, {
          kind:
            route.binding.provider === "claude" ? "selection" : "registration",
          action:
            route.binding.provider === "claude"
              ? "claude_unselected"
              : "codex_unregistered",
          outcome: "accepted", aliases: [route.alias],
          operatorAction: input.activity.operatorAction,
        });
      }
      return { removed: true, settlements };
    });
  }
  async replaceCodexRegistrationAtomic(
    input: ReplaceCodexRegistrationAtomicInput,
  ): Promise<ReplaceCodexRegistrationAtomicResult> {
    return this.mutate((state, now) => {
      this.validateRouteInput(input.replacement);
      if (!isPrivateToken(input.expectedOldRegistrationId)) {
        throw new BridgeError("INVALID_ROUTE_BINDING", "The expected succeeded registration identity is malformed.");
      }
      if (input.replacement.binding.provider !== "codex") {
        throw new BridgeError("CODEX_SUCCESSION_OWNER_MISMATCH", "Only a Codex logical registration can succeed another Codex registration.");
      }
      const oldRoute = state.routes.find((route) => route.alias === input.oldAlias);
      const installed = state.routes.find(
        (route) => route.alias === input.replacement.alias,
      );
      if (oldRoute === undefined) {
        if (
          installed !== undefined &&
          sameBinding(installed.binding, input.replacement.binding) &&
          installed.registrationMode === input.replacement.registrationMode
        ) {
          return {
            replaced: true, idempotent: true,
            settlements: [],
          };
        }
        throw new BridgeError("CODEX_SUCCESSION_OWNER_MISMATCH", "The succeeded Codex registration is no longer installed.");
      }
      if (
        oldRoute.binding.registrationId !== input.expectedOldRegistrationId
      ) {
        throw new BridgeError("ROUTE_UNREGISTERED", "The succeeded Codex registration is no longer the expected owner.");
      }
      if (
        oldRoute.binding.provider !== "codex" ||
        installed !== undefined ||
        oldRoute.binding.hostId !== input.replacement.binding.hostId ||
        oldRoute.alias === input.replacement.alias ||
        oldRoute.binding.registrationId ===
          input.replacement.binding.registrationId ||
        oldRoute.binding.routeHandle === input.replacement.binding.routeHandle
      ) {
        throw new BridgeError("CODEX_SUCCESSION_OWNER_MISMATCH", "The successor must be a distinct Codex task and alias on the same host.");
      }
      const collision = state.routes.some(
        (route) =>
          route !== oldRoute &&
          (route.binding.registrationId ===
            input.replacement.binding.registrationId ||
            (route.binding.provider === "codex" &&
              route.binding.hostId === input.replacement.binding.hostId &&
              route.binding.routeHandle === input.replacement.binding.routeHandle)),
      );
      if (collision) {
        throw new BridgeError("CODEX_SUCCESSION_OWNER_MISMATCH", "The successor logical identity is already registered.");
      }
      const settlements = this.terminalizeRegistration(
        state,
        oldRoute.binding.registrationId,
        now,
      );
      this.removeRegistrationMetadata(state, oldRoute);
      state.routes.push(routeRecord(input.replacement, now));
      this.appendRuntimeActivity(state, now, {
        kind: "registration", action: "codex_succeeded",
        outcome: "accepted",
        aliases: [oldRoute.alias, input.replacement.alias],
        operatorAction: input.activity.operatorAction,
      });
      return { replaced: true, idempotent: false, settlements };
    });
  }
  async replaceClaudeSelection(
    replacement: RegisterRouteInput,
  ): Promise<Readonly<{ settlements: readonly TerminalMessageSettlement[] }>> {
    return this.mutate((state, now) => {
      this.validateRouteInput(replacement);
      if (replacement.binding.provider !== "claude") {
        throw new BridgeError("INVALID_ROUTE_BINDING", "Claude selection replacement requires a Claude logical route.");
      }
      const byAlias = state.routes.find(
        (route) => route.alias === replacement.alias,
      );
      const byRegistration = state.routes.find(
        (route) =>
          route.binding.registrationId === replacement.binding.registrationId,
      );
      const byTarget = state.routes.find(
        (route) =>
          route.binding.provider === "claude" &&
          route.binding.hostId === replacement.binding.hostId &&
          route.binding.routeHandle === replacement.binding.routeHandle,
      );
      if (
        (byRegistration === undefined) !== (byTarget === undefined) ||
        (byRegistration !== undefined && byRegistration !== byTarget)
      ) {
        throw new BridgeError("ROUTE_IDENTITY_ALREADY_REGISTERED", "The Claude registration ID and native target do not identify one route.");
      }
      const byIdentity = byRegistration;
      if (
        byAlias !== undefined &&
        byIdentity !== undefined &&
        byAlias !== byIdentity
      ) {
        throw new BridgeError("ROUTE_IDENTITY_ALREADY_REGISTERED", "The Claude alias and logical identity belong to distinct selections.");
      }
      const current = byIdentity ?? byAlias;
      if (current === undefined) {
        if (state.routes.length >= this.config.limits.maxRoutes) {
          throw new BridgeError("ROUTE_CAPACITY_REACHED", "The bounded logical route inventory is full.", true);
        }
        state.routes.push(routeRecord(replacement, now));
        return { settlements: [] };
      }
      if (
        current.binding.routeHandle === replacement.binding.routeHandle &&
        current.binding.registrationId === replacement.binding.registrationId
      ) {
        this.renameRegistrationCoordinates(
          state,
          current.alias,
          replacement.alias,
          current.binding.registrationId,
        );
        current.alias = replacement.alias;
        current.enabled = true;
        current.updatedAt = now.toISOString();
        return { settlements: [] };
      }
      const settlements = this.terminalizeRegistration(
        state,
        current.binding.registrationId,
        now,
      );
      this.removeRegistrationMetadata(state, current);
      state.routes.push(routeRecord(replacement, now));
      return { settlements };
    });
  }
  async hasConsentEdge(input: ConsentEdgeInput): Promise<boolean> {
    return this.read((state) => {
      const pair = this.resolvePair(
        state,
        input.aliases,
        false,
        input.expectedRegistrationIds,
      );
      return (
        pair !== undefined &&
        state.consentEdges.some((edge) =>
          sameConsent(edge.endpoints, pair.endpoints),
        )
      );
    });
  }
  async addConsentEdge(input: ConsentEdgeInput): Promise<void> {
    await this.mutate((state, now) => {
      const pair = this.resolvePair(
        state,
        input.aliases,
        true,
        input.expectedRegistrationIds,
      )!;
      if (
        state.consentEdges.some((edge) =>
          sameConsent(edge.endpoints, pair.endpoints),
        )
      ) {
        return;
      }
      if (state.consentEdges.length >= this.config.limits.maxConsentEdges) {
        throw new BridgeError("CONSENT_EDGE_CAPACITY_REACHED", "The bounded consent-edge inventory is full.", true);
      }
      state.consentEdges.push({
        endpoints: pair.endpoints, createdAt: now.toISOString(),
        updatedAt: now.toISOString(), counters: emptyCounters(),
      });
    });
  }
  async removeConsentEdge(
    input: ConsentEdgeInput,
  ): Promise<Readonly<{
    settlements: readonly TerminalMessageSettlement[];
    unreferencedAliases: readonly string[];
  }>> {
    return this.mutate((state, now) => {
      const pair = this.resolvePair(
        state,
        input.aliases,
        false,
        input.expectedRegistrationIds,
      );
      if (pair === undefined) {
        return { settlements: [], unreferencedAliases: [] };
      }
      const index = state.consentEdges.findIndex((edge) =>
        sameConsent(edge.endpoints, pair.endpoints),
      );
      if (index < 0) return { settlements: [], unreferencedAliases: [] };
      const edge = state.consentEdges[index]!;
      const settlements: TerminalMessageSettlement[] = [];
      for (const message of state.messages) {
        if (
          message.state.phase === "terminal" ||
          !sameConsent(message.consentEdge, edge.endpoints)
        ) {
          continue;
        }
        const outcome =
          message.state.phase === "armed"
            ? "ambiguous"
            : message.state.phase === "accepted"
              ? message.state.lossOutcome
              : "cancelled";
        settlements.push(
          this.finishMessage(
            state,
            message,
            outcome,
            now,
            outcome === "ambiguous"
              ? "DISPATCH_OUTCOME_AMBIGUOUS"
              : outcome === "unconfirmed"
                ? "DELIVERY_UNCONFIRMED"
                : "SENDER_NOT_PAIRED",
          ),
        );
      }
      state.consentEdges.splice(index, 1);
      return {
        settlements,
        unreferencedAliases: edge.endpoints
          .map((endpoint) => endpoint.alias)
          .filter(
            (alias) =>
              !state.consentEdges.some((candidate) =>
                candidate.endpoints.some((endpoint) => endpoint.alias === alias),
              ),
          ),
      };
    });
  }
  async enqueueMessage(
    input: EnqueueMessageInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate((state, now) => {
      const hasExpectedSource = input.expectedSourceRegistrationId !== undefined;
      const hasExpectedTarget = input.expectedTargetRegistrationId !== undefined;
      if (
        hasExpectedSource !== hasExpectedTarget ||
        (hasExpectedSource &&
          (!isPrivateToken(input.expectedSourceRegistrationId) ||
            !isPrivateToken(input.expectedTargetRegistrationId)))
      ) {
        throw new BridgeError("INVALID_GATEWAY_MESSAGE", "Expected source and target registrations must be supplied together.");
      }
      const source = this.requireRoute(state, input.sourceAlias);
      const target = this.requireRoute(state, input.targetAlias);
      if (
        hasExpectedSource &&
        (source.binding.registrationId !== input.expectedSourceRegistrationId ||
          target.binding.registrationId !== input.expectedTargetRegistrationId)
      ) {
        throw new BridgeError("ROUTE_UNREGISTERED", "The correlated source or target registration is no longer installed.");
      }
      const edge = this.requireConsent(state, source, target);
      return this.enqueueResolved(state, now, input, {
        sourceAlias: source.alias, targetAlias: target.alias,
        direction: directionId(source.binding.provider, target.binding.provider),
        sourceRegistrationId: source.binding.registrationId, targetRegistrationId: target.binding.registrationId,
        consentEdge: edge.endpoints, pair: true,
        exposeDeliveryToken: true,
      });
    });
  }
  async enqueueNativeIngress(
    input: EnqueueNativeIngressInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate((state, now) => {
      if (
        !ALIAS_PATTERN.test(input.targetAlias) ||
        !isPrivateToken(input.expectedTargetRegistrationId)
      ) {
        throw new BridgeError("INVALID_ROUTE_BINDING", "The native ingress target authority is malformed.");
      }
      const target = state.routes.find(
        (route) => route.alias === input.targetAlias && route.enabled,
      );
      if (
        target === undefined ||
        target.binding.registrationId !== input.expectedTargetRegistrationId
      ) {
        throw new BridgeError("ROUTE_UNREGISTERED", "The native ingress target registration is no longer current.");
      }
      if (
        input.source.binding.provider !== "claude" ||
        input.source.binding.hostId !== target.binding.hostId ||
        input.source.alias.endsWith(`@${target.binding.hostId}`) === false
      ) {
        throw new BridgeError("INVALID_NATIVE_PEER", "The native Claude sender does not match the target host.");
      }
      const selected = state.routes.find(
        (route) =>
          route.alias === input.source.alias &&
          route.binding.provider === "claude" &&
          route.binding.routeHandle === input.source.binding.routeHandle &&
          route.binding.registrationId === input.source.binding.registrationId,
      );
      const edge =
        selected === undefined
          ? undefined
          : state.consentEdges.find((candidate) =>
              sameConsent(
                candidate.endpoints,
                canonicalConsentEndpoints(selected, target),
              ),
            );
      if (this.config.inboundMode === "paired" && edge === undefined) {
        this.recordRejection(
          state,
          {
            sourceAlias: input.source.alias, targetAlias: target.alias,
            direction: directionId("claude", target.binding.provider),
            sourceRegistrationId: selected?.binding.registrationId ?? null, targetRegistrationId: target.binding.registrationId,
            consentEdge: null,
          },
          Buffer.byteLength(input.body, "utf8"),
          now,
          "SENDER_NOT_PAIRED",
          input,
        );
        throw new CommitAndThrow(
          new BridgeError(
            "SENDER_NOT_PAIRED",
            "The native Claude sender lacks exact durable consent.",
          ),
        );
      }
      return this.enqueueResolved(state, now, input, {
        sourceAlias: input.source.alias, targetAlias: target.alias,
        direction: directionId("claude", target.binding.provider),
        sourceRegistrationId:
          selected?.binding.registrationId ?? null,
        targetRegistrationId: target.binding.registrationId, consentEdge: edge?.endpoints ?? null,
        ...(edge === undefined ? {} : { pair: true as const }),
        exposeDeliveryToken: false,
      });
    });
  }
  async enqueueNativeReply(
    input: EnqueueNativeReplyInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate((state, now) => {
      if (
        !ALIAS_PATTERN.test(input.sourceAlias) ||
        !isPrivateToken(input.expectedSourceRegistrationId)
      ) {
        throw new BridgeError("INVALID_ROUTE_BINDING", "The native reply source authority is malformed.");
      }
      const source = state.routes.find(
        (route) => route.alias === input.sourceAlias && route.enabled,
      );
      if (
        source === undefined ||
        source.binding.registrationId !== input.expectedSourceRegistrationId
      ) {
        throw new BridgeError("ROUTE_UNREGISTERED", "The native reply source registration is no longer current.");
      }
      if (
        !isLogicalBinding(input.target.binding) ||
        input.target.binding.provider !== "claude" ||
        input.target.binding.hostId !== source.binding.hostId ||
        !input.target.alias.endsWith(`@${source.binding.hostId}`)
      ) {
        throw new BridgeError("INVALID_NATIVE_PEER", "The native Claude reply target does not match the source host.");
      }
      const selectedTarget = state.routes.find(
        (route) =>
          route.alias === input.target.alias &&
          route.binding.provider === "claude" &&
          route.binding.routeHandle === input.target.binding.routeHandle &&
          route.binding.registrationId === input.target.binding.registrationId,
      );
      let edge: GatewayConsentEdgeRecord | undefined;
      if (input.pair === true) {
        if (selectedTarget === undefined) {
          throw new BridgeError("SENDER_NOT_PAIRED", "The reply no longer matches an exact selected Claude route.");
        }
        edge = this.requireConsent(state, source, selectedTarget);
      }
      return this.enqueueResolved(state, now, input, {
        sourceAlias: source.alias, targetAlias: input.target.alias,
        direction: directionId(source.binding.provider, "claude"),
        sourceRegistrationId: source.binding.registrationId,
        targetRegistrationId:
          selectedTarget?.binding.registrationId ?? input.target.binding.registrationId,
        consentEdge: edge?.endpoints ?? null,
        ...(edge === undefined ? { transientTarget: true as const } : { pair: true as const }),
        exposeDeliveryToken: input.exposeDeliveryToken === true,
      });
    });
  }
  async inspectDispatchableTargets(): Promise<string[]> {
    return this.read((state) =>
      [...new Set(
        state.messages
          .filter((message) => message.state.phase === "queued")
          .map((message) => message.targetAlias),
      )],
    );
  }
  async nextDeadlineAt(): Promise<string | undefined> {
    return this.read((state) =>
      state.messages
        .filter((message) => message.state.phase !== "terminal")
        .map((message) => message.deadlineAt)
        .sort()[0],
    );
  }
  async deliveryStatus(token: string): Promise<GatewayMessageRecord | undefined> {
    if (!DELIVERY_TOKEN_PATTERN.test(token)) {
      throw new BridgeError("INVALID_DELIVERY_TOKEN", "The delivery-status token is malformed.");
    }
    return this.read((state) => {
      const message = state.messages.find(
        (candidate) => candidate.deliveryToken === token,
      );
      return message === undefined ? undefined : structuredClone(message);
    });
  }
  async reserveMessage(targetAlias?: string, mode: "any" | "steer_only" = "any"): Promise<ReserveMessageResult> {
    return this.mutate((state, now) => {
      if (targetAlias !== undefined && !ALIAS_PATTERN.test(targetAlias)) {
        throw new BridgeError("INVALID_GATEWAY_ALIAS", "The dispatch target alias is invalid.");
      }
      const inFlight = state.messages.filter(
        (candidate) =>
          candidate.state.phase === "reserved" ||
          candidate.state.phase === "armed" ||
          candidate.state.phase === "accepted",
      ).length;
      if (inFlight >= this.config.limits.maxInFlightMessages) {
        return { status: "empty" };
      }
      const message = state.messages.find(
        (candidate) =>
          candidate.state.phase === "queued" &&
          (targetAlias === undefined || candidate.targetAlias === targetAlias) &&
          (mode === "any" || candidate.steer === true),
      );
      if (message === undefined) return { status: "empty" };
      if (Date.parse(message.deadlineAt) <= now.getTime()) {
        return { status: "terminal", settlement: this.finishMessage(state, message, "expired", now, "MESSAGE_EXPIRED") };
      }
      if (message.targetRegistrationId === null) {
        return { status: "terminal", settlement: this.finishMessage(state, message, "abandoned", now, "CONTROLLER_RESTARTED") };
      }
      if (message.state.phase !== "queued") return { status: "empty" };
      const maximumAttemptCount = 1 + Math.max(0,
        Math.ceil((Date.parse(message.deadlineAt) - Date.parse(message.enqueuedAt)) / 500));
      if (message.state.attemptCount >= maximumAttemptCount) {
        throw new RangeError("GATEWAY_ATTEMPT_BUDGET_EXHAUSTED");
      }
      const attemptId = `attempt_${this.randomId()}`;
      const attemptCount = message.state.attemptCount + 1;
      message.state = {
        phase: "reserved",
        attemptId,
        attemptCount,
        reservedAt: now.toISOString(), sourceRegistrationId: message.sourceRegistrationId,
        targetRegistrationId: message.targetRegistrationId, consentEdge: message.consentEdge,
      };
      state.accounting.queuedBytes -= message.bytes;
      this.touchMessage(state, message);
      return {
        status: "reserved",
        attempt: {
          messageId: message.messageId,
          attemptId,
          attemptCount,
          body: message.body!, deadlineAt: message.deadlineAt,
          direction: message.direction, sourceAlias: message.sourceAlias,
          targetAlias: message.targetAlias,
          ...(message.conversationIdSuffix === undefined
            ? {}
            : { conversationIdSuffix: message.conversationIdSuffix }),
          sourceRegistrationId: message.sourceRegistrationId, targetRegistrationId: message.targetRegistrationId,
          consentEdge: message.consentEdge, bytes: message.bytes,
          ...(message.steer === true ? { steer: true as const } : {}),
        },
      };
    });
  }
  async authorizeMessage(input: AuthorizeMessageInput): Promise<AuthorizeMessageResult> {
    return this.mutate((state, now) => {
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (message?.state.phase !== "reserved") {
        return { status: "stale", reason: "not_reserved" };
      }
      if (message.state.attemptId !== input.attemptId) {
        return { status: "stale", reason: "attempt_mismatch" };
      }
      if (Date.parse(message.deadlineAt) <= now.getTime()) {
        return { status: "terminal", reason: "expired",
          settlement: this.finishMessage(state, message, "expired", now, "MESSAGE_EXPIRED") };
      }
      const bodySha256 = createHash("sha256")
        .update(message.body ?? "", "utf8")
        .digest("hex");
      if (
        !isPrepared(input.prepared) ||
        input.prepared.kind !== expectedPreparedKind(message) ||
        input.prepared.bodyBytes !== message.bytes ||
        input.prepared.bodySha256 !== bodySha256
      ) {
        throw new BridgeError("INVALID_PREPARED_WRITE_EVIDENCE", "The prepared payload evidence does not match the admitted message.");
      }
      const target = state.routes.find(
        (route) =>
          route.alias === message.targetAlias &&
          route.binding.registrationId === message.targetRegistrationId &&
          route.enabled,
      );
      if (
        input.sourceRegistrationId !== message.sourceRegistrationId ||
        input.targetRegistrationId !== message.targetRegistrationId ||
        (message.transientTarget !== true && target === undefined)
      ) {
        return { status: "stale", reason: "registration_changed" };
      }
      if (message.sourceRegistrationId !== null) {
        const source = state.routes.find(
          (route) =>
            route.alias === message.sourceAlias &&
            route.binding.registrationId === message.sourceRegistrationId &&
            route.enabled,
        );
        if (source === undefined) {
          return { status: "stale", reason: "registration_changed" };
        }
      }
      if (
        message.consentEdge !== null &&
        !state.consentEdges.some((edge) =>
          sameConsent(edge.endpoints, message.consentEdge),
        )
      ) {
        return { status: "stale", reason: "consent_removed" };
      }
      const authority = message.state;
      message.state = {
        phase: "armed", attemptId: authority.attemptId,
        attemptCount: authority.attemptCount, targetRegistrationId: authority.targetRegistrationId,
        sourceRegistrationId: authority.sourceRegistrationId, consentEdge: authority.consentEdge,
        armedAt: now.toISOString(), prepared: { ...input.prepared },
      };
      this.touchMessage(state, message);
      return { status: "authorized" };
    });
  }
  async acceptMessage(input: AcceptMessageInput): Promise<AcceptMessageResult> {
    return this.mutate((state, now) => {
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (
        message?.state.phase !== "armed" ||
        message.state.attemptId !== input.attemptId
      ) {
        return { status: "stale" };
      }
      const authority = message.state;
      message.state = {
        phase: "accepted", attemptId: authority.attemptId,
        attemptCount: authority.attemptCount, targetRegistrationId: authority.targetRegistrationId,
        sourceRegistrationId: authority.sourceRegistrationId, consentEdge: authority.consentEdge,
        acceptedAt: now.toISOString(), prepared: authority.prepared,
        lossOutcome: input.lossOutcome,
      };
      this.touchMessage(state, message);
      return { status: "accepted" };
    });
  }
  async resolvePrewriteAttempt(input: ResolvePrewriteAttemptInput): Promise<ResolvePrewriteAttemptResult> {
    return this.mutate((state, now) => {
      if (input.safeErrorCode !== undefined && !isSafeCode(input.safeErrorCode)) {
        throw new BridgeError("INVALID_SAFE_ERROR_CODE", "The pre-write result safe code is malformed.");
      }
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (
        message?.state.phase !== "reserved" ||
        message.state.attemptId !== input.attemptId
      ) {
        return { status: "stale" };
      }
      if (input.outcome === "requeue" && Date.parse(message.deadlineAt) > now.getTime()) {
        const attemptCount = message.state.attemptCount;
        message.state = { phase: "queued", attemptCount };
        state.accounting.queuedBytes += message.bytes;
        this.touchMessage(state, message);
        return { status: "requeued" };
      }
      const expired = Date.parse(message.deadlineAt) <= now.getTime();
      return { status: "settled", settlement: this.finishMessage(state, message,
        expired ? "expired" : "failed", now, expired ? "MESSAGE_EXPIRED" : input.safeErrorCode) };
    });
  }
  async settleAttempt(input: SettleAttemptInput): Promise<SettleAttemptResult> {
    return this.mutate((state, now) => {
      if (input.safeErrorCode !== undefined && !isSafeCode(input.safeErrorCode)) {
        throw new BridgeError("INVALID_SAFE_ERROR_CODE", "The settlement safe code is malformed.");
      }
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (
        message === undefined ||
        (message.state.phase !== "armed" && message.state.phase !== "accepted") ||
        message.state.attemptId !== input.attemptId
      ) {
        return { status: "stale" };
      }
      if (
        (message.state.phase === "armed" &&
          (input.state === "expired" ||
            (input.state === "unconfirmed" &&
              (input.safeErrorCode !== "ACP_OUTCOME_COARSE" ||
                message.state.prepared.kind !== "acp_prompt")))) ||
        (message.state.phase === "accepted" &&
          (input.state === "expired" ||
            (input.state === "unconfirmed" &&
              message.state.lossOutcome !== "unconfirmed") ||
            (input.state === "ambiguous" &&
              message.state.lossOutcome !== "ambiguous")))
      ) {
        throw new RangeError("INVALID_ATTEMPT_SETTLEMENT_PHASE");
      }
      return { status: "settled",
        settlement: this.finishMessage(state, message, input.state, now, input.safeErrorCode) };
    });
  }
  async settleAttemptForShutdown(input: SettleAttemptForShutdownInput): Promise<SettleAttemptForShutdownResult> {
    return this.mutate((state, now) => {
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (
        message === undefined ||
        message.state.phase === "queued" ||
        message.state.phase === "terminal" ||
        message.state.attemptId !== input.attemptId
      ) {
        return { status: "stale" };
      }
      if (message.state.phase === "reserved") {
        const attemptCount = message.state.attemptCount;
        message.state = { phase: "queued", attemptCount };
        state.accounting.queuedBytes += message.bytes;
        this.touchMessage(state, message);
        return { status: "requeued" };
      }
      const outcome = message.state.phase === "armed" ? "ambiguous" : message.state.lossOutcome;
      return { status: "settled", settlement: this.finishMessage(state, message, outcome, now,
        outcome === "ambiguous" ? "DISPATCH_OUTCOME_AMBIGUOUS" : "DELIVERY_UNCONFIRMED") };
    });
  }
  async settleQueuedMessageForShutdown(input: SettleQueuedMessageForShutdownInput): Promise<SettleQueuedMessageForShutdownResult> {
    return this.mutate((state, now) => {
      const message = state.messages.find((candidate) => candidate.messageId === input.messageId);
      if (message?.state.phase !== "queued") return { status: "stale" };
      return { status: "settled",
        settlement: this.finishMessage(state, message, "cancelled", now, "GATEWAY_SHUTDOWN") };
    });
  }
  async expireDueMessages(now?: Date): Promise<TerminalMessageSettlement[]> {
    return this.mutate((state, mutationNow) => {
      const effective = now ?? mutationNow;
      const settlements: TerminalMessageSettlement[] = [];
      for (const message of state.messages) {
        if (
          message.state.phase === "terminal" ||
          Date.parse(message.deadlineAt) > effective.getTime()
        ) {
          continue;
        }
        const outcome =
          message.state.phase === "accepted"
            ? message.state.lossOutcome
            : message.state.phase === "armed"
              ? "ambiguous"
              : "expired";
        settlements.push(
          this.finishMessage(
            state,
            message,
            outcome,
            effective,
            outcome === "ambiguous"
              ? "DISPATCH_OUTCOME_AMBIGUOUS"
              : outcome === "unconfirmed"
                ? "DELIVERY_UNCONFIRMED"
                : "MESSAGE_EXPIRED",
          ),
        );
      }
      return settlements;
    });
  }
  async recordActivity(
    event: Omit<PublicGatewayActivityEvent, "sequence" | "timestamp">,
  ): Promise<PublicGatewayActivityEvent> {
    return this.mutate((state, now) => {
      return this.appendRuntimeActivity(state, now, event);
    });
  }
  async publicSnapshot(): Promise<GatewayPublicSnapshot> {
    return this.read((state) => {
      const now = this.now();
      const routes: PublicRouteSnapshot[] = state.routes.map((route) => {
        const queued = state.messages.filter(
          (message) =>
            message.targetRegistrationId === route.binding.registrationId &&
            message.state.phase === "queued",
        );
        return {
          alias: route.alias, provider: route.binding.provider,
          host: route.binding.hostId, enabled: route.enabled,
          state: route.enabled ? "idle" : "disabled", busyPolicy: route.busyPolicy,
          queueDepth: queued.length,
          ...(queued[0]?.enqueuedAt === undefined
            ? {}
            : { oldestQueuedAt: queued[0].enqueuedAt }),
          counters: { ...route.counters },
        };
      });
      const consentEdges: PublicConsentEdgeSnapshot[] = state.consentEdges.map(
        (edge) => ({
          endpoints: [
            {
              alias: edge.endpoints[0].alias, provider: edge.endpoints[0].provider,
            },
            {
              alias: edge.endpoints[1].alias, provider: edge.endpoints[1].provider,
            },
          ],
          host: aliasHost(edge.endpoints[0].alias), counters: { ...edge.counters },
        }),
      );
      const currentEvents = state.messages.map((message) =>
        this.projectMessageEvent(message),
      );
      const legacyEvents = state.activity
        .filter(
          (entry): entry is GatewayLegacyMessageActivity =>
            entry.type === "legacy_message",
        )
        .map((entry) => structuredClone(entry.event));
      const activityEvents = state.activity
        .filter(
          (entry): entry is GatewayRuntimeActivity => entry.type === "activity",
        )
        .map((entry) => structuredClone(entry.event));
      const messages = [...legacyEvents, ...currentEvents]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-gatewayPublicSnapshotLimits.messages);
      return projectGatewayPublicSnapshot({
        schemaVersion: 2, generatedAt: now.toISOString(),
        inboundMode: this.config.inboundMode, health: "offline",
        connectors: [], availablePeers: [],
        routes,
        consentEdges,
        activityEvents,
        deadlinePressure: {
          configuredDeadlineMs: this.config.limits.messageDeadlineMs,
          ...(messages[0]?.timestamp === undefined
            ? {}
            : { retainedSince: messages[0].timestamp }),
          terminalEvents: messages.filter((event) =>
            [
              "delivered",
              "unconfirmed",
              "failed",
              "ambiguous",
              "expired",
              "cancelled",
              "abandoned",
            ].includes(event.state),
          ).length,
          expiredEvents: messages.filter((event) => event.state === "expired")
            .length,
          buckets: [],
        },
        messages,
        accounting: { ...state.accounting }, alerts: [],
        truncation: {
          connectors: 0, availablePeers: 0,
          routes: 0, consentEdges: 0,
          activityEvents: 0,
          messages: Math.max(
            0,
            legacyEvents.length + currentEvents.length - messages.length,
          ),
          alerts: 0,
        },
      });
    });
  }
  private projectMessageEvent(
    message: GatewayMessageRecord,
  ): NormalizedMessageEvent {
    const state: DeliveryState =
      message.state.phase === "queued"
        ? "queued"
        : message.state.phase === "reserved"
          ? "dispatching"
          : message.state.phase === "armed" || message.state.phase === "accepted"
            ? "transport_written"
            : message.state.outcome;
    return {
      sequence: message.sequence,
      timestamp:
        message.state.phase === "queued"
          ? message.enqueuedAt
          : message.state.phase === "reserved"
            ? message.state.reservedAt
            : message.state.phase === "armed"
              ? message.state.armedAt
              : message.state.phase === "accepted"
                ? message.state.acceptedAt
                : message.state.terminalAt,
      messageIdSuffix: message.messageIdSuffix,
      ...(message.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: message.conversationIdSuffix }),
      direction: message.direction, sourceAlias: message.sourceAlias,
      targetAlias: message.targetAlias,
      state,
      bytes: message.bytes,
      ...(message.body === undefined ? {} : { body: message.body }),
      ...(message.steer === true ? { steer: true as const } : {}),
      ...(message.state.phase === "terminal"
        ? {
            latencyMs: message.state.latencyMs,
            ...(message.state.safeErrorCode === undefined
              ? {}
              : { safeErrorCode: message.state.safeErrorCode }),
          }
        : {}),
    };
  }
  private validateRouteInput(input: RegisterRouteInput): void {
    if (
      !isObject(input) ||
      !ALIAS_PATTERN.test(input.alias) ||
      !isLogicalBinding(input.binding) ||
      !REGISTRATION_MODES.has(input.registrationMode) ||
      !input.alias.endsWith(`@${input.binding.hostId}`) ||
      !this.config.allowedHosts.includes(input.binding.hostId) ||
      (input.binding.provider === "claude"
        ? input.registrationMode !== "selected_live_peer"
        : input.registrationMode !== "explicit_opt_in")
    ) {
      throw new BridgeError("INVALID_ROUTE_BINDING", "The logical route binding is invalid for this gateway.");
    }
    const prefix = gatewayRegistrationIngressPrefixes[input.binding.provider];
    if (prefix !== undefined && !input.alias.startsWith(prefix)) {
      throw new BridgeError("INVALID_ROUTE_BINDING", "The route alias does not match its provider ingress convention.");
    }
  }
  private requireRoute(
    state: GatewayPersistedState, alias: string,
  ): GatewayRouteRecord {
    const route = state.routes.find(
      (candidate) => candidate.alias === alias && candidate.enabled,
    );
    if (route === undefined) {
      throw new BridgeError("ROUTE_NOT_AVAILABLE", "The exact logical route is not registered and enabled.", true);
    }
    return route;
  }
  private resolvePair(
    state: GatewayPersistedState,
    aliases: readonly [string, string],
    required: boolean,
    expectedRegistrationIds?: readonly [string, string],
  ):
    | Readonly<{
        left: GatewayRouteRecord;
        right: GatewayRouteRecord;
        endpoints: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint];
      }>
    | undefined {
    if (
      aliases.length !== 2 ||
      aliases[0] === aliases[1] ||
      !aliases.every((alias) => ALIAS_PATTERN.test(alias))
    ) {
      if (required) {
        throw new BridgeError("INVALID_CONSENT_EDGE", "Consent requires two distinct exact route aliases.");
      }
      return undefined;
    }
    const left = state.routes.find((route) => route.alias === aliases[0]);
    const right = state.routes.find((route) => route.alias === aliases[1]);
    if (
      expectedRegistrationIds === undefined ||
      !expectedRegistrationIds.every(isPrivateToken)
    ) {
      if (required) {
        throw new BridgeError("INVALID_CONSENT_EDGE", "Consent requires both exact registration identities.");
      }
      return undefined;
    }
    if (
      left?.binding.registrationId !== expectedRegistrationIds[0] ||
      right?.binding.registrationId !== expectedRegistrationIds[1]
    ) {
      throw new BridgeError("ROUTE_UNREGISTERED", "A consent endpoint registration is no longer current.");
    }
    if (
      left === undefined ||
      right === undefined ||
      left.binding.provider === right.binding.provider ||
      left.binding.hostId !== right.binding.hostId
    ) {
      if (required) {
        throw new BridgeError("INVALID_CONSENT_EDGE", "Consent requires exact same-host routes from distinct providers.");
      }
      return undefined;
    }
    return {
      left,
      right,
      endpoints: canonicalConsentEndpoints(left, right),
    };
  }
  private requireConsent(
    state: GatewayPersistedState, source: GatewayRouteRecord,
    target: GatewayRouteRecord,
  ): GatewayConsentEdgeRecord {
    const endpoints = canonicalConsentEndpoints(source, target);
    const edge = state.consentEdges.find((candidate) =>
      sameConsent(candidate.endpoints, endpoints),
    );
    if (edge === undefined) {
      throw new BridgeError("SENDER_NOT_PAIRED", "The exact logical routes do not share consent.");
    }
    return edge;
  }
  private enqueueResolved(
    state: GatewayPersistedState, now: Date,
    input: Omit<EnqueueMessageInput, "sourceAlias" | "targetAlias">,
    authority: Readonly<{
      sourceAlias: string;
      targetAlias: string;
      direction: MessageDirection;
      sourceRegistrationId: string | null;
      targetRegistrationId: string;
      consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
      pair?: true;
      transientTarget?: true;
      exposeDeliveryToken: boolean;
    }>,
  ): EnqueueMessageResult {
    if (
      typeof input.body !== "string" ||
      input.body.length === 0 ||
      input.body.includes("\u0000") ||
      typeof input.dedupeKey !== "string" ||
      input.dedupeKey.length === 0 ||
      (input.conversationIdSuffix !== undefined &&
        !CONVERSATION_SUFFIX_PATTERN.test(input.conversationIdSuffix))
    ) {
      throw new BridgeError("INVALID_GATEWAY_MESSAGE", "The gateway message body or correlation metadata is invalid.");
    }
    const bytes = Buffer.byteLength(input.body, "utf8");
    if (bytes > this.config.limits.maxMessageBytes) {
      this.recordRejection(state, authority, bytes, now, "MESSAGE_TOO_LARGE", input);
      throw new CommitAndThrow(
        new BridgeError(
          "MESSAGE_TOO_LARGE",
          "The message exceeds the configured byte bound.",
        ),
      );
    }
    if (Buffer.byteLength(input.dedupeKey, "utf8") > 512) {
      throw new BridgeError("INVALID_DEDUPE_KEY", "A bounded, non-empty deduplication key is required.");
    }
    const deadlineAt =
      input.deadlineAt ??
      new Date(now.getTime() + this.config.limits.messageDeadlineMs).toISOString();
    if (
      !isIsoTimestamp(deadlineAt) ||
      Date.parse(deadlineAt) <= now.getTime() ||
      Date.parse(deadlineAt) > now.getTime() + this.config.limits.messageDeadlineMs
    ) {
      this.recordRejection(state, authority, bytes, now, "INVALID_DEADLINE", input);
      throw new CommitAndThrow(
        new BridgeError(
          "INVALID_DEADLINE",
          "The message deadline must fall inside the configured delivery window.",
        ),
      );
    }
    const fingerprint = createHash("sha256")
      .update(
        [
          authority.sourceAlias,
          authority.targetAlias,
          authority.direction,
          input.dedupeKey,
        ].join("\0"),
      )
      .digest("base64url");
    const duplicate = state.dedupe.find(
      (entry) =>
        entry.fingerprint === fingerprint &&
        Date.parse(entry.expiresAt) > now.getTime(),
    );
    if (duplicate !== undefined) {
      state.accounting.duplicates += 1;
      return {
        accepted: false, duplicate: true,
        messageIdSuffix: duplicate.messageIdSuffix,
      };
    }
    if (!this.consumeRate(state, authority.sourceAlias, now)) {
      this.recordRejection(state, authority, bytes, now, "GATEWAY_RATE_LIMITED", input);
      throw new CommitAndThrow(
        new BridgeError(
          "GATEWAY_RATE_LIMITED",
          "The source exceeded the bounded gateway rate window.",
          true,
        ),
      );
    }
    const active = state.messages.filter(
      (message) => message.state.phase !== "terminal",
    );
    const queuedSteers =
      input.steer === true
        ? active
            .filter(
              (message) =>
                message.state.phase === "queued" &&
                message.steer === true &&
                message.sourceAlias === authority.sourceAlias &&
                message.targetAlias === authority.targetAlias,
            )
            .sort(
              (left, right) =>
                Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt) ||
                left.sequence - right.sequence,
            )
        : [];
    const superseded = queuedSteers.length >= 3 ? queuedSteers[0] : undefined;
    if (
      active.length - (superseded === undefined ? 0 : 1) >=
        this.config.limits.maxQueueMessages ||
      active.filter((message) => message.targetAlias === authority.targetAlias)
        .length - (superseded === undefined ? 0 : 1) >=
        this.config.limits.maxQueueMessagesPerRoute ||
      state.accounting.queuedBytes - (superseded?.bytes ?? 0) + bytes >
        this.config.limits.maxQueueBytes
    ) {
      this.recordRejection(state, authority, bytes, now, "GATEWAY_QUEUE_FULL", input);
      throw new CommitAndThrow(
        new BridgeError(
          "GATEWAY_QUEUE_FULL",
          "The bounded gateway queue is full.",
          true,
        ),
      );
    }
    const messageId = `msg_${this.randomId()}`;
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BridgeError("GATEWAY_ID_ALLOCATION_FAILED", "A valid message identifier could not be allocated.");
    }
    const messageIdSuffix = messageId.replaceAll("-", "").slice(-8).toLowerCase();
    const deliveryToken = authority.exposeDeliveryToken
      ? this.allocateDeliveryToken(state)
      : undefined;
    const supersededSettlement =
      superseded === undefined
        ? undefined
        : this.finishMessage(
            state,
            superseded,
            "cancelled",
            now,
            "STEER_QUEUE_SUPERSEDED",
          );
    state.eventSequence += 1;
    const message: GatewayMessageRecord = {
      sequence: state.eventSequence,
      messageId,
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
      direction: authority.direction, sourceAlias: authority.sourceAlias,
      targetAlias: authority.targetAlias, enqueuedAt: now.toISOString(),
      deadlineAt,
      bytes,
      body: input.body,
      ...(authority.pair === true ? { pair: true as const } : {}),
      ...(authority.transientTarget === true
        ? { transientTarget: true as const }
        : {}),
      ...(input.steer === true ? { steer: true as const } : {}),
      sourceRegistrationId: authority.sourceRegistrationId, targetRegistrationId: authority.targetRegistrationId,
      consentEdge: authority.consentEdge,
      state: { phase: "queued", attemptCount: 0 },
    };
    state.messages.push(message);
    state.accounting.accepted += 1;
    state.accounting.bytesAccepted += bytes;
    state.accounting.queuedBytes += bytes;
    const source = state.routes.find(
      (route) => route.binding.registrationId === authority.sourceRegistrationId,
    );
    if (source !== undefined) {
      source.counters.accepted += 1;
      source.counters.bytesAccepted += bytes;
    }
    const edge = state.consentEdges.find((candidate) =>
      sameConsent(candidate.endpoints, authority.consentEdge),
    );
    if (edge !== undefined) {
      edge.counters.accepted += 1;
      edge.counters.bytesAccepted += bytes;
      edge.updatedAt = now.toISOString();
    }
    state.dedupe.push({
      fingerprint,
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      sourceAlias: authority.sourceAlias, targetAlias: authority.targetAlias,
      direction: authority.direction,
      ...(authority.pair === true ? { pair: true as const } : {}),
      firstSeenAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.limits.dedupeTtlMs,
      ).toISOString(),
    });
    while (state.dedupe.length > this.config.limits.dedupeCapacity) {
      state.dedupe.shift();
    }
    return {
      accepted: true, duplicate: false,
      messageId,
      messageIdSuffix,
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
      ...(authority.pair === true ? { pair: true as const } : {}),
      ...(supersededSettlement === undefined
        ? {}
        : { supersededSettlement }),
    };
  }
  private allocateDeliveryToken(state: GatewayPersistedState): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = `dlv_${createHash("sha256")
        .update(this.randomId(), "utf8")
        .digest("base64url")
        .slice(0, 24)}`;
      if (
        DELIVERY_TOKEN_PATTERN.test(token) &&
        !state.messages.some((message) => message.deliveryToken === token)
      ) {
        return token;
      }
    }
    throw new BridgeError("DELIVERY_TOKEN_CAPACITY_REACHED", "A unique bounded delivery-status token could not be allocated.", true);
  }
  private consumeRate(
    state: GatewayPersistedState, sourceAlias: string,
    now: Date,
  ): boolean {
    let bucket = state.rateBuckets.find(
      (candidate) => candidate.sourceAlias === sourceAlias,
    );
    if (
      bucket === undefined ||
      now.getTime() - Date.parse(bucket.windowStartedAt) >=
        this.config.limits.rateWindowMs
    ) {
      state.rateBuckets = state.rateBuckets.filter(
        (candidate) => candidate.sourceAlias !== sourceAlias,
      );
      if (state.rateBuckets.length >= this.config.limits.maxRoutes) {
        return false;
      }
      bucket = {
        sourceAlias,
        windowStartedAt: now.toISOString(), count: 0,
      };
      state.rateBuckets.push(bucket);
    }
    if (bucket.count >= this.config.limits.rateLimitPerRoute) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
  private recordRejection(
    state: GatewayPersistedState,
    authority: Readonly<{
      sourceAlias: string;
      targetAlias: string;
      direction: MessageDirection;
      sourceRegistrationId: string | null;
      targetRegistrationId: string;
      consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
      pair?: true;
      transientTarget?: true;
    }>,
    bytes: number, now: Date,
    safeErrorCode: string,
    input: Pick<EnqueueMessageInput, "conversationIdSuffix" | "steer">,
  ): void {
    state.accounting.rejected += 1;
    const source = state.routes.find(
      (route) => route.binding.registrationId === authority.sourceRegistrationId,
    );
    if (source !== undefined) source.counters.rejected += 1;
    const edge = state.consentEdges.find((candidate) =>
      sameConsent(candidate.endpoints, authority.consentEdge),
    );
    if (edge !== undefined) {
      edge.counters.rejected += 1;
      edge.updatedAt = now.toISOString();
    }
    const suffix = this.randomId().replaceAll("-", "").slice(-8).toLowerCase();
    if (!MESSAGE_SUFFIX_PATTERN.test(suffix)) return;
    state.eventSequence += 1;
    state.activity.push({
      type: "legacy_message",
      event: {
        sequence: state.eventSequence, timestamp: now.toISOString(),
        messageIdSuffix: suffix,
        ...(input.conversationIdSuffix === undefined
          ? {}
          : { conversationIdSuffix: input.conversationIdSuffix }),
        direction: authority.direction, sourceAlias: authority.sourceAlias,
        targetAlias: authority.targetAlias, state: "rejected",
        bytes: Math.max(1, bytes),
        safeErrorCode,
        ...(input.steer === true ? { steer: true as const } : {}),
      },
    });
    while (state.activity.length > gatewayPublicSnapshotLimits.activityEvents) {
      state.activity.shift();
    }
  }
  private finishMessage(
    state: GatewayPersistedState, message: GatewayMessageRecord,
    outcome: TerminalDeliveryOutcome, now: Date,
    safeErrorCode?: string,
  ): TerminalMessageSettlement {
    if (message.state.phase === "terminal") {
      return {
        messageId: message.messageId, state: message.state.outcome,
        ...(message.state.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: message.state.safeErrorCode }),
      };
    }
    if (message.state.phase === "queued") {
      state.accounting.queuedBytes -= message.bytes;
    }
    message.state = terminalState(
      outcome,
      now,
      message.enqueuedAt,
      safeErrorCode,
    );
    this.touchMessage(state, message);
    state.accounting[outcome] += 1;
    const target = state.routes.find(
      (route) => route.binding.registrationId === message.targetRegistrationId,
    );
    if (target !== undefined) target.counters[outcome] += 1;
    const edge = state.consentEdges.find((candidate) =>
      sameConsent(candidate.endpoints, message.consentEdge),
    );
    if (edge !== undefined) {
      edge.counters[outcome] += 1;
      edge.updatedAt = now.toISOString();
    }
    return {
      messageId: message.messageId, state: outcome,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    };
  }
  private touchMessage(
    state: GatewayPersistedState, message: GatewayMessageRecord,
  ): void {
    state.eventSequence += 1;
    message.sequence = state.eventSequence;
  }
  private appendRuntimeActivity(
    state: GatewayPersistedState, now: Date,
    event: Omit<PublicGatewayActivityEvent, "sequence" | "timestamp">,
  ): PublicGatewayActivityEvent {
    state.eventSequence += 1;
    const recorded: PublicGatewayActivityEvent = {
      ...structuredClone(event),
      sequence: state.eventSequence, timestamp: now.toISOString(),
    };
    const wrapped: GatewayRuntimeActivity = {
      type: "activity", event: recorded,
    };
    state.activity.push(wrapped);
    while (state.activity.length > gatewayPublicSnapshotLimits.activityEvents) {
      state.activity.shift();
    }
    return structuredClone(recorded);
  }
  private terminalizeRegistration(
    state: GatewayPersistedState, registrationId: string,
    now: Date,
  ): TerminalMessageSettlement[] {
    const settlements: TerminalMessageSettlement[] = [];
    for (const message of state.messages) {
      if (
        message.state.phase === "terminal" ||
        (message.sourceRegistrationId !== registrationId &&
          message.targetRegistrationId !== registrationId)
      ) {
        continue;
      }
      const outcome =
        message.state.phase === "armed"
          ? "ambiguous"
          : message.state.phase === "accepted"
            ? message.state.lossOutcome
            : "cancelled";
      settlements.push(
        this.finishMessage(
          state,
          message,
          outcome,
          now,
          outcome === "cancelled"
            ? "ROUTE_UNREGISTERED"
            : outcome === "ambiguous"
              ? "DISPATCH_OUTCOME_AMBIGUOUS"
              : "DELIVERY_UNCONFIRMED",
        ),
      );
    }
    return settlements;
  }
  private removeRegistrationMetadata(
    state: GatewayPersistedState, route: GatewayRouteRecord,
  ): void {
    state.routes = state.routes.filter((candidate) => candidate !== route);
    state.consentEdges = state.consentEdges.filter(
      (edge) =>
        !edge.endpoints.some(
          (endpoint) =>
            endpoint.registrationId === route.binding.registrationId,
        ),
    );
    state.dedupe = state.dedupe.filter(
      (entry) =>
        entry.sourceAlias !== route.alias && entry.targetAlias !== route.alias,
    );
    state.rateBuckets = state.rateBuckets.filter(
      (entry) => entry.sourceAlias !== route.alias,
    );
  }
  private renameRegistrationCoordinates(
    state: GatewayPersistedState, oldAlias: string,
    newAlias: string, registrationId: string,
  ): void {
    if (oldAlias === newAlias) return;
    if (
      !ALIAS_PATTERN.test(newAlias) ||
      state.routes.some((route) => route.alias === newAlias)
    ) {
      throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "The replacement alias is invalid or already registered.");
    }
    for (const edge of state.consentEdges) {
      const updated = edge.endpoints.map((endpoint) =>
        endpoint.registrationId === registrationId
          ? { ...endpoint, alias: newAlias }
          : endpoint,
      ) as [GatewayConsentEndpoint, GatewayConsentEndpoint];
      updated.sort(compareConsentEndpoints);
      edge.endpoints = updated;
    }
    for (const message of state.messages) {
      if (message.sourceRegistrationId === registrationId) {
        message.sourceAlias = newAlias;
      }
      if (message.targetRegistrationId === registrationId) {
        message.targetAlias = newAlias;
      }
      if (message.consentEdge !== null) {
        const updated = message.consentEdge.map((endpoint) =>
          endpoint.registrationId === registrationId
            ? { ...endpoint, alias: newAlias }
            : endpoint,
        ) as [GatewayConsentEndpoint, GatewayConsentEndpoint];
        updated.sort(compareConsentEndpoints);
        message.consentEdge = updated;
      }
      if (
        message.state.phase === "reserved" ||
        message.state.phase === "armed" ||
        message.state.phase === "accepted"
      ) {
        if (message.state.consentEdge !== null) {
          const updated = message.state.consentEdge.map((endpoint) =>
            endpoint.registrationId === registrationId
              ? { ...endpoint, alias: newAlias }
              : endpoint,
          ) as [GatewayConsentEndpoint, GatewayConsentEndpoint];
          updated.sort(compareConsentEndpoints);
          message.state.consentEdge = updated;
        }
      }
    }
    for (const entry of state.dedupe) {
      if (entry.sourceAlias === oldAlias) entry.sourceAlias = newAlias;
      if (entry.targetAlias === oldAlias) entry.targetAlias = newAlias;
    }
    const oldBucket = state.rateBuckets.find(
      (bucket) => bucket.sourceAlias === oldAlias,
    );
    const newBucket = state.rateBuckets.find(
      (bucket) => bucket.sourceAlias === newAlias,
    );
    if (oldBucket !== undefined && newBucket === undefined) {
      oldBucket.sourceAlias = newAlias;
    } else if (oldBucket !== undefined && newBucket !== undefined) {
      newBucket.windowStartedAt =
        newBucket.windowStartedAt < oldBucket.windowStartedAt
          ? newBucket.windowStartedAt
          : oldBucket.windowStartedAt;
      newBucket.count = Math.min(
        Number.MAX_SAFE_INTEGER,
        newBucket.count + oldBucket.count,
      );
      state.rateBuckets = state.rateBuckets.filter(
        (bucket) => bucket !== oldBucket,
      );
    }
  }
  private recoverAfterRestart(now: Date): void {
    const state = this.requireState();
    for (const message of state.messages) {
      if (message.state.phase === "terminal") continue;
      if (message.state.phase === "armed") {
        this.finishMessage(
          state,
          message,
          "ambiguous",
          now,
          "CONTROLLER_RESTARTED",
        );
        continue;
      }
      if (message.state.phase === "accepted") {
        this.finishMessage(
          state,
          message,
          message.state.lossOutcome,
          now,
          "CONTROLLER_RESTARTED",
        );
        continue;
      }
      if (
        Date.parse(message.deadlineAt) <= now.getTime() ||
        (message.state.phase === "queued" && message.body === undefined)
      ) {
        this.finishMessage(
          state,
          message,
          Date.parse(message.deadlineAt) <= now.getTime()
            ? "expired"
            : "abandoned",
          now,
          Date.parse(message.deadlineAt) <= now.getTime()
            ? "MESSAGE_EXPIRED"
            : "CONTROLLER_RESTARTED",
        );
        continue;
      }
      if (message.transientTarget === true) {
        this.finishMessage(
          state,
          message,
          "abandoned",
          now,
          "CONTROLLER_RESTARTED",
        );
        continue;
      }
      if (message.state.phase === "reserved") {
        const attemptCount = message.state.attemptCount;
        message.state = { phase: "queued", attemptCount };
        state.accounting.queuedBytes += message.bytes;
        this.touchMessage(state, message);
        continue;
      }
    }
  }
  private prune(state: GatewayPersistedState, now: Date): void {
    const cutoff = now.getTime() - this.config.limits.eventTtlMs;
    const active = state.messages.filter(
      (message) => message.state.phase !== "terminal",
    );
    const terminal = state.messages
      .filter(
        (message) =>
          message.state.phase === "terminal" &&
          Date.parse(message.state.terminalAt) > cutoff,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-this.config.limits.eventCapacity);
    state.messages = [...active, ...terminal];
    state.activity = state.activity
      .filter((entry) => Date.parse(entry.event.timestamp) > cutoff)
      .slice(-gatewayPublicSnapshotLimits.activityEvents);
    state.dedupe = state.dedupe
      .filter((entry) => Date.parse(entry.expiresAt) > now.getTime())
      .slice(-this.config.limits.dedupeCapacity);
    state.rateBuckets = state.rateBuckets.filter(
      (bucket) =>
        now.getTime() - Date.parse(bucket.windowStartedAt) <
        this.config.limits.rateWindowMs,
    );
    this.pruneRetainedBodies(state);
  }
  private pruneRetainedBodies(state: GatewayPersistedState): void {
    const cap =
      this.config.limits.maxRetainedBodyBytes ?? DEFAULT_RETAINED_BODY_BYTES;
    if (
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      cap > GATEWAY_MAX_STATE_FILE_BYTES
    ) {
      throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The retained message-body limit is invalid.");
    }
    let bytes = state.messages.reduce(
      (total, message) =>
        total +
        (message.state.phase === "terminal" && message.body !== undefined
          ? Buffer.byteLength(message.body, "utf8")
          : 0),
      0,
    );
    for (const message of state.messages) {
      if (bytes <= cap) break;
      if (message.state.phase !== "terminal" || message.body === undefined) {
        continue;
      }
      bytes -= Buffer.byteLength(message.body, "utf8");
      delete message.body;
    }
  }
  private assertConfiguredBounds(state: GatewayPersistedState): void {
    const active = state.messages.filter(
      (message) => message.state.phase !== "terminal",
    );
    if (
      state.routes.some(
        (route) => !this.config.allowedHosts.includes(route.binding.hostId),
      ) ||
      state.routes.length > this.config.limits.maxRoutes ||
      state.consentEdges.length > this.config.limits.maxConsentEdges ||
      active.length > this.config.limits.maxQueueMessages ||
      active.filter(
        (message) =>
          message.state.phase === "reserved" ||
          message.state.phase === "armed" ||
          message.state.phase === "accepted",
      ).length > this.config.limits.maxInFlightMessages ||
      state.dedupe.length > this.config.limits.dedupeCapacity ||
      state.rateBuckets.length > this.config.limits.maxRoutes ||
      state.accounting.queuedBytes > this.config.limits.maxQueueBytes ||
      active.some(
        (message) =>
          message.bytes > this.config.limits.maxMessageBytes ||
          Date.parse(message.deadlineAt) - Date.parse(message.enqueuedAt) >
            this.config.limits.messageDeadlineMs,
      )
    ) {
      throw new BridgeError("CORRUPT_GATEWAY_STATE", "The gateway state exceeds its configured bounds or host allowlist.");
    }
  }
  private async read<T>(operation: (state: GatewayPersistedState) => T): Promise<T> {
    return this.mutex.run("gateway", async () => operation(this.requireState()));
  }
  private async mutate<T>(
    operation: (state: GatewayPersistedState, now: Date) => T,
  ): Promise<T> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const before = structuredClone(state);
      const now = this.now();
      this.prune(state, now);
      let value: T;
      try {
        value = operation(state, now);
      } catch (error) {
        if (error instanceof CommitAndThrow) {
          state.updatedAt = now.toISOString();
          state.commit = {
            sequence: state.commit.sequence + 1, id: this.randomId(),
          };
          try {
            await this.persist();
          } catch (persistError) {
            if (!(persistError instanceof PostRenamePersistenceError)) {
              this.state = before;
            }
            throw persistError;
          }
          throw error.error;
        }
        this.state = before;
        throw error;
      }
      state.updatedAt = now.toISOString();
      state.commit = {
        sequence: state.commit.sequence + 1, id: this.randomId(),
      };
      try {
        await this.persist();
      } catch (error) {
        if (!(error instanceof PostRenamePersistenceError)) this.state = before;
        throw error;
      }
      return value;
    });
  }
  private requireState(): GatewayPersistedState {
    if (this.state === undefined || this.lockHandle === undefined) {
      throw new BridgeError("GATEWAY_NOT_INITIALIZED", "The gateway store must hold its controller lock before use.");
    }
    return this.state;
  }
  private async prepareOwnedDirectory(): Promise<string> {
    const requested = path.resolve(this.rootDir);
    await assertNoSymlinkComponents(requested);
    const canonical = await canonicalFuturePath(requested);
    const home = await realpath(os.homedir()).catch(() =>
      path.resolve(os.homedir()),
    );
    const temporaryRoot = await realpath(os.tmpdir()).catch(() =>
      path.resolve(os.tmpdir()),
    );
    if (
      canonical === path.parse(canonical).root ||
      canonical === home ||
      canonical === temporaryRoot
    ) {
      throw new BridgeError("UNSAFE_GATEWAY_STATE_DIRECTORY", "The gateway state directory must be a dedicated private leaf.");
    }
    let existed = true;
    try {
      const info = await lstat(canonical);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BridgeError("UNSAFE_GATEWAY_STATE_DIRECTORY", "The gateway state path must be a real directory.");
      }
      this.assertOwnedPrivate(info.uid, info.mode, "directory");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        existed = false;
      } else {
        throw error;
      }
    }
    if (!existed) {
      await mkdir(canonical, { recursive: true, mode: 0o700 });
      await chmod(canonical, 0o700);
    }
    const root = await realpath(canonical);
    if (root !== canonical) {
      throw new BridgeError("UNSAFE_GATEWAY_STATE_DIRECTORY", "The gateway state path changed while it was prepared.");
    }
    const markerPath = path.join(root, STATE_MARKER);
    let markerExists = true;
    try {
      await this.readPrivateFile(
        markerPath,
        MAX_MARKER_FILE_BYTES,
        STATE_MARKER_CONTENT,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        markerExists = false;
      } else {
        throw error;
      }
    }
    if (!markerExists) {
      const entries = await readdir(root);
      if (existed && entries.length > 0) {
        throw new BridgeError("GATEWAY_STATE_DIRECTORY_NOT_OWNED", "The existing state directory is non-empty and lacks the ownership marker.");
      }
      const marker = await open(
        markerPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await marker.writeFile(STATE_MARKER_CONTENT, "utf8");
        await marker.sync();
      } finally {
        await marker.close();
      }
    }
    return root;
  }
  private assertOwnedPrivate(uid: number, mode: number, kind: string): void {
    if (typeof process.getuid === "function" && uid !== process.getuid()) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        `The gateway ${kind} is not owned by the current process user.`,
      );
    }
    const expectedMode = kind === "directory" ? 0o700 : 0o600;
    if ((mode & 0o777) !== expectedMode) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        `The gateway ${kind} must use exact mode ${expectedMode.toString(8)}.`,
      );
    }
  }
  private async readPrivateFile(
    filePath: string, maximumBytes: number,
    expectedBody?: string,
  ): Promise<string> {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new BridgeError("UNSAFE_GATEWAY_STATE_FILE", "A gateway controller file is not a regular file.");
    }
    this.assertOwnedPrivate(info.uid, info.mode, "state file");
    if (info.size > maximumBytes) {
      throw new BridgeError("GATEWAY_STATE_FILE_TOO_LARGE", "A gateway controller file exceeds its strict byte limit.");
    }
    const handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size > maximumBytes
      ) {
        throw new BridgeError("UNSAFE_GATEWAY_STATE_FILE", "A gateway controller file changed during its bounded read.");
      }
      this.assertOwnedPrivate(opened.uid, opened.mode, "state file");
      const buffer = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > maximumBytes) {
        throw new BridgeError("GATEWAY_STATE_FILE_TOO_LARGE", "A gateway controller file exceeds its strict byte limit.");
      }
      const body = buffer.subarray(0, offset).toString("utf8");
      if (expectedBody !== undefined && body !== expectedBody) {
        throw new BridgeError("GATEWAY_STATE_DIRECTORY_NOT_OWNED", "The gateway ownership marker is not recognized.");
      }
      return body;
    } finally {
      await handle.close();
    }
  }
  private async acquireLock(): Promise<void> {
    const lockPath = path.join(this.rootDir, CONTROLLER_LOCK);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(
          lockPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await handle.writeFile(
            `${JSON.stringify({
              schemaVersion: 1, pid: process.pid,
              hostname: os.hostname(),
              token,
            })}\n`,
            "utf8",
          );
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        this.lockHandle = handle;
        this.lockToken = token;
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }
      let owner: { pid?: unknown; hostname?: unknown };
      try {
        owner = JSON.parse(
          await this.readPrivateFile(lockPath, MAX_LOCK_FILE_BYTES),
        ) as { pid?: unknown; hostname?: unknown };
      } catch {
        throw new BridgeError("GATEWAY_STATE_LOCK_UNVERIFIED", "The gateway state lock exists but cannot be safely verified.");
      }
      if (owner.hostname !== os.hostname() || !isPositiveInteger(owner.pid)) {
        throw new BridgeError("GATEWAY_STATE_IN_USE", "The gateway state directory is locked by another host or unverifiable process.", true);
      }
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          alive = false;
        }
      }
      if (alive) {
        throw new BridgeError("GATEWAY_STATE_IN_USE", "Another live gateway controller owns this state directory.", true);
      }
      await rename(
        lockPath,
        path.join(
          this.rootDir,
          `.gateway-controller.lock.stale-${randomUUID()}`,
        ),
      ).catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      });
    }
    throw new BridgeError("GATEWAY_STATE_IN_USE", "Could not acquire exclusive gateway controller ownership.", true);
  }
  async releaseControllerLock(): Promise<void> {
    const handle = this.lockHandle;
    const token = this.lockToken;
    this.lockHandle = undefined;
    this.lockToken = undefined;
    if (handle === undefined || token === undefined) return;
    await handle.close().catch(() => undefined);
    const lockPath = path.join(this.rootDir, CONTROLLER_LOCK);
    try {
      const parsed = JSON.parse(
        await this.readPrivateFile(lockPath, MAX_LOCK_FILE_BYTES),
      ) as { token?: unknown };
      if (parsed.token === token) await unlink(lockPath);
    } catch {
      // Never remove a lock that cannot be proven to belong to this instance.
    }
  }
  private async loadStateFile(): Promise<GatewayPersistedState | undefined> {
    let body: string;
    try {
      body = await this.readPrivateFile(
        this.stateFilePath,
        GATEWAY_MAX_STATE_FILE_BYTES,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BridgeError("CORRUPT_GATEWAY_STATE", "The gateway controller state is not valid JSON.");
    }
    if (isObject(parsed) && parsed.schemaVersion === 2) {
      throw new BridgeError("GATEWAY_STATE_CONVERSION_REQUIRED", "The gateway state must be converted offline before this release can start.");
    }
    if (!isGatewayPersistedStateV3(parsed)) {
      throw new BridgeError("CORRUPT_GATEWAY_STATE", "The gateway controller state failed strict v3 schema validation.");
    }
    this.assertConfiguredBounds(parsed);
    return parsed;
  }
  private async persist(force = false): Promise<void> {
    if (this.persistenceDeferred && !force) return;
    const state = this.requireState();
    const temporary = path.join(
      this.rootDir,
      `.gateway-state-${randomUUID()}.tmp`,
    );
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > GATEWAY_MAX_STATE_FILE_BYTES) {
      throw new BridgeError("GATEWAY_STATE_FILE_TOO_LARGE", "The bounded gateway state exceeds its durable byte limit.");
    }
    const prior = await this.loadStateFile();
    let handle: FileHandle | undefined;
    let renameAttempted = false;
    try {
      try {
        handle = await open(
          temporary,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(body, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          const existing = await lstat(this.stateFilePath);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new BridgeError("UNSAFE_GATEWAY_STATE_FILE", "The gateway state target is not a regular file.");
          }
          this.assertOwnedPrivate(existing.uid, existing.mode, "state file");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        renameAttempted = true;
        await this.renameStateFile(temporary, this.stateFilePath);
        await this.afterStateFileRename?.();
        const directory = await open(this.rootDir, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!renameAttempted) throw error;
        let installed: GatewayPersistedState | undefined;
        let readbackFailed = false;
        try {
          installed = await this.loadStateFile();
        } catch {
          readbackFailed = true;
          // Rename crossed the commit point; unverifiable authority poisons this instance.
        }
        const installedCurrent =
          installed?.commit.id === state.commit.id &&
          installed.commit.sequence === state.commit.sequence;
        if (installedCurrent && installed !== undefined) {
          this.state = installed;
          return;
        }
        const installedPrior =
          !readbackFailed &&
          (prior === undefined
            ? installed === undefined
            : installed?.commit.id === prior.commit.id &&
              installed.commit.sequence === prior.commit.sequence);
        if (installedPrior) throw error;
        this.state = undefined;
        throw new PostRenamePersistenceError();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
