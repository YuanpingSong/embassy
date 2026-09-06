import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { BrokerCommand } from "../src/gateway/broker-control.js";
import { renderTui, runTui, type TuiModel } from "../src/gateway/tui.js";

const endpoint = { id: "reg_original", alias: "codex-one@local", host: "local", provider: "codex", queueDepth: 2,
  lastOperation: { outcome: "delivered", code: "DELIVERED" } };
const snapshot = () => ({ health: "healthy", revision: 4, routes: [endpoint],
  messages: [{ source: endpoint.alias, target: "pm@remote", state: "delivered", ageMs: 50_000, safeErrorCode: "DELIVERED" }],
  retirements: [{ alias: "old@local", at: "2026-09-06T00:00:00.000Z" }],
  federation: { truncated: false, nodes: [{ host: "remote", observedAt: "2026-09-06T00:00:00.000Z",
    routes: [{ id: "reg_remote", alias: "pm@remote", host: "remote", provider: "claude" }] }] } });
const model = (): TuiModel => ({ snapshot: snapshot(), snapshotAt: Date.parse("2026-09-06T00:00:00.000Z"),
  section: "endpoints", selected: { endpoints: 0, deliveries: 0, retirements: 0 }, mode: "browse", token: "" });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function terminal(call: (command: BrokerCommand) => Promise<unknown>, dimensions = { columns: 100, rows: 24 }) {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
    setRawMode(value: boolean) { raw.push(value); this.isRaw = value; } });
  let bytes = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { bytes += chunk.toString(); done(); } }),
    { isTTY: true, ...dimensions });
  const stop = new AbortController();
  const running = runTui({ input, output, call, renderStatus: () => "plain snapshot\n", host: "local",
    hint: (code) => code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" ? "The operation may have applied. Inspect status; do not resend an uncertain write." : "",
    signal: stop.signal });
  return { input, output, raw, stop, running, text: () => bytes,
    frame: () => bytes.split("\u001b[2J").at(-1)!, key: (value: string) => input.emit("data", Buffer.from(value)) };
}

test("TUI renders only metadata and distinguishes remote catalog observation from local health", () => {
  const m = model();
  const text = renderTui(m, 140, 24, Date.parse("2026-09-06T00:00:30.000Z"));
  assert.match(text, /broker healthy/);
  assert.match(text, /not a provider readiness proof/);
  assert.match(text, /codex-one@local/);
  assert.match(text, /queued 2/);
  assert.doesNotMatch(text, /\bDELIVERED\b/);
  assert.match(text, /pm@remote/);
  assert.match(text, /not reported/);
  assert.doesNotMatch(text, /remote.*healthy/);
  m.section = "deliveries";
  assert.match(renderTui(m, 140, 24), /delivered.*codex-one@local -> pm@remote/);
  m.section = "retirements";
  assert.match(renderTui(m, 100, 24), /ago.*old@local/);
  m.snapshot = { ...snapshot(), body: "secret body", token: "secret token", handle: "native identity" };
  assert.doesNotMatch(renderTui(m), /secret body|secret token|native identity/);
});

test("TUI render bounds, scroll, and terminal-control escaping", () => {
  const m = model();
  m.snapshot = { ...snapshot(), routes: Array.from({ length: 40 }, (_, i) => ({ ...endpoint, alias: `codex-${i}@local` })) };
  m.selected.endpoints = 39;
  assert.match(renderTui(m, 80, 24), /codex-39@local/);
  m.action = "unsafe\u001b]52;clipboard\u0007\r\ntext";
  for (const [columns, rows] of [[80, 24], [40, 12], [12, 4]]) {
    const rendered = renderTui(m, columns, rows);
    assert.ok(rendered.split("\n").length <= rows!);
    assert.ok(rendered.split("\n").every((line) => line.length <= columns!));
    assert.doesNotMatch(rendered, /[\u001b\u0007\r]/);
  }
});

