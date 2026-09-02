import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../src/errors.js";
import { ClaudeNativeHelperClient, type ClaudeNativeHelperClientLike,
  type ClaudeNativeHelperClientStartOptions } from "../src/gateway/claude-helper-client.js";
import { assertClaudeNativeHelperIpcSize, isClaudeNativeHelperParentMessage,
  CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS,
  type ClaudeNativeHelperCommand, type ClaudeNativeHelperResult } from "../src/gateway/claude-helper-protocol.js";
import { ClaudeNativeHelperSupervisor } from "../src/gateway/claude-helper-supervisor.js";
import type { GatewayAdapterCallbacks } from "../src/gateway/service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function missing(file: string): Promise<boolean> {
  try { await access(file); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

test("real-PID helpers own independent records and exact cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-helper-"));
  const sessionsDir = path.join(root, "sessions"), socketDir = path.join(root, "sockets");
  await mkdir(sessionsDir, { mode: 0o700 }); await mkdir(socketDir, { mode: 0o700 });
  await chmod(sessionsDir, 0o700); await chmod(socketDir, 0o700);
  const runtime = { sessionsDir, socketDir } as const;
  const entryPath = path.join(repoRoot, "dist/src/gateway/claude-helper.js");
  const exits: number[] = [];
  const start = (alias: string, sourceProvider: "codex") => ClaudeNativeHelperClient.start({
    entryPath, runtime, hostId: "this-mac", locale: "en", deliveryNotices: "merged", maxPendingMessages: 8,
    registration: { alias, sourceProvider, cwd: root }, callbacks: { onEvent: () => undefined, onExit: () => exits.push(1) },
  });
  let first: ClaudeNativeHelperClient | undefined, second: ClaudeNativeHelperClient | undefined;
  try {
    first = await start("codex-first@this-mac", "codex"); second = await start("codex-second@this-mac", "codex");
    assert.notEqual(first.pid, second.pid); assert.notEqual(first.pid, process.pid); assert.notEqual(first.generation, second.generation);
    const owned = (client: ClaudeNativeHelperClient) => ({
      record: path.join(sessionsDir, `${client.pid}.json`), socket: path.join(socketDir, `${client.pid}.sock`),
    });
    const a = owned(first), b = owned(second);
    const [recordA, recordB] = await Promise.all([readFile(a.record, "utf8").then(JSON.parse), readFile(b.record, "utf8").then(JSON.parse)]);
    assert.deepEqual([recordA.pid, recordA.name, recordA.messagingSocketPath], [first.pid, "codex-first", a.socket]);
    assert.deepEqual([recordB.pid, recordB.name, recordB.messagingSocketPath], [second.pid, "codex-second", b.socket]);
    await first.close(); first = undefined;
    assert.equal(await missing(a.record), true); assert.equal(await missing(a.socket), true);
    assert.equal(await missing(b.record), false); assert.equal(await missing(b.socket), false);
    await second.close(); second = undefined;
    assert.equal(await missing(b.record), true); assert.equal(await missing(b.socket), true); assert.equal(exits.length, 2);
  } finally { await first?.forceClose().catch(() => undefined); await second?.forceClose().catch(() => undefined);
    await rm(root, { recursive: true, force: true }); }
});

const route = { provider: "claude", hostId: "this-mac", routeHandle: "00000000-0000-7000-8000-000000000111",
  registrationId: "registration-first" } as const;
const prepare = { method: "prepare_dispatch", binding: route, authorization: "selected_route", stateRoot: "/state",
  messageId: "gateway-message-first", sourceAlias: "codex-first@this-mac", sourceProvider: "codex",
  targetAlias: "claude-first@this-mac", conversationId: "conv_0123456789abcdef", text: "body", expectsReply: false,
  deadlineAt: "2030-01-01T00:00:00.000Z", progressWatchActive: true } as const;
const envelope = (command: unknown) => ({ protocolVersion: 1, type: "request", requestId: "request_0123456789", command });

