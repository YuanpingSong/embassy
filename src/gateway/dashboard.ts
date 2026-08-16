import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  formatDashboardCopy,
  getDashboardCopy,
  type DashboardCopy,
  type DashboardCopyKey,
  type DashboardLocale,
} from "./dashboard-copy.js";
import {
  buildDashboardViewModel,
  DASHBOARD_MODEL_LIMITS,
  dashboardTone,
  deliveryMeaningKey,
  guidanceCopyKey,
  nextActionCopyKey,
  type DashboardAttentionItem,
  type DashboardExchangeParty,
  type DashboardMessageGroup,
  type DashboardTone,
  type DashboardViewModel,
} from "./dashboard-model.js";
import { parseDirection } from "./types.js";
import type {
  ConnectorHealth,
  DeliveryState,
  GatewayProvider,
  GatewayPublicSnapshot,
  PublicAvailablePeerState,
  RouteState,
} from "./types.js";

export type { GatewayPublicSnapshot } from "./types.js";
export type DashboardSnapshot = GatewayPublicSnapshot;

export const DASHBOARD_FILE_NAME = "gateway-dashboard.html";
export const DASHBOARD_ZH_CN_FILE_NAME = "gateway-dashboard.zh-CN.html";
/** Retained as an API compatibility constant. Static snapshots never refresh. */
export const DASHBOARD_DEFAULT_REFRESH_SECONDS = 15;
export const DASHBOARD_MESSAGE_LIMIT = DASHBOARD_MODEL_LIMITS.messages;
export const DASHBOARD_MESSAGE_HISTORY_LIMIT = DASHBOARD_MODEL_LIMITS.messageEvents;
export const DASHBOARD_CONNECTOR_LIMIT = DASHBOARD_MODEL_LIMITS.connectors;
export const DASHBOARD_AVAILABLE_PEER_LIMIT = DASHBOARD_MODEL_LIMITS.availablePeers;
export const DASHBOARD_AVAILABLE_PEER_INPUT_LIMIT = 256;
export const DASHBOARD_ROUTE_LIMIT = DASHBOARD_MODEL_LIMITS.routes;
export const DASHBOARD_ALERT_LIMIT = DASHBOARD_MODEL_LIMITS.alerts;
export const DASHBOARD_MAX_HTML_BYTES = 256 * 1024;

export type DashboardRenderOptions = {
  locale?: DashboardLocale;
  /** Deprecated and ignored: v1 snapshots are deliberately inert. */
  refreshSeconds?: number;
};

const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeDashboardHtml(value: string): string {
  return value.replace(
    HTML_ESCAPE_PATTERN,
    (character) => HTML_ESCAPES[character] ?? "",
  );
}

type RenderContext = Readonly<{
  locale: DashboardLocale;
  copy: DashboardCopy;
  model: DashboardViewModel;
}>;

function t(
  context: RenderContext,
  key: DashboardCopyKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return escapeDashboardHtml(formatDashboardCopy(context.copy, key, values));
}

function normalizeDashboardLocale(value: unknown): DashboardLocale {
  if (value === undefined || value === "en") return "en";
  if (value === "zh-CN") return "zh-CN";
  throw new Error("DASHBOARD_LOCALE_UNSUPPORTED");
}

function formatInteger(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderCount(
  context: RenderContext,
  value: number,
  lowerBound: boolean,
): string {
  const count = formatInteger(value);
  return lowerBound
    ? t(context, "count.atLeast", { count })
    : count;
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatQueueAge(
  milliseconds: number | undefined,
  locale: DashboardLocale,
): string | undefined {
  if (milliseconds === undefined) return undefined;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return locale === "zh-CN" ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return locale === "zh-CN"
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return locale === "zh-CN"
      ? `${hours} 小时 ${minutes % 60} 分`
      : `${hours}h ${minutes % 60}m`;
  }
  return locale === "zh-CN"
    ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) {
    const kibibytes = bytes / 1_024;
    return `${kibibytes < 10 ? kibibytes.toFixed(1) : Math.round(kibibytes)} KiB`;
  }
  const mebibytes = bytes / 1_048_576;
  return `${mebibytes < 10 ? mebibytes.toFixed(1) : Math.round(mebibytes)} MiB`;
}

function formatShortAge(milliseconds: number, locale: DashboardLocale): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return locale === "zh-CN" ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return locale === "zh-CN" ? `${minutes} 分` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return locale === "zh-CN" ? `${hours} 小时` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return locale === "zh-CN" ? `${days} 天` : `${days}d`;
}

function renderTimestampAtSnapshot(
  context: RenderContext,
  timestamp: string | undefined,
): string {
  if (timestamp === undefined) {
    return `<span class="quiet">${t(context, "time.unavailable")}</span>`;
  }
  if (context.model.generatedAt === undefined) {
    return `<time datetime="${timestamp}" title="${timestamp}">${escapeDashboardHtml(timestamp.slice(0, 19).replace("T", " "))} UTC</time>`;
  }
  const difference =
    Date.parse(context.model.generatedAt) - Date.parse(timestamp);
  let label: string;
  if (Math.abs(difference) < 1_000) {
    label = t(context, "time.atSnapshot");
  } else if (difference > 0) {
    label = t(context, "time.beforeSnapshot", {
      age: formatShortAge(difference, context.locale),
    });
  } else {
    label = t(context, "time.afterSnapshot", {
      age: formatShortAge(-difference, context.locale),
    });
  }
  return `<time datetime="${timestamp}" title="${timestamp}">${label}</time>`;
}

function toneForOverall(overall: DashboardViewModel["overall"]): DashboardTone {
  return dashboardTone("overall", overall);
}

function toneForParty(status: DashboardExchangeParty["status"]): DashboardTone {
  return dashboardTone("party", status);
}

function toneForHealth(health: ConnectorHealth): DashboardTone {
  return dashboardTone("health", health);
}

function toneForRoute(state: RouteState): DashboardTone {
  return dashboardTone("route", state);
}

function toneForPeer(state: PublicAvailablePeerState): DashboardTone {
  return dashboardTone("peer", state);
}

function toneForDelivery(
  state: DeliveryState,
  safeErrorCode?: string,
): DashboardTone {
  return dashboardTone("delivery", state, safeErrorCode);
}

function statusPill(label: string, tone: DashboardTone): string {
  return `<span class="status status--${tone}"><span class="status__dot" aria-hidden="true"></span>${label}</span>`;
}

function overallLabel(context: RenderContext): string {
  return t(
    context,
    context.model.overall === "ready"
      ? "overall.ready"
      : context.model.overall === "attention"
        ? "overall.attention"
        : "overall.setup",
  );
}

function partyStatusLabel(
  context: RenderContext,
  status: DashboardExchangeParty["status"],
): string {
  const key: DashboardCopyKey =
    status === "ready"
      ? "status.ready"
      : status === "busy"
        ? "status.busy"
        : status === "waiting"
          ? "status.waiting"
          : status === "attention"
            ? "status.attention"
            : "status.missing";
  return t(context, key);
}

function nextActionLabel(
  context: RenderContext,
  action: DashboardExchangeParty["nextAction"],
): string {
  return t(context, nextActionCopyKey(action) as DashboardCopyKey);
}

