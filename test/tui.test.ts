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
  const running = runTui({ input, output, call, renderStatus: () => "plain snapshot\n", signal: stop.signal });
  return { input, output, raw, stop, running, text: () => bytes, key: (value: string) => input.emit("data", Buffer.from(value)) };
}

test("TUI renders only metadata and distinguishes remote catalog observation from local health", () => {
  const m = model();
  const text = renderTui(m, 140, 24, Date.parse("2026-09-06T00:00:30.000Z"));
  assert.match(text, /broker healthy/);
  assert.match(text, /not a provider readiness proof/);
  assert.match(text, /codex-one@local.*queue 2.*DELIVERED/);
  assert.match(text, /pm@remote/);
  assert.match(text, /not reported/);
  assert.doesNotMatch(text, /remote.*healthy/);
  m.section = "deliveries";
  assert.match(renderTui(m, 140, 24), /codex-one@local -> pm@remote.*delivered.*DELIVERED/);
  m.section = "retirements";
  assert.match(renderTui(m, 100, 24), /old@local.*2026-09-06/);
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
    ui.key("x"); ui.key("y"); await settle();
    assert.deepEqual(commands.find((c) => c.method === "retire_route"), { method: "retire_route", params: { endpoint: endpoint.id } });
    assert.match(ui.text(), /cancelled.*2.*ambiguous.*1.*unconfirmed.*0/);
    ui.key("\t"); ui.key("j"); ui.key("x"); ui.key("y"); await settle();
    assert.equal(commands.filter((c) => c.method === "retire_route").length, 1);
    assert.match(ui.text(), /owned by remote/);
    ui.key("r"); await settle(); ui.key("c"); await settle();
    assert.ok(commands.some((c) => c.method === "refresh_discovery"));
    assert.ok(commands.some((c) => c.method === "check"));
    ui.key("d"); ui.key("dlv_abcdefghijklmnopqrstuvwx\r"); await settle();
    assert.deepEqual(commands.find((c) => c.method === "delivery_status"), {
      method: "delivery_status", params: { token: "dlv_abcdefghijklmnopqrstuvwx" } });
    assert.doesNotMatch(ui.text(), /dlv_abcdefghijklmnopqrstuvwx/);
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
    assert.match(ui.text(), /STALE.*CONTROL_CONNECT_DENIED/);
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
    action.resolve(undefined); await settle();
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
