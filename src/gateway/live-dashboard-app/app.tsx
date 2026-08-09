// App shell (integration spec §4.1): tablist navigation with roving tabindex,
// header (wordmark, posture chip, global search, as-of, connection chip and
// controls, language toggle), staleness/reset/missed-frame notices, bounded
// operator authority footer, and the top-level mount.
//
// The shell keeps zero cross-frame accumulated state (D8): every render is a
// pure function of the latest LiveDashboardStreamEvent plus the live wall
// clock; tab content is derived through Embassy.adapter on each render.
namespace Embassy {
  const PREFS_STORAGE_KEY = "embassy-live-prefs";

  /** Staleness threshold: mirrors the protocol's 35 s heartbeat watchdog. */
  const STALE_NOTICE_MS = 35_000;

  const TAB_KEYS = [
    "overview",
    "deliveries",
    "routes",
    "activity",
    "diagnostics",
  ] as const;

  type TabKey = (typeof TAB_KEYS)[number];

  function isTabKey(value: unknown): value is TabKey {
    return (
      typeof value === "string" &&
      (TAB_KEYS as readonly string[]).includes(value)
    );
  }

  type StoredPrefs = Readonly<{
    locale: Locale;
    tab: TabKey;
  }>;

  /** Parse `embassy-live-prefs` once (initializer, never per render). */
  function loadPrefs(fallbackLocale: Locale): StoredPrefs {
    try {
      const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as Readonly<Record<string, unknown>>;
          const locale = record["locale"];
          const tab = record["tab"];
          return {
            locale:
              locale === "en" || locale === "zh-CN" ? locale : fallbackLocale,
            tab: isTabKey(tab) ? tab : "overview",
          };
        }
      }
    } catch {
      // Storage unavailable or corrupted — fall through to defaults.
    }
    return { locale: fallbackLocale, tab: "overview" };
  }

  function savePrefs(prefs: StoredPrefs): void {
    try {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Storage unavailable — preferences simply do not persist.
    }
  }

  type NoticeFlags = Readonly<Record<ProtocolNoticeKind, boolean>>;

  type NoticeProps = Readonly<{
    tone: "info" | "warning";
    text: string;
    onDismiss: () => void;
  }>;

  function Notice(props: NoticeProps): React.ReactElement {
    const t = useT();
    return (
      <div className="notice" data-tone={props.tone} role="status">
        <span>{props.text}</span>
        <button
          type="button"
          className="toggle-link"
          onClick={props.onDismiss}
        >
          {t("app.hide")}
        </button>
      </div>
    );
  }

  type ShellProps = Readonly<{
    initialTab: TabKey;
  }>;

  function Shell(props: ShellProps): React.ReactElement {
    const t = useT();
    const [locale, setLocale] = useLocale();
    const [tab, setTab] = React.useState<TabKey>(props.initialTab);
    const [latest, setLatest] = React.useState<
      LiveDashboardStreamEvent | undefined
    >(undefined);
    const [connectionState, setConnectionState] =
      React.useState<ConnectionState>("connecting");
    const [lastFrameAtMs, setLastFrameAtMs] = React.useState<
      number | undefined
    >(undefined);
    const [notices, setNotices] = React.useState<NoticeFlags>({
      reset: false,
      missedFrames: false,
    });
    const [preset, setPreset] = React.useState<DeliveriesPreset | undefined>(
      undefined,
    );
    const [query, setQuery] = React.useState("");
    const nowMs = useNowMs();
    const protocolRef = React.useRef<Protocol | undefined>(undefined);
    const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

    // Top-level protocol wiring: one FSM for the lifetime of the shell.
    React.useEffect(() => {
      const protocol = createProtocol({
        onEvent: (event) => {
          setLatest(event);
          setLastFrameAtMs(Date.now());
        },
        onConnectionState: setConnectionState,
        onNotice: (kind) => {
          setNotices((previous) => ({ ...previous, [kind]: true }));
        },
      });
      protocolRef.current = protocol;
      protocol.start();
      return () => {
        protocolRef.current = undefined;
        protocol.pause();
      };
    }, []);

    // Keep the document language in sync with the in-page toggle.
    React.useEffect(() => {
      document.documentElement.lang = locale;
    }, [locale]);

    React.useEffect(() => {
      savePrefs({ locale, tab });
    }, [locale, tab]);

    const goDeliveries = React.useCallback((next: DeliveriesPreset): void => {
      setPreset(next);
      setTab("deliveries");
    }, []);

    // Consume-once contract (prototype App.jsx clearPreset): the deliveries
    // tab clears the preset after applying it, so returning to the tab never
    // re-fires a stale deep-link over the operator's own filters.
    const clearPreset = React.useCallback((): void => {
      setPreset(undefined);
    }, []);

    const runAction = React.useCallback(
      async (
        action: LiveDashboardAction,
      ): Promise<LiveDashboardActionResult> =>
        protocolRef.current?.executeAction(action) ?? {
          ok: false,
          code: "unavailable",
        },
      [],
    );

    const dismissNotice = (kind: ProtocolNoticeKind): void => {
      setNotices((previous) => ({ ...previous, [kind]: false }));
    };

    const onSearchKeyDown = (
      event: React.KeyboardEvent<HTMLInputElement>,
    ): void => {
      if (event.key !== "Enter") return;
      const token = query.trim();
      if (token === "") return;
      setPreset({ token });
      setTab("deliveries");
      setQuery("");
    };

    // Roving tabindex: arrows/Home/End move focus and select (selection
    // follows focus); only the active tab is in the tab order.
    const onTabKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ): void => {
      const currentIndex = TAB_KEYS.indexOf(tab);
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % TAB_KEYS.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + TAB_KEYS.length) % TAB_KEYS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = TAB_KEYS.length - 1;
      }
      if (nextIndex === undefined) return;
      event.preventDefault();
      const nextTab = TAB_KEYS[nextIndex];
      if (nextTab === undefined) return;
      setTab(nextTab);
      tabRefs.current[nextIndex]?.focus();
    };

    const generatedAt = latest?.model.generatedAt;
    const staleAgeMs =
      lastFrameAtMs === undefined ? undefined : nowMs - lastFrameAtMs;
    const hasNotices = notices.reset || notices.missedFrames;

    function renderActiveTab(): React.ReactElement {
      if (latest === undefined) {
        return (
          <div className="empty-state">
            <p className="empty-state__text">
              {t(`live.connection.${connectionState}`)}
            </p>
          </div>
        );
      }
      const model = latest.model;
      switch (tab) {
        case "overview":
          return (
            <OverviewTab
              data={adapter.overviewProps(model, nowMs)}
              onViewDeliveries={goDeliveries}
            />
          );
        case "deliveries":
          return (
            <DeliveriesTab
              groups={adapter.deliveriesGroups(model)}
              omissions={model.omissions}
              preset={preset}
              clearPreset={clearPreset}
            />
          );
        case "routes":
          return (
            <RoutesTab
              data={adapter.routesProps(model, nowMs)}
              actionsEnabled={connectionState === "connected"}
              onAction={runAction}
            />
          );
        case "activity":
          return (
            <ActivityTab
              rows={adapter.activityRows(model)}
              omissions={model.omissions}
            />
          );
        case "diagnostics":
          return <DiagnosticsTab data={adapter.diagnosticsProps(model)} />;
      }
    }

    return (
      <div className="app-shell">
        <header className="app-header">
          <div className="header-bar">
            <div className="brand">
              <svg
                width="26"
                height="26"
                viewBox="0 0 64 64"
                fill="none"
                aria-hidden="true"
                className="brand-mark"
              >
                <path d="M32 16 V5 L41 7.5 L32 10" fill="#f4a259" />
                <path
                  d="M21.5 55 V32 C21.5 23 42.5 23 42.5 32 V55 Z"
                  fill="#f4a259"
                />
                <path
                  d="M14 55 V30.5 C14 17 50 17 50 30.5 V55"
                  stroke="#17171c"
                  strokeWidth="3.4"
                  strokeLinecap="round"
                />
                <path
                  d="M10 55.5 H54"
                  stroke="#17171c"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              <span className="brand-wordmark">Embassy</span>
              <span className="mono-label">{t("live.label")}</span>
              {latest === undefined ? null : (
                <span className="brand-posture">
                  <StateChip
                    domain="overall"
                    state={latest.model.overall}
                    small={true}
                  />
                </span>
              )}
            </div>
            <div className="header-spacer" />
            <input
              type="search"
              className="text-input header-search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={onSearchKeyDown}
              aria-label={t("app.search.label")}
              placeholder={t("app.search.placeholder")}
            />
            <div className="header-meta">
              <span className="as-of" title={generatedAt}>
                {t("app.asOf", {
                  time:
                    generatedAt === undefined
                      ? t("time.unavailable")
                      : fmtAbs(generatedAt, locale),
                })}
              </span>
              <span className="conn-status" aria-live="polite">
                <StateChip
                  domain="connection"
                  state={connectionState}
                  label={t(`live.connection.${connectionState}`)}
                  small={true}
                />
              </span>
              <div className="lang-toggle">
                <button
                  type="button"
                  className="lang-toggle__btn"
                  aria-pressed={locale === "en"}
                  onClick={() => {
                    setLocale("en");
                  }}
                >
                  EN
                </button>
                <button
                  type="button"
                  className="lang-toggle__btn"
                  aria-pressed={locale === "zh-CN"}
                  onClick={() => {
                    setLocale("zh-CN");
                  }}
                >
                  中文
                </button>
              </div>
            </div>
            {/* Second header row (flex-basis 100%): staleness note on the
                left, connection controls on the right — keeps the primary
                row at the prototype's brand/search/as-of/chip/lang line. */}
            <div className="header-subrow">
              {staleAgeMs !== undefined && staleAgeMs >= STALE_NOTICE_MS ? (
                <p
                  className={
                    connectionState === "connected"
                      ? "staleness staleness--quiet"
                      : "staleness"
                  }
                  role="status"
                >
                  {connectionState === "connected"
                    ? t("app.staleQuiet", { age: fmtAge(staleAgeMs) })
                    : t("app.stale", { age: fmtAge(staleAgeMs) })}
                </p>
              ) : null}
              <span className="conn-controls">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => protocolRef.current?.pause()}
                >
                  {t("live.control.pause")}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => protocolRef.current?.reconnect()}
                >
                  {t("live.control.reconnect")}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => protocolRef.current?.readNow()}
                >
                  {t("live.control.refresh")}
                </button>
              </span>
            </div>
          </div>
          <nav
            className="app-nav"
            role="tablist"
            aria-label={t("live.label")}
          >
            {TAB_KEYS.map((key, index) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`tab-${key}`}
                className="tab"
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                tabIndex={tab === key ? 0 : -1}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                onClick={() => {
                  setTab(key);
                }}
                onKeyDown={onTabKeyDown}
              >
                {t(`app.tab.${key}`)}
              </button>
            ))}
          </nav>
        </header>
        <main className="app-main">
          {/* Notices + tabpanel share the 20px stack; <main> itself stays a
              plain block like the prototype's. */}
          <div className="stack-lg">
            {hasNotices ? (
              <div className="stack">
                {notices.reset ? (
                  <Notice
                    tone="info"
                    text={t("live.stream.reset")}
                    onDismiss={() => {
                      dismissNotice("reset");
                    }}
                  />
                ) : null}
                {notices.missedFrames ? (
                  <Notice
                    tone="warning"
                    text={t("app.missedFrames")}
                    onDismiss={() => {
                      dismissNotice("missedFrames");
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            <div
              role="tabpanel"
              id={`panel-${tab}`}
              aria-labelledby={`tab-${tab}`}
              tabIndex={0}
            >
              {renderActiveTab()}
            </div>
          </div>
        </main>
        <footer className="app-footer">
          <span className="mono-label">{t("live.action.authorityLabel")}</span>
          <p>{t("live.action.authorityBody")}</p>
          <p className="footer-diagnostic">
            {t("live.metric.revision")}:{" "}
            {latest === undefined ? "—" : String(latest.streamRevision)}
          </p>
        </footer>
      </div>
    );
  }

  export function App(): React.ReactElement {
    const boot = window.EMBASSY_BOOT;
    const [initialPrefs] = React.useState<StoredPrefs>(() =>
      loadPrefs(boot.locale),
    );
    return (
      <I18nProvider copy={boot.copy} initialLocale={initialPrefs.locale}>
        <Shell initialTab={initialPrefs.tab} />
      </I18nProvider>
    );
  }

  // Mount: scripts are deferred, so #root exists at execution time.
  const rootElement = document.getElementById("root");
  if (rootElement !== null) {
    ReactDOM.createRoot(rootElement).render(<App />);
  }
}
