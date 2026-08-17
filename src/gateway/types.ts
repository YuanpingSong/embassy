export const gatewayProviders = ["claude", "codex", "deepseek", "grok"] as const;

export type GatewayProvider = (typeof gatewayProviders)[number];

export const gatewayProviderDisplayNames = Object.freeze({ claude: "Claude", codex: "Codex", deepseek: "DeepSeek", grok: "Grok Build" } satisfies Readonly<Record<GatewayProvider, string>>);

/** Registration syntax only; route bindings, never prefixes, prove providers. */
export const gatewayRegistrationIngressPrefixes = Object.freeze({ claude: undefined, codex: "codex-", deepseek: "dsh-", grok: "grok-" } satisfies Readonly<Record<GatewayProvider, string | undefined>>);

export const gatewayInboundModes = ["paired", "open"] as const;

export type GatewayInboundMode = (typeof gatewayInboundModes)[number];

export const connectorHealthStates = [
  "offline",
  "connecting",
  "healthy",
  "degraded",
] as const;

export type ConnectorHealth = (typeof connectorHealthStates)[number];

export const routeStates = [
  "stale",
  "idle",
  "busy",
  "awaiting_approval",
  "offline",
  "disabled",
] as const;

export type RouteState = (typeof routeStates)[number];

export const routeRegistrationModes = [
  "explicit_opt_in",
  "selected_live_peer",
] as const;

export type RouteRegistrationMode =
  (typeof routeRegistrationModes)[number];

export type MessageDirection = { [Source in GatewayProvider]: `${Source}_to_${Exclude<GatewayProvider, Source>}` }[GatewayProvider];

export type ParsedMessageDirection = Readonly<{ sourceProvider: GatewayProvider; targetProvider: GatewayProvider }>;

export const isGatewayProvider = (value: unknown): value is GatewayProvider =>
  typeof value === "string" && (gatewayProviders as readonly string[]).includes(value);

export function directionId(
  sourceProvider: GatewayProvider,
  targetProvider: GatewayProvider,
): MessageDirection {
  if (sourceProvider === targetProvider) {
    throw new RangeError("SAME_PROVIDER_DIRECTION");
  }
  return `${sourceProvider}_to_${targetProvider}` as MessageDirection;
}

export const messageDirections = Object.freeze(gatewayProviders.flatMap(
  (sourceProvider) => gatewayProviders.filter((targetProvider) => targetProvider !== sourceProvider)
    .map((targetProvider) => directionId(sourceProvider, targetProvider)),
)) as readonly MessageDirection[];

export function parseDirection(
  value: unknown,
): ParsedMessageDirection | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("_to_");
  if (separator < 1 || separator !== value.lastIndexOf("_to_")) {
    return undefined;
  }
  const sourceProvider = value.slice(0, separator);
  const targetProvider = value.slice(separator + 4);
  if (
    !isGatewayProvider(sourceProvider) ||
    !isGatewayProvider(targetProvider) ||
    sourceProvider === targetProvider
  ) {
    return undefined;
  }
  return { sourceProvider, targetProvider };
}

export const isMessageDirection = (value: unknown): value is MessageDirection =>
  parseDirection(value) !== undefined;

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
  registryRejectionCodes: 32,
  availablePeers: 256,
  routes: 256,
  consentEdges: 256,
  progressWatches: 64,
  progressWatchEvents: 256,
  activityEvents: 256,
  messages: 1_024,
  alerts: 256,
} as const);

/** Leaves headroom for the private control protocol response envelope. */
export const GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET = 240 * 1024;

/**
 * Durable logical registration. Provider endpoint generations are deliberately
 * absent: they are operation-local evidence and never routing authority.
 */
export type LogicalRouteBinding = {
  provider: GatewayProvider;
  hostId: string;
  routeHandle: string;
  registrationId: string;
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
  binding: LogicalRouteBinding;
  registrationMode: RouteRegistrationMode;
  enabled: boolean;
  busyPolicy: BusyPolicy;
  registeredAt: string;
  updatedAt: string;
  counters: RouteCounters;
};

