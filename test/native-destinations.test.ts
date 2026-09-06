import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import { ClaudePeerAdapter } from "../src/gateway/claude-peer.js";
import type { WakeInput, WakeResult } from "../src/gateway/coordinator.js";
import type { Endpoint } from "../src/gateway/ledger.js";
import { ClaudeDestination, CodexDestination } from "../src/gateway/native-destinations.js";
import type {
  StatelessCodexAcceptedOperation,
  StatelessCodexOperationInput,
  StatelessCodexOperationResult,
  StatelessCodexOperationTransport,
} from "../src/gateway/codex-stateless-transport.js";

const claude: Endpoint = {
  id: "reg_claude",
  host: "m5dev",
  provider: "claude",
  alias: "advisor@m5dev",
  handle: "session-advisor",
};
const codex: Endpoint = {
  id: "reg_codex",
  host: "m5dev",
  provider: "codex",
  alias: "codex-builder@m5dev",
  handle: "thread-builder",
};

function wake(target: Endpoint, overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    attempt: "attempt-1",
    target,
    text: "<cross-session-message>one\n<cross-session-message>two",
    deadline: Date.now() + 60_000,
    steer: false,
    messages: [],
    authorize: async () => true,
    accepted: async () => undefined,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Claude destination re-discovers exact identity and performs only after authorization", async () => {
  const events: string[] = [];
  let optionsSeen: unknown;
  const destination = new ClaudeDestination({
    host: "m5dev",
    stateRoot: "/private/test-state",
    peer: {
      discover: async () => ({ peers: [{ targetId: claude.handle, alias: "advisor", kind: "interactive",
        status: "idle", compatibility: "compatible" }], rejected: {}, truncated: false,
      entriesScanned: 1, parseableRecords: 1 }),
      assertTargetWorkspaceDisjoint: async (target, root) => {
        assert.deepEqual([target, root], [claude.handle, "/private/test-state"]);
        events.push("workspace");
      },
      prepareSend: async (target, text, options) => {
        assert.equal(target, claude.handle);
        assert.equal(text, wake(claude).text);
        optionsSeen = options;
        events.push("prepare");
        return {
          messageId: "00000000-0000-4000-8000-000000000001",
          frameBytes: 81,
          sha256: "a".repeat(64),
          cancel: () => events.push("cancel"),
          perform: async (authorize: () => Promise<boolean>) => {
            events.push("reattest");
            assert.equal(await authorize(), true);
            events.push("write");
            return { messageId: "00000000-0000-4000-8000-000000000001",
              transportStatus: "transport_written" };
          },
        };
      },
      close: async () => undefined,
    },
  });
  const result = await destination.deliver(wake(claude, {
    authorize: async (evidence) => {
      events.push("authorize");
      assert.deepEqual(evidence, { bytes: 81, sha256: "a".repeat(64) });
      return true;
    },
  }));
  assert.deepEqual(result, { outcome: "delivered", code: "DELIVERED" });
  assert.deepEqual(events, ["workspace", "prepare", "reattest", "authorize", "write"]);
  assert.deepEqual(Object.keys(optionsSeen as object), ["deadlineAt"]);
});

