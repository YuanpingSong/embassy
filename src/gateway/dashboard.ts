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
export const DASHBOARD_DEFAULT_REFRESH_SECONDS = 5;
export const DASHBOARD_MESSAGE_LIMIT = 100;
export const DASHBOARD_CONNECTOR_LIMIT = 32;
export const DASHBOARD_AVAILABLE_PEER_LIMIT = 128;
export const DASHBOARD_AVAILABLE_PEER_INPUT_LIMIT = 256;
export const DASHBOARD_AGENT_LIMIT = 256;
export const DASHBOARD_ROUTE_LIMIT = 256;
export const DASHBOARD_ALERT_LIMIT = 64;
export const DASHBOARD_MAX_HTML_BYTES = 256 * 1024;

export type DashboardRenderOptions = {
  refreshSeconds?: number;
};

type Tone = "good" | "warn" | "bad" | "quiet";

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

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function renderTimestamp(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === undefined) return '<span class="quiet">\u2014</span>';
  const label = timestamp.replace("T", " ").replace(".000Z", "Z");
  return `<time datetime="${timestamp}">${label}</time>`;
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
      return { label: "Connecting", tone: "warn" };
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
      return { label: "Busy", tone: "warn" };
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
      return { label: "Busy", tone: "warn" };
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
    case "held":
    case "ambiguous":
      return {
        label:
          value === "queued"
            ? "Queued"
            : value === "dispatching"
              ? "Dispatching"
              : value === "transport_written"
                ? "Transport written"
                : value === "held"
                  ? "Held"
              : "Ambiguous",
        tone: "warn",
      };
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

function emptyRow(columns: number, label: string): string {
  return `<tr><td colspan="${columns}" class="empty">${label}</td></tr>`;
}

function sortKey(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function renderConnectorProtocol(connector: PublicConnectorSnapshot): string {
  const protocol = safeProtocol(connector.protocol);
  const version = safeProtocol(connector.protocolVersion);
  return `<code>${protocol} ${version}</code>`;
}

function renderConnectors(connectors: readonly PublicConnectorSnapshot[]): string {
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
        <th scope="row">${publicLabel(connector.host)}</th>
        <td>${providerLabel(connector.provider)}</td>
        <td>${statusPill(health.label, health.tone)}</td>
        <td>${statusPill(compatibility.label, compatibility.tone)}</td>
        <td>${renderConnectorProtocol(connector)}</td>
        <td>${renderTimestamp(connector.lastSeenAt)}</td>
        <td>${renderSafeCode(connector.safeErrorCode)}</td>
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
): string {
  const visible = [...peers]
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      return compareText(sortKey(left.alias), sortKey(right.alias));
    })
    .slice(0, DASHBOARD_AVAILABLE_PEER_LIMIT);
  if (visible.length === 0) {
    return emptyRow(7, "No compatible Claude peers discovered.");
  }
  return visible
    .map((peer) => {
      const state = agentStatusPresentation(peer.state);
      const compatibility = compatibilityPresentation(peer.compatibility);
      const selection = peer.selected
        ? statusPill("Selected", "good")
        : statusPill("Available", "quiet");
      return `<tr>
        <th scope="row">${publicLabel(peer.alias)}</th>
        <td>${publicLabel(peer.host)}</td>
        <td>${statusPill(state.label, state.tone)}</td>
        <td>${statusPill(compatibility.label, compatibility.tone)}</td>
        <td>${selection}</td>
        <td>${renderTimestamp(peer.lastSeenAt)}</td>
        <td>${renderSafeCode(peer.safeErrorCode)}</td>
      </tr>`;
    })
    .join("\n");
}

function matchingConnector(
  route: PublicRouteSnapshot,
  connectors: readonly PublicConnectorSnapshot[],
): PublicConnectorSnapshot | undefined {
  return [...connectors]
    .filter(
      (connector) =>
        connector.provider === route.provider && connector.host === route.host,
    )
    .sort((left, right) => {
      const byProtocol = compareText(
        sortKey(left.protocol),
        sortKey(right.protocol),
      );
      return byProtocol === 0
        ? compareText(
            sortKey(left.protocolVersion),
            sortKey(right.protocolVersion),
          )
        : byProtocol;
    })[0];
}

