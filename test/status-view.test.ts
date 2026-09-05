import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  diffWatch,
  emptyWatchState,
  renderStatus,
  renderWatchEvent,
  STATUS_CAPS,
  STATUS_REMEDY,
  STATUS_ROUTE_STALE_AFTER_MS,
  __test,
} from "../src/gateway/status-view.js";
import { EMBASSY_VERSION } from "../src/gateway/cli.js";
import type {
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicAvailablePeerSnapshot,
  PublicConnectorSnapshot,
  PublicRouteSnapshot,
  RouteCounters,
} from "../src/gateway/types.js";

const { connectorWord, overallWord, previewBody, relativeAge, routeView } = __test;

// Every fixture is a literal snapshot: the renderer is pure, so no broker, no
// state directory, and no clock is involved anywhere in this file. That makes
// the whole file platform-independent — it runs identically on ubuntu.
const HOST = "this-mac";
const NOW = "2026-09-02T18:04:11.000Z";
const now = Date.parse(NOW);
const at = (msAgo: number): string => new Date(now - msAgo).toISOString();

/** Fixture overrides may set an optional field back to absent. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };
function prune<T>(value: object): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record as T;
}

const ZERO_COUNTERS: RouteCounters = {
  accepted: 0, delivered: 0, unconfirmed: 0, failed: 0, ambiguous: 0, expired: 0,
  cancelled: 0, abandoned: 0, rejected: 0, bytesAccepted: 0,
};

function connector(
  provider: "claude" | "codex" | "peer", overrides: Overrides<PublicConnectorSnapshot> = {},
): PublicConnectorSnapshot {
  return prune({
    provider, host: HOST, health: "healthy" as const,
    protocol: provider === "claude" ? "claude-native" : provider === "codex" ? "codex-app-server" : "peer-mailbox",
    protocolVersion: "1", lastSeenAt: at(4_000), observationAgeMs: 4_000, ...overrides,
  });
}

function route(
  alias: string, provider: "claude" | "codex" | "peer",
  overrides: Overrides<PublicRouteSnapshot> = {},
): PublicRouteSnapshot {
  return prune({
    alias, provider, host: HOST, enabled: true, state: "idle" as const, busyPolicy: "queue" as const,
    queueDepth: 0, counters: { ...ZERO_COUNTERS }, mutable: true,
    lastSeenAt: at(9_000), ...overrides,
  });
}

function session(
  alias: string, overrides: Overrides<PublicAvailablePeerSnapshot> = {},
): PublicAvailablePeerSnapshot {
  return prune({
    alias, provider: "claude" as const, host: HOST, state: "idle" as const,
    validated: true, routed: true, lastSeenAt: at(4_000), ...overrides,
  });
}

let sequence = 0;
function message(overrides: Overrides<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  sequence += 1;
  return prune({
    sequence, timestamp: at(120_000), messageIdSuffix: "0a1b2c3d",
    direction: "claude_to_codex" as const, sourceAlias: `advisor@${HOST}`,
    targetAlias: `codex-reviewer@${HOST}`, state: "delivered" as const, bytes: 42, latencyMs: 61,
    ...overrides,
  });
}

function snapshot(overrides: Overrides<GatewayPublicSnapshot> = {}): GatewayPublicSnapshot {
  return prune({
    schemaVersion: 2, generatedAt: NOW, health: "healthy",
    connectors: [connector("claude"), connector("codex")],
    availablePeers: [], routes: [], activityEvents: [], messages: [],
    accounting: {
      accepted: 0, duplicates: 0, delivered: 0, unconfirmed: 0, failed: 0, ambiguous: 0,
      expired: 0, cancelled: 0, abandoned: 0, rejected: 0, bytesAccepted: 0, queuedBytes: 0,
    },
    alerts: [],
    truncation: { connectors: 0, availablePeers: 0, routes: 0, activityEvents: 0, messages: 0, alerts: 0 },
    ...overrides,
  });
}

const options = { stateDir: "/private/state/agent-embassy", version: EMBASSY_VERSION, recent: 10, color: false, now };
/** The version as it appears in a header, escaped for the regexes below, so a release bump touches no literal here. */
const VERSION = EMBASSY_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COUNTERS: RouteCounters = { ...ZERO_COUNTERS, accepted: 3, delivered: 3, bytesAccepted: 240 };
const EXAMPLE_MESSAGES: NormalizedMessageEvent[] = [
  { sequence: 11, timestamp: at(300_000), messageIdSuffix: "0a1b2c3d", direction: "claude_to_codex",
    sourceAlias: `advisor@${HOST}`, targetAlias: `codex-reviewer@${HOST}`, state: "delivered",
    bytes: 51, body: "Please review the migration risk before the freeze.", latencyMs: 61 },
  { sequence: 12, timestamp: at(90_000), messageIdSuffix: "1b2c3d4e", direction: "codex_to_claude",
    sourceAlias: `codex-reviewer@${HOST}`, targetAlias: `advisor@${HOST}`, state: "delivered",
    bytes: 62, body: "The risk is the double-write window; I would gate it behind a flag.", latencyMs: 210 },
  { sequence: 13, timestamp: at(12_000), messageIdSuffix: "2c3d4e5f", direction: "claude_to_codex",
    sourceAlias: `advisor@${HOST}`, targetAlias: `codex-reviewer@${HOST}`, state: "queued", bytes: 34 },
];