test("helper IPC strictly binds preparation authority and bounds", () => {
  const initialization = { protocolVersion: 1, type: "initialize", requestId: "request_0123456789",
    runtime: { sessionsDir: "/tmp/sessions", socketDir: "/tmp/sockets" }, hostId: "this-mac", locale: "en",
    deliveryNotices: "merged", maxPendingMessages: 8,
    registration: { alias: "peer-builder@this-mac", sourceProvider: "peer", cwd: "/workspace/peer" } } as const;
  assert.equal(isClaudeNativeHelperParentMessage(initialization), true);
  assert.equal(isClaudeNativeHelperParentMessage({ ...initialization, runtime: { ...initialization.runtime, extra: true } }), false);
  assert.equal(isClaudeNativeHelperParentMessage({ ...initialization,
    registration: { ...initialization.registration, sourceProvider: "unknown" } }), false);
  assert.equal(isClaudeNativeHelperParentMessage({ ...initialization,
    registration: { ...initialization.registration, sourceProvider: "claude" } }), false);
  assert.equal(isClaudeNativeHelperParentMessage(envelope(prepare)), true);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, stateRoot: undefined })), false);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, authorization: "native_reply", stateRoot: undefined })), true);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, authorization: "native_reply" })), false);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, unexpected: true })), false);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, sourceProvider: "unknown" })), false);
  assert.equal(isClaudeNativeHelperParentMessage(envelope({ ...prepare, text: "x".repeat(16 * 1024 + 1) })), false);
  for (const method of ["perform_dispatch", "cancel_dispatch"] as const) {
    assert.equal(isClaudeNativeHelperParentMessage(envelope({ method, preparationId: "prep_0123456789abcdefghijklmn" })), true);
    assert.equal(isClaudeNativeHelperParentMessage(envelope({ method, preparationId: "prep_foreign" })), false);
  }
  const maximum = envelope({ ...prepare, text: "\u0001".repeat(16 * 1024) });
  assert.equal(isClaudeNativeHelperParentMessage(maximum), true); assert.doesNotThrow(() => assertClaudeNativeHelperIpcSize(maximum));
});

class FakeClient implements ClaudeNativeHelperClientLike {
  readonly commands: ClaudeNativeHelperCommand[] = []; readonly pid: number;
  readonly registration: ClaudeNativeHelperClientLike["registration"]; generation: string; closed = false;
  constructor(readonly options: ClaudeNativeHelperClientStartOptions, index: number) {
    this.pid = 50_000 + index; this.registration = options.registration; this.generation = `helper_${index}`;
  }
  async request(command: ClaudeNativeHelperCommand): Promise<ClaudeNativeHelperResult> {
    this.commands.push(command);
    if (command.method === "prepare_dispatch") return { preparationId: "prep_0123456789abcdefghijklmn", frameBytes: 123, sha256: "a".repeat(64) };
    if (command.method === "perform_dispatch") return { state: "delivered" };
    if (command.method === "release_inbound_receipt") return { released: true };
    return { ok: true };
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.options.callbacks.onExit({ code: 0, signal: null }); } }
  forceClose(): Promise<void> { return this.close(); }
  crash(): void { if (!this.closed) { this.closed = true; this.options.callbacks.onExit({ code: 1, signal: null }); } }
}

