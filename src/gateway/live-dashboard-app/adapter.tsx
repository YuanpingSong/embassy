// Data adapter — every §2 derivation as a pure function over the
// DashboardViewModel (plus the live wall clock where ages tick).
//
// Trust-the-server rules: `model.activity` IS the deliveries grouping (never
// regroup client-side); route/peer/connector arrays keep the server sort.
// Queue ages are always computed client-side from `oldestQueuedAt` against
// `nowMs` — the server's `queueAgeMs`/`oldestQueueAgeMs` are excluded from the
// stream fingerprint, go stale between frames, and must never be displayed.
namespace Embassy {
  export const GATEWAY_PROVIDERS: readonly GatewayProvider[] = ["claude", "codex", "deepseek", "grok", "peer"];

  export function parseDirection(direction: MessageDirection): Readonly<{
    sourceProvider: GatewayProvider; targetProvider: GatewayProvider;
  }> | undefined {
    const separator = direction.indexOf("_to_");
    if (separator < 1 || separator !== direction.lastIndexOf("_to_")) {
      return undefined;
    }
    const sourceProvider = direction.slice(0, separator);
    const targetProvider = direction.slice(separator + 4);
    const providers = GATEWAY_PROVIDERS as readonly string[];
    if (sourceProvider === targetProvider || !providers.includes(sourceProvider) ||
        !providers.includes(targetProvider)) return undefined;
    return {
      sourceProvider: sourceProvider as GatewayProvider,
      targetProvider: targetProvider as GatewayProvider,
    };
  }

