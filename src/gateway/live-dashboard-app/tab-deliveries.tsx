// Deliveries tab (§4.3) — the retained delivery register.
//
// Honesty rules this file is built around:
//   * `model.activity` IS the grouping; rows render in server order
//     (latest-event desc, tie sourceAlias asc) — never re-sorted here.
//   * There is no conversation token in the public snapshot, so the secondary
//     grouping is the route pair and `app.deliveries.noConv` says so out loud.
//   * Bodies are never retained: the body section has exactly one branch.
//   * A lifecycle is only the *retained* transitions; sequence gaps and the
//     bounded-display omissions are surfaced, never smoothed over.
//   * `delivered` on a codex→claude delivery renders `qualified`, not green
//     (released ≠ read) — chips.tsx owns that rule via the direction prop.
//
// Accessibility note on the list: the spec asks for row buttons carrying
// `aria-selected` plus a real caption. `aria-selected` is not a button
// attribute in ARIA, so the list is a single-select listbox whose options are
// buttons (roving tabindex, Arrow/Home/End), and the caption is a visible
// element referenced by `aria-labelledby` — the caption is real text with a
// real programmatic association rather than a `<caption>` orphaned from a
// table this list is not.
namespace Embassy {
  type DirectionFilter = "all" | MessageDirection;
  type StateFilter = "all" | DeliveryState;
  type ViewMode = "byRoute" | "flat";

  /** The real closed 13 (§3.2), in the spec's table order. */
  const DELIVERY_STATE_FILTERS = [
    "queued",
    "dispatching",
    "transport_written",
    "held",
    "duplicate",
    "delivered",
    "unconfirmed",
    "ambiguous",
    "failed",
    "expired",
    "rejected",
    "cancelled",
    "abandoned",
  ] as const satisfies readonly DeliveryState[];

  type UncoveredDeliveryState = Exclude<
    DeliveryState,
    (typeof DELIVERY_STATE_FILTERS)[number]
  >;

  /** Adding a state to the union without a pill here is a compile error. */
  type DeliveryStateCoverage = [UncoveredDeliveryState] extends [never]
    ? true
    : "tab-deliveries: DELIVERY_STATE_FILTERS is missing a DeliveryState";

  const DELIVERY_STATE_FILTERS_COVER_THE_UNION: DeliveryStateCoverage = true;

  const DIRECTION_FILTERS: readonly MessageDirection[] = [
    "claude_to_codex",
    "codex_to_claude",
  ];

  const DIRECTION_COPY_KEYS: Readonly<Record<MessageDirection, string>> = {
    claude_to_codex: "direction.claudeToCodex",
    codex_to_claude: "direction.codexToClaude",
  };

  /**
   * The two directional filter pills read Claude-first (`Claude → Codex` /
   * `Claude ← Codex`) so they align on the same subject; the detail rail keeps
   * the neutral `direction.*` phrasing shared with the other surfaces.
   */
  const DIRECTION_PILL_COPY_KEYS: Readonly<Record<MessageDirection, string>> = {
    claude_to_codex: "direction.claudeToCodex",
    codex_to_claude: "app.deliveries.dir.codexToClaude",
  };

  /** Teaching command for both empty states (a real CLI verb; body on stdin). */
  const SEND_TO_CODEX_CMD = "embassy send-to-codex --from <alias> --to <alias>";

  const countFormatters = new Map<Locale, Intl.NumberFormat>();

  function fmtCount(locale: Locale, value: number): string {
    const existing = countFormatters.get(locale);
    if (existing !== undefined) return existing.format(value);
    const formatter = new Intl.NumberFormat(locale);
    countFormatters.set(locale, formatter);
    return formatter.format(value);
  }

  function includesFold(
    haystack: string | undefined,
    needleLower: string,
  ): boolean {
    return haystack !== undefined && haystack.toLowerCase().includes(needleLower);
  }

  function equalsFold(value: string | undefined, wantedLower: string): boolean {
    return value !== undefined && value.toLowerCase() === wantedLower;
  }

  /**
   * Case-insensitive free-text match across suffix, both aliases and every
   * safe code (group-level and per-event) — one folded comparison for all
   * fields, so filtering never splits on case.
   */
  function matchesQuery(view: DeliveryGroupView, needleLower: string): boolean {
    if (needleLower === "") return true;
    const group = view.group;
    return (
      includesFold(group.messageIdSuffix, needleLower) ||
      includesFold(group.sourceAlias, needleLower) ||
      includesFold(group.targetAlias, needleLower) ||
      includesFold(group.safeErrorCode, needleLower) ||
      group.events.some((event) =>
        includesFold(event.safeErrorCode, needleLower),
      )
    );
  }