function renderParty(context: RenderContext, party: DashboardExchangeParty): string {
  const isClaude = party.kind === "claude";
  const title = party.kind === "claude"
    ? t(context, "exchange.claude.title")
    : party.kind === "codex"
      ? t(context, "exchange.codex.title")
      : providerLabel(context, party.kind);
  const note = party.kind === "claude"
    ? t(context, "exchange.claude.note")
    : party.kind === "codex"
      ? t(context, "exchange.codex.note")
      : t(context, "exchange.provider.note");
  const ready = renderCount(context, party.ready, party.countIsLowerBound);
  const total = renderCount(context, party.total, party.countIsLowerBound);
  const selectable = renderCount(
    context,
    party.selectable ?? 0,
    party.countIsLowerBound,
  );
  return `<article class="exchange-party exchange-party--${party.kind}" data-semantic-party="${party.kind}">
    <div class="party-heading">
      <div><h3>${title}</h3><p>${note}</p></div>
      ${statusPill(partyStatusLabel(context, party.status), toneForParty(party.status))}
    </div>
    <p class="party-count">${t(context, isClaude ? "exchange.count.claude" : "app.overview.count.provider", { ready, selectable, total })}</p>
    ${party.primaryAlias === undefined ? "" : `<p class="party-alias">${escapeDashboardHtml(party.primaryAlias)}</p>`}
    <p class="next-action"><strong>${t(context, "next.label")}:</strong> ${nextActionLabel(context, party.nextAction)}</p>
  </article>`;
}

function renderPairGraph(context: RenderContext): string {
  const graph = context.model.graph;
  const locallyOmittedPairs = Math.max(
    0,
    graph.consentEdgeCount - context.model.consentEdges.length,
  );
  const upstreamOmittedPairs = Math.max(
    0,
    context.model.omissions.consentEdges - locallyOmittedPairs,
  );
  const knownPairCount = graph.consentEdgeCount + upstreamOmittedPairs;
  const summary = t(context, "app.routes.pairSummary", {
    ready: renderCount(
      context,
      graph.readyConsentEdgeCount,
      graph.consentEdgeCountIsLowerBound,
    ),
    total: renderCount(context, knownPairCount, graph.consentEdgeCountIsLowerBound),
  });
  const unpaired = context.model.exchange.parties.map((party) =>
    t(context, "app.routes.unpairedProvider", {
      provider: providerLabel(context, party.kind),
      count: String(graph.unpairedReadyByProvider[party.kind]),
    })
  ).join(" · ");
  const hasPairEvidence =
    graph.consentEdgeCount > 0 || graph.consentEdgeCountIsLowerBound;
  const rows = context.model.consentEdges.length === 0 && !hasPairEvidence
    ? `<p class="quiet">${t(context, "app.routes.noPairInline")}</p>`
    : `<ul class="pair-list">${context.model.consentEdges.map((edge) => {
        const [left, right] = edge.endpoints;
        const label = t(context, "app.routes.consentEdge", {
          left: t(context, "app.routes.consentEndpoint", {
            provider: providerLabel(context, left.provider),
            alias: escapeDashboardHtml(left.alias),
          }),
          right: t(context, "app.routes.consentEndpoint", {
            provider: providerLabel(context, right.provider),
            alias: escapeDashboardHtml(right.alias),
          }),
        });
        const stateLabel = edge.state === "ready"
          ? t(context, "status.ready")
          : t(
              context,
              edge.state === "degraded"
                ? "app.routes.pairState.degraded"
                : "app.routes.pairState.unavailable",
            );
        const tone: DashboardTone = edge.state === "ready"
          ? "good"
          : edge.state === "degraded"
            ? "warning"
            : "danger";
        const reason = edge.state === "ready"
          ? ""
          : `<small>${t(context, edge.state === "degraded" ? "app.routes.pairDegradedReason" : "app.routes.pairUnavailableReason")}</small>`;
        return `<li><span>${label}${reason}</span>${statusPill(stateLabel, tone)}</li>`;
      }).join("")}</ul>`;
  const omitted = context.model.omissions.consentEdges === 0
    ? ""
    : `<p class="quiet">${t(context, "app.omitted.pairs", {
        count: String(context.model.omissions.consentEdges),
      })}</p>`;
  return `<section class="pair-graph" aria-labelledby="pair-graph-title">
    <div class="pair-graph__heading"><h3 id="pair-graph-title">${t(context, "app.routes.pairs")}</h3><strong>${summary}</strong></div>
    <p>${unpaired}</p>
    ${rows}
    ${omitted}
  </section>`;
}

function renderExchange(context: RenderContext): string {
  const age = formatQueueAge(
    context.model.exchange.oldestQueueAgeMs,
    context.locale,
  );
  const pouch = context.model.exchange.queuedMessages === 0
    ? t(context, "exchange.pouch.empty")
    : t(context, "exchange.pouch.queued", {
        count: renderCount(
          context,
          context.model.exchange.queuedMessages,
          context.model.exchange.queueCountIsLowerBound,
        ),
      });
  const paired = context.model.inboundMode === "paired";
  const hasPair =
    context.model.graph.consentEdgeCount > 0 ||
    context.model.graph.consentEdgeCountIsLowerBound;
  const policyBody = paired
    ? t(context, hasPair ? "inbound.paired.body" : "inbound.noPair.body")
    : t(context, "inbound.open.body");
  const directionParties = context.model.exchange.parties.length === 2
    ? [...context.model.exchange.parties].reverse()
    : context.model.exchange.parties;
  return `<section class="section exchange" aria-labelledby="exchange-title">
    <div class="section-heading">
      <div><p class="eyebrow">${t(context, "exchange.eyebrow")}</p><h2 id="exchange-title">${t(context, "exchange.title")}</h2></div>
      <p>${t(context, "exchange.note")}</p>
    </div>
    <div class="inbound-policy" data-inbound-mode="${context.model.inboundMode}">
      ${statusPill(
        t(
          context,
          paired ? "inbound.paired.badge" : "inbound.open.badge",
        ),
        paired ? "quiet" : "warning",
      )}
      <p>${policyBody}</p>
    </div>
    <div class="exchange-board${context.model.exchange.parties.length > 2 ? " exchange-board--many" : ""}">
      ${renderParty(context, context.model.exchange.parties[0]!)}
      <div class="pouch" aria-label="${t(context, "exchange.pouch.title")}">
        <span class="pouch__line" aria-hidden="true"></span>
        <div class="seal-mark" aria-hidden="true"><span></span></div>
        <p class="pouch__title">${t(context, "exchange.pouch.title")}</p>
        <strong>${pouch}</strong>
        ${age === undefined ? "" : `<small>${t(context, "exchange.pouch.oldest", { age })}</small>`}
      </div>
      ${context.model.exchange.parties.slice(1).map((party) => renderParty(context, party)).join("")}
    </div>
    <div class="direction-key" aria-label="${t(context, "exchange.title")}">${directionParties.flatMap((source) => context.model.exchange.parties.filter((target) => target.kind !== source.kind).map((target) => `<span>${providerLabel(context, source.kind)} → ${providerLabel(context, target.kind)}</span>`)).join("")}</div>
    ${renderPairGraph(context)}
  </section>`;
}

function severityLabel(context: RenderContext, severity: DashboardAttentionItem["severity"]): string {
  return t(
    context,
    severity === "error"
      ? "severity.error"
      : severity === "warning"
        ? "severity.warning"
        : "severity.info",
  );
}

function alertTone(severity: DashboardAttentionItem["severity"]): DashboardTone {
  return dashboardTone("severity", severity);
}

function guidanceKeys(guidance: DashboardAttentionItem["guidance"]): readonly [DashboardCopyKey, DashboardCopyKey, DashboardCopyKey] {
  const segment = guidanceCopyKey(guidance);
  return [
    `guidance.${segment}.title` as DashboardCopyKey,
    `guidance.${segment}.body` as DashboardCopyKey,
    `guidance.${segment}.action` as DashboardCopyKey,
  ];
}

