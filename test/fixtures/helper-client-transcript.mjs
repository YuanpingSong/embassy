import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
class FakeChild extends EventEmitter {
  pid = 42_121; connected = true; killed = false;
  sent = []; signals = [];
  #actualIds = new Map(); #callbacks = new Map();
  send(message, callback) {
    const requestId = `fixture_request_${this.sent.length + 1}`;
    this.#actualIds.set(requestId, message.requestId);
    this.#callbacks.set(requestId, callback);
    this.sent.push({ ...message, requestId });
    return true;
  }
  respond(requestId, result) {
    this.emit("message", { protocolVersion: 2, type: "response",
      requestId: this.#actualIds.get(requestId), ok: true, result });
  }
  completeSend(requestId, error = null) {
    this.#callbacks.get(requestId)(error);
  }
  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}
const child = new FakeChild();
const originalFork = childProcess.fork;
childProcess.fork = () => child;
syncBuiltinESMExports();
try {
  const { ClaudeNativeHelperClient } = await import(
    "../../dist/src/gateway/claude-helper-supervisor.js");
  const registration = { alias: "codex-fixture@this-mac", sourceProvider: "codex", cwd: "/fixture" };
  const settled = [];
  const exits = [];
  const starting = ClaudeNativeHelperClient.start({
    entryPath: "/fixture/helper.js",
    runtime: { sessionsDir: "/fixture/sessions", socketDir: "/fixture/sockets" },
    hostId: "this-mac", deliveryNotices: "merged", maxPendingMessages: 8, registration,
    callbacks: { onEvent: () => assert.fail("unexpected event"), onExit: (event) => {
      exits.push(event);
      settled.push("callback:onExit");
    } },
  });
  assert.deepEqual(child.sent, [{ protocolVersion: 2, type: "initialize", requestId: "fixture_request_1",
    runtime: { sessionsDir: "/fixture/sessions", socketDir: "/fixture/sockets" }, hostId: "this-mac",
    deliveryNotices: "merged", maxPendingMessages: 8, registration }]);
  child.completeSend("fixture_request_1");
  child.respond("fixture_request_1", { generation: "fixture_generation" });
  const client = await starting;
  assert.equal(client.generation, "fixture_generation");
  const track = (label, promise) => promise.then(
    (value) => { settled.push(`${label}:ok`); return value; },
    (error) => { settled.push(`${label}:${error.code}`); throw error; });
  const timed = track("timed", client.request({ method: "release_inbound_receipt", receiptHandle: "receipt" }, 10));
  const answered = track("answered", client.request({ method: "update_status",
    alias: registration.alias, status: "idle" }, 100));
  child.completeSend("fixture_request_2");
  child.completeSend("fixture_request_3");
  child.respond("fixture_request_3", { ok: true });
  child.completeSend("fixture_request_3", new Error("late fixture IPC failure"));
  assert.deepEqual(await answered, { ok: true });
  await Promise.all([assert.rejects(timed, { code: "CLAUDE_NATIVE_HELPER_REQUEST_TIMEOUT" }), delay(15)]);
  child.respond("fixture_request_2", { released: true });
  const ipc = track("ipc", client.request({ method: "update_status", alias: registration.alias, status: "busy" }));
  child.completeSend("fixture_request_4", new Error("fixture IPC failure"));
  await assert.rejects(ipc, { code: "CLAUDE_NATIVE_HELPER_IPC_FAILED", recoverable: true });
  child.completeSend("fixture_request_4", new Error("duplicate fixture IPC failure"));
  child.respond("fixture_request_4", { ok: true });
  const exiting = track("exit", client.request({ method: "unadvertise", alias: registration.alias }));
  child.completeSend("fixture_request_5");
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  child.respond("fixture_request_5", { ok: true });
  await assert.rejects(exiting, { code: "CLAUDE_NATIVE_HELPER_EXITED" });
  await client.close();
  await Promise.resolve();
  assert.deepEqual(child.sent.slice(1), [
    { protocolVersion: 2, type: "request", requestId: "fixture_request_2",
      command: { method: "release_inbound_receipt", receiptHandle: "receipt" } },
    { protocolVersion: 2, type: "request", requestId: "fixture_request_3",
      command: { method: "update_status", alias: registration.alias, status: "idle" } },
    { protocolVersion: 2, type: "request", requestId: "fixture_request_4",
      command: { method: "update_status", alias: registration.alias, status: "busy" } },
    { protocolVersion: 2, type: "request", requestId: "fixture_request_5",
      command: { method: "unadvertise", alias: registration.alias } },
  ]);
  assert.deepEqual(settled, ["answered:ok", "timed:CLAUDE_NATIVE_HELPER_REQUEST_TIMEOUT",
    "ipc:CLAUDE_NATIVE_HELPER_IPC_FAILED", "callback:onExit", "exit:CLAUDE_NATIVE_HELPER_EXITED"]);
  assert.deepEqual(exits, [{ code: null, signal: "SIGTERM" }]);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  console.log("emb-121 client transcript: ok");
} finally {
  childProcess.fork = originalFork;
  syncBuiltinESMExports();
}
