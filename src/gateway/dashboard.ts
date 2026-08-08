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
import { arePublicAvailablePeerSnapshots } from "./types.js";
import type {
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicAvailablePeerSnapshot,
  PublicConnectorSnapshot,
  PublicRouteSnapshot,
  SafeGatewayAlert,
} from "./types.js";

export type { GatewayPublicSnapshot } from "./types.js";
export type DashboardSnapshot = GatewayPublicSnapshot;

export const DASHBOARD_FILE_NAME = "gateway-dashboard.html";
export const DASHBOARD_DEFAULT_REFRESH_SECONDS = 15;
export const DASHBOARD_MESSAGE_LIMIT = 50;
export const DASHBOARD_MESSAGE_HISTORY_LIMIT = 60;
export const DASHBOARD_CONNECTOR_LIMIT = 16;
export const DASHBOARD_AVAILABLE_PEER_LIMIT = 64;
export const DASHBOARD_AVAILABLE_PEER_INPUT_LIMIT = 256;
export const DASHBOARD_ROUTE_LIMIT = 128;
export const DASHBOARD_ALERT_LIMIT = 32;
export const DASHBOARD_MAX_HTML_BYTES = 256 * 1024;

export type DashboardRenderOptions = {
  refreshSeconds?: number;
};

type Tone = "good" | "info" | "warn" | "bad" | "quiet";

type DashboardOmissions = {
  connectors: number;
  availablePeers: number;
  routes: number;
  messages: number;
  alerts: number;
};

type MessageGroup = {
  latest: NormalizedMessageEvent;
  events: readonly NormalizedMessageEvent[];
};

const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,47}$/;
const SAFE_PROTOCOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,47}$/;
const OPAQUE_SUFFIX_PATTERN = /^[a-f0-9]{6,12}$/i;
const COMMAND_ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;

export function escapeDashboardHtml(value: string): string {
  return value.replace(
    HTML_ESCAPE_PATTERN,
    (character) => HTML_ESCAPES[character] ?? "",
  );
}

function clampText(value: unknown, maximumCharacters: number): string {
  if (typeof value !== "string") return "unknown";
  const characters = Array.from(value);
  if (characters.length <= maximumCharacters) return value;
  return `${characters.slice(0, maximumCharacters - 1).join("")}\u2026`;
}

function publicLabel(value: unknown): string {
  return escapeDashboardHtml(clampText(value, 80));
}

function safeProtocol(value: unknown): string {
  if (typeof value !== "string" || !SAFE_PROTOCOL_PATTERN.test(value)) {
    return "unknown";
  }
  return value;
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_CODE_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function normalizedInteger(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return undefined;
  }
  return value;
}

function formatInteger(value: unknown): string {
  const integer = normalizedInteger(value);
  if (integer === undefined) return "\u2014";
  return String(integer).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDuration(value: unknown): string {
  const milliseconds = normalizedInteger(value);
  if (milliseconds === undefined) return "\u2014";
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

function formatBytes(value: unknown): string {
  const bytes = normalizedInteger(value);
  if (bytes === undefined) return "\u2014";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) {
    const kibibytes = bytes / 1_024;
    return `${kibibytes < 10 ? kibibytes.toFixed(1) : Math.round(kibibytes)} KiB`;
  }
  const mebibytes = bytes / 1_048_576;
  return `${mebibytes < 10 ? mebibytes.toFixed(1) : Math.round(mebibytes)} MiB`;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function renderTimestamp(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === undefined) return '<span class="quiet">\u2014</span>';
  const label = `${timestamp.slice(0, 19).replace("T", " ")} UTC`;
  return `<time datetime="${timestamp}" title="${timestamp}">${label}</time>`;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderTimestampAtSnapshot(
  value: unknown,
  generatedAt: unknown,
): string {
  const timestamp = normalizeTimestamp(value);
  const reference = normalizeTimestamp(generatedAt);
  if (timestamp === undefined) return '<span class="quiet">\u2014</span>';
  if (reference === undefined) return renderTimestamp(timestamp);
  const difference = Date.parse(reference) - Date.parse(timestamp);
  const label =
    Math.abs(difference) < 1_000
      ? "At snapshot"
      : difference > 0
        ? `${formatAge(difference)} before snapshot`
        : `${formatAge(-difference)} after snapshot`;
  return `<time datetime="${timestamp}" title="${timestamp}">${label}</time>`;
}

function renderClockTimestamp(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === undefined) return '<span class="quiet">\u2014</span>';
  return `<time datetime="${timestamp}" title="${timestamp}">${timestamp.slice(11, 19)} UTC</time>`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function statusPill(label: string, tone: Tone): string {
  return `<span class="status status--${tone}"><span class="status__dot" aria-hidden="true"></span>${label}</span>`;
}

function healthPresentation(value: unknown): { label: string; tone: Tone } {
  switch (value) {
    case "healthy":
      return { label: "Healthy", tone: "good" };
    case "degraded":
      return { label: "Degraded", tone: "warn" };
    case "connecting":
      return { label: "Connecting", tone: "info" };
    case "incompatible":
      return { label: "Incompatible", tone: "bad" };
    case "offline":
      return { label: "Offline", tone: "bad" };
    default:
      return { label: "Unknown", tone: "quiet" };
  }
}

function connectorHealthPresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  return healthPresentation(value);
}

function agentStatusPresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  switch (value) {
    case "idle":
      return { label: "Idle", tone: "good" };
    case "busy":
      return { label: "Busy", tone: "info" };
    case "awaiting_approval":
      return { label: "Awaiting approval", tone: "warn" };
    case "offline":
      return { label: "Offline", tone: "bad" };
    case "stale":
      return { label: "Stale", tone: "bad" };
    case "incompatible":
      return { label: "Incompatible", tone: "bad" };
    case "disabled":
      return { label: "Disabled", tone: "quiet" };
    default:
      return { label: "Unknown", tone: "quiet" };
  }
}

function routeStatePresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  switch (value) {
    case "idle":
      return { label: "Idle", tone: "good" };
    case "busy":
      return { label: "Busy", tone: "info" };
    case "awaiting_approval":
      return { label: "Awaiting approval", tone: "warn" };
    case "stale":
      return { label: "Stale", tone: "bad" };
    case "offline":
      return { label: "Offline", tone: "bad" };
    case "incompatible":
      return { label: "Incompatible", tone: "bad" };
    case "disabled":
      return { label: "Disabled", tone: "quiet" };
    default:
      return { label: "Unknown", tone: "quiet" };
  }
}

function messageStatePresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  switch (value) {
    case "delivered":
      return { label: "Delivered", tone: "good" };
    case "queued":
    case "dispatching":
    case "transport_written":
      return {
        label:
          value === "queued"
            ? "Queued"
            : value === "dispatching"
              ? "Dispatching"
              : "Transport written",
        tone: "info",
      };
    case "held":
      return { label: "Held", tone: "warn" };
    case "ambiguous":
      return { label: "Ambiguous", tone: "warn" };
    case "duplicate":
      return { label: "Duplicate", tone: "quiet" };
    case "rejected":
    case "expired":
    case "cancelled":
    case "abandoned":
    case "failed":
      return {
        label:
          value === "rejected"
            ? "Rejected"
            : value === "expired"
              ? "Expired"
              : value === "cancelled"
                ? "Cancelled"
                : value === "abandoned"
                  ? "Abandoned"
                  : "Failed",
        tone: "bad",
      };
    default:
      return { label: "Unknown", tone: "quiet" };
  }
}

function providerLabel(value: unknown): string {
  if (value === "claude") return "Claude";
  if (value === "codex") return "Codex";
  return "Unknown";
}

function busyPolicyLabel(value: unknown): string {
  if (value === "queue") return "Queue when busy";
  return "Unknown";
}

function compatibilityPresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  switch (value) {
    case "compatible":
      return { label: "Compatible", tone: "good" };
    case "unknown":
      return { label: "Unknown", tone: "quiet" };
    case "expired":
      return { label: "Expired", tone: "warn" };
    case "incompatible":
      return { label: "Incompatible", tone: "bad" };
    default:
      return { label: "Unknown", tone: "quiet" };
  }
}

function alertSeverityPresentation(value: unknown): {
  label: string;
  tone: Tone;
} {
  if (value === "info") return { label: "Info", tone: "quiet" };
  if (value === "warning") return { label: "Warning", tone: "warn" };
  if (value === "error") return { label: "Error", tone: "bad" };
  return { label: "Unknown", tone: "quiet" };
}

function directionLabel(value: unknown): string {
  if (value === "claude_to_codex") return "Claude \u2192 Codex";
  if (value === "codex_to_claude") return "Codex \u2192 Claude";
  return "Unknown";
}

function shortOpaqueSuffix(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_SUFFIX_PATTERN.test(value)) {
    return "\u2014";
  }
  return value.toLowerCase();
}

function renderSafeCode(value: unknown): string {
  const code = safeCode(value);
  return code === undefined
    ? '<span class="quiet">\u2014</span>'
    : `<code>${code}</code>`;
}

function commandAlias(value: unknown): string {
  return typeof value === "string" && COMMAND_ALIAS_PATTERN.test(value)
    ? escapeDashboardHtml(value)
    : "&lt;alias&gt;";
}

function command(value: string): string {
  return `<code class="command">${value}</code>`;
}

function emptyRow(columns: number, label: string): string {
  return `<tr class="empty-row"><td colspan="${columns}" class="empty">${label}</td></tr>`;
}

function sortKey(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function renderConnectorProtocol(connector: PublicConnectorSnapshot): string {
  const protocol = safeProtocol(connector.protocol);
  const version = safeProtocol(connector.protocolVersion);
  return `<code>${protocol} ${version}</code>`;
}

function renderConnectors(
  connectors: readonly PublicConnectorSnapshot[],
  generatedAt: unknown,
): string {
  const visible = [...connectors]
    .sort((left, right) => {
      const byHost = compareText(sortKey(left.host), sortKey(right.host));
      return byHost === 0
        ? compareText(sortKey(left.provider), sortKey(right.provider))
        : byHost;
    })
    .slice(0, DASHBOARD_CONNECTOR_LIMIT);
  if (visible.length === 0) return emptyRow(7, "No host connectors registered.");
  return visible
    .map((connector) => {
      const health = connectorHealthPresentation(connector.health);
      const compatibility = compatibilityPresentation(connector.compatibility);
      return `<tr>
        <th scope="row" data-label="Host">${publicLabel(connector.host)}</th>
        <td data-label="Provider">${providerLabel(connector.provider)}</td>
        <td data-label="Health">${statusPill(health.label, health.tone)}</td>
        <td data-label="Compatibility">${statusPill(compatibility.label, compatibility.tone)}</td>
        <td data-label="Protocol">${renderConnectorProtocol(connector)}</td>
        <td data-label="Observed">${renderTimestampAtSnapshot(connector.lastSeenAt, generatedAt)}</td>
        <td data-label="Code">${renderSafeCode(connector.safeErrorCode)}</td>
      </tr>`;
    })
    .join("\n");
}

function availableClaudePeers(
  value: unknown,
): readonly PublicAvailablePeerSnapshot[] {
  return arePublicAvailablePeerSnapshots(
    value,
    DASHBOARD_AVAILABLE_PEER_INPUT_LIMIT,
  )
    ? value
    : [];
}

function renderAvailablePeers(
  peers: readonly PublicAvailablePeerSnapshot[],
  generatedAt: unknown,
  showObserved: boolean,
): string {
  const visible = [...peers]
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      return compareText(sortKey(left.alias), sortKey(right.alias));
    })
    .slice(0, DASHBOARD_AVAILABLE_PEER_LIMIT);
  const columns = showObserved ? 7 : 6;
  if (visible.length === 0) {
    return emptyRow(
      columns,
      "No Claude sessions are currently visible to Embassy.",
    );
  }
  return visible
    .map((peer) => {
      const state = agentStatusPresentation(peer.state);
      const compatibility = compatibilityPresentation(peer.compatibility);
      const selection = peer.selected
        ? statusPill("Selected", "good")
        : statusPill("Available", "quiet");
      const issue =
        peer.safeErrorCode === "PEER_ALIAS_COLLISION"
          ? `${renderSafeCode(peer.safeErrorCode)}<span class="cell-note">Rename one Claude session, refresh, then select the unique alias.</span>`
          : renderSafeCode(peer.safeErrorCode);
      return `<tr>
        <th scope="row" data-label="Alias" class="alias">${publicLabel(peer.alias)}</th>
        <td data-label="Host">${publicLabel(peer.host)}</td>
        <td data-label="State">${statusPill(state.label, state.tone)}</td>
        <td data-label="Compatibility">${statusPill(compatibility.label, compatibility.tone)}</td>
        <td data-label="Selection">${selection}</td>
        ${showObserved ? `<td data-label="Observed">${renderTimestampAtSnapshot(peer.lastSeenAt, generatedAt)}</td>` : ""}
        <td data-label="Issue">${issue}</td>
      </tr>`;
    })
    .join("\n");
}

