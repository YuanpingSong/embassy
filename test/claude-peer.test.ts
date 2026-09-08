import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net, { type Server } from "node:net";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { MessagingBroker } from "../src/gateway/broker.js";
import { handleBrokerCommand } from "../src/gateway/broker-control.js";
import { Coordinator, type Destination } from "../src/gateway/coordinator.js";
import { runCoreCli } from "../src/gateway/core-cli.js";
import { EndpointDirectory } from "../src/gateway/endpoint-directory.js";
import { bodyHash, ledgerDefaults } from "../src/gateway/ledger.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { serveLocalControl } from "../src/gateway/local-control.js";
import { ClaudeDestination } from "../src/gateway/native-destinations.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

import { BridgeError } from "../src/errors.js";
import {
  ClaudePeerAdapter,
  encodeClaudePeerUserFrame,
  type ClaudePeerAdapterOptions,
  type ClaudePeerAdapterTestOverrides,
  type ClaudeProcessIdentity,
} from "../src/gateway/claude-peer.js";

const UID = process.getuid?.() ?? 501;
const TEST_VERSION = "2.1.227";
const SESSION_ONE = "00000000-0000-4000-8000-000000000001";
const SESSION_TWO = "00000000-0000-4000-8000-000000000002";
const SESSION_THREE = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ONE = "00000000-0000-4000-8000-000000000101";

type Fixture = {
  root: string;
  home: string;
  workspace: string;
  stateDir: string;
  systemTemp: string;
  sessionsDir: string;
  socketDir: string;
  processes: Map<number, ClaudeProcessIdentity>;
  servers: Server[];
  adapter: ClaudePeerAdapter;
};

type FixtureOverrides = Partial<
  Omit<
    ClaudePeerAdapterOptions,
    "sessionsDir" | "socketDir"
  >
> &
  Omit<
    ClaudePeerAdapterTestOverrides,
    "processInspector" | "userHome" | "tempRoots"
  >;

async function fixture(
  t: TestContext,
  overrides: FixtureOverrides = {},
): Promise<Fixture> {
  // Keep the test-owned root short enough for Darwin's Unix socket pathname
  // limit. os.tmpdir() can be a long per-user path there. This still never uses the real
  // /tmp/cc-socks root or ~/.claude.
  const createdRoot = await mkdtemp(
    path.join("/tmp", "synthetic-cc-peer-"),
  );
  const root = await realpath(createdRoot);
  const sessionsDir = path.join(root, "sessions");
  const socketDir = path.join(root, "sockets");
  const home = path.join(root, "home");
  const workspace = path.join(home, "workspace");
  const stateDir = path.join(root, "state");
  const systemTemp = path.join(root, "system-temp");
  await Promise.all([
    mkdir(sessionsDir, { mode: 0o700 }),
    mkdir(socketDir, { mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(systemTemp, { mode: 0o700 }),
  ]);
  await chmod(home, 0o700);
  const processes = new Map<number, ClaudeProcessIdentity>();
  const servers: Server[] = [];
  const {
    connect,
    now,
    createId,
    expectedUid,
    ...productionOverrides
  } = overrides;
  const adapter = new ClaudePeerAdapter(
    {
      sessionsDir,
      socketDir,
      connectTimeoutMs: 500,
      ...productionOverrides,
    },
    {
      processInspector: async (pid) => processes.get(pid),
      ...(expectedUid === undefined ? {} : { expectedUid }),
      ...(connect === undefined ? {} : { connect }),
      ...(now === undefined ? {} : { now }),
      ...(createId === undefined ? {} : { createId }),
      userHome: home,
      tempRoots: [systemTemp],
    },
  );
  t.after(async () => {
    await adapter.close();
    await Promise.all(
      servers.map(
        async (server) =>
          await new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    workspace,
    stateDir,
    systemTemp,
    sessionsDir,
    socketDir,
    processes,
    servers,
    adapter,
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
}

async function addPeer(
  current: Fixture,
  input: {
    pid: number;
    startedAt?: number;
    sessionId?: string;
    name?: string;
    kind?: string;
    status?: string;
    peerProtocol?: number;
    socketPath?: string;
    recordPid?: number;
    cwd?: string;
    version?: string;
    omitVersion?: boolean;
    nameSource?: string | null;
    omitStatus?: boolean;
    handler?: (socket: net.Socket) => void;
  },
): Promise<{ socketPath: string; registryPath: string; server: Server }> {
  const socketPath =
    input.socketPath ?? path.join(current.socketDir, `${input.pid}.sock`);
  const server = net.createServer(input.handler);
  await listen(server, socketPath);
  current.servers.push(server);
  current.processes.set(input.pid, {
    uid: UID,
    generation: `process-generation-${input.pid}`,
  });
  const registryPath = path.join(current.sessionsDir, `${input.pid}.json`);
  await writeFile(
    registryPath,
    JSON.stringify({
      pid: input.recordPid ?? input.pid,
      sessionId: input.sessionId ?? SESSION_ONE,
      cwd: input.cwd ?? current.workspace,
      startedAt: input.startedAt ?? 1_786_148_832_556,
      procStart: "Sat Aug  8 00:27:11 2026",
      ...(input.omitVersion
        ? {}
        : {
            version:
              input.version ?? TEST_VERSION,
          }),
      peerProtocol: input.peerProtocol ?? 1,
      kind: input.kind ?? "interactive",
      entrypoint: "cli",
      messagingSocketPath: socketPath,
      name: input.name ?? `peer-${input.pid}`,
      ...(input.nameSource === undefined
        ? {}
        : { nameSource: input.nameSource }),
      ...(input.omitStatus ? {} : { status: input.status ?? "idle" }),
      updatedAt: 1_786_149_062_112,
      ...(input.omitStatus ? {} : { statusUpdatedAt: 1_786_149_062_112 }),
    }),
    { mode: 0o644 },
  );
  return { socketPath, registryPath, server };
}

async function selectFirstPeer(current: Fixture) {
  const target = (await current.adapter.discover()).peers[0];
  assert.ok(target !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    target.targetId,
    current.stateDir,
  );
  return target;
}

async function prepareAndPerform(
  current: Fixture,
  targetId: string,
  content: string,
) {
  const prepared = await current.adapter.prepareSend(targetId, content, {
    deadlineAt: Date.now() + 30_000,
  });
  return await prepared.perform(async () => true);
}

async function sendLines(
  socketPath: string,
  chunks: readonly (string | Buffer)[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.once("error", reject);
    socket.once("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end(resolve);
    });
  });
}

async function eventually(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("condition did not become true before the deadline");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("adapter normalizes its private roots without launcher metadata", () => {
  assert.throws(
    () =>
      new ClaudePeerAdapter({
        sessionsDir: "relative/sessions",
        socketDir: "/synthetic/sockets",
      }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_PEER_PATH",
  );
});

test("discovery returns stable session UUID targets and never treats names as authority", async (t) => {
  const current = await fixture(t);
  await addPeer(current, {
    pid: 41_101,
    sessionId: SESSION_ONE,
    name: "same-name",
    status: "busy",
  });
  await addPeer(current, {
    pid: 41_102,
    sessionId: SESSION_TWO,
    name: "same-name",
    kind: "bg",
  });

  const result = await current.adapter.discover();
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rejected, {});
  assert.equal(result.entriesScanned, 2);
  assert.equal(result.parseableRecords, 2);
  assert.equal(result.peers.length, 2);
  assert.equal(result.peers[0]?.alias, "same-name");
  assert.equal(result.peers[1]?.alias, "same-name");
  assert.notEqual(result.peers[0]?.targetId, result.peers[1]?.targetId);
  assert.deepEqual(Object.keys(result.peers[0] ?? {}).sort(), [
    "alias",
    "compatibility",
    "kind",
    "status",
    "targetId",
  ]);
  assert.ok(!JSON.stringify(result).includes(current.root));
  assert.deepEqual(
    result.peers.map((peer) => peer.targetId).sort(),
    [SESSION_ONE, SESSION_TWO],
  );
  assert.ok(!JSON.stringify(result).includes("41101"));
});

test("duplicate live sessions select the newest process, probe without writing and resolve both callers", async (t) => {
  const current = await fixture(t);
  const writes: string[] = [];
  let received!: () => void;
  const messageReceived = new Promise<void>((resolve) => { received = resolve; });
  const first = await addPeer(current, {
    pid: 41_103,
    sessionId: SESSION_ONE,
    name: "first-record",
    startedAt: 100,
    handler: (socket) => socket.on("data", (data) => { writes.push(`first:${data}`); received(); }),
  });
  const second = await addPeer(current, {
    pid: 41_104,
    sessionId: SESSION_ONE,
    name: "second-record",
    startedAt: 200,
    handler: (socket) => socket.on("data", (data) => writes.push(`second:${data}`)),
  });
  // OS process age, not PID order or the registry's timestamps, wins.
  current.processes.set(41_103, { uid: UID, generation: "Tue Sep  8 12:00:02 2026" });
  current.processes.set(41_104, { uid: UID, generation: "Tue Sep  8 12:00:01 2026" });
  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0]?.alias, "first-record");
  assert.deepEqual(result.peers[0]?.duplicate, { selectedPid: 41_103, newestPid: 41_103, otherPids: [41_104], reason: "stale_older" });
  assert.deepEqual(result.rejected, { CLAUDE_SESSION_DUPLICATE: 1 });
  for (const address of [first.socketPath, second.socketPath])
    assert.deepEqual(await current.adapter.resolveReplyAddress(`uds:${address}`), result.peers[0]);
  assert.deepEqual(writes, []);
  await current.adapter.assertTargetWorkspaceDisjoint(SESSION_ONE, current.stateDir);
  const prepared = await current.adapter.prepareSend(SESSION_ONE, "selected only", { deadlineAt: Date.now() + 10_000 });
  await prepared.perform(async () => true);
  await messageReceived;
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /^first:.*selected only/);
  await unlink(second.registryPath);
  assert.equal((await current.adapter.discover()).peers[0]?.duplicate, undefined);
});

test("duplicate selection skips a non-listening socket and bounds a hanging probe without writing", async (t) => {
  const sockets: EventEmitter[] = [];
  const current = await fixture(t, { connectTimeoutMs: 10, connect: (socketPath) => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => { socket.emit("close"); return socket; };
    socket.write = () => { assert.fail("liveness probe wrote data"); };
    sockets.push(socket);
    if (socketPath.endsWith("41103.sock")) queueMicrotask(() => socket.emit("connect"));
    return socket;
  } });
  await addPeer(current, { pid: 41_103, startedAt: 100 });
  await addPeer(current, { pid: 41_104, startedAt: 200 });
  // Keep an owned handle alive while the adapter's unref'ed deadline fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const found = await current.adapter.discover();
    assert.deepEqual(found.peers[0]?.duplicate, { selectedPid: 41_103, newestPid: 41_104, otherPids: [41_104], reason: "unreachable_newest" });
    assert.equal(sockets.length, 2);
  } finally { clearInterval(keepAlive); }
});

