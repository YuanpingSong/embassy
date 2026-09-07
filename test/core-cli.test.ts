import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { CORE_VERSION, runCoreCli } from "../src/gateway/core-cli.js";
import { runCoreRuntime, type CoreRuntimeDependencies } from "../src/gateway/runtime.js";
import { serveLocalControl } from "../src/gateway/local-control.js";

const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const sink = () => {
  let value = "";
  return { stream: new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } }), read: () => value };
};
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

test("CLI register, named send, retained reply and broker check traverse the real control/runtime chain", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-cli-"));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(path.join(stateDir, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  await chmod(path.join(stateDir, "nodes.json"), 0o600);
  const writes: string[] = [];
  const deps: CoreRuntimeDependencies = {
    createCodexDiscovery: () => undefined,
    loginHome: () => root,
    acquireLease: async () => ({ lost: new Promise<void>(() => {}), isLost: () => false, close: async () => {} }),
    attestClaudeRuntime: async () => ({ sessionsDir: path.join(root, "sessions"), socketDir: path.join(root, "sockets") }),
    createClaudePeer: () => ({ discover: async () => ({ peers: [], rejected: {}, truncated: false, entriesScanned: 0, parseableRecords: 0 }),
      resolveReplyAddress: async () => { throw new Error("no Claude session"); }, assertTargetWorkspaceDisjoint: async () => {},
      prepareSend: async () => { throw new Error("no Claude session"); }, close: async () => {} }),
    createCodexOperation: () => ({ execute: async (input) => {
      assert.equal(await input.authorizeWrite({ attemptId: input.attemptId, kind: "codex_turn_start",
        bodyBytes: Buffer.byteLength(input.text), frameBytes: Buffer.byteLength(input.text) + 100,
        sha256: createHash("sha256").update(input.text).digest("hex") }), true);
      writes.push(input.text);
      await input.onAccepted({ attemptId: input.attemptId, turnId: "test-turn", steer: async () => {
        throw new Error("not steering in this fixture");
      } });
      return { attemptId: input.attemptId, cleanupConfirmed: true, phase: "terminal", state: "terminal", outcome: "completed" };
    } }),
  };
  let stop = new AbortController(), ready = deferred();
  let running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: stateDir }, signal: stop.signal, onReady: () => ready.resolve() }, deps);
  t.after(async () => { stop.abort(); await running; await rm(root, { recursive: true, force: true }); });
  await ready.promise;
  const cli = async (args: string[], handle = a, input = "") => {
    const output = sink(), errors = sink();
    const code = await runCoreCli(args, { env: { EMBASSY_STATE_DIR: stateDir, CODEX_THREAD_ID: handle },
      stdin: Readable.from([input]), stdout: output.stream, stderr: errors.stream });
    assert.equal(code, 0, errors.read());
    return JSON.parse(output.read()) as { ok: boolean; result: Record<string, unknown> };
  };
  await cli(["register-codex", "--alias", "codex-a@local"], a);
  await cli(["register-codex", "--alias", "codex-b@local"], b);
  const sent = await cli(["send", "--to", "codex-b@local"], a, "hello from A");
  const receipt = await cli(["wait-delivery", "--token", String(sent.result.deliveryToken)]);
  assert.equal(receipt.result.state, "delivered");
  stop.abort(); await running;
  stop = new AbortController(); ready = deferred();
  running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: stateDir }, signal: stop.signal, onReady: () => ready.resolve() }, deps);
  await ready.promise;
  const hint = /Reply by running `embassy ([^`]+)`/.exec(writes[0]!)![1]!;
  const replied = await cli(hint.split(" "), b, "explicit reply");
  assert.equal((await cli(["wait-delivery", "--token", String(replied.result.deliveryToken)])).result.state, "delivered");
  assert.equal(writes.length, 2);
  assert.match(writes[0]!, /from-name="codex-a@local"/);
  assert.match(writes[1]!, /from-name="codex-b@local"/);
  assert.deepEqual((await cli(["check"])).result, { status: "ok", scope: "broker-loopback" });
  assert.equal(writes.length, 2, "check must not call a native provider");
  const status = JSON.stringify((await cli(["status", "--json"])).result);
  for (const value of [a, b, "hello from A", "explicit reply", sent.result.conversationId, sent.result.deliveryToken]) assert.equal(status.includes(String(value)), false);
  await cli(["retire", "--alias", "codex-b@local"]);
  const terminal = sink(), errors = sink();
  Object.assign(terminal.stream, { isTTY: true });
  assert.equal(await runCoreCli(["status"], { env: { EMBASSY_STATE_DIR: stateDir }, stdout: terminal.stream, stderr: errors.stream }), 0);
  assert.match(terminal.read(), /Recent deliveries:/);
  assert.match(terminal.read(), /Recent retirements:[\s\S]*codex-b@local/);
  assert.doesNotMatch(terminal.read(), /hello from A|explicit reply/);
  const nonTty = sink();
  assert.equal(await runCoreCli(["tui"], { env: { EMBASSY_STATE_DIR: stateDir },
    stdin: Readable.from([]), stdout: nonTty.stream, stderr: errors.stream }), 0);
  assert.match(nonTty.read(), /Recent deliveries:/);
  assert.match(nonTty.read(), /Recent retirements:[\s\S]*codex-b@local/);
  assert.doesNotMatch(nonTty.read(), /\u001b|hello from A|explicit reply/);
  const unknown = sink();
  assert.equal(await runCoreCli(["wait-delivery", "--token", "dlv_abcdefghijklmnopqrstuvwx"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout: unknown.stream, stderr: errors.stream,
  }), 3, "a missing retained receipt is not a failed delivery");
  assert.deepEqual(JSON.parse(unknown.read()).result, { found: false });
  const keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = sink(); Object.assign(screen.stream, { isTTY: true, columns: 100, rows: 24 });
  const tuiStop = new AbortController();
  const tui = runCoreCli(["tui"], { env: { EMBASSY_STATE_DIR: stateDir }, stdin: keys,
    stdout: screen.stream, stderr: errors.stream, signal: tuiStop.signal });
  const screenHas = async (pattern: RegExp) => {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(screen.read()) && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.match(screen.read(), pattern);
  };
  try {
    await screenHas(/codex-a@local/);
    await screenHas(/Embassy local.*ledger rev/);
    keys.write("x"); await screenHas(/Endpoint ID[\s\S]*reg_/);
    keys.write("y"); await screenHas(/result ready/); keys.write("4");
    await screenHas(/cancelled.*ambiguous.*unconfirmed/);
    assert.deepEqual((await cli(["status", "--json"])).result.routes, []);
    assert.equal(writes.length, 2, "operator TUI retirement performs no native provider write");
    keys.write("q"); assert.equal(await tui, 0);
  } finally { tuiStop.abort(); await tui; }
});

test("interactive action errors use the real CLI uncertainty hint through closed control decoding", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-tui-hint-"));
  await chmod(root, 0o700);
  await writeFile(path.join(root, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  const control = await serveLocalControl({ stateDir: root, socketPath: path.join(root, "control.sock"),
    handle: async (request) => (request as { method: string }).method === "list_snapshot"
      ? { ok: true, result: { health: "healthy", revision: 1, routes: [], messages: [], retirements: [] } }
      : { ok: false, code: "HANDLER_FAILURE" } });
  const stop = new AbortController();
  const keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = sink(); Object.assign(screen.stream, { isTTY: true, columns: 140, rows: 24 });
  const running = runCoreCli(["tui"], { env: { EMBASSY_STATE_DIR: root }, stdin: keys,
    stdout: screen.stream, signal: stop.signal });
  t.after(async () => { stop.abort(); await running; await control.close(); await rm(root, { recursive: true, force: true }); });
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(screen.read()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(screen.read(), pattern);
  };
  await waitFor(/broker healthy/);
  keys.write("c");
  await waitFor(/result ready/); keys.write("4");
  await waitFor(/CONTROL_WRITE_OUTCOME_AMBIGUOUS/);
  await waitFor(/The operation may have applied/);
  await waitFor(/do not resend an uncertain write/);
  keys.write("q"); assert.equal(await running, 0);
});

test("help/version avoid state access", async () => {
  for (const arg of ["--help", "--version"]) {
    const stdout = sink();
    assert.equal(await runCoreCli([arg], { env: { EMBASSY_STATE_DIR: "not-absolute" }, stdout: stdout.stream }), 0);
    assert.ok(stdout.read().length > 0);
    assert.equal(CORE_VERSION, "4.4.0");
    if (arg === "--version") assert.equal(stdout.read(), `embassy ${CORE_VERSION}\n`);
  }
});

test("the real CLI preserves post-write uncertainty and rejects extra public fields", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-wire-"));
  await chmod(root, 0o700);
  await writeFile(path.join(root, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  let reply: unknown;
  const control = await serveLocalControl({ stateDir: root, socketPath: path.join(root, "control.sock"), handle: async () => reply });
  t.after(async () => { await control.close(); await rm(root, { recursive: true, force: true }); });
  for (const result of [
    { ok: true, result: { id: "reg_test", host: "local", provider: "codex", alias: "codex-test@local", handle: a } },
    { ok: false, code: "HANDLER_FAILURE" },
    { ok: false, code: "INVALID_HANDLER_RESPONSE" },
    { ok: false, code: "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN" },
  ]) {
    reply = result;
    const output = sink(), errors = sink();
    assert.equal(await runCoreCli(["register-codex", "--alias", "codex-test@local"], {
      env: { EMBASSY_STATE_DIR: root, CODEX_THREAD_ID: a }, stdout: output.stream, stderr: errors.stream,
    }), 3);
    assert.equal(JSON.parse(output.read()).error.code, "CONTROL_WRITE_OUTCOME_AMBIGUOUS");
    assert.equal((output.read() + errors.read()).includes(a), false);
  }
  reply = { ok: true, result: { status: "healthy", private: a } };
  const output = sink(), errors = sink();
  assert.equal(await runCoreCli(["health"], { env: { EMBASSY_STATE_DIR: root }, stdout: output.stream, stderr: errors.stream }), 3);
  assert.equal(JSON.parse(output.read()).error.code, "CONTROL_INVALID_RESPONSE");
  assert.equal((output.read() + errors.read()).includes(a), false);
});
