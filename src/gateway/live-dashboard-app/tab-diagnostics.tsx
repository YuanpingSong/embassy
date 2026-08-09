// Diagnostics tab (§4.6). Section order follows the designer's: the
// operator-tunable settings open the tab, then connector protocols, the
// honest-absent features, limits & pressure, and the bounded counters.
//
// Phase A truth enforced here: there is no mutation endpoint, so this tab
// carries no number input, no Apply, no suggestion button and no confirm bar.
// Every limit teaches the real environment-variable path instead, and every
// feature the live contract does not carry renders as an AbsentFeature card
// rather than a dead control. Counts that the model may have bounded carry the
// lower-bound badge; both counter tables are captioned and collapsed behind
// native <details>.
namespace Embassy {
  /** Rendered wherever the live contract carries no value for a field. */
  const DIAGNOSTICS_ABSENT_FIELD = "—";

  const DIAGNOSTICS_CONNECTOR_COLUMNS = 7;

  const diagnosticsNumberFormatters = new Map<Locale, Intl.NumberFormat>();

  function diagnosticsNumberFormatter(locale: Locale): Intl.NumberFormat {
    const existing = diagnosticsNumberFormatters.get(locale);
    if (existing !== undefined) return existing;
    const formatter = new Intl.NumberFormat(locale);
    diagnosticsNumberFormatters.set(locale, formatter);
    return formatter;
  }

  /** Locale-aware integer, so counters group digits per the reader's locale. */
  function formatDiagnosticsCount(value: number, locale: Locale): string {
    return diagnosticsNumberFormatter(locale).format(value);
  }

  /** Binary byte sizes, mirroring the static dashboard's B / KiB / MiB steps. */
  function formatDiagnosticsBytes(value: number, locale: Locale): string {
    if (value < 1_024) {
      return `${formatDiagnosticsCount(value, locale)} B`;
    }
    if (value < 1_048_576) {
      const kibibytes = value / 1_024;
      const rounded =
        kibibytes < 10 ? Math.round(kibibytes * 10) / 10 : Math.round(kibibytes);
      return `${formatDiagnosticsCount(rounded, locale)} KiB`;
    }
    const mebibytes = value / 1_048_576;
    const rounded =
      mebibytes < 10 ? Math.round(mebibytes * 10) / 10 : Math.round(mebibytes);
    return `${formatDiagnosticsCount(rounded, locale)} MiB`;
  }

  type DiagnosticsCounterRow = Readonly<{
    id: string;
    label: string;
    value: string;
  }>;

  type DiagnosticsOmissionRow = Readonly<{
    /** Wire field name from `omissions`; an English contract token by design. */
    field: string;
    text: string;
  }>;

  type DiagnosticsSettingRow = Readonly<{
    id: string;
    name: string;
    /** True when the name is a contract/feature token rather than prose. */
    nameIsToken: boolean;
    /** Environment variable read at `embassy serve` start, when one exists. */
    envName: string | undefined;
    /** Tab whose evidence motivates changing this setting. */
    where: string;
    /** Why there is no environment variable, when there is none. */
    note: string | undefined;
  }>;

  /** "At least N; the display is bounded." — never rendered without a count. */
  function DiagnosticsLowerBound(
    props: Readonly<{ count: number }>,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    return (
      <span className="lower-bound">
        {t("app.lowerBound", {
          count: formatDiagnosticsCount(props.count, locale),
        })}
      </span>
    );
  }

