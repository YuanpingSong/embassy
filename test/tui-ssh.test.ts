import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createTuiSshClient, TuiSshError, type TuiSshSpawn } from "../src/gateway/tui-ssh.js";

const snapshot = (host = "remote") => ({ health: "healthy", revision: 1,
  routes: [{ id: "reg_worker", alias: `worker@${host}`, provider: "codex", host, queueDepth: 0 }],
  messages: [], retirements: [] });
const envelope = (command: string, result: unknown) => `${JSON.stringify({ ok: true, command, result })}\n`;

type FakeChild = ReturnType<typeof child>;
function child() {
  const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  const signals: (string | undefined)[] = [];
  return {
    stdout, stderr, signals,
    once: events.once.bind(events),
    kill: (signal?: NodeJS.Signals | number) => { signals.push(signal === undefined ? undefined : String(signal)); return true; },
    output: (value: string | Buffer, code = 0) => queueMicrotask(() => {
      stdout.write(value); events.emit("close", code, null);
    }),
    fail: () => queueMicrotask(() => events.emit("error", new Error("private"))),
    exit: (code = 1) => events.emit("close", code, null),
  };
}

function scripted(outputs: Array<string | Buffer | "hang" | "error">) {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown; child: FakeChild }> = [];
  let active = 0, maximum = 0;
  const spawn: TuiSshSpawn = (command, args, options) => {
    const process = child(); calls.push({ command, args, options, child: process });
    active++; maximum = Math.max(maximum, active);
    const once = process.once;
    process.once = ((event: string, listener: (...args: unknown[]) => void) => once(event, (...args: unknown[]) => {
      if (event === "close") active--; listener(...args);
    })) as FakeChild["once"];
    const output = outputs.shift();
    if (output === "error") process.fail(); else if (output !== "hang" && output !== undefined) process.output(output);
    return process;
  };
  return { spawn, calls, maximum: () => maximum };
}

