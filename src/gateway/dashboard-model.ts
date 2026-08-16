import {
  arePublicAvailablePeerSnapshots,
  gatewayProviders,
  isPublicRegistryObservationSnapshot,
  parseDirection,
} from "./types.js";
import type {
  AlertSeverity,
  ConnectorHealth,
  DeliveryState,
  GatewayProvider,
  GatewayPublicSnapshot,
  MessageDirection,
  PublicAvailablePeerState,
  RouteCounters,
  RouteState,
} from "./types.js";

export const DASHBOARD_MODEL_LIMITS = Object.freeze({
  connectors: 16,
  availablePeers: 64,
  routes: 128,
  consentEdges: 64,
  messages: 50,
  messageEvents: 60,
  progressWatches: 64,
  progressWatchEvents: 64,
  activityEvents: 64,
  alerts: 32,
} as const);

export type DashboardTone = "good" | "info" | "warning" | "danger" | "quiet";

export type DashboardNextAction =
  | "discover_claude"
  | "select_claude"
  | "pair_routes"
  | "restore_claude"
  | "repair_claude_inventory"
  | "register_codex"
  | "restore_codex"
  | "none";

export type DashboardExchangeParty = Readonly<{
  kind: GatewayProvider;
  status: "ready" | "busy" | "waiting" | "missing" | "attention";
  total: number;
  ready: number;
  selectable?: number | undefined;
  countIsLowerBound: boolean;
  primaryAlias?: string | undefined;
  nextAction: DashboardNextAction;
}>;

export type DashboardAttentionItem = Readonly<{
  kind: "alert" | "route" | "connector" | "broker" | "watch";
  code?: string | undefined;
  severity: AlertSeverity;
  timestamp?: string | undefined;
  provider?: GatewayProvider | undefined;
  alias?: string | undefined;
  host?: string | undefined;
  /** Present only for a threshold-stalled queue behind a busy Codex route. */
  queueDepth?: number | undefined;
  guidance:
    | "reobserve_claude"
    | "reobserve_codex"
    | "codex_reactivation_required"
    | "consent_edge_unavailable"
    | "claude_not_observed"
    | "codex_stale"
    | "codex_app_reconnect_required"
    | "connector_offline"
    | "route_stale"
    | "queue_stalled"
    | "recipient_waiting_input"
    | "unconfirmed"
    | "degraded"
    | "codex_succession_busy"
    | "codex_succession_recovery"
    | "progress_watch"
    | "registry_empty"
    | "registry_rejected"
    | "generic";
}>;

export type DashboardProgressWatchRow = Readonly<{
  conversationIdSuffix: string;
  ownerAlias: string;
  workerAlias: string;
  lastActivityAt: string;
  nextActionAt: string;
  idleForMs: number;
  dueInMs: number;
  nudgeCount: 0 | 1 | 2;
}>;

export type DashboardProgressWatchEventRow = Readonly<{
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
    | "tracking_disabled"
    | undefined;
}>;

export type DashboardMessageEvent = Readonly<{
  sequence: number;
  timestamp?: string | undefined;
  state: DeliveryState;
  latencyMs?: number | undefined;
  safeErrorCode?: string | undefined;
  conversationIdSuffix?: string | undefined;
  steer?: true | undefined;
}>;

export type DashboardMessageGroup = Readonly<{
  direction: MessageDirection;
  sourceAlias: string;
  targetAlias: string;
  messageIdSuffix?: string | undefined;
  conversationIdSuffix?: string | undefined;
  state: DeliveryState;
  timestamp?: string | undefined;
  latencyMs?: number | undefined;
  bytes: number;
  safeErrorCode?: string | undefined;
  steer?: true | undefined;
  events: readonly DashboardMessageEvent[];
}>;

export type LiveDashboardMessageGroup = DashboardMessageGroup &
  Readonly<{ body?: string | undefined }>;

export type DashboardActivityEventRow = Readonly<{
  sequence: number;
  timestamp: string;
  kind:
    | "discovery"
    | "selection"
    | "registration"
    | "pairing"
    | "watch"
    | "endpoint"
    | "recovery";
  action:
    | "discovery_refreshed"
    | "claude_selected"
    | "claude_unselected"
    | "codex_registered"
    | "codex_succeeded"
    | "codex_unregistered"
    | "routes_paired"
    | "routes_unpaired"
    | "watch_ended"
    | "endpoint_refreshed"
    | "codex_orphan_removed";
  outcome: "accepted" | "rejected";
  aliases: readonly string[];
  operatorAction: boolean;
  safeErrorCode?: string | undefined;
}>;

export type DashboardPeerRow = Readonly<{
  alias: string;
  host: string;
  state: PublicAvailablePeerState;
  validated: boolean;
  selected: boolean;
  selectable: boolean;
  selectionGuidance?:
    | "alias_collision"
    | "session_collision"
    | "discovery_incomplete"
    | "offline"
    | undefined;
  lastSeenAt?: string | undefined;
  safeErrorCode?: string | undefined;
}>;

export type DashboardRouteRow = Readonly<{
  alias: string;
  provider: GatewayProvider;
  host: string;
  enabled: boolean;
  state: RouteState;
  queueDepth: number;
  oldestQueuedAt?: string | undefined;
  queueAgeMs?: number | undefined;
  counters: RouteCounters;
  lastSeenAt?: string | undefined;
  safeErrorCode?: string | undefined;
}>;

export type DashboardConsentEndpoint = Readonly<{
  alias: string;
  provider: GatewayProvider;
}>;

export type DashboardConsentEdgeRow = Readonly<{
  endpoints: readonly [DashboardConsentEndpoint, DashboardConsentEndpoint];
  host: string;
  state: "ready" | "degraded" | "unavailable";
  counters: RouteCounters;
}>;

export type DashboardGraphFacts = Readonly<{
  consentEdgeCount: number;
  readyConsentEdgeCount: number;
  consentEdgeCountIsLowerBound: boolean;
  unpairedReadyByProvider: Readonly<Record<GatewayProvider, number>>;
}>;

export type DashboardConnectorRow = Readonly<{
  provider: GatewayProvider;
  host: string;
  health: ConnectorHealth;
  protocol?: string | undefined;
  protocolVersion?: string | undefined;
  lastSeenAt?: string | undefined;
  codexDoctor?: Readonly<{
    conditions: readonly (
      | "split_brain"
      | "orphaned"
      | "attached"
      | "observation_stale"
      | "unknown"
    )[];
  }>;
  safeErrorCode?: string | undefined;
  registry?: DashboardRegistryObservation | undefined;
}>;

export type DashboardRegistryObservation = Readonly<{
  entriesScanned: number;
  parseableRecords: number;
  parseableRecordSeenSinceBoot: boolean;
  rejected: readonly Readonly<{
    safeErrorCode: string;
    count: number;
  }>[];
  rejectedCodesOmitted: number;
}>;

export type DashboardOmissions = Readonly<{
  connectors: number;
  availablePeers: number;
  routes: number;
  consentEdges: number;
  progressWatches: number;
  upstreamProgressWatchEvents: number;
  progressWatchEvents: number;
  upstreamMessageEvents: number;
  messageGroups: number;
  messageEvents: number;
  upstreamAlerts: number;
  attentionItems: number;
  upstreamActivityEvents: number;
  activityEvents: number;
}>;

