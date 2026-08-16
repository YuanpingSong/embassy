import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CodexAppServerConnector,
  type CodexAppServerTransport,
} from "../src/gateway/codex-app-server.js";
import {
  createStatelessCodexOperationTransport,
  type StatelessCodexOperationResult,
  type StatelessCodexWriteEvidence,
} from "../src/gateway/codex-stateless-transport.js";

const THREAD = "thread-fixture-1";
const TURN = "turn-fixture-1";
const DEADLINE = "2040-01-01T00:01:00.000Z";
const OPT_OUTS = [
  "item/started",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "turn/diff/updated",
  "turn/plan/updated",
];
const NOW = "2040-01-01T00:00:00.000Z";
type Frame = Record<string, unknown>;
type Classification = "HOLD" | "INTENTIONAL_CHANGE" | "DELETE";

class ScriptTransport implements CodexAppServerTransport {
  readonly sent: Frame[] = [];
  readonly messageListeners = new Set<(payload: string) => void>();
  readonly closeListeners = new Set<() => void>();
  readonly errorListeners = new Set<() => void>();
  closed = false;

  constructor(readonly script: (frame: Frame, peer: ScriptTransport) => void | Promise<void>) {}
  onMessage(listener: (payload: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  async send(payload: string): Promise<void> {
    const frame = JSON.parse(payload) as Frame;
    this.sent.push(frame);
    await this.script(frame, this);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
  emit(frame: unknown): void {
    const payload = JSON.stringify(frame);
    for (const listener of this.messageListeners) listener(payload);
  }
  result(request: Frame, result: unknown): void {
    this.emit({ id: request.id, result });
  }
}

type Mode =
  | "success" | "busy" | "approval" | "fast" | "sync-loss" | "async-loss"
  | "close" | "timeout" | "malformed" | "wrong" | "large-reply" | "steer"
  | "failed" | "interrupted" | "duplicate" | "init-loss" | "resume-loss"
  | "nonempty" | "resume-drift" | "steer-loss" | "wrong-reply";

function statelessFixture(
  modes: Mode[],
  cleanupFails = false,
  limits: Record<string, unknown> = {},
  onSemanticSend?: () => void,
) {
  let factoryCount = 0;
  let connectCount = 0;
  let closeCount = 0;
  let semanticWrites = 0;
  const frames: Frame[][] = [];
  const transports: ScriptTransport[] = [];
  const createFactory = async () => {
      factoryCount += 1;
      const mode = modes.shift() ?? "success";
      const operationFrames: Frame[] = [];
      frames.push(operationFrames);
      const wire = new ScriptTransport((frame, peer) => {
        operationFrames.push(frame);
        if (frame.method === "initialize") {
          if (mode === "init-loss") return Promise.reject(new Error("initialize loss"));
          peer.result(frame, {});
        }
        else if (frame.method === "thread/resume") {
          if (mode === "resume-loss") return Promise.reject(new Error("resume loss"));
          const status = mode === "busy" || mode === "steer" || mode === "steer-loss"
            ? { type: "active" }
            : mode === "approval"
              ? { activeFlags: ["waitingOnApproval"], type: "active" }
              : { type: "idle" };
          peer.result(frame, { thread: {
            id: THREAD, status, turns: mode === "nonempty" ? [{ redacted: true }] : [],
          } });
          if (mode === "resume-drift") peer.emit({ method: "thread/status/changed",
            params: { threadId: THREAD, status: { type: "active" } } });
          if (mode === "approval") peer.emit({
            id: "approval-1", method: "item/commandExecution/requestApproval",
            params: { threadId: THREAD, turnId: TURN },
          });
        } else if (frame.method === "turn/start" || frame.method === "turn/steer") {
          semanticWrites += 1;
          onSemanticSend?.();
          if (mode === "async-loss" || mode === "steer-loss")
            return Promise.reject(new Error("synthetic async loss"));
          if (mode === "close") return peer.close();
          if (mode === "timeout") return;
          if (mode === "malformed") return peer.result(frame, { turn: null });
          if (frame.method === "turn/steer") return peer.result(frame, { turnId: TURN });
          const start = { turn: { id: TURN, status: "inProgress" } };
          if (mode === "wrong") return peer.emit({ id: 999_999, result: start });
          const complete = () => {
            peer.emit({ method: "item/completed", params: {
              item: { phase: "final_answer", text: mode === "large-reply" ? "oversized" : "ok", type: "agentMessage" },
              threadId: THREAD, turnId: mode === "wrong-reply" ? "turn-other" : TURN,
            }});
            peer.emit({ method: "turn/completed", params: {
              threadId: THREAD, turn: {
                id: TURN,
                status: mode === "failed" || mode === "interrupted" ? mode : "completed",
              },
            }});
            if (mode === "duplicate") peer.emit({ method: "turn/completed", params: {
              threadId: THREAD, turn: { id: TURN, status: "failed" },
            }});
          };
          if (mode === "fast") {
            peer.emit({ method: "turn/started", params: { threadId: THREAD, turn: start.turn } });
            complete();
            peer.result(frame, start);
          } else {
            peer.result(frame, start);
            setImmediate(() => {
              peer.emit({ method: "turn/started", params: { threadId: THREAD, turn: start.turn } });
              complete();
            });
          }
        }
      });
      const close = wire.close.bind(wire);
      const owned = Object.assign(wire, { cleanupConfirmed: false });
      transports.push(owned);
      owned.close = async () => {
        if (!owned.closed) closeCount += 1;
        await close();
        owned.cleanupConfirmed = !cleanupFails;
      };
      if (mode === "sync-loss") {
        const send = owned.send.bind(owned);
        owned.send = (payload: string) => {
          const frame = JSON.parse(payload) as Frame;
          if (frame.method !== "turn/start" && frame.method !== "turn/steer") return send(payload);
          owned.sent.push(frame);
          operationFrames.push(frame);
          semanticWrites += 1;
          onSemanticSend?.();
          throw new Error("synthetic sync loss");
        };
      }
      return {
        appServerVersion: "0.1.0", endpointGeneration: `endpoint-${factoryCount}`,
        hostId: "this-mac", protocol: "codex-app-server" as const, protocolVersion: "0.1.0",
        close: async () => undefined,
        connectTransport: async () => { connectCount += 1; return owned; },
      };
  };
  return {
    counts: () => ({ closeCount, connectCount, factoryCount, semanticWrites }),
    frames,
    transports,
    operation: createStatelessCodexOperationTransport({
      maxReplyBytes: 4,
      now: () => new Date(NOW),
      requestTimeoutMs: 10,
      turnTimeoutMs: 10,
      ...limits,
    }, { createFactory }),
  };
}

const input = (
  authorizeWrite: (evidence: StatelessCodexWriteEvidence) => Promise<boolean>,
  kind: "start" | "steer" = "start",
  text = "synthetic body",
) => ({
  attemptId: "attempt-fixture-1", authorizeWrite, deadlineAt: DEADLINE,
  ...(kind === "steer" ? { expectedTurnId: TURN, kind } as const : { kind } as const),
  route: { alias: "codex-fixture@this-mac", hostId: "this-mac", threadId: THREAD },
  text,
});

function assertState(result: StatelessCodexOperationResult, phase: string, state: string): void {
  assert.equal(result.phase, phase);
  assert.equal(result.state, state);
}

function normalizeFrames(frames: Frame[]): Frame[] {
  const requests = new Map<number, string>();
  let next = 1;
  return JSON.parse(JSON.stringify(frames), (key, value: unknown) => {
    if (key === "id" && typeof value === "number") {
      if (!requests.has(value)) requests.set(value, `$rpc${next++}`);
      return requests.get(value);
    }
    if (value === THREAD) return "$thread1";
    if (value === TURN) return "$turn1";
    if (value === "synthetic body" || value === "synthetic steer") return "$body1";
    return value;
  }) as Frame[];
}

const manifest = JSON.parse(
  readFileSync(new URL("./fixtures/v18/codex-contract.json", import.meta.url), "utf8"),
) as {
  schemaVersion: number;
  normalization: Record<string, string>;
  contract: Array<{ classification: Classification; id: string; reason: string; scope?: "broker" }>;
  golden: Array<{
    classification: Classification; covers: string[]; id: string;
    expect: { cleanupConfirmed?: boolean; outcome: string; replyCode?: string; semanticWrites: number };
  }>;
  wireGolden: { initialize: Frame[]; resume: Frame; start: Frame; steer: Frame };
};
const row = (id: string): Classification => {
  const found = manifest.contract.find((candidate) => candidate.id === id);
  assert.notEqual(found, undefined, `unclassified contract row: ${id}`);
  return found!.classification;
};
const golden = (id: string) => {
  const found = manifest.golden.find((candidate) => candidate.id === id);
  assert.notEqual(found, undefined, `missing golden: ${id}`);
  return found!;
};
function assertGolden(id: string, result: StatelessCodexOperationResult, semanticWrites: number): void {
  const expected = golden(id).expect;
  const outcome = result.phase === "terminal" ? `terminal-${result.outcome}` : `${result.phase}-${result.state}`;
  assert.equal(outcome, expected.outcome.replace("-at-plus-one", ""), id);
  assert.equal(semanticWrites, expected.semanticWrites, id);
  if (expected.replyCode !== undefined)
    assert.equal("replyCode" in result ? result.replyCode : undefined, expected.replyCode, id);
  if (expected.cleanupConfirmed !== undefined)
    assert.equal(result.cleanupConfirmed, expected.cleanupConfirmed, id);
}

test("v1.8 Codex contract has one complete preclassified normalization ledger", () => {
  const expected = {
    HOLD: ["initialize", "resume-empty-history", "busy-approval", "start", "steer", "bounds",
      "consent-identity", "provenance", "queue-deadline-dedupe", "exact-correlation",
      "fast-terminal", "first-terminal-wins", "no-replay-after-uncertainty",
      "reply-bound-redaction", "cleanup-terminal-truth"],
    INTENTIONAL_CHANGE: ["record-only-registration", "connection-per-operation",
      "registration-no-reachability", "desktop-independent-authority",
      "provider-unavailable-retains-route", "connector-health-observation-only"],
    DELETE: ["loaded-list-admission", "endpoint-generation-authority", "refresh-reanchor-activation",
      "connector-queue-recovery", "unsubscribe-interrupt-cleanup", "stale-route-lifecycle",
      "setup-observation-rejection", "succession-journals", "reconnect-required-choreography",
      "remove-stale-registration"],
  } satisfies Record<Classification, string[]>;
  for (const [classification, ids] of Object.entries(expected))
    assert.deepEqual(manifest.contract.filter((item) => item.classification === classification).map(({ id }) => id), ids);
  assert.equal(new Set(manifest.golden.map(({ id }) => id)).size, manifest.golden.length);
  assert.ok(manifest.golden.every(({ classification, covers, expect }) =>
    classification === "HOLD" && expect.semanticWrites >= 0 &&
    covers.every((id) => row(id) === classification)));
  const brokerHolds = manifest.contract.filter(({ scope }) => scope === "broker").map(({ id }) => id);
  assert.deepEqual(brokerHolds, ["provenance", "queue-deadline-dedupe"]);
  assert.deepEqual(new Set(manifest.golden.flatMap(({ covers }) => covers)),
    new Set(expected.HOLD.filter((id) => !brokerHolds.includes(id))));
  assert.match(manifest.normalization.identity ?? "", /equal inputs keep one token/);
  assert.match(manifest.normalization.writes ?? "", /clean=0.*armed uncertainty=1/);
});

test("legacy connector freezes applicable HOLD initialize resume start and steer frames", async () => {
  for (const id of ["initialize", "resume-empty-history", "start", "steer"])
    assert.equal(row(id), "HOLD");
  const transport = new ScriptTransport((frame, peer) => {
    if (frame.method === "initialize") peer.result(frame, {});
    else if (frame.method === "thread/loaded/list") peer.result(frame, { data: [THREAD] });
    else if (frame.method === "thread/resume")
      peer.result(frame, { thread: { id: THREAD, status: { type: "idle" }, turns: [] } });
    else if (frame.method === "turn/start")
      peer.result(frame, { turn: { id: TURN, status: "inProgress" } });
    else if (frame.method === "turn/steer") peer.result(frame, { turnId: TURN });
  });
  const connector = await CodexAppServerConnector.connect({
    compatibility: { endpointGeneration: "endpoint-fixture-1" },
    now: () => new Date("2040-01-01T00:00:00.000Z"),
    route: { endpointGeneration: "endpoint-fixture-1", threadId: THREAD },
    transport,
  });
  assert.deepEqual(normalizeFrames(transport.sent.slice(0, 2)), manifest.wireGolden.initialize);
  await connector.observeLoadedThread(connector.guard());
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: DEADLINE,
    messageId: "message-fixture-1",
    text: "synthetic body",
  });
  const resumes = transport.sent.filter(({ method }) => method === "thread/resume");
  assert.ok(resumes.length > 0);
  for (const resume of resumes)
    assert.deepEqual(normalizeFrames([resume])[0]?.params, manifest.wireGolden.resume.params);
  assert.deepEqual(normalizeFrames([transport.sent.find(({ method }) => method === "turn/start")!])[0]?.params,
    manifest.wireGolden.start.params);
  const steered = await connector.submitMessage(connector.guard(), {
    deadlineAt: DEADLINE,
    messageId: "message-fixture-2",
    steer: true,
    text: "synthetic steer",
  });
  assert.equal(steered.disposition, "steered");
  assert.deepEqual(normalizeFrames([transport.sent.find(({ method }) => method === "turn/steer")!])[0]?.params,
    manifest.wireGolden.steer.params);
  await connector.close();
});

test("stateless transport is inert until execute and opens one exact connection per operation", async () => {
  const current = statelessFixture(["success", "fast"]);
  assert.deepEqual(current.counts(), { closeCount: 0, connectCount: 0, factoryCount: 0, semanticWrites: 0 });
  const evidence: unknown[] = [];
  for (let index = 0; index < 2; index += 1) {
    const result = await current.operation.execute(input(async (value) => {
      evidence.push(value);
      return true;
    }));
    assertState(result, "terminal", "terminal");
    if (index === 0) assertGolden("idle-start", result, 1);
    if (index === 1) assertGolden("fast-terminal", result, 1);
  }
  assert.deepEqual(current.counts(), { closeCount: 2, connectCount: 2, factoryCount: 2, semanticWrites: 2 });
  assert.equal(evidence.length, 2);
  assert.equal(JSON.stringify(evidence).includes(THREAD), false);
  assert.equal(JSON.stringify(evidence).includes("synthetic body"), false);
  for (const frames of current.frames) {
    assert.deepEqual(frames[0], {
      id: 1, method: "initialize", params: {
        capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUTS },
        clientInfo: { name: "agent_embassy_gateway", title: "Embassy Gateway", version: "1.7.0" },
      },
    });
    assert.deepEqual(frames[1], { method: "initialized", params: {} });
    assert.deepEqual(frames.find(({ method }) => method === "thread/resume")?.params,
      { excludeTurns: true, threadId: THREAD });
    assert.deepEqual(frames.find(({ method }) => method === "turn/start")?.params,
      { input: [{ text: "synthetic body", type: "text" }], threadId: THREAD });
    const normalized = normalizeFrames(frames);
    assert.deepEqual(normalized.slice(0, 2), manifest.wireGolden.initialize);
    assert.deepEqual(normalized.find(({ method }) => method === "thread/resume"), manifest.wireGolden.resume);
    assert.deepEqual(normalized.find(({ method }) => method === "turn/start"), manifest.wireGolden.start);
    assert.equal(frames.some(({ method }) => ["thread/loaded/list", "thread/unsubscribe", "turn/interrupt"].includes(String(method))), false);
  }
});