function renderAttention(context: RenderContext): string {
  const hasOmissions =
    context.model.omissions.upstreamAlerts > 0 ||
    context.model.omissions.attentionItems > 0;
  if (context.model.attention.length === 0 && !hasOmissions) return "";
  return `<section class="section attention" aria-labelledby="attention-title">
    <div class="section-heading"><div><p class="eyebrow">${t(context, "attention.eyebrow")}</p><h2 id="attention-title">${t(context, "attention.title")}</h2></div><p>${t(context, hasOmissions ? "attention.countVisible" : "attention.count", { count: formatInteger(context.model.attention.length) })}</p></div>
    ${context.model.attention.length === 0 ? `<p class="attention-projection-note">${t(context, "attention.projectionOnly")}</p>` : `<ol class="attention-list">${context.model.attention
      .map((item) => {
        const [titleKey, bodyKey, actionKey] = guidanceKeys(item.guidance);
        const scope = [
          item.provider === undefined
            ? undefined
            : providerLabel(context, item.provider),
          item.alias === undefined ? undefined : escapeDashboardHtml(item.alias),
          item.host === undefined ? undefined : escapeDashboardHtml(item.host),
        ].filter((value): value is string => value !== undefined);
        return `<li class="attention-item attention-item--${alertTone(item.severity)}">
          <div class="attention-item__meta">${statusPill(severityLabel(context, item.severity), alertTone(item.severity))}${item.code === undefined ? "" : `<code>${item.code}</code>`}${renderTimestampAtSnapshot(context, item.timestamp)}</div>
          <h3>${t(context, titleKey)}</h3><p>${t(context, bodyKey)}</p>
          ${item.queueDepth === undefined ? "" : `<p><strong>${t(context, "transit.queued")}:</strong> ${formatInteger(item.queueDepth)}</p><p>${t(context, "guidance.queueStalled.busy")}</p>`}
          ${scope.length === 0 ? "" : `<p class="scope"><strong>${t(context, "attention.scope")}:</strong> ${scope.join(" · ")}</p>`}
          <p class="next-action"><strong>${t(context, "next.label")}:</strong> ${t(context, actionKey, { alias: item.alias ?? "<alias>" })}</p>
        </li>`;
      })
      .join("")}</ol>`}
  </section>`;
}

function renderTransit(context: RenderContext): string {
  const age = formatQueueAge(
    context.model.transit.oldestQueueAgeMs,
    context.locale,
  );
  return `<section class="section transit" aria-labelledby="transit-title">
    <div class="section-heading"><div><p class="eyebrow">${t(context, "transit.eyebrow")}</p><h2 id="transit-title">${t(context, "transit.title")}</h2></div>${context.model.transit.queuedMessages === 0 ? `<p>${t(context, "transit.empty")}</p>` : ""}</div>
    <dl class="ledger-strip">
      <div><dt>${t(context, "transit.queued")}</dt><dd>${renderCount(context, context.model.transit.queuedMessages, context.model.transit.queueCountIsLowerBound)}</dd></div>
      <div><dt>${t(context, "transit.active")}</dt><dd>${renderCount(context, context.model.transit.activeDeliveries, context.model.transit.activeCountIsLowerBound)}</dd></div>
      <div><dt>${t(context, "transit.oldest")}</dt><dd>${age === undefined ? t(context, context.model.transit.queuedMessages === 0 ? "time.unavailable" : "transit.unavailable") : `<time datetime="${context.model.transit.oldestQueuedAt}">${escapeDashboardHtml(age)}</time>`}</dd></div>
    </dl>
  </section>`;
}

function deliveryLabelKey(state: DeliveryState): DashboardCopyKey {
  switch (state) {
    case "queued": return "delivery.queued";
    case "duplicate": return "delivery.duplicate";
    case "dispatching": return "delivery.dispatching";
    case "transport_written": return "delivery.transportWritten";
    case "held": return "delivery.held";
    case "delivered": return "delivery.delivered";
    case "unconfirmed": return "delivery.unconfirmed";
    case "failed": return "delivery.failed";
    case "ambiguous": return "delivery.ambiguous";
    case "expired": return "delivery.expired";
    case "cancelled": return "delivery.cancelled";
    case "abandoned": return "delivery.abandoned";
    case "rejected": return "delivery.rejected";
  }
}

function renderMessageHistory(context: RenderContext, message: DashboardMessageGroup): string {
  if (message.events.length <= 1) {
    return `<span class="quiet">${t(context, "activity.history.one")}</span>`;
  }
  return `<details class="history"><summary>${t(context, "activity.history.many", { count: formatInteger(message.events.length) })}</summary><ol>${message.events
    .map(
      (event) => `<li data-dashboard-row="message-event">${renderTimestampAtSnapshot(context, event.timestamp)} ${statusPill(t(context, deliveryLabelKey(event.state)), toneForDelivery(event.state, event.safeErrorCode))}${event.safeErrorCode === undefined ? "" : `<code>${event.safeErrorCode}</code>`}</li>`,
    )
    .join("")}</ol></details>`;
}

function renderActivity(context: RenderContext): string {
  const rows = context.model.activity.length === 0
    ? `<tr class="empty-row"><td colspan="7">${t(context, "activity.empty")}</td></tr>`
    : context.model.activity
        .map(
          (message) => `<tr data-dashboard-row="message-summary" data-delivery-state="${message.state}">
            <td data-label="${t(context, "activity.column.updated")}">${renderTimestampAtSnapshot(context, message.timestamp)}</td>
            <td data-label="${t(context, "activity.column.route")}" class="route-cell"><strong>${directionLabel(context, message.direction)}${message.steer === true ? ' <span class="pill quiet">STEER</span>' : ""}</strong><span>${escapeDashboardHtml(message.sourceAlias)} → ${escapeDashboardHtml(message.targetAlias)}</span></td>
            <td data-label="${t(context, "activity.column.id")}"><code>…${message.messageIdSuffix ?? "—"}</code>${message.conversationIdSuffix === undefined ? "" : `<span class="cell-note"><code>conv …${escapeDashboardHtml(message.conversationIdSuffix)}</code></span>`}</td>
            <td data-label="${t(context, "activity.column.result")}">${statusPill(t(context, deliveryLabelKey(message.state)), toneForDelivery(message.state, message.safeErrorCode))}<span class="cell-note">${t(context, deliveryMeaningKey(message.state, message.direction, message.safeErrorCode) as DashboardCopyKey)}</span>${message.safeErrorCode === undefined ? "" : `<code class="cell-code">${message.safeErrorCode}</code>`}</td>
            <td data-label="${t(context, "activity.column.elapsed")}" class="numeric">${formatDuration(message.latencyMs)}</td>
            <td data-label="${t(context, "activity.column.size")}" class="numeric">${formatBytes(message.bytes)}</td>
            <td data-label="${t(context, "activity.column.history")}">${renderMessageHistory(context, message)}</td>
          </tr>`,
        )
        .join("");
  const operationCopyKeys: Readonly<
    Record<(typeof context.model.brokerActivity)[number]["action"], DashboardCopyKey>
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
    endpoint_refreshed: "app.activity.operation.endpointRefreshed",
    codex_orphan_removed: "app.activity.operation.codexOrphanRemoved",
  };
  const operations = context.model.brokerActivity.length === 0
    ? ""
    : `<details class="history"><summary>${t(context, "app.activity.kinds.operation")} (${formatInteger(context.model.brokerActivity.length)})</summary><ol>${context.model.brokerActivity
        .slice()
        .reverse()
        .map(
          (event) => `<li data-dashboard-row="${event.operatorAction ? "operator-action" : "automatic-event"}" data-activity-authority="${event.operatorAction ? "operator" : "automatic"}">${renderTimestampAtSnapshot(context, event.timestamp)} ${statusPill(t(context, event.operatorAction ? "app.activity.operation.operator" : "app.activity.operation.automatic"), event.operatorAction ? "info" : "quiet")} ${escapeDashboardHtml(t(context, operationCopyKeys[event.action]))} ${statusPill(t(context, event.outcome === "accepted" ? "app.activity.operation.accepted" : "app.activity.operation.rejected"), event.outcome === "accepted" ? "good" : "warning")}${event.aliases.length === 0 ? "" : ` <code>${event.aliases.map(escapeDashboardHtml).join(" · ")}</code>`}${event.safeErrorCode === undefined ? "" : ` <code>${event.safeErrorCode}</code>`}</li>`,
        )
        .join("")}</ol></details>`;
  return `<section class="section" aria-labelledby="activity-title">
    <div class="section-heading"><div><p class="eyebrow">${t(context, "activity.eyebrow")}</p><h2 id="activity-title">${t(context, "activity.title")}</h2></div><p>${t(context, "activity.note")}</p></div>
    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="activity-title"><table class="responsive-table"><caption>${t(context, "activity.note")}</caption><thead><tr><th>${t(context, "activity.column.updated")}</th><th>${t(context, "activity.column.route")}</th><th>${t(context, "activity.column.id")}</th><th>${t(context, "activity.column.result")}</th><th class="numeric">${t(context, "activity.column.elapsed")}</th><th class="numeric">${t(context, "activity.column.size")}</th><th>${t(context, "activity.column.history")}</th></tr></thead><tbody>${rows}</tbody></table></div>${operations}
  </section>`;
}

