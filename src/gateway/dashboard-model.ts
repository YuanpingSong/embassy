import { arePublicAvailablePeerSnapshots } from "./types.js";
import {
  isCompatibilityAttestation,
  type CompatibilityCertificationDepth,
  type CompatibilityTier,
  type CompatibilitySurface,
} from "./compatibility.js";
import type {
  AlertSeverity,
  CompatibilityState,
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
  pairs: 64,
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
  kind: "claude" | "codex";
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
  guidance:
    | "reobserve_claude"
    | "reobserve_codex"
    | "claude_not_observed"
    | "codex_stale"
    | "connector_offline"
    | "route_stale"
    | "queue_stalled"
    | "unconfirmed"
    | "degraded"
    | "codex_succession_busy"
    | "codex_succession_recovery"
    | "progress_watch"
    | "generic";
}>;

export type DashboardProgressWatchRow = Readonly<{
  conversationIdSuffix: string;
  ownerAlias: string;
  workerAlias: string;
  phase: "quiet" | "episode";
  capability: "conversation" | "route";
  lastActivityAt: string;
  nextActionAt: string;
  idleMs: number;
  idleForMs: number;
  dueInMs: number;
  nudgeCount: 0 | 1 | 2;
  workerReportedComplete: boolean;
}>;

export type DashboardProgressWatchEventRow = Readonly<{
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
  nudgeNumber?: 1 | 2 | undefined;
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
  compatibility: CompatibilityState;
  validated: boolean;
  selected: boolean;
  selectable: boolean;
  selectionGuidance?:
    | "alias_collision"
    | "session_collision"
    | "discovery_incomplete"
    | "incompatible"
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
  compatibility: CompatibilityState;
  queueDepth: number;
  oldestQueuedAt?: string | undefined;
  queueAgeMs?: number | undefined;
  counters: RouteCounters;
  lastSeenAt?: string | undefined;
  safeErrorCode?: string | undefined;
}>;

export type DashboardPairRow = Readonly<{
  claudeAlias: string;
  codexAlias: string;
  host: string;
  state: "ready" | "degraded" | "unavailable";
  counters: RouteCounters;
}>;

export type DashboardGraphFacts = Readonly<{
  pairCount: number;
  readyPairCount: number;
  pairCountIsLowerBound: boolean;
  unpairedReadyClaude: number;
  unpairedReadyCodex: number;
}>;

export type DashboardConnectorRow = Readonly<{
  provider: GatewayProvider;
  host: string;
  health: ConnectorHealth;
  compatibility: CompatibilityState;
  protocol?: string | undefined;
  protocolVersion?: string | undefined;
  lastSeenAt?: string | undefined;
  safeErrorCode?: string | undefined;
}>;

export type DashboardCompatibilityCheckRow = Readonly<{
  surface: CompatibilitySurface;
  version: string;
  tier: CompatibilityTier;
  checkedAt: string;
  certificationDepth?: CompatibilityCertificationDepth | undefined;
  certificationOutcome?: "pass" | "fail" | undefined;
  certifiedAt?: string | undefined;
  certificationSafeErrorCode?: string | undefined;
  failedProbe?: string | undefined;
  safeErrorCode?: string | undefined;
}>;

