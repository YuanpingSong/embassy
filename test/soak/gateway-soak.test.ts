import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  loadGatewayConfig as loadBaseGatewayConfig,
  type GatewayConfig,
} from "../../src/gateway/config.js";
import type { GatewayControlHandlers } from "../../src/gateway/control.js";
import {
  GatewayService,
  type GatewayAdapterCallbacks,
  type GatewayAdapterDispatchInput,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterRouteState,
  type GatewayProviderAdapter,
} from "../../src/gateway/service.js";
import type {
  GatewayPreparedWriteEvidence,
  GatewayProvider,
  LogicalRouteBinding,
} from "../../src/gateway/types.js";

/**
 * Deliverability soak: the v1.2 gate instrument.
 *
 * Property under test — every accepted message reaches EXACTLY ONE of the six
 * explicit terminal outcomes with an allowlisted reason, under randomized
 * busy/idle churn, scripted dispatch faults, clock jumps, and full service
 * restarts. Bodies survive only in the bounded private v4 ledger; every
 * accepted message must remain neither silently lost nor double-settled.
 */

const THREAD_ID = "00000000-0000-7000-8000-000000000901";
const SOAK_BODY = "SOAK_BOUNDED_V3_BODY_5f21";
const ITERATIONS = Number(process.env.SOAK_ITERATIONS ?? "1200");
const RESTART_AT = new Set(
  (process.env.SOAK_RESTARTS ?? "400,800")
    .split(",")
    .map((value) => Number(value)),
);
const TRACE = process.env.SOAK_TRACE === "1";
const SEED = 0xe3ba55e; // "embassy", as close as hex allows

