import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { BridgeError } from "../src/errors.js";
import type { BrokerCommand } from "../src/gateway/broker-control.js";
import { runTui } from "../src/gateway/tui.js";

const snapshot = (host: string) => ({ health: "healthy", revision: 1, routes: [{
  id: `reg_${host}`, alias: `codex-one@${host}`, host, provider: "codex", queueDepth: 2,
}], messages: [], retirements: [], federation: { nodes: [{ host: "mirror", routes: [
  { id: "reg_mirror", alias: "codex-mirror@mirror", host: "mirror", provider: "codex" },
]}], truncated: false } });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r)); };
function terminal(hosts: string[], local: (c: BrokerCommand) => Promise<unknown>, remote: (h: string, c: BrokerCommand) => Promise<unknown>) {
  let bytes = "", closes = 0;
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (value: boolean) => { raw.push(value); } });
  const output = Object.assign(new Writable({ write(chunk, _enc, done) { bytes += String(chunk); done(); } }), { isTTY: true, columns: 120, rows: 30 });
  const stop = new AbortController();
  const running = runTui({ input, output, host: "local", call: local, renderStatus: () => "plain\n", signal: stop.signal,
    remote: { hosts, call: remote, close: () => { closes++; } } });
  return { raw, input, output, stop, running, key: (keys: string) => input.write(keys), closes: () => closes,
    frame: () => bytes.split("\u001b[2J").at(-1)!, text: () => bytes };
}

test("one hung host cannot block local or other host polls, navigation, or quit", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const hung = deferred<unknown>();
  const calls = { local: 0, dead: 0, remote: 0 };
  const ui = terminal(["dead", "remote"], async () => { calls.local++; return snapshot("local"); }, async (host) => {
    if (host === "dead") { calls.dead++; return hung.promise; }
    calls.remote++; return snapshot("remote");
  });
  try {
    await settle();
    assert.deepEqual(calls, { local: 1, dead: 1, remote: 1 });
    assert.match(ui.frame(), /local.*healthy/); assert.match(ui.frame(), /remote.*healthy/);
    assert.doesNotMatch(ui.frame(), /codex-mirror/);
    for (let i = 0; i < 5; i++) { t.mock.timers.tick(1_000); await settle(); }
    assert.equal(calls.local, 6); assert.equal(calls.dead, 1); assert.equal(calls.remote, 2);
    ui.key("]]"); assert.match(ui.frame(), /Embassy remote/); assert.match(ui.frame(), /codex-one@remote/);
    ui.key("["); assert.match(ui.frame(), /Embassy dead/);
    ui.key("q"); await ui.running;
    assert.equal(ui.closes(), 1); assert.deepEqual(ui.raw, [true, false]);
    const stopped = ui.text(); hung.resolve(snapshot("dead")); await settle();
    assert.equal(ui.text(), stopped);
  } finally { ui.stop.abort(); await ui.running; }
});

test("remote retirement captures host and full ID even if the operator changes panes immediately", async () => {
  const mutations: { host: string; command: BrokerCommand }[] = [];
  const result = deferred<unknown>();
  const ui = terminal(["remote"], async (command) => {
    assert.equal(command.method, "list_snapshot", "no local mutation"); return snapshot("local");
  }, async (host, command) => {
    if (command.method === "list_snapshot") return snapshot(host);
    mutations.push({ host, command }); return result.promise;
  });
  try {
    await settle(); ui.key("]x");
    assert.match(ui.frame(), /Host: remote/); assert.match(ui.frame(), /Endpoint ID: reg_remote/);
    assert.doesNotMatch(ui.frame(), /Host: local/);
    ui.key("y["); await settle();
    assert.match(ui.frame(), /Embassy local/);
    assert.deepEqual(mutations, [{ host: "remote", command: { method: "retire_route", params: { endpoint: "reg_remote" } } }]);
    result.resolve({ cancelled: 2, ambiguous: 0, unconfirmed: 1 }); await settle();
    assert.doesNotMatch(ui.frame(), /cancelled/);
    ui.key("]4"); assert.match(ui.frame(), /cancelled.*2/);
    assert.equal(mutations.length, 1);
  } finally { ui.stop.abort(); await ui.running; }
});

test("unsupported or failed owner observations retain stale rows but fence retirement through recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let unsupported = false;
  const mutations: BrokerCommand[] = [];
  const ui = terminal(["remote"], async () => snapshot("local"), async (_host, command) => {
    if (command.method !== "list_snapshot") { mutations.push(command); return { cancelled: 0, ambiguous: 0, unconfirmed: 0 }; }
    if (unsupported) throw new BridgeError("CONTROL_INVALID_RESPONSE", "hidden", false, { detail: "unsupported response — remote CLI version 3.0.0" });
    return snapshot("remote");
  });
  try {
    await settle(); ui.key("]x");
    unsupported = true; t.mock.timers.tick(5_000); await settle();
    ui.key("y"); await settle();
    assert.equal(mutations.length, 0);
    assert.match(ui.frame(), /STALE/); assert.match(ui.frame(), /unsupported response.*CLI version 3.0.0/);
    assert.match(ui.frame(), /codex-one@remote/);
    ui.key("xy"); await settle(); assert.equal(mutations.length, 0);
    unsupported = false; t.mock.timers.tick(5_000); await settle();
    ui.key("xy"); await settle(); assert.equal(mutations.length, 1);
  } finally { ui.stop.abort(); await ui.running; }
});

test("retirement rechecks a pending owner poll before launching the remote mutation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const next = deferred<unknown>(); let polls = 0, writes = 0;
  const ui = terminal(["remote"], async () => snapshot("local"), async (_host, command) => {
    if (command.method !== "list_snapshot") { writes++; return {}; }
    if (++polls === 1) return snapshot("remote");
    await next.promise; throw new BridgeError("CONTROL_TIMEOUT", "no owner response");
  });
  try {
    await settle(); ui.key("]x");
    t.mock.timers.tick(5_000); await settle(); ui.key("y["); await settle();
    assert.equal(writes, 0);
    next.resolve(undefined); await settle();
    assert.equal(writes, 0); ui.key("]"); assert.match(ui.frame(), /fresh supported owner snapshot/);
  } finally { ui.stop.abort(); await ui.running; }
});

test("non-TTY output stays local and never calls a remote", async () => {
  let localCalls = 0, remoteCalls = 0, output = "";
  await runTui({ input: new PassThrough(), output: { write(data) { output += String(data); return true; } },
    call: async () => { localCalls++; return snapshot("local"); }, renderStatus: () => "local status\n",
    remote: { hosts: ["remote"], call: async () => { remoteCalls++; return snapshot("remote"); }, close() {} } });
  assert.equal(localCalls, 1); assert.equal(remoteCalls, 0); assert.equal(output, "local status\n");
});
