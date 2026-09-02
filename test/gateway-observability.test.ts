import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GATEWAY_CONTROL_PROTOCOL_VERSION,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewayControlRequest,
  type GatewayControlResponse,
  type ValidatedSendParams,
} from "../src/gateway/control.js";
import {
  gatewayCliExitCodes,
  readGatewayControllerPid,
  runGatewayCli as runGatewayCliBase,
  EMBASSY_VERSION,
  type GatewayCliDependencies,
} from "../src/gateway/cli.js";
import type { GatewayPublicSnapshot } from "../src/gateway/types.js";

/**
 * Nothing in this file touches a real state directory, spawns a broker, or
 * reads a provider artifact: every gateway call is answered by an in-process
 * responder, and the two tests that need a directory make their own under
 * TMPDIR. The file therefore runs unchanged on ubuntu.
 */
const HOST = "this-mac";
const NOW = "2026-09-02T18:04:11.000Z";
const CONVERSATION_ID = "conv_0123456789abcdef";
const DELIVERY_TOKEN = "dlv_0123456789abcdefghijklmn";
const PEER_TOKEN = `peer_${"a".repeat(32)}`;
const PEER_RECEIPT = `prc_${"b".repeat(24)}`;
const TEST_INVENTORY = { host: HOST, nodes: [] } as const;
const CONFIG = {
  stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
  allowedHosts: [HOST], hostId: HOST, peerNodes: [], steeringEnabled: true,
  stallNoticeMs: 30_000, limits: {} as never,
};

type Capture = { chunks: string[]; isTTY?: boolean; write(chunk: string): void };
function capture(isTTY = false): Capture {
  const chunks: string[] = [];
  return { chunks, isTTY, write(chunk: string) { chunks.push(chunk); } };
}
const text = (output: Capture): string => output.chunks.join("");

const SNAPSHOT: GatewayPublicSnapshot = {
  schemaVersion: 2, generatedAt: NOW, health: "healthy",
  connectors: [
    { provider: "claude", host: HOST, health: "healthy", protocol: "claude-native", protocolVersion: "1", lastSeenAt: NOW },
    { provider: "codex", host: HOST, health: "degraded", protocol: "codex-app-server", protocolVersion: "1", lastSeenAt: NOW, safeErrorCode: "MANAGED_CODEX_UNAVAILABLE" },
  ],
  availablePeers: [{ alias: `advisor@${HOST}`, provider: "claude", host: HOST, state: "idle", validated: true, routed: true, lastSeenAt: NOW }],
  routes: [{
    alias: `codex-reviewer@${HOST}`, provider: "codex", host: HOST, enabled: true, state: "idle",
    busyPolicy: "queue", queueDepth: 0, lastSeenAt: NOW, mutable: true,
    counters: { accepted: 1, delivered: 1, unconfirmed: 0, failed: 0, ambiguous: 0, expired: 0, cancelled: 0, abandoned: 0, rejected: 0, bytesAccepted: 42 },
  }],
  activityEvents: [],
  messages: [{
    sequence: 1, timestamp: NOW, messageIdSuffix: "0a1b2c3d", direction: "claude_to_codex",
    sourceAlias: `advisor@${HOST}`, targetAlias: `codex-reviewer@${HOST}`, state: "delivered",
    bytes: 5, body: "hello", latencyMs: 61,
  }],
  accounting: {
    accepted: 1, duplicates: 0, delivered: 1, unconfirmed: 0, failed: 0, ambiguous: 0,
    expired: 0, cancelled: 0, abandoned: 0, rejected: 0, bytesAccepted: 5, queuedBytes: 0,
  },
  alerts: [],
  truncation: { connectors: 0, availablePeers: 0, routes: 0, activityEvents: 0, messages: 0, alerts: 0 },
};

type Responder = (request: GatewayControlRequest) => unknown;
function dependencies(
  stdout: Capture, respond: Responder, extra: GatewayCliDependencies = {},
): GatewayCliDependencies {
  return {
    env: { NO_COLOR: "1" }, stdout, stderr: capture(), loadConfig: () => CONFIG,
    loadNodeInventory: async () => TEST_INVENTORY,
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: GatewayControlRequest }) => {
      const result = respond(request);
      if (result !== null && typeof result === "object" && "ok" in result) {
        return result as GatewayControlResponse;
      }
      return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result };
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    ...extra,
  };
}
const runGatewayCli: typeof runGatewayCliBase = (argv, deps = {}) =>
  runGatewayCliBase(argv, { loadNodeInventory: async () => TEST_INVENTORY, ...deps });