test("a new duplicate after preparation invalidates the old selection before authorization", async (t) => {
  const current = await fixture(t);
  const writes: string[] = [];
  await addPeer(current, { pid: 41_103, startedAt: 100, handler: (s) => s.on("data", (b) => writes.push(String(b))) });
  await current.adapter.discover();
  await current.adapter.assertTargetWorkspaceDisjoint(SESSION_ONE, current.stateDir);
  const prepared = await current.adapter.prepareSend(SESSION_ONE, "old prepared message", { deadlineAt: Date.now() + 10_000 });
  await addPeer(current, { pid: 41_104, startedAt: 200, handler: (s) => s.on("data", (b) => writes.push(String(b))) });
  let authorized = false;
  await assert.rejects(prepared.perform(async () => { authorized = true; return true; }), { code: "CLAUDE_PEER_TARGET_CHANGED" });
  assert.equal(authorized, false);
  assert.deepEqual(writes, []);
});

test("duplicate probes share one deadline and a sixteen-socket concurrency bound across groups", async (t) => {
  let active = 0, maximum = 0, probes = 0, ready!: () => void;
  const batchReady = new Promise<void>((resolve) => { ready = resolve; });
  const current = await fixture(t, { connectTimeoutMs: 10, connect: () => {
    const socket = new EventEmitter() as net.Socket;
    probes++; active++; maximum = Math.max(maximum, active);
    socket.destroy = () => { active--; socket.emit("close"); return socket; };
    socket.write = () => assert.fail("probe wrote a message");
    if (probes === 16) ready();
    return socket;
  } });
  for (let index = 0; index < 20; index++) {
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await addPeer(current, { pid: 42_000 + index * 2, sessionId });
    await addPeer(current, { pid: 42_001 + index * 2, sessionId });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const discovery = current.adapter.discover();
  await batchReady;
  assert.equal(active, 16);
  t.mock.timers.tick(10);
  const found = await discovery;
  assert.equal(maximum, 16);
  assert.equal(probes, 16); // remaining groups do not buy another deadline
  assert.equal(active, 0);
  assert.equal(found.peers.length, 20);
  assert.ok(found.peers.every((peer) => peer.duplicate?.reason === "all_unreachable"));
  assert.equal(found.rejected.PID_NOT_LIVE, undefined);
});

test("native delivery reuses its selection and never probes a socket held by the write", async (t) => {
  let connects = 0;
  const current = await fixture(t, { connect: (socketPath) => {
    connects++; return net.createConnection({ path: socketPath });
  } });
  await addPeer(current, { pid: 41_103, name: "advisor", startedAt: 100 });
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => { received = resolve; });
  await addPeer(current, { pid: 41_104, name: "advisor", startedAt: 200,
    handler: (socket) => socket.on("data", () => received()) });
  for (let index = 0; index < 10; index++) await addPeer(current, { pid: 45_000 + index,
    sessionId: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}` });
  let inspections = 0;
  const get = current.processes.get.bind(current.processes);
  current.processes.get = (pid) => { inspections++; return get(pid); };
  const destination = new ClaudeDestination({ host: "local", stateRoot: current.stateDir, peer: current.adapter });
  const result = await destination.deliver({ attempt: "attempt", target: {
    id: "reg_advisor", host: "local", provider: "claude", handle: SESSION_ONE, alias: "advisor@local",
  }, text: "real bounded fixture write", deadline: Date.now() + 10_000, steer: false, messages: [],
    authorize: async () => true, accepted: async () => assert.fail("Claude does not emit an accepted callback") });
  await arrival;
  assert.deepEqual(result, { outcome: "delivered", code: "DELIVERED" });
  assert.equal(inspections, 16); // 12 in discovery, 2 in this group, 2 exact checks
  assert.equal(connects, 4); // 2 discovery probes, 1 other-process probe, 1 write
});

test("a newer daemon cannot hide an interactive duplicate or gain its caller eligibility", async (t) => {
  const current = await fixture(t);
  await addPeer(current, { pid: 41_103, name: "advisor", startedAt: 100 });
  const daemon = await addPeer(current, { pid: 41_104, name: "worker", kind: "daemon", startedAt: 200 });
  assert.equal((await current.adapter.discover()).peers[0]?.alias, "advisor");
  await assert.rejects(current.adapter.resolveReplyAddress(`uds:${daemon.socketPath}`), { code: "CLAUDE_REPLY_ROUTE_MISMATCH" });
});

test("300 unrelated stale registry files do not gate an exact prepared write or run unrelated ps checks", async (t) => {
  const current = await fixture(t);
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => { received = resolve; });
  const live = await addPeer(current, { pid: 41_103, handler: (socket) => socket.on("data", () => received()) });
  await current.adapter.discover();
  await current.adapter.assertTargetWorkspaceDisjoint(SESSION_ONE, current.stateDir);
  const prepared = await current.adapter.prepareSend(SESSION_ONE, "bounded", { deadlineAt: Date.now() + 10_000 });
  const template = JSON.parse(await readFile(live.registryPath, "utf8"));
  for (let index = 0; index < 300; index++) await writeFile(path.join(current.sessionsDir, `${50_000 + index}.json`),
    JSON.stringify({ ...template, pid: 50_000 + index, sessionId: SESSION_TWO }), { mode: 0o600 });
  let inspections = 0;
  const get = current.processes.get.bind(current.processes);
  current.processes.get = (pid) => { inspections++; assert.equal(pid, 41_103); return get(pid); };
  await prepared.perform(async () => true);
  await arrival;
  assert.equal(inspections, 3); // one group check and two exact-generation checks
  const next = await current.adapter.prepareSend(SESSION_ONE, "newer beyond display window", { deadlineAt: Date.now() + 10_000 });
  await addPeer(current, { pid: 60_000, startedAt: 1_786_148_833_000 });
  current.processes.get = get;
  await assert.rejects(next.perform(async () => assert.fail("missed newer duplicate beyond display bound")), { code: "CLAUDE_PEER_TARGET_CHANGED" });
});

test("a duplicate appearing at socket connect is checked without re-probing the held target", async (t) => {
  let inject = false, inserted!: () => void;
  const ready = new Promise<void>((resolve) => { inserted = resolve; });
  let current: Fixture;
  current = await fixture(t, { connect: (socketPath) => {
    const socket = net.createConnection({ path: socketPath });
    if (inject) {
      inject = false;
      // Delay this test transport's connect notification until the new
      // registry record exists, not by wall-clock sleeps.
      const emit = socket.emit.bind(socket);
      socket.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === "connect") { void ready.then(() => emit(event, ...args)); return true; }
        return emit(event, ...args);
      }) as typeof socket.emit;
      void addPeer(current, { pid: 41_104, startedAt: 200 }).then(inserted);
    }
    return socket;
  } });
  let bytes = 0;
  await addPeer(current, { pid: 41_103, startedAt: 100, handler: (s) => s.on("data", (b) => { bytes += b.length; }) });
  await current.adapter.discover();
  await current.adapter.assertTargetWorkspaceDisjoint(SESSION_ONE, current.stateDir);
  const prepared = await current.adapter.prepareSend(SESSION_ONE, "connect boundary", { deadlineAt: Date.now() + 10_000 });
  inject = true;
  await assert.rejects(prepared.perform(async () => assert.fail("old process authorized")), { code: "CLAUDE_PEER_TARGET_CHANGED" });
  assert.equal(bytes, 0);
});

test("duplicate session warnings traverse real registry, broker and CLI; both directions deliver", async (t) => {
  let failedProbe: "none" | "newest" | "all" = "none";
  const current = await fixture(t, { connect: (socketPath) => {
    if (failedProbe === "all" || failedProbe === "newest" && socketPath.endsWith("41104.sock")) {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", new Error("fixture listener unavailable")));
      return socket;
    }
    return net.createConnection({ path: socketPath });
  } });
  const old = await addPeer(current, { pid: 41_103, name: "MyProj", startedAt: 100,
    handler: (socket) => socket.on("data", () => assert.fail("old process received message bytes")) });
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => { received = resolve; });
  await addPeer(current, { pid: 41_104, name: "MyProj", startedAt: 200,
    handler: (socket) => socket.on("data", (bytes) => { assert.match(String(bytes), /hello advisor/); received(); }) });
  await addPeer(current, { pid: 41_105, name: "Worker.1", kind: "daemon", sessionId: SESSION_THREE });
  await addPeer(current, { pid: 41_106, name: "Worker.1", kind: "daemon", sessionId: SESSION_THREE });
  await writeFile(path.join(current.stateDir, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  const store = new OwnedStateFile(current.stateDir, createLedgerCodec("local", ledgerDefaults));
  await store.initialize();
  const directory = new EndpointDirectory({ host: "local", store, limits: ledgerDefaults, claude: current.adapter });
  const writes: string[] = [];
  const codex: Destination = { close: async () => {}, deliver: async (input) => {
    assert.equal(await input.authorize({ bytes: Buffer.byteLength(input.text), sha256: bodyHash(input.text) }), true);
    writes.push(input.text); return { outcome: "delivered", code: "DELIVERED" };
  } };
  const coordinator = new Coordinator({ host: "local", store, limits: ledgerDefaults, resolve: (ref) => directory.exact(ref),
    claude: new ClaudeDestination({ host: "local", stateRoot: current.stateDir, peer: current.adapter }), codex, ssh: codex });
  const broker = new MessagingBroker({ host: "local", store, directory, coordinator, limits: ledgerDefaults });
  const control = await serveLocalControl({ stateDir: current.stateDir, socketPath: path.join(current.stateDir, "control.sock"), handle: async (input) => {
    return handleBrokerCommand(input, { broker, validateHandoff: () => false, check: async () => ({}) });
  } });
  const cli = async (args: string[], fromClaude = false, body = "") => {
    let output = "", errors = "";
    const status = await runCoreCli(args, { env: { EMBASSY_STATE_DIR: current.stateDir,
      ...(fromClaude ? { CLAUDE_CODE_MESSAGING_SOCKET: old.socketPath } : { CODEX_THREAD_ID: SESSION_TWO }) },
      stdin: Readable.from([body]), stdout: new Writable({ write(chunk, _, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _, done) { errors += chunk; done(); } }) });
    assert.equal(status, 0, output + errors);
    return { result: JSON.parse(output).result, errors };
  };
  try {
    await cli(["register-codex", "--alias", "codex-builder@local"]);
    for (const command of [["refresh"], ["status", "--json"]]) {
      const { result, errors } = await cli(command);
      assert.deepEqual(result.warnings, [{ code: "CLAUDE_SESSION_DUPLICATE", alias: "myproj@local", selectedPid: 41_104,
        newestPid: 41_104, otherPids: [41_103], reason: "stale_older" }]);
      assert.match(errors, /using newest PID 41104; older PID\(s\) 41103.*Exit the older Claude process/);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SESSION_ONE}|${current.socketDir}|Worker|MyProj`));
    }
    const sent = await cli(["send", "--to", "myproj@local"], false, "hello advisor");
    assert.match(sent.errors, /CLAUDE_SESSION_DUPLICATE/);
    const target = (await store.snapshot()).endpoints.find((row) => row.provider === "claude")!;
    await coordinator.wake(target); await arrival;
    assert.equal((await broker.delivery(sent.result.deliveryToken) as { state: string }).state, "delivered");
    const reply = await cli(["send", "--conversation", sent.result.conversationId], true, "hello builder");
    assert.match(reply.errors, /CLAUDE_SESSION_DUPLICATE/);
    await coordinator.wake((await store.snapshot()).endpoints.find((row) => row.provider === "codex")!);
    assert.equal((await broker.delivery(reply.result.deliveryToken) as { state: string }).state, "delivered");
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /hello builder/);
    failedProbe = "newest";
    const fallback = await cli(["refresh"]);
    assert.equal(fallback.result.warnings[0].reason, "unreachable_newest");
    assert.match(fallback.errors, /newest PID 41104 was not confirmed reachable\. Check it before exiting anything/);
    assert.doesNotMatch(fallback.errors, /Exit the older|stale PID/);
    failedProbe = "all";
    const unavailable = await cli(["refresh"]);
    assert.equal(unavailable.result.warnings[0].reason, "all_unreachable");
    assert.match(unavailable.errors, /none of the duplicate sockets for PID\(s\).*was confirmed reachable.*before exiting anything/);
    assert.doesNotMatch(unavailable.errors, /PID_NOT_LIVE|Exit the older/);
    failedProbe = "none";
    await unlink(old.registryPath);
    assert.equal((await cli(["refresh"])).result.warnings, undefined);
    assert.equal((await cli(["status", "--json"])).errors, "");
  } finally { await control.close(); await broker.close(); await store.close(); }
});