export type DashboardViewModel = Readonly<{
  schemaVersion: 2;
  generatedAt?: string | undefined;
  inboundMode: "paired" | "open";
  health: ConnectorHealth;
  overall: "ready" | "setup" | "attention";
  exchange: Readonly<{
    parties: readonly DashboardExchangeParty[];
    queuedMessages: number;
    queueCountIsLowerBound: boolean;
    oldestQueueAgeMs?: number | undefined;
    oldestQueuedAt?: string | undefined;
  }>;
  attention: readonly DashboardAttentionItem[];
  transit: Readonly<{
    queuedMessages: number;
    activeDeliveries: number;
    queueCountIsLowerBound: boolean;
    activeCountIsLowerBound: boolean;
    oldestQueueAgeMs?: number | undefined;
    oldestQueuedAt?: string | undefined;
  }>;
  activity: readonly DashboardMessageGroup[];
  brokerActivity: readonly DashboardActivityEventRow[];
  peers: readonly DashboardPeerRow[];
  routes: readonly DashboardRouteRow[];
  consentEdges: readonly DashboardConsentEdgeRow[];
  watches: readonly DashboardProgressWatchRow[];
  watchEvents: readonly DashboardProgressWatchEventRow[];
  graph: DashboardGraphFacts;
  connectors: readonly DashboardConnectorRow[];
  accounting: GatewayPublicSnapshot["accounting"];
  deadlinePressure?: GatewayPublicSnapshot["deadlinePressure"];
  omissions: DashboardOmissions;
}>;

export type LiveDashboardViewModel = Omit<DashboardViewModel, "activity"> &
  Readonly<{ activity: readonly LiveDashboardMessageGroup[] }>;

export type DashboardChipKind =
  | "positive"
  | "qualified"
  | "active"
  | "progress"
  | "warning"
  | "indeterminate"
  | "failure"
  | "inert"
  | "unknown";

export type DashboardSemanticDomain =
  | "delivery"
  | "route"
  | "peer"
  | "health"
  | "overall"
  | "party"
  | "severity"
  | "connection";

type DashboardPresentation = Readonly<{
  tone: DashboardTone;
  chip: DashboardChipKind;
}>;

const presentation = <T extends string>(
  values: Readonly<Record<T, DashboardPresentation>>,
): Readonly<Record<T, DashboardPresentation>> => values;

const statePresentation = {
  delivery: presentation<DeliveryState>({
    queued: { tone: "info", chip: "progress" },
    duplicate: { tone: "quiet", chip: "inert" },
    dispatching: { tone: "info", chip: "progress" },
    transport_written: { tone: "info", chip: "progress" },
    held: { tone: "warning", chip: "progress" },
    delivered: { tone: "good", chip: "positive" },
    unconfirmed: { tone: "warning", chip: "indeterminate" },
    failed: { tone: "danger", chip: "failure" },
    ambiguous: { tone: "warning", chip: "indeterminate" },
    expired: { tone: "danger", chip: "failure" },
    cancelled: { tone: "danger", chip: "inert" },
    abandoned: { tone: "danger", chip: "inert" },
    rejected: { tone: "danger", chip: "warning" },
  }),
  route: presentation<RouteState>({
    stale: { tone: "danger", chip: "failure" },
    idle: { tone: "good", chip: "progress" },
    busy: { tone: "info", chip: "active" },
    awaiting_approval: { tone: "warning", chip: "warning" },
    offline: { tone: "danger", chip: "failure" },
    disabled: { tone: "quiet", chip: "inert" },
  }),
  peer: presentation<PublicAvailablePeerState>({
    idle: { tone: "good", chip: "progress" },
    busy: { tone: "info", chip: "active" },
    awaiting_approval: { tone: "warning", chip: "warning" },
    offline: { tone: "danger", chip: "inert" },
  }),
  health: presentation<ConnectorHealth>({
    healthy: { tone: "good", chip: "positive" },
    connecting: { tone: "info", chip: "progress" },
    degraded: { tone: "warning", chip: "warning" },
    offline: { tone: "danger", chip: "failure" },
  }),
  overall: presentation<DashboardViewModel["overall"]>({
    ready: { tone: "good", chip: "positive" },
    setup: { tone: "info", chip: "progress" },
    attention: { tone: "danger", chip: "failure" },
  }),
  party: presentation<DashboardExchangeParty["status"]>({
    ready: { tone: "good", chip: "positive" },
    busy: { tone: "info", chip: "active" },
    waiting: { tone: "warning", chip: "warning" },
    missing: { tone: "quiet", chip: "inert" },
    attention: { tone: "danger", chip: "failure" },
  }),
  severity: presentation<AlertSeverity>({
    info: { tone: "info", chip: "active" },
    warning: { tone: "warning", chip: "warning" },
    error: { tone: "danger", chip: "failure" },
  }),
  connection: presentation({
    connected: { tone: "good", chip: "positive" },
    connecting: { tone: "info", chip: "progress" },
    paused: { tone: "quiet", chip: "inert" },
    unavailable: { tone: "warning", chip: "warning" },
    capacity: { tone: "warning", chip: "warning" },
    disconnected: { tone: "warning", chip: "warning" },
    stopped: { tone: "warning", chip: "warning" },
  }),
} as const;

const guidanceCopyKeys = {
  reobserve_claude: "reobserveClaude",
  reobserve_codex: "reobserveCodex",
  codex_reactivation_required: "codexReactivationRequired",
  consent_edge_unavailable: "consentEdgeUnavailable",
  claude_not_observed: "claudeNotObserved",
  codex_stale: "codexStale",
  codex_app_reconnect_required: "codexAppReconnectRequired",
  connector_offline: "connectorOffline",
  route_stale: "routeStale",
  queue_stalled: "queueStalled",
  recipient_waiting_input: "recipientWaitingInput",
  unconfirmed: "unconfirmed",
  degraded: "degraded",
  codex_succession_busy: "codexSuccessionBusy",
  codex_succession_recovery: "codexSuccessionRecovery",
  progress_watch: "progressWatch",
  registry_empty: "registryEmpty",
  registry_rejected: "registryRejected",
  generic: "generic",
} as const satisfies Record<DashboardAttentionItem["guidance"], string>;

const nextActionCopyKeys = {
  discover_claude: "next.discoverClaude",
  select_claude: "next.selectClaude",
  pair_routes: "next.pairRoutes",
  restore_claude: "next.restoreClaude",
  repair_claude_inventory: "next.repairClaude",
  register_codex: "next.registerCodex",
  restore_codex: "next.restoreCodex",
  none: "next.none",
} as const satisfies Record<DashboardNextAction, string>;

const attentionCommands = {
  reobserve_claude: "embassy select-claude --alias {alias}",
  reobserve_codex: "embassy register-codex --alias {alias}",
  codex_reactivation_required: "embassy register-codex --alias {alias}",
  consent_edge_unavailable: "embassy refresh-dashboard",
  claude_not_observed: "embassy select-claude --alias {alias}",
  codex_stale: "embassy register-codex --alias {alias}",
  codex_app_reconnect_required:
    "/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT",
  connector_offline: "embassy status",
  route_stale: "embassy status",
  queue_stalled: "embassy status",
  recipient_waiting_input: "embassy status",
  unconfirmed: "embassy status",
  degraded: "embassy status",
  codex_succession_busy:
    "embassy register-codex --alias <new> --succeeds {alias}",
  codex_succession_recovery:
    "embassy register-codex --alias <new> --succeeds {alias}",
  progress_watch: "embassy status",
  registry_empty: "embassy refresh-dashboard",
  registry_rejected: "embassy status",
  generic: "embassy status",
} as const satisfies Record<DashboardAttentionItem["guidance"], string>;

const deliveryMeaningKeys = {
  queued: "activity.meaning.queued",
  duplicate: "activity.meaning.duplicate",
  dispatching: "activity.meaning.dispatching",
  transport_written: "activity.meaning.transportWritten",
  held: "activity.meaning.held",
  delivered: "activity.meaning.delivered",
  unconfirmed: "activity.meaning.unconfirmed",
  failed: "activity.meaning.failed",
  ambiguous: "activity.meaning.ambiguous",
  expired: "activity.meaning.expired",
  cancelled: "activity.meaning.cancelled",
  abandoned: "activity.meaning.abandoned.generic",
  rejected: "activity.meaning.rejected",
} as const satisfies Record<DeliveryState, string>;