function isRouteReady(route: PublicRouteSnapshot): boolean {
  return (
    route.enabled &&
    route.compatibility === "compatible" &&
    (route.state === "idle" || route.state === "busy")
  );
}

function routePriority(route: PublicRouteSnapshot): number {
  if (!route.enabled || route.state === "offline" || route.state === "incompatible") {
    return 0;
  }
  if (route.state === "stale" || route.compatibility !== "compatible") return 1;
  if (route.state === "awaiting_approval") return 2;
  if (route.state === "busy") return 3;
  return 4;
}

function sortRoutes(routes: readonly PublicRouteSnapshot[]): PublicRouteSnapshot[] {
  return [...routes].sort((left, right) => {
    const byPriority = routePriority(left) - routePriority(right);
    return byPriority === 0
      ? compareText(sortKey(left.alias), sortKey(right.alias))
      : byPriority;
  });
}

function routeRepairHint(route: PublicRouteSnapshot): string {
  if (isRouteReady(route)) return "";
  const alias = commandAlias(route.alias);
  if (route.provider === "codex") {
    return `<p class="route__action"><strong>Next:</strong> run ${command(`embassy register-codex --alias ${alias}`)} inside that exact Codex task.</p>`;
  }
  return `<p class="route__action"><strong>Next:</strong> run ${command("embassy refresh-dashboard")}, then ${command(`embassy select-claude --alias ${alias}`)}.</p>`;
}

function renderRouteList(
  routes: readonly PublicRouteSnapshot[],
  generatedAt: unknown,
): string {
  return `<ul class="route-list">${routes
    .map((route) => {
      const state = routeStatePresentation(
        route.enabled ? route.state : "disabled",
      );
      const compatibility = compatibilityPresentation(route.compatibility);
      const depth = normalizedInteger(route.queueDepth) ?? 0;
      return `<li class="route ${isRouteReady(route) ? "route--ready" : "route--attention"}">
        <div class="route__main">
          <strong class="alias">${publicLabel(route.alias)}</strong>
          <span class="route__meta">${publicLabel(route.host)} \u00b7 observed ${renderTimestampAtSnapshot(route.lastSeenAt, generatedAt)}</span>
        </div>
        <div class="route__status">${statusPill(state.label, state.tone)} ${statusPill(compatibility.label, compatibility.tone)}</div>
        <div class="route__queue"><span>${busyPolicyLabel(route.busyPolicy)}</span><strong>${depth === 0 ? "Queue empty" : `${formatInteger(depth)} queued`}</strong></div>
        ${route.safeErrorCode === undefined ? "" : `<div class="route__code">${renderSafeCode(route.safeErrorCode)}</div>`}
        ${routeRepairHint(route)}
      </li>`;
    })
    .join("\n")}</ul>`;
}

function renderDirectionCard(
  provider: "claude" | "codex",
  allRoutes: readonly PublicRouteSnapshot[],
  visibleRoutes: readonly PublicRouteSnapshot[],
  peers: readonly PublicAvailablePeerSnapshot[],
  generatedAt: unknown,
): string {
  const ready = allRoutes.filter(isRouteReady).length;
  const needsAttention = allRoutes.length - ready;
  const cardTone: Tone =
    needsAttention > 0 ? "warn" : ready > 0 ? "good" : "info";
  const cardStatus =
    needsAttention > 0
      ? `${formatInteger(needsAttention)} need attention`
      : ready > 0
        ? `${formatInteger(ready)} ready`
        : provider === "claude"
          ? "Not selected"
          : "No targets";

  if (provider === "claude") {
    const selectedPeers = peers.filter((peer) => peer.selected).length;
    const selectedRouteCount = Math.max(selectedPeers, ready);
    const compatiblePeers = peers.filter(
      (peer) =>
        peer.compatibility === "compatible" && peer.state !== "incompatible",
    );
    let content: string;
    if (visibleRoutes.length > 0) {
      content = renderRouteList(visibleRoutes, generatedAt);
    } else if (peers.length > 0 && compatiblePeers.length === 0) {
      content = `<div class="empty-state"><h3>Claude sessions need a compatible version.</h3><p>Use the supported Claude Code and Embassy pairing, restart ${command("embassy serve")}, then refresh this snapshot.</p></div>`;
    } else if (compatiblePeers.length > 0) {
      content = `<div class="empty-state"><h3>No Claude session is selected.</h3><p>${formatInteger(compatiblePeers.length)} compatible ${compatiblePeers.length === 1 ? "session is" : "sessions are"} available. Selection is always explicit.</p><p class="empty-state__action">Run ${command("embassy select-claude --alias &lt;alias&gt;")}.</p></div>`;
    } else {
      content = `<div class="empty-state"><h3>No Claude sessions discovered.</h3><p>Keep Claude Code running with its native <code>crossSessionInbound</code> setting enabled, then run ${command("embassy refresh-dashboard")}.</p></div>`;
    }
    return `<section class="direction-card" aria-labelledby="codex-to-claude-heading">
      <div class="direction-card__heading">
        <div><p class="direction-card__eyebrow">Codex \u2192 Claude</p><h2 id="codex-to-claude-heading">Selected Claude destination</h2></div>
        ${statusPill(cardStatus, cardTone)}
      </div>
      <p class="direction-card__note">Codex can send only to a Claude session you selected explicitly.</p>
      <p class="direction-card__count">${peers.length === 0 ? `<strong>${formatInteger(selectedRouteCount)}</strong> selected routes; no Claude sessions discovered in this snapshot` : `<strong>${formatInteger(selectedRouteCount)}</strong> of <strong>${formatInteger(peers.length)}</strong> discovered sessions selected`}${needsAttention > 0 ? `; ${formatInteger(needsAttention)} route ${needsAttention === 1 ? "needs" : "need"} attention` : ""}.</p>
      ${content}
    </section>`;
  }

  const content =
    visibleRoutes.length > 0
      ? renderRouteList(visibleRoutes, generatedAt)
      : `<div class="empty-state"><h3>No Codex tasks registered.</h3><p>Inside the Codex task you want Claude to reach, run:</p><p class="empty-state__action">${command("embassy register-codex --alias &lt;name&gt;@&lt;host&gt;")}</p></div>`;
  return `<section class="direction-card" aria-labelledby="claude-to-codex-heading">
    <div class="direction-card__heading">
      <div><p class="direction-card__eyebrow">Claude \u2192 Codex</p><h2 id="claude-to-codex-heading">Registered Codex targets</h2></div>
      ${statusPill(cardStatus, cardTone)}
    </div>
    <p class="direction-card__note">Every live Claude session can see each registered Codex target.</p>
    <p class="direction-card__count"><strong>${formatInteger(ready)}</strong> of <strong>${formatInteger(allRoutes.length)}</strong> targets ready${needsAttention > 0 ? `; ${formatInteger(needsAttention)} ${needsAttention === 1 ? "needs" : "need"} attention` : ""}.</p>
    ${content}
  </section>`;
}

