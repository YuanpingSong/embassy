import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import { isCodexRegistrationGeneration } from "./codex-registration-generation.js";
import type { GatewayConfig } from "./config.js";
import {
  PROGRESS_WATCH_DEFAULT_CAPACITY,
  PROGRESS_WATCH_HARD_CAPACITY,
  PROGRESS_WATCH_MAX_IDLE_MS,
  PROGRESS_WATCH_MIN_IDLE_MS,
  commitProgressWatchNudge,
  createProgressWatch,
  deferProgressWatchNudge,
  inspectProgressWatchDue,
  progressWatchJournalKinds,
  recordProgressWatchActivity,
  type ProgressWatch,
  type ProgressWatchJournalEvent,
  type ProgressWatchSettlement,
} from "./progress-watch-machine.js";
import {
  CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY,
  CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY,
  CONNECTOR_OBSERVATION_STALE_AFTER_MS,
  connectorHealthStates,
  directionId,
  deliveryStates,
  gatewayPublicSnapshotLimits,
  gatewayProviders,
  gatewayRegistrationIngressPrefixes,
  messageDirections,
  parseDirection,
  projectGatewayPublicSnapshot,
  routeRegistrationModes,
  routeStates,
  type ConnectorRecord,
  type CodexEndpointRefreshJournalEvent,
  type CodexOrphanRemovalJournalEvent,
  type DeadlinePressureBucket,
  type DedupeRecord,
  type DeliveryState,
  type EnqueueMessageInput,
  type EnqueueMessageResult,
  type EnqueueNativeIngressInput,
  type EnqueueNativeReplyInput,
  type GatewayAccounting,
  type GatewayConsentEdgeRecord,
  type GatewayConsentEndpoint,
  type GatewayProvider,
  type GatewayPersistedState,
  type GatewayPrivateRouteInspection,
  type GatewayPublicSnapshot,
  type GatewayRouteRecord,
  type GatewayStoreDependencies,
  type InFlightMessageMetadata,
  type InFlightMessageProgressState,
  type MessageDirection,
  type NormalizedMessageEvent,
  type ObserveConnectorInput,
  type ObserveRouteInput,
  type PrivateEndpointIdentity,
  type PrivateRouteBinding,
  type PublicConnectorSnapshot,
  type PublicConsentEdgeSnapshot,
  type PublicProgressWatchEventSnapshot,
  type PublicProgressWatchSnapshot,
  type PublicRouteSnapshot,
  type QueuedMessageMetadata,
  type ReanchorCodexRoutesInput,
  type ReanchorCodexRoutesResult,
  type RebindStaleRouteInput,
  type RegisterRouteInput,
  type RequeueInFlightMessageResult,
  type RouteCounters,
  type RemoveStaleCodexOrphanInput,
  type RemoveStaleCodexOrphanResult,
  type SafeGatewayAlert,
  type SettleMessageInput,
  type SettleMessageResult,
  type StaleCodexOrphanRemovalAuthority,
  type StaleCodexOrphanRemovalCommitProofInput,
  type TerminalMessageSettlement,
  type TransientNativeClaudePeer,
  type TransientQueuedMessage,
} from "./types.js";

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
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTOCOL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const MESSAGE_ID_PATTERN =
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{16,64}$/;
const CONVERSATION_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class PostRenamePersistenceError extends BridgeError {
  constructor(verified: boolean) {
    super(
      "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
      verified
        ? "The gateway state rename was installed, but directory durability could not be confirmed. The exact installed state was retained; retry is forbidden until recovery is reconciled."
        : "The gateway state rename was installed, but the exact installed state could not be verified. The controller was disabled and must be recovered before reuse.",
    );
    this.name = "PostRenamePersistenceError";
  }
}

const PROVIDERS = new Set<string>(gatewayProviders);
const CONNECTOR_HEALTH = new Set<string>(connectorHealthStates);
const ROUTE_STATES = new Set<string>(routeStates);
const REGISTRATION_MODES = new Set<string>(routeRegistrationModes);
const DIRECTIONS = new Set<string>(messageDirections);
const DELIVERY_STATES = new Set<string>(deliveryStates);
const PROGRESS_WATCH_JOURNAL_KINDS = new Set<string>(
  progressWatchJournalKinds,
);

type PendingProgressWatchJournalEvent =
  ProgressWatchJournalEvent extends infer Event
    ? Event extends ProgressWatchJournalEvent
      ? Omit<Event, "sequence">
      : never
    : never;

type ProgressWatchNudge = Readonly<{
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  nudgeNumber: 1 | 2;
}>;

export type SettleQueuedMessageInput = {
  messageId: string;
  state: Extract<
    DeliveryState,
    "failed" | "expired" | "cancelled" | "abandoned"
  >;
  safeErrorCode?: string;
};

export type SettleQueuedMessageResult =
  | {
      status: "settled";
      settlement: TerminalMessageSettlement;
    }
  | {
      status: "not_queued";
    };

export type AffectedInFlightMessageInspection = Readonly<{
  messageId: string;
  deadlineAt: string;
}>;

export type RouteInFlightSettlementInput = Readonly<{
  messageId: string;
  state: SettleMessageInput["state"];
  safeErrorCode?: string;
}>;

export type ReplaceClaudeSelectionInput = Readonly<{
  replacement: RegisterRouteInput;
  inFlightSettlements?: readonly RouteInFlightSettlementInput[];
}>;

export type GatewayConsentEdgeInput = Readonly<{
  aliases: readonly [string, string];
}>;

export type RemoveConsentEdgeInput = GatewayConsentEdgeInput &
  Readonly<{
    inFlightSettlements?: readonly RouteInFlightSettlementInput[];
  }>;

export type RemoveConsentEdgeResult = Readonly<{
  settlements: readonly TerminalMessageSettlement[];
  unreferencedAliases: readonly string[];
}>;

export const codexSuccessionJournalStages = [
  "prepared",
  "publication_armed",
  "published",
  "activated",
  "recovery_forbidden",
] as const;

export type CodexSuccessionJournalStage =
  (typeof codexSuccessionJournalStages)[number];

export type CodexSuccessionStoreIdentity = Readonly<{
  alias: string;
  threadId: string;
  hostId: string;
  /** Opaque exact ownership/listener generation; never interpreted as a path. */
  generation: string;
  /** Existing private route metadata only; never publicly projected. */
  binding: PrivateRouteBinding;
}>;

type CodexSuccessionJournal = Readonly<{
  schemaVersion: 1;
  stage: CodexSuccessionJournalStage;
  old: CodexSuccessionStoreIdentity;
  new: CodexSuccessionStoreIdentity;
  safeErrorCode?: string;
}>;

export type PrepareCodexSuccessionInput = Readonly<{
  old: CodexSuccessionStoreIdentity;
  new: CodexSuccessionStoreIdentity;
}>;

export type ExactCodexSuccessionInput = Readonly<{
  oldGeneration: string;
  newGeneration: string;
}>;

export type ClearCodexSuccessionInput = ExactCodexSuccessionInput &
  Readonly<{
    /** Required once the durable arm exists; ignored only before arming. */
    publicationAbsenceConfirmed?: true;
  }>;

export type ActivateCodexSuccessionInput = ExactCodexSuccessionInput &
  Readonly<{
    state: "idle" | "busy" | "awaiting_approval";
  }>;

export type ForbidCodexSuccessionRecoveryInput =
  ExactCodexSuccessionInput &
    Readonly<{
      safeErrorCode: string;
    }>;

export type CodexSuccessionRecoveryAuthority =
  | Readonly<{ authority: "none" }>
  | Readonly<{
      authority: "old" | "new";
      journal: CodexSuccessionJournal;
    }>;

export type CodexSuccessionBarrierInspection = Readonly<{
  codexRouteCount: number;
  queueCount: number;
  inFlightCount: number;
  transientBodyCount: number;
  codexQueueDepth: number;
  clean: boolean;
}>;

const CODEX_SUCCESSION_STAGES = new Set<string>(
  codexSuccessionJournalStages,
);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
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

function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value);
}

function isPrivateToken(value: unknown): value is string {
  // Intentionally excludes whitespace and path separators. Socket/reply paths
  // must remain connector-memory-only and can never become route handles.
  return typeof value === "string" && PRIVATE_TOKEN_PATTERN.test(value);
}

function isCodexSuccessionIdentity(
  value: unknown,
): value is CodexSuccessionStoreIdentity {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "alias",
      "threadId",
      "hostId",
      "generation",
      "binding",
    ]) &&
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" &&
    HOST_PATTERN.test(value.hostId) &&
    value.alias.endsWith(`@${value.hostId}`) &&
    isPrivateToken(value.threadId) &&
    isCodexRegistrationGeneration(value.generation) &&
    isPrivateRouteBinding(value.binding) &&
    value.binding.provider === "codex" &&
    value.binding.hostId === value.hostId &&
    value.binding.routeHandle === value.threadId
  );
}

function isCodexSuccessionJournal(
  value: unknown,
): value is CodexSuccessionJournal {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      ["schemaVersion", "stage", "old", "new"],
      ["safeErrorCode"],
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.stage !== "string" ||
    !CODEX_SUCCESSION_STAGES.has(value.stage) ||
    !isCodexSuccessionIdentity(value.old) ||
    !isCodexSuccessionIdentity(value.new)
  ) {
    return false;
  }
  const oldIdentity = value.old;
  const newIdentity = value.new;
  if (
    oldIdentity.hostId !== newIdentity.hostId ||
    oldIdentity.alias === newIdentity.alias ||
    oldIdentity.threadId === newIdentity.threadId ||
    oldIdentity.generation === newIdentity.generation ||
    oldIdentity.binding.ownerLease === newIdentity.binding.ownerLease
  ) {
    return false;
  }
  return value.stage === "recovery_forbidden"
    ? isSafeCode(value.safeErrorCode)
    : value.safeErrorCode === undefined;
}

function isPrivateEndpointIdentity(
  value: unknown,
): value is PrivateEndpointIdentity {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["provider", "hostId", "endpointGeneration"]) &&
    typeof value.provider === "string" &&
    PROVIDERS.has(value.provider) &&
    typeof value.hostId === "string" &&
    HOST_PATTERN.test(value.hostId) &&
    isPrivateToken(value.endpointGeneration)
  );
}

function isPrivateRouteBinding(value: unknown): value is PrivateRouteBinding {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "provider",
      "hostId",
      "endpointGeneration",
      "routeHandle",
      "ownerLease",
    ]) &&
    isPrivateEndpointIdentity({
      provider: value.provider,
      hostId: value.hostId,
      endpointGeneration: value.endpointGeneration,
    }) &&
    isPrivateToken(value.routeHandle) &&
    isPrivateToken(value.ownerLease)
  );
}

function isCodexEndpointRefreshJournalEvent(
  value: unknown,
): value is CodexEndpointRefreshJournalEvent {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "sequence",
      "timestamp",
      "alias",
      "hostId",
      "threadId",
      "oldEndpointGeneration",
      "newEndpointGeneration",
    ], ["reason"]) &&
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" &&
    HOST_PATTERN.test(value.hostId) &&
    value.alias.endsWith(`@${value.hostId}`) &&
    isPrivateToken(value.threadId) &&
    isPrivateToken(value.oldEndpointGeneration) &&
    isPrivateToken(value.newEndpointGeneration) &&
    (value.reason === undefined
      ? value.oldEndpointGeneration !== value.newEndpointGeneration
      : value.reason === "boot_reactivation")
  );
}

function isCodexOrphanRemovalJournalEvent(
  value: unknown,
): value is CodexOrphanRemovalJournalEvent {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "sequence",
      "timestamp",
      "alias",
      "hostId",
    ]) &&
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" &&
    HOST_PATTERN.test(value.hostId) &&
    value.alias.endsWith(`@${value.hostId}`)
  );
}

function isRouteCounters(value: unknown): value is RouteCounters {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
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

function isRouteRecord(value: unknown): value is GatewayRouteRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "alias",
        "binding",
        "registrationMode",
        "enabled",
        "state",
        "busyPolicy",
        "registeredAt",
        "updatedAt",
        "queueDepth",
        "counters",
      ],
      ["lastSeenAt", "safeErrorCode"],
    )
  ) {
    return false;
  }
  return (
    typeof value.alias === "string" &&
    ALIAS_PATTERN.test(value.alias) &&
    isPrivateRouteBinding(value.binding) &&
    typeof value.registrationMode === "string" &&
    REGISTRATION_MODES.has(value.registrationMode) &&
    typeof value.enabled === "boolean" &&
    typeof value.state === "string" &&
    ROUTE_STATES.has(value.state) &&
    value.busyPolicy === "queue" &&
    isIsoTimestamp(value.registeredAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    isNonNegativeInteger(value.queueDepth) &&
    isRouteCounters(value.counters) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isConsentEndpoint(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["alias", "provider", "ownerLease"]) &&
    typeof value.alias === "string" && ALIAS_PATTERN.test(value.alias) &&
    typeof value.provider === "string" && PROVIDERS.has(value.provider) &&
    isPrivateToken(value.ownerLease)
  );
}

function isConsentEdgeRecord(value: unknown): value is GatewayConsentEdgeRecord {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ["endpoints", "createdAt", "updatedAt", "counters"]) &&
    Array.isArray(value.endpoints) &&
    value.endpoints.length === 2 &&
    value.endpoints.every(isConsentEndpoint) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isRouteCounters(value.counters)
  );
}

function progressWatchPairKey(
  watch: Pick<
    ProgressWatch,
    "ownerAlias" | "ownerLease" | "workerAlias" | "workerLease"
  >,
): string {
  return [
    `${watch.ownerAlias}\0${watch.ownerLease}`,
    `${watch.workerAlias}\0${watch.workerLease}`,
  ]
    .sort()
    .join("\0");
}

function progressWatchMatchesConsentEdge(
  watch: Pick<
    ProgressWatch,
    "ownerAlias" | "ownerLease" | "workerAlias" | "workerLease"
  >,
  pair: GatewayConsentEdgeRecord,
): boolean {
  const [left, right] = pair.endpoints;
  return (
    (watch.ownerAlias === left.alias &&
      watch.ownerLease === left.ownerLease &&
      watch.workerAlias === right.alias &&
      watch.workerLease === right.ownerLease) ||
    (watch.ownerAlias === right.alias &&
      watch.ownerLease === right.ownerLease &&
      watch.workerAlias === left.alias &&
      watch.workerLease === left.ownerLease)
  );
}

function progressWatchJournalEvent(
  watch: Pick<
    ProgressWatch,
    "conversationId" | "ownerAlias" | "workerAlias"
  >,
  timestamp: string,
  transition:
    | Readonly<{ kind: "opened" | "replaced"; actor: "owner" }>
    | (Readonly<{ kind: "settled" }> & ProgressWatchSettlement),
): PendingProgressWatchJournalEvent {
  return {
    timestamp,
    conversationId: watch.conversationId,
    ownerAlias: watch.ownerAlias,
    workerAlias: watch.workerAlias,
    ...transition,
  };
}

type LegacyV14ProgressWatch = Readonly<{
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  ownerLease: string;
  workerLease: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleMs: number;
  phase: "quiet" | "episode";
  nudgeCount: 0 | 1 | 2;
  nextActionAt: string;
  capability: "conversation" | "route";
  degradedNoticeSent: boolean;
}>;

const LEGACY_V14_PROGRESS_WATCH_JOURNAL_KINDS = new Set([
  "opened",
  "replaced",
  "activity",
  "nudge",
  "worker_reported_complete",
  "capability_degraded",
  "conversation_rebound",
  "done",
  "unresponsive",
  "pair_removed",
  "endpoint_retired",
  "disabled",
]);

type LegacyV14ProgressWatchJournalEvent = Readonly<{
  sequence: number;
  timestamp: string;
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  kind:
    | "opened"
    | "replaced"
    | "activity"
    | "nudge"
    | "worker_reported_complete"
    | "capability_degraded"
    | "conversation_rebound"
    | "done"
    | "unresponsive"
    | "pair_removed"
    | "endpoint_retired"
    | "disabled";
  nudgeNumber?: 1 | 2;
}>;

function isLegacyV14ProgressWatch(
  value: unknown,
): value is LegacyV14ProgressWatch {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "conversationId",
      "ownerAlias",
      "workerAlias",
      "ownerLease",
      "workerLease",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
      "idleMs",
      "phase",
      "nudgeCount",
      "nextActionAt",
      "capability",
      "degradedNoticeSent",
    ])
  ) {
    return false;
  }
  return (
    typeof value.conversationId === "string" &&
    CONVERSATION_ID_PATTERN.test(value.conversationId) &&
    typeof value.ownerAlias === "string" &&
    ALIAS_PATTERN.test(value.ownerAlias) &&
    typeof value.workerAlias === "string" &&
    ALIAS_PATTERN.test(value.workerAlias) &&
    value.ownerAlias !== value.workerAlias &&
    isPrivateToken(value.ownerLease) &&
    isPrivateToken(value.workerLease) &&
    value.ownerLease !== value.workerLease &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isIsoTimestamp(value.lastActivityAt) &&
    isPositiveInteger(value.idleMs) &&
    value.idleMs >= PROGRESS_WATCH_MIN_IDLE_MS &&
    value.idleMs <= PROGRESS_WATCH_MAX_IDLE_MS &&
    (value.phase === "quiet" || value.phase === "episode") &&
    (value.nudgeCount === 0 ||
      value.nudgeCount === 1 ||
      value.nudgeCount === 2) &&
    (value.phase === "quiet"
      ? value.nudgeCount === 0
      : value.nudgeCount === 1 || value.nudgeCount === 2) &&
    isIsoTimestamp(value.nextActionAt) &&
    (value.capability === "conversation" || value.capability === "route") &&
    typeof value.degradedNoticeSent === "boolean"
  );
}

function isLegacyV14ProgressWatchJournalEvent(
  value: unknown,
): value is LegacyV14ProgressWatchJournalEvent {
  return (
    isObject(value) &&
    hasOnlyKeys(
      value,
      [
        "sequence",
        "timestamp",
        "conversationId",
        "ownerAlias",
        "workerAlias",
        "kind",
      ],
      ["nudgeNumber"],
    ) &&
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.conversationId === "string" &&
    CONVERSATION_ID_PATTERN.test(value.conversationId) &&
    typeof value.ownerAlias === "string" &&
    ALIAS_PATTERN.test(value.ownerAlias) &&
    typeof value.workerAlias === "string" &&
    ALIAS_PATTERN.test(value.workerAlias) &&
    value.ownerAlias !== value.workerAlias &&
    typeof value.kind === "string" &&
    LEGACY_V14_PROGRESS_WATCH_JOURNAL_KINDS.has(value.kind) &&
    (value.kind === "nudge"
      ? value.nudgeNumber === 1 || value.nudgeNumber === 2
      : value.nudgeNumber === undefined)
  );
}

function isProgressWatch(value: unknown): value is ProgressWatch {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "conversationId",
      "ownerAlias",
      "workerAlias",
      "ownerLease",
      "workerLease",
      "lastActivityAt",
      "idleMs",
      "nudgeCount",
      "nextActionAt",
    ]) &&
    typeof value.conversationId === "string" &&
    CONVERSATION_ID_PATTERN.test(value.conversationId) &&
    typeof value.ownerAlias === "string" &&
    ALIAS_PATTERN.test(value.ownerAlias) &&
    typeof value.workerAlias === "string" &&
    ALIAS_PATTERN.test(value.workerAlias) &&
    value.ownerAlias !== value.workerAlias &&
    isPrivateToken(value.ownerLease) &&
    isPrivateToken(value.workerLease) &&
    value.ownerLease !== value.workerLease &&
    isIsoTimestamp(value.lastActivityAt) &&
    isPositiveInteger(value.idleMs) &&
    value.idleMs >= PROGRESS_WATCH_MIN_IDLE_MS &&
    value.idleMs <= PROGRESS_WATCH_MAX_IDLE_MS &&
    (value.nudgeCount === 0 ||
      value.nudgeCount === 1 ||
      value.nudgeCount === 2) &&
    isIsoTimestamp(value.nextActionAt)
  );
}

function isProgressWatchJournalEvent(
  value: unknown,
): value is ProgressWatchJournalEvent {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "sequence",
        "timestamp",
        "conversationId",
        "ownerAlias",
        "workerAlias",
        "kind",
        "actor",
      ],
      ["reason"],
    ) ||
    !isPositiveInteger(value.sequence) ||
    !isIsoTimestamp(value.timestamp) ||
    typeof value.conversationId !== "string" ||
    !CONVERSATION_ID_PATTERN.test(value.conversationId) ||
    typeof value.ownerAlias !== "string" ||
    !ALIAS_PATTERN.test(value.ownerAlias) ||
    typeof value.workerAlias !== "string" ||
    !ALIAS_PATTERN.test(value.workerAlias) ||
    value.ownerAlias === value.workerAlias ||
    typeof value.kind !== "string" ||
    !PROGRESS_WATCH_JOURNAL_KINDS.has(value.kind)
  ) {
    return false;
  }
  if (value.kind === "opened") {
    return value.actor === "owner" && value.reason === undefined;
  }
  if (value.kind === "replaced") {
    return (
      (value.actor === "owner" || value.actor === "unknown") &&
      value.reason === undefined
    );
  }
  if (value.kind !== "settled" || typeof value.reason !== "string") {
    return false;
  }
  if (value.reason === "done") {
    return value.actor === "owner" || value.actor === "worker";
  }
  if (value.reason === "untracked") return value.actor === "operator";
  if (value.reason === "pair_removed") return value.actor === "operator";
  if (value.reason === "endpoint_retired") {
    return value.actor === "gateway" || value.actor === "operator";
  }
  if (
    value.reason === "idle_timeout" ||
    value.reason === "tracking_disabled"
  ) {
    return value.actor === "gateway";
  }
  return false;
}

function isConnectorRecord(value: unknown): value is ConnectorRecord {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "provider",
        "hostId",
        "endpointGeneration",
        "health",
        "protocol",
        "protocolVersion",
        "updatedAt",
      ],
      ["lastSeenAt", "safeErrorCode"],
    )
  ) {
    return false;
  }
  return (
    isPrivateEndpointIdentity({
      provider: value.provider,
      hostId: value.hostId,
      endpointGeneration: value.endpointGeneration,
    }) &&
    typeof value.health === "string" &&
    CONNECTOR_HEALTH.has(value.health) &&
    typeof value.protocol === "string" &&
    PROTOCOL_PATTERN.test(value.protocol) &&
    typeof value.protocolVersion === "string" &&
    PROTOCOL_VERSION_PATTERN.test(value.protocolVersion) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isQueuedMetadata(value: unknown): value is QueuedMessageMetadata {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "messageId",
        "messageIdSuffix",
        "direction",
        "sourceAlias",
        "targetAlias",
        "enqueuedAt",
        "deadlineAt",
        "bytes",
      ],
      ["conversationIdSuffix", "body", "pair", "transientTarget", "steer"],
    )
  ) {
    return false;
  }
  return (
    typeof value.messageId === "string" &&
    MESSAGE_ID_PATTERN.test(value.messageId) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    typeof value.direction === "string" &&
    DIRECTIONS.has(value.direction) &&
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
    (value.pair === undefined || value.pair === true) &&
    (value.transientTarget === undefined || value.transientTarget === true) &&
    (value.steer === undefined || value.steer === true)
  );
}

function isInFlightMetadata(
  value: unknown,
): value is InFlightMessageMetadata {
  if (!isObject(value)) return false;
  const { dispatchedAt, ...metadata } = value;
  return isQueuedMetadata(metadata) && isIsoTimestamp(dispatchedAt);
}