test("non-TTY TUI reads one snapshot and prints the existing status renderer without terminal effects", async () => {
  const commands: BrokerCommand[] = [];
  let output = "";
  await runTui({ input: new PassThrough(), output: { write(value) { output += String(value); return true; } },
    call: async (command) => { commands.push(command); return snapshot(); },
    renderStatus: (value) => { assert.deepEqual(value, snapshot()); return "existing status text\n"; } });
  assert.deepEqual(commands, [{ method: "list_snapshot", params: {} }]);
  assert.equal(output, "existing status text\n");
});

test("TUI actions call existing methods, confirm exact IDs, and refuse remote retirement", async () => {
  const commands: BrokerCommand[] = [];
  const ui = terminal(async (command) => {
    commands.push(command);
    if (command.method === "list_snapshot") return snapshot();
    if (command.method === "check") return { status: "ok", scope: "broker-loopback" };
    if (command.method === "refresh_discovery") return { routes: [] };
    if (command.method === "retire_route") return { cancelled: 2, ambiguous: 1, unconfirmed: 0 };
    return { found: false };
  });
  try {
    await settle();
    ui.key("x"); ui.key("n"); await settle();
    assert.equal(commands.some((c) => c.method === "retire_route"), false);
    ui.key("x"); ui.key("y"); await settle(); ui.key("4");
    assert.deepEqual(commands.find((c) => c.method === "retire_route"), { method: "retire_route", params: { endpoint: endpoint.id } });
    assert.match(ui.text(), /cancelled.*2.*ambiguous.*1.*unconfirmed.*0/);
    ui.key("1"); ui.key("j"); ui.key("x"); ui.key("y"); await settle();
    assert.equal(commands.filter((c) => c.method === "retire_route").length, 1);
    assert.match(ui.text(), /owned by remote/);
    ui.key("r"); await settle(); ui.key("c"); await settle();
    assert.ok(commands.some((c) => c.method === "refresh_discovery"));
    assert.ok(commands.some((c) => c.method === "check"));
    ui.key("d"); ui.key("dlv_abcdefghijklmnopqrstuvwx\r"); await settle();
    assert.deepEqual(commands.find((c) => c.method === "delivery_status"), {
      method: "delivery_status", params: { token: "dlv_abcdefghijklmnopqrstuvwx" } });
    assert.match(ui.text(), /dlv_abcdefghijklmnopqrstuvwx/);
    assert.doesNotMatch(ui.frame(), /dlv_abcdefghijklmnopqrstuvwx/);
  } finally { ui.stop.abort(); await ui.running; }
  assert.deepEqual(ui.raw, [true, false]);
  assert.match(ui.text(), /\u001b\[\?25h/);
  assert.equal(ui.input.listenerCount("data"), 0);
  assert.equal(ui.input.isPaused(), true);
});

test("polling is single-flight, disconnected data is stale, recovery clears it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<unknown>();
  let count = 0;
  const ui = terminal(async () => {
    count++;
    if (count === 1) return pending.promise;
    if (count === 2) throw Object.assign(new Error("private diagnostic"), { code: "CONTROL_CONNECT_DENIED" });
    return snapshot();
  });
  try {
    await settle(); t.mock.timers.tick(5_000); await settle();
    assert.equal(count, 1);
    pending.resolve(snapshot()); await settle();
    t.mock.timers.tick(1_000); await settle();
    assert.equal(count, 2);
    assert.match(ui.frame(), /broker UNREACHABLE.*CONTROL_CONNECT_DENIED/);
    assert.match(ui.frame(), /STALE/);
    assert.doesNotMatch(ui.text(), /private diagnostic/);
    t.mock.timers.tick(1_000); await settle();
    assert.equal(count, 3);
  } finally { ui.stop.abort(); await ui.running; }
});

test("retirement confirmation never switches identity when polling replaces an alias", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = snapshot();
  const mutations: BrokerCommand[] = [];
  const ui = terminal(async (command) => {
    if (command.method === "list_snapshot") return current;
    mutations.push(command); return { cancelled: 0, ambiguous: 0, unconfirmed: 0 };
  });
  try {
    await settle(); ui.key("x");
    current = { ...snapshot(), routes: [{ ...endpoint, id: "reg_replacement" }] };
    t.mock.timers.tick(1_000); await settle(); ui.key("y"); await settle();
    assert.deepEqual(mutations, [{ method: "retire_route", params: { endpoint: "reg_original" } }]);
  } finally { ui.stop.abort(); await ui.running; }
});

