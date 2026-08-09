// Routes tab (integration spec §4.4) — bounded consent graph
// actions, the two accordion columns, and successions.
//
// The action surface is deliberately not a generic control plane: it can only
// pair, unpair, or refresh discovery after an explicit consequence step.
// The prototype's crash on an empty peer array is structurally impossible here
// — every column, edge, and detail block derives from possibly-empty arrays,
// each index read is guarded, and both zero-peer and zero-route branches are
// explicit empty states. The register-codex teaching block sits outside that
// branch (as in the prototype) so it stays reachable once routes exist.
//
// Topology renders every projected consent edge. Highlight follows hover AND
// keyboard focus across all incident edges and counterpart nodes, so the
// affordance is not mouse-only. Queue ages come from the adapter's live-clock
// derivation; the server's stale queueAgeMs is never displayed (R13).
namespace Embassy {
  // Geometry constants mirror app.css: .topo-row height and .topology__col
  // padding-top. Changing one without the other misaligns the edge.
  const TOPOLOGY_ROW_HEIGHT_PX = 64;
  const TOPOLOGY_PADDING_PX = 18;
  const TOPOLOGY_EDGE_WIDTH_PX = 220;

  // Every command below is a verified-real CLI verb (spec §3.4).
  const SELECT_CLAUDE_COMMAND = "embassy select-claude --alias <alias>";
  const REGISTER_CODEX_COMMAND =
    "embassy register-codex --alias codex-<name>@<host>";
  const SUCCEEDS_COMMAND =
    "embassy register-codex --alias <new> --succeeds <old>";

  type TopologySide = "claude" | "codex";

  type TopologyFocus = Readonly<{ side: TopologySide; index: number }>;

  type TopologyHighlight = "on" | "off" | undefined;

  type TopologyEdge = Readonly<{
    claudeIndex: number;
    codexIndex: number;
    claudeAlias: string;
    codexAlias: string;
    state: DashboardPairRow["state"];
  }>;

  type TopologyItem = Readonly<{
    key: string;
    alias: string;
    /** Dashed chip: discovered/registered but not incident to a consent edge. */
    candidate: boolean;
    /** Visually-hidden equivalent of the dashed/solid distinction. */
    srLabel: string;
  }>;

  const ROUTE_COUNTER_ROWS = [
    ["accepted", "diagnostics.accepted"],
    ["delivered", "diagnostics.delivered"],
    ["unconfirmed", "diagnostics.unconfirmed"],
    ["failed", "diagnostics.failed"],
    ["ambiguous", "diagnostics.ambiguous"],
    ["expired", "diagnostics.expired"],
    ["cancelled", "diagnostics.cancelled"],
    ["abandoned", "diagnostics.abandoned"],
    ["rejected", "diagnostics.rejected"],
    ["bytesAccepted", "diagnostics.bytesAccepted"],
  ] as const satisfies readonly (readonly [keyof RouteCounters, string])[];

  const countFormatters = new Map<Locale, Intl.NumberFormat>();

  /** Locale-grouped integer formatting (Intl, never a raw toString). */
  function formatCount(value: number, locale: Locale): string {
    const existing = countFormatters.get(locale);
    if (existing !== undefined) return existing.format(value);
    const formatter = new Intl.NumberFormat(locale);
    countFormatters.set(locale, formatter);
    return formatter.format(value);
  }

  /** Mirrors routeIsReady: only live compatible Codex endpoints form edges. */
  function isReadyCodexRoute(route: DashboardRouteRow): boolean {
    return (
      route.enabled &&
      route.compatibility === "compatible" &&
      (route.state === "idle" || route.state === "busy")
    );
  }

  /** Identity that survives re-sorted frames better than a bare alias. */
  function rowIdentity(alias: string, host: string): string {
    return `${alias}\u0000${host}`;
  }

