// Activity tab (§4.5) — the merged, honestly bounded event stream.
//
// The live contract carries bounded broker activity in addition to delivery
// settlements and alerts. Operator actions remain visibly attributed. It never includes bodies,
// private route handles, task IDs, or complete conversation capabilities.
//
// Row order is the adapter's explicit timestamp-desc sort (adapter.activityRows);
// this file never re-sorts and never relies on the model's array order. Row text
// is composed from the copy catalog — the prototype's English-only payload prose
// (`e.text`) has no equivalent here. Every count the retention budget can bound
// renders the lower-bound badge beside it.
namespace Embassy {
  type ActivityKind = ActivityRow["kind"];

  type ActivityKindFilter = ActivityKind | "all";

  const ACTIVITY_KINDS: readonly ActivityKind[] = [
    "delivery",
    "operation",
    "alert",
  ];

  const ACTIVITY_KIND_LABEL_KEYS: Readonly<Record<ActivityKind, string>> = {
    delivery: "app.activity.kinds.delivery",
    operation: "app.activity.kinds.operation",
    alert: "app.activity.kinds.alert",
  };

  const OPERATION_COPY_KEYS: Readonly<
    Record<DashboardActivityEventRow["action"], string>
  > = {
    discovery_refreshed: "app.activity.operation.discoveryRefreshed",
    claude_selected: "app.activity.operation.claudeSelected",
    claude_unselected: "app.activity.operation.claudeUnselected",
    codex_registered: "app.activity.operation.codexRegistered",
    codex_succeeded: "app.activity.operation.codexSucceeded",
    codex_unregistered: "app.activity.operation.codexUnregistered",
    routes_paired: "app.activity.operation.routesPaired",
    routes_unpaired: "app.activity.operation.routesUnpaired",
    watch_ended: "app.activity.operation.watchEnded",
  };

  /** Teaching command for the empty stream (verified real CLI verb). */
  const ACTIVITY_EMPTY_COMMAND =
    "embassy send-to-codex --from <alias> --to <alias>";

  const activityCountFormatters = new Map<Locale, Intl.NumberFormat>();

  export function activityAuthority(
    event: DashboardActivityEventRow,
  ): "operator" | "automatic" {
    return event.operatorAction ? "operator" : "automatic";
  }

  /** Locale-aware integer formatting; format.tsx covers dates only. */
  function formatCount(count: number, locale: Locale): string {
    const existing = activityCountFormatters.get(locale);
    if (existing !== undefined) return existing.format(count);
    const formatter = new Intl.NumberFormat(locale);
    activityCountFormatters.set(locale, formatter);
    return formatter.format(count);
  }

  type ActivityCounts = Readonly<Record<ActivityKindFilter, number>>;

  function countByKind(rows: readonly ActivityRow[]): ActivityCounts {
    let delivery = 0;
    let operation = 0;
    let alert = 0;
    for (const row of rows) {
      if (row.kind === "delivery") delivery += 1;
      else if (row.kind === "operation") operation += 1;
      else alert += 1;
    }
    return { all: rows.length, delivery, operation, alert };
  }

  /**
   * Whether the displayed rows of a kind are a lower bound: delivery rows come
   * from the retained message groups, alert rows from the bounded attention
   * projection.
   */
  function kindIsLowerBound(
    kind: ActivityKind,
    omissions: DashboardOmissions,
  ): boolean {
    if (kind === "delivery") {
      return omissions.messageGroups > 0 || omissions.upstreamMessageEvents > 0;
    }
    if (kind === "operation") {
      return omissions.activityEvents > 0 || omissions.upstreamActivityEvents > 0;
    }
    return omissions.attentionItems > 0 || omissions.upstreamAlerts > 0;
  }

  function filterIsLowerBound(
    filter: ActivityKindFilter,
    omissions: DashboardOmissions,
  ): boolean {
    return filter === "all"
      ? ACTIVITY_KINDS.some((kind) => kindIsLowerBound(kind, omissions))
      : kindIsLowerBound(filter, omissions);
  }