function renderAgents(
  routes: readonly PublicRouteSnapshot[],
  connectors: readonly PublicConnectorSnapshot[],
): string {
  const visible = [...routes]
    .sort((left, right) =>
      compareText(sortKey(left.alias), sortKey(right.alias)),
    )
    .slice(0, DASHBOARD_AGENT_LIMIT);
  if (visible.length === 0) return emptyRow(6, "No agents opted in.");
  return visible
    .map((route) => {
      const status = agentStatusPresentation(
        route.enabled ? route.state : "disabled",
      );
      const connector = matchingConnector(route, connectors);
      return `<tr>
        <th scope="row">${publicLabel(route.alias)}</th>
        <td>${providerLabel(route.provider)}</td>
        <td>${publicLabel(route.host)}</td>
        <td>${statusPill(status.label, status.tone)}</td>
        <td>${connector === undefined ? '<span class="quiet">\u2014</span>' : renderConnectorProtocol(connector)}</td>
        <td>${renderTimestamp(route.lastSeenAt)}</td>
      </tr>`;
    })
    .join("\n");
}

function renderRoutes(routes: readonly PublicRouteSnapshot[]): string {
  const visible = [...routes]
    .sort((left, right) =>
      compareText(sortKey(left.alias), sortKey(right.alias)),
    )
    .slice(0, DASHBOARD_ROUTE_LIMIT);
  if (visible.length === 0) return emptyRow(5, "No message routes registered.");
  return visible
    .map((route) => {
      const state = routeStatePresentation(
        route.enabled ? route.state : "disabled",
      );
      const compatibility = compatibilityPresentation(route.compatibility);
      const depth = formatInteger(route.queueDepth);
      return `<tr>
        <th scope="row">${publicLabel(route.alias)}</th>
        <td>${statusPill(state.label, state.tone)}</td>
        <td>${statusPill(compatibility.label, compatibility.tone)}</td>
        <td>${busyPolicyLabel(route.busyPolicy)}</td>
        <td class="numeric">${depth}</td>
      </tr>`;
    })
    .join("\n");
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
  return compareText(
    sortKey(left.messageIdSuffix),
    sortKey(right.messageIdSuffix),
  );
}

function renderMessages(messages: readonly NormalizedMessageEvent[]): string {
  const visible = [...messages]
    .sort(compareMessages)
    .slice(0, DASHBOARD_MESSAGE_LIMIT);
  if (visible.length === 0) return emptyRow(9, "No delivery metadata recorded.");
  return visible
    .map((message) => {
      const state = messageStatePresentation(message.state);
      return `<tr>
        <td>${renderTimestamp(message.timestamp)}</td>
        <td>${directionLabel(message.direction)}</td>
        <td>${publicLabel(message.sourceAlias)}</td>
        <td>${publicLabel(message.targetAlias)}</td>
        <td><code>\u2026${shortOpaqueSuffix(message.messageIdSuffix)}</code></td>
        <td>${statusPill(state.label, state.tone)}</td>
        <td class="numeric">${formatInteger(message.latencyMs)}</td>
        <td class="numeric">${formatInteger(message.bytes)}</td>
        <td>${renderSafeCode(message.safeErrorCode)}</td>
      </tr>`;
    })
    .join("\n");
}

function compareAlerts(left: SafeGatewayAlert, right: SafeGatewayAlert): number {
  const leftTimestamp = normalizeTimestamp(left.timestamp) ?? "";
  const rightTimestamp = normalizeTimestamp(right.timestamp) ?? "";
  const byTimestamp = compareText(rightTimestamp, leftTimestamp);
  if (byTimestamp !== 0) return byTimestamp;
  return compareText(sortKey(left.code), sortKey(right.code));
}

function renderAlerts(alerts: readonly SafeGatewayAlert[]): string {
  const visible = [...alerts]
    .sort(compareAlerts)
    .slice(0, DASHBOARD_ALERT_LIMIT);
  if (visible.length === 0) return emptyRow(6, "No active gateway alerts.");
  return visible
    .map((alert) => {
      const severity = alertSeverityPresentation(alert.severity);
      return `<tr>
        <td>${renderTimestamp(alert.timestamp)}</td>
        <td>${statusPill(severity.label, severity.tone)}</td>
        <td>${renderSafeCode(alert.code)}</td>
        <td>${providerLabel(alert.provider)}</td>
        <td>${alert.host === undefined ? '<span class="quiet">\u2014</span>' : publicLabel(alert.host)}</td>
        <td>${alert.alias === undefined ? '<span class="quiet">\u2014</span>' : publicLabel(alert.alias)}</td>
      </tr>`;
    })
    .join("\n");
}

function refreshSeconds(value: unknown): number {
  const integer = normalizedInteger(value);
  if (integer === undefined) return DASHBOARD_DEFAULT_REFRESH_SECONDS;
  return Math.min(60, Math.max(2, integer));
}