/** The exact snapshot the README's first `status` block is rendered from. */
export const HEALTHY_FIXTURE = snapshot({
  availablePeers: [session(`advisor@${HOST}`, { state: "busy", lastSeenAt: at(3_000) })],
  routes: [
    route(`advisor@${HOST}`, "claude", { state: "busy", queueDepth: 2, oldestQueuedAt: at(40_000), lastSeenAt: at(3_000) }),
    route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(12_000), counters: COUNTERS }),
  ],
  messages: EXAMPLE_MESSAGES,
});

/** …and the second. */
export const DEGRADED_FIXTURE = snapshot({
  health: "degraded",
  connectors: [connector("claude"), connector("codex", {
    health: "degraded", safeErrorCode: "MANAGED_CODEX_UNAVAILABLE" })],
  availablePeers: [session(`advisor@${HOST}`, { state: "busy", lastSeenAt: at(3_000) })],
  routes: [
    route(`advisor@${HOST}`, "claude", { state: "busy", queueDepth: 2, oldestQueuedAt: at(40_000), lastSeenAt: at(3_000) }),
    route(`codex-reviewer@${HOST}`, "codex", { state: "stale", safeErrorCode: "THREAD_NOT_OBSERVED",
      queueDepth: 1, oldestQueuedAt: at(60_000), lastSeenAt: at(1_800_000), counters: COUNTERS }),
    route(`peer-release@${HOST}`, "peer", { queueDepth: 2, oldestQueuedAt: at(120_000), lastSeenAt: undefined }),
  ],
  messages: EXAMPLE_MESSAGES,
  alerts: [{ code: "PEER_TUNNEL_UNAVAILABLE", severity: "warning", timestamp: at(45_000), host: "studio" }],
});

/** Exported with the fixtures so the README blocks can be regenerated from them. */
export const README_OPTIONS = {
  stateDir: "/Users/you/.local/state/agent-embassy", version: EMBASSY_VERSION,
  recent: 3, color: false, now, pid: 41213,
};

