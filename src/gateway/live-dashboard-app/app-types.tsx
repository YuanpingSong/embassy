// Wire-type mirror for the live dashboard app bundle.
//
// The enum unions mirror src/gateway/types.ts and the Dashboard* types mirror
// src/gateway/dashboard-model.ts (lines 15-173) verbatim. The stream event
// mirrors src/gateway/live-dashboard-stream.ts (lines 40-45). Do not add,
// rename, or invent fields here; the server side is the source of truth.
namespace Embassy {
  export type Locale = "en" | "zh-CN";

  export type ConnectionState =
    | "connecting"
    | "connected"
    | "paused"
    | "unavailable"
    | "disconnected"
    | "stopped";

  export type LiveDashboardAction =
    | Readonly<{
        action: "pair" | "unpair";
        claudeAlias: string;
        codexAlias: string;
      }>
    | Readonly<{ action: "refresh_dashboard" }>;

  export type LiveDashboardActionResult = Readonly<{
    ok: boolean;
    code: string;
  }>;

  // ---------------------------------------------------------------------
  // Enum unions mirrored from src/gateway/types.ts
  // ---------------------------------------------------------------------

  export type GatewayProvider = "codex" | "claude";

  export type ConnectorHealth =
    | "offline"
    | "connecting"
    | "healthy"
    | "degraded"
    | "incompatible";

  export type CompatibilityState =
    | "unknown"
    | "compatible"
    | "incompatible"
    | "expired";

  export type RouteState =
    | "stale"
    | "idle"
    | "busy"
    | "awaiting_approval"
    | "offline"
    | "incompatible"
    | "disabled";

  export type MessageDirection = "codex_to_claude" | "claude_to_codex";

  export type DeliveryState =
    | "queued"
    | "duplicate"
    | "dispatching"
    | "transport_written"
    | "held"
    | "delivered"
    | "unconfirmed"
    | "failed"
    | "ambiguous"
    | "expired"
    | "cancelled"
    | "abandoned"
    | "rejected";

  export type AlertSeverity = "info" | "warning" | "error";

  export type PublicAvailablePeerState =
    | "idle"
    | "busy"
    | "awaiting_approval"
    | "offline"
    | "incompatible";

  export type RouteCounters = Readonly<{
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
  }>;

  /** Mirrors GatewayAccounting (= GatewayPublicSnapshot["accounting"]). */
  export type DashboardAccounting = Readonly<{
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
  }>;

