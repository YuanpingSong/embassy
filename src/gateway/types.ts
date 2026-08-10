import type {
  ProgressWatchJournalEvent,
  ProgressWatchMachine,
} from "./progress-watch-machine.js";
import type { CompatibilityAttestation } from "./compatibility.js";

export const gatewayProviders = ["codex", "claude"] as const;

export type GatewayProvider = (typeof gatewayProviders)[number];

export const gatewayInboundModes = ["paired", "open"] as const;

export type GatewayInboundMode = (typeof gatewayInboundModes)[number];

export const connectorHealthStates = [
  "offline",
  "connecting",
  "healthy",
  "degraded",
  "incompatible",
] as const;

export type ConnectorHealth = (typeof connectorHealthStates)[number];

export const compatibilityStates = [
  "unknown",
  "compatible",
  "incompatible",
  "expired",
] as const;

export type CompatibilityState = (typeof compatibilityStates)[number];

export const routeStates = [
  "stale",
  "idle",
  "busy",
  "awaiting_approval",
  "offline",
  "incompatible",
  "disabled",
] as const;

export type RouteState = (typeof routeStates)[number];

export const routeRegistrationModes = [
  "explicit_opt_in",
  "selected_live_peer",
] as const;

export type RouteRegistrationMode =
  (typeof routeRegistrationModes)[number];

export const messageDirections = [
  "codex_to_claude",
  "claude_to_codex",
] as const;

export type MessageDirection = (typeof messageDirections)[number];

export const deliveryStates = [
  "queued",
  "duplicate",
  "dispatching",
  "transport_written",
  "held",
  "delivered",
  "unconfirmed",
  "failed",
  "ambiguous",
  "expired",
  "cancelled",
  "abandoned",
  "rejected",
] as const;

export type DeliveryState = (typeof deliveryStates)[number];

export const terminalDeliveryStates = new Set<DeliveryState>([
  "delivered",
  "unconfirmed",
  "failed",
  "ambiguous",
  "expired",
  "cancelled",
  "abandoned",
  "rejected",
]);

export const alertSeverities = ["info", "warning", "error"] as const;

export type AlertSeverity = (typeof alertSeverities)[number];

export type BusyPolicy = "queue";

/** Canonical closed-array bounds shared by store projections and control/UI. */
export const gatewayPublicSnapshotLimits = Object.freeze({
  connectors: 64,
  compatibilityChecks: 2,
  availablePeers: 256,
  routes: 256,
  pairs: 256,
  progressWatches: 64,
  progressWatchEvents: 256,
  activityEvents: 256,
  messages: 1_024,
  alerts: 256,
} as const);

/** Leaves headroom for the private control protocol response envelope. */
export const GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET = 240 * 1024;

/**
 * Private connector identity. Values in this structure are permitted only in
 * controller-owned state and connector calls. They must never be copied into
 * public snapshots, normalized events, logs, or error messages.
 */
export type PrivateEndpointIdentity = {
  provider: GatewayProvider;
  hostId: string;
  endpointGeneration: string;
};

/**
 * Private, immutable target binding. routeHandle may be a native provider
 * thread/session identifier; ownerLease proves which registration owns it.
 */
export type PrivateRouteBinding = PrivateEndpointIdentity & {
  routeHandle: string;
  ownerLease: string;
};

export type RouteCounters = {
  accepted: number;
  delivered: number;
  unconfirmed: number;
  failed: number;
  ambiguous: number;
  expired: number;
  cancelled: number;
  abandoned: number;
  rejected: number;
  bytesAccepted: number;
};

export type GatewayRouteRecord = {
  alias: string;
  binding: PrivateRouteBinding;
  registrationMode: RouteRegistrationMode;
  enabled: boolean;
  state: RouteState;
  compatibility: CompatibilityState;
  busyPolicy: BusyPolicy;
  registeredAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  queueDepth: number;
  counters: RouteCounters;
  safeErrorCode?: string;
};

/**
 * Durable bidirectional consent between two exact route owners. Aliases are
 * display coordinates; the private leases prevent an alias from silently
 * retargeting an existing permission edge.
 */
export type GatewayPairRecord = {
  claudeAlias: string;
  codexAlias: string;
  claudeOwnerLease: string;
  codexOwnerLease: string;
  createdAt: string;
  updatedAt: string;
  counters: RouteCounters;
};