const snapshotResponder: Responder = (request) =>
  request.method === "refresh_discovery" ? { accepted: true, code: "ok", revision: 2 }
    : request.method === "list_snapshot" ? SNAPSHOT : {};

test("status renders for a terminal and stays byte-identical JSON everywhere else", async () => {
  const expectedJson = `${JSON.stringify({ ok: true, command: "status", result: SNAPSHOT })}\n`;

  // Piped: exactly the line scripts and the skill already parse.
  const piped = capture();
  assert.equal(await runGatewayCli(["status"], dependencies(piped, snapshotResponder)),
    gatewayCliExitCodes.ok);
  assert.equal(text(piped), expectedJson);
  assert.deepEqual((JSON.parse(text(piped)) as { result: unknown }).result, SNAPSHOT);

  // A terminal gets the human view instead.
  const terminal = capture(true);
  assert.equal(await runGatewayCli(["status"], dependencies(terminal, snapshotResponder)),
    gatewayCliExitCodes.ok);
  assert.match(text(terminal), new RegExp(`^embassy ${EMBASSY_VERSION.replace(/\./g, "\\.")} {2}broker degraded`));
  assert.match(text(terminal), /MANAGED_CODEX_UNAVAILABLE/);
  assert.equal(text(terminal).startsWith("{"), false);

  // --json overrides the terminal and reproduces the piped bytes exactly.
  const forced = capture(true);
  assert.equal(await runGatewayCli(["status", "--json"], dependencies(forced, snapshotResponder)),
    gatewayCliExitCodes.ok);
  assert.equal(text(forced), expectedJson);
});

test("status rescans before it reads, and a refused rescan is reported rather than fatal", async () => {
  const methods: string[] = [];
  const stdout = capture(true);
  const code = await runGatewayCli(["status"], dependencies(stdout, (request) => {
    methods.push(request.method);
    return request.method === "refresh_discovery"
      ? { accepted: false, code: "unavailable", revision: 2 } : SNAPSHOT;
  }));
  assert.deepEqual(methods, ["refresh_discovery", "list_snapshot"]);
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.match(text(stdout), /the rescan for Claude sessions did not run \(unavailable\)/);
});

test("status exits 0 whenever the broker answered, whatever the overall word says", async () => {
  for (const argv of [["status"], ["status", "--json"]]) {
    const stdout = capture(argv.length === 1);
    assert.equal(await runGatewayCli(argv, dependencies(stdout, snapshotResponder)),
      gatewayCliExitCodes.ok, argv.join(" "));
  }
});

test("--recent is bounded, and an out-of-range value never reaches the broker", async () => {
  const stdout = capture(true);
  await runGatewayCli(["status", "--recent", "1"], dependencies(stdout, snapshotResponder));
  assert.match(text(stdout), /^recent \(1 of 1\)$/m);

  for (const value of ["0", "101", "abc", "-1", "1.5"]) {
    const out = capture(true), err = capture();
    let contacted = false;
    const code = await runGatewayCli(["status", "--recent", value], {
      env: {}, stdout: out, stderr: err, loadConfig: () => CONFIG,
      loadNodeInventory: async () => TEST_INVENTORY,
      validateControlSocket: async () => { contacted = true; },
      sendRequest: async () => { contacted = true; throw new Error("must not send"); },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput, value);
    assert.equal(contacted, false, value);
    assert.equal((JSON.parse(text(out)) as { error: { code: string } }).error.code, "INVALID_ARGUMENTS");
  }
});

test("NO_COLOR suppresses colour on a terminal, and a pipe never colours at all", async () => {
  const coloured = capture(true);
  await runGatewayCli(["status"], dependencies(coloured, snapshotResponder, { env: {} }));
  assert.ok(text(coloured).includes("\u001b["));

  const plain = capture(true);
  await runGatewayCli(["status"], dependencies(plain, snapshotResponder));
  assert.equal(text(plain).includes("\u001b["), false);
  assert.equal(text(plain).replace(/\u001b\[\d+m/g, ""), text(coloured).replace(/\u001b\[\d+m/g, ""));

  const piped = capture();
  await runGatewayCli(["status"], dependencies(piped, snapshotResponder, { env: {} }));
  assert.equal(text(piped).includes("\u001b["), false);
});

test("the broker pid comes from the controller lock, and a missing or odd lock is silent", async (t) => {
  const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "embassy-lock-")));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  await chmod(stateDir, 0o700);
  const lock = path.join(stateDir, ".gateway-controller.lock");

  assert.equal(await readGatewayControllerPid(stateDir), undefined);
  await writeFile(lock, JSON.stringify({ pid: 41213, hostname: "mac" }), { mode: 0o600 });
  assert.equal(await readGatewayControllerPid(stateDir), 41213);
  await writeFile(lock, "not json", { mode: 0o600 });
  assert.equal(await readGatewayControllerPid(stateDir), undefined);
  await writeFile(lock, JSON.stringify({ pid: 0 }), { mode: 0o600 });
  assert.equal(await readGatewayControllerPid(stateDir), undefined);

  const stdout = capture(true);
  await runGatewayCli(["status"], dependencies(stdout, snapshotResponder, {
    readControllerPid: async () => 41213,
  }));
  assert.match(text(stdout), /broker degraded · pid 41213 · /);
});