/**
 * Durable bidirectional consent between two exact route owners. Aliases are
 * display coordinates; the private leases prevent an alias from silently
 * retargeting an existing permission edge.
 */
export type GatewayConsentEndpoint = Readonly<{
  alias: string;
  provider: GatewayProvider;
  registrationId: string;
}>;

export type GatewayConsentEdgeRecord = {
  /** Canonical order: provider order first, then alias. */
  endpoints: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint];
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
  binding: LogicalRouteBinding;
  registrationMode: RouteRegistrationMode;
  enabled: boolean;
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

export type GatewayPreparedWriteEvidence = {
  kind:
    | "claude_mailbox"
    | "codex_turn_start"
    | "codex_turn_steer"
    | "acp_prompt";
  bodyBytes: number;
  bodySha256: string;
  frameBytes: number;
  sha256: string;
};

export type GatewayMessageAttemptAuthority = {
  attemptId: string;
  attemptCount: number;
  targetRegistrationId: string;
  /** Null is allowed only for admitted open-mode native Claude ingress. */
  sourceRegistrationId: string | null;
  /** Exact canonical consent endpoints captured at reservation. */
  consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
};

export type GatewayMessageState =
  | { phase: "queued"; attemptCount: number }
  | (GatewayMessageAttemptAuthority & {
      phase: "reserved";
      reservedAt: string;
    })
  | (GatewayMessageAttemptAuthority & {
      phase: "armed";
      armedAt: string;
      prepared: GatewayPreparedWriteEvidence;
    })
  | (GatewayMessageAttemptAuthority & {
      phase: "accepted";
      acceptedAt: string;
      prepared: GatewayPreparedWriteEvidence;
      lossOutcome: "unconfirmed" | "ambiguous";
    })
  | {
      phase: "terminal";
      outcome: Extract<
        DeliveryState,
        | "delivered"
        | "unconfirmed"
        | "failed"
        | "ambiguous"
        | "expired"
        | "cancelled"
        | "abandoned"
      >;
      terminalAt: string;
      safeErrorCode?: string;
      latencyMs: number;
    };

export type GatewayMessageRecord = QueuedMessageMetadata & {
  /** Latest durable transition sequence for deterministic public projection. */
  sequence: number;
  /** Bounded opaque status capability; absent for non-CLI provider ingress. */
  deliveryToken?: string;
  /** Exact admitted logical authority; never derived again from alias text. */
  sourceRegistrationId: string | null;
  /** Null is valid only after terminalizing a v2 transient-target row. */
  targetRegistrationId: string | null;
  consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
  state: GatewayMessageState;
};

/** Suffix-only v2 history is non-authoritative and can never be correlated. */
export type GatewayLegacyMessageActivity = {
  type: "legacy_message";
  event: NormalizedMessageEvent;
};

export type GatewayRuntimeActivity = {
  type: "activity";
  event: PublicGatewayActivityEvent;
};

export type GatewayStateActivity =
  | GatewayLegacyMessageActivity
  | GatewayRuntimeActivity;

export type GatewayPersistedState = {
  schemaVersion: 3;
  commit: { sequence: number; id: string };
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
  routes: GatewayRouteRecord[];
  consentEdges: GatewayConsentEdgeRecord[];
  messages: GatewayMessageRecord[];
  dedupe: DedupeRecord[];
  rateBuckets: RateBucket[];
  /** Bounded, non-authoritative suffix-only history retained for v2 parity. */
  activity: GatewayStateActivity[];
  accounting: GatewayAccounting;
};

export type GatewayMessageRecordV3 = GatewayMessageRecord;
export type GatewayPersistedStateV3 = GatewayPersistedState;