test("busy and approval observations are clean pre-write and never answer approval", async () => {
  for (const mode of ["busy", "approval", "resume-drift"] as const) {
    const current = statelessFixture([mode]);
    let authorizationCalls = 0;
    const result = await current.operation.execute(input(async () => {
      authorizationCalls += 1;
      return true;
    }));
    assertState(result, "clean", "deferred");
    assert.equal(authorizationCalls, 0);
    assert.equal(current.counts().semanticWrites, 0);
    assert.equal(current.frames[0]?.some(({ method }) => method === "turn/start"), false);
    assert.equal(current.frames[0]?.some(({ id }) => id === "approval-1"), false);
    assertGolden(mode === "resume-drift" ? "busy" : mode, result,
      current.counts().semanticWrites);
  }
});

test("history setup loss and expiry remain clean with zero authorization or body send", async () => {
  for (const mode of ["init-loss", "resume-loss", "nonempty"] as const) {
    const current = statelessFixture([mode]);
    let authorizations = 0;
    const result = await current.operation.execute(input(async () => {
      authorizations += 1;
      return true;
    }));
    assert.equal(result.phase, "clean");
    assert.equal(authorizations, 0);
    assert.equal(current.counts().semanticWrites, 0);
    assertGolden(mode === "nonempty" ? "nonempty-history" : "prewrite-loss", result, 0);
  }
  const expired = statelessFixture(["success"]);
  let authorizations = 0;
  const result = await expired.operation.execute({
    ...input(async () => { authorizations += 1; return true; }), deadlineAt: NOW,
  });
  assert.equal(result.phase, "clean");
  assert.equal(authorizations, 0);
  assert.equal(expired.counts().semanticWrites, 0);
});

