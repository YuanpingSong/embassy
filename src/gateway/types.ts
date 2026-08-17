export const gatewayProviders = ["claude", "codex", "deepseek", "grok", "peer"] as const;
export type GatewayProvider = (typeof gatewayProviders)[number];
export const gatewayRegistrationIngressPrefixes = Object.freeze({ claude: undefined, codex: "codex-", deepseek: "dsh-", grok: "grok-", peer: "peer-" } satisfies Readonly<Record<GatewayProvider, string | undefined>>);
export const gatewayInboundModes = ["paired", "open"] as const;
export type GatewayInboundMode = (typeof gatewayInboundModes)[number];
export const connectorHealthStates = ["offline", "connecting", "healthy", "degraded"] as const;
export type ConnectorHealth = (typeof connectorHealthStates)[number];
export const routeStates = ["stale", "idle", "busy", "awaiting_approval", "offline", "disabled"] as const;
export type RouteState = (typeof routeStates)[number];
export const routeRegistrationModes = ["explicit_opt_in", "selected_live_peer", "federated_peer"] as const;
export type RouteRegistrationMode = (typeof routeRegistrationModes)[number];
export type MessageDirection = `${GatewayProvider}_to_${GatewayProvider}`;
export type ParsedMessageDirection = Readonly<{ sourceProvider: GatewayProvider; targetProvider: GatewayProvider }>;
export const isGatewayProvider = (value: unknown): value is GatewayProvider =>
  typeof value === "string" && (gatewayProviders as readonly string[]).includes(value);
export function directionId(sourceProvider: GatewayProvider, targetProvider: GatewayProvider): MessageDirection {
  return `${sourceProvider}_to_${targetProvider}` as MessageDirection;
}
export const messageDirections = Object.freeze(gatewayProviders.flatMap(
  (sourceProvider) => gatewayProviders.map((targetProvider) => directionId(sourceProvider, targetProvider)),
)) as readonly MessageDirection[];
export function parseDirection(value: unknown): ParsedMessageDirection | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("_to_");
  if (separator < 1 || separator !== value.lastIndexOf("_to_")) {
    return undefined;
  }
  const sourceProvider = value.slice(0, separator);
  const targetProvider = value.slice(separator + 4);
  if (
    !isGatewayProvider(sourceProvider) ||
    !isGatewayProvider(targetProvider)
  ) {
    return undefined;
  }
  return { sourceProvider, targetProvider };
}
export const isMessageDirection = (value: unknown): value is MessageDirection =>
  parseDirection(value) !== undefined;
export const deliveryStates = ["queued", "duplicate", "dispatching", "transport_written", "held",
  "delivered", "unconfirmed", "failed", "ambiguous", "expired", "cancelled", "abandoned", "rejected"] as const;
export type DeliveryState = (typeof deliveryStates)[number];
export type TerminalDeliveryOutcome = Extract<DeliveryState,
  "delivered" | "unconfirmed" | "failed" | "ambiguous" | "expired" | "cancelled" | "abandoned">;
export const alertSeverities = ["info", "warning", "error"] as const;
export type AlertSeverity = (typeof alertSeverities)[number];
export type BusyPolicy = "queue";
export const gatewayPublicSnapshotLimits = Object.freeze({
  connectors: 64, registryRejectionCodes: 32,
  availablePeers: 256, routes: 256,
  consentEdges: 256, progressWatches: 64,
  progressWatchEvents: 256, activityEvents: 256,
  messages: 1_024, alerts: 256,
} as const);
export const GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET = 240 * 1024;
/**
 * Durable logical registration. Provider endpoint generations are deliberately
 * absent: they are operation-local evidence and never routing authority.
 */
