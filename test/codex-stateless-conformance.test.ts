import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type CodexAppServerTransport,
} from "../src/gateway/codex-app-server.js";
import {
  createStatelessCodexOperationTransport,
  type StatelessCodexAcceptedOperation,
  type StatelessCodexActiveSteerResult,
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
  reject(request: Frame): void {
    this.emit({ error: { code: -32602 }, id: request.id });
  }
}

type Mode =
  | "success" | "busy" | "approval" | "fast" | "sync-loss" | "async-loss"
  | "close" | "timeout" | "malformed" | "wrong" | "large-reply"
  | "failed" | "interrupted" | "duplicate" | "init-loss" | "resume-loss"
  | "nonempty" | "resume-drift" | "steer-loss" | "wrong-reply"
  | "accepted-timeout" | "accepted-close" | "steer-reject";

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
          const status = mode === "busy"
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
          if (frame.method === "turn/steer") {
            if (mode === "steer-reject") return peer.reject(frame);
            return peer.result(frame, { turnId: TURN });
          }
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
            if (mode === "accepted-timeout" || mode === "steer-reject") return;
            if (mode === "accepted-close") return void setImmediate(() => { void peer.close(); });
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
  text = "synthetic body",
  onAccepted: (accepted: StatelessCodexAcceptedOperation) => Promise<void> = async () => undefined,
) => ({
  attemptId: "attempt-fixture-1", authorizeWrite, deadlineAt: DEADLINE, kind: "start" as const,
  onAccepted,
  route: {
    alias: "codex-fixture@this-mac", hostId: "this-mac",
    registrationId: "registration-fixture-1", threadId: THREAD,
  },
  text,
});

function assertState(result: { phase: string; state: string }, phase: string, state: string): void {
  assert.equal(result.phase, phase);
  assert.equal(result.state, state);
}

function assertCode(result: object, code: string): void {
  assert.equal("safeErrorCode" in result ? result.safeErrorCode : undefined, code);
}

