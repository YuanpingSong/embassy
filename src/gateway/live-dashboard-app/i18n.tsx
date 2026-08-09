// Locale context and translation for the live dashboard app.
//
// The copy dictionaries arrive embedded in window.EMBASSY_BOOT (both locales),
// so the toggle never reloads. Interpolation uses the catalog's `{name}` regex
// convention, mirroring formatDashboardCopy / the vanilla client's t().
namespace Embassy {
  export type TranslateValues = Readonly<Record<string, string | number>>;

  export type Translate = (key: string, values?: TranslateValues) => string;

  export type CopyByLocale = Readonly<
    Record<Locale, Readonly<Record<string, string>>>
  >;

  const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

  /** `{name}` interpolation; unknown placeholders are left verbatim. */
  export function interpolate(
    template: string,
    values: TranslateValues = {},
  ): string {
    return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? String(values[name])
        : match,
    );
  }

  type I18nContextValue = Readonly<{
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: Translate;
  }>;

  const I18nContext = React.createContext<I18nContextValue | null>(null);

  export type I18nProviderProps = Readonly<{
    copy: CopyByLocale;
    initialLocale: Locale;
    onLocaleChange?: ((locale: Locale) => void) | undefined;
    children?: React.ReactNode;
  }>;

  export function I18nProvider(props: I18nProviderProps): React.ReactElement {
    const { copy, onLocaleChange } = props;
    const [locale, setLocaleState] = React.useState<Locale>(
      props.initialLocale,
    );
    const setLocale = React.useCallback(
      (next: Locale) => {
        setLocaleState(next);
        if (onLocaleChange !== undefined) onLocaleChange(next);
      },
      [onLocaleChange],
    );
    const t = React.useCallback<Translate>(
      (key, values) => {
        const template = copy[locale][key] ?? key;
        return interpolate(template, values ?? {});
      },
      [copy, locale],
    );
    const value = React.useMemo<I18nContextValue>(
      () => ({ locale, setLocale, t }),
      [locale, setLocale, t],
    );
    return (
      <I18nContext.Provider value={value}>
        {props.children}
      </I18nContext.Provider>
    );
  }

  function useI18n(): I18nContextValue {
    const value = React.useContext(I18nContext);
    if (value === null) {
      throw new Error("Embassy.I18nProvider is missing above this component.");
    }
    return value;
  }

  /** Translation function `t(key, values?)`; falls back to the raw key. */
  export function useT(): Translate {
    return useI18n().t;
  }

  /** Current locale plus setter, as a `[locale, setLocale]` pair. */
  export function useLocale(): readonly [Locale, (locale: Locale) => void] {
    const { locale, setLocale } = useI18n();
    return [locale, setLocale] as const;
  }
}