/** JSON-safe semantics embedded once in the live dashboard boot payload. */
export const DASHBOARD_SEMANTICS = Object.freeze({
  statePresentation,
  deliveryChipByTargetProvider: {
    delivered: { claude: "qualified" },
  },
  deliveryChipBySafeErrorCode: {
    rejected: { SENDER_NOT_PAIRED: "inert" },
  },
  deliveryToneBySafeErrorCode: {
    rejected: { SENDER_NOT_PAIRED: "quiet" },
  },
  guidanceCopyKeys,
  nextActionCopyKeys,
  attentionCommands,
  attentionCommandFallbacks: {
    codex_succession_busy: "<old>",
    codex_succession_recovery: "<old>",
  },
  deliveryMeaningKeys,
  deliveryMeaningByTargetProvider: {
    claude: "activity.meaning.delivered.toClaude",
    codex: "activity.meaning.delivered.toCodex",
    deepseek: "activity.meaning.delivered.toDeepSeek",
    grok: "activity.meaning.delivered.toGrok",
  },
  deliveryMeaningBySafeErrorCode: {
    SENDER_NOT_PAIRED: "activity.meaning.senderNotPaired",
    CONTROLLER_RESTARTED: "activity.meaning.abandoned.controllerRestarted",
    TRANSIENT_BODY_UNAVAILABLE: "activity.meaning.abandoned.transientBody",
    ROUTE_UNREGISTERED: "activity.meaning.abandoned.routeTerminated",
    MESSAGE_EXPIRED: "activity.meaning.abandoned.routeTerminated",
  },
} as const);

export type DashboardSemantics = typeof DASHBOARD_SEMANTICS;

function semanticPresentation(
  domain: DashboardSemanticDomain,
  state: string,
): DashboardPresentation | undefined {
  const table = DASHBOARD_SEMANTICS.statePresentation[domain] as Readonly<
    Record<string, DashboardPresentation>
  >;
  return Object.prototype.hasOwnProperty.call(table, state)
    ? table[state]
    : undefined;
}

export function dashboardChipKind(
  domain: DashboardSemanticDomain,
  state: string,
  direction?: MessageDirection,
  safeErrorCode?: string,
): DashboardChipKind {
  if (domain === "delivery") {
    const byCode = DASHBOARD_SEMANTICS.deliveryChipBySafeErrorCode as Readonly<
      Record<string, Readonly<Record<string, DashboardChipKind>>>
    >;
    const byTarget = DASHBOARD_SEMANTICS.deliveryChipByTargetProvider as Readonly<
      Record<string, Readonly<Partial<Record<GatewayProvider, DashboardChipKind>>>>
    >;
    if (safeErrorCode !== undefined) {
      const override = byCode[state]?.[safeErrorCode];
      if (override !== undefined) return override;
    }
    if (direction !== undefined) {
      const target = parseDirection(direction)?.targetProvider;
      const override = target === undefined ? undefined : byTarget[state]?.[target];
      if (override !== undefined) return override;
    }
  }
  return semanticPresentation(domain, state)?.chip ?? "unknown";
}

export function dashboardTone(
  domain: DashboardSemanticDomain,
  state: string,
  safeErrorCode?: string,
): DashboardTone {
  if (domain === "delivery" && safeErrorCode !== undefined) {
    const byCode = DASHBOARD_SEMANTICS.deliveryToneBySafeErrorCode as Readonly<
      Record<string, Readonly<Record<string, DashboardTone>>>
    >;
    const override = byCode[state]?.[safeErrorCode];
    if (override !== undefined) return override;
  }
  return semanticPresentation(domain, state)?.tone ?? "danger";
}

export function deliveryMeaningKey(
  state: string,
  direction?: MessageDirection,
  safeErrorCode?: string,
): string {
  if (state === "rejected" && safeErrorCode === "SENDER_NOT_PAIRED") {
    return DASHBOARD_SEMANTICS.deliveryMeaningBySafeErrorCode.SENDER_NOT_PAIRED;
  }
  if (state === "delivered" && direction !== undefined) {
    const target = parseDirection(direction)?.targetProvider;
    if (target !== undefined) {
      return DASHBOARD_SEMANTICS.deliveryMeaningByTargetProvider[target];
    }
  }
  if (state === "abandoned" && safeErrorCode !== undefined) {
    const byCode = DASHBOARD_SEMANTICS.deliveryMeaningBySafeErrorCode as Readonly<
      Record<string, string>
    >;
    return byCode[safeErrorCode] ?? deliveryMeaningKeys.abandoned;
  }
  const byState = DASHBOARD_SEMANTICS.deliveryMeaningKeys as Readonly<
    Record<string, string>
  >;
  return byState[state] ?? "activity.meaning.other";
}

export function guidanceCopyKey(
  guidance: DashboardAttentionItem["guidance"],
): string {
  return DASHBOARD_SEMANTICS.guidanceCopyKeys[guidance];
}

export function nextActionCopyKey(action: DashboardNextAction): string {
  return DASHBOARD_SEMANTICS.nextActionCopyKeys[action];
}

export function attentionCommand(item: DashboardAttentionItem): string {
  const fallbacks = DASHBOARD_SEMANTICS.attentionCommandFallbacks as Readonly<
    Partial<Record<DashboardAttentionItem["guidance"], string>>
  >;
  return DASHBOARD_SEMANTICS.attentionCommands[item.guidance].replaceAll(
    "{alias}",
    item.alias ?? fallbacks[item.guidance] ?? "<alias>",
  );
}

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_PROTOCOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,47}$/;
const OPAQUE_SUFFIX_PATTERN = /^[a-f0-9]{6,12}$/i;
const CONVERSATION_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{8}$/;