/**
 * Controller-internal route view used to prove ownership across a restart.
 * This type must never cross the control protocol or enter a public snapshot.
 */
export type GatewayPrivateRouteInspection = {
  alias: string;
  binding: PrivateRouteBinding;
  registrationMode: RouteRegistrationMode;
  enabled: boolean;
  state: RouteState;
  compatibility: CompatibilityState;
  safeErrorCode?: string;
};

export type ConnectorRecord = {
  provider: GatewayProvider;
  hostId: string;
  endpointGeneration: string;
  health: ConnectorHealth;
  compatibility: CompatibilityState;
  protocol: string;
  protocolVersion: string;
  updatedAt: string;
  lastSeenAt?: string;
  safeErrorCode?: string;
};

/** Metadata persisted for a queued message. Legacy rows may be bodyless. */
export type QueuedMessageMetadata = {
  messageId: string;
  messageIdSuffix: string;
  /** Bounded public correlation only; the full conversation capability stays private. */
  conversationIdSuffix?: string;
  direction: MessageDirection;
  sourceAlias: string;
  targetAlias: string;
  enqueuedAt: string;
  deadlineAt: string;
  bytes: number;
  /** Bounded same-user durable payload; absent only on pre-v1.2 rows. */
  body?: string;
  hopCount: number;
  /** This message was admitted by the exact durable consent edge. */
  pair?: true;
  /** Target authority was transient and must never be reconstructed after restart. */
  transientTarget?: true;
  /** Exact Claude-to-Codex `STEER:` classification; absence means ordinary. */
  steer?: true;
};

/** A dispatch value with the exact persisted body promoted to required. */
export type TransientQueuedMessage = QueuedMessageMetadata & {
  body: string;
};

export type InFlightMessageMetadata = QueuedMessageMetadata & {
  dispatchedAt: string;
};

export type DedupeRecord = {
  fingerprint: string;
  messageIdSuffix: string;
  conversationIdSuffix?: string;
  sourceAlias: string;
  targetAlias: string;
  direction: MessageDirection;
  pair?: true;
  firstSeenAt: string;
  expiresAt: string;
};

export type RateBucket = {
  sourceAlias: string;
  windowStartedAt: string;
  count: number;
};

export type NormalizedMessageEvent = {
  sequence: number;
  timestamp: string;
  messageIdSuffix: string;
  conversationIdSuffix?: string;
  direction: MessageDirection;
  sourceAlias: string;
  targetAlias: string;
  state: DeliveryState;
  bytes: number;
  /** Retained payload; oldest values are evicted without removing metadata. */
  body?: string;
  hopCount: number;
  steer?: true;
  latencyMs?: number;
  safeErrorCode?: string;
};

export type GatewayAccounting = {
  accepted: number;
  duplicates: number;
  delivered: number;
  unconfirmed: number;
  failed: number;
  ambiguous: number;
  expired: number;
  cancelled: number;
  abandoned: number;
  rejected: number;
  bytesAccepted: number;
  queuedBytes: number;
};

/**
 * Private proof that one exact Codex task was re-anchored after its App Server
 * endpoint generation changed. Native task and endpoint identifiers in this
 * journal must never enter a public snapshot, event, error, or log.
 */
export type CodexEndpointRefreshJournalEvent = {
  sequence: number;
  timestamp: string;
  alias: string;
  hostId: string;
  threadId: string;
  oldEndpointGeneration: string;
  newEndpointGeneration: string;
  /** Broker-start proof; absent for a live endpoint-generation refresh. */
  reason?: "boot_reactivation";
};

export const CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY = 256;

/**
 * Private durable evidence that an operator removed one safely proven stale
 * Codex registration. No native task or endpoint identifiers are retained.
 */
export type CodexOrphanRemovalJournalEvent = {
  sequence: number;
  timestamp: string;
  alias: string;
  hostId: string;
};

export const CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY = 256;