function fakeTimers() {
  let now = 0;
  const jobs: Array<{ at: number; callback: () => void; timer: ReturnType<typeof setTimeout>; active: boolean }> = [];
  return {
    setTimeout: (callback: () => void, milliseconds: number) => {
      const timer = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      jobs.push({ at: now + milliseconds, callback, timer, active: true }); return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { const job = jobs.find((item) => item.timer === timer); if (job) job.active = false; },
    advance: (milliseconds: number) => { now += milliseconds;
      for (const job of jobs.filter((item) => item.active && item.at <= now)) { job.active = false; job.callback(); } },
  };
}

const expectCode = async (promise: Promise<unknown>, code: string) => await assert.rejects(promise,
  (error: unknown) => error instanceof TuiSshError && error.code === code);

test("fixed ssh argv/env and the closed command mapping return validated broker results", async () => {
  const routes = [{ id: "reg_worker", alias: "worker@remote", provider: "codex" as const, host: "remote" }];
  const h = scripted([
    envelope("status", snapshot()),
    envelope("refresh", { routes }),
    envelope("check", { status: "ok", scope: "broker-loopback" }),
    envelope("delivery-status", { found: false }),
    envelope("retire", { cancelled: 0, ambiguous: 0, unconfirmed: 0 }),
  ]);
  const client = createTuiSshClient({ nodes: ["remote"], env: {
    HOME: "/home/operator", USER: "operator", LOGNAME: "operator", SSH_AUTH_SOCK: "/agent", PATH: "/private",
  }, spawn: h.spawn });
  assert.deepEqual(await client.call("remote", { method: "list_snapshot", params: {} }), snapshot());
  await client.call("remote", { method: "refresh_discovery", params: {} });
  await client.call("remote", { method: "check", params: {} });
  await client.call("remote", { method: "delivery_status", params: { token: "dlv_abcdefghijklmnopqrstuvwx" } });
  await client.call("remote", { method: "retire_route", params: { endpoint: "reg_worker" } });
  assert.deepEqual(h.calls.map((call) => call.args.slice(-4)), [
    ["remote", "embassy", "status", "--json"], ["Tunnel=no", "remote", "embassy", "refresh"],
    ["Tunnel=no", "remote", "embassy", "check"], ["embassy", "delivery-status", "--token", "dlv_abcdefghijklmnopqrstuvwx"],
    ["embassy", "retire", "--endpoint", "reg_worker"],
  ]);
  assert.equal(h.calls[0]!.command, "/usr/bin/ssh");
  assert.deepEqual((h.calls[0]!.options as { env: object }).env,
    { HOME: "/home/operator", USER: "operator", LOGNAME: "operator", SSH_AUTH_SOCK: "/agent" });
  assert.deepEqual((h.calls[0]!.options as { shell: boolean; stdio: string[] }),
    { env: { HOME: "/home/operator", USER: "operator", LOGNAME: "operator", SSH_AUTH_SOCK: "/agent" },
      shell: false, stdio: ["ignore", "pipe", "pipe"] });
  client.close();
});

test("host and argument grammars prevent arbitrary ssh commands", async () => {
  const client = createTuiSshClient({ nodes: ["remote"], spawn: scripted([]).spawn });
  await expectCode(client.call("other", { method: "list_snapshot", params: {} }), "PEER_NOT_CONFIGURED");
  await expectCode(client.call("remote", { method: "send", params: {} } as never), "INVALID_REQUEST");
  await expectCode(client.call("remote", { method: "retire_route", params: { alias: "worker@remote" } }), "INVALID_REQUEST");
  await expectCode(client.call("remote", { method: "delivery_status", params: { token: "dlv_;touch" } }), "INVALID_REQUEST");
  assert.throws(() => createTuiSshClient({ nodes: ["remote;touch"], spawn: scripted([]).spawn }), TypeError);
});

test("unsupported read shape probes CLI metadata lazily after the first child exits", async () => {
  const h = scripted(["{}\n", "embassy 3.1.0\n"]);
  const client = createTuiSshClient({ nodes: ["remote"], spawn: h.spawn });
  await assert.rejects(client.call("remote", { method: "list_snapshot", params: {} }), (error: unknown) =>
    error instanceof TuiSshError && error.code === "CONTROL_INVALID_RESPONSE" &&
    error.detail?.detail === "unsupported response — remote CLI version 3.1.0");
  assert.deepEqual(h.calls.map((call) => call.args.slice(-3)), [
    ["embassy", "status", "--json"], ["remote", "embassy", "--version"],
  ]);
  assert.equal(h.maximum(), 1);
  client.close();
});

test("unknown version, extra output, fatal UTF-8, and host mismatch never become guessed rows", async () => {
  for (const output of ["{}\nextra\n", Buffer.from([0xff, 0x0a])]) {
    const h = scripted([output, "private version output\n"]);
    const client = createTuiSshClient({ nodes: ["remote"], spawn: h.spawn });
    await assert.rejects(client.call("remote", { method: "list_snapshot", params: {} }), (error: unknown) =>
      error instanceof TuiSshError && error.detail?.detail === "unsupported response — remote CLI version unknown");
    client.close();
  }
  const h = scripted([envelope("status", snapshot("another"))]);
  const client = createTuiSshClient({ nodes: ["remote"], spawn: h.spawn });
  await assert.rejects(client.call("remote", { method: "list_snapshot", params: {} }), (error: unknown) =>
    error instanceof TuiSshError && error.code === "CONTROL_INVALID_RESPONSE" && error.detail?.detail === "host mismatch");
  assert.equal(h.calls.length, 1, "a host mismatch is not mislabeled as version skew");
  client.close();
});

test("recognized refusals survive while uncertain action output and transport loss stay ambiguous", async () => {
  const refused = `${JSON.stringify({ ok: false, command: "retire", error: { code: "FEDERATED_ROUTE_READ_ONLY" } })}\n`;
  const uncertain = `${JSON.stringify({ ok: false, command: "retire", error: { code: "HANDLER_FAILURE" } })}\n`;
  const h = scripted([refused, uncertain, "error"]);
  const client = createTuiSshClient({ nodes: ["remote"], spawn: h.spawn });
  const retire = { method: "retire_route", params: { endpoint: "reg_worker" } } as const;
  await expectCode(client.call("remote", retire), "FEDERATED_ROUTE_READ_ONLY");
  await expectCode(client.call("remote", retire), "CONTROL_WRITE_OUTCOME_AMBIGUOUS");
  await expectCode(client.call("remote", retire), "CONTROL_WRITE_OUTCOME_AMBIGUOUS");
  client.close();
});

test("output bounds stop children, retain the per-host reservation, and close terminates all", async () => {
  const h = scripted(["hang", "embassy 4.0.0\n", "hang"]), client = createTuiSshClient({ nodes: ["one", "two"], spawn: h.spawn });
  const first = client.call("one", { method: "list_snapshot", params: {} });
  h.calls[0]!.child.stdout.write(Buffer.alloc(256 * 1024 + 1));
  assert.deepEqual(h.calls[0]!.child.signals, ["SIGTERM"]);
  await expectCode(client.call("one", { method: "list_snapshot", params: {} }), "ROUTE_BUSY");
  h.calls[0]!.child.exit();
  await expectCode(first, "CONTROL_INVALID_RESPONSE");
  const second = client.call("two", { method: "list_snapshot", params: {} });
  client.close();
  assert.deepEqual(h.calls[2]!.child.signals, ["SIGTERM"]);
  h.calls[2]!.child.exit();
  await expectCode(second, "PEER_TUNNEL_UNAVAILABLE");
  await expectCode(client.call("two", { method: "list_snapshot", params: {} }), "CONTROL_UNAVAILABLE");
});

test("wall bounds retain a timed-out host slot until child close without blocking another host or replaying actions", async () => {
  const h = scripted(["hang", envelope("status", snapshot("two")), "hang"]), timers = fakeTimers();
  const client = createTuiSshClient({ nodes: ["one", "two"], spawn: h.spawn, timers });
  const read = client.call("one", { method: "list_snapshot", params: {} });
  timers.advance(8_000); await expectCode(read, "PEER_TUNNEL_UNAVAILABLE");
  assert.deepEqual(h.calls[0]!.child.signals, ["SIGTERM"]);
  await expectCode(client.call("one", { method: "list_snapshot", params: {} }), "ROUTE_BUSY");
  assert.equal((await client.call("two", { method: "list_snapshot", params: {} }) as { revision: number }).revision, 1);
  timers.advance(1_000); assert.deepEqual(h.calls[0]!.child.signals, ["SIGTERM", "SIGKILL"]);
  h.calls[0]!.child.exit();
  const retire = client.call("one", { method: "retire_route", params: { endpoint: "reg_worker" } });
  timers.advance(15_000); await expectCode(retire, "CONTROL_WRITE_OUTCOME_AMBIGUOUS");
  assert.equal(h.calls.filter((call) => call.args.includes("retire")).length, 1, "an uncertain action is never replayed");
  h.calls[2]!.child.exit(); client.close();
});

test("stderr and version diagnostics are bounded without exposing remote text", async () => {
  const h = scripted(["hang"]), client = createTuiSshClient({ nodes: ["remote"], spawn: h.spawn });
  const read = client.call("remote", { method: "list_snapshot", params: {} });
  h.calls[0]!.child.stderr.write(Buffer.alloc(64 * 1024 + 1, "x"));
  await assert.rejects(read, (error: unknown) => error instanceof TuiSshError && error.code === "PEER_TUNNEL_UNAVAILABLE" &&
    !error.message.includes("x") && error.detail === undefined);
  h.calls[0]!.child.exit(); client.close();
  const version = `embassy ${"1".repeat(129)}\n`, h2 = scripted(["{}\n", version]);
  const second = createTuiSshClient({ nodes: ["remote"], spawn: h2.spawn });
  await assert.rejects(second.call("remote", { method: "list_snapshot", params: {} }), (error: unknown) =>
    error instanceof TuiSshError && error.detail?.detail === "unsupported response — remote CLI version unknown");
  second.close();
});
