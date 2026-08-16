// Overview tab (spec §4.2) — status strip, exchange board, needs-attention,
// and the terminal-state pulse.
//
// Everything rendered here is a pure function of OverviewTabProps (produced by
// adapter.overviewProps) plus the shared ticking clock; there is no window.*
// access, no overview mutation, and no dead control. Removed with intent versus the
// designer prototype: applyQueueRaise, the confirm bars, the useReducer
// force-update, the EMB_DATA writes, the open-mode banner (pair modes have not
// landed), the lease status card (not in the live contract), and the phantom
// `released` pulse bar. The board keeps the prototype's three-column
// composition (claude · edges-or-no-pair · codex); anything that would make a
// fourth column or a fourth node line — the no-pair explanation when queues
// are shown, and the next-action sentences — renders under the board.
namespace Embassy {
  /** Pulse bar geometry: 6px floor, +38px at the tallest bar (prototype parity). */
  const PULSE_BAR_BASE_PX = 6;
  const PULSE_BAR_RANGE_PX = 38;

  /**
   * The one literal teaching command on this tab. Queue depth is an env var
   * read at `embassy serve` start (R2) — there is no in-app raise action.
   */
  const QUEUE_DEPTH_COMMAND = "EMBASSY_MAX_QUEUE_MESSAGES=<n> embassy serve";

  /**
   * Lower-bound badge (`app.lowerBound`): the short form is the visible chip,
   * the full sentence is what assistive tech and the tooltip get.
   */
  function LowerBound(props: Readonly<{ count: number }>): React.ReactElement {
    const t = useT();
    const sentence = t("app.lowerBound", { count: props.count });
    return (
      <span className="lower-bound" title={sentence}>
        <span aria-hidden="true">
          {t("count.atLeast", { count: props.count })}
        </span>
        <span className="sr-only">{sentence}</span>
      </span>
    );
  }

  type StatusCardProps = Readonly<{
    label: string;
    chip: React.ReactNode;
    detail: string | undefined;
  }>;

  function StatusCard(props: StatusCardProps): React.ReactElement {
    return (
      <div className="status-card">
        <div className="status-card__head">
          <span className="status-card__label">{props.label}</span>
          {props.chip}
        </div>
        {props.detail === undefined ? null : (
          <span className="status-card__detail">{props.detail}</span>
        )}
      </div>
    );
  }

  /**
   * Health card. `undefined` means no connector of that provider was observed
   * at all — an inert "no connector reported" chip, never a fake health value.
   */
  function HealthStatusCard(
    props: Readonly<{ label: string; health: ConnectorHealth | undefined }>,
  ): React.ReactElement {
    const t = useT();
    const health = props.health;
    if (health === undefined) {
      return (
        <StatusCard
          label={props.label}
          detail={undefined}
          chip={
            <span className="chip chip--small" data-kind="inert">
              {t("app.overview.connectorMissing")}
            </span>
          }
        />
      );
    }
    return (
      <StatusCard
        label={props.label}
        detail={t(`health.meaning.${camelCaseToken(health)}`)}
        chip={<StateChip domain="health" state={health} small />}
      />
    );
  }

  type ExchangeNodeProps = Readonly<{
    title: string;
    sub: string;
    party: DashboardExchangeParty;
    countLine: string;
  }>;

  /**
   * One party of the exchange board — both sides are wired (the prototype read
   * only Claude). Node body stays at the prototype's short line count: the
   * next-action sentences run to full sentences, so they render once beneath
   * the board (`.exchange-notes`) instead of wrapping inside a 210px node and
   * desynchronising the two nodes' heights.
   */
  function ExchangeNode(props: ExchangeNodeProps): React.ReactElement {
    const party = props.party;
    return (
      <div className="exchange-node">
        <div>
          <div className="exchange-node__title">{props.title}</div>
          <div className="exchange-node__sub">{props.sub}</div>
        </div>
        <div className="chip-row">
          <StateChip domain="party" state={party.status} small />
          {party.countIsLowerBound ? <LowerBound count={party.total} /> : null}
        </div>
        <div className="exchange-node__line">{props.countLine}</div>
        {party.primaryAlias === undefined ? null : (
          <div className="exchange-node__line mono">{party.primaryAlias}</div>
        )}
      </div>
    );
  }

  /**
   * Queue age on the live wall clock (R13): recomputed from `oldestQueuedAt`
   * against this component's own 30 s tick so the age keeps counting between
   * stream frames, whatever clock produced the props. The server's
   * `queueAgeMs` is never read.
   */
  function liveQueueAgeMs(
    queue: QueueSummary,
    nowMs: number,
  ): number | undefined {
    const queuedMs = parseTimestampMs(queue.oldestQueuedAt);
    if (queuedMs === undefined) return queue.oldestAgeMs;
    return Math.max(0, nowMs - queuedMs);
  }