export type GatewayPersistedState = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
  routes: GatewayRouteRecord[];
  pairs: GatewayPairRecord[];
  connectors: ConnectorRecord[];
  queue: QueuedMessageMetadata[];
  inFlight: InFlightMessageMetadata[];
  events: NormalizedMessageEvent[];
  dedupe: DedupeRecord[];
  rateBuckets: RateBucket[];
  accounting: GatewayAccounting;
  watchSequence: number;
  progressWatches: ProgressWatchMachine[];
  progressWatchEvents: ProgressWatchJournalEvent[];
  /** Bounded, body-free probe evidence keyed by provider surface and version. */
  compatibilityAttestations: CompatibilityAttestation[];
  /** Monotonic sequence for the bounded private endpoint-refresh journal. */
  codexEndpointRefreshSequence: number;
  /** Strictly private route-lifecycle evidence; never publicly projected. */
  codexEndpointRefreshEvents: CodexEndpointRefreshJournalEvent[];
  /** Monotonic sequence for bounded private operator-recovery evidence. */
  codexOrphanRemovalSequence: number;
  /** Strictly private orphan-removal evidence; never publicly projected. */
  codexOrphanRemovalEvents: CodexOrphanRemovalJournalEvent[];
  /** Strictly validated internal restart journal; never publicly projected. */
  codexSuccession?: unknown;
};

export type PublicRouteSnapshot = {
  alias: string;
  provider: GatewayProvider;
  host: string;
  enabled: boolean;
  state: RouteState;
  compatibility: CompatibilityState;
  busyPolicy: BusyPolicy;
  lastSeenAt?: string;
  queueDepth: number;
  /** Earliest enqueue time for this route's current queue, if non-empty. */
  oldestQueuedAt?: string;
  counters: RouteCounters;
  safeErrorCode?: string;
};

/** Metadata-only public consent edge. Private route authority is omitted. */
export type PublicPairSnapshot = {
  claudeAlias: string;
  codexAlias: string;
  host: string;
  counters: RouteCounters;
};

export type PublicConnectorSnapshot = {
  provider: GatewayProvider;
  host: string;
  health: ConnectorHealth;
  compatibility: CompatibilityState;
  protocol: string;
  protocolVersion: string;
  lastSeenAt?: string;
  safeErrorCode?: string;
};

export const publicAvailablePeerStates = [
  "idle",
  "busy",
  "awaiting_approval",
  "offline",
  "incompatible",
] as const;

export type PublicAvailablePeerState =
  (typeof publicAvailablePeerStates)[number];

/**
 * A transient, metadata-only discovery row. Native provider IDs, process
 * identifiers, registry/socket paths, and generations are deliberately absent.
 * Version 1 uses this for genuine Claude peers; Codex inventory remains the
 * explicit PublicRouteSnapshot list.
 */
export type PublicAvailablePeerSnapshot = {
  alias: string;
  provider: GatewayProvider;
  host: string;
  state: PublicAvailablePeerState;
  compatibility: CompatibilityState;
  /** True only when this row passed the provider's strict selectable-peer checks. */
  validated: boolean;
  selected: boolean;
  lastSeenAt?: string;
  safeErrorCode?: string;
};

export const gatewayActivityKinds = [
  "discovery",
  "selection",
  "registration",
  "pairing",
  "watch",
  "endpoint",
  "recovery",
] as const;
export type GatewayActivityKind = (typeof gatewayActivityKinds)[number];

export const gatewayActivityActions = [
  "discovery_refreshed",
  "claude_selected",
  "claude_unselected",
  "codex_registered",
  "codex_succeeded",
  "codex_unregistered",
  "routes_paired",
  "routes_unpaired",
  "watch_ended",
  "endpoint_refreshed",
  "codex_orphan_removed",
] as const;
export type GatewayActivityAction = (typeof gatewayActivityActions)[number];

/** Bounded, body-free operator activity retained for this broker process. */
export type PublicGatewayActivityEvent = {
  sequence: number;
  timestamp: string;
  kind: GatewayActivityKind;
  action: GatewayActivityAction;
  outcome: "accepted" | "rejected";
  aliases: string[];
  operatorAction: boolean;
  safeErrorCode?: string;
};

export const deadlinePressureBucketNames = [
  "under_1m",
  "1m_to_5m",
  "5m_to_15m",
  "15m_to_60m",
  "over_60m",
] as const;
export type DeadlinePressureBucketName =
  (typeof deadlinePressureBucketNames)[number];
export type DeadlinePressureBucket = {
  bucket: DeadlinePressureBucketName;
  settled: number;
  expired: number;
};

/** Counts are computed only from the bounded retained delivery ledger. */
export type DeadlinePressureSnapshot = {
  configuredDeadlineMs: number;
  retainedSince?: string;
  terminalEvents: number;
  expiredEvents: number;
  buckets: DeadlinePressureBucket[];
};