function renderProgressWatches(context: RenderContext): string {
  const rows = context.model.watches.length === 0
    ? `<tr class="empty-row"><td colspan="5">${t(context, "watches.empty")}</td></tr>`
    : context.model.watches
        .map(
          (watch) => `<tr data-dashboard-row="progress-watch">
            <th scope="row" data-label="${t(context, "watches.column.conversation")}"><code>…${escapeDashboardHtml(watch.conversationIdSuffix)}</code></th>
            <td data-label="${t(context, "watches.column.parties")}" class="route-cell"><strong>${escapeDashboardHtml(watch.ownerAlias)} → ${escapeDashboardHtml(watch.workerAlias)}</strong></td>
            <td data-label="${t(context, "watches.column.quietFor")}" class="numeric">${formatDuration(watch.idleForMs)}</td>
            <td data-label="${t(context, "watches.column.nextAction")}" class="numeric">${formatDuration(watch.dueInMs)}</td>
            <td data-label="${t(context, "watches.column.nudges")}" class="numeric">${formatInteger(watch.nudgeCount)}</td>
          </tr>`,
        )
        .join("");
  return `<section class="section" aria-labelledby="watches-title">
    <div class="section-heading"><div><p class="eyebrow">${t(context, "watches.eyebrow")}</p><h2 id="watches-title">${t(context, "watches.title")}</h2></div><p>${t(context, "watches.note")}</p></div>
    <div class="table-wrap" tabindex="0" role="region" aria-labelledby="watches-title"><table class="responsive-table"><caption>${t(context, "watches.note")}</caption><thead><tr><th>${t(context, "watches.column.conversation")}</th><th>${t(context, "watches.column.parties")}</th><th class="numeric">${t(context, "watches.column.quietFor")}</th><th class="numeric">${t(context, "watches.column.nextAction")}</th><th class="numeric">${t(context, "watches.column.nudges")}</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function providerLabel(context: RenderContext, provider: GatewayProvider): string {
  return t(context, `provider.${provider}` as DashboardCopyKey);
}

function directionLabel(
  context: RenderContext,
  direction: DashboardMessageGroup["direction"],
): string {
  const parsed = parseDirection(direction);
  return parsed === undefined
    ? direction
    : `${providerLabel(context, parsed.sourceProvider)} → ${providerLabel(context, parsed.targetProvider)}`;
}

function healthLabel(context: RenderContext, health: ConnectorHealth): string {
  return t(context, `health.${health}` as DashboardCopyKey);
}

function routeStateLabel(context: RenderContext, state: RouteState): string {
  const suffix = state === "awaiting_approval" ? "awaitingApproval" : state;
  return t(context, `route.${suffix}` as DashboardCopyKey);
}

function peerStateLabel(context: RenderContext, state: PublicAvailablePeerState): string {
  const suffix = state === "awaiting_approval" ? "awaitingApproval" : state;
  return t(context, `peer.${suffix}` as DashboardCopyKey);
}

function peerSelectionGuidance(
  context: RenderContext,
  guidance: NonNullable<DashboardViewModel["peers"][number]["selectionGuidance"]>,
): string {
  const key: DashboardCopyKey =
    guidance === "alias_collision"
      ? "peer.reason.aliasCollision"
      : guidance === "session_collision"
        ? "peer.reason.sessionCollision"
        : guidance === "discovery_incomplete"
          ? "peer.reason.discoveryIncomplete"
          : guidance === "offline"
            ? "peer.reason.offline"
            : "peer.reason.offline";
  return t(context, key);
}

function renderSessions(context: RenderContext): string {
  const peerRows = context.model.peers.length === 0
    ? `<tr class="empty-row"><td colspan="7">${t(context, "sessions.peers.empty")}</td></tr>`
    : context.model.peers.map((peer) => `<tr><th scope="row" data-label="${t(context, "column.alias")}">${escapeDashboardHtml(peer.alias)}</th><td data-label="${t(context, "column.host")}">${escapeDashboardHtml(peer.host)}</td><td data-label="${t(context, "column.state")}">${statusPill(peerStateLabel(context, peer.state), toneForPeer(peer.state))}</td><td data-label="${t(context, "column.validation")}">${statusPill(t(context, peer.validated ? "status.validated" : "status.validationRejected"), peer.validated ? "good" : "warning")}</td><td data-label="${t(context, "column.selection")}">${peer.selectable ? statusPill(t(context, peer.selected ? "status.selected" : "status.available"), peer.selected ? "good" : "quiet") : `${statusPill(t(context, "status.notSelectable"), "warning")}${peer.selectionGuidance === undefined ? "" : `<span class="cell-note">${peerSelectionGuidance(context, peer.selectionGuidance)}</span>`}`}</td><td data-label="${t(context, "column.observed")}">${renderTimestampAtSnapshot(context, peer.lastSeenAt)}</td><td data-label="${t(context, "column.issue")}">${peer.safeErrorCode === undefined ? "—" : `<code>${peer.safeErrorCode}</code>`}</td></tr>`).join("");
  const routeRows = context.model.routes.length === 0
    ? `<tr class="empty-row"><td colspan="7">${t(context, "sessions.routes.empty")}</td></tr>`
    : context.model.routes.map((route) => `<tr><th scope="row" data-label="${t(context, "column.alias")}">${escapeDashboardHtml(route.alias)}</th><td data-label="${t(context, "column.provider")}">${providerLabel(context, route.provider)}</td><td data-label="${t(context, "column.host")}">${escapeDashboardHtml(route.host)}</td><td data-label="${t(context, "column.state")}">${statusPill(routeStateLabel(context, route.enabled ? route.state : "disabled"), toneForRoute(route.enabled ? route.state : "disabled"))}</td><td data-label="${t(context, "column.queue")}">${formatInteger(route.queueDepth)}${route.queueAgeMs === undefined ? "" : `<span class="cell-note">${escapeDashboardHtml(formatQueueAge(route.queueAgeMs, context.locale) ?? "")}</span>`}</td><td data-label="${t(context, "column.observed")}">${renderTimestampAtSnapshot(context, route.lastSeenAt)}</td><td data-label="${t(context, "column.issue")}">${route.safeErrorCode === undefined ? "—" : `<code>${route.safeErrorCode}</code>`}</td></tr>`).join("");
  return `<section class="section" aria-labelledby="sessions-title">
    <div class="section-heading"><div><p class="eyebrow">${t(context, "sessions.eyebrow")}</p><h2 id="sessions-title">${t(context, "sessions.title")}</h2></div><p>${t(context, "sessions.note")}</p></div>
    <div class="register-grid">
      <section aria-labelledby="peers-title"><h3 id="peers-title">${t(context, "sessions.peers.title")}</h3><div class="table-wrap" tabindex="0" role="region" aria-labelledby="peers-title"><table class="responsive-table"><caption>${t(context, "sessions.peers.caption")}</caption><thead><tr><th>${t(context, "column.alias")}</th><th>${t(context, "column.host")}</th><th>${t(context, "column.state")}</th><th>${t(context, "column.validation")}</th><th>${t(context, "column.selection")}</th><th>${t(context, "column.observed")}</th><th>${t(context, "column.issue")}</th></tr></thead><tbody>${peerRows}</tbody></table></div></section>
      <section aria-labelledby="routes-title"><h3 id="routes-title">${t(context, "sessions.routes.title")}</h3><div class="table-wrap" tabindex="0" role="region" aria-labelledby="routes-title"><table class="responsive-table"><caption>${t(context, "sessions.routes.caption")}</caption><thead><tr><th>${t(context, "column.alias")}</th><th>${t(context, "column.provider")}</th><th>${t(context, "column.host")}</th><th>${t(context, "column.state")}</th><th>${t(context, "column.queue")}</th><th>${t(context, "column.observed")}</th><th>${t(context, "column.issue")}</th></tr></thead><tbody>${routeRows}</tbody></table></div></section>
    </div>
  </section>`;
}

function renderDiagnostics(context: RenderContext): string {
  const connectorRows = context.model.connectors.length === 0
    ? `<tr class="empty-row"><td colspan="7">${t(context, "diagnostics.connectors.empty")}</td></tr>`
    : context.model.connectors.map((connector) => {
        const observation = connector.registry;
        let registry = "—";
        if (observation !== undefined) {
          const stateKey: DashboardCopyKey =
            observation.parseableRecordSeenSinceBoot
              ? "diagnostics.registry.state.parseableRecordObserved"
              : observation.entriesScanned === 0
                ? "diagnostics.registry.state.emptySinceBoot"
                : "diagnostics.registry.state.noParseableRecordSinceBoot";
          const rejected = observation.rejected.length === 0
            ? t(context, "diagnostics.registry.rejectedNone")
            : observation.rejected
                .map((row) => `<code>${escapeDashboardHtml(row.safeErrorCode)}</code> × ${formatInteger(row.count)}`)
                .join(" · ");
          const omitted = observation.rejectedCodesOmitted === 0
            ? ""
            : `<span class="cell-note">${t(context, "diagnostics.registry.rejectedCodesOmitted", { count: formatInteger(observation.rejectedCodesOmitted) })}</span>`;
          registry = `${statusPill(t(context, stateKey), observation.parseableRecordSeenSinceBoot ? "good" : "warning")}<span class="cell-note">${t(context, "diagnostics.registry.entriesScanned")}: ${formatInteger(observation.entriesScanned)} · ${t(context, "diagnostics.registry.parseableRecords")}: ${formatInteger(observation.parseableRecords)}</span><span class="cell-note">${t(context, "diagnostics.registry.rejected")}: ${rejected}</span>${omitted}`;
        }
        const doctor = connector.codexDoctor?.conditions.map((condition) =>
          `<span class="cell-note">${t(context, `diagnostics.codexDoctor.${condition}` as DashboardCopyKey)}</span>`
        ).join("") ?? "";
        const issue = `${connector.safeErrorCode === undefined ? "" : `<code>${connector.safeErrorCode}</code>`}${doctor}` || "—";
        return `<tr><th scope="row" data-label="${t(context, "column.provider")}">${providerLabel(context, connector.provider)}</th><td data-label="${t(context, "column.host")}">${escapeDashboardHtml(connector.host)}</td><td data-label="${t(context, "diagnostics.health")}">${statusPill(healthLabel(context, connector.health), toneForHealth(connector.health))}</td><td data-label="${t(context, "diagnostics.protocol")}"><code>${escapeDashboardHtml([connector.protocol, connector.protocolVersion].filter(Boolean).join(" ") || "—")}</code></td><td data-label="${t(context, "diagnostics.registry.title")}">${registry}</td><td data-label="${t(context, "column.observed")}">${renderTimestampAtSnapshot(context, connector.lastSeenAt)}</td><td data-label="${t(context, "column.issue")}">${issue}</td></tr>`;
      }).join("");
  const omissions = context.model.omissions;
  const omissionEntries: readonly [number, DashboardCopyKey][] = [
    [omissions.connectors, "diagnostics.omissions.connectors"],
    [omissions.availablePeers, "diagnostics.omissions.peers"],
    [omissions.routes, "diagnostics.omissions.routes"],
    [omissions.consentEdges, "diagnostics.omissions.consentEdges"],
    [omissions.progressWatches, "diagnostics.omissions.progressWatches"],
    [
      omissions.upstreamProgressWatchEvents,
      "diagnostics.omissions.upstreamProgressWatchEvents",
    ],
    [
      omissions.progressWatchEvents,
      "diagnostics.omissions.progressWatchEvents",
    ],
    [
      omissions.upstreamMessageEvents,
      "diagnostics.omissions.upstreamMessageEvents",
    ],
    [omissions.messageGroups, "diagnostics.omissions.messageGroups"],
    [omissions.messageEvents, "diagnostics.omissions.messageEvents"],
    [omissions.upstreamAlerts, "diagnostics.omissions.upstreamAlerts"],
    [omissions.attentionItems, "diagnostics.omissions.attentionItems"],
    [
      omissions.upstreamActivityEvents,
      "diagnostics.omissions.upstreamActivityEvents",
    ],
    [omissions.activityEvents, "diagnostics.omissions.activityEvents"],
  ];
  const visibleOmissions = omissionEntries.filter(([count]) => count > 0);
  const omissionText = visibleOmissions.length === 0
    ? t(context, "diagnostics.omissions.none")
    : visibleOmissions
        .map(([count, key]) => t(context, key, { count: formatInteger(count) }))
        .join(" · ");
  const accounting = context.model.accounting;
  const deadline = context.model.deadlinePressure;
  const deadlineBucketKeys = {
    under_1m: "app.diag.deadline.bucket.under1m",
    "1m_to_5m": "app.diag.deadline.bucket.1to5m",
    "5m_to_15m": "app.diag.deadline.bucket.5to15m",
    "15m_to_60m": "app.diag.deadline.bucket.15to60m",
    over_60m: "app.diag.deadline.bucket.over60m",
  } as const satisfies Readonly<
    Record<NonNullable<typeof deadline>["buckets"][number]["bucket"], DashboardCopyKey>
  >;
  const deadlineSection = deadline === undefined
    ? ""
    : `<section aria-labelledby="deadline-pressure-title"><h3 id="deadline-pressure-title">${t(context, "app.diag.deadline.title")}</h3><p>${t(context, "app.diag.deadline.retained", { terminal: formatInteger(deadline.terminalEvents), expired: formatInteger(deadline.expiredEvents), deadline: formatDuration(deadline.configuredDeadlineMs) })}</p><dl class="accounting">${deadline.buckets.map((bucket) => `<div><dt>${t(context, deadlineBucketKeys[bucket.bucket])}</dt><dd>${formatInteger(bucket.settled)} · ${formatInteger(bucket.expired)} ${t(context, "delivery.expired")}</dd></div>`).join("")}</dl></section>`;
  return `<details class="section diagnostics" aria-labelledby="diagnostics-title" aria-describedby="diagnostics-note">
    <summary><h2 id="diagnostics-title"><span class="disclosure-icon" aria-hidden="true"><span class="disclosure-icon__closed">+</span><span class="disclosure-icon__open">−</span></span>${t(context, "diagnostics.title")}</h2></summary>
    <div class="diagnostics__body">
      <p id="diagnostics-note" class="diagnostics__note">${t(context, "diagnostics.note")}</p>
      <section aria-labelledby="connectors-title"><h3 id="connectors-title">${t(context, "diagnostics.connectors")}</h3><div class="table-wrap" tabindex="0" role="region" aria-labelledby="connectors-title"><table class="responsive-table"><caption>${t(context, "diagnostics.connectors.caption")}</caption><thead><tr><th>${t(context, "column.provider")}</th><th>${t(context, "column.host")}</th><th>${t(context, "diagnostics.health")}</th><th>${t(context, "diagnostics.protocol")}</th><th>${t(context, "diagnostics.registry.title")}</th><th>${t(context, "column.observed")}</th><th>${t(context, "column.issue")}</th></tr></thead><tbody>${connectorRows}</tbody></table></div></section>
      ${deadlineSection}
      <section aria-labelledby="accounting-title"><h3 id="accounting-title">${t(context, "diagnostics.accounting")}</h3><dl class="accounting"><div><dt>${t(context, "diagnostics.accepted")}</dt><dd>${formatInteger(accounting.accepted)}</dd></div><div><dt>${t(context, "diagnostics.duplicates")}</dt><dd>${formatInteger(accounting.duplicates)}</dd></div><div><dt>${t(context, "diagnostics.delivered")}</dt><dd>${formatInteger(accounting.delivered)}</dd></div><div><dt>${t(context, "diagnostics.unconfirmed")}</dt><dd>${formatInteger(accounting.unconfirmed)}</dd></div><div><dt>${t(context, "diagnostics.ambiguous")}</dt><dd>${formatInteger(accounting.ambiguous)}</dd></div><div><dt>${t(context, "diagnostics.failed")}</dt><dd>${formatInteger(accounting.failed)}</dd></div><div><dt>${t(context, "diagnostics.expired")}</dt><dd>${formatInteger(accounting.expired)}</dd></div><div><dt>${t(context, "diagnostics.cancelled")}</dt><dd>${formatInteger(accounting.cancelled)}</dd></div><div><dt>${t(context, "diagnostics.abandoned")}</dt><dd>${formatInteger(accounting.abandoned)}</dd></div><div><dt>${t(context, "diagnostics.rejected")}</dt><dd>${formatInteger(accounting.rejected)}</dd></div><div><dt>${t(context, "diagnostics.bytesAccepted")}</dt><dd>${formatBytes(accounting.bytesAccepted)}</dd></div><div><dt>${t(context, "diagnostics.queuedBytes")}</dt><dd>${formatBytes(accounting.queuedBytes)}</dd></div></dl></section>
      <p class="omissions"><strong>${t(context, "diagnostics.omissions")}:</strong> ${omissionText}</p>
    </div>
  </details>`;
}

function languageNavigation(context: RenderContext): string {
  const en = context.locale === "en"
    ? `<span lang="en" aria-current="page">${t(context, "language.en")}</span>`
    : `<a lang="en" hreflang="en" href="./${DASHBOARD_FILE_NAME}">${t(context, "language.en")}</a>`;
  const zh = context.locale === "zh-CN"
    ? `<span lang="zh-CN" aria-current="page">${t(context, "language.zhCn")}</span>`
    : `<a lang="zh-CN" hreflang="zh-CN" href="./${DASHBOARD_ZH_CN_FILE_NAME}">${t(context, "language.zhCn")}</a>`;
  return `<nav class="language" aria-label="${t(context, "language.label")}">${en}<span aria-hidden="true">/</span>${zh}</nav>`;
}

const DASHBOARD_STYLES = `
    :root {
      color-scheme: light;
      --paper: #f5f0e6;
      --paper-deep: #ebe3d4;
      --sheet: #fffdf7;
      --ink: #28251f;
      --muted: #5f594f;
      --hairline: #cbc2b2;
      --hairline-strong: #9e9587;
      --seal: #b63a2c;
      --seal-soft: #f7e5df;
      --good: #256348;
      --good-soft: #e4f0e8;
      --info: #315f78;
      --info-soft: #e5eef1;
      --warning: #8a5a18;
      --warning-soft: #f5ebd7;
      --danger: #a13232;
      --danger-soft: #f6e3df;
      --quiet: #5c574f;
      --quiet-soft: #ece7de;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper); scroll-behavior: smooth; }
    body { margin: 0; color: var(--ink); background: linear-gradient(90deg, transparent 0 49.92%, rgba(78,67,52,.035) 49.92% 50.08%, transparent 50.08%), var(--paper); font: 15px/1.55 ui-serif, Georgia, "Times New Roman", serif; }
    a { color: inherit; text-underline-offset: .2em; }
    a:focus-visible, summary:focus-visible, .table-wrap:focus-visible { outline: 3px solid var(--seal); outline-offset: 3px; }
    .skip-link { position: fixed; z-index: 10; left: 1rem; top: -6rem; padding: .65rem .9rem; color: var(--sheet); background: var(--ink); }
    .skip-link:focus { top: 1rem; }
    main { width: min(100% - 2rem, 1240px); margin: 0 auto; padding: 2rem 0 3rem; }
    .masthead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2rem; align-items: start; padding: 1.35rem 0 2.4rem; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
    .brand-row { display: flex; gap: 1.15rem; align-items: center; }
    .brand-mark, .seal-mark { position: relative; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--ink); border-radius: 50%; }
    .brand-mark { width: 4.4rem; height: 4.4rem; }
    .brand-mark::before, .brand-mark::after, .seal-mark::before, .seal-mark::after { content: ""; position: absolute; top: 23%; bottom: 23%; width: 23%; border-radius: 50%; }
    .brand-mark::before, .seal-mark::before { left: 20%; border-right: 1px solid var(--ink); }
    .brand-mark::after, .seal-mark::after { right: 20%; border-left: 1px solid var(--ink); }
    .brand-mark span, .seal-mark span { position: relative; z-index: 1; width: 24%; aspect-ratio: 1; border-radius: 50%; background: var(--seal); }
    .eyebrow { margin: 0 0 .28rem; color: var(--seal); font: 700 .72rem/1.2 ui-sans-serif, system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: .25rem; font-size: clamp(2.5rem, 7vw, 5.7rem); font-weight: 500; letter-spacing: -.055em; line-height: .9; }
    h2 { margin-bottom: 0; font-size: clamp(1.55rem, 3vw, 2.25rem); font-weight: 500; letter-spacing: -.025em; line-height: 1.05; }
    h3 { margin-bottom: .28rem; font-size: 1.03rem; }
    .subtitle { max-width: 44rem; margin: .65rem 0 0; color: var(--muted); font-size: 1.03rem; }
    .masthead__meta { display: grid; justify-items: end; gap: .8rem; max-width: 23rem; text-align: right; }
    .masthead__meta p { margin: 0; color: var(--muted); font-size: .82rem; }
    .language { display: inline-flex; gap: .5rem; align-items: center; font: 700 .76rem/1 ui-sans-serif, system-ui, sans-serif; }
    .language [aria-current="page"] { color: var(--seal); }
    .status { display: inline-flex; align-items: center; gap: .42rem; padding: .23rem .52rem; border: 1px solid currentColor; border-radius: 999px; font: 720 .72rem/1.2 ui-sans-serif, system-ui, sans-serif; white-space: nowrap; }
    .status__dot { width: .42rem; height: .42rem; border-radius: 50%; background: currentColor; }
    .status--good { color: var(--good); background: var(--good-soft); }
    .status--info { color: var(--info); background: var(--info-soft); }
    .status--warning { color: var(--warning); background: var(--warning-soft); }
    .status--danger { color: var(--danger); background: var(--danger-soft); }
    .status--quiet { color: var(--quiet); background: var(--quiet-soft); }
    .section { padding: 2.4rem 0; border-bottom: 1px solid var(--hairline-strong); }
    .section-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(14rem, .72fr); gap: 2rem; align-items: end; margin-bottom: 1.25rem; }
    .section-heading > p { margin: 0; color: var(--muted); font-size: .88rem; }
    .exchange-board { display: grid; grid-template-columns: minmax(0, 1fr) minmax(11rem, .38fr) minmax(0, 1fr); align-items: stretch; border: 1px solid var(--ink); background: var(--sheet); }
    .exchange-board--many { grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .exchange-board--many .exchange-party { order: 1; border: 0; border-right: 1px solid var(--hairline); }
    .exchange-board--many .pouch { order: 2; grid-column: 1 / -1; border-top: 1px solid var(--hairline); }
    .inbound-policy { display: flex; align-items: center; gap: .75rem; margin: 0 0 1rem; padding: .65rem .8rem; border: 1px solid var(--hairline); background: var(--paper-deep); }
    .inbound-policy p { margin: 0; }
    .inbound-policy[data-inbound-mode="open"] { border-color: var(--warning); background: var(--warning-soft); }
    .exchange-party { min-width: 0; padding: 1.3rem; }
    .exchange-party--claude { border-right: 1px solid var(--hairline); }
    .exchange-party--codex { border-left: 1px solid var(--hairline); }
    .party-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
    .party-heading p, .party-count { color: var(--muted); font-size: .82rem; }
    .party-count { margin: 1.8rem 0 .3rem; font-family: ui-sans-serif, system-ui, sans-serif; }
    .party-alias { margin: 0; font: 650 .85rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .next-action { margin: 1.15rem 0 0; padding-top: .85rem; border-top: 1px solid var(--hairline); color: var(--muted); font-size: .81rem; }
    .next-action strong { color: var(--ink); }
    .pouch { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 15rem; padding: 1rem; text-align: center; overflow: hidden; }
    .pouch__line { position: absolute; left: -10%; right: -10%; top: 50%; height: 1px; background: var(--hairline-strong); }
    .seal-mark { width: 3.7rem; height: 3.7rem; margin-bottom: .75rem; background: var(--paper); }
    .pouch p, .pouch strong, .pouch small { position: relative; z-index: 1; background: var(--sheet); }
    .pouch__title { margin: 0; padding: 0 .35rem; color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .1em; }
    .pouch strong { padding: .1rem .35rem; font: 720 .88rem/1.4 ui-sans-serif, system-ui, sans-serif; }
    .pouch small { padding: 0 .35rem; color: var(--muted); }
    .direction-key { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .25rem 1rem; padding-top: .55rem; color: var(--muted); font-size: .74rem; }
    .pair-graph { margin-top: 1.2rem; padding: 1rem; border: 1px solid var(--hairline); background: var(--sheet); }
    .pair-graph__heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .7rem 1rem; align-items: baseline; }
    .pair-graph__heading h3, .pair-graph p { margin-bottom: .55rem; }
    .pair-graph__heading strong, .pair-graph p { color: var(--muted); font: .78rem/1.45 ui-sans-serif, system-ui, sans-serif; }
    .pair-list { display: grid; gap: .45rem; margin: .8rem 0 0; padding: 0; list-style: none; }
    .pair-list li { display: flex; justify-content: space-between; gap: .8rem; align-items: center; padding-top: .45rem; border-top: 1px solid var(--hairline); overflow-wrap: anywhere; }
    .pair-list small { display: block; margin-top: .2rem; color: var(--muted); font-size: .8em; }
    .attention { border-bottom-color: var(--danger); }
    .attention-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--hairline); }
    .attention-projection-note { margin: 0; padding: 1rem; background: var(--warning-soft); }
    .attention-item { padding: 1.1rem 0; border-bottom: 1px solid var(--hairline); }
    .attention-item--danger { color: var(--danger); }
    .attention-item--warning { color: var(--warning); }
    .attention-item--info { color: var(--info); }
    .attention-item h3, .attention-item p { color: var(--ink); }
    .attention-item__meta { display: flex; flex-wrap: wrap; gap: .55rem; align-items: center; margin-bottom: .7rem; color: var(--muted); font-size: .75rem; }
    .scope { margin-bottom: 0; color: var(--muted) !important; font-size: .78rem; }
    .ledger-strip, .accounting { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
    .ledger-strip > div, .accounting > div { padding: .9rem 1rem; border-right: 1px solid var(--hairline); }
    .ledger-strip > div:last-child, .accounting > div:nth-child(3n) { border-right: 0; }
    dt { color: var(--muted); font: 700 .7rem/1.2 ui-sans-serif, system-ui, sans-serif; letter-spacing: .07em; text-transform: uppercase; }
    dd { margin: .25rem 0 0; font-size: 1.45rem; font-variant-numeric: tabular-nums; }
    .table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--hairline); background: var(--sheet); }
    table { width: 100%; border-collapse: collapse; font: .79rem/1.4 ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
    caption { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    th, td { padding: .68rem .75rem; border-bottom: 1px solid var(--hairline); text-align: left; vertical-align: top; white-space: nowrap; }
    thead th { color: var(--muted); background: var(--paper-deep); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; }
    tbody tr:last-child > * { border-bottom: 0; }
    tbody th { font-weight: 720; }
    code { font: .76rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .route-cell { white-space: normal; min-width: 16rem; }
    .route-cell span, .cell-note, .cell-code { display: block; margin-top: .2rem; color: var(--muted); font-size: .72rem; white-space: normal; }
    .numeric { text-align: right; }
    .history summary, .diagnostics summary { cursor: pointer; }
    .history ol { min-width: 22rem; margin: .55rem 0 0; padding-left: 1.1rem; }
    .history li { margin: .3rem 0; }
    .history .status { margin: 0 .4rem; }
    .empty-row td { padding: 1.2rem; color: var(--muted); text-align: center; }
    .register-grid { display: grid; gap: 1.4rem; }
    .register-grid > section { min-width: 0; }
    .register-grid h3, .diagnostics__body h3 { margin: 0 0 .55rem; }
    .diagnostics { padding-bottom: 0; }
    .diagnostics > summary { list-style: none; padding-bottom: 2rem; }
    .diagnostics > summary::-webkit-details-marker { display: none; }
    .diagnostics > summary h2 { display: flex; align-items: center; gap: .4rem; margin: 0; font-size: 1.05rem; }
    .disclosure-icon { display: inline-grid; width: 1.5rem; color: var(--seal); }
    .disclosure-icon > span { grid-area: 1 / 1; }
    .disclosure-icon__open { visibility: hidden; }
    .diagnostics[open] .disclosure-icon__closed { visibility: hidden; }
    .diagnostics[open] .disclosure-icon__open { visibility: visible; }
    .diagnostics__body { display: grid; gap: 1.5rem; padding-bottom: 2.2rem; }
    .diagnostics__note { margin: 0; color: var(--muted); font-size: .8rem; }
    .accounting { grid-template-columns: repeat(6, 1fr); }
    .accounting > div { border-bottom: 0; }
    .accounting dd { font-size: 1.1rem; }
    .omissions { margin: 0; color: var(--muted); font-size: .8rem; }
    .quiet { color: var(--muted); }
    footer { padding-top: 1rem; color: var(--muted); font-size: .74rem; text-align: center; }
    @media (max-width: 860px) {
      .masthead, .section-heading { grid-template-columns: 1fr; gap: 1rem; }
      .masthead__meta { justify-items: start; max-width: none; text-align: left; }
      .exchange-board { grid-template-columns: 1fr; }
      .exchange-party--claude { border-right: 0; border-bottom: 1px solid var(--hairline); }
      .exchange-party--codex { border-left: 0; border-top: 1px solid var(--hairline); }
      .pouch { min-height: 10rem; }
      .direction-key { display: none; }
      .accounting { grid-template-columns: repeat(3, 1fr); }
      .accounting > div:nth-child(3) { border-right: 0; }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 1rem, 1240px); padding-top: .5rem; }
      .brand-row { align-items: flex-start; }
      .brand-mark { width: 3.3rem; height: 3.3rem; }
      .party-heading { flex-direction: column; }
      .ledger-strip { grid-template-columns: 1fr; }
      .ledger-strip > div { border-right: 0; border-bottom: 1px solid var(--hairline); }
      .ledger-strip > div:last-child { border-bottom: 0; }
      .responsive-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      .responsive-table, .responsive-table tbody, .responsive-table tr { display: block; width: 100%; }
      .responsive-table tbody tr:not(.empty-row) { padding: .5rem .7rem; border-bottom: 1px solid var(--hairline); }
      .responsive-table tbody th, .responsive-table tbody td { display: grid; grid-template-columns: minmax(6.7rem, .42fr) minmax(0, 1fr); gap: .55rem; padding: .3rem 0; border: 0; white-space: normal; text-align: left; }
      .responsive-table tbody th::before, .responsive-table tbody td::before { content: attr(data-label); color: var(--muted); font-size: .65rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
      .responsive-table .empty-row td { display: block; }
      .route-cell { min-width: 0; }
      .history ol { min-width: 0; }
      .accounting { grid-template-columns: repeat(2, 1fr); }
      .accounting > div, .accounting > div:nth-child(3n) { border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); }
      .accounting > div:nth-child(2n) { border-right: 0; }
    }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; --paper: #201e1a; --paper-deep: #2b2823; --sheet: #25221d; --ink: #eee7da; --muted: #b5ac9e; --hairline: #514a40; --hairline-strong: #776f62; --seal: #e06b55; --seal-soft: #452822; --good: #8bc5a7; --good-soft: #20362b; --info: #96bdcf; --info-soft: #24343b; --warning: #e2b26b; --warning-soft: #3d3020; --danger: #ef958c; --danger-soft: #412725; --quiet: #b5aca0; --quiet-soft: #34302a; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    @media (forced-colors: active) {
      .exchange-board, .table-wrap, .ledger-strip, .accounting, .status, .brand-mark, .seal-mark, .attention-item { border-color: CanvasText; }
      .status__dot, .brand-mark span, .seal-mark span { background: CanvasText; }
      a:focus-visible, summary:focus-visible, .table-wrap:focus-visible { outline-color: Highlight; }
    }
    @media print { body { background: white; } }