/** Two polls: the second carries one settlement, one new row, and one activity row. */
function watchResponder(): Responder {
  let poll = 0;
  return (request) => {
    if (request.method !== "observe_snapshot") return {};
    poll += 1;
    if (poll === 1) {
      return { snapshotRevision: 1, snapshot: { ...SNAPSHOT, messages: [
        { ...SNAPSHOT.messages[0]!, sequence: 4, state: "queued", latencyMs: undefined, body: undefined },
      ] } };
    }
    return { snapshotRevision: 2, snapshot: { ...SNAPSHOT,
      messages: [
        { ...SNAPSHOT.messages[0]!, sequence: 4, state: "delivered", latencyMs: 61 },
        { ...SNAPSHOT.messages[0]!, sequence: 5, state: "queued", bytes: 12, body: "second" },
      ],
      activityEvents: [{
        sequence: 9, timestamp: NOW, kind: "registration" as const, action: "claude_route_installed" as const,
        outcome: "accepted" as const, aliases: [`advisor@${HOST}`], operatorAction: true as const,
      }],
    } };
  };
}

test("watch tails new rows and settlements once each, then exits 0 on interrupt", async () => {
  const controller = new AbortController();
  const stdout = capture(true);
  let polls = 0;
  const code = await runGatewayCli(["watch"], dependencies(stdout, (request) => {
    const responder = watchState;
    if (request.method === "observe_snapshot") {
      polls += 1;
      if (polls >= 3) controller.abort();
    }
    return responder(request);
  }, { watchSignal: controller.signal, delay: async () => undefined, env: { NO_COLOR: "1" } }));

  assert.equal(code, gatewayCliExitCodes.ok);
  const lines = text(stdout).trimEnd().split("\n");
  // The first poll only seeds the baseline; nothing from it is replayed.
  assert.deepEqual(lines, [
    "#4  queued → delivered (61 ms)",
    `#5  advisor@${HOST} → codex-reviewer@${HOST}  queued  12 B  second`,
    `   claude_route_installed  advisor@${HOST}  accepted`,
  ]);
});
const watchState = watchResponder();

test("watch --json streams the same events as JSONL", async () => {
  const controller = new AbortController();
  const stdout = capture(true);
  let polls = 0;
  const responder = watchResponder();
  await runGatewayCli(["watch", "--json"], dependencies(stdout, (request) => {
    if (request.method === "observe_snapshot") {
      polls += 1;
      if (polls >= 3) controller.abort();
    }
    return responder(request);
  }, { watchSignal: controller.signal, delay: async () => undefined }));

  const rows = text(stdout).trimEnd().split("\n").map((line) => JSON.parse(line) as { type: string });
  assert.deepEqual(rows.map((row) => row.type), ["transition", "message", "activity"]);
  assert.equal(text(stdout).includes("\u001b["), false);
  assert.deepEqual(rows[0], {
    type: "transition", sequence: 4, from: "queued", to: "delivered",
    sourceAlias: `advisor@${HOST}`, targetAlias: `codex-reviewer@${HOST}`, latencyMs: 61,
  });
});

