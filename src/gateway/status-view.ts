/**
 * Human rendering of the public snapshot. Pure and side-effect free: it takes
 * a validated `GatewayPublicSnapshot` and returns text, so every judgement it
 * makes — which connectors matter, what counts as stale, which alerts are
 * actionable — is unit-testable against fixture snapshots without a broker.
 *
 * Nothing here reaches for state the snapshot does not already carry. The
 * snapshot is the whole input; `StatusViewOptions` adds only what the client
 * knows about itself (its own version, the state directory it resolved, and
 * the pid recorded in that directory's controller lock).
 */
import type {
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicConnectorSnapshot,
  PublicGatewayActivityEvent,
  PublicRouteSnapshot,
  SafeGatewayAlert,
} from "./types.js";

/**
 * A route whose last observation is older than this is reported `stale`
 * whatever word the broker gave it. The broker's own rule fires at 35 s for
 * providers that observe on a timer; this is the backstop for a `lastSeenAt`
 * that stopped advancing without the broker noticing.
 */
export const STATUS_ROUTE_STALE_AFTER_MS = 10 * 60_000;
const PREVIEW_MAX_CHARS = 60;
const MAX_ALERT_ROWS = 6;
const MAX_SHELL_PEER_ROWS = 8;
export const STATUS_RECENT_DEFAULT = 10;
export const STATUS_RECENT_MIN = 1;
export const STATUS_RECENT_MAX = 100;

/** The words a connector is allowed to say. Never a sentence, never a number. */
export type StatusWord = "ok" | "stale" | "degraded" | "offline";

export type StatusViewOptions = Readonly<{
  stateDir: string;
  version: string;
  recent: number;
  color: boolean;
  /** Defaults to the snapshot's own `generatedAt`, so every age is self-consistent. */
  now?: number;
  /** From `<stateDir>/.gateway-controller.lock`; absent when it could not be read. */
  pid?: number;
  /** Safe code of the rescan `status` runs first, when that rescan did not succeed. */
  refreshFailure?: string;
}>;

/**
 * One remedy per safe code, each one line. A connector with an unknown code
 * still gets a bounded generic remedy — it is on the delivery path, so the
 * operator must be told something — while an alert with an unknown code is
 * counted rather than printed. That filter is what makes the alert section
 * "actionable alerts" instead of an event log.
 *
 * `PEER_ALIAS_COLLISION` is deliberately the same sentence the CLI prints for
 * a refused send (`CLI_HINT.aliasCollision`); a test pins the two together.
 */
export const STATUS_REMEDY: Readonly<Record<string, string>> = {
  MANAGED_CODEX_UNAVAILABLE:
    "A process outside Embassy holds the managed Codex control socket. Quit it, then run `codex app-server daemon start`.",
  PEER_ALIAS_COLLISION:
    "the alias names more than one live session; rename one, or address the session by UUID with --to <session-uuid>.",
  PEER_PROTOCOL_MISMATCH:
    "That node runs a different federation peer protocol; upgrade the lagging node's Embassy and it re-catalogs on the next refresh.",
  PEER_TUNNEL_UNAVAILABLE:
    "The SSH tunnel to that node is down; check the node is reachable and its broker is running.",
  PEER_DIAL_FAILED:
    "Embassy could not open the SSH tunnel to that node; check its entry in nodes.json and your SSH configuration.",
  PEER_CATALOG_INCOMPLETE:
    "That node answered with an incomplete catalog; its mirrored routes are shown from the last complete one.",
  PEER_ROUTE_STALE:
    "That mirrored route was missing from the node's latest catalog; it retires when the node stops publishing it.",
  CLAUDE_PEER_NOT_OBSERVED:
    "That Claude session is no longer in the live registry; run `embassy refresh`, and its route retires on the next send if the session exited.",
  ROUTE_UNOBSERVED:
    "The provider stopped reporting this route; retire it if the session or task ended.",
  THREAD_NOT_OBSERVED:
    "That Codex task is gone. Run `embassy register-codex --alias <new-alias> --succeeds <this alias>` from the new task, or `embassy unregister-codex --alias <this alias>` from the old one.",
  CODEX_OBSERVER_UNAVAILABLE:
    "Embassy cannot observe Codex tasks; start the managed daemon with `codex app-server daemon start`.",
  CONNECTOR_OBSERVATION_STALE:
    "Nothing has been observed on this connector recently; that is silence, not a fault.",
  GATEWAY_WAKE_FAILED:
    "The broker's maintenance tick failed once; if it repeats, restart the broker.",
} as const;