function isEvent(value: unknown): value is NormalizedMessageEvent {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
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
      ],
      ["conversationIdSuffix", "body", "latencyMs", "safeErrorCode", "steer"],
    )
  ) {
    return false;
  }
  return (
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    typeof value.direction === "string" &&
    DIRECTIONS.has(value.direction) &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    typeof value.state === "string" &&
    DELIVERY_STATES.has(value.state) &&
    isPositiveInteger(value.bytes) &&
    (value.body === undefined ||
      (typeof value.body === "string" &&
        value.body.length > 0 &&
        !value.body.includes("\u0000") &&
        Buffer.byteLength(value.body, "utf8") === value.bytes)) &&
    (value.latencyMs === undefined || isNonNegativeInteger(value.latencyMs)) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode)) &&
    (value.steer === undefined || value.steer === true)
  );
}

function isDedupeRecord(value: unknown): value is DedupeRecord {
  return (
    isObject(value) &&
    hasOnlyKeys(
      value,
      [
        "fingerprint",
        "messageIdSuffix",
        "sourceAlias",
        "targetAlias",
        "direction",
        "firstSeenAt",
        "expiresAt",
      ],
      ["conversationIdSuffix", "pair"],
    ) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.fingerprint) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined ||
      (typeof value.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(value.conversationIdSuffix))) &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    typeof value.direction === "string" &&
    DIRECTIONS.has(value.direction) &&
    (value.pair === undefined || value.pair === true) &&
    isIsoTimestamp(value.firstSeenAt) &&
    isIsoTimestamp(value.expiresAt)
  );
}

function isAccounting(value: unknown): value is GatewayAccounting {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
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

function isPersistedState(value: unknown): value is GatewayPersistedState {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "createdAt",
      "updatedAt",
      "eventSequence",
      "routes",
      "consentEdges",
      "connectors",
      "queue",
      "inFlight",
      "events",
      "dedupe",
      "rateBuckets",
      "accounting",
      "watchSequence",
      "progressWatches",
      "progressWatchEvents",
      "codexEndpointRefreshSequence",
      "codexEndpointRefreshEvents",
      "codexOrphanRemovalSequence",
      "codexOrphanRemovalEvents",
      "codexSuccession",
    ]) ||
    value.schemaVersion !== 2 ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isNonNegativeInteger(value.eventSequence) ||
    !isNonNegativeInteger(value.watchSequence) ||
    !isNonNegativeInteger(value.codexEndpointRefreshSequence) ||
    !isNonNegativeInteger(value.codexOrphanRemovalSequence) ||
    !Array.isArray(value.routes) ||
    !value.routes.every(isRouteRecord) ||
    !Array.isArray(value.consentEdges) ||
    value.consentEdges.length > gatewayPublicSnapshotLimits.consentEdges ||
    !value.consentEdges.every(isConsentEdgeRecord) ||
    !Array.isArray(value.progressWatches) ||
    value.progressWatches.length > PROGRESS_WATCH_HARD_CAPACITY ||
    !value.progressWatches.every(isProgressWatch) ||
    !Array.isArray(value.progressWatchEvents) ||
    value.progressWatchEvents.length > gatewayPublicSnapshotLimits.messages ||
    !value.progressWatchEvents.every(isProgressWatchJournalEvent) ||
    !Array.isArray(value.codexEndpointRefreshEvents) ||
    value.codexEndpointRefreshEvents.length >
      CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY ||
    !value.codexEndpointRefreshEvents.every(
      isCodexEndpointRefreshJournalEvent,
    ) ||
    !Array.isArray(value.codexOrphanRemovalEvents) ||
    value.codexOrphanRemovalEvents.length >
      CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY ||
    !value.codexOrphanRemovalEvents.every(
      isCodexOrphanRemovalJournalEvent,
    ) ||
    !Array.isArray(value.connectors) ||
    !value.connectors.every(isConnectorRecord) ||
    !Array.isArray(value.queue) ||
    !value.queue.every(isQueuedMetadata) ||
    !Array.isArray(value.inFlight) ||
    !value.inFlight.every(isInFlightMetadata) ||
    !Array.isArray(value.events) ||
    value.events.length > gatewayPublicSnapshotLimits.messages ||
    !value.events.every(isEvent) ||
    !Array.isArray(value.dedupe) ||
    !value.dedupe.every(isDedupeRecord) ||
    !Array.isArray(value.rateBuckets) ||
    !value.rateBuckets.every(
      (bucket) =>
        isObject(bucket) &&
        hasOnlyKeys(bucket, ["sourceAlias", "windowStartedAt", "count"]) &&
        typeof bucket.sourceAlias === "string" &&
        ALIAS_PATTERN.test(bucket.sourceAlias) &&
        isIsoTimestamp(bucket.windowStartedAt) &&
        isNonNegativeInteger(bucket.count),
    ) ||
    !isAccounting(value.accounting) ||
    (value.codexSuccession !== null &&
      !isCodexSuccessionJournal(value.codexSuccession))
  ) {
    return false;
  }

  const candidate = value as unknown as GatewayPersistedState;
  const aliases = new Set(candidate.routes.map((route) => route.alias));
  const routeTargets = new Set(
    candidate.routes.map(
      (route) =>
        `${route.binding.provider}\0${route.binding.hostId}\0${route.binding.endpointGeneration}\0${route.binding.routeHandle}`,
    ),
  );
  const ownerLeases = new Set(
    candidate.routes.map((route) => route.binding.ownerLease),
  );
  const watchConversationIds = new Set(
    candidate.progressWatches.map((watch) => watch.conversationId),
  );
  if (watchConversationIds.size !== candidate.progressWatches.length) {
    return false;
  }
  const watchPairKeys = new Set(
    candidate.progressWatches.map(progressWatchPairKey),
  );
  if (watchPairKeys.size !== candidate.progressWatches.length) return false;
  for (const watch of candidate.progressWatches) {
    const owner = candidate.routes.find(
      (route) =>
        route.alias === watch.ownerAlias &&
        route.binding.ownerLease === watch.ownerLease,
    );
    const worker = candidate.routes.find(
      (route) =>
        route.alias === watch.workerAlias &&
        route.binding.ownerLease === watch.workerLease,
    );
    if (
      owner === undefined ||
      worker === undefined ||
      owner.binding.provider === worker.binding.provider ||
      owner.binding.hostId !== worker.binding.hostId
    ) {
      return false;
    }
    const endpoints = canonicalConsentEndpoints(owner, worker);
    if (
      !candidate.consentEdges.some(
        (edge) => edge.endpoints.every((endpoint, index) =>
          endpoint.alias === endpoints[index]!.alias &&
          endpoint.provider === endpoints[index]!.provider &&
          endpoint.ownerLease === endpoints[index]!.ownerLease),
      )
    ) {
      return false;
    }
  }
  const connectorKeys = new Set(
    candidate.connectors.map(
      (connector) => `${connector.provider}\0${connector.hostId}`,
    ),
  );
  const messageIds = [
    ...candidate.queue.map((item) => item.messageId),
    ...candidate.inFlight.map((item) => item.messageId),
  ];
  const expectedQueuedBytes = candidate.queue.reduce(
    (total, item) => total + item.bytes,
    0,
  );
  const routeByAlias = new Map(
    candidate.routes.map((route) => [route.alias, route]),
  );
  const edgeKeys = candidate.consentEdges.map((edge) => consentEdgeKey(edge.endpoints));
  const edgesValid = candidate.consentEdges.every((edge) => {
    const [leftEndpoint, rightEndpoint] = edge.endpoints;
    const left = routeByAlias.get(leftEndpoint.alias);
    const right = routeByAlias.get(rightEndpoint.alias);
    return (
      compareConsentEndpoints(leftEndpoint, rightEndpoint) < 0 &&
      left?.binding.provider === leftEndpoint.provider &&
      right?.binding.provider === rightEndpoint.provider &&
      left.binding.provider !== right.binding.provider &&
      left.binding.hostId === right.binding.hostId &&
      left.binding.ownerLease === leftEndpoint.ownerLease &&
      right.binding.ownerLease === rightEndpoint.ownerLease
    );
  });
  const claudeConnectorHosts = new Set(
    candidate.connectors
      .filter((connector) => connector.provider === "claude")
      .map((connector) => connector.hostId),
  );
  const aliasHost = (alias: string): string =>
    alias.slice(alias.lastIndexOf("@") + 1);
  const isValidPersistedMessagePair = (message: {
    direction: MessageDirection;
    sourceAlias: string;
    targetAlias: string;
    pair?: true;
  }): boolean => {
    const source = routeByAlias.get(message.sourceAlias);
    const target = routeByAlias.get(message.targetAlias);
    const parsed = parseDirection(message.direction);
    if (parsed === undefined) return false;
    const sourceValid = source?.binding.provider === parsed.sourceProvider ||
      (source === undefined && parsed.sourceProvider === "claude" && target !== undefined &&
        claudeConnectorHosts.has(target.binding.hostId) &&
        aliasHost(message.sourceAlias) === target.binding.hostId);
    const targetValid = target?.binding.provider === parsed.targetProvider ||
      (target === undefined && parsed.targetProvider === "claude" && source !== undefined &&
        claudeConnectorHosts.has(source.binding.hostId) &&
        aliasHost(message.targetAlias) === source.binding.hostId);
    const routeShapeValid = sourceValid && targetValid &&
      (source === undefined || target === undefined ||
        source.binding.hostId === target.binding.hostId);
    return (
      routeShapeValid &&
      (message.pair !== true ||
        candidate.consentEdges.some((edge) => consentEdgeMatchesMessage(edge, message)))
    );
  };
  const sequencesStrictlyIncrease = candidate.events.every(
    (event, index) =>
      index === 0 ||
      event.sequence > (candidate.events[index - 1]?.sequence ?? 0),
  );
  const progressWatchSequencesStrictlyIncrease =
    candidate.progressWatchEvents.every(
      (event, index) =>
        event.sequence <= candidate.watchSequence &&
        (index === 0 ||
          event.sequence >
            (candidate.progressWatchEvents[index - 1]?.sequence ?? 0)),
    );
  const endpointRefreshSequenceConsistent =
    candidate.codexEndpointRefreshEvents.length === 0
      ? candidate.codexEndpointRefreshSequence === 0
      : candidate.codexEndpointRefreshEvents.at(-1)?.sequence ===
          candidate.codexEndpointRefreshSequence &&
        candidate.codexEndpointRefreshEvents.every(
          (event, index) =>
            index === 0 ||
            event.sequence ===
              (candidate.codexEndpointRefreshEvents[index - 1]?.sequence ??
                0) +
                1,
        );
  const orphanRemovalSequenceConsistent =
    candidate.codexOrphanRemovalEvents.length === 0
      ? candidate.codexOrphanRemovalSequence === 0
      : candidate.codexOrphanRemovalEvents.at(-1)?.sequence ===
          candidate.codexOrphanRemovalSequence &&
        candidate.codexOrphanRemovalEvents.every(
          (event, index) =>
            index === 0 ||
            event.sequence ===
              (candidate.codexOrphanRemovalEvents[index - 1]?.sequence ?? 0) +
                1,
        );
  return (
    aliases.size === candidate.routes.length &&
    new Set(edgeKeys).size === edgeKeys.length &&
    edgesValid &&
    routeTargets.size === candidate.routes.length &&
    ownerLeases.size === candidate.routes.length &&
    connectorKeys.size === candidate.connectors.length &&
    new Set(messageIds).size === messageIds.length &&
    new Set(candidate.dedupe.map((record) => record.fingerprint)).size ===
      candidate.dedupe.length &&
    new Set(candidate.rateBuckets.map((bucket) => bucket.sourceAlias)).size ===
      candidate.rateBuckets.length &&
    candidate.accounting.queuedBytes === expectedQueuedBytes &&
    sequencesStrictlyIncrease &&
    progressWatchSequencesStrictlyIncrease &&
    candidate.events.every(
      (event) => event.sequence <= candidate.eventSequence,
    ) &&
    endpointRefreshSequenceConsistent &&
    orphanRemovalSequenceConsistent &&
    candidate.routes.every(
      (route) =>
        route.alias.endsWith(`@${route.binding.hostId}`) &&
        ((route.binding.provider === "claude" &&
          route.registrationMode === "selected_live_peer") ||
          (route.binding.provider !== "claude" &&
            route.registrationMode === "explicit_opt_in")) &&
        (gatewayRegistrationIngressPrefixes[route.binding.provider] === undefined ||
          route.alias.startsWith(gatewayRegistrationIngressPrefixes[route.binding.provider]!)) &&
        route.queueDepth ===
          candidate.queue.filter((item) => item.targetAlias === route.alias)
            .length,
    ) &&
    [...candidate.queue, ...candidate.inFlight].every((item) => {
      return (
        item.messageIdSuffix ===
          item.messageId.replaceAll("-", "").slice(-8).toLowerCase() &&
        isValidPersistedMessagePair(item)
      );
    }) &&
    candidate.dedupe.every(isValidPersistedMessagePair) &&
    candidate.rateBuckets.every(
      (bucket) =>
        aliases.has(bucket.sourceAlias) ||
        candidate.routes.some(
          (route) =>
            claudeConnectorHosts.has(route.binding.hostId) &&
            route.binding.hostId === aliasHost(bucket.sourceAlias),
        ),
    ) &&
    isPersistedSuccessionConsistent(candidate)
  );
}

function routeMatchesSuccessionIdentity(
  route: GatewayRouteRecord,
  identity: CodexSuccessionStoreIdentity,
): boolean {
  return (
    route.alias === identity.alias &&
    route.registrationMode === "explicit_opt_in" &&
    route.binding.provider === "codex" &&
    route.binding.hostId === identity.hostId &&
    route.binding.routeHandle === identity.threadId &&
    sameBinding(route.binding, identity.binding)
  );
}

function isPersistedSuccessionConsistent(
  state: GatewayPersistedState,
): boolean {
  if (state.codexSuccession === null) return true;
  if (!isCodexSuccessionJournal(state.codexSuccession)) return false;
  const journal = state.codexSuccession;
  const matchingRoutes = state.routes.filter(
    (candidate) =>
      routeMatchesSuccessionIdentity(candidate, journal.old) ||
      routeMatchesSuccessionIdentity(candidate, journal.new),
  );
  if (matchingRoutes.length !== 1 || matchingRoutes[0] === undefined) {
    return false;
  }
  const route = matchingRoutes[0];
  const successionAliases = new Set([journal.old.alias, journal.new.alias]);
  if (
    state.queue.some(
      (item) =>
        successionAliases.has(item.sourceAlias) ||
        successionAliases.has(item.targetAlias),
    ) ||
    state.inFlight.some(
      (item) =>
        successionAliases.has(item.sourceAlias) ||
        successionAliases.has(item.targetAlias),
    ) ||
    route.queueDepth !== 0
  ) {
    return false;
  }
  const oldMatches = routeMatchesSuccessionIdentity(route, journal.old);
  const newMatches = routeMatchesSuccessionIdentity(route, journal.new);
  const newConnectorGenerationExists = state.connectors.some((connector) =>
    sameEndpoint(connector, journal.new.binding),
  );
  if (!newConnectorGenerationExists) return false;
  const nonCodexCollision = state.routes.some(
    (candidate) =>
      candidate !== route &&
      (candidate.alias === journal.new.alias ||
        sameRouteTarget(candidate.binding, journal.new.binding) ||
        candidate.binding.ownerLease === journal.new.binding.ownerLease),
  );
  if (nonCodexCollision) return false;
  if (journal.stage === "activated") {
    return newMatches && isZeroRouteCounters(route.counters);
  }
  if (journal.stage === "recovery_forbidden") {
    return oldMatches || (newMatches && isZeroRouteCounters(route.counters));
  }
  return oldMatches;
}

function isZeroRouteCounters(counters: RouteCounters): boolean {
  return Object.values(counters).every((value) => value === 0);
}

function emptyCounters(): RouteCounters {
  return {
    accepted: 0,
    delivered: 0,
    unconfirmed: 0,
    failed: 0,
    ambiguous: 0,
    expired: 0,
    cancelled: 0,
    abandoned: 0,
    rejected: 0,
    bytesAccepted: 0,
  };
}

function emptyAccounting(): GatewayAccounting {
  return {
    accepted: 0,
    duplicates: 0,
    delivered: 0,
    unconfirmed: 0,
    failed: 0,
    ambiguous: 0,
    expired: 0,
    cancelled: 0,
    abandoned: 0,
    rejected: 0,
    bytesAccepted: 0,
    queuedBytes: 0,
  };
}

async function canonicalFuturePath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      return path.join(await realpath(cursor), ...suffix);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertNoSymlinkComponents(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const relative = absolute.slice(parsed.root.length);
  let cursor = parsed.root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_DIRECTORY",
          "The gateway state path must not contain symbolic links.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

function sameEndpoint(
  left: PrivateEndpointIdentity,
  right: PrivateEndpointIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.hostId === right.hostId &&
    left.endpointGeneration === right.endpointGeneration
  );
}

function endpointOf(binding: PrivateRouteBinding): PrivateEndpointIdentity {
  return {
    provider: binding.provider,
    hostId: binding.hostId,
    endpointGeneration: binding.endpointGeneration,
  };
}

function cloneSuccessionIdentity(
  identity: CodexSuccessionStoreIdentity,
): CodexSuccessionStoreIdentity {
  return {
    alias: identity.alias,
    threadId: identity.threadId,
    hostId: identity.hostId,
    generation: identity.generation,
    binding: { ...identity.binding },
  };
}

function cloneSuccessionJournal(
  journal: CodexSuccessionJournal,
): CodexSuccessionJournal {
  return {
    schemaVersion: 1,
    stage: journal.stage,
    old: cloneSuccessionIdentity(journal.old),
    new: cloneSuccessionIdentity(journal.new),
    ...(journal.safeErrorCode === undefined
      ? {}
      : { safeErrorCode: journal.safeErrorCode }),
  };
}

function sameBinding(
  left: PrivateRouteBinding,
  right: PrivateRouteBinding,
): boolean {
  return (
    sameEndpoint(left, right) &&
    left.routeHandle === right.routeHandle &&
    left.ownerLease === right.ownerLease
  );
}

function sameRouteTarget(
  left: PrivateRouteBinding,
  right: PrivateRouteBinding,
): boolean {
  return sameEndpoint(left, right) && left.routeHandle === right.routeHandle;
}

function renameRateBucket(
  state: GatewayPersistedState,
  previousAlias: string,
  newAlias: string,
): void {
  const previous = state.rateBuckets.find(
    (bucket) => bucket.sourceAlias === previousAlias,
  );
  if (previous === undefined) return;
  const existing = state.rateBuckets.find(
    (bucket) => bucket.sourceAlias === newAlias,
  );
  if (existing === undefined) {
    previous.sourceAlias = newAlias;
    return;
  }
  existing.windowStartedAt =
    existing.windowStartedAt < previous.windowStartedAt
      ? existing.windowStartedAt
      : previous.windowStartedAt;
  existing.count = Math.min(
    Number.MAX_SAFE_INTEGER,
    existing.count + previous.count,
  );
  state.rateBuckets = state.rateBuckets.filter(
    (bucket) => bucket !== previous,
  );
}

function compareConsentEndpoints(left: Pick<GatewayConsentEndpoint, "alias" | "provider">,
  right: Pick<GatewayConsentEndpoint, "alias" | "provider">): number {
  return gatewayProviders.indexOf(left.provider) -
    gatewayProviders.indexOf(right.provider) || left.alias.localeCompare(right.alias);
}

function canonicalConsentEndpoints(
  source: GatewayRouteRecord,
  target: GatewayRouteRecord,
): readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] {
  const endpoints: [GatewayConsentEndpoint, GatewayConsentEndpoint] = [
    { alias: source.alias, provider: source.binding.provider,
      ownerLease: source.binding.ownerLease },
    { alias: target.alias, provider: target.binding.provider,
      ownerLease: target.binding.ownerLease },
  ];
  endpoints.sort(compareConsentEndpoints);
  return endpoints;
}

function consentEdgeKey(endpoints: readonly [
  Pick<GatewayConsentEndpoint, "alias" | "provider">,
  Pick<GatewayConsentEndpoint, "alias" | "provider">,
]): string {
  return endpoints.map(({ provider, alias }) => `${provider}\0${alias}`).join("\0");
}

function consentEdgeMatchesMessage(
  pair: GatewayConsentEdgeRecord | GatewayConsentEdgeInput,
  message: Pick<
    QueuedMessageMetadata,
    "sourceAlias" | "targetAlias" | "pair"
  >,
): boolean {
  const aliases = "endpoints" in pair
    ? pair.endpoints.map((endpoint) => endpoint.alias)
    : pair.aliases;
  return message.pair === true &&
    ((message.sourceAlias === aliases[0] && message.targetAlias === aliases[1]) ||
      (message.sourceAlias === aliases[1] && message.targetAlias === aliases[0]));
}

function findConsentEdgeForMessage(
  state: GatewayPersistedState,
  message: Pick<QueuedMessageMetadata, "sourceAlias" | "targetAlias">,
): GatewayConsentEdgeRecord | undefined {
  return state.consentEdges.find((edge) => consentEdgeMatchesMessage(edge, message));
}

function renameConsentEdgeAlias(
  state: GatewayPersistedState,
  previousAlias: string,
  newAlias: string,
  now: Date,
): void {
  if (previousAlias === newAlias) return;
  for (const edge of state.consentEdges) {
    const endpoint = edge.endpoints.find(({ alias }) => alias === previousAlias);
    if (endpoint !== undefined) {
      const renamed = edge.endpoints.map((candidate) =>
        candidate.alias === previousAlias
          ? { ...candidate, alias: newAlias }
          : candidate,
      ) as [GatewayConsentEndpoint, GatewayConsentEndpoint];
      renamed.sort(compareConsentEndpoints);
      edge.endpoints = renamed;
      edge.updatedAt = now.toISOString();
    }
  }
}

function renameProgressWatchAlias(
  state: GatewayPersistedState,
  previousAlias: string,
  newAlias: string,
): void {
  if (previousAlias === newAlias) return;
  state.progressWatches = state.progressWatches.map((watch) =>
    watch.ownerAlias === previousAlias
      ? { ...watch, ownerAlias: newAlias }
      : watch.workerAlias === previousAlias
        ? { ...watch, workerAlias: newAlias }
        : watch,
  );
}

function removeConsentEdgesForAliases(
  state: GatewayPersistedState,
  aliases: ReadonlySet<string>,
): void {
  state.consentEdges = state.consentEdges.filter(
    (edge) => !edge.endpoints.some(({ alias }) => aliases.has(alias)),
  );
}

function routeTerminationMatches(
  state: GatewayPersistedState,
  aliases: ReadonlySet<string>,
  message: Pick<
    QueuedMessageMetadata,
    "sourceAlias" | "targetAlias" | "pair"
  >,
): boolean {
  for (const alias of [message.sourceAlias, message.targetAlias]) {
    if (!aliases.has(alias)) continue;
    const route = state.routes.find((candidate) => candidate.alias === alias);
    if (route?.binding.provider !== "claude" || message.pair === true) {
      return true;
    }
  }
  return false;
}

function directionFor(
  source: GatewayRouteRecord,
  target: GatewayRouteRecord,
): MessageDirection {
  if (source.binding.provider !== target.binding.provider) {
    return directionId(source.binding.provider, target.binding.provider);
  }
  throw new BridgeError(
    "INVALID_GATEWAY_ROUTE_PAIR",
    "Gateway messages must cross between distinct providers.",
  );
}

type ResolvedEnqueueSides = {
  sourceAlias: string;
  targetAlias: string;
  direction: MessageDirection;
  pair?: true;
  transientTarget?: true;
  sourceRoute?: GatewayRouteRecord;
  targetRoute?: GatewayRouteRecord;
};

export class GatewayStore {
  readonly config: GatewayConfig;
  rootDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly afterStateFileRename:
    | (() => void | Promise<void>)
    | undefined;
  private readonly mutex = new KeyedMutex();
  private readonly transientBodies = new Map<string, string>();
  private state: GatewayPersistedState | undefined;
  private lockHandle: FileHandle | undefined;
  private lockToken: string | undefined;
  /** Startup may defer the first native-v2 persistence until admission passes. */
  private persistenceDeferred = false;