test("authorization denial and uncertainty send nothing while allow invokes send synchronously once", async () => {
  const denied = statelessFixture(["success"]);
  const deniedResult = await denied.operation.execute(input(async () => false));
  assert.equal(deniedResult.phase, "clean");
  assert.equal(denied.counts().semanticWrites, 0);

  const uncertain = statelessFixture(["success"]);
  const uncertainResult = await uncertain.operation.execute(input(async () => { throw new Error("uncertain"); }));
  assertState(uncertainResult, "armed", "ambiguous");
  assert.equal(uncertain.counts().semanticWrites, 0);

  let fenced = false;
  let releaseAuthorization!: (allowed: boolean) => void;
  let observedAuthorization!: () => void;
  const permit = new Promise<boolean>((resolve) => { releaseAuthorization = resolve; });
  const observed = new Promise<void>((resolve) => { observedAuthorization = resolve; });
  const allowed = statelessFixture(["success"], false, {}, () => assert.equal(fenced, false));
  const execution = allowed.operation.execute(input(() => {
    observedAuthorization();
    return permit;
  }));
  await observed;
  releaseAuthorization(true);
  queueMicrotask(() => { fenced = true; });
  const allowedResult = await execution;
  assertState(allowedResult, "terminal", "terminal");
  assert.equal(allowed.counts().semanticWrites, 1);

  const raced = statelessFixture(["success"]);
  const racedResult = await raced.operation.execute(input(async () => {
    await raced.transports[0]?.close();
    return true;
  }));
  assertState(racedResult, "armed", "ambiguous");
  assert.equal(raced.counts().semanticWrites, 0);
  assertGolden("authorization-race", racedResult, 0);
});