export type LogicalRouteBinding = {
  provider: GatewayProvider; hostId: string; routeHandle: string; registrationId: string;
};
export type RouteCounters = {
  accepted: number; delivered: number; unconfirmed: number; failed: number; ambiguous: number; expired: number; cancelled: number; abandoned: number;
  rejected: number; bytesAccepted: number;
};
export type GatewayRouteRecord = {
  alias: string; binding: LogicalRouteBinding; registrationMode: RouteRegistrationMode; enabled: boolean; busyPolicy: BusyPolicy; registeredAt: string; updatedAt: string; counters: RouteCounters;
};
/**
 * Durable bidirectional consent between two exact route owners. Aliases are
 * display coordinates; the private registration identities prevent an alias from silently
 * retargeting an existing permission edge.
 */
export type GatewayConsentEndpoint = Readonly<{
  alias: string; provider: GatewayProvider; registrationId: string;
}>;
export type GatewayConsentEdgeRecord = {
  endpoints: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint]; createdAt: string; updatedAt: string; counters: RouteCounters;
};
/**
 * Controller-internal route view used to prove ownership across a restart.
 * This type must never cross the control protocol or enter a public snapshot.
 */
export type GatewayPrivateRouteInspection = {
  alias: string; binding: LogicalRouteBinding; registrationMode: RouteRegistrationMode; enabled: boolean;
};
export type QueuedMessageMetadata = {
  messageId: string; messageIdSuffix: string; conversationIdSuffix?: string; direction: MessageDirection; sourceAlias: string; targetAlias: string; enqueuedAt: string; deadlineAt: string;
  bytes: number; body?: string; pair?: true; transientTarget?: true;
  steer?: true;
};
export type DedupeRecord = {
  fingerprint: string; messageIdSuffix: string; conversationIdSuffix?: string; sourceAlias: string; targetAlias: string; direction: MessageDirection; pair?: true; firstSeenAt: string;
  expiresAt: string;
};
export type RateBucket = {
  sourceAlias: string; windowStartedAt: string; count: number;
};
export type NormalizedMessageEvent = {
  sequence: number; timestamp: string; messageIdSuffix: string; conversationIdSuffix?: string; direction: MessageDirection; sourceAlias: string; targetAlias: string; state: DeliveryState;
  bytes: number; body?: string; steer?: true; latencyMs?: number; safeErrorCode?: string;
};
export type GatewayAccounting = {
  accepted: number; duplicates: number; delivered: number; unconfirmed: number; failed: number; ambiguous: number; expired: number; cancelled: number;
  abandoned: number; rejected: number; bytesAccepted: number; queuedBytes: number;
};
export type GatewayPreparedWriteEvidence = {
  kind:
    | "claude_mailbox"
    | "codex_turn_start"
    | "codex_turn_steer"
    | "acp_prompt"
    | "peer_mailbox"
    | "peer_handoff";
  bodyBytes: number; bodySha256: string; frameBytes: number; sha256: string;
};
export type GatewayMessageAttemptAuthority = {
  attemptId: string; attemptCount: number; targetRegistrationId: string; sourceRegistrationId: string | null; consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
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
      outcome: TerminalDeliveryOutcome;
      terminalAt: string;
      safeErrorCode?: string;
      latencyMs: number;
    };
export type GatewayMessageRecord = QueuedMessageMetadata & {
  sequence: number; deliveryToken?: string; sourceRegistrationId: string | null; targetRegistrationId: string | null; consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
  state: GatewayMessageState;
};
export type GatewayMessageActivity = {
  type: "message_activity"; event: NormalizedMessageEvent;
};
export type GatewayRuntimeActivity = {
  type: "activity"; event: PublicGatewayActivityEvent;
};
export type GatewayStateActivity =
  | GatewayMessageActivity
  | GatewayRuntimeActivity;
