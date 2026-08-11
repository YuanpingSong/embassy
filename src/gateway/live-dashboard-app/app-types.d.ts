import type {
  DashboardActivityEventRow as ModelActivityEventRow,
  DashboardAttentionItem as ModelAttentionItem,
  DashboardChipKind as ModelChipKind,
  DashboardCompatibilityCheckRow as ModelCompatibilityCheckRow,
  DashboardConnectorRow as ModelConnectorRow,
  DashboardExchangeParty as ModelExchangeParty,
  DashboardGraphFacts as ModelGraphFacts,
  DashboardNextAction as ModelNextAction,
  DashboardOmissions as ModelOmissions,
  DashboardPairRow as ModelPairRow,
  DashboardPeerRow as ModelPeerRow,
  DashboardProgressWatchEventRow as ModelProgressWatchEventRow,
  DashboardProgressWatchRow as ModelProgressWatchRow,
  DashboardRegistryObservation as ModelRegistryObservation,
  DashboardRouteRow as ModelRouteRow,
  DashboardTone as ModelTone,
  DashboardSemantics as ModelSemantics,
  DashboardSemanticDomain as ModelSemanticDomain,
  LiveDashboardMessageGroup as ModelMessageGroup,
  LiveDashboardViewModel as ModelViewModel,
} from "../dashboard-model.js";
import type {
  LiveDashboardAction as HttpAction,
  LiveDashboardActionResult as HttpActionResult,
} from "../live-dashboard-http.js";
import type {
  LiveDashboardSnapshotRevision as StreamSnapshotRevision,
  LiveDashboardStreamEvent as StreamEvent,
} from "../live-dashboard-stream.js";
import type {
  AlertSeverity as GatewayAlertSeverity,
  CompatibilityState as GatewayCompatibilityState,
  ConnectorHealth as GatewayConnectorHealth,
  DeliveryState as GatewayDeliveryState,
  GatewayProvider as ModelGatewayProvider,
  MessageDirection as GatewayMessageDirection,
  PublicAvailablePeerState as GatewayAvailablePeerState,
  RouteCounters as GatewayRouteCounters,
  RouteState as GatewayRouteState,
} from "../types.js";

export type DashboardViewModel = ModelViewModel;
export type DashboardMessageGroup = ModelMessageGroup;
export type DashboardAttentionItem = ModelAttentionItem;
export type DashboardRouteRow = ModelRouteRow;
export type DashboardPeerRow = ModelPeerRow;
export type DashboardActivityEventRow = ModelActivityEventRow;
export type DashboardOmissions = ModelOmissions;
export type DeliveryState = GatewayDeliveryState;
export type MessageDirection = GatewayMessageDirection;
export type GatewayProvider = ModelGatewayProvider;
export type ConnectorHealth = GatewayConnectorHealth;
export type CompatibilityState = GatewayCompatibilityState;

export type QueueSummary = Readonly<{
  depth: number;
  depthIsLowerBound: boolean;
  oldestQueuedAt: string | undefined;
  oldestAgeMs: number | undefined;
}>;

export type PulseBar = Readonly<{
  state: GatewayDeliveryState;
  count: number;
}>;

export type PulseData = Readonly<{
  bars: readonly PulseBar[];
  total: number;
  isLowerBound: boolean;
}>;

export type AttentionView = Readonly<{
  item: ModelAttentionItem;
  guidanceKey: string;
  command: string;
}>;

export type StatusStripData = Readonly<{
  broker: GatewayConnectorHealth;
  claudeConnector: GatewayConnectorHealth | undefined;
  codexConnector: GatewayConnectorHealth | undefined;
  compatibility: GatewayCompatibilityState | undefined;
}>;

export type OverviewData = Readonly<{
  generatedAt: string | undefined;
  inboundMode: "paired" | "open";
  overall: ModelViewModel["overall"];
  statusStrip: StatusStripData;
  exchange: Omit<ModelViewModel["exchange"], "codex"> &
    Readonly<{
      codex: ModelExchangeParty &
        Readonly<{ monitorOnly?: number | undefined }>;
    }>;
  queueClaudeToCodex: QueueSummary;
  queueCodexToClaude: QueueSummary;
  graph: ModelGraphFacts;
  degradedPairCopyKey:
    | "app.overview.degradedEdge"
    | "app.overview.degradedEdges"
    | undefined;
  attention: readonly AttentionView[];
  attentionOmitted: number;
  pulse: PulseData;
}>;

export type DeliveryGroupView = Readonly<{
  key: string;
  group: ModelMessageGroup;
  routePair: string;
  eventsTruncated: boolean;
}>;

export type CodexRouteView = Readonly<{
  route: ModelRouteRow;
  monitorOnly: boolean;
  oldestAgeMs: number | undefined;
}>;

