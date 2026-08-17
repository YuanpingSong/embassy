import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  ClaudePeerAdapter,
  encodeClaudePeerUserFrame,
  type ClaudePeerAdapterOptions,
  type ClaudePeerConnect,
  type ClaudeProcessIdentity,
} from "../src/gateway/claude-peer.js";
import {
  assertClaudeNativeHelperIpcSize,
  isClaudeNativeHelperChildMessage,
  isClaudeNativeHelperParentMessage,
} from "../src/gateway/claude-helper-protocol.js";

const UID = process.getuid?.() ?? 501;
const SESSION = "00000000-0000-7000-8000-000000000111";
const MESSAGE = "00000000-0000-7000-8000-000000000222";
const DEADLINE = 1_900_000_000_000;

type Fixture = {
  adapter: ClaudePeerAdapter;
  home: string;
  processes: Map<number, ClaudeProcessIdentity>;
  root: string;
  sessionsDir: string;
  socketDir: string;
  stateDir: string;
  workspace: string;
  servers: Server[];
};

async function fixture(
  t: TestContext,
  overrides: { connect?: ClaudePeerConnect; now?: () => number } = {},
): Promise<Fixture> {
  const root = await realpath(await mkdtemp("/tmp/embassy-claude-contract-"));
  const sessionsDir = path.join(root, "sessions");
  const socketDir = path.join(root, "sockets");
  const home = path.join(root, "home");
  const workspace = path.join(home, "workspace");
  const stateDir = path.join(root, "state");
  const excludedTemp = path.join(root, "excluded-temp");
  await Promise.all([
    mkdir(sessionsDir, { mode: 0o700 }),
    mkdir(socketDir, { mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(excludedTemp, { mode: 0o700 }),
  ]);
  await chmod(home, 0o700);
  const processes = new Map<number, ClaudeProcessIdentity>();
  const servers: Server[] = [];
  const options: ClaudePeerAdapterOptions = {
    sessionsDir,
    socketDir,
    connectTimeoutMs: 100,
  };
  const adapter = new ClaudePeerAdapter(options, {
    expectedUid: UID,
    processInspector: async (pid) => processes.get(pid),
    createId: () => MESSAGE,
    userHome: home,
    tempRoots: [excludedTemp],
    ...(overrides.connect === undefined ? {} : { connect: overrides.connect }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  t.after(async () => {
    await adapter.close();
    await Promise.all(servers.map(async (server) => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
    await rm(root, { recursive: true, force: true });
  });
  return {
    adapter,
    home,
    processes,
    root,
    sessionsDir,
    socketDir,
    stateDir,
    workspace,
    servers,
  };
}

async function addPeer(
  current: Fixture,
  pid: number,
  onSocket: (socket: Socket) => void = (socket) => socket.resume(),
): Promise<{ registryPath: string; server: Server; socketPath: string }> {
  const socketPath = path.join(current.socketDir, `${pid}.sock`);
  const server = net.createServer(onSocket);
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  current.servers.push(server);
  current.processes.set(pid, { uid: UID, generation: `process-${pid}` });
  const registryPath = path.join(current.sessionsDir, `${pid}.json`);
  await writeFile(registryPath, JSON.stringify({
    pid,
    sessionId: SESSION,
    cwd: current.workspace,
    startedAt: 1,
    procStart: `process-${pid}`,
    version: "2.1.227",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: socketPath,
    name: `claude-${pid}`,
    status: "idle",
    updatedAt: 2,
    statusUpdatedAt: 2,
    ignoredFutureDiagnostic: { safe: true },
  }), { mode: 0o644 });
  return { registryPath, server, socketPath };
}

async function select(current: Fixture): Promise<string> {
  const peer = (await current.adapter.discover()).peers[0];
  assert.ok(peer !== undefined);
  assert.equal(peer.targetId, SESSION);
  await current.adapter.assertTargetWorkspaceDisjoint(
    peer.targetId,
    current.stateDir,
  );
  return peer.targetId;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("wire evidence did not arrive");
}

test("Claude user wire is one exact canonical NDJSON frame", () => {
  const actual = encodeClaudePeerUserFrame({
    messageId: MESSAGE,
    content: "exact body",
    from: "uds:/tmp/embassy-callback.sock",
  });
  assert.equal(
    actual.toString("utf8"),
    `${JSON.stringify({
      msgV: 1,
      msg_id: MESSAGE,
      type: "user",
      message: { role: "user", content: "exact body" },
      priority: "next",
      from: "uds:/tmp/embassy-callback.sock",
    })}\n`,
  );
  assert.throws(() => encodeClaudePeerUserFrame({
    messageId: MESSAGE,
    content: "exact body",
    from: "https://example.invalid",
  }));
});

test("Claude preparation is zero-write until one exact authorized perform", async (t) => {
  let now = DEADLINE - 10_000;
  let connections = 0;
  let wire = Buffer.alloc(0);
  const current = await fixture(t, { now: () => now });
  const original = await addPeer(current, 41_001);
  const targetId = await select(current);

  const denied = await current.adapter.prepareSend(targetId, "denied", {
    deadlineAt: DEADLINE,
  });
  denied.cancel();
  await assert.rejects(denied.perform(), (error: unknown) =>
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_PREPARATION_CONSUMED");
  assert.equal(connections, 0);

  await unlink(original.registryPath);
  await new Promise<void>((resolve) => original.server.close(() => resolve()));
  await addPeer(current, 41_002, (socket) => {
    connections += 1;
    socket.on("data", (chunk) => {
      wire = Buffer.concat([wire, chunk]);
    });
  });

  const prepared = await current.adapter.prepareSend(targetId, "authorized", {
    deadlineAt: DEADLINE,
  });
  const exact = encodeClaudePeerUserFrame({
    messageId: MESSAGE,
    content: "authorized",
  });
  assert.equal(connections, 0);
  assert.deepEqual(
    { frameBytes: prepared.frameBytes, sha256: prepared.sha256 },
    {
      frameBytes: exact.length,
      sha256: createHash("sha256").update(exact).digest("hex"),
    },
  );
  assert.deepEqual(await prepared.perform(), {
    messageId: MESSAGE,
    transportStatus: "transport_written",
  });
  await eventually(() => wire.includes(0x0a));
  assert.equal(connections, 1);
  assert.deepEqual(wire, exact);
  await assert.rejects(prepared.perform(), (error: unknown) =>
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_PREPARATION_CONSUMED");
  assert.equal(connections, 1);

  now = DEADLINE;
  await assert.rejects(
    current.adapter.prepareSend(targetId, "expired", { deadlineAt: DEADLINE }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CLAUDE_PEER_MESSAGE_EXPIRED",
  );
});

test("Claude post-connect uncertainty is ambiguous and never replayed", async (t) => {
  let writes = 0;
  const socket = new EventEmitter() as Socket;
  socket.destroy = (() => socket) as Socket["destroy"];
  socket.setTimeout = (() => socket) as Socket["setTimeout"];
  socket.end = ((_frame: Buffer) => {
    writes += 1;
    queueMicrotask(() => socket.emit("error", new Error("synthetic reset")));
    return socket;
  }) as Socket["end"];
  const current = await fixture(t, {
    connect: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  await addPeer(current, 42_001);
  const targetId = await select(current);
  const prepared = await current.adapter.prepareSend(targetId, "uncertain", {
    deadlineAt: Date.now() + 30_000,
  });
  await assert.rejects(prepared.perform(), (error: unknown) =>
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
    error.recoverable === false);
  await assert.rejects(prepared.perform(), (error: unknown) =>
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_PREPARATION_CONSUMED");
  assert.equal(writes, 1);
});

test("helper IPC keeps one strict prepare, perform, and cancel contract", () => {
  const requestId = "request_0123456789";
  const preparationId = "prep_0123456789abcdefghijklmn";
  const command = {
    method: "prepare_dispatch",
    binding: {
      provider: "claude",
      hostId: "this-mac",
      routeHandle: SESSION,
      registrationId: "registration-claude-one",
    },
    authorization: "selected_route",
    stateRoot: "/private/embassy-state",
    messageId: "message-one",
    sourceAlias: "codex-main@this-mac",
    sourceProvider: "codex",
    targetAlias: "claude-main@this-mac",
    conversationId: "conv_0123456789abcdef",
    text: "exact helper body",
    expectsReply: true,
    deadlineAt: "2030-01-01T00:00:00.000Z",
  } as const;
  const prepare = {
    protocolVersion: 1,
    type: "request",
    requestId,
    command,
  } as const;
  assert.equal(isClaudeNativeHelperParentMessage(prepare), true);
  assert.equal(
    JSON.stringify(prepare),
    '{"protocolVersion":1,"type":"request","requestId":"request_0123456789",' +
      '"command":{"method":"prepare_dispatch","binding":{"provider":"claude",' +
      '"hostId":"this-mac","routeHandle":"00000000-0000-7000-8000-000000000111",' +
      '"registrationId":"registration-claude-one"},"authorization":"selected_route",' +
      '"stateRoot":"/private/embassy-state","messageId":"message-one",' +
      '"sourceAlias":"codex-main@this-mac","sourceProvider":"codex",' +
      '"targetAlias":"claude-main@this-mac","conversationId":"conv_0123456789abcdef",' +
      '"text":"exact helper body","expectsReply":true,' +
      '"deadlineAt":"2030-01-01T00:00:00.000Z"}}',
  );

  const { stateRoot: _stateRoot, ...nativeCommand } = command;
  assert.equal(isClaudeNativeHelperParentMessage({
    ...prepare,
    command: { ...nativeCommand, authorization: "native_reply" },
  }), true);
  for (const invalidCommand of [
    { ...command, stateRoot: undefined },
    { ...nativeCommand, authorization: "native_reply", stateRoot: "/forbidden" },
    { ...command, sourceProvider: "unknown" },
    { ...command, privateThreadId: SESSION },
  ]) {
    assert.equal(isClaudeNativeHelperParentMessage({
      ...prepare,
      command: invalidCommand,
    }), false);
  }

  for (const method of ["perform_dispatch", "cancel_dispatch"] as const) {
    assert.equal(isClaudeNativeHelperParentMessage({
      ...prepare,
      command: { method, preparationId },
    }), true);
  }
  assert.equal(isClaudeNativeHelperParentMessage({
    ...prepare,
    command: { method: "perform_dispatch", preparationId: "prep_foreign" },
  }), false);

  const evidence = {
    protocolVersion: 1,
    type: "response",
    requestId,
    ok: true,
    result: {
      preparationId,
      frameBytes: 123,
      sha256: "a".repeat(64),
    },
  } as const;
  assert.equal(isClaudeNativeHelperChildMessage(evidence), true);
  assert.equal(isClaudeNativeHelperChildMessage({
    ...evidence,
    result: { ...evidence.result, body: "must not cross IPC evidence" },
  }), false);

  const escapedMaximum = {
    ...prepare,
    command: { ...command, text: "\u0001".repeat(16 * 1024) },
  };
  assert.doesNotThrow(() => assertClaudeNativeHelperIpcSize(escapedMaximum));
  assert.throws(
    () => assertClaudeNativeHelperIpcSize({ text: "\u0001".repeat(22 * 1024) }),
    /CLAUDE_NATIVE_HELPER_IPC_TOO_LARGE/u,
  );
});