test("discovery isolates mixed real-world records across a Claude Code patch upgrade", async (t) => {
  const current = await fixture(t);
  const manual = await addPeer(current, {
    pid: 41_111,
    name: "manual-monitor",
    version: "2.1.224",
    nameSource: null,
  });
  await addPeer(current, {
    pid: 41_112,
    sessionId: SESSION_TWO,
    name: "derived-peer",
    version: "2.1.225",
    nameSource: "derived",
  });
  await addPeer(current, {
    pid: 41_113,
    sessionId: "00000000-0000-4000-8000-000000000003",
    name: "print-session",
    version: "2.1.225",
    omitStatus: true,
  });
  await addPeer(current, {
    pid: 41_114,
    sessionId: "00000000-0000-4000-8000-000000000004",
    name: "current-peer",
    version: TEST_VERSION,
  });
  await addPeer(current, {
    pid: 41_115,
    sessionId: "00000000-0000-4000-8000-000000000005",
    name: "project migration",
    version: TEST_VERSION,
  });
  await addPeer(current, {
    pid: 41_116,
    sessionId: "00000000-0000-4000-8000-000000000006",
    name: "dead-peer",
    version: "2.1.224",
  });
  current.processes.delete(41_116);

  assert.equal((await lstat(manual.registryPath)).mode & 0o777, 0o644);
  const result = await current.adapter.discover();
  assert.deepEqual(result.rejected, {
    REGISTRY_INVALID_SCHEMA: 1,
    PID_NOT_LIVE: 1,
  });
  assert.equal(result.entriesScanned, 6);
  assert.equal(result.parseableRecords, 5);
  assert.deepEqual(
    result.peers.map((peer) => peer.alias).sort(),
    [
      "current-peer",
      "derived-peer",
      "manual-monitor",
      "print-session",
    ],
  );
  assert.equal(
    result.peers.find((peer) => peer.alias === "print-session")?.status,
    "busy",
  );
});