  function DiagnosticsConnectorTable(
    props: Readonly<{ connectors: readonly DashboardConnectorRow[] }>,
  ): React.ReactElement {
    const t = useT();
    const { connectors } = props;
    return (
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">{t("app.diag.versions.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("app.diag.col.provider")}</th>
              <th scope="col">{t("app.diag.col.host")}</th>
              <th scope="col">{t("app.diag.col.protocol")}</th>
              <th scope="col">{t("app.diag.col.version")}</th>
              <th scope="col">{t("diagnostics.health")}</th>
              <th scope="col">{t("app.diag.col.compat")}</th>
              <th scope="col">{t("column.issue")}</th>
            </tr>
          </thead>
          <tbody>
            {connectors.length === 0 ? (
              <tr>
                <td colSpan={DIAGNOSTICS_CONNECTOR_COLUMNS}>
                  {t("diagnostics.connectors.empty")}
                </td>
              </tr>
            ) : (
              connectors.map((connector, index) => (
                <tr key={`${connector.provider}|${connector.host}|${index}`}>
                  <th scope="row">
                    {connector.provider === "claude"
                      ? t("provider.claude")
                      : t("provider.codex")}
                  </th>
                  <td className="cell-mono">{connector.host}</td>
                  <td className="cell-mono">
                    {connector.protocol ?? DIAGNOSTICS_ABSENT_FIELD}
                  </td>
                  <td className="cell-mono">
                    {connector.protocolVersion ?? DIAGNOSTICS_ABSENT_FIELD}
                  </td>
                  <td>
                    <StateChip domain="health" state={connector.health} small />
                  </td>
                  <td>
                    <StateChip
                      domain="compatibility"
                      state={connector.compatibility}
                      small
                    />
                  </td>
                  <td className="cell-mono">
                    {connector.safeErrorCode ?? DIAGNOSTICS_ABSENT_FIELD}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  /**
   * Accounting counters: the prototype's flush-right two-column row list,
   * capped at 480px (`.counters-list` / `.data-table--counters`). It stays a
   * real table so the visible caption and the row headers survive. Rows carry
   * a top border only, so `<Rule/>` closes the list.
   */
  function DiagnosticsCounterTable(
    props: Readonly<{ caption: string; rows: readonly DiagnosticsCounterRow[] }>,
  ): React.ReactElement {
    return (
      <div className="table-wrap counters-list">
        <table className="data-table data-table--counters">
          <caption className="table-caption">{props.caption}</caption>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                <td className="cell-mono">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Rule />
      </div>
    );
  }

  /**
   * Omissions: the wire field name (English contract token) as the row header,
   * the localized "{count} …" phrase as the value.
   */
  function DiagnosticsOmissionTable(
    props: Readonly<{
      caption: string;
      rows: readonly DiagnosticsOmissionRow[];
    }>,
  ): React.ReactElement {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <caption className="table-caption">{props.caption}</caption>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.field}>
                <th scope="row" className="cell-mono">
                  {row.field}
                </th>
                <td>{row.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Rule />
      </div>
    );
  }

  /**
   * Native <details> carrying the prototype's inline text-link affordance:
   * "<label> · show" / "<label> · hide". The element stays uncontrolled — the
   * browser owns the disclosure; the mirrored flag only picks the verb.
   */
  function DiagnosticsDisclosure(
    props: Readonly<{ label: string; children?: React.ReactNode }>,
  ): React.ReactElement {
    const t = useT();
    const [open, setOpen] = React.useState(false);
    return (
      <details
        className="details-block"
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary>
          {props.label} · {open ? t("app.hide") : t("app.show")}
        </summary>
        {props.children}
      </details>
    );
  }

  function DiagnosticsSetting(
    props: Readonly<{ setting: DiagnosticsSettingRow }>,
  ): React.ReactElement {
    const { setting } = props;
    return (
      <div className="setting-row">
        <div className="row-baseline">
          <span
            className={
              setting.nameIsToken
                ? "detail-value detail-value--mono"
                : "detail-value"
            }
          >
            {setting.name}
          </span>
          <span className="mono-label">{setting.where}</span>
        </div>
        <div className="env-name">
          {setting.envName ?? DIAGNOSTICS_ABSENT_FIELD}
        </div>
        {setting.note === undefined ? null : (
          <p className="footnote">{setting.note}</p>
        )}
      </div>
    );
  }

  export function DiagnosticsTab(
    props: DiagnosticsTabProps,
  ): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const { data } = props;
    const versionsHeadingId = React.useId();
    const limitsHeadingId = React.useId();
    const deadlineHeadingId = React.useId();
    const queueHeadingId = React.useId();
    const bytesHeadingId = React.useId();
    const settingsHeadingId = React.useId();

    // The only limit the live contract can actually adjudicate: deliveries
    // that already died on the deadline. Queue depth and the byte budget
    // report observed pressure but no ceiling, so neither carries a verdict.
    const deadlineIsWarn = data.expiredCount > 0;

    const accounting = data.accounting;
    const accountingRows: readonly DiagnosticsCounterRow[] = [
      {
        id: "accepted",
        label: t("diagnostics.accepted"),
        value: formatDiagnosticsCount(accounting.accepted, locale),
      },
      {
        id: "duplicates",
        label: t("diagnostics.duplicates"),
        value: formatDiagnosticsCount(accounting.duplicates, locale),
      },
      {
        id: "delivered",
        label: t("diagnostics.delivered"),
        value: formatDiagnosticsCount(accounting.delivered, locale),
      },
      {
        id: "unconfirmed",
        label: t("diagnostics.unconfirmed"),
        value: formatDiagnosticsCount(accounting.unconfirmed, locale),
      },
      {
        id: "ambiguous",
        label: t("diagnostics.ambiguous"),
        value: formatDiagnosticsCount(accounting.ambiguous, locale),
      },
      {
        id: "failed",
        label: t("diagnostics.failed"),
        value: formatDiagnosticsCount(accounting.failed, locale),
      },
      {
        id: "expired",
        label: t("diagnostics.expired"),
        value: formatDiagnosticsCount(accounting.expired, locale),
      },
      {
        id: "cancelled",
        label: t("diagnostics.cancelled"),
        value: formatDiagnosticsCount(accounting.cancelled, locale),
      },
      {
        id: "abandoned",
        label: t("diagnostics.abandoned"),
        value: formatDiagnosticsCount(accounting.abandoned, locale),
      },
      {
        id: "rejected",
        label: t("diagnostics.rejected"),
        value: formatDiagnosticsCount(accounting.rejected, locale),
      },
      {
        id: "bytesAccepted",
        label: t("diagnostics.bytesAccepted"),
        value: formatDiagnosticsBytes(accounting.bytesAccepted, locale),
      },
      {
        id: "queuedBytes",
        label: t("diagnostics.queuedBytes"),
        value: formatDiagnosticsBytes(accounting.queuedBytes, locale),
      },
    ];

    const omissions = data.omissions;
    const omissionRows: readonly DiagnosticsOmissionRow[] = [
      {
        field: "connectors",
        text: t("diagnostics.omissions.connectors", {
          count: formatDiagnosticsCount(omissions.connectors, locale),
        }),
      },
      {
        field: "availablePeers",
        text: t("diagnostics.omissions.peers", {
          count: formatDiagnosticsCount(omissions.availablePeers, locale),
        }),
      },
      {
        field: "routes",
        text: t("diagnostics.omissions.routes", {
          count: formatDiagnosticsCount(omissions.routes, locale),
        }),
      },
      {
        field: "upstreamMessageEvents",
        text: t("diagnostics.omissions.upstreamMessageEvents", {
          count: formatDiagnosticsCount(
            omissions.upstreamMessageEvents,
            locale,
          ),
        }),
      },
      {
        field: "messageGroups",
        text: t("diagnostics.omissions.messageGroups", {
          count: formatDiagnosticsCount(omissions.messageGroups, locale),
        }),
      },
      {
        field: "messageEvents",
        text: t("diagnostics.omissions.messageEvents", {
          count: formatDiagnosticsCount(omissions.messageEvents, locale),
        }),
      },
      {
        field: "upstreamAlerts",
        text: t("diagnostics.omissions.upstreamAlerts", {
          count: formatDiagnosticsCount(omissions.upstreamAlerts, locale),
        }),
      },
      {
        field: "attentionItems",
        text: t("diagnostics.omissions.attentionItems", {
          count: formatDiagnosticsCount(omissions.attentionItems, locale),
        }),
      },
    ];

    const nothingOmitted =
      omissions.connectors === 0 &&
      omissions.availablePeers === 0 &&
      omissions.routes === 0 &&
      omissions.upstreamMessageEvents === 0 &&
      omissions.messageGroups === 0 &&
      omissions.messageEvents === 0 &&
      omissions.upstreamAlerts === 0 &&
      omissions.attentionItems === 0;

    // The change order's editable four, read-only in Phase A: env var name
    // where one exists, and the tab whose evidence motivates the change.
    const settings: readonly DiagnosticsSettingRow[] = [
      {
        id: "deadline",
        name: t("app.diag.deadline.title"),
        nameIsToken: false,
        envName: "EMBASSY_MESSAGE_DEADLINE_MS",
        where: t("app.tab.diagnostics"),
        note: undefined,
      },
      {
        id: "queueDepth",
        name: t("app.diag.queue.title"),
        nameIsToken: false,
        envName: "EMBASSY_MAX_QUEUE_MESSAGES",
        where: t("app.tab.overview"),
        note: undefined,
      },
      {
        id: "steering",
        // The AbsentFeature card directly above carries the "not landed"
        // sentence; repeating it on the row would say the same thing twice.
        name: "steering",
        nameIsToken: true,
        envName: undefined,
        where: t("app.tab.diagnostics"),
        note: undefined,
      },
      {
        id: "inboundMode",
        name: "inbound mode",
        nameIsToken: true,
        envName: undefined,
        where: t("app.tab.routes"),
        note: t("app.routes.detail.absent"),
      },
    ];

    return (
      <div className="tab-panel tab-panel--narrow">
        {/* The designer opens this tab with the operator-tunable surface, not
            with a seven-column reference table. */}
        <section className="section" aria-labelledby={settingsHeadingId}>
          <h2 className="mono-label section-label" id={settingsHeadingId}>
            {t("app.diag.editable.title")}
          </h2>
          <div className="stack-lg">
            {/* The prototype pairs the deadline with steering side by side. */}
            <div className="grid-2">
              <section
                className={deadlineIsWarn ? "card card--warn" : "card"}
                aria-labelledby={deadlineHeadingId}
              >
                <div className="card__head">
                  <h3 className="card__title" id={deadlineHeadingId}>
                    {t("app.diag.deadline.title")}
                  </h3>
                  {deadlineIsWarn ? (
                    <StateChip domain="severity" state="warning" small />
                  ) : null}
                </div>
                <p className="card__body">
                  {t("app.diag.deadline.body", {
                    count: formatDiagnosticsCount(data.expiredCount, locale),
                  })}
                </p>
                <p className="env-name">EMBASSY_MESSAGE_DEADLINE_MS</p>
                <CopyCmd cmd="EMBASSY_MESSAGE_DEADLINE_MS=<ms> embassy serve" />
              </section>

              <AbsentFeature
                title={t("app.diag.steering.title")}
                body={t("app.diag.steering.absent")}
              />
            </div>
            <div className="setting-list">
              {settings.map((setting) => (
                <DiagnosticsSetting key={setting.id} setting={setting} />
              ))}
            </div>
            {/* The note belongs to the settings it describes. */}
            <p className="footnote">{t("app.diag.editable.note")}</p>
          </div>
        </section>

        <section className="section" aria-labelledby={versionsHeadingId}>
          <div className="row-baseline section-label">
            <h2 className="mono-label" id={versionsHeadingId}>
              {t("app.diag.versions")}
            </h2>
            {data.connectorsOmitted > 0 ? (
              <DiagnosticsLowerBound count={data.connectors.length} />
            ) : null}
          </div>
          <div className="stack">
            <DiagnosticsConnectorTable connectors={data.connectors} />
            {/* The prototype printed the pinned range beside each verdict; the
                live contract does not carry it, so say so rather than let the
                bare chip read as an omission. */}
            <p className="footnote">{t("app.diag.versions.rangeAbsent")}</p>
          </div>
        </section>

        <div className="grid-2">
          <AbsentFeature
            title={t("app.diag.attestation.title")}
            body={t("app.diag.attestation.absent")}
            cmd="embassy health"
          />
          <AbsentFeature
            title={t("app.diag.lease.title")}
            body={t("app.diag.lease.absent")}
            cmd="embassy status"
          />
        </div>

        <section className="section" aria-labelledby={limitsHeadingId}>
          <h2 className="mono-label section-label" id={limitsHeadingId}>
            {t("app.diag.limits")}
          </h2>
          {/* One full-width card per limit, queue depth first (prototype). */}
          <div className="stack">
            <section className="card" aria-labelledby={queueHeadingId}>
              <div className="card__head">
                <h3 className="card__title" id={queueHeadingId}>
                  {t("app.diag.queue.title")}
                </h3>
                {data.queueCountIsLowerBound ? (
                  <DiagnosticsLowerBound count={data.queuedMessages} />
                ) : null}
              </div>
              <p className="card__body">
                {t("app.diag.queue.body", {
                  count: formatDiagnosticsCount(data.queuedMessages, locale),
                })}
              </p>
              <p className="env-name">EMBASSY_MAX_QUEUE_MESSAGES</p>
              <CopyCmd cmd="EMBASSY_MAX_QUEUE_MESSAGES=<n> embassy serve" />
            </section>

            <section className="card" aria-labelledby={bytesHeadingId}>
              <div className="card__head">
                <h3 className="card__title" id={bytesHeadingId}>
                  {t("app.diag.bytes.title")}
                </h3>
              </div>
              <p className="card__body">
                {t("app.diag.bytes.body", {
                  queued: formatDiagnosticsBytes(
                    accounting.queuedBytes,
                    locale,
                  ),
                  accepted: formatDiagnosticsBytes(
                    accounting.bytesAccepted,
                    locale,
                  ),
                })}
              </p>
              <p className="env-name">EMBASSY_MAX_MESSAGE_BYTES</p>
              <CopyCmd cmd="EMBASSY_MAX_MESSAGE_BYTES=<n> embassy serve" />
            </section>

            {/* One hint for the section — the cards used to say it twice. */}
            <p className="footnote">{t("app.diag.limits.hint")}</p>
          </div>
        </section>

        <section className="section">
          <DiagnosticsDisclosure label={t("app.diag.counters")}>
            <div className="details-block__content">
              <DiagnosticsCounterTable
                caption={t("app.diag.counters.caption")}
                rows={accountingRows}
              />
            </div>
          </DiagnosticsDisclosure>
          <DiagnosticsDisclosure label={t("app.diag.omissions")}>
            <div className="details-block__content stack">
              <DiagnosticsOmissionTable
                caption={t("app.diag.omissions.caption")}
                rows={omissionRows}
              />
              {nothingOmitted ? (
                <p className="footnote">{t("diagnostics.omissions.none")}</p>
              ) : null}
            </div>
          </DiagnosticsDisclosure>
        </section>
      </div>
    );
  }
}
