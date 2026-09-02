import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import type { GatewayConfig } from "./config.js";
import { peerRouteRef, type PeerCatalogResult, type PeerHandoffParams } from "./peer-protocol.js";
import { deliveryStates, directionId, gatewayActivityActions, gatewayActivityKinds,
  gatewayProviders, gatewayPublicSnapshotLimits, gatewayRegistrationIngressPrefixes,
  parseDirection, projectGatewayPublicSnapshot, routeRegistrationModes } from "./types.js";
import type { AcceptMessageInput, AcceptMessageResult, AuthorizeMessageInput,
  AuthorizeMessageResult, DeadlinePressureBucket, DedupeRecord, DeliveryState, EnqueueMessageInput,
  EnqueueMessageResult, EnqueueNativeIngressInput,
  GatewayAccounting,
  GatewayMessageActivity, GatewayMessageRecord, GatewayMessageState,
  GatewayPersistedState, GatewayPreparedWriteEvidence, GatewayPrivateRouteInspection,
  GatewayPublicSnapshot, GatewayRouteRecord, GatewayRuntimeActivity,
  GatewayStoreDependencies, InstallClaudeRouteResult, LogicalRouteBinding, MessageDirection, NormalizedMessageEvent,
  PublicGatewayActivityEvent, PublicRouteSnapshot,
  RegisterRouteInput, RemoveRouteAtomicResult, ReplaceCodexRegistrationAtomicInput,
  ReplaceCodexRegistrationAtomicResult, ReserveMessageResult, ResolvePrewriteAttemptInput,
  ResolvePrewriteAttemptResult, RouteCounters, SettleAttemptInput,
  SettleAttemptForShutdownInput, SettleAttemptForShutdownResult, SettleAttemptResult,
  SettleQueuedMessageForShutdownInput, SettleQueuedMessageForShutdownResult,
  TerminalDeliveryOutcome, TerminalMessageSettlement } from "./types.js";
const STATE_MARKER = ".agent-embassy-state";
const STATE_MARKER_CONTENT = "agent-embassy-state-v1\n";
const STATE_FILE = "gateway-state.json";
/** Static dashboard files a 2.x install may have left behind (emb-100 removed the feature; emb-106 sweeps the litter). */
const STALE_DASHBOARD_FILES = ["gateway-dashboard.html", "gateway-dashboard.zh-CN.html"] as const;
/** 2.x wrote its dashboards via temp-file + rename; a crash mid-publish could leave one of these behind too. */
const STALE_DASHBOARD_TEMP_PATTERNS = [
  /^\.gateway-dashboard\.html\.[^/]+\.tmp$/,
  /^\.gateway-dashboard\.zh-CN\.html\.[^/]+\.tmp$/,
] as const;
function isStaleDashboardArtifact(name: string): boolean {
  return (STALE_DASHBOARD_FILES as readonly string[]).includes(name) ||
    STALE_DASHBOARD_TEMP_PATTERNS.some((pattern) => pattern.test(name));
}
/**
 * Locks this store moved aside as stale, kept a week so a crash stays
 * diagnosable. The recovery time is in the name, not in the file's mtime:
 * `rename` carries the crashed lock's own timestamps across, so a broker that
 * ran for a month would have its lock swept by the very boot that recovered it.
 */