export type SuccessionView = Readonly<{
  item: ModelAttentionItem;
  guidanceKey: "codexSuccessionBusy" | "codexSuccessionRecovery";
  command: string;
}>;

export type RoutesData = Readonly<{
  inboundMode: "paired" | "open";
  peers: readonly ModelPeerRow[];
  peersOmitted: number;
  codexRoutes: readonly CodexRouteView[];
  routesOmitted: number;
  pairs: readonly ModelPairRow[];
  pairsOmitted: number;
  graph: ModelGraphFacts;
  successions: readonly SuccessionView[];
}>;

export type ActivityRow =
  | Readonly<{
      kind: "delivery";
      timestamp: string | undefined;
      group: ModelMessageGroup;
    }>
  | Readonly<{
      kind: "alert";
      timestamp: string;
      item: ModelAttentionItem;
      guidanceKey: string;
    }>
  | Readonly<{
      kind: "operation";
      timestamp: string;
      event: ModelActivityEventRow;
    }>;

export type DiagnosticsData = Readonly<{
  connectors: readonly ModelConnectorRow[];
  connectorsOmitted: number;
  compatibilityChecks: readonly ModelCompatibilityCheckRow[];
  expiredCount: number;
  deadlinePressure?: ModelViewModel["deadlinePressure"];
  queuedMessages: number;
  queueCountIsLowerBound: boolean;
  accounting: ModelViewModel["accounting"];
  omissions: ModelOmissions;
}>;

export type EmbassyAdapter = Readonly<{
  overviewProps(model: ModelViewModel, nowMs: number): OverviewData;
  deliveriesGroups(model: ModelViewModel): readonly DeliveryGroupView[];
  routesProps(model: ModelViewModel, nowMs: number): RoutesData;
  activityRows(model: ModelViewModel): readonly ActivityRow[];
  diagnosticsProps(model: ModelViewModel): DiagnosticsData;
  queueSplit(
    model: ModelViewModel,
    targetProvider: ModelGatewayProvider,
    nowMs: number,
  ): QueueSummary;
  routeOldestAgeMs(route: ModelRouteRow, nowMs: number): number | undefined;
  pulse(model: ModelViewModel): PulseData;
  worstConnectorHealth(
    model: ModelViewModel,
    provider: ModelGatewayProvider,
  ): GatewayConnectorHealth | undefined;
  worstCompatibility(model: ModelViewModel): GatewayCompatibilityState | undefined;
  extractSuccessions(model: ModelViewModel): readonly SuccessionView[];
  isMonitorOnly(route: ModelRouteRow): boolean;
  hasLifecycleTruncation(group: ModelMessageGroup): boolean;
  deliveriesTruncated(model: ModelViewModel): boolean;
  deliveryGroupKey(group: ModelMessageGroup): string;
  guidanceCopyKey(guidance: ModelAttentionItem["guidance"]): string;
  attentionCommand(item: ModelAttentionItem): string;
  attentionViews(model: ModelViewModel): readonly AttentionView[];
  isTerminalDeliveryState(state: GatewayDeliveryState): boolean;
  parseTimestampMs(iso: string | undefined): number | undefined;
}>;

export type ChipDomain = ModelSemanticDomain;

export type EmbassyNamespace = Readonly<{
  adapter: EmbassyAdapter;
  createProtocol(options: Readonly<{
    onEvent: (event: unknown) => void;
    onConnectionState: (state: string) => void;
    onNotice?: (kind: string) => void;
  }>): Readonly<{
    start(): void;
    executeAction(action: HttpAction): Promise<HttpActionResult>;
  }>;
  TERMINAL_DELIVERY_STATES: readonly GatewayDeliveryState[];
  PULSE_WINDOW_MS: number;
  chipKindFor(
    state: string,
    direction?: GatewayMessageDirection,
    safeErrorCode?: string,
  ): string;
  chipKindByDomain(
    domain: ChipDomain,
    state: string,
    direction?: GatewayMessageDirection,
  ): string;
  routeChipKind(state: string): string;
  peerChipKind(state: string): string;
  healthChipKind(state: string): string;
  compatibilityChipKind(state: string): string;
  overallChipKind(state: string): string;
  partyChipKind(state: string): string;
  severityChipKind(state: string): string;
  connectionChipKind(state: string): string;
  deliveryMeaningKey(
    state: string,
    direction?: GatewayMessageDirection,
    safeErrorCode?: string,
  ): string;
  meaningKeyFor(
    domain: ChipDomain,
    state: string,
    safeErrorCode?: string,
    direction?: GatewayMessageDirection,
  ): string;
  camelCaseToken(token: string): string;
  canRequestStaleCodexRegistrationRemoval(route: ModelRouteRow): boolean;
  activityAuthority(event: ModelActivityEventRow): "operator" | "automatic";
  attentionQueueDepthLine(
    item: ModelAttentionItem,
    t: (key: string, values?: Readonly<Record<string, string | number>>) => string,
    locale: "en" | "zh-CN",
  ): string | undefined;
}>;