test("the README's two status examples are exactly what the renderer prints", async () => {
  const readme = await readFile(path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
  const fenced = [...readme.matchAll(/```text\n(embassy [^\n]*broker [\s\S]*?)```/g)]
    .map((found) => found[1]!);
  assert.equal(fenced.length, 2, "README must carry exactly the two captured status examples");
  assert.equal(fenced[0], renderStatus(HEALTHY_FIXTURE, README_OPTIONS));
  assert.equal(fenced[1], renderStatus(DEGRADED_FIXTURE, README_OPTIONS));
});

test("a healthy snapshot renders one broker line, connectors, sessions, routes, and bodies", () => {
  const rendered = renderStatus(HEALTHY_FIXTURE, { ...options, pid: 41213 });
  assert.match(rendered, new RegExp(`^embassy ${VERSION} {2}broker ok · pid 41213 · snapshot just now\n`));
  assert.match(rendered, /^state dir \/private\/state\/agent-embassy$/m);
  assert.match(rendered, /^sessions scanned 3s ago$/m);
  assert.match(rendered, /^ {2}claude {2}ok$/m);
  assert.match(rendered, /^ {2}codex {3}ok$/m);
  assert.match(rendered, /^ {2}session {2,}state {2,}route {2,}last seen$/m);
  assert.match(rendered, /^ {2}advisor@this-mac {2,}busy {2,}routed {2,}3s ago$/m);
  assert.match(rendered, /^ {2}advisor@this-mac {2,}claude {2,}busy {2,}2 {2,}discovered 3s$/m);
  assert.match(rendered, /^ {2}codex-reviewer@this-mac {2,}codex {2,}idle {2,}0 {2,}12s ago$/m);
  assert.match(rendered, /^recent \(3 of 3\)$/m);
  assert.match(rendered, /Please review the migration risk before the freeze\./);
  assert.doesNotMatch(rendered, /^alerts$/m);
  assert.equal(rendered.includes("\u001b"), false);
});

test("the header dates the scan from the sessions it found, and never rescans itself", () => {
  const fresh = renderStatus(snapshot({
    availablePeers: [session(`advisor@${HOST}`, { lastSeenAt: at(30_000) })] }), options);
  assert.match(fresh, /^sessions scanned 30s ago$/m);
  assert.doesNotMatch(fresh, /embassy refresh` to rescan/);

  // The newest session stamp is the scan's. The claude connector's own
  // `lastSeenAt` also moves on a delivery, so it is not consulted at all.
  const two = renderStatus(snapshot({
    connectors: [connector("claude", { lastSeenAt: at(1_000) }), connector("codex")],
    availablePeers: [session(`a@${HOST}`, { lastSeenAt: at(300_000) }), session(`b@${HOST}`, { lastSeenAt: at(120_000) })],
  }), options);
  assert.match(two, /^sessions scanned 2m ago {2}— run `embassy refresh` to rescan$/m);

  // Nothing discovered: there is no stamp to read, so no age is invented.
  const none = renderStatus(snapshot(), options);
  assert.match(none, /^sessions: none discovered {2}— run `embassy refresh` to rescan$/m);
});

test("the sessions block shows what can be addressed, routed or not", () => {
  const rendered = renderStatus(snapshot({
    availablePeers: [
      session(`advisor@${HOST}`),
      session(`scribe@${HOST}`, { routed: false, state: "awaiting_approval", lastSeenAt: at(20_000) }),
    ],
  }), options);
  assert.match(rendered, /^ {2}advisor@this-mac {2,}idle {2,}routed {2,}4s ago$/m);
  assert.match(rendered, /^ {2}scribe@this-mac {2,}awaiting {2,}no route yet {2,}20s ago$/m);

  const empty = renderStatus(snapshot(), options);
  assert.match(empty, /^ {2}none discovered — start a Claude Code session, then run `embassy refresh`$/m);
});

test("a degraded Codex connector names its code, both causes, and sets the overall word", () => {
  const rendered = renderStatus(DEGRADED_FIXTURE, options);
  assert.match(rendered, new RegExp(`^embassy ${VERSION} {2}broker degraded · snapshot just now$`, "m"));
  assert.match(rendered, /^ {2}codex {3}degraded {2}MANAGED_CODEX_UNAVAILABLE$/m);
  assert.ok(rendered.includes(STATUS_REMEDY.MANAGED_CODEX_UNAVAILABLE!));
  assert.match(rendered, /holds the managed Codex control socket/);
  // The second cause points at the README's install line, not at `daemon start`.
  assert.match(rendered, /the managed App Server standalone layout is missing/);
  assert.match(rendered, /follow the Codex prerequisite in the README/);
  assert.doesNotMatch(rendered, /run `codex app-server daemon start`/);
  assert.equal(overallWord(DEGRADED_FIXTURE), "degraded");
});

test("an unobserved connector is stale, not degraded, and says which stale it is", () => {
  const noCodexTask = snapshot({
    connectors: [connector("claude"), connector("codex", {
      health: "degraded", safeErrorCode: "CONNECTOR_OBSERVATION_STALE" })],
  });
  const rendered = renderStatus(noCodexTask, options);
  assert.match(rendered, /^ {2}codex {3}stale {2}CONNECTOR_OBSERVATION_STALE$/m);
  assert.match(rendered, /No Codex task is registered\. Run `embassy register-codex/);
  assert.equal(overallWord(noCodexTask), "stale");

  const registered = snapshot({
    connectors: noCodexTask.connectors, routes: [route(`codex-reviewer@${HOST}`, "codex")],
  });
  assert.match(renderStatus(registered, options), /run `embassy check` to test the round trip/);
});

test("a stale shell-peer mailbox is reported without degrading the overall word", () => {
  const waiting = snapshot({
    routes: [route(`peer-reviewer@${HOST}`, "peer", { queueDepth: 3, oldestQueuedAt: at(60_000), lastSeenAt: undefined })],
  });
  const rendered = renderStatus(waiting, options);
  assert.match(rendered, /^ {2}peer-reviewer@this-mac stale \(token or await loop gone\)$/m);
  assert.match(rendered, /3 message\(s\) waiting: run `embassy await --alias peer-reviewer@this-mac --token-stdin`/);
  assert.equal(overallWord(waiting), "ok");
  assert.match(rendered, new RegExp(`^embassy ${VERSION} {2}broker ok`, "m"));

  const quiet = snapshot({ routes: [route(`peer-reviewer@${HOST}`, "peer", { lastSeenAt: undefined })] });
  assert.match(renderStatus(quiet, options), /^ {2}peer-reviewer@this-mac ok$/m);
});

test("the succession remedy needs both the backstop and a code that says the task is gone", () => {
  const beyond = at(STATUS_ROUTE_STALE_AFTER_MS + 60_000);
  // Silence alone — the broker calls a route stale after 35 s, which the
  // Codex observer's single slot crosses routinely. Never tell an operator to
  // retire a task on that evidence.
  const quiet = renderStatus(snapshot({ routes: [
    route(`codex-reviewer@${HOST}`, "codex", { state: "stale", lastSeenAt: beyond })] }), options);
  assert.match(quiet, /not observed for 11m; the task may be busy or the app-server slow — run `embassy check --to codex-reviewer@this-mac` to settle it/);
  assert.doesNotMatch(quiet, /--succeeds/);

  // The endpoint-gone code, past the backstop: now it is earned.
  const gone = renderStatus(snapshot({ routes: [
    route(`codex-reviewer@${HOST}`, "codex", { state: "stale", safeErrorCode: "THREAD_NOT_OBSERVED", lastSeenAt: beyond })] }), options);
  assert.match(gone, /^ {4}codex-reviewer@this-mac: That Codex task is gone\. Run `embassy register-codex --alias <new-alias> --succeeds <this alias>`/m);

  // The same code inside the backstop is a broker word, not a verdict.
  const recent = renderStatus(snapshot({ routes: [
    route(`codex-reviewer@${HOST}`, "codex", { state: "stale", safeErrorCode: "THREAD_NOT_OBSERVED", lastSeenAt: at(40_000) })] }), options);
  assert.doesNotMatch(recent, /--succeeds/);
  assert.match(recent, /^ {2}codex-reviewer@this-mac {2,}codex {2,}stale/m);
});

test("a Claude route the latest scan still lists is never stale", () => {
  const alias = `advisor@${HOST}`;
  const stale = route(alias, "claude", { state: "stale", lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS + 60_000) });
  const seen = renderStatus(snapshot({
    availablePeers: [session(alias, { state: "busy", lastSeenAt: at(2_000) })], routes: [stale],
  }), options);
  assert.match(seen, /^ {2}advisor@this-mac {2,}claude {2,}busy {2,}0 {2,}discovered 2s$/m);
  assert.doesNotMatch(seen, /exited or renamed/);

  // The same route with the session gone from the scan earns the honest line.
  const unseen = renderStatus(snapshot({ routes: [stale] }), options);
  assert.match(unseen, /^ {2}advisor@this-mac {2,}claude {2,}stale/m);
  assert.match(unseen, /^ {4}advisor@this-mac: that session has exited or renamed; run `embassy refresh`$/m);
  assert.equal(routeView(stale, undefined, now).word, "stale");
  assert.equal(routeView(stale, session(alias), now).word, "idle");
});