`;

export function renderGatewayDashboard(
  snapshot: GatewayPublicSnapshot,
  options: DashboardRenderOptions = {},
): string {
  const locale = normalizeDashboardLocale(options.locale);
  const context: RenderContext = {
    locale,
    copy: getDashboardCopy(locale),
    model: buildDashboardViewModel(snapshot),
  };
  const languageFile = locale === "en" ? DASHBOARD_FILE_NAME : DASHBOARD_ZH_CN_FILE_NAME;
  const generatedAt = context.model.generatedAt === undefined
    ? t(context, "time.unavailable")
    : `<time datetime="${context.model.generatedAt}">${escapeDashboardHtml(context.model.generatedAt.slice(0, 19).replace("T", " "))} UTC</time>`;
  const html = `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light dark">
  <title>${t(context, "meta.title")}</title>
  <style>${DASHBOARD_STYLES}</style>
</head>
<body data-dashboard-locale="${locale}" data-dashboard-file="${languageFile}">
  <a class="skip-link" href="#main">${t(context, "skip")}</a>
  <main id="main">
    <header class="masthead">
      <div class="brand-row"><div class="brand-mark" aria-hidden="true"><span></span></div><div><p class="eyebrow">${t(context, "brand.eyebrow")}</p><h1>${t(context, "brand.title")}</h1><p class="subtitle">${t(context, "brand.subtitle")}</p></div></div>
      <div class="masthead__meta">${languageNavigation(context)}${statusPill(overallLabel(context), toneForOverall(context.model.overall))}<p><strong>${t(context, "snapshot.asOf", { time: "" })}</strong>${generatedAt}<br>${t(context, "snapshot.static")}</p></div>
    </header>
    ${renderExchange(context)}
    ${renderAttention(context)}
    ${renderTransit(context)}
    ${renderProgressWatches(context)}
    ${renderActivity(context)}
    ${renderSessions(context)}
    ${renderDiagnostics(context)}
    <footer>${t(context, "footer")}</footer>
  </main>
