import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorWord,
  overallWord,
  previewBody,
  relativeAge,
  renderStatus,
  renderWatchEvent,
  routeWord,
  diffWatch,
  emptyWatchState,
  STATUS_REMEDY,
  STATUS_ROUTE_STALE_AFTER_MS,
} from "../src/gateway/status-view.js";
import type {
  GatewayPublicSnapshot,
  NormalizedMessageEvent,
  PublicConnectorSnapshot,
  PublicRouteSnapshot,
  RouteCounters,
} from "../src/gateway/types.js";

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

const options = { stateDir: "/private/state/agent-embassy", version: "2.0.1", recent: 10, color: false, now };

/** The fixture the README's "See it" example is captured from. */
export const HEALTHY_FIXTURE = snapshot({
  routes: [
    route(`advisor@${HOST}`, "claude", { state: "busy", queueDepth: 2, lastSeenAt: at(3_000) }),
    route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(12_000) }),
  ],
  messages: [
    message({ state: "delivered", timestamp: at(300_000), body: "Please review the migration risk before the freeze." }),
    message({ state: "queued", timestamp: at(60_000), latencyMs: undefined, body: "Working on it." }),
  ],
});

test("a healthy snapshot renders one broker line, both connectors, routes, and recent bodies", () => {
  const rendered = renderStatus(HEALTHY_FIXTURE, { ...options, pid: 41213 });
  assert.match(rendered, /^embassy 2\.0\.1 {2}broker ok · pid 41213 · snapshot just now\n/);
  assert.match(rendered, /^state dir \/private\/state\/agent-embassy$/m);
  assert.match(rendered, /^ {2}claude {2}ok$/m);
  assert.match(rendered, /^ {2}codex {3}ok$/m);
  assert.match(rendered, /^ {2}alias {2,} +provider {2}state {2}queue {2}last seen$/m);
  assert.match(rendered, /^ {2}advisor@this-mac {2,}claude {2,}busy {2,}2 {2,}3s ago$/m);
  assert.match(rendered, /^ {2}codex-reviewer@this-mac {2,}codex {2,}idle {2,}0 {2,}12s ago$/m);
  assert.match(rendered, /^recent \(2 of 2\)$/m);
  assert.match(rendered, /^ {2}5m ago {4} +advisor@this-mac → codex-reviewer@this-mac {2}delivered {2}61 ms$/m);
  assert.match(rendered, /Please review the migration risk before the freeze\./);
  // No remedy prose anywhere: nothing is wrong.
  assert.doesNotMatch(rendered, /alerts/);
  assert.equal(rendered.includes("\u001b"), false);
});

test("a degraded Codex connector names its code and its remedy, and sets the overall word", () => {
  const degraded = snapshot({
    health: "degraded",
    connectors: [connector("claude"), connector("codex", {
      health: "degraded", safeErrorCode: "MANAGED_CODEX_UNAVAILABLE" })],
    routes: [route(`codex-reviewer@${HOST}`, "codex")],
  });
  const rendered = renderStatus(degraded, options);
  assert.match(rendered, /^embassy 2\.0\.1 {2}broker degraded · snapshot just now$/m);
  assert.match(rendered, /^ {2}codex {3}degraded {2}MANAGED_CODEX_UNAVAILABLE$/m);
  assert.ok(rendered.includes(STATUS_REMEDY.MANAGED_CODEX_UNAVAILABLE!));
  assert.equal(overallWord(degraded), "degraded");
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

  // The same code with a task registered is a different sentence.
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
  assert.match(rendered, /^embassy 2\.0\.1 {2}broker ok/m);

  // A shell peer with an empty mailbox is simply ok.
  const quiet = snapshot({ routes: [route(`peer-reviewer@${HOST}`, "peer", { lastSeenAt: undefined })] });
  assert.match(renderStatus(quiet, options), /^ {2}peer-reviewer@this-mac ok$/m);
});

test("an orphaned Codex registration carries the succession remedy the dashboard used to", () => {
  const orphaned = snapshot({
    routes: [route(`codex-reviewer@${HOST}`, "codex", {
      state: "stale", safeErrorCode: "THREAD_NOT_OBSERVED", lastSeenAt: at(40_000) })],
  });
  const rendered = renderStatus(orphaned, options);
  assert.match(rendered, /^ {2}codex-reviewer@this-mac {2,}codex {2,}stale/m);
  assert.match(rendered, /^ {4}codex-reviewer@this-mac: That Codex task is gone\. Run `embassy register-codex --alias <new-alias> --succeeds <this alias>`/m);
});

test("a route unobservable for more than ten minutes is stale whatever the broker called it", () => {
  const fresh = route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS - 1_000) });
  const old = route(`codex-reviewer@${HOST}`, "codex", { lastSeenAt: at(STATUS_ROUTE_STALE_AFTER_MS + 1_000) });
  assert.equal(routeWord(fresh, now), "idle");
  assert.equal(routeWord(old, now), "stale");
  // A route that was never observed keeps the broker's word: absence of an
  // observation is not evidence of an age.
  assert.equal(routeWord(route(`peer-x@${HOST}`, "peer", { lastSeenAt: undefined }), now), "idle");
  assert.equal(routeWord(route(`peer-x@${HOST}`, "peer", { enabled: false }), now), "disabled");
  // The ten-minute backstop reaches the orphan remedy on its own.
  assert.match(renderStatus(snapshot({ routes: [old] }), options), /That Codex task is gone\./);
});