test("an awaiting route says where the approval prompt is", () => {
  const rendered = renderStatus(snapshot({ routes: [
    route(`codex-reviewer@${HOST}`, "codex", { state: "awaiting_approval" })] }), options);
  assert.match(rendered, /^ {2}codex-reviewer@this-mac {2,}codex {2,}awaiting/m);
  assert.match(rendered, /waiting on an approval prompt in that Codex task's own terminal$/m);
});

test("a route unobservable for more than ten minutes is stale whatever the broker called it", () => {
  const fresh = route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS - 1_000) });
  const old = route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS + 1_000) });
  assert.equal(routeView(fresh, undefined, now).word, "idle");
  assert.equal(routeView(old, undefined, now).word, "stale");
  // A route never observed keeps the broker's word: absence of an observation
  // is not evidence of an age.
  assert.equal(routeView(route(`peer-x@${HOST}`, "peer", { lastSeenAt: undefined }), undefined, now).word, "idle");
  assert.equal(routeView(route(`peer-x@${HOST}`, "peer", { enabled: false }), undefined, now).word, "disabled");
});

test("a filtered alias collision is reported as a count with the CLI's own remedy", () => {
  const colliding = snapshot({
    connectors: [
      connector("claude", { registry: {
        entriesScanned: 4, parseableRecords: 4, parseableRecordSeenSinceBoot: true,
        rejected: [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 2 }], rejectedCodesOmitted: 0 } }),
      connector("codex"),
    ],
    availablePeers: [session(`advisor-1a2b3c4d@${HOST}`)],
    routes: [route(`advisor-1a2b3c4d@${HOST}`, "claude")],
  });
  const rendered = renderStatus(colliding, options);
  assert.match(rendered, /^ {4}2 discovered Claude name\(s\) are shared by more than one live session and are hidden from this list; the alias names more than one live session; rename one, or address the session by UUID with --to <session-uuid>\.$/m);
  // The disambiguated alias is shown exactly as the broker minted it.
  assert.match(rendered, /^ {2}advisor-1a2b3c4d@this-mac/m);
});