test("Claude destination wakes a real test-owned native socket without reply artifacts", async (t) => {
  const root = await realpath(await mkdtemp(path.join("/tmp", "embassy-native-destination-")));
  const sessionsDir = path.join(root, "sessions");
  const socketDir = path.join(root, "sockets");
  const home = path.join(root, "home");
  const workspace = path.join(home, "workspace");
  const stateRoot = path.join(root, "state");
  const systemTemp = path.join(root, "system-temp");
  await Promise.all([
    mkdir(sessionsDir, { mode: 0o700 }),
    mkdir(socketDir, { mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(stateRoot, { mode: 0o700 }),
    mkdir(systemTemp, { mode: 0o700 }),
  ]);
  await chmod(home, 0o700);
  const pid = 45_201;
  const sessionId = "00000000-0000-4000-8000-000000000201";
  const socketPath = path.join(socketDir, `${pid}.sock`);
  let wire = Buffer.alloc(0);
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => { wire = Buffer.concat([wire, chunk]); });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const registryPath = path.join(sessionsDir, `${pid}.json`);
  const record = (name: string) => ({
    pid,
    sessionId,
    cwd: workspace,
    startedAt: 1_786_148_832_556,
    procStart: "Sat Aug  8 00:27:11 2026",
    version: "2.1.227",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: socketPath,
    name,
    status: "idle",
    updatedAt: 1_786_149_062_112,
    statusUpdatedAt: 1_786_149_062_112,
  });
  await writeFile(registryPath, JSON.stringify(record("advisor")), { mode: 0o600 });
  const peer = new ClaudePeerAdapter({ sessionsDir, socketDir, connectTimeoutMs: 500 }, {
    processInspector: async (candidate) => candidate === pid
      ? { uid: process.getuid?.() ?? 501, generation: "native-destination-process" }
      : undefined,
    userHome: home,
    tempRoots: [systemTemp],
  });
  const destination = new ClaudeDestination({ host: "m5dev", stateRoot, peer });
  t.after(async () => {
    await destination.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const before = {
    sessions: await readdir(sessionsDir),
    sockets: await readdir(socketDir),
  };

  assert.deepEqual(await destination.deliver(wake({ ...claude, handle: sessionId }, {
    authorize: async () => false,
  })), { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" });
  assert.equal(wire.length, 0);

  await writeFile(registryPath, JSON.stringify(record("renamed")), { mode: 0o600 });
  assert.deepEqual(await destination.deliver(wake({ ...claude, handle: sessionId })),
    { outcome: "deferred", code: "ROUTE_BUSY" });
  const text = "<cross-session-message>first</cross-session-message>\n" +
    "<cross-session-message>second</cross-session-message>";
  assert.deepEqual(await destination.deliver(wake({ ...claude, alias: "renamed@m5dev",
    handle: sessionId }, { text })), { outcome: "delivered", code: "DELIVERED" });
  for (let attempt = 0; attempt < 100 && !wire.includes(0x0a); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(wire.includes(0x0a));
  const frame = JSON.parse(wire.toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(frame).sort(), ["message", "msgV", "msg_id", "priority", "type"]);
  assert.equal(frame.msgV, 1);
  assert.match(String(frame.msg_id), /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
  assert.equal(frame.type, "user");
  assert.equal(frame.priority, "next");
  assert.deepEqual(frame.message, { role: "user", content: text });
  assert.equal(Object.hasOwn(frame, "from"), false);
  assert.deepEqual({ sessions: await readdir(sessionsDir), sockets: await readdir(socketDir) }, before);
});

test("Claude destination preserves clean refusal and authorization uncertainty", async () => {
  let writes = 0;
  let cancelled = 0;
  const peer = {
    discover: async () => ({ peers: [{ targetId: claude.handle, alias: "advisor", kind: "bg" as const,
      status: "idle" as const, compatibility: "compatible" as const }], rejected: {}, truncated: false,
    entriesScanned: 1, parseableRecords: 1 }),
    assertTargetWorkspaceDisjoint: async () => undefined,
    prepareSend: async () => ({ messageId: "00000000-0000-4000-8000-000000000001",
      frameBytes: 5, sha256: "b".repeat(64), cancel: () => { cancelled += 1; },
      perform: async (authorize: () => Promise<boolean>) => {
        let authorized: boolean;
        try {
          authorized = await authorize();
        } catch {
          throw new BridgeError("WRITE_AUTHORIZATION_UNCERTAIN", "uncertain");
        }
        if (!authorized) {
          throw new BridgeError("WRITE_AUTHORIZATION_DENIED", "denied", true);
        }
        writes += 1;
        return { messageId: "00000000-0000-4000-8000-000000000001" as const,
          transportStatus: "transport_written" as const };
      } }),
    close: async () => undefined,
  };
  const denied = new ClaudeDestination({ host: "m5dev", stateRoot: "/state", peer });
  assert.deepEqual(await denied.deliver(wake(claude, { authorize: async () => false })),
    { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" });
  const uncertain = new ClaudeDestination({ host: "m5dev", stateRoot: "/state", peer });
  assert.deepEqual(await uncertain.deliver(wake(claude, { authorize: async () => {
    throw new Error("lost authorization reply");
  } })), { outcome: "ambiguous", code: "WRITE_AUTHORIZATION_UNCERTAIN" });
  assert.deepEqual([writes, cancelled], [0, 0]);

  const missing = new ClaudeDestination({ host: "m5dev", stateRoot: "/state", peer: {
    ...peer,
    discover: async () => ({ peers: [], rejected: {}, truncated: false,
      entriesScanned: 0, parseableRecords: 0 }),
  } });
  assert.deepEqual(await missing.deliver(wake(claude)), { outcome: "deferred", code: "ROUTE_BUSY" });

  for (const [error, expected] of [
    [new BridgeError("CLAUDE_PEER_CONNECT_TIMEOUT", "no write", true),
      { outcome: "failed", code: "CLAUDE_PEER_CONNECT_TIMEOUT" }],
    [new BridgeError("CLAUDE_PEER_WRITE_AMBIGUOUS", "write began"),
      { outcome: "ambiguous", code: "CLAUDE_PEER_WRITE_AMBIGUOUS" }],
  ] as const) {
    const postAuthorization = new ClaudeDestination({ host: "m5dev", stateRoot: "/state", peer: {
      ...peer,
      prepareSend: async () => ({ messageId: "00000000-0000-4000-8000-000000000001",
        frameBytes: 5, sha256: "b".repeat(64), cancel: () => undefined,
        perform: async (authorize: () => Promise<boolean>) => {
          assert.equal(await authorize(), true);
          throw error;
        } }),
    } });
    assert.deepEqual(await postAuthorization.deliver(wake(claude)), expected);
  }
});

test("Claude destination authorizes only after asynchronous final re-attestation", async () => {
  const reattestation = deferred<void>();
  const release = deferred<void>();
  let retired = false;
  let writes = 0;
  let authorizationCalls = 0;
  const destination = new ClaudeDestination({
    host: "m5dev",
    stateRoot: "/state",
    peer: {
      discover: async () => ({ peers: [{ targetId: claude.handle, alias: "advisor",
        kind: "interactive" as const, status: "idle" as const,
        compatibility: "compatible" as const }], rejected: {}, truncated: false,
      entriesScanned: 1, parseableRecords: 1 }),
      assertTargetWorkspaceDisjoint: async () => undefined,
      prepareSend: async () => ({
        messageId: "00000000-0000-4000-8000-000000000001",
        frameBytes: 5,
        sha256: "e".repeat(64),
        cancel: () => undefined,
        perform: async (authorize: () => Promise<boolean>) => {
          reattestation.resolve();
          await release.promise;
          if (!await authorize()) {
            throw new BridgeError("WRITE_AUTHORIZATION_DENIED", "retired", true);
          }
          writes += 1;
          return { messageId: "00000000-0000-4000-8000-000000000001",
            transportStatus: "transport_written" as const };
        },
      }),
      close: async () => undefined,
    },
  });
  const delivery = destination.deliver(wake(claude, {
    authorize: async () => {
      authorizationCalls += 1;
      return !retired;
    },
  }));
  await reattestation.promise;
  retired = true;
  release.resolve();

  assert.deepEqual(await delivery, {
    outcome: "deferred",
    code: "WRITE_AUTHORIZATION_DENIED",
  });
  assert.equal(authorizationCalls, 1);
  assert.equal(writes, 0);
});

function transport(
  execute: (input: StatelessCodexOperationInput) => Promise<StatelessCodexOperationResult>,
): StatelessCodexOperationTransport {
  return { execute };
}

test("Codex destination maps every operation phase without forwarding output", async () => {
  const cases: Array<[StatelessCodexOperationResult, WakeResult]> = [
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "clean", state: "deferred",
      safeErrorCode: "ROUTE_BUSY" }, { outcome: "deferred", code: "ROUTE_BUSY" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "clean", state: "failed",
      safeErrorCode: "INPUT_INVALID" }, { outcome: "failed", code: "INPUT_INVALID" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "clean", state: "failed",
      safeErrorCode: "MESSAGE_EXPIRED" }, { outcome: "expired", code: "MESSAGE_EXPIRED", unwritten: true }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "armed", state: "ambiguous",
      safeErrorCode: "TRANSPORT_WRITE_FAILED" },
    { outcome: "ambiguous", code: "TRANSPORT_WRITE_FAILED" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "accepted", state: "unconfirmed",
      safeErrorCode: "REQUEST_TIMEOUT" }, { outcome: "unconfirmed", code: "REQUEST_TIMEOUT" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "terminal", state: "terminal",
      outcome: "completed" },
    { outcome: "delivered", code: "DELIVERED" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "terminal", state: "terminal",
      outcome: "failed" },
    { outcome: "failed", code: "CODEX_TURN_FAILED" }],
    [{ attemptId: "attempt-1", cleanupConfirmed: true, phase: "terminal", state: "terminal",
      outcome: "interrupted" },
    { outcome: "cancelled", code: "CODEX_TURN_INTERRUPTED" }],
  ];
  for (const [native, expected] of cases) {
    const destination = new CodexDestination({ host: "m5dev", operation: transport(async () => native) });
    assert.deepEqual(await destination.deliver(wake(codex)), expected);
  }
});

test("Codex destination starts a normal turn when STEER has no accepted operation", async () => {
  let executions = 0;
  const destination = new CodexDestination({ host: "m5dev", operation: transport(async (input) => {
    executions += 1;
    assert.equal(input.kind, "start");
    assert.equal(input.text, "STEER: begin instead");
    return { attemptId: input.attemptId, cleanupConfirmed: true,
      phase: "terminal", state: "terminal", outcome: "completed" };
  }) });

  assert.deepEqual(await destination.deliver(wake(codex, {
    attempt: "attempt-steer-fallback",
    steer: true,
    text: "STEER: begin instead",
  })), { outcome: "delivered", code: "DELIVERED" });
  assert.equal(executions, 1);
});

test("Codex destination reserves one exact-target start before provider setup", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let executions = 0;
  const destination = new CodexDestination({ host: "m5dev", operation: transport(async (input) => {
    executions += 1;
    entered.resolve();
    await release.promise;
    return { attemptId: input.attemptId, cleanupConfirmed: true,
      phase: "terminal", state: "terminal", outcome: "completed" };
  }) });

  const first = destination.deliver(wake(codex, { attempt: "attempt-normal" }));
  await entered.promise;
  assert.deepEqual(await destination.deliver(wake(codex, {
    attempt: "attempt-racing-steer",
    steer: true,
    text: "STEER: racing start",
  })), { outcome: "deferred", code: "ROUTE_BUSY" });
  assert.equal(executions, 1);
  release.resolve();
  assert.deepEqual(await first, { outcome: "delivered", code: "DELIVERED" });
});

test("queued STEER falls back to a new turn after the accepted operation completes", async () => {
  const acceptedReady = deferred<void>();
  const completeFirst = deferred<void>();
  let executions = 0;
  let activeSteers = 0;
  const destination = new CodexDestination({ host: "m5dev", operation: transport(async (input) => {
    executions += 1;
    if (executions === 1) {
      await input.onAccepted({
        attemptId: input.attemptId,
        turnId: "turn-active",
        steer: async (steer) => {
          activeSteers += 1;
          return { attemptId: steer.attemptId, phase: "clean", state: "deferred",
            safeErrorCode: "ROUTE_BUSY" };
        },
      });
      acceptedReady.resolve();
      await completeFirst.promise;
    } else {
      assert.equal(input.text, "STEER: retry after completion");
    }
    return { attemptId: input.attemptId, cleanupConfirmed: true,
      phase: "terminal", state: "terminal", outcome: "completed" };
  }) });

  const first = destination.deliver(wake(codex, { attempt: "attempt-active" }));
  await acceptedReady.promise;
  const steer = wake({ ...codex, alias: "codex-renamed@m5dev" }, {
    attempt: "attempt-queued-steer",
    steer: true,
    text: "STEER: retry after completion",
  });
  assert.deepEqual(await destination.deliver(steer),
    { outcome: "deferred", code: "ROUTE_BUSY" });
  assert.deepEqual([executions, activeSteers], [1, 1]);

  completeFirst.resolve();
  assert.deepEqual(await first, { outcome: "delivered", code: "DELIVERED" });
  assert.deepEqual(await destination.deliver(steer),
    { outcome: "delivered", code: "DELIVERED" });
  assert.deepEqual([executions, activeSteers], [2, 1]);
});

test("Codex accepted handle admits exact STEER and lives until completion", async () => {
  const completed = deferred<StatelessCodexOperationResult>();
  const acceptedReady = deferred<void>();
  const abortSeen = deferred<void>();
  const events: string[] = [];
  const accepted: StatelessCodexAcceptedOperation = {
    attemptId: "attempt-1",
    turnId: "turn-1",
    steer: async (input) => {
      events.push(`steer:${input.text}`);
      assert.equal(await input.authorizeWrite({ attemptId: input.attemptId,
        kind: "codex_turn_steer", bodyBytes: 5, frameBytes: 17,
        sha256: "c".repeat(64) }), true);
      return { attemptId: input.attemptId, phase: "terminal", state: "terminal",
        outcome: "delivered" };
    },
  };
  const destination = new CodexDestination({ host: "m5dev", operation: transport(async (input) => {
    input.signal?.addEventListener("abort", () => abortSeen.resolve(), { once: true });
    assert.equal(await input.authorizeWrite({ attemptId: input.attemptId,
      kind: "codex_turn_start", bodyBytes: 20, frameBytes: 61,
      sha256: "d".repeat(64) }), true);
    await input.onAccepted(accepted);
    acceptedReady.resolve();
    return await completed.promise;
  }) });
  const start = destination.deliver(wake(codex, {
    authorize: async (evidence) => {
      events.push(`authorize:${evidence.bytes}`);
      return true;
    },
    accepted: async (loss) => { events.push(`accepted:${loss}`); },
  }));
  await acceptedReady.promise;
  assert.deepEqual(await destination.deliver(wake(codex, {
    attempt: "attempt-steer",
    steer: true,
    text: "STEER: adjust",
    authorize: async (evidence) => {
      events.push(`authorize:${evidence.bytes}`);
      return true;
    },
  })), { outcome: "delivered", code: "DELIVERED" });
  assert.deepEqual(await destination.deliver(wake({ ...codex, handle: "replacement" }, {
    attempt: "attempt-wrong", steer: true, text: "STEER: wrong",
  })), { outcome: "deferred", code: "ROUTE_BUSY" });

  let closed = false;
  const closing = destination.close().then(() => { closed = true; });
  await abortSeen.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  completed.resolve({ attemptId: "attempt-1", cleanupConfirmed: true,
    phase: "terminal", state: "terminal", outcome: "completed" });
  assert.deepEqual(await start, { outcome: "delivered", code: "DELIVERED" });
  await closing;
  assert.deepEqual(events, ["authorize:61", "accepted:unconfirmed",
    "steer:STEER: adjust", "authorize:17"]);
});

test("Codex accepted callback failure remains unconfirmed", async () => {
  const destination = new CodexDestination({ host: "m5dev", operation: transport(async (input) => {
    try {
      await input.onAccepted({ attemptId: input.attemptId, turnId: "turn-1",
        steer: async () => { throw new Error("unused"); } });
    } catch (error) {
      assert.match(String(error), /persistence unavailable/u);
      return { attemptId: input.attemptId, cleanupConfirmed: true,
        phase: "accepted", state: "unconfirmed", safeErrorCode: "ACCEPTANCE_UNCONFIRMED" };
    }
    assert.fail("accepted callback should fail");
  }) });
  assert.deepEqual(await destination.deliver(wake(codex, {
    accepted: async () => { throw new Error("persistence unavailable"); },
  })), { outcome: "unconfirmed", code: "ACCEPTANCE_UNCONFIRMED" });
});
