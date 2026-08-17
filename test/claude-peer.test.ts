import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net, { type Server } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  ClaudePeerAdapter,
  encodeClaudePeerUserFrame,
  type ClaudePeerAdapterOptions,
  type ClaudePeerAdapterTestOverrides,
  type ClaudePeerInboundMessage,
  type ClaudePeerListener,
  type ClaudePeerProtocolNotice,
  type ClaudeProcessIdentity,
} from "../src/gateway/claude-peer.js";

const UID = process.getuid?.() ?? 501;
const TEST_VERSION = "2.1.227";
const SESSION_ONE = "00000000-0000-4000-8000-000000000001";
const SESSION_TWO = "00000000-0000-4000-8000-000000000002";
const SESSION_THREE = "00000000-0000-4000-8000-000000000003";
const MESSAGE_ONE = "00000000-0000-4000-8000-000000000101";
const MESSAGE_TWO = "00000000-0000-4000-8000-000000000102";

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
    createArtifactToken,
    expectedUid,
    registryRename,
    registryOperationHook,
    postBindHook,
    ...productionOverrides
  } = overrides;
  const adapter = new ClaudePeerAdapter(
    {
      sessionsDir,
      socketDir,
      connectTimeoutMs: 500,
      connectionIdleMs: 500,
      ...productionOverrides,
    },
    {
      processInspector: async (pid) => processes.get(pid),
      ...(expectedUid === undefined ? {} : { expectedUid }),
      ...(connect === undefined ? {} : { connect }),
      ...(now === undefined ? {} : { now }),
      ...(createId === undefined ? {} : { createId }),
      ...(createArtifactToken === undefined ? {} : { createArtifactToken }),
      ...(registryRename === undefined ? {} : { registryRename }),
      ...(registryOperationHook === undefined
        ? {}
        : { registryOperationHook }),
      ...(postBindHook === undefined ? {} : { postBindHook }),
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
      startedAt: 1_786_148_832_556,
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
  return await prepared.perform();
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

test("discovery rejects duplicate live records for one session UUID", async (t) => {
  const current = await fixture(t);
  await addPeer(current, {
    pid: 41_103,
    sessionId: SESSION_ONE,
    name: "first-record",
  });
  await addPeer(current, {
    pid: 41_104,
    sessionId: SESSION_ONE,
    name: "second-record",
  });

  const result = await current.adapter.discover();
  assert.deepEqual(result.peers, []);
  assert.deepEqual(result.rejected, { SESSION_ID_COLLISION: 1 });
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
  assert.equal(
    await current.adapter.assertTargetWorkspaceDisjoint(
      target.targetId,
      current.stateDir,
    ),
    undefined,
  );
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

test("preparation freshly attests safe replacement state and workspace roots", { skip: process.platform !== "darwin" }, async (t) => {
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

test("absent and bounded Claude versions remain metadata through delivery", async (t) => {
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
  });

  const result = await current.adapter.discover();
  assert.equal(result.peers.length, 3);
  assert.deepEqual(result.rejected, { REGISTRY_INVALID_SCHEMA: 1 });
  assert.equal(result.entriesScanned, 4);
  assert.equal(result.parseableRecords, 3);
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
  assert.equal(connections, 3);
});

test("discovery excludes a marked Embassy helper advertisement before peer accounting", async (t) => {
  const current = await fixture(t);
  const helper = await addPeer(current, {
    pid: 42_116,
    name: "codex-helper",
  });
  const record = JSON.parse(
    await readFile(helper.registryPath, "utf8"),
  ) as Record<string, unknown>;
  record.embassyAdvertisementVersion = 1;
  await writeFile(helper.registryPath, JSON.stringify(record), { mode: 0o600 });

  const result = await current.adapter.discover();
  assert.deepEqual(result.peers, []);
  assert.deepEqual(result.rejected, {});
  assert.equal(result.entriesScanned, 1);
  assert.equal(result.parseableRecords, 0);
});

test("discovery does not mistake an unmarked Claude codex-* name for an Embassy advertisement", async (t) => {
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
    from: "uds:/synthetic/sockets/123.sock",
  });
  assert.equal(encoded.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), {
    msgV: 1,
    msg_id: MESSAGE_ONE,
    type: "user",
    message: { role: "user", content: "hello" },
    priority: "next",
    from: "uds:/synthetic/sockets/123.sock",
  });
  assert.throws(() =>
    encodeClaudePeerUserFrame({ messageId: MESSAGE_ONE, content: "" }),
  );
  assert.throws(() =>
    encodeClaudePeerUserFrame({
      messageId: MESSAGE_ONE,
      content: "hello",
      from: "https://example.invalid",
    }),
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
  const replyListener = await current.adapter.listen({
    onMessage: () => undefined,
  });
  const prepared = await current.adapter.prepareSend(
    target.targetId,
    "authorized exact frame",
    { deadlineAt: Date.now() + 30_000, replyListener },
  );
  assert.equal(connections, 0);
  const exactFrame = encodeClaudePeerUserFrame({
    messageId: MESSAGE_ONE,
    content: "authorized exact frame",
    from: replyListener.address,
  });
  assert.equal(prepared.frameBytes, exactFrame.length);
  assert.equal(
    prepared.sha256,
    createHash("sha256").update(exactFrame).digest("hex"),
  );

  assert.deepEqual(await prepared.perform(), {
    messageId: MESSAGE_ONE,
    transportStatus: "transport_written",
  });
  await eventually(() => wire.includes(0x0a));
  assert.equal(connections, 1);
  assert.deepEqual(wire, exactFrame);
  await assert.rejects(
    prepared.perform(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_PREPARATION_CONSUMED",
  );
  assert.equal(connections, 1);
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
    cancelled.perform(),
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
    expired.perform(),
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
    prepared.perform(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      error.recoverable === false,
  );
});

test("a post-connect timeout is ambiguous rather than not-written", async (t) => {
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.destroy = (() => fakeSocket) as net.Socket["destroy"];
  fakeSocket.end = (() => fakeSocket) as net.Socket["end"];
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
  await assert.rejects(
    prepared.perform(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      error.recoverable === false,
  );
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
    prepared.perform(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS" &&
      !error.recoverable,
  );
});

test("anonymous callback listener bounds NDJSON and marks registered peers untrusted", async (t) => {
  const current = await fixture(t);
  const peer = await addPeer(current, { pid: 45_101, name: "advisor" });
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const canonical = encodeClaudePeerUserFrame({
    messageId: MESSAGE_TWO,
    content: "reply from Claude",
    from: `uds:${peer.socketPath}`,
  });
  await sendLines(listener.address.slice(4), [
    canonical.subarray(0, 7),
    canonical.subarray(7),
  ]);
  await eventually(() => messages.length === 1);
  assert.equal(messages[0]?.content, "reply from Claude");
  assert.equal(messages[0]?.sourceAlias, "advisor");
  assert.equal(messages[0]?.replySupported, true);
  assert.equal(messages[0]?.trust, "untrusted_same_uid_peer");

  await sendLines(listener.address.slice(4), [
    '{"type":"rename","name":"takeover"}\n',
  ]);
  await eventually(() => notices.length > 0);
  assert.ok(notices.some((notice) => notice.code === "UNSUPPORTED_FRAME"));
  assert.equal(messages.length, 1);
});

test("callback refuses connect-back addresses without a live exact registry", async (t) => {
  const current = await fixture(t);
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const frame = encodeClaudePeerUserFrame({
    messageId: MESSAGE_ONE,
    content: "spoofed callback",
    from: `uds:${path.join(current.socketDir, "49999.sock")}`,
  });
  await sendLines(listener.address.slice(4), [frame]);
  await eventually(() => notices.length === 1);
  assert.equal(notices[0]?.code, "UNREGISTERED_REPLY_ADDRESS");
  assert.equal(messages.length, 0);
});

test("transient reply addresses resolve only to the exact logical session UUID", async (t) => {
  const current = await fixture(t);
  const peer = await addPeer(current, { pid: 45_201, name: "reviewer" });
  const resolved = await current.adapter.resolveReplyAddress(
    `uds:${peer.socketPath}`,
  );
  assert.deepEqual(Object.keys(resolved).sort(), [
    "alias",
    "compatibility",
    "kind",
    "status",
    "targetId",
  ]);
  assert.equal(resolved.alias, "reviewer");
  assert.ok(!JSON.stringify(resolved).includes(peer.socketPath));
  assert.ok(!JSON.stringify(resolved).includes("45201"));
  await assert.rejects(
    current.adapter.resolveReplyAddress(
      `uds:${path.join(current.root, "outside.sock")}`,
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNREGISTERED_REPLY_ADDRESS",
  );
});

test("listener advertises one native codex peer and removes it on close", async (t) => {
  const current = await fixture(t, { createId: () => SESSION_ONE });
  const listener = await current.adapter.listen({ onMessage: () => undefined });
  const registryPath = path.join(current.sessionsDir, `${process.pid}.json`);

  await listener.advertise("codex-isolated-test", current.workspace);
  const record = JSON.parse(await readFile(registryPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(record.pid, process.pid);
  assert.equal(record.name, "codex-isolated-test");
  assert.equal(record.embassyAdvertisementVersion, 1);
  assert.equal(record.kind, "interactive");
  assert.equal(record.messagingSocketPath, listener.address.slice(4));

  await listener.updateAdvertisedStatus("waiting");
  const waiting = JSON.parse(
    await readFile(registryPath, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(waiting.status, "waiting");
  assert.equal(typeof waiting.statusUpdatedAt, "number");

  await listener.close();
  await assert.rejects(lstat(registryPath), { code: "ENOENT" });
});

test("listener advertises bounded unknown Claude version evidence", async (t) => {
  const current = await fixture(t, {
    createId: () => SESSION_ONE,
  });
  const listener = await current.adapter.listen({ onMessage: () => undefined });
  const registryPath = path.join(current.sessionsDir, `${process.pid}.json`);

  await listener.advertise("codex-unknown-version", current.workspace);
  const record = JSON.parse(await readFile(registryPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(record.version, "unknown");

  const discovery = await current.adapter.discover();
  assert.deepEqual(discovery.peers, []);
  assert.deepEqual(discovery.rejected, {});
  assert.equal(discovery.entriesScanned, 1);
  assert.equal(discovery.parseableRecords, 0);

  await listener.close();
});

test("post-bind registry quarantine confirms exact callback closure", async (t) => {
  let socketPath: string | undefined;
  const current = await fixture(t, {
    postBindHook: async (boundPath) => {
      socketPath = boundPath;
      await chmod(current.sessionsDir, 0o755);
    },
  });

  await assert.rejects(
    current.adapter.listen({ onMessage: () => undefined }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "UNSAFE_PEER_DIRECTORY",
  );
  assert.ok(socketPath !== undefined);
  await assert.rejects(lstat(socketPath), { code: "ENOENT" });
  await chmod(current.sessionsDir, 0o700);
});

test("post-bind registry quarantine stays fatal after callback replacement", async (t) => {
  let socketPath: string | undefined;
  const current = await fixture(t, {
    postBindHook: async (boundPath) => {
      socketPath = boundPath;
      await chmod(current.sessionsDir, 0o755);
      await rename(boundPath, `${boundPath}.displaced`);
      await writeFile(boundPath, "foreign callback path", { mode: 0o600 });
    },
  });

  await assert.rejects(
    current.adapter.listen({ onMessage: () => undefined }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_CALLBACK_UNSAFE",
  );
  assert.ok(socketPath !== undefined);
  assert.equal((await lstat(socketPath)).isFile(), true);
  await chmod(current.sessionsDir, 0o700);
});

test("listener artifact tokens are fresh across process replacements", async (t) => {
  const current = await fixture(t, {
    createArtifactToken: () => "ordinary_old_01",
  });
  const oldListener = await current.adapter.listen({
    onMessage: () => undefined,
  });
  const oldArtifactToken = oldListener.generation;
  assert.equal(oldArtifactToken, "ordinary_old_01");
  await oldListener.close();
  await current.adapter.close();

  const replacementAdapter = new ClaudePeerAdapter(
    {
      sessionsDir: current.sessionsDir,
      socketDir: current.socketDir,
    },
    {
      createArtifactToken: () => "ordinary_new_02",
      userHome: current.home,
      tempRoots: [current.systemTemp],
    },
  );
  try {
    const replacement = await replacementAdapter.listen({
      onMessage: () => undefined,
    });
    assert.equal(replacement.generation, "ordinary_new_02");
    assert.notEqual(replacement.generation, oldArtifactToken);
    await replacement.close();
  } finally {
    await replacementAdapter.close();
  }
});

test("listener artifact token factories fail closed on invalid output", async (t) => {
  const current = await fixture(t, {
    createArtifactToken: () => "invalid.generation",
  });
  await assert.rejects(
    current.adapter.listen({ onMessage: () => undefined }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CODEX_PEER_GENERATION",
  );
});

test("listener returns native held and delivered statuses to the sending peer", async (t) => {
  let receiptHandle: string | undefined;
  const statuses: Array<Record<string, unknown>> = [];
  const current = await fixture(t);
  const peer = await addPeer(current, {
    pid: 47_151,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.split("\n")) {
          if (line.length > 0) {
            statuses.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "native inbound" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);
  await listener.acknowledge(receiptHandle as string, "held");
  await listener.acknowledge(receiptHandle as string, "delivered");
  await eventually(() => statuses.length === 2);
  assert.deepEqual(
    statuses.map((status) => status.status),
    ["held", "delivered"],
  );
  assert.equal(statuses[0]?.orig_msg_id, MESSAGE_ONE);
});

test("native acknowledgements follow a session UUID across socket rotation", async (t) => {
  let now = 10_000;
  let receiptHandle: string | undefined;
  const originalStatuses: Array<Record<string, unknown>> = [];
  const replacementStatuses: Array<Record<string, unknown>> = [];
  const current = await fixture(t, {
    now: () => now,
  });
  const original = await addPeer(current, {
    pid: 47_153,
    sessionId: SESSION_ONE,
    name: "before-rotation",
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        originalStatuses.push(JSON.parse(data) as Record<string, unknown>);
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "survive peer rotation" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${original.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);

  now += 101;
  await unlink(original.registryPath);
  await addPeer(current, {
    pid: 47_154,
    sessionId: SESSION_ONE,
    name: "after-rotation",
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        replacementStatuses.push(
          JSON.parse(data) as Record<string, unknown>,
        );
      });
    },
  });

  const result = await listener.acknowledge(
    receiptHandle as string,
    "delivered",
  );
  assert.deepEqual(result, { transportStatus: "transport_written" });
  await eventually(() => replacementStatuses.length === 1);
  assert.equal(replacementStatuses[0]?.status, "delivered");
  assert.equal(replacementStatuses[0]?.orig_msg_id, MESSAGE_ONE);
  assert.equal(originalStatuses.length, 0);
  await assert.rejects(
    listener.acknowledge(receiptHandle as string, "delivered"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_RECEIPT_UNKNOWN",
  );
});

test("native ingress quiescence joins admitted hooks, rejects new messages, and preserves receipt writes", async (t) => {
  let receiptHandle: string | undefined;
  let messageCount = 0;
  let releaseHook!: () => void;
  let markHookStarted!: () => void;
  const hookStarted = new Promise<void>((resolve) => {
    markHookStarted = resolve;
  });
  const hookGate = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  const statuses: Array<Record<string, unknown>> = [];
  const current = await fixture(t);
  const peer = await addPeer(current, {
    pid: 47_152,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.split("\n")) {
          if (line.length > 0) {
            statuses.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: async (message) => {
      messageCount += 1;
      receiptHandle = message.receiptHandle;
      markHookStarted();
      await hookGate;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "admitted before quiesce" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await hookStarted;

  let quiesced = false;
  const quiesce = listener.quiesceInbound().then(() => {
    quiesced = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(quiesced, false);
  releaseHook();
  await quiesce;
  assert.equal(quiesced, true);

  await listener.acknowledge(receiptHandle as string, "expired", {
    code: "GATEWAY_SHUTDOWN",
  });
  await eventually(() => statuses.length === 1);
  assert.equal(statuses[0]?.status, "expired");

  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "new after quiesce" },
      msgV: 1,
      msg_id: MESSAGE_TWO,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]).catch(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(messageCount, 1);
});

test("native acknowledgements reject a truncated UUID re-resolution before writing and remain retryable", async (t) => {
  let receiptHandle: string | undefined;
  const statuses: Array<Record<string, unknown>> = [];
  const current = await fixture(t, { maxRegistryEntries: 1 });
  const peer = await addPeer(current, {
    pid: 47_160,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        statuses.push(JSON.parse(data) as Record<string, unknown>);
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "require a complete receipt scan" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);

  const extra = await addPeer(current, {
    pid: 47_161,
    sessionId: SESSION_TWO,
  });
  await assert.rejects(
    listener.notifyInboundProgress(receiptHandle as string, {
      kind: "stall",
      reason: "AWAITING_EXTERNAL_APPROVAL",
      queuedForMs: 100,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_RECEIPT_NOT_WRITTEN" &&
      error.recoverable,
  );
  await assert.rejects(
    listener.acknowledge(receiptHandle as string, "delivered"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_RECEIPT_NOT_WRITTEN" &&
      error.recoverable,
  );
  assert.equal(statuses.length, 0);

  await unlink(extra.registryPath);
  const result = await listener.acknowledge(
    receiptHandle as string,
    "delivered",
  );
  assert.deepEqual(result, { transportStatus: "transport_written" });
  await eventually(() => statuses.length === 1);
  assert.equal(statuses[0]?.status, "delivered");
});

test("one bounded native stall frame follows UUID rotation without consuming its receipt", async (t) => {
  let now = 20_000;
  let receiptHandle: string | undefined;
  const originalPayloads: string[] = [];
  const replacementPayloads: string[] = [];
  const current = await fixture(t, {
    locale: "zh-CN",
    now: () => now,
    maxFrameBytes: 512,
  });
  const original = await addPeer(current, {
    pid: 47_158,
    sessionId: SESSION_ONE,
    name: "stall-before-rotation",
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => originalPayloads.push(data));
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "wait through a route stall" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${original.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);

  await assert.rejects(
    listener.notifyInboundProgress(receiptHandle as string, {
      kind: "stall",
      reason: "UNSAFE_FREE_FORM_REASON",
      queuedForMs: 100,
    } as never),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_PEER_PROGRESS",
  );

  now += 101;
  await unlink(original.registryPath);
  const replacement = await addPeer(current, {
    pid: 47_159,
    sessionId: SESSION_ONE,
    name: "stall-after-rotation",
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => replacementPayloads.push(data));
    },
  });

  const progressResult = await listener.notifyInboundProgress(
    receiptHandle as string,
    {
      kind: "stall",
      reason: "AWAITING_EXTERNAL_APPROVAL",
      queuedForMs: Number.POSITIVE_INFINITY,
    },
  );
  assert.deepEqual(progressResult, { transportStatus: "transport_written" });
  await eventually(() => replacementPayloads.length === 1);
  assert.equal(originalPayloads.length, 0);
  assert.ok(Buffer.byteLength(replacementPayloads[0]!, "utf8") <= 513);
  const progressFrame = JSON.parse(
    replacementPayloads[0]!.trim(),
  ) as Record<string, unknown>;
  assert.equal(progressFrame.type, "user");
  assert.equal(progressFrame.action, undefined);
  assert.equal(progressFrame.status, undefined);
  assert.equal(progressFrame.from, undefined);
  const progressContent = String(
    (progressFrame.message as Record<string, unknown>)?.content,
  );
  assert.match(progressContent, /^<gateway-delivery-stall /);
  assert.match(progressContent, /terminal="false"/);
  assert.match(progressContent, /reason="AWAITING_EXTERNAL_APPROVAL"/);
  assert.match(progressContent, /queued-for-ms="3600000"/);
  assert.match(progressContent, /本地网关仍在等待投递前一条消息/);
  assert.match(progressContent, /embassy status/);
  assert.equal(progressContent.includes("peer_message_status"), false);

  await assert.rejects(
    listener.notifyInboundProgress(receiptHandle as string, {
      kind: "stall",
      reason: "ROUTE_BUSY",
      queuedForMs: 200,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_PROGRESS_ALREADY_NOTIFIED",
  );
  assert.equal(replacementPayloads.length, 1);

  const terminalResult = await listener.acknowledge(
    receiptHandle as string,
    "delivered",
  );
  assert.deepEqual(terminalResult, { transportStatus: "transport_written" });
  await eventually(() => replacementPayloads.length === 2);
  const terminalFrame = JSON.parse(
    replacementPayloads[1]!.trim(),
  ) as Record<string, unknown>;
  assert.equal(terminalFrame.action, "peer_message_status");
  assert.equal(terminalFrame.status, "delivered");
  assert.equal(terminalFrame.orig_msg_id, MESSAGE_ONE);
  assert.equal(replacement.socketPath.endsWith("47159.sock"), true);
});

test("a pre-write acknowledgement failure is recoverable and retains its handle", async (t) => {
  let failBeforeConnect = true;
  let receiptHandle: string | undefined;
  const statuses: Array<Record<string, unknown>> = [];
  const current = await fixture(t, {
    connect: (socketPath) => {
      if (!failBeforeConnect) return net.createConnection({ path: socketPath });
      failBeforeConnect = false;
      const socket = new EventEmitter() as net.Socket;
      socket.destroy = (() => socket) as net.Socket["destroy"];
      socket.setTimeout = (() => socket) as net.Socket["setTimeout"];
      queueMicrotask(() => socket.emit("error", new Error("pre-connect")));
      return socket;
    },
  });
  const peer = await addPeer(current, {
    pid: 47_155,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        statuses.push(JSON.parse(data) as Record<string, unknown>);
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "retry clean pre-write" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);

  await assert.rejects(
    listener.acknowledge(receiptHandle as string, "expired", {
      code: "ROUTE_UNAVAILABLE",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_RECEIPT_NOT_WRITTEN" &&
      error.recoverable,
  );
  const result = await listener.acknowledge(
    receiptHandle as string,
    "delivered",
  );
  assert.deepEqual(result, { transportStatus: "transport_written" });
  await eventually(() => statuses.length === 1);
  assert.equal(statuses[0]?.status, "delivered");
});

test("releasing an inbound receipt frees it exactly once without writing", async (t) => {
  let receiptHandle: string | undefined;
  let statusConnections = 0;
  const current = await fixture(t);
  const peer = await addPeer(current, {
    pid: 47_157,
    handler: (socket) => {
      statusConnections += 1;
      socket.resume();
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "release without a write" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);

  assert.equal(
    listener.releaseInboundReceipt(receiptHandle as string),
    true,
  );
  assert.equal(
    listener.releaseInboundReceipt(receiptHandle as string),
    false,
  );
  assert.equal(listener.releaseInboundReceipt("unknown-receipt"), false);
  assert.equal(statusConnections, 0);
  await assert.rejects(
    listener.acknowledge(receiptHandle as string, "delivered"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_RECEIPT_UNKNOWN",
  );
  assert.equal(statusConnections, 0);
});

test("receipt capacity explicitly expires rather than forwarding an untracked message", async (t) => {
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  const peerFrames: Array<Record<string, unknown>> = [];
  const current = await fixture(t, { maxPendingReceipts: 1 });
  const peer = await addPeer(current, {
    pid: 47_156,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.trim().split("\n")) {
          peerFrames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const frame = (messageId: string, content: string) =>
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content },
      msgV: 1,
      msg_id: messageId,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`;

  await sendLines(listener.address.slice(4), [
    frame(MESSAGE_ONE, "occupy receipt capacity"),
  ]);
  await eventually(() => messages.length === 1);
  await sendLines(listener.address.slice(4), [
    frame(MESSAGE_TWO, "must be refused explicitly"),
  ]);
  await eventually(() => peerFrames.length === 1);
  assert.equal(messages.length, 1);
  assert.ok(notices.some((notice) => notice.code === "RECEIPT_LIMIT"));
  assert.equal(peerFrames[0]?.status, "expired");
  assert.equal(peerFrames[0]?.orig_msg_id, MESSAGE_TWO);
  assert.equal(peerFrames[0]?.reason, "GATEWAY_RECEIPT_CAPACITY");

  await listener.acknowledge(
    messages[0]?.receiptHandle as string,
    "delivered",
  );
  await eventually(() => peerFrames.length === 2);
  await sendLines(listener.address.slice(4), [
    frame(
      "00000000-0000-4000-8000-000000000103",
      "capacity is available again",
    ),
  ]);
  await eventually(() => messages.length === 2);
});

test("capacity expiry retains one bounded retry after a clean pre-write failure", async (t) => {
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  const peerFrames: Array<Record<string, unknown>> = [];
  let connectAttempts = 0;
  const current = await fixture(t, {
    maxPendingReceipts: 1,
    connect: (socketPath) => {
      connectAttempts += 1;
      if (connectAttempts !== 1) {
        return net.createConnection({ path: socketPath });
      }
      const socket = new EventEmitter() as net.Socket;
      socket.destroy = (() => socket) as net.Socket["destroy"];
      socket.setTimeout = (() => socket) as net.Socket["setTimeout"];
      queueMicrotask(() => socket.emit("error", new Error("pre-connect")));
      return socket;
    },
  });
  const peer = await addPeer(current, {
    pid: 47_162,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.trim().split("\n")) {
          peerFrames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const frame = (messageId: string, content: string) =>
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content },
      msgV: 1,
      msg_id: messageId,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`;

  await sendLines(listener.address.slice(4), [
    frame(MESSAGE_ONE, "occupy capacity"),
  ]);
  await eventually(() => messages.length === 1);
  await sendLines(listener.address.slice(4), [
    frame(MESSAGE_TWO, "retry capacity expiry"),
  ]);

  await eventually(() => peerFrames.length === 1);
  assert.equal(connectAttempts, 2);
  assert.equal(messages.length, 1);
  assert.ok(notices.some((notice) => notice.code === "RECEIPT_LIMIT"));
  assert.equal(
    notices.some((notice) => notice.code === "CALLBACK_ERROR"),
    false,
  );
  assert.equal(peerFrames[0]?.status, "expired");
  assert.equal(peerFrames[0]?.orig_msg_id, MESSAGE_TWO);
  assert.equal(peerFrames[0]?.reason, "GATEWAY_RECEIPT_CAPACITY");
});

test("capacity expiry never replays an ambiguous write and releases its overflow slot", async (t) => {
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  let connectAttempts = 0;
  const current = await fixture(t, {
    maxPendingReceipts: 1,
    connect: () => {
      connectAttempts += 1;
      const socket = new EventEmitter() as net.Socket;
      socket.destroy = (() => socket) as net.Socket["destroy"];
      socket.setTimeout = (() => socket) as net.Socket["setTimeout"];
      socket.end = ((
        _payload: Buffer,
        _callback: () => void,
      ) => {
        queueMicrotask(() => socket.emit("error", new Error("reset")));
        return socket;
      }) as net.Socket["end"];
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  const peer = await addPeer(current, { pid: 47_163 });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const frame = (messageId: string) =>
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "capacity ambiguity" },
      msgV: 1,
      msg_id: messageId,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`;

  await sendLines(listener.address.slice(4), [frame(MESSAGE_ONE)]);
  await eventually(() => messages.length === 1);
  await sendLines(listener.address.slice(4), [frame(MESSAGE_TWO)]);
  await eventually(
    () =>
      connectAttempts === 1 &&
      notices.some((notice) => notice.code === "CALLBACK_ERROR"),
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(connectAttempts, 1);

  await sendLines(listener.address.slice(4), [
    frame("00000000-0000-4000-8000-000000000104"),
  ]);
  await eventually(() => connectAttempts === 2);
  assert.equal(messages.length, 1);
});

test("a second overflow frame is transport-rejected while the bounded capacity slot is occupied", async (t) => {
  const messages: ClaudePeerInboundMessage[] = [];
  let connectAttempts = 0;
  const current = await fixture(t, {
    maxPendingReceipts: 1,
    connect: () => {
      connectAttempts += 1;
      const socket = new EventEmitter() as net.Socket;
      socket.destroy = (() => socket) as net.Socket["destroy"];
      socket.setTimeout = (() => socket) as net.Socket["setTimeout"];
      queueMicrotask(() => socket.emit("error", new Error("pre-connect")));
      return socket;
    },
  });
  const peer = await addPeer(current, { pid: 47_164 });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
  });
  const frame = (messageId: string) =>
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "bounded overflow" },
      msgV: 1,
      msg_id: messageId,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`;

  await sendLines(listener.address.slice(4), [frame(MESSAGE_ONE)]);
  await eventually(() => messages.length === 1);
  await sendLines(listener.address.slice(4), [frame(MESSAGE_TWO)]);
  await eventually(() => connectAttempts === 1);

  const transportClosed = new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: listener.address.slice(4) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("overflow transport remained open"));
    }, 500);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("connect", () => {
      socket.write(frame("00000000-0000-4000-8000-000000000105"));
    });
  });
  await transportClosed;
  assert.equal(messages.length, 1);
});

test("capacity clean-write retries release on exhaustion and stop on listener close", async (t) => {
  const messages: ClaudePeerInboundMessage[] = [];
  const notices: ClaudePeerProtocolNotice[] = [];
  let connectAttempts = 0;
  const current = await fixture(t, {
    maxPendingReceipts: 1,
    connect: () => {
      connectAttempts += 1;
      const socket = new EventEmitter() as net.Socket;
      socket.destroy = (() => socket) as net.Socket["destroy"];
      socket.setTimeout = (() => socket) as net.Socket["setTimeout"];
      queueMicrotask(() => socket.emit("error", new Error("pre-connect")));
      return socket;
    },
  });
  const peer = await addPeer(current, { pid: 47_165 });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      messages.push(message);
    },
    onProtocolNotice: (notice) => {
      notices.push(notice);
    },
  });
  const frame = (messageId: string) =>
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "bounded clean failure" },
      msgV: 1,
      msg_id: messageId,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`;

  await sendLines(listener.address.slice(4), [frame(MESSAGE_ONE)]);
  await eventually(() => messages.length === 1);
  await sendLines(listener.address.slice(4), [frame(MESSAGE_TWO)]);
  await eventually(
    () =>
      connectAttempts === 3 &&
      notices.some((notice) => notice.code === "CALLBACK_ERROR"),
  );

  await sendLines(listener.address.slice(4), [
    frame("00000000-0000-4000-8000-000000000106"),
  ]);
  await eventually(() => connectAttempts === 4);
  await listener.close();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(connectAttempts, 4);
  assert.equal(messages.length, 1);
});

test("verbose notices preserve the localized expired diagnostic frame", async (t) => {
  let receiptHandle: string | undefined;
  const frames: Array<Record<string, unknown>> = [];
  const current = await fixture(t, {
    locale: "zh-CN",
    deliveryNotices: "verbose",
  });
  const peer = await addPeer(current, {
    pid: 47_152,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.trim().split("\n")) {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "native inbound failure" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);
  await listener.acknowledge(receiptHandle as string, "expired", {
    code: "ROUTE_UNAVAILABLE",
  });
  await eventually(() => frames.length === 2);
  assert.equal(frames[0]?.status, "expired");
  assert.equal(frames[0]?.reason, "ROUTE_UNAVAILABLE");
  assert.equal(frames[1]?.type, "user");
  const diagnosticContent = String(
    (frames[1]?.message as Record<string, unknown>)?.content,
  );
  assert.match(
    diagnosticContent,
    /gateway-delivery-diagnostic status="expired" code="ROUTE_UNAVAILABLE"/,
  );
  assert.match(diagnosticContent, /本地网关无法投递前一条消息/);
  assert.match(diagnosticContent, /embassy status/);
  assert.match(diagnosticContent, /排队邮件会在忙碌接收方的当前轮次结束后到达/);
  assert.equal(frames[1]?.from, undefined);
});

test("merged notices keep stalls but fold expiry diagnostics into native status", async (t) => {
  let receiptHandle: string | undefined;
  const frames: Array<Record<string, unknown>> = [];
  const current = await fixture(t, { deliveryNotices: "merged" });
  const peer = await addPeer(current, {
    pid: 47_153,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.trim().split("\n").filter(Boolean)) {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "merged native inbound failure" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);
  assert.deepEqual(
    await listener.notifyInboundProgress(receiptHandle as string, {
      kind: "stall",
      reason: "ROUTE_BUSY",
      queuedForMs: 150_000,
    }),
    { transportStatus: "transport_written" },
  );
  await eventually(() => frames.length === 1);
  assert.equal(frames[0]?.type, "user");
  assert.match(
    String((frames[0]?.message as Record<string, unknown>)?.content),
    /gateway-delivery-stall/,
  );
  assert.match(
    String((frames[0]?.message as Record<string, unknown>)?.content),
    /Queued mail reaches a busy recipient when its turn ends/,
  );

  await listener.acknowledge(receiptHandle as string, "expired", {
    code: "ROUTE_UNAVAILABLE",
  });
  await eventually(() => frames.length === 2);
  assert.equal(frames[1]?.action, "peer_message_status");
  assert.equal(frames[1]?.status, "expired");
  assert.equal(frames[1]?.reason, "ROUTE_UNAVAILABLE");
  assert.equal(
    frames.some((frame) =>
      String((frame.message as Record<string, unknown> | undefined)?.content)
        .includes("gateway-delivery-diagnostic"),
    ),
    false,
  );
});

test("quiet notices suppress gateway user frames while preserving native expiry truth", async (t) => {
  let receiptHandle: string | undefined;
  const frames: Array<Record<string, unknown>> = [];
  const current = await fixture(t, { deliveryNotices: "quiet" });
  const peer = await addPeer(current, {
    pid: 47_154,
    handler: (socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => {
        for (const line of data.trim().split("\n").filter(Boolean)) {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    },
  });
  await selectFirstPeer(current);
  const listener = await current.adapter.listen({
    onMessage: (message) => {
      receiptHandle = message.receiptHandle;
    },
  });
  await sendLines(listener.address.slice(4), [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "quiet native inbound failure" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
      from: `uds:${peer.socketPath}`,
    })}\n`,
  ]);
  await eventually(() => receiptHandle !== undefined);
  assert.deepEqual(
    await listener.notifyInboundProgress(receiptHandle as string, {
      kind: "stall",
      reason: "ROUTE_BUSY",
      queuedForMs: 150_000,
    }),
    { transportStatus: "suppressed" },
  );
  assert.equal(frames.length, 0);

  await listener.acknowledge(receiptHandle as string, "expired", {
    code: "ROUTE_UNAVAILABLE",
  });
  await eventually(() => frames.length === 1);
  assert.equal(frames[0]?.action, "peer_message_status");
  assert.equal(frames[0]?.status, "expired");
  assert.equal(frames[0]?.reason, "ROUTE_UNAVAILABLE");
  assert.equal(frames[0]?.type, "control");
});

test("close is single-flight and shuts the socket after registry cleanup failure", async (t) => {
  let failUnadvertise = true;
  let received = 0;
  const current = await fixture(t, {
    registryOperationHook: (event) => {
      if (
        failUnadvertise &&
        event.operation === "unadvertise" &&
        event.phase === "entered"
      ) {
        failUnadvertise = false;
        throw new Error("synthetic unadvertise failure");
      }
    },
  });
  const listener = await current.adapter.listen({
    onMessage: () => {
      received += 1;
    },
  });
  await listener.advertise("codex-close-failure", current.workspace);
  const callbackPath = listener.address.slice(4);
  const registryPath = path.join(current.sessionsDir, `${process.pid}.json`);

  const firstClose = listener.close();
  const concurrentClose = listener.close();
  assert.strictEqual(concurrentClose, firstClose);
  await assert.rejects(firstClose, /synthetic unadvertise failure/);
  assert.equal(listener.closed, true);
  await assert.rejects(lstat(callbackPath), { code: "ENOENT" });
  assert.equal(
    (JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>)
      .name,
    "codex-close-failure",
  );
  await sendLines(callbackPath, [
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "must not arrive" },
      msgV: 1,
      msg_id: MESSAGE_ONE,
      priority: "next",
    })}\n`,
  ]).catch(() => undefined);
  assert.equal(received, 0);

  const retryClose = listener.close();
  assert.strictEqual(retryClose, firstClose);
  await assert.rejects(retryClose, /synthetic unadvertise failure/);
});

test("callback cleanup preserves an observed foreign path replacement", async (t) => {
  const current = await fixture(t);
  const listener = await current.adapter.listen({ onMessage: () => undefined });
  const callbackPath = listener.address.slice(4);
  await unlink(callbackPath);
  await writeFile(callbackPath, "foreign replacement", { mode: 0o600 });
  await assert.rejects(
    listener.close(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_CALLBACK_CHANGED",
  );
  assert.equal(await readFile(callbackPath, "utf8"), "foreign replacement");
});