test("registry drift is named the moment nothing parses", () => {
  const drifted = snapshot({
    connectors: [connector("claude", { registry: {
      entriesScanned: 3, parseableRecords: 0, parseableRecordSeenSinceBoot: false,
      rejected: [], rejectedCodesOmitted: 0 } }), connector("codex")],
  });
  assert.match(renderStatus(drifted, options),
    /no parseable session record since broker start — Claude Code's registry layout may have changed; run `embassy check`/);

  // An empty registry is not drift: nothing was scanned, so nothing failed.
  const emptyRegistry = snapshot({
    connectors: [connector("claude", { registry: {
      entriesScanned: 0, parseableRecords: 0, parseableRecordSeenSinceBoot: false,
      rejected: [], rejectedCodesOmitted: 0 } }), connector("codex")],
  });
  assert.doesNotMatch(renderStatus(emptyRegistry, options), /registry layout may have changed/);
});

test("only alerts with a remedy are shown, deduplicated, and every cap says what it hid", () => {
  const noisy = snapshot({
    alerts: [
      { code: "PEER_TUNNEL_UNAVAILABLE", severity: "warning", timestamp: at(300_000), host: "peer2" },
      { code: "PEER_TUNNEL_UNAVAILABLE", severity: "warning", timestamp: at(30_000), host: "peer2" },
      { code: "SOMETHING_WE_HAVE_NO_REMEDY_FOR", severity: "warning", timestamp: at(10_000) },
    ],
  });
  const rendered = renderStatus(noisy, options);
  assert.equal(rendered.match(/PEER_TUNNEL_UNAVAILABLE/g)?.length, 1);
  assert.match(rendered, /^ {2}PEER_TUNNEL_UNAVAILABLE {2}peer2 {2}30s ago$/m);
  assert.ok(rendered.includes(STATUS_REMEDY.PEER_TUNNEL_UNAVAILABLE!));
  assert.doesNotMatch(rendered, /SOMETHING_WE_HAVE_NO_REMEDY_FOR/);
  assert.match(rendered, /^ {2}1 alert\(s\) with no known remedy/m);

  // Over the cap, the count is printed rather than the rows silently dropped.
  const codes = ["PEER_TUNNEL_UNAVAILABLE", "PEER_DIAL_FAILED", "PEER_PROTOCOL_MISMATCH",
    "ROUTE_UNOBSERVED", "GATEWAY_WAKE_FAILED", "DISPATCH_RUNNER_FAILED",
    "CLAUDE_INGRESS_REJECTED", "CLAUDE_REPLY_REJECTED"] as const;
  const many = renderStatus(snapshot({ alerts: codes.map((code, index) => ({
    code, severity: "warning" as const, timestamp: at(1_000 * (index + 1)), host: `node${String(index)}` })) }), options);
  assert.equal(many.match(/^ {2}[A-Z_]+ {2}node/gm)?.length, STATUS_CAPS.alerts);
  assert.match(many, new RegExp(`^ {2}${String(codes.length - STATUS_CAPS.alerts)} more alert\\(s\\) not shown$`, "m"));
});

test("the shell-peer cap hides only quiet peers, and says how many", () => {
  const peers = Array.from({ length: STATUS_CAPS.shellPeers + 2 }, (_, index) =>
    route(`peer-${String(index)}x@${HOST}`, "peer",
      { lastSeenAt: undefined, ...(index === STATUS_CAPS.shellPeers + 1
        ? { queueDepth: 4, oldestQueuedAt: at(30_000) } : {}) }));
  const rendered = renderStatus(snapshot({ routes: peers }), options);
  // The one stuck peer sorts to the front and survives the cap.
  assert.match(rendered, new RegExp(`^ {2}peer-${String(STATUS_CAPS.shellPeers + 1)}x@this-mac stale \\(token or await loop gone\\)$`, "m"));
  assert.match(rendered, /^ {2}2 more shell peer\(s\) with empty mailboxes$/m);
});

test("the session cap says how many it hid", () => {
  const sessions = Array.from({ length: STATUS_CAPS.sessions + 3 }, (_, index) =>
    session(`s${String(index)}@${HOST}`));
  const rendered = renderStatus(snapshot({ availablePeers: sessions }), options);
  assert.match(rendered, /^ {4}3 more discovered session\(s\) — read `embassy status --json`$/m);
});

test("a truncated snapshot says what it dropped", () => {
  const rendered = renderStatus(snapshot({
    truncation: { connectors: 0, availablePeers: 3, routes: 0, activityEvents: 0, messages: 120, alerts: 0 },
  }), options);
  assert.match(rendered, /^omitted from this snapshot: 3 availablePeers, 120 messages$/m);
});

test("an empty broker explains what to do instead of showing an empty frame", () => {
  const rendered = renderStatus(snapshot({ connectors: [], health: "offline" }), options);
  assert.match(rendered, /broker offline/);
  assert.match(rendered, /none — the broker has no provider connectors/);
  assert.match(rendered, /none — a Claude session's route installs on its first send/);
  assert.match(rendered, /no messages retained/);
});

test("--recent selects the newest rows, newest first", () => {
  const many = snapshot({
    messages: [1, 2, 3, 4, 5].map((index) => message({
      sequence: index, bytes: index, messageIdSuffix: `0000000${String(index)}`, body: `body ${String(index)}` })),
  });
  const rendered = renderStatus(many, { ...options, recent: 2 });
  assert.match(rendered, /^recent \(2 of 5\)$/m);
  const bodies = [...rendered.matchAll(/body (\d)/g)].map((found) => found[1]);
  assert.deepEqual(bodies, ["5", "4"]);
});

test("a body preview is one line, free of control and formatting characters, and bounded", () => {
  const hostile = `alert\u0007\u001b[31mred\u001b[0m\u202ereversed\u200b\u200d\nsecond line\t${"x".repeat(200)}`;
  const preview = previewBody(hostile);
  assert.equal(preview.includes("\u001b"), false);
  assert.equal(/\p{Cf}/u.test(preview), false);
  assert.equal(preview.includes("\n"), false);
  assert.equal([...preview].length, 60);
  assert.ok(preview.endsWith("…"));
  const rendered = renderStatus(snapshot({ messages: [message({ body: hostile })] }), options);
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(/\p{Cf}/u.test(rendered), false);
});

test("colour is opt-in, carries no meaning alone, and keeps the table aligned", () => {
  const plain = renderStatus(DEGRADED_FIXTURE, options);
  const painted = renderStatus(DEGRADED_FIXTURE, { ...options, color: true });
  assert.equal(plain.includes("\u001b"), false);
  assert.ok(painted.includes("\u001b[31mdegraded\u001b[0m"));
  // Stripping every escape from the coloured render reproduces the plain one:
  // colour adds emphasis, never information — and never width.
  assert.equal(painted.replaceAll(/\u001b\[\d+m/g, ""), plain);
});

test("rendered busy Claude rows show observation remedies without overriding other states", () => {
  const alias = `advisor@${HOST}`;
  const cases: Array<{ overrides: Overrides<PublicRouteSnapshot>; discovered?: "idle" | "busy";
    word: string; show?: boolean; fallback?: string }> = [
    { overrides: { state: "busy" }, word: "busy", show: true },
    { overrides: { state: "idle" }, discovered: "busy", word: "busy", show: true },
    { overrides: { state: "busy" }, discovered: "idle", word: "idle" },
    { overrides: { state: "busy", lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS + 1_000) },
      word: "stale", fallback: "that session has exited or renamed" },
    { overrides: { state: "awaiting_approval" }, word: "awaiting", fallback: "waiting on an approval prompt" },
    { overrides: { state: "busy", enabled: false }, word: "disabled" },
  ];
  for (const safeErrorCode of ["CLAUDE_PEER_WORKSPACE_UNATTESTED", "CLAUDE_PEER_NOT_OBSERVED"]) {
    for (const current of cases) {
      const rendered = renderStatus(snapshot({
        routes: [route(alias, "claude", { safeErrorCode, ...current.overrides })],
        availablePeers: current.discovered === undefined ? [] : [session(alias, { state: current.discovered })],
      }), options);
      assert.match(rendered, new RegExp(`^  ${alias} +claude +${current.word} `, "m"));
      assert.equal(rendered.includes(STATUS_REMEDY[safeErrorCode]!), current.show === true, `${safeErrorCode}/${current.word}`);
      if (current.fallback !== undefined) assert.ok(rendered.includes(current.fallback));
    }
  }
});

test("every remedy the renderer can reach is reachable, and the shared one cannot drift", async () => {
  // The comment on STATUS_REMEDY claims this pin exists; here it is.
  const cli = await readFile(path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "src", "gateway", "cli.ts"), "utf8");
  const hint = /aliasCollision:\n\s*"([^"]+)",/.exec(cli)?.[1];
  assert.equal(hint, STATUS_REMEDY.PEER_ALIAS_COLLISION);

  // No entry in the table is unreachable: each is rendered by a connector, a
  // route, an alert, or the collision line.
  const reachable = new Set<string>(["MANAGED_CODEX_UNAVAILABLE", "PEER_ALIAS_COLLISION",
    "THREAD_NOT_OBSERVED"]);
  for (const code of Object.keys(STATUS_REMEDY)) {
    if (reachable.has(code)) continue;
    const asAlert = renderStatus(snapshot({
      alerts: [{ code, severity: "warning", timestamp: at(1_000) }] }), options);
    const asConnector = renderStatus(snapshot({
      connectors: [connector("codex", { health: "degraded", safeErrorCode: code })] }), options);
    assert.ok(asAlert.includes(STATUS_REMEDY[code]!) || asConnector.includes(STATUS_REMEDY[code]!), code);
  }
});