  /** The eight terminal delivery states, in canonical pulse-bar order. */
  export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
    "delivered",
    "unconfirmed",
    "failed",
    "ambiguous",
    "expired",
    "cancelled",
    "abandoned",
    "rejected",
  ];

  const TERMINAL_DELIVERY_STATE_SET: ReadonlySet<DeliveryState> = new Set(
    TERMINAL_DELIVERY_STATES,
  );

  /** Pulse window: one hour before the snapshot's generatedAt. */
  export const PULSE_WINDOW_MS = 3_600_000;

  /** Worst-first connector-health order (§2.2). */
  const HEALTH_WORST_FIRST: readonly ConnectorHealth[] = [
    "offline",
    "degraded",
    "connecting",
    "healthy",
  ];

  function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  export function isTerminalDeliveryState(state: DeliveryState): boolean {
    return TERMINAL_DELIVERY_STATE_SET.has(state);
  }

  export function parseTimestampMs(
    iso: string | undefined,
  ): number | undefined {
    if (iso === undefined) return undefined;
    const milliseconds = Date.parse(iso);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  /**
   * Per-target queue split (§2.2): messages queue at the target route.
   * Oldest age ticks on the live clock from `oldestQueuedAt`.
   */
  export function queueSplit(
    model: DashboardViewModel,
    targetProvider: GatewayProvider,
    nowMs: number,
  ): QueueSummary {
    let depth = 0;
    let oldestQueuedAt: string | undefined;
    let oldestQueuedMs: number | undefined;
    for (const route of model.routes) {
      if (route.provider !== targetProvider) continue;
      depth += route.queueDepth;
      if (route.queueDepth === 0 || route.oldestQueuedAt === undefined) {
        continue;
      }
      const queuedMs = parseTimestampMs(route.oldestQueuedAt);
      if (queuedMs === undefined) continue;
      if (oldestQueuedMs === undefined || queuedMs < oldestQueuedMs) {
        oldestQueuedMs = queuedMs;
        oldestQueuedAt = route.oldestQueuedAt;
      }
    }
    return {
      depth,
      depthIsLowerBound: model.omissions.routes > 0,
      oldestQueuedAt,
      oldestAgeMs:
        oldestQueuedMs === undefined
          ? undefined
          : Math.max(0, nowMs - oldestQueuedMs),
    };
  }

  /** Live-clock queue age for a single route; undefined when queue is empty. */
  export function routeOldestAgeMs(
    route: DashboardRouteRow,
    nowMs: number,
  ): number | undefined {
    if (route.queueDepth === 0 || route.oldestQueuedAt === undefined) {
      return undefined;
    }
    const queuedMs = parseTimestampMs(route.oldestQueuedAt);
    return queuedMs === undefined ? undefined : Math.max(0, nowMs - queuedMs);
  }

  /**
   * Worst connector health for a provider, order
   * offline < incompatible < degraded < connecting < healthy;
   * undefined when no connector of that provider is observed.
   */
  export function worstConnectorHealth(
    model: DashboardViewModel,
    provider: GatewayProvider,
  ): ConnectorHealth | undefined {
    let worst: ConnectorHealth | undefined;
    for (const connector of model.connectors) {
      if (connector.provider !== provider) continue;
      if (
        worst === undefined ||
        HEALTH_WORST_FIRST.indexOf(connector.health) <
          HEALTH_WORST_FIRST.indexOf(worst)
      ) {
        worst = connector.health;
      }
    }
    return worst;
  }

  /**
   * Pulse (§2.2): terminal-state settlements over the 3600 s window before
   * `generatedAt`, one bar per terminal state (all eight, zeros included).
   * Without a parseable `generatedAt` the window check is skipped.
   */
  export function pulse(model: DashboardViewModel): PulseData {
    const generatedMs = parseTimestampMs(model.generatedAt);
    const cutoffMs =
      generatedMs === undefined ? undefined : generatedMs - PULSE_WINDOW_MS;
    const counts = new Map<DeliveryState, number>();
    for (const group of model.activity) {
      if (!isTerminalDeliveryState(group.state)) continue;
      if (cutoffMs !== undefined) {
        const timestampMs = parseTimestampMs(group.timestamp);
        if (timestampMs === undefined || timestampMs < cutoffMs) continue;
      }
      counts.set(group.state, (counts.get(group.state) ?? 0) + 1);
    }
    const bars = TERMINAL_DELIVERY_STATES.map(
      (state): PulseBar => ({ state, count: counts.get(state) ?? 0 }),
    );
    return {
      bars,
      total: bars.reduce((sum, bar) => sum + bar.count, 0),
      isLowerBound:
        model.omissions.messageGroups > 0 ||
        model.omissions.upstreamMessageEvents > 0,
    };
  }

  /**
   * Lifecycle truncation detection (§2.1): a gap in the store-global
   * `sequence` between adjacent retained events means transitions were
   * dropped by the event budget.
   */
  export function hasLifecycleTruncation(group: DashboardMessageGroup): boolean {
    for (let index = 1; index < group.events.length; index += 1) {
      const previous = group.events[index - 1];
      const current = group.events[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.sequence > previous.sequence + 1
      ) {
        return true;
      }
    }
    return false;
  }

  /** Tab-level truncation line condition (§2.1). */
  export function deliveriesTruncated(model: DashboardViewModel): boolean {
    return (
      model.omissions.messageEvents > 0 ||
      model.activity.some(hasLifecycleTruncation)
    );
  }

  /** Stable React row key for a delivery group (§2.1). */
  export function deliveryGroupKey(group: DashboardMessageGroup): string {
    const suffix =
      group.messageIdSuffix ?? `seq${group.events[0]?.sequence ?? 0}`;
    return `${group.direction}|${group.sourceAlias}|${group.targetAlias}|${suffix}`;
  }

  /** camelCase segment for `guidance.<key>.{title,body,action}` copy keys. */
  export function guidanceCopyKey(guidance: DashboardAttentionGuidance): string {
    return window.EMBASSY_BOOT.semantics.guidanceCopyKeys[guidance];
  }

  /**
   * Guidance → teaching-command map (§2.2). Every command is a real CLI verb;
   * placeholders stay angle-bracketed when the scope is unknown.
   */
  export function attentionCommand(item: DashboardAttentionItem): string {
    const semantics = window.EMBASSY_BOOT.semantics;
    const fallbacks = semantics.attentionCommandFallbacks as Readonly<
      Partial<Record<DashboardAttentionGuidance, string>>
    >;
    return semantics.attentionCommands[
      item.guidance
    ].replaceAll(
      "{alias}",
      item.alias ?? fallbacks[item.guidance] ?? "<alias>",
    );
  }

  /** Attention items decorated with copy key + teaching command, server order kept. */
  export function attentionViews(
    model: DashboardViewModel,
  ): readonly AttentionView[] {
    return model.attention.map(
      (item): AttentionView => ({
        item,
        guidanceKey: guidanceCopyKey(item.guidance),
        command: attentionCommand(item),
      }),
    );
  }

  export function overviewProps(
    model: DashboardViewModel,
    nowMs: number,
  ): OverviewData {
    const nonReadyConsentEdgeCount =
      model.graph.consentEdgeCount - model.graph.readyConsentEdgeCount;
    return {
      generatedAt: model.generatedAt,
      inboundMode: model.inboundMode,
      overall: model.overall,
      statusStrip: {
        broker: model.health,
        providers: GATEWAY_PROVIDERS.map((provider) =>
          ({ provider, health: worstConnectorHealth(model, provider) })),
      },
      exchange: model.exchange,
      providerQueues: GATEWAY_PROVIDERS.map((provider) =>
        ({ provider, queue: queueSplit(model, provider, nowMs) })),
      graph: model.graph,
      degradedConsentEdgeCopyKey:
        nonReadyConsentEdgeCount <= 0
          ? undefined
          : nonReadyConsentEdgeCount === 1 &&
              !model.graph.consentEdgeCountIsLowerBound
            ? "app.overview.degradedEdge"
            : "app.overview.degradedEdges",
      attention: attentionViews(model),
      attentionOmitted: model.omissions.attentionItems,
      pulse: pulse(model),
    };
  }

  /**
   * Deliveries rows (§2.1): `model.activity` IS the grouping — rendered
   * verbatim in server order (latest-event desc, tie sourceAlias asc).
   */
  export function deliveriesGroups(
    model: DashboardViewModel,
  ): readonly DeliveryGroupView[] {
    return model.activity.map((group): DeliveryGroupView => {
      const parsed = parseDirection(group.direction);
      if (parsed === undefined) throw new Error("INVALID_MESSAGE_DIRECTION");
      return {
        key: deliveryGroupKey(group),
        group,
        routePair: `${group.sourceAlias} → ${group.targetAlias}`,
        sourceProvider: parsed.sourceProvider,
        targetProvider: parsed.targetProvider,
        eventsTruncated: hasLifecycleTruncation(group),
      };
    });
  }

  export function matchesProviderFilters(
    view: DeliveryGroupView,
    from: "all" | GatewayProvider,
    to: "all" | GatewayProvider,
  ): boolean {
    const parsed = parseDirection(view.group.direction);
    return parsed !== undefined && (from === "all" || parsed.sourceProvider === from) &&
      (to === "all" || parsed.targetProvider === to);
  }

  export function routesProps(
    model: DashboardViewModel,
    nowMs: number,
  ): RoutesData {
    const routes = model.routes.map(
      (route): RouteView => ({
        route,
        oldestAgeMs: routeOldestAgeMs(route, nowMs),
      }),
    );
    return {
      inboundMode: model.inboundMode,
      peers: model.peers,
      peersOmitted: model.omissions.availablePeers,
      routes,
      routesOmitted: model.omissions.routes,
      consentEdges: model.consentEdges,
      consentEdgesOmitted: model.omissions.consentEdges,
      graph: model.graph,
    };
  }

  function activityRowSource(row: ActivityRow): string {
    if (row.kind === "delivery") return row.group.sourceAlias;
    if (row.kind === "operation") return row.event.aliases[0] ?? "";
    return row.item.alias ?? row.item.host ?? "";
  }

  /**
   * Activity union (§2.2 / R14): delivery settlements (terminal latest state)
   * plus attention items that carry a timestamp; timestamp desc, tie by
   * source alias.
   */
  export function activityRows(
    model: DashboardViewModel,
  ): readonly ActivityRow[] {
    const rows: ActivityRow[] = [];
    for (const group of model.activity) {
      if (!isTerminalDeliveryState(group.state)) continue;
      rows.push({ kind: "delivery", timestamp: group.timestamp, group });
    }
    for (const item of model.attention) {
      if (item.timestamp === undefined) continue;
      rows.push({
        kind: "alert",
        timestamp: item.timestamp,
        item,
        guidanceKey: guidanceCopyKey(item.guidance),
      });
    }
    for (const event of model.brokerActivity ?? []) {
      rows.push({ kind: "operation", timestamp: event.timestamp, event });
    }
    return rows.sort(
      (left, right) =>
        compareText(right.timestamp ?? "", left.timestamp ?? "") ||
        compareText(activityRowSource(left), activityRowSource(right)),
    );
  }

  export function diagnosticsProps(
    model: DashboardViewModel,
  ): DiagnosticsData {
    return {
      connectors: model.connectors,
      connectorsOmitted: model.omissions.connectors,
      expiredCount: model.accounting.expired,
      ...(model.deadlinePressure === undefined
        ? {}
        : { deadlinePressure: model.deadlinePressure }),
      queuedMessages: model.exchange.queuedMessages,
      queueCountIsLowerBound: model.exchange.queueCountIsLowerBound,
      accounting: model.accounting,
      omissions: model.omissions,
    };
  }

  /** The adapter surface — pure functions only, unit-testable via node:vm. */
  export const adapter = {
    overviewProps,
    deliveriesGroups,
    matchesProviderFilters,
    routesProps,
    activityRows,
    diagnosticsProps,
    queueSplit,
    routeOldestAgeMs,
    pulse,
    worstConnectorHealth,
    hasLifecycleTruncation,
    deliveriesTruncated,
    deliveryGroupKey,
    guidanceCopyKey,
    attentionCommand,
    attentionViews,
    isTerminalDeliveryState,
    parseTimestampMs,
  } as const;
}