const STALE_LOCK_PATTERN = /^\.gateway-controller\.lock\.stale-(\d{13,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE_LOCK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The recovery time encoded in a stale-lock name, or undefined if this is not one. */
function staleLockRecoveredAt(name: string): number | undefined {
  const found = STALE_LOCK_PATTERN.exec(name);
  return found === null ? undefined : Number(found[1]);
}
const CONTROLLER_LOCK = ".gateway-controller.lock";
const MAX_MARKER_FILE_BYTES = 128;
const MAX_LOCK_FILE_BYTES = 4 * 1024;
export const GATEWAY_MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETAINED_BODY_BYTES = 1 * 1024 * 1024;
const ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PRIVATE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REGISTRATION_ID_PATTERN = /^reg_[A-Za-z0-9_-]{1,252}$/;
const PEER_ROUTE_HANDLE_PATTERN = /^peer:[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MESSAGE_ID_PATTERN =
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const CONVERSATION_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DELIVERY_TOKEN_PATTERN = /^dlv_[A-Za-z0-9_-]{24}$/;
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
const LOCK_HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/**
 * A machine name bounded before it is compared or handed to a client hint.
 * Both sides of the comparison pass through here, so a local hostname the
 * pattern cannot represent (a name with a space, say) is never mistaken for
 * a different machine — it is simply unverifiable on both sides.
 */
function boundedHostname(value: unknown): string | undefined {
  return typeof value === "string" && LOCK_HOSTNAME_PATTERN.test(value) ? value : undefined;
}
const lockUnverified = (): BridgeError => new BridgeError(
  "GATEWAY_STATE_LOCK_UNVERIFIED",
  "The gateway state lock exists but cannot be read as a controller record.",
);
function defaultProcessLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that means "gone"; EPERM means alive and not ours.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
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
    REGISTRATION_ID_PATTERN.test(value.binding.registrationId) &&
    typeof value.registrationMode === "string" &&
    REGISTRATION_MODES.has(value.registrationMode) &&
    (value.binding.provider !== "peer" || value.registrationMode === "federated_peer" ||
      PEER_ROUTE_HANDLE_PATTERN.test(value.binding.routeHandle)) &&
    typeof value.enabled === "boolean" &&
    value.busyPolicy === "queue" &&
    isIsoTimestamp(value.registeredAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isCounters(value.counters)
  );
}
function peerMirrorRegistrationId(host: string, routeRef: string): string {
  return `reg_peer_${createHash("sha256").update(`${host}\0${routeRef}`).digest("base64url").slice(0, 32)}`;
}
function routeModeMatchesHost(
  route: Pick<GatewayRouteRecord, "binding" | "registrationMode">,
  localHost: string | undefined,
): boolean {
  if (route.registrationMode === "federated_peer") {
    // Without a known local host there is nothing to prove the mirror foreign
    // against, so the check abstains rather than refusing. The store always
    // supplies its configured host, so the shipped path always checks.
    return localHost === undefined || route.binding.hostId !== localHost;
  }
  return route.binding.hostId === localHost && (route.binding.provider === "claude"
    ? route.registrationMode === "selected_live_peer"
    : route.registrationMode === "explicit_opt_in");
}
function isPrepared(value: unknown): value is GatewayPreparedWriteEvidence {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["kind", "bodyBytes", "bodySha256", "frameBytes", "sha256"]) &&
    (value.kind === "claude_mailbox" ||
      value.kind === "codex_turn_start" ||
      value.kind === "codex_turn_steer" ||
      value.kind === "peer_mailbox" ||
      value.kind === "peer_handoff") &&
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
  targetMode?: GatewayRouteRecord["registrationMode"],
): GatewayPreparedWriteEvidence["kind"] {
  if (targetMode === "federated_peer") return "peer_handoff";
  const target = parseDirection(message.direction)!.targetProvider;
  if (target === "claude") return "claude_mailbox";
  if (target === "peer") return "peer_mailbox";
  return message.steer === true ? "codex_turn_steer" : "codex_turn_start";
}
function isAttemptAuthority(value: Record<string, unknown>): boolean {
  return (
    typeof value.attemptId === "string" &&
    isPrivateToken(value.attemptId) &&
    isPositiveInteger(value.attemptCount) &&
    typeof value.targetRegistrationId === "string" &&
    isPrivateToken(value.targetRegistrationId) &&
    isPrivateToken(value.sourceRegistrationId)
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
        "sourceRegistrationId", "reservedAt"]) &&
      isAttemptAuthority(value) &&
      isIsoTimestamp(value.reservedAt)
    );
  }
  if (value.phase === "armed") {
    return (
      hasOnlyKeys(value, ["phase", "attemptId", "attemptCount", "targetRegistrationId",
        "sourceRegistrationId", "armedAt", "prepared"]) &&
      isAttemptAuthority(value) &&
      isIsoTimestamp(value.armedAt) &&
      isPrepared(value.prepared)
    );
  }
  if (value.phase === "accepted") {
    return (
      hasOnlyKeys(value, ["phase", "attemptId", "attemptCount", "targetRegistrationId",
        "sourceRegistrationId", "acceptedAt", "prepared", "lossOutcome"]) &&
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
        "targetRegistrationId", "state"],
      ["conversationIdSuffix", "deliveryToken", "body", "steer"],
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
    (value.steer === undefined || value.steer === true) &&
    isPrivateToken(value.sourceRegistrationId) &&
    (value.targetRegistrationId === null ||
      isPrivateToken(value.targetRegistrationId)) &&
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
      ["conversationIdSuffix"],
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
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix)))
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
function isMessageActivity(value: unknown): value is GatewayMessageActivity {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["type", "event"]) &&
    value.type === "message_activity" &&
    isNormalizedEvent(value.event)
  );
}
/**
 * `configuredHost` is the broker's own host identity, known at construction and
 * always supplied on the shipped path. Deriving the local host from the routes
 * alone is not sufficient: a federation node whose only routes are mirrors has
 * no local route to derive from, and a state file it just wrote would fail its
 * own validator on the next persist.
 */