export type DashboardOmissions = Readonly<{
  connectors: number;
  availablePeers: number;
  routes: number;
  pairs: number;
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
  schemaVersion: 1;
  generatedAt?: string | undefined;
  inboundMode: "paired" | "open";
  health: ConnectorHealth;
  overall: "ready" | "setup" | "attention";
  exchange: Readonly<{
    claude: DashboardExchangeParty;
    codex: DashboardExchangeParty;
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
  pairs: readonly DashboardPairRow[];
  watches: readonly DashboardProgressWatchRow[];
  watchEvents: readonly DashboardProgressWatchEventRow[];
  graph: DashboardGraphFacts;
  connectors: readonly DashboardConnectorRow[];
  compatibilityChecks: readonly DashboardCompatibilityCheckRow[];
  accounting: GatewayPublicSnapshot["accounting"];
  deadlinePressure?: GatewayPublicSnapshot["deadlinePressure"];
  omissions: DashboardOmissions;
}>;

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

function routeIsReady(route: DashboardRouteRow): boolean {
  return (
    route.enabled &&
    route.compatibility === "compatible" &&
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
  if (
    peer.state === "incompatible" ||
    peer.compatibility !== "compatible" ||
    peer.safeErrorCode !== undefined
  ) {
    return "incompatible";
  }
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
  if (!route.enabled || route.state === "offline" || route.state === "incompatible") {
    return 0;
  }
  if (route.state === "stale" || route.compatibility !== "compatible") return 1;
  if (route.state === "awaiting_approval") return 2;
  if (route.state === "busy") return 3;
  return 4;
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
): {
  groups: DashboardMessageGroup[];
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
    .map((events): DashboardMessageGroup => {
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
    (group, index): DashboardMessageGroup => {
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

export function buildDashboardViewModel(
  snapshot: GatewayPublicSnapshot,
): DashboardViewModel {
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
        compatibility: peer.compatibility,
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
      compatibility: route.compatibility,
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

  const routeByAlias = new Map(allRoutes.map((route) => [route.alias, route]));
  const allPairs = snapshot.pairs
    .map((pair): DashboardPairRow => {
      const claudeAlias = boundedText(pair.claudeAlias);
      const codexAlias = boundedText(pair.codexAlias);
      const claudeRoute = routeByAlias.get(claudeAlias);
      const codexRoute = routeByAlias.get(codexAlias);
      const bothPresent = claudeRoute !== undefined && codexRoute !== undefined;
      return {
        claudeAlias,
        codexAlias,
        host: boundedText(pair.host),
        state:
          bothPresent && routeIsReady(claudeRoute) && routeIsReady(codexRoute)
            ? "ready"
            : bothPresent
              ? "degraded"
              : "unavailable",
        counters: normalizedCounters(pair.counters),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.claudeAlias, right.claudeAlias) ||
        compareText(left.codexAlias, right.codexAlias),
    );
  const pairs = allPairs.slice(0, DASHBOARD_MODEL_LIMITS.pairs);

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
      const idleMs = normalizedInteger(watch.idleMs);
      if (
        idleMs === undefined ||
        (watch.nudgeCount !== 0 && watch.nudgeCount !== 1 && watch.nudgeCount !== 2)
      ) {
        return [];
      }
      return [
        {
          conversationIdSuffix: watch.conversationIdSuffix,
          ownerAlias: boundedText(watch.ownerAlias),
          workerAlias: boundedText(watch.workerAlias),
          phase: watch.phase,
          capability: watch.capability,
          lastActivityAt,
          nextActionAt,
          idleMs,
          idleForMs: Math.max(0, generatedAtMs - Date.parse(lastActivityAt)),
          dueInMs: Math.max(0, Date.parse(nextActionAt) - generatedAtMs),
          nudgeCount: watch.nudgeCount,
          workerReportedComplete: Boolean(watch.workerReportedComplete),
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
          ...(event.nudgeNumber === undefined
            ? {}
            : { nudgeNumber: event.nudgeNumber }),
        },
      ];
    })
    .sort((left, right) => right.sequence - left.sequence);
  const watchEvents = allWatchEvents.slice(
    0,
    DASHBOARD_MODEL_LIMITS.progressWatchEvents,
  );

  const connectors = snapshot.connectors
    .map(
      (connector): DashboardConnectorRow => ({
        provider: connector.provider,
        host: boundedText(connector.host),
        health: connector.health,
        compatibility: connector.compatibility,
        ...(safeProtocol(connector.protocol) === undefined
          ? {}
          : { protocol: safeProtocol(connector.protocol) }),
        ...(safeProtocol(connector.protocolVersion) === undefined
          ? {}
          : { protocolVersion: safeProtocol(connector.protocolVersion) }),
        ...(normalizedTimestamp(connector.lastSeenAt) === undefined
          ? {}
          : { lastSeenAt: normalizedTimestamp(connector.lastSeenAt) }),
        ...(safeCode(connector.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(connector.safeErrorCode) }),
      }),
    )
    .sort((left, right) =>
      compareText(`${left.provider}\0${left.host}`, `${right.provider}\0${right.host}`),
    )
    .slice(0, DASHBOARD_MODEL_LIMITS.connectors);
  const compatibilityChecks = (
    Array.isArray(snapshot.compatibilityChecks)
      ? snapshot.compatibilityChecks.filter(isCompatibilityAttestation)
      : []
  )
    .map((attestation): DashboardCompatibilityCheckRow => {
      const failed = attestation.probes.find(
        (probe) => probe.outcome === "fail",
      );
      return {
        surface: attestation.surface,
        version: boundedText(attestation.version),
        tier: attestation.tier,
        checkedAt: attestation.checkedAt,
        ...(attestation.certification === undefined
          ? {}
          : {
              certificationDepth: attestation.certification.depth,
              certificationOutcome: attestation.certification.outcome,
              certifiedAt: attestation.certification.certifiedAt,
              ...(safeCode(attestation.certification.safeErrorCode) === undefined
                ? {}
                : {
                    certificationSafeErrorCode: safeCode(
                      attestation.certification.safeErrorCode,
                    ),
                  }),
            }),
        ...(failed === undefined ? {} : { failedProbe: failed.name }),
        ...(safeCode(attestation.safeErrorCode) === undefined
          ? {}
          : { safeErrorCode: safeCode(attestation.safeErrorCode) }),
      };
    })
    .sort((left, right) => compareText(left.surface, right.surface))
    .slice(0, 2);

  const messages = buildMessageGroups(snapshot.messages);
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

  const claudeRoutes = allRoutes.filter((route) => route.provider === "claude");
  const codexRoutes = allRoutes.filter((route) => route.provider === "codex");
  const readyClaude = claudeRoutes.filter(routeIsReady).length;
  const readyCodex = codexRoutes.filter(routeIsReady).length;
  const readyPairs = allPairs.filter((pair) => pair.state === "ready");
  const pairedReadyClaude = new Set(
    readyPairs.map((pair) => pair.claudeAlias),
  );
  const pairedReadyCodex = new Set(readyPairs.map((pair) => pair.codexAlias));
  const graph: DashboardGraphFacts = {
    pairCount: allPairs.length,
    readyPairCount: readyPairs.length,
    pairCountIsLowerBound:
      (normalizedInteger(snapshot.truncation.pairs) ?? 0) > 0,
    unpairedReadyClaude: claudeRoutes.filter(
      (route) => routeIsReady(route) && !pairedReadyClaude.has(route.alias),
    ).length,
    unpairedReadyCodex: codexRoutes.filter(
      (route) => routeIsReady(route) && !pairedReadyCodex.has(route.alias),
    ).length,
  };
  const selectedPeers = validPeers.filter(
    (peer) => peer.selected && peerIsSelectable(peer),
  );
  const selectablePeers = validPeers.filter(peerIsSelectable);
  const selectedClaudeCount = Math.max(selectedPeers.length, readyClaude);
  const claudeStatus = partyStatus(claudeRoutes, readyClaude);
  const codexStatus = partyStatus(codexRoutes, readyCodex);
  const claudeNextAction: DashboardNextAction =
    graph.readyPairCount > 0 && selectedClaudeCount > 0 && readyClaude > 0
      ? "none"
      : validPeers.length === 0
        ? "discover_claude"
        : selectablePeers.length > 0
          ? "pair_routes"
          : selectedPeers.length > 0
            ? "restore_claude"
            : "repair_claude_inventory";
  const codexNextAction: DashboardNextAction =
    codexRoutes.length === 0
      ? "register_codex"
      : readyCodex === 0
        ? "restore_codex"
        : graph.readyPairCount === 0
          ? "pair_routes"
          : "none";

  const explicitAlerts: DashboardAttentionItem[] = snapshot.alerts
    .map((alert): DashboardAttentionItem => {
      const code = safeCode(alert.code);
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
        ...(alert.provider === "claude" || alert.provider === "codex"
          ? { provider: alert.provider }
          : {}),
        ...(typeof alert.alias === "string"
          ? { alias: boundedText(alert.alias) }
          : {}),
        ...(typeof alert.host === "string" ? { host: boundedText(alert.host) } : {}),
        guidance: guidanceFor(code, alert.provider),
      };
    })
    .sort((left, right) =>
      alertPriority(left.severity) - alertPriority(right.severity) ||
      compareText(right.timestamp ?? "", left.timestamp ?? ""),
    );
  const attentionCandidates: DashboardAttentionItem[] = [...explicitAlerts];
  for (const watch of allWatches) {
    if (watch.phase !== "episode" && watch.capability !== "route") continue;
    attentionCandidates.push({
      kind: "watch",
      code:
        watch.capability === "route"
          ? "PROGRESS_WATCH_CAPABILITY_DEGRADED"
          : "PROGRESS_WATCH_QUIET",
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
    if (
      routeIsReady(route)
    ) {
      continue;
    }
    const scope = `${route.provider}\0${route.alias}\0${route.host}`;
    if (representedScopes.has(scope)) continue;
    attentionCandidates.push({
      kind: "route",
      ...(route.safeErrorCode === undefined ? {} : { code: route.safeErrorCode }),
      severity:
        route.state === "offline" || route.state === "incompatible"
          ? "error"
          : "warning",
      ...(route.lastSeenAt === undefined ? {} : { timestamp: route.lastSeenAt }),
      provider: route.provider,
      alias: route.alias,
      host: route.host,
      guidance:
        route.provider === "codex" && route.state === "stale"
          ? "codex_stale"
          : "route_stale",
    });
    representedScopes.add(scope);
  }
  for (const connector of connectors) {
    if (
      (connector.health === "healthy" &&
        connector.compatibility === "compatible")
    ) {
      continue;
    }
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
        connector.health === "offline" ? "connector_offline" : "degraded",
    });
    representedScopes.add(scope);
  }
  if (
    (snapshot.health === "degraded" ||
      snapshot.health === "offline" ||
      snapshot.health === "incompatible") &&
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

  const setupComplete = graph.readyPairCount > 0;
  const overall =
    attentionCandidates.length > 0 ||
    (normalizedInteger(snapshot.truncation.alerts) ?? 0) > 0
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
    pairs: boundedAdd(
      normalizedInteger(snapshot.truncation.pairs) ?? 0,
      Math.max(0, allPairs.length - DASHBOARD_MODEL_LIMITS.pairs),
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
    schemaVersion: 1,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    inboundMode,
    health: snapshot.health,
    overall,
    exchange: {
      claude: {
        kind: "claude",
        status:
          selectedClaudeCount > 0 && claudeStatus === "missing"
            ? "attention"
            : claudeStatus,
        total: validPeers.length,
        ready: selectedClaudeCount,
        selectable: selectablePeers.length,
        countIsLowerBound:
          (normalizedInteger(snapshot.truncation.availablePeers) ?? 0) > 0 ||
          (normalizedInteger(snapshot.truncation.routes) ?? 0) > 0,
        ...(selectedPeers[0]?.alias === undefined
          ? claudeRoutes[0]?.alias === undefined
            ? {}
            : { primaryAlias: boundedText(claudeRoutes[0].alias) }
          : { primaryAlias: boundedText(selectedPeers[0].alias) }),
        nextAction: claudeNextAction,
      },
      codex: {
        kind: "codex",
        status: codexStatus,
        total: codexRoutes.length,
        ready: readyCodex,
        countIsLowerBound:
          (normalizedInteger(snapshot.truncation.routes) ?? 0) > 0,
        ...(codexRoutes[0]?.alias === undefined
          ? {}
          : { primaryAlias: codexRoutes[0].alias }),
        nextAction: codexNextAction,
      },
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
    pairs,
    watches,
    watchEvents,
    graph,
    connectors,
    compatibilityChecks,
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