test("quit during an in-flight action restores terminal and never replays an uncertain mutation", async () => {
  const pending = deferred<unknown>();
  let mutations = 0;
  let reads = 0;
  const ui = terminal(async (command) => {
    if (command.method === "list_snapshot") { reads++; return snapshot(); }
    mutations++; return pending.promise;
  });
  await settle(); ui.key("c"); await settle();
  ui.key("q"); await ui.running;
  const bytesAtExit = ui.text();
  pending.resolve({ status: "ok", scope: "broker-loopback" }); await settle();
  assert.equal(mutations, 1);
  assert.equal(reads, 1, "quitting must not start a follow-up read after the action completes");
  assert.equal(ui.text(), bytesAtExit);
  assert.deepEqual(ui.raw, [true, false]);
});

test("empty remote catalogs still show failure, and long action results remain scrollable", () => {
  const m = model();
  m.snapshot = { ...snapshot(), federation: { truncated: true, nodes: [
    { host: "remote", routes: [], safeErrorCode: "PEER_TUNNEL_UNAVAILABLE" }] } };
  assert.match(renderTui(m, 100, 24), /remote.*PEER_TUNNEL_UNAVAILABLE/);
  m.section = "result";
  m.result = { label: "delivery", value: JSON.stringify({ found: true, state: "unconfirmed", terminal: true,
    deadlineAt: "2026-09-06T00:00:00.000Z", safeErrorCode: "REQUEST_TIMEOUT" }) };
  const full = renderTui(m, 40, 24).split("\n").map((line) => line.replace(/^[> ] /, "")).join("");
  assert.match(full, /REQUEST_TIMEOUT/);
  assert.match(full, /unconfirmed/);
});

test("repeated action keys do not create a queue; an uncertain action is shown once without replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const action = deferred<unknown>();
  const calls: BrokerCommand[] = [];
  const ui = terminal(async (command) => {
    calls.push(command);
    if (command.method === "list_snapshot") return snapshot();
    await action.promise;
    throw Object.assign(new Error("must not print"), { code: "CONTROL_WRITE_OUTCOME_AMBIGUOUS" });
  });
  try {
    await settle(); ui.key("c"); await settle();
    ui.key("rrrrcccc"); t.mock.timers.tick(5_000); await settle();
    assert.equal(calls.length, 2, "no overlapping poll or second action");
    action.resolve(undefined); await settle(); ui.key("4");
    assert.match(ui.text(), /CONTROL_WRITE_OUTCOME_AMBIGUOUS/);
    assert.doesNotMatch(ui.text(), /must not print/);
    assert.equal(calls.filter((call) => call.method !== "list_snapshot").length, 1);
  } finally { ui.stop.abort(); await ui.running; }
});

test("narrow terminal cannot confirm retirement without displaying the whole endpoint identity", async () => {
  let retired = false;
  const ui = terminal(async (command) => {
    if (command.method === "retire_route") retired = true;
    return snapshot();
  }, { columns: 12, rows: 4 });
  try {
    await settle(); ui.key("x"); ui.key("y"); await settle();
    assert.equal(retired, false);
    ui.output.columns = 80; ui.output.rows = 24; ui.output.emit("resize");
    ui.key("x"); ui.key("y"); await settle();
    assert.equal(retired, true);
  } finally { ui.stop.abort(); await ui.running; }
});