export function isGatewayPersistedStateV5(
  value: unknown, configuredHost?: string,
): value is GatewayPersistedState {
  if (
    !isObject(value) ||
    // Exact keys: a file that still carries the retired `consentEdges` key is
    // refused here as a corrupt document; the documented recovery is a reset.
    !hasOnlyKeys(value, ["schemaVersion", "commit", "createdAt", "updatedAt", "eventSequence",
      "routes", "messages", "dedupe", "rateBuckets", "activity", "accounting"]) ||
    value.schemaVersion !== 5 ||
    !isObject(value.commit) ||
    !hasOnlyKeys(value.commit, ["sequence", "id"]) ||
    !isNonNegativeInteger(value.commit.sequence) ||
    !isPrivateToken(value.commit.id) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isNonNegativeInteger(value.eventSequence) ||
    !Array.isArray(value.routes) ||
    !value.routes.every(isRoute) ||
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
      (entry) => isMessageActivity(entry) || isRuntimeActivity(entry),
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
  const localHosts = new Set(state.routes
    .filter((route) => route.registrationMode !== "federated_peer")
    .map((route) => route.binding.hostId));
  if (localHosts.size > 1) return false;
  // The configured host is authority; a local route's own hostId is checked
  // against it in the loop below, so the derived host is only the fallback for
  // a caller that has no configured identity to offer.
  const localHost = configuredHost ?? [...localHosts][0];
  for (const route of state.routes) {
    if (
      !route.alias.endsWith(`@${route.binding.hostId}`) ||
      !routeModeMatchesHost(route, localHost)
    ) {
      return false;
    }
    const prefix = gatewayRegistrationIngressPrefixes[route.binding.provider];
    if (prefix !== undefined && !route.alias.startsWith(prefix)) return false;
  }
  for (const message of active) {
    const target = routesByAlias.get(message.targetAlias);
    const source = routesByAlias.get(message.sourceAlias);
    const direction = parseDirection(message.direction)!;
    if (
      message.targetRegistrationId === null ||
      target?.binding.registrationId !== message.targetRegistrationId ||
      target.binding.provider !== direction.targetProvider ||
      source?.binding.registrationId !== message.sourceRegistrationId ||
      source.binding.provider !== direction.sourceProvider ||
      (source.binding.hostId === target.binding.hostId &&
        source.binding.provider === target.binding.provider)
    ) {
      return false;
    }
    if (
      (message.state.phase === "reserved" ||
        message.state.phase === "armed" ||
        message.state.phase === "accepted") &&
      (message.state.sourceRegistrationId !== message.sourceRegistrationId ||
        message.state.targetRegistrationId !== message.targetRegistrationId)
    ) {
      return false;
    }
    if (
      (message.state.phase === "armed" ||
        message.state.phase === "accepted") &&
      (message.state.prepared.kind !== expectedPreparedKind(message, target?.registrationMode) ||
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
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly hostname: () => string;
  private persistenceDeferred = false;
  constructor(config: GatewayConfig, dependencies: GatewayStoreDependencies = {}) {
    this.config = config;
    this.rootDir = path.resolve(config.stateDir);
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.renameStateFile = dependencies.renameStateFile ?? rename;
    this.afterStateFileRename = dependencies.afterStateFileRename;
    this.isProcessAlive = dependencies.isProcessAlive ?? defaultProcessLiveness;
    this.hostname = dependencies.hostname ?? (() => os.hostname());
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
          schemaVersion: 5,
          commit: { sequence: 0, id: this.randomId() },
          createdAt: now.toISOString(), updatedAt: now.toISOString(),
          eventSequence: 0, routes: [],
          messages: [],
          dedupe: [], rateBuckets: [],
          activity: [], accounting: emptyAccounting(),
        };
        this.assertConfiguredBounds(this.state);
        await this.removeStateDirectoryLitter(this.rootDir);
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
  async reconcilePeerCatalog(peerHost: string, catalog: PeerCatalogResult): Promise<Readonly<{
    settlements: readonly TerminalMessageSettlement[]; routes: readonly GatewayPrivateRouteInspection[];
  }>> {
    return this.mutate((state, now) => {
      const localHost = this.config.hostId;
      if (!this.config.allowedHosts.includes(peerHost) || peerHost === localHost ||
        !catalog.complete || catalog.truncated || catalog.routes.some((route) => route.host !== peerHost)) {
        throw new BridgeError("INVALID_PEER_CATALOG", "The peer catalog is not an exact complete projection for this configured host.");
      }
      const desired = new Map(catalog.routes.map((route) => [route.ref, route]));
      const existing = state.routes.filter((route) => route.registrationMode === "federated_peer" && route.binding.hostId === peerHost);
      const settlements: TerminalMessageSettlement[] = [];
      for (const route of existing) {
        const row = desired.get(route.binding.routeHandle);
        if (row !== undefined && row.provider === route.binding.provider) continue;
        settlements.push(...this.terminalizeRegistration(state, route.binding.registrationId, now));
        this.removeRegistrationMetadata(state, route);
      }
      for (const row of catalog.routes) {
        let route = state.routes.find((candidate) => candidate.registrationMode === "federated_peer" &&
          candidate.binding.hostId === peerHost && candidate.binding.routeHandle === row.ref &&
          candidate.binding.provider === row.provider);
        const collision = state.routes.find((candidate) => candidate.alias === row.alias && candidate !== route);
        if (collision !== undefined) throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "A peer catalog alias conflicts with current local authority.");
        if (route === undefined) {
          if (state.routes.length >= this.config.limits.maxRoutes) throw new BridgeError("ROUTE_CAPACITY_REACHED", "The bounded logical route inventory is full.", true);
          const input: RegisterRouteInput = { alias: row.alias, registrationMode: "federated_peer",
            binding: { provider: row.provider, hostId: peerHost, routeHandle: row.ref,
              registrationId: peerMirrorRegistrationId(peerHost, row.ref) } };
          route = routeRecord(input, now); state.routes.push(route);
        } else if (route.alias !== row.alias) {
          this.renameRegistrationCoordinates(state, route.alias, row.alias, route.binding.registrationId);
          route.alias = row.alias;
        }
        route.enabled = row.enabled; route.updatedAt = now.toISOString();
      }
      return { settlements, routes: state.routes.filter((route) => route.registrationMode === "federated_peer" &&
        route.binding.hostId === peerHost).map((route) => ({ alias: route.alias, binding: { ...route.binding },
          registrationMode: route.registrationMode, enabled: route.enabled })) };
    });
  }
  async enqueuePeerHandoff(peerHost: string, handoff: PeerHandoffParams): Promise<EnqueueMessageResult> {
    return this.mutate((state, now) => {
      const localHost = this.config.hostId;
      // A handoff is authorized by the sending host's nodes.json membership
      // (checked by the service before this call) plus exact alias addressing
      // to a mirrored source and a local, enabled target.
      if (!this.config.allowedHosts.includes(peerHost) || peerHost === localHost || handoff.source.host !== peerHost ||
        handoff.target.host !== localHost)
        throw new BridgeError("INVALID_PEER_HANDOFF", "The peer handoff does not match this configured direct link.");
      const source = state.routes.find((route) => route.registrationMode === "federated_peer" && route.binding.hostId === peerHost &&
        route.alias === handoff.source.alias && route.binding.provider === handoff.source.provider && route.binding.routeHandle === handoff.source.routeRef);
      const target = state.routes.find((route) => route.registrationMode !== "federated_peer" && route.binding.hostId === localHost &&
        route.alias === handoff.target.alias && route.binding.provider === handoff.target.provider &&
        peerRouteRef(localHost, route.binding.registrationId) === handoff.target.routeRef && route.enabled);
      if (source === undefined || target === undefined) throw new BridgeError("ROUTE_UNREGISTERED", "The peer handoff endpoint is no longer current.");
      return this.enqueueResolved(state, now, { body: handoff.body, dedupeKey: `${peerHost}:${handoff.originMessageId}`,
        deadlineAt: handoff.deadlineAt, ...(handoff.conversationCorrelation === undefined ? {} :
          { conversationIdSuffix: handoff.conversationCorrelation }), ...(handoff.steer === true ? { steer: true as const } : {}) },
      { sourceAlias: source.alias, targetAlias: target.alias, direction: directionId(source.binding.provider, target.binding.provider),
        sourceRegistrationId: source.binding.registrationId, targetRegistrationId: target.binding.registrationId,
        exposeDeliveryToken: false });
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
      if (route.registrationMode === "federated_peer") {
        throw new BridgeError("FEDERATED_ROUTE_READ_ONLY", "A federated route is owned by its peer node; only catalog reconciliation may retire it.");
      }
      if (input.activity !== undefined && route.binding.provider !== "codex") {
        throw new BridgeError("INVALID_ROUTE_BINDING", "Only exact Codex unregister has public activity.");
      }
      const settlements = this.terminalizeRegistration(
        state,
        route.binding.registrationId,
        now,
      );
      this.removeRegistrationMetadata(state, route);
      if (input.activity !== undefined) {
        this.appendRuntimeActivity(state, now, {
          kind: "registration", action: "codex_unregistered",
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
  /**
   * Installs the route of a discovered Claude session on its first send, or
   * brings an existing route up to date with discovery. The (host, session
   * UUID) pair is the identity: a session already bound keeps its
   * registration (and its in-flight conversations) and is renamed if its
   * current name changed; a route whose alias now names a different session
   * is displaced, its work settled `cancelled/ENDPOINT_RETIRED`. Both
   * outcomes are journaled so `embassy status` can show them. Installation
   * never creates a permission: same-UID, same-host addressing already is
   * the permission, and the service's alias-collision fence has already run.
   */
  async installClaudeRoute(
    replacement: RegisterRouteInput,
  ): Promise<InstallClaudeRouteResult> {
    return this.mutate((state, now) => {
      this.validateRouteInput(replacement);
      if (replacement.binding.provider !== "claude") {
        throw new BridgeError("INVALID_ROUTE_BINDING", "Only a Claude logical route installs on first send.");
      }
      const byAlias = state.routes.find(
        (route) => route.alias === replacement.alias,
      );
      const byRegistration = state.routes.find(
        (route) =>
          route.binding.registrationId === replacement.binding.registrationId,
      );
      const byIdentity = state.routes.find(
        (route) =>
          route.binding.provider === "claude" &&
          route.binding.hostId === replacement.binding.hostId &&
          route.binding.routeHandle === replacement.binding.routeHandle,
      );
      if (byRegistration !== undefined && byRegistration !== byIdentity) {
        throw new BridgeError("ROUTE_IDENTITY_ALREADY_REGISTERED", "The Claude registration ID and native session do not identify one route.");
      }
      if (
        byIdentity !== undefined &&
        byIdentity.binding.registrationId !== replacement.binding.registrationId
      ) {
        throw new BridgeError("ROUTE_IDENTITY_ALREADY_REGISTERED", "The native Claude session is already registered under another identity.");
      }
      const settlements: TerminalMessageSettlement[] = [];
      if (byAlias !== undefined && byAlias !== byIdentity) {
        if (byAlias.binding.provider !== "claude" || byAlias.registrationMode === "federated_peer") {
          throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "The alias belongs to a route that a Claude session cannot displace.");
        }
        settlements.push(...this.terminalizeRegistration(
          state, byAlias.binding.registrationId, now, "ENDPOINT_RETIRED",
        ));
        this.removeRegistrationMetadata(state, byAlias);
        this.appendRuntimeActivity(state, now, {
          kind: "registration", action: "claude_route_retired",
          outcome: "accepted", aliases: [byAlias.alias], operatorAction: true,
        });
      }
      if (byIdentity === undefined) {
        if (state.routes.length >= this.config.limits.maxRoutes) {
          throw new BridgeError("ROUTE_CAPACITY_REACHED", "The bounded logical route inventory is full.", true);
        }
        state.routes.push(routeRecord(replacement, now));
        this.appendRuntimeActivity(state, now, {
          kind: "registration", action: "claude_route_installed",
          outcome: "accepted", aliases: [replacement.alias], operatorAction: true,
        });
        return { installed: true, settlements };
      }
      const priorAlias = byIdentity.alias;
      if (priorAlias !== replacement.alias) {
        this.renameRegistrationCoordinates(
          state, priorAlias, replacement.alias, byIdentity.binding.registrationId,
        );
        byIdentity.alias = replacement.alias;
        this.appendRuntimeActivity(state, now, {
          kind: "registration", action: "claude_route_installed",
          outcome: "accepted", aliases: [priorAlias, replacement.alias], operatorAction: true,
        });
      }
      byIdentity.enabled = true;
      byIdentity.updatedAt = now.toISOString();
      return { installed: priorAlias !== replacement.alias, settlements };
    });
  }
  /**
   * The refusal half of admission, without the write. A send to a Claude
   * session that has no route yet would otherwise install one — displacing
   * another session and settling its queued work — on its way to being
   * refused for its own reasons: too large, past the deadline window, rate
   * limited, or into a full queue. Callers that are about to materialize a
   * route run this first and materialize only if it returns.
   *
   * The refusal is still journaled, because a rejection is a fact about a real
   * attempt; nothing else is written, and the authoritative checks still run
   * inside `enqueueMessage` itself. `dedupeKey` is optional: a first send's key
   * is broker-generated and cannot collide, and omitting it keeps this from
   * inventing one to test against.
   */
  async assertEnqueueAdmissible(
    input: Readonly<{
      sourceAlias: string; targetAlias: string; direction: MessageDirection;
      sourceRegistrationId: string; body: string; dedupeKey?: string;
      conversationIdSuffix?: string; deadlineAt?: string; steer?: true;
    }>,
  ): Promise<void> {
    const bytes = Buffer.byteLength(typeof input.body === "string" ? input.body : "", "utf8");
    const refusal = await this.read((state) => {
      const now = this.now();
      if (bytes > this.config.limits.maxMessageBytes) return "MESSAGE_TOO_LARGE" as const;
      const deadlineAt = input.deadlineAt ??
        new Date(now.getTime() + this.config.limits.messageDeadlineMs).toISOString();
      if (!isIsoTimestamp(deadlineAt) || Date.parse(deadlineAt) <= now.getTime() ||
        Date.parse(deadlineAt) > now.getTime() + this.config.limits.messageDeadlineMs) {
        return "INVALID_DEADLINE" as const;
      }
      // Read-only rate probe: the real enqueue consumes the token, this only
      // asks whether one is available.
      const bucket = state.rateBuckets.find((row) => row.sourceAlias === input.sourceAlias);
      const windowOpen = bucket === undefined ||
        now.getTime() - Date.parse(bucket.windowStartedAt) >= this.config.limits.rateWindowMs;
      if (windowOpen
        ? state.rateBuckets.filter((row) => row.sourceAlias !== input.sourceAlias).length >=
          this.config.limits.maxRoutes
        : bucket.count >= this.config.limits.rateLimitPerRoute) {
        return "GATEWAY_RATE_LIMITED" as const;
      }
      const active = state.messages.filter((message) => message.state.phase !== "terminal");
      if (active.length >= this.config.limits.maxQueueMessages ||
        active.filter((message) => message.targetAlias === input.targetAlias).length >=
          this.config.limits.maxQueueMessagesPerRoute ||
        state.accounting.queuedBytes + bytes > this.config.limits.maxQueueBytes) {
        return "GATEWAY_QUEUE_FULL" as const;
      }
      return undefined;
    });
    if (refusal === undefined) return;
    await this.mutate((state, now) => {
      this.recordRejection(state, { sourceAlias: input.sourceAlias, targetAlias: input.targetAlias,
        direction: input.direction, sourceRegistrationId: input.sourceRegistrationId,
        targetRegistrationId: input.sourceRegistrationId },
      bytes, now, refusal, input);
    });
    throw new BridgeError(refusal,
      refusal === "MESSAGE_TOO_LARGE" ? "The message exceeds the configured byte bound."
        : refusal === "INVALID_DEADLINE" ? "The message deadline must fall inside the configured delivery window."
          : refusal === "GATEWAY_RATE_LIMITED" ? "The source exceeded the bounded gateway rate window."
            : "The bounded gateway queue is full.",
      refusal === "GATEWAY_RATE_LIMITED" || refusal === "GATEWAY_QUEUE_FULL");
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
      if (
        source.binding.provider === target.binding.provider &&
        source.binding.hostId === target.binding.hostId
      ) {
        throw new BridgeError("ROUTE_DIRECTION_MISMATCH", "Messages route only between different providers or between configured hosts.");
      }
      return this.enqueueResolved(state, now, input, {
        sourceAlias: source.alias, targetAlias: target.alias,
        direction: directionId(source.binding.provider, target.binding.provider),
        sourceRegistrationId: source.binding.registrationId, targetRegistrationId: target.binding.registrationId,
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
      const nativeSourceHost = target.registrationMode === "federated_peer"
        ? this.config.hostId : target.binding.hostId;
      if (
        input.source.binding.provider !== "claude" ||
        input.source.binding.hostId !== nativeSourceHost ||
        input.source.alias.endsWith(`@${nativeSourceHost}`) === false
      ) {
        throw new BridgeError("INVALID_NATIVE_PEER", "The native Claude sender does not match the target host.");
      }
      // The sender's own route was installed by the service on this send;
      // the exact binding fences a same-alias replacement that raced it.
      const source = state.routes.find(
        (route) =>
          route.alias === input.source.alias &&
          route.enabled &&
          route.binding.provider === "claude" &&
          route.binding.routeHandle === input.source.binding.routeHandle &&
          route.binding.registrationId === input.source.binding.registrationId,
      );
      if (source === undefined) {
        throw new BridgeError("ROUTE_UNREGISTERED", "The native Claude sender's route is no longer current.");
      }
      if (
        source.binding.provider === target.binding.provider &&
        source.binding.hostId === target.binding.hostId
      ) {
        throw new BridgeError("ROUTE_DIRECTION_MISMATCH", "Messages route only between different providers or between configured hosts.");
      }
      return this.enqueueResolved(state, now, input, {
        sourceAlias: source.alias, targetAlias: target.alias,
        direction: directionId("claude", target.binding.provider),
        sourceRegistrationId: source.binding.registrationId,
        targetRegistrationId: target.binding.registrationId,
        exposeDeliveryToken: false,
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
        targetRegistrationId: message.targetRegistrationId,
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
          bytes: message.bytes,
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
      const target = state.routes.find(
        (route) =>
          route.alias === message.targetAlias &&
          route.binding.registrationId === message.targetRegistrationId &&
          route.enabled,
      );
      if (
        !isPrepared(input.prepared) ||
        input.prepared.kind !== expectedPreparedKind(message, target?.registrationMode) ||
        input.prepared.bodyBytes !== message.bytes ||
        input.prepared.bodySha256 !== bodySha256
      ) {
        throw new BridgeError("INVALID_PREPARED_WRITE_EVIDENCE", "The prepared payload evidence does not match the admitted message.");
      }
      if (
        input.sourceRegistrationId !== message.sourceRegistrationId ||
        input.targetRegistrationId !== message.targetRegistrationId ||
        target === undefined
      ) {
        return { status: "stale", reason: "registration_changed" };
      }
      const source = state.routes.find(
        (route) =>
          route.alias === message.sourceAlias &&
          route.binding.registrationId === message.sourceRegistrationId &&
          route.enabled,
      );
      if (source === undefined) {
        return { status: "stale", reason: "registration_changed" };
      }
      const authority = message.state;
      message.state = {
        phase: "armed", attemptId: authority.attemptId,
        attemptCount: authority.attemptCount, targetRegistrationId: authority.targetRegistrationId,
        sourceRegistrationId: authority.sourceRegistrationId,
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
        sourceRegistrationId: authority.sourceRegistrationId,
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
              !(input.safeErrorCode === "PEER_HANDOFF_ACCEPTANCE_UNCONFIRMED" && message.state.prepared.kind === "peer_handoff")))) ||
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
          mutable: route.registrationMode !== "federated_peer",
        };
      });
      const currentEvents = state.messages.map((message) =>
        this.projectMessageEvent(message),
      );
      const messageEvents = state.activity
        .filter(
          (entry): entry is GatewayMessageActivity =>
            entry.type === "message_activity",
        )
        .map((entry) => structuredClone(entry.event));
      const activityEvents = state.activity
        .filter(
          (entry): entry is GatewayRuntimeActivity => entry.type === "activity",
        )
        .map((entry) => structuredClone(entry.event));
      const messages = [...messageEvents, ...currentEvents]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-gatewayPublicSnapshotLimits.messages);
      const pressureBuckets: DeadlinePressureBucket[] = [
        { bucket: "under_1m", settled: 0, expired: 0 },
        { bucket: "1m_to_5m", settled: 0, expired: 0 },
        { bucket: "5m_to_15m", settled: 0, expired: 0 },
        { bucket: "15m_to_60m", settled: 0, expired: 0 },
        { bucket: "over_60m", settled: 0, expired: 0 },
      ];
      const terminalEvidence = messages.filter((event) =>
        event.latencyMs !== undefined && ["delivered", "unconfirmed", "failed", "ambiguous",
          "expired", "cancelled", "abandoned"].includes(event.state));
      for (const event of terminalEvidence) {
        const latency = event.latencyMs ?? 0;
        const index = latency < 60_000 ? 0 : latency < 300_000 ? 1 :
          latency < 900_000 ? 2 : latency < 3_600_000 ? 3 : 4;
        pressureBuckets[index]!.settled += 1;
        if (event.state === "expired") pressureBuckets[index]!.expired += 1;
      }
      return projectGatewayPublicSnapshot({
        schemaVersion: 2, generatedAt: now.toISOString(),
        health: "offline",
        connectors: [], availablePeers: [],
        routes,
        activityEvents,
        deadlinePressure: {
          configuredDeadlineMs: this.config.limits.messageDeadlineMs,
          ...(messages[0]?.timestamp === undefined
            ? {}
            : { retainedSince: messages[0].timestamp }),
          terminalEvents: terminalEvidence.length,
          expiredEvents: terminalEvidence.filter((event) => event.state === "expired").length,
          buckets: pressureBuckets,
        },
        messages,
        accounting: { ...state.accounting }, alerts: [],
        truncation: {
          connectors: 0, availablePeers: 0,
          routes: 0,
          activityEvents: 0,
          messages: Math.max(
            0,
            messageEvents.length + currentEvents.length - messages.length,
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
    const localHost = this.config.hostId;
    if (
      !isObject(input) ||
      !ALIAS_PATTERN.test(input.alias) ||
      !isLogicalBinding(input.binding) ||
      !REGISTRATION_ID_PATTERN.test(input.binding.registrationId) ||
      !REGISTRATION_MODES.has(input.registrationMode) ||
      (input.binding.provider === "peer" && input.registrationMode !== "federated_peer" &&
        !PEER_ROUTE_HANDLE_PATTERN.test(input.binding.routeHandle)) ||
      !input.alias.endsWith(`@${input.binding.hostId}`) ||
      !this.config.allowedHosts.includes(input.binding.hostId) ||
      !routeModeMatchesHost(input, localHost)
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
  private enqueueResolved(
    state: GatewayPersistedState, now: Date,
    input: Omit<EnqueueMessageInput, "sourceAlias" | "targetAlias">,
    authority: Readonly<{
      sourceAlias: string;
      targetAlias: string;
      direction: MessageDirection;
      sourceRegistrationId: string;
      targetRegistrationId: string;
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
      ...(input.steer === true ? { steer: true as const } : {}),
      sourceRegistrationId: authority.sourceRegistrationId, targetRegistrationId: authority.targetRegistrationId,
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
    state.dedupe.push({
      fingerprint,
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      sourceAlias: authority.sourceAlias, targetAlias: authority.targetAlias,
      direction: authority.direction,
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
      sourceRegistrationId: string;
      targetRegistrationId: string;
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
    const suffix = this.randomId().replaceAll("-", "").slice(-8).toLowerCase();
    if (!MESSAGE_SUFFIX_PATTERN.test(suffix)) return;
    state.eventSequence += 1;
    state.activity.push({
      type: "message_activity",
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
    const handedOff = outcome === "delivered" &&
      (message.state.phase === "armed" || message.state.phase === "accepted") &&
      message.state.prepared.kind === "peer_handoff";
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
    if (handedOff) delete message.body;
    state.accounting[outcome] += 1;
    const target = state.routes.find(
      (route) => route.binding.registrationId === message.targetRegistrationId,
    );
    if (target !== undefined) target.counters[outcome] += 1;
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
    now: Date, cancelledCode: "ROUTE_UNREGISTERED" | "ENDPOINT_RETIRED" = "ROUTE_UNREGISTERED",
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
            ? cancelledCode
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
    for (const message of state.messages) {
      if (message.sourceRegistrationId === registrationId) {
        message.sourceAlias = newAlias;
      }
      if (message.targetRegistrationId === registrationId) {
        message.targetAlias = newAlias;
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
        (route) => !this.config.allowedHosts.includes(route.binding.hostId) ||
          !routeModeMatchesHost(route, this.config.hostId),
      ) ||
      state.routes.length > this.config.limits.maxRoutes ||
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
      if (existed && entries.some((entry) => entry !== "nodes.json")) {
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
  /**
   * Boot-time litter sweep (emb-106): the static `gateway-dashboard*.html`
   * files 2.x published, any `.tmp` file its temp-file+rename publish could
   * have left behind mid-crash, and controller locks this store recovered as
   * stale more than seven days ago, are unlinked best-effort. Only a
   * regular file owned by this uid is removed (lstat, no symlink following);
   * nothing else in the state directory is touched, and a removal failure
   * never blocks startup. Runs only after the controller lock is held and
   * the state this boot will run on has passed both its schema check and
   * assertConfiguredBounds, so a refused boot leaves the directory exactly
   * as found.
   */
  private async removeStateDirectoryLitter(root: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const now = this.now().getTime();
    for (const name of entries) {
      const dashboard = isStaleDashboardArtifact(name);
      const recoveredAt = dashboard ? undefined : staleLockRecoveredAt(name);
      if (!dashboard && recoveredAt === undefined) continue;
      const filePath = path.join(root, name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(filePath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile() || (uid !== undefined && info.uid !== uid)) continue;
      // A recovered lock is evidence: keep it a week from the recovery that
      // created it, which is what its name records.
      if (recoveredAt !== undefined && now - recoveredAt <= STALE_LOCK_RETENTION_MS) continue;
      try {
        await unlink(filePath);
        process.stderr.write(dashboard
          ? `[embassy] removed stale ${name} left by an earlier Embassy release from the gateway state directory\n`
          : `[embassy] removed ${name}, a recovered gateway lock older than seven days\n`);
      } catch {
        // Best-effort cleanup; leave the file in place if it cannot be removed.
      }
    }
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
  /**
   * Move a lock nobody owns aside instead of deleting it: a crash stays
   * diagnosable for a week (the boot sweep ages these out), and the caller
   * is told, because a silent recovery of another process's lock would be
   * the one event an operator most needs to see.
   */
  private async recoverStaleLock(lockPath: string, description: string): Promise<void> {
    const name = `${CONTROLLER_LOCK}.stale-${String(this.now().getTime())}-${randomUUID()}`;
    const moved = await rename(lockPath, path.join(this.rootDir, name)).then(() => true, (error: unknown) => {
      // Another start recovered it first; retry the create either way.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
    if (moved) process.stderr.write(`[embassy] recovered a stale gateway lock (${description}) → ${name}\n`);
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
              hostname: this.hostname(),
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
      let body: string;
      try {
        body = await this.readPrivateFile(lockPath, MAX_LOCK_FILE_BYTES);
      } catch {
        throw lockUnverified();
      }
      // A crash between the O_EXCL create and the write leaves a zero-byte
      // lock. It records no owner at all, so it can only be the corpse of a
      // start that never began: recover it rather than wedging on it.
      if (body.trim().length === 0) {
        await this.recoverStaleLock(lockPath, "empty, left by an interrupted start");
        continue;
      }
      let owner: { pid?: unknown; hostname?: unknown };
      try {
        owner = JSON.parse(body) as { pid?: unknown; hostname?: unknown };
      } catch {
        throw lockUnverified();
      }
      // Parsed, but naming no process: there is nothing to probe and nothing
      // to claim about it, so this is unverified like any other unreadable
      // record — never "another broker may own this".
      if (!isPositiveInteger(owner.pid)) throw lockUnverified();
      // Recovery is decided by process liveness alone; the recorded hostname
      // is informational. A machine that renames itself — a network-triggered
      // rename, a restore onto new hardware — must not wedge its own state
      // directory forever, so a dead pid is stale whatever name wrote it.
      const recorded = boundedHostname(owner.hostname);
      const pid = String(owner.pid);
      // A name this cannot represent is not reported as a name: the client
      // hint drops the whole clause rather than printing a placeholder.
      const detail = recorded === undefined ? { pid } : { host: recorded, pid };
      if (this.isProcessAlive(owner.pid)) {
        // The pid is alive, but nothing here can tell whether it is a broker:
        // pid numbers are reused, and a renamed machine records its old name.
        // Refuse, and hand the client the bounded facts its hint needs.
        const mine = boundedHostname(this.hostname());
        const message = recorded !== undefined && mine !== undefined && recorded === mine
          ? `A live process (pid ${pid}) recorded on this machine owns this gateway state directory.`
          : recorded === undefined
            ? `The gateway state lock records pid ${pid} under a machine name that cannot be verified, and a process with that pid is alive here.`
            : `The gateway state lock records host ${recorded} and pid ${pid}, and a process with that pid is alive here.`;
        throw new BridgeError("GATEWAY_STATE_IN_USE", message, true, detail);
      }
      await this.recoverStaleLock(lockPath,
        recorded === undefined ? `pid ${pid}, machine name unverifiable` : `recorded host ${recorded}, pid ${pid}`);
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
    if (isObject(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 5) {
      throw new BridgeError(
        "GATEWAY_STATE_SCHEMA_UNSUPPORTED",
        "The gateway state schema is unsupported. Stop Embassy, move gateway-state.json aside — nodes.json, if you use federation, is untouched — then restart and re-register Codex tasks.",
      );
    }
    if (!isGatewayPersistedStateV5(parsed, this.config.hostId)) {
      // A document that is a valid v5 state on its own terms but not under this
      // broker's host identity is not corrupt: it belongs to another host, and
      // the operator deserves that sentence rather than "failed validation".
      throw isGatewayPersistedStateV5(parsed)
        ? new BridgeError("CORRUPT_GATEWAY_STATE", "The gateway state exceeds its configured bounds or host allowlist.")
        : new BridgeError("CORRUPT_GATEWAY_STATE", "The gateway controller state failed strict v5 schema validation.");
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