export type GatewayPersistedState = {
  schemaVersion: 4; commit: { sequence: number; id: string }; createdAt: string; updatedAt: string; eventSequence: number; routes: GatewayRouteRecord[];
  consentEdges: GatewayConsentEdgeRecord[]; messages: GatewayMessageRecord[]; dedupe: DedupeRecord[]; rateBuckets: RateBucket[]; activity: GatewayStateActivity[]; accounting: GatewayAccounting;
};
export type PublicRouteSnapshot = {
  alias: string; provider: GatewayProvider; host: string; enabled: boolean; state: RouteState; busyPolicy: BusyPolicy; lastSeenAt?: string; queueDepth: number;
  oldestQueuedAt?: string; counters: RouteCounters; safeErrorCode?: string; mutable?: boolean;
};
export type PublicConsentEndpointSnapshot = Readonly<{ alias: string; provider: GatewayProvider }>;
export type PublicConsentEdgeSnapshot = {
  endpoints: readonly [PublicConsentEndpointSnapshot, PublicConsentEndpointSnapshot]; host: string; counters: RouteCounters; mutable?: boolean;
};
export type PublicConnectorSnapshot = {
  provider: GatewayProvider; host: string; health: ConnectorHealth; protocol: string; protocolVersion: string; lastSeenAt?: string; observationAgeMs?: number; codexDoctor?: PublicCodexDoctorSnapshot; safeErrorCode?: string; registry?: PublicRegistryObservationSnapshot;
};
export type PublicCodexDoctorCondition =
  | "split_brain"
  | "orphaned"
  | "attached"
  | "observation_stale"
  | "managed_layout_missing" | "unknown";
export type PublicCodexDoctorSnapshot = Readonly<{
  conditions: readonly PublicCodexDoctorCondition[];
}>;
export const CONNECTOR_OBSERVATION_STALE_AFTER_MS = 35_000;
/**
 * Bounded, native-ID-free evidence attached to one Claude connector. Counts
 * describe only the latest pass; the monotonic flag distinguishes an ordinary
 * empty registry from one that has never yielded parseable required fields
 * this boot.
 */