  constructor(config: GatewayConfig, dependencies: GatewayStoreDependencies = {}) {
    this.config = config;
    this.rootDir = path.resolve(config.stateDir);
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.afterStateFileRename = dependencies.afterStateFileRename;
  }

  get stateFilePath(): string {
    return path.join(this.rootDir, STATE_FILE);
  }

  async initialize(options: Readonly<{ deferPersistence?: boolean }> = {}): Promise<void> {
    await this.mutex.run("gateway", async () => {
      if (this.state) return;
      this.rootDir = await this.prepareOwnedDirectory();
      const rootMetadata = await lstat(this.rootDir);
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_DIRECTORY",
          "The prepared gateway controller root is no longer a real directory.",
        );
      }
      await this.acquireLock();
      try {
        const now = this.now();
        const loaded = await this.loadStateFile(now);
        this.state = loaded ?? {
          schemaVersion: 2,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          eventSequence: 0,
          routes: [],
          consentEdges: [],
          connectors: [],
          queue: [],
          inFlight: [],
          events: [],
          dedupe: [],
          rateBuckets: [],
          accounting: emptyAccounting(),
          watchSequence: 0,
          progressWatches: [],
          progressWatchEvents: [],
          codexEndpointRefreshSequence: 0,
          codexEndpointRefreshEvents: [],
          codexOrphanRemovalSequence: 0,
          codexOrphanRemovalEvents: [],
          codexSuccession: null,
        };
        if (this.state.consentEdges.length > this.config.limits.maxConsentEdges) {
          throw new BridgeError(
            "CONSENT_EDGE_CAPACITY_REACHED",
            "The durable consent-edge inventory exceeds the configured bound.",
          );
        }
        if (
          this.state.progressWatches.length >
          (this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY)
        ) {
          throw new BridgeError(
            "PROGRESS_WATCH_CAPACITY_REACHED",
            "The durable progress-watch inventory exceeds the configured bound.",
          );
        }
        this.recoverAfterRestart(now);
        this.prune(now);
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

  /** Commit a successfully admitted startup exactly once. */
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
      this.transientBodies.clear();
      this.state = undefined;
      this.persistenceDeferred = false;
      await this.releaseControllerLock();
    });
  }

  async observeConnector(input: ObserveConnectorInput): Promise<void> {
    await this.mutate(async (state, now) => {
      this.assertAllowedIdentity(input.identity);
      if (
        !PROTOCOL_PATTERN.test(input.protocol) ||
        !PROTOCOL_VERSION_PATTERN.test(input.protocolVersion) ||
        (input.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(input.safeErrorCode))
      ) {
        throw new BridgeError(
          "INVALID_CONNECTOR_OBSERVATION",
          "The connector observation contains an unsupported normalized field.",
        );
      }
      const existingIndex = state.connectors.findIndex(
        (connector) =>
          connector.provider === input.identity.provider &&
          connector.hostId === input.identity.hostId,
      );
      const existing = state.connectors[existingIndex];
      if (
        existing &&
        existing.endpointGeneration !== input.identity.endpointGeneration &&
        existing.health !== "offline"
      ) {
        throw new BridgeError(
          "ENDPOINT_GENERATION_MISMATCH",
          "A live connector already owns this provider and host. It must be invalidated before a new endpoint generation is observed.",
        );
      }
      const observed: ConnectorRecord = {
        ...input.identity,
        health: input.health,
        protocol: input.protocol,
        protocolVersion: input.protocolVersion,
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        ...(input.safeErrorCode ? { safeErrorCode: input.safeErrorCode } : {}),
      };
      if (existingIndex >= 0) state.connectors[existingIndex] = observed;
      else {
        if (
          state.connectors.length >=
          this.config.allowedHosts.length * gatewayProviders.length
        ) {
          throw new BridgeError(
            "CONNECTOR_CAPACITY_REACHED",
            "The bounded provider and host connector registry is full.",
          );
        }
        state.connectors.push(observed);
      }
    });
  }

  async markConnectorOffline(
    identity: PrivateEndpointIdentity,
    safeErrorCode = "CONNECTOR_OFFLINE",
    inFlightSettlements: readonly RouteInFlightSettlementInput[] = [],
    options: Readonly<{ preserveQueued?: boolean }> = {},
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      this.assertAllowedIdentity(identity);
      if (!SAFE_CODE_PATTERN.test(safeErrorCode)) {
        throw new BridgeError(
          "INVALID_SAFE_ERROR_CODE",
          "Connector error codes must use the normalized safe-code grammar.",
        );
      }
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, identity),
      );
      if (!connector) {
        throw new BridgeError(
          "CONNECTOR_NOT_FOUND",
          "No connector matches the exact private endpoint generation.",
        );
      }
      const affectedAliases = new Set<string>();
      for (const route of state.routes) {
        if (!sameEndpoint(route.binding, identity)) continue;
        affectedAliases.add(route.alias);
      }
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        affectedAliases,
        inFlightSettlements,
      );
      connector.health = "offline";
      connector.updatedAt = now.toISOString();
      connector.safeErrorCode = safeErrorCode;
      for (const route of state.routes) {
        if (!sameEndpoint(route.binding, identity)) continue;
        route.state = route.enabled ? "stale" : "disabled";
        route.updatedAt = now.toISOString();
        route.safeErrorCode = safeErrorCode;
      }
      return this.terminateAffectedMessages(
        state,
        affectedAliases,
        now,
        safeErrorCode,
        settlementPlan,
        options.preserveQueued === true,
      );
    });
  }

  async registerRoute(input: RegisterRouteInput): Promise<void> {
    await this.mutate(async (state, now) => {
      this.validateRouteInput(input);
      this.assertAllowedIdentity(endpointOf(input.binding));
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, input.binding),
      );
      if (
        !connector ||
        !["healthy", "degraded"].includes(connector.health)
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The exact live endpoint generation must be observed before a route can be registered.",
        );
      }
      const byAlias = state.routes.find((route) => route.alias === input.alias);
      const byBinding = state.routes.find((route) =>
        sameRouteTarget(route.binding, input.binding),
      );
      if (byAlias) {
        if (!sameBinding(byAlias.binding, input.binding)) {
          throw new BridgeError(
            "ROUTE_ALIAS_COLLISION",
            "The public alias is already bound to another private route.",
          );
        }
        if (byAlias.registrationMode !== input.registrationMode) {
          throw new BridgeError(
            "ROUTE_REGISTRATION_MISMATCH",
            "The route registration mode cannot change for an existing binding.",
          );
        }
        byAlias.enabled = true;
        byAlias.state = input.state ?? "idle";
        byAlias.updatedAt = now.toISOString();
        byAlias.lastSeenAt = now.toISOString();
        delete byAlias.safeErrorCode;
        return;
      }
      if (byBinding) {
        throw new BridgeError(
          "ROUTE_BINDING_COLLISION",
          "The private route is already registered under another public alias.",
        );
      }
      if (
        state.routes.some(
          (route) => route.binding.ownerLease === input.binding.ownerLease,
        )
      ) {
        throw new BridgeError(
          "ROUTE_LEASE_COLLISION",
          "The private ownership lease already belongs to another route.",
        );
      }
      if (state.routes.length >= this.config.limits.maxRoutes) {
        throw new BridgeError(
          "ROUTE_CAPACITY_REACHED",
          "The bounded gateway route registry is full.",
          true,
        );
      }
      state.routes.push({
        alias: input.alias,
        binding: { ...input.binding },
        registrationMode: input.registrationMode,
        enabled: true,
        state: input.state ?? "idle",
        busyPolicy: "queue",
        registeredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        queueDepth: state.queue.filter(
          (item) => item.targetAlias === input.alias,
        ).length,
        counters: emptyCounters(),
      });
    });
  }

  /**
   * Replace the complete selected-Claude set with one exact live session in a
   * single durable mutation. Work owned by every retired selection settles by
   * the same evidence-aware rules as explicit unselection; no public snapshot
   * can observe a two-selection intermediate state.
   */
  async replaceClaudeSelection(
    input: ReplaceClaudeSelectionInput,
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      const replacement = input.replacement;
      this.validateRouteInput(replacement);
      this.assertAllowedIdentity(endpointOf(replacement.binding));
      if (
        replacement.binding.provider !== "claude" ||
        replacement.registrationMode !== "selected_live_peer"
      ) {
        throw new BridgeError(
          "INVALID_CLAUDE_SELECTION_REPLACEMENT",
          "A Claude selection replacement must name one exact selected live peer.",
        );
      }
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, replacement.binding),
      );
      if (
        !connector ||
        !["healthy", "degraded"].includes(connector.health)
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The exact live endpoint generation must be observed before a Claude selection can replace another.",
        );
      }

      const selectedClaudeRoutes = state.routes.filter(
        (route) =>
          route.binding.provider === "claude" &&
          route.registrationMode === "selected_live_peer",
      );
      const logicalMatches = selectedClaudeRoutes.filter(
        (route) =>
          route.binding.hostId === replacement.binding.hostId &&
          route.binding.routeHandle === replacement.binding.routeHandle &&
          route.binding.ownerLease === replacement.binding.ownerLease,
      );
      if (logicalMatches.length > 1) {
        throw new BridgeError(
          "CLAUDE_SELECTION_STATE_CORRUPT",
          "More than one durable selection claims the same exact Claude session authority.",
        );
      }
      const retained = logicalMatches[0];
      if (
        retained !== undefined &&
        !sameBinding(retained.binding, replacement.binding) &&
        (!retained.enabled || retained.state !== "stale")
      ) {
        throw new BridgeError(
          "ROUTE_REBIND_IDENTITY_MISMATCH",
          "Only a stale exact Claude session may adopt a newly observed endpoint generation during replacement.",
        );
      }
      const aliasOwner = state.routes.find(
        (route) => route.alias === replacement.alias,
      );
      if (
        aliasOwner !== undefined &&
        aliasOwner !== retained &&
        !selectedClaudeRoutes.includes(aliasOwner)
      ) {
        throw new BridgeError(
          "ROUTE_ALIAS_COLLISION",
          "The replacement alias belongs to a different non-retired route.",
        );
      }

      // Replacing an endpoint is scoped to the replacement alias. Other
      // selected Claude routes and their independent consent edges survive.
      const retired = selectedClaudeRoutes.filter(
        (route) => route !== retained && route === aliasOwner,
      );
      if (
        state.routes.some(
          (route) =>
            route !== retained &&
            !retired.includes(route) &&
            (sameRouteTarget(route.binding, replacement.binding) ||
              route.binding.ownerLease === replacement.binding.ownerLease),
        )
      ) {
        throw new BridgeError(
          "ROUTE_BINDING_COLLISION",
          "The replacement Claude authority collides with a non-retired route.",
        );
      }
      const retiredAliases = new Set(retired.map((route) => route.alias));
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        retiredAliases,
        input.inFlightSettlements ?? [],
      );
      this.settleProgressWatchesForAliases(state, retiredAliases, now);
      const settlements = this.terminateAffectedMessages(
        state,
        retiredAliases,
        now,
        "ROUTE_UNREGISTERED",
        settlementPlan,
      );
      state.routes = state.routes.filter((route) => !retired.includes(route));
      removeConsentEdgesForAliases(state, retiredAliases);
      state.rateBuckets = state.rateBuckets.filter(
        (bucket) => !retiredAliases.has(bucket.sourceAlias),
      );
      state.dedupe = state.dedupe.filter(
        (record) =>
          !retiredAliases.has(record.sourceAlias) &&
          !retiredAliases.has(record.targetAlias),
      );

      if (retained !== undefined) {
        const previousAlias = retained.alias;
        retained.alias = replacement.alias;
        retained.binding = { ...replacement.binding };
        retained.enabled = true;
        retained.state = replacement.state ?? "idle";
        retained.updatedAt = now.toISOString();
        retained.lastSeenAt = now.toISOString();
        delete retained.safeErrorCode;
        if (previousAlias !== replacement.alias) {
          for (const item of [...state.queue, ...state.inFlight]) {
            if (item.sourceAlias === previousAlias) {
              item.sourceAlias = replacement.alias;
            }
            if (item.targetAlias === previousAlias) {
              item.targetAlias = replacement.alias;
            }
          }
          for (const record of state.dedupe) {
            if (record.sourceAlias === previousAlias) {
              record.sourceAlias = replacement.alias;
            }
            if (record.targetAlias === previousAlias) {
              record.targetAlias = replacement.alias;
            }
          }
          renameRateBucket(state, previousAlias, replacement.alias);
          renameConsentEdgeAlias(state, previousAlias, replacement.alias, now);
          renameProgressWatchAlias(
            state,
            previousAlias,
            replacement.alias,
          );
        }
      } else {
        if (state.routes.length >= this.config.limits.maxRoutes) {
          throw new BridgeError(
            "ROUTE_CAPACITY_REACHED",
            "The bounded gateway route registry is full.",
            true,
          );
        }
        state.routes.push({
          alias: replacement.alias,
          binding: { ...replacement.binding },
          registrationMode: replacement.registrationMode,
          enabled: true,
          state: replacement.state ?? "idle",
          busyPolicy: "queue",
          registeredAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          queueDepth: state.queue.filter(
            (item) => item.targetAlias === replacement.alias,
          ).length,
          counters: emptyCounters(),
        });
      }

      if (
        state.routes.filter(
          (route) =>
            route.alias === replacement.alias &&
            route.binding.provider === "claude" &&
            route.registrationMode === "selected_live_peer" &&
            sameBinding(route.binding, replacement.binding),
        ).length !== 1
      ) {
        throw new BridgeError(
          "CLAUDE_SELECTION_STATE_CORRUPT",
          "A successful endpoint replacement must leave exactly one matching Claude route.",
        );
      }
      return settlements;
    });
  }

  async observeRoute(input: ObserveRouteInput): Promise<void> {
    await this.mutate(async (state, now) => {
      if (
        !isPrivateRouteBinding(input.binding) ||
        (input.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(input.safeErrorCode))
      ) {
        throw new BridgeError(
          "INVALID_ROUTE_OBSERVATION",
          "The exact route observation contains an unsupported private or normalized field.",
        );
      }
      this.assertAllowedIdentity(endpointOf(input.binding));
      const route = state.routes.find((candidate) =>
        sameBinding(candidate.binding, input.binding),
      );
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, input.binding),
      );
      if (!route || !route.enabled) {
        throw new BridgeError(
          "ROUTE_OWNERSHIP_MISMATCH",
          "No enabled route matches the exact private binding and ownership lease.",
        );
      }
      const endpointObservationValid =
        input.state === "stale"
          ? connector?.health === "degraded"
          : connector !== undefined &&
            ["healthy", "degraded"].includes(connector.health);
      if (!endpointObservationValid) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The route observation must match the exact endpoint generation's current health.",
        );
      }
      route.state = input.state;
      route.lastSeenAt = now.toISOString();
      route.updatedAt = now.toISOString();
      if (input.safeErrorCode) route.safeErrorCode = input.safeErrorCode;
      else delete route.safeErrorCode;
    });
  }

  async invalidateRoute(
    binding: PrivateRouteBinding,
    safeErrorCode = "ROUTE_STALE",
    inFlightSettlements: readonly RouteInFlightSettlementInput[] = [],
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      if (
        !isPrivateRouteBinding(binding) ||
        !SAFE_CODE_PATTERN.test(safeErrorCode)
      ) {
        throw new BridgeError(
          "INVALID_ROUTE_INVALIDATION",
          "Route invalidation requires an exact private binding and normalized safe code.",
        );
      }
      this.assertAllowedIdentity(endpointOf(binding));
      const route = state.routes.find((candidate) =>
        sameBinding(candidate.binding, binding),
      );
      if (!route || !route.enabled) {
        throw new BridgeError(
          "ROUTE_OWNERSHIP_MISMATCH",
          "No enabled route matches the exact private binding and ownership lease.",
        );
      }
      const aliases = new Set([route.alias]);
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        aliases,
        inFlightSettlements,
      );
      route.state = "stale";
      route.updatedAt = now.toISOString();
      route.safeErrorCode = safeErrorCode;
      return this.terminateAffectedMessages(
        state,
        aliases,
        now,
        safeErrorCode,
        settlementPlan,
      );
    });
  }

  /**
   * Replaces only an already-invalidated binding. Codex must retain the exact
   * task handle. Claude must retain its exact session UUID and ownership lease;
   * an authorized discovery may also atomically adopt that UUID's latest live
   * display name. Names alone are never rebind authority.
   */
  async rebindStaleRoute(input: RebindStaleRouteInput): Promise<void> {
    await this.mutate(async (state, now) => {
      const newAlias = input.newAlias ?? input.alias;
      if (
        !ALIAS_PATTERN.test(input.alias) ||
        !ALIAS_PATTERN.test(newAlias) ||
        !isPrivateRouteBinding(input.newBinding) ||
        !newAlias.endsWith(`@${input.newBinding.hostId}`) ||
        (input.journalReason !== undefined &&
          input.journalReason !== "boot_reactivation")
      ) {
        throw new BridgeError(
          "INVALID_ROUTE_REBIND",
          "The stale-route rebind request is malformed.",
        );
      }
      this.assertAllowedIdentity(endpointOf(input.newBinding));
      const route = this.requireOwnedRoute(
        state,
        input.alias,
        input.currentOwnerLease,
      );
      if (
        !route.enabled ||
        route.state !== "stale" ||
        state.inFlight.some(
          (item) =>
            item.sourceAlias === route.alias || item.targetAlias === route.alias,
        )
      ) {
        throw new BridgeError(
          "ROUTE_REBIND_NOT_SAFE",
          "Only an enabled, expired stale route without in-flight work can be rebound.",
        );
      }
      if (
        route.binding.provider !== input.newBinding.provider ||
        route.binding.hostId !== input.newBinding.hostId
      ) {
        throw new BridgeError(
          "ROUTE_REBIND_SCOPE_MISMATCH",
          "A route rebind cannot change provider or allowlisted host.",
        );
      }
      const sameLogicalRoute =
        route.binding.routeHandle === input.newBinding.routeHandle &&
        route.binding.ownerLease === input.newBinding.ownerLease;
      const claudeReasonAllowed =
        input.reason === "peer_explicitly_reselected" ||
        input.reason === "peer_identity_reobserved";
      if (
        (route.binding.provider === "codex" &&
          (input.reason !== "endpoint_reobserved" || !sameLogicalRoute)) ||
        (route.binding.provider === "claude" &&
          (!claudeReasonAllowed || !sameLogicalRoute))
      ) {
        throw new BridgeError(
          "ROUTE_RESELECTION_REQUIRED",
          "A stale route may rebind only the same provider-native logical identity and ownership lease.",
        );
      }
      if (
        input.journalReason === "boot_reactivation" &&
        route.binding.provider !== "codex"
      ) {
        throw new BridgeError(
          "INVALID_ROUTE_REBIND",
          "Only an exact retained Codex route may record boot reactivation.",
        );
      }
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, input.newBinding),
      );
      if (
        !connector ||
        !["healthy", "degraded"].includes(connector.health)
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The replacement endpoint generation must be positively observed and live.",
        );
      }
      if (
        state.routes.some(
          (candidate) =>
            candidate !== route &&
            (candidate.alias === newAlias ||
              sameRouteTarget(candidate.binding, input.newBinding) ||
              candidate.binding.ownerLease === input.newBinding.ownerLease),
        )
      ) {
        throw new BridgeError(
          "ROUTE_BINDING_COLLISION",
          "The replacement private binding already belongs to another alias.",
        );
      }
      if (
        input.journalReason === "boot_reactivation" &&
        state.codexEndpointRefreshSequence >= Number.MAX_SAFE_INTEGER
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_SEQUENCE_EXHAUSTED",
          "The bounded Codex endpoint-refresh sequence is exhausted.",
        );
      }
      const previousAlias = route.alias;
      const oldEndpointGeneration = route.binding.endpointGeneration;
      route.binding = { ...input.newBinding };
      route.alias = newAlias;
      route.state = input.state ?? "idle";
      route.updatedAt = now.toISOString();
      route.lastSeenAt = now.toISOString();
      delete route.safeErrorCode;
      if (previousAlias !== newAlias) {
        // Retained queued mail follows only the exact re-observed logical
        // route. In-flight work remains forbidden above.
        for (const item of [...state.queue, ...state.inFlight]) {
          if (item.sourceAlias === previousAlias) item.sourceAlias = newAlias;
          if (item.targetAlias === previousAlias) item.targetAlias = newAlias;
        }
        for (const record of state.dedupe) {
          if (record.sourceAlias === previousAlias) {
            record.sourceAlias = newAlias;
          }
          if (record.targetAlias === previousAlias) {
            record.targetAlias = newAlias;
          }
        }
        renameRateBucket(state, previousAlias, newAlias);
        renameConsentEdgeAlias(state, previousAlias, newAlias, now);
      }
      if (input.journalReason === "boot_reactivation") {
        this.appendCodexEndpointRefreshEvent(state, {
          timestamp: now.toISOString(),
          alias: route.alias,
          hostId: route.binding.hostId,
          threadId: route.binding.routeHandle,
          oldEndpointGeneration,
          newEndpointGeneration: route.binding.endpointGeneration,
          reason: "boot_reactivation",
        });
      }
    });
  }

  /**
   * Atomically re-anchor only the exact Codex tasks proved present on a newly
   * compatible App Server generation. Omitted stale tasks stay untouched.
   */
  async reanchorCodexRoutes(
    input: ReanchorCodexRoutesInput,
  ): Promise<ReanchorCodexRoutesResult> {
    return await this.mutate(async (state, now) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, ["oldEndpoint", "newEndpoint", "routes"]) ||
        !isPrivateEndpointIdentity(input.oldEndpoint) ||
        !isPrivateEndpointIdentity(input.newEndpoint) ||
        input.oldEndpoint.provider !== "codex" ||
        input.newEndpoint.provider !== "codex" ||
        input.oldEndpoint.hostId !== input.newEndpoint.hostId ||
        input.oldEndpoint.endpointGeneration ===
          input.newEndpoint.endpointGeneration ||
        !Array.isArray(input.routes) ||
        input.routes.length > this.config.limits.maxRoutes
      ) {
        throw new BridgeError(
          "INVALID_CODEX_ENDPOINT_REFRESH",
          "Codex endpoint refresh requires two distinct exact generations on one allowlisted host and a bounded route subset.",
        );
      }
      this.assertAllowedIdentity(input.oldEndpoint);
      this.assertAllowedIdentity(input.newEndpoint);
      const newConnector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, input.newEndpoint),
      );
      if (
        newConnector === undefined ||
        !["healthy", "degraded"].includes(newConnector.health)
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The replacement Codex endpoint generation must be positively observed and live.",
        );
      }

      const aliases = new Set<string>();
      const threadIds = new Set<string>();
      const ownerLeases = new Set<string>();
      const replacements: Array<{
        route: GatewayRouteRecord;
        state: "idle" | "busy" | "awaiting_approval";
      }> = [];
      for (const candidate of input.routes) {
        if (
          !isObject(candidate) ||
          !hasOnlyKeys(
            candidate,
            ["alias", "threadId", "ownerLease"],
            ["state"],
          ) ||
          typeof candidate.alias !== "string" ||
          !ALIAS_PATTERN.test(candidate.alias) ||
          !candidate.alias.startsWith("codex-") ||
          !candidate.alias.endsWith(`@${input.oldEndpoint.hostId}`) ||
          !isPrivateToken(candidate.threadId) ||
          !isPrivateToken(candidate.ownerLease) ||
          (candidate.state !== undefined &&
            candidate.state !== "idle" &&
            candidate.state !== "busy" &&
            candidate.state !== "awaiting_approval")
        ) {
          throw new BridgeError(
            "INVALID_CODEX_ENDPOINT_REFRESH",
            "A Codex endpoint refresh route proof is malformed.",
          );
        }
        if (
          aliases.has(candidate.alias) ||
          threadIds.has(candidate.threadId) ||
          ownerLeases.has(candidate.ownerLease)
        ) {
          throw new BridgeError(
            "AMBIGUOUS_CODEX_ENDPOINT_REFRESH",
            "A Codex endpoint refresh cannot contain duplicate alias, task, or lease claims.",
          );
        }
        aliases.add(candidate.alias);
        threadIds.add(candidate.threadId);
        ownerLeases.add(candidate.ownerLease);
        const route = state.routes.find(
          (stored) => stored.alias === candidate.alias,
        );
        if (
          route === undefined ||
          route.binding.provider !== "codex" ||
          route.registrationMode !== "explicit_opt_in" ||
          !route.enabled ||
          route.state !== "stale" ||
          !sameEndpoint(route.binding, input.oldEndpoint) ||
          route.binding.routeHandle !== candidate.threadId ||
          route.binding.ownerLease !== candidate.ownerLease ||
          state.inFlight.some(
            (item) =>
              item.sourceAlias === route.alias ||
              item.targetAlias === route.alias,
          )
        ) {
          throw new BridgeError(
            "CODEX_ENDPOINT_REFRESH_NOT_SAFE",
            "Only an exact enabled, expired stale Codex task without in-flight work may be refreshed.",
          );
        }
        const newBinding: PrivateRouteBinding = {
          ...route.binding,
          endpointGeneration: input.newEndpoint.endpointGeneration,
        };
        if (
          state.routes.some(
            (stored) =>
              stored !== route &&
              (sameRouteTarget(stored.binding, newBinding) ||
                stored.binding.ownerLease === newBinding.ownerLease),
          )
        ) {
          throw new BridgeError(
            "ROUTE_BINDING_COLLISION",
            "A refreshed Codex task or ownership lease is already claimed by another route.",
          );
        }
        replacements.push({ route, state: candidate.state ?? "idle" });
      }

      if (
        state.codexEndpointRefreshSequence >
        Number.MAX_SAFE_INTEGER - replacements.length
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_SEQUENCE_EXHAUSTED",
          "The bounded Codex endpoint-refresh sequence is exhausted.",
        );
      }

      for (const replacement of replacements) {
        const oldEndpointGeneration =
          replacement.route.binding.endpointGeneration;
        replacement.route.binding = {
          ...replacement.route.binding,
          endpointGeneration: input.newEndpoint.endpointGeneration,
        };
        replacement.route.state = replacement.state;
        replacement.route.updatedAt = now.toISOString();
        replacement.route.lastSeenAt = now.toISOString();
        delete replacement.route.safeErrorCode;
        this.appendCodexEndpointRefreshEvent(state, {
          timestamp: now.toISOString(),
          alias: replacement.route.alias,
          hostId: replacement.route.binding.hostId,
          threadId: replacement.route.binding.routeHandle,
          oldEndpointGeneration,
          newEndpointGeneration: input.newEndpoint.endpointGeneration,
        });
      }
      return { reboundAliases: replacements.map(({ route }) => route.alias) };
    });
  }

  /**
   * Dashboard recovery primitive for one abandoned Codex registration. The
   * alias is only authority to request evaluation; durable state must prove
   * the task is empty, stale, expired, and on a dead or superseded generation.
   */
  async removeStaleCodexOrphan(
    input: RemoveStaleCodexOrphanInput,
  ): Promise<RemoveStaleCodexOrphanResult> {
    return await this.mutate(async (state, now) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, ["alias"]) ||
        typeof input.alias !== "string"
      ) {
        throw new BridgeError(
          "INVALID_CODEX_ORPHAN_RECOVERY",
          "Codex orphan recovery requires one exact Codex alias.",
        );
      }
      const route = this.requireStaleCodexOrphan(state, input.alias);

      const aliases = new Set([route.alias]);
      const removedEdges = state.consentEdges
        .filter((edge) => edge.endpoints.some(({ alias }) => alias === route.alias))
        .map((edge) => ({ aliases: edge.endpoints.map(({ alias }) => alias) as [string, string] }));
      if (state.codexOrphanRemovalSequence >= Number.MAX_SAFE_INTEGER) {
        throw new BridgeError(
          "CODEX_ORPHAN_REMOVAL_SEQUENCE_EXHAUSTED",
          "The bounded Codex orphan-removal sequence is exhausted.",
        );
      }
      this.settleProgressWatchesForAliases(state, aliases, now);
      state.routes = state.routes.filter((candidate) => candidate !== route);
      removeConsentEdgesForAliases(state, aliases);
      state.rateBuckets = state.rateBuckets.filter(
        (bucket) => bucket.sourceAlias !== route.alias,
      );
      state.dedupe = state.dedupe.filter(
        (record) =>
          record.sourceAlias !== route.alias &&
          record.targetAlias !== route.alias,
      );
      this.appendCodexOrphanRemovalEvent(state, {
        timestamp: now.toISOString(),
        alias: route.alias,
        hostId: route.binding.hostId,
      });
      return {
        alias: route.alias,
        binding: { ...route.binding },
        removedEdges,
      };
    });
  }

  async disableRoute(
    alias: string,
    ownerLease: string,
    inFlightSettlements: readonly RouteInFlightSettlementInput[] = [],
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      const route = this.requireOwnedRoute(state, alias, ownerLease);
      const aliases = new Set([route.alias]);
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        aliases,
        inFlightSettlements,
      );
      route.enabled = false;
      route.state = "disabled";
      route.updatedAt = now.toISOString();
      return this.terminateAffectedMessages(
        state,
        aliases,
        now,
        "ROUTE_DISABLED",
        settlementPlan,
      );
    });
  }

  async unregisterRoute(
    alias: string,
    ownerLease: string,
    inFlightSettlements: readonly RouteInFlightSettlementInput[] = [],
    progressWatchSettlementActor: "gateway" | "operator" = "gateway",
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      const route = this.requireOwnedRoute(state, alias, ownerLease);
      const aliases = new Set([route.alias]);
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        aliases,
        inFlightSettlements,
      );
      this.settleProgressWatchesForAliases(
        state,
        aliases,
        now,
        progressWatchSettlementActor,
      );
      const settlements = this.terminateAffectedMessages(
        state,
        aliases,
        now,
        "ROUTE_UNREGISTERED",
        settlementPlan,
      );
      state.routes = state.routes.filter((candidate) => candidate !== route);
      removeConsentEdgesForAliases(state, aliases);
      const remainingCodexHosts = new Set(
        state.routes
          .filter((candidate) => candidate.binding.provider === "codex")
          .map((candidate) => candidate.binding.hostId),
      );
      state.rateBuckets = state.rateBuckets.filter(
        (bucket) =>
          bucket.sourceAlias !== route.alias &&
          (state.routes.some(
            (candidate) => candidate.alias === bucket.sourceAlias,
          ) ||
            remainingCodexHosts.has(
              bucket.sourceAlias.slice(bucket.sourceAlias.lastIndexOf("@") + 1),
            )),
      );
      state.dedupe = state.dedupe.filter(
        (record) =>
          record.sourceAlias !== route.alias &&
          record.targetAlias !== route.alias,
      );
      return settlements;
    });
  }

  /**
   * Move one owned route to its provider's latest live display name without
   * changing the logical provider route binding. Historical normalized events
   * retain the name that was true when they were emitted; active metadata is
   * rewritten so subsequent settlement and dispatch use only the latest name.
   */
  async renameRoute(
    alias: string,
    newAlias: string,
    ownerLease: string,
  ): Promise<void> {
    await this.mutate(async (state, now) => {
      if (!ALIAS_PATTERN.test(newAlias)) {
        throw new BridgeError(
          "INVALID_ROUTE_ALIAS",
          "The replacement route alias is invalid.",
        );
      }
      const route = this.requireOwnedRoute(state, alias, ownerLease);
      if (alias === newAlias) return;
      if (state.routes.some((candidate) => candidate.alias === newAlias)) {
        throw new BridgeError(
          "ROUTE_ALIAS_COLLISION",
          "The replacement alias already belongs to another route.",
        );
      }

      route.alias = newAlias;
      route.updatedAt = now.toISOString();
      route.lastSeenAt = now.toISOString();
      for (const item of [...state.queue, ...state.inFlight]) {
        if (item.sourceAlias === alias) item.sourceAlias = newAlias;
        if (item.targetAlias === alias) item.targetAlias = newAlias;
      }
      for (const record of state.dedupe) {
        if (record.sourceAlias === alias) record.sourceAlias = newAlias;
        if (record.targetAlias === alias) record.targetAlias = newAlias;
      }
      renameRateBucket(state, alias, newAlias);
      renameConsentEdgeAlias(state, alias, newAlias, now);
      renameProgressWatchAlias(state, alias, newAlias);
    });
  }

  async resolveRoute(alias: string): Promise<PrivateRouteBinding> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const route = state.routes.find((candidate) => candidate.alias === alias);
      if (
        route?.enabled === true &&
        route.binding.provider === "codex" &&
        route.state === "stale" &&
        route.safeErrorCode === "CODEX_ROUTE_STALE"
      ) {
        throw new BridgeError(
          "CODEX_ROUTE_STALE",
          "The selected Codex route exists but its connector is stale.",
          true,
        );
      }
      if (
        !route ||
        !route.enabled ||
        !["idle", "busy", "awaiting_approval"].includes(route.state)
      ) {
        throw new BridgeError(
          "ROUTE_UNAVAILABLE",
          "The selected route is not currently enabled and positively observed.",
          true,
        );
      }
      return { ...route.binding };
    });
  }

  /**
   * Controller-internal ownership lookup used for explicit reactivation and
   * unregister after restart. Callers must never return this value through a
   * control response, dashboard projection, log, or normalized event.
   */
  async inspectPrivateRoute(
    alias: string,
  ): Promise<GatewayPrivateRouteInspection | undefined> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      if (!ALIAS_PATTERN.test(alias)) {
        throw new BridgeError(
          "INVALID_GATEWAY_ALIAS",
          "The selected alias does not use the required lowercase ASCII grammar.",
        );
      }
      const route = state.routes.find((candidate) => candidate.alias === alias);
      if (!route) return undefined;
      return {
        alias: route.alias,
        binding: { ...route.binding },
        registrationMode: route.registrationMode,
        enabled: route.enabled,
        state: route.state,
        ...(route.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: route.safeErrorCode }),
      };
    });
  }

  /**
   * Read-only preflight for service-side provider cleanup. Removal repeats the
   * identical proof atomically so no intervening state change can authorize it.
   */
  async inspectStaleCodexOrphan(
    alias: string,
  ): Promise<PrivateRouteBinding> {
    return this.mutex.run("gateway", async () => {
      const route = this.requireStaleCodexOrphan(this.requireState(), alias);
      return { ...route.binding };
    });
  }

  /**
   * Capture the exact pre-mutation authority needed to reconcile a possible
   * post-rename orphan-removal commit. This value remains controller-private.
   */
  async inspectStaleCodexOrphanRemovalAuthority(
    alias: string,
  ): Promise<StaleCodexOrphanRemovalAuthority> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const route = this.requireStaleCodexOrphan(state, alias);
      return {
        binding: { ...route.binding },
        previousSequence: state.codexOrphanRemovalSequence,
      };
    });
  }

  /**
   * Fail-closed reconciliation for one exact removal whose durable rename may
   * have committed before a directory-sync error. The latest private journal
   * row, monotonic predecessor, alias absence, and native authority absence
   * must all corroborate the same mutation.
   */
  async wasStaleCodexOrphanRemovalCommitted(
    input: StaleCodexOrphanRemovalCommitProofInput,
  ): Promise<boolean> {
    return this.mutex.run("gateway", async () => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, ["alias", "binding", "previousSequence"]) ||
        typeof input.alias !== "string" ||
        !ALIAS_PATTERN.test(input.alias) ||
        !input.alias.startsWith("codex-") ||
        !isPrivateRouteBinding(input.binding) ||
        input.binding.provider !== "codex" ||
        !input.alias.endsWith(`@${input.binding.hostId}`) ||
        !isNonNegativeInteger(input.previousSequence) ||
        input.previousSequence >= Number.MAX_SAFE_INTEGER
      ) {
        throw new BridgeError(
          "INVALID_CODEX_ORPHAN_COMMIT_PROOF",
          "Codex orphan-removal reconciliation requires one exact private pre-mutation authority.",
        );
      }
      this.assertAllowedIdentity(endpointOf(input.binding));
      const state = this.requireState();
      const expectedSequence = input.previousSequence + 1;
      const latest = state.codexOrphanRemovalEvents.at(-1);
      const routeOrAuthorityPresent = state.routes.some(
        (route) =>
          route.alias === input.alias ||
          sameRouteTarget(route.binding, input.binding) ||
          route.binding.ownerLease === input.binding.ownerLease,
      );
      return (
        !routeOrAuthorityPresent &&
        state.codexOrphanRemovalSequence === expectedSequence &&
        latest?.sequence === expectedSequence &&
        latest.alias === input.alias &&
        latest.hostId === input.binding.hostId
      );
    });
  }

  /**
   * Controller-internal inventory used to preserve exact Codex registration
   * identities across restart. Native task handles never cross the control
   * protocol or enter a public projection.
   */
  async inspectPrivateCodexRoutes(): Promise<
    GatewayPrivateRouteInspection[]
  > {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      return state.routes
        .filter(
          (route) =>
            route.binding.provider === "codex" &&
            route.registrationMode === "explicit_opt_in",
        )
        .slice(0, this.config.limits.maxRoutes)
        .map((route) => ({
          alias: route.alias,
          binding: { ...route.binding },
          registrationMode: route.registrationMode,
          enabled: route.enabled,
          state: route.state,
        }));
    });
  }

  /**
   * Bounded, metadata-only barrier observation for the succession controller.
   * No route, message, conversation, or listener identifier is returned.
   */
  async inspectCodexSuccessionBarrier(
    alias: string,
  ): Promise<CodexSuccessionBarrierInspection> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const codexRoutes = state.routes.filter(
        (route) =>
          route.binding.provider === "codex" && route.alias === alias,
      );
      const codexQueueDepth = codexRoutes.reduce(
        (total, route) => total + route.queueDepth,
        0,
      );
      const queued = state.queue.filter(
        (item) => item.sourceAlias === alias || item.targetAlias === alias,
      );
      const inFlight = state.inFlight.filter(
        (item) => item.sourceAlias === alias || item.targetAlias === alias,
      );
      const ownedMessageIds = new Set([
        ...queued.map((item) => item.messageId),
        ...inFlight.map((item) => item.messageId),
      ]);
      const transientBodyCount = [...this.transientBodies.keys()].filter(
        (messageId) => ownedMessageIds.has(messageId),
      ).length;
      const inspection: CodexSuccessionBarrierInspection = {
        codexRouteCount: codexRoutes.length,
        queueCount: queued.length,
        inFlightCount: inFlight.length,
        transientBodyCount,
        codexQueueDepth,
        clean:
          codexRoutes.length === 1 &&
          queued.length === 0 &&
          inFlight.length === 0 &&
          transientBodyCount === 0 &&
          codexQueueDepth === 0,
      };
      return inspection;
    });
  }

  /** Begin one exact, same-host Codex registration succession. */
  async prepareCodexSuccession(
    input: PrepareCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, ["old", "new"]) ||
        !isCodexSuccessionIdentity(input.old) ||
        !isCodexSuccessionIdentity(input.new) ||
        !isCodexSuccessionJournal({
          schemaVersion: 1,
          stage: "prepared",
          old: input.old,
          new: input.new,
        })
      ) {
        throw new BridgeError(
          "INVALID_CODEX_SUCCESSION",
          "The Codex succession identities are malformed, non-distinct, or cross-host.",
        );
      }
      this.assertAllowedIdentity(endpointOf(input.old.binding));
      this.assertAllowedIdentity(endpointOf(input.new.binding));
      if (state.codexSuccession !== null) {
        throw new BridgeError(
          "CODEX_SUCCESSION_ALREADY_ACTIVE",
          "A durable Codex succession journal already exists.",
        );
      }
      this.assertSuccessionLedgerEmpty(state, input.old.alias);
      const route = this.requireCodexRouteForIdentity(state, input.old);
      if (!routeMatchesSuccessionIdentity(route, input.old)) {
        throw new BridgeError(
          "CODEX_SUCCESSION_OWNER_MISMATCH",
          "The old succession identity does not exactly own its Codex route.",
        );
      }
      this.requireObservedEndpoint(state, input.new.binding);
      this.assertNewSuccessionIdentityAvailable(state, route, input.new);
      state.codexSuccession = {
        schemaVersion: 1,
        stage: "prepared",
        old: cloneSuccessionIdentity(input.old),
        new: cloneSuccessionIdentity(input.new),
      };
    });
  }

  /** Durably closes the rollback-to-old boundary before registry publication. */
  async armCodexSuccessionPublication(
    input: ExactCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      const journal = this.requireExactSuccession(
        state,
        input,
        ["prepared"],
      );
      this.assertSuccessionLedgerEmpty(state, journal.old.alias);
      this.requireJournalRoute(state, journal, "old");
      state.codexSuccession = { ...journal, stage: "publication_armed" };
    });
  }

  /** Record that the exact new registry generation is externally visible. */
  async markCodexSuccessionPublished(
    input: ExactCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      const journal = this.requireExactSuccession(
        state,
        input,
        ["publication_armed"],
      );
      this.assertSuccessionLedgerEmpty(state, journal.old.alias);
      this.requireJournalRoute(state, journal, "old");
      state.codexSuccession = { ...journal, stage: "published" };
    });
  }

  /**
   * Atomically replace the sole old Codex route with the exact journaled new
   * private binding. No route gap is ever persisted.
   */
  async activateCodexSuccession(
    input: ActivateCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state, now) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, ["oldGeneration", "newGeneration", "state"]) ||
        !["idle", "busy", "awaiting_approval"].includes(input.state)
      ) {
        throw new BridgeError(
          "INVALID_CODEX_SUCCESSION",
          "The Codex succession activation request is malformed.",
        );
      }
      const journal = this.requireExactSuccession(
        state,
        {
          oldGeneration: input.oldGeneration,
          newGeneration: input.newGeneration,
        },
        ["published"],
      );
      this.assertSuccessionLedgerEmpty(state, journal.old.alias);
      const route = this.requireJournalRoute(state, journal, "old");
      this.requireObservedEndpoint(state, journal.new.binding);
      this.assertNewSuccessionIdentityAvailable(state, route, journal.new);
      this.replaceCodexRouteForSuccession(
        state,
        route,
        journal.new,
        now,
        input.state,
      );
      state.codexSuccession = { ...journal, stage: "activated" };
    });
  }

  /** Record an armed-or-later failure for fail-closed restart authority. */
  async forbidCodexSuccessionRecovery(
    input: ForbidCodexSuccessionRecoveryInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(input, [
          "oldGeneration",
          "newGeneration",
          "safeErrorCode",
        ]) ||
        !isSafeCode(input.safeErrorCode)
      ) {
        throw new BridgeError(
          "INVALID_CODEX_SUCCESSION",
          "The Codex recovery-forbidden request is malformed.",
        );
      }
      const journal = this.requireExactSuccession(
        state,
        {
          oldGeneration: input.oldGeneration,
          newGeneration: input.newGeneration,
        },
        [
          "publication_armed",
          "published",
          "activated",
          "recovery_forbidden",
        ],
      );
      this.assertSuccessionLedgerEmpty(state, journal.old.alias);
      const expected =
        journal.stage === "activated" ? "new" : undefined;
      if (expected !== undefined) this.requireJournalRoute(state, journal, expected);
      else {
        this.requireAnyJournalRoute(state, journal);
      }
      state.codexSuccession = {
        ...journal,
        stage: "recovery_forbidden",
        safeErrorCode: input.safeErrorCode,
      };
    });
  }

  /** Clear before arming, or after positive proof that an arm was unpublished. */
  async clearCodexSuccession(
    input: ClearCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      if (
        !isObject(input) ||
        !hasOnlyKeys(
          input,
          ["oldGeneration", "newGeneration"],
          ["publicationAbsenceConfirmed"],
        ) ||
        (input.publicationAbsenceConfirmed !== undefined &&
          input.publicationAbsenceConfirmed !== true)
      ) {
        throw new BridgeError(
          "INVALID_CODEX_SUCCESSION",
          "The Codex succession clear request is malformed.",
        );
      }
      const journal = this.requireExactSuccession(
        state,
        {
          oldGeneration: input.oldGeneration,
          newGeneration: input.newGeneration,
        },
        ["prepared", "publication_armed"],
      );
      if (
        journal.stage === "publication_armed" &&
        input.publicationAbsenceConfirmed !== true
      ) {
        throw new BridgeError(
          "CODEX_SUCCESSION_PUBLICATION_PROOF_REQUIRED",
          "Clearing an armed succession requires positive proof that publication is absent.",
        );
      }
      this.assertSuccessionLedgerEmpty(state, journal.old.alias);
      this.requireJournalRoute(state, journal, "old");
      state.codexSuccession = null;
    });
  }

  /** Complete an activated or restart-canonicalized new generation. */
  async completeCodexSuccession(
    input: ExactCodexSuccessionInput,
  ): Promise<void> {
    await this.mutate(async (state) => {
      const journal = this.requireExactSuccession(state, input, [
        "activated",
        "recovery_forbidden",
      ]);
      this.assertSuccessionLedgerEmpty(state, journal.new.alias);
      this.requireJournalRoute(state, journal, "new");
      state.codexSuccession = null;
    });
  }

  /** Controller-private restart authority; omitted from every public view. */
  async inspectCodexSuccessionRecoveryAuthority(): Promise<CodexSuccessionRecoveryAuthority> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const journal = this.journal(state);
      if (journal === null) return { authority: "none" };
      return {
        authority: journal.stage === "prepared" ? "old" : "new",
        journal: cloneSuccessionJournal(journal),
      };
    });
  }

  /**
   * Controller-internal inventory used only for exact-UUID Claude restoration
   * and explicit offline unselection. The result is bounded by maxRoutes and
   * must never cross the control protocol or enter a public projection.
   */
  async inspectPrivateClaudeRoutes(): Promise<
    GatewayPrivateRouteInspection[]
  > {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      return state.routes
        .filter(
          (route) =>
            route.binding.provider === "claude" &&
            route.registrationMode === "selected_live_peer",
        )
        .slice(0, this.config.limits.maxRoutes)
        .map((route) => ({
          alias: route.alias,
          binding: { ...route.binding },
          registrationMode: route.registrationMode,
          enabled: route.enabled,
          state: route.state,
        }));
    });
  }

  /** Create one explicit, durable consent edge between distinct providers. */
  async addConsentEdge(
    input: GatewayConsentEdgeInput,
  ): Promise<{ created: boolean }> {
    return this.mutate(async (state, now) => {
      const [left, right] = this.requireConsentEdgeRoutes(state, input);
      const endpoints = canonicalConsentEndpoints(left, right);
      const key = consentEdgeKey(endpoints);
      const existing = state.consentEdges.find(
        (edge) => consentEdgeKey(edge.endpoints) === key,
      );
      if (existing !== undefined) {
        if (
          existing.endpoints.some(
            (endpoint, index) =>
              endpoint.ownerLease !== endpoints[index]!.ownerLease,
          )
        ) {
          throw new BridgeError(
            "CONSENT_EDGE_AUTHORITY_MISMATCH",
            "The edge aliases no longer match their exact route authorities.",
          );
        }
        return { created: false };
      }
      if (state.consentEdges.length >= this.config.limits.maxConsentEdges) {
        throw new BridgeError(
          "CONSENT_EDGE_CAPACITY_REACHED",
          "The bounded permission graph cannot accept another consent edge.",
          true,
        );
      }
      state.consentEdges.push({
        endpoints,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        counters: emptyCounters(),
      });
      return { created: true };
    });
  }

  /** Bounded metadata-only graph inventory for controller inference. */
  async inspectConsentEdges(): Promise<GatewayConsentEdgeInput[]> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      return state.consentEdges
        .map(({ endpoints }) => ({
          aliases: endpoints.map(({ alias }) => alias) as [string, string],
        }))
        .sort((left, right) => left.aliases.join("\0").localeCompare(right.aliases.join("\0")));
    });
  }

  /** Resolve only an exact live watch; recovery may substitute its suffix. */
  async resolveProgressWatchDispatch(
    input: Readonly<{
      sourceAlias: string;
      targetAlias: string;
    }> &
      (
        | Readonly<{
            conversationId: string;
            recoveredConversationIdSuffix?: never;
          }>
        | Readonly<{
            conversationId?: never;
            recoveredConversationIdSuffix: string;
          }>
      ),
  ): Promise<Readonly<{ conversationId?: string; markerActive: boolean }>> {
    return this.mutex.run("gateway", async () => {
      if (
        !ALIAS_PATTERN.test(input.sourceAlias) ||
        !ALIAS_PATTERN.test(input.targetAlias) ||
        input.sourceAlias === input.targetAlias ||
        (input.conversationId === undefined) ===
          (input.recoveredConversationIdSuffix === undefined) ||
        (input.conversationId !== undefined &&
          !CONVERSATION_ID_PATTERN.test(input.conversationId)) ||
        (input.recoveredConversationIdSuffix !== undefined &&
          !CONVERSATION_SUFFIX_PATTERN.test(
            input.recoveredConversationIdSuffix,
          ))
      ) {
        throw new BridgeError(
          "INVALID_PROGRESS_WATCH",
          "The progress-watch dispatch lookup is malformed.",
        );
      }
      const state = this.requireState();
      const watch = state.progressWatches.find(
        (watch) =>
          (input.conversationId !== undefined
            ? watch.conversationId === input.conversationId
            : watch.conversationId.endsWith(
                input.recoveredConversationIdSuffix!,
              )) &&
          ((watch.ownerAlias === input.sourceAlias &&
            watch.workerAlias === input.targetAlias) ||
            (watch.ownerAlias === input.targetAlias &&
              watch.workerAlias === input.sourceAlias)),
      );
      if (watch === undefined) return { markerActive: false };
      const hasExactPair = state.consentEdges.some(
        (candidate) =>
          consentEdgeMatchesMessage(candidate, {
            sourceAlias: input.sourceAlias,
            targetAlias: input.targetAlias,
            pair: true,
          }) && progressWatchMatchesConsentEdge(watch, candidate),
      );
      if (!hasExactPair) return { markerActive: false };
      return {
        conversationId: watch.conversationId,
        markerActive:
          watch.ownerAlias === input.sourceAlias &&
          watch.workerAlias === input.targetAlias,
      };
    });
  }

  async touchProgressWatchesForAlias(alias: string): Promise<number> {
    return this.mutate(async (state, now) => {
      if (!ALIAS_PATTERN.test(alias)) return 0;
      let changed = 0;
      for (let index = 0; index < state.progressWatches.length; index += 1) {
        const watch = state.progressWatches[index];
        if (
          watch === undefined ||
          (watch.ownerAlias !== alias && watch.workerAlias !== alias)
        ) {
          continue;
        }
        state.progressWatches[index] = recordProgressWatchActivity(
          watch,
          now.getTime(),
        );
        changed += 1;
      }
      return changed;
    });
  }

  async endProgressWatch(conversationId: string): Promise<boolean> {
    return this.mutate(async (state, now) => {
      if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
        throw new BridgeError(
          "INVALID_PROGRESS_WATCH",
          "The progress-watch conversation token is malformed.",
        );
      }
      const index = state.progressWatches.findIndex(
        (watch) => watch.conversationId === conversationId,
      );
      const watch = state.progressWatches[index];
      if (watch === undefined) return false;
      this.appendProgressWatchEvents(state, [
        progressWatchJournalEvent(watch, now.toISOString(), {
          kind: "settled",
          actor: "operator",
          reason: "untracked",
        }),
      ]);
      state.progressWatches.splice(index, 1);
      return true;
    });
  }

  /** Advance every due watch once under one durable store mutation. */
  async advanceDueProgressWatches(): Promise<ProgressWatchNudge[]> {
    return this.mutate(async (state, now) => {
      const actions: ProgressWatchNudge[] = [];
      const retained: ProgressWatch[] = [];
      const events: PendingProgressWatchJournalEvent[] = [];
      for (const watch of state.progressWatches) {
        if (Date.parse(watch.nextActionAt) > now.getTime()) {
          retained.push(watch);
          continue;
        }
        const due = this.inspectProgressWatchDue(state, watch, now);
        if (due.kind === "not_due" || due.kind === "nudge") {
          retained.push(watch);
        } else if (due.kind === "rescheduled") {
          retained.push(due.watch);
        }
        if (due.kind === "nudge") {
          actions.push({
            conversationId: watch.conversationId,
            ownerAlias: watch.ownerAlias,
            workerAlias: watch.workerAlias,
            nudgeNumber: due.nudgeNumber,
          });
        } else if (due.kind === "settled") {
          events.push(
            progressWatchJournalEvent(watch, now.toISOString(), {
              kind: "settled",
              actor: "gateway",
              reason: "idle_timeout",
            }),
          );
        }
      }
      this.appendProgressWatchEvents(state, events);
      state.progressWatches = retained;
      return actions;
    });
  }

  async nextProgressWatchActionAt(): Promise<string | undefined> {
    return this.mutex.run("gateway", async () =>
      this.requireState().progressWatches.reduce<string | undefined>(
        (earliest, watch) =>
          earliest === undefined || watch.nextActionAt < earliest
            ? watch.nextActionAt
            : earliest,
        undefined,
      ),
    );
  }

  async deferProgressWatchNudge(
    conversationId: string,
    nudgeNumber: 1 | 2,
  ): Promise<boolean> {
    return this.mutate(async (state, now) => {
      const index = state.progressWatches.findIndex(
        (watch) => watch.conversationId === conversationId,
      );
      const watch = state.progressWatches[index];
      if (watch === undefined) return false;
      const due = this.inspectProgressWatchDue(state, watch, now);
      if (due.kind !== "nudge" || due.nudgeNumber !== nudgeNumber) {
        return false;
      }
      state.progressWatches[index] = deferProgressWatchNudge(
        watch,
        now.getTime(),
      );
      return true;
    });
  }

  async hasConsentEdge(input: GatewayConsentEdgeInput): Promise<boolean> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      try {
        const [left, right] = this.requireConsentEdgeRoutes(state, input, false);
        const endpoints = canonicalConsentEndpoints(left, right);
        return state.consentEdges.some((edge) => edge.endpoints.every(
          (endpoint, index) =>
            endpoint.alias === endpoints[index]!.alias &&
            endpoint.provider === endpoints[index]!.provider &&
            endpoint.ownerLease === endpoints[index]!.ownerLease,
        ));
      } catch (error) {
        if (error instanceof BridgeError) return false;
        throw error;
      }
    });
  }

  async inspectAffectedConsentEdgeInFlightMessages(
    input: GatewayConsentEdgeInput,
  ): Promise<AffectedInFlightMessageInspection[]> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const routes = this.requireConsentEdgeRoutes(state, input, false);
      const edge = this.requireExactConsentEdge(state, ...routes);
      return state.inFlight
        .filter((item) => consentEdgeMatchesMessage(edge, item))
        .map(({ messageId, deadlineAt }) => ({ messageId, deadlineAt }));
    });
  }

  /**
   * Remove exactly one consent edge and settle only work owned by that edge.
   * Adjacent edges, terminal token metadata, and unrelated messages survive.
   */
  async removeConsentEdge(
    input: RemoveConsentEdgeInput,
  ): Promise<RemoveConsentEdgeResult> {
    return this.mutate(async (state, now) => {
      const routes = this.requireConsentEdgeRoutes(state, input, false);
      const pair = this.requireExactConsentEdge(state, ...routes);
      const plan = this.validateAffectedConsentEdgeInFlightSettlements(
        state,
        pair,
        input.inFlightSettlements ?? [],
      );
      this.settleProgressWatchesForConsentEdge(state, pair, now);
      const settlements = this.terminateAffectedConsentEdgeMessages(
        state,
        pair,
        now,
        "PAIR_REMOVED",
        plan,
      );
      state.consentEdges = state.consentEdges.filter((candidate) => candidate !== pair);
      state.dedupe = state.dedupe.filter(
        (record) => !consentEdgeMatchesMessage(pair, record),
      );
      return {
        settlements,
        unreferencedAliases: pair.endpoints
          .filter(({ alias }) => !state.consentEdges.some((edge) =>
            edge.endpoints.some((endpoint) => endpoint.alias === alias),
          ))
          .map(({ alias }) => alias),
      };
    });
  }

  /**
   * Controller-internal inventory used to prepare an exact, evidence-aware
   * terminal plan before a route mutation. Message bodies and route handles
   * never cross this boundary. The route mutation validates the returned set
   * again so a stale or incomplete plan cannot partially settle the ledger.
   */
  async inspectAffectedInFlightMessages(
    aliases: readonly string[],
  ): Promise<AffectedInFlightMessageInspection[]> {
    if (
      aliases.length < 1 ||
      aliases.length > this.config.limits.maxRoutes ||
      aliases.some((alias) => !ALIAS_PATTERN.test(alias))
    ) {
      throw new BridgeError(
        "INVALID_ROUTE_TERMINATION_SCOPE",
        "Affected in-flight inspection requires a bounded list of valid route aliases.",
      );
    }
    const scope = new Set(aliases);
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      return state.inFlight
        .filter((item) => routeTerminationMatches(state, scope, item))
        .map(({ messageId, deadlineAt }) => ({ messageId, deadlineAt }));
    });
  }

  async enqueueMessage(
    input: EnqueueMessageInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate(async (state, now) => {
      const source = this.requireAvailableRoute(state, input.sourceAlias);
      const target = this.requireAvailableRoute(state, input.targetAlias);
      const sides: ResolvedEnqueueSides = {
        sourceAlias: source.alias,
        targetAlias: target.alias,
        direction: directionFor(source, target),
        sourceRoute: source,
        targetRoute: target,
      };
      try {
        this.requireExactConsentEdge(state, source, target);
        sides.pair = true;
      } catch (error) {
        if (error instanceof BridgeError && error.code === "SENDER_NOT_PAIRED") {
          this.recordRejection(
            state,
            sides,
            typeof input.body === "string"
              ? Math.max(1, Buffer.byteLength(input.body, "utf8"))
              : 1,
            now,
            "SENDER_NOT_PAIRED",
            input.steer,
            input.conversationIdSuffix,
          );
        }
        throw error;
      }
      return this.enqueueResolvedMessage(state, now, input, sides);
    });
  }

  /**
   * Accept one message from a caller-attested native Claude peer without
   * registering or persisting that peer as a route. The exact private binding
   * is used only to prove a live same-host connector generation for this call.
   */
  async enqueueNativeIngress(
    input: EnqueueNativeIngressInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate(async (state, now) => {
      const target = this.requireAvailableRoute(state, input.targetAlias);
      this.validateTransientNativeClaudePeer(state, input.source, target);
      const direction = directionId("claude", target.binding.provider);
      const selectedClaude = state.routes.find(
        (route) =>
          route.alias === input.source.alias &&
          route.binding.provider === "claude" &&
          route.registrationMode === "selected_live_peer" &&
          route.enabled &&
          ["idle", "busy", "awaiting_approval"].includes(route.state) &&
          sameBinding(route.binding, input.source.binding),
      );
      const pair =
        selectedClaude === undefined
          ? undefined
          : (() => {
              try {
                return this.requireExactConsentEdge(state, selectedClaude, target);
              } catch (error) {
                if (error instanceof BridgeError) return undefined;
                throw error;
              }
            })();
      if (
        input.authorizedPairTeardownReply === true &&
        selectedClaude === undefined
      ) {
        throw new BridgeError(
          "SENDER_NOT_PAIRED",
          "The retained reply no longer matches the exact selected Claude route.",
        );
      }
      if (
        this.config.inboundMode === "paired" &&
        pair === undefined &&
        input.authorizedPairTeardownReply !== true
      ) {
          const bytes =
            typeof input.body === "string"
              ? Math.max(1, Buffer.byteLength(input.body, "utf8"))
              : 1;
          this.recordRejection(
            state,
            {
              sourceAlias: input.source.alias,
              targetAlias: target.alias,
              direction,
              targetRoute: target,
            },
            bytes,
            now,
            "SENDER_NOT_PAIRED",
            input.steer,
            input.conversationIdSuffix,
          );
          throw new BridgeError(
            "SENDER_NOT_PAIRED",
            "The native Claude sender does not share exact consent with this route.",
          );
      }
      return this.enqueueResolvedMessage(state, now, input, {
        sourceAlias: input.source.alias,
        targetAlias: target.alias,
        direction,
        targetRoute: target,
        ...(pair === undefined ? {} : { pair: true as const }),
      });
    });
  }

  /**
   * Queue a correlated provider reply for a caller-attested transient Claude
   * peer. The service owns conversation correlation and the live dispatch
   * capability; the store retains only bounded public-alias metadata.
   */
  async enqueueNativeReply(
    input: EnqueueNativeReplyInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate(async (state, now) => {
      const source = this.requireAvailableRoute(state, input.sourceAlias);
      this.validateTransientNativeClaudePeer(state, input.target, source);
      const target = input.pair === true
        ? state.routes.find((route) =>
            route.alias === input.target.alias &&
            route.binding.provider === "claude" &&
            sameBinding(route.binding, input.target.binding))
        : undefined;
      if (input.pair === true) {
        if (target === undefined) {
          throw new BridgeError(
            "SENDER_NOT_PAIRED",
            "The correlated reply no longer has its exact paired Claude route.",
          );
        }
        this.requireExactConsentEdge(state, target, source);
      }
      return this.enqueueResolvedMessage(state, now, input, {
        sourceAlias: source.alias,
        targetAlias: input.target.alias,
        direction: directionId(source.binding.provider, "claude"),
        sourceRoute: source,
        ...(target !== undefined
          ? { pair: true as const, targetRoute: target }
          : { transientTarget: true as const }),
      });
    });
  }

  async dequeueMessage(
    targetAlias?: string,
    mode: "any" | "steer_only" = "any",
  ): Promise<
    (TransientQueuedMessage & { queuedAhead?: number }) | undefined
  > {
    return this.mutate(async (state, now) => {
      if (targetAlias !== undefined && !ALIAS_PATTERN.test(targetAlias)) {
        throw new BridgeError(
          "INVALID_GATEWAY_ALIAS",
          "The target alias does not use the required lowercase ASCII grammar.",
        );
      }
      if (mode !== "any" && mode !== "steer_only") {
        throw new BridgeError(
          "INVALID_GATEWAY_DISPATCH_MODE",
          "The gateway dispatch selector is not recognized.",
        );
      }
      const index = state.queue.findIndex(
        (item) =>
          (targetAlias === undefined || item.targetAlias === targetAlias) &&
          (mode === "any" || item.steer === true),
      );
      if (index < 0) return undefined;
      if (state.inFlight.length >= this.config.limits.maxInFlightMessages) {
        throw new BridgeError(
          "GATEWAY_IN_FLIGHT_FULL",
          "The bounded gateway dispatch set is at capacity.",
          true,
        );
      }
      const metadata = state.queue[index];
      if (!metadata) return undefined;
      const queuedAhead = state.queue
        .slice(0, index)
        .filter((candidate) => candidate.targetAlias === metadata.targetAlias)
        .length;
      state.queue.splice(index, 1);
      state.accounting.queuedBytes -= metadata.bytes;
      const target = state.routes.find(
        (route) => route.alias === metadata.targetAlias,
      );
      if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
      const body = this.transientBodies.get(metadata.messageId) ?? metadata.body;
      this.transientBodies.delete(metadata.messageId);
      if (body === undefined) {
        this.finishMetadata(state, metadata, "abandoned", now, "TRANSIENT_BODY_UNAVAILABLE");
        return undefined;
      }
      state.inFlight.push({ ...metadata, dispatchedAt: now.toISOString() });
      this.appendEvent(state, {
        timestamp: now.toISOString(),
        messageIdSuffix: metadata.messageIdSuffix,
        ...(metadata.conversationIdSuffix === undefined
          ? {}
          : { conversationIdSuffix: metadata.conversationIdSuffix }),
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: "dispatching",
        bytes: metadata.bytes,
        body,
        ...(metadata.steer === true ? { steer: true as const } : {}),
        latencyMs: Math.max(0, now.getTime() - Date.parse(metadata.enqueuedAt)),
      });
      return {
        ...metadata,
        body,
        ...(queuedAhead === 0 ? {} : { queuedAhead }),
      };
    });
  }

  /** Controller-private shutdown inventory; full IDs never cross control output. */
  async inspectQueuedMessageIds(): Promise<string[]> {
    return this.mutex.run("gateway", async () =>
      this.requireState().queue.map((item) => item.messageId),
    );
  }

  /**
   * Atomically terminalizes every message whose delivery deadline is due.
   * Returned settlements are emitted only by the mutation that removed the
   * message, so callers can release service-owned capabilities exactly once.
   *
   * @deprecated GatewayService must arbitrate deadlines through the delivery
   * reducer because only the service owns transport-write evidence. Retained
   * temporarily as a store-level recovery/test primitive; production service
   * code must not call it.
   */
  async expireDueMessages(now?: Date): Promise<TerminalMessageSettlement[]> {
    const requestedTime = now instanceof Date ? now.getTime() : undefined;
    if (
      now !== undefined &&
      (!(now instanceof Date) || !Number.isFinite(requestedTime))
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_TIMESTAMP",
        "The gateway expiry time must be a valid Date.",
      );
    }
    return this.mutate(async (state, mutationNow) => {
      const effectiveNow =
        requestedTime === undefined ? mutationNow : new Date(requestedTime);
      const settlements: TerminalMessageSettlement[] = [];
      const retainedQueue: QueuedMessageMetadata[] = [];
      for (const item of state.queue) {
        if (Date.parse(item.deadlineAt) > effectiveNow.getTime()) {
          retainedQueue.push(item);
          continue;
        }
        this.transientBodies.delete(item.messageId);
        state.accounting.queuedBytes -= item.bytes;
        const target = state.routes.find(
          (route) => route.alias === item.targetAlias,
        );
        if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
        settlements.push(
          this.finishMetadata(
            state,
            item,
            "expired",
            effectiveNow,
            "MESSAGE_EXPIRED",
          ),
        );
      }
      state.queue = retainedQueue;

      const retainedInFlight: InFlightMessageMetadata[] = [];
      for (const item of state.inFlight) {
        if (Date.parse(item.deadlineAt) > effectiveNow.getTime()) {
          retainedInFlight.push(item);
          continue;
        }
        settlements.push(
          this.finishMetadata(
            state,
            item,
            "ambiguous",
            effectiveNow,
            "DELIVERY_DEADLINE_EXPIRED",
          ),
        );
      }
      state.inFlight = retainedInFlight;
      return settlements;
    });
  }

  async settleMessage(input: SettleMessageInput): Promise<SettleMessageResult> {
    return this.mutate(async (state, now) => {
      if (!MESSAGE_ID_PATTERN.test(input.messageId)) {
        throw new BridgeError(
          "INVALID_GATEWAY_MESSAGE_ID",
          "The gateway message identifier is invalid.",
        );
      }
      if (
        input.safeErrorCode !== undefined &&
        !SAFE_CODE_PATTERN.test(input.safeErrorCode)
      ) {
        throw new BridgeError(
          "INVALID_SAFE_ERROR_CODE",
          "Delivery error codes must use the normalized safe-code grammar.",
        );
      }
      if (
        input.state !== "delivered" &&
        input.state !== "unconfirmed" &&
        input.state !== "failed" &&
        input.state !== "ambiguous" &&
        input.state !== "expired" &&
        input.state !== "cancelled"
      ) {
        throw new BridgeError(
          "INVALID_DELIVERY_SETTLEMENT",
          "Gateway delivery settlement must use a fixed terminal state.",
        );
      }
      const index = state.inFlight.findIndex(
        (item) => item.messageId === input.messageId,
      );
      const metadata = state.inFlight[index];
      if (!metadata || index < 0) {
        return { status: "not_in_flight" };
      }
      state.inFlight.splice(index, 1);
      return {
        status: "settled",
        settlement: this.finishMetadata(
          state,
          metadata,
          input.state,
          now,
          input.safeErrorCode,
        ),
      };
    });
  }

  async requeueInFlightMessage(
    messageId: string,
    body: string,
    safeErrorCode?: string,
  ): Promise<RequeueInFlightMessageResult> {
    return this.mutate(async (state, now) => {
      if (
        !MESSAGE_ID_PATTERN.test(messageId) ||
        typeof body !== "string" ||
        body.length === 0 ||
        body.includes("\u0000") ||
        (safeErrorCode !== undefined && !SAFE_CODE_PATTERN.test(safeErrorCode))
      ) {
        throw new BridgeError(
          "INVALID_GATEWAY_MESSAGE",
          "Only an exact in-flight message can be returned to the queue.",
        );
      }
      const index = state.inFlight.findIndex(
        (item) => item.messageId === messageId,
      );
      const metadata = state.inFlight[index];
      if (metadata === undefined || index < 0) {
        return { status: "not_in_flight" };
      }
      if (Buffer.byteLength(body, "utf8") !== metadata.bytes) {
        throw new BridgeError(
          "INVALID_GATEWAY_MESSAGE",
          "A requeued message body must exactly match its admitted byte count.",
        );
      }
      state.inFlight.splice(index, 1);
      if (Date.parse(metadata.deadlineAt) <= now.getTime()) {
        return {
          status: "settled",
          settlement: this.finishMetadata(
            state,
            metadata,
            "expired",
            now,
            "MESSAGE_EXPIRED",
          ),
        };
      }
      const { dispatchedAt: _dispatchedAt, ...queuedMetadata } = metadata;
      queuedMetadata.body = body;
      state.queue.unshift(queuedMetadata);
      this.transientBodies.set(messageId, body);
      state.accounting.queuedBytes += metadata.bytes;
      const target = state.routes.find(
        (route) => route.alias === metadata.targetAlias,
      );
      if (target !== undefined) target.queueDepth += 1;
      this.appendEvent(state, {
        timestamp: now.toISOString(),
        messageIdSuffix: metadata.messageIdSuffix,
        ...(metadata.conversationIdSuffix === undefined
          ? {}
          : { conversationIdSuffix: metadata.conversationIdSuffix }),
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: "held",
        bytes: metadata.bytes,
        body,
        ...(metadata.steer === true ? { steer: true as const } : {}),
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
        latencyMs: Math.max(
          0,
          now.getTime() - Date.parse(metadata.enqueuedAt),
        ),
      });
      return { status: "requeued" };
    });
  }

  async markMessageProgress(
    messageId: string,
    progress: InFlightMessageProgressState,
  ): Promise<void> {
    await this.mutate(async (state, now) => {
      if (!MESSAGE_ID_PATTERN.test(messageId)) {
        throw new BridgeError(
          "INVALID_GATEWAY_MESSAGE_ID",
          "The gateway message identifier is invalid.",
        );
      }
      if (progress !== "transport_written" && progress !== "held") {
        throw new BridgeError(
          "INVALID_DELIVERY_PROGRESS",
          "Gateway delivery progress must use a fixed nonterminal state.",
        );
      }
      const metadata = state.inFlight.find(
        (item) => item.messageId === messageId,
      );
      if (!metadata) {
        throw new BridgeError(
          "MESSAGE_NOT_IN_FLIGHT",
          "The gateway message is not owned by an active dispatch.",
        );
      }
      this.appendEvent(state, {
        timestamp: now.toISOString(),
        messageIdSuffix: metadata.messageIdSuffix,
        ...(metadata.conversationIdSuffix === undefined
          ? {}
          : { conversationIdSuffix: metadata.conversationIdSuffix }),
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: progress,
        bytes: metadata.bytes,
        ...(metadata.body === undefined ? {} : { body: metadata.body }),
        ...(metadata.steer === true ? { steer: true as const } : {}),
        latencyMs: Math.max(
          0,
          now.getTime() - Date.parse(metadata.enqueuedAt),
        ),
      });
    });
  }

  /**
   * Atomically terminalize one queued message and return the authoritative
   * settlement produced by the winning mutation. A later contender observes
   * `not_queued` and must not infer or publish another terminal outcome. At
   * or beyond the delivery deadline, expiry is authoritative regardless of
   * the caller's requested terminal state.
   */
  async settleQueuedMessage(
    input: SettleQueuedMessageInput,
  ): Promise<SettleQueuedMessageResult> {
    return this.mutate(async (state, now) => {
      if (!MESSAGE_ID_PATTERN.test(input.messageId)) {
        throw new BridgeError(
          "INVALID_GATEWAY_MESSAGE_ID",
          "The gateway message identifier is invalid.",
        );
      }
      if (
        input.safeErrorCode !== undefined &&
        !SAFE_CODE_PATTERN.test(input.safeErrorCode)
      ) {
        throw new BridgeError(
          "INVALID_SAFE_ERROR_CODE",
          "Delivery error codes must use the normalized safe-code grammar.",
        );
      }
      if (
        input.state !== "failed" &&
        input.state !== "expired" &&
        input.state !== "cancelled" &&
        input.state !== "abandoned"
      ) {
        throw new BridgeError(
          "INVALID_DELIVERY_SETTLEMENT",
          "Queued delivery settlement must use an applicable terminal state.",
        );
      }
      const index = state.queue.findIndex(
        (item) => item.messageId === input.messageId,
      );
      const metadata = state.queue[index];
      if (!metadata || index < 0) return { status: "not_queued" };
      state.queue.splice(index, 1);
      this.transientBodies.delete(input.messageId);
      state.accounting.queuedBytes -= metadata.bytes;
      const target = state.routes.find(
        (route) => route.alias === metadata.targetAlias,
      );
      if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
      const deadlineReached = Date.parse(metadata.deadlineAt) <= now.getTime();
      return {
        status: "settled",
        settlement: this.finishMetadata(
          state,
          metadata,
          deadlineReached ? "expired" : input.state,
          now,
          deadlineReached ? "MESSAGE_EXPIRED" : input.safeErrorCode,
        ),
      };
    });
  }

  /** @deprecated Prefer settleQueuedMessage so callers retain terminal proof. */
  async cancelQueuedMessage(messageId: string): Promise<boolean> {
    const result = await this.settleQueuedMessage({
      messageId,
      state: "cancelled",
      safeErrorCode: "MESSAGE_CANCELLED",
    });
    return result.status === "settled";
  }

  async publicSnapshot(): Promise<GatewayPublicSnapshot> {
    return this.mutate(async (state, now) => {
      const connectors: PublicConnectorSnapshot[] = state.connectors
        .map((connector) => {
          const observedAt = connector.lastSeenAt === undefined
            ? undefined
            : Date.parse(connector.lastSeenAt);
          const observationAgeMs = observedAt === undefined || !Number.isFinite(observedAt)
            ? undefined
            : Math.min(
                Number.MAX_SAFE_INTEGER,
                Math.max(0, now.getTime() - observedAt),
              );
          const health = connector.health === "healthy" &&
              (observationAgeMs === undefined ||
                observationAgeMs > CONNECTOR_OBSERVATION_STALE_AFTER_MS)
            ? "degraded"
            : connector.health;
          return {
            provider: connector.provider,
            host: connector.hostId,
            health,
            protocol: connector.protocol,
            protocolVersion: connector.protocolVersion,
            ...(connector.lastSeenAt ? { lastSeenAt: connector.lastSeenAt } : {}),
            ...(observationAgeMs === undefined ? {} : { observationAgeMs }),
            ...(connector.safeErrorCode
              ? { safeErrorCode: connector.safeErrorCode }
              : {}),
          };
        })
        .sort((left, right) =>
          `${left.provider}:${left.host}`.localeCompare(
            `${right.provider}:${right.host}`,
          ),
        );
      const oldestQueuedAtByTarget = new Map<string, string>();
      for (const item of state.queue) {
        const oldest = oldestQueuedAtByTarget.get(item.targetAlias);
        if (
          oldest === undefined ||
          Date.parse(item.enqueuedAt) < Date.parse(oldest)
        ) {
          oldestQueuedAtByTarget.set(item.targetAlias, item.enqueuedAt);
        }
      }
      const routes: PublicRouteSnapshot[] = state.routes
        .map((route) => {
          const oldestQueuedAt = oldestQueuedAtByTarget.get(route.alias);
          return {
            alias: route.alias,
            provider: route.binding.provider,
            host: route.binding.hostId,
            enabled: route.enabled,
            state: route.state,
            busyPolicy: route.busyPolicy,
            ...(route.lastSeenAt ? { lastSeenAt: route.lastSeenAt } : {}),
            queueDepth: route.queueDepth,
            ...(oldestQueuedAt === undefined ? {} : { oldestQueuedAt }),
            counters: { ...route.counters },
            ...(route.safeErrorCode
              ? { safeErrorCode: route.safeErrorCode }
              : {}),
          };
        })
        .sort((left, right) => left.alias.localeCompare(right.alias));
      const consentEdges: PublicConsentEdgeSnapshot[] = state.consentEdges
        .map((edge) => ({
          endpoints: edge.endpoints.map(({ alias, provider }) => ({ alias, provider })) as [
            { alias: string; provider: GatewayProvider },
            { alias: string; provider: GatewayProvider },
          ],
          host: edge.endpoints[0].alias.slice(edge.endpoints[0].alias.lastIndexOf("@") + 1),
          counters: { ...edge.counters },
        }))
        .sort((left, right) =>
          consentEdgeKey(left.endpoints).localeCompare(consentEdgeKey(right.endpoints)),
        );
      const progressWatches: PublicProgressWatchSnapshot[] =
        state.progressWatches
          .map((watch) => ({
            conversationIdSuffix: watch.conversationId.slice(-8),
            ownerAlias: watch.ownerAlias,
            workerAlias: watch.workerAlias,
            lastActivityAt: watch.lastActivityAt,
            nextActionAt: watch.nextActionAt,
            nudgeCount: watch.nudgeCount,
          }))
          .sort((left, right) =>
            `${left.nextActionAt}\0${left.ownerAlias}\0${left.workerAlias}`.localeCompare(
              `${right.nextActionAt}\0${right.ownerAlias}\0${right.workerAlias}`,
            ),
          );
      const progressWatchEvents: PublicProgressWatchEventSnapshot[] =
        state.progressWatchEvents.map((event) => ({
          sequence: event.sequence,
          timestamp: event.timestamp,
          conversationIdSuffix: event.conversationId.slice(-8),
          ownerAlias: event.ownerAlias,
          workerAlias: event.workerAlias,
          kind: event.kind,
          actor: event.actor,
          ...(event.kind === "settled" ? { reason: event.reason } : {}),
        }));
      const pressureBuckets: DeadlinePressureBucket[] = [
        { bucket: "under_1m", settled: 0, expired: 0 },
        { bucket: "1m_to_5m", settled: 0, expired: 0 },
        { bucket: "5m_to_15m", settled: 0, expired: 0 },
        { bucket: "15m_to_60m", settled: 0, expired: 0 },
        { bucket: "over_60m", settled: 0, expired: 0 },
      ];
      const terminalEvidence = state.events.filter(
        (event) =>
          event.latencyMs !== undefined &&
          (event.state === "delivered" ||
            event.state === "unconfirmed" ||
            event.state === "failed" ||
            event.state === "ambiguous" ||
            event.state === "expired" ||
            event.state === "cancelled" ||
            event.state === "abandoned"),
      );
      for (const event of terminalEvidence) {
        const latency = event.latencyMs ?? 0;
        const index =
          latency < 60_000
            ? 0
            : latency < 300_000
              ? 1
              : latency < 900_000
                ? 2
                : latency < 3_600_000
                  ? 3
                  : 4;
        const bucket = pressureBuckets[index];
        if (bucket === undefined) continue;
        bucket.settled += 1;
        if (event.state === "expired") bucket.expired += 1;
      }
      const health = this.aggregateHealth(connectors);
      const unsortedAlerts: SafeGatewayAlert[] = [
        ...connectors.flatMap((connector) =>
          connector.safeErrorCode
            ? [
                {
                  code: connector.safeErrorCode,
                  severity: connector.health === "offline" ? "error" : "warning",
                  timestamp: connector.lastSeenAt ?? now.toISOString(),
                  provider: connector.provider,
                  host: connector.host,
                } satisfies SafeGatewayAlert,
              ]
            : [],
        ),
        ...routes.flatMap((route) =>
          route.safeErrorCode
            ? [
                {
                  code: route.safeErrorCode,
                  severity: "warning",
                  timestamp: route.lastSeenAt ?? now.toISOString(),
                  provider: route.provider,
                  host: route.host,
                  alias: route.alias,
                } satisfies SafeGatewayAlert,
              ]
            : [],
        ),
      ];
      const alerts = unsortedAlerts
        .sort((left, right) => {
          const byTime = left.timestamp.localeCompare(right.timestamp);
          if (byTime !== 0) return byTime;
          return `${left.code}\0${left.provider ?? ""}\0${left.host ?? ""}\0${left.alias ?? ""}`.localeCompare(
            `${right.code}\0${right.provider ?? ""}\0${right.host ?? ""}\0${right.alias ?? ""}`,
          );
        });
      return projectGatewayPublicSnapshot({
        schemaVersion: 2,
        generatedAt: now.toISOString(),
        inboundMode: this.config.inboundMode,
        health,
        connectors,
        availablePeers: [],
        routes,
        consentEdges,
        progressWatches,
        progressWatchEvents,
        deadlinePressure: {
          configuredDeadlineMs: this.config.limits.messageDeadlineMs,
          ...(state.events[0]?.timestamp === undefined
            ? {}
            : { retainedSince: state.events[0].timestamp }),
          terminalEvents: terminalEvidence.length,
          expiredEvents: terminalEvidence.filter(
            (event) => event.state === "expired",
          ).length,
          buckets: pressureBuckets,
        },
        messages: state.events.map((event) => ({ ...event })),
        accounting: { ...state.accounting },
        alerts,
        truncation: {
          connectors: 0,
          availablePeers: 0,
          routes: 0,
          consentEdges: 0,
          progressWatches: 0,
          progressWatchEvents: 0,
          messages: 0,
          alerts: 0,
        },
      });
    });
  }

  private async mutate<T>(
    operation: (state: GatewayPersistedState, now: Date) => Promise<T> | T,
  ): Promise<T> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const stateBefore = structuredClone(state);
      const bodiesBefore = new Map(this.transientBodies);
      const now = this.now();
      this.prune(now);
      let outcome:
        | { ok: true; value: T }
        | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await operation(state, now) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      state.updatedAt = now.toISOString();
      try {
        await this.persist();
      } catch (persistError) {
        if (persistError instanceof PostRenamePersistenceError) {
          // Rename is the commit point. `persist` reloaded and verified the
          // installed state, so restoring `stateBefore` would create two
          // conflicting authorities inside one controller.
          throw persistError;
        }
        // A failed durable commit must not leave a newer in-memory authority.
        this.state = stateBefore;
        this.transientBodies.clear();
        for (const [messageId, body] of bodiesBefore) {
          this.transientBodies.set(messageId, body);
        }
        throw persistError;
      }
      // Rejection accounting/events deliberately survive operation errors that
      // occur after both selected routes have been safely resolved.
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  }

  private requireState(): GatewayPersistedState {
    if (!this.state || !this.lockHandle) {
      throw new BridgeError(
        "GATEWAY_NOT_INITIALIZED",
        "The gateway store must hold its controller lock before use.",
      );
    }
    return this.state;
  }

  private journal(state: GatewayPersistedState): CodexSuccessionJournal | null {
    if (state.codexSuccession === null) return null;
    if (!isCodexSuccessionJournal(state.codexSuccession)) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The in-memory Codex succession journal is invalid.",
      );
    }
    return state.codexSuccession;
  }

  private requireExactSuccession(
    state: GatewayPersistedState,
    input: ExactCodexSuccessionInput,
    allowedStages: readonly CodexSuccessionJournalStage[],
  ): CodexSuccessionJournal {
    if (
      !isObject(input) ||
      !hasOnlyKeys(input, ["oldGeneration", "newGeneration"]) ||
      !isCodexRegistrationGeneration(input.oldGeneration) ||
      !isCodexRegistrationGeneration(input.newGeneration)
    ) {
      throw new BridgeError(
        "INVALID_CODEX_SUCCESSION",
        "The exact Codex succession generations are malformed.",
      );
    }
    const journal = this.journal(state);
    if (journal === null) {
      throw new BridgeError(
        "CODEX_SUCCESSION_NOT_FOUND",
        "No durable Codex succession journal exists.",
      );
    }
    if (
      journal.old.generation !== input.oldGeneration ||
      journal.new.generation !== input.newGeneration ||
      !allowedStages.includes(journal.stage)
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_OWNER_MISMATCH",
        "The succession stage or exact generation ownership does not match.",
      );
    }
    return journal;
  }

  private assertSuccessionLedgerEmpty(
    state: GatewayPersistedState,
    alias: string,
  ): void {
    const queued = state.queue.filter(
      (item) => item.sourceAlias === alias || item.targetAlias === alias,
    );
    const inFlight = state.inFlight.filter(
      (item) => item.sourceAlias === alias || item.targetAlias === alias,
    );
    const ownedMessageIds = new Set([
      ...queued.map((item) => item.messageId),
      ...inFlight.map((item) => item.messageId),
    ]);
    if (
      queued.length !== 0 ||
      inFlight.length !== 0 ||
      [...this.transientBodies.keys()].some((messageId) =>
        ownedMessageIds.has(messageId),
      ) ||
      state.routes.some(
        (route) =>
          route.binding.provider === "codex" &&
          route.alias === alias &&
          route.queueDepth !== 0,
      )
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_LEDGER_NOT_EMPTY",
        "Codex succession requires the replaced route's queue and in-flight ledger to be drained.",
        true,
      );
    }
  }

  private requireCodexRouteForIdentity(
    state: GatewayPersistedState,
    identity: CodexSuccessionStoreIdentity,
  ): GatewayRouteRecord {
    const route = state.routes.find(
      (candidate) => routeMatchesSuccessionIdentity(candidate, identity),
    );
    if (route === undefined) {
      throw new BridgeError(
        "CODEX_SUCCESSION_OWNER_MISMATCH",
        "Codex succession requires the exact persisted Codex route.",
      );
    }
    return route;
  }

  private requireJournalRoute(
    state: GatewayPersistedState,
    journal: CodexSuccessionJournal,
    side: "old" | "new",
  ): GatewayRouteRecord {
    return this.requireCodexRouteForIdentity(state, journal[side]);
  }

  private requireAnyJournalRoute(
    state: GatewayPersistedState,
    journal: CodexSuccessionJournal,
  ): GatewayRouteRecord {
    const routes = state.routes.filter(
      (candidate) =>
        routeMatchesSuccessionIdentity(candidate, journal.old) ||
        routeMatchesSuccessionIdentity(candidate, journal.new),
    );
    if (routes.length !== 1 || routes[0] === undefined) {
      throw new BridgeError(
        "CODEX_SUCCESSION_OWNER_MISMATCH",
        "The succession journal must own exactly one persisted Codex route.",
      );
    }
    return routes[0];
  }

  private assertNewSuccessionIdentityAvailable(
    state: GatewayPersistedState,
    oldRoute: GatewayRouteRecord,
    identity: CodexSuccessionStoreIdentity,
  ): void {
    if (
      state.routes.some(
        (candidate) =>
          candidate !== oldRoute &&
          (candidate.alias === identity.alias ||
            sameRouteTarget(candidate.binding, identity.binding) ||
            candidate.binding.ownerLease === identity.binding.ownerLease),
      )
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_BINDING_COLLISION",
        "The new Codex identity collides with another persisted route.",
      );
    }
  }

  private replaceCodexRouteForSuccession(
    state: GatewayPersistedState,
    route: GatewayRouteRecord,
    identity: CodexSuccessionStoreIdentity,
    now: Date,
    routeState: "idle" | "busy" | "awaiting_approval" | "stale",
  ): void {
    const oldAlias = route.alias;
    const affectedAliases = new Set([oldAlias, identity.alias]);
    this.settleProgressWatchesForAliases(state, affectedAliases, now);
    route.alias = identity.alias;
    route.binding = { ...identity.binding };
    route.registrationMode = "explicit_opt_in";
    route.enabled = true;
    route.state = routeState;
    route.registeredAt = now.toISOString();
    route.updatedAt = now.toISOString();
    route.queueDepth = 0;
    route.counters = emptyCounters();
    if (routeState === "stale") {
      delete route.lastSeenAt;
      route.safeErrorCode = "REOBSERVATION_REQUIRED";
    } else {
      route.lastSeenAt = now.toISOString();
      delete route.safeErrorCode;
    }
    state.dedupe = state.dedupe.filter(
      (record) =>
        record.sourceAlias !== oldAlias &&
        record.targetAlias !== oldAlias &&
        record.sourceAlias !== identity.alias &&
        record.targetAlias !== identity.alias,
    );
    state.rateBuckets = state.rateBuckets.filter(
      (bucket) =>
        bucket.sourceAlias !== oldAlias &&
        bucket.sourceAlias !== identity.alias,
    );
    removeConsentEdgesForAliases(state, affectedAliases);
  }

  private assertAllowedIdentity(identity: PrivateEndpointIdentity): void {
    if (!isPrivateEndpointIdentity(identity)) {
      throw new BridgeError(
        "INVALID_PRIVATE_ROUTE_IDENTITY",
        "The private route identity is malformed or contains a path-like value.",
      );
    }
    if (!this.config.allowedHosts.includes(identity.hostId)) {
      throw new BridgeError(
        "GATEWAY_HOST_NOT_ALLOWED",
        "The route host is not in the fixed gateway allowlist.",
      );
    }
  }

  private requireObservedEndpoint(
    state: GatewayPersistedState,
    binding: PrivateRouteBinding,
  ): void {
    const connector = state.connectors.find((candidate) =>
      sameEndpoint(candidate, binding),
    );
    if (
      !connector ||
      !["healthy", "degraded"].includes(connector.health)
    ) {
      throw new BridgeError(
        "ROUTE_ENDPOINT_NOT_OBSERVED",
        "The exact live endpoint generation must be observed before Codex succession can publish or activate it.",
      );
    }
  }

  private validateRouteInput(input: RegisterRouteInput): void {
    if (!ALIAS_PATTERN.test(input.alias)) {
      throw new BridgeError(
        "INVALID_GATEWAY_ALIAS",
        "Gateway aliases must use lowercase ASCII name@host syntax.",
      );
    }
    if (!isPrivateRouteBinding(input.binding)) {
      throw new BridgeError(
        "INVALID_PRIVATE_ROUTE_IDENTITY",
        "The private route binding is malformed or contains a path-like value.",
      );
    }
    const aliasHost = input.alias.slice(input.alias.lastIndexOf("@") + 1);
    if (aliasHost !== input.binding.hostId) {
      throw new BridgeError(
        "ROUTE_HOST_MISMATCH",
        "The public alias host must match the allowlisted private route host.",
      );
    }
    const requiredPrefix =
      gatewayRegistrationIngressPrefixes[input.binding.provider];
    if (requiredPrefix !== undefined && !input.alias.startsWith(requiredPrefix)) {
      throw new BridgeError(
        "INVALID_GATEWAY_ALIAS",
        `The ${input.binding.provider} registration alias must use its required ingress prefix.`,
      );
    }
    if (
      (input.binding.provider === "claude" &&
        input.registrationMode !== "selected_live_peer") ||
      (input.binding.provider !== "claude" &&
        input.registrationMode !== "explicit_opt_in")
    ) {
      throw new BridgeError(
        "ROUTE_OPT_IN_REQUIRED",
        "Non-Claude routes require explicit opt-in and Claude routes require a selected live peer.",
      );
    }
  }

  private requireOwnedRoute(
    state: GatewayPersistedState,
    alias: string,
    ownerLease: string,
  ): GatewayRouteRecord {
    const route = state.routes.find((candidate) => candidate.alias === alias);
    if (!route || route.binding.ownerLease !== ownerLease) {
      throw new BridgeError(
        "ROUTE_OWNERSHIP_MISMATCH",
        "The route does not exist or the private ownership lease does not match.",
      );
    }
    return route;
  }

  private requireStaleCodexOrphan(
    state: GatewayPersistedState,
    alias: string,
  ): GatewayRouteRecord {
    if (
      typeof alias !== "string" ||
      !ALIAS_PATTERN.test(alias) ||
      !alias.startsWith("codex-")
    ) {
      throw new BridgeError(
        "INVALID_CODEX_ORPHAN_RECOVERY",
        "Codex orphan recovery requires one exact Codex alias.",
      );
    }
    const route = state.routes.find((candidate) => candidate.alias === alias);
    if (route === undefined) {
      throw new BridgeError(
        "CODEX_ORPHAN_NOT_FOUND",
        "No Codex registration matches the requested alias.",
      );
    }
    if (
      route.binding.provider !== "codex" ||
      route.registrationMode !== "explicit_opt_in" ||
      !route.enabled ||
      route.state !== "stale" ||
      route.queueDepth !== 0 ||
      state.queue.some(
        (item) =>
          item.sourceAlias === route.alias || item.targetAlias === route.alias,
      ) ||
      state.inFlight.some(
        (item) =>
          item.sourceAlias === route.alias || item.targetAlias === route.alias,
      )
    ) {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_NOT_SAFE",
        "Only an enabled, expired, empty stale Codex registration can be removed as an orphan.",
      );
    }
    const connector = state.connectors.find(
      (candidate) =>
        candidate.provider === "codex" &&
        candidate.hostId === route.binding.hostId,
    );
    const generationProvedDead =
      connector !== undefined &&
      (connector.endpointGeneration !== route.binding.endpointGeneration ||
        connector.health === "offline");
    if (!generationProvedDead) {
      throw new BridgeError(
        "CODEX_ORPHAN_GENERATION_LIVE",
        "The Codex registration cannot be removed while its endpoint generation may still be live.",
      );
    }
    const succession = this.journal(state);
    if (
      succession !== null &&
      (routeMatchesSuccessionIdentity(route, succession.old) ||
        routeMatchesSuccessionIdentity(route, succession.new))
    ) {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_BLOCKED",
        "A Codex registration owned by an active succession cannot be removed as an orphan.",
      );
    }
    return route;
  }

  private requireAvailableRoute(
    state: GatewayPersistedState,
    alias: string,
  ): GatewayRouteRecord {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new BridgeError(
        "INVALID_GATEWAY_ALIAS",
        "The selected alias does not use the required lowercase ASCII grammar.",
      );
    }
    const route = state.routes.find((candidate) => candidate.alias === alias);
    if (
      !route ||
      !route.enabled ||
      !["idle", "busy", "awaiting_approval"].includes(route.state)
    ) {
      throw new BridgeError(
        "ROUTE_UNAVAILABLE",
        "The selected route is not currently enabled and positively observed.",
        true,
      );
    }
    return route;
  }

  private requireConsentEdgeRoutes(
    state: GatewayPersistedState,
    input: GatewayConsentEdgeInput,
    requireAvailable = true,
  ): readonly [GatewayRouteRecord, GatewayRouteRecord] {
    if (
      !isObject(input) ||
      !Array.isArray(input.aliases) ||
      input.aliases.length !== 2 ||
      input.aliases.some((alias) => typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) ||
      input.aliases[0] === input.aliases[1]
    ) {
      throw new BridgeError(
        "INVALID_CONSENT_EDGE",
        "A consent edge requires two distinct normalized aliases.",
      );
    }
    const resolve = (alias: string): GatewayRouteRecord => {
      if (requireAvailable) return this.requireAvailableRoute(state, alias);
      const route = state.routes.find((candidate) => candidate.alias === alias);
      if (route === undefined) {
        throw new BridgeError(
          "CONSENT_EDGE_ROUTE_NOT_FOUND",
          "The consent edge references a route that is not registered.",
        );
      }
      return route;
    };
    const left = resolve(input.aliases[0]);
    const right = resolve(input.aliases[1]);
    if (
      left.binding.provider === right.binding.provider ||
      left.binding.hostId !== right.binding.hostId
    ) {
      throw new BridgeError(
        "INVALID_CONSENT_EDGE",
        "A consent edge must connect distinct providers on the same host.",
      );
    }
    return [left, right];
  }

  private requireExactConsentEdge(
    state: GatewayPersistedState,
    left: GatewayRouteRecord,
    right: GatewayRouteRecord,
  ): GatewayConsentEdgeRecord {
    const endpoints = canonicalConsentEndpoints(left, right);
    const pair = state.consentEdges.find(
      (candidate) => consentEdgeKey(candidate.endpoints) === consentEdgeKey(endpoints),
    );
    if (
      pair === undefined ||
      pair.endpoints.some((endpoint, index) =>
        endpoint.ownerLease !== endpoints[index]!.ownerLease)
    ) {
      throw new BridgeError(
        "SENDER_NOT_PAIRED",
        "The two exact route authorities do not share a consent edge.",
      );
    }
    return pair;
  }

  private validateTransientNativeClaudePeer(
    state: GatewayPersistedState,
    peer: TransientNativeClaudePeer,
    route: GatewayRouteRecord,
  ): void {
    if (
      !isObject(peer) ||
      !hasOnlyKeys(peer, ["alias", "binding"]) ||
      typeof peer.alias !== "string" ||
      !ALIAS_PATTERN.test(peer.alias) ||
      !isPrivateRouteBinding(peer.binding) ||
      peer.binding.provider !== "claude"
    ) {
      throw new BridgeError(
        "INVALID_NATIVE_CLAUDE_PEER",
        "Native ingress requires a normalized alias and a private Claude binding.",
      );
    }
    this.assertAllowedIdentity(endpointOf(peer.binding));
    const aliasHost = peer.alias.slice(peer.alias.lastIndexOf("@") + 1);
    if (
      route.binding.provider === "claude" ||
      aliasHost !== peer.binding.hostId ||
      peer.binding.hostId !== route.binding.hostId ||
      peer.alias === route.alias
    ) {
      throw new BridgeError(
        "NATIVE_PEER_SCOPE_MISMATCH",
        "The transient Claude peer and registered route must be distinct providers on the same allowlisted host.",
      );
    }
    const connector = state.connectors.find((candidate) =>
      sameEndpoint(candidate, peer.binding),
    );
    if (
      !connector ||
      !["healthy", "degraded"].includes(connector.health)
    ) {
      throw new BridgeError(
        "NATIVE_PEER_ENDPOINT_NOT_OBSERVED",
        "The transient Claude peer's exact connector generation is not live.",
        true,
      );
    }
  }

  private enqueueResolvedMessage(
    state: GatewayPersistedState,
    now: Date,
    input: Pick<
      EnqueueMessageInput,
      | "body"
      | "dedupeKey"
      | "conversationIdSuffix"
      | "deadlineAt"
      | "steer"
      | "progressWatch"
      | "progressWatchNudge"
    >,
    sides: ResolvedEnqueueSides,
  ): EnqueueMessageResult {
    if (
      input.conversationIdSuffix !== undefined &&
      !CONVERSATION_SUFFIX_PATTERN.test(input.conversationIdSuffix)
    ) {
      throw new BridgeError(
        "INVALID_CONVERSATION_SUFFIX",
        "Conversation correlation requires an eight-character opaque suffix.",
      );
    }
    if (
      typeof input.body !== "string" ||
      input.body.length === 0 ||
      input.body.includes("\u0000")
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_MESSAGE",
        "Gateway messages must contain a non-empty text body without NUL bytes.",
      );
    }
    const bytes = Buffer.byteLength(input.body, "utf8");
    if (bytes > this.config.limits.maxMessageBytes) {
      this.recordRejection(
        state,
        sides,
        bytes,
        now,
        "MESSAGE_TOO_LARGE",
        input.steer,
        input.conversationIdSuffix,
      );
      throw new BridgeError(
        "MESSAGE_TOO_LARGE",
        "The transient message exceeds the configured byte limit.",
      );
    }
    if (
      typeof input.dedupeKey !== "string" ||
      input.dedupeKey.length === 0 ||
      Buffer.byteLength(input.dedupeKey) > 512
    ) {
      throw new BridgeError(
        "INVALID_DEDUPE_KEY",
        "A bounded, non-empty deduplication key is required.",
      );
    }
    const fingerprint = createHash("sha256")
      .update(sides.sourceAlias)
      .update("\0")
      .update(sides.targetAlias)
      .update("\0")
      .update(input.dedupeKey)
      .digest("base64url");
    const duplicate = state.dedupe.find(
      (record) =>
        record.fingerprint === fingerprint &&
        Date.parse(record.expiresAt) > now.getTime(),
    );
    if (duplicate) {
      state.accounting.duplicates += 1;
      this.appendEvent(state, {
        timestamp: now.toISOString(),
        messageIdSuffix: duplicate.messageIdSuffix,
        direction: sides.direction,
        sourceAlias: sides.sourceAlias,
        targetAlias: sides.targetAlias,
        state: "duplicate",
        ...(duplicate.conversationIdSuffix === undefined
          ? {}
          : { conversationIdSuffix: duplicate.conversationIdSuffix }),
        bytes,
        ...(input.steer === true ? { steer: true as const } : {}),
      });
      return {
        accepted: false,
        duplicate: true,
        messageIdSuffix: duplicate.messageIdSuffix,
      };
    }
    this.consumeRateLimit(state, sides.sourceAlias, now);
    const deadline = input.deadlineAt
      ? new Date(input.deadlineAt)
      : new Date(now.getTime() + this.config.limits.messageDeadlineMs);
    if (
      !Number.isFinite(deadline.getTime()) ||
      deadline.getTime() <= now.getTime() ||
      deadline.getTime() > now.getTime() + this.config.limits.messageDeadlineMs
    ) {
      this.recordRejection(
        state,
        sides,
        bytes,
        now,
        "INVALID_DEADLINE",
        input.steer,
        input.conversationIdSuffix,
      );
      throw new BridgeError(
        "INVALID_DEADLINE",
        "The message deadline must be in the future and within the configured maximum.",
      );
    }
    let oldestSteerIndex = -1;
    if (input.steer === true) {
      let oldestSteerAt = Number.POSITIVE_INFINITY;
      for (const [index, item] of state.queue.entries()) {
        if (
          item.sourceAlias !== sides.sourceAlias ||
          item.targetAlias !== sides.targetAlias ||
          item.steer !== true
        ) {
          continue;
        }
        const enqueuedAt = Date.parse(item.enqueuedAt);
        if (enqueuedAt < oldestSteerAt) {
          oldestSteerAt = enqueuedAt;
          oldestSteerIndex = index;
        }
      }
      const steerDepth = state.queue.filter(
        (item) =>
          item.sourceAlias === sides.sourceAlias &&
          item.targetAlias === sides.targetAlias &&
          item.steer === true,
      ).length;
      if (steerDepth < 3) oldestSteerIndex = -1;
    }
    const superseded =
      oldestSteerIndex < 0 ? undefined : state.queue[oldestSteerIndex];
    const targetDepthBefore = state.queue.filter(
      (item) => item.targetAlias === sides.targetAlias,
    ).length;
    const queueLengthAfterSupersession =
      state.queue.length - (superseded === undefined ? 0 : 1);
    const targetDepthAfterSupersession =
      targetDepthBefore - (superseded === undefined ? 0 : 1);
    const queuedBytesAfterSupersession =
      state.accounting.queuedBytes - (superseded?.bytes ?? 0);
    if (
      queueLengthAfterSupersession + state.inFlight.length >=
        this.config.limits.maxQueueMessages ||
      targetDepthAfterSupersession >=
        this.config.limits.maxQueueMessagesPerRoute ||
      queuedBytesAfterSupersession + bytes >
        this.config.limits.maxQueueBytes
    ) {
      this.recordRejection(
        state,
        sides,
        bytes,
        now,
        "QUEUE_FULL",
        input.steer,
        input.conversationIdSuffix,
      );
      throw new BridgeError(
        "GATEWAY_QUEUE_FULL",
        "The bounded gateway queue cannot accept another message.",
        true,
      );
    }
    if (
      input.progressWatch !== undefined &&
      input.progressWatchNudge !== undefined
    ) {
      throw new BridgeError(
        "INVALID_PROGRESS_WATCH",
        "A queued message cannot be both endpoint activity and a controller nudge.",
      );
    }
    const opaque = this.randomId();
    const messageId = `msg_${opaque}`;
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BridgeError(
        "INVALID_RANDOM_ID_SOURCE",
        "The gateway random identifier source did not return a UUID.",
      );
    }
    const messageIdSuffix = opaque.replaceAll("-", "").slice(-8).toLowerCase();
    const metadata: QueuedMessageMetadata = {
      messageId,
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      enqueuedAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
      bytes,
      body: input.body,
      ...(sides.pair === true ? { pair: true as const } : {}),
      ...(sides.transientTarget === true
        ? { transientTarget: true as const }
        : {}),
      ...(input.steer === true ? { steer: true as const } : {}),
    };
    this.applyProgressWatchMessageActivity(
      state,
      now,
      input.progressWatch,
      sides,
    );
    this.commitProgressWatchNudge(
      state,
      now,
      input.progressWatchNudge,
      sides,
    );
    let supersededSettlement: TerminalMessageSettlement | undefined;
    if (superseded !== undefined) {
      state.queue.splice(oldestSteerIndex, 1);
      this.transientBodies.delete(superseded.messageId);
      state.accounting.queuedBytes -= superseded.bytes;
      const oldestTarget = state.routes.find(
        (route) => route.alias === superseded.targetAlias,
      );
      if (oldestTarget) {
        oldestTarget.queueDepth = Math.max(0, oldestTarget.queueDepth - 1);
      }
      supersededSettlement = this.finishMetadata(
        state,
        superseded,
        "cancelled",
        now,
        "STEER_QUEUE_SUPERSEDED",
      );
    }
    state.queue.push(metadata);
    this.transientBodies.set(messageId, input.body);
    state.accounting.accepted += 1;
    state.accounting.bytesAccepted += bytes;
    const pair = findConsentEdgeForMessage(state, metadata);
    if (pair !== undefined) {
      pair.counters.accepted += 1;
      pair.counters.bytesAccepted += bytes;
      pair.updatedAt = now.toISOString();
    }
    state.accounting.queuedBytes += bytes;
    if (sides.sourceRoute) {
      sides.sourceRoute.counters.accepted += 1;
      sides.sourceRoute.counters.bytesAccepted += bytes;
    }
    if (sides.targetRoute) sides.targetRoute.queueDepth += 1;
    state.dedupe.push({
      fingerprint,
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      direction: sides.direction,
      ...(sides.pair === true ? { pair: true as const } : {}),
      firstSeenAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.limits.dedupeTtlMs,
      ).toISOString(),
    });
    while (state.dedupe.length > this.config.limits.dedupeCapacity) {
      state.dedupe.shift();
    }
    this.appendEvent(state, {
      timestamp: now.toISOString(),
      messageIdSuffix,
      ...(input.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: input.conversationIdSuffix }),
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      state: "queued",
      bytes,
      body: input.body,
      ...(input.steer === true ? { steer: true as const } : {}),
    });
    return {
      accepted: true,
      duplicate: false,
      messageId,
      messageIdSuffix,
      ...(sides.pair === true ? { pair: true as const } : {}),
      ...(supersededSettlement === undefined
        ? {}
        : { supersededSettlement }),
    };
  }

  private consumeRateLimit(
    state: GatewayPersistedState,
    sourceAlias: string,
    now: Date,
  ): void {
    let bucket = state.rateBuckets.find(
      (candidate) => candidate.sourceAlias === sourceAlias,
    );
    if (
      !bucket ||
      now.getTime() - Date.parse(bucket.windowStartedAt) >=
        this.config.limits.rateWindowMs
    ) {
      state.rateBuckets = state.rateBuckets.filter(
        (candidate) => candidate.sourceAlias !== sourceAlias,
      );
      if (state.rateBuckets.length >= this.config.limits.maxRoutes) {
        state.accounting.rejected += 1;
        const route = state.routes.find(
          (candidate) => candidate.alias === sourceAlias,
        );
        if (route) route.counters.rejected += 1;
        throw new BridgeError(
          "GATEWAY_RATE_LIMITED",
          "The bounded gateway rate window cannot admit another source.",
          true,
        );
      }
      bucket = {
        sourceAlias,
        windowStartedAt: now.toISOString(),
        count: 0,
      };
      state.rateBuckets.push(bucket);
    }
    if (bucket.count >= this.config.limits.rateLimitPerRoute) {
      state.accounting.rejected += 1;
      const route = state.routes.find((candidate) => candidate.alias === sourceAlias);
      if (route) route.counters.rejected += 1;
      throw new BridgeError(
        "GATEWAY_RATE_LIMITED",
        "The source route exceeded its bounded gateway rate window.",
        true,
      );
    }
    bucket.count += 1;
  }

  private recordRejection(
    state: GatewayPersistedState,
    sides: ResolvedEnqueueSides,
    bytes: number,
    now: Date,
    safeErrorCode: string,
    steer?: true,
    conversationIdSuffix?: string,
  ): void {
    const suffix = this.randomId().replaceAll("-", "").slice(-8).toLowerCase();
    if (!MESSAGE_SUFFIX_PATTERN.test(suffix)) return;
    state.accounting.rejected += 1;
    if (sides.sourceRoute) sides.sourceRoute.counters.rejected += 1;
    const pair = findConsentEdgeForMessage(state, sides);
    if (pair !== undefined) {
      pair.counters.rejected += 1;
      pair.updatedAt = now.toISOString();
    }
    this.appendEvent(state, {
      timestamp: now.toISOString(),
      messageIdSuffix: suffix,
      ...(conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix }),
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      state: "rejected",
      bytes: Math.max(1, bytes),
      safeErrorCode,
      ...(steer === true ? { steer: true as const } : {}),
    });
  }

  private appendEvent(
    state: GatewayPersistedState,
    event: Omit<NormalizedMessageEvent, "sequence">,
  ): void {
    if (event.body !== undefined) {
      for (const retained of state.events) {
        if (
          retained.body !== undefined &&
          retained.messageIdSuffix === event.messageIdSuffix &&
          retained.direction === event.direction &&
          retained.sourceAlias === event.sourceAlias &&
          retained.targetAlias === event.targetAlias &&
          retained.conversationIdSuffix === event.conversationIdSuffix
        ) {
          delete retained.body;
        }
      }
    }
    state.eventSequence += 1;
    state.events.push({ sequence: state.eventSequence, ...event });
    while (state.events.length > this.config.limits.eventCapacity) {
      state.events.shift();
    }
    this.pruneRetainedEventBodies(state);
  }

  private pruneRetainedEventBodies(state: GatewayPersistedState): void {
    const configured =
      this.config.limits.maxRetainedBodyBytes ??
      DEFAULT_RETAINED_BODY_BYTES;
    if (
      !Number.isSafeInteger(configured) ||
      configured < 1 ||
      configured > GATEWAY_MAX_STATE_FILE_BYTES
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_CONFIGURATION",
        "The retained message-body byte limit is invalid.",
      );
    }
    let retainedBytes = state.events.reduce(
      (total, event) =>
        total +
        (event.body === undefined
          ? 0
          : Buffer.byteLength(event.body, "utf8")),
      0,
    );
    for (const event of state.events) {
      if (retainedBytes <= configured) break;
      if (event.body === undefined) continue;
      retainedBytes -= Buffer.byteLength(event.body, "utf8");
      delete event.body;
    }
  }

  private appendCodexEndpointRefreshEvent(
    state: GatewayPersistedState,
    event: Omit<CodexEndpointRefreshJournalEvent, "sequence">,
  ): void {
    if (state.codexEndpointRefreshSequence >= Number.MAX_SAFE_INTEGER) {
      throw new BridgeError(
        "CODEX_ENDPOINT_REFRESH_SEQUENCE_EXHAUSTED",
        "The bounded Codex endpoint-refresh sequence is exhausted.",
      );
    }
    state.codexEndpointRefreshSequence += 1;
    state.codexEndpointRefreshEvents.push({
      sequence: state.codexEndpointRefreshSequence,
      ...event,
    });
    while (
      state.codexEndpointRefreshEvents.length >
      CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY
    ) {
      state.codexEndpointRefreshEvents.shift();
    }
  }

  private appendCodexOrphanRemovalEvent(
    state: GatewayPersistedState,
    event: Omit<CodexOrphanRemovalJournalEvent, "sequence">,
  ): void {
    if (state.codexOrphanRemovalSequence >= Number.MAX_SAFE_INTEGER) {
      throw new BridgeError(
        "CODEX_ORPHAN_REMOVAL_SEQUENCE_EXHAUSTED",
        "The bounded Codex orphan-removal sequence is exhausted.",
      );
    }
    state.codexOrphanRemovalSequence += 1;
    state.codexOrphanRemovalEvents.push({
      sequence: state.codexOrphanRemovalSequence,
      ...event,
    });
    while (
      state.codexOrphanRemovalEvents.length >
      CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY
    ) {
      state.codexOrphanRemovalEvents.shift();
    }
  }

  /** Commit watch activity only after every message-admission check succeeds. */
  private applyProgressWatchMessageActivity(
    state: GatewayPersistedState,
    now: Date,
    activity: EnqueueMessageInput["progressWatch"],
    sides: ResolvedEnqueueSides,
  ): void {
    if (activity === undefined) return;
    if (
      !CONVERSATION_ID_PATTERN.test(activity.conversationId) ||
      activity.actorAlias !== sides.sourceAlias ||
      (activity.openIdleMs !== undefined &&
        (!Number.isSafeInteger(activity.openIdleMs) ||
          activity.openIdleMs < PROGRESS_WATCH_MIN_IDLE_MS ||
          activity.openIdleMs > PROGRESS_WATCH_MAX_IDLE_MS)) ||
      (activity.completionSignal === true &&
        activity.openIdleMs !== undefined)
    ) {
      throw new BridgeError(
        "INVALID_PROGRESS_WATCH",
        "The message watch activity is malformed or contradictory.",
      );
    }

    const pair =
      sides.pair === true
        ? state.consentEdges.find((candidate) => consentEdgeMatchesMessage(candidate, sides))
        : undefined;
    const index = state.progressWatches.findIndex(
      (watch) => watch.conversationId === activity.conversationId,
    );
    const existing = state.progressWatches[index];
    if (existing !== undefined) {
      if (
        pair === undefined ||
        !progressWatchMatchesConsentEdge(existing, pair) ||
        !(
          (sides.sourceAlias === existing.ownerAlias &&
            sides.targetAlias === existing.workerAlias) ||
          (sides.sourceAlias === existing.workerAlias &&
            sides.targetAlias === existing.ownerAlias)
        )
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_OWNERSHIP_MISMATCH",
          "The watched conversation belongs to different exact endpoints.",
        );
      }
      if (
        activity.openIdleMs !== undefined &&
        activity.actorAlias !== existing.ownerAlias
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_OWNER_REQUIRED",
          "Tracking options persist from the original TRACK; a repeated TRACK from the exact owner refreshes activity without changing them.",
        );
      }
      if (activity.completionSignal === true) {
        this.appendProgressWatchEvents(state, [
          progressWatchJournalEvent(existing, now.toISOString(), {
            kind: "settled",
            actor:
              activity.actorAlias === existing.ownerAlias
                ? "owner"
                : "worker",
            reason: "done",
          }),
        ]);
        state.progressWatches.splice(index, 1);
        return;
      }
      state.progressWatches[index] = recordProgressWatchActivity(
        existing,
        now.getTime(),
      );
      return;
    }

    if (activity.openIdleMs === undefined) return;
    if (this.config.trackingEnabled === false) {
      throw new BridgeError(
        "PROGRESS_TRACKING_DISABLED",
        "Progress tracking is disabled by the controller configuration.",
      );
    }
    if (pair === undefined) {
      throw new BridgeError(
        "PROGRESS_WATCH_EDGE_REQUIRED",
        "Progress tracking requires one exact paired consent edge.",
      );
    }
    const watch = createProgressWatch({
      conversationId: activity.conversationId,
      ownerAlias: sides.sourceAlias,
      workerAlias: sides.targetAlias,
      ownerLease: pair.endpoints.find(
        ({ alias }) => alias === sides.sourceAlias,
      )!.ownerLease,
      workerLease: pair.endpoints.find(
        ({ alias }) => alias === sides.targetAlias,
      )!.ownerLease,
      idleMs: activity.openIdleMs,
      at: now.getTime(),
    });
    this.installProgressWatch(state, watch, pair, now);
  }

  private inspectProgressWatchDue(
    state: GatewayPersistedState,
    watch: ProgressWatch,
    now: Date,
  ): ReturnType<typeof inspectProgressWatchDue> {
    const owner = state.routes.find(
      (route) =>
        route.alias === watch.ownerAlias &&
        route.binding.ownerLease === watch.ownerLease,
    );
    const worker = state.routes.find(
      (route) =>
        route.alias === watch.workerAlias &&
        route.binding.ownerLease === watch.workerLease,
    );
    return inspectProgressWatchDue(watch, {
      at: now.getTime(),
      bothIdle: owner?.state === "idle" && worker?.state === "idle",
    });
  }

  private commitProgressWatchNudge(
    state: GatewayPersistedState,
    now: Date,
    nudge: EnqueueMessageInput["progressWatchNudge"],
    sides: ResolvedEnqueueSides,
  ): void {
    if (nudge === undefined) return;
    const index = state.progressWatches.findIndex(
      (watch) => watch.conversationId === nudge.conversationId,
    );
    const watch = state.progressWatches[index];
    if (
      watch === undefined ||
      sides.sourceAlias !== watch.ownerAlias ||
      sides.targetAlias !== watch.workerAlias
    ) {
      throw new BridgeError(
        "PROGRESS_WATCH_OWNERSHIP_MISMATCH",
        "The controller nudge no longer matches its exact watch edge.",
      );
    }
    const due = this.inspectProgressWatchDue(state, watch, now);
    if (due.kind !== "nudge" || due.nudgeNumber !== nudge.nudgeNumber) {
      throw new BridgeError(
        "PROGRESS_WATCH_NUDGE_NOT_DUE",
        "The requested progress-watch nudge is not currently due.",
        true,
      );
    }
    state.progressWatches[index] = commitProgressWatchNudge(watch, {
      at: now.getTime(),
      nudgeNumber: nudge.nudgeNumber,
    });
  }

  private installProgressWatch(
    state: GatewayPersistedState,
    watch: ProgressWatch,
    pair: GatewayConsentEdgeRecord,
    now: Date,
  ): void {
    const replacedIndex = state.progressWatches.findIndex((candidate) =>
      progressWatchMatchesConsentEdge(candidate, pair),
    );
    if (
      replacedIndex < 0 &&
      state.progressWatches.length >=
        (this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY)
    ) {
      throw new BridgeError(
        "PROGRESS_WATCH_CAPACITY_REACHED",
        "The bounded progress-watch inventory is full.",
        true,
      );
    }
    if (
      replacedIndex >= 0 &&
      state.progressWatches[replacedIndex]!.ownerAlias !== watch.ownerAlias
    ) {
      throw new BridgeError(
        "PROGRESS_WATCH_REPLACEMENT_OWNER_REQUIRED",
        "Only the incumbent watch owner may replace this pair watch; ask that owner to untrack it first.",
      );
    }
    if (replacedIndex >= 0) {
      const replaced = state.progressWatches[replacedIndex]!;
      this.appendProgressWatchEvents(state, [
        progressWatchJournalEvent(replaced, now.toISOString(), {
          kind: "replaced",
          actor: "owner",
        }),
      ]);
      state.progressWatches[replacedIndex] = watch;
      return;
    }
    this.appendProgressWatchEvents(state, [
      progressWatchJournalEvent(watch, now.toISOString(), {
        kind: "opened",
        actor: "owner",
      }),
    ]);
    state.progressWatches.push(watch);
  }

  private appendProgressWatchEvents(
    state: GatewayPersistedState,
    events: readonly PendingProgressWatchJournalEvent[],
  ): void {
    if (
      state.watchSequence > Number.MAX_SAFE_INTEGER - events.length
    ) {
      throw new BridgeError(
        "PROGRESS_WATCH_SEQUENCE_EXHAUSTED",
        "The bounded progress-watch journal sequence is exhausted.",
      );
    }
    for (const event of events) {
      state.watchSequence += 1;
      state.progressWatchEvents.push({
        sequence: state.watchSequence,
        ...event,
      });
    }
    while (
      state.progressWatchEvents.length > this.config.limits.eventCapacity
    ) {
      state.progressWatchEvents.shift();
    }
  }

  private settleProgressWatchesForAliases(
    state: GatewayPersistedState,
    aliases: ReadonlySet<string>,
    now: Date,
    actor: "gateway" | "operator" = "gateway",
  ): void {
    const retained: ProgressWatch[] = [];
    const events: PendingProgressWatchJournalEvent[] = [];
    for (const watch of state.progressWatches) {
      if (
        !aliases.has(watch.ownerAlias) &&
        !aliases.has(watch.workerAlias)
      ) {
        retained.push(watch);
        continue;
      }
      events.push(
        progressWatchJournalEvent(watch, now.toISOString(), {
          kind: "settled",
          actor,
          reason: "endpoint_retired",
        }),
      );
    }
    this.appendProgressWatchEvents(state, events);
    state.progressWatches = retained;
  }

  private settleProgressWatchesForConsentEdge(
    state: GatewayPersistedState,
    pair: GatewayConsentEdgeRecord,
    now: Date,
  ): void {
    const retained: ProgressWatch[] = [];
    const events: PendingProgressWatchJournalEvent[] = [];
    for (const watch of state.progressWatches) {
      if (!progressWatchMatchesConsentEdge(watch, pair)) {
        retained.push(watch);
        continue;
      }
      events.push(
        progressWatchJournalEvent(watch, now.toISOString(), {
          kind: "settled",
          actor: "operator",
          reason: "pair_removed",
        }),
      );
    }
    this.appendProgressWatchEvents(state, events);
    state.progressWatches = retained;
  }

  private finishMetadata(
    state: GatewayPersistedState,
    metadata: QueuedMessageMetadata | InFlightMessageMetadata,
    deliveryState: Extract<
      DeliveryState,
      | "delivered"
      | "unconfirmed"
      | "failed"
      | "ambiguous"
      | "expired"
      | "cancelled"
      | "abandoned"
    >,
    now: Date,
    safeErrorCode?: string,
  ): TerminalMessageSettlement {
    const counterKey = deliveryState;
    state.accounting[counterKey] += 1;
    const pair = findConsentEdgeForMessage(state, metadata);
    if (pair !== undefined) {
      pair.counters[counterKey] += 1;
      pair.updatedAt = now.toISOString();
    }
    const target = state.routes.find(
      (route) => route.alias === metadata.targetAlias,
    );
    if (target) target.counters[counterKey] += 1;
    this.appendEvent(state, {
      timestamp: now.toISOString(),
      messageIdSuffix: metadata.messageIdSuffix,
      ...(metadata.conversationIdSuffix === undefined
        ? {}
        : { conversationIdSuffix: metadata.conversationIdSuffix }),
      direction: metadata.direction,
      sourceAlias: metadata.sourceAlias,
      targetAlias: metadata.targetAlias,
      state: deliveryState,
      bytes: metadata.bytes,
      ...(metadata.body === undefined ? {} : { body: metadata.body }),
      ...(metadata.steer === true ? { steer: true as const } : {}),
      latencyMs: Math.max(0, now.getTime() - Date.parse(metadata.enqueuedAt)),
      ...(safeErrorCode ? { safeErrorCode } : {}),
    });
    return {
      messageId: metadata.messageId,
      state: deliveryState,
      ...(safeErrorCode ? { safeErrorCode } : {}),
    };
  }

  private validateAffectedInFlightSettlements(
    state: GatewayPersistedState,
    aliases: Set<string>,
    requested: readonly RouteInFlightSettlementInput[],
  ): ReadonlyMap<string, RouteInFlightSettlementInput> {
    if (requested.length > this.config.limits.maxInFlightMessages) {
      throw new BridgeError(
        "INVALID_ROUTE_TERMINATION_PLAN",
        "Route termination requires one normalized terminal settlement per affected in-flight message.",
      );
    }
    const affectedIds = new Set(
      state.inFlight
        .filter((item) => routeTerminationMatches(state, aliases, item))
        .map((item) => item.messageId),
    );
    const byMessageId = new Map<string, RouteInFlightSettlementInput>();
    for (const settlement of requested) {
      if (
        !MESSAGE_ID_PATTERN.test(settlement.messageId) ||
        (settlement.state !== "delivered" &&
          settlement.state !== "unconfirmed" &&
          settlement.state !== "failed" &&
          settlement.state !== "ambiguous" &&
          settlement.state !== "expired" &&
          settlement.state !== "cancelled") ||
        (settlement.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(settlement.safeErrorCode)) ||
        byMessageId.has(settlement.messageId)
      ) {
        throw new BridgeError(
          "INVALID_ROUTE_TERMINATION_PLAN",
          "Route termination requires one normalized terminal settlement per affected in-flight message.",
        );
      }
      byMessageId.set(settlement.messageId, settlement);
    }
    if (
      byMessageId.size !== affectedIds.size ||
      [...affectedIds].some((messageId) => !byMessageId.has(messageId)) ||
      [...byMessageId].some(([messageId]) => !affectedIds.has(messageId))
    ) {
      throw new BridgeError(
        "ROUTE_TERMINATION_PLAN_MISMATCH",
        "The exact in-flight route termination plan no longer matches the affected message set.",
        true,
      );
    }
    return byMessageId;
  }

  private validateAffectedConsentEdgeInFlightSettlements(
    state: GatewayPersistedState,
    pair: GatewayConsentEdgeInput | GatewayConsentEdgeRecord,
    requested: readonly RouteInFlightSettlementInput[],
  ): ReadonlyMap<string, RouteInFlightSettlementInput> {
    if (requested.length > this.config.limits.maxInFlightMessages) {
      throw new BridgeError(
        "INVALID_PAIR_TERMINATION_PLAN",
        "Unpairing requires one normalized terminal settlement per affected in-flight message.",
      );
    }
    const affectedIds = new Set(
      state.inFlight
        .filter((item) => consentEdgeMatchesMessage(pair, item))
        .map((item) => item.messageId),
    );
    const byMessageId = new Map<string, RouteInFlightSettlementInput>();
    for (const settlement of requested) {
      if (
        !MESSAGE_ID_PATTERN.test(settlement.messageId) ||
        (settlement.state !== "delivered" &&
          settlement.state !== "unconfirmed" &&
          settlement.state !== "failed" &&
          settlement.state !== "ambiguous" &&
          settlement.state !== "expired" &&
          settlement.state !== "cancelled") ||
        (settlement.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(settlement.safeErrorCode)) ||
        byMessageId.has(settlement.messageId)
      ) {
        throw new BridgeError(
          "INVALID_PAIR_TERMINATION_PLAN",
          "Unpairing requires one normalized terminal settlement per affected in-flight message.",
        );
      }
      byMessageId.set(settlement.messageId, settlement);
    }
    if (
      byMessageId.size !== affectedIds.size ||
      [...affectedIds].some((messageId) => !byMessageId.has(messageId)) ||
      [...byMessageId].some(([messageId]) => !affectedIds.has(messageId))
    ) {
      throw new BridgeError(
        "PAIR_TERMINATION_PLAN_MISMATCH",
        "The exact pair termination plan no longer matches its in-flight messages.",
        true,
      );
    }
    return byMessageId;
  }

  private terminateAffectedMessages(
    state: GatewayPersistedState,
    aliases: Set<string>,
    now: Date,
    safeErrorCode: string,
    inFlightSettlements: ReadonlyMap<
      string,
      RouteInFlightSettlementInput
    >,
    preserveQueued = false,
  ): TerminalMessageSettlement[] {
    const settlements: TerminalMessageSettlement[] = [];
    const queued = preserveQueued
      ? []
      : state.queue.filter((item) =>
          routeTerminationMatches(state, aliases, item),
        );
    if (!preserveQueued) {
      state.queue = state.queue.filter(
        (item) => !routeTerminationMatches(state, aliases, item),
      );
    }
    for (const item of queued) {
      this.transientBodies.delete(item.messageId);
      state.accounting.queuedBytes -= item.bytes;
      const target = state.routes.find((route) => route.alias === item.targetAlias);
      if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
      const deadlineReached = Date.parse(item.deadlineAt) <= now.getTime();
      settlements.push(
        this.finishMetadata(
          state,
          item,
          deadlineReached ? "expired" : "abandoned",
          now,
          deadlineReached ? "MESSAGE_EXPIRED" : safeErrorCode,
        ),
      );
    }
    const inFlight = state.inFlight.filter((item) =>
      routeTerminationMatches(state, aliases, item),
    );
    state.inFlight = state.inFlight.filter(
      (item) => !routeTerminationMatches(state, aliases, item),
    );
    for (const item of inFlight) {
      const requested = inFlightSettlements.get(item.messageId);
      if (requested === undefined) {
        throw new BridgeError(
          "ROUTE_TERMINATION_PLAN_MISMATCH",
          "The exact in-flight route termination plan no longer matches the affected message set.",
          true,
        );
      }
      settlements.push(
        this.finishMetadata(
          state,
          item,
          requested.state,
          now,
          requested.safeErrorCode,
        ),
      );
    }
    return settlements;
  }

  private terminateAffectedConsentEdgeMessages(
    state: GatewayPersistedState,
    pair: GatewayConsentEdgeInput | GatewayConsentEdgeRecord,
    now: Date,
    safeErrorCode: string,
    inFlightSettlements: ReadonlyMap<
      string,
      RouteInFlightSettlementInput
    >,
  ): TerminalMessageSettlement[] {
    const settlements: TerminalMessageSettlement[] = [];
    const queued = state.queue.filter((item) => consentEdgeMatchesMessage(pair, item));
    state.queue = state.queue.filter(
      (item) => !consentEdgeMatchesMessage(pair, item),
    );
    for (const item of queued) {
      this.transientBodies.delete(item.messageId);
      state.accounting.queuedBytes -= item.bytes;
      const target = state.routes.find(
        (route) => route.alias === item.targetAlias,
      );
      if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
      const deadlineReached = Date.parse(item.deadlineAt) <= now.getTime();
      settlements.push(
        this.finishMetadata(
          state,
          item,
          deadlineReached ? "expired" : "abandoned",
          now,
          deadlineReached ? "MESSAGE_EXPIRED" : safeErrorCode,
        ),
      );
    }
    const inFlight = state.inFlight.filter((item) =>
      consentEdgeMatchesMessage(pair, item),
    );
    state.inFlight = state.inFlight.filter(
      (item) => !consentEdgeMatchesMessage(pair, item),
    );
    for (const item of inFlight) {
      const requested = inFlightSettlements.get(item.messageId);
      if (requested === undefined) {
        throw new BridgeError(
          "PAIR_TERMINATION_PLAN_MISMATCH",
          "The exact pair termination plan no longer matches its in-flight messages.",
          true,
        );
      }
      settlements.push(
        this.finishMetadata(
          state,
          item,
          requested.state,
          now,
          requested.safeErrorCode,
        ),
      );
    }
    return settlements;
  }

  private prune(now: Date): void {
    const state = this.requireState();
    const eventCutoff = now.getTime() - this.config.limits.eventTtlMs;
    state.events = state.events
      .filter((event) => Date.parse(event.timestamp) > eventCutoff);
    state.progressWatchEvents = state.progressWatchEvents
      .filter((event) => Date.parse(event.timestamp) > eventCutoff);
    state.dedupe = state.dedupe
      .filter((record) => Date.parse(record.expiresAt) > now.getTime())
      .slice(-this.config.limits.dedupeCapacity);
    state.rateBuckets = state.rateBuckets.filter(
      (bucket) =>
        now.getTime() - Date.parse(bucket.windowStartedAt) <
        this.config.limits.rateWindowMs,
    );
    this.pruneRetainedEventBodies(state);
  }

  private recoverAfterRestart(now: Date): void {
    const state = this.requireState();
    this.recoverCodexSuccessionAfterRestart(state, now);
    if (this.config.trackingEnabled === false) {
      this.appendProgressWatchEvents(
        state,
        state.progressWatches.map((watch) =>
          progressWatchJournalEvent(watch, now.toISOString(), {
            kind: "settled",
            actor: "gateway",
            reason: "tracking_disabled",
          }),
        ),
      );
      state.progressWatches = [];
    }
    for (const connector of state.connectors) {
      connector.health = "offline";
      connector.updatedAt = now.toISOString();
      connector.safeErrorCode = "REOBSERVATION_REQUIRED";
    }
    for (const route of state.routes) {
      route.state = route.enabled ? "stale" : "disabled";
      route.updatedAt = now.toISOString();
      route.safeErrorCode = "REOBSERVATION_REQUIRED";
      route.queueDepth = 0;
    }
    const retainedQueue: QueuedMessageMetadata[] = [];
    let retainedQueuedBytes = 0;
    this.transientBodies.clear();
    for (const item of state.queue) {
      if (Date.parse(item.deadlineAt) <= now.getTime()) {
        this.finishMetadata(
          state,
          item,
          "expired",
          now,
          "MESSAGE_EXPIRED",
        );
        continue;
      }
      if (item.body === undefined) {
        this.finishMetadata(
          state,
          item,
          "abandoned",
          now,
          "CONTROLLER_RESTARTED",
        );
        continue;
      }
      // A correlated native reply admitted through a transient Claude
      // capability cannot regain its exact UUID/generation after restart,
      // even when another session later claims the same public alias.
      if (
        item.transientTarget === true ||
        !state.routes.some((route) => route.alias === item.targetAlias)
      ) {
        this.finishMetadata(
          state,
          item,
          "abandoned",
          now,
          "CONTROLLER_RESTARTED",
        );
        continue;
      }
      retainedQueue.push(item);
      retainedQueuedBytes += item.bytes;
      this.transientBodies.set(item.messageId, item.body);
      const target = state.routes.find(
        (route) => route.alias === item.targetAlias,
      );
      if (target !== undefined) target.queueDepth += 1;
    }
    for (const item of state.inFlight) {
      this.finishMetadata(
        state,
        item,
        "ambiguous",
        now,
        "CONTROLLER_RESTARTED",
      );
    }
    state.queue = retainedQueue;
    state.inFlight = [];
    state.accounting.queuedBytes = retainedQueuedBytes;
  }

  private recoverCodexSuccessionAfterRestart(
    state: GatewayPersistedState,
    now: Date,
  ): void {
    const journal = this.journal(state);
    if (journal === null || journal.stage === "prepared") return;
    const route = this.requireAnyJournalRoute(state, journal);
    this.assertSuccessionLedgerEmpty(state, route.alias);
    this.assertNewSuccessionIdentityAvailable(state, route, journal.new);
    this.replaceCodexRouteForSuccession(
      state,
      route,
      journal.new,
      now,
      "stale",
    );
    state.codexSuccession = {
      ...journal,
      stage: "recovery_forbidden",
      safeErrorCode: "CODEX_SUCCESSION_RESTART_RECOVERY_REQUIRED",
    };
  }

  private aggregateHealth(
    connectors: readonly PublicConnectorSnapshot[],
  ): "offline" | "connecting" | "healthy" | "degraded" {
    if (connectors.length === 0) return "offline";
    if (connectors.some((connector) => connector.health === "degraded")) {
      return "degraded";
    }
    if (connectors.some((connector) => connector.health === "connecting")) {
      return "connecting";
    }
    if (connectors.every((connector) => connector.health === "healthy")) {
      return "healthy";
    }
    return "offline";
  }

  private async prepareOwnedDirectory(): Promise<string> {
    const requested = path.resolve(this.rootDir);
    await assertNoSymlinkComponents(requested);
    const canonical = await canonicalFuturePath(requested);
    const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
    const temporaryRoot = await realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir()));
    if (
      canonical === path.parse(canonical).root ||
      canonical === home ||
      canonical === temporaryRoot
    ) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        "The gateway state directory must be a dedicated private leaf.",
      );
    }
    let existed = true;
    try {
      const info = await lstat(canonical);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_DIRECTORY",
          "The gateway state path must be a real directory.",
        );
      }
      this.assertOwnedPrivate(info.uid, info.mode, "directory");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
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
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        "The gateway state path changed while it was being prepared.",
      );
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
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        markerExists = false;
      } else {
        throw error;
      }
    }
    if (!markerExists) {
      const entries = await readdir(root);
      if (existed && entries.length > 0) {
        throw new BridgeError(
          "GATEWAY_STATE_DIRECTORY_NOT_OWNED",
          "The existing gateway state directory is non-empty and has no gateway ownership marker.",
        );
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
      await chmod(markerPath, 0o600);
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
    if ((mode & 0o077) !== 0) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        `The gateway ${kind} must not grant group or other permissions.`,
      );
    }
  }

  private async readPrivateFile(
    filePath: string,
    maximumBytes: number,
    expectedBody?: string,
  ): Promise<string> {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_FILE",
        "A gateway controller file is not a regular file.",
      );
    }
    this.assertOwnedPrivate(info.uid, info.mode, "state file");
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      info.size > maximumBytes
    ) {
      throw new BridgeError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "A gateway controller file exceeds its strict byte limit.",
      );
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
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_FILE",
          "A gateway controller file changed during its bounded read.",
        );
      }
      this.assertOwnedPrivate(opened.uid, opened.mode, "state file");
      const buffer = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximumBytes) {
        throw new BridgeError(
          "GATEWAY_STATE_FILE_TOO_LARGE",
          "A gateway controller file exceeds its strict byte limit.",
        );
      }
      const body = buffer.subarray(0, offset).toString("utf8");
      if (expectedBody !== undefined && body !== expectedBody) {
        throw new BridgeError(
          "GATEWAY_STATE_DIRECTORY_NOT_OWNED",
          "The gateway ownership marker is not recognized.",
        );
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
              schemaVersion: 1,
              pid: process.pid,
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
        ) as {
          pid?: unknown;
          hostname?: unknown;
        };
      } catch {
        throw new BridgeError(
          "GATEWAY_STATE_LOCK_UNVERIFIED",
          "The gateway state lock exists but cannot be safely verified.",
        );
      }
      if (
        owner.hostname !== os.hostname() ||
        !isPositiveInteger(owner.pid)
      ) {
        throw new BridgeError(
          "GATEWAY_STATE_IN_USE",
          "The gateway state directory is locked by another or unverifiable host process.",
          true,
        );
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
        throw new BridgeError(
          "GATEWAY_STATE_IN_USE",
          "Another live gateway controller owns this state directory.",
          true,
        );
      }
      await rename(
        lockPath,
        path.join(this.rootDir, `.gateway-controller.lock.stale-${randomUUID()}`),
      ).catch((error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    throw new BridgeError(
      "GATEWAY_STATE_IN_USE",
      "Could not acquire exclusive gateway controller ownership.",
      true,
    );
  }

  async releaseControllerLock(): Promise<void> {
    const handle = this.lockHandle;
    const token = this.lockToken;
    this.lockHandle = undefined;
    this.lockToken = undefined;
    if (!handle || !token) return;
    await handle.close().catch(() => undefined);
    const lockPath = path.join(this.rootDir, CONTROLLER_LOCK);
    try {
      const parsed = JSON.parse(
        await this.readPrivateFile(lockPath, MAX_LOCK_FILE_BYTES),
      ) as {
        token?: unknown;
      };
      if (parsed.token === token) await unlink(lockPath);
    } catch {
      // Never remove a lock that cannot be proven to belong to this instance.
    }
  }

  private async loadStateFile(
    _now: Date,
  ): Promise<GatewayPersistedState | undefined> {
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
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state is not valid JSON.",
      );
    }
    if (!isPersistedState(parsed)) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state failed strict schema validation.",
      );
    }
    if (
      parsed.routes.some((route) => !this.config.allowedHosts.includes(route.binding.hostId)) ||
      parsed.connectors.some((connector) => !this.config.allowedHosts.includes(connector.hostId)) ||
      parsed.routes.length > this.config.limits.maxRoutes ||
      parsed.connectors.length >
        this.config.allowedHosts.length * gatewayProviders.length ||
      parsed.consentEdges.length > this.config.limits.maxConsentEdges ||
      parsed.rateBuckets.length > this.config.limits.maxRoutes ||
      parsed.progressWatches.length >
        (this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY) ||
      parsed.dedupe.length > this.config.limits.dedupeCapacity ||
      parsed.queue.length > this.config.limits.maxQueueMessages ||
      parsed.inFlight.length > this.config.limits.maxInFlightMessages ||
      parsed.queue.length + parsed.inFlight.length >
        this.config.limits.maxQueueMessages ||
      parsed.queue.some((item) => item.bytes > this.config.limits.maxMessageBytes) ||
      parsed.accounting.queuedBytes > this.config.limits.maxQueueBytes
    ) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway state exceeds its current allowlist or configured bounds.",
      );
    }
    return parsed;
  }

  private async persist(force = false): Promise<void> {
    if (this.persistenceDeferred && !force) return;
    const state = this.requireState();
    if (!isPersistedState(state)) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway refused to persist internally inconsistent state.",
      );
    }
    const temporary = path.join(
      this.rootDir,
      `.gateway-state-${randomUUID()}.tmp`,
    );
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > GATEWAY_MAX_STATE_FILE_BYTES) {
      throw new BridgeError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "The bounded gateway controller state exceeds its durable byte limit.",
      );
    }
    let handle: FileHandle | undefined;
    let renamed = false;
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
            throw new BridgeError(
              "UNSAFE_GATEWAY_STATE_FILE",
              "The gateway state target is not a regular file.",
            );
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
        await rename(temporary, this.stateFilePath);
        renamed = true;
        await this.afterStateFileRename?.();
        const directory = await open(this.rootDir, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!renamed) throw error;
        let installed: GatewayPersistedState | undefined;
        try {
          installed = await this.loadStateFile(this.now());
        } catch {
          // Rename crossed the commit point. Keep the intended in-memory
          // authority even if verification itself is unavailable; never
          // manufacture an old-state rollback after an installed rename.
        }
        const verified =
          installed !== undefined &&
          JSON.stringify(installed) === JSON.stringify(state);
        if (verified && installed !== undefined) {
          this.state = installed;
        } else {
          this.state = undefined;
        }
        throw new PostRenamePersistenceError(verified);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