const PUBLIC_ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PUBLIC_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PUBLIC_SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Strict closed-schema guard for runtime-supplied transient inventory rows. */
export function isPublicAvailablePeerSnapshot(
  value: unknown,
): value is PublicAvailablePeerSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const required = [
    "alias",
    "provider",
    "host",
    "state",
    "compatibility",
    "validated",
    "selected",
  ];
  const optional = ["lastSeenAt", "safeErrorCode"];
  const keys = Object.keys(candidate);
  if (
    !required.every((key) => Object.hasOwn(candidate, key)) ||
    !keys.every((key) => required.includes(key) || optional.includes(key))
  ) {
    return false;
  }
  if (
    typeof candidate.alias !== "string" ||
    !PUBLIC_ALIAS_PATTERN.test(candidate.alias) ||
    typeof candidate.host !== "string" ||
    !PUBLIC_HOST_PATTERN.test(candidate.host) ||
    !candidate.alias.endsWith(`@${candidate.host}`) ||
    candidate.provider !== "claude" ||
    typeof candidate.state !== "string" ||
    !(publicAvailablePeerStates as readonly string[]).includes(candidate.state) ||
    typeof candidate.compatibility !== "string" ||
    !(compatibilityStates as readonly string[]).includes(
      candidate.compatibility,
    ) ||
    typeof candidate.validated !== "boolean" ||
    typeof candidate.selected !== "boolean"
  ) {
    return false;
  }
  if (
    candidate.lastSeenAt !== undefined &&
    (typeof candidate.lastSeenAt !== "string" ||
      candidate.lastSeenAt.length < 20 ||
      candidate.lastSeenAt.length > 35 ||
      !Number.isFinite(Date.parse(candidate.lastSeenAt)))
  ) {
    return false;
  }
  return (
    candidate.safeErrorCode === undefined ||
    (typeof candidate.safeErrorCode === "string" &&
      PUBLIC_SAFE_CODE_PATTERN.test(candidate.safeErrorCode))
  );
}

export function arePublicAvailablePeerSnapshots(
  value: unknown,
  maximumRows: number = gatewayPublicSnapshotLimits.availablePeers,
): value is PublicAvailablePeerSnapshot[] {
  if (
    !Array.isArray(value) ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 0 ||
    value.length > maximumRows ||
    !value.every(isPublicAvailablePeerSnapshot)
  ) {
    return false;
  }
  const aliases = value.map((peer) => `${peer.provider}\0${peer.alias}`);
  return new Set(aliases).size === aliases.length;
}

export type SafeGatewayAlert = {
  code: string;
  severity: AlertSeverity;
  timestamp: string;
  provider?: GatewayProvider;
  host?: string;
  alias?: string;
};

export type PublicProgressWatchSnapshot = {
  conversationIdSuffix: string;
  ownerAlias: string;
  workerAlias: string;
  phase: "quiet" | "episode";
  capability: "conversation" | "route";
  lastActivityAt: string;
  nextActionAt: string;
  idleMs: number;
  nudgeCount: 0 | 1 | 2;
  workerReportedComplete: boolean;
};

export type PublicProgressWatchEventSnapshot = {
  sequence: number;
  timestamp: string;
  conversationIdSuffix: string;
  ownerAlias: string;
  workerAlias: string;
  kind:
    | "opened"
    | "nudge"
    | "worker_reported_complete"
    | "capability_degraded"
    | "done"
    | "unresponsive"
    | "endpoint_retired"
    | "disabled";
  nudgeNumber?: 1 | 2;
};

export type GatewayPublicSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  /** Launch-time Claude-to-Codex consent policy; paired is the safe default. */
  inboundMode: GatewayInboundMode;
  health: ConnectorHealth;
  connectors: PublicConnectorSnapshot[];
  compatibilityChecks?: CompatibilityAttestation[];
  availablePeers: PublicAvailablePeerSnapshot[];
  routes: PublicRouteSnapshot[];
  pairs: PublicPairSnapshot[];
  progressWatches?: PublicProgressWatchSnapshot[];
  progressWatchEvents?: PublicProgressWatchEventSnapshot[];
  activityEvents?: PublicGatewayActivityEvent[];
  deadlinePressure?: DeadlinePressureSnapshot;
  messages: NormalizedMessageEvent[];
  accounting: GatewayAccounting;
  alerts: SafeGatewayAlert[];
  truncation: GatewaySnapshotTruncation;
};