function emitTerminal(wire: ScriptTransport): void {
  wire.emit({ method: "turn/completed", params: {
    threadId: THREAD, turn: { id: TURN, status: "completed" },
  }});
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

test("stateless transport is inert until execute and opens one exact connection per operation", async () => {
  for (const id of ["initialize", "resume-empty-history", "start", "steer"])
    assert.equal(row(id), "HOLD");
  const current = statelessFixture(["success", "fast"]);
  assert.deepEqual(current.counts(), { closeCount: 0, connectCount: 0, factoryCount: 0, semanticWrites: 0 });
  const evidence: StatelessCodexWriteEvidence[] = [];
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
  const sentStart = current.frames[0]?.find(({ method }) => method === "turn/start");
  assert.notEqual(sentStart, undefined);
  const startFrame = JSON.stringify(sentStart);
  assert.deepEqual(evidence[0], {
    attemptId: "attempt-fixture-1",
    bodyBytes: Buffer.byteLength("synthetic body"),
    frameBytes: Buffer.byteLength(startFrame),
    kind: "codex_turn_start",
    sha256: createHash("sha256").update(startFrame).digest("hex"),
  });
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

test("correlated acceptance is reported before terminal and callback loss is unconfirmed", async () => {
  const order: string[] = [];
  const current = statelessFixture(["fast"]);
  let closedHandle: StatelessCodexActiveSteerResult | undefined;
  const result = await current.operation.execute(input(
    async () => true,
    "synthetic body",
    async (accepted) => {
      assert.deepEqual({ attemptId: accepted.attemptId, turnId: accepted.turnId },
        { attemptId: "attempt-fixture-1", turnId: TURN });
      order.push("accepted");
      closedHandle = await accepted.steer({
        attemptId: "fast-terminal-steer", authorizeWrite: async () => true,
        deadlineAt: DEADLINE, text: "synthetic steer",
      });
    },
  ));
  order.push("terminal");
  assert.deepEqual(order, ["accepted", "terminal"]);
  assertState(result, "terminal", "terminal");
  assertState(closedHandle!, "clean", "deferred");
  assert.equal(current.counts().semanticWrites, 1);

  const rejected = statelessFixture(["fast"]);
  const unconfirmed = await rejected.operation.execute(input(
    async () => true,
    "synthetic body",
    async () => { throw new Error("durable acceptance callback failed"); },
  ));
  assertState(unconfirmed, "accepted", "unconfirmed");
  assert.equal("safeErrorCode" in unconfirmed ? unconfirmed.safeErrorCode : undefined,
    "ACCEPTANCE_UNCONFIRMED");
  assert.equal(rejected.counts().semanticWrites, 1);

  const unresolved = statelessFixture(["accepted-timeout"], false, { turnTimeoutMs: 100 });
  let premature: StatelessCodexActiveSteerResult | undefined;
  let prematureAuthorizations = 0;
  let handle: StatelessCodexAcceptedOperation | undefined;
  let callbackDone!: () => void;
  const committed = new Promise<void>((resolve) => { callbackDone = resolve; });
  const pending = unresolved.operation.execute(input(async () => true, "synthetic body", async (accepted) => {
    handle = accepted;
    premature = await accepted.steer({
      attemptId: "premature-steer",
      authorizeWrite: async () => { prematureAuthorizations += 1; return true; },
      deadlineAt: DEADLINE, text: "synthetic steer",
    });
    callbackDone();
  }));
  await committed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertState(premature!, "clean", "deferred");
  assert.equal(prematureAuthorizations, 0);
  const afterCommit = await handle!.steer({
    attemptId: "committed-steer", authorizeWrite: async () => true,
    deadlineAt: DEADLINE, text: "synthetic steer",
  });
  assertState(afterCommit, "terminal", "terminal");
  emitTerminal(unresolved.transports[0]!);
  assertState(await pending, "terminal", "terminal");
  assert.equal(unresolved.frames[0]?.filter(({ method }) => method === "turn/steer").length, 1);
  assert.equal(unresolved.counts().semanticWrites, 2);
});

test("accepted timeout or close is unconfirmed and never replays the start", async () => {
  for (const mode of ["accepted-timeout", "accepted-close"] as const) {
    const current = statelessFixture([mode]);
    let accepted = 0;
    const result = await current.operation.execute(input(
      async () => true,
      "synthetic body",
      async () => { accepted += 1; },
    ));
    assertState(result, "accepted", "unconfirmed");
    assert.equal(accepted, 1);
    assert.equal(current.counts().semanticWrites, 1);
    assert.equal(current.frames[0]?.filter(({ method }) => method === "turn/start").length, 1);
  }
});

test("operation abort maps by phase and never leaks across executions", async () => {
  const isolated = statelessFixture(["success"]);
  const pre = new AbortController();
  pre.abort();
  const preResult = await isolated.operation.execute({
    ...input(async () => { throw new Error("must not authorize"); }), signal: pre.signal,
  });
  assertState(preResult, "clean", "failed");
  assertCode(preResult, "TRANSPORT_CLOSED");
  assert.deepEqual(isolated.counts(), { closeCount: 0, connectCount: 0, factoryCount: 0, semanticWrites: 0 });
  const independent = await isolated.operation.execute(input(async () => true));
  assertState(independent, "terminal", "terminal");
  assert.deepEqual(isolated.counts(), { closeCount: 1, connectCount: 1, factoryCount: 1, semanticWrites: 1 });

  for (const disposition of ["false", "true", "throw"] as const) {
    const controller = new AbortController();
    const current = statelessFixture(["success"]);
    let observed!: () => void;
    let settle!: (value: boolean) => void;
    let reject!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { observed = resolve; });
    const permit = new Promise<boolean>((resolve, fail) => { settle = resolve; reject = fail; });
    const execution = current.operation.execute({
      ...input(() => { observed(); return permit; }), signal: controller.signal,
    });
    await started;
    controller.abort();
    if (disposition === "throw") reject(new Error("authorization uncertain"));
    else settle(disposition === "true");
    const result = await execution;
    assertState(result, disposition === "false" ? "clean" : "armed",
      disposition === "false" ? "failed" : "ambiguous");
    assertCode(result, disposition === "throw" ? "WRITE_AUTHORIZATION_UNCERTAIN" : "TRANSPORT_CLOSED");
    assert.equal(current.counts().semanticWrites, 0);
  }

  const afterSendAbort = new AbortController();
  const afterSend = statelessFixture(["timeout"], false, {}, () => afterSendAbort.abort());
  const armed = await afterSend.operation.execute({
    ...input(async () => true), signal: afterSendAbort.signal,
  });
  assertState(armed, "armed", "ambiguous");
  assertCode(armed, "TRANSPORT_CLOSED");
  assert.equal(afterSend.counts().semanticWrites, 1);

  const afterAcceptanceAbort = new AbortController();
  const afterAcceptance = statelessFixture(["accepted-timeout"], false, { turnTimeoutMs: 100 });
  let committed!: () => void;
  const accepted = new Promise<void>((resolve) => { committed = resolve; });
  const acceptedExecution = afterAcceptance.operation.execute({
    ...input(async () => true, "synthetic body", async () => { committed(); }),
    signal: afterAcceptanceAbort.signal,
  });
  await accepted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  afterAcceptanceAbort.abort();
  const unconfirmed = await acceptedExecution;
  assertState(unconfirmed, "accepted", "unconfirmed");
  assertCode(unconfirmed, "TRANSPORT_CLOSED");

  const afterTerminalAbort = new AbortController();
  const afterTerminal = statelessFixture(["fast"]);
  const terminal = await afterTerminal.operation.execute({
    ...input(async () => true, "synthetic body", async () => { afterTerminalAbort.abort(); }),
    signal: afterTerminalAbort.signal,
  });
  assertState(terminal, "terminal", "terminal");
  assert.equal(afterTerminal.counts().semanticWrites, 1);
});

test("abort closes setup that resolves late without connecting or initializing", async () => {
  const promptly = async <T>(pending: Promise<T>, label: string): Promise<T> =>
    await Promise.race([pending, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`setup race stalled: ${label}`)), 100))]);
  for (const boundary of ["factory", "connect"] as const) {
    const controller = new AbortController();
    const frames: Frame[] = [];
    let authorizations = 0;
    let connectCount = 0;
    let factoryCloseCount = 0;
    let ownedCloseCount = 0;
    let cleanupConfirmed = false;
    let reportFactoryClosed!: () => void;
    let reportOwnedClosed!: () => void;
    const factoryClosed = new Promise<void>((resolve) => { reportFactoryClosed = resolve; });
    const ownedClosed = new Promise<void>((resolve) => { reportOwnedClosed = resolve; });
    let resolveOwned!: (owned: ScriptTransport & { cleanupConfirmed: boolean }) => void;
    const pendingOwned = new Promise<ScriptTransport & { cleanupConfirmed: boolean }>(
      (resolve) => { resolveOwned = resolve; },
    );
    const wire = Object.assign(new ScriptTransport((frame) => { frames.push(frame); }),
      { cleanupConfirmed: false });
    const rawClose = wire.close.bind(wire);
    wire.close = async () => {
      if (!wire.closed) ownedCloseCount += 1;
      await rawClose();
      cleanupConfirmed = true;
      wire.cleanupConfirmed = true;
      reportOwnedClosed();
    };
    const factory = {
      appServerVersion: "0.1.0", endpointGeneration: "endpoint-delayed",
      hostId: "this-mac", protocol: "codex-app-server" as const, protocolVersion: "0.1.0",
      close: async () => { factoryCloseCount += 1; reportFactoryClosed(); },
      connectTransport: async () => { connectCount += 1; return pendingOwned; },
    };
    let resolveFactory!: (value: typeof factory) => void;
    let setupStarted!: () => void;
    const started = new Promise<void>((resolve) => { setupStarted = resolve; });
    const pendingFactory = new Promise<typeof factory>((resolve) => { resolveFactory = resolve; });
    const operation = createStatelessCodexOperationTransport({ now: () => new Date(NOW) }, {
      createFactory: async () => {
        setupStarted();
        return boundary === "factory" ? pendingFactory : factory;
      },
    });
    const execution = operation.execute({
      ...input(async () => { authorizations += 1; return true; }), signal: controller.signal,
    });
    await started;
    if (boundary === "connect") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(connectCount, 1);
    }
    controller.abort();
    const result = await promptly(execution, `${boundary} abort`);
    assertState(result, "clean", "failed");
    assertCode(result, "TRANSPORT_CLOSED");
    assert.equal(result.cleanupConfirmed, false);
    if (boundary === "factory") {
      resolveFactory(factory);
      await promptly(factoryClosed, "late factory close");
    } else {
      resolveOwned(wire);
      await promptly(Promise.all([factoryClosed, ownedClosed]), "late owned close");
    }
    assert.equal(factoryCloseCount, 1);
    assert.equal(connectCount, boundary === "factory" ? 0 : 1);
    assert.equal(ownedCloseCount, boundary === "factory" ? 0 : 1);
    assert.equal(cleanupConfirmed, boundary === "connect");
    assert.equal(authorizations, 0);
    assert.deepEqual(frames, []);
  }
});