function boundedText(value: unknown, maximumCharacters = 96): string {
  if (typeof value !== "string") return "";
  const characters = Array.from(value);
  return characters.length <= maximumCharacters
    ? value
    : `${characters.slice(0, maximumCharacters - 1).join("")}\u2026`;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

function safeProtocol(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PROTOCOL_PATTERN.test(value)
    ? value
    : undefined;
}

function normalizedInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function normalizedCounters(counters: Partial<RouteCounters> | undefined): RouteCounters {
  return {
    accepted: normalizedInteger(counters?.accepted) ?? 0,
    delivered: normalizedInteger(counters?.delivered) ?? 0,
    unconfirmed: normalizedInteger(counters?.unconfirmed) ?? 0,
    failed: normalizedInteger(counters?.failed) ?? 0,
    ambiguous: normalizedInteger(counters?.ambiguous) ?? 0,
    expired: normalizedInteger(counters?.expired) ?? 0,
    cancelled: normalizedInteger(counters?.cancelled) ?? 0,
    abandoned: normalizedInteger(counters?.abandoned) ?? 0,
    rejected: normalizedInteger(counters?.rejected) ?? 0,
    bytesAccepted: normalizedInteger(counters?.bytesAccepted) ?? 0,
  };
}

export function buildDashboardViewModel(
  snapshot: GatewayPublicSnapshot,
): DashboardViewModel {
  return buildProjectedDashboardViewModel(snapshot, false);
}

export function buildLiveDashboardViewModel(
  snapshot: GatewayPublicSnapshot,
): LiveDashboardViewModel {
  return buildProjectedDashboardViewModel(snapshot, true);
}

function routeIsReady(route: DashboardRouteRow): boolean {
  return (
    route.enabled &&
    (route.state === "idle" || route.state === "busy")
  );
}

function peerSelectionGuidance(
  peer: GatewayPublicSnapshot["availablePeers"][number],
): DashboardPeerRow["selectionGuidance"] {
  if (peer.safeErrorCode === "PEER_ALIAS_COLLISION") return "alias_collision";
  if (peer.safeErrorCode === "PEER_SESSION_COLLISION") return "session_collision";
  if (peer.safeErrorCode === "PEER_DISCOVERY_INCOMPLETE") {
    return "discovery_incomplete";
  }
  if (peer.state === "offline") return "offline";
  return undefined;
}

function peerIsSelectable(
  peer: GatewayPublicSnapshot["availablePeers"][number],
): boolean {
  return peer.validated && peerSelectionGuidance(peer) === undefined;
}

function partyStatus(
  routes: readonly DashboardRouteRow[],
  ready: number,
): DashboardExchangeParty["status"] {
  if (routes.length === 0) return "missing";
  if (ready === 0) {
    return routes.some((route) => route.state === "awaiting_approval")
      ? "waiting"
      : "attention";
  }
  return routes.some((route) => route.state === "busy") ? "busy" : "ready";
}

function routePriority(route: DashboardRouteRow): number {
  if (!route.enabled || route.state === "offline") {
    return 0;
  }
  if (route.state === "stale") return 1;
  if (route.state === "awaiting_approval") return 2;
  if (route.state === "busy") return 3;
  return 4;
}

const CODEX_APP_RECONNECT_GUIDANCE_AFTER_MS = 2_000;

function needsCodexAppReconnect(
  route: DashboardRouteRow,
  connectors: readonly DashboardConnectorRow[],
  generatedAt: string | undefined,
): boolean {
  if (
    route.provider !== "codex" ||
    route.state !== "stale" ||
    (route.safeErrorCode !== "CODEX_ROUTE_STALE" &&
      route.safeErrorCode !== "ENDPOINT_GENERATION_CHANGED") ||
    route.lastSeenAt === undefined ||
    generatedAt === undefined ||
    Date.parse(generatedAt) - Date.parse(route.lastSeenAt) <
      CODEX_APP_RECONNECT_GUIDANCE_AFTER_MS
  ) {
    return false;
  }
  return connectors.some(
    (connector) =>
      connector.provider === "codex" &&
      connector.host === route.host &&
      connector.health === "healthy",
  );
}

function alertPriority(severity: AlertSeverity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function guidanceFor(
  code: string | undefined,
  provider: GatewayProvider | undefined,
): DashboardAttentionItem["guidance"] {
  if (code === "CODEX_SUCCESSION_BARRIER_BUSY") {
    return "codex_succession_busy";
  }
  if (code?.startsWith("CODEX_SUCCESSION_") === true) {
    return "codex_succession_recovery";
  }
  if (
    provider === "codex" &&
    (code === "REOBSERVATION_REQUIRED" ||
      code === "CODEX_BOOT_REACTIVATION_SKIPPED")
  ) {
    return "codex_reactivation_required";
  }
  switch (code) {
    case "REOBSERVATION_REQUIRED":
      return provider === "claude" ? "reobserve_claude" : "reobserve_codex";
    case "PEER_NOT_OBSERVED":
    case "CLAUDE_PEER_NOT_OBSERVED":
      return "claude_not_observed";
    case "CODEX_ROUTE_STALE":
      return "codex_stale";
    case "CONNECTOR_OFFLINE":
      return "connector_offline";
    case "ROUTE_STALE":
      return "route_stale";
    case "QUEUE_STALLED":
      return "queue_stalled";
    case "CLAUDE_NATIVE_ACK_UNAVAILABLE":
    case "CLAUDE_RECEIPT_UNCONFIRMED":
      return "unconfirmed";
    case "ADAPTER_DEGRADED":
    case "ROUTE_DEGRADED":
      return "degraded";
    default:
      return "generic";
  }
}

function isCodexReactivationCondition(item: DashboardAttentionItem): boolean {
  return (
    item.provider === "codex" &&
    (item.code === "REOBSERVATION_REQUIRED" ||
      item.code === "CODEX_BOOT_REACTIVATION_SKIPPED")
  );
}

function coalesceCodexReactivationAlerts(
  alerts: readonly DashboardAttentionItem[],
  routes: readonly DashboardRouteRow[],
): DashboardAttentionItem[] {
  const staleCodexScopes = new Set(
    routes
      .filter((route) => route.provider === "codex" && route.state === "stale")
      .map((route) => `${route.alias}\0${route.host}`),
  );
  const coalesced: DashboardAttentionItem[] = [];
  for (const alert of alerts) {
    if (!isCodexReactivationCondition(alert)) {
      coalesced.push(alert);
      continue;
    }
    if (alert.alias === undefined || alert.host === undefined) continue;
    const scope = `${alert.alias}\0${alert.host}`;
    if (!staleCodexScopes.has(scope)) continue;
    const existingIndex = coalesced.findIndex(
      (candidate) =>
        isCodexReactivationCondition(candidate) &&
        candidate.alias === alert.alias &&
        candidate.host === alert.host,
    );
    if (existingIndex === -1) {
      coalesced.push(alert);
      continue;
    }
    const existing = coalesced[existingIndex]!;
    const bootSkipped = alert.code === "CODEX_BOOT_REACTIVATION_SKIPPED"
      ? alert
      : existing.code === "CODEX_BOOT_REACTIVATION_SKIPPED"
        ? existing
        : alert;
    const timestamp = compareText(
      alert.timestamp ?? "",
      existing.timestamp ?? "",
    ) >= 0 ? alert.timestamp : existing.timestamp;
    coalesced[existingIndex] = {
      ...bootSkipped,
      severity:
        alertPriority(alert.severity) < alertPriority(existing.severity)
          ? alert.severity
          : existing.severity,
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  }
  return coalesced;
}

function recipientIsUnobserved(route: DashboardRouteRow): boolean {
  return (
    route.provider === "claude" &&
    (route.safeErrorCode === "CLAUDE_PEER_NOT_OBSERVED" ||
      route.safeErrorCode === "PEER_NOT_OBSERVED")
  );
}

function queueAge(
  depth: number,
  oldestQueuedAt: string | undefined,
  generatedAt: string | undefined,
): number | undefined {
  if (depth === 0 || oldestQueuedAt === undefined || generatedAt === undefined) {
    return undefined;
  }
  const elapsed = Date.parse(generatedAt) - Date.parse(oldestQueuedAt);
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function messageKey(message: GatewayPublicSnapshot["messages"][number]): string {
  return [
    message.direction,
    boundedText(message.sourceAlias),
    boundedText(message.targetAlias),
    typeof message.messageIdSuffix === "string" ? message.messageIdSuffix : "",
  ].join("\0");
}

function buildMessageGroups(
  messages: GatewayPublicSnapshot["messages"],
  includeBodies: boolean,
): {
  groups: LiveDashboardMessageGroup[];
  omittedGroups: number;
  omittedEvents: number;
  activeGroups: number;
} {
  const grouped = new Map<string, GatewayPublicSnapshot["messages"]>();
  for (const message of messages) {
    const key = messageKey(message);
    const events = grouped.get(key);
    if (events === undefined) grouped.set(key, [message]);
    else events.push(message);
  }
  const all = [...grouped.values()]
    .map((events): LiveDashboardMessageGroup => {
      const ordered = [...events].sort((left, right) => {
        const byTime = compareText(
          normalizedTimestamp(left.timestamp) ?? "",
          normalizedTimestamp(right.timestamp) ?? "",
        );
        return byTime ||
          (normalizedInteger(left.sequence) ?? 0) -
            (normalizedInteger(right.sequence) ?? 0);
      });
      const latest = ordered[ordered.length - 1]!;
      const allEvents = ordered.map(
        (event): DashboardMessageEvent => ({
          sequence: normalizedInteger(event.sequence) ?? 0,
          ...(normalizedTimestamp(event.timestamp) === undefined
            ? {}
            : { timestamp: normalizedTimestamp(event.timestamp) }),
          state: event.state,
          ...(normalizedInteger(event.latencyMs) === undefined
            ? {}
            : { latencyMs: normalizedInteger(event.latencyMs) }),
          ...(safeCode(event.safeErrorCode) === undefined
            ? {}
            : { safeErrorCode: safeCode(event.safeErrorCode) }),
          ...(typeof event.conversationIdSuffix === "string" &&
          CONVERSATION_SUFFIX_PATTERN.test(event.conversationIdSuffix)
            ? { conversationIdSuffix: event.conversationIdSuffix }
            : {}),
          ...(event.steer === true ? { steer: true as const } : {}),
        }),
      );
      return {
        direction: latest.direction,
        sourceAlias: boundedText(latest.sourceAlias),
        targetAlias: boundedText(latest.targetAlias),
        ...(typeof latest.messageIdSuffix === "string" &&
        OPAQUE_SUFFIX_PATTERN.test(latest.messageIdSuffix)
          ? { messageIdSuffix: latest.messageIdSuffix.toLowerCase() }
          : {}),
        ...(typeof latest.conversationIdSuffix === "string" &&
        CONVERSATION_SUFFIX_PATTERN.test(latest.conversationIdSuffix)
          ? { conversationIdSuffix: latest.conversationIdSuffix }
          : {}),
        state: latest.state,
        ...(normalizedTimestamp(latest.timestamp) === undefined
          ? {}
          : { timestamp: normalizedTimestamp(latest.timestamp) }),
        ...(normalizedInteger(latest.latencyMs) === undefined
          ? {}
          : { latencyMs: normalizedInteger(latest.latencyMs) }),
        bytes: normalizedInteger(latest.bytes) ?? 0,
        ...(safeCode(latest.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(latest.safeErrorCode) }),
        ...(latest.steer === true ? { steer: true as const } : {}),
        // Bodies are first-class observable data (CO #36); the display copy
        // is bounded so one 16 KiB message cannot dominate the view model.
        ...(includeBodies &&
        typeof latest.body === "string" && latest.body.length > 0
          ? { body: boundedText(latest.body, 4096) }
          : {}),
        events: allEvents,
      };
    })
    .sort((left, right) =>
      compareText(right.timestamp ?? "", left.timestamp ?? "") ||
      compareText(left.sourceAlias, right.sourceAlias),
    );
  let eventBudget = DASHBOARD_MODEL_LIMITS.messageEvents;
  let omittedEvents = 0;
  const displayedGroups = all.slice(0, DASHBOARD_MODEL_LIMITS.messages);
  const visibleGroups = displayedGroups.map(
    (group, index): LiveDashboardMessageGroup => {
      const groupsAfterThis = displayedGroups.length - index - 1;
      const availableForThis = Math.max(1, eventBudget - groupsAfterThis);
      const retained = Math.min(availableForThis, group.events.length);
      eventBudget -= retained;
      omittedEvents += group.events.length - retained;
      return {
        ...group,
        events: retained === 0 ? [] : group.events.slice(-retained),
      };
    },
  );
  return {
    groups: visibleGroups,
    omittedGroups: Math.max(0, all.length - DASHBOARD_MODEL_LIMITS.messages),
    omittedEvents,
    activeGroups: all.filter((message) =>
      ["queued", "dispatching", "transport_written", "held"].includes(
        message.state,
      ),
    ).length,
  };
}

function buildProjectedDashboardViewModel(
  snapshot: GatewayPublicSnapshot,
  includeBodies: boolean,
): LiveDashboardViewModel {
  const generatedAt = normalizedTimestamp(snapshot.generatedAt);
  const inboundMode = snapshot.inboundMode === "open" ? "open" : "paired";
  const validPeers = arePublicAvailablePeerSnapshots(snapshot.availablePeers)
    ? snapshot.availablePeers
    : [];
  const peers = validPeers
    .map(
      (peer): DashboardPeerRow => ({
        alias: boundedText(peer.alias),
        host: boundedText(peer.host),
        state: peer.state,
        validated: peer.validated,
        selected: peer.selected,
        selectable: peerIsSelectable(peer),
        ...(peerSelectionGuidance(peer) === undefined
          ? {}
          : { selectionGuidance: peerSelectionGuidance(peer) }),
        ...(normalizedTimestamp(peer.lastSeenAt) === undefined
          ? {}
          : { lastSeenAt: normalizedTimestamp(peer.lastSeenAt) }),
        ...(safeCode(peer.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(peer.safeErrorCode) }),
      }),
    )
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      return compareText(left.alias, right.alias);
    })
    .slice(0, DASHBOARD_MODEL_LIMITS.availablePeers);
  const allBrokerActivity: DashboardActivityEventRow[] = (
    snapshot.activityEvents ?? []
  ).flatMap((event) => {
    const timestamp = normalizedTimestamp(event.timestamp);
    const sequence = normalizedInteger(event.sequence);
    if (timestamp === undefined || sequence === undefined || sequence < 1) {
      return [];
    }
    return [
      {
        sequence,
        timestamp,
        kind: event.kind,
        action: event.action,
        outcome: event.outcome,
        aliases: event.aliases.map((alias) => boundedText(alias)).slice(0, 2),
        operatorAction: event.operatorAction,
        ...(safeCode(event.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(event.safeErrorCode) }),
      },
    ];
  });
  const brokerActivity = allBrokerActivity.slice(
    -DASHBOARD_MODEL_LIMITS.activityEvents,
  );

  const allRoutes = snapshot.routes.map((route): DashboardRouteRow => {
    const depth = normalizedInteger(route.queueDepth) ?? 0;
    const oldestQueuedAt = normalizedTimestamp(route.oldestQueuedAt);
    const age = queueAge(depth, oldestQueuedAt, generatedAt);
    return {
      alias: boundedText(route.alias),
      provider: route.provider,
      host: boundedText(route.host),
      enabled: Boolean(route.enabled),
      state: route.state,
      queueDepth: depth,
      ...(oldestQueuedAt === undefined ? {} : { oldestQueuedAt }),
      ...(age === undefined ? {} : { queueAgeMs: age }),
      counters: normalizedCounters(route.counters),
      ...(normalizedTimestamp(route.lastSeenAt) === undefined
        ? {}
        : { lastSeenAt: normalizedTimestamp(route.lastSeenAt) }),
      ...(safeCode(route.safeErrorCode) === undefined
        ? {}
        : { safeErrorCode: safeCode(route.safeErrorCode) }),
    };
  });
  const routes = [...allRoutes]
    .sort((left, right) =>
      routePriority(left) - routePriority(right) ||
      compareText(left.alias, right.alias),
    )
    .slice(0, DASHBOARD_MODEL_LIMITS.routes);

  const routeByEndpoint = new Map(
    allRoutes.map((route) => [`${route.provider}\0${route.alias}`, route]),
  );
  const allConsentEdges = snapshot.consentEdges
    .map((edge): DashboardConsentEdgeRow => {
      const endpoints = edge.endpoints.map((endpoint) => ({
        alias: boundedText(endpoint.alias),
        provider: endpoint.provider,
      })) as [DashboardConsentEndpoint, DashboardConsentEndpoint];
      const routes = endpoints.map((endpoint) =>
        routeByEndpoint.get(`${endpoint.provider}\0${endpoint.alias}`)
      );
      const bothPresent = routes.every((route) => route !== undefined);
      return {
        endpoints,
        host: boundedText(edge.host),
        state:
          bothPresent &&
          routes.every((route) => route !== undefined && routeIsReady(route))
            ? "ready"
            : bothPresent
              ? "degraded"
              : "unavailable",
        counters: normalizedCounters(edge.counters),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.endpoints[0].provider, right.endpoints[0].provider) ||
        compareText(left.endpoints[0].alias, right.endpoints[0].alias) ||
        compareText(left.endpoints[1].provider, right.endpoints[1].provider) ||
        compareText(left.endpoints[1].alias, right.endpoints[1].alias),
    );
  const consentEdges = allConsentEdges.slice(0, DASHBOARD_MODEL_LIMITS.consentEdges);

  const allWatches: DashboardProgressWatchRow[] = (
    snapshot.progressWatches ?? []
  )
    .flatMap((watch): DashboardProgressWatchRow[] => {
      const lastActivityAt = normalizedTimestamp(watch.lastActivityAt);
      const nextActionAt = normalizedTimestamp(watch.nextActionAt);
      const generatedAtMs = generatedAt === undefined ? undefined : Date.parse(generatedAt);
      if (
        !CONVERSATION_SUFFIX_PATTERN.test(watch.conversationIdSuffix) ||
        lastActivityAt === undefined ||
        nextActionAt === undefined ||
        generatedAtMs === undefined
      ) {
        return [];
      }
      if (
        watch.nudgeCount !== 0 &&
        watch.nudgeCount !== 1 &&
        watch.nudgeCount !== 2
      ) {
        return [];
      }
      return [
        {
          conversationIdSuffix: watch.conversationIdSuffix,
          ownerAlias: boundedText(watch.ownerAlias),
          workerAlias: boundedText(watch.workerAlias),
          lastActivityAt,
          nextActionAt,
          idleForMs: Math.max(0, generatedAtMs - Date.parse(lastActivityAt)),
          dueInMs: Math.max(0, Date.parse(nextActionAt) - generatedAtMs),
          nudgeCount: watch.nudgeCount,
        },
      ];
    })
    .sort(
      (left, right) =>
        compareText(left.nextActionAt, right.nextActionAt) ||
        compareText(left.ownerAlias, right.ownerAlias) ||
        compareText(left.workerAlias, right.workerAlias),
    );
  const watches = allWatches.slice(0, DASHBOARD_MODEL_LIMITS.progressWatches);
  const allWatchEvents: DashboardProgressWatchEventRow[] = (
    snapshot.progressWatchEvents ?? []
  )
    .flatMap((event): DashboardProgressWatchEventRow[] => {
      const timestamp = normalizedTimestamp(event.timestamp);
      if (
        timestamp === undefined ||
        !CONVERSATION_SUFFIX_PATTERN.test(event.conversationIdSuffix) ||
        normalizedInteger(event.sequence) === undefined
      ) {
        return [];
      }
      return [
        {
          sequence: event.sequence,
          timestamp,
          conversationIdSuffix: event.conversationIdSuffix,
          ownerAlias: boundedText(event.ownerAlias),
          workerAlias: boundedText(event.workerAlias),
          kind: event.kind,
          actor: event.actor,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      ];
    })
    .sort((left, right) => right.sequence - left.sequence);
  const watchEvents = allWatchEvents.slice(
    0,
    DASHBOARD_MODEL_LIMITS.progressWatchEvents,
  );

  const connectors = snapshot.connectors
    .map((connector): DashboardConnectorRow => {
      const registry = isPublicRegistryObservationSnapshot(connector.registry)
        ? connector.registry
        : undefined;
      return {
        provider: connector.provider,
        host: boundedText(connector.host),
        health: connector.health,
        ...(safeProtocol(connector.protocol) === undefined
          ? {}
          : { protocol: safeProtocol(connector.protocol) }),
        ...(safeProtocol(connector.protocolVersion) === undefined
          ? {}
          : { protocolVersion: safeProtocol(connector.protocolVersion) }),
        ...(normalizedTimestamp(connector.lastSeenAt) === undefined
          ? {}
          : { lastSeenAt: normalizedTimestamp(connector.lastSeenAt) }),
        ...(connector.codexDoctor === undefined
          ? {}
          : {
              codexDoctor: {
                conditions: [...connector.codexDoctor.conditions],
              },
            }),
        ...(safeCode(connector.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(connector.safeErrorCode) }),
        ...(registry === undefined
          ? {}
          : {
              registry: {
                entriesScanned: registry.entriesScanned,
                parseableRecords: registry.parseableRecords,
                parseableRecordSeenSinceBoot:
                  registry.parseableRecordSeenSinceBoot,
                rejected: registry.rejected.map((row) => ({ ...row })),
                rejectedCodesOmitted: registry.rejectedCodesOmitted,
              },
            }),
      };
    })
    .sort((left, right) =>
      compareText(`${left.provider}\0${left.host}`, `${right.provider}\0${right.host}`),
    )
    .slice(0, DASHBOARD_MODEL_LIMITS.connectors);
  const messages = buildMessageGroups(snapshot.messages, includeBodies);
  const queuedMessages = allRoutes.reduce(
    (total, route) => boundedAdd(total, route.queueDepth),
    0,
  );
  const queuedWithAge = allRoutes
    .filter(
      (route): route is DashboardRouteRow & {
        oldestQueuedAt: string;
        queueAgeMs: number;
      } => route.oldestQueuedAt !== undefined && route.queueAgeMs !== undefined,
    )
    .sort((left, right) => right.queueAgeMs - left.queueAgeMs);
  const oldest = queuedWithAge[0];
  const activeDeliveries = messages.activeGroups;

  const routesByProvider = Object.fromEntries(
    gatewayProviders.map((provider) => [
      provider,
      allRoutes.filter((route) => route.provider === provider),
    ]),
  ) as Record<GatewayProvider, DashboardRouteRow[]>;
  const readyByProvider = Object.fromEntries(
    gatewayProviders.map((provider) => [
      provider,
      routesByProvider[provider].filter(routeIsReady).length,
    ]),
  ) as Record<GatewayProvider, number>;
  const pairedAliasesByProvider = Object.fromEntries(
    gatewayProviders.map((provider) => [provider, new Set<string>()]),
  ) as Record<GatewayProvider, Set<string>>;
  for (const edge of allConsentEdges) {
    for (const endpoint of edge.endpoints) {
      pairedAliasesByProvider[endpoint.provider].add(endpoint.alias);
    }
  }
  const readyConsentEdges = allConsentEdges.filter((edge) => edge.state === "ready");
  const consentEdgeCountIsLowerBound =
    (normalizedInteger(snapshot.truncation.consentEdges) ?? 0) > 0;
  const hasConsentEvidence =
    allConsentEdges.length > 0 || consentEdgeCountIsLowerBound;
  const graph: DashboardGraphFacts = {
    consentEdgeCount: allConsentEdges.length,
    readyConsentEdgeCount: readyConsentEdges.length,
    consentEdgeCountIsLowerBound,
    unpairedReadyByProvider: Object.fromEntries(
      gatewayProviders.map((provider) => [
        provider,
        routesByProvider[provider].filter(
          (route) => routeIsReady(route) &&
            !pairedAliasesByProvider[provider].has(route.alias),
        ).length,
      ]),
    ) as Record<GatewayProvider, number>,
  };
  const selectedPeers = validPeers.filter(
    (peer) => peer.selected && peerIsSelectable(peer),
  );
  const selectablePeers = validPeers.filter(peerIsSelectable);
  const selectedClaudeCount = Math.max(
    selectedPeers.filter((peer) => peer.provider === "claude").length,
    readyByProvider.claude,
  );
  const readyPairedByProvider = Object.fromEntries(
    gatewayProviders.map((provider) => [
      provider,
      routesByProvider[provider].some(
        (route) => routeIsReady(route) &&
          pairedAliasesByProvider[provider].has(route.alias),
      ),
    ]),
  ) as Record<GatewayProvider, boolean>;
  const claudeNextAction: DashboardNextAction =
    selectedClaudeCount > 0 &&
    (readyPairedByProvider.claude ||
      (consentEdgeCountIsLowerBound && readyByProvider.claude > 0))
      ? "none"
      : readyByProvider.claude > 0
        ? "pair_routes"
        : validPeers.length === 0
          ? "discover_claude"
          : selectablePeers.length > 0
            ? !hasConsentEvidence
              ? "pair_routes"
              : "restore_claude"
            : selectedPeers.length > 0
              ? "restore_claude"
              : "repair_claude_inventory";
  const codexNextAction: DashboardNextAction =
    readyPairedByProvider.codex ||
    (consentEdgeCountIsLowerBound && readyByProvider.codex > 0)
      ? "none"
      : readyByProvider.codex > 0
        ? "pair_routes"
        : routesByProvider.codex.length === 0
          ? "register_codex"
          : "restore_codex";
  const parties = gatewayProviders.map((provider): DashboardExchangeParty => {
      const providerPeers = validPeers.filter((peer) => peer.provider === provider);
      const providerRoutes = routesByProvider[provider];
      const ready = provider === "claude"
        ? selectedClaudeCount
        : readyByProvider[provider];
      const nextAction: DashboardNextAction = provider === "claude"
        ? claudeNextAction
        : provider === "codex"
          ? codexNextAction
          : readyPairedByProvider[provider]
            ? "none"
            : ready > 0
              ? "pair_routes"
              : "none";
      return {
        kind: provider,
        status:
          provider === "claude" && ready > 0 && partyStatus(providerRoutes, ready) === "missing"
            ? "attention"
            : partyStatus(providerRoutes, ready),
        total: provider === "claude" ? providerPeers.length : providerRoutes.length,
        ready,
        ...(provider === "claude"
          ? { selectable: selectablePeers.filter((peer) => peer.provider === provider).length }
          : {}),
        countIsLowerBound:
          (normalizedInteger(snapshot.truncation.routes) ?? 0) > 0 ||
          (provider === "claude" &&
            (normalizedInteger(snapshot.truncation.availablePeers) ?? 0) > 0),
        ...(providerPeers.find((peer) => peer.selected)?.alias === undefined
          ? providerRoutes[0]?.alias === undefined
            ? {}
            : { primaryAlias: boundedText(providerRoutes[0].alias) }
          : { primaryAlias: boundedText(providerPeers.find((peer) => peer.selected)!.alias) }),
        nextAction,
      };
  });

  const explicitAlerts = coalesceCodexReactivationAlerts(
    snapshot.alerts
      .map((alert): DashboardAttentionItem => {
        const code = safeCode(alert.code);
        const route =
          code === "QUEUE_STALLED" && typeof alert.alias === "string" &&
            alert.provider !== undefined
            ? routeByEndpoint.get(`${alert.provider}\0${alert.alias}`)
            : undefined;
        const alertRoute =
          typeof alert.alias === "string" && alert.provider !== undefined
            ? routeByEndpoint.get(`${alert.provider}\0${alert.alias}`)
            : undefined;
        return {
          kind: "alert",
          ...(code === undefined ? {} : { code }),
          severity:
            alert.severity === "error" ||
            alert.severity === "warning" ||
            alert.severity === "info"
              ? alert.severity
              : "warning",
          ...(normalizedTimestamp(alert.timestamp) === undefined
            ? {}
            : { timestamp: normalizedTimestamp(alert.timestamp) }),
          ...(alert.provider === undefined ? {} : { provider: alert.provider }),
          ...(typeof alert.alias === "string"
            ? { alias: boundedText(alert.alias) }
            : {}),
          ...(typeof alert.host === "string"
            ? { host: boundedText(alert.host) }
            : {}),
          ...(alert.provider === "codex" &&
            typeof alert.host === "string" &&
            route !== undefined &&
            alert.host === route.host &&
            route.provider === "codex" &&
            route.state === "busy" &&
            route.queueDepth > 0
              ? { queueDepth: route.queueDepth }
              : {}),
          guidance:
            alertRoute !== undefined &&
            needsCodexAppReconnect(alertRoute, connectors, generatedAt)
              ? "codex_app_reconnect_required"
              : guidanceFor(code, alert.provider),
        };
      }),
    allRoutes,
  ).sort((left, right) =>
    alertPriority(left.severity) - alertPriority(right.severity) ||
    compareText(right.timestamp ?? "", left.timestamp ?? ""),
  );
  const attentionCandidates: DashboardAttentionItem[] = [...explicitAlerts];
  const unavailableConsentEdgeScopes = new Set<string>();
  for (const edge of allConsentEdges) {
    if (edge.state !== "unavailable") continue;
    for (const endpoint of edge.endpoints) {
      if (routeByEndpoint.has(`${endpoint.provider}\0${endpoint.alias}`)) continue;
      const scope = `${endpoint.provider}\0${endpoint.alias}\0${edge.host}`;
      if (unavailableConsentEdgeScopes.has(scope)) continue;
      unavailableConsentEdgeScopes.add(scope);
      attentionCandidates.push({
        kind: "route",
        severity: "warning",
        provider: endpoint.provider,
        alias: endpoint.alias,
        host: edge.host,
        guidance: "consent_edge_unavailable",
      });
    }
  }
  for (const route of allRoutes) {
    const writes = messages.groups.filter(
      ({ direction, targetAlias, state, timestamp }) =>
        parseDirection(direction)?.targetProvider === "claude" &&
        targetAlias === route.alias && state === "delivered" &&
        timestamp !== undefined,
    );
    // Groups arrive newest-first. The oldest unconsumed write owns the notice:
    // a fresh write to the same recipient is not evidence that an hours-old one
    // was ever read.
    const write = writes[writes.length - 1];
    if (
      generatedAt === undefined || write?.timestamp === undefined ||
      !recipientIsUnobserved(route) ||
      Date.parse(generatedAt) - Date.parse(write.timestamp) <
        120_000
    ) continue;
    const item: DashboardAttentionItem = {
      kind: "route",
      code: route.safeErrorCode,
      severity: "warning",
      ...(route.lastSeenAt === undefined ? {} : { timestamp: route.lastSeenAt }),
      provider: route.provider,
      alias: route.alias,
      host: route.host,
      guidance: "recipient_waiting_input",
    };
    const existingIndex = attentionCandidates.findIndex(
      (candidate) =>
        candidate.provider === item.provider &&
        candidate.alias === item.alias &&
        (candidate.code === "CLAUDE_PEER_NOT_OBSERVED" ||
          candidate.code === "PEER_NOT_OBSERVED"),
    );
    if (existingIndex === -1) attentionCandidates.push(item);
    else attentionCandidates[existingIndex] = item;
  }
  for (const watch of allWatches) {
    if (watch.nudgeCount === 0) continue;
    attentionCandidates.push({
      kind: "watch",
      code: "PROGRESS_WATCH_QUIET",
      severity: "warning",
      timestamp: watch.lastActivityAt,
      alias: watch.workerAlias,
      guidance: "progress_watch",
    });
  }
  const representedScopes = new Set(
    attentionCandidates.map(
      (item) =>
        `${item.provider ?? ""}\0${item.alias ?? ""}\0${item.host ?? ""}`,
    ),
  );
  for (const route of allRoutes) {
    if (routeIsReady(route)) {
      continue;
    }
    const scope = `${route.provider}\0${route.alias}\0${route.host}`;
    if (representedScopes.has(scope)) continue;
    attentionCandidates.push({
      kind: "route",
      ...(route.safeErrorCode === undefined ? {} : { code: route.safeErrorCode }),
      severity: route.state === "offline" ? "error" : "warning",
      ...(route.lastSeenAt === undefined ? {} : { timestamp: route.lastSeenAt }),
      provider: route.provider,
      alias: route.alias,
      host: route.host,
      guidance:
        route.provider === "codex" &&
        route.state === "stale" &&
        route.safeErrorCode === "REOBSERVATION_REQUIRED"
          ? "codex_reactivation_required"
          : needsCodexAppReconnect(route, connectors, generatedAt)
            ? "codex_app_reconnect_required"
            : route.provider === "codex" && route.state === "stale"
              ? "codex_stale"
              : "route_stale",
    });
    representedScopes.add(scope);
  }
  for (const connector of connectors) {
    if (connector.health === "healthy") continue;
    const scope = `${connector.provider}\0\0${connector.host}`;
    if (representedScopes.has(scope)) continue;
    attentionCandidates.push({
      kind: "connector",
      ...(connector.safeErrorCode === undefined
        ? {}
        : { code: connector.safeErrorCode }),
      severity: connector.health === "degraded" ? "warning" : "error",
      ...(connector.lastSeenAt === undefined
        ? {}
        : { timestamp: connector.lastSeenAt }),
      provider: connector.provider,
      host: connector.host,
      guidance:
        connector.health === "offline"
          ? "connector_offline"
          : "degraded",
    });
    representedScopes.add(scope);
  }
  for (const connector of connectors) {
    const observation = connector.registry;
    if (observation === undefined) continue;
    if (
      observation.rejected.length > 0 ||
      observation.rejectedCodesOmitted > 0
    ) {
      const item: DashboardAttentionItem = {
        kind: "connector",
        code: observation.rejected.some(
          (row) => row.safeErrorCode === "CLAUDE_REGISTRY_UNAVAILABLE",
        )
          ? "CLAUDE_REGISTRY_UNAVAILABLE"
          : "CLAUDE_REGISTRY_RECORDS_REJECTED",
        severity: "warning",
        provider: "claude",
        host: connector.host,
        guidance: "registry_rejected",
      };
      const duplicateIndex = attentionCandidates.findIndex(
        (candidate) =>
          candidate.code === item.code &&
          candidate.provider === item.provider &&
          candidate.alias === item.alias &&
          candidate.host === item.host,
      );
      if (duplicateIndex === -1) attentionCandidates.push(item);
      else attentionCandidates[duplicateIndex] = item;
      continue;
    }
    if (observation.parseableRecordSeenSinceBoot) continue;
    attentionCandidates.push({
      kind: "connector",
      code:
        observation.entriesScanned === 0
          ? "CLAUDE_REGISTRY_EMPTY_SINCE_BOOT"
          : "CLAUDE_REGISTRY_NO_PARSEABLE_RECORD_SINCE_BOOT",
      severity: "warning",
      provider: "claude",
      host: connector.host,
      guidance: "registry_empty",
    });
  }
  if (
    (snapshot.health === "degraded" || snapshot.health === "offline") &&
    !attentionCandidates.some((item) => item.kind === "broker")
  ) {
    attentionCandidates.push({
      kind: "broker",
      severity: snapshot.health === "degraded" ? "warning" : "error",
      guidance:
        snapshot.health === "offline" ? "connector_offline" : "degraded",
    });
  }
  const attention = attentionCandidates.slice(0, DASHBOARD_MODEL_LIMITS.alerts);

  const setupComplete = hasConsentEvidence;
  const hasDegradedConsentEdge = allConsentEdges.some((edge) => edge.state !== "ready");
  const overall =
    attentionCandidates.length > 0 ||
    (normalizedInteger(snapshot.truncation.alerts) ?? 0) > 0 ||
    hasDegradedConsentEdge
      ? "attention"
      : setupComplete
        ? "ready"
        : "setup";
  const omissions: DashboardOmissions = {
    connectors: boundedAdd(
      normalizedInteger(snapshot.truncation.connectors) ?? 0,
      Math.max(0, snapshot.connectors.length - DASHBOARD_MODEL_LIMITS.connectors),
    ),
    availablePeers: boundedAdd(
      normalizedInteger(snapshot.truncation.availablePeers) ?? 0,
      Math.max(0, validPeers.length - DASHBOARD_MODEL_LIMITS.availablePeers),
    ),
    routes: boundedAdd(
      normalizedInteger(snapshot.truncation.routes) ?? 0,
      Math.max(0, allRoutes.length - DASHBOARD_MODEL_LIMITS.routes),
    ),
    consentEdges: boundedAdd(
      normalizedInteger(snapshot.truncation.consentEdges) ?? 0,
      Math.max(0, allConsentEdges.length - DASHBOARD_MODEL_LIMITS.consentEdges),
    ),
    progressWatches: boundedAdd(
      normalizedInteger(snapshot.truncation.progressWatches) ?? 0,
      Math.max(0, allWatches.length - DASHBOARD_MODEL_LIMITS.progressWatches),
    ),
    upstreamProgressWatchEvents:
      normalizedInteger(snapshot.truncation.progressWatchEvents) ?? 0,
    progressWatchEvents: Math.max(
      0,
      allWatchEvents.length - DASHBOARD_MODEL_LIMITS.progressWatchEvents,
    ),
    upstreamMessageEvents:
      normalizedInteger(snapshot.truncation.messages) ?? 0,
    messageGroups: messages.omittedGroups,
    messageEvents: messages.omittedEvents,
    upstreamAlerts: normalizedInteger(snapshot.truncation.alerts) ?? 0,
    attentionItems: Math.max(
      0,
      attentionCandidates.length - DASHBOARD_MODEL_LIMITS.alerts,
    ),
    upstreamActivityEvents:
      normalizedInteger(snapshot.truncation.activityEvents) ?? 0,
    activityEvents: Math.max(
      0,
      allBrokerActivity.length - DASHBOARD_MODEL_LIMITS.activityEvents,
    ),
  };

  return {
    schemaVersion: 2,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    inboundMode,
    health: snapshot.health,
    overall,
    exchange: {
      parties,
      queuedMessages,
      queueCountIsLowerBound:
        (normalizedInteger(snapshot.truncation.routes) ?? 0) > 0,
      ...(oldest === undefined
        ? {}
        : {
            oldestQueueAgeMs: oldest.queueAgeMs,
            oldestQueuedAt: oldest.oldestQueuedAt,
          }),
    },
    attention,
    transit: {
      queuedMessages,
      activeDeliveries,
      queueCountIsLowerBound:
        (normalizedInteger(snapshot.truncation.routes) ?? 0) > 0,
      activeCountIsLowerBound:
        (normalizedInteger(snapshot.truncation.messages) ?? 0) > 0,
      ...(oldest === undefined
        ? {}
        : {
            oldestQueueAgeMs: oldest.queueAgeMs,
            oldestQueuedAt: oldest.oldestQueuedAt,
          }),
    },
    activity: messages.groups,
    brokerActivity,
    peers,
    routes,
    consentEdges,
    watches,
    watchEvents,
    graph,
    connectors,
    accounting: {
      accepted: normalizedInteger(snapshot.accounting.accepted) ?? 0,
      duplicates: normalizedInteger(snapshot.accounting.duplicates) ?? 0,
      delivered: normalizedInteger(snapshot.accounting.delivered) ?? 0,
      unconfirmed: normalizedInteger(snapshot.accounting.unconfirmed) ?? 0,
      failed: normalizedInteger(snapshot.accounting.failed) ?? 0,
      ambiguous: normalizedInteger(snapshot.accounting.ambiguous) ?? 0,
      expired: normalizedInteger(snapshot.accounting.expired) ?? 0,
      cancelled: normalizedInteger(snapshot.accounting.cancelled) ?? 0,
      abandoned: normalizedInteger(snapshot.accounting.abandoned) ?? 0,
      rejected: normalizedInteger(snapshot.accounting.rejected) ?? 0,
      bytesAccepted: normalizedInteger(snapshot.accounting.bytesAccepted) ?? 0,
      queuedBytes: normalizedInteger(snapshot.accounting.queuedBytes) ?? 0,
    },
    ...(snapshot.deadlinePressure === undefined
      ? {}
      : { deadlinePressure: snapshot.deadlinePressure }),
    omissions,
  };
}