export type GatewaySnapshotTruncation = {
  connectors: number;
  compatibilityChecks?: number;
  availablePeers: number;
  routes: number;
  pairs: number;
  progressWatches?: number;
  progressWatchEvents?: number;
  activityEvents?: number;
  messages: number;
  alerts: number;
};

function severityPriority(severity: AlertSeverity): number {
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function routePriority(state: RouteState): number {
  if (state === "busy" || state === "awaiting_approval") return 0;
  if (state === "idle") return 1;
  if (state === "offline" || state === "incompatible") return 2;
  if (state === "stale") return 3;
  return 4;
}

function connectorPriority(health: ConnectorHealth): number {
  if (health === "healthy" || health === "connecting") return 0;
  if (health === "degraded") return 1;
  if (health === "incompatible") return 2;
  return 3;
}

function peerPriority(state: PublicAvailablePeerState): number {
  if (state === "busy" || state === "awaiting_approval") return 0;
  if (state === "idle") return 1;
  if (state === "incompatible") return 2;
  return 3;
}

function snapshotBytes(snapshot: GatewayPublicSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/**
 * Deterministically projects a canonical snapshot under the local control
 * byte budget. Content is never shortened: complete metadata rows are either
 * retained or counted as omitted. Connector/selected-route inventory is the
 * last category removed.
 */
export function projectGatewayPublicSnapshot(
  snapshot: GatewayPublicSnapshot,
  maximumBytes: number = GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
): GatewayPublicSnapshot {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1_024 ||
    maximumBytes > GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET
  ) {
    throw new RangeError("INVALID_GATEWAY_SNAPSHOT_BYTE_BUDGET");
  }
  const projected: GatewayPublicSnapshot = {
    ...snapshot,
    connectors: snapshot.connectors.slice(0, gatewayPublicSnapshotLimits.connectors),
    ...(snapshot.compatibilityChecks === undefined
      ? {}
      : {
          compatibilityChecks: snapshot.compatibilityChecks.slice(
            0,
            gatewayPublicSnapshotLimits.compatibilityChecks,
          ),
        }),
    availablePeers: snapshot.availablePeers.slice(
      0,
      gatewayPublicSnapshotLimits.availablePeers,
    ),
    routes: snapshot.routes.slice(0, gatewayPublicSnapshotLimits.routes),
    pairs: snapshot.pairs.slice(0, gatewayPublicSnapshotLimits.pairs),
    ...(snapshot.progressWatches === undefined
      ? {}
      : {
          progressWatches: snapshot.progressWatches.slice(
            0,
            gatewayPublicSnapshotLimits.progressWatches,
          ),
        }),
    ...(snapshot.progressWatchEvents === undefined
      ? {}
      : {
          progressWatchEvents: snapshot.progressWatchEvents.slice(
            -gatewayPublicSnapshotLimits.progressWatchEvents,
          ),
        }),
    ...(snapshot.activityEvents === undefined
      ? {}
      : {
          activityEvents: snapshot.activityEvents.slice(
            -gatewayPublicSnapshotLimits.activityEvents,
          ),
        }),
    messages: snapshot.messages.slice(-gatewayPublicSnapshotLimits.messages),
    alerts: snapshot.alerts.slice(-gatewayPublicSnapshotLimits.alerts),
    accounting: { ...snapshot.accounting },
    truncation: {
      connectors:
        snapshot.truncation.connectors +
        Math.max(0, snapshot.connectors.length - gatewayPublicSnapshotLimits.connectors),
      ...(snapshot.compatibilityChecks === undefined
        ? {}
        : {
            compatibilityChecks:
              (snapshot.truncation.compatibilityChecks ?? 0) +
              Math.max(
                0,
                snapshot.compatibilityChecks.length -
                  gatewayPublicSnapshotLimits.compatibilityChecks,
              ),
          }),
      availablePeers:
        snapshot.truncation.availablePeers +
        Math.max(
          0,
          snapshot.availablePeers.length - gatewayPublicSnapshotLimits.availablePeers,
        ),
      routes:
        snapshot.truncation.routes +
        Math.max(0, snapshot.routes.length - gatewayPublicSnapshotLimits.routes),
      pairs:
        snapshot.truncation.pairs +
        Math.max(0, snapshot.pairs.length - gatewayPublicSnapshotLimits.pairs),
      ...(snapshot.progressWatches === undefined
        ? {}
        : {
            progressWatches:
              (snapshot.truncation.progressWatches ?? 0) +
              Math.max(
                0,
                snapshot.progressWatches.length -
                  gatewayPublicSnapshotLimits.progressWatches,
              ),
          }),
      ...(snapshot.progressWatchEvents === undefined
        ? {}
        : {
            progressWatchEvents:
              (snapshot.truncation.progressWatchEvents ?? 0) +
              Math.max(
                0,
                snapshot.progressWatchEvents.length -
                  gatewayPublicSnapshotLimits.progressWatchEvents,
              ),
          }),
      ...(snapshot.activityEvents === undefined
        ? {}
        : {
            activityEvents:
              (snapshot.truncation.activityEvents ?? 0) +
              Math.max(
                0,
                snapshot.activityEvents.length -
                  gatewayPublicSnapshotLimits.activityEvents,
              ),
          }),
      messages:
        snapshot.truncation.messages +
        Math.max(0, snapshot.messages.length - gatewayPublicSnapshotLimits.messages),
      alerts:
        snapshot.truncation.alerts +
        Math.max(0, snapshot.alerts.length - gatewayPublicSnapshotLimits.alerts),
    },
  };
  if (snapshotBytes(projected) <= maximumBytes) return projected;

  const retainUntilFit = (
    rowCount: number,
    applyRetainedCount: (retained: number) => void,
  ): boolean => {
    let lower = 0;
    let upper = rowCount;
    let best = -1;
    while (lower <= upper) {
      const candidate = Math.floor((lower + upper) / 2);
      applyRetainedCount(candidate);
      if (snapshotBytes(projected) <= maximumBytes) {
        best = candidate;
        lower = candidate + 1;
      } else {
        upper = candidate - 1;
      }
    }
    if (best >= 0) {
      applyRetainedCount(best);
      return true;
    }
    applyRetainedCount(0);
    return false;
  };

  const watchEvents = projected.progressWatchEvents ?? [];
  const watchEventOmissions = projected.truncation.progressWatchEvents ?? 0;
  if (
    watchEvents.length > 0 &&
    retainUntilFit(watchEvents.length, (retained) => {
      projected.progressWatchEvents =
        retained === 0 ? [] : watchEvents.slice(-retained);
      projected.truncation.progressWatchEvents =
        watchEventOmissions + watchEvents.length - retained;
    })
  ) {
    return projected;
  }

  const activityEvents = projected.activityEvents ?? [];
  const activityEventOmissions = projected.truncation.activityEvents ?? 0;
  if (
    activityEvents.length > 0 &&
    retainUntilFit(activityEvents.length, (retained) => {
      projected.activityEvents =
        retained === 0 ? [] : activityEvents.slice(-retained);
      projected.truncation.activityEvents =
        activityEventOmissions + activityEvents.length - retained;
    })
  ) {
    return projected;
  }

  const messages = projected.messages;
  const messageOmissions = projected.truncation.messages;
  if (
    retainUntilFit(messages.length, (retained) => {
      projected.messages = retained === 0 ? [] : messages.slice(-retained);
      projected.truncation.messages =
        messageOmissions + messages.length - retained;
    })
  ) {
    return projected;
  }

  const peers = [...projected.availablePeers].sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    const byState = peerPriority(left.state) - peerPriority(right.state);
    if (byState !== 0) return byState;
    const bySeen = (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "");
    return bySeen || left.alias.localeCompare(right.alias);
  });
  const peerOmissions = projected.truncation.availablePeers;
  if (
    retainUntilFit(peers.length, (retained) => {
      projected.availablePeers = peers.slice(0, retained);
      projected.truncation.availablePeers =
        peerOmissions + peers.length - retained;
    })
  ) {
    return projected;
  }

  const alerts = [...projected.alerts].sort((left, right) => {
    const bySeverity =
      severityPriority(left.severity) - severityPriority(right.severity);
    if (bySeverity !== 0) return bySeverity;
    const byTime = right.timestamp.localeCompare(left.timestamp);
    return byTime || left.code.localeCompare(right.code);
  });
  const alertOmissions = projected.truncation.alerts;
  if (
    retainUntilFit(alerts.length, (retained) => {
      projected.alerts = alerts.slice(0, retained);
      projected.truncation.alerts =
        alertOmissions + alerts.length - retained;
    })
  ) {
    return projected;
  }

  const routes = [...projected.routes].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    const byState = routePriority(left.state) - routePriority(right.state);
    if (byState !== 0) return byState;
    return left.alias.localeCompare(right.alias);
  });
  const routeOmissions = projected.truncation.routes;
  const pairs = [...projected.pairs].sort((left, right) =>
    `${left.claudeAlias}\0${left.codexAlias}`.localeCompare(
      `${right.claudeAlias}\0${right.codexAlias}`,
    ),
  );
  const pairOmissions = projected.truncation.pairs;
  if (
    retainUntilFit(pairs.length, (retained) => {
      projected.pairs = pairs.slice(0, retained);
      projected.truncation.pairs = pairOmissions + pairs.length - retained;
    })
  ) {
    return projected;
  }

  if (
    retainUntilFit(routes.length, (retained) => {
      projected.routes = routes.slice(0, retained);
      projected.truncation.routes = routeOmissions + routes.length - retained;
    })
  ) {
    return projected;
  }

  const connectors = [...projected.connectors].sort((left, right) => {
    const byHealth =
      connectorPriority(left.health) - connectorPriority(right.health);
    if (byHealth !== 0) return byHealth;
    return `${left.provider}\0${left.host}`.localeCompare(
      `${right.provider}\0${right.host}`,
    );
  });
  const connectorOmissions = projected.truncation.connectors;
  if (
    retainUntilFit(connectors.length, (retained) => {
      projected.connectors = connectors.slice(0, retained);
      projected.truncation.connectors =
        connectorOmissions + connectors.length - retained;
    })
  ) {
    return projected;
  }
  throw new RangeError("GATEWAY_SNAPSHOT_BASE_EXCEEDS_BYTE_BUDGET");
}

