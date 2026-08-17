namespace Embassy {
  export function canRequestCodexRegistrationRemoval(
    route: DashboardRouteRow,
  ): boolean {
    return route.provider === "codex" && route.mutable !== false;
  }

  export const canOfferConsentEdgeCandidate = (route: DashboardRouteRow): boolean => route.enabled && (route.state === "idle" || route.state === "busy" || route.state === "awaiting_approval");

  function sameEdge(
    edge: DashboardConsentEdgeRow,
    aliases: readonly [string, string],
  ): boolean {
    const actual = edge.endpoints.map(({ alias }) => alias);
    return aliases.every((alias) => actual.includes(alias));
  }

  function ActionButton(props: Readonly<{
    action: LiveDashboardAction;
    label: string;
    consequence?: string;
    enabled: boolean;
    onAction: RoutesTabProps["onAction"];
  }>): React.ReactElement {
    const t = useT();
    const [confirming, setConfirming] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [result, setResult] = React.useState<LiveDashboardActionResult>();
    const run = (): void => {
      setPending(true);
      props.onAction(props.action).then((next) => {
        setResult(next); setPending(false); setConfirming(false);
      });
    };
    if (confirming) return <span className="stack-sm">
      {props.consequence === undefined ? null : <span className="footnote">{props.consequence}</span>}
      <span className="row-baseline">
      <button type="button" disabled={pending} onClick={run}>{pending ? t("live.action.pending") : t("live.action.confirm")}</button>
      <button type="button" disabled={pending} onClick={() => { setConfirming(false); }}>{t("live.action.cancel")}</button>
      </span>
    </span>;
    return <span className="stack-sm">
      <button type="button" disabled={!props.enabled} onClick={() => { setResult(undefined); setConfirming(true); }}>{props.label}</button>
      {result === undefined ? null : <span className="footnote">{t(result.ok ? "live.action.succeeded" : "live.action.failed", { code: result.code })}</span>}
    </span>;
  }

  function edgeLabel(edge: DashboardConsentEdgeRow, t: Translate): string {
    const labels = edge.endpoints.map(({ provider, alias }) =>
      t("app.routes.consentEndpoint", { provider: t(`provider.${provider}`), alias }));
    return t("app.routes.consentEdge", { left: labels[0] ?? "", right: labels[1] ?? "" });
  }

  export function RoutesTab(props: RoutesTabProps): React.ReactElement {
    const t = useT();
    const { data } = props;
    const candidates: Array<readonly [DashboardRouteRow, DashboardRouteRow]> = [];
    for (let left = 0; left < data.routes.length; left += 1) {
      for (let right = left + 1; right < data.routes.length; right += 1) {
        const a = data.routes[left]?.route; const b = data.routes[right]?.route;
        if (a === undefined || b === undefined || !canOfferConsentEdgeCandidate(a) || !canOfferConsentEdgeCandidate(b) ||
          (a.provider === b.provider && a.host === b.host) || [a, b].find((route) => route.host === [a.host, b.host].sort()[0])?.mutable === false) continue;
        if (!data.consentEdges.some((edge) => sameEdge(edge, [a.alias, b.alias]))) candidates.push([a, b]);
      }
    }
    return <div className="tab-panel">
      <section className="section">
        <h2 className="mono-label section-label">{t("app.routes.topology")}</h2>
        <p>{t("app.routes.pairSummary", { ready: data.graph.readyConsentEdgeCount, total: data.graph.consentEdgeCount })}</p>
        <ul className="pair-list">
          {data.consentEdges.map((edge) => {
            const aliases = edge.endpoints.map(({ alias }) => alias) as [string, string];
            return <li key={aliases.join("\0")}><code>{edgeLabel(edge, t)}</code> <StateChip domain="route" state={edge.state === "ready" ? "idle" : "stale"} small />
              <ActionButton action={{ action: "unpair", aliases }} label={t("live.action.unpair")} enabled={props.actionsEnabled && edge.mutable !== false} onAction={props.onAction} />
            </li>;
          })}
        </ul>
        {data.consentEdgesOmitted > 0 ? <p className="footnote">{t("app.omitted.pairs", { count: data.consentEdgesOmitted })}</p> : null}
      </section>
      {GATEWAY_PROVIDERS.map((provider) => {
        const routes = data.routes.filter((view) => view.route.provider === provider);
        return <section className="section" key={provider} aria-label={t(`provider.${provider}`)}>
          <h2 className="mono-label section-label">{t(`provider.${provider}`)}</h2>
          <ul>{routes.map(({ route, oldestAgeMs }) => <li key={`${route.alias}\0${route.host}`}>
            <code>{route.alias}</code> · <StateChip domain="route" state={route.state} small /> · {t("app.routes.queueDepth")}: {route.queueDepth}{oldestAgeMs === undefined ? "" : ` · ${fmtAge(oldestAgeMs)}`}
            {canRequestCodexRegistrationRemoval(route) ? <ActionButton action={{ action: "remove_codex_registration", alias: route.alias }} label={t("live.action.removeCodexRegistration")} consequence={t("app.routes.removeCodex.consequence", { alias: route.alias })} enabled={props.actionsEnabled} onAction={props.onAction} /> : null}
          </li>)}</ul>
          <p className="footnote">{t("app.routes.unpairedProvider", { provider: t(`provider.${provider}`), count: data.graph.unpairedReadyByProvider[provider] })}</p>
        </section>;
      })}
      <section className="section">
        <h2 className="mono-label section-label">{t("app.routes.candidates")}</h2>
        <ul>{candidates.map(([left, right]) => <li key={`${left.alias}\0${right.alias}`}><code>{left.alias} ↔ {right.alias}</code>
          <ActionButton action={{ action: "pair", aliases: [left.alias, right.alias] }} label={t("live.action.pair")} enabled={props.actionsEnabled} onAction={props.onAction} />
        </li>)}</ul>
        <ActionButton action={{ action: "refresh_dashboard" }} label={t("live.action.refresh")} enabled={props.actionsEnabled} onAction={props.onAction} />
      </section>
    </div>;
  }
}