</body>
</html>
`;
  if (Buffer.byteLength(html, "utf8") > DASHBOARD_MAX_HTML_BYTES) {
    throw new Error("DASHBOARD_SNAPSHOT_TOO_LARGE");
  }
  return html;
}

export const renderDashboardHtml = renderGatewayDashboard;

async function validatePrivateStateDirectory(
  stateDirectory: string,
): Promise<string> {
  const resolved = path.resolve(stateDirectory);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("DASHBOARD_STATE_DIRECTORY_UNSAFE");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error("DASHBOARD_STATE_DIRECTORY_UNSAFE");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("DASHBOARD_STATE_DIRECTORY_UNSAFE");
  }
  if ((await realpath(resolved)) !== resolved) {
    throw new Error("DASHBOARD_STATE_DIRECTORY_UNSAFE");
  }
  return resolved;
}

async function validateExistingDashboard(outputPath: string): Promise<void> {
  try {
    const info = await lstat(outputPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("DASHBOARD_TARGET_UNSAFE");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("DASHBOARD_TARGET_UNSAFE");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

type PendingDashboardArtifact = {
  outputPath: string;
  temporaryPath: string;
  html: string;
  handle?: FileHandle | undefined;
};

export async function publishGatewayDashboard(
  stateDirectory: string,
  snapshot: GatewayPublicSnapshot,
  _options: DashboardRenderOptions = {},
): Promise<string> {
  const directory = await validatePrivateStateDirectory(stateDirectory);
  const artifacts: PendingDashboardArtifact[] = [
    {
      outputPath: path.join(directory, DASHBOARD_FILE_NAME),
      temporaryPath: path.join(
        directory,
        `.${DASHBOARD_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
      ),
      html: renderGatewayDashboard(snapshot, { locale: "en" }),
    },
    {
      outputPath: path.join(directory, DASHBOARD_ZH_CN_FILE_NAME),
      temporaryPath: path.join(
        directory,
        `.${DASHBOARD_ZH_CN_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
      ),
      html: renderGatewayDashboard(snapshot, { locale: "zh-CN" }),
    },
  ];
  for (const artifact of artifacts) {
    await validateExistingDashboard(artifact.outputPath);
  }
  try {
    for (const artifact of artifacts) {
      artifact.handle = await open(artifact.temporaryPath, "wx", 0o600);
      await artifact.handle.writeFile(artifact.html, "utf8");
      await artifact.handle.chmod(0o600);
      await artifact.handle.sync();
      await artifact.handle.close();
      artifact.handle = undefined;
    }
    for (const artifact of artifacts) {
      await rename(artifact.temporaryPath, artifact.outputPath);
    }
    return artifacts[0]!.outputPath;
  } finally {
    for (const artifact of artifacts) {
      if (artifact.handle !== undefined) {
        await artifact.handle.close().catch(() => undefined);
      }
      await unlink(artifact.temporaryPath).catch(() => undefined);
    }
  }
}

export const writeDashboardSnapshot = publishGatewayDashboard;