  function topologyRowCenterY(index: number): number {
    return (
      TOPOLOGY_PADDING_PX +
      index * TOPOLOGY_ROW_HEIGHT_PX +
      TOPOLOGY_ROW_HEIGHT_PX / 2
    );
  }

  /** Visible edges only; omitted endpoints remain represented by counts. */
  function topologyEdges(data: RoutesData): readonly TopologyEdge[] {
    const claudeIndices = new Map(
      data.peers.map((peer, index) => [peer.alias, index] as const),
    );
    const codexIndices = new Map(
      data.codexRoutes.map((view, index) => [view.route.alias, index] as const),
    );
    const edges: TopologyEdge[] = [];
    for (const pair of data.pairs) {
      const claudeIndex = claudeIndices.get(pair.claudeAlias);
      const codexIndex = codexIndices.get(pair.codexAlias);
      if (claudeIndex === undefined || codexIndex === undefined) continue;
      edges.push({
        claudeIndex,
        codexIndex,
        claudeAlias: pair.claudeAlias,
        codexAlias: pair.codexAlias,
        state: pair.state,
      });
    }
    return edges;
  }

  function isEdgeEndpoint(
    edge: TopologyEdge,
    side: TopologySide,
    index: number,
  ): boolean {
    return side === "claude"
      ? index === edge.claudeIndex
      : index === edge.codexIndex;
  }

  /**
   * Chip highlight: the focused chip and, when the edge joins them, its
   * counterpart read "on"; everything else dims to "off". No focus at all
   * leaves the attribute off entirely so nothing is dimmed at rest.
   */
  function chipHighlight(
    focus: TopologyFocus | undefined,
    edges: readonly TopologyEdge[],
    side: TopologySide,
    index: number,
  ): TopologyHighlight {
    if (focus === undefined) return undefined;
    if (focus.side === side && focus.index === index) return "on";
    if (
      focus.side !== side &&
      edges.some(
        (edge) =>
          isEdgeEndpoint(edge, focus.side, focus.index) &&
          isEdgeEndpoint(edge, side, index),
      )
    ) {
      return "on";
    }
    return "off";
  }

  function edgeHighlight(
    focus: TopologyFocus | undefined,
    edge: TopologyEdge,
  ): TopologyHighlight {
    if (focus === undefined) return undefined;
    return isEdgeEndpoint(edge, focus.side, focus.index) ? "on" : "off";
  }

  type TopologyColumnProps = Readonly<{
    side: TopologySide;
    items: readonly TopologyItem[];
    listLabel: string;
    emptyText: string;
    highlightAt: (side: TopologySide, index: number) => TopologyHighlight;
    onFocusChange: (focus: TopologyFocus | undefined) => void;
  }>;