  function activityRowIdentity(row: ActivityRow): string {
    if (row.kind === "delivery") {
      return `delivery|${deliveryGroupKey(row.group)}`;
    }
    if (row.kind === "operation") {
      return `operation|${row.event.sequence}|${row.event.action}`;
    }
    const item = row.item;
    return `alert|${row.timestamp}|${item.guidance}|${item.alias ?? ""}|${
      item.host ?? ""
    }|${item.code ?? ""}`;
  }

  /**
   * Stable React keys: content-derived, with an occurrence ordinal so two
   * indistinguishable rows in the same frame still get distinct keys.
   */
  function activityRowKeys(rows: readonly ActivityRow[]): readonly string[] {
    const seen = new Map<string, number>();
    return rows.map((row) => {
      const identity = activityRowIdentity(row);
      const occurrence = seen.get(identity) ?? 0;
      seen.set(identity, occurrence + 1);
      return occurrence === 0 ? identity : `${identity}#${occurrence}`;
    });
  }

  function alertScope(item: DashboardAttentionItem, t: Translate): string {
    const parts: string[] = [];
    if (item.provider !== undefined) {
      parts.push(t(`provider.${item.provider}`));
    }
    if (item.alias !== undefined) parts.push(item.alias);
    if (item.host !== undefined) parts.push(item.host);
    if (item.code !== undefined) parts.push(item.code);
    return parts.join(" · ");
  }

  /**
   * Delivery settlement text: route pair, the settled state as a StateChip
   * (raw protocol token per H6, direction-qualified per H2, localized meaning
   * in its title/aria-description), then the message suffix when one exists.
   */
  function DeliveryEntryText(
    props: Readonly<{ group: DashboardMessageGroup }>,
  ): React.ReactElement {
    const group = props.group;
    return (
      <div className="activity-text chip-row">
        <span className="mono">
          {group.sourceAlias} → {group.targetAlias}
        </span>
        <StateChip
          small
          state={group.state}
          direction={group.direction}
          safeErrorCode={group.safeErrorCode}
        />
        {group.steer === true ? (
          <span className="mono text-muted">STEER</span>
        ) : null}
        {group.messageIdSuffix === undefined ? null : (
          <span className="mono text-muted">{group.messageIdSuffix}</span>
        )}
      </div>
    );
  }

  /** Alert text: severity chip plus the guidance title and scope from the catalog. */
  function AlertEntryText(
    props: Readonly<{ item: DashboardAttentionItem; guidanceKey: string }>,
  ): React.ReactElement {
    const t = useT();
    const scope = alertScope(props.item, t);
    return (
      <div className="activity-text stack-sm">
        <div className="chip-row">
          <StateChip small domain="severity" state={props.item.severity} />
          <span>{t(`guidance.${props.guidanceKey}.title`)}</span>
        </div>
        {scope === "" ? null : (
          <span className="attention-item__scope">
            {t("attention.scope")}: {scope}
          </span>
        )}
      </div>
    );
  }

  function OperationEntryText(
    props: Readonly<{ event: DashboardActivityEventRow }>,
  ): React.ReactElement {
    const t = useT();
    const event = props.event;
    const authority = activityAuthority(event);
    return (
      <div
        className="activity-text stack-sm"
        data-activity-authority={authority}
      >
        <div className="chip-row">
          <span className="chip chip--small" data-kind="inert">
            {t(
              authority === "operator"
                ? "app.activity.operation.operator"
                : "app.activity.operation.automatic",
            )}
          </span>
          <span>{t(OPERATION_COPY_KEYS[event.action])}</span>
          <span className="mono text-muted">
            {t(
              event.outcome === "accepted"
                ? "app.activity.operation.accepted"
                : "app.activity.operation.rejected",
            )}
          </span>
        </div>
        {event.aliases.length === 0 && event.safeErrorCode === undefined ? null : (
          <span className="attention-item__scope">
            {[...event.aliases, event.safeErrorCode]
              .filter((part): part is string => part !== undefined)
              .join(" · ")}
          </span>
        )}
      </div>
    );
  }