export type RegisterRouteInput = {
  alias: string;
  binding: PrivateRouteBinding;
  registrationMode: RouteRegistrationMode;
  state?: "idle" | "busy" | "awaiting_approval";
  compatibility?: "compatible";
};

export type ObserveConnectorInput = {
  identity: PrivateEndpointIdentity;
  health: Exclude<ConnectorHealth, "offline">;
  compatibility: CompatibilityState;
  protocol: string;
  protocolVersion: string;
  safeErrorCode?: string;
};

export type ObserveRouteInput =
  | {
      binding: PrivateRouteBinding;
      state: "idle" | "busy" | "awaiting_approval";
      compatibility: "compatible";
      safeErrorCode?: string;
    }
  | {
      binding: PrivateRouteBinding;
      state: "stale";
      compatibility: "expired";
      safeErrorCode: string;
    };

export type RebindStaleRouteInput = {
  /** The currently persisted alias. */
  alias: string;
  /** The provider's latest live display name for the same logical route. */
  newAlias?: string;
  currentOwnerLease: string;
  newBinding: PrivateRouteBinding;
  reason:
    | "endpoint_reobserved"
    | "peer_explicitly_reselected"
    | "peer_identity_reobserved";
  /** Append exact private boot-recovery evidence in the refresh journal. */
  journalReason?: "boot_reactivation";
  state?: "idle" | "busy" | "awaiting_approval";
};