function compareMessages(
  left: NormalizedMessageEvent,
  right: NormalizedMessageEvent,
): number {
  const leftTimestamp = normalizeTimestamp(left.timestamp) ?? "";
  const rightTimestamp = normalizeTimestamp(right.timestamp) ?? "";
  const byTimestamp = compareText(rightTimestamp, leftTimestamp);
  if (byTimestamp !== 0) return byTimestamp;
  const byFrom = compareText(
    sortKey(left.sourceAlias),
    sortKey(right.sourceAlias),
  );
  if (byFrom !== 0) return byFrom;
  const byTo = compareText(
    sortKey(left.targetAlias),
    sortKey(right.targetAlias),
  );
  if (byTo !== 0) return byTo;
  const bySuffix = compareText(
    sortKey(left.messageIdSuffix),
    sortKey(right.messageIdSuffix),
  );
  if (bySuffix !== 0) return bySuffix;
  return (normalizedInteger(right.sequence) ?? 0) -
    (normalizedInteger(left.sequence) ?? 0);
}

function messageGroupKey(message: NormalizedMessageEvent): string {
  return [
    sortKey(message.direction),
    sortKey(message.sourceAlias),
    sortKey(message.targetAlias),
    sortKey(message.messageIdSuffix),
  ].join("\0");
}

function compareMessageEventsAscending(
  left: NormalizedMessageEvent,
  right: NormalizedMessageEvent,
): number {
  const leftTimestamp = normalizeTimestamp(left.timestamp) ?? "";
  const rightTimestamp = normalizeTimestamp(right.timestamp) ?? "";
  const byTimestamp = compareText(leftTimestamp, rightTimestamp);
  if (byTimestamp !== 0) return byTimestamp;
  return (normalizedInteger(left.sequence) ?? 0) -
    (normalizedInteger(right.sequence) ?? 0);
}

function groupMessages(
  messages: readonly NormalizedMessageEvent[],
): MessageGroup[] {
  const grouped = new Map<string, NormalizedMessageEvent[]>();
  for (const message of messages) {
    const key = messageGroupKey(message);
    const events = grouped.get(key);
    if (events === undefined) grouped.set(key, [message]);
    else events.push(message);
  }
  return [...grouped.values()]
    .map((events) => {
      const ordered = [...events].sort(compareMessageEventsAscending);
      return { latest: ordered[ordered.length - 1]!, events: ordered };
    })
    .sort((left, right) => compareMessages(left.latest, right.latest));
}

function renderMessageHistory(
  events: readonly NormalizedMessageEvent[],
  remainingBudget: number,
): { html: string; used: number } {
  if (events.length <= 1) {
    return { html: '<span class="quiet">1 stage</span>', used: 0 };
  }
  const allowance = Math.min(6, remainingBudget, events.length);
  if (allowance === 0) {
    return {
      html: `<span class="quiet">${formatInteger(events.length)} stages; history omitted by display bound</span>`,
      used: 0,
    };
  }
  const visible =
    events.length <= allowance
      ? [...events]
      : allowance === 1
        ? [events[events.length - 1]!]
        : [events[0]!, ...events.slice(-(allowance - 1))];
  const omitted = events.length - visible.length;
  const items = visible
    .map((event) => {
      const state = messageStatePresentation(event.state);
      return `<li data-dashboard-row="message-event"><span>${renderClockTimestamp(event.timestamp)}</span>${statusPill(state.label, state.tone)}<span>${formatDuration(event.latencyMs)}</span>${event.safeErrorCode === undefined ? "" : renderSafeCode(event.safeErrorCode)}</li>`;
    })
    .join("\n");
  return {
    html: `<details class="message-history"><summary>${formatInteger(events.length)} stages${omitted > 0 ? `; showing ${formatInteger(visible.length)}` : ""}</summary><ol>${items}</ol></details>`,
    used: visible.length,
  };
}

function renderMessages(
  groups: readonly MessageGroup[],
  generatedAt: unknown,
): string {
  if (groups.length === 0) {
    return emptyRow(
      7,
      "No delivery metadata yet. Send a message after both directions are ready.",
    );
  }
  let historyBudget = DASHBOARD_MESSAGE_HISTORY_LIMIT;
  return groups
    .map((group) => {
      const message = group.latest;
      const state = messageStatePresentation(message.state);
      const history = renderMessageHistory(group.events, historyBudget);
      historyBudget -= history.used;
      return `<tr data-dashboard-row="message-summary">
        <td data-label="Updated">${renderTimestampAtSnapshot(message.timestamp, generatedAt)}</td>
        <td data-label="Route" class="message-route"><strong>${directionLabel(message.direction)}</strong><span class="alias">${publicLabel(message.sourceAlias)} \u2192 ${publicLabel(message.targetAlias)}</span></td>
        <td data-label="ID"><code>\u2026${shortOpaqueSuffix(message.messageIdSuffix)}</code></td>
        <td data-label="Result">${statusPill(state.label, state.tone)}${message.safeErrorCode === undefined ? "" : `<span class="cell-note">${renderSafeCode(message.safeErrorCode)}</span>`}</td>
        <td data-label="Elapsed" class="numeric">${formatDuration(message.latencyMs)}</td>
        <td data-label="Size" class="numeric">${formatBytes(message.bytes)}</td>
        <td data-label="History">${history.html}</td>
      </tr>`;
    })
    .join("\n");
}

function compareAlerts(left: SafeGatewayAlert, right: SafeGatewayAlert): number {
  const severityRank = (value: unknown): number =>
    value === "error" ? 0 : value === "warning" ? 1 : 2;
  const bySeverity = severityRank(left.severity) - severityRank(right.severity);
  if (bySeverity !== 0) return bySeverity;
  const leftTimestamp = normalizeTimestamp(left.timestamp) ?? "";
  const rightTimestamp = normalizeTimestamp(right.timestamp) ?? "";
  const byTimestamp = compareText(rightTimestamp, leftTimestamp);
  if (byTimestamp !== 0) return byTimestamp;
  return compareText(sortKey(left.code), sortKey(right.code));
}