  /**
   * Token jump: an exact `messageIdSuffix` hit wins; otherwise an exact safe
   * code (group-level or on any retained event) selects the first group that
   * carries it. Anything else leaves the selection alone and only filters.
   */
  function findPresetTarget(
    groups: readonly DeliveryGroupView[],
    token: string,
  ): DeliveryGroupView | undefined {
    const wanted = token.trim().toLowerCase();
    if (wanted === "") return undefined;
    const bySuffix = groups.find((view) =>
      equalsFold(view.group.messageIdSuffix, wanted),
    );
    if (bySuffix !== undefined) return bySuffix;
    return groups.find(
      (view) =>
        equalsFold(view.group.safeErrorCode, wanted) ||
        view.group.events.some((event) =>
          equalsFold(event.safeErrorCode, wanted),
        ),
    );
  }

  type RoutePairGroup = Readonly<{
    pair: string;
    rows: readonly DeliveryGroupView[];
  }>;

  /** Route-pair buckets in first-appearance order — the server sort is kept. */
  function groupByRoutePair(
    views: readonly DeliveryGroupView[],
  ): readonly RoutePairGroup[] {
    const order: string[] = [];
    const buckets = new Map<string, DeliveryGroupView[]>();
    for (const view of views) {
      const bucket = buckets.get(view.routePair);
      if (bucket === undefined) {
        buckets.set(view.routePair, [view]);
        order.push(view.routePair);
      } else {
        bucket.push(view);
      }
    }
    return order.map((pair) => ({ pair, rows: buckets.get(pair) ?? [] }));
  }

  /**
   * Transitions the retention budget dropped inside one group, counted from
   * gaps in the store-global `sequence` between adjacent retained events.
   */
  function droppedEventCount(group: DashboardMessageGroup): number {
    let dropped = 0;
    for (let index = 1; index < group.events.length; index += 1) {
      const previous = group.events[index - 1];
      const current = group.events[index];
      if (previous === undefined || current === undefined) continue;
      const gap = current.sequence - previous.sequence - 1;
      if (gap > 0) dropped += gap;
    }
    return dropped;
  }

  type DetailRowProps = Readonly<{
    label: string;
    mono?: boolean | undefined;
    children?: React.ReactNode;
  }>;

  function DetailRow(props: DetailRowProps): React.ReactElement {
    return (
      <div className="detail-row">
        <span className="detail-label">{props.label}</span>{" "}
        <span
          className={
            props.mono === true
              ? "detail-value detail-value--mono"
              : "detail-value"
          }
        >
          {props.children}
        </span>
      </div>
    );
  }

  type LifecycleProps = Readonly<{ group: DashboardMessageGroup }>;