function renderTruncationNotice(snapshot: GatewayPublicSnapshot): string {
  const entries = [
    ["connectors", normalizedInteger(snapshot.truncation.connectors)],
    ["available peers", normalizedInteger(snapshot.truncation.availablePeers)],
    ["routes", normalizedInteger(snapshot.truncation.routes)],
    ["messages", normalizedInteger(snapshot.truncation.messages)],
    ["alerts", normalizedInteger(snapshot.truncation.alerts)],
  ] as const;
  const omitted = entries
    .filter((entry) => (entry[1] ?? 0) > 0)
    .map(([label, count]) => `${formatInteger(count)} ${label}`);
  if (omitted.length === 0) return "";
  return `<p class="truncation-note" role="status"><strong>Bounded snapshot:</strong> omitted ${omitted.join(", ")}.</p>`;
}

export function renderGatewayDashboard(
  snapshot: GatewayPublicSnapshot,
  options: DashboardRenderOptions = {},
): string {
  const refresh = refreshSeconds(options.refreshSeconds);
  const gatewayHealth = healthPresentation(snapshot.health);
  const queuedMessages = snapshot.routes.reduce((sum, route) => {
    const depth = normalizedInteger(route.queueDepth) ?? 0;
    return Math.min(Number.MAX_SAFE_INTEGER, sum + depth);
  }, 0);
  const peers = availableClaudePeers(snapshot.availablePeers);
  const generatedAt = renderTimestamp(snapshot.generatedAt);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${refresh}">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="only light">
  <title>Agent Gateway Monitor</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f5f7fb;
      --surface: #ffffff;
      --surface-soft: #f8fafc;
      --ink: #172033;
      --muted: #65708a;
      --line: #dfe5ef;
      --accent: #405cf5;
      --accent-soft: #eef1ff;
      --good: #16794d;
      --good-soft: #eaf8f1;
      --warn: #9a5b00;
      --warn-soft: #fff5df;
      --bad: #b12b3b;
      --bad-soft: #fff0f2;
      --shadow: 0 14px 40px rgba(23, 32, 51, 0.07);
    }
    * { box-sizing: border-box; }
    html { background: var(--canvas); }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #edf0ff 0, transparent 25rem),
        var(--canvas);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
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
    main { width: min(1440px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 3rem; }
    header {
      display: flex;
      align-items: flex-end;
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
    h1 { margin: 0; font-size: clamp(1.65rem, 3vw, 2.35rem); letter-spacing: -.035em; }
    .subtitle { margin: .35rem 0 0; color: var(--muted); }
    .generated { margin: 0; color: var(--muted); text-align: right; white-space: nowrap; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: .85rem;
      margin-bottom: 1rem;
    }
    .metric, .panel {
      background: rgba(255, 255, 255, .94);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .metric { padding: 1rem 1.1rem; }
    .metric__label { display: block; margin-bottom: .3rem; color: var(--muted); font-size: .78rem; }
    .metric__value { font-size: 1.35rem; font-weight: 760; letter-spacing: -.02em; }
    .truncation-note { margin: 0 0 1rem; padding: .75rem 1rem; color: var(--warn); background: var(--warn-soft); border: 1px solid #f0d79e; border-radius: 10px; }
    .panel { margin-top: 1rem; overflow: hidden; }
    .panel__heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      padding: .95rem 1.1rem;
      background: linear-gradient(180deg, #fff, var(--surface-soft));
      border-bottom: 1px solid var(--line);
    }
    h2 { margin: 0; font-size: 1rem; }
    .panel__note { margin: 0; color: var(--muted); font-size: .78rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
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
    tbody tr:hover { background: #fafbff; }
    code { font: .82rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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
    .status--warn { color: var(--warn); background: var(--warn-soft); }
    .status--bad { color: var(--bad); background: var(--bad-soft); }
    .status--quiet { color: var(--muted); background: #eef1f5; }
    .numeric { text-align: right; }
    .quiet, .empty { color: var(--muted); }
    .empty { padding: 1.4rem 1.1rem; text-align: center; }
    footer { margin-top: 1.15rem; color: var(--muted); font-size: .75rem; text-align: center; }
    @media (max-width: 1100px) { .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 850px) {
      header { align-items: flex-start; flex-direction: column; }
      .generated { text-align: left; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 480px) {
      main { width: min(100% - 1rem, 1440px); padding-top: 1rem; }
      .metrics { grid-template-columns: 1fr; }
      th, td { padding-inline: .85rem; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
    @media print { body { background: white; } .metric, .panel { box-shadow: none; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to gateway status</a>
  <main id="main">
    <header>
      <div>
        <p class="eyebrow">Local, private snapshot</p>
        <h1>Agent Gateway Monitor</h1>
        <p class="subtitle">Normalized routing and delivery metadata only.</p>
      </div>
      <p class="generated">Generated ${generatedAt}<br>Refreshes every ${refresh} seconds</p>
    </header>

    <section class="metrics" aria-label="Gateway summary">
      <div class="metric"><span class="metric__label">Gateway</span><span class="metric__value">${statusPill(gatewayHealth.label, gatewayHealth.tone)}</span></div>
      <div class="metric"><span class="metric__label">Opted-in agents</span><span class="metric__value">${formatInteger(snapshot.routes.length)}</span></div>
      <div class="metric"><span class="metric__label">Available Claude peers</span><span class="metric__value">${formatInteger(peers.length)}</span></div>
      <div class="metric"><span class="metric__label">Queued messages</span><span class="metric__value">${formatInteger(queuedMessages)}</span></div>
      <div class="metric"><span class="metric__label">Active alerts</span><span class="metric__value">${formatInteger(snapshot.alerts.length)}</span></div>
    </section>
    ${renderTruncationNotice(snapshot)}

    <section class="panel" aria-labelledby="connectors-heading">
      <div class="panel__heading"><h2 id="connectors-heading">Host connectors</h2><p class="panel__note">Maximum ${DASHBOARD_CONNECTOR_LIMIT} rows</p></div>
      <div class="table-wrap"><table>
        <caption>Host connector health and compatibility</caption>
        <thead><tr><th scope="col">Host</th><th scope="col">Provider</th><th scope="col">Health</th><th scope="col">Compatibility</th><th scope="col">Protocol</th><th scope="col">Last seen</th><th scope="col">Code</th></tr></thead>
        <tbody>${renderConnectors(snapshot.connectors)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="available-peers-heading">
      <div class="panel__heading"><h2 id="available-peers-heading">Available Claude peers</h2><p class="panel__note">Genuine live discovery; maximum ${DASHBOARD_AVAILABLE_PEER_LIMIT} rows</p></div>
      <div class="table-wrap"><table>
        <caption>Available genuine Claude peers and selection state</caption>
        <thead><tr><th scope="col">Alias</th><th scope="col">Host</th><th scope="col">State</th><th scope="col">Compatibility</th><th scope="col">Selection</th><th scope="col">Last seen</th><th scope="col">Code</th></tr></thead>
        <tbody>${renderAvailablePeers(peers)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="agents-heading">
      <div class="panel__heading"><h2 id="agents-heading">Selected agents</h2><p class="panel__note">Public aliases only</p></div>
      <div class="table-wrap"><table>
        <caption>Opted-in Claude and Codex agents</caption>
        <thead><tr><th scope="col">Alias</th><th scope="col">Provider</th><th scope="col">Host</th><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">Last seen</th></tr></thead>
        <tbody>${renderAgents(snapshot.routes, snapshot.connectors)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="routes-heading">
      <div class="panel__heading"><h2 id="routes-heading">Routes</h2><p class="panel__note">Busy behavior and bounded queues</p></div>
      <div class="table-wrap"><table>
        <caption>Registered message routes</caption>
        <thead><tr><th scope="col">Alias</th><th scope="col">State</th><th scope="col">Compatibility</th><th scope="col">Busy policy</th><th scope="col" class="numeric">Queue</th></tr></thead>
        <tbody>${renderRoutes(snapshot.routes)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="alerts-heading">
      <div class="panel__heading"><h2 id="alerts-heading">Gateway alerts</h2><p class="panel__note">Safe codes only</p></div>
      <div class="table-wrap"><table>
        <caption>Bounded normalized gateway alerts</caption>
        <thead><tr><th scope="col">Timestamp</th><th scope="col">Severity</th><th scope="col">Code</th><th scope="col">Provider</th><th scope="col">Host</th><th scope="col">Alias</th></tr></thead>
        <tbody>${renderAlerts(snapshot.alerts)}</tbody>
      </table></div>
    </section>

    <section class="panel" aria-labelledby="messages-heading">
      <div class="panel__heading"><h2 id="messages-heading">Message timeline</h2><p class="panel__note">Latest ${DASHBOARD_MESSAGE_LIMIT}; content excluded</p></div>
      <div class="table-wrap"><table>
        <caption>Bounded normalized delivery metadata</caption>
        <thead><tr><th scope="col">Timestamp</th><th scope="col">Direction</th><th scope="col">From</th><th scope="col">To</th><th scope="col">ID</th><th scope="col">State</th><th scope="col" class="numeric">Latency ms</th><th scope="col" class="numeric">Bytes</th><th scope="col">Code</th></tr></thead>
        <tbody>${renderMessages(snapshot.messages)}</tbody>
      </table></div>
    </section>

    <footer>This file is a read-only controller snapshot. It has no network or mutation surface.</footer>
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
