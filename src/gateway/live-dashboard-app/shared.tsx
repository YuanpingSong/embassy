// Shared UI primitives (§4.7). Classes only for static styling (D5);
// chip labels stay raw protocol tokens (H6) — only hover meaning localizes.
namespace Embassy {
  export type StateChipProps = Readonly<{
    state: string;
    /** Chip normalization table to use; defaults to "delivery". */
    domain?: ChipDomain | undefined;
    /** Drives the H2 qualified rule for delivered deliveries. */
    direction?: MessageDirection | undefined;
    /** Selects the abandoned-state annotation (H4). */
    safeErrorCode?: string | undefined;
    label?: string | undefined;
    /** Per-instance hover override (prototype `note` escape hatch). */
    note?: string | undefined;
    small?: boolean | undefined;
  }>;

  export function StateChip(props: StateChipProps): React.ReactElement {
    const t = useT();
    const domain = props.domain ?? "delivery";
    const kind = chipKindByDomain(domain, props.state, props.direction);
    const meaning =
      props.note ??
      t(
        meaningKeyFor(
          domain,
          props.state,
          props.safeErrorCode,
          props.direction,
        ),
      );
    return (
      <span
        className={props.small === true ? "chip chip--small" : "chip"}
        data-kind={kind}
        title={meaning}
        aria-description={meaning}
      >
        {props.label ?? props.state}
      </span>
    );
  }

  export type MonoLabelProps = Readonly<{
    className?: string | undefined;
    children?: React.ReactNode;
  }>;

  export function MonoLabel(props: MonoLabelProps): React.ReactElement {
    const className =
      props.className === undefined
        ? "mono-label"
        : `mono-label ${props.className}`;
    return <div className={className}>{props.children}</div>;
  }

  export type CopyCmdProps = Readonly<{
    cmd: string;
  }>;

  /**
   * Copyable CLI command. Clipboard failures produce visible feedback — the
   * button only claims "copied" when the write actually resolved; the command
   * text itself stays selectable as the manual fallback.
   */
  export function CopyCmd(props: CopyCmdProps): React.ReactElement {
    const t = useT();
    const [feedback, setFeedback] = React.useState<
      "idle" | "copied" | "failed"
    >("idle");
    React.useEffect(() => {
      if (feedback === "idle") return undefined;
      const handle = window.setTimeout(() => {
        setFeedback("idle");
      }, 1_500);
      return () => {
        window.clearTimeout(handle);
      };
    }, [feedback]);
    const copy = (): void => {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard === undefined) {
        setFeedback("failed");
        return;
      }
      clipboard.writeText(props.cmd).then(
        () => {
          setFeedback("copied");
        },
        () => {
          setFeedback("failed");
        },
      );
    };
    const status =
      feedback === "copied"
        ? t("app.copied")
        : feedback === "failed"
          ? t("app.copyFailed")
          : "";
    return (
      <div className="copy-cmd">
        <code className="copy-cmd__code">{props.cmd}</code>
        <span
          className="copy-cmd__status"
          data-tone={feedback === "failed" ? "error" : undefined}
          aria-live="polite"
        >
          {status}
        </span>
        <button type="button" className="copy-cmd__button" onClick={copy}>
          {t("app.copy")}
        </button>
      </div>
    );
  }

  export function Rule(
    props: Readonly<{ className?: string | undefined }>,
  ): React.ReactElement {
    const className =
      props.className === undefined ? "rule" : `rule ${props.className}`;
    return <hr className={className} />;
  }

  export type FilterPillProps = Readonly<{
    active: boolean;
    onClick: () => void;
    children?: React.ReactNode;
  }>;

  export function FilterPill(props: FilterPillProps): React.ReactElement {
    return (
      <button
        type="button"
        className="pill"
        aria-pressed={props.active}
        onClick={props.onClick}
      >
        {props.children}
      </button>
    );
  }

  export type TimeAgoProps = Readonly<{
    iso: string;
  }>;

  /**
   * Relative time on the shared ticking clock, localized via
   * Intl.RelativeTimeFormat; absolute time in the title plus a
   * visually-hidden copy for assistive tech.
   */
  export function TimeAgo(props: TimeAgoProps): React.ReactElement {
    const t = useT();
    const [locale] = useLocale();
    const nowMs = useNowMs();
    const absolute = fmtAbs(props.iso, locale);
    // Hour/day tiers keep the prototype's composite precision ("2h 5m ago",
    // "3d 2h ago") via the localized `time.ago` template; sub-hour and future
    // deltas stay on Intl.RelativeTimeFormat.
    const parsedMs = Date.parse(props.iso);
    const ageMs = Number.isFinite(parsedMs) ? nowMs - parsedMs : undefined;
    const relative =
      ageMs !== undefined && ageMs >= 3_600_000
        ? t("time.ago", { duration: fmtAge(ageMs) })
        : fmtRel(props.iso, nowMs, locale);
    return (
      <span className="time-ago" title={absolute}>
        {relative}
        <span className="sr-only"> ({absolute})</span>
      </span>
    );
  }

  export type TooltipProps = Readonly<{
    tip: string;
    /** Wide wrapping variant (`data-tip-wrap`). */
    wrap?: boolean | undefined;
    children?: React.ReactNode;
  }>;

  /**
   * Focusable tooltip: keyboard-reachable (tabIndex=0), CSS-driven via
   * `data-tip` on hover and :focus-visible, described for AT through
   * aria-describedby pointing at a visually-hidden copy of the tip.
   */
  export function Tooltip(props: TooltipProps): React.ReactElement {
    const descriptionId = React.useId();
    return (
      <span
        className="tooltip"
        tabIndex={0}
        data-tip={props.tip}
        data-tip-wrap={props.wrap === true ? "" : undefined}
        aria-describedby={descriptionId}
      >
        {props.children ?? <span className="info-dot">i</span>}
        <span className="sr-only" id={descriptionId}>
          {props.tip}
        </span>
      </span>
    );
  }

  export type AbsentFeatureProps = Readonly<{
    title: string;
    body: string;
    cmd?: string | undefined;
  }>;

  /**
   * The honest-absent card (`app.notLanded.*` framing): names a feature that
   * has not landed and teaches the real CLI path instead — never a dead
   * control.
   */
  export function AbsentFeature(props: AbsentFeatureProps): React.ReactElement {
    const t = useT();
    return (
      <section className="absent-feature">
        <MonoLabel>{t("app.notLanded.title")}</MonoLabel>
        <h3 className="absent-feature__title">{props.title}</h3>
        <p className="absent-feature__body">{props.body}</p>
        <p className="absent-feature__note">{t("app.notLanded.body")}</p>
        {props.cmd === undefined ? null : <CopyCmd cmd={props.cmd} />}
      </section>
    );
  }
}
