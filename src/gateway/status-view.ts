/**
 * Human rendering of the public snapshot. Pure and side-effect free: it takes
 * a validated `GatewayPublicSnapshot` and returns text, so every judgement it
 * makes — which connectors matter, what counts as stale, which alerts are
 * actionable — is unit-testable against fixture snapshots without a broker.
 *
 * Nothing here reaches for state the snapshot does not already carry, and
 * nothing here asks the broker for anything: `status` is read-only. The
 * snapshot is the whole input; `StatusViewOptions` adds only what the client
 * knows about itself (its own version, the state directory it resolved, the
 * pid recorded in that directory's controller lock, and the clock).
 *
 * Caps: at most `STATUS_CAPS.sessions` discovered sessions, `.shellPeers`
 * shell-peer lines, and `.alerts` alert rows are printed. Every cap says how
 * many rows it hid, and the shell-peer list is ordered stale-first so a stuck
 * peer is never the row that falls off the end.
 */
import { gatewayPublicSnapshotLimits } from "./types.js";
import type {
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicAvailablePeerSnapshot,
  PublicConnectorSnapshot,
  PublicGatewayActivityEvent,
  PublicRouteSnapshot,
  SafeGatewayAlert,
} from "./types.js";

/**
 * The backstop for a route the broker has not heard about in a long time.
 *
 * It is deliberately far above the broker's own 35-second connector window
 * (`CONNECTOR_OBSERVATION_STALE_AFTER_MS`), because that window is crossed
 * routinely and innocently: the Codex observer polls one route at a time
 * every 15 s, and Claude routes are not polled at all — their evidence is
 * edge-triggered, written when a discovery scan or a delivery observes the
 * session, so a quiet Claude session's `lastSeenAt` simply stops advancing
 * while the session is perfectly alive. A word that meant "gone" at 35 s
 * would tell operators to retire live work; ten minutes plus a code that
 * says the endpoint is gone is what earns that sentence.
 */
export const STATUS_ROUTE_STALE_AFTER_MS = 10 * 60_000;
/** Older than this, the header offers a rescan. `status` never rescans itself. */
export const STATUS_SCAN_STALE_AFTER_MS = 60_000;
/** The one safe code that means the Codex task behind a route is actually gone. */
export const CODEX_ENDPOINT_GONE_CODES: readonly string[] = ["THREAD_NOT_OBSERVED"];
export const STATUS_RECENT = Object.freeze({ default: 10, minimum: 1, maximum: 100 });
export const STATUS_CAPS = Object.freeze({ sessions: 16, shellPeers: 8, alerts: 6 });
// LocalClaudeGatewayProvider emits these from clean prewrite failures,
// refreshClaudeDiscoveryOnce, and the discovery monitor's failure callback.
export const CLAUDE_BUSY_OBSERVATION_CODES = new Set([
  "CLAUDE_PEER_TARGET_UNKNOWN",
  "CLAUDE_PEER_WORKSPACE_UNATTESTED",
  "CLAUDE_PEER_NOT_OBSERVED",
  "CLAUDE_DISCOVERY_UNAVAILABLE",
]);
const PREVIEW_MAX_CHARS = 60;

export type StatusViewOptions = Readonly<{
  stateDir: string;
  version: string;
  recent: number;
  color: boolean;
  /** Wall clock, so "snapshot 3s ago" is the reader's own now, not the broker's. */
  now: number;
  /** From `<stateDir>/.gateway-controller.lock`; absent when it could not be read. */
  pid?: number;
}>;

/**
 * One remedy per safe code, each one line. A connector with an unknown code
 * still gets a bounded generic remedy — it is on the delivery path, so the
 * operator must be told something — while an alert with an unknown code is
 * counted rather than printed. That filter is what makes the alert section
 * "actionable alerts" instead of an event log.
 *
 * `PEER_ALIAS_COLLISION` is deliberately the same sentence the CLI prints for
 * a refused send (`CLI_HINT.aliasCollision`); `status-view.test.ts` pins the
 * two strings together so they cannot drift apart.
 */