function alertGuidance(alert: SafeGatewayAlert): {
  title: string;
  description: string;
  action: string;
} {
  const alias = commandAlias(alert.alias);
  switch (safeCode(alert.code)) {
    case "REOBSERVATION_REQUIRED":
      return alert.provider === "claude"
        ? {
            title: "Claude selection must be observed again",
            description:
              "Embassy restarted and discarded the old endpoint proof for this route.",
            action: `Run ${command("embassy refresh-dashboard")}; if the session appears, run ${command(`embassy select-claude --alias ${alias}`)}.`,
          }
        : {
            title: "Codex registration must be observed again",
            description:
              "Embassy restarted and discarded the old endpoint proof for this route.",
            action: `Run inside that exact Codex task: ${command(`embassy register-codex --alias ${alias}`)}.`,
          };
    case "PEER_NOT_OBSERVED":
    case "CLAUDE_PEER_NOT_OBSERVED":
      return {
        title: "Selected Claude session is no longer visible",
        description:
          "The previously selected session is not present in current local discovery.",
        action: `Keep Claude Code running with <code>crossSessionInbound</code> enabled, run ${command("embassy refresh-dashboard")}, then select the current alias explicitly.`,
      };
    case "CODEX_POLICY_MONITOR_ONLY":
      return {
        title: "Codex task is monitor-only",
        description:
          "The task is visible, but its effective native policy is not eligible for inbound turns.",
        action: `Use native Codex controls to set <code>approvalPolicy: never</code>, sandbox <code>readOnly</code>, and network access off; then re-run ${command(`embassy register-codex --alias ${alias}`)} inside that task.`,
      };
    case "CODEX_WORKSPACE_UNATTESTED":
      return {
        title: "Codex workspace attestation needs renewal",
        description:
          "Embassy could not re-establish the exact task and workspace proof required for writes.",
        action: `Confirm <code>EMBASSY_STATE_DIR</code> is outside the task workspace, then re-run ${command(`embassy register-codex --alias ${alias}`)} inside that task.`,
      };
    case "CODEX_ROUTE_STALE":
      return {
        title: "Codex route is stale",
        description:
          "The Codex App Server connection for this registered task is no longer ready.",
        action: `Inside that task, run ${command(`embassy unregister-codex --alias ${alias}`)} and then ${command(`embassy register-codex --alias ${alias}`)}.`,
      };
    case "CODEX_MONITOR_ONLY":
    case "CODEX_WRITES_DISABLED":
      return {
        title: "Codex write compatibility is unavailable",
        description:
          "The pinned write-compatibility gate was not established; only observation is available.",
        action: `Do not send. Use the supported Codex App Server and Embassy pairing, then restart ${command("embassy serve")}.`,
      };
    case "CONNECTOR_OFFLINE":
      return {
        title: "Provider connector is offline",
        description: "Embassy cannot currently reach this local provider connector.",
        action: `Ensure the provider application is running, then restart ${command("embassy serve")}.`,
      };
    case "ROUTE_STALE":
      return {
        title: "Route is stale",
        description: "This route no longer has a current local endpoint proof.",
        action:
          alert.provider === "claude"
            ? `Run ${command("embassy refresh-dashboard")}, then explicitly select the current Claude alias.`
            : `Re-run ${command(`embassy register-codex --alias ${alias}`)} inside that exact Codex task.`,
      };
    case "ADAPTER_DEGRADED":
    case "ROUTE_DEGRADED":
      return {
        title: "Provider route is degraded",
        description: "Embassy retained only a normalized compatibility warning.",
        action: `Run ${command("embassy status")}; if the warning persists, restart ${command("embassy serve")}.`,
      };
    default:
      return {
        title: "Embassy reported a normalized alert",
        description:
          "This safe code has no automatic repair mapped in the dashboard.",
        action: `Review the matching provider or route with ${command("embassy status")}. Do not retry an ambiguous delivery automatically.`,
      };
  }
}

function renderAlerts(
  alerts: readonly SafeGatewayAlert[],
  generatedAt: unknown,
  totalAlerts: number,
): string {
  if (alerts.length === 0) return "";
  return `<section class="alert-panel" aria-labelledby="alerts-heading">
    <div class="section-heading"><div><p class="section-heading__eyebrow">Attention</p><h2 id="alerts-heading">Action required</h2></div><span>${formatInteger(totalAlerts)} active</span></div>
    <ul class="alert-list">${alerts
      .map((alert) => {
        const severity = alertSeverityPresentation(alert.severity);
        const guidance = alertGuidance(alert);
        const scope = [
          alert.provider === undefined ? undefined : providerLabel(alert.provider),
          alert.alias === undefined ? undefined : publicLabel(alert.alias),
          alert.host === undefined ? undefined : publicLabel(alert.host),
        ].filter((value): value is string => value !== undefined);
        return `<li class="alert-card alert-card--${severity.tone}">
          <div class="alert-card__top"><span>${statusPill(severity.label, severity.tone)} ${renderSafeCode(alert.code)}</span><span>Observed ${renderTimestampAtSnapshot(alert.timestamp, generatedAt)}</span></div>
          <h3>${guidance.title}</h3>
          <p>${guidance.description}</p>
          <p class="alert-card__scope">${scope.length === 0 ? "Embassy" : scope.join(" \u00b7 ")}</p>
          <p class="alert-card__action"><strong>Next:</strong> ${guidance.action}</p>
        </li>`;
      })
      .join("\n")}</ul>
  </section>`;
}

function refreshSeconds(value: unknown): number | undefined {
  const integer = normalizedInteger(value);
  if (integer === undefined) return DASHBOARD_DEFAULT_REFRESH_SECONDS;
  if (integer === 0) return undefined;
  return Math.min(60, Math.max(2, integer));
}

function boundedSum(left: unknown, right: unknown): number | undefined {
  const normalizedLeft = normalizedInteger(left);
  const normalizedRight = normalizedInteger(right);
  if (normalizedLeft === undefined && normalizedRight === undefined) {
    return undefined;
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    (normalizedLeft ?? 0) + (normalizedRight ?? 0),
  );
}

function renderTruncationNotice(
  snapshot: GatewayPublicSnapshot,
  local: DashboardOmissions,
): string {
  const entries = [
    ["connectors", boundedSum(snapshot.truncation.connectors, local.connectors)],
    [
      "Claude sessions",
      boundedSum(snapshot.truncation.availablePeers, local.availablePeers),
    ],
    ["routes", boundedSum(snapshot.truncation.routes, local.routes)],
    [
      "delivery records",
      boundedSum(snapshot.truncation.messages, local.messages),
    ],
    ["alerts", boundedSum(snapshot.truncation.alerts, local.alerts)],
  ] as const;
  const omitted = entries
    .filter((entry) => (entry[1] ?? 0) > 0)
    .map(([label, count]) => `${formatInteger(count)} ${label}`);
  if (omitted.length === 0) return "";
  return `<p class="truncation-note" role="status"><strong>Bounded display:</strong> omitted ${omitted.join(", ")}.</p>`;
}