test("connector and relative-age vocabulary stays closed", () => {
  assert.equal(connectorWord(connector("claude")), "ok");
  assert.equal(connectorWord(connector("claude", { health: "connecting" })), "ok");
  assert.equal(connectorWord(connector("claude", { health: "offline" })), "offline");
  assert.equal(connectorWord(connector("claude", { health: "degraded" })), "degraded");
  assert.equal(relativeAge(undefined, now), "never");
  assert.equal(relativeAge("not a date", now), "unknown");
  assert.equal(relativeAge(at(0), now), "just now");
  assert.equal(relativeAge(at(45_000), now), "45s ago");
  assert.equal(relativeAge(at(120_000), now), "2m ago");
  assert.equal(relativeAge(at(3 * 3_600_000), now), "3h ago");
  assert.equal(relativeAge(at(5 * 86_400_000), now), "5d ago");
  // A timestamp from the future is never a negative age.
  assert.equal(relativeAge(at(-60_000), now), "just now");
});

test("watch identifies a message by its id, not by a sequence the store re-stamps", () => {
  // The store advances `eventSequence` on every state change and re-stamps the
  // message with it, so the same message arrives under a new sequence when it
  // settles. Keyed by sequence, that read as a brand-new row.
  const queued = message({ sequence: 7, messageIdSuffix: "aaaa1111", state: "queued", latencyMs: undefined });
  const first = diffWatch(emptyWatchState, snapshot({ messages: [queued] }));
  assert.equal(first.state.lastSequence, 7);

  const second = diffWatch(first.state, snapshot({
    messages: [
      { ...queued, sequence: 9, state: "delivered", latencyMs: 61 },
      message({ sequence: 10, messageIdSuffix: "bbbb2222", state: "queued", latencyMs: undefined, bytes: 12 }),
    ],
    activityEvents: [{
      sequence: 11, timestamp: at(1_000), kind: "registration", action: "claude_route_installed",
      outcome: "accepted", aliases: [`advisor@${HOST}`], operatorAction: true,
    }],
  }));
  assert.deepEqual(second.events.map((event) => event.type), ["transition", "message", "activity"]);
  const lines = second.events.map((event) => renderWatchEvent(event, false));
  const clock = new Date(now - 120_000).toTimeString().slice(0, 8);
  assert.equal(lines[0], `${clock}  aaaa1111  queued → delivered (61 ms)`);
  assert.match(lines[1]!, /^\d\d:\d\d:\d\d {2}bbbb2222 {2}advisor@this-mac → codex-reviewer@this-mac {2}queued {2}12 B$/);
  assert.match(lines[2]!, /^\d\d:\d\d:\d\d {2}claude_route_installed {2}advisor@this-mac {2}accepted$/);

  // Re-polling an unchanged snapshot emits nothing, and the tracked state
  // never grows past the rows the snapshot itself carries.
  const repeat = diffWatch(second.state, snapshot({
    messages: [{ ...queued, sequence: 9, state: "delivered", latencyMs: 61 }] }));
  assert.deepEqual(repeat.events, []);
  assert.equal(repeat.state.messageStates.size, 1);
});