  /**
   * Retained transitions, oldest first, exactly as the server retained them.
   * Only the last dot is coloured (it is the state the delivery is in now);
   * every row carries its own chip, times, safe code, latency and meaning.
   */
  function DeliveryLifecycle(props: LifecycleProps): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const events = props.group.events;
    return (
      <div className="lifecycle">
        {events.map((event, index) => {
          const isLast = index === events.length - 1;
          const kind = chipKindFor(
            event.state,
            props.group.direction,
            event.safeErrorCode,
          );
          const noteParts: string[] = [];
          if (event.safeErrorCode !== undefined) {
            noteParts.push(event.safeErrorCode);
          }
          if (event.latencyMs !== undefined) {
            noteParts.push(`${fmtCount(locale, event.latencyMs)} ms`);
          }
          return (
            <div className="lifecycle-item" key={event.sequence}>
              <div className="lifecycle-rail" aria-hidden={true}>
                <span
                  className="lifecycle-dot"
                  data-kind={isLast ? kind : undefined}
                />
                {isLast ? null : <span className="lifecycle-connector" />}
              </div>
              <div className="lifecycle-body">
                <div className="lifecycle-head">
                  <StateChip
                    small={true}
                    state={event.state}
                    direction={props.group.direction}
                    safeErrorCode={event.safeErrorCode}
                  />
                  {event.timestamp === undefined ? (
                    <span className="lifecycle-abs">{t("time.unavailable")}</span>
                  ) : (
                    <React.Fragment>
                      <TimeAgo iso={event.timestamp} />
                      <span className="lifecycle-abs">
                        {fmtAbs(event.timestamp, locale)}
                      </span>
                    </React.Fragment>
                  )}
                </div>
                {noteParts.length === 0 ? null : (
                  <div className="lifecycle-note">{noteParts.join(" · ")}</div>
                )}
                <div className="lifecycle-meaning">
                  {t(
                    deliveryMeaningKey(
                      event.state,
                      event.safeErrorCode,
                      props.group.direction,
                    ),
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  type DeliveryDetailProps = Readonly<{ view: DeliveryGroupView }>;

  /**
   * Detail rail for one delivery group. Mounted with the row key so the raw
   * JSON toggle resets when the selection changes.
   */
  function DeliveryDetail(props: DeliveryDetailProps): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const [rawOpen, setRawOpen] = React.useState(false);
    const rawId = React.useId();
    const group = props.view.group;
    const dropped = droppedEventCount(group);
    const frames = group.events.filter(
      (event) => event.safeErrorCode !== undefined,
    );
    const earliest = group.events[0]?.timestamp;
    return (
      <div className="detail-pane">
        {/* Header is exactly two lines — the state is read from the
            lifecycle timeline immediately below it. */}
        <div className="detail-pane__head">
          <span className="detail-pane__id">
            {group.messageIdSuffix ?? "—"}
            {group.steer === true ? " · STEER" : ""}
          </span>
          <div className="detail-pane__sub">
            {props.view.routePair} · {t(DIRECTION_COPY_KEYS[group.direction])}
          </div>
        </div>

        <div>
          <MonoLabel className="section-label section-label--lifecycle">
            {t("app.deliveries.lifecycle")}
          </MonoLabel>
          <DeliveryLifecycle group={group} />
          {props.view.eventsTruncated ? (
            <p className="truncation-note">
              {t("app.deliveries.eventsTruncated", {
                count: fmtCount(locale, dropped),
              })}
            </p>
          ) : null}
        </div>

        {/* Bodies are never retained — one branch, no window, no cap. */}
        <div>
          <MonoLabel className="section-label section-label--body">
            {t("app.deliveries.bodyLabel")}
          </MonoLabel>
          <p className="detail-pane__sub">{t("app.deliveries.bodiesNote")}</p>
        </div>

        <div>
          <MonoLabel className="section-label section-label--frames">
            {t("app.deliveries.frames")}
          </MonoLabel>
          {frames.length === 0 ? (
            <p className="detail-pane__sub">{t("app.deliveries.noFrames")}</p>
          ) : (
            <div className="frames-list">
              {frames.map((event) => (
                <div className="frame-item" key={event.sequence}>
                  <span className="frame-code">{event.safeErrorCode}</span>
                  {event.timestamp === undefined ? (
                    <span className="lifecycle-abs">
                      {t("time.unavailable")}
                    </span>
                  ) : (
                    <TimeAgo iso={event.timestamp} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live-model facts the prototype had no source for; they sit after
            the canonical lifecycle → body → frames sequence so the header
            stays adjacent to the lifecycle. */}
        <div className="detail-list">
          {group.latencyMs === undefined ? null : (
            <DetailRow label={t("activity.column.elapsed")} mono={true}>
              {`${fmtCount(locale, group.latencyMs)} ms`}
            </DetailRow>
          )}
          <DetailRow label={t("activity.column.size")} mono={true}>
            {`${fmtCount(locale, group.bytes)} B`}
          </DetailRow>
          <DetailRow label={t("app.deliveries.earliestRetained")}>
            {earliest === undefined ? (
              t("time.unavailable")
            ) : (
              <React.Fragment>
                <TimeAgo iso={earliest} /> · {fmtAbs(earliest, locale)}
              </React.Fragment>
            )}
          </DetailRow>
          {group.safeErrorCode === undefined ? null : (
            <DetailRow label={t("column.issue")} mono={true}>
              {group.safeErrorCode}
            </DetailRow>
          )}
        </div>

        <div>
          <button
            type="button"
            className="toggle-link"
            aria-expanded={rawOpen}
            aria-controls={rawOpen ? rawId : undefined}
            onClick={() => {
              setRawOpen(!rawOpen);
            }}
          >
            {rawOpen ? t("app.deliveries.hideRaw") : t("app.deliveries.raw")}
          </button>
          {rawOpen ? (
            <pre className="raw-json" id={rawId} tabIndex={0}>
              {JSON.stringify(group, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    );
  }

  type DeliveriesEmptyProps = Readonly<{ text: string }>;

  function DeliveriesEmpty(props: DeliveriesEmptyProps): React.ReactElement {
    return (
      <div className="empty-state">
        <p className="empty-state__text">{props.text}</p>
        <CopyCmd cmd={SEND_TO_CODEX_CMD} />
      </div>
    );
  }

  const WATCH_EVENT_COPY_KEYS: Readonly<
    Record<DashboardProgressWatchEventRow["kind"], string>
  > = {
    opened: "watches.event.opened",
    nudge: "watches.event.nudge",
    worker_reported_complete: "watches.event.workerReportedComplete",
    capability_degraded: "watches.event.capabilityDegraded",
    done: "watches.event.done",
    unresponsive: "watches.event.unresponsive",
    endpoint_retired: "watches.event.endpointRetired",
    disabled: "watches.event.disabled",
  };

  function ProgressWatchRegister(
    props: Readonly<{
      watches: readonly DashboardProgressWatchRow[];
      events: readonly DashboardProgressWatchEventRow[];
    }>,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    return (
      <section className="watch-register" aria-labelledby="watch-register-title">
        <div className="row-baseline section-label">
          <div>
            <MonoLabel>{t("watches.eyebrow")}</MonoLabel>
            <h2 id="watch-register-title">{t("watches.title")}</h2>
          </div>
          <span className="mono text-muted">
            {fmtCount(locale, props.watches.length)}
          </span>
        </div>
        <p className="footnote">{t("watches.note")}</p>
        {props.watches.length === 0 ? (
          <p className="watch-register__empty">{t("watches.empty")}</p>
        ) : (
          <div className="watch-grid">
            {props.watches.map((watch) => (
              <article
                className="watch-card"
                data-phase={watch.phase}
                key={`${watch.ownerAlias}|${watch.workerAlias}|${watch.conversationIdSuffix}`}
              >
                <div className="watch-card__head">
                  <code>…{watch.conversationIdSuffix}</code>
                  <StateChip
                    domain="severity"
                    state={watch.phase === "episode" ? "warning" : "info"}
                    label={t(
                      watch.phase === "episode"
                        ? "watches.phase.episode"
                        : "watches.phase.quiet",
                    )}
                    note={t(
                      watch.phase === "episode"
                        ? "watches.phase.episode"
                        : "watches.phase.quiet",
                    )}
                  />
                </div>
                <strong>{watch.ownerAlias} → {watch.workerAlias}</strong>
                <dl className="watch-card__facts">
                  <div><dt>{t("watches.column.quietFor")}</dt><dd><TimeAgo iso={watch.lastActivityAt} /></dd></div>
                  <div><dt>{t("watches.column.nextAction")}</dt><dd><TimeAgo iso={watch.nextActionAt} /></dd></div>
                  <div><dt>{t("watches.column.nudges")}</dt><dd>{fmtCount(locale, watch.nudgeCount)}</dd></div>
                  <div><dt>{t("watches.column.capability")}</dt><dd>{t(watch.capability === "route" ? "watches.capability.route" : "watches.capability.conversation")}</dd></div>
                </dl>
                {watch.workerReportedComplete ? (
                  <p className="footnote">{t("watches.workerComplete")}</p>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {props.events.length === 0 ? null : (
          <details className="watch-history">
            <summary>{t("watches.history.title")}</summary>
            <ol>
              {props.events.map((event) => (
                <li key={event.sequence}>
                  <TimeAgo iso={event.timestamp} /> · <code>…{event.conversationIdSuffix}</code> · {t(WATCH_EVENT_COPY_KEYS[event.kind])}
                  {event.nudgeNumber === undefined ? "" : ` #${event.nudgeNumber}`}
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
    );
  }

  export function DeliveriesTab(
    props: DeliveriesTabProps,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const captionId = React.useId();
    const searchId = React.useId();
    const [directionFilter, setDirectionFilter] =
      React.useState<DirectionFilter>("all");
    const [stateFilter, setStateFilter] = React.useState<StateFilter>("all");
    const [viewMode, setViewMode] = React.useState<ViewMode>("byRoute");
    const [query, setQuery] = React.useState("");
    const [selectedKey, setSelectedKey] = React.useState<string | undefined>(
      undefined,
    );
    const rowRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());

    const groups = props.groups;
    const preset = props.preset;
    const clearPreset = props.clearPreset;

    // Presets arrive from the header search and the pulse click-through. The
    // effect depends on the preset object only: re-running it on every stream
    // frame would clobber whatever the operator typed since the jump.
    React.useEffect(() => {
      if (preset === undefined) return;
      if (preset.state !== undefined) setStateFilter(preset.state);
      const token = preset.token === undefined ? "" : preset.token.trim();
      if (token !== "") {
        setQuery(token);
        const target = findPresetTarget(groups, token);
        if (target !== undefined) setSelectedKey(target.key);
      }
      // Consume-once: the preset applies exactly one time, then the shell
      // clears it so later filter edits are never clobbered.
      clearPreset?.();
    }, [preset]);

    const needle = query.trim().toLowerCase();
    const filtered = React.useMemo<readonly DeliveryGroupView[]>(
      () =>
        groups.filter(
          (view) =>
            (directionFilter === "all" ||
              view.group.direction === directionFilter) &&
            (stateFilter === "all" || view.group.state === stateFilter) &&
            matchesQuery(view, needle),
        ),
      [groups, directionFilter, stateFilter, needle],
    );
    const pairs = React.useMemo<readonly RoutePairGroup[]>(
      () => groupByRoutePair(filtered),
      [filtered],
    );
    // Display order — the same array the keyboard walks, so grouped and flat
    // views navigate identically.
    const ordered = React.useMemo<readonly DeliveryGroupView[]>(
      () => (viewMode === "flat" ? filtered : pairs.flatMap((pair) => pair.rows)),
      [viewMode, filtered, pairs],
    );

    const selectedView = ordered.find((view) => view.key === selectedKey);
    const activeKey = selectedView?.key ?? ordered[0]?.key;

    const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const keys = ordered.map((view) => view.key);
      if (keys.length === 0) return;
      const currentIndex = Math.max(
        0,
        activeKey === undefined ? 0 : keys.indexOf(activeKey),
      );
      let nextIndex: number;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = Math.min(keys.length - 1, currentIndex + 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(0, currentIndex - 1);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = keys.length - 1;
          break;
        default:
          return;
      }
      const nextKey = keys[nextIndex];
      if (nextKey === undefined) return;
      event.preventDefault();
      setSelectedKey(nextKey);
      rowRefs.current.get(nextKey)?.focus();
    };

    const renderRow = (view: DeliveryGroupView): React.ReactElement => {
      const group = view.group;
      const isSelected = view.key === selectedView?.key;
      return (
        <button
          type="button"
          key={view.key}
          className="delivery-row"
          role="option"
          aria-selected={isSelected}
          tabIndex={view.key === activeKey ? 0 : -1}
          ref={(element) => {
            if (element === null) rowRefs.current.delete(view.key);
            else rowRefs.current.set(view.key, element);
          }}
          onClick={() => {
            setSelectedKey(view.key);
          }}
        >
          <span className="delivery-row__id">
            {group.messageIdSuffix ?? "—"}
          </span>
          <span className="delivery-row__route" title={view.routePair}>
            {view.routePair}
          </span>
          <StateChip
            small={true}
            state={group.state}
            direction={group.direction}
            safeErrorCode={group.safeErrorCode}
          />
          {group.steer === true ? (
            <span className="mono text-muted">STEER</span>
          ) : null}
          <span className="delivery-row__time">
            {group.timestamp === undefined ? (
              t("time.unavailable")
            ) : (
              <TimeAgo iso={group.timestamp} />
            )}
          </span>
        </button>
      );
    };

    const list =
      ordered.length === 0 ? null : (
        <div
          className="delivery-list"
          role="listbox"
          aria-labelledby={captionId}
          onKeyDown={moveFocus}
        >
          {viewMode === "flat"
            ? filtered.map(renderRow)
            : pairs.map((pair) => (
                <div
                  className="delivery-group"
                  role="group"
                  aria-label={pair.pair}
                  key={pair.pair}
                >
                  {/* The pair is the group's accessible name already. */}
                  <div className="delivery-group__head" aria-hidden={true}>
                    <MonoLabel>{t("activity.column.route")}</MonoLabel>
                    <span className="delivery-group__key">{pair.pair}</span>
                  </div>
                  {pair.rows.map(renderRow)}
                  <Rule />
                </div>
              ))}
        </div>
      );

    return (
      <div className="deliveries-layout">
        <div className="deliveries-main">
          {/* The tab opens on its filters (no page title); the caption is the
              heading and the list's programmatic label at once. */}
          <div className="row-baseline section-label">
            <h2 className="text-xs text-muted" id={captionId}>
              {t("app.deliveries.caption")}
            </h2>
            <span className="mono text-muted">
              {t("attention.countVisible", {
                count: fmtCount(locale, ordered.length),
              })}
            </span>
            {props.omissions.messageGroups > 0 ? (
              <span className="lower-bound">
                {t("app.lowerBound", {
                  count: fmtCount(locale, groups.length),
                })}
              </span>
            ) : null}
          </div>

          <div className="filters">
            <div className="filter-group">
              <MonoLabel>{t("app.deliveries.dir.label")}</MonoLabel>
              <div
                className="pill-row"
                role="group"
                aria-label={t("app.deliveries.dir.label")}
              >
                <FilterPill
                  active={directionFilter === "all"}
                  onClick={() => {
                    setDirectionFilter("all");
                  }}
                >
                  {t("app.deliveries.dir.all")}
                </FilterPill>
                {/* Exclusive radios: re-clicking the active direction is a
                    no-op, only the state pills toggle back to `all`. */}
                {DIRECTION_FILTERS.map((direction) => (
                  <FilterPill
                    key={direction}
                    active={directionFilter === direction}
                    onClick={() => {
                      setDirectionFilter(direction);
                    }}
                  >
                    {t(DIRECTION_PILL_COPY_KEYS[direction])}
                  </FilterPill>
                ))}
              </div>
            </div>
            <div className="filter-group">
              <MonoLabel>{t("app.deliveries.view.label")}</MonoLabel>
              <div
                className="pill-row"
                role="group"
                aria-label={t("app.deliveries.view.label")}
              >
                <FilterPill
                  active={viewMode === "byRoute"}
                  onClick={() => {
                    setViewMode("byRoute");
                  }}
                >
                  {t("app.deliveries.view.byRoute")}
                </FilterPill>
                <FilterPill
                  active={viewMode === "flat"}
                  onClick={() => {
                    setViewMode("flat");
                  }}
                >
                  {t("app.deliveries.view.flat")}
                </FilterPill>
              </div>
            </div>
          </div>

          {/* There is no conversation token in the contract; say so. */}
          <p className="footnote section-label">{t("app.deliveries.noConv")}</p>

          <ProgressWatchRegister
            watches={props.watches}
            events={props.watchEvents}
          />

          <div className="filter-group filters-block">
            <MonoLabel>{t("column.state")}</MonoLabel>
            <div className="pill-row" role="group" aria-label={t("column.state")}>
              <FilterPill
                active={stateFilter === "all"}
                onClick={() => {
                  setStateFilter("all");
                }}
              >
                {t("app.deliveries.state.all")}
              </FilterPill>
              {DELIVERY_STATE_FILTERS.map((state) => (
                <FilterPill
                  key={state}
                  active={stateFilter === state}
                  onClick={() => {
                    setStateFilter(stateFilter === state ? "all" : state);
                  }}
                >
                  {/* Protocol tokens stay English in both locales (H6). */}
                  {state}
                </FilterPill>
              ))}
            </div>
          </div>

          <div className="filter-group filters-search">
            <label className="sr-only" htmlFor={searchId}>
              {t("app.deliveries.search")}
            </label>
            <input
              id={searchId}
              className="text-input filter-input"
              type="text"
              value={query}
              placeholder={t("app.deliveries.search")}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                setQuery(event.target.value);
              }}
            />
          </div>

          {props.omissions.messageEvents > 0 ? (
            <p className="footnote section-label">
              {t("app.deliveries.eventsTruncated", {
                count: fmtCount(locale, props.omissions.messageEvents),
              })}
            </p>
          ) : null}

          {groups.length === 0 ? (
            <DeliveriesEmpty text={t("activity.empty")} />
          ) : ordered.length === 0 ? (
            <DeliveriesEmpty text={t("app.deliveries.noMatch")} />
          ) : (
            <React.Fragment>
              {list}
              {viewMode === "flat" ? <Rule /> : null}
            </React.Fragment>
          )}
        </div>

        <div className="deliveries-rail">
          {selectedView === undefined ? (
            <p className="detail-pane__empty">{t("app.deliveries.pickRow")}</p>
          ) : (
            <DeliveryDetail key={selectedView.key} view={selectedView} />
          )}
        </div>
      </div>
    );
  }
}