export type PublicRouteSnapshot = {
  alias: string;
  provider: GatewayProvider;
  host: string;
  enabled: boolean;
  state: RouteState;
  busyPolicy: BusyPolicy;
  lastSeenAt?: string;
  queueDepth: number;
  /** Earliest enqueue time for this route's current queue, if non-empty. */
  oldestQueuedAt?: string;
  counters: RouteCounters;
  safeErrorCode?: string;
};

/** Metadata-only public consent edge. Private route authority is omitted. */
export type PublicConsentEndpointSnapshot = Readonly<{ alias: string; provider: GatewayProvider }>;

export type PublicConsentEdgeSnapshot = {
  /** Canonical order matching the private consent edge. */
  endpoints: readonly [PublicConsentEndpointSnapshot, PublicConsentEndpointSnapshot];
  host: string;
  counters: RouteCounters;
};

export type PublicConnectorSnapshot = {
  provider: GatewayProvider;
  host: string;
  health: ConnectorHealth;
  protocol: string;
  protocolVersion: string;
  lastSeenAt?: string;
  /** Age of the latest positive connector observation at snapshot generation. */
  observationAgeMs?: number;
  codexDoctor?: PublicCodexDoctorSnapshot;
  safeErrorCode?: string;
  registry?: PublicRegistryObservationSnapshot;
};

export type PublicCodexDoctorCondition =
  | "split_brain"
  | "orphaned"
  | "attached"
  | "observation_stale"
  | "unknown";

export type PublicCodexDoctorSnapshot = Readonly<{
  conditions: readonly PublicCodexDoctorCondition[];
}>;

/** A healthy connector must have positive observation evidence within this age. */
export const CONNECTOR_OBSERVATION_STALE_AFTER_MS = 35_000;

/**
 * Bounded, native-ID-free evidence attached to one Claude connector. Counts
 * describe only the latest pass; the monotonic flag distinguishes an ordinary
 * empty registry from one that has never yielded parseable required fields
 * this boot.
 */
export type PublicRegistryObservationSnapshot = {
  entriesScanned: number;
  parseableRecords: number;
  parseableRecordSeenSinceBoot: boolean;
  rejected: { safeErrorCode: string; count: number }[];
  rejectedCodesOmitted: number;
};

export const publicAvailablePeerStates = [
  "idle",
  "busy",
  "awaiting_approval",
  "offline",
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

export function isPublicRegistryObservationSnapshot(
  value: unknown,
): value is PublicRegistryObservationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 5 ||
    ![
      "entriesScanned",
      "parseableRecords",
      "parseableRecordSeenSinceBoot",
      "rejected",
      "rejectedCodesOmitted",
    ].every((key) => Object.hasOwn(candidate, key)) ||
    !Number.isSafeInteger(candidate.entriesScanned) ||
    Number(candidate.entriesScanned) < 0 ||
    !Number.isSafeInteger(candidate.parseableRecords) ||
    Number(candidate.parseableRecords) < 0 ||
    Number(candidate.parseableRecords) > Number(candidate.entriesScanned) ||
    typeof candidate.parseableRecordSeenSinceBoot !== "boolean" ||
    (Number(candidate.parseableRecords) > 0 &&
      candidate.parseableRecordSeenSinceBoot !== true) ||
    !Number.isSafeInteger(candidate.rejectedCodesOmitted) ||
    Number(candidate.rejectedCodesOmitted) < 0 ||
    !Array.isArray(candidate.rejected) ||
    candidate.rejected.length > gatewayPublicSnapshotLimits.registryRejectionCodes
  ) {
    return false;
  }
  const rejected = candidate.rejected as unknown[];
  if (
    !rejected.every((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const record = row as Record<string, unknown>;
      return (
        Object.keys(record).length === 2 &&
        Object.hasOwn(record, "safeErrorCode") &&
        Object.hasOwn(record, "count") &&
        typeof record.safeErrorCode === "string" &&
        PUBLIC_SAFE_CODE_PATTERN.test(record.safeErrorCode) &&
        Number.isSafeInteger(record.count) &&
        Number(record.count) > 0
      );
    })
  ) {
    return false;
  }
  const codes = rejected.map(
    (row) => (row as { safeErrorCode: string }).safeErrorCode,
  );
  return codes.every(
    (code, index) => index === 0 || codes[index - 1]! < code,
  );
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
  lastActivityAt: string;
  nextActionAt: string;
  nudgeCount: 0 | 1 | 2;
};