export type PublicRegistryObservationSnapshot = {
  entriesScanned: number; parseableRecords: number; parseableRecordSeenSinceBoot: boolean; rejected: { safeErrorCode: string; count: number }[]; rejectedCodesOmitted: number;
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
  alias: string; provider: GatewayProvider; host: string; state: PublicAvailablePeerState; validated: boolean; selected: boolean; lastSeenAt?: string; safeErrorCode?: string;
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
export type PublicGatewayActivityEvent = {
  sequence: number; timestamp: string; kind: GatewayActivityKind; action: GatewayActivityAction; outcome: "accepted" | "rejected"; aliases: string[]; operatorAction: boolean; safeErrorCode?: string;
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
  bucket: DeadlinePressureBucketName; settled: number; expired: number;
};
export type DeadlinePressureSnapshot = {
  configuredDeadlineMs: number; retainedSince?: string; terminalEvents: number; expiredEvents: number; buckets: DeadlinePressureBucket[];
};
const PUBLIC_ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PUBLIC_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PUBLIC_SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
function publicRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function exactPublicKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}
function publicTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 35 && Number.isFinite(Date.parse(value));
}
function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function isPublicAvailablePeerSnapshot(value: unknown): value is PublicAvailablePeerSnapshot {
  const candidate = publicRecord(value);
  if (candidate === undefined ||
    !exactPublicKeys(candidate, ["alias", "provider", "host", "state", "validated", "selected"],
      ["lastSeenAt", "safeErrorCode"]) ||
    typeof candidate.alias !== "string" ||
    !PUBLIC_ALIAS_PATTERN.test(candidate.alias) ||
    typeof candidate.host !== "string" ||
    !PUBLIC_HOST_PATTERN.test(candidate.host) ||
    !candidate.alias.endsWith(`@${candidate.host}`) ||
    candidate.provider !== "claude" ||
    typeof candidate.state !== "string" ||
    !(publicAvailablePeerStates as readonly string[]).includes(candidate.state) ||
    typeof candidate.validated !== "boolean" ||
    typeof candidate.selected !== "boolean") return false;
  return (candidate.lastSeenAt === undefined || publicTimestamp(candidate.lastSeenAt)) &&
    (candidate.safeErrorCode === undefined ||
      (typeof candidate.safeErrorCode === "string" && PUBLIC_SAFE_CODE_PATTERN.test(candidate.safeErrorCode)));
}
export function arePublicAvailablePeerSnapshots(
  value: unknown, maximumRows: number = gatewayPublicSnapshotLimits.availablePeers,
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
export function isPublicRegistryObservationSnapshot(value: unknown): value is PublicRegistryObservationSnapshot {
  const candidate = publicRecord(value);
  if (candidate === undefined ||
    !exactPublicKeys(candidate, ["entriesScanned", "parseableRecords", "parseableRecordSeenSinceBoot",
      "rejected", "rejectedCodesOmitted"]) ||
    !nonNegative(candidate.entriesScanned) || !nonNegative(candidate.parseableRecords) ||
    Number(candidate.parseableRecords) > Number(candidate.entriesScanned) ||
    typeof candidate.parseableRecordSeenSinceBoot !== "boolean" ||
    (Number(candidate.parseableRecords) > 0 && candidate.parseableRecordSeenSinceBoot !== true) ||
    !nonNegative(candidate.rejectedCodesOmitted) ||
    !Array.isArray(candidate.rejected) ||
    candidate.rejected.length > gatewayPublicSnapshotLimits.registryRejectionCodes) return false;
  const rejected = candidate.rejected as unknown[];
  if (!rejected.every((row) => {
      const record = publicRecord(row);
      return record !== undefined && exactPublicKeys(record, ["safeErrorCode", "count"]) &&
        typeof record.safeErrorCode === "string" &&
        PUBLIC_SAFE_CODE_PATTERN.test(record.safeErrorCode) &&
        Number.isSafeInteger(record.count) && Number(record.count) > 0;
    })) return false;
  const codes = rejected.map((row) => (row as { safeErrorCode: string }).safeErrorCode);
  return codes.every((code, index) => index === 0 || codes[index - 1]! < code);
}
export type SafeGatewayAlert = {
  code: string; severity: AlertSeverity; timestamp: string; provider?: GatewayProvider; host?: string; alias?: string;
};
export type PublicProgressWatchSnapshot = {
  conversationIdSuffix: string; ownerAlias: string; workerAlias: string; lastActivityAt: string; nextActionAt: string; nudgeCount: 0 | 1 | 2;
};
export type PublicProgressWatchEventSnapshot = {
  sequence: number; timestamp: string; conversationIdSuffix: string; ownerAlias: string;
  workerAlias: string; kind: "opened" | "replaced" | "settled"; actor: "owner" | "worker" | "operator" | "gateway" | "unknown";
  reason?:
    | "done"
    | "untracked"
    | "idle_timeout"
    | "pair_removed"
    | "endpoint_retired"
    | "tracking_disabled";
};
export type GatewayPublicSnapshot = {
  schemaVersion: 2; generatedAt: string; inboundMode: GatewayInboundMode; health: ConnectorHealth;
  connectors: PublicConnectorSnapshot[]; availablePeers: PublicAvailablePeerSnapshot[]; routes: PublicRouteSnapshot[]; consentEdges: PublicConsentEdgeSnapshot[];
  progressWatches?: PublicProgressWatchSnapshot[]; progressWatchEvents?: PublicProgressWatchEventSnapshot[]; activityEvents?: PublicGatewayActivityEvent[]; deadlinePressure?: DeadlinePressureSnapshot;
  messages: NormalizedMessageEvent[]; accounting: GatewayAccounting; alerts: SafeGatewayAlert[]; truncation: GatewaySnapshotTruncation;
};
export type GatewaySnapshotTruncation = {
  connectors: number; availablePeers: number; routes: number; consentEdges: number;
  progressWatches?: number; progressWatchEvents?: number; activityEvents?: number; messages: number;
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
  snapshot: GatewayPublicSnapshot, maximumBytes: number = GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
): GatewayPublicSnapshot {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1_024 ||
    maximumBytes > GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET
  ) {
    throw new RangeError("INVALID_GATEWAY_SNAPSHOT_BYTE_BUDGET");
  }
  const omitted = (length: number, limit: number): number => Math.max(0, length - limit);
  const truncation: GatewaySnapshotTruncation = {
    connectors: snapshot.truncation.connectors + omitted(snapshot.connectors.length, gatewayPublicSnapshotLimits.connectors),
    availablePeers: snapshot.truncation.availablePeers + omitted(snapshot.availablePeers.length, gatewayPublicSnapshotLimits.availablePeers),
    routes: snapshot.truncation.routes + omitted(snapshot.routes.length, gatewayPublicSnapshotLimits.routes),
    consentEdges: snapshot.truncation.consentEdges + omitted(snapshot.consentEdges.length, gatewayPublicSnapshotLimits.consentEdges),
    messages: snapshot.truncation.messages + omitted(snapshot.messages.length, gatewayPublicSnapshotLimits.messages),
    alerts: snapshot.truncation.alerts + omitted(snapshot.alerts.length, gatewayPublicSnapshotLimits.alerts),
  };
  if (snapshot.progressWatches !== undefined) {
    truncation.progressWatches = (snapshot.truncation.progressWatches ?? 0) +
      omitted(snapshot.progressWatches.length, gatewayPublicSnapshotLimits.progressWatches);
  }
  if (snapshot.progressWatchEvents !== undefined) {
    truncation.progressWatchEvents = (snapshot.truncation.progressWatchEvents ?? 0) +
      omitted(snapshot.progressWatchEvents.length, gatewayPublicSnapshotLimits.progressWatchEvents);
  }
  if (snapshot.activityEvents !== undefined) {
    truncation.activityEvents = (snapshot.truncation.activityEvents ?? 0) +
      omitted(snapshot.activityEvents.length, gatewayPublicSnapshotLimits.activityEvents);
  }
  const projected: GatewayPublicSnapshot = {
    ...snapshot,
    connectors: structuredClone(snapshot.connectors.slice(0, gatewayPublicSnapshotLimits.connectors)),
    availablePeers: snapshot.availablePeers.slice(0, gatewayPublicSnapshotLimits.availablePeers),
    routes: snapshot.routes.slice(0, gatewayPublicSnapshotLimits.routes),
    consentEdges: snapshot.consentEdges.slice(0, gatewayPublicSnapshotLimits.consentEdges),
    ...(snapshot.progressWatches === undefined ? {} : {
      progressWatches: snapshot.progressWatches.slice(0, gatewayPublicSnapshotLimits.progressWatches),
    }),
    ...(snapshot.progressWatchEvents === undefined ? {} : {
      progressWatchEvents: snapshot.progressWatchEvents.slice(-gatewayPublicSnapshotLimits.progressWatchEvents),
    }),
    ...(snapshot.activityEvents === undefined ? {} : {
      activityEvents: snapshot.activityEvents.slice(-gatewayPublicSnapshotLimits.activityEvents),
    }),
    messages: snapshot.messages.slice(-gatewayPublicSnapshotLimits.messages), alerts: snapshot.alerts.slice(-gatewayPublicSnapshotLimits.alerts),
    accounting: { ...snapshot.accounting },
    truncation,
  };
  if (snapshotBytes(projected) <= maximumBytes) return projected;
  const retainUntilFit = (
    rowCount: number, applyRetainedCount: (retained: number) => void,
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
  const retainRows = <T>(
    rows: readonly T[], priorOmissions: number,
    newest: boolean,
    apply: (retained: T[], omissions: number) => void,
  ): boolean => retainUntilFit(rows.length, (count) => {
    const retained = count === 0 ? [] : newest ? rows.slice(-count) : rows.slice(0, count);
    apply(retained, priorOmissions + rows.length - count);
  });
  const watchEvents = projected.progressWatchEvents ?? [];
  if (
    watchEvents.length > 0 &&
    retainRows(watchEvents, projected.truncation.progressWatchEvents ?? 0, true, (rows, omissions) => {
      projected.progressWatchEvents = rows;
      projected.truncation.progressWatchEvents = omissions;
    })
  ) return projected;
  const activityEvents = projected.activityEvents ?? [];
  if (
    activityEvents.length > 0 &&
    retainRows(activityEvents, projected.truncation.activityEvents ?? 0, true, (rows, omissions) => {
      projected.activityEvents = rows;
      projected.truncation.activityEvents = omissions;
    })
  ) return projected;
  const messages = projected.messages;
  if (retainRows(messages, projected.truncation.messages, true, (rows, omissions) => {
    projected.messages = rows;
    projected.truncation.messages = omissions;
  })) return projected;
  const peers = [...projected.availablePeers].sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    const byState = peerPriority(left.state) - peerPriority(right.state);
    if (byState !== 0) return byState;
    const bySeen = (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "");
    return bySeen || left.alias.localeCompare(right.alias);
  });
  if (retainRows(peers, projected.truncation.availablePeers, false, (rows, omissions) => {
    projected.availablePeers = rows;
    projected.truncation.availablePeers = omissions;
  })) return projected;
  const alerts = [...projected.alerts].sort((left, right) => {
    const bySeverity =
      severityPriority(left.severity) - severityPriority(right.severity);
    if (bySeverity !== 0) return bySeverity;
    const byTime = right.timestamp.localeCompare(left.timestamp);
    return byTime || left.code.localeCompare(right.code);
  });
  if (retainRows(alerts, projected.truncation.alerts, false, (rows, omissions) => {
    projected.alerts = rows;
    projected.truncation.alerts = omissions;
  })) return projected;
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
  if (retainRows(consentEdges, projected.truncation.consentEdges, false, (rows, omissions) => {
    projected.consentEdges = rows;
    projected.truncation.consentEdges = omissions;
  })) return projected;
  if (retainRows(routes, projected.truncation.routes, false, (rows, omissions) => {
    projected.routes = rows;
    projected.truncation.routes = omissions;
  })) return projected;
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
  if (retainRows(connectors, projected.truncation.connectors, false, (rows, omissions) => {
    projected.connectors = rows;
    projected.truncation.connectors = omissions;
  })) return projected;
  throw new RangeError("GATEWAY_SNAPSHOT_BASE_EXCEEDS_BYTE_BUDGET");
}
export type RegisterRouteInput = {
  alias: string; binding: LogicalRouteBinding; registrationMode: RouteRegistrationMode;
};
export type GatewayReservedAttempt = Readonly<{
  messageId: string; attemptId: string; attemptCount: number; body: string;
  deadlineAt: string; direction: MessageDirection; sourceAlias: string; targetAlias: string;
  conversationIdSuffix?: string; sourceRegistrationId: string | null; targetRegistrationId: string; consentEdge: readonly [GatewayConsentEndpoint, GatewayConsentEndpoint] | null;
  bytes: number; steer?: true;
}>;
export type ReserveMessageResult =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "terminal"; settlement: TerminalMessageSettlement }>
  | Readonly<{ status: "reserved"; attempt: GatewayReservedAttempt }>;