test("supervisor binds source, namespaces receipts, and consumes preparations once", async () => {
  const clients: FakeClient[] = [], messages: Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0][] = [], notices: string[] = [];
  const callbacks: GatewayAdapterCallbacks = { onRouteState: () => undefined, onClaudeReply: () => undefined,
    onClaudeMessage: (message) => messages.push(message), onProtocolNotice: (notice) => notices.push(notice.code) };
  const supervisor = new ClaudeNativeHelperSupervisor({ identity: { provider: "claude", hostId: "this-mac" },
    runtime: { sessionsDir: "/tmp/sessions", socketDir: "/tmp/sockets" }, locale: "en", deliveryNotices: "merged",
    maxPendingMessages: 8, maxHelpers: 2, callbacks: () => callbacks,
    factory: async (options) => { const client = new FakeClient(options, clients.length + 1); clients.push(client); return client; } });
  try {
    await supervisor.advertise({ alias: "codex-first@this-mac", sourceProvider: "codex", cwd: "/workspace/first" });
    await supervisor.advertise({ alias: "codex-second@this-mac", sourceProvider: "codex", cwd: "/workspace/second" });
    for (const [index, client] of clients.entries()) client.options.callbacks.onEvent({ event: "claude_message", value: {
      routeHandle: `00000000-0000-7000-8000-00000000011${index + 1}`, sourceAlias: `claude-${index}@this-mac`,
      targetAlias: client.registration.alias, text: "inbound", receiptHandle: "same-child-handle" } });
    assert.equal(messages.length, 2); assert.notEqual(messages[0]!.receiptHandle, messages[1]!.receiptHandle);
    await supervisor.updateInboundStatus(messages[0]!.receiptHandle!, "delivered");
    assert.deepEqual(clients[0]!.commands.at(-1), { method: "update_inbound_status", receiptHandle: "same-child-handle", status: "delivered" });

    const input = { sourceAlias: "codex-first@this-mac", sourceProvider: "codex", targetAlias: "claude-first@this-mac",
      conversationId: "conv_0123456789abcdef", selectedAlias: "claude-first@this-mac", stateRoot: "/state", binding: route,
      authorization: "selected_route", messageId: "gateway-message-first", text: "outbound", expectsReply: false,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(), progressWatchActive: true } as const;
    const prepared = await supervisor.prepareDispatch(input);
    assert.deepEqual(clients[0]!.commands.at(-1), { ...prepare, text: "outbound", deadlineAt: input.deadlineAt });
    assert.deepEqual(await prepared.perform(), { state: "delivered" });
    assert.deepEqual(await prepared.perform(), { state: "failed", safeErrorCode: "CLAUDE_NATIVE_PREPARATION_CONSUMED" });
    const denied = await supervisor.prepareDispatch({ ...input, messageId: "gateway-message-denied" }); await denied.cancel();
    assert.equal(clients[0]!.commands.at(-1)!.method, "cancel_dispatch"); assert.deepEqual(await denied.perform(), {
      state: "failed", safeErrorCode: "CLAUDE_NATIVE_PREPARATION_CONSUMED" });
    const count = clients[0]!.commands.length;
    await assert.rejects(supervisor.prepareDispatch({ ...input, sourceProvider: "peer" }),
      (error: unknown) => error instanceof BridgeError && error.code === "PROVENANCE_ENVELOPE_INVALID");
    assert.equal(clients[0]!.commands.length, count);
    const renamed = await supervisor.prepareDispatch({ ...input, selectedAlias: "claude-renamed@this-mac" });
    assert.deepEqual(await renamed.perform(), { state: "delivered" });
    assert.equal((clients[0]!.commands.at(-2) as Extract<ClaudeNativeHelperCommand, { method: "prepare_dispatch" }>).targetAlias,
      "claude-first@this-mac");
    const reply = await supervisor.prepareDispatch({ ...input, authorization: "native_reply", stateRoot: "/must-not-cross-ipc" });
    const replyCommand = clients[0]!.commands.at(-1)!;
    assert.equal(replyCommand.method, "prepare_dispatch");
    assert.equal("stateRoot" in replyCommand, false); await reply.cancel();
    clients[0]!.crash(); assert.equal(supervisor.size, 1); assert.equal(notices.at(-1), "CLAUDE_NATIVE_HELPER_EXITED");
    await supervisor.updateStatus("codex-second@this-mac", "busy"); assert.equal(clients[1]!.commands.at(-1)!.method, "update_status");
  } finally { await supervisor.close(); }
});