  type ExchangeEdgeProps = Readonly<{
    label: string;
    direction: "out" | "in";
    queue: QueueSummary;
  }>;

  function ExchangeEdge(props: ExchangeEdgeProps): React.ReactElement {
    const t = useT();
    const nowMs = useNowMs();
    const queue = props.queue;
    const inbound = props.direction === "in";
    const ageMs = liveQueueAgeMs(queue, nowMs);
    const oldest =
      queue.depth > 0 && ageMs !== undefined
        ? ` · ${t("app.overview.oldest")} ${fmtAge(ageMs)}`
        : "";
    return (
      <div className="exchange-edge">
        <div className="edge-label">{props.label}</div>
        <div className="edge-line">
          <span
            className={
              inbound ? "edge-arrow edge-arrow--in" : "edge-arrow edge-arrow--out"
            }
            aria-hidden="true"
          >
            {inbound ? "←" : "→"}
          </span>
        </div>
        <div
          className="edge-queue"
          data-active={queue.depth > 0 ? "true" : "false"}
        >
          {`${t("app.overview.depth")} ${queue.depth}${oldest}`}
        </div>
        {queue.depthIsLowerBound ? <LowerBound count={queue.depth} /> : null}
      </div>
    );
  }

  /** Scope line parts for an attention item: provider · alias · host · code. */
  function attentionScopeParts(
    item: DashboardAttentionItem,
    t: Translate,
  ): readonly string[] {
    const parts: string[] = [];
    if (item.provider !== undefined) {
      parts.push(t(`provider.${item.provider}`));
    }
    if (item.alias !== undefined) parts.push(item.alias);
    if (item.host !== undefined) parts.push(item.host);
    if (item.code !== undefined) parts.push(item.code);
    return parts;
  }

  export function attentionQueueDepthLine(
    item: DashboardAttentionItem,
    t: Translate,
    locale: Locale,
  ): string | undefined {
    return item.queueDepth === undefined
      ? undefined
      : `${t("app.routes.queueDepth")}: ${item.queueDepth.toLocaleString(locale)}`;
  }

  function AttentionItem(
    props: Readonly<{ view: AttentionView }>,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const { item, guidanceKey, command } = props.view;
    const scope = attentionScopeParts(item, t).join(" · ");
    const queueDepthLine = attentionQueueDepthLine(item, t, locale);
    return (
      <div className="attention-item">
        <div className="attention-item__head">
          <StateChip domain="severity" state={item.severity} small />
          <h3 className="attention-item__title">
            {t(`guidance.${guidanceKey}.title`)}
          </h3>
          {item.timestamp === undefined ? null : (
            <TimeAgo iso={item.timestamp} />
          )}
        </div>
        <p className="attention-item__body">
          {t(`guidance.${guidanceKey}.body`)}
        </p>
        <p className="attention-item__body">
          {t(`guidance.${guidanceKey}.action`, {
            alias: item.alias ?? "<alias>",
          })}
        </p>
        {queueDepthLine === undefined ? null : (
          <p className="attention-item__body">{queueDepthLine}</p>
        )}
        {scope === "" ? null : (
          <div className="attention-item__scope">
            {`${t("attention.scope")}: ${scope}`}
          </div>
        )}
        <div className="attention-item__action">
          <CopyCmd cmd={command} />
        </div>
        {item.guidance === "queue_stalled" ? (
          <AbsentFeature
            title={t("app.diag.queue.title")}
            body={t("app.diag.editable.note")}
            cmd={QUEUE_DEPTH_COMMAND}
          />
        ) : null}
      </div>
    );
  }

  type PulseBarButtonProps = Readonly<{
    bar: PulseBar;
    maxCount: number;
    onSelect: (state: DeliveryState) => void;
  }>;

  function PulseBarButton(props: PulseBarButtonProps): React.ReactElement {
    const t = useT();
    const { bar } = props;
    const viewIn = t("app.overview.viewIn");
    const heightPx =
      PULSE_BAR_BASE_PX + (PULSE_BAR_RANGE_PX * bar.count) / props.maxCount;
    return (
      <button
        type="button"
        className="pulse-bar-btn"
        title={viewIn}
        aria-label={`${bar.state}: ${bar.count} — ${viewIn}`}
        onClick={() => {
          props.onSelect(bar.state);
        }}
      >
        <span className="pulse-count">{bar.count}</span>
        <span
          className="pulse-bar"
          data-kind={chipKindFor(bar.state)}
          data-empty={bar.count === 0 ? "true" : "false"}
          style={{ height: `${heightPx}px` }}
        />
        <StateChip state={bar.state} small />
      </button>
    );
  }