test("accepted handle keeps steering on one connector with exact cap and key", async () => {
  const current = statelessFixture(["accepted-timeout"], false, { turnTimeoutMs: 100 });
  const results: StatelessCodexActiveSteerResult[] = [];
  const evidence: StatelessCodexWriteEvidence[] = [];
  let publish!: (accepted: StatelessCodexAcceptedOperation) => void;
  const published = new Promise<StatelessCodexAcceptedOperation>((resolve) => { publish = resolve; });
  const execution = current.operation.execute(input(
    async (value) => { evidence.push(value); return true; },
    "synthetic body",
    async (accepted) => { publish(accepted); },
  ));
  const handle = await published;
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const index of [1, 1, 2, 3, 4]) {
    results.push(await handle.steer({
      attemptId: `steer-attempt-${index}`,
      authorizeWrite: async (value) => { evidence.push(value); return true; },
      deadlineAt: DEADLINE, text: "synthetic steer",
    }));
  }
  emitTerminal(current.transports[0]!);
  const terminal = await execution;
  assertState(terminal, "terminal", "terminal");
  assert.deepEqual(results.map(({ phase, state }) => ({ phase, state })), [
    { phase: "terminal", state: "terminal" },
    { phase: "clean", state: "failed" },
    { phase: "terminal", state: "terminal" },
    { phase: "terminal", state: "terminal" },
    { phase: "clean", state: "deferred" },
  ]);
  assert.deepEqual(current.counts(), { closeCount: 1, connectCount: 1, factoryCount: 1, semanticWrites: 4 });
  assert.deepEqual(evidence.map(({ attemptId, kind }) => ({ attemptId, kind })), [
    { attemptId: "attempt-fixture-1", kind: "codex_turn_start" },
    { attemptId: "steer-attempt-1", kind: "codex_turn_steer" },
    { attemptId: "steer-attempt-2", kind: "codex_turn_steer" },
    { attemptId: "steer-attempt-3", kind: "codex_turn_steer" },
  ]);
  const steerFrames = current.frames[0]?.filter(({ method }) => method === "turn/steer") ?? [];
  assert.equal(steerFrames.length, 3);
  for (const [index, frame] of steerFrames.entries()) {
    assert.deepEqual(normalizeFrames([frame])[0]?.params, manifest.wireGolden.steer.params);
    const frameText = JSON.stringify(frame);
    assert.deepEqual(evidence[index + 1], {
      attemptId: `steer-attempt-${index + 1}`,
      bodyBytes: Buffer.byteLength("synthetic steer"),
      frameBytes: Buffer.byteLength(frameText),
      kind: "codex_turn_steer",
      sha256: createHash("sha256").update(frameText).digest("hex"),
    });
  }
  const late = await handle.steer({
    attemptId: "steer-after-close", authorizeWrite: async () => true,
    deadlineAt: DEADLINE, text: "synthetic steer",
  });
  assertState(late, "clean", "deferred");
  assert.equal(current.counts().semanticWrites, 4);
});

