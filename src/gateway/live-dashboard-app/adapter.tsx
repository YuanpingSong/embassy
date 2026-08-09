// Data adapter — every §2 derivation as a pure function over the
// DashboardViewModel (plus the live wall clock where ages tick).
//
// Trust-the-server rules: `model.activity` IS the deliveries grouping (never
// regroup client-side); route/peer/connector arrays keep the server sort.
// Queue ages are always computed client-side from `oldestQueuedAt` against
// `nowMs` — the server's `queueAgeMs`/`oldestQueueAgeMs` are excluded from the
// stream fingerprint, go stale between frames, and must never be displayed.
namespace Embassy {
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
    "incompatible",
    "degraded",
    "connecting",
    "healthy",
  ];

  /** Worst-first compatibility order (§2.2). */
  const COMPATIBILITY_WORST_FIRST: readonly CompatibilityState[] = [
    "incompatible",
    "expired",
    "unknown",
    "compatible",
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
   * Per-direction queue split (§2.2): messages queue at the target route, so
   * claude→codex sums codex routes and codex→claude sums claude routes.
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
   * Worst compatibility across all connectors, order
   * incompatible < expired < unknown < compatible;
   * undefined when no connectors are observed.
   */
  export function worstCompatibility(
    model: DashboardViewModel,
  ): CompatibilityState | undefined {
    let worst: CompatibilityState | undefined;
    for (const connector of model.connectors) {
      if (
        worst === undefined ||
        COMPATIBILITY_WORST_FIRST.indexOf(connector.compatibility) <
          COMPATIBILITY_WORST_FIRST.indexOf(worst)
      ) {
        worst = connector.compatibility;
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

  /** Monitor-only detection: the codex write gate is closed (§2.2). */
  export function isMonitorOnly(route: DashboardRouteRow): boolean {
    return route.safeErrorCode === "CODEX_WRITES_DISABLED";
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

  const GUIDANCE_COPY_KEYS = {
    reobserve_claude: "reobserveClaude",
    reobserve_codex: "reobserveCodex",
    claude_not_observed: "claudeNotObserved",
    codex_stale: "codexStale",
    connector_offline: "connectorOffline",
    route_stale: "routeStale",
    queue_stalled: "queueStalled",
    unconfirmed: "unconfirmed",
    degraded: "degraded",
    codex_succession_busy: "codexSuccessionBusy",
    codex_succession_recovery: "codexSuccessionRecovery",
    generic: "generic",
  } as const satisfies Record<DashboardAttentionGuidance, string>;

  /** camelCase segment for `guidance.<key>.{title,body,action}` copy keys. */
  export function guidanceCopyKey(guidance: DashboardAttentionGuidance): string {
    return GUIDANCE_COPY_KEYS[guidance];
  }

  /**
   * Guidance → teaching-command map (§2.2). Every command is a real CLI verb;
   * placeholders stay angle-bracketed when the scope is unknown.
   */
  export function attentionCommand(item: DashboardAttentionItem): string {
    switch (item.guidance) {
      case "reobserve_claude":
      case "claude_not_observed":
        return `embassy select-claude --alias ${item.alias ?? "<alias>"}`;
      case "reobserve_codex":
      case "codex_stale":
        return `embassy register-codex --alias ${item.alias ?? "<alias>"}`;
      case "codex_succession_busy":
      case "codex_succession_recovery":
        return `embassy register-codex --alias <new> --succeeds ${item.alias ?? "<old>"}`;
      default:
        return "embassy status";
    }
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

  /** Succession extraction (§2.2): succession-guidance attention items only. */
  export function extractSuccessions(
    model: DashboardViewModel,
  ): readonly SuccessionView[] {
    const successions: SuccessionView[] = [];
    for (const item of model.attention) {
      if (item.guidance === "codex_succession_busy") {
        successions.push({
          item,
          guidanceKey: "codexSuccessionBusy",
          command: attentionCommand(item),
        });
      } else if (item.guidance === "codex_succession_recovery") {
        successions.push({
          item,
          guidanceKey: "codexSuccessionRecovery",
          command: attentionCommand(item),
        });
      }
    }
    return successions;
  }

  export function overviewProps(
    model: DashboardViewModel,
    nowMs: number,
  ): OverviewData {
    return {
      generatedAt: model.generatedAt,
      inboundMode: model.inboundMode,
      overall: model.overall,
      statusStrip: {
        broker: model.health,
        claudeConnector: worstConnectorHealth(model, "claude"),
        codexConnector: worstConnectorHealth(model, "codex"),
        compatibility: worstCompatibility(model),
      },
      exchange: {
        ...model.exchange,
        codex: {
          ...model.exchange.codex,
          monitorOnly: model.routes.filter(
            (route) => route.provider === "codex" && isMonitorOnly(route),
          ).length,
        },
      },
      queueClaudeToCodex: queueSplit(model, "codex", nowMs),
      queueCodexToClaude: queueSplit(model, "claude", nowMs),
      graph: model.graph,
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
    return model.activity.map(
      (group): DeliveryGroupView => ({
        key: deliveryGroupKey(group),
        group,
        routePair: `${group.sourceAlias} → ${group.targetAlias}`,
        eventsTruncated: hasLifecycleTruncation(group),
      }),
    );
  }

  export function routesProps(
    model: DashboardViewModel,
    nowMs: number,
  ): RoutesData {
    const codexRoutes = model.routes
      .filter((route) => route.provider === "codex")
      .map(
        (route): CodexRouteView => ({
          route,
          monitorOnly: isMonitorOnly(route),
          oldestAgeMs: routeOldestAgeMs(route, nowMs),
        }),
      );
    return {
      inboundMode: model.inboundMode,
      peers: model.peers,
      peersOmitted: model.omissions.availablePeers,
      codexRoutes,
      routesOmitted: model.omissions.routes,
      pairs: model.pairs,
      pairsOmitted: model.omissions.pairs,
      graph: model.graph,
      successions: extractSuccessions(model),
    };
  }

  function activityRowSource(row: ActivityRow): string {
    return row.kind === "delivery"
      ? row.group.sourceAlias
      : row.item.alias ?? row.item.host ?? "";
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
    routesProps,
    activityRows,
    diagnosticsProps,
    queueSplit,
    routeOldestAgeMs,
    pulse,
    worstConnectorHealth,
    worstCompatibility,
    extractSuccessions,
    isMonitorOnly,
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