const TERMINAL_OUTCOMES = new Set([
  "delivered",
  "unconfirmed",
  "expired",
  "failed",
  "ambiguous",
  "cancelled",
]);
const SAFE_CODE_ALLOWLIST = new Set([
  undefined,
  "GATEWAY_SHUTDOWN",
  "CONTROLLER_RESTARTED",
  "MESSAGE_EXPIRED",
  "DELIVERY_DEADLINE_EXPIRED",
  "DISPATCH_OUTCOME_AMBIGUOUS",
  "PROVIDER_DISPATCH_DEFERRED",
  "CLAUDE_RECEIPT_UNCONFIRMED",
  "SOAK_FAILED",
  "SOAK_CANCELLED",
  "SOAK_AMBIGUOUS",
  "ROUTE_BUSY",
  "PROVIDER_DISPATCH_FAILED",
  "WRITE_AUTHORIZATION_UNCERTAIN",
  "DELIVERY_UNCONFIRMED",
  "PROVIDER_DELIVERY_CANCELLED",
]);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ManualClock {
  nowMs = Date.parse("2026-08-08T12:00:00.000Z");
  #jobs = new Map<number, { dueAt: number; callback: () => void }>();
  #nextHandle = 1;
  now = (): Date => new Date(this.nowMs);
  setTimeout = (callback: () => void, ms: number): NodeJS.Timeout => {
    const handle = this.#nextHandle++;
    this.#jobs.set(handle, { dueAt: this.nowMs + ms, callback });
    return { handle, unref: () => undefined } as unknown as NodeJS.Timeout;
  };
  clearTimeout = (handle: unknown): void => {
    if (
      typeof handle === "object" &&
      handle !== null &&
      "handle" in handle
    ) {
      this.#jobs.delete((handle as { handle: number }).handle);
    }
  };
  async advanceBy(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let earliest: [number, { dueAt: number; callback: () => void }] | undefined;
      for (const entry of this.#jobs) {
        if (entry[1].dueAt <= target) {
          if (earliest === undefined || entry[1].dueAt < earliest[1].dueAt) {
            earliest = entry;
          }
        }
      }
      if (earliest === undefined) break;
      this.nowMs = Math.max(this.nowMs, earliest[1].dueAt);
      this.#jobs.delete(earliest[0]);
      earliest[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.nowMs = target;
  }
}

type SoakDispatchPlan =
  | GatewayAdapterDispatchResult
  | { state: "throw" }
  | { state: "throw_armed" };

class SoakProvider implements GatewayProviderAdapter {
  readonly identity: Readonly<{ provider: GatewayProvider; hostId: string }>;
  readonly protocol: string;
  readonly protocolVersion = "synthetic-1";
  callbacks: GatewayAdapterCallbacks | undefined;
  state: GatewayAdapterRouteState = "idle";
  dispatchPlans = new Map<string, SoakDispatchPlan[]>();
  dispatches: GatewayAdapterDispatchInput[] = [];
  readonly evidence = new Map<string, {
    attemptIds: Set<string>;
    authorizations: number;
    semanticWrites: number;
    acceptances: number;
  }>();
  observed = new Map<string, LogicalRouteBinding>();
  closed = false;

  constructor(provider: "codex" | "claude") {
    this.identity = {
      provider,
      hostId: "this-mac",
    };
    this.protocol = provider === "codex" ? "codex-app-server" : "claude-peer";
  }

  #trace(name: string): void {
    if (TRACE) console.error(`soak ${this.identity.provider}.${name}`);
  }

  async initialize(callbacks: GatewayAdapterCallbacks): Promise<{
    health: "healthy";
  }> {
    this.#trace("initialize");
    this.callbacks = callbacks;
    return { health: "healthy" };
  }

  async discoverClaudePeers(): Promise<{
    peers: Array<{
      alias: string;
      routeHandle: string;
      kind: "interactive";
      state: GatewayAdapterRouteState;
    }>;
    complete: boolean;
  }> {
    this.#trace("discoverClaudePeers");
    return {
      peers: [
        {
          alias: "claude-one@this-mac",
          routeHandle: "claude_target_1",
          kind: "interactive",
          state: "idle",
        },
      ],
      complete: true,
    };
  }

  async selectRoute(input: { alias: string; routeHandle: string }): Promise<{
    routeHandle: string;
    state: GatewayAdapterRouteState;
  }> {
    this.#trace("selectRoute");
    return { routeHandle: input.routeHandle, state: this.state };
  }

  #advertisedGenerations = new Map<string, string>();

  observeLogicalRoute(input: {
    alias: string;
    routeHandle: string;
    registrationId: string;
  }): void {
    this.observed.set(input.alias, {
      ...this.identity,
      routeHandle: input.routeHandle,
      registrationId: input.registrationId,
    });
  }

  forgetLogicalRoute(registrationId: string): void {
    for (const [alias, binding] of this.observed) {
      if (binding.registrationId === registrationId) this.observed.delete(alias);
    }
  }

  async advertiseNativeSourcePeer(input: { alias: string; sourceProvider: GatewayProvider }): Promise<void> {
    assert.equal(input.sourceProvider, "codex");
    this.#trace("advertiseNativeSourcePeer");
    this.#advertisedGenerations.set(input.alias, "soak_listener_1");
  }

  async unadvertiseNativeSourcePeer(): Promise<void> {
    this.#trace("unadvertiseNativeSourcePeer");
    // Soak never asserts unadvertisement.
  }

  async updateNativeSourcePeerStatus(): Promise<void> {
    this.#trace("updateNativeSourcePeerStatus");
    // Soak never asserts peer status writes.
  }

  assertWorkspaceDisjoint = async (): Promise<void> => {
    this.#trace("assertWorkspaceDisjoint");
  };

  async releaseRoute(): Promise<void> {
    this.#trace("releaseRoute");
    // Soak never asserts release ordering.
  }

  async resolveReplyAddress(address: string): Promise<{ routeHandle: string }> {
    assert.equal(address, "uds:/synthetic/claude.sock");
    return { routeHandle: "claude_target_1" };
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    this.#trace("dispatch");
    this.dispatches.push({ ...input, binding: { ...input.binding } });
    const counter = this.evidence.get(input.text) ?? {
      attemptIds: new Set<string>(),
      authorizations: 0,
      semanticWrites: 0,
      acceptances: 0,
    };
    assert.equal(counter.attemptIds.has(input.attemptId), false, "attempt IDs never replay");
    counter.attemptIds.add(input.attemptId);
    this.evidence.set(input.text, counter);
    const script = this.dispatchPlans.get(input.text) ?? [];
    const plan = script.shift();
    if (script.length === 0) this.dispatchPlans.delete(input.text);
    else this.dispatchPlans.set(input.text, script);
    if (plan?.state === "throw") {
      throw new Error("SOAK_SYNTHETIC_DISPATCH_CRASH");
    }
    if (plan?.state === "deferred") return plan;
    const evidence = prepared(input);
    const authorized = await input.authorizeWrite({ attemptId: input.attemptId, ...evidence });
    assert.equal(authorized, true);
    counter.authorizations += 1;
    counter.semanticWrites += 1;
    if (this.identity.provider === "codex") {
      await input.onAccepted({ attemptId: input.attemptId });
      counter.acceptances += 1;
    }
    if (plan?.state === "throw_armed") {
      throw new Error("SOAK_SYNTHETIC_POST_WRITE_CRASH");
    }
    return plan ?? { state: "delivered" };
  }

  emitRouteState(state: GatewayAdapterRouteState): void {
    this.state = state;
    for (const route of this.observed.values()) {
      this.callbacks?.onRouteState({
        route,
        state,
        observedAt: new Date().toISOString(),
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  plan(body: string, plan: SoakDispatchPlan): void {
    this.dispatchPlans.set(
      body,
      plan.state === "deferred" ? [plan, { state: "delivered" }] : [plan],
    );
  }
}

function prepared(input: GatewayAdapterDispatchInput): GatewayPreparedWriteEvidence {
  const kind = input.binding.provider === "claude"
    ? "claude_mailbox"
    : input.binding.provider === "codex"
      ? input.steer === true
        ? "codex_turn_steer"
        : "codex_turn_start"
      : "acp_prompt";
  const frame = `soak:${input.attemptId}:${input.messageId}:${input.text}`;
  return {
    kind,
    bodyBytes: Buffer.byteLength(input.text),
    bodySha256: createHash("sha256").update(input.text).digest("hex"),
    frameBytes: Buffer.byteLength(frame),
    sha256: createHash("sha256").update(frame).digest("hex"),
  };
}

function soakConfig(stateDir: string): GatewayConfig {
  return {
    ...loadBaseGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_MESSAGE_DEADLINE_MS: "60000",
      EMBASSY_MAX_QUEUE_MESSAGES: "100",
      EMBASSY_MAX_QUEUE_PER_ROUTE: "20",
      EMBASSY_MAX_IN_FLIGHT: "16",
      EMBASSY_RATE_LIMIT: "10000",
    }, { host: "this-mac", nodes: [] }),
    inboundMode: "open",
  };
}

async function registerAndSelect(
  handlers: GatewayControlHandlers,
): Promise<void> {
  const refreshed = await handlers.refreshDiscovery();
  assert.equal(refreshed.accepted, true);
  const registered = await handlers.registerCodex({
    alias: "codex-main@this-mac",
    threadId: THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  });
  assert.deepEqual(registered, { accepted: true, code: "ok" }, "registerCodex");
  const selected = await handlers.selectClaude({
    alias: "claude-one@this-mac",
  });
  assert.deepEqual(selected, { accepted: true, code: "ok" }, "selectClaude");
  const paired = await handlers.pair({
    aliases: ["claude-one@this-mac", "codex-main@this-mac"],
  });
  assert.deepEqual(paired, { accepted: true, code: "ok" }, "pair");
}

test("soak: randomized churn settles every accepted message exactly once", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "soak-")));
  let service: GatewayService | undefined;
  t.after(async () => {
    try {
      await service?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const stateDir = path.join(root, "state");
  const config = soakConfig(stateDir);
  const random = mulberry32(SEED);
  const clock = new ManualClock();

  let claude = new SoakProvider("claude");
  let codex = new SoakProvider("codex");
  const providers = [claude, codex];
  service = new GatewayService({
    config,
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  let handlers = service.handlers();
  await registerAndSelect(handlers);

  type LedgerEntry = {
    token: string;
    body: string;
    provider: "claude" | "codex";
    epoch: number;
    settled?: { state: string; safeErrorCode?: string };
  };
  const ledger: LedgerEntry[] = [];
  let epoch = 0;
  const tallies = {
    sent: 0,
    acceptedRejections: 0,
    restarts: 0,
  };

  const planPool: SoakDispatchPlan[] = [
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
    { state: "deferred", safeErrorCode: "ROUTE_BUSY" },
    { state: "delivered" },
    { state: "failed", safeErrorCode: "SOAK_FAILED" },
    { state: "cancelled", safeErrorCode: "SOAK_CANCELLED" },
    { state: "throw" },
    { state: "throw_armed" },
  ];

  const settleLedger = async (onlyEpoch?: number): Promise<void> => {
    for (const entry of ledger) {
      if (onlyEpoch !== undefined && entry.epoch !== onlyEpoch) continue;
      const status = await handlers.deliveryStatus({ token: entry.token });
      if (entry.settled !== undefined) {
        if (status.found) {
          assert.equal(status.terminal, true, "terminal delivery truth never reopens");
          assert.equal(status.state, entry.settled.state);
          assert.equal(status.safeErrorCode, entry.settled.safeErrorCode);
        }
        continue;
      }
      if (status.found && status.terminal) {
        entry.settled = {
          state: status.state,
          ...(status.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: status.safeErrorCode }),
        };
      }
    }
  };

  for (let i = 1; i <= ITERATIONS; i += 1) {
    if (TRACE) console.error(`soak iter ${i}`);
    if (RESTART_AT.has(i)) {
      // Snapshot current terminals, then prove queued/phase truth survives restart.
      await settleLedger(epoch);
      await service.close();
      claude = new SoakProvider("claude");
      codex = new SoakProvider("codex");
      providers.push(claude, codex);
      service = new GatewayService({
        config,
        adapters: [claude, codex],
        now: clock.now,
        timers: clock,
      });
      await service.start();
      handlers = service.handlers();
      await registerAndSelect(handlers);
      await settleLedger();
      epoch += 1;
      tallies.restarts += 1;
      continue;
    }

    const roll = random();
    if (roll < 0.4) {
      // Claude -> Codex send.
      const body = `${SOAK_BODY}_${i}`;
      codex.plan(body, planPool[Math.floor(random() * planPool.length)]!);
      const accepted = await handlers.send({
        fromAlias: "claude-one@this-mac",
        toAlias: "codex-main@this-mac",
        text: body,
        replyAddress: "uds:/synthetic/claude.sock",
        expectsReply: false,
      });
      if (accepted.accepted) {
        ledger.push({ token: accepted.deliveryToken, body, provider: "codex", epoch });
        tallies.sent += 1;
      } else {
        tallies.acceptedRejections += 1;
      }
    } else if (roll < 0.65) {
      // Codex -> Claude send.
      const body = `${SOAK_BODY}_${i}`;
      claude.plan(body, planPool[Math.floor(random() * planPool.length)]!);
      const accepted = await handlers.send({
        fromAlias: "codex-main@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude-one@this-mac",
        text: body,
        expectsReply: false,
      });
      if (accepted.accepted) {
        ledger.push({ token: accepted.deliveryToken, body, provider: "claude", epoch });
        tallies.sent += 1;
      } else {
        tallies.acceptedRejections += 1;
      }
    } else if (roll < 0.8) {
      codex.emitRouteState(random() < 0.5 ? "busy" : "idle");
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await clock.advanceBy(250 + Math.floor(random() * 4750));
    }
    if (i % 50 === 0) {
      for (let pass = 0; pass < 5; pass += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await settleLedger();
    }
  }

  // Drain in two phases: first give the idle route room to flush its queue
  // in small steps (dispatch loops run on 500ms retries), then push past the
  // deadline so stragglers settle explicitly.
  codex.emitRouteState("idle");
  for (let step = 0; step < 20; step += 1) {
    await clock.advanceBy(2_000);
  }
  await settleLedger();
  await clock.advanceBy(config.limits.messageDeadlineMs + 10_000);
  // Observe terminals from the first deadline window before their bounded
  // status-retention window can elapse during the second clock jump.
  await settleLedger();
  await clock.advanceBy(config.limits.messageDeadlineMs + 10_000);
  await settleLedger();
  for (let pass = 0; pass < 10; pass += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await settleLedger();
  }

  const unsettled = ledger.filter((entry) => entry.settled === undefined);
  for (const entry of unsettled) {
    const status = await handlers.deliveryStatus({ token: entry.token });
    console.error(
      `soak unsettled: token=${entry.token} epoch=${entry.epoch}/${epoch} ` +
        `status=${JSON.stringify(status)}`,
    );
  }
  assert.deepEqual(
    unsettled.map((entry) => entry.token),
    [],
    "every accepted message must reach a terminal state",
  );

  const outcomes = new Map<string, number>();
  for (const entry of ledger) {
    const state = entry.settled!.state;
    outcomes.set(state, (outcomes.get(state) ?? 0) + 1);
    assert.equal(
      TERMINAL_OUTCOMES.has(state),
      true,
      `unexpected outcome ${state}`,
    );
    assert.equal(
      SAFE_CODE_ALLOWLIST.has(entry.settled!.safeErrorCode),
      true,
      `unexpected safe code ${entry.settled!.safeErrorCode} for ${state}`,
    );
  }

  for (const entry of ledger) {
    const generations = providers
      .filter((provider) => provider.identity.provider === entry.provider)
      .map((provider) => provider.evidence.get(entry.body))
      .filter((candidate) => candidate !== undefined);
    if (generations.length === 0) continue;
    const attemptIds = new Set<string>();
    let attemptCount = 0;
    let authorizations = 0;
    let semanticWrites = 0;
    let acceptances = 0;
    for (const evidence of generations) {
      attemptCount += evidence.attemptIds.size;
      for (const attemptId of evidence.attemptIds) attemptIds.add(attemptId);
      authorizations += evidence.authorizations;
      semanticWrites += evidence.semanticWrites;
      acceptances += evidence.acceptances;
    }
    assert.equal(attemptIds.size, attemptCount, `attempt ID reused across restart for ${entry.body}`);
    assert.ok(authorizations <= 1, `authorization replayed for ${entry.body}`);
    assert.ok(semanticWrites <= 1, `semantic write replayed for ${entry.body}`);
    assert.ok(acceptances <= 1, `acceptance replayed for ${entry.body}`);
  }

  // No silent loss: tallies reconcile.
  assert.equal(
    ledger.length,
    tallies.sent,
    "ledger tracks every accepted send",
  );

  // v4 retains bodies only in the bounded private ledger and its bounded
  // public projection. Report their retained presence without assuming that
  // an old terminal row must survive capacity eviction.
  const snapshot = await handlers.listSnapshot();
  const snapshotCarriesBodies = JSON.stringify(snapshot).includes(SOAK_BODY);
  const stateFile = await readFile(
    path.join(stateDir, "gateway-state.json"),
    "utf8",
  );
  const stateCarriesBodies = stateFile.includes(SOAK_BODY);

  // Print the deliverability tally for the human reading the soak log.
  const summary = Object.fromEntries(
    [...outcomes.entries()].sort((a, b) => b[1] - a[1]),
  );
  // eslint-disable-next-line no-console
  console.log(
    `soak summary: sent=${tallies.sent} restarts=${tallies.restarts} ` +
      `enqueueRejections=${tallies.acceptedRejections} outcomes=${JSON.stringify(summary)} ` +
      `bodiesInSnapshot=${snapshotCarriesBodies} bodiesInState=${stateCarriesBodies}`,
  );
});