test("same-connector steer RPC rejection is ambiguous and never replayed", async () => {
  const current = statelessFixture(["steer-reject"], false, { turnTimeoutMs: 100 });
  let publish!: (accepted: StatelessCodexAcceptedOperation) => void;
  const published = new Promise<StatelessCodexAcceptedOperation>((resolve) => { publish = resolve; });
  const execution = current.operation.execute(input(async () => true, "synthetic body",
    async (accepted) => { publish(accepted); }));
  const accepted = await published;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const steerResult = await accepted.steer({
    attemptId: "steer-rejected", authorizeWrite: async () => true,
    deadlineAt: DEADLINE, text: "synthetic steer",
  });
  emitTerminal(current.transports[0]!);
  const main = await execution;
  assertState(main, "terminal", "terminal");
  assertState(steerResult!, "armed", "ambiguous");
  assert.equal(current.counts().semanticWrites, 2);
  assert.equal(current.frames[0]?.filter(({ method }) => method === "turn/steer").length, 1);
});

test("paused steer authorization is fenced by terminal, approval, status, close, or protocol drift", async () => {
  const disruptions: Array<(wire: ScriptTransport) => void> = [
    (wire) => wire.emit({ method: "turn/completed", params: {
      threadId: THREAD, turn: { id: TURN, status: "completed" },
    }}),
    (wire) => wire.emit({ id: "approval-steer", method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: TURN } }),
    (wire) => wire.emit({ method: "thread/status/changed", params: {
      threadId: THREAD, status: { activeFlags: ["waitingOnApproval"], type: "active" },
    }}),
    (wire) => { void wire.close(); },
    (wire) => wire.emit({ method: "turn/completed", params: { threadId: THREAD, turn: null } }),
  ];
  for (const disrupt of disruptions) {
    const current = statelessFixture(["accepted-timeout"], false, { turnTimeoutMs: 100 });
    let publish!: (accepted: StatelessCodexAcceptedOperation) => void;
    const published = new Promise<StatelessCodexAcceptedOperation>((resolve) => { publish = resolve; });
    const main = current.operation.execute(input(async () => true, "synthetic body",
      async (accepted) => { publish(accepted); }));
    const accepted = await published;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let release!: (value: boolean) => void;
    const permit = new Promise<boolean>((resolve) => { release = resolve; });
    const pending = accepted.steer({
      attemptId: "paused-steer", authorizeWrite: () => permit,
      deadlineAt: DEADLINE, text: "synthetic steer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    disrupt(current.transports[0]!);
    release(true);
    const side = await pending;
    const result = await main;
    assertState(side, "armed", "ambiguous");
    assert.equal(current.frames[0]?.filter(({ method }) => method === "turn/steer").length, 0);
    assert.equal(current.counts().semanticWrites, 1);
    assert.ok(result.phase === "terminal" || result.phase === "accepted");
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

test("every post-arm start loss is ambiguous exactly once", async () => {
  for (const mode of [
    "sync-loss", "async-loss", "close", "timeout", "malformed", "wrong",
  ] as const) {
    const current = statelessFixture([mode]);
    const result = await current.operation.execute(input(async () => true));
    assertState(result, "armed", "ambiguous");
    assert.equal(current.counts().semanticWrites, 1, mode);
    assert.equal(current.frames[0]?.filter(({ method }) =>
      method === "turn/start").length, 1);
    assertGolden(
      mode === "wrong" ? "wrong-correlation" : "armed-start-loss",
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
    }, text));
    assert.equal(result.phase, "clean");
    assert.equal(authorizations, 0);
    assert.equal(current.counts().semanticWrites, 0);
    assertGolden("bounds", result, 0);
  }
});