const ANSI = Object.freeze({
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m",
  red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m",
});
export type Paint = (text: string, code: keyof typeof ANSI) => string;
/** The one place that emits an escape sequence; `color: false` emits none. */
export const terminalPainter = (color: boolean): Paint =>
  color ? (text, code) => `${ANSI[code]}${text}${ANSI.reset}` : (text) => text;
const painter = terminalPainter;
const wordColor = (word: string): keyof typeof ANSI =>
  word === "ok" ? "green" : word === "degraded" || word === "offline" ? "red" : "yellow";

/**
 * Bodies are the one snapshot field with no shape validation beyond "non-empty
 * UTF-8 without NUL", so a preview strips C0/C1 controls — an embedded escape
 * sequence would otherwise repaint the operator's terminal — collapses runs of
 * whitespace, and is cut to one short line.
 */
export function previewBody(body: string, maximum = PREVIEW_MAX_CHARS): string {
  const flattened = body.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = [...flattened];
  return characters.length <= maximum ? flattened : `${characters.slice(0, maximum - 1).join("")}…`;
}

/** Relative wall-clock age: deterministic, and free of the reader's timezone. */
export function relativeAge(timestamp: string | undefined, now: number): string {
  if (timestamp === undefined) return "never";
  const observed = Date.parse(timestamp);
  if (!Number.isFinite(observed)) return "unknown";
  const seconds = Math.max(0, Math.round((now - observed) / 1_000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

const ageMs = (timestamp: string | undefined, now: number): number | undefined => {
  if (timestamp === undefined) return undefined;
  const observed = Date.parse(timestamp);
  return Number.isFinite(observed) ? Math.max(0, now - observed) : undefined;
};

/**
 * Connector words. A connector reporting `CONNECTOR_OBSERVATION_STALE` has
 * nothing wrong with it: no route of that provider was observed inside the
 * broker's window. That is `stale`, not `degraded`, and the difference is the
 * point — an idle Mac with no registered Codex task must not read as broken.
 */
export function connectorWord(connector: PublicConnectorSnapshot): StatusWord {
  if (connector.health === "healthy" || connector.health === "connecting") return "ok";
  if (connector.health === "offline") return "offline";
  return connector.safeErrorCode === "CONNECTOR_OBSERVATION_STALE" ? "stale" : "degraded";
}

/** Route word, with the >10-minute unobservable backstop applied on top. */
export function routeWord(route: PublicRouteSnapshot, now: number): string {
  if (!route.enabled) return "disabled";
  const observed = ageMs(route.lastSeenAt, now);
  if (observed !== undefined && observed > STATUS_ROUTE_STALE_AFTER_MS) return "stale";
  return route.state === "awaiting_approval" ? "awaiting" : route.state;
}

const severityRank = (word: StatusWord): number =>
  word === "degraded" || word === "offline" ? 0 : word === "stale" ? 1 : 2;

/**
 * The overall word is informational and derived from the two connectors a
 * message actually travels through. A shell peer never contributes: its
 * mailbox is pull-only, so "nobody is awaiting it" is a fact about the
 * operator's other terminal, not about the broker.
 */
export function overallWord(snapshot: GatewayPublicSnapshot): StatusWord {
  const routed = snapshot.connectors.filter(
    (connector) => connector.provider === "claude" || connector.provider === "codex");
  if (routed.length === 0) return "offline";
  return routed.map(connectorWord).reduce<StatusWord>(
    (worst, word) => severityRank(word) < severityRank(worst) ? word : worst, "ok");
}

/** The remedy for one connector's condition; never empty when the word is not ok. */
function connectorRemedy(
  connector: PublicConnectorSnapshot, snapshot: GatewayPublicSnapshot,
): string {
  const code = connector.safeErrorCode;
  if (code === "CONNECTOR_OBSERVATION_STALE" && connector.provider === "codex") {
    return snapshot.routes.some((route) => route.provider === "codex")
      ? "A registered Codex task has not been observed recently; run `embassy check` to test the round trip."
      : "No Codex task is registered. Run `embassy register-codex --alias codex-<name>@<host>` from inside the task.";
  }
  if (code === "CONNECTOR_OBSERVATION_STALE" && connector.provider === "claude") {
    return "No Claude session has been observed recently; start one, then run `embassy refresh`.";
  }
  const known = code === undefined ? undefined : STATUS_REMEDY[code];
  if (known !== undefined) return known;
  return `The ${connector.provider} connector is not answering. Read \`embassy status --json\` for the full snapshot, and restart the broker if it does not clear.`;
}

/**
 * Colliding Claude names are filtered out of `availablePeers` by the broker,
 * and the only public trace left is a rejection count on the Claude
 * connector's registry observation. The count is therefore what can honestly
 * be reported: which name collided is not in the snapshot.
 */
function collisionCount(snapshot: GatewayPublicSnapshot): number {
  const claude = snapshot.connectors.find((connector) => connector.provider === "claude");
  return claude?.registry?.rejected.find(
    (row) => row.safeErrorCode === "PEER_ALIAS_COLLISION")?.count ?? 0;
}

type Cell = Readonly<{ value: string; tone?: keyof typeof ANSI }>;
/**
 * Columns padded to content width; the last column is never padded. Padding is
 * measured and applied on the plain value and colour is put on afterwards —
 * padding a string that already carries escape bytes counts them as width and
 * shears the table apart the moment colour is on.
 */
function table(
  headers: readonly string[], rows: readonly (readonly Cell[])[], paint: Paint,
): string[] {
  const widths = headers.map((header, index) => Math.max(
    header.length, ...rows.map((row) => (row[index]?.value ?? "").length)));
  const render = (cells: readonly Cell[]): string => cells.map((cell, index) => {
    const padded = index === headers.length - 1 ? cell.value : cell.value.padEnd(widths[index] ?? 0);
    return cell.tone === undefined ? padded : paint(padded, cell.tone);
  }).join("  ").trimEnd();
  return [render(headers.map((value) => ({ value }))), ...rows.map(render)];
}

/** The most recent alert per (code, host, alias), newest first, remedied ones only. */
function actionableAlerts(alerts: readonly SafeGatewayAlert[]): {
  shown: SafeGatewayAlert[]; suppressed: number;
} {
  const latest = new Map<string, SafeGatewayAlert>();
  for (const alert of alerts) {
    latest.set(`${alert.code} ${alert.host ?? ""} ${alert.alias ?? ""}`, alert);
  }
  const rows = [...latest.values()].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const shown = rows.filter((alert) => STATUS_REMEDY[alert.code] !== undefined).slice(0, MAX_ALERT_ROWS);
  return { shown, suppressed: rows.length - shown.length };
}

const messageArrow = (event: Readonly<{ sourceAlias: string; targetAlias: string }>): string =>
  `${event.sourceAlias} → ${event.targetAlias}`;

export function renderStatus(
  snapshot: GatewayPublicSnapshot, options: StatusViewOptions,
): string {
  const now = options.now ?? Date.parse(snapshot.generatedAt);
  const paint = painter(options.color);
  const lines: string[] = [];
  const overall = overallWord(snapshot);

  const brokerFacts = [
    paint(overall, wordColor(overall)),
    ...(options.pid === undefined ? [] : [`pid ${String(options.pid)}`]),
    `snapshot ${relativeAge(snapshot.generatedAt, now)}`,
  ];
  lines.push(`${paint(`embassy ${options.version}`, "bold")}  broker ${brokerFacts.join(" · ")}`);
  lines.push(paint(`state dir ${options.stateDir}`, "dim"));
  if (options.refreshFailure !== undefined) {
    lines.push(paint(
      `the rescan for Claude sessions did not run (${options.refreshFailure}); names below may be out of date`,
      "yellow"));
  }

  lines.push("", paint("connectors", "bold"));
  const routedConnectors = snapshot.connectors.filter(
    (connector) => connector.provider === "claude" || connector.provider === "codex");
  if (routedConnectors.length === 0) lines.push("  none — the broker has no provider connectors");
  for (const connector of routedConnectors) {
    const word = connectorWord(connector);
    const suffix = word === "ok" ? "" : `  ${connector.safeErrorCode ?? "no safe code"}`;
    lines.push(`  ${connector.provider.padEnd(7)} ${paint(word, wordColor(word))}${suffix}`);
    if (word !== "ok") lines.push(paint(`          ${connectorRemedy(connector, snapshot)}`, "dim"));
  }
  // A registered shell peer is a connector from the operator's side: the route
  // exists, but whether anything is awaiting it lives in another terminal.
  // Queued mail with no waiter is the one observable proof, and it never
  // touches the overall word.
  for (const peer of snapshot.routes.filter((route) => route.provider === "peer").slice(0, MAX_SHELL_PEER_ROWS)) {
    const waiting = peer.queueDepth > 0;
    lines.push(`  ${peer.alias} ${waiting
      ? paint("stale (token or await loop gone)", "yellow") : paint("ok", "green")}`);
    if (waiting) {
      lines.push(paint(`          ${String(peer.queueDepth)} message(s) waiting: run \`embassy await --alias ${peer.alias} --token-stdin\` in the shell holding its token, or \`embassy unregister-peer --alias ${peer.alias} --token-stdin\`.`, "dim"));
    }
  }

  lines.push("", paint("routes", "bold"));
  if (snapshot.routes.length === 0) {
    lines.push("  none — a Claude session's route installs on its first send; a Codex task is registered explicitly");
  } else {
    const rows = snapshot.routes.map((route): Cell[] => {
      const word = routeWord(route, now);
      return [{ value: route.alias }, { value: route.provider },
        { value: word, tone: wordColor(word === "idle" || word === "busy" ? "ok" : word) },
        { value: String(route.queueDepth) }, { value: relativeAge(route.lastSeenAt, now) }];
    });
    for (const line of table(["alias", "provider", "state", "queue", "last seen"], rows, paint)) {
      lines.push(`  ${line}`);
    }
    // The orphaned Codex registration emb-100 lost with the dashboard: a task
    // that is still registered and can no longer be observed.
    for (const route of snapshot.routes) {
      if (route.provider !== "codex" || routeWord(route, now) !== "stale") continue;
      const remedy = STATUS_REMEDY[route.safeErrorCode ?? "THREAD_NOT_OBSERVED"] ?? STATUS_REMEDY.THREAD_NOT_OBSERVED;
      lines.push(paint(`    ${route.alias}: ${remedy ?? ""}`, "dim"));
    }
  }
  const collisions = collisionCount(snapshot);
  if (collisions > 0) {
    lines.push(paint(`    ${String(collisions)} discovered Claude name(s) are shared by more than one live session and are hidden from this list; address those sessions by UUID.`, "yellow"));
  }

  const recent = snapshot.messages.slice(-options.recent);
  lines.push("", paint(`recent (${String(recent.length)} of ${String(snapshot.messages.length)})`, "bold"));
  if (recent.length === 0) lines.push("  no messages retained");
  for (const event of [...recent].reverse()) {
    const latency = event.latencyMs === undefined ? "" : `  ${String(event.latencyMs)} ms`;
    const code = event.safeErrorCode === undefined ? "" : `  ${event.safeErrorCode}`;
    lines.push(`  ${relativeAge(event.timestamp, now).padEnd(9)}  ${messageArrow(event)}  ${event.state}${latency}${code}`);
    if (event.body !== undefined) lines.push(paint(`             ${previewBody(event.body)}`, "dim"));
  }

  const { shown, suppressed } = actionableAlerts(snapshot.alerts);
  if (shown.length > 0) {
    lines.push("", paint("alerts", "bold"));
    for (const alert of shown) {
      const subject = alert.alias ?? alert.host ?? alert.provider ?? "";
      lines.push(`  ${alert.code}${subject === "" ? "" : `  ${subject}`}  ${relativeAge(alert.timestamp, now)}`);
      lines.push(paint(`    ${STATUS_REMEDY[alert.code] ?? ""}`, "dim"));
    }
    if (suppressed > 0) {
      lines.push(paint(`  ${String(suppressed)} alert(s) with no known remedy — read \`embassy status --json\``, "dim"));
    }
  }

  const omitted = Object.entries(snapshot.truncation)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([name, count]) => `${String(count)} ${name}`);
  if (omitted.length > 0) {
    lines.push("", paint(`omitted from this snapshot: ${omitted.join(", ")}`, "dim"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `watch` state. Memory is bounded by the snapshot itself: the state map is
 * rebuilt from each poll's own rows, which the control protocol caps, so a
 * broker watched for a month costs what one watched for a minute costs.
 */
export type WatchState = Readonly<{
  messageStates: ReadonlyMap<number, string>;
  lastMessageSequence: number;
  lastActivitySequence: number;
}>;
export const emptyWatchState: WatchState = Object.freeze({
  messageStates: new Map<number, string>(), lastMessageSequence: -1, lastActivitySequence: -1,
});
export type WatchEvent =
  | Readonly<{ type: "message"; event: NormalizedMessageEvent }>
  | Readonly<{
      type: "transition"; sequence: number; from: string; to: string;
      sourceAlias: string; targetAlias: string; latencyMs?: number; safeErrorCode?: string;
    }>
  | Readonly<{ type: "activity"; event: PublicGatewayActivityEvent }>;

/** Pure diff of one poll against the last, in stable emit order. */
export function diffWatch(
  previous: WatchState, snapshot: GatewayPublicSnapshot,
): Readonly<{ state: WatchState; events: WatchEvent[] }> {
  const events: WatchEvent[] = [];
  const messageStates = new Map<number, string>();
  let lastMessageSequence = previous.lastMessageSequence;
  for (const event of [...snapshot.messages].sort((left, right) => left.sequence - right.sequence)) {
    messageStates.set(event.sequence, event.state);
    if (event.sequence > previous.lastMessageSequence) {
      events.push({ type: "message", event });
      lastMessageSequence = Math.max(lastMessageSequence, event.sequence);
      continue;
    }
    const before = previous.messageStates.get(event.sequence);
    if (before !== undefined && before !== event.state) {
      events.push({
        type: "transition", sequence: event.sequence, from: before, to: event.state,
        sourceAlias: event.sourceAlias, targetAlias: event.targetAlias,
        ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
        ...(event.safeErrorCode === undefined ? {} : { safeErrorCode: event.safeErrorCode }),
      });
    }
  }
  let lastActivitySequence = previous.lastActivitySequence;
  for (const event of [...(snapshot.activityEvents ?? [])].sort((left, right) => left.sequence - right.sequence)) {
    if (event.sequence <= previous.lastActivitySequence) continue;
    events.push({ type: "activity", event });
    lastActivitySequence = Math.max(lastActivitySequence, event.sequence);
  }
  return { state: { messageStates, lastMessageSequence, lastActivitySequence }, events };
}

const SETTLED_BADLY = ["failed", "ambiguous", "unconfirmed", "expired", "cancelled", "abandoned", "rejected"];

/** One terminal line per watch event; the activity line is deliberately secondary. */
export function renderWatchEvent(event: WatchEvent, color: boolean): string {
  const paint = painter(color);
  if (event.type === "message") {
    const preview = event.event.body === undefined
      ? "" : `  ${paint(previewBody(event.event.body, 40), "dim")}`;
    return `#${String(event.event.sequence)}  ${messageArrow(event.event)}  ${event.event.state}  ${String(event.event.bytes)} B${preview}`;
  }
  if (event.type === "transition") {
    const latency = event.latencyMs === undefined ? "" : ` (${String(event.latencyMs)} ms)`;
    const code = event.safeErrorCode === undefined ? "" : `  ${event.safeErrorCode}`;
    const word = event.to === "delivered" ? paint(event.to, "green")
      : SETTLED_BADLY.includes(event.to) ? paint(event.to, "red") : event.to;
    return `#${String(event.sequence)}  ${event.from} → ${word}${latency}${code}`;
  }
  const detail = event.event.safeErrorCode === undefined ? "" : `  ${event.event.safeErrorCode}`;
  return paint(`   ${event.event.action}  ${event.event.aliases.join(", ")}  ${event.event.outcome}${detail}`, "dim");
}