test("a reserved authorization is fenced by later busy approval or protocol evidence", async () => {
  const evidence = [
    { method: "thread/status/changed", params: { threadId: THREAD, status: { type: "active" } } },
    { id: "approval-race", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: TURN } },
    { id: 999_999, result: {} },
  ];
  for (const event of evidence) {
    const current = statelessFixture(["success"]);
    let release!: (value: boolean) => void;
    let observed!: () => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { observed = resolve; });
    const execution = current.operation.execute(input(() => { observed(); return pending; }));
    await started;
    current.transports[0]?.emit(event);
    release(true);
    const result = await execution;
    assertGolden("authorization-race", result, current.counts().semanticWrites);
  }
});

test("every post-arm loss is ambiguous exactly once for start and steer", async () => {
  for (const [mode, kind] of [
    ["sync-loss", "start"], ["async-loss", "start"], ["close", "start"],
    ["timeout", "start"], ["malformed", "start"], ["wrong", "start"],
    ["steer-loss", "steer"],
  ] as const) {
    const current = statelessFixture([mode]);
    const result = await current.operation.execute(input(async () => true, kind));
    assertState(result, "armed", "ambiguous");
    assert.equal(current.counts().semanticWrites, 1, `${mode}/${kind}`);
    assert.equal(current.frames[0]?.filter(({ method }) =>
      method === (kind === "start" ? "turn/start" : "turn/steer")).length, 1);
    assertGolden(
      mode === "wrong" ? "wrong-correlation" : kind === "steer" ? "armed-steer-loss" : "armed-start-loss",
      result,
      1,
    );
  }
});