test("unadvertise destroys only the exact helper", async () => {
  const clients: FakeClient[] = [];
  const supervisor = new ClaudeNativeHelperSupervisor({ identity: { provider: "claude", hostId: "this-mac" },
    runtime: { sessionsDir: "/tmp/sessions", socketDir: "/tmp/sockets" }, locale: "en", deliveryNotices: "merged",
    maxPendingMessages: 8, maxHelpers: 1, callbacks: () => undefined,
    factory: async (options) => { const client = new FakeClient(options, clients.length + 1); clients.push(client); return client; } });
  await supervisor.advertise({ alias: "codex-old@this-mac", sourceProvider: "codex", cwd: "/old" });
  await supervisor.unadvertise("codex-old@this-mac");
  assert.equal(clients[0]!.closed, true); assert.deepEqual(clients[0]!.commands, [{ method: "unadvertise", alias: "codex-old@this-mac" }]);
  await supervisor.advertise({ alias: "codex-new@this-mac", sourceProvider: "codex", cwd: "/new" });
  assert.equal(supervisor.size, 1); await supervisor.close();
});

test("forked fake helper expires and fences capabilities, ambiguity, and receipt ownership", async () => {
  const root = await mkdtemp(path.join("/tmp", "embassy-helper-fake-"));
  const entryPath = path.join(root, "child.mjs"), marker = path.join(root, "perform.marker");
  await writeFile(entryPath, `
    import { appendFileSync } from "node:fs";
    let held; const ttl = 25;
    const send = (requestId, result) => process.send({protocolVersion:1,type:"response",requestId,ok:true,result});
    const fail = (requestId, code) => process.send({protocolVersion:1,type:"response",requestId,ok:false,error:{code,recoverable:false}});
    process.on("message", (message) => {
      if (message.type === "initialize") return send(message.requestId, {generation:"fake_generation"});
      const command = message.command;
      if (command.method === "prepare_dispatch") {
        clearTimeout(held?.timer); const id = "prep_0123456789abcdefghijklmn";
        held = {id, messageId:command.messageId, timer:setTimeout(() => { held = undefined; }, ttl)};
        return send(message.requestId, {preparationId:id,frameBytes:123,sha256:"a".repeat(64)});
      }
      if (command.method === "perform_dispatch" || command.method === "cancel_dispatch") {
        if (!held) return fail(message.requestId, "CLAUDE_NATIVE_PREPARATION_UNKNOWN");
        const current = held;
        if (command.preparationId !== current.id) return fail(message.requestId, "CLAUDE_NATIVE_PREPARATION_MISMATCH");
        held = undefined; clearTimeout(current.timer);
        if (command.method === "cancel_dispatch") return send(message.requestId, {ok:true});
        if (current.messageId === "crash-during-perform") { appendFileSync(${JSON.stringify(marker)}, "perform\\n"); return process.exit(9); }
        return send(message.requestId, {state:"delivered"});
      }
      if (command.method === "update_status" && command.status === "waiting") process.send({protocolVersion:1,type:"event",value:{event:"claude_message",value:{routeHandle:"00000000-0000-7000-8000-000000000111",sourceAlias:"claude-first@this-mac",targetAlias:"codex-fake@this-mac",text:"inbound",receiptHandle:"child-receipt"}}});
      if (command.method === "release_inbound_receipt") return send(message.requestId, {released:true});
      if (command.method === "close") { send(message.requestId, {ok:true}); return setImmediate(() => process.exit(0)); }
      send(message.requestId, {ok:true});
    });
  `, { mode: 0o600 });
  const messages: Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0][] = [];
  let client: ClaudeNativeHelperClient | undefined;
  const supervisor = new ClaudeNativeHelperSupervisor({ identity: { provider: "claude", hostId: "this-mac" },
    runtime: { sessionsDir: "/unused", socketDir: "/unused" }, locale: "en", deliveryNotices: "merged",
    maxPendingMessages: 4, maxHelpers: 1,
    callbacks: () => ({ onRouteState: () => undefined, onClaudeReply: () => undefined, onClaudeMessage: (value) => messages.push(value) }),
    factory: async (options) => client = await ClaudeNativeHelperClient.start({ ...options, entryPath }) });
  const deadlineAt = new Date(Date.now() + 30_000).toISOString();
  const command = { ...prepare, sourceAlias: "codex-fake@this-mac", deadlineAt } as const;
  try {
    await supervisor.advertise({ alias: "codex-fake@this-mac", sourceProvider: "codex", cwd: "/unused" });
    const evidence = await client!.request(command); assert.ok("preparationId" in evidence); await delay(40);
    await assert.rejects(client!.request({ method: "perform_dispatch", preparationId: evidence.preparationId }),
      (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_NATIVE_PREPARATION_UNKNOWN");
    for (const method of ["perform_dispatch", "cancel_dispatch"] as const) {
      const next = await client!.request({ ...command, messageId: `foreign-${method}` }); assert.ok("preparationId" in next);
      await assert.rejects(client!.request({ method, preparationId: "prep_abcdefghijklmnopqrstuvwx" }),
        (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_NATIVE_PREPARATION_MISMATCH");
      const exact = await client!.request({ method, preparationId: next.preparationId });
      assert.deepEqual(exact, method === "perform_dispatch" ? { state: "delivered" } : { ok: true });
    }
    await supervisor.updateStatus("codex-fake@this-mac", "waiting"); assert.equal(messages.length, 1);
    const crash = await supervisor.prepareDispatch({ ...command, selectedAlias: command.targetAlias,
      messageId: "crash-during-perform" });
    assert.deepEqual(await crash.perform(), { state: "ambiguous", safeErrorCode: "CLAUDE_NATIVE_HELPER_PERFORM_UNCERTAIN" });
    await delay(10); assert.equal(supervisor.size, 0);
    assert.equal(await supervisor.releaseInboundReceipt(messages[0]!.receiptHandle!), false);
    assert.equal(await readFile(marker, "utf8"), "perform\n");
  } finally { await supervisor.close().catch(() => undefined); await client?.forceClose().catch(() => undefined);
    await rm(root, { recursive: true, force: true }); }
});

test("production helper child owns TTL and non-consuming foreign preparation fences", async () => {
  const root = await realpath(await mkdtemp(path.join("/tmp", "embassy-helper-real-")));
  const workspace = await realpath(await mkdtemp(path.join(os.homedir(), ".embassy-helper-workspace-")));
  const sessionsDir = path.join(root, "sessions"), socketDir = path.join(root, "sockets"), stateRoot = path.join(root, "state");
  await Promise.all([mkdir(sessionsDir, { mode: 0o700 }), mkdir(socketDir, { mode: 0o700 }), mkdir(stateRoot, { mode: 0o700 })]);
  const peerPath = path.join(root, "peer.mjs");
  await writeFile(peerPath, `
    import { execFileSync } from "node:child_process";
    import { chmodSync } from "node:fs";
    import net from "node:net";
    import path from "node:path";
    const socketPath = path.join(process.argv[2], process.pid + ".sock");
    const server = net.createServer((socket) => { const chunks = []; socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => process.send({wire:Buffer.concat(chunks).toString("base64")})); });
    server.listen(socketPath, () => { chmodSync(socketPath, 0o600);
      const output = execFileSync("/bin/ps", ["-o", "uid=,lstart=", "-p", String(process.pid)], {encoding:"utf8",env:{LC_ALL:"C",PATH:"/usr/bin:/bin:/usr/sbin:/sbin"}});
      process.send({ready:true,socketPath,procStart:/^\\s*[0-9]+\\s+(.+?)\\s*$/.exec(output)[1]}); });
    process.on("message", (message) => { if (message === "close") server.close(() => process.exit(0)); });
  `, { mode: 0o600 });
  const peer: ChildProcess = fork(peerPath, [socketDir], { serialization: "json", stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const wires: string[] = [];
  const ready = await new Promise<{ procStart: string; socketPath: string }>((resolve, reject) => {
    peer.once("error", reject); peer.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null && "wire" in value) wires.push(String(value.wire));
      if (typeof value === "object" && value !== null && "ready" in value && "procStart" in value && "socketPath" in value)
        resolve(value as { procStart: string; socketPath: string });
    });
  });
  const routeHandle = "00000000-0000-7000-8000-000000000111";
  const recordPath = path.join(sessionsDir, `${peer.pid}.json`);
  const record = { pid: peer.pid, sessionId: routeHandle,
    cwd: workspace, startedAt: Date.now(), procStart: ready.procStart, version: "test", peerProtocol: 1,
    kind: "bg", entrypoint: "cli", messagingSocketPath: ready.socketPath, name: "claude-fake", status: "idle",
    updatedAt: Date.now(), statusUpdatedAt: Date.now() };
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  let helper: ClaudeNativeHelperClient | undefined, resolveInbound!: () => void; const inbound = new Promise<void>((resolve) => { resolveInbound = resolve; });
  const command = { ...prepare, binding: { ...route, hostId: "studio", routeHandle }, sourceAlias: "codex-real@studio",
    targetAlias: "claude-fake@studio", stateRoot, deadlineAt: new Date(Date.now() + 30_000).toISOString() } as const;
  try {
    helper = await ClaudeNativeHelperClient.start({ entryPath: path.join(repoRoot, "dist/src/gateway/claude-helper.js"),
      runtime: { sessionsDir, socketDir }, hostId: "studio", locale: "en", deliveryNotices: "merged", maxPendingMessages: 8,
      registration: { alias: command.sourceAlias, sourceProvider: "codex", cwd: workspace },
      callbacks: { onEvent: (event) => { if (JSON.stringify(event).includes('"sourceAlias":"claude-fake@studio"')) resolveInbound(); }, onExit: () => undefined } });
    const helperRecord = JSON.parse(await readFile(path.join(sessionsDir, `${helper.pid}.json`), "utf8")) as { messagingSocketPath: string }; await new Promise<void>((resolve, reject) => { const socket = connect(helperRecord.messagingSocketPath, () => socket.end(JSON.stringify({
      msgV: 1, msg_id: "00000000-0000-7000-8000-000000000333", type: "user", message: { role: "user", content: "inbound" }, priority: "next", from: `uds:${ready.socketPath}` }) + "\n")); socket.on("error", reject); socket.on("close", () => resolve()); });
    await Promise.race([inbound, delay(1_000).then(() => assert.fail("custom-host inbound was not forwarded"))]);
    const expired = await helper.request({ ...command, messageId: "expires" }); assert.ok("preparationId" in expired);
    await delay(CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS + 50);
    for (const method of ["perform_dispatch", "cancel_dispatch"] as const)
      await assert.rejects(helper.request({ method, preparationId: expired.preparationId }),
        (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_NATIVE_PREPARATION_UNKNOWN");
    const foreignId = "prep_abcdefghijklmnopqrstuvwx";
    for (const method of ["cancel_dispatch", "perform_dispatch"] as const) {
      const held = await helper.request({ ...command, messageId: `real-${method}` }); assert.ok("preparationId" in held);
      await assert.rejects(helper.request({ method, preparationId: foreignId }),
        (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_NATIVE_PREPARATION_MISMATCH");
      assert.deepEqual(await helper.request({ method, preparationId: held.preparationId }),
        method === "perform_dispatch" ? { state: "delivered" } : { ok: true });
    }
    await chmod(workspace, 0o777);
    await assert.rejects(helper.request({ ...command, messageId: "workspace-drift" }),
      (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_PEER_WORKSPACE_UNSAFE");
    await chmod(workspace, 0o700); assert.equal(wires.length, 1);
    await assert.rejects(helper.request({ ...command, binding: { ...command.binding, hostId: "m5dev" }, messageId: "foreign-host" }),
      (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_ROUTE_MISMATCH");
    await writeFile(recordPath, JSON.stringify({ ...record,
      sessionId: "00000000-0000-7000-8000-000000000222", updatedAt: Date.now() }), { mode: 0o600 });
    await assert.rejects(helper.request({ ...command, messageId: "stale-uuid" }),
      (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_ROUTE_MISMATCH");
    await delay(20); assert.equal(wires.length, 1);
  } finally {
    await helper?.forceClose().catch(() => undefined); if (peer.connected) peer.send("close");
    if (peer.exitCode === null && peer.signalCode === null) await Promise.race([once(peer, "exit"), delay(1_000)]);
    if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGKILL");
    await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  }
});
