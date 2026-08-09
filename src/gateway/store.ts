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
  PROGRESS_WATCH_MAX_IDLE_MS,
  PROGRESS_WATCH_MIN_IDLE_MS,
  createProgressWatchMachine,
  progressWatchCapabilities,
  progressWatchJournalKinds,
  progressWatchPhases,
  transitionProgressWatch,
  type ProgressWatchJournalEvent,
  type ProgressWatchMachine,
  type ProgressWatchOutcome,
} from "./progress-watch-machine.js";
import {
  compatibilityStates,
  connectorHealthStates,
  deliveryStates,
  gatewayProviders,
  messageDirections,
  projectGatewayPublicSnapshot,
  routeRegistrationModes,
  routeStates,
  type ConnectorRecord,
  type DedupeRecord,
  type DeliveryState,
  type EnqueueMessageInput,
  type EnqueueMessageResult,
  type EnqueueNativeIngressInput,
  type EnqueueNativeReplyInput,
  type GatewayAccounting,
  type GatewayPairRecord,
  type GatewayPersistedState,
  type GatewayPrivateRouteInspection,
  type GatewayPublicSnapshot,
  type GatewayRouteRecord,
  type GatewayStoreDependencies,
  type InFlightMessageMetadata,
  type InFlightMessageProgressState,
  type NormalizedMessageEvent,
  type ObserveConnectorInput,
  type ObserveRouteInput,
  type PrivateEndpointIdentity,
  type PrivateRouteBinding,
  type PublicConnectorSnapshot,
  type PublicPairSnapshot,
  type PublicRouteSnapshot,
  type QueuedMessageMetadata,
  type RebindStaleRouteInput,
  type RegisterRouteInput,
  type RequeueInFlightMessageResult,
  type RouteCounters,
  type SafeGatewayAlert,
  type SettleMessageInput,
  type SettleMessageResult,
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
const COMPATIBILITY = new Set<string>(compatibilityStates);
const ROUTE_STATES = new Set<string>(routeStates);
const REGISTRATION_MODES = new Set<string>(routeRegistrationModes);
const DIRECTIONS = new Set<string>(messageDirections);
const DELIVERY_STATES = new Set<string>(deliveryStates);
const PROGRESS_WATCH_PHASES = new Set<string>(progressWatchPhases);
const PROGRESS_WATCH_CAPABILITIES = new Set<string>(
  progressWatchCapabilities,
);
const PROGRESS_WATCH_JOURNAL_KINDS = new Set<string>(
  progressWatchJournalKinds,
);

export type OpenProgressWatchInput = Readonly<{
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  idleMs: number;
}>;

export type ProgressWatchAction = Readonly<{
  type: "send_nudge" | "notify_capability_degraded" | "settled";
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  nudgeNumber?: 1 | 2;
  outcome?: ProgressWatchOutcome;
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

export type GatewayPairInput = Readonly<{
  claudeAlias: string;
  codexAlias: string;
}>;

export type UnpairRoutesInput = GatewayPairInput &
  Readonly<{
    inFlightSettlements?: readonly RouteInFlightSettlementInput[];
  }>;

export type UnpairRoutesResult = Readonly<{
  settlements: readonly TerminalMessageSettlement[];
  claudeRouteUnreferenced: boolean;
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
        "compatibility",
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
    typeof value.compatibility === "string" &&
    COMPATIBILITY.has(value.compatibility) &&
    value.busyPolicy === "queue" &&
    isIsoTimestamp(value.registeredAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.lastSeenAt === undefined || isIsoTimestamp(value.lastSeenAt)) &&
    isNonNegativeInteger(value.queueDepth) &&
    isRouteCounters(value.counters) &&
    (value.safeErrorCode === undefined || isSafeCode(value.safeErrorCode))
  );
}

function isPairRecord(value: unknown): value is GatewayPairRecord {
  return (
    isObject(value) &&
    hasOnlyKeys(value, [
      "claudeAlias",
      "codexAlias",
      "claudeOwnerLease",
      "codexOwnerLease",
      "createdAt",
      "updatedAt",
      "counters",
    ]) &&
    typeof value.claudeAlias === "string" &&
    ALIAS_PATTERN.test(value.claudeAlias) &&
    typeof value.codexAlias === "string" &&
    ALIAS_PATTERN.test(value.codexAlias) &&
    isPrivateToken(value.claudeOwnerLease) &&
    isPrivateToken(value.codexOwnerLease) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    isRouteCounters(value.counters)
  );
}

function isProgressWatchMachine(value: unknown): value is ProgressWatchMachine {
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      [
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
      ],
      ["workerReportedCompleteAt"],
    )
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
    typeof value.phase === "string" &&
    PROGRESS_WATCH_PHASES.has(value.phase) &&
    (value.nudgeCount === 0 ||
      value.nudgeCount === 1 ||
      value.nudgeCount === 2) &&
    (value.phase === "quiet"
      ? value.nudgeCount === 0
      : value.nudgeCount === 1 || value.nudgeCount === 2) &&
    isIsoTimestamp(value.nextActionAt) &&
    typeof value.capability === "string" &&
    PROGRESS_WATCH_CAPABILITIES.has(value.capability) &&
    typeof value.degradedNoticeSent === "boolean" &&
    (value.workerReportedCompleteAt === undefined ||
      isIsoTimestamp(value.workerReportedCompleteAt))
  );
}

function isProgressWatchJournalEvent(
  value: unknown,
): value is ProgressWatchJournalEvent {
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
    PROGRESS_WATCH_JOURNAL_KINDS.has(value.kind) &&
    (value.nudgeNumber === undefined ||
      value.nudgeNumber === 1 ||
      value.nudgeNumber === 2) &&
    (value.kind === "nudge"
      ? value.nudgeNumber === 1 || value.nudgeNumber === 2
      : value.nudgeNumber === undefined)
  );
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
        "compatibility",
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
    typeof value.compatibility === "string" &&
    COMPATIBILITY.has(value.compatibility) &&
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
        "hopCount",
      ],
      ["pair", "steer"],
    )
  ) {
    return false;
  }
  return (
    typeof value.messageId === "string" &&
    MESSAGE_ID_PATTERN.test(value.messageId) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    typeof value.direction === "string" &&
    DIRECTIONS.has(value.direction) &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    isIsoTimestamp(value.enqueuedAt) &&
    isIsoTimestamp(value.deadlineAt) &&
    isPositiveInteger(value.bytes) &&
    isNonNegativeInteger(value.hopCount) &&
    (value.pair === undefined || value.pair === true) &&
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
        "hopCount",
      ],
      ["latencyMs", "safeErrorCode", "steer"],
    )
  ) {
    return false;
  }
  return (
    isPositiveInteger(value.sequence) &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
    typeof value.direction === "string" &&
    DIRECTIONS.has(value.direction) &&
    typeof value.sourceAlias === "string" &&
    ALIAS_PATTERN.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" &&
    ALIAS_PATTERN.test(value.targetAlias) &&
    typeof value.state === "string" &&
    DELIVERY_STATES.has(value.state) &&
    isPositiveInteger(value.bytes) &&
    isNonNegativeInteger(value.hopCount) &&
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
      ["pair"],
    ) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.fingerprint) &&
    typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX_PATTERN.test(value.messageIdSuffix) &&
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

const PRE_UNCONFIRMED_ROUTE_COUNTER_KEYS = [
  "accepted",
  "delivered",
  "failed",
  "ambiguous",
  "expired",
  "cancelled",
  "abandoned",
  "rejected",
  "bytesAccepted",
] as const;