declare global {
  interface Window {
    EMBASSY_BOOT: {
      readonly locale: "en" | "zh-CN";
      readonly copy: Readonly<
        Record<"en" | "zh-CN", Readonly<Record<string, string>>>
      >;
      readonly semantics: ModelSemantics;
    };
  }

  namespace Embassy {
    type Locale = "en" | "zh-CN";
    type ConnectionState =
      | "connecting"
      | "connected"
      | "paused"
      | "unavailable"
      | "capacity"
      | "disconnected"
      | "stopped";

    type LiveDashboardAction = HttpAction;
    type LiveDashboardActionResult = HttpActionResult;
    type GatewayProvider = ModelGatewayProvider;
    type ConnectorHealth = GatewayConnectorHealth;
    type CompatibilityState = GatewayCompatibilityState;
    type RouteState = GatewayRouteState;
    type MessageDirection = GatewayMessageDirection;
    type DeliveryState = GatewayDeliveryState;
    type AlertSeverity = GatewayAlertSeverity;
    type PublicAvailablePeerState = GatewayAvailablePeerState;
    type RouteCounters = GatewayRouteCounters;
    type DashboardTone = ModelTone;
    type ChipKind = ModelChipKind;
    type ChipDomain = ModelSemanticDomain;
    type DashboardNextAction = ModelNextAction;
    type DashboardExchangeParty = ModelExchangeParty;
    type DashboardAttentionGuidance = ModelAttentionItem["guidance"];
    type DashboardAttentionItem = ModelAttentionItem;
    type DashboardMessageEvent = ModelMessageGroup["events"][number];
    type DashboardMessageGroup = ModelMessageGroup;
    type DashboardPeerRow = ModelPeerRow;
    type DashboardActivityEventRow = ModelActivityEventRow;
    type DeadlinePressureSnapshot = NonNullable<ModelViewModel["deadlinePressure"]>;
    type DashboardRouteRow = ModelRouteRow;
    type DashboardPairRow = ModelPairRow;
    type DashboardProgressWatchRow = ModelProgressWatchRow;
    type DashboardProgressWatchEventRow = ModelProgressWatchEventRow;
    type DashboardGraphFacts = ModelGraphFacts;
    type DashboardConnectorRow = ModelConnectorRow;
    type DashboardCompatibilityCheckRow = ModelCompatibilityCheckRow;
    type DashboardRegistryObservation = ModelRegistryObservation;
    type DashboardOmissions = ModelOmissions;
    type DashboardAccounting = ModelViewModel["accounting"];
    type DashboardViewModel = ModelViewModel;
    type LiveDashboardSnapshotRevision = StreamSnapshotRevision;
    type LiveDashboardStreamEvent = StreamEvent;
    type StatusStripData = import("./app-types.js").StatusStripData;
    type QueueSummary = import("./app-types.js").QueueSummary;
    type PulseBar = import("./app-types.js").PulseBar;
    type PulseData = import("./app-types.js").PulseData;
    type AttentionView = import("./app-types.js").AttentionView;
    type OverviewData = import("./app-types.js").OverviewData;
    type DeliveriesPreset = Readonly<{
      token?: string | undefined;
      state?: GatewayDeliveryState | undefined;
    }>;
    type DeliveryGroupView = import("./app-types.js").DeliveryGroupView;
    type CodexRouteView = import("./app-types.js").CodexRouteView;
    type SuccessionView = import("./app-types.js").SuccessionView;
    type RoutesData = import("./app-types.js").RoutesData;
    type ActivityRow = import("./app-types.js").ActivityRow;
    type DiagnosticsData = import("./app-types.js").DiagnosticsData;

    type OverviewTabProps = Readonly<{
      data: OverviewData;
      onViewDeliveries: (preset: DeliveriesPreset) => void;
    }>;
    type DeliveriesTabProps = Readonly<{
      groups: readonly DeliveryGroupView[];
      watches: readonly ModelProgressWatchRow[];
      watchEvents: readonly ModelProgressWatchEventRow[];
      omissions: ModelOmissions;
      preset: DeliveriesPreset | undefined;
      clearPreset?: (() => void) | undefined;
    }>;
    type RoutesTabProps = Readonly<{
      data: RoutesData;
      actionsEnabled: boolean;
      onAction: (action: HttpAction) => Promise<HttpActionResult>;
    }>;
    type ActivityTabProps = Readonly<{
      rows: readonly ActivityRow[];
      omissions: ModelOmissions;
    }>;
    type DiagnosticsTabProps = Readonly<{ data: DiagnosticsData }>;
  }
}

export {};