  // ---------------------------------------------------------------------
  // View-model types mirrored from src/gateway/dashboard-model.ts
  // ---------------------------------------------------------------------

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
    /**
     * Codex only: routes whose write gate is closed (CODEX_WRITES_DISABLED).
     * Computed client-side by the adapter — the server model never carries it.
     */
    monitorOnly?: number | undefined;
  }>;

  export type DashboardAttentionGuidance =
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
    | "generic";

  export type DashboardAttentionItem = Readonly<{
    kind: "alert" | "route" | "connector" | "broker";
    code?: string | undefined;
    severity: AlertSeverity;
    timestamp?: string | undefined;
    provider?: GatewayProvider | undefined;
    alias?: string | undefined;
    host?: string | undefined;
    guidance: DashboardAttentionGuidance;
  }>;

  export type DashboardMessageEvent = Readonly<{
    sequence: number;
    timestamp?: string | undefined;
    state: DeliveryState;
    latencyMs?: number | undefined;
    safeErrorCode?: string | undefined;
    steer?: true | undefined;
  }>;

  export type DashboardMessageGroup = Readonly<{
    direction: MessageDirection;
    sourceAlias: string;
    targetAlias: string;
    messageIdSuffix?: string | undefined;
    state: DeliveryState;
    timestamp?: string | undefined;
    latencyMs?: number | undefined;
    bytes: number;
    safeErrorCode?: string | undefined;
    steer?: true | undefined;
    events: readonly DashboardMessageEvent[];
  }>;

  export type DashboardPeerRow = Readonly<{
    alias: string;
    host: string;
    state: PublicAvailablePeerState;
    compatibility: CompatibilityState;
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

  export type DashboardOmissions = Readonly<{
    connectors: number;
    availablePeers: number;
    routes: number;
    pairs: number;
    upstreamMessageEvents: number;
    messageGroups: number;
    messageEvents: number;
    upstreamAlerts: number;
    attentionItems: number;
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
    peers: readonly DashboardPeerRow[];
    routes: readonly DashboardRouteRow[];
    pairs: readonly DashboardPairRow[];
    graph: DashboardGraphFacts;
    connectors: readonly DashboardConnectorRow[];
    accounting: DashboardAccounting;
    omissions: DashboardOmissions;
  }>;

  // ---------------------------------------------------------------------
  // Stream event mirrored from src/gateway/live-dashboard-stream.ts
  // ---------------------------------------------------------------------

  export type LiveDashboardSnapshotRevision = string | number;

  export type LiveDashboardStreamEvent = Readonly<{
    streamRevision: number;
    snapshotRevision: LiveDashboardSnapshotRevision;
    reset: boolean;
    model: DashboardViewModel;
  }>;

  // ---------------------------------------------------------------------
  // Client-side derived view types (produced by Embassy.adapter)
  // ---------------------------------------------------------------------

  /** Overview status strip; `undefined` connector health means "no connector observed". */
  export type StatusStripData = Readonly<{
    broker: ConnectorHealth;
    claudeConnector: ConnectorHealth | undefined;
    codexConnector: ConnectorHealth | undefined;
    compatibility: CompatibilityState | undefined;
  }>;

  /**
   * Per-direction queue summary. `oldestAgeMs` is derived on the live wall
   * clock from `oldestQueuedAt`; the server's stale `queueAgeMs` is never used.
   */
  export type QueueSummary = Readonly<{
    depth: number;
    depthIsLowerBound: boolean;
    oldestQueuedAt: string | undefined;
    oldestAgeMs: number | undefined;
  }>;

  export type PulseBar = Readonly<{
    state: DeliveryState;
    count: number;
  }>;

  export type PulseData = Readonly<{
    /** Always the eight terminal states, in canonical order. */
    bars: readonly PulseBar[];
    total: number;
    isLowerBound: boolean;
  }>;

  export type AttentionView = Readonly<{
    item: DashboardAttentionItem;
    /** camelCase segment for the `guidance.<key>.{title,body,action}` catalog keys. */
    guidanceKey: string;
    /** Real CLI teaching command for the CopyCmd block. */
    command: string;
  }>;

  export type OverviewData = Readonly<{
    generatedAt: string | undefined;
    inboundMode: "paired" | "open";
    overall: DashboardViewModel["overall"];
    statusStrip: StatusStripData;
    exchange: DashboardViewModel["exchange"];
    queueClaudeToCodex: QueueSummary;
    queueCodexToClaude: QueueSummary;
    graph: DashboardGraphFacts;
    attention: readonly AttentionView[];
    attentionOmitted: number;
    pulse: PulseData;
  }>;

  /** Deliveries navigation preset (global search jump / pulse click-through). */
  export type DeliveriesPreset = Readonly<{
    token?: string | undefined;
    state?: DeliveryState | undefined;
  }>;

  export type DeliveryGroupView = Readonly<{
    /** Stable React row key per the integration spec §2.1. */
    key: string;
    group: DashboardMessageGroup;
    routePair: string;
    /** True when intra-group sequence gaps indicate budget-dropped transitions. */
    eventsTruncated: boolean;
  }>;

  export type CodexRouteView = Readonly<{
    route: DashboardRouteRow;
    monitorOnly: boolean;
    oldestAgeMs: number | undefined;
  }>;

  export type SuccessionView = Readonly<{
    item: DashboardAttentionItem;
    guidanceKey: "codexSuccessionBusy" | "codexSuccessionRecovery";
    command: string;
  }>;

  export type RoutesData = Readonly<{
    inboundMode: "paired" | "open";
    peers: readonly DashboardPeerRow[];
    peersOmitted: number;
    codexRoutes: readonly CodexRouteView[];
    routesOmitted: number;
    pairs: readonly DashboardPairRow[];
    pairsOmitted: number;
    graph: DashboardGraphFacts;
    successions: readonly SuccessionView[];
  }>;

  export type ActivityRow =
    | Readonly<{
        kind: "delivery";
        timestamp: string | undefined;
        group: DashboardMessageGroup;
      }>
    | Readonly<{
        kind: "alert";
        timestamp: string;
        item: DashboardAttentionItem;
        guidanceKey: string;
      }>;

  export type DiagnosticsData = Readonly<{
    connectors: readonly DashboardConnectorRow[];
    connectorsOmitted: number;
    /** Lifetime expired count from accounting; feeds the deadline pressure card. */
    expiredCount: number;
    queuedMessages: number;
    queueCountIsLowerBound: boolean;
    accounting: DashboardAccounting;
    omissions: DashboardOmissions;
  }>;

  // ---------------------------------------------------------------------
  // Per-tab component prop types
  // ---------------------------------------------------------------------

  export type OverviewTabProps = Readonly<{
    data: OverviewData;
    onViewDeliveries: (preset: DeliveriesPreset) => void;
  }>;

  export type DeliveriesTabProps = Readonly<{
    groups: readonly DeliveryGroupView[];
    omissions: DashboardOmissions;
    preset: DeliveriesPreset | undefined;
    /** Consume-once contract: called after the preset has been applied. */
    clearPreset?: (() => void) | undefined;
  }>;

  export type RoutesTabProps = Readonly<{
    data: RoutesData;
    actionsEnabled: boolean;
    onAction: (action: LiveDashboardAction) => Promise<LiveDashboardActionResult>;
  }>;

  export type ActivityTabProps = Readonly<{
    rows: readonly ActivityRow[];
    omissions: DashboardOmissions;
  }>;

  export type DiagnosticsTabProps = Readonly<{
    data: DiagnosticsData;
  }>;
}