  export function OverviewTab(props: OverviewTabProps): React.ReactElement {
    const t = useT();
    const { data, onViewDeliveries } = props;
    const openInbound = data.inboundMode === "open";
    const hasConsentEdge =
      data.graph.consentEdgeCount > 0 ||
      data.graph.consentEdgeCountIsLowerBound;
    const showAttention =
      data.attention.length > 0 || data.attentionOmitted > 0;
    const maxPulse = data.pulse.bars.reduce(
      (largest, bar) => Math.max(largest, bar.count),
      1,
    );
    const selectPulseState = React.useCallback(
      (state: DeliveryState) => {
        onViewDeliveries({ state });
      },
      [onViewDeliveries],
    );

    const idPrefix = React.useId();
    const stripId = `${idPrefix}-strip`;
    const exchangeId = `${idPrefix}-exchange`;
    const attentionId = `${idPrefix}-attention`;
    const pulseId = `${idPrefix}-pulse`;

    return (
      <div className="tab-panel">
        <section className="section" aria-labelledby={stripId}>
          <h2 className="mono-label section-label" id={stripId}>
            {t("app.overview.statusStrip")}
          </h2>
          <div className="status-strip">
            <HealthStatusCard
              label={t("app.overview.broker")}
              health={data.statusStrip.broker}
            />
            {data.statusStrip.providers.map(({ provider, health }) => (
              <HealthStatusCard
                key={provider}
                label={t(`provider.${provider}`)}
                health={health}
              />
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby={exchangeId}>
          <div className="row section-label section-head">
            <h2 className="mono-label" id={exchangeId}>
              {t("exchange.eyebrow")}
            </h2>
            <Tooltip tip={t("exchange.note")} wrap>
              <span className="info-dot">i</span>
            </Tooltip>
          </div>
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
                  : hasConsentEdge
                    ? "inbound.paired.body"
                    : "inbound.noPair.body",
              )}
            </p>
          </div>
          <div className="exchange-board">
            {data.exchange.parties.map((party) => (
              <ExchangeNode
                key={party.kind}
                title={t(`provider.${party.kind}`)}
                sub={party.kind}
                party={party}
                countLine={`${party.ready}/${party.total}`}
              />
            ))}
          </div>
          <div className="exchange-edges">
            {data.providerQueues.map(({ provider, queue }) => (
              <ExchangeEdge
                key={provider}
                direction="in"
                label={t(`provider.${provider}`)}
                queue={queue}
              />
            ))}
          </div>
          {data.degradedConsentEdgeCopyKey === undefined ? null : (
            <p className="text-xs text-body-muted">
              {t(data.degradedConsentEdgeCopyKey)}
            </p>
          )}
        </section>

        {showAttention ? (
          <section className="section" aria-labelledby={attentionId}>
            <div className="row section-label section-head">
              <h2 className="mono-label" id={attentionId}>
                {t("attention.eyebrow")}
              </h2>
              {data.attentionOmitted > 0 ? (
                <LowerBound count={data.attention.length} />
              ) : null}
            </div>
            <div className="attention-list">
              {data.attention.map((view, index) => (
                <AttentionItem
                  key={`${view.item.kind}|${view.item.guidance}|${view.item.alias ?? ""}|${view.item.host ?? ""}|${index}`}
                  view={view}
                />
              ))}
            </div>
            {data.attentionOmitted > 0 ? (
              <p className="footnote">{t("attention.projectionOnly")}</p>
            ) : null}
          </section>
        ) : null}

        <section className="section" aria-labelledby={pulseId}>
          <h2 className="mono-label section-label" id={pulseId}>
            {t("app.overview.pulse.title")}
          </h2>
          {data.pulse.total === 0 ? (
            <p className="pulse-empty">{t("app.overview.pulse.empty")}</p>
          ) : null}
          <div className="pulse">
            {data.pulse.bars.map((bar) => (
              <PulseBarButton
                key={bar.state}
                bar={bar}
                maxCount={maxPulse}
                onSelect={selectPulseState}
              />
            ))}
          </div>
          <p className="pulse-caption">
            {t("app.overview.pulse.caption")}
            {data.pulse.isLowerBound ? " " : null}
            {data.pulse.isLowerBound ? (
              <LowerBound count={data.pulse.total} />
            ) : null}
          </p>
        </section>
      </div>
    );
  }
}