export const STATUS_REMEDY: Readonly<Record<string, string>> = {
  MANAGED_CODEX_UNAVAILABLE:
    "Either a process outside Embassy holds the managed Codex control socket — quit it — or the managed App Server standalone layout is missing, which starting the daemon alone does not create: follow the Codex prerequisite in the README (the official installer, then the daemon).",
  PEER_ALIAS_COLLISION:
    "the alias names more than one live session; rename one, or address the session by UUID with --to <session-uuid>.",
  CLAUDE_PEER_WORKSPACE_UNATTESTED:
    "Let the queued delivery retry, then run `embassy status`; each routed preparation validates the workspace again. If this persists, report CLAUDE_PEER_WORKSPACE_UNATTESTED with the current alias.",
  CLAUDE_PEER_TARGET_UNKNOWN:
    "Run `embassy refresh`, then read `embassy status` for the session's current name; discovery did not find the delivery target.",
  CLAUDE_DISCOVERY_UNAVAILABLE:
    "Run `embassy refresh` and read that command's result: a failed scan returns `accepted: false` and its refusal code.",
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
    "Discovery did not find that session; run `embassy refresh`, then inspect `embassy status` for current peers. Sending does not retire a missing session's stored route.",
  ROUTE_UNOBSERVED:
    "The provider stopped reporting this route; retire it if the session or task ended.",
  THREAD_NOT_OBSERVED:
    "That Codex task is gone. Run `embassy register-codex --alias <new-alias> --succeeds <this alias>` from the new task, or `embassy unregister-codex --alias <this alias>` from the old one.",
  CODEX_OBSERVER_UNAVAILABLE:
    "Embassy cannot observe Codex tasks; start the managed daemon with `codex app-server daemon start`.",
  DISPATCH_RUNNER_FAILED:
    "A delivery attempt failed inside the broker; the message keeps its own settled state — read it with `embassy delivery-status`, and restart the broker if this repeats.",
  CLAUDE_INGRESS_REJECTED:
    "A Claude session refused an inbound message; check that session's `crossSessionInbound` setting.",
  CLAUDE_REPLY_REJECTED:
    "A reply could not be written back to the originating Claude session; it may have exited — run `embassy refresh`.",
  ROUTE_OBSERVATION_FAILED:
    "The provider's route observation failed once; the state words above may be out of date until the next poll.",
  EPHEMERAL_ROUTE_EXPIRY_FAILED:
    "A throwaway `embassy check` registration could not be retired on time. The broker retries twice more, five seconds apart; if all three attempts fail the registration stays until the broker restarts, which clears it by construction.",
  GATEWAY_WAKE_FAILED:
    "The broker's maintenance tick failed once; if it repeats, restart the broker.",
} as const;

const ANSI = Object.freeze({
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m",
  red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m",
});
type Tone = keyof typeof ANSI;
export type Paint = (text: string, tone: Tone) => string;
/** The one place that emits an escape sequence; `color: false` emits none. */
export const terminalPainter = (color: boolean): Paint =>
  color ? (text, tone) => `${ANSI[tone]}${text}${ANSI.reset}` : (text) => text;
const wordColor = (word: string): Tone =>
  word === "ok" ? "green" : word === "degraded" || word === "offline" ? "red" : "yellow";

/**
 * Bodies are the one snapshot field with no shape validation beyond "non-empty
 * UTF-8 without NUL", so a preview strips C0/C1 controls and Unicode format
 * characters — an escape sequence would repaint the operator's terminal, and a
 * bidi override or zero-width joiner would let a body render as text it is
 * not — collapses runs of whitespace, and is cut to one short line.
 */
function previewBody(body: string, maximum = PREVIEW_MAX_CHARS): string {
  const flattened = body
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...flattened];
  return characters.length <= maximum ? flattened : `${characters.slice(0, maximum - 1).join("")}…`;
}