export type PublicProgressWatchEventSnapshot = {
  sequence: number;
  timestamp: string;
  conversationIdSuffix: string;
  ownerAlias: string;
  workerAlias: string;
  kind: "opened" | "replaced" | "settled";
  actor: "owner" | "worker" | "operator" | "gateway" | "unknown";
  reason?:
    | "done"
    | "untracked"
    | "idle_timeout"
    | "pair_removed"
    | "endpoint_retired"
    | "tracking_disabled";
};

export type GatewayPublicSnapshot = {
  schemaVersion: 2;
  generatedAt: string;
  /** Launch-time Claude-to-Codex consent policy; paired is the safe default. */
  inboundMode: GatewayInboundMode;
  health: ConnectorHealth;
  connectors: PublicConnectorSnapshot[];
  availablePeers: PublicAvailablePeerSnapshot[];
  routes: PublicRouteSnapshot[];
  consentEdges: PublicConsentEdgeSnapshot[];
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
  availablePeers: number;
  routes: number;
  consentEdges: number;
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
  if (state === "offline") return 2;
  if (state === "stale") return 3;
  return 4;
}

function connectorPriority(health: ConnectorHealth): number {
  if (health === "healthy" || health === "connecting") return 0;
  if (health === "degraded") return 1;
  return 2;
}

function peerPriority(state: PublicAvailablePeerState): number {
  if (state === "busy" || state === "awaiting_approval") return 0;
  if (state === "idle") return 1;
  return 2;
}