/** A scripted broker for `check`; `reply` decides what the peer mailbox returns. */
function checkResponder(overrides: {
  reply?: "echo" | "silent" | "other"; delivery?: string; sendRefusal?: { code: string; reason?: string };
  registerRefusal?: boolean; routes?: GatewayPublicSnapshot["routes"];
} = {}, advance: (milliseconds: number) => void = () => undefined) {
  const seen: GatewayControlRequest[] = [];
  const respond: Responder = (request) => {
    seen.push(request);
    switch (request.method) {
      case "list_snapshot":
        return { ...SNAPSHOT, routes: overrides.routes ?? SNAPSHOT.routes };
      case "register_peer":
        return overrides.registerRefusal === true
          ? { accepted: false, code: "conflict" } : { accepted: true, code: "ok", token: PEER_TOKEN };
      case "send":
        return overrides.sendRefusal === undefined
          ? { accepted: true, code: "ok", conversationId: CONVERSATION_ID, deliveryToken: DELIVERY_TOKEN }
          : { accepted: false, ...overrides.sendRefusal };
      case "delivery_status":
        return { found: true, state: overrides.delivery ?? "delivered", terminal: true,
          updatedAt: NOW, deadlineAt: "2099-01-01T00:00:00.000Z",
          ...(overrides.delivery === undefined || overrides.delivery === "delivered"
            ? {} : { safeErrorCode: "DELIVERY_UNCONFIRMED" }) };
      case "await_peer": {
        // A real broker holds this open for 30 s before answering `timeout`;
        // the fake moves the injected clock the same way so the reply budget
        // is spent by the wall clock, not only by the attempt bound.
        if (overrides.reply === "silent") { advance(30_000); return { state: "timeout" }; }
        const id = /\[embassy check ([0-9a-f]{8})\]/.exec(
          (seen.find((row) => row.method === "send")?.params as { text: string }).text)?.[1] ?? "";
        const result = {
          fromAlias: `codex-reviewer@${HOST}`, toAlias: (request.params as { alias: string }).alias,
          conversationId: CONVERSATION_ID, expectsReply: false,
          text: overrides.reply === "other" ? "unrelated answer" : `check ${id} received`,
        };
        return { state: "message", receipt: PEER_RECEIPT, frame: `${JSON.stringify({ ok: true, command: "await", result })}\n` };
      }
      default:
        return { accepted: true, code: "ok" };
    }
  };
  return { respond, seen };
}

function checkClock(): {
  now: () => number; delay: (ms: number) => Promise<void>; advance: (ms: number) => void;
} {
  let clock = 1_700_000_000_000;
  const advance = (milliseconds: number): void => { clock += milliseconds; };
  return { now: () => clock, delay: async (ms: number) => { advance(ms); }, advance };
}