/** Relative wall-clock age: deterministic, and free of the reader's timezone. */
function relativeAge(timestamp: string | undefined, now: number): string {
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
/** The same age without "ago", for a phrase that supplies its own preposition. */
const spanFor = (timestamp: string | undefined, now: number): string =>
  relativeAge(timestamp, now).replace(/ ago$/, "");

const ageMs = (timestamp: string | undefined, now: number): number | undefined => {
  if (timestamp === undefined) return undefined;
  const observed = Date.parse(timestamp);
  return Number.isFinite(observed) ? Math.max(0, now - observed) : undefined;
};

/** The words a connector is allowed to say. Never a sentence, never a number. */
export type StatusWord = "ok" | "stale" | "degraded" | "offline";
/**
 * Connector words. A connector reporting `CONNECTOR_OBSERVATION_STALE` has
 * nothing wrong with it: no route of that provider was observed inside the
 * broker's window. That is `stale`, not `degraded`, and the difference is the
 * point — an idle Mac with no registered Codex task must not read as broken.
 */
function connectorWord(connector: PublicConnectorSnapshot): StatusWord {
  if (connector.health === "healthy" || connector.health === "connecting") return "ok";
  if (connector.health === "offline") return "offline";
  return connector.safeErrorCode === "CONNECTOR_OBSERVATION_STALE" ? "stale" : "degraded";
}

/**
 * What a route's row says, and why.
 *
 * A Claude route whose session the latest discovery scan still lists is never
 * `stale`: the scan is fresher evidence than the route's own edge-triggered
 * observation, so the discovered state wins and the last-seen cell says where
 * that came from. Everything else keeps the broker's word until the
 * ten-minute backstop, and only then is called stale.
 */
type RouteView = Readonly<{ word: string; lastSeen: string; remedy?: string }>;
function routeView(
  route: PublicRouteSnapshot, discovered: PublicAvailablePeerSnapshot | undefined, now: number,
): RouteView {
  if (!route.enabled) return { word: "disabled", lastSeen: relativeAge(route.lastSeenAt, now) };
  if (discovered !== undefined) {
    return {
      word: discovered.state === "awaiting_approval" ? "awaiting" : discovered.state,
      lastSeen: `discovered ${spanFor(discovered.lastSeenAt, now)}`,
      ...(discovered.state === "awaiting_approval"
        ? { remedy: "waiting on an approval prompt in that session's own terminal" } : {}),
    };
  }
  const observed = ageMs(route.lastSeenAt, now);
  const beyondBackstop = observed !== undefined && observed > STATUS_ROUTE_STALE_AFTER_MS;
  const word = beyondBackstop ? "stale"
    : route.state === "awaiting_approval" ? "awaiting" : route.state;
  const lastSeen = relativeAge(route.lastSeenAt, now);
  if (word === "awaiting") {
    return { word, lastSeen,
      remedy: `waiting on an approval prompt in that ${route.provider === "codex" ? "Codex task" : "session"}'s own terminal` };
  }
  if (word !== "stale") return { word, lastSeen };
  // Stale, and now the only question that matters: gone, or merely quiet?
  if (route.provider === "codex") {
    // A bare silence is not evidence the task is gone, and neither is the
    // broker's own 35-second word: the succession remedy needs BOTH the
    // ten-minute backstop and a code that says the endpoint itself is gone.
    // Anything less tells operators to retire tasks that are merely busy.
    const gone = beyondBackstop && route.safeErrorCode !== undefined &&
      CODEX_ENDPOINT_GONE_CODES.includes(route.safeErrorCode);
    return { word, lastSeen, remedy: gone
      ? STATUS_REMEDY.THREAD_NOT_OBSERVED ?? ""
      : `not observed for ${spanFor(route.lastSeenAt, now)}; the task may be busy or the app-server slow — run \`embassy check --to ${route.alias}\` to settle it` };
  }
  if (route.provider === "claude") {
    return { word, lastSeen,
      remedy: "that session has exited or renamed; run `embassy refresh`" };
  }
  return { word, lastSeen };
}

const severityRank = (word: StatusWord): number =>
  word === "degraded" || word === "offline" ? 0 : word === "stale" ? 1 : 2;

/**
 * The overall word is informational and derived from the two connectors a
 * message actually travels through. A shell peer never contributes: its
 * mailbox is pull-only, so "nobody is awaiting it" is a fact about the
 * operator's other terminal, not about the broker.
 */
function overallWord(snapshot: GatewayPublicSnapshot): StatusWord {
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
const claudeConnector = (snapshot: GatewayPublicSnapshot): PublicConnectorSnapshot | undefined =>
  snapshot.connectors.find((connector) => connector.provider === "claude");
function collisionCount(snapshot: GatewayPublicSnapshot): number {
  return claudeConnector(snapshot)?.registry?.rejected.find(
    (row) => row.safeErrorCode === "PEER_ALIAS_COLLISION")?.count ?? 0;
}
/**
 * The registry-drift signal: the scan saw records and could not parse a single
 * one into the fields Embassy consumes, and has not since this broker started.
 * That is what a changed Claude Code registry layout looks like from here.
 */
function registryDrifted(snapshot: GatewayPublicSnapshot): boolean {
  const registry = claudeConnector(snapshot)?.registry;
  return registry !== undefined && registry.entriesScanned > 0 &&
    !registry.parseableRecordSeenSinceBoot;
}

type Cell = Readonly<{ value: string; tone?: Tone }>;
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
  shown: SafeGatewayAlert[]; hidden: number; unexplained: number;
} {
  const latest = new Map<string, SafeGatewayAlert>();
  for (const alert of alerts) {
    latest.set(`${alert.code} ${alert.host ?? ""} ${alert.alias ?? ""}`, alert);
  }
  const rows = [...latest.values()].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const explained = rows.filter((alert) => STATUS_REMEDY[alert.code] !== undefined);
  return {
    shown: explained.slice(0, STATUS_CAPS.alerts),
    hidden: Math.max(0, explained.length - STATUS_CAPS.alerts),
    unexplained: rows.length - explained.length,
  };
}

const messageArrow = (event: Readonly<{ sourceAlias: string; targetAlias: string }>): string =>
  `${event.sourceAlias} → ${event.targetAlias}`;

export function renderStatus(
  snapshot: GatewayPublicSnapshot, options: StatusViewOptions,
): string {
  const now = options.now;
  const paint = terminalPainter(options.color);
  const lines: string[] = [];
  const overall = overallWord(snapshot);
  const discoveredByAlias = new Map(snapshot.availablePeers.map((peer) => [peer.alias, peer]));

  const brokerFacts = [
    paint(overall, wordColor(overall)),
    ...(options.pid === undefined ? [] : [`pid ${String(options.pid)}`]),
    `snapshot ${relativeAge(snapshot.generatedAt, now)}`,
  ];
  lines.push(`${paint(`embassy ${options.version}`, "bold")}  broker ${brokerFacts.join(" · ")}`);
  lines.push(paint(`state dir ${options.stateDir}`, "dim"));
  // `status` never rescans — a rescan journals an activity row and performs a
  // passive discovery scan, both of which need the operator to ask. So the
  // header says how old the scan is and offers the command. The scan's own
  // stamp is the newest `availablePeers[].lastSeenAt`: every discovered
  // session is stamped by the scan that found it, whereas the claude
  // connector's `lastSeenAt` also moves on a delivery. With nothing
  // discovered there is no stamp to read, so the line says that rather than
  // inventing an age.
  const scannedAt = snapshot.availablePeers
    .map((peer) => peer.lastSeenAt)
    .filter((stamp): stamp is string => stamp !== undefined)
    .sort().at(-1);
  const scanAge = ageMs(scannedAt, now);
  lines.push(paint(scannedAt === undefined ? "sessions: none discovered"
    : `sessions scanned ${relativeAge(scannedAt, now)}`, "dim") +
    (scanAge === undefined || scanAge > STATUS_SCAN_STALE_AFTER_MS
      ? paint("  — run `embassy refresh` to rescan", "yellow") : ""));

  lines.push("", paint("connectors", "bold"));
  const routedConnectors = snapshot.connectors.filter(
    (connector) => connector.provider === "claude" || connector.provider === "codex");
  if (routedConnectors.length === 0) lines.push("  none — the broker has no provider connectors");
  for (const connector of routedConnectors) {
    const word = connectorWord(connector);
    const suffix = word === "ok" ? "" : `  ${connector.safeErrorCode ?? "no safe code"}`;
    lines.push(`  ${connector.provider.padEnd(7)} ${paint(word, wordColor(word))}${suffix}`);
    if (word !== "ok") lines.push(paint(`          ${connectorRemedy(connector, snapshot)}`, "dim"));
    if (connector.provider === "claude" && registryDrifted(snapshot)) {
      lines.push(paint("          no parseable session record since broker start — Claude Code's registry layout may have changed; run `embassy check`", "yellow"));
    }
  }
  // A registered shell peer is a connector from the operator's side: the route
  // exists, but whether anything is awaiting it lives in another terminal.
  // Queued mail with no waiter is the one observable proof, and it never
  // touches the overall word. Stale first, so the cap can only hide quiet ones.
  const shellPeers = snapshot.routes
    .filter((route) => route.provider === "peer")
    .sort((left, right) => Number(right.queueDepth > 0) - Number(left.queueDepth > 0));
  for (const peer of shellPeers.slice(0, STATUS_CAPS.shellPeers)) {
    const waiting = peer.queueDepth > 0;
    lines.push(`  ${peer.alias} ${waiting
      ? paint("stale (token or await loop gone)", "yellow") : paint("ok", "green")}`);
    if (waiting) {
      lines.push(paint(`          ${String(peer.queueDepth)} message(s) waiting: run \`embassy await --alias ${peer.alias} --token-stdin\` in the shell holding its token, or \`embassy unregister-peer --alias ${peer.alias} --token-stdin\`.`, "dim"));
    }
  }
  if (shellPeers.length > STATUS_CAPS.shellPeers) {
    lines.push(paint(`  ${String(shellPeers.length - STATUS_CAPS.shellPeers)} more shell peer(s) with empty mailboxes`, "dim"));
  }

  lines.push("", paint("sessions", "bold"));
  if (snapshot.availablePeers.length === 0) {
    lines.push("  none discovered — start a Claude Code session, then run `embassy refresh`");
  } else {
    const rows = snapshot.availablePeers.slice(0, STATUS_CAPS.sessions).map((peer): Cell[] => {
      const word = peer.state === "awaiting_approval" ? "awaiting" : peer.state;
      return [{ value: peer.alias }, { value: word, tone: wordColor(word === "offline" ? "offline" : "ok") },
        { value: peer.routed ? "routed" : "no route yet" },
        { value: relativeAge(peer.lastSeenAt, now) }];
    });
    for (const line of table(["session", "state", "route", "last seen"], rows, paint)) {
      lines.push(`  ${line}`);
    }
    if (snapshot.availablePeers.length > STATUS_CAPS.sessions) {
      lines.push(paint(`    ${String(snapshot.availablePeers.length - STATUS_CAPS.sessions)} more discovered session(s) — read \`embassy status --json\``, "dim"));
    }
  }
  const collisions = collisionCount(snapshot);
  if (collisions > 0) {
    lines.push(paint(`    ${String(collisions)} discovered Claude name(s) are shared by more than one live session and are hidden from this list; ${STATUS_REMEDY.PEER_ALIAS_COLLISION ?? ""}`, "yellow"));
  }

  lines.push("", paint("routes", "bold"));
  if (snapshot.routes.length === 0) {
    lines.push("  none — a Claude session's route installs on its first send; a Codex task is registered explicitly");
  } else {
    const views = snapshot.routes.map((route) => ({
      route, view: routeView(route,
        route.provider === "claude" ? discoveredByAlias.get(route.alias) : undefined, now),
    }));
    const rows = views.map(({ route, view }): Cell[] => [
      { value: route.alias }, { value: route.provider },
      { value: view.word, tone: wordColor(view.word === "idle" || view.word === "busy" ? "ok" : view.word) },
      { value: String(route.queueDepth) }, { value: view.lastSeen },
    ]);
    for (const line of table(["alias", "provider", "state", "queue", "last seen"], rows, paint)) {
      lines.push(`  ${line}`);
    }
    for (const { route, view } of views) {
      if (view.remedy === undefined && view.word === "busy" &&
          route.safeErrorCode !== undefined && CLAUDE_BUSY_OBSERVATION_CODES.has(route.safeErrorCode)) {
        lines.push(paint(`    ${route.alias}: ${STATUS_REMEDY[route.safeErrorCode]}`, "dim"));
        continue;
      }
      if (view.remedy === undefined) continue;
      lines.push(paint(`    ${route.alias}: ${view.remedy}`, "dim"));
    }
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

  const { shown, hidden, unexplained } = actionableAlerts(snapshot.alerts);
  if (shown.length > 0) {
    lines.push("", paint("alerts", "bold"));
    for (const alert of shown) {
      const subject = alert.alias ?? alert.host ?? alert.provider ?? "";
      lines.push(`  ${alert.code}${subject === "" ? "" : `  ${subject}`}  ${relativeAge(alert.timestamp, now)}`);
      lines.push(paint(`    ${STATUS_REMEDY[alert.code] ?? ""}`, "dim"));
    }
    if (hidden > 0) lines.push(paint(`  ${String(hidden)} more alert(s) not shown`, "dim"));
    if (unexplained > 0) {
      lines.push(paint(`  ${String(unexplained)} alert(s) with no known remedy — read \`embassy status --json\``, "dim"));
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
 * `watch` state.
 *
 * A message row is identified by `messageIdSuffix`, never by `sequence`: the
 * store re-stamps a message's sequence on every state change, so sequence
 * orders events but does not name one. Memory is bounded by the snapshot
 * itself — the map is rebuilt from each poll's own rows, which the control
 * protocol caps — so a broker watched for a month costs what one watched for a
 * minute costs.
 */
export type WatchState = Readonly<{
  messageStates: ReadonlyMap<string, string>;
  lastSequence: number;
  lastActivitySequence: number;
  truncatedMessages: number;
}>;
export const emptyWatchState: WatchState = Object.freeze({
  messageStates: new Map<string, string>(), lastSequence: -1,
  lastActivitySequence: -1, truncatedMessages: 0,
});
export type WatchEvent =
  | Readonly<{ type: "message"; event: NormalizedMessageEvent }>
  | Readonly<{
      type: "transition"; message: string; timestamp: string; from: string; to: string;
      sourceAlias: string; targetAlias: string; latencyMs?: number; safeErrorCode?: string;
    }>
  | Readonly<{ type: "activity"; event: PublicGatewayActivityEvent }>
  | Readonly<{ type: "notice"; text: string }>;

/**
 * Pure diff of one poll against the last, in stable emit order.
 *
 * A snapshot can carry the same message twice — once as a journaled activity
 * event and once as the live row — so the last occurrence in sequence order is
 * the current state. What this can promise is "at most once per observed
 * change": a transition the broker passed through entirely between two polls
 * is never seen, and rows evicted from the retained window before this tail
 * reached them are reported as a notice rather than silently skipped.
 */
export function diffWatch(
  previous: WatchState, snapshot: GatewayPublicSnapshot,
): Readonly<{ state: WatchState; events: WatchEvent[] }> {
  const events: WatchEvent[] = [];
  const ordered = [...snapshot.messages].sort((left, right) => left.sequence - right.sequence);
  const messageStates = new Map<string, string>();
  const sequences = [...ordered.map((event) => event.sequence),
    ...(snapshot.activityEvents ?? []).map((event) => event.sequence)];
  const lastSequence = sequences.length === 0 ? previous.lastSequence
    : Math.max(previous.lastSequence, ...sequences);
  // Message and activity events share one counter, and settling a message
  // re-stamps it, so an ordinary gap in the numbers proves nothing. Only a
  // jump wider than the whole retained window proves rows were evicted before
  // this tail could read them — that, and truncation, are the honest signals.
  const lowest = sequences.length === 0 ? undefined : Math.min(...sequences);
  const missed = lowest === undefined ? 0 : lowest - previous.lastSequence - 1;
  if (previous.lastSequence >= 0 && missed > gatewayPublicSnapshotLimits.messages) {
    events.push({ type: "notice", text:
      `the retained window advanced past ${String(missed)} event(s) before this tail saw them` });
  }
  if (snapshot.truncation.messages > previous.truncatedMessages) {
    events.push({ type: "notice", text:
      `${String(snapshot.truncation.messages)} message row(s) omitted from this snapshot by the size budget` });
  }
  for (const event of ordered) {
    const before = previous.messageStates.get(event.messageIdSuffix);
    const already = messageStates.get(event.messageIdSuffix);
    messageStates.set(event.messageIdSuffix, event.state);
    if (already === event.state) continue;
    if (before === undefined && already === undefined) {
      events.push({ type: "message", event });
      continue;
    }
    const from = already ?? before!;
    if (from === event.state) continue;
    events.push({
      type: "transition", message: event.messageIdSuffix, timestamp: event.timestamp,
      from, to: event.state, sourceAlias: event.sourceAlias, targetAlias: event.targetAlias,
      ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
      ...(event.safeErrorCode === undefined ? {} : { safeErrorCode: event.safeErrorCode }),
    });
  }
  let lastActivitySequence = previous.lastActivitySequence;
  for (const event of [...(snapshot.activityEvents ?? [])].sort((left, right) => left.sequence - right.sequence)) {
    if (event.sequence <= previous.lastActivitySequence) continue;
    events.push({ type: "activity", event });
    lastActivitySequence = Math.max(lastActivitySequence, event.sequence);
  }
  return {
    state: { messageStates, lastSequence, lastActivitySequence,
      truncatedMessages: snapshot.truncation.messages },
    events,
  };
}

const SETTLED_BADLY = ["failed", "ambiguous", "unconfirmed", "expired", "cancelled", "abandoned", "rejected"];
/** Local wall-clock time, because a tail is read beside other live logs. */
const clockOf = (timestamp: string): string => {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toTimeString().slice(0, 8) : "--:--:--";
};

/** One terminal line per watch event; the activity line is deliberately secondary. */
export function renderWatchEvent(event: WatchEvent, color: boolean): string {
  const paint = terminalPainter(color);
  if (event.type === "notice") return paint(`   note  ${event.text}`, "yellow");
  if (event.type === "message") {
    const preview = event.event.body === undefined
      ? "" : `  ${paint(previewBody(event.event.body, 40), "dim")}`;
    return `${clockOf(event.event.timestamp)}  ${event.event.messageIdSuffix}  ${messageArrow(event.event)}  ${event.event.state}  ${String(event.event.bytes)} B${preview}`;
  }
  if (event.type === "transition") {
    const latency = event.latencyMs === undefined ? "" : ` (${String(event.latencyMs)} ms)`;
    const code = event.safeErrorCode === undefined ? "" : `  ${event.safeErrorCode}`;
    const word = event.to === "delivered" ? paint(event.to, "green")
      : SETTLED_BADLY.includes(event.to) ? paint(event.to, "red") : event.to;
    return `${clockOf(event.timestamp)}  ${event.message}  ${event.from} → ${word}${latency}${code}`;
  }
  const detail = event.event.safeErrorCode === undefined ? "" : `  ${event.event.safeErrorCode}`;
  return paint(`${clockOf(event.event.timestamp)}  ${event.event.action}  ${event.event.aliases.join(", ")}  ${event.event.outcome}${detail}`, "dim");
}