type AttemptInput = Readonly<{ messageId: string; attemptId: string }>;
type StaleAttemptResult = Readonly<{ status: "stale" }>;
type SettledAttemptResult = Readonly<{ status: "settled"; settlement: TerminalMessageSettlement }>;
export type AuthorizeMessageInput = AttemptInput & Readonly<{
  sourceRegistrationId: string | null; targetRegistrationId: string; prepared: GatewayPreparedWriteEvidence;
}>;
export type AuthorizeMessageResult =
  | Readonly<{ status: "authorized" }>
  | Readonly<{ status: "stale"; reason: "not_reserved" | "attempt_mismatch" | "registration_changed" | "consent_removed" }>
  | Readonly<{ status: "terminal"; reason: "expired" | "fenced"; settlement: TerminalMessageSettlement }>;
export type AcceptMessageInput = AttemptInput & Readonly<{
  lossOutcome: "unconfirmed" | "ambiguous";
}>;
export type AcceptMessageResult = Readonly<{ status: "accepted" }> | StaleAttemptResult;
export type ResolvePrewriteAttemptInput = AttemptInput & Readonly<{
  outcome: "requeue" | "failed"; safeErrorCode?: string;
}>;
export type ResolvePrewriteAttemptResult =
  | Readonly<{ status: "requeued" }>
  | SettledAttemptResult
  | StaleAttemptResult;