  function ActivityEntry(
    props: Readonly<{ row: ActivityRow }>,
  ): React.ReactElement {
    const t = useT();
    const row = props.row;
    return (
      <div className="activity-row" role="listitem">
        {row.timestamp === undefined ? (
          <span className="time-ago text-muted" title={t("transit.unavailable")}>
            —<span className="sr-only">{t("transit.unavailable")}</span>
          </span>
        ) : (
          <TimeAgo iso={row.timestamp} />
        )}
        <span className="activity-kind">
          {t(ACTIVITY_KIND_LABEL_KEYS[row.kind])}
        </span>
        {row.kind === "delivery" ? (
          <DeliveryEntryText group={row.group} />
        ) : row.kind === "operation" ? (
          <OperationEntryText event={row.event} />
        ) : (
          <AlertEntryText item={row.item} guidanceKey={row.guidanceKey} />
        )}
      </div>
    );
  }

  export function ActivityTab(props: ActivityTabProps): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const headingId = React.useId();
    const [kindFilter, setKindFilter] =
      React.useState<ActivityKindFilter>("all");

    const rows = props.rows;
    const counts = React.useMemo(() => countByKind(rows), [rows]);
    const shown = React.useMemo(
      () =>
        kindFilter === "all"
          ? rows
          : rows.filter((row) => row.kind === kindFilter),
      [rows, kindFilter],
    );
    const keys = React.useMemo(() => activityRowKeys(shown), [shown]);

    const showAll = React.useCallback(() => {
      setKindFilter("all");
    }, []);
    // Toggle-off: pressing the active kind returns to the unfiltered stream.
    const toggleKind = React.useCallback((kind: ActivityKind) => {
      setKindFilter((current) => (current === kind ? "all" : kind));
    }, []);

    const isLowerBound = filterIsLowerBound(kindFilter, props.omissions);

    return (
      <section
        className="section tab-panel--narrow"
        aria-labelledby={headingId}
      >
        <h2 id={headingId} className="mono-label section-label">
          {t("app.activity.title")}
        </h2>

        <div className="filters">
          <div className="filter-group">
            <div className="pill-row">
              <FilterPill active={kindFilter === "all"} onClick={showAll}>
                {t("app.activity.kinds.all")}{" "}
                <span className="pill__count">
                  {formatCount(counts.all, locale)}
                </span>
              </FilterPill>
              {ACTIVITY_KINDS.map((kind) => (
                <FilterPill
                  key={kind}
                  active={kindFilter === kind}
                  onClick={() => {
                    toggleKind(kind);
                  }}
                >
                  {t(ACTIVITY_KIND_LABEL_KEYS[kind])}{" "}
                  <span className="pill__count">
                    {formatCount(counts[kind], locale)}
                  </span>
                </FilterPill>
              ))}
            </div>
            {isLowerBound ? (
              <div className="chip-row">
                <span className="lower-bound">
                  {t("app.lowerBound", {
                    count: formatCount(shown.length, locale),
                  })}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="stack">
          {shown.length === 0 ? (
            <div className="empty-state empty-state--activity">
              <p className="empty-state__text">{t("app.activity.empty")}</p>
              {/* The sentence hands off to the command, so the command is
                  always there to receive it — a filtered-empty window still
                  needs a next step. */}
              <CopyCmd cmd={ACTIVITY_EMPTY_COMMAND} />
            </div>
          ) : (
            <div>
              <div className="activity-list" role="list">
                {shown.map((row, index) => (
                  <ActivityEntry key={keys[index] ?? index} row={row} />
                ))}
              </div>
              {/* Rows carry a top border only; the closing rule ends the list. */}
              <Rule />
            </div>
          )}
          <p className="footnote">{t("app.activity.limited")}</p>
        </div>
      </section>
    );
  }
}