test("check runs the whole round trip and reports every hop", async () => {
  const { respond, seen } = checkResponder();
  const stdout = capture(true);
  const clock = checkClock();
  const code = await runGatewayCli(["check"], dependencies(stdout, respond, {
    ...clock, env: { NO_COLOR: "1" } }));

  assert.equal(code, gatewayCliExitCodes.ok);
  const output = text(stdout);
  assert.match(output, new RegExp(`^embassy check [0-9a-f]{8} → codex-reviewer@${HOST}\n`));
  assert.match(output, /^ {2}ok {4}register {3}peer-check-[0-9a-f]{8}@this-mac {2}0 ms$/m);
  assert.match(output, /^ {2}ok {4}send {7}accepted, conversation …89abcdef {2}0 ms$/m);
  assert.match(output, /^ {2}ok {4}delivered {2}the peer's transport accepted it/m);
  assert.match(output, new RegExp(`^ {2}ok {4}reply {6}codex-reviewer@${HOST} echoed [0-9a-f]{8}`, "m"));
  assert.match(output, /^ {2}ok {4}cleanup {4}temporary check identity removed$/m);
  assert.match(output, /^check passed$/m);

  // It mints its own principal, sends through the ordinary send path, and
  // takes the temporary registration back down again.
  assert.deepEqual(seen.map((request) => request.method),
    ["list_snapshot", "register_peer", "send", "delivery_status", "await_peer", "peer_receipt", "unregister_peer"]);
  const sent = seen.find((request) => request.method === "send")!.params as {
    fromAlias: string; toAlias: string; peerToken: string; expectsReply: boolean; text: string;
  };
  assert.match(sent.fromAlias, /^peer-check-[0-9a-f]{8}@this-mac$/);
  assert.equal(sent.toAlias, `codex-reviewer@${HOST}`);
  assert.equal(sent.peerToken, PEER_TOKEN);
  assert.equal(sent.expectsReply, true);
  assert.match(sent.text, /^\[embassy check [0-9a-f]{8}\] /);
});

test("check --to names any route and skips discovery of a Codex task", async () => {
  const { respond, seen } = checkResponder();
  const stdout = capture(true);
  const code = await runGatewayCli(["check", "--to", `advisor@${HOST}`],
    dependencies(stdout, respond, { ...checkClock(), env: { NO_COLOR: "1" } }));
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(seen.some((request) => request.method === "list_snapshot"), false);
  assert.equal((seen.find((request) => request.method === "send")!.params as { toAlias: string }).toAlias,
    `advisor@${HOST}`);
});

test("check with nothing registered says what to register and exits non-zero", async () => {
  const { respond } = checkResponder({ routes: [] });
  const stdout = capture(true), stderr = capture();
  const code = await runGatewayCli(["check"], dependencies(stdout, respond, { stderr }));
  assert.equal(code, gatewayCliExitCodes.invalidInput);
  assert.equal((JSON.parse(text(stdout)) as { error: { code: string } }).error.code, "INVALID_ARGUMENTS");
  assert.match(text(stderr), /no Codex task is registered, so there is nothing to check\. Run `embassy register-codex --alias codex-<name>@this-mac` from inside the task, or name any current route with `embassy check --to <alias>`\./);
});

test("each check hop fails with its own code, and the identity is always released", async () => {
  const cases = [
    { name: "register", overrides: { registerRefusal: true },
      expected: gatewayCliExitCodes.failure,
      line: /^ {2}FAIL {2}register {3}the broker refused a temporary check identity \(conflict\)/m },
    { name: "send", overrides: { sendRefusal: { code: "not_found", reason: "CLAUDE_TARGET_CHANGED" } },
      expected: gatewayCliExitCodes.rejected,
      line: /^ {2}FAIL {2}send {7}not_found CLAUDE_TARGET_CHANGED/m },
    { name: "delivered", overrides: { delivery: "unconfirmed" },
      expected: gatewayCliExitCodes.failure,
      line: /^ {2}FAIL {2}delivered {2}unconfirmed DELIVERY_UNCONFIRMED/m },
    { name: "reply", overrides: { reply: "silent" as const },
      expected: gatewayCliExitCodes.failure,
      line: /^ {2}FAIL {2}reply {6}no reply within 60 s — the peer received the message but did not answer/m },
  ];
  for (const current of cases) {
    const clock = checkClock();
    const { respond, seen } = checkResponder(current.overrides as never, clock.advance);
    const stdout = capture(true);
    const code = await runGatewayCli(["check"], dependencies(stdout, respond, {
      now: clock.now, delay: clock.delay }));
    assert.equal(code, current.expected, current.name);
    assert.match(text(stdout), current.line, current.name);
    assert.match(text(stdout), new RegExp(`^check failed at the ${current.name} hop$`, "m"), current.name);
    // Only a registration that was never minted has nothing to release.
    assert.equal(seen.some((request) => request.method === "unregister_peer"),
      current.name !== "register", current.name);
  }
});

test("check answers that do not correlate are consumed and waited past, not reported", async () => {
  // A reply in the check's own conversation counts even when it does not
  // repeat the id; the conversation token is the correlation, the echo is
  // confirmation printed beside it.
  const { respond } = checkResponder({ reply: "other" });
  const stdout = capture(true);
  const code = await runGatewayCli(["check"], dependencies(stdout, respond, {
    ...checkClock(), env: { NO_COLOR: "1" } }));
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.match(text(stdout), /answered without repeating [0-9a-f]{8}/);
});

test("--timeout is bounded and shapes the reply wait", async () => {
  const clock = checkClock();
  const { respond } = checkResponder({ reply: "silent" }, clock.advance);
  const stdout = capture(true);
  const code = await runGatewayCli(["check", "--timeout", "5"], dependencies(stdout, respond, {
    now: clock.now, delay: clock.delay }));
  assert.equal(code, gatewayCliExitCodes.failure);
  assert.match(text(stdout), /no reply within 5 s/);

  for (const value of ["0", "601", "x"]) {
    const out = capture(true);
    let contacted = false;
    const rejected = await runGatewayCli(["check", "--timeout", value], {
      env: {}, stdout: out, stderr: capture(), loadConfig: () => CONFIG,
      loadNodeInventory: async () => TEST_INVENTORY,
      validateControlSocket: async () => { contacted = true; },
      sendRequest: async () => { contacted = true; throw new Error("must not send"); },
    });
    assert.equal(rejected, gatewayCliExitCodes.invalidInput, value);
    assert.equal(contacted, false, value);
  }
});

test("help documents the three observability commands with their options", async () => {
  const stdout = capture();
  await runGatewayCli(["--help"], {
    env: {}, stdout, stderr: capture(),
    loadConfig: () => { throw new Error("help must not load configuration"); },
    sendRequest: async () => { throw new Error("help must not contact the gateway"); },
  });
  assert.match(text(stdout), /^ {2}status \[--json\] \[--recent <n>\]$/m);
  assert.match(text(stdout), /^ {2}watch \[--json\] {9}Tail messages and route activity until Ctrl-C$/m);
  assert.match(text(stdout), /^ {2}check \[--to <alias>\] \[--timeout <s>\]$/m);
});

/**
 * The fakes above answer whatever `check` asks. This one does not: it drives
 * the real control server, so every request `check` builds is decoded by the
 * shipped validators and every result it reads is validated on the way back —
 * including the peer mailbox frame, which has its own closed shape. Unix
 * sockets and a mode-0700 directory are all it needs, so it runs on ubuntu.
 */
test("check and status hold up against the real control server", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "embassy-check-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(path.join(stateDir, "nodes.json"),
    `{"version":1,"host":"${HOST}","nodes":[]}`, { mode: 0o600 });
  const socketPath = path.join(stateDir, "control.sock");

  const sends: ValidatedSendParams[] = [];
  let awaited = 0;
  let peerAlias = "";
  let released = false;
  const handlers: GatewayControlHandlers = {
    health: () => ({ status: "ok", revision: 1 }),
    registerCodex: () => ({ accepted: true, code: "ok" }),
    unregisterCodex: () => ({ accepted: true, code: "ok" }),
    listSnapshot: () => SNAPSHOT,
    observeSnapshot: () => ({ snapshotRevision: 1, snapshot: SNAPSHOT }),
    deliveryStatus: () => ({
      found: true, state: "delivered", terminal: true,
      updatedAt: NOW, deadlineAt: "2099-01-01T00:00:00.000Z",
    }),
    send: (params) => {
      sends.push({ ...params });
      return { accepted: true, code: "ok", conversationId: CONVERSATION_ID, deliveryToken: DELIVERY_TOKEN };
    },
    refreshDiscovery: () => ({ accepted: true, code: "ok", revision: 2 }),
    registerPeer: ({ alias }) => {
      peerAlias = alias;
      return { accepted: true, code: "ok", token: PEER_TOKEN };
    },
    unregisterPeer: () => { released = true; return { accepted: true, code: "ok" }; },
    awaitPeer: ({ alias }) => {
      awaited += 1;
      const id = /\[embassy check ([0-9a-f]{8})\]/.exec(sends[0]?.text ?? "")?.[1] ?? "";
      const result = {
        fromAlias: `codex-reviewer@${HOST}`, toAlias: alias,
        conversationId: CONVERSATION_ID, text: `check ${id} received`, expectsReply: false,
      };
      return { state: "message", receipt: PEER_RECEIPT,
        frame: `${JSON.stringify({ ok: true, command: "await", result })}\n` };
    },
    peerReceipt: () => ({ accepted: true, code: "ok" }),
  };
  const server = await startGatewayControlServer({ stateDir, socketPath, handlers });
  t.after(async () => await server.close());

  const stdout = capture(true);
  const code = await runGatewayCliBase(["check"], {
    env: { EMBASSY_STATE_DIR: stateDir, NO_COLOR: "1" }, stdout, stderr: capture(),
  });
  assert.equal(code, gatewayCliExitCodes.ok, text(stdout));
  assert.match(text(stdout), /^check passed$/m);
  assert.equal(awaited, 1);
  assert.equal(released, true);
  assert.match(peerAlias, /^peer-check-[0-9a-f]{8}@this-mac$/);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.fromAlias, peerAlias);
  assert.equal(sends[0]?.toAlias, `codex-reviewer@${HOST}`);
  assert.equal(sends[0]?.expectsReply, true);
  assert.equal(sends[0]?.peerToken, PEER_TOKEN);

  // And the same server proves the snapshot both views read is the validated one.
  const piped = capture();
  assert.equal(await runGatewayCliBase(["status"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout: piped, stderr: capture(),
  }), gatewayCliExitCodes.ok);
  assert.deepEqual((JSON.parse(text(piped)) as { result: unknown }).result, SNAPSHOT);
});