export type SettleAttemptInput = AttemptInput & Readonly<{
  state: Exclude<TerminalDeliveryOutcome, "abandoned">; safeErrorCode?: string;
}>;
export type SettleAttemptResult = SettledAttemptResult | StaleAttemptResult;
export type SettleAttemptForShutdownInput = AttemptInput;
export type SettleAttemptForShutdownResult =
  | Readonly<{ status: "requeued" }>
  | SettledAttemptResult
  | StaleAttemptResult;
export type SettleQueuedMessageForShutdownInput = Readonly<{
  messageId: string;
}>;
export type SettleQueuedMessageForShutdownResult =
  SettledAttemptResult | StaleAttemptResult;
export type RemoveRouteAtomicResult = Readonly<{
  removed: boolean; settlements: readonly TerminalMessageSettlement[];
}>;
export type GatewayAtomicActivityInput = Readonly<{
  operatorAction: boolean;
}>;
export type ReplaceCodexRegistrationAtomicInput = Readonly<{
  oldAlias: string; expectedOldRegistrationId: string; replacement: RegisterRouteInput; activity: GatewayAtomicActivityInput;
}>;
export type ReplaceCodexRegistrationAtomicResult = Readonly<{
  replaced: boolean; idempotent: boolean; settlements: readonly TerminalMessageSettlement[];
}>;
export type EnqueueMessageInput = {
  sourceAlias: string; targetAlias: string; expectedSourceRegistrationId?: string; expectedTargetRegistrationId?: string;
  body: string; dedupeKey: string; conversationIdSuffix?: string; deadlineAt?: string;
  steer?: true;
};
/**
 * Controller-internal proof of one currently observed native Claude peer.
 * The binding may contain a native session identifier and must remain an
 * in-memory call argument. Store metadata retains only the public alias.
 */