const PRE_UNCONFIRMED_ACCOUNTING_KEYS = [
  "accepted",
  "duplicates",
  "delivered",
  "failed",
  "ambiguous",
  "expired",
  "cancelled",
  "abandoned",
  "rejected",
  "bytesAccepted",
  "queuedBytes",
] as const;

/**
 * One narrow migration for unpublished dogfood state created before the
 * `unconfirmed` terminal outcome existed. Atomic state replacement means a
 * valid old file has either every old counter shape or none of them; mixed or
 * otherwise unfamiliar shapes continue to fail strict validation.
 */
function migratePreUnconfirmedCounters(value: unknown): unknown {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isObject(value.accounting) ||
    !hasOnlyKeys(value.accounting, PRE_UNCONFIRMED_ACCOUNTING_KEYS) ||
    Object.hasOwn(value.accounting, "unconfirmed") ||
    !Array.isArray(value.routes) ||
    !value.routes.every(
      (route) =>
        isObject(route) &&
        isObject(route.counters) &&
        hasOnlyKeys(route.counters, PRE_UNCONFIRMED_ROUTE_COUNTER_KEYS) &&
        !Object.hasOwn(route.counters, "unconfirmed"),
    )
  ) {
    return value;
  }
  return {
    ...value,
    accounting: { ...value.accounting, unconfirmed: 0 },
    routes: value.routes.map((route) => {
      const record = route as Record<string, unknown>;
      return {
        ...record,
        counters: {
          ...(record.counters as Record<string, unknown>),
          unconfirmed: 0,
        },
      };
    }),
  };
}

const PRE_SUCCESSION_JOURNAL_STATE_KEYS = [
  "schemaVersion",
  "createdAt",
  "updatedAt",
  "eventSequence",
  "routes",
  "connectors",
  "queue",
  "inFlight",
  "events",
  "dedupe",
  "rateBuckets",
  "accounting",
] as const;

/** Add the nullable internal journal to exact legacy v1 state only. */
function migratePreSuccessionJournal(value: unknown): unknown {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, PRE_SUCCESSION_JOURNAL_STATE_KEYS)
  ) {
    return value;
  }
  return { ...value, codexSuccession: null };
}

const PRE_PAIR_GRAPH_STATE_KEYS = [
  ...PRE_SUCCESSION_JOURNAL_STATE_KEYS,
  "codexSuccession",
] as const;

/**
 * Preserve the old explicit singleton-selection consent when adding the pair
 * graph. This migration accepts only the exact prior v1 top-level shape; final
 * state validation still proves every route, lease, host, and edge.
 */
function migratePrePairGraph(value: unknown): unknown {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, PRE_PAIR_GRAPH_STATE_KEYS) ||
    !Array.isArray(value.routes) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return value;
  }
  const routes = value.routes.filter(isObject);
  const claudeRoutes = routes.filter(
    (route) =>
      route.registrationMode === "selected_live_peer" &&
      isObject(route.binding) &&
      route.binding.provider === "claude",
  );
  const codexRoutes = routes.filter(
    (route) =>
      route.registrationMode === "explicit_opt_in" &&
      isObject(route.binding) &&
      route.binding.provider === "codex",
  );
  const pairs: GatewayPairRecord[] = [];
  for (const claude of claudeRoutes) {
    for (const codex of codexRoutes) {
      const claudeBinding = claude.binding as Record<string, unknown>;
      const codexBinding = codex.binding as Record<string, unknown>;
      if (
        claudeBinding.hostId !== codexBinding.hostId ||
        typeof claude.alias !== "string" ||
        typeof codex.alias !== "string" ||
        typeof claudeBinding.ownerLease !== "string" ||
        typeof codexBinding.ownerLease !== "string"
      ) {
        continue;
      }
      pairs.push({
        claudeAlias: claude.alias,
        codexAlias: codex.alias,
        claudeOwnerLease: claudeBinding.ownerLease,
        codexOwnerLease: codexBinding.ownerLease,
        createdAt: value.updatedAt,
        updatedAt: value.updatedAt,
        counters: emptyCounters(),
      });
    }
  }
  if (pairs.length > 256) return value;
  return { ...value, pairs };
}

const PRE_PROGRESS_WATCH_STATE_KEYS = [
  ...PRE_PAIR_GRAPH_STATE_KEYS,
  "pairs",
] as const;

