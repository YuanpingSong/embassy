// Clock and date formatting for the live dashboard app.
//
// All relative rendering runs against a shared ticking wall clock (useNowMs)
// so ages keep counting between stream frames; formatting is locale-aware via
// Intl (no hardcoded locale, no frozen "now").
namespace Embassy {
  export const DEFAULT_CLOCK_TICK_MS = 30_000;

  /** Wall-clock hook; re-renders every `tickMs` (30 s default). */
  export function useNowMs(tickMs: number = DEFAULT_CLOCK_TICK_MS): number {
    const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
    React.useEffect(() => {
      const handle = window.setInterval(() => {
        setNowMs(Date.now());
      }, tickMs);
      return () => {
        window.clearInterval(handle);
      };
    }, [tickMs]);
    return nowMs;
  }

  const absoluteFormatters = new Map<Locale, Intl.DateTimeFormat>();
  const relativeFormatters = new Map<Locale, Intl.RelativeTimeFormat>();

  function absoluteFormatter(locale: Locale): Intl.DateTimeFormat {
    const existing = absoluteFormatters.get(locale);
    if (existing !== undefined) return existing;
    const formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    absoluteFormatters.set(locale, formatter);
    return formatter;
  }

  function relativeFormatter(locale: Locale): Intl.RelativeTimeFormat {
    const existing = relativeFormatters.get(locale);
    if (existing !== undefined) return existing;
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormatters.set(locale, formatter);
    return formatter;
  }

  /** Localized absolute timestamp; returns the raw input when unparseable. */
  export function fmtAbs(iso: string, locale: Locale): string {
    const milliseconds = Date.parse(iso);
    if (!Number.isFinite(milliseconds)) return iso;
    return absoluteFormatter(locale).format(new Date(milliseconds));
  }

  /**
   * Localized relative timestamp against the ticking clock, via
   * Intl.RelativeTimeFormat; returns the raw input when unparseable.
   */
  export function fmtRel(iso: string, nowMs: number, locale: Locale): string {
    const milliseconds = Date.parse(iso);
    if (!Number.isFinite(milliseconds)) return iso;
    const deltaSeconds = Math.round((milliseconds - nowMs) / 1000);
    const magnitude = Math.abs(deltaSeconds);
    const formatter = relativeFormatter(locale);
    if (magnitude < 60) return formatter.format(deltaSeconds, "second");
    if (magnitude < 3_600) {
      return formatter.format(Math.trunc(deltaSeconds / 60), "minute");
    }
    if (magnitude < 86_400) {
      return formatter.format(Math.trunc(deltaSeconds / 3_600), "hour");
    }
    return formatter.format(Math.trunc(deltaSeconds / 86_400), "day");
  }

  /** Compact duration for queue ages: "42s", "3m 12s", "2h 5m", "3d 2h". */
  export function fmtAge(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
    return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
  }
}