test("exact start terminals, steer, reply bound, and cleanup preserve first truth", async () => {
  for (const mode of ["success", "failed", "interrupted"] as const) {
    const current = statelessFixture([mode]);
    const result = await current.operation.execute(input(async () => true));
    assertState(result, "terminal", "terminal");
    assert.equal("outcome" in result ? result.outcome : undefined,
      mode === "success" ? "completed" : mode);
    if (mode === "success") {
      assert.equal("replyText" in result ? result.replyText : undefined, "ok");
      assert.equal("replyCode" in result ? result.replyCode : undefined, null);
    }
  }
  const steer = statelessFixture(["steer"]);
  const steered = await steer.operation.execute(input(async () => true, "steer"));
  assertState(steered, "terminal", "terminal");
  assert.deepEqual(steer.frames[0]?.find(({ method }) => method === "turn/steer")?.params, {
    expectedTurnId: TURN,
    input: [{ text: "synthetic body", type: "text" }],
    threadId: THREAD,
  });
  assert.deepEqual(
    normalizeFrames(steer.frames[0] ?? []).find(({ method }) => method === "turn/steer"),
    manifest.wireGolden.steer,
  );

  const bounded = statelessFixture(["large-reply"]);
  const oversized = await bounded.operation.execute(input(async () => true));
  assertState(oversized, "terminal", "terminal");
  assert.equal("replyText" in oversized ? oversized.replyText : undefined, null);
  assert.equal("replyCode" in oversized ? oversized.replyCode : undefined, "REPLY_TOO_LARGE");
  assertGolden("reply-bound", oversized, 1);

  const correlated = statelessFixture(["wrong-reply"]);
  const ignored = await correlated.operation.execute(input(async () => true));
  assertState(ignored, "terminal", "terminal");
  assert.equal("replyText" in ignored ? ignored.replyText : undefined, null);
  assert.equal("replyCode" in ignored ? ignored.replyCode : undefined, "REPLY_UNAVAILABLE");

  const cleanup = statelessFixture(["duplicate"], true);
  const terminal = await cleanup.operation.execute(input(async () => true));
  assertState(terminal, "terminal", "terminal");
  assert.equal("outcome" in terminal ? terminal.outcome : undefined, "completed");
  assert.equal(terminal.cleanupConfirmed, false);
  assertGolden("duplicate-terminal-cleanup", terminal, 1);
});

test("input and serialized frame bounds fail before authorization", async () => {
  for (const [limits, text] of [
    [{ maxInputBytes: 4 }, "abcde"],
    [{ maxFrameBytes: 128, maxInputBytes: 1_000 }, "x".repeat(256)],
  ] as const) {
    const current = statelessFixture(["success"], false, limits);
    let authorizations = 0;
    const result = await current.operation.execute(input(async () => {
      authorizations += 1;
      return true;
    }, "start", text));
    assert.equal(result.phase, "clean");
    assert.equal(authorizations, 0);
    assert.equal(current.counts().semanticWrites, 0);
    assertGolden("bounds", result, 0);
  }
});