function snapshotBytes(snapshot: GatewayPublicSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/**
 * Deterministically projects a canonical snapshot under the local control
 * byte budget. Content is never shortened: complete metadata rows are either
 * retained or counted as omitted. Registry rejection-code detail is shed
 * before consent edges or selected routes; connector inventory remains last.
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
    connectors: snapshot.connectors
      .slice(0, gatewayPublicSnapshotLimits.connectors)
      .map((connector) => ({
        ...connector,
        ...(connector.registry === undefined
          ? {}
          : {
              registry: {
                ...connector.registry,
                rejected: connector.registry.rejected.map((row) => ({
                  ...row,
                })),
              },
            }),
      })),
    availablePeers: snapshot.availablePeers.slice(
      0,
      gatewayPublicSnapshotLimits.availablePeers,
    ),
    routes: snapshot.routes.slice(0, gatewayPublicSnapshotLimits.routes),
    consentEdges: snapshot.consentEdges.slice(
      0,
      gatewayPublicSnapshotLimits.consentEdges,
    ),
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
      availablePeers:
        snapshot.truncation.availablePeers +
        Math.max(
          0,
          snapshot.availablePeers.length - gatewayPublicSnapshotLimits.availablePeers,
        ),
      routes:
        snapshot.truncation.routes +
        Math.max(0, snapshot.routes.length - gatewayPublicSnapshotLimits.routes),
      consentEdges:
        snapshot.truncation.consentEdges +
        Math.max(
          0,
          snapshot.consentEdges.length -
            gatewayPublicSnapshotLimits.consentEdges,
        ),
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

  const registryConnectorRows = projected.connectors;
  const registryRejectionRows = registryConnectorRows.reduce(
    (count, connector) => count + (connector.registry?.rejected.length ?? 0),
    0,
  );
  if (
    registryRejectionRows > 0 &&
    retainUntilFit(registryRejectionRows, (retained) => {
      let remaining = retained;
      projected.connectors = registryConnectorRows.map((connector) => {
        const registry = connector.registry;
        if (registry === undefined) return connector;
        const retainedHere = Math.min(remaining, registry.rejected.length);
        remaining -= retainedHere;
        return {
          ...connector,
          registry: {
            ...registry,
            rejected: registry.rejected.slice(0, retainedHere),
            rejectedCodesOmitted:
              registry.rejectedCodesOmitted +
              registry.rejected.length -
              retainedHere,
          },
        };
      });
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
  const consentEdges = [...projected.consentEdges].sort((left, right) =>
    left.endpoints
      .map((endpoint) => `${endpoint.provider}\0${endpoint.alias}`)
      .join("\0")
      .localeCompare(
        right.endpoints
          .map((endpoint) => `${endpoint.provider}\0${endpoint.alias}`)
          .join("\0"),
      ),
  );
  const consentEdgeOmissions = projected.truncation.consentEdges;
  if (
    retainUntilFit(consentEdges.length, (retained) => {
      projected.consentEdges = consentEdges.slice(0, retained);
      projected.truncation.consentEdges =
        consentEdgeOmissions + consentEdges.length - retained;
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
    const leftHasRegistryIssue =
      left.registry !== undefined &&
      (left.registry.rejected.length > 0 ||
        left.registry.rejectedCodesOmitted > 0 ||
        !left.registry.parseableRecordSeenSinceBoot);
    const rightHasRegistryIssue =
      right.registry !== undefined &&
      (right.registry.rejected.length > 0 ||
        right.registry.rejectedCodesOmitted > 0 ||
        !right.registry.parseableRecordSeenSinceBoot);
    if (leftHasRegistryIssue !== rightHasRegistryIssue) {
      return leftHasRegistryIssue ? -1 : 1;
    }
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
  binding: LogicalRouteBinding;
  registrationMode: RouteRegistrationMode;
};

export type GatewayReservedAttempt = Readonly<{
  messageId: string;
  attemptId: string;
  attemptCount: number;
  body: string;
  deadlineAt: string;
  direction: MessageDirection;
  sourceAlias: string;
  targetAlias: string;
  conversationIdSuffix?: string;
  sourceRegistrationId: string | null;
  targetRegistrationId: string;
  consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
  bytes: number;
  steer?: true;
}>;

export type ReserveMessageResult =
  | Readonly<{ status: "empty" }>
  | Readonly<{
      status: "terminal";
      settlement: TerminalMessageSettlement;
    }>
  | Readonly<{ status: "reserved"; attempt: GatewayReservedAttempt }>;

export type AuthorizeMessageInput = Readonly<{
  messageId: string;
  attemptId: string;
  sourceRegistrationId: string | null;
  targetRegistrationId: string;
  prepared: GatewayPreparedWriteEvidence;
}>;

export type AuthorizeMessageResult =
  | Readonly<{ status: "authorized" }>
  | Readonly<{
      status: "stale";
      reason:
        | "not_reserved"
        | "attempt_mismatch"
        | "registration_changed"
        | "consent_removed";
    }>
  | Readonly<{
      status: "terminal";
      reason: "expired" | "fenced";
      settlement: TerminalMessageSettlement;
    }>;

export type AcceptMessageInput = Readonly<{
  messageId: string;
  attemptId: string;
  lossOutcome: "unconfirmed" | "ambiguous";
}>;

export type AcceptMessageResult =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "stale" }>;

export type ResolvePrewriteAttemptInput = Readonly<{
  messageId: string;
  attemptId: string;
  outcome: "requeue" | "failed";
  safeErrorCode?: string;
}>;

export type ResolvePrewriteAttemptResult =
  | Readonly<{ status: "requeued" }>
  | Readonly<{
      status: "settled";
      settlement: TerminalMessageSettlement;
    }>
  | Readonly<{ status: "stale" }>;

export type SettleAttemptInput = Readonly<{
  messageId: string;
  attemptId: string;
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
}>;

export type SettleAttemptResult =
  | Readonly<{
      status: "settled";
      settlement: TerminalMessageSettlement;
    }>
  | Readonly<{ status: "stale" }>;

export type SettleAttemptForShutdownInput = Readonly<{
  messageId: string;
  attemptId: string;
}>;

export type SettleAttemptForShutdownResult =
  | Readonly<{ status: "requeued" }>
  | Readonly<{
      status: "settled";
      settlement: TerminalMessageSettlement;
    }>
  | Readonly<{ status: "stale" }>;

export type SettleQueuedMessageForShutdownInput = Readonly<{
  messageId: string;
}>;

export type SettleQueuedMessageForShutdownResult =
  | Readonly<{
      status: "settled";
      settlement: TerminalMessageSettlement;
    }>
  | Readonly<{ status: "stale" }>;

export type RemoveRouteAtomicResult = Readonly<{
  removed: boolean;
  settlements: readonly TerminalMessageSettlement[];
}>;

export type GatewayAtomicActivityInput = Readonly<{
  operatorAction: boolean;
}>;

export type RemoveRouteAtomicInput = Readonly<{
  alias: string;
  activity: GatewayAtomicActivityInput;
}>;

export type ReplaceCodexRegistrationAtomicInput = Readonly<{
  oldAlias: string;
  expectedOldRegistrationId: string;
  replacement: RegisterRouteInput;
  activity: GatewayAtomicActivityInput;
}>;

export type ReplaceCodexRegistrationAtomicResult = Readonly<{
  replaced: boolean;
  idempotent: boolean;
  settlements: readonly TerminalMessageSettlement[];
}>;

export type EnqueueMessageInput = {
  sourceAlias: string;
  targetAlias: string;
  expectedSourceRegistrationId?: string;
  expectedTargetRegistrationId?: string;
  body: string;
  dedupeKey: string;
  /** Last eight opaque characters of the controller-owned conversation ID. */
  conversationIdSuffix?: string;
  deadlineAt?: string;
  steer?: true;
};