test("discovery preserves capabilities only for the same exact session generation", async (t) => {
  const current = await fixture(t);
  const peer = await addPeer(current, {
    pid: 41_201,
    sessionId: SESSION_ONE,
    status: "idle",
  });
  const first = (await current.adapter.discover()).peers[0];
  assert.ok(first !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    first.targetId,
    current.stateDir,
  );

  const record = JSON.parse(await readFile(peer.registryPath, "utf8")) as Record<
    string,
    unknown
  >;
  record.status = "busy";
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  const statusRefresh = (await current.adapter.discover()).peers[0];
  assert.ok(statusRefresh !== undefined);
  assert.equal(statusRefresh.targetId, first.targetId);
  assert.equal(statusRefresh.status, "busy");

  record.sessionId = SESSION_TWO;
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  const replaced = (await current.adapter.discover()).peers[0];
  assert.ok(replaced !== undefined);
  assert.notEqual(replaced.targetId, first.targetId);
  await assert.rejects(
    prepareAndPerform(current, first.targetId, "must not silently rebind"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_TARGET_UNKNOWN",
  );
});

test("selection attestation is required before any peer socket write", async (t) => {
  let connections = 0;
  const current = await fixture(t);
  await addPeer(current, {
    pid: 41_301,
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  const target = (await current.adapter.discover()).peers[0];
  assert.ok(target !== undefined);

  await assert.rejects(
    prepareAndPerform(current, target.targetId, "must remain local"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WORKSPACE_UNATTESTED",
  );
  assert.equal(connections, 0);
  await current.adapter.discover();
  const deadline = { deadlineAt: Date.now() + 30_000 };
  await assert.rejects(current.adapter.prepareSend(target.targetId, "still unattested", deadline),
    (error: unknown) => error instanceof BridgeError && error.code === "CLAUDE_PEER_WORKSPACE_UNATTESTED");
  assert.equal(
    await current.adapter.assertTargetWorkspaceDisjoint(
      target.targetId,
      current.stateDir,
    ),
    undefined,
  );
  (await current.adapter.prepareSend(target.targetId, "attested without a restart", deadline)).cancel();
});

test("selection allows home when state is disjoint but rejects root and temporary workspaces", async (t) => {
  const current = await fixture(t);
  await addPeer(current, { pid: 41_311, sessionId: SESSION_ONE, name: "root", cwd: "/" });
  await addPeer(current, {
    pid: 41_312,
    sessionId: SESSION_TWO,
    name: "home",
    cwd: current.home,
  });
  await addPeer(current, {
    pid: 41_313,
    sessionId: SESSION_THREE,
    name: "temp",
    cwd: current.systemTemp,
  });
  const targets = (await current.adapter.discover()).peers;
  assert.equal(targets.length, 3);

  const home = targets.find((candidate) => candidate.alias === "home");
  assert.ok(home !== undefined);
  assert.equal(
    await current.adapter.assertTargetWorkspaceDisjoint(
      home.targetId,
      current.stateDir,
    ),
    undefined,
  );

  for (const alias of ["root", "temp"] as const) {
    const target = targets.find((candidate) => candidate.alias === alias);
    assert.ok(target !== undefined);
    await assert.rejects(
      current.adapter.assertTargetWorkspaceDisjoint(
        target.targetId,
        current.stateDir,
      ),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "CLAUDE_PEER_WORKSPACE_BROAD",
    );
  }
});

test("selection rejects unsafe paths but permits controller state beneath an accessible workspace", async (t) => {
  const current = await fixture(t);
  const realWorkspace = path.join(current.home, "real-workspace");
  const linkedWorkspace = path.join(current.home, "linked-workspace");
  const missingWorkspace = path.join(current.home, "private-marker-missing");
  const nestedState = path.join(current.workspace, ".gateway-state");
  const linkedState = path.join(current.root, "linked-state");
  await mkdir(realWorkspace, { mode: 0o700 });
  await mkdir(nestedState, { mode: 0o700 });
  await symlink(realWorkspace, linkedWorkspace);
  await symlink(current.stateDir, linkedState);
  await addPeer(current, {
    pid: 41_321,
    sessionId: SESSION_ONE,
    name: "linked",
    cwd: linkedWorkspace,
  });
  await addPeer(current, {
    pid: 41_322,
    sessionId: SESSION_TWO,
    name: "missing",
    cwd: missingWorkspace,
  });
  await addPeer(current, {
    pid: 41_323,
    sessionId: SESSION_THREE,
    name: "overlap",
    cwd: current.workspace,
  });
  const targets = (await current.adapter.discover()).peers;

  const linked = targets.find((candidate) => candidate.alias === "linked");
  assert.ok(linked !== undefined);
  await assert.rejects(
    current.adapter.assertTargetWorkspaceDisjoint(
      linked.targetId,
      current.stateDir,
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WORKSPACE_UNSAFE",
  );

  const missing = targets.find((candidate) => candidate.alias === "missing");
  assert.ok(missing !== undefined);
  await assert.rejects(
    current.adapter.assertTargetWorkspaceDisjoint(
      missing.targetId,
      current.stateDir,
    ),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "CLAUDE_PEER_WORKSPACE_UNSAFE");
      assert.ok(!error.message.includes("private-marker-missing"));
      return true;
    },
  );

  const overlap = targets.find((candidate) => candidate.alias === "overlap");
  assert.ok(overlap !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    overlap.targetId,
    nestedState,
  );
  await assert.rejects(
    current.adapter.assertTargetWorkspaceDisjoint(
      overlap.targetId,
      linkedState,
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_STATE_ROOT_UNSAFE",
  );
});

test("name, cwd, and kind changes preserve the logical session UUID", async (t) => {
  const current = await fixture(t);
  const alternateWorkspace = path.join(current.home, "alternate-workspace");
  await mkdir(alternateWorkspace, { mode: 0o700 });
  const peer = await addPeer(current, {
    pid: 41_331,
    name: "original",
    kind: "interactive",
    handler: (socket) => socket.resume(),
  });
  const first = (await current.adapter.discover()).peers[0];
  assert.ok(first !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    first.targetId,
    current.stateDir,
  );
  const record = JSON.parse(await readFile(peer.registryPath, "utf8")) as Record<
    string,
    unknown
  >;

  record.name = "renamed";
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  const renamed = (await current.adapter.discover()).peers[0];
  assert.ok(renamed !== undefined);
  assert.equal(renamed.targetId, first.targetId);
  assert.equal(renamed.alias, "renamed");

  record.cwd = alternateWorkspace;
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  const moved = (await current.adapter.discover()).peers[0];
  assert.ok(moved !== undefined);
  assert.equal(moved.targetId, renamed.targetId);

  record.kind = "bg";
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  const changedKind = (await current.adapter.discover()).peers[0];
  assert.ok(changedKind !== undefined);
  assert.equal(changedKind.targetId, moved.targetId);
  await prepareAndPerform(current, first.targetId, "current workspace proven");
});

test("preparation freshly attests safe replacement state and workspace roots", {
  skip: process.platform === "darwin"
    ? false
    : "the shipped runtime is macOS-only; this replacement test exercises its Darwin filesystem boundary",
}, async (t) => {
  let connections = 0;
  const current = await fixture(t);
  await addPeer(current, {
    pid: 41_341,
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  const target = await selectFirstPeer(current);

  await rm(current.stateDir, { recursive: true });
  await mkdir(current.stateDir, { mode: 0o700 });
  await prepareAndPerform(current, target.targetId, "state replaced safely");
  assert.equal(connections, 1);

  await rm(current.workspace, { recursive: true });
  await mkdir(current.workspace, { mode: 0o700 });
  await prepareAndPerform(current, target.targetId, "workspace replaced safely");
  assert.equal(connections, 2);
});

test("discovery ignores provider modes but rejects invalid processes and paths", async (t) => {
  const current = await fixture(t);
  const valid = await addPeer(current, { pid: 42_101 });
  await chmod(valid.registryPath, 0o664);
  await chmod(valid.socketPath, 0o666);

  const mismatch = await addPeer(current, {
    pid: 42_102,
    recordPid: 42_999,
  });
  assert.ok(mismatch.registryPath.endsWith("42102.json"));

  await addPeer(current, { pid: 42_103, peerProtocol: 2 });
  const linkedTarget = path.join(current.root, "outside.json");
  await writeFile(linkedTarget, "{}", { mode: 0o600 });
  await symlink(linkedTarget, path.join(current.sessionsDir, "42104.json"));
  await writeFile(path.join(current.sessionsDir, "notes.txt"), "ignored", {
    mode: 0o600,
  });

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0]?.alias, "peer-42101");
  assert.equal(result.rejected.PID_MISMATCH, 1);
  assert.equal(result.rejected.REGISTRY_INVALID_SCHEMA, 1);
  assert.equal(result.rejected.REGISTRY_NOT_REGULAR, 1);
  assert.equal(result.rejected.INVALID_FILE_NAME, 1);
});

test("discovery counts bad registry artifacts without hiding healthy peers", async (t) => {
  const current = await fixture(t, { maxRegistryBytes: 1_024 });
  await addPeer(current, { pid: 42_105 });

  const badSocket = await addPeer(current, {
    pid: 42_106,
    sessionId: SESSION_TWO,
  });
  await new Promise<void>((resolve, reject) =>
    badSocket.server.close((error) => (error ? reject(error) : resolve())),
  );
  current.servers.splice(current.servers.indexOf(badSocket.server), 1);
  await writeFile(badSocket.socketPath, "not a socket", { mode: 0o600 });

  await writeFile(
    path.join(current.sessionsDir, "42107.json"),
    "x".repeat(1_025),
    { mode: 0o600 },
  );
  const outside = path.join(current.root, "outside-registry.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, path.join(current.sessionsDir, "42108.json"));

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0]?.alias, "peer-42105");
  assert.deepEqual(result.rejected, {
    SOCKET_NOT_SOCKET: 1,
    REGISTRY_TOO_LARGE: 1,
    REGISTRY_NOT_REGULAR: 1,
  });
  assert.equal(result.entriesScanned, 4);
  assert.equal(result.parseableRecords, 2);
});

test("discovery tolerates unknown registry fields without exposing them", async (t) => {
  const current = await fixture(t);
  let connections = 0;
  const peer = await addPeer(current, {
    pid: 42_111,
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  const record = JSON.parse(await readFile(peer.registryPath, "utf8")) as Record<
    string,
    unknown
  >;
  record.waitingFor = "dialog open";
  await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.deepEqual(result.rejected, {});
  assert.equal(result.parseableRecords, 1);
  assert.ok(!JSON.stringify(result).includes("dialog open"));
  const target = result.peers[0];
  assert.ok(target !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    target.targetId,
    current.stateDir,
  );
  const sent = await prepareAndPerform(
    current,
    target.targetId,
    "unknown fields do not hide this peer",
  );
  assert.equal(sent.transportStatus, "transport_written");
  assert.equal(connections, 1);
});

test("discovery rejects unsupported peer protocols per record", async (t) => {
  const current = await fixture(t);
  await addPeer(current, { pid: 42_112, peerProtocol: 2 });

  const result = await current.adapter.discover();
  assert.deepEqual(result.peers, []);
  assert.deepEqual(result.rejected, { REGISTRY_INVALID_SCHEMA: 1 });
  assert.equal(result.entriesScanned, 1);
  assert.equal(result.parseableRecords, 0);
});

test("Claude version metadata never fences discovery or delivery", async (t) => {
  const current = await fixture(t);
  let connections = 0;
  await addPeer(current, {
    pid: 42_113,
    version: "3.0.0",
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  await addPeer(current, {
    pid: 42_115,
    sessionId: SESSION_TWO,
    omitVersion: true,
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  await addPeer(current, {
    pid: 42_114,
    sessionId: SESSION_THREE,
    version: "diagnostic-build-label",
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  await addPeer(current, {
    pid: 42_116,
    sessionId: "00000000-0000-4000-8000-000000000004",
    version: "x".repeat(65),
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 4);
  assert.deepEqual(result.rejected, {});
  assert.equal(result.entriesScanned, 4);
  assert.equal(result.parseableRecords, 4);
  for (const target of result.peers) {
    await current.adapter.assertTargetWorkspaceDisjoint(
      target.targetId,
      current.stateDir,
    );
    const sent = await prepareAndPerform(
      current,
      target.targetId,
      "version metadata does not fence the route",
    );
    assert.equal(sent.transportStatus, "transport_written");
  }
  assert.equal(connections, 4);
});

test("discovery treats names as metadata regardless of provider-like spelling", async (t) => {
  const current = await fixture(t);
  await addPeer(current, { pid: 42_117, name: "codex-cli" });

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0]?.alias, "codex-cli");
  assert.deepEqual(result.rejected, {});
  assert.equal(result.entriesScanned, 1);
  assert.equal(result.parseableRecords, 1);
});

test("discovery still rejects malformed known registry fields", async (t) => {
  const current = await fixture(t);
  const malformed = [
    await addPeer(current, { pid: 42_114 }),
    await addPeer(current, { pid: 42_115, sessionId: SESSION_TWO }),
    await addPeer(current, { pid: 42_116, sessionId: SESSION_THREE }),
  ];
  const invalidKnownFields: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { statusUpdatedAt: -1 },
    { nameSource: { source: "derived" } },
    { entrypoint: "cli/unsafe" },
  ];
  for (const [index, peer] of malformed.entries()) {
    assert.ok(peer !== undefined);
    const record = JSON.parse(
      await readFile(peer.registryPath, "utf8"),
    ) as Record<string, unknown>;
    Object.assign(record, invalidKnownFields[index]);
    await writeFile(peer.registryPath, JSON.stringify(record), { mode: 0o600 });
  }

  const result = await current.adapter.discover();
  assert.deepEqual(result.peers, []);
  assert.deepEqual(result.rejected, { REGISTRY_INVALID_SCHEMA: 3 });
  assert.equal(result.entriesScanned, 3);
  assert.equal(result.parseableRecords, 0);
});

test("discovery requires private owned sessions but accepts shared socket directory modes", async (t) => {
  const current = await fixture(t);
  await addPeer(current, { pid: 42_121 });
  await chmod(current.sessionsDir, 0o755);
  await assert.rejects(
    current.adapter.discover(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "UNSAFE_PEER_DIRECTORY",
  );
  await chmod(current.sessionsDir, 0o700);
  await chmod(current.socketDir, 0o755);
  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 1);
  assert.deepEqual(result.rejected, {});

  const wrongOwner = await fixture(t, { expectedUid: UID + 1 });
  await assert.rejects(
    wrongOwner.adapter.discover(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "UNSAFE_PEER_DIRECTORY",
  );
});

test("registry enumeration stops at its configured entry bound", async (t) => {
  const current = await fixture(t, { maxRegistryEntries: 1 });
  await addPeer(current, { pid: 42_201 });
  await addPeer(current, { pid: 42_202, sessionId: SESSION_TWO });
  const result = await current.adapter.discover();
  assert.equal(result.truncated, true);
  assert.equal(result.rejected.ENTRY_LIMIT_EXCEEDED, 1);
  assert.equal(result.peers.length, 1);
});

test("frame codec emits canonical v1 NDJSON and rejects smuggling", () => {
  const encoded = encodeClaudePeerUserFrame({
    messageId: MESSAGE_ONE,
    content: "hello",
  });
  assert.equal(encoded.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), {
    msgV: 1,
    msg_id: MESSAGE_ONE,
    type: "user",
    message: { role: "user", content: "hello" },
    priority: "next",
  });
  assert.throws(() =>
    encodeClaudePeerUserFrame({ messageId: MESSAGE_ONE, content: "" }),
  );
  assert.throws(
    () => encodeClaudePeerUserFrame({
      messageId: MESSAGE_ONE,
      content: "é".repeat(129),
      maxFrameBytes: 256,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_PEER_CONTENT",
  );
  assert.throws(
    () => encodeClaudePeerUserFrame({
      messageId: MESSAGE_ONE,
      content: "contains\0nul",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_PEER_CONTENT",
  );
  assert.throws(
    () => encodeClaudePeerUserFrame({
      messageId: MESSAGE_ONE,
      content: "é".repeat(120),
      maxFrameBytes: 256,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "PEER_FRAME_TOO_LARGE",
  );
  assert.throws(() =>
    encodeClaudePeerUserFrame({
      messageId: "not-a-uuid",
      content: "hello",
    }),
  );
});

test("preparation revalidates the exact target generation and never retries a changed peer", async (t) => {
  const current = await fixture(t);
  const target = await addPeer(current, { pid: 43_101 });
  const discovered = await current.adapter.discover();
  const targetId = discovered.peers[0]?.targetId;
  assert.ok(targetId !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    targetId,
    current.stateDir,
  );
  const record = JSON.parse(await readFile(target.registryPath, "utf8")) as Record<
    string,
    unknown
  >;
  record.sessionId = SESSION_TWO;
  await writeFile(target.registryPath, JSON.stringify(record), { mode: 0o600 });

  await assert.rejects(
    prepareAndPerform(current, targetId, "do not deliver"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_TARGET_UNKNOWN",
  );
});

test("prepared send refuses a replaced socket generation before connecting", async (t) => {
  let replacementBytes = 0;
  const current = await fixture(t, { createId: () => MESSAGE_ONE });
  const original = await addPeer(current, { pid: 43_151 });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "must stay on the prepared socket",
    { deadlineAt: Date.now() + 30_000 },
  );

  // Keep the old socket inode allocated so Linux cannot immediately reuse it
  // for the replacement and make this test accidentally preserve generation.
  const retainedSocket = path.join(current.root, "retained-original.sock");
  await rename(original.socketPath, retainedSocket);
  await new Promise<void>((resolve, reject) =>
    original.server.close((error) => error ? reject(error) : resolve()),
  );
  current.servers.splice(current.servers.indexOf(original.server), 1);
  const replacement = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      replacementBytes += chunk.length;
    });
  });
  await listen(replacement, original.socketPath);
  current.servers.push(replacement);
  const [oldGeneration, newGeneration] = await Promise.all([
    lstat(retainedSocket, { bigint: true }),
    lstat(original.socketPath, { bigint: true }),
  ]);
  assert.notDeepEqual(
    [oldGeneration.dev, oldGeneration.ino, oldGeneration.ctimeNs],
    [newGeneration.dev, newGeneration.ino, newGeneration.ctimeNs],
  );

  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_TARGET_CHANGED" &&
      error.recoverable,
  );
  assert.equal(replacementBytes, 0);
});

test("prepared send refuses a ctime-only socket generation change", async (t) => {
  let connections = 0;
  let receivedBytes = 0;
  const current = await fixture(t, { createId: () => MESSAGE_ONE });
  const peer = await addPeer(current, {
    pid: 43_153,
    handler: (socket) => {
      connections += 1;
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
    },
  });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "must stay on the exact socket metadata generation",
    { deadlineAt: Date.now() + 30_000 },
  );
  const before = await lstat(peer.socketPath, { bigint: true });
  let after = before;
  for (let attempt = 0; attempt < 8 && after.ctimeNs === before.ctimeNs; attempt += 1) {
    await chmod(peer.socketPath, 0o640);
    await chmod(peer.socketPath, 0o600);
    after = await lstat(peer.socketPath, { bigint: true });
  }
  assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal(Number(after.mode & 0o777n), 0o600);

  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_TARGET_CHANGED" &&
      error.recoverable,
  );
  assert.equal(connections, 0);
  assert.equal(receivedBytes, 0);
});

test("a process change after connect is re-attested before the first byte", async (t) => {
  const pid = 43_152;
  let receivedBytes = 0;
  let current: Fixture;
  current = await fixture(t, {
    createId: () => MESSAGE_ONE,
    connect: (socketPath) => {
      const socket = net.createConnection({ path: socketPath });
      socket.once("connect", () => {
        current.processes.set(pid, {
          uid: UID,
          generation: "replacement-after-connect",
        });
      });
      return socket;
    },
  });
  await addPeer(current, {
    pid,
    handler: (socket) => {
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
    },
  });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "never write after generation replacement",
    { deadlineAt: Date.now() + 30_000 },
  );

  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_TARGET_CHANGED" &&
      error.recoverable,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedBytes, 0);
});

test("preparation follows a session UUID across process and socket rotation", async (t) => {
  let replacementConnections = 0;
  const current = await fixture(t);
  const original = await addPeer(current, {
    pid: 43_201,
    sessionId: SESSION_ONE,
    name: "before-rotation",
  });
  const target = (await current.adapter.discover()).peers[0];
  assert.ok(target !== undefined);
  await current.adapter.assertTargetWorkspaceDisjoint(
    target.targetId,
    current.stateDir,
  );

  await unlink(original.registryPath);
  await addPeer(current, {
    pid: 43_202,
    sessionId: SESSION_ONE,
    name: "after-rotation",
    handler: (socket) => {
      replacementConnections += 1;
      socket.resume();
    },
  });

  const sent = await prepareAndPerform(
    current,
    target.targetId,
    "follow the logical session",
  );
  assert.equal(target.targetId, SESSION_ONE);
  assert.equal(sent.transportStatus, "transport_written");
  assert.equal(replacementConnections, 1);
  assert.equal(
    (await current.adapter.discover()).peers[0]?.alias,
    "after-rotation",
  );
});

test("prepared send exposes exact immutable evidence and opens no socket before perform", async (t) => {
  let wire = Buffer.alloc(0);
  let connections = 0;
  const current = await fixture(t, { createId: () => MESSAGE_ONE });
  await addPeer(current, {
    pid: 44_151,
    handler: (socket) => {
      connections += 1;
      socket.on("data", (chunk) => {
        wire = Buffer.concat([wire, chunk]);
      });
    },
  });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "authorized exact frame",
    { deadlineAt: Date.now() + 30_000 },
  );
  assert.equal(connections, 0);
  const exactFrame = encodeClaudePeerUserFrame({
    messageId: MESSAGE_ONE,
    content: "authorized exact frame",
  });
  assert.equal(prepared.frameBytes, exactFrame.length);
  assert.equal(
    prepared.sha256,
    createHash("sha256").update(exactFrame).digest("hex"),
  );

  assert.deepEqual(await prepared.perform(async () => true), {
    messageId: MESSAGE_ONE,
    transportStatus: "transport_written",
  });
  await eventually(() => wire.includes(0x0a));
  assert.equal(connections, 1);
  assert.deepEqual(wire, exactFrame);
  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_PREPARATION_CONSUMED",
  );
  assert.equal(connections, 1);
});

test("final authorization denial or uncertainty writes no Claude bytes", async (t) => {
  let connections = 0;
  let receivedBytes = 0;
  const current = await fixture(t);
  await addPeer(current, {
    pid: 44_153,
    handler: (socket) => {
      connections += 1;
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
    },
  });
  const target = await selectFirstPeer(current);
  const denied = await current.adapter.prepareSend(
    target.targetId,
    "denied at the final boundary",
    { deadlineAt: Date.now() + 30_000 },
  );
  await assert.rejects(
    denied.perform(async () => false),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WRITE_AUTHORIZATION_DENIED" &&
      error.recoverable,
  );
  const uncertain = await current.adapter.prepareSend(
    target.targetId,
    "uncertain at the final boundary",
    { deadlineAt: Date.now() + 30_000 },
  );
  await assert.rejects(
    uncertain.perform(async () => {
      throw new Error("commit reply lost");
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "WRITE_AUTHORIZATION_UNCERTAIN" &&
      !error.recoverable,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections, 2);
  assert.equal(receivedBytes, 0);
});

test("cancel and deadline consume prepared sends without opening a socket", async (t) => {
  let connections = 0;
  let now = 1_786_150_000_000;
  const current = await fixture(t, {
    createId: () => MESSAGE_ONE,
    now: () => now,
  });
  await addPeer(current, {
    pid: 44_152,
    handler: (socket) => {
      connections += 1;
      socket.resume();
    },
  });
  const target = await selectFirstPeer(current);
  const cancelled = await current.adapter.prepareSend(
    target.targetId,
    "denied",
    { deadlineAt: now + 30_000 },
  );
  cancelled.cancel();
  await assert.rejects(
    cancelled.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_PREPARATION_CONSUMED",
  );

  const expired = await current.adapter.prepareSend(
    target.targetId,
    "expired",
    { deadlineAt: now + 1 },
  );
  now += 1;
  await assert.rejects(
    expired.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_MESSAGE_EXPIRED" &&
      error.recoverable,
  );
  assert.equal(connections, 0);
});

test("a prepared post-connect error is ambiguous and non-retryable", async (t) => {
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.destroy = (() => fakeSocket) as net.Socket["destroy"];
  fakeSocket.end = ((
    _frame: Buffer,
    _callback: () => void,
  ) => {
    queueMicrotask(() => fakeSocket.emit("error", new Error("reset")));
    return fakeSocket;
  }) as net.Socket["end"];
  const current = await fixture(t, {
    createId: () => MESSAGE_ONE,
    connect: () => {
      queueMicrotask(() => fakeSocket.emit("connect"));
      return fakeSocket;
    },
  });
  await addPeer(current, { pid: 44_301 });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "ambiguous edge",
    { deadlineAt: Date.now() + 30_000 },
  );
  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      error.recoverable === false,
  );
});

test("a timeout after socket.end begins is ambiguous rather than not-written", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let began!: () => void;
  const writing = new Promise<void>((resolve) => { began = resolve; });
  let writes = 0;
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.destroy = (() => fakeSocket) as net.Socket["destroy"];
  fakeSocket.end = (() => { writes++; began(); return fakeSocket; }) as net.Socket["end"];
  const current = await fixture(t, {
    createId: () => MESSAGE_ONE,
    connectTimeoutMs: 10,
    connect: () => {
      queueMicrotask(() => fakeSocket.emit("connect"));
      return fakeSocket;
    },
  });
  await addPeer(current, { pid: 44_302 });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "timeout edge",
    { deadlineAt: Date.now() + 30_000 },
  );
  const performed = prepared.perform(async () => true);
  const rejected = assert.rejects(
    performed,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      error.recoverable === false,
  );
  await writing;
  t.mock.timers.tick(11);
  await rejected;
  assert.equal(writes, 1);
});

test("a connected socket can time out during pre-write revalidation without writing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new EventEmitter() as net.Socket;
  let writes = 0;
  socket.destroy = (() => socket) as net.Socket["destroy"];
  socket.end = (() => { writes++; return socket; }) as net.Socket["end"];
  const current = await fixture(t, { connectTimeoutMs: 10, connect: () => {
    queueMicrotask(() => {
      socket.emit("connect");
      // beforeWrite is awaiting real owned-file/process revalidation here.
      t.mock.timers.tick(11);
    });
    return socket;
  } });
  await addPeer(current, { pid: 44_305 });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(target.targetId, "pre-write timeout", { deadlineAt: Date.now() + 30_000 });
  await assert.rejects(prepared.perform(async () => true), (error: unknown) =>
    error instanceof BridgeError && error.code === "CLAUDE_PEER_CONNECT_TIMEOUT" && error.recoverable);
  assert.equal(writes, 0);
});

test("a write that hangs across the canonical deadline is ambiguous, not expired", async (t) => {
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.destroy = (() => fakeSocket) as net.Socket["destroy"];
  fakeSocket.end = (() => fakeSocket) as net.Socket["end"];
  const current = await fixture(t, {
    createId: () => MESSAGE_ONE,
    connectTimeoutMs: 500,
    connect: () => {
      queueMicrotask(() => fakeSocket.emit("connect"));
      return fakeSocket;
    },
  });
  await addPeer(current, { pid: 44_304 });
  const target = await selectFirstPeer(current);
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "deadline-crossing write",
    { deadlineAt: Date.now() + 200 },
  );
  await assert.rejects(
    prepared.perform(async () => true),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      !error.recoverable,
  );
});