export function renderGatewayDashboard(
  snapshot: GatewayPublicSnapshot,
  options: DashboardRenderOptions = {},
): string {
  const refresh = refreshSeconds(options.refreshSeconds);
  const brokerHealth = healthPresentation(snapshot.health);
  const queuedMessages = snapshot.routes.reduce((sum, route) => {
    const depth = normalizedInteger(route.queueDepth) ?? 0;
    return Math.min(Number.MAX_SAFE_INTEGER, sum + depth);
  }, 0);
  const peers = availableClaudePeers(snapshot.availablePeers);
  const claudeRoutes = sortRoutes(
    snapshot.routes.filter((route) => route.provider === "claude"),
  );
  const codexRoutes = sortRoutes(
    snapshot.routes.filter((route) => route.provider === "codex"),
  );
  const routeLimitPerProvider = Math.floor(DASHBOARD_ROUTE_LIMIT / 2);
  const visibleClaudeRoutes = claudeRoutes.slice(0, routeLimitPerProvider);
  const visibleCodexRoutes = codexRoutes.slice(0, routeLimitPerProvider);
  const messageGroups = groupMessages(snapshot.messages);
  const visibleMessageGroups = messageGroups.slice(0, DASHBOARD_MESSAGE_LIMIT);
  const visibleAlerts = [...snapshot.alerts]
    .sort(compareAlerts)
    .slice(0, DASHBOARD_ALERT_LIMIT);
  const peerHasObservedTimestamp = peers.some(
    (peer) => normalizeTimestamp(peer.lastSeenAt) !== undefined,
  );
  const selectedClaude = Math.max(
    peers.filter((peer) => peer.selected).length,
    claudeRoutes.filter(isRouteReady).length,
  );
  const readyCodex = codexRoutes.filter(isRouteReady).length;
  const routesNeedingAttention = snapshot.routes.filter(
    (route) => !isRouteReady(route),
  ).length;
  const brokerNeedsAttention =
    snapshot.health === "offline" ||
    snapshot.health === "incompatible" ||
    snapshot.health === "degraded";
  const readiness = brokerNeedsAttention
    ? { label: "Broker needs attention", tone: "bad" as const }
    : snapshot.alerts.length > 0 || routesNeedingAttention > 0
      ? { label: "Attention needed", tone: "warn" as const }
      : selectedClaude > 0 && readyCodex > 0
        ? { label: "Ready in both directions", tone: "good" as const }
        : { label: "Setup incomplete", tone: "info" as const };
  const localOmissions: DashboardOmissions = {
    connectors: Math.max(0, snapshot.connectors.length - DASHBOARD_CONNECTOR_LIMIT),
    availablePeers: Math.max(0, peers.length - DASHBOARD_AVAILABLE_PEER_LIMIT),
    routes:
      Math.max(0, claudeRoutes.length - routeLimitPerProvider) +
      Math.max(0, codexRoutes.length - routeLimitPerProvider),
    messages: Math.max(0, messageGroups.length - DASHBOARD_MESSAGE_LIMIT),
    alerts: Math.max(0, snapshot.alerts.length - DASHBOARD_ALERT_LIMIT),
  };
  const generatedAt = renderTimestamp(snapshot.generatedAt);
  const refreshMeta =
    refresh === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${refresh}">`;
  const refreshNote =
    refresh === undefined
      ? "Automatic reload is paused. Reload this page to read the latest file."
      : `Auto-reloads this local file every ${refresh} seconds.`;
  const connectorNeedsAttention = snapshot.connectors.some(
    (connector) =>
      connector.health !== "healthy" ||
      connector.compatibility !== "compatible" ||
      connector.safeErrorCode !== undefined,
  );
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refreshMeta}
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light dark">
  <title>Embassy</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas: #f4f4f1;
      --surface: #ffffff;
      --surface-elevated: rgba(255, 255, 255, .94);
      --surface-soft: #f7f7f4;
      --ink: #1c2333;
      --muted: #667085;
      --line: #d9dde6;
      --accent: #584bc7;
      --accent-soft: #efedff;
      --seal: #9b651b;
      --seal-soft: #fff3dc;
      --good: #14734d;
      --good-soft: #e8f7ef;
      --info: #315c9f;
      --info-soft: #edf3ff;
      --warn: #8c5700;
      --warn-soft: #fff4dc;
      --bad: #b12b3b;
      --bad-soft: #fff0f2;
      --quiet-soft: #edf0f4;
      --hover: #fafaff;
      --shadow: 0 14px 40px rgba(23, 32, 51, 0.07);
    }
    * { box-sizing: border-box; }
    html { background: var(--canvas); }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, var(--accent-soft) 0, transparent 28rem),
        var(--canvas);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; }
    a.skip-link {
      position: fixed;
      left: 1rem;
      top: -5rem;
      z-index: 10;
      padding: .65rem .9rem;
      color: white;
      background: var(--ink);
      border-radius: .5rem;
    }
    a.skip-link:focus { top: 1rem; }
    :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
    main { width: min(1380px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 3rem; }
    .hero {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .eyebrow {
      margin: 0 0 .35rem;
      color: var(--accent);
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1; letter-spacing: -.055em; }
    h2, h3 { margin: 0; line-height: 1.25; }
    .subtitle { max-width: 52rem; margin: .65rem 0 0; color: var(--muted); font-size: 1rem; }
    .snapshot-card {
      flex: 0 0 min(26rem, 42%);
      padding: 1rem 1.1rem;
      background: var(--surface-elevated);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .snapshot-card > p { margin: .65rem 0 0; color: var(--muted); font-size: .8rem; }
    .snapshot-card strong { color: var(--ink); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: .85rem;
      margin: 0 0 1rem;
    }
    .metric, .panel, .direction-card, .alert-panel {
      background: var(--surface-elevated);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .metric { padding: 1rem 1.1rem; }
    .metric dt { margin-bottom: .3rem; color: var(--muted); font-size: .78rem; }
    .metric dd { margin: 0; font-size: 1.25rem; font-weight: 760; letter-spacing: -.02em; }
    .metric__detail { color: var(--muted); font-size: .78rem; font-weight: 500; letter-spacing: 0; }
    .truncation-note { margin: 0 0 1rem; padding: .75rem 1rem; color: var(--warn); background: var(--warn-soft); border: 1px solid currentColor; border-radius: 10px; }
    .section-heading, .panel__heading, .direction-card__heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
    }
    .section-heading { padding: 1rem 1.1rem; border-bottom: 1px solid var(--line); }
    .section-heading__eyebrow, .direction-card__eyebrow {
      margin: 0 0 .25rem;
      color: var(--accent);
      font-size: .68rem;
      font-weight: 800;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .alert-panel { margin: 1rem 0; overflow: hidden; }
    .alert-list, .route-list { margin: 0; padding: 0; list-style: none; }
    .alert-list { display: grid; gap: .75rem; padding: .9rem; }
    .alert-card { padding: .95rem 1rem; border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px; background: var(--surface); }
    .alert-card--bad { border-left-color: var(--bad); }
    .alert-card--warn { border-left-color: var(--warn); }
    .alert-card--info, .alert-card--quiet { border-left-color: var(--info); }
    .alert-card__top { display: flex; justify-content: space-between; gap: 1rem; color: var(--muted); font-size: .75rem; }
    .alert-card h3 { margin-top: .65rem; font-size: 1rem; }
    .alert-card p { margin: .35rem 0 0; }
    .alert-card__scope { color: var(--muted); font-size: .78rem; }
    .alert-card__action { padding-top: .45rem; border-top: 1px solid var(--line); }
    .directions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
    .direction-card { min-width: 0; padding: 1.05rem; }
    .direction-card h2 { font-size: 1.05rem; }
    .direction-card__note { min-height: 2.7rem; margin: .65rem 0 .35rem; color: var(--muted); }
    .direction-card__count { margin: 0 0 .85rem; font-size: .82rem; }
    .route-list { display: grid; gap: .65rem; }
    .route {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: .55rem 1rem;
      padding: .8rem;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-soft);
    }
    .route--attention { border-left: 4px solid var(--warn); }
    .route__main { min-width: 0; }
    .route__main strong, .route__meta { display: block; }
    .route__meta { margin-top: .15rem; color: var(--muted); font-size: .73rem; }
    .route__status { display: flex; align-items: flex-start; justify-content: flex-end; gap: .35rem; flex-wrap: wrap; }
    .route__queue { display: flex; gap: .55rem; color: var(--muted); font-size: .74rem; }
    .route__queue strong { color: var(--ink); }
    .route__code { text-align: right; }
    .route__action { grid-column: 1 / -1; margin: .1rem 0 0; padding-top: .55rem; border-top: 1px solid var(--line); font-size: .78rem; }
    .empty-state { padding: 1rem; border: 1px dashed var(--line); border-radius: 10px; background: var(--surface-soft); }
    .empty-state h3 { font-size: .95rem; }
    .empty-state p { margin: .35rem 0 0; color: var(--muted); }
    .empty-state__action { color: var(--ink) !important; }
    .panel { margin-top: 1rem; overflow: hidden; }
    .panel__heading {
      padding: .95rem 1.1rem;
      background: linear-gradient(180deg, var(--surface), var(--surface-soft));
      border-bottom: 1px solid var(--line);
    }
    .panel__heading h2 { font-size: 1rem; }
    summary.panel__heading { cursor: pointer; }
    summary.panel__heading .panel__title { font-size: 1rem; font-weight: 760; }
    .panel__note { margin: 0; color: var(--muted); font-size: .78rem; }
    .table-wrap { overflow-x: auto; scrollbar-gutter: stable; }
    .table-wrap:focus-visible, summary.panel__heading:focus-visible { outline-offset: -3px; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    caption { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
    th, td { padding: .72rem 1.1rem; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
    thead th {
      color: var(--muted);
      background: var(--surface-soft);
      font-size: .7rem;
      font-weight: 800;
      letter-spacing: .065em;
      text-transform: uppercase;
    }
    tbody th { font-weight: 720; }
    tbody tr:last-child > * { border-bottom: 0; }
    tbody tr:hover { background: var(--hover); }
    code { font: .82rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .command { overflow-wrap: anywhere; }
    .alias { overflow-wrap: anywhere; }
    .cell-note { display: block; margin-top: .25rem; color: var(--muted); font-size: .72rem; white-space: normal; }
    .message-route { min-width: 18rem; white-space: normal; }
    .message-route > span { display: block; margin-top: .2rem; color: var(--muted); font-size: .75rem; }
    .message-history { min-width: 7.5rem; }
    .message-history summary { cursor: pointer; color: var(--accent); font-weight: 700; }
    .message-history ol { display: grid; gap: .35rem; min-width: 25rem; margin: .65rem 0 0; padding-left: 1.2rem; }
    .message-history li { display: grid; grid-template-columns: 7rem auto 5rem minmax(0, 1fr); align-items: center; gap: .5rem; color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: .42rem;
      padding: .24rem .55rem;
      border-radius: 999px;
      font-size: .76rem;
      font-weight: 720;
    }
    .status__dot { width: .46rem; height: .46rem; border-radius: 50%; background: currentColor; }
    .status--good { color: var(--good); background: var(--good-soft); }
    .status--info { color: var(--info); background: var(--info-soft); }
    .status--warn { color: var(--warn); background: var(--warn-soft); }
    .status--bad { color: var(--bad); background: var(--bad-soft); }
    .status--quiet { color: var(--muted); background: var(--quiet-soft); }
    .numeric { text-align: right; }
    .quiet, .empty { color: var(--muted); }
    .empty { padding: 1.4rem 1.1rem; text-align: center; }
    footer { margin-top: 1.15rem; color: var(--muted); font-size: .75rem; text-align: center; }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas: #11131a;
        --surface: #191c25;
        --surface-elevated: rgba(25, 28, 37, .95);
        --surface-soft: #212530;
        --ink: #f3f4f7;
        --muted: #aab1c2;
        --line: #373c4b;
        --accent: #b9afff;
        --accent-soft: #292543;
        --seal: #e4b361;
        --seal-soft: #352a1c;
        --good: #7ad9ae;
        --good-soft: #18372b;
        --info: #9ebcff;
        --info-soft: #1d2d4a;
        --warn: #f1c06f;
        --warn-soft: #3a2c17;
        --bad: #ff9ba8;
        --bad-soft: #44232a;
        --quiet-soft: #292e3a;
        --hover: #222636;
        --shadow: 0 14px 42px rgba(0, 0, 0, .25);
      }
    }
    @media (max-width: 1100px) {
      .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .directions { grid-template-columns: 1fr; }
      .direction-card__note { min-height: 0; }
    }
    @media (max-width: 800px) {
      .hero { flex-direction: column; }
      .snapshot-card { width: 100%; flex-basis: auto; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .alert-card__top { flex-direction: column; gap: .35rem; }
    }
    @media (max-width: 640px) {
      main { width: min(100% - 1rem, 1380px); padding-top: 1rem; }
      .metric { padding: .8rem; }
      .metric dd { font-size: 1.05rem; }
      .section-heading, .panel__heading, .direction-card__heading { align-items: flex-start; flex-direction: column; gap: .35rem; }
      .route { display: block; }
      .route > * + * { margin-top: .55rem; }
      .route__status { justify-content: flex-start; }
      .route__code { text-align: left; }
      .responsive-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      .responsive-table, .responsive-table tbody, .responsive-table tr { display: block; width: 100%; }
      .responsive-table tbody tr:not(.empty-row) { padding: .6rem .85rem; border-bottom: 1px solid var(--line); }
      .responsive-table tbody tr:last-child { border-bottom: 0; }
      .responsive-table tbody th, .responsive-table tbody td {
        display: grid;
        grid-template-columns: minmax(6.5rem, .42fr) minmax(0, 1fr);
        gap: .65rem;
        align-items: start;
        padding: .35rem 0;
        border: 0;
        white-space: normal;
        text-align: left;
      }
      .responsive-table tbody th::before, .responsive-table tbody td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: .68rem;
        font-weight: 800;
        letter-spacing: .05em;
        text-transform: uppercase;
      }
      .responsive-table .empty-row td { display: block; padding: 1rem; }
      .message-route { min-width: 0; }
      .message-history ol { min-width: 0; padding-left: 1rem; }
      .message-history li { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
    @media (forced-colors: active) {
      .metric, .panel, .direction-card, .alert-panel, .route, .alert-card, .empty-state, .status { border: 1px solid CanvasText; }
      .status__dot { background: CanvasText; }
      :focus-visible { outline-color: Highlight; }
    }
    @media print { body { background: white; } .metric, .panel, .direction-card, .alert-panel { box-shadow: none; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to Embassy status</a>
  <main id="main">
    <header class="hero">
      <div>
        <p class="eyebrow">Local agent gateway</p>
        <h1>Embassy</h1>
        <p class="subtitle">A metadata-only snapshot of consent-gated routes between Claude Code and Codex. Message content and internal provider IDs are omitted.</p>
      </div>
      <div class="snapshot-card">
        ${statusPill(readiness.label, readiness.tone)}
        <p><strong>Snapshot generated ${generatedAt}.</strong><br>${refreshNote}<br>Status is accurate at snapshot time; this static file is not a live connectivity check.</p>
      </div>
    </header>

    <dl class="metrics" aria-label="Embassy summary">
      <div class="metric"><dt>Broker at snapshot</dt><dd>${statusPill(brokerHealth.label, brokerHealth.tone)}</dd></div>
      <div class="metric"><dt>Claude selection</dt><dd>${formatInteger(selectedClaude)} <span class="metric__detail">selected \u00b7 ${formatInteger(peers.length)} discovered</span></dd></div>
      <div class="metric"><dt>Codex targets</dt><dd>${formatInteger(readyCodex)} <span class="metric__detail">of ${formatInteger(codexRoutes.length)} ready</span></dd></div>
      <div class="metric"><dt>Queued messages</dt><dd>${formatInteger(queuedMessages)}</dd></div>
      <div class="metric"><dt>Active alerts</dt><dd>${formatInteger(snapshot.alerts.length)}</dd></div>
    </dl>
    ${renderTruncationNotice(snapshot, localOmissions)}
    ${renderAlerts(visibleAlerts, snapshot.generatedAt, snapshot.alerts.length)}

    <section class="directions" aria-label="Message route readiness">
      ${renderDirectionCard("claude", claudeRoutes, visibleClaudeRoutes, peers, snapshot.generatedAt)}
      ${renderDirectionCard("codex", codexRoutes, visibleCodexRoutes, peers, snapshot.generatedAt)}
    </section>

    <section class="panel" aria-labelledby="messages-heading">
      <div class="panel__heading"><h2 id="messages-heading">Recent deliveries</h2><p class="panel__note">${formatInteger(visibleMessageGroups.length)} messages; content excluded</p></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Recent delivery metadata"><table class="responsive-table">
        <caption>Messages grouped from bounded normalized delivery events</caption>
        <thead><tr><th scope="col">Updated</th><th scope="col">Route</th><th scope="col">ID</th><th scope="col">Result</th><th scope="col" class="numeric">Elapsed</th><th scope="col" class="numeric">Size</th><th scope="col">History</th></tr></thead>
        <tbody>${renderMessages(visibleMessageGroups, snapshot.generatedAt)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="available-peers-heading">
      <div class="panel__heading"><h2 id="available-peers-heading">Discovered Claude sessions</h2><p class="panel__note">Selection is explicit; internal IDs are omitted</p></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Discovered Claude sessions"><table class="responsive-table">
        <caption>Discovered Claude sessions and explicit selection state</caption>
        <thead><tr><th scope="col">Alias</th><th scope="col">Host</th><th scope="col">State</th><th scope="col">Compatibility</th><th scope="col">Selection</th>${peerHasObservedTimestamp ? '<th scope="col">Observed</th>' : ""}<th scope="col">Issue</th></tr></thead>
        <tbody>${renderAvailablePeers(peers, snapshot.generatedAt, peerHasObservedTimestamp)}</tbody>
      </table></div>
    </section>

    <details class="panel" ${connectorNeedsAttention ? "open" : ""}>
      <summary class="panel__heading"><span class="panel__title" id="connectors-heading">Connector details</span><span class="panel__note">Pinned protocols and snapshot-scoped observations</span></summary>
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="connectors-heading"><table class="responsive-table">
        <caption>Host connector health and compatibility at snapshot time</caption>
        <thead><tr><th scope="col">Host</th><th scope="col">Provider</th><th scope="col">Health</th><th scope="col">Compatibility</th><th scope="col">Protocol</th><th scope="col">Observed</th><th scope="col">Code</th></tr></thead>
        <tbody>${renderConnectors(snapshot.connectors, snapshot.generatedAt)}</tbody>
      </table></div>
    </details>

    <footer>This read-only Embassy page contains no mutation controls or network requests. Processes running as your local user can read the mode-0600 snapshot file.</footer>
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
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function publishGatewayDashboard(
  stateDirectory: string,
  snapshot: GatewayPublicSnapshot,
  options: DashboardRenderOptions = {},
): Promise<string> {
  const directory = await validatePrivateStateDirectory(stateDirectory);
  const outputPath = path.join(directory, DASHBOARD_FILE_NAME);
  await validateExistingDashboard(outputPath);
  const temporaryPath = path.join(
    directory,
    `.${DASHBOARD_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(renderGatewayDashboard(snapshot, options), "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    return outputPath;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export const writeDashboardSnapshot = publishGatewayDashboard;