test("a filtered alias collision is reported as a count, because the name is not in the snapshot", () => {
  const colliding = snapshot({
    connectors: [
      connector("claude", { registry: {
        entriesScanned: 4, parseableRecords: 4, parseableRecordSeenSinceBoot: true,
        rejected: [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 2 }], rejectedCodesOmitted: 0 } }),
      connector("codex"),
    ],
    routes: [route(`advisor-1a2b3c4d@${HOST}`, "claude")],
  });
  const rendered = renderStatus(colliding, options);
  assert.match(rendered, /^ {4}2 discovered Claude name\(s\) are shared by more than one live session and are hidden from this list; address those sessions by UUID\./m);
  // The disambiguated alias is shown exactly as the broker minted it.
  assert.match(rendered, /^ {2}advisor-1a2b3c4d@this-mac/m);
});

test("only alerts with a remedy are shown, deduplicated, and the rest are counted", () => {
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
  assert.match(rendered, /1 alert\(s\) with no known remedy/);
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

test("a refused rescan is reported in the header rather than failing the view", () => {
  const rendered = renderStatus(snapshot(), { ...options, refreshFailure: "unavailable" });
  assert.match(rendered, /^the rescan for Claude sessions did not run \(unavailable\); names below may be out of date$/m);
});

test("--recent selects the newest rows, newest first", () => {
  const many = snapshot({
    messages: [1, 2, 3, 4, 5].map((index) => message({ sequence: index, bytes: index, body: `body ${String(index)}` })),
  });
  const rendered = renderStatus(many, { ...options, recent: 2 });
  assert.match(rendered, /^recent \(2 of 5\)$/m);
  const bodies = [...rendered.matchAll(/body (\d)/g)].map((found) => found[1]);
  assert.deepEqual(bodies, ["5", "4"]);
});

test("a body preview is one line, control-free, and bounded", () => {
  const hostile = `alert\u0007\u001b[31mred\u001b[0m\nsecond line\t${"x".repeat(200)}`;
  const preview = previewBody(hostile);
  assert.equal(preview.includes("\u001b"), false);
  assert.equal(preview.includes("\n"), false);
  assert.equal([...preview].length, 60);
  assert.ok(preview.endsWith("…"));
  const rendered = renderStatus(snapshot({ messages: [message({ body: hostile })] }), options);
  assert.equal(rendered.includes("\u001b"), false);
});

test("colour is opt-in, carries no meaning alone, and is absent by default", () => {
  const degraded = snapshot({
    connectors: [connector("claude"), connector("codex", {
      health: "degraded", safeErrorCode: "MANAGED_CODEX_UNAVAILABLE" })],
  });
  const plain = renderStatus(degraded, options);
  const painted = renderStatus(degraded, { ...options, color: true });
  assert.equal(plain.includes("\u001b"), false);
  assert.ok(painted.includes("\u001b[31mdegraded\u001b[0m"));
  // Stripping every escape from the coloured render reproduces the plain one:
  // colour adds emphasis, never information.
  assert.equal(painted.replaceAll(/\u001b\[\d+m/g, ""), plain);
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

test("watch emits each new row once and each settlement once, from a bounded state", () => {
  const first = snapshot({ messages: [message({ sequence: 7, state: "queued", latencyMs: undefined })] });
  const seed = diffWatch(emptyWatchState, first);
  assert.equal(seed.state.lastMessageSequence, 7);

  const second = snapshot({
    messages: [
      message({ sequence: 7, state: "delivered", latencyMs: 61 }),
      message({ sequence: 8, state: "queued", latencyMs: undefined, bytes: 12 }),
    ],
    activityEvents: [{
      sequence: 3, timestamp: at(1_000), kind: "registration", action: "claude_route_installed",
      outcome: "accepted", aliases: [`advisor@${HOST}`], operatorAction: true,
    }],
  });
  const step = diffWatch(seed.state, second);
  assert.deepEqual(step.events.map((event) => event.type), ["transition", "message", "activity"]);
  const lines = step.events.map((event) => renderWatchEvent(event, false));
  assert.equal(lines[0], "#7  queued → delivered (61 ms)");
  assert.match(lines[1]!, /^#8 {2}advisor@this-mac → codex-reviewer@this-mac {2}queued {2}12 B$/);
  assert.equal(lines[2], "   claude_route_installed  advisor@this-mac  accepted");

  // Re-polling an unchanged snapshot emits nothing, and the tracked state
  // never grows past the rows the snapshot itself carries.
  const repeat = diffWatch(step.state, second);
  assert.deepEqual(repeat.events, []);
  assert.equal(repeat.state.messageStates.size, second.messages.length);
});

test("a settlement that went badly is named, with its safe code", () => {
  const before = diffWatch(emptyWatchState, snapshot({
    messages: [message({ sequence: 4, state: "queued", latencyMs: undefined })] }));
  const after = diffWatch(before.state, snapshot({
    messages: [message({ sequence: 4, state: "unconfirmed", latencyMs: 900, safeErrorCode: "DELIVERY_UNCONFIRMED" })] }));
  assert.equal(renderWatchEvent(after.events[0]!, false),
    "#4  queued → unconfirmed (900 ms)  DELIVERY_UNCONFIRMED");
});