/** Add empty opt-in watch state to the exact preceding v1 schema only. */
function migratePreProgressWatches(value: unknown): unknown {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, PRE_PROGRESS_WATCH_STATE_KEYS)
  ) {
    return value;
  }
  return {
    ...value,
    watchSequence: 0,
    progressWatches: [],
    progressWatchEvents: [],
  };
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
      "pairs",
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
      "codexSuccession",
    ]) ||
    value.schemaVersion !== 1 ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isNonNegativeInteger(value.eventSequence) ||
    !isNonNegativeInteger(value.watchSequence) ||
    !Array.isArray(value.routes) ||
    !value.routes.every(isRouteRecord) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length > 256 ||
    !value.pairs.every(isPairRecord) ||
    !Array.isArray(value.progressWatches) ||
    value.progressWatches.length > 256 ||
    !value.progressWatches.every(isProgressWatchMachine) ||
    !Array.isArray(value.progressWatchEvents) ||
    !value.progressWatchEvents.every(isProgressWatchJournalEvent) ||
    !Array.isArray(value.connectors) ||
    !value.connectors.every(isConnectorRecord) ||
    !Array.isArray(value.queue) ||
    !value.queue.every(isQueuedMetadata) ||
    !Array.isArray(value.inFlight) ||
    !value.inFlight.every(isInFlightMetadata) ||
    !Array.isArray(value.events) ||
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
    const pairAliases = pairAliasesForRoutes(owner, worker);
    if (
      !candidate.pairs.some(
        (pair) =>
          pair.claudeAlias === pairAliases.claudeAlias &&
          pair.codexAlias === pairAliases.codexAlias &&
          pair.claudeOwnerLease ===
            (owner.binding.provider === "claude"
              ? owner.binding.ownerLease
              : worker.binding.ownerLease) &&
          pair.codexOwnerLease ===
            (owner.binding.provider === "codex"
              ? owner.binding.ownerLease
              : worker.binding.ownerLease),
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
  const pairKeys = candidate.pairs.map(
    (pair) => `${pair.claudeAlias}\0${pair.codexAlias}`,
  );
  const pairsValid = candidate.pairs.every((pair) => {
    const claude = routeByAlias.get(pair.claudeAlias);
    const codex = routeByAlias.get(pair.codexAlias);
    return (
      claude?.binding.provider === "claude" &&
      codex?.binding.provider === "codex" &&
      claude.binding.hostId === codex.binding.hostId &&
      claude.binding.ownerLease === pair.claudeOwnerLease &&
      codex.binding.ownerLease === pair.codexOwnerLease
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
    direction: "codex_to_claude" | "claude_to_codex";
    sourceAlias: string;
    targetAlias: string;
    pair?: true;
  }): boolean => {
    const source = routeByAlias.get(message.sourceAlias);
    const target = routeByAlias.get(message.targetAlias);
    const routeShapeValid =
      message.direction === "codex_to_claude"
        ? source?.binding.provider === "codex" &&
          ((target?.binding.provider === "claude" &&
            target.binding.hostId === source.binding.hostId) ||
            (target === undefined &&
              claudeConnectorHosts.has(source.binding.hostId) &&
              aliasHost(message.targetAlias) === source.binding.hostId))
        : target?.binding.provider === "codex" &&
          ((source?.binding.provider === "claude" &&
            source.binding.hostId === target.binding.hostId) ||
            (source === undefined &&
              claudeConnectorHosts.has(target.binding.hostId) &&
              aliasHost(message.sourceAlias) === target.binding.hostId));
    return (
      routeShapeValid &&
      (message.pair !== true ||
        candidate.pairs.some((pair) => pairMatchesMessage(pair, message)))
    );
  };
  const sequencesStrictlyIncrease = candidate.events.every(
    (event, index) =>
      index === 0 ||
      event.sequence > (candidate.events[index - 1]?.sequence ?? 0),
  );
  return (
    aliases.size === candidate.routes.length &&
    new Set(pairKeys).size === pairKeys.length &&
    pairsValid &&
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
    candidate.events.every(
      (event) => event.sequence <= candidate.eventSequence,
    ) &&
    candidate.routes.every(
      (route) =>
        route.alias.endsWith(`@${route.binding.hostId}`) &&
        ((route.binding.provider === "codex" &&
          route.registrationMode === "explicit_opt_in") ||
          (route.binding.provider === "claude" &&
            route.registrationMode === "selected_live_peer")) &&
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
            route.binding.provider === "codex" &&
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

function pairKey(claudeAlias: string, codexAlias: string): string {
  return `${claudeAlias}\0${codexAlias}`;
}

function pairAliasesForRoutes(
  source: GatewayRouteRecord,
  target: GatewayRouteRecord,
): GatewayPairInput {
  if (
    source.binding.provider === "claude" &&
    target.binding.provider === "codex"
  ) {
    return { claudeAlias: source.alias, codexAlias: target.alias };
  }
  if (
    source.binding.provider === "codex" &&
    target.binding.provider === "claude"
  ) {
    return { claudeAlias: target.alias, codexAlias: source.alias };
  }
  throw new BridgeError(
    "INVALID_GATEWAY_ROUTE_PAIR",
    "Gateway pairs must connect one Claude route and one Codex route.",
  );
}

function pairMatchesMessage(
  pair: GatewayPairInput,
  message: Pick<
    QueuedMessageMetadata,
    "sourceAlias" | "targetAlias" | "pair"
  >,
): boolean {
  return (
    message.pair === true &&
    ((message.sourceAlias === pair.claudeAlias &&
      message.targetAlias === pair.codexAlias) ||
      (message.sourceAlias === pair.codexAlias &&
        message.targetAlias === pair.claudeAlias))
  );
}

function findPairForMessage(
  state: GatewayPersistedState,
  message: Pick<QueuedMessageMetadata, "sourceAlias" | "targetAlias">,
): GatewayPairRecord | undefined {
  return state.pairs.find((pair) => pairMatchesMessage(pair, message));
}

function renamePairAlias(
  state: GatewayPersistedState,
  previousAlias: string,
  newAlias: string,
  now: Date,
): void {
  if (previousAlias === newAlias) return;
  for (const pair of state.pairs) {
    if (pair.claudeAlias === previousAlias) pair.claudeAlias = newAlias;
    if (pair.codexAlias === previousAlias) pair.codexAlias = newAlias;
    if (
      pair.claudeAlias === newAlias ||
      pair.codexAlias === newAlias
    ) {
      pair.updatedAt = now.toISOString();
    }
  }
}

function removePairsForAliases(
  state: GatewayPersistedState,
  aliases: ReadonlySet<string>,
): void {
  state.pairs = state.pairs.filter(
    (pair) =>
      !aliases.has(pair.claudeAlias) && !aliases.has(pair.codexAlias),
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
): "codex_to_claude" | "claude_to_codex" {
  if (
    source.binding.provider === "codex" &&
    target.binding.provider === "claude"
  ) {
    return "codex_to_claude";
  }
  if (
    source.binding.provider === "claude" &&
    target.binding.provider === "codex"
  ) {
    return "claude_to_codex";
  }
  throw new BridgeError(
    "INVALID_GATEWAY_ROUTE_PAIR",
    "Gateway messages must cross from one provider to the other.",
  );
}

type ResolvedEnqueueSides = {
  sourceAlias: string;
  targetAlias: string;
  direction: "codex_to_claude" | "claude_to_codex";
  pair?: true;
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

  async initialize(): Promise<void> {
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
        const loaded = await this.loadStateFile();
        const now = this.now();
        this.state = loaded ?? {
          schemaVersion: 1,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          eventSequence: 0,
          routes: [],
          pairs: [],
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
          codexSuccession: null,
        };
        if (this.state.pairs.length > this.config.limits.maxPairs) {
          throw new BridgeError(
            "PAIR_CAPACITY_REACHED",
            "The durable pair inventory exceeds the configured bound.",
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
        await this.persist();
      } catch (error) {
        this.state = undefined;
        await this.releaseControllerLock();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.run("gateway", async () => {
      this.transientBodies.clear();
      this.state = undefined;
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
        compatibility: input.compatibility,
        protocol: input.protocol,
        protocolVersion: input.protocolVersion,
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        ...(input.safeErrorCode ? { safeErrorCode: input.safeErrorCode } : {}),
      };
      if (existingIndex >= 0) state.connectors[existingIndex] = observed;
      else {
        if (state.connectors.length >= this.config.allowedHosts.length * 2) {
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
        route.compatibility = "expired";
        route.updatedAt = now.toISOString();
        route.safeErrorCode = safeErrorCode;
      }
      return this.terminateAffectedMessages(
        state,
        affectedAliases,
        now,
        safeErrorCode,
        settlementPlan,
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
        !["healthy", "degraded"].includes(connector.health) ||
        connector.compatibility !== "compatible"
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The exact compatible endpoint generation must be observed before a route can be registered.",
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
        byAlias.compatibility = "compatible";
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
        compatibility: "compatible",
        busyPolicy: "queue",
        registeredAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        queueDepth: 0,
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
        !["healthy", "degraded"].includes(connector.health) ||
        connector.compatibility !== "compatible"
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The exact compatible endpoint generation must be observed before a Claude selection can replace another.",
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
        (!retained.enabled ||
          retained.state !== "stale" ||
          retained.compatibility !== "expired")
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
      const retiredAliases = new Set(retired.map((route) => route.alias));
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        retiredAliases,
        input.inFlightSettlements ?? [],
      );
      const settlements = this.terminateAffectedMessages(
        state,
        retiredAliases,
        now,
        "ROUTE_UNREGISTERED",
        settlementPlan,
      );
      this.settleProgressWatchesForAliases(state, retiredAliases, now);
      state.routes = state.routes.filter((route) => !retired.includes(route));
      removePairsForAliases(state, retiredAliases);
      state.rateBuckets = state.rateBuckets.filter(
        (bucket) => !retiredAliases.has(bucket.sourceAlias),
      );
      state.dedupe = state.dedupe.filter(
        (record) =>
          !retiredAliases.has(record.sourceAlias) &&
          !retiredAliases.has(record.targetAlias),
      );

      if (
        state.routes.some(
          (route) =>
            route !== retained &&
            (sameRouteTarget(route.binding, replacement.binding) ||
              route.binding.ownerLease === replacement.binding.ownerLease),
        )
      ) {
        throw new BridgeError(
          "ROUTE_BINDING_COLLISION",
          "The replacement Claude authority collides with a non-retired route.",
        );
      }

      if (retained !== undefined) {
        const previousAlias = retained.alias;
        retained.alias = replacement.alias;
        retained.binding = { ...replacement.binding };
        retained.enabled = true;
        retained.state = replacement.state ?? "idle";
        retained.compatibility = "compatible";
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
          renamePairAlias(state, previousAlias, replacement.alias, now);
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
          compatibility: "compatible",
          busyPolicy: "queue",
          registeredAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          queueDepth: 0,
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
          ? connector?.health === "degraded" &&
            connector.compatibility === "expired"
          : connector !== undefined &&
            ["healthy", "degraded"].includes(connector.health) &&
            connector.compatibility === "compatible";
      if (!endpointObservationValid) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The route observation must match the exact endpoint generation's current health and compatibility.",
        );
      }
      route.state = input.state;
      route.compatibility = input.compatibility;
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
      route.compatibility = "expired";
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
        !newAlias.endsWith(`@${input.newBinding.hostId}`)
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
        route.compatibility !== "expired" ||
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
          "ROUTE_REBIND_NOT_SAFE",
          "Only an enabled, expired, empty stale route can be rebound.",
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
      const connector = state.connectors.find((candidate) =>
        sameEndpoint(candidate, input.newBinding),
      );
      if (
        !connector ||
        !["healthy", "degraded"].includes(connector.health) ||
        connector.compatibility !== "compatible"
      ) {
        throw new BridgeError(
          "ROUTE_ENDPOINT_NOT_OBSERVED",
          "The replacement endpoint generation must be positively observed and compatible.",
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
      const previousAlias = route.alias;
      route.binding = { ...input.newBinding };
      route.alias = newAlias;
      route.state = input.state ?? "idle";
      route.compatibility = "compatible";
      route.updatedAt = now.toISOString();
      route.lastSeenAt = now.toISOString();
      delete route.safeErrorCode;
      if (previousAlias !== newAlias) {
        // Restart recovery has already emptied queue/in-flight state. Keep the
        // metadata rewrite complete anyway so this mutation stays atomic if a
        // future caller uses the same primitive after another invalidation.
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
        renamePairAlias(state, previousAlias, newAlias, now);
      }
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
  ): Promise<TerminalMessageSettlement[]> {
    return await this.mutate(async (state, now) => {
      const route = this.requireOwnedRoute(state, alias, ownerLease);
      const aliases = new Set([route.alias]);
      const settlementPlan = this.validateAffectedInFlightSettlements(
        state,
        aliases,
        inFlightSettlements,
      );
      const settlements = this.terminateAffectedMessages(
        state,
        aliases,
        now,
        "ROUTE_UNREGISTERED",
        settlementPlan,
      );
      this.settleProgressWatchesForAliases(state, aliases, now);
      state.routes = state.routes.filter((candidate) => candidate !== route);
      removePairsForAliases(state, aliases);
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
      renamePairAlias(state, alias, newAlias, now);
      for (let index = 0; index < state.progressWatches.length; index += 1) {
        const watch = state.progressWatches[index];
        if (watch === undefined) continue;
        if (watch.ownerAlias === alias) {
          state.progressWatches[index] = {
            ...watch,
            ownerAlias: newAlias,
            updatedAt: now.toISOString(),
          };
        } else if (watch.workerAlias === alias) {
          state.progressWatches[index] = {
            ...watch,
            workerAlias: newAlias,
            updatedAt: now.toISOString(),
          };
        }
      }
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
        !["idle", "busy", "awaiting_approval"].includes(route.state) ||
        route.compatibility !== "compatible"
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
        compatibility: route.compatibility,
        ...(route.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: route.safeErrorCode }),
      };
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
          compatibility: route.compatibility,
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
      this.requireCompatibleObservedEndpoint(state, input.new.binding);
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
      this.requireCompatibleObservedEndpoint(state, journal.new.binding);
      this.assertNewSuccessionIdentityAvailable(state, route, journal.new);
      this.replaceCodexRouteForSuccession(
        state,
        route,
        journal.new,
        now,
        input.state,
        "compatible",
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
          compatibility: route.compatibility,
        }));
    });
  }

  /** Create one explicit, durable Claude↔Codex consent edge. */
  async pairRoutes(input: GatewayPairInput): Promise<{ created: boolean }> {
    return this.mutate(async (state, now) => {
      const { claude, codex } = this.requirePairRoutes(state, input);
      const existing = state.pairs.find(
        (pair) =>
          pair.claudeAlias === claude.alias && pair.codexAlias === codex.alias,
      );
      if (existing !== undefined) {
        if (
          existing.claudeOwnerLease !== claude.binding.ownerLease ||
          existing.codexOwnerLease !== codex.binding.ownerLease
        ) {
          throw new BridgeError(
            "PAIR_AUTHORITY_MISMATCH",
            "The pair aliases no longer match their exact route authorities.",
          );
        }
        return { created: false };
      }
      if (state.pairs.length >= this.config.limits.maxPairs) {
        throw new BridgeError(
          "PAIR_CAPACITY_REACHED",
          "The bounded permission graph cannot accept another pair.",
          true,
        );
      }
      state.pairs.push({
        claudeAlias: claude.alias,
        codexAlias: codex.alias,
        claudeOwnerLease: claude.binding.ownerLease,
        codexOwnerLease: codex.binding.ownerLease,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        counters: emptyCounters(),
      });
      return { created: true };
    });
  }

  /** Bounded metadata-only graph inventory for controller inference. */
  async inspectPairs(): Promise<GatewayPairInput[]> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      return state.pairs
        .map(({ claudeAlias, codexAlias }) => ({ claudeAlias, codexAlias }))
        .sort((left, right) =>
          pairKey(left.claudeAlias, left.codexAlias).localeCompare(
            pairKey(right.claudeAlias, right.codexAlias),
          ),
        );
    });
  }

  /** Open one durable owner-ended watch on an exact consent edge. */
  async openProgressWatch(
    input: OpenProgressWatchInput,
  ): Promise<{ created: boolean; watch: ProgressWatchMachine }> {
    return this.mutate(async (state, now) => {
      if (
        !CONVERSATION_ID_PATTERN.test(input.conversationId) ||
        !ALIAS_PATTERN.test(input.ownerAlias) ||
        !ALIAS_PATTERN.test(input.workerAlias) ||
        input.ownerAlias === input.workerAlias ||
        !Number.isSafeInteger(input.idleMs) ||
        input.idleMs < PROGRESS_WATCH_MIN_IDLE_MS ||
        input.idleMs > PROGRESS_WATCH_MAX_IDLE_MS
      ) {
        throw new BridgeError(
          "INVALID_PROGRESS_WATCH",
          "The progress-watch request is malformed or outside its idle bound.",
        );
      }
      const existing = state.progressWatches.find(
        (watch) => watch.conversationId === input.conversationId,
      );
      if (existing !== undefined) {
        if (
          existing.ownerAlias !== input.ownerAlias ||
          existing.workerAlias !== input.workerAlias
        ) {
          throw new BridgeError(
            "PROGRESS_WATCH_OWNERSHIP_MISMATCH",
            "The conversation watch belongs to different exact endpoints.",
          );
        }
        return { created: false, watch: { ...existing } };
      }
      if (
        state.progressWatches.length >=
        (this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY)
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_CAPACITY_REACHED",
          "The bounded progress-watch inventory is full.",
          true,
        );
      }
      const owner = this.requireAvailableRoute(state, input.ownerAlias);
      const worker = this.requireAvailableRoute(state, input.workerAlias);
      const pairAliases = pairAliasesForRoutes(owner, worker);
      this.requireExactPair(
        state,
        owner.binding.provider === "claude" ? owner : worker,
        owner.binding.provider === "codex" ? owner : worker,
      );
      if (
        pairAliases.claudeAlias !==
          (owner.binding.provider === "claude"
            ? owner.alias
            : worker.alias) ||
        pairAliases.codexAlias !==
          (owner.binding.provider === "codex" ? owner.alias : worker.alias)
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_EDGE_MISMATCH",
          "The watch endpoints do not form one exact consent edge.",
        );
      }
      const watch = createProgressWatchMachine({
        conversationId: input.conversationId,
        ownerAlias: owner.alias,
        workerAlias: worker.alias,
        ownerLease: owner.binding.ownerLease,
        workerLease: worker.binding.ownerLease,
        idleMs: input.idleMs,
        at: now.getTime(),
      });
      state.progressWatches.push(watch);
      this.appendProgressWatchEvent(state, watch, {
        kind: "opened",
        timestamp: now.toISOString(),
      });
      return { created: true, watch: { ...watch } };
    });
  }

  async inspectProgressWatches(): Promise<ProgressWatchMachine[]> {
    return this.mutex.run("gateway", async () =>
      this.requireState().progressWatches.map((watch) => ({ ...watch })),
    );
  }

  async touchProgressWatch(input: Readonly<{
    conversationId: string;
    actorAlias: string;
    workerReportedComplete?: true;
  }>): Promise<boolean> {
    return this.mutate(async (state, now) => {
      const index = state.progressWatches.findIndex(
        (watch) => watch.conversationId === input.conversationId,
      );
      const watch = state.progressWatches[index];
      if (watch === undefined) return false;
      if (
        input.actorAlias !== watch.ownerAlias &&
        input.actorAlias !== watch.workerAlias
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_OWNERSHIP_MISMATCH",
          "The watch activity did not come from an endpoint on its exact edge.",
        );
      }
      const workerReportedComplete =
        input.workerReportedComplete === true &&
        input.actorAlias === watch.workerAlias;
      const transition = transitionProgressWatch(watch, {
        type: "activity",
        at: now.getTime(),
        ...(workerReportedComplete
          ? { workerReportedComplete: true as const }
          : {}),
      });
      if (transition.state === null) return false;
      state.progressWatches[index] = transition.state;
      if (workerReportedComplete) {
        this.appendProgressWatchEvent(state, transition.state, {
          kind: "worker_reported_complete",
          timestamp: now.toISOString(),
        });
      }
      return true;
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
        const transition = transitionProgressWatch(watch, {
          type: "route_activity",
          at: now.getTime(),
        });
        if (transition.state !== null) {
          state.progressWatches[index] = transition.state;
          changed += 1;
        }
      }
      return changed;
    });
  }

  async settleProgressWatch(input: Readonly<{
    conversationId: string;
    outcome: ProgressWatchOutcome;
    ownerAlias?: string;
  }>): Promise<boolean> {
    return this.mutate(async (state, now) => {
      const index = state.progressWatches.findIndex(
        (watch) => watch.conversationId === input.conversationId,
      );
      const watch = state.progressWatches[index];
      if (watch === undefined) return false;
      if (
        input.ownerAlias !== undefined &&
        input.ownerAlias !== watch.ownerAlias
      ) {
        throw new BridgeError(
          "PROGRESS_WATCH_OWNER_REQUIRED",
          "Only the exact watch owner may end this watch.",
        );
      }
      const event =
        input.outcome === "done"
          ? ({ type: "owner_done", at: now.getTime() } as const)
          : input.outcome === "endpoint_retired"
            ? ({ type: "endpoint_retired", at: now.getTime() } as const)
            : input.outcome === "disabled"
              ? ({ type: "disabled", at: now.getTime() } as const)
              : undefined;
      if (event === undefined) {
        throw new BridgeError(
          "INVALID_PROGRESS_WATCH_SETTLEMENT",
          "Unresponsive settlement is owned only by the watch deadline machine.",
        );
      }
      const transition = transitionProgressWatch(watch, event);
      state.progressWatches.splice(index, 1);
      this.appendProgressWatchEvent(state, watch, {
        kind: input.outcome,
        timestamp: now.toISOString(),
      });
      return transition.state === null;
    });
  }

  /** Advance every due watch once under one durable store mutation. */
  async advanceDueProgressWatches(): Promise<ProgressWatchAction[]> {
    return this.mutate(async (state, now) => {
      const actions: ProgressWatchAction[] = [];
      const retained: ProgressWatchMachine[] = [];
      for (const watch of state.progressWatches) {
        if (Date.parse(watch.nextActionAt) > now.getTime()) {
          retained.push(watch);
          continue;
        }
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
        const pairPresent =
          owner !== undefined &&
          worker !== undefined &&
          state.pairs.some(
            (pair) =>
              ((pair.claudeAlias === owner.alias &&
                pair.codexAlias === worker.alias) ||
                (pair.claudeAlias === worker.alias &&
                  pair.codexAlias === owner.alias)) &&
              pair.claudeOwnerLease ===
                (owner.binding.provider === "claude"
                  ? owner.binding.ownerLease
                  : worker.binding.ownerLease) &&
              pair.codexOwnerLease ===
                (owner.binding.provider === "codex"
                  ? owner.binding.ownerLease
                  : worker.binding.ownerLease),
          );
        const transition = transitionProgressWatch(watch, {
          type: "due",
          at: now.getTime(),
          bothIdle: owner?.state === "idle" && worker?.state === "idle",
          endpointsPresent: pairPresent,
        });
        if (transition.state !== null) retained.push(transition.state);
        for (const effect of transition.effects) {
          if (effect.type === "send_nudge") {
            this.appendProgressWatchEvent(
              state,
              transition.state ?? watch,
              {
                kind: "nudge",
                timestamp: now.toISOString(),
                nudgeNumber: effect.nudgeNumber,
              },
            );
            actions.push({
              type: "send_nudge",
              conversationId: watch.conversationId,
              ownerAlias: watch.ownerAlias,
              workerAlias: watch.workerAlias,
              nudgeNumber: effect.nudgeNumber,
            });
          } else if (effect.type === "settled") {
            this.appendProgressWatchEvent(state, watch, {
              kind: effect.outcome,
              timestamp: now.toISOString(),
            });
            actions.push({
              type: "settled",
              conversationId: watch.conversationId,
              ownerAlias: watch.ownerAlias,
              workerAlias: watch.workerAlias,
              outcome: effect.outcome,
            });
          }
        }
      }
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

  async hasPair(input: GatewayPairInput): Promise<boolean> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      try {
        const { claude, codex } = this.requirePairRoutes(state, input, false);
        return state.pairs.some(
          (pair) =>
            pair.claudeAlias === claude.alias &&
            pair.codexAlias === codex.alias &&
            pair.claudeOwnerLease === claude.binding.ownerLease &&
            pair.codexOwnerLease === codex.binding.ownerLease,
        );
      } catch (error) {
        if (error instanceof BridgeError) return false;
        throw error;
      }
    });
  }

  async inspectAffectedPairInFlightMessages(
    input: GatewayPairInput,
  ): Promise<AffectedInFlightMessageInspection[]> {
    return this.mutex.run("gateway", async () => {
      const state = this.requireState();
      const { claude, codex } = this.requirePairRoutes(state, input, false);
      this.requireExactPair(state, claude, codex);
      return state.inFlight
        .filter((item) => pairMatchesMessage(input, item))
        .map(({ messageId, deadlineAt }) => ({ messageId, deadlineAt }));
    });
  }

  /**
   * Remove exactly one consent edge and settle only work owned by that edge.
   * Adjacent pairs, terminal token metadata, and unrelated messages survive.
   */
  async unpairRoutes(input: UnpairRoutesInput): Promise<UnpairRoutesResult> {
    return this.mutate(async (state, now) => {
      const { claude, codex } = this.requirePairRoutes(state, input, false);
      const pair = this.requireExactPair(state, claude, codex);
      const plan = this.validateAffectedPairInFlightSettlements(
        state,
        pair,
        input.inFlightSettlements ?? [],
      );
      const settlements = this.terminateAffectedPairMessages(
        state,
        pair,
        now,
        "PAIR_REMOVED",
        plan,
      );
      this.settleProgressWatchesForPair(state, pair, now);
      state.pairs = state.pairs.filter((candidate) => candidate !== pair);
      state.dedupe = state.dedupe.filter(
        (record) => !pairMatchesMessage(pair, record),
      );
      return {
        settlements,
        claudeRouteUnreferenced: !state.pairs.some(
          (candidate) => candidate.claudeAlias === pair.claudeAlias,
        ),
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
        const pairAliases = pairAliasesForRoutes(source, target);
        this.requireExactPair(
          state,
          pairAliases.claudeAlias === source.alias ? source : target,
          pairAliases.codexAlias === source.alias ? source : target,
        );
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
      if (target.binding.provider !== "codex") {
        throw new BridgeError(
          "INVALID_NATIVE_INGRESS_TARGET",
          "Native Claude ingress requires an explicitly registered Codex target.",
        );
      }
      this.validateTransientNativeClaudePeer(state, input.source, target);
      const selectedClaude = state.routes.find(
        (route) =>
          route.alias === input.source.alias &&
          route.binding.provider === "claude" &&
          route.registrationMode === "selected_live_peer" &&
          route.enabled &&
          route.compatibility === "compatible" &&
          ["idle", "busy", "awaiting_approval"].includes(route.state) &&
          sameBinding(route.binding, input.source.binding),
      );
      const pair =
        selectedClaude === undefined
          ? undefined
          : state.pairs.find(
              (candidate) =>
                candidate.claudeAlias === selectedClaude.alias &&
                candidate.codexAlias === target.alias &&
                candidate.claudeOwnerLease ===
                  selectedClaude.binding.ownerLease &&
                candidate.codexOwnerLease === target.binding.ownerLease,
            );
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
              direction: "claude_to_codex",
              targetRoute: target,
            },
            bytes,
            now,
            "SENDER_NOT_PAIRED",
            input.steer,
          );
          throw new BridgeError(
            "SENDER_NOT_PAIRED",
            "The native Claude sender is not the exact session paired with this Codex task.",
          );
      }
      return this.enqueueResolvedMessage(state, now, input, {
        sourceAlias: input.source.alias,
        targetAlias: target.alias,
        direction: "claude_to_codex",
        targetRoute: target,
        ...(pair === undefined ? {} : { pair: true as const }),
      });
    });
  }

  /**
   * Queue a correlated Codex reply for a caller-attested transient Claude
   * peer. The service owns conversation correlation and the live dispatch
   * capability; the store retains only bounded public-alias metadata.
   */
  async enqueueNativeReply(
    input: EnqueueNativeReplyInput,
  ): Promise<EnqueueMessageResult> {
    return this.mutate(async (state, now) => {
      const source = this.requireAvailableRoute(state, input.sourceAlias);
      if (source.binding.provider !== "codex") {
        throw new BridgeError(
          "INVALID_NATIVE_REPLY_SOURCE",
          "A native Claude reply requires an explicitly registered Codex source.",
        );
      }
      this.validateTransientNativeClaudePeer(state, input.target, source);
      if (input.pair === true) {
        const target = state.routes.find(
          (route) =>
            route.alias === input.target.alias &&
            route.binding.provider === "claude" &&
            sameBinding(route.binding, input.target.binding),
        );
        if (target === undefined) {
          throw new BridgeError(
            "SENDER_NOT_PAIRED",
            "The correlated reply no longer has its exact paired Claude route.",
          );
        }
        this.requireExactPair(state, target, source);
      }
      return this.enqueueResolvedMessage(state, now, input, {
        sourceAlias: source.alias,
        targetAlias: input.target.alias,
        direction: "codex_to_claude",
        sourceRoute: source,
        ...(input.pair === true ? { pair: true as const } : {}),
      });
    });
  }

  async dequeueMessage(
    targetAlias?: string,
    mode: "any" | "steer_only" = "any",
  ): Promise<TransientQueuedMessage | undefined> {
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
      state.queue.splice(index, 1);
      state.accounting.queuedBytes -= metadata.bytes;
      const target = state.routes.find(
        (route) => route.alias === metadata.targetAlias,
      );
      if (target) target.queueDepth = Math.max(0, target.queueDepth - 1);
      const body = this.transientBodies.get(metadata.messageId);
      this.transientBodies.delete(metadata.messageId);
      if (body === undefined) {
        this.finishMetadata(state, metadata, "abandoned", now, "TRANSIENT_BODY_UNAVAILABLE");
        return undefined;
      }
      state.inFlight.push({ ...metadata, dispatchedAt: now.toISOString() });
      this.appendEvent(state, {
        timestamp: now.toISOString(),
        messageIdSuffix: metadata.messageIdSuffix,
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: "dispatching",
        bytes: metadata.bytes,
        hopCount: metadata.hopCount,
        ...(metadata.steer === true ? { steer: true as const } : {}),
        latencyMs: Math.max(0, now.getTime() - Date.parse(metadata.enqueuedAt)),
      });
      return { ...metadata, body };
    });
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
  ): Promise<RequeueInFlightMessageResult> {
    return this.mutate(async (state, now) => {
      if (!MESSAGE_ID_PATTERN.test(messageId) || typeof body !== "string") {
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
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: "held",
        bytes: metadata.bytes,
        hopCount: metadata.hopCount,
        ...(metadata.steer === true ? { steer: true as const } : {}),
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
        direction: metadata.direction,
        sourceAlias: metadata.sourceAlias,
        targetAlias: metadata.targetAlias,
        state: progress,
        bytes: metadata.bytes,
        hopCount: metadata.hopCount,
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
        .map((connector) => ({
          provider: connector.provider,
          host: connector.hostId,
          health: connector.health,
          compatibility: connector.compatibility,
          protocol: connector.protocol,
          protocolVersion: connector.protocolVersion,
          ...(connector.lastSeenAt ? { lastSeenAt: connector.lastSeenAt } : {}),
          ...(connector.safeErrorCode
            ? { safeErrorCode: connector.safeErrorCode }
            : {}),
        }))
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
            compatibility: route.compatibility,
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
      const pairs: PublicPairSnapshot[] = state.pairs
        .map((pair) => ({
          claudeAlias: pair.claudeAlias,
          codexAlias: pair.codexAlias,
          host: pair.claudeAlias.slice(pair.claudeAlias.lastIndexOf("@") + 1),
          counters: { ...pair.counters },
        }))
        .sort((left, right) =>
          `${left.claudeAlias}\0${left.codexAlias}`.localeCompare(
            `${right.claudeAlias}\0${right.codexAlias}`,
          ),
        );
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
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        inboundMode: this.config.inboundMode,
        health,
        connectors,
        availablePeers: [],
        routes,
        pairs,
        messages: state.events.map((event) => ({ ...event })),
        accounting: { ...state.accounting },
        alerts,
        truncation: {
          connectors: 0,
          availablePeers: 0,
          routes: 0,
          pairs: 0,
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
    compatibility: "compatible" | "expired",
  ): void {
    const oldAlias = route.alias;
    route.alias = identity.alias;
    route.binding = { ...identity.binding };
    route.registrationMode = "explicit_opt_in";
    route.enabled = true;
    route.state = routeState;
    route.compatibility = compatibility;
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
    this.settleProgressWatchesForAliases(
      state,
      new Set([oldAlias, identity.alias]),
      now,
    );
    removePairsForAliases(state, new Set([oldAlias, identity.alias]));
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

  private requireCompatibleObservedEndpoint(
    state: GatewayPersistedState,
    binding: PrivateRouteBinding,
  ): void {
    const connector = state.connectors.find((candidate) =>
      sameEndpoint(candidate, binding),
    );
    if (
      !connector ||
      !["healthy", "degraded"].includes(connector.health) ||
      connector.compatibility !== "compatible"
    ) {
      throw new BridgeError(
        "ROUTE_ENDPOINT_NOT_OBSERVED",
        "The exact compatible endpoint generation must be observed before Codex succession can publish or activate it.",
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
    if (
      (input.binding.provider === "codex" &&
        input.registrationMode !== "explicit_opt_in") ||
      (input.binding.provider === "claude" &&
        input.registrationMode !== "selected_live_peer")
    ) {
      throw new BridgeError(
        "ROUTE_OPT_IN_REQUIRED",
        "Codex routes require explicit self opt-in and Claude routes require a selected live peer.",
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
      !["idle", "busy", "awaiting_approval"].includes(route.state) ||
      route.compatibility !== "compatible"
    ) {
      throw new BridgeError(
        "ROUTE_UNAVAILABLE",
        "The selected route is not currently enabled and positively observed.",
        true,
      );
    }
    return route;
  }

  private requirePairRoutes(
    state: GatewayPersistedState,
    input: GatewayPairInput,
    requireAvailable = true,
  ): { claude: GatewayRouteRecord; codex: GatewayRouteRecord } {
    if (
      !isObject(input) ||
      typeof input.claudeAlias !== "string" ||
      typeof input.codexAlias !== "string" ||
      !ALIAS_PATTERN.test(input.claudeAlias) ||
      !ALIAS_PATTERN.test(input.codexAlias) ||
      input.claudeAlias === input.codexAlias
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_PAIR",
        "A pair requires distinct normalized Claude and Codex aliases.",
      );
    }
    const resolve = (alias: string): GatewayRouteRecord => {
      if (requireAvailable) return this.requireAvailableRoute(state, alias);
      const route = state.routes.find((candidate) => candidate.alias === alias);
      if (route === undefined) {
        throw new BridgeError(
          "PAIR_ROUTE_NOT_FOUND",
          "The pair references a route that is not registered.",
        );
      }
      return route;
    };
    const claude = resolve(input.claudeAlias);
    const codex = resolve(input.codexAlias);
    if (
      claude.binding.provider !== "claude" ||
      claude.registrationMode !== "selected_live_peer" ||
      codex.binding.provider !== "codex" ||
      codex.registrationMode !== "explicit_opt_in" ||
      claude.binding.hostId !== codex.binding.hostId
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_PAIR",
        "A pair must connect one selected Claude route and one registered Codex route on the same host.",
      );
    }
    return { claude, codex };
  }

  private requireExactPair(
    state: GatewayPersistedState,
    claude: GatewayRouteRecord,
    codex: GatewayRouteRecord,
  ): GatewayPairRecord {
    const pair = state.pairs.find(
      (candidate) =>
        candidate.claudeAlias === claude.alias &&
        candidate.codexAlias === codex.alias,
    );
    if (
      pair === undefined ||
      pair.claudeOwnerLease !== claude.binding.ownerLease ||
      pair.codexOwnerLease !== codex.binding.ownerLease
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
    codexRoute: GatewayRouteRecord,
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
      codexRoute.binding.provider !== "codex" ||
      aliasHost !== peer.binding.hostId ||
      peer.binding.hostId !== codexRoute.binding.hostId ||
      peer.alias === codexRoute.alias
    ) {
      throw new BridgeError(
        "NATIVE_PEER_SCOPE_MISMATCH",
        "The transient Claude peer and registered Codex route must have distinct aliases on the same allowlisted host.",
      );
    }
    const connector = state.connectors.find((candidate) =>
      sameEndpoint(candidate, peer.binding),
    );
    if (
      !connector ||
      !["healthy", "degraded"].includes(connector.health) ||
      connector.compatibility !== "compatible"
    ) {
      throw new BridgeError(
        "NATIVE_PEER_ENDPOINT_NOT_OBSERVED",
        "The transient Claude peer's exact compatible connector generation is not live.",
        true,
      );
    }
  }

  private enqueueResolvedMessage(
    state: GatewayPersistedState,
    now: Date,
    input: Pick<
      EnqueueMessageInput,
      "body" | "dedupeKey" | "deadlineAt" | "hopCount" | "steer"
    >,
    sides: ResolvedEnqueueSides,
  ): EnqueueMessageResult {
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
      );
      throw new BridgeError(
        "MESSAGE_TOO_LARGE",
        "The transient message exceeds the configured byte limit.",
      );
    }
    const hopCount = input.hopCount ?? 0;
    if (
      !isNonNegativeInteger(hopCount) ||
      hopCount > this.config.limits.maxHopCount
    ) {
      this.recordRejection(
        state,
        sides,
        bytes,
        now,
        "HOP_LIMIT_EXCEEDED",
        input.steer,
      );
      throw new BridgeError(
        "HOP_LIMIT_EXCEEDED",
        "The message exceeds the configured gateway hop limit.",
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
        bytes,
        hopCount,
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
      );
      throw new BridgeError(
        "GATEWAY_QUEUE_FULL",
        "The bounded gateway queue cannot accept another message.",
        true,
      );
    }
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
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      enqueuedAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
      bytes,
      hopCount,
      ...(sides.pair === true ? { pair: true as const } : {}),
      ...(input.steer === true ? { steer: true as const } : {}),
    };
    state.queue.push(metadata);
    this.transientBodies.set(messageId, input.body);
    state.accounting.accepted += 1;
    state.accounting.bytesAccepted += bytes;
    const pair = findPairForMessage(state, metadata);
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
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      state: "queued",
      bytes,
      hopCount,
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
  ): void {
    const suffix = this.randomId().replaceAll("-", "").slice(-8).toLowerCase();
    if (!MESSAGE_SUFFIX_PATTERN.test(suffix)) return;
    state.accounting.rejected += 1;
    if (sides.sourceRoute) sides.sourceRoute.counters.rejected += 1;
    const pair = findPairForMessage(state, sides);
    if (pair !== undefined) {
      pair.counters.rejected += 1;
      pair.updatedAt = now.toISOString();
    }
    this.appendEvent(state, {
      timestamp: now.toISOString(),
      messageIdSuffix: suffix,
      direction: sides.direction,
      sourceAlias: sides.sourceAlias,
      targetAlias: sides.targetAlias,
      state: "rejected",
      bytes: Math.max(1, bytes),
      hopCount: 0,
      safeErrorCode,
      ...(steer === true ? { steer: true as const } : {}),
    });
  }

  private appendEvent(
    state: GatewayPersistedState,
    event: Omit<NormalizedMessageEvent, "sequence">,
  ): void {
    state.eventSequence += 1;
    state.events.push({ sequence: state.eventSequence, ...event });
    while (state.events.length > this.config.limits.eventCapacity) {
      state.events.shift();
    }
  }

  private appendProgressWatchEvent(
    state: GatewayPersistedState,
    watch: ProgressWatchMachine,
    event: Readonly<{
      kind: ProgressWatchJournalEvent["kind"];
      timestamp: string;
      nudgeNumber?: 1 | 2;
    }>,
  ): void {
    state.watchSequence += 1;
    state.progressWatchEvents.push({
      sequence: state.watchSequence,
      timestamp: event.timestamp,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: event.kind,
      ...(event.nudgeNumber === undefined
        ? {}
        : { nudgeNumber: event.nudgeNumber }),
    });
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
  ): void {
    const retained: ProgressWatchMachine[] = [];
    for (const watch of state.progressWatches) {
      if (
        !aliases.has(watch.ownerAlias) &&
        !aliases.has(watch.workerAlias)
      ) {
        retained.push(watch);
        continue;
      }
      this.appendProgressWatchEvent(state, watch, {
        kind: "endpoint_retired",
        timestamp: now.toISOString(),
      });
    }
    state.progressWatches = retained;
  }

  private settleProgressWatchesForPair(
    state: GatewayPersistedState,
    pair: GatewayPairInput,
    now: Date,
  ): void {
    const retained: ProgressWatchMachine[] = [];
    for (const watch of state.progressWatches) {
      const matches =
        (watch.ownerAlias === pair.claudeAlias &&
          watch.workerAlias === pair.codexAlias) ||
        (watch.ownerAlias === pair.codexAlias &&
          watch.workerAlias === pair.claudeAlias);
      if (!matches) {
        retained.push(watch);
        continue;
      }
      this.appendProgressWatchEvent(state, watch, {
        kind: "endpoint_retired",
        timestamp: now.toISOString(),
      });
    }
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
    const pair = findPairForMessage(state, metadata);
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
      direction: metadata.direction,
      sourceAlias: metadata.sourceAlias,
      targetAlias: metadata.targetAlias,
      state: deliveryState,
      bytes: metadata.bytes,
      hopCount: metadata.hopCount,
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

  private validateAffectedPairInFlightSettlements(
    state: GatewayPersistedState,
    pair: GatewayPairInput,
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
        .filter((item) => pairMatchesMessage(pair, item))
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
  ): TerminalMessageSettlement[] {
    const settlements: TerminalMessageSettlement[] = [];
    const queued = state.queue.filter((item) =>
      routeTerminationMatches(state, aliases, item),
    );
    state.queue = state.queue.filter(
      (item) => !routeTerminationMatches(state, aliases, item),
    );
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

  private terminateAffectedPairMessages(
    state: GatewayPersistedState,
    pair: GatewayPairInput,
    now: Date,
    safeErrorCode: string,
    inFlightSettlements: ReadonlyMap<
      string,
      RouteInFlightSettlementInput
    >,
  ): TerminalMessageSettlement[] {
    const settlements: TerminalMessageSettlement[] = [];
    const queued = state.queue.filter((item) => pairMatchesMessage(pair, item));
    state.queue = state.queue.filter(
      (item) => !pairMatchesMessage(pair, item),
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
      pairMatchesMessage(pair, item),
    );
    state.inFlight = state.inFlight.filter(
      (item) => !pairMatchesMessage(pair, item),
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
      .filter((event) => Date.parse(event.timestamp) > eventCutoff)
      .slice(-this.config.limits.eventCapacity);
    state.progressWatchEvents = state.progressWatchEvents
      .filter((event) => Date.parse(event.timestamp) > eventCutoff)
      .slice(-this.config.limits.eventCapacity);
    state.dedupe = state.dedupe
      .filter((record) => Date.parse(record.expiresAt) > now.getTime())
      .slice(-this.config.limits.dedupeCapacity);
    state.rateBuckets = state.rateBuckets.filter(
      (bucket) =>
        now.getTime() - Date.parse(bucket.windowStartedAt) <
        this.config.limits.rateWindowMs,
    );
  }

  private recoverAfterRestart(now: Date): void {
    const state = this.requireState();
    this.recoverCodexSuccessionAfterRestart(state, now);
    for (let index = 0; index < state.progressWatches.length; index += 1) {
      const watch = state.progressWatches[index];
      if (watch === undefined) continue;
      const transition = transitionProgressWatch(watch, {
        type: "restart",
        at: now.getTime(),
        conversationCapabilityRestored: false,
      });
      if (transition.state !== null) {
        state.progressWatches[index] = transition.state;
      }
      if (
        transition.effects.some(
          (effect) => effect.type === "notify_capability_degraded",
        )
      ) {
        this.appendProgressWatchEvent(state, transition.state ?? watch, {
          kind: "capability_degraded",
          timestamp: now.toISOString(),
        });
      }
    }
    for (const connector of state.connectors) {
      connector.health = "offline";
      connector.compatibility = "expired";
      connector.updatedAt = now.toISOString();
      connector.safeErrorCode = "REOBSERVATION_REQUIRED";
    }
    for (const route of state.routes) {
      route.state = route.enabled ? "stale" : "disabled";
      route.compatibility = "expired";
      route.updatedAt = now.toISOString();
      route.safeErrorCode = "REOBSERVATION_REQUIRED";
      route.queueDepth = 0;
    }
    for (const item of state.queue) {
      state.accounting.queuedBytes -= item.bytes;
      this.finishMetadata(
        state,
        item,
        "abandoned",
        now,
        "CONTROLLER_RESTARTED",
      );
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
    state.queue = [];
    state.inFlight = [];
    state.accounting.queuedBytes = 0;
    this.transientBodies.clear();
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
      "expired",
    );
    state.codexSuccession = {
      ...journal,
      stage: "recovery_forbidden",
      safeErrorCode: "CODEX_SUCCESSION_RESTART_RECOVERY_REQUIRED",
    };
  }

  private aggregateHealth(
    connectors: readonly PublicConnectorSnapshot[],
  ): "offline" | "connecting" | "healthy" | "degraded" | "incompatible" {
    if (connectors.length === 0) return "offline";
    if (connectors.some((connector) => connector.health === "incompatible")) {
      return "incompatible";
    }
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
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state is not valid JSON.",
      );
    }
    parsed = migratePreUnconfirmedCounters(parsed);
    parsed = migratePreSuccessionJournal(parsed);
    parsed = migratePrePairGraph(parsed);
    parsed = migratePreProgressWatches(parsed);
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
      parsed.connectors.length > this.config.allowedHosts.length * 2 ||
      parsed.rateBuckets.length > this.config.limits.maxRoutes ||
      parsed.progressWatches.length >
        (this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY) ||
      parsed.progressWatchEvents.length > this.config.limits.eventCapacity ||
      parsed.events.length > this.config.limits.eventCapacity ||
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

  private async persist(): Promise<void> {
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
          installed = await this.loadStateFile();
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