export type ReanchorCodexRouteInput = {
  alias: string;
  /** Exact private App Server thread identifier proved present by loaded/list. */
  threadId: string;
  /** Existing registration authority; a refresh never rotates this lease. */
  ownerLease: string;
  state?: "idle" | "busy" | "awaiting_approval";
};

export type ReanchorCodexRoutesInput = {
  oldEndpoint: PrivateEndpointIdentity;
  newEndpoint: PrivateEndpointIdentity;
  /** Only the exact loaded/list-present subset is named here. */
  routes: readonly ReanchorCodexRouteInput[];
};

export type ReanchorCodexRoutesResult = {
  reboundAliases: string[];
};

export type RemoveStaleCodexOrphanInput = {
  /** Dashboard-confirmed exact public alias; no native identifier is accepted. */
  alias: string;
};

export type StaleCodexOrphanRemovalAuthority = {
  binding: PrivateRouteBinding;
  previousSequence: number;
};

export type StaleCodexOrphanRemovalCommitProofInput = {
  alias: string;
  binding: PrivateRouteBinding;
  previousSequence: number;
};

export type RemoveStaleCodexOrphanResult = {
  alias: string;
  /** Private result used only to reconcile in-process service bindings. */
  binding: PrivateRouteBinding;
  removedPairs: Array<{
    claudeAlias: string;
    codexAlias: string;
  }>;
};