/**
 * Controller-internal proof of one currently observed native Claude peer.
 * The binding may contain a native session identifier and must remain an
 * in-memory call argument. Store metadata retains only the public alias.
 */
export type TransientNativeClaudePeer = {
  alias: string;
  binding: LogicalRouteBinding;
};

export type EnqueueNativeIngressInput = Omit<
  EnqueueMessageInput,
  | "sourceAlias"
  | "targetAlias"
  | "expectedSourceRegistrationId"
  | "expectedTargetRegistrationId"
> & {
  source: TransientNativeClaudePeer;
  targetAlias: string;
  /** Exact target identity captured by the operation that owns this ingress. */
  expectedTargetRegistrationId: string;
  /** Pre-deadline reply evidence retained across exact pair teardown. */
  authorizedPairTeardownReply?: true;
};

export type EnqueueNativeReplyInput = Omit<
  EnqueueMessageInput,
  | "sourceAlias"
  | "targetAlias"
  | "expectedSourceRegistrationId"
  | "expectedTargetRegistrationId"
> & {
  sourceAlias: string;
  /** Exact source identity captured by the operation that owns this reply. */
  expectedSourceRegistrationId: string;
  target: TransientNativeClaudePeer;
  /** Retain the original paired admission authority, when one existed. */
  pair?: true;
  /** Explicit same-user reply commands receive durable status correlation. */
  exposeDeliveryToken?: true;
};

export type EnqueueMessageResult = {
  accepted: boolean;
  duplicate: boolean;
  messageId?: string;
  messageIdSuffix: string;
  deliveryToken?: string;
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
  maxConsentEdges: number;
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
  rateLimitPerRoute: number;
  rateWindowMs: number;
};

export type GatewayStoreDependencies = {
  now?: () => Date;
  randomId?: () => string;
  /** Deterministic rename-outcome seam; production callers leave this unset. */
  renameStateFile?: (source: string, target: string) => Promise<void>;
  /** Deterministic durability-fault seam; production callers leave this unset. */
  afterStateFileRename?: () => void | Promise<void>;
};