test("newest deliveries lead with age/state and fault counts exclude pending and uncertain outcomes", () => {
  const m = model(); m.section = "deliveries";
  m.snapshot = { ...snapshot(), messages: [
    { source: "old@local", target: "pm@remote", state: "failed", safeErrorCode: "OLD_FAILURE", ageMs: 99_000 },
    { source: "fresh@local", target: "pm@remote", state: "delivered", safeErrorCode: "TRANSPORT_WRITTEN", ageMs: 1_000 },
    { source: "middle@local", target: "pm@remote", state: "failed", safeErrorCode: "NEW_FAILURE", ageMs: 50_000 },
    { source: "pending@local", state: "queued", ageMs: 100_000 },
    { source: "uncertain@local", state: "unconfirmed", safeErrorCode: "REQUEST_TIMEOUT", ageMs: 101_000 },
  ] };
  const rendered = renderTui(m, 100, 24);
  assert.match(rendered, /deliveries.*2 failed/);
  assert.ok(rendered.indexOf("fresh@local") < rendered.indexOf("middle@local"));
  assert.ok(rendered.indexOf("middle@local") < rendered.indexOf("old@local"));
  assert.match(rendered, />.*1s.*delivered.*fresh@local/);
  assert.doesNotMatch(rendered, /TRANSPORT_WRITTEN/);
  assert.match(rendered, /!\s*NEW_FAILURE/);
  const narrow = renderTui(m, 40, 12);
  assert.match(narrow, /1s.*delivered/);
});

test("unreachable headline demotes last-known health and shows a next step on first launch too", () => {
  const m = model(); m.host = "m5dev"; m.error = "CONTROL_UNAVAILABLE"; m.staleSince = 5_000;
  const rendered = renderTui(m, 120, 24, 50_000);
  assert.match(rendered.split("\n")[0]!, /Embassy m5dev.*broker UNREACHABLE.*CONTROL_UNAVAILABLE.*45s/);
  assert.doesNotMatch(rendered.split("\n")[0]!, /healthy/);
  assert.match(rendered, /embassy service status/);
  assert.match(rendered, /STALE/);
  assert.match(rendered, /not a provider readiness proof/);
  delete m.snapshot;
  assert.doesNotMatch(renderTui(m), /last-known.*unavailable/);
});

test("retirement modal shows the exact identity and all settlement consequences", () => {
  const m = model(); m.mode = "confirm"; m.retiring = { ...endpoint, local: true };
  const rendered = renderTui(m, 100, 24).replaceAll("\n", " ");
  assert.match(rendered, /Endpoint ID: reg_original/);
  assert.match(rendered, /codex.*queued 2.*delivered/);
  assert.match(rendered, /queued\/reserved.*cancelled/i);
  assert.match(rendered, /armed.*ambiguous/);
  assert.match(rendered, /accepted.*unconfirmed/);
  assert.match(rendered, /cannot be undone/);
  assert.match(rendered, /y.*N/);
});

test("collision rows are visibly distinct and anonymous groups never hide faults or claim loopback", () => {
  const m = model();
  m.snapshot = { ...snapshot(), routes: [
    { ...endpoint, id: "reg_aaaabbbb" }, { ...endpoint, id: "reg_ccccdddd" },
  ], messages: [
    { state: "delivered", ageMs: 1_000 }, { state: "failed", safeErrorCode: "DISPATCH_FAILED", ageMs: 2_000 },
    { state: "unconfirmed", safeErrorCode: "REQUEST_TIMEOUT", ageMs: 3_000 },
    { source: "someone@local", state: "delivered", ageMs: 4_000 },
    { state: "delivered", ageMs: 5_000 },
  ], retirements: [{ alias: "loopback-a-1234abcd@local", at: "2026-09-06T00:00:00.000Z" }] };
  const endpoints = renderTui(m, 140, 24);
  assert.match(endpoints, /aaaabbbb/); assert.match(endpoints, /ccccdddd/);
  assert.match(endpoints, /ambiguous/);
  m.section = "deliveries";
  const deliveries = renderTui(m, 160, 24);
  assert.match(deliveries, /3 unattributed deliveries/);
  assert.match(deliveries, /DISPATCH_FAILED/); assert.match(deliveries, /REQUEST_TIMEOUT/);
  assert.doesNotMatch(deliveries, /loopback check/);
  assert.match(deliveries, /someone@local/);
  m.section = "retirements";
  assert.match(renderTui(m, 120, 24), /\(loopback check\)/);
});