  function TopologyColumn(props: TopologyColumnProps): React.ReactElement {
    const { side, highlightAt, onFocusChange } = props;
    if (props.items.length === 0) {
      return (
        <div className="topology__col">
          <p className="topology__empty">{props.emptyText}</p>
        </div>
      );
    }
    return (
      <div className="topology__col">
        <div role="list" aria-label={props.listLabel}>
          {props.items.map((item, index) => (
            <div
              key={item.key}
              role="listitem"
              className={
                side === "claude"
                  ? "topo-row topo-row--left"
                  : "topo-row topo-row--right"
              }
              onMouseEnter={() => {
                onFocusChange({ side, index });
              }}
              onMouseLeave={() => {
                onFocusChange(undefined);
              }}
            >
              <span
                className="topo-chip"
                data-side={side}
                data-candidate={item.candidate ? "true" : undefined}
                data-highlight={highlightAt(side, index)}
                tabIndex={0}
                onFocus={() => {
                  onFocusChange({ side, index });
                }}
                onBlur={() => {
                  onFocusChange(undefined);
                }}
              >
                {item.alias}
              </span>
              <span className="sr-only">{item.srLabel}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  type TopologyEdgeSvgProps = Readonly<{
    rows: number;
    edges: readonly TopologyEdge[];
    focus: TopologyFocus | undefined;
    /** Side currently hovered/focused; picks the highlight stroke accent. */
    focusSide: TopologySide | undefined;
  }>;

  /**
   * Decorative bipartite line with a real <title>: the chip lists remain the
   * accessible representation, and the SVG only says what it draws.
   * Geometry and the highlight weight are dynamic numerics (D5/R10), and the
   * stroke token cannot live in a class because app.css carries no rule for
   * this path — both go through the React style prop (CSSOM, CSP-safe).
   * At rest the connector is a quiet hairline; it only takes the hovered
   * side's accent while that side is highlighted.
   */
  function TopologyEdgeSvg(props: TopologyEdgeSvgProps): React.ReactElement {
    const height =
      TOPOLOGY_PADDING_PX * 2 + props.rows * TOPOLOGY_ROW_HEIGHT_PX;
    return (
      <svg
        className="topology__svg"
        width={TOPOLOGY_EDGE_WIDTH_PX}
        height={height}
        viewBox={`0 0 ${TOPOLOGY_EDGE_WIDTH_PX} ${height}`}
        aria-hidden="true"
        focusable="false"
      >
        {props.edges.map((edge) => {
          const highlight = edgeHighlight(props.focus, edge);
          const stroke =
            highlight === "on"
              ? props.focusSide === "codex"
                ? "var(--action-blue)"
                : "var(--coral-accent, var(--coral))"
              : edge.state === "ready"
                ? "var(--hairline)"
                : "var(--warning)";
          return (
            <path
              key={`${edge.claudeAlias}\0${edge.codexAlias}`}
              fill="none"
              d={`M 0 ${topologyRowCenterY(edge.claudeIndex)} C 80 ${topologyRowCenterY(
                edge.claudeIndex,
              )} 140 ${topologyRowCenterY(edge.codexIndex)} ${TOPOLOGY_EDGE_WIDTH_PX} ${topologyRowCenterY(
                edge.codexIndex,
              )}`}
              style={{
                stroke,
                strokeDasharray: edge.state === "ready" ? undefined : "5 4",
                strokeWidth: highlight === "on" ? 2 : 1.25,
                opacity: highlight === "off" ? 0.2 : 1,
              }}
            />
          );
        })}
      </svg>
    );
  }

  type DetailRowProps = Readonly<{
    label: string;
    children?: React.ReactNode;
  }>;

  function DetailRow(props: DetailRowProps): React.ReactElement {
    return (
      <p className="detail-row">
        <span className="detail-label">{props.label}: </span>
        {props.children}
      </p>
    );
  }

  /** Fields the prototype showed that the live contract does not carry. */
  function AbsentDetail(
    props: Readonly<{ fields: readonly string[] }>,
  ): React.ReactElement {
    const t = useT();
    return (
      <p className="detail-row">
        <span className="detail-value detail-value--mono">
          {props.fields.join(" · ")}
        </span>
        <span className="detail-label"> — {t("app.routes.detail.absent")}</span>
      </p>
    );
  }

  function LowerBoundBadge(
    props: Readonly<{ count: number }>,
  ): React.ReactElement {
    const t = useT();
    return (
      <span className="lower-bound">
        {t("app.lowerBound", { count: props.count })}
      </span>
    );
  }

  type AccordionRowProps = Readonly<{
    alias: string;
    open: boolean;
    onToggle: () => void;
    head: React.ReactNode;
    children?: React.ReactNode;
  }>;

  /**
   * One accordion entry. The open state lives in the parent column, so the two
   * columns never share it (the prototype's single `open` quirk).
   */
  function AccordionRow(props: AccordionRowProps): React.ReactElement {
    const baseId = React.useId();
    const buttonId = `${baseId}-summary`;
    const panelId = `${baseId}-panel`;
    return (
      <div className="accordion">
        <button
          type="button"
          id={buttonId}
          className="accordion__row"
          aria-expanded={props.open}
          aria-controls={props.open ? panelId : undefined}
          onClick={props.onToggle}
        >
          <span className="accordion__alias">{props.alias}</span>
          {props.head}
          <span className="accordion__marker" aria-hidden="true">
            {props.open ? "−" : "+"}
          </span>
        </button>
        {props.open ? (
          <div
            className="accordion__panel"
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
          >
            <div className="detail-list">{props.children}</div>
          </div>
        ) : null}
      </div>
    );
  }

  type PeerRowProps = Readonly<{
    peer: DashboardPeerRow;
    open: boolean;
    onToggle: () => void;
    pairs: readonly DashboardPairRow[];
    codexRoutes: readonly CodexRouteView[];
    actionsEnabled: boolean;
    onAction: RoutesTabProps["onAction"];
  }>;

  function PeerAccordionRow(props: PeerRowProps): React.ReactElement {
    const t = useT();
    const peer = props.peer;
    const selectionLabel = peer.selected
      ? t("status.selected")
      : peer.selectable
        ? t("status.available")
        : t("status.notSelectable");
    return (
      <AccordionRow
        alias={peer.alias}
        open={props.open}
        onToggle={props.onToggle}
        head={
          <>
            {peer.selected ? (
              <span
                className="status-dot"
                title={t("status.selected")}
                aria-hidden="true"
              />
            ) : null}
            <StateChip domain="peer" state={peer.state} small />
            {peer.selected ? (
              <span className="chip chip--small" data-kind="positive">
                {selectionLabel}
              </span>
            ) : null}
          </>
        }
      >
        <DetailRow label={t("column.state")}>
          <StateChip domain="peer" state={peer.state} small />
        </DetailRow>
        <DetailRow label={t("column.compatibility")}>
          <StateChip domain="compatibility" state={peer.compatibility} small />
        </DetailRow>
        <DetailRow label={t("column.validation")}>
          <span
            className="chip chip--small"
            data-kind={peer.validated ? "positive" : "warning"}
          >
            {t(
              peer.validated
                ? "status.validated"
                : "status.validationRejected",
            )}
          </span>
        </DetailRow>
        <DetailRow label={t("column.selection")}>
          <span
            className="chip chip--small"
            data-kind={peer.selected ? "positive" : "inert"}
          >
            {selectionLabel}
          </span>
        </DetailRow>
        {peer.selectionGuidance === undefined ? null : (
          <p className="detail-row">
            {t(`peer.reason.${camelCaseToken(peer.selectionGuidance)}`)}
          </p>
        )}
        <DetailRow label={t("column.host")}>
          <span className="detail-value detail-value--mono">{peer.host}</span>
        </DetailRow>
        <DetailRow label={t("column.observed")}>
          {peer.lastSeenAt === undefined ? (
            t("time.unavailable")
          ) : (
            <TimeAgo iso={peer.lastSeenAt} />
          )}
        </DetailRow>
        {peer.safeErrorCode === undefined ? null : (
          <DetailRow label={t("column.issue")}>
            <span className="detail-value detail-value--mono">
              {peer.safeErrorCode}
            </span>
          </DetailRow>
        )}
        <AbsentDetail fields={["binding", "renames", "discovery"]} />
        {peer.selected || peer.selectable
          ? props.codexRoutes.map((view) => {
              const codexAlias = view.route.alias;
              const paired = props.pairs.some(
                (pair) =>
                  pair.claudeAlias === peer.alias &&
                  pair.codexAlias === codexAlias,
              );
              return (
                <ActionControl
                  key={codexAlias}
                  action={{
                    action: paired ? "unpair" : "pair",
                    claudeAlias: peer.alias,
                    codexAlias,
                  }}
                  consequence={t(
                    paired
                      ? "app.routes.unpairCmd.consequence"
                      : "app.routes.pairCmd.consequence",
                    { claude: peer.alias, codex: codexAlias },
                  )}
                  enabled={props.actionsEnabled}
                  onAction={props.onAction}
                />
              );
            })
          : null}
      </AccordionRow>
    );
  }

  type RouteCountersTableProps = Readonly<{
    alias: string;
    counters: RouteCounters;
  }>;

  function RouteCountersTable(
    props: RouteCountersTableProps,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    return (
      <details className="details-block">
        <summary>{t("app.routes.counters")}</summary>
        <div className="details-block__content">
          <div className="table-wrap">
            <table className="data-table">
              <caption className="table-caption">
                {`${t("app.routes.counters")} — ${props.alias}`}
              </caption>
              <tbody>
                {ROUTE_COUNTER_ROWS.map(([field, copyKey]) => (
                  <tr key={field}>
                    <th scope="row">{t(copyKey)}</th>
                    <td className="cell-mono">
                      {formatCount(props.counters[field], locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    );
  }

  type CodexRowProps = Readonly<{
    view: CodexRouteView;
    open: boolean;
    onToggle: () => void;
  }>;

  function CodexAccordionRow(props: CodexRowProps): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const route = props.view.route;
    return (
      <AccordionRow
        alias={route.alias}
        open={props.open}
        onToggle={props.onToggle}
        head={
          <>
            <span
              className="status-dot"
              title={t("app.routes.registered")}
              aria-hidden="true"
            />
            <StateChip domain="route" state={route.state} small />
            {props.view.monitorOnly ? (
              // Short token in the head; the raw safe code stays in the panel.
              <span className="chip chip--small" data-kind="warning">
                {t("app.routes.monitorOnly")}
              </span>
            ) : null}
          </>
        }
      >
        <DetailRow label={t("column.state")}>
          <StateChip domain="route" state={route.state} small />
        </DetailRow>
        <DetailRow label={t("column.compatibility")}>
          <StateChip domain="compatibility" state={route.compatibility} small />
        </DetailRow>
        <DetailRow label={t("column.selection")}>
          <span
            className="chip chip--small"
            data-kind={route.enabled ? "positive" : "inert"}
          >
            {route.enabled ? t("status.enabled") : t("status.disabled")}
          </span>
        </DetailRow>
        <DetailRow label={t("app.routes.queueDepth")}>
          <span className="detail-value detail-value--mono">
            {formatCount(route.queueDepth, locale)}
          </span>
        </DetailRow>
        {props.view.oldestAgeMs === undefined ? null : (
          <DetailRow label={t("app.overview.oldest")}>
            <span className="detail-value detail-value--mono">
              {fmtAge(props.view.oldestAgeMs)}
            </span>
          </DetailRow>
        )}
        {props.view.monitorOnly ? (
          <p className="detail-row">{t("app.routes.monitorOnlyReason")}</p>
        ) : null}
        <DetailRow label={t("column.host")}>
          <span className="detail-value detail-value--mono">{route.host}</span>
        </DetailRow>
        <DetailRow label={t("column.observed")}>
          {route.lastSeenAt === undefined ? (
            t("time.unavailable")
          ) : (
            <TimeAgo iso={route.lastSeenAt} />
          )}
        </DetailRow>
        {route.safeErrorCode === undefined ? null : (
          <DetailRow label={t("column.issue")}>
            <span className="detail-value detail-value--mono">
              {route.safeErrorCode}
            </span>
          </DetailRow>
        )}
        <AbsentDetail fields={["policy", "identity lock", "registered"]} />
        <RouteCountersTable alias={route.alias} counters={route.counters} />
      </AccordionRow>
    );
  }

  function successionScope(item: DashboardAttentionItem, t: Translate): string {
    const parts: string[] = [];
    if (item.provider !== undefined) parts.push(t(`provider.${item.provider}`));
    if (item.alias !== undefined) parts.push(item.alias);
    if (item.host !== undefined) parts.push(item.host);
    if (item.code !== undefined) parts.push(item.code);
    return parts.join(" · ");
  }

  function SuccessionCard(
    props: Readonly<{ view: SuccessionView }>,
  ): React.ReactElement {
    const t = useT();
    const item = props.view.item;
    const scope = successionScope(item, t);
    return (
      <article className="succession-card">
        <div className="succession-card__head">
          <div className="chip-row">
            <MonoLabel>succession</MonoLabel>
            <StateChip domain="severity" state={item.severity} small />
          </div>
          {item.timestamp === undefined ? null : (
            <TimeAgo iso={item.timestamp} />
          )}
        </div>
        <h3 className="card__title succession-card__title">
          {t(`guidance.${props.view.guidanceKey}.title`)}
        </h3>
        <p className="card__body">
          {t(`guidance.${props.view.guidanceKey}.body`)}
        </p>
        {scope === "" ? null : (
          <p className="attention-item__scope">
            {t("attention.scope")}: {scope}
          </p>
        )}
        <p className="card__body">
          {t(`guidance.${props.view.guidanceKey}.action`)}
        </p>
        <AbsentDetail fields={["predecessor", "successor", "drain outcome"]} />
        <p className="succession-note">{t("app.routes.successions.note")}</p>
        <CopyCmd cmd={props.view.command} />
      </article>
    );
  }

  type ActionControlProps = Readonly<{
    action: LiveDashboardAction;
    consequence: string;
    enabled: boolean;
    onAction: RoutesTabProps["onAction"];
  }>;

  function actionLabelKey(action: LiveDashboardAction): string {
    switch (action.action) {
      case "pair":
        return "live.action.pair";
      case "unpair":
        return "live.action.unpair";
      case "refresh_dashboard":
        return "live.action.refresh";
    }
  }

  function ActionControl(props: ActionControlProps): React.ReactElement {
    const t = useT();
    const [confirming, setConfirming] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [result, setResult] = React.useState<
      LiveDashboardActionResult | undefined
    >(undefined);
    const actionIdentity =
      props.action.action === "refresh_dashboard"
        ? props.action.action
        : `${props.action.action}:${props.action.claudeAlias}:${props.action.codexAlias}`;
    React.useEffect(() => {
      setConfirming(false);
      setPending(false);
      setResult(undefined);
    }, [actionIdentity]);
    const baseLabel = t(actionLabelKey(props.action));
    const label =
      props.action.action === "refresh_dashboard"
        ? baseLabel
        : `${baseLabel}: ${props.action.claudeAlias} ↔ ${props.action.codexAlias}`;

    const confirm = async (): Promise<void> => {
      if (!props.enabled || pending) return;
      setPending(true);
      setResult(undefined);
      const next = await props.onAction(props.action);
      setPending(false);
      setConfirming(false);
      setResult(next);
    };

    return (
      <section className="action-card" aria-label={label}>
        <h3 className="action-card__title">{label}</h3>
        <p className="action-card__consequence">{props.consequence}</p>
        {!props.enabled ? (
          <p className="action-card__status" role="status">
            {t("live.action.requiresConnected")}
          </p>
        ) : null}
        {result === undefined ? null : (
          <p
            className="action-card__status"
            data-action-result={result.ok ? "success" : "failure"}
            role="status"
          >
            {t(result.ok ? "live.action.succeeded" : "live.action.failed", {
              code: result.code,
            })}
          </p>
        )}
        {confirming ? (
          <div className="action-card__buttons" role="group" aria-label={label}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!props.enabled || pending}
              onClick={() => {
                void confirm();
              }}
            >
              {pending ? t("live.action.pending") : t("live.action.confirm")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("live.action.cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!props.enabled}
            onClick={() => {
              setResult(undefined);
              setConfirming(true);
            }}
          >
            {label}
          </button>
        )}
      </section>
    );
  }

  export function RoutesTab(props: RoutesTabProps): React.ReactElement {
    const t = useT();
    const data = props.data;
    const openInbound = data.inboundMode === "open";
    const [focus, setFocus] = React.useState<TopologyFocus | undefined>(
      undefined,
    );
    // Separate open state per column — the two accordions never fight.
    const [openPeer, setOpenPeer] = React.useState<string | undefined>(
      undefined,
    );
    const [openRoute, setOpenRoute] = React.useState<string | undefined>(
      undefined,
    );

    const edges = topologyEdges(data);
    const highlightAt = (
      side: TopologySide,
      index: number,
    ): TopologyHighlight => chipHighlight(focus, edges, side, index);

    const claudeItems: readonly TopologyItem[] = data.peers.map(
      (peer, index): TopologyItem => ({
        key: `${rowIdentity(peer.alias, peer.host)}|${index}`,
        alias: peer.alias,
        candidate: !edges.some((edge) => edge.claudeAlias === peer.alias),
        srLabel: edges.some((edge) => edge.claudeAlias === peer.alias)
          ? t("status.selected")
          : peer.selectable
            ? t("status.available")
            : t("status.notSelectable"),
      }),
    );
    const codexItems: readonly TopologyItem[] = data.codexRoutes.map(
      (view, index): TopologyItem => ({
        key: `${rowIdentity(view.route.alias, view.route.host)}|${index}`,
        alias: view.route.alias,
        candidate: !edges.some(
          (edge) => edge.codexAlias === view.route.alias,
        ),
        srLabel: t(`route.${camelCaseToken(view.route.state)}`),
      }),
    );

    return (
      <div className="tab-panel">
        <section className="section" aria-label={t("app.routes.topology")}>
          <MonoLabel className="section-label">
            {t("app.routes.topology")}
          </MonoLabel>
          <div className="inbound-policy" data-inbound-mode={data.inboundMode}>
            <span
              className="chip chip--small"
              data-kind={openInbound ? "warning" : "inert"}
            >
              {t(
                openInbound
                  ? "inbound.open.badge"
                  : "inbound.paired.badge",
              )}
            </span>
            <p>
              {t(
                openInbound
                  ? "inbound.open.body"
                  : edges.length === 0
                    ? "inbound.noPair.body"
                    : "inbound.paired.body",
              )}
            </p>
          </div>
          <div className="topology">
            <div className="topology__heads">
              <MonoLabel className="topology__head--claude">
                {t("provider.claude")}
              </MonoLabel>
              <MonoLabel className="topology__head--codex">
                {t("provider.codex")}
              </MonoLabel>
            </div>
            <div className="topology__cols">
              <TopologyColumn
                side="claude"
                items={claudeItems}
                listLabel={t("app.routes.candidates")}
                emptyText={t("app.routes.noPeers")}
                highlightAt={highlightAt}
                onFocusChange={setFocus}
              />
              <TopologyEdgeSvg
                rows={Math.max(claudeItems.length, codexItems.length)}
                edges={edges}
                focus={focus}
                focusSide={focus === undefined ? undefined : focus.side}
              />
              <TopologyColumn
                side="codex"
                items={codexItems}
                listLabel={t("app.routes.codexRoutes")}
                emptyText={t("app.routes.noCodex")}
                highlightAt={highlightAt}
                onFocusChange={setFocus}
              />
            </div>
            {edges.length === 0 ? (
              <p className="topology__empty">
                {t(
                  openInbound
                    ? "inbound.open.body"
                    : "app.routes.noPairInline",
                )}
              </p>
            ) : (
              <ul
                className="topology__edge-list"
                aria-label={t("app.routes.pairs")}
              >
                {edges.map((edge) => (
                  <li key={`${edge.claudeAlias}\0${edge.codexAlias}`}>
                    {t("app.routes.pairDescription", {
                      claude: edge.claudeAlias,
                      codex: edge.codexAlias,
                    })}{" "}
                    <StateChip domain="route" state={edge.state === "ready" ? "idle" : "stale"} small />
                  </li>
                ))}
              </ul>
            )}
            {data.pairsOmitted > 0 ? (
              <p className="topology__empty">
                {t("app.omitted.pairs", { count: data.pairsOmitted })}
              </p>
            ) : null}
          </div>
          {/* Subordinate to the topology, exactly as the pair controls were. */}
          <section
            className="section section__sub"
            aria-label={t("live.action.sectionTitle")}
          >
            <div className="row-baseline section-label">
              <MonoLabel>{t("live.action.sectionTitle")}</MonoLabel>
            </div>
            <p className="section-teaching">{t("live.action.scope")}</p>
            <div className="action-panel">
              <ActionControl
                action={{ action: "refresh_dashboard" }}
                consequence={t("app.routes.refreshCmd")}
                enabled={props.actionsEnabled}
                onAction={props.onAction}
              />
            </div>
          </section>
        </section>

        <section className="section" aria-label={t("app.routes.claudeSessions")}>
          <div className="row-baseline row-baseline--split section-label">
            <MonoLabel>{t("app.routes.claudeSessions")}</MonoLabel>
            {data.peersOmitted > 0 ? (
              <LowerBoundBadge count={data.peers.length} />
            ) : null}
          </div>
          {data.peers.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state__text">{t("app.routes.noPeers")}</p>
              <CopyCmd cmd={SELECT_CLAUDE_COMMAND} />
            </div>
          ) : (
            <div>
              {data.peers.map((peer, index) => {
                const identity = rowIdentity(peer.alias, peer.host);
                return (
                  <PeerAccordionRow
                    key={`${identity}|${index}`}
                    peer={peer}
                    open={openPeer === identity}
                    pairs={data.pairs}
                    codexRoutes={data.codexRoutes}
                    actionsEnabled={props.actionsEnabled}
                    onAction={props.onAction}
                    onToggle={() => {
                      setOpenPeer(openPeer === identity ? undefined : identity);
                    }}
                  />
                );
              })}
            </div>
          )}
          <Rule />
        </section>

        <section className="section" aria-label={t("app.routes.codexRoutes")}>
          <div className="row-baseline row-baseline--split section-label">
            <MonoLabel>{t("app.routes.codexRoutes")}</MonoLabel>
            {data.routesOmitted > 0 ? (
              <LowerBoundBadge count={data.codexRoutes.length} />
            ) : null}
          </div>
          {data.codexRoutes.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state__text">{t("app.routes.noCodex")}</p>
            </div>
          ) : (
            <div>
              {data.codexRoutes.map((view, index) => {
                const identity = rowIdentity(view.route.alias, view.route.host);
                return (
                  <CodexAccordionRow
                    key={`${identity}|${index}`}
                    view={view}
                    open={openRoute === identity}
                    onToggle={() => {
                      setOpenRoute(
                        openRoute === identity ? undefined : identity,
                      );
                    }}
                  />
                );
              })}
            </div>
          )}
          <Rule />
          {/* Registration is never a control here: it must run inside the
              Codex task, so the teaching command stays visible in both the
              empty and the populated section. */}
          <div className="stack routes-register">
            <p className="text-xs text-body-muted">
              {t("app.routes.registerHint")}
            </p>
            <CopyCmd cmd={REGISTER_CODEX_COMMAND} />
          </div>
        </section>

        <section className="section" aria-label={t("app.routes.successions")}>
          <MonoLabel className="section-label">
            {t("app.routes.successions")}
          </MonoLabel>
          {data.successions.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state__text">
                {t("app.routes.successions.empty")}
              </p>
              <p className="succession-note">
                {t("app.routes.successions.note")}
              </p>
              <CopyCmd cmd={SUCCEEDS_COMMAND} />
            </div>
          ) : (
            <div className="stack-lg">
              {data.successions.map((view, index) => (
                <SuccessionCard
                  key={`${view.guidanceKey}|${view.item.alias ?? ""}|${index}`}
                  view={view}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }
}