export type TransientNativeClaudePeer = {
  alias: string; binding: LogicalRouteBinding;
};
export type EnqueueNativeIngressInput = Omit<
  EnqueueMessageInput,
  | "sourceAlias"
  | "targetAlias"
  | "expectedSourceRegistrationId"
  | "expectedTargetRegistrationId"
> & {
  source: TransientNativeClaudePeer; targetAlias: string; expectedTargetRegistrationId: string;
  authorizedPairTeardownReply?: true;
};
export type EnqueueNativeReplyInput = Omit<
  EnqueueMessageInput,
  | "sourceAlias"
  | "targetAlias"
  | "expectedSourceRegistrationId"
  | "expectedTargetRegistrationId"
> & {
  sourceAlias: string; expectedSourceRegistrationId: string; target: TransientNativeClaudePeer;
  pair?: true; exposeDeliveryToken?: true;
};
export type EnqueueMessageResult = {
  accepted: boolean; duplicate: boolean; messageId?: string; messageIdSuffix: string;
  deliveryToken?: string; pair?: true;
  supersededSettlement?: TerminalMessageSettlement;
};
/**
 * Controller-internal proof that one message won its terminal-state race.
 * Full message IDs are required only for in-memory service correlation; this
 * structure must never enter a public snapshot or persisted event.
 */
export type TerminalMessageSettlement = {
  messageId: string; state: TerminalDeliveryOutcome; safeErrorCode?: string;
};
export type GatewayStoreLimits = {
  maxRoutes: number; maxConsentEdges: number; maxWatches?: number; eventCapacity: number;
  eventTtlMs: number; dedupeCapacity: number; dedupeTtlMs: number; maxQueueMessages: number;
  maxQueueMessagesPerRoute: number; maxInFlightMessages: number; maxQueueBytes: number; maxMessageBytes: number;
  maxRetainedBodyBytes?: number; messageDeadlineMs: number; rateLimitPerRoute: number; rateWindowMs: number;
};
export type GatewayStoreDependencies = {
  now?: () => Date; randomId?: () => string; renameStateFile?: (source: string, target: string) => Promise<void>;
  afterStateFileRename?: () => void | Promise<void>;
};