test("selection follows identity across insertion and cannot silently select its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const second = { ...endpoint, id: "reg_second", alias: "codex-two@local" };
  let current = { ...snapshot(), routes: [endpoint, second] };
  const mutations: BrokerCommand[] = [];
  const ui = terminal(async (command) => {
    if (command.method === "list_snapshot") return current;
    mutations.push(command); return { cancelled: 0, ambiguous: 0, unconfirmed: 0 };
  });
  try {
    await settle(); ui.key("j");
    current = { ...snapshot(), routes: [{ ...endpoint, id: "reg_new" }, endpoint, second] };
    t.mock.timers.tick(1_000); await settle();
    ui.key("x"); assert.match(ui.frame(), /Endpoint ID: reg_second/); ui.key("n");
    current = { ...snapshot(), routes: [{ ...endpoint, id: "reg_new" }, endpoint] };
    t.mock.timers.tick(1_000); await settle();
    ui.key("xy"); await settle();
    assert.equal(mutations.length, 0, "a removed selection requires a fresh selection before retirement");
  } finally { ui.stop.abort(); await ui.running; }
});

test("redraw clock continues through a slow action without extra polls and CLI uncertainty guidance is shown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10_000 });
  const action = deferred<unknown>();
  let reads = 0;
  const ui = terminal(async (command) => {
    if (command.method === "list_snapshot") { reads++; return snapshot(); }
    await action.promise;
    throw Object.assign(new Error("private"), { code: "CONTROL_WRITE_OUTCOME_AMBIGUOUS" });
  });
  try {
    await settle(); ui.key("r"); await settle();
    const startFrame = ui.frame();
    t.mock.timers.tick(3_000); await settle();
    assert.equal(reads, 1);
    assert.notEqual(ui.frame(), startFrame);
    assert.match(ui.frame(), /refresh in progress.*polling paused/);
    assert.match(ui.frame(), /3s/);
    action.resolve(undefined); await settle(); ui.key("4");
    assert.match(ui.frame().replace(/\n[> ] /g, ""), /The operation may have applied/);
    assert.match(ui.frame().replace(/\n[> ] /g, ""), /do not resend an uncertain write/);
    // readline owns the real escape-sequence disambiguation timer.
    t.mock.timers.reset();
    ui.key("\u001b"); await new Promise((resolve) => setTimeout(resolve, 600));
    assert.match(ui.frame(), /\[endpoints/);
  } finally { ui.stop.abort(); await ui.running; }
});

test("frame caching, direct navigation and ledger revision drop are visible without losing terminal cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10_000 });
  let current = snapshot();
  const ui = terminal(async () => current);
  try {
    await settle(); const previous = ui.text();
    ui.output.emit("resize"); assert.equal(ui.text(), previous, "identical frames are not written");
    ui.key("2"); assert.match(ui.frame(), /\[deliveries/);
    ui.key("3"); assert.match(ui.frame(), /\[retirements/);
    ui.key("1G"); assert.match(ui.frame(), />.*remote/);
    ui.key("g"); assert.match(ui.frame(), />.*codex-one@local/);
    current = { ...snapshot(), revision: 1 };
    t.mock.timers.tick(1_000); await settle();
    assert.match(ui.frame(), /ledger rev 1/);
    assert.match(ui.frame(), /restart|reset/i);
  } finally { ui.stop.abort(); await ui.running; }
});

test("token typing validates live, and a reachable degraded broker retains its named fault", async () => {
  const m = model(); m.snapshot = { ...snapshot(), health: "degraded", safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" };
  assert.match(renderTui(m, 120, 24).split("\n")[0]!, /degraded.*DISPATCH_OUTCOME_AMBIGUOUS/);
  const ui = terminal(async () => snapshot());
  try {
    await settle(); ui.key("dno");
    assert.match(ui.frame(), /invalid|incomplete|dlv_<24/i);
    ui.key("\u007f\u007fdlv_abcdefghijklmnopqrstuvwx");
    assert.match(ui.frame(), /dlv_abcdefghijklmnopqrstuvwx/);
    assert.match(ui.frame(), /format valid/);
    assert.match(ui.frame(), /Enter look up/);
    ui.key("\r"); await settle();
    assert.doesNotMatch(ui.frame(), /dlv_abcdefghijklmnopqrstuvwx/);
  } finally { ui.stop.abort(); await ui.running; }
});