export type EnqueueMessageInput = {
  sourceAlias: string;
  targetAlias: string;
  body: string;
  dedupeKey: string;
  /** Last eight opaque characters of the controller-owned conversation ID. */
  conversationIdSuffix?: string;
  deadlineAt?: string;
  hopCount?: number;
  steer?: true;
  /**
   * Controller-derived watch intent committed in the same mutation as the
   * accepted message. Bodies and command flags are never persisted here.
   */
  progressWatch?: {
    conversationId: string;
    actorAlias: string;
    openIdleMs?: number;
    completionSignal?: true;
  };
  /** Controller-authored nudge committed atomically with its queued body. */
  progressWatchNudge?: {
    conversationId: string;
    nudgeNumber: 1 | 2;
  };
};

/**
 * Controller-internal proof of one currently observed native Claude peer.
 * The binding may contain a native session identifier and must remain an
 * in-memory call argument. Store metadata retains only the public alias.
 */
export type TransientNativeClaudePeer = {
  alias: string;
  binding: PrivateRouteBinding;
};

export type EnqueueNativeIngressInput = Omit<
  EnqueueMessageInput,
  "sourceAlias" | "targetAlias"
> & {
  source: TransientNativeClaudePeer;
  targetAlias: string;
  /** Pre-deadline reply evidence retained across exact pair teardown. */
  authorizedPairTeardownReply?: true;
};

export type EnqueueNativeReplyInput = Omit<
  EnqueueMessageInput,
  "sourceAlias" | "targetAlias"
> & {
  sourceAlias: string;
  target: TransientNativeClaudePeer;
  /** Retain the original paired admission authority, when one existed. */
  pair?: true;
};

export type EnqueueMessageResult = {
  accepted: boolean;
  duplicate: boolean;
  messageId?: string;
  messageIdSuffix: string;
  /** The accepted message is owned by one exact consent edge. */
  pair?: true;
  /** Exact older queued steer displaced by the per-edge cap, if any. */
  supersededSettlement?: TerminalMessageSettlement;
};

export type InFlightMessageProgressState = Extract<
  DeliveryState,
  "transport_written" | "held"
>;

export type SettleMessageInput = {
  messageId: string;
  state: Extract<
    DeliveryState,
    | "delivered"
    | "unconfirmed"
    | "failed"
    | "ambiguous"
    | "expired"
    | "cancelled"
  >;
  safeErrorCode?: string;
};

/**
 * Controller-internal proof that one message won its terminal-state race.
 * Full message IDs are required only for in-memory service correlation; this
 * structure must never enter a public snapshot or persisted event.
 */
export type TerminalMessageSettlement = {
  messageId: string;
  state: Extract<
    DeliveryState,
    | "delivered"
    | "unconfirmed"
    | "failed"
    | "ambiguous"
    | "expired"
    | "cancelled"
    | "abandoned"
  >;
  safeErrorCode?: string;
};

export type SettleMessageResult =
  | {
      status: "settled";
      settlement: TerminalMessageSettlement;
    }
  | {
      status: "not_in_flight";
    };

export type RequeueInFlightMessageResult =
  | {
      status: "requeued";
    }
  | {
      status: "settled";
      settlement: TerminalMessageSettlement;
    }
  | {
      status: "not_in_flight";
    };

export type GatewayStoreLimits = {
  maxRoutes: number;
  maxPairs: number;
  /** Omitted injected-test configs use the production default of 32. */
  maxWatches?: number;
  eventCapacity: number;
  eventTtlMs: number;
  dedupeCapacity: number;
  dedupeTtlMs: number;
  maxQueueMessages: number;
  maxQueueMessagesPerRoute: number;
  maxInFlightMessages: number;
  maxQueueBytes: number;
  maxMessageBytes: number;
  /** Bounded historical event-body bytes; omitted configs use 1 MiB. */
  maxRetainedBodyBytes?: number;
  messageDeadlineMs: number;
  maxHopCount: number;
  rateLimitPerRoute: number;
  rateWindowMs: number;
};

export type GatewayStoreDependencies = {
  now?: () => Date;
  randomId?: () => string;
  /** Deterministic durability-fault seam; production callers leave this unset. */
  afterStateFileRename?: () => void | Promise<void>;
};