test("a message that appears twice in one snapshot settles to its latest row", () => {
  // A snapshot merges journaled activity with the live row, so the same
  // message can be present twice; the higher sequence is the current state.
  const base = message({ messageIdSuffix: "cccc3333", state: "queued", latencyMs: undefined });
  const diff = diffWatch(emptyWatchState, snapshot({ messages: [
    { ...base, sequence: 4 }, { ...base, sequence: 5, state: "delivered", latencyMs: 30 }] }));
  assert.deepEqual(diff.events.map((event) => event.type), ["message", "transition"]);
  assert.equal(diff.state.messageStates.get("cccc3333"), "delivered");
});

test("watch reports what it could not see rather than skipping it", () => {
  const seeded = diffWatch(emptyWatchState, snapshot({
    messages: [message({ sequence: 3, messageIdSuffix: "dddd4444", state: "queued", latencyMs: undefined })] }));
  const jumped = diffWatch(seeded.state, snapshot({
    messages: [message({ sequence: 40_000, messageIdSuffix: "eeee5555" })],
    truncation: { connectors: 0, availablePeers: 0, routes: 0, activityEvents: 0, messages: 7, alerts: 0 },
  }));
  const notices = jumped.events.filter((event) => event.type === "notice");
  assert.equal(notices.length, 2);
  assert.equal(renderWatchEvent(notices[0]!, false),
    "   note  the retained window advanced past 39996 event(s) before this tail saw them");
  assert.equal(renderWatchEvent(notices[1]!, false),
    "   note  7 message row(s) omitted from this snapshot by the size budget");
  // The same truncation on the next poll is not re-announced.
  assert.deepEqual(diffWatch(jumped.state, snapshot({
    messages: [message({ sequence: 40_000, messageIdSuffix: "eeee5555" })],
    truncation: { connectors: 0, availablePeers: 0, routes: 0, activityEvents: 0, messages: 7, alerts: 0 },
  })).events, []);
});

test("a settlement that went badly is named, with its safe code", () => {
  const queued = message({ sequence: 4, messageIdSuffix: "ffff6666", state: "queued", latencyMs: undefined });
  const before = diffWatch(emptyWatchState, snapshot({ messages: [queued] }));
  const after = diffWatch(before.state, snapshot({ messages: [
    { ...queued, sequence: 5, state: "unconfirmed", latencyMs: 900, safeErrorCode: "DELIVERY_UNCONFIRMED" }] }));
  const clock = new Date(now - 120_000).toTimeString().slice(0, 8);
  assert.equal(renderWatchEvent(after.events[0]!, false),
    `${clock}  ffff6666  queued → unconfirmed (900 ms)  DELIVERY_UNCONFIRMED`);
});
