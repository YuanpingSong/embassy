import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../src/errors.js";
import type { GatewayConfig } from "../src/gateway/config.js";
import { spawnPeerClient, type PeerClient, type PeerSpawn } from "../src/gateway/peer-client.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { decodePeerResult, peerRouteRef, type PeerCatalogResult, type PeerHandoffParams } from "../src/gateway/peer-protocol.js";
import { LocalPeerMailboxProvider } from "../src/gateway/peer-mailbox.js";
import {
  GatewayService,
  type GatewayAdapterCallbacks,
  type GatewayAdapterDiscoverySnapshot,
  type GatewayAdapterDispatchInput,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterStart,
  type GatewayProviderAdapter,
  type GatewayServiceOptions,
} from "../src/gateway/service.js";
import { GatewayStore } from "../src/gateway/store.js";
import { CONNECTOR_OBSERVATION_STALE_AFTER_MS } from "../src/gateway/types.js";
import type {
  GatewayPreparedWriteEvidence,
  GatewayProvider,
  LogicalRouteBinding,
  RegisterRouteInput,
} from "../src/gateway/types.js";

const THREAD_A = "00000000-0000-7000-8000-000000000701";
const THREAD_B = "00000000-0000-7000-8000-000000000702";
const THREAD_C = "00000000-0000-7000-8000-000000000703";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message = "condition did not become true",
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

class TestClock {
  private value = Date.parse("2026-08-16T12:00:00.000Z");
  private sequence = 0;

  now = (): Date => new Date(this.value);

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  randomId = (): string =>
    `00000000-0000-4000-8000-${(++this.sequence).toString(16).padStart(12, "0")}`;
}

type TimerRow = {
  id: ReturnType<typeof setTimeout>;
  at: number;
  callback: () => void;
  cancelled: boolean;
};

class TestTimers {
  private sequence = 0;
  readonly rows: TimerRow[] = [];

  constructor(private readonly clock: TestClock) {}

  setTimeout = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const id = (++this.sequence) as unknown as ReturnType<typeof setTimeout>;
    this.rows.push({
      id,
      at: this.clock.now().getTime() + Math.max(0, delayMs),
      callback,
      cancelled: false,
    });
    return id;
  };

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row !== undefined) row.cancelled = true;
  };

  async runDue(): Promise<void> {
    for (;;) {
      const row = this.rows
        .filter((candidate) => !candidate.cancelled && candidate.at <= this.clock.now().getTime())
        .sort((left, right) => left.at - right.at)[0];
      if (row === undefined) return;
      row.cancelled = true;
      row.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

type DispatchMode =
  | "deliver"
  | "defer_once"
  | "fail"
  | "fast_reply"
  | "pause_armed"
  | "pause_accepted"
  | "never";

class FakeProvider implements GatewayProviderAdapter {
  readonly protocol: string;
  readonly protocolVersion = "test-1";
  readonly dispatches: GatewayAdapterDispatchInput[] = [];
  readonly observed: Array<{ alias: string; routeHandle: string; registrationId: string }> = [];
  readonly forgotten: string[] = [];
  readonly advertised: string[] = [];
  readonly unadvertised: string[] = [];
  readonly effects: string[] = [];
  readonly pauseEntered = deferred<void>();
  readonly pauseRelease = deferred<void>();
  callbacks: GatewayAdapterCallbacks | undefined;
  closeCalls = 0;
  discoverCalls = 0;
  writes = 0;
  terminalReplyText: string | undefined;
  replyRouteHandle = "claude-session-a";
  claudeDiscovery = { alias: "advisor@this-mac", routeHandle: "claude-session-a",
    kind: "interactive" as "interactive" | "bg", state: "idle" as const };
  deferredCode = "ROUTE_BUSY";
  deferAlways = false;
  private deferredOnce = false;
  private steerWrites = 0;
  private readonly dispatchWaiters = new Map<number, Deferred<void>>();

  constructor(
    readonly identity: Readonly<{ provider: GatewayProvider; hostId: string }>,
    readonly mode: DispatchMode = "deliver",
    private readonly ownedRoute?: GatewayAdapterStart["ownedRoute"],
  ) {
    this.protocol = `${identity.provider}-fake`;
  }

  async initialize(callbacks: GatewayAdapterCallbacks): Promise<GatewayAdapterStart> {
    this.callbacks = callbacks;
    return {
      health: "healthy",
      ...(this.ownedRoute === undefined ? {} : { ownedRoute: this.ownedRoute }),
    };
  }

  observeLogicalRoute(input: { alias: string; routeHandle: string; registrationId: string }): void {
    this.observed.push({ ...input });
  }

  forgetLogicalRoute(registrationId: string): void {
    this.forgotten.push(registrationId);
  }

  async discoverClaudePeers(): Promise<GatewayAdapterDiscoverySnapshot> {
    this.discoverCalls += 1;
    return {
      complete: true,
      peers: this.identity.provider === "claude"
        ? [this.claudeDiscovery]
        : [],
      registry: { entriesScanned: 1, parseableRecords: 1, rejected: [] },
    };
  }

  async selectRoute(input: { alias: string; routeHandle: string }) {
    return { ...input, state: "idle" as const };
  }

  workspaceGuard: (() => Promise<void>) | undefined;

  async assertWorkspaceDisjoint(): Promise<void> {
    await this.workspaceGuard?.();
  }

  async resolveReplyAddress(): Promise<{ routeHandle: string }> {
    return { routeHandle: this.replyRouteHandle };
  }

  async advertiseNativeSourcePeer(input: { alias: string }): Promise<void> {
    this.advertised.push(input.alias);
  }

  async unadvertiseNativeSourcePeer(alias: string): Promise<void> {
    this.unadvertised.push(alias);
    this.effects.push(`unadvertise:${alias}`);
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
  ): Promise<void> {
    this.effects.push(`status:${receiptHandle}:${status}`);
  }

  async releaseNativeInboundReceipt(receiptHandle: string): Promise<boolean> {
    this.effects.push(`release:${receiptHandle}`);
    return true;
  }

  async notifyNativeInboundProgress(
    receiptHandle: string,
    progress: Readonly<{
      kind: "stall";
      reason: "ROUTE_BUSY" | "ROUTE_UNAVAILABLE" | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    }>,
  ): Promise<void> {
    this.effects.push(
      `stall:${receiptHandle}:${progress.reason}:${progress.queuedForMs}`,
    );
  }

  async dispatch(input: GatewayAdapterDispatchInput): Promise<GatewayAdapterDispatchResult> {
    this.dispatches.push(input);
    for (const [count, waiter] of this.dispatchWaiters) {
      if (this.dispatches.length < count) continue;
      this.dispatchWaiters.delete(count);
      waiter.resolve();
    }
    if (this.mode === "never") return await new Promise<GatewayAdapterDispatchResult>(() => undefined);
    if (this.mode === "defer_once" && (this.deferAlways || !this.deferredOnce)) {
      this.deferredOnce = true;
      return { state: "deferred", safeErrorCode: this.deferredCode };
    }
    if (this.mode === "fail") {
      return { state: "failed", safeErrorCode: "INPUT_INVALID" };
    }
    if (input.steer === true && this.mode === "pause_accepted" && this.steerWrites >= 3) {
      return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
    }
    const evidence = prepared(input);
    assert.equal(await input.authorizeWrite({ attemptId: input.attemptId, ...evidence }), true);
    this.writes += 1;
    if (this.mode === "pause_accepted" || this.identity.provider === "codex") {
      await input.onAccepted({ attemptId: input.attemptId });
    }
    if (input.steer === true && this.mode === "pause_accepted") {
      this.steerWrites += 1;
      return { state: "delivered" };
    }
    if (this.mode === "pause_armed" || this.mode === "pause_accepted") {
      this.pauseEntered.resolve();
      await this.pauseRelease.promise;
    }
    if (this.mode === "fast_reply") {
      this.callbacks?.onClaudeReply({
        endpoint: {
          provider: "claude",
          hostId: input.binding.hostId,
          routeHandle: input.binding.routeHandle,
        },
        text: "fast native reply",
      });
    }
    return {
      state: "delivered",
      ...(this.terminalReplyText === undefined
        ? {}
        : { replyText: this.terminalReplyText }),
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.effects.push(`close:${this.identity.provider}`);
  }

  waitForDispatchCount(count: number): Promise<void> {
    if (this.dispatches.length >= count) return Promise.resolve();
    const waiter = this.dispatchWaiters.get(count) ?? deferred<void>();
    this.dispatchWaiters.set(count, waiter);
    return waiter.promise;
  }
}

function prepared(input: GatewayAdapterDispatchInput): GatewayPreparedWriteEvidence {
  const kind = input.binding.provider === "claude"
    ? "claude_mailbox"
    : input.binding.provider === "codex"
      ? input.steer === true
        ? "codex_turn_steer"
        : "codex_turn_start"
      : "peer_mailbox";
  const frame = `frame:${input.messageId}:${input.text}`;
  return {
    kind,
    bodyBytes: Buffer.byteLength(input.text, "utf8"),
    bodySha256: createHash("sha256").update(input.text).digest("hex"),
    frameBytes: Buffer.byteLength(frame),
    sha256: createHash("sha256").update(frame).digest("hex"),
  };
}

function limits(messageDeadlineMs = 10_000): GatewayConfig["limits"] {
  return {
    maxRoutes: 16,
    eventCapacity: 64,
    eventTtlMs: 60_000,
    dedupeCapacity: 64,
    dedupeTtlMs: 60_000,
    maxQueueMessages: 32,
    maxQueueMessagesPerRoute: 16,
    maxInFlightMessages: 16,
    maxQueueBytes: 128 * 1024,
    maxMessageBytes: 16 * 1024,
    maxRetainedBodyBytes: 64 * 1024,
    messageDeadlineMs,
    rateLimitPerRoute: 64,
    rateWindowMs: 1_000,
  };
}

type Fixture = {
  root: string;
  config: GatewayConfig;
  clock: TestClock;
  timers: TestTimers;
  store: GatewayStore;
  service: GatewayService;
  handlers: ReturnType<GatewayService["handlers"]>;
  close: () => Promise<void>;
};

async function fixture(
  adapters: readonly GatewayProviderAdapter[],
  options: Readonly<{
    deadlineMs?: number;
    hostId?: string;
    peerNodes?: readonly string[];
    spawnPeer?: NonNullable<GatewayServiceOptions["spawnPeer"]>;
    seed?: (store: GatewayStore) => Promise<void>;
    managedCodexSocketHeld?: () => Promise<boolean>;
  }> = {},
): Promise<Fixture> {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "gateway-service-v3-"));
  const stateDir = path.join(root, "state", "gateway");
  await mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  const config: GatewayConfig = {
    stateDir,
    controlSocketPath: path.join(stateDir, "control.sock"),
    allowedHosts: [options.hostId ?? "this-mac", ...(options.peerNodes ?? [])],
    hostId: options.hostId ?? "this-mac",
    peerNodes: options.peerNodes ?? [],
    steeringEnabled: true,
    stallNoticeMs: 2_500,
    limits: limits(options.deadlineMs),
  };
  const clock = new TestClock();
  const timers = new TestTimers(clock);
  const store = new GatewayStore(config, { now: clock.now, randomId: clock.randomId });
  await store.initialize();
  await options.seed?.(store);
  const service = new GatewayService({
    config,
    adapters,
    store,
    now: clock.now,
    timers,
    ...(options.managedCodexSocketHeld === undefined ? {} : { managedCodexSocketHeld: options.managedCodexSocketHeld }),
    ...(options.spawnPeer === undefined ? {} : { spawnPeer: options.spawnPeer }),
  });
  await service.start();
  return {
    root,
    config,
    clock,
    timers,
    store,
    service,
    handlers: service.handlers(),
    close: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function route(
  provider: GatewayProvider,
  alias: string,
  routeHandle: string,
  registrationId: string,
): RegisterRouteInput {
  return {
    alias,
    binding: { provider, hostId: "this-mac", routeHandle, registrationId },
    registrationMode: provider === "claude" ? "selected_live_peer" : "explicit_opt_in",
  };
}

async function routed(
  store: GatewayStore,
  left: RegisterRouteInput,
  right: RegisterRouteInput,
): Promise<void> {
  await store.registerRoute(left);
  await store.registerRoute(right);
}

const claude = route("claude", "advisor@this-mac", "claude-session-a", "reg_claude_a");
const codex = route("codex", "codex-main@this-mac", THREAD_A, "reg_codex_a");

test("peer registration persists only its hash and exact token owns idempotence and removal", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const peer = new FakeProvider({ provider: "peer", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, peer]);
  try {
    const registered = await subject.handlers.registerPeer({ alias: "peer-shell@this-mac" });
    assert.equal(registered.accepted, true);
    assert.ok("token" in registered);
    const token = registered.token;
    assert.match(token, /^peer_[A-Za-z0-9_-]{32}$/);
    const expected = `peer:${createHash("sha256").update(
      `${process.getuid!()}\0peer-shell@this-mac\0${token}`,
    ).digest("hex")}`;
    const stored = await subject.store.inspectPrivateRoute("peer-shell@this-mac");
    assert.equal(stored?.binding.routeHandle, expected);
    const state = await readFile(subject.store.stateFilePath, "utf8");
    assert.equal(state.includes(expected), true);
    assert.equal(state.includes(token), false);
    await eventually(() => claudeProvider.advertised.includes("peer-shell@this-mac"));
    assert.equal((await subject.service.snapshot()).alerts.some((alert) => alert.code === "NATIVE_ADVERTISEMENT_FAILED"), false);
    const foreignToken = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
    assert.notEqual(foreignToken, token);
    assert.deepEqual(await subject.handlers.registerPeer({ alias: "peer-shell@this-mac", token }), {
      accepted: true, code: "ok",
    });
    assert.deepEqual(await subject.handlers.registerPeer({ alias: "peer-shell@this-mac", token: foreignToken }), {
      accepted: false, code: "route_mismatch",
    });
    assert.deepEqual(await subject.handlers.unregisterPeer({ alias: "peer-shell@this-mac", token: foreignToken }), {
      accepted: false, code: "route_mismatch",
    });
    assert.notEqual(await subject.store.inspectPrivateRoute("peer-shell@this-mac"), undefined);
    const unadvertiseEntered = deferred<void>(); const releaseUnadvertise = deferred<void>();
    claudeProvider.unadvertiseNativeSourcePeer = async (alias) => {
      unadvertiseEntered.resolve(); await releaseUnadvertise.promise; claudeProvider.unadvertised.push(alias);
    };
    let removalSettled = false;
    const removal = Promise.resolve(subject.handlers.unregisterPeer({ alias: "peer-shell@this-mac", token }))
      .finally(() => { removalSettled = true; });
    await unadvertiseEntered.promise; await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(removalSettled, false);
    assert.deepEqual(await subject.handlers.registerPeer({ alias: "peer-shell@this-mac" }), {
      accepted: false, code: "busy",
    });
    assert.equal(await subject.store.inspectPrivateRoute("peer-shell@this-mac"), undefined);
    releaseUnadvertise.resolve();
    assert.deepEqual(await removal, {
      accepted: true, code: "ok",
    });
    assert.equal(await subject.store.inspectPrivateRoute("peer-shell@this-mac"), undefined);
    assert.equal(peer.forgotten.length, 1);
    await eventually(() => claudeProvider.unadvertised.includes("peer-shell@this-mac"));
    const priorAds = claudeProvider.advertised.length;
    assert.equal((await subject.handlers.registerPeer({ alias: "peer-shell@this-mac" })).accepted, true);
    await eventually(() => claudeProvider.advertised.length > priorAds);
  } finally { await subject.close(); }
});

test("peer principals send both directions and reply through ordinary conversations", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const peerProvider = new FakeProvider({ provider: "peer", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider, peerProvider]);
  try {
    const minted = await subject.handlers.registerPeer({ alias: "peer-shell@this-mac" });
    assert.ok(minted.accepted && "token" in minted);
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const toCodex = await subject.handlers.send({ fromAlias: "peer-shell@this-mac",
      peerToken: minted.token, toAlias: codex.alias, text: "STEER: peer stays ordinary", expectsReply: true });
    const toClaude = await subject.handlers.send({ fromAlias: "peer-shell@this-mac",
      peerToken: minted.token, toAlias: claude.alias, text: "peer to claude", expectsReply: true });
    assert.equal(toCodex.accepted, true); assert.equal(toClaude.accepted, true);
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, replyAddress: "uds:/test/forged.sock", toAlias: claude.alias, text: "wrong principal", expectsReply: false }),
      { accepted: false, code: "route_mismatch" });
    assert.deepEqual(await subject.handlers.send({ fromAlias: claude.alias, threadId: THREAD_A, toAlias: codex.alias, text: "wrong principal", expectsReply: false }),
      { accepted: false, code: "route_mismatch" });
    await eventually(() => codexProvider.dispatches.length === 1 && claudeProvider.dispatches.length === 1);
    assert.equal(codexProvider.dispatches[0]?.sourceProvider, "peer");
    assert.equal(codexProvider.dispatches[0]?.steer, undefined);
    assert.equal(claudeProvider.dispatches[0]?.sourceProvider, "peer");
    assert.ok(toClaude.accepted);
    const reply = await subject.handlers.reply({ conversationId: toClaude.conversationId,
      text: "peer follow-up", caller: { kind: "peer", alias: "peer-shell@this-mac", token: minted.token } });
    assert.equal(reply.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 2);
    assert.equal(claudeProvider.dispatches[1]?.text, "peer follow-up");
  } finally { await subject.close(); }
});

test("background Claude discovery installs its route on first send and replies exactly", async () => {
  const backgroundAlias = "bg9a04b5e9@this-mac", backgroundRoute = "claude-session-background";
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  claudeProvider.claudeDiscovery = { alias: backgroundAlias, routeHandle: backgroundRoute,
    kind: "bg", state: "idle" };
  claudeProvider.replyRouteHandle = backgroundRoute;
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({
      alias: codex.alias, threadId: THREAD_A, hostId: "this-mac", busyPolicy: "queue",
    });
    // No selection step: the background session's route installs on this send.
    assert.equal(await subject.store.inspectPrivateRoute(backgroundAlias), undefined);
    const sent = await subject.handlers.send({
      fromAlias: codex.alias, threadId: THREAD_A, toAlias: backgroundAlias,
      text: "background round trip", expectsReply: true,
    });
    assert.equal(sent.accepted, true);
    const installed = await subject.store.inspectPrivateRoute(backgroundAlias);
    assert.equal(installed?.registrationMode, "selected_live_peer");
    assert.equal(installed?.binding.routeHandle, backgroundRoute);
    if (!sent.accepted) assert.fail("background send admission");
    await eventually(() => claudeProvider.dispatches.length === 1);
    const reply = await subject.handlers.reply({
      conversationId: sent.conversationId, text: "background reply",
      caller: { kind: "claude", alias: backgroundAlias, replyAddress: "uds:/synthetic/background.sock" },
    });
    assert.equal(reply.accepted, true);
    await eventually(() => codexProvider.dispatches.some((dispatch) => dispatch.text === "background reply"));
  } finally { await subject.close(); }
});

test("a colliding Claude alias is refused at send time and stays sticky under a partial scan", async () => {
  const duplicateAlias = "shared-agent@this-mac", uniqueAlias = "unique-bg@this-mac";
  const firstUuid = "00000000-0000-7000-8000-000000000711";
  const secondUuid = "00000000-0000-7000-8000-000000000712";
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  let colliding = false, complete = true, duplicateRecord = false;
  claudeProvider.discoverClaudePeers = async () => {
    const peers = [
      { alias: duplicateAlias, routeHandle: firstUuid, kind: "interactive" as const, state: "idle" as const },
      ...(colliding ? [{ alias: duplicateAlias, routeHandle: secondUuid,
        kind: "bg" as const, state: "idle" as const }] : []),
      ...(duplicateRecord ? [{ alias: duplicateAlias, routeHandle: firstUuid,
        kind: "interactive" as const, state: "idle" as const }] : []),
      { alias: uniqueAlias, routeHandle: "claude-unique-background", kind: "bg" as const, state: "idle" as const },
    ];
    return { complete, peers, registry: { entriesScanned: peers.length, parseableRecords: peers.length,
      rejected: colliding ? [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 2 }] : [] } };
  };
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  const claudeRoutes = async () =>
    (await subject.store.listLogicalRoutes()).filter((row) => row.binding.provider === "claude");
  try {
    assert.deepEqual((await subject.handlers.listSnapshot()).availablePeers.map((peer) => peer.alias),
      [duplicateAlias, uniqueAlias]);
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });

    // The alias collides before anyone ever addressed it: the send is refused,
    // no route is installed under the ambiguous name, and nothing is enqueued.
    colliding = true;
    const refused = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: duplicateAlias, text: "ambiguous target", expectsReply: false });
    assert.deepEqual(refused, { accepted: false, code: "conflict", reason: "PEER_ALIAS_COLLISION" });
    assert.deepEqual(await claudeRoutes(), []);
    assert.deepEqual((await subject.handlers.listSnapshot()).messages, []);
    assert.equal(claudeProvider.dispatches.length, 0);

    // The fence is a fence on NAMES. A session UUID is unambiguous, so the
    // operator can always reach a session whose display name collides.
    const byUuid = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: firstUuid, text: "addressed by uuid", expectsReply: false });
    assert.equal(byUuid.accepted, true);
    assert.equal((await subject.store.inspectPrivateRoute(duplicateAlias))?.binding.routeHandle, firstUuid);
    await eventually(() => claudeProvider.dispatches.some((row) => row.text === "addressed by uuid"));

    // The escape hatch does not open the name: the same session is still
    // unaddressable by the ambiguous name, even now that it holds a route.
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: duplicateAlias, text: "still ambiguous by name", expectsReply: false }),
    { accepted: false, code: "conflict", reason: "PEER_ALIAS_COLLISION" });

    const snapshot = await subject.handlers.listSnapshot();
    assert.deepEqual(snapshot.availablePeers.map((peer) => peer.alias), [uniqueAlias]);
    assert.deepEqual(snapshot.connectors.find((row) => row.provider === "claude")?.registry?.rejected,
      [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 3 }]);

    // An incomplete scan cannot clear a collision: it stays sticky, and the
    // unaddressable name stays out of availablePeers.
    colliding = false; complete = false;
    await subject.handlers.refreshDiscovery();
    const incomplete = await subject.handlers.listSnapshot();
    assert.equal(incomplete.availablePeers.some((peer) => peer.alias === duplicateAlias), false);
    assert.deepEqual(incomplete.connectors.find((row) => row.provider === "claude")?.registry?.rejected,
      [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 1 }]);
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: duplicateAlias, text: "still ambiguous", expectsReply: false }),
    { accepted: false, code: "conflict", reason: "PEER_ALIAS_COLLISION" });
    assert.equal((await claudeRoutes()).length, 1);

    // One complete scan clears the name, and it resolves to the same route.
    complete = true;
    await subject.handlers.refreshDiscovery();
    assert.equal((await subject.handlers.listSnapshot()).availablePeers.some(
      (peer) => peer.alias === duplicateAlias), true);
    const admitted = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: duplicateAlias, text: "now addressable", expectsReply: false });
    assert.equal(admitted.accepted, true);
    const installed = await subject.store.inspectPrivateRoute(duplicateAlias);
    assert.equal(installed?.registrationMode, "selected_live_peer");
    assert.equal(installed?.binding.routeHandle, firstUuid);
    assert.equal((await subject.handlers.listSnapshot()).routes.some(
      (row) => row.alias === duplicateAlias && row.provider === "claude"), true);
    await eventually(() => claudeProvider.dispatches.some((row) => row.text === "now addressable"));

    // A repeated identical discovery row is not a collision.
    duplicateRecord = true;
    await subject.handlers.refreshDiscovery();
    const repeated = await subject.handlers.listSnapshot();
    assert.equal(repeated.availablePeers.filter((peer) => peer.alias === duplicateAlias).length, 1);
    assert.equal(repeated.connectors.find((row) => row.provider === "claude")?.registry?.rejected.some(
      (row) => row.safeErrorCode === "PEER_ALIAS_COLLISION"), false);

    // A collision that appears after the route exists refuses the send without
    // retiring the installed route: the fence never picks first, and never
    // silently retargets a name.
    duplicateRecord = false; colliding = true;
    await subject.handlers.refreshDiscovery();
    assert.equal((await subject.handlers.listSnapshot()).availablePeers.some(
      (peer) => peer.alias === duplicateAlias), false);
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: duplicateAlias, text: "ambiguous again", expectsReply: false }),
    { accepted: false, code: "conflict", reason: "PEER_ALIAS_COLLISION" });
    assert.equal((await subject.store.inspectPrivateRoute(duplicateAlias))?.binding.routeHandle, firstUuid);

    const sent = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: uniqueAlias, text: "unique candidate remains routable", expectsReply: false });
    assert.equal(sent.accepted, true);
    await eventually(() => claudeProvider.dispatches.some(
      (row) => row.text === "unique candidate remains routable"));
  } finally { await subject.close(); }
});

test("a Claude session's own route installs on its first send and its claimed name is checked", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    assert.equal(await subject.store.inspectPrivateRoute(claude.alias), undefined);

    // The sender is identified by its inherited socket, not by --from; its own
    // route installs on this first send.
    const sent = await subject.handlers.send({ fromAlias: claude.alias, toAlias: codex.alias,
      text: "first outbound", replyAddress: "uds:/test/claude-reply.sock", expectsReply: false });
    assert.equal(sent.accepted, true);
    const installed = await subject.store.inspectPrivateRoute(claude.alias);
    assert.equal(installed?.registrationMode, "selected_live_peer");
    assert.equal(installed?.binding.routeHandle, claudeProvider.replyRouteHandle);
    await eventually(() => codexProvider.dispatches.some((row) => row.text === "first outbound"));

    // A --from that names a different session than the socket identifies is a
    // refusal, never a silent rename of the sending session.
    assert.deepEqual(await subject.handlers.send({ fromAlias: "impostor@this-mac", toAlias: codex.alias,
      text: "claimed name mismatch", replyAddress: "uds:/test/claude-reply.sock", expectsReply: false }),
    { accepted: false, code: "route_mismatch", reason: "CLAUDE_ROUTE_MISMATCH" });
    assert.equal(await subject.store.inspectPrivateRoute("impostor@this-mac"), undefined);
    assert.equal((await subject.store.inspectPrivateRoute(claude.alias))?.binding.registrationId,
      installed?.binding.registrationId);
    assert.equal(codexProvider.dispatches.filter((row) => row.text === "claimed name mismatch").length, 0);
  } finally { await subject.close(); }
});

test("a refused send installs nothing and leaves another session's queued work alone", async () => {
  // The caller claims a name that is not its own while a stale route of the
  // same name holds queued work. The refusal must be read-only: no install, no
  // displacement, no ENDPOINT_RETIRED settlement, no journal row.
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "never");
  const stale = route("claude", claude.alias, "claude-session-stale", "reg_claude_stale");
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => {
      await store.registerRoute(stale);
      await store.registerRoute(codex);
      await store.enqueueMessage({ sourceAlias: stale.alias, targetAlias: codex.alias,
        body: "queued under the stale route", dedupeKey: "stale-queued" });
    },
  });
  const durable = async () => {
    const snapshot = await subject.store.publicSnapshot();
    return {
      routes: (await subject.store.listLogicalRoutes())
        .map((row) => `${row.alias}\u0000${row.binding.registrationId}`).sort(),
      // Terminal states only: ordinary background dispatch progress is not a
      // settlement, and this test is about work the refusal must not settle.
      settled: snapshot.messages.filter((event) => ["cancelled", "ambiguous", "unconfirmed",
        "failed", "expired", "abandoned", "rejected"].includes(event.state))
        .map((event) => `${event.body ?? ""}\u0000${event.state}\u0000${event.safeErrorCode ?? ""}`).sort(),
      installs: (snapshot.activityEvents ?? []).filter(
        (event) => event.action === "claude_route_installed" ||
          event.action === "claude_route_retired").length,
    };
  };
  try {
    // Discovery shows the live session under a different name than the stale
    // route carries, so a --from naming the stale route is a lie.
    claudeProvider.claudeDiscovery = { alias: "advisor-live@this-mac",
      routeHandle: claudeProvider.replyRouteHandle, kind: "interactive", state: "idle" };
    const before = await durable();
    assert.deepEqual(before.installs, 0);
    assert.deepEqual(
      await subject.handlers.send({ fromAlias: claude.alias, toAlias: codex.alias,
        text: "claimed under another session's name", replyAddress: "uds:/test/claude-reply.sock",
        expectsReply: false }),
      { accepted: false, code: "route_mismatch", reason: "CLAUDE_ROUTE_MISMATCH" },
    );
    // The stale route, its queued work, and the journal are all untouched: a
    // refused send never displaces a session or settles someone else's message.
    assert.deepEqual(await durable(), before);
    assert.equal((await subject.store.inspectPrivateRoute(claude.alias))?.binding.registrationId,
      stale.binding.registrationId);
    assert.equal(await subject.store.inspectPrivateRoute("advisor-live@this-mac"), undefined);
  } finally { await subject.close(); }
});

test("two first sends to the same never-installed session share one route", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    // Both sends read no route and both mint a registration; the loser adopts
    // the winner's rather than refusing an honest send.
    const [first, second] = await Promise.all([
      subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
        toAlias: claude.alias, text: "racing first send", expectsReply: false }),
      subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
        toAlias: claude.alias, text: "racing second send", expectsReply: false }),
    ]);
    assert.equal(first.accepted, true, JSON.stringify(first));
    assert.equal(second.accepted, true, JSON.stringify(second));
    const routes = (await subject.store.listLogicalRoutes()).filter(
      (row) => row.binding.provider === "claude");
    assert.equal(routes.length, 1);
    assert.equal(routes[0]?.binding.routeHandle, claudeProvider.claudeDiscovery.routeHandle);
    await eventually(() => claudeProvider.dispatches.filter(
      (row) => row.text.startsWith("racing")).length === 2);
  } finally { await subject.close(); }
});

test("a session renamed between reserve and dispatch is delivered to under its new name", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const opened = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: claude.alias, text: "installs the route", expectsReply: false });
    assert.equal(opened.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 1);
    const installed = (await subject.store.inspectPrivateRoute(claude.alias))!;

    // Rename the session in the exact window the runner is exposed to: after
    // the attempt captured its target alias, before the runner resolves it.
    const renamedAlias = "advisor-mid-flight@this-mac";
    const reserve = subject.store.reserveMessage.bind(subject.store);
    let renamed = false;
    subject.store.reserveMessage = async (...args) => {
      const result = await reserve(...args);
      if (!renamed && result.status === "reserved" && result.attempt.body === "survives a rename") {
        renamed = true;
        await subject.store.installClaudeRoute({ ...installed, alias: renamedAlias });
      }
      return result;
    };
    const sent = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: claude.alias, text: "survives a rename", expectsReply: false });
    assert.equal(sent.accepted, true);
    if (!sent.accepted) assert.fail("second send admission");
    // The route is the same registration under a new name, so the attempt is
    // delivered rather than settled ROUTE_UNREGISTERED against a stale alias.
    await eventually(async () => {
      const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken });
      return status.found && status.state === "delivered";
    });
    assert.equal(await subject.store.inspectPrivateRoute(claude.alias), undefined);
    assert.equal((await subject.store.inspectPrivateRoute(renamedAlias))?.binding.registrationId,
      installed.binding.registrationId);
    assert.equal(claudeProvider.dispatches.at(-1)?.text, "survives a rename");
  } finally { await subject.close(); }
});

test("a re-anchored Claude session keeps its registration and its in-flight conversation", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const opened = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: claude.alias, text: "before the rename", expectsReply: true });
    assert.equal(opened.accepted, true);
    if (!opened.accepted) assert.fail("install-on-send admission");
    const first = await subject.store.inspectPrivateRoute(claude.alias);
    assert.ok(first);

    // Same host, same session UUID, new display name: the identity is the
    // (host, UUID) pair, so the registration and the open conversation survive.
    claudeProvider.claudeDiscovery = { ...claudeProvider.claudeDiscovery, alias: "advisor-renamed@this-mac" };
    const renamed = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: "advisor-renamed@this-mac", text: "after the rename", expectsReply: false });
    assert.equal(renamed.accepted, true);
    assert.equal(await subject.store.inspectPrivateRoute(claude.alias), undefined);
    const second = await subject.store.inspectPrivateRoute("advisor-renamed@this-mac");
    assert.equal(second?.binding.registrationId, first.binding.registrationId);
    assert.equal(second?.binding.routeHandle, first.binding.routeHandle);
    assert.equal(
      ((await subject.store.publicSnapshot()).activityEvents ?? []).filter(
        (event) => event.action === "claude_route_retired").length,
      0,
      "a rename is not a displacement",
    );
    const reply = await subject.handlers.reply({ conversationId: opened.conversationId,
      text: "still the same session", caller: { kind: "claude", alias: "advisor-renamed@this-mac",
        replyAddress: "uds:/test/claude-reply.sock" } });
    assert.equal(reply.accepted, true);
    await eventually(() => codexProvider.dispatches.some((row) => row.text === "still the same session"));
  } finally { await subject.close(); }
});

test("a deliberately broad Claude workspace is refused before any route is installed", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  claudeProvider.workspaceGuard = async () => {
    throw new BridgeError("CLAUDE_PEER_WORKSPACE_BROAD", "The Claude workspace contains the gateway state directory.");
  };
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: claude.alias, text: "must not install", expectsReply: false }),
    { accepted: false, code: "rejected", reason: "CLAUDE_PEER_WORKSPACE_BROAD" });
    assert.equal(await subject.store.inspectPrivateRoute(claude.alias), undefined);
    assert.deepEqual((await subject.handlers.listSnapshot()).messages, []);
    assert.equal(claudeProvider.dispatches.length, 0);
  } finally { await subject.close(); }
});

test("a send to an undiscovered Claude alias is an ordinary unknown target", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: "nobody@this-mac", text: "no such session", expectsReply: false }),
    { accepted: false, code: "not_found", reason: "CLAUDE_ROUTE_NOT_FOUND" });
    assert.deepEqual((await subject.handlers.listSnapshot()).messages, []);
    assert.deepEqual((await subject.store.listLogicalRoutes()).map((row) => row.alias), [codex.alias]);
  } finally { await subject.close(); }
});

test("an operator rescan reports discovery failure and journals only a completed scan", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider]);
  const refreshedRows = async (): Promise<number> =>
    ((await subject.store.publicSnapshot()).activityEvents ?? [])
      .filter((event) => event.action === "discovery_refreshed").length;
  try {
    const baseline = await refreshedRows();
    const scans = claudeProvider.discoverCalls;

    const working = claudeProvider.discoverClaudePeers.bind(claudeProvider);
    claudeProvider.discoverClaudePeers = async () => {
      claudeProvider.discoverCalls += 1;
      throw new BridgeError("CLAUDE_PROVIDER_UNAVAILABLE", "The Claude provider is unavailable.");
    };
    const revision = (await subject.handlers.health()).revision;
    assert.deepEqual(await subject.handlers.refreshDiscovery(), {
      accepted: false, code: "unavailable", revision,
    });
    assert.equal(claudeProvider.discoverCalls, scans + 1, "the failed rescan still attempted the scan");
    assert.equal(await refreshedRows(), baseline, "a failed rescan journals no discovery_refreshed row");

    claudeProvider.discoverClaudePeers = working;
    assert.deepEqual(await subject.handlers.refreshDiscovery(), {
      accepted: true, code: "ok", revision,
    });
    assert.equal(await refreshedRows(), baseline + 1);
    assert.equal(
      (await subject.handlers.listSnapshot()).availablePeers.some(
        (peer) => peer.alias === claudeProvider.claudeDiscovery.alias),
      true,
    );
  } finally { await subject.close(); }
});

test("Claude alias collision overflow drops unfenced candidates and keeps diagnostics complete", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const aliases = Array.from({ length: 257 }, (_, index) =>
    `overflow-${String(index).padStart(3, "0")}@this-mac`);
  claudeProvider.discoverClaudePeers = async () => ({ complete: true,
    peers: aliases.flatMap((alias, index) => [
      { alias, routeHandle: `overflow-${index}-a`, kind: "interactive" as const, state: "idle" as const },
      { alias, routeHandle: `overflow-${index}-b`, kind: "bg" as const, state: "idle" as const },
    ]), registry: { entriesScanned: 514, parseableRecords: 514, rejected: [] } });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider]);
  try {
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const snapshot = await subject.handlers.listSnapshot();
    assert.deepEqual(snapshot.availablePeers, []);
    assert.deepEqual(snapshot.connectors.find((row) => row.provider === "claude")?.registry?.rejected,
      [{ safeErrorCode: "PEER_ALIAS_COLLISION", count: 257 }]);
    // The overflow alias is discarded rather than left unfenced, so a send to
    // it is an ordinary unknown target, never a pick-first delivery.
    assert.deepEqual(await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: aliases.at(-1)!, text: "overflow target", expectsReply: false }),
    { accepted: false, code: "not_found", reason: "CLAUDE_ROUTE_NOT_FOUND" });
    assert.deepEqual((await subject.store.listLogicalRoutes()).filter(
      (row) => row.binding.provider === "claude"), []);
  } finally { await subject.close(); }
});

test("a peer waiter kicks cleanly deferred mail and exact receipt settles it once", async () => {
  const mailbox = new LocalPeerMailboxProvider({ hostId: "this-mac", receiptTimeoutMs: 100,
    now: () => Date.parse("2026-08-16T12:00:00.000Z") });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([mailbox, codexProvider]);
  try {
    const minted = await subject.handlers.registerPeer({ alias: "peer-shell@this-mac" });
    assert.ok(minted.accepted && "token" in minted);
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const sent = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: "peer-shell@this-mac", text: "mailbox payload", expectsReply: true });
    assert.ok(sent.accepted);
    const received = await subject.handlers.awaitPeer({ alias: "peer-shell@this-mac", token: minted.token });
    assert.equal(received.state, "message");
    assert.match(received.frame, /mailbox payload/);
    assert.deepEqual(await subject.handlers.peerReceipt({ alias: "peer-shell@this-mac",
      token: minted.token, receipt: received.receipt }), { accepted: true, code: "ok" });
    assert.deepEqual(await subject.handlers.peerReceipt({ alias: "peer-shell@this-mac",
      token: minted.token, receipt: received.receipt }), { accepted: true, code: "ok" });
    await eventually(async () => {
      const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken });
      return status.found && status.state === "delivered";
    });
  } finally { await subject.close(); }
});

test("native Claude STEER text reaches a peer mailbox only through the ordinary lane", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const mailbox = new LocalPeerMailboxProvider({ hostId: "this-mac", receiptTimeoutMs: 100,
    now: () => Date.parse("2026-08-16T12:00:00.000Z") });
  let observedSteer: true | undefined;
  const dispatch = mailbox.dispatch.bind(mailbox);
  mailbox.dispatch = async (input) => { observedSteer = input.steer; return await dispatch(input); };
  const subject = await fixture([claudeProvider, mailbox], {
    seed: async (store) => store.registerRoute(claude),
  });
  try {
    const minted = await subject.handlers.registerPeer({ alias: "peer-native@this-mac" });
    assert.ok(minted.accepted && "token" in minted);
    const waiting = subject.handlers.awaitPeer({ alias: "peer-native@this-mac", token: minted.token });
    claudeProvider.callbacks?.onClaudeMessage?.({ endpoint: { provider: "claude",
      hostId: "this-mac", routeHandle: claude.binding.routeHandle }, sourceAlias: claude.alias,
      targetAlias: "peer-native@this-mac", text: "STEER: ordinary peer mailbox" });
    const received = await waiting;
    assert.equal(received.state, "message");
    assert.equal(observedSteer, undefined);
    assert.match(received.frame, /STEER: ordinary peer mailbox/);
    assert.deepEqual(await subject.handlers.peerReceipt({ alias: "peer-native@this-mac",
      token: minted.token, receipt: received.receipt }), { accepted: true, code: "ok" });
  } finally { await subject.close(); }
});

test("queued peer mail resumes once after restart under the same hash-only principal", async () => {
  const firstMailbox = new LocalPeerMailboxProvider({ hostId: "this-mac",
    now: () => Date.parse("2026-08-16T12:00:00.000Z") });
  const firstCodex = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([firstMailbox, firstCodex]);
  let replacement: GatewayService | undefined;
  try {
    const minted = await subject.handlers.registerPeer({ alias: "peer-restart@this-mac" });
    assert.ok(minted.accepted && "token" in minted);
    await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" });
    const sent = await subject.handlers.send({ fromAlias: codex.alias, threadId: THREAD_A,
      toAlias: "peer-restart@this-mac", text: "survive restart", expectsReply: true });
    assert.ok(sent.accepted);
    await eventually(() => subject.timers.rows.some((row) =>
      !row.cancelled && row.at === subject.clock.now().getTime() + 500));
    await subject.service.close();

    const store = new GatewayStore(subject.config, { now: subject.clock.now,
      randomId: subject.clock.randomId });
    const mailbox = new LocalPeerMailboxProvider({ hostId: "this-mac", receiptTimeoutMs: 100,
      now: () => subject.clock.now().getTime() });
    const replacementClaude = new FakeProvider({ provider: "claude", hostId: "this-mac" });
    replacement = new GatewayService({ config: subject.config, store,
      adapters: [mailbox, replacementClaude, new FakeProvider({ provider: "codex", hostId: "this-mac" })],
      now: subject.clock.now, timers: new TestTimers(subject.clock) });
    await replacement.start();
    await eventually(() => replacementClaude.advertised.includes("peer-restart@this-mac"));
    const handlers = replacement.handlers();
    assert.deepEqual(await handlers.registerPeer({ alias: "peer-restart@this-mac", token: minted.token }), {
      accepted: true, code: "ok",
    });
    assert.deepEqual(await handlers.registerPeer({ alias: "peer-restart@this-mac",
      token: `${minted.token.slice(0, -1)}${minted.token.endsWith("z") ? "a" : "z"}` }), { accepted: false, code: "route_mismatch" });
    const received = await handlers.awaitPeer({ alias: "peer-restart@this-mac", token: minted.token });
    assert.equal(received.state, "message");
    assert.match(received.frame, /survive restart/);
    assert.deepEqual(await handlers.peerReceipt({ alias: "peer-restart@this-mac",
      token: minted.token, receipt: received.receipt }), { accepted: true, code: "ok" });
    await eventually(async () => {
      const status = await handlers.deliveryStatus({ token: sent.deliveryToken });
      return status.found && status.state === "delivered";
    });
  } finally { await replacement?.close(); await subject.close(); }
});

test("start restores logical observations and helper advertisements without provider construction", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    assert.deepEqual(codexProvider.observed, [{
      alias: codex.alias,
      routeHandle: THREAD_A,
      registrationId: "reg_codex_a",
    }]);
    assert.deepEqual(claudeProvider.advertised, [codex.alias]);
    assert.equal(codexProvider.dispatches.length, 0);
    const snapshot = await subject.service.snapshot();
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(snapshot.routes.map((item) => item.alias).sort(), [claude.alias, codex.alias]);
    assert.equal(JSON.stringify(snapshot).includes(THREAD_A), false);
    assert.equal(JSON.stringify(snapshot).includes("reg_codex_a"), false);
  } finally {
    await subject.close();
  }
});

test("record-only register and atomic succeeds never connect during construction", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const registered = await subject.handlers.registerCodex({
      alias: "codex-next@this-mac",
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
      succeedsAlias: codex.alias,
    });
    assert.deepEqual(registered, { accepted: true, code: "ok" });
    assert.equal(await subject.store.inspectPrivateRoute(codex.alias), undefined);
    assert.equal((await subject.store.inspectPrivateRoute("codex-next@this-mac"))?.binding.routeHandle, THREAD_B);
    assert.equal(codexProvider.dispatches.length, 0);
    assert.deepEqual(claudeProvider.unadvertised, [codex.alias]);
    assert.deepEqual(claudeProvider.advertised.slice(-1), ["codex-next@this-mac"]);
    const events = (await subject.store.publicSnapshot()).activityEvents ?? [];
    assert.equal(events.filter((event) => event.action === "codex_succeeded").length, 1);
  } finally {
    await subject.close();
  }
});

test("federated named routes refuse removal even when the presented binding matches", async () => {
  const subject = await fixture([new FakeProvider({ provider: "claude", hostId: "studio" })],
    { hostId: "studio", peerNodes: ["m5dev"] });
  try {
    const remoteCodex: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
      binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote_codex", registrationId: "reg_mirror_codex" } };
    const remoteClaude: RegisterRouteInput = { alias: "advisor@m5dev", registrationMode: "federated_peer",
      binding: { provider: "claude", hostId: "m5dev", routeHandle: "reg_remote_claude", registrationId: "reg_mirror_claude" } };
    const local: RegisterRouteInput = { alias: "advisor@studio", registrationMode: "selected_live_peer",
      binding: { provider: "claude", hostId: "studio", routeHandle: "claude-session-a", registrationId: "reg_local" } };
    await subject.store.registerRoute(local); await subject.store.registerRoute(remoteCodex); await subject.store.registerRoute(remoteClaude);
    const before = await readFile(subject.store.stateFilePath, "utf8");
    // The handler is called with the federated route's exact handle, so alias and
    // binding both match; only the explicit federated guard can refuse here.
    assert.deepEqual(await subject.handlers.unregisterCodex({ alias: remoteCodex.alias, threadId: remoteCodex.binding.routeHandle }),
      { accepted: false, code: "rejected" });
    assert.equal(await readFile(subject.store.stateFilePath, "utf8"), before);
    assert.equal((await subject.store.inspectPrivateRoute(remoteCodex.alias))?.registrationMode, "federated_peer");
  } finally { await subject.close(); }
});

test("peer handoff preserves every write boundary and never replays uncertainty", async () => {
  const run = async (mode: "confirmed" | "pipe" | "authorization" | "acceptance") => {
    const subject = await fixture([new FakeProvider({ provider: "claude", hostId: "studio" })],
      { hostId: "studio", peerNodes: ["m5dev"] });
    let writes = 0;
    try {
      const local: RegisterRouteInput = { alias: "advisor@studio", registrationMode: "selected_live_peer",
        binding: { provider: "claude", hostId: "studio", routeHandle: "claude-session-a", registrationId: "reg_local" } };
      const remote: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
        binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote", registrationId: "reg_mirror" } };
      await subject.store.registerRoute(local); await subject.store.registerRoute(remote);
      const peer = { close: () => undefined, prepareHandoff: (params: PeerHandoffParams) => {
        assert.equal(params.source.routeRef, peerRouteRef("studio", local.binding.registrationId));
        assert.notEqual(params.source.routeRef, local.binding.registrationId);
        const bodySha256 = createHash("sha256").update(params.body).digest("hex");
        return { bodyBytes: Buffer.byteLength(params.body), bodySha256, frameBytes: 32, sha256: createHash("sha256").update("peer-frame").digest("hex"),
          cancel: () => undefined, perform: async () => { writes += 1; if (mode === "pipe") throw new Error("pipe lost"); return { accepted: true as const }; } };
      } } as unknown as PeerClient;
      (subject.service as unknown as { peerClients: Map<string, PeerClient> }).peerClients.set("m5dev", peer);
      if (mode === "authorization") {
        const original = subject.store.authorizeMessage.bind(subject.store);
        subject.store.authorizeMessage = async (input) => { await original(input); throw new Error("authorization commit uncertain"); };
      } else if (mode === "acceptance") {
        const original = subject.store.acceptMessage.bind(subject.store);
        subject.store.acceptMessage = async (input) => { await original(input); throw new Error("accept commit uncertain"); };
      }
      const sent = await subject.handlers.send({ fromAlias: local.alias, toAlias: remote.alias,
        text: `peer ${mode}`, replyAddress: "uds:/test/reply.sock", expectsReply: false });
      assert.equal(sent.accepted, true, JSON.stringify(sent));
      await eventually(async () => { const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken }); return status.found && status.terminal; });
      const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken });
      assert.equal(status.found, true);
      if (!status.found) throw new Error("missing delivery");
      assert.equal(status.state, mode === "confirmed" ? "delivered" : mode === "acceptance" ? "unconfirmed" : "ambiguous");
      assert.equal(status.safeErrorCode, mode === "confirmed" ? "PEER_HANDOFF_CONFIRMED" : mode === "acceptance"
        ? "PEER_HANDOFF_ACCEPTANCE_UNCONFIRMED" : mode === "authorization" ? "WRITE_AUTHORIZATION_UNCERTAIN" : "PEER_HANDOFF_OUTCOME_UNKNOWN");
      assert.equal(writes, mode === "authorization" ? 0 : 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writes, mode === "authorization" ? 0 : 1);
      if (mode === "confirmed") {
        const state = JSON.parse(await readFile(subject.store.stateFilePath, "utf8")) as { messages: Record<string, unknown>[] };
        assert.equal(Object.hasOwn(state.messages.at(-1)!, "body"), false);
      }
    } finally { await subject.close(); }
  };
  for (const mode of ["confirmed", "pipe", "authorization", "acceptance"] as const) await run(mode);
});

test("an unavailable peer requeues once without a hot dispatch loop", async () => {
  const provider = new FakeProvider({ provider: "claude", hostId: "studio" });
  const subject = await fixture([provider], { hostId: "studio", peerNodes: ["m5dev"] });
  let reserves = 0;
  try {
    const local: RegisterRouteInput = { alias: "advisor@studio", registrationMode: "selected_live_peer",
      binding: { provider: "claude", hostId: "studio", routeHandle: provider.replyRouteHandle, registrationId: "reg_local" } };
    const remote: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
      binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote", registrationId: "reg_mirror" } };
    await subject.store.registerRoute(local); await subject.store.registerRoute(remote);
    const reserve = subject.store.reserveMessage.bind(subject.store);
    subject.store.reserveMessage = async (...args) => { reserves += 1; return await reserve(...args); };
    const sent = await subject.handlers.send({ fromAlias: local.alias, toAlias: remote.alias,
      text: "wait for tunnel", replyAddress: "uds:/test/reply.sock", expectsReply: false });
    assert.equal(sent.accepted, true); await eventually(() => reserves === 1);
    for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reserves, 1);
    const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken });
    assert.equal(status.found && status.state, "stalled");
  } finally { await subject.close(); }
});

test("local Claude ingress advertises and hands off a federated Codex route", async () => {
  const provider = new FakeProvider({ provider: "claude", hostId: "studio" });
  const local: RegisterRouteInput = { alias: "advisor@studio", registrationMode: "selected_live_peer",
    binding: { provider: "claude", hostId: "studio", routeHandle: provider.replyRouteHandle, registrationId: "reg_local" } };
  const remote: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
    binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote", registrationId: "reg_mirror" } };
  const subject = await fixture([provider], { hostId: "studio", peerNodes: ["m5dev"], seed: async (store) => {
    await store.registerRoute(local); await store.registerRoute(remote);
  } });
  let writes = 0;
  try {
    const peer = { close: () => undefined, prepareHandoff: (params: PeerHandoffParams) => {
      const bodySha256 = createHash("sha256").update(params.body).digest("hex");
      return { bodyBytes: Buffer.byteLength(params.body), bodySha256, frameBytes: 32,
        sha256: createHash("sha256").update("native-peer-frame").digest("hex"), cancel: () => undefined,
        perform: async () => { writes += 1; return { accepted: true as const }; } };
    } } as unknown as PeerClient;
    (subject.service as unknown as { peerClients: Map<string, PeerClient> }).peerClients.set("m5dev", peer);
    assert.ok(provider.advertised.includes(remote.alias));
    provider.callbacks?.onClaudeMessage?.({ endpoint: { provider: "claude", hostId: "studio", routeHandle: provider.replyRouteHandle },
      sourceAlias: local.alias, targetAlias: remote.alias, text: "native federation", receiptHandle: "receipt-native-federation" });
    await eventually(() => writes === 1);
    await eventually(async () => (await subject.store.publicSnapshot()).messages.at(-1)?.state === "delivered");
    assert.equal((await subject.store.publicSnapshot()).messages.at(-1)?.safeErrorCode, "PEER_HANDOFF_CONFIRMED");
  } finally { await subject.close(); }
});

test("peer lifecycle reconciles mirrors, exports local-only catalog, and commits inbound handoff before acceptance", async () => {
  const local: RegisterRouteInput = { alias: "codex-local@studio", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "studio", routeHandle: THREAD_A, registrationId: "reg_local" } };
  const remote = { alias: "codex-worker@m5dev", provider: "codex" as const, host: "m5dev", routeRef: "reg_remote_codex" };
  const localEndpoint = { alias: local.alias, provider: local.binding.provider, host: "studio",
    routeRef: peerRouteRef("studio", local.binding.registrationId) };
  let current: PeerCatalogResult = { revision: 1, complete: true, truncated: false, generatedAt: "2026-08-16T12:00:00.000Z",
    health: "healthy", connectors: [], routes: [{ ref: remote.routeRef, alias: remote.alias, provider: remote.provider,
      host: remote.host, enabled: true, state: "idle", queueDepth: 0 }], alerts: [] };
  let catalogCalls = 0, closes = 0, failCatalog = false;
  const peer = { close: () => { closes += 1; }, catalog: async () => {
    catalogCalls += 1; if (failCatalog) throw new Error("synthetic tunnel loss"); return current;
  },
    prepareHandoff: () => { throw new Error("outbound handoff not expected"); } } as unknown as PeerClient;
  const subject = await fixture([new FakeProvider({ provider: "claude", hostId: "studio" })], {
    hostId: "studio", peerNodes: ["m5dev"], seed: async (store) => store.registerRoute(local),
    spawnPeer: async ({ node, localHost }) => { assert.equal(node, "m5dev"); assert.equal(localHost, "studio"); return peer; },
  });
  try {
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue();
    await eventually(async () => (await subject.store.inspectPrivateRoute(remote.alias))?.registrationMode === "federated_peer");
    assert.equal(catalogCalls, 1);
    const reconcile = subject.store.reconcilePeerCatalog.bind(subject.store); let reconcileCalls = 0;
    subject.store.reconcilePeerCatalog = async (...args) => { reconcileCalls += 1; return reconcile(...args); };
    current = { ...current, revision: 99,
      generatedAt: "2026-08-16T12:00:01.000Z" };
    subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue(); await eventually(() => catalogCalls === 2);
    assert.equal(reconcileCalls, 0, "peer revision echoes must not create durable reconciliation commits");
    current = { ...current, complete: false };
    subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue();
    assert.equal((await subject.store.inspectPrivateRoute(remote.alias))?.registrationMode, "federated_peer");
    await eventually(async () => (await subject.service.snapshot()).routes.find((route) => route.alias === remote.alias)
      ?.safeErrorCode === "PEER_CATALOG_INCOMPLETE");
    current = { ...current, complete: true, routes: current.routes.map((route) => ({ ...route, enabled: false })) };
    subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue();
    await eventually(async () => (await subject.store.inspectPrivateRoute(remote.alias))?.enabled === false,
      "same-revision authority changes must still reconcile");
    const exported = await subject.handlers.peerCatalog?.({ peerHost: "m5dev" });
    assert.ok(exported); assert.deepEqual(exported.routes.map((route) => route.alias), [local.alias]);
    assert.equal(JSON.stringify(exported).includes(remote.alias), false); assert.equal(JSON.stringify(exported).includes("body"), false);
    const handoff: PeerHandoffParams = { originAttemptId: "attempt_origin", originMessageId: "msg_origin", source: remote,
      target: localEndpoint,
      deadlineAt: new Date(subject.clock.now().getTime() + 5_000).toISOString(), expectsReply: false, body: "committed remotely" };
    assert.deepEqual(await subject.handlers.peerHandoff?.({ peerHost: "m5dev", handoff }), { accepted: true });
    assert.equal((JSON.parse(await readFile(subject.store.stateFilePath, "utf8")) as { messages: { body?: string }[] }).messages.at(-1)?.body,
      "committed remotely");
    assert.deepEqual(await subject.handlers.peerHandoff?.({ peerHost: "m5dev", handoff }), { accepted: true });
    const afterHandoff = await subject.handlers.peerCatalog?.({ peerHost: "m5dev" });
    assert.equal(JSON.stringify(afterHandoff).includes("committed remotely"), false);
    assert.equal(JSON.stringify(afterHandoff).includes("msg_origin"), false);
    failCatalog = true; subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue();
    await eventually(async () => (await subject.service.snapshot()).routes.find((route) => route.alias === remote.alias)
      ?.safeErrorCode === "PEER_TUNNEL_UNAVAILABLE");
    assert.equal((await subject.store.inspectPrivateRoute(remote.alias))?.registrationMode, "federated_peer");
    failCatalog = false;
    current = { ...current, revision: 2, routes: [] };
    subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue();
    await eventually(async () => (await subject.store.inspectPrivateRoute(remote.alias)) === undefined);
  } finally { await subject.close(); }
  assert.equal(closes, 2, "the failed client closes and the reconnected client closes at shutdown");
});

test("a fresh canonical-host broker exports its startup-owned routes to a configured peer", async () => {
  const providers = (["codex", "peer"] as const).map((provider) => new FakeProvider(
    { provider, hostId: "m5dev" }, "deliver",
    { alias: `${provider}-main@m5dev`, routeHandle: provider === "peer" ? "peer:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : "codex-owned", state: "idle" },
  ));
  const subject = await fixture(providers, { hostId: "m5dev", peerNodes: ["this-mac"] });
  try {
    assert.equal((await subject.service.snapshot()).routes.length, 2);
    const catalog = await subject.handlers.peerCatalog?.({ peerHost: "this-mac" });
    assert.deepEqual(catalog?.routes.map((route) => route.alias).sort(),
      ["codex-main@m5dev", "peer-main@m5dev"]);
  } finally { await subject.close(); }
});

test("a this-mac mixed-provider catalog is strict, opaque, and excludes local-only authority", async () => {
  const routes = [
    route("claude", "advisor@this-mac", "00000000-0000-4000-8000-000000000001", "reg_claude"),
    route("codex", "codex-main@this-mac", THREAD_A, "reg_codex_main"),
    route("codex", "codex-review@this-mac", THREAD_B, "reg_codex_review"),
    route("peer", "peer-main@this-mac", "peer:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "reg_peer"),
  ];
  const subject = await fixture((["claude", "codex", "peer"] as const)
    .map((provider) => new FakeProvider({ provider, hostId: "this-mac" })), {
    hostId: "this-mac", peerNodes: ["m5dev"], seed: async (store) => {
      for (const candidate of routes) await store.registerRoute(candidate);
    },
  });
  try {
    const alerts = (subject.service as unknown as { runtimeAlerts: Array<Record<string, unknown>> }).runtimeAlerts;
    alerts.push({ code: "INVALID_CODEX_PEER_ALIAS", severity: "warning", timestamp: subject.clock.now().toISOString(),
      provider: "codex", host: "m5dev", alias: "codex-invalid@m5dev" });
    alerts.push({ code: "LOCAL_TEST_NOTICE", severity: "warning", timestamp: subject.clock.now().toISOString(),
      provider: "codex", host: "this-mac", alias: routes[1]!.alias });
    const catalog = await subject.handlers.peerCatalog?.({ peerHost: "m5dev" });
    assert.ok(catalog); assert.deepEqual(decodePeerResult("catalog/get", catalog), catalog);
    assert.equal(catalog.routes.length, 4);
    assert.deepEqual(catalog.alerts.map((alert) => alert.code), ["LOCAL_TEST_NOTICE"]);
    assert.ok(catalog.routes.every((row) => /^reg_[A-Za-z0-9_-]+$/.test(row.ref)));
    const wire = JSON.stringify(catalog);
    for (const candidate of routes) {
      assert.equal(wire.includes(candidate.binding.registrationId), false);
      assert.equal(wire.includes(candidate.binding.routeHandle), false);
    }
  } finally { await subject.close(); }
});

test("peer refresh closes a late spawned client before shutdown completes", async () => {
  const spawn = deferred<PeerClient>(); let spawnCalls = 0, closes = 0, catalogCalls = 0;
  const subject = await fixture([], { hostId: "studio", peerNodes: ["m5dev"], spawnPeer: async () => {
    spawnCalls += 1; return spawn.promise;
  } });
  await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
  await subject.timers.runDue(); await eventually(() => spawnCalls === 1);
  let closed = false; const closing = subject.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(closed, false);
  spawn.resolve(({ close: () => { closes += 1; }, catalog: async () => {
    catalogCalls += 1; throw new Error("must not run");
  } }) as unknown as PeerClient);
  await closing; assert.equal(closes, 1); assert.equal(catalogCalls, 0);
});

test("first peer dial failure is host-visible and the next cadence re-dials", async () => {
  let attempts = 0;
  const peer = { close: () => undefined, catalog: async (): Promise<PeerCatalogResult> => ({ revision: 1,
    complete: true, truncated: false, generatedAt: "2026-08-16T12:00:00.000Z", health: "healthy",
    connectors: [], routes: [], alerts: [] }) } as unknown as PeerClient;
  const subject = await fixture([], { hostId: "studio", peerNodes: ["m5dev"], spawnPeer: async () => {
    attempts += 1; if (attempts === 1) throw new Error("private ssh failure"); return peer;
  } });
  try {
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue(); await eventually(() => attempts === 1);
    const failedSnapshot = await subject.service.snapshot();
    assert.deepEqual(failedSnapshot.alerts.filter((alert) => alert.host === "m5dev")
      .map(({ code, host }) => ({ code, host })), [{ code: "PEER_DIAL_FAILED", host: "m5dev" }]);
    assert.equal(JSON.stringify(failedSnapshot).includes("private ssh failure"), false);
    subject.clock.advance(30_000);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue(); await eventually(() => attempts === 2);
    assert.equal((await subject.service.snapshot()).alerts.some((alert) => alert.host === "m5dev" &&
      alert.code === "PEER_DIAL_FAILED"), false);
  } finally { await subject.close(); }
});

test("a peer answering initialize with another protocol version surfaces PEER_PROTOCOL_MISMATCH, not a tunnel fault", async () => {
  // A real PeerClient over a fake wire: the remote is a 2.x node that still speaks version 1.
  class FakeChild extends EventEmitter {
    readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); killed = false;
    kill(): boolean { this.killed = true; queueMicrotask(() => this.emit("exit")); return true; }
  }
  const children: FakeChild[] = []; const methods: string[] = [];
  const spawn: PeerSpawn = () => {
    const child = new FakeChild(); children.push(child);
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { id: number; method: string }; methods.push(request.method);
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, host: "m5dev",
          capabilities: ["catalog", "handoff"], limits: { requestBytes: 32768, catalogBytes: 262144, bodyBytes: 16384 } } })}\n`);
      }
    });
    return child as unknown as ReturnType<PeerSpawn>;
  };
  const subject = await fixture([new FakeProvider({ provider: "claude", hostId: "studio" })], { hostId: "studio", peerNodes: ["m5dev"],
    spawnPeer: (options) => spawnPeerClient({ ...options, spawn }) });
  try {
    const local: RegisterRouteInput = { alias: "advisor@studio", registrationMode: "selected_live_peer",
      binding: { provider: "claude", hostId: "studio", routeHandle: "claude-session-a", registrationId: "reg_local" } };
    const mirrors: RegisterRouteInput[] = [
      { alias: "codex-main@m5dev", registrationMode: "federated_peer", binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote_codex", registrationId: "reg_mirror_codex" } },
      { alias: "advisor@m5dev", registrationMode: "federated_peer", binding: { provider: "claude", hostId: "m5dev", routeHandle: "reg_remote_claude", registrationId: "reg_mirror_claude" } },
    ];
    await subject.store.registerRoute(local); for (const mirror of mirrors) await subject.store.registerRoute(mirror);
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
    await subject.timers.runDue(); await eventually(() => children.length === 1 && children[0]!.killed);
    const snapshot = await subject.service.snapshot();
    assert.deepEqual(snapshot.alerts.filter((alert) => alert.host === "m5dev").map(({ code, host }) => ({ code, host })),
      [{ code: "PEER_PROTOCOL_MISMATCH", host: "m5dev" }]);
    assert.deepEqual(snapshot.routes.filter((route) => route.host === "m5dev").map(({ alias, state, safeErrorCode }) => ({ alias, state, safeErrorCode })).sort((a, b) => a.alias.localeCompare(b.alias)),
      [{ alias: "advisor@m5dev", state: "stale", safeErrorCode: "PEER_PROTOCOL_MISMATCH" }, { alias: "codex-main@m5dev", state: "stale", safeErrorCode: "PEER_PROTOCOL_MISMATCH" }]);
    assert.deepEqual(methods, ["initialize"], "no catalog decode is attempted against a mismatched peer");
    assert.equal(JSON.stringify(snapshot).includes("PEER_TUNNEL_UNAVAILABLE"), false);
  } finally { await subject.close(); }
});

test("one blocked peer does not prevent another peer catalog from reconciling", async () => {
  const blocked = deferred<PeerCatalogResult>(); const remote = { alias: "codex-worker@zdev", provider: "codex" as const,
    host: "zdev", routeRef: "reg_remote_zdev" };
  const healthy: PeerCatalogResult = { revision: 1, complete: true, truncated: false,
    generatedAt: "2026-08-16T12:00:00.000Z", health: "healthy", connectors: [], routes: [{ ref: remote.routeRef,
      alias: remote.alias, provider: remote.provider, host: remote.host, enabled: true, state: "idle", queueDepth: 0 }],
    alerts: [] };
  const clients = new Map<string, PeerClient>([["m5dev", { close: () => undefined, catalog: () => blocked.promise } as unknown as PeerClient],
    ["zdev", { close: () => undefined, catalog: async () => healthy } as unknown as PeerClient]]);
  const subject = await fixture([], { hostId: "studio", peerNodes: ["m5dev", "zdev"],
    spawnPeer: async ({ node }) => clients.get(node)! });
  await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at <= subject.clock.now().getTime()));
  await subject.timers.runDue();
  await eventually(async () => (await subject.store.inspectPrivateRoute(remote.alias))?.registrationMode === "federated_peer");
  blocked.resolve({ ...healthy, routes: [], revision: 0 });
  await subject.close();
});

test("stale removal and succession controls preserve a same-alias replacement", async () => {
  const run = async (operation: "remove" | "succeeds"): Promise<void> => {
    const subject = await fixture([
      new FakeProvider({ provider: "claude", hostId: "this-mac" }),
      new FakeProvider({ provider: "codex", hostId: "this-mac" }),
    ], { seed: async (store) => routed(store, claude, codex) });
    const entered = deferred<void>();
    const release = deferred<void>();
    const removeOwnedRoute = subject.store.removeOwnedRouteAtomic.bind(subject.store);
    try {
      const pending = operation === "remove"
        ? (() => {
            subject.store.removeOwnedRouteAtomic = async (input) => {
              if (input.alias === codex.alias) {
                entered.resolve();
                await release.promise;
              }
              return await removeOwnedRoute(input);
            };
            return subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle });
          })()
        : (() => {
            const original = subject.store.replaceCodexRegistrationAtomic.bind(subject.store);
            subject.store.replaceCodexRegistrationAtomic = async (input) => {
              entered.resolve();
              await release.promise;
              return await original(input);
            };
            return subject.handlers.registerCodex({
              alias: "codex-next@this-mac",
              threadId: THREAD_B,
              hostId: "this-mac",
              busyPolicy: "queue",
              succeedsAlias: codex.alias,
            });
          })();
      await entered.promise;
      await removeOwnedRoute({
        alias: codex.alias,
        binding: (await subject.store.inspectPrivateRoute(codex.alias))!.binding,
      });
      const unrelated = route("codex", codex.alias, THREAD_C, `reg_${operation}_replacement`);
      await subject.store.registerRoute(unrelated);
      release.resolve();
      assert.deepEqual(
        await pending,
        operation === "remove"
          ? { accepted: false, code: "not_found" }
          : { accepted: false, code: "rejected" },
      );
      assert.equal(
        (await subject.store.inspectPrivateRoute(codex.alias))?.binding.registrationId,
        unrelated.binding.registrationId,
      );
      assert.equal(await subject.store.inspectPrivateRoute("codex-next@this-mac"), undefined);
    } finally {
      release.resolve();
      await subject.close();
    }
  };
  await run("remove");
  await run("succeeds");
});

test("confirmed removal atomically terminalizes phase truth", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const queued = await subject.store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      body: "queued",
      dedupeKey: "remove-queued",
    });
    const armedEnqueue = await subject.store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      body: "armed",
      dedupeKey: "remove-armed",
    });
    const acceptedEnqueue = await subject.store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      body: "accepted",
      dedupeKey: "remove-accepted",
    });
    const armed = await subject.store.reserveMessage(codex.alias);
    assert.equal(armed.status, "reserved");
    const accepted = await subject.store.reserveMessage(codex.alias);
    assert.equal(accepted.status, "reserved");
    if (armed.status !== "reserved" || accepted.status !== "reserved") assert.fail("reservation");
    await subject.store.authorizeMessage({
      messageId: armed.attempt.messageId,
      attemptId: armed.attempt.attemptId,
      sourceRegistrationId: armed.attempt.sourceRegistrationId,
      targetRegistrationId: armed.attempt.targetRegistrationId,
      prepared: evidenceFor(armed.attempt.body, "codex_turn_start"),
    });
    await subject.store.authorizeMessage({
      messageId: accepted.attempt.messageId,
      attemptId: accepted.attempt.attemptId,
      sourceRegistrationId: accepted.attempt.sourceRegistrationId,
      targetRegistrationId: accepted.attempt.targetRegistrationId,
      prepared: evidenceFor(accepted.attempt.body, "codex_turn_start"),
    });
    await subject.store.acceptMessage({
      messageId: accepted.attempt.messageId,
      attemptId: accepted.attempt.attemptId,
      lossOutcome: "unconfirmed",
    });
    const removed = await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle });
    assert.deepEqual(removed, { accepted: true, code: "ok" });
    const messages = await subject.store.publicSnapshot();
    const byBody = new Map(messages.messages.map((message) => [message.body, message]));
    assert.equal(byBody.get("accepted")?.state, "cancelled");
    assert.equal(byBody.get("queued")?.state, "ambiguous");
    assert.equal(byBody.get("armed")?.state, "unconfirmed");
    assert.equal(queued.accepted && armedEnqueue.accepted && acceptedEnqueue.accepted, true);
    assert.deepEqual(codexProvider.forgotten, ["reg_codex_a"]);
    assert.deepEqual(claudeProvider.unadvertised, [codex.alias]);
  } finally {
    await subject.close();
  }
});

function evidenceFor(
  body: string,
  kind: GatewayPreparedWriteEvidence["kind"],
): GatewayPreparedWriteEvidence {
  const frame = `frame:${body}`;
  return {
    kind,
    bodyBytes: Buffer.byteLength(body),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    frameBytes: Buffer.byteLength(frame),
    sha256: createHash("sha256").update(frame).digest("hex"),
  };
}

test("same-target FIFO and different-target parallelism hold at the armed boundary", async () => {
  const source = route("codex", "codex-source@this-mac", THREAD_A, "reg_source");
  const peer = route("peer", "peer-one@this-mac", "peer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reg_peer_one");
  const advisor = route("claude", "advisor@this-mac", "00000000-0000-4000-8000-000000000001", "reg_advisor_one");
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const paused = new FakeProvider(
    { provider: "peer", hostId: "this-mac" },
    "pause_armed",
  );
  const parallel = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([codexProvider, paused, parallel], {
    seed: async (store) => {
      await store.registerRoute(source);
      await store.registerRoute(peer);
      await store.registerRoute(advisor);
      await store.enqueueMessage({ sourceAlias: source.alias, targetAlias: peer.alias, body: "first", dedupeKey: "fifo-1" });
      await store.enqueueMessage({ sourceAlias: source.alias, targetAlias: peer.alias, body: "second", dedupeKey: "fifo-2" });
      await store.enqueueMessage({ sourceAlias: source.alias, targetAlias: advisor.alias, body: "parallel", dedupeKey: "parallel" });
    },
  });
  try {
    await paused.pauseEntered.promise;
    await eventually(() => parallel.dispatches.length === 1);
    assert.deepEqual(paused.dispatches.map((dispatch) => dispatch.text), ["first"]);
    assert.deepEqual(parallel.dispatches.map((dispatch) => dispatch.text), ["parallel"]);
    paused.pauseRelease.resolve();
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "first" && message.state === "delivered",
      ),
    );
    await paused.waitForDispatchCount(2);
    assert.equal(
      paused.dispatches.length,
      2,
      JSON.stringify(await subject.service.snapshot()),
    );
    assert.deepEqual(paused.dispatches.map((dispatch) => dispatch.text), ["first", "second"]);
  } finally {
    paused.pauseRelease.resolve();
    await subject.close();
  }
});

test("90s post-write pause keeps control live, advances observers and refuses a late overwrite", async () => {
  const source = route("codex", "codex-source@this-mac", THREAD_A, "reg_source");
  const peer = route("peer", "peer-one@this-mac", "peer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reg_peer_one");
  const advisor = route("claude", "advisor@this-mac", "00000000-0000-4000-8000-000000000001", "reg_advisor_one");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const paused = new FakeProvider({ provider: "peer", hostId: "this-mac" }, "pause_armed");
  const subject = await fixture([claudeProvider, codexProvider, paused], {
    deadlineMs: 120_000,
    seed: async (store) => {
      await store.registerRoute(source);
      await store.registerRoute(peer);
      await store.registerRoute(advisor);
      await store.enqueueMessage({
        sourceAlias: source.alias,
        targetAlias: peer.alias,
        body: "paused-first",
        dedupeKey: "headline-first",
        deadlineAt: "2026-08-16T12:01:00.000Z",
      });
      await store.enqueueMessage({
        sourceAlias: source.alias,
        targetAlias: peer.alias,
        body: "same-target-second",
        dedupeKey: "headline-second",
      });
      await store.enqueueMessage({
        sourceAlias: source.alias,
        targetAlias: advisor.alias,
        body: "unrelated",
        dedupeKey: "headline-unrelated",
      });
    },
  });
  try {
    await paused.pauseEntered.promise;
    await eventually(() => claudeProvider.dispatches.length === 1);
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.find(
        (message) => message.body === "unrelated",
      )?.state === "delivered",
    );
    const during = await subject.service.snapshot();
    assert.equal(during.messages.find((message) => message.body === "paused-first")?.state, "transport_written");
    assert.equal(during.messages.find((message) => message.body === "same-target-second")?.state, "queued");
    assert.equal(during.messages.find((message) => message.body === "unrelated")?.state, "delivered");
    assert.deepEqual(subject.handlers.health(), { status: "ok", revision: 0 });

    codexProvider.callbacks?.onRouteState({
      route: source.binding,
      state: "unobserved",
      observedAt: subject.clock.now().toISOString(),
      safeErrorCode: "OBSERVER_RECONNECTING",
    });
    codexProvider.callbacks?.onRouteState({
      route: source.binding,
      state: "idle",
      observedAt: subject.clock.now().toISOString(),
    });
    await eventually(async () =>
      (await subject.service.snapshot()).routes.find(
        (item) => item.alias === source.alias,
      )?.state === "idle",
    );
    const discoveryBefore = claudeProvider.discoverCalls;
    subject.clock.advance(90_000);
    await subject.timers.runDue();
    codexProvider.callbacks?.onRouteState({
      route: source.binding,
      state: "unobserved",
      observedAt: subject.clock.now().toISOString(),
      safeErrorCode: "OBSERVER_RECONNECTING",
    });
    codexProvider.callbacks?.onRouteState({
      route: source.binding,
      state: "idle",
      observedAt: subject.clock.now().toISOString(),
    });
    await eventually(async () =>
      (await subject.service.snapshot()).routes.find(
        (item) => item.alias === source.alias,
      )?.state === "idle",
    );
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.find(
        (message) => message.body === "paused-first",
      )?.state === "ambiguous",
    );
    assert.ok(claudeProvider.discoverCalls > discoveryBefore);
    assert.equal(
      (await subject.service.snapshot()).routes.find((item) => item.alias === source.alias)?.state,
      "idle",
    );
    assert.deepEqual(paused.dispatches.map((dispatch) => dispatch.text), ["paused-first"]);

    paused.pauseRelease.resolve();
    await eventually(() => paused.dispatches.length === 2);
    await eventually(async () => {
      const snapshot = await subject.store.publicSnapshot();
      return snapshot.messages.find((message) => message.body === "same-target-second")?.state === "delivered";
    });
    const after = await subject.store.publicSnapshot();
    assert.equal(after.messages.find((message) => message.body === "paused-first")?.state, "ambiguous");
  } finally {
    paused.pauseRelease.resolve();
    await subject.close();
  }
});

test("clean prewrite retry waits 500ms while terminal input failure never retries", async () => {
  const retrying = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "defer_once");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, retrying], {
    seed: async (store) => {
      await routed(store, claude, codex);
      await store.enqueueMessage({ sourceAlias: claude.alias, targetAlias: codex.alias, body: "retry", dedupeKey: "retry" });
    },
  });
  try {
    await eventually(() => retrying.dispatches.length === 1);
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.at(-1)?.state === "queued",
    );
    await eventually(() => subject.timers.rows.some((row) => !row.cancelled && row.at === subject.clock.now().getTime() + 500));
    assert.equal(retrying.dispatches.length, 1);
    subject.clock.advance(499);
    await subject.timers.runDue();
    assert.equal(retrying.dispatches.length, 1);
    subject.clock.advance(1);
    await subject.timers.runDue();
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.at(-1)?.state !== "queued",
    );
    await eventually(() => retrying.dispatches.length === 2);
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.at(-1)?.state === "delivered",
    );
  } finally {
    await subject.close();
  }

  const failing = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "fail");
  const otherClaude = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const terminal = await fixture([otherClaude, failing], {
    seed: async (store) => {
      await routed(store, claude, codex);
      await store.enqueueMessage({ sourceAlias: claude.alias, targetAlias: codex.alias, body: "invalid", dedupeKey: "invalid" });
    },
  });
  try {
    await eventually(() => failing.dispatches.length === 1);
    terminal.clock.advance(5_000);
    await terminal.timers.runDue();
    assert.equal(failing.dispatches.length, 1);
    assert.equal((await terminal.store.publicSnapshot()).messages.at(-1)?.safeErrorCode, "INPUT_INVALID");
  } finally {
    await terminal.close();
  }

  const providerSpecificCodes = [
    "CLAUDE_PEER_TARGET_UNKNOWN",
    "CLAUDE_PEER_TARGET_STALE",
    "CLAUDE_PEER_TARGET_CHANGED",
    "CLAUDE_PEER_WORKSPACE_UNATTESTED",
    "UNRULED_DEFERRED_CODE",
  ];
  const provider = new FakeProvider(
    { provider: "codex", hostId: "this-mac" },
    "defer_once",
  );
  provider.deferAlways = true;
  const table = await fixture([
    new FakeProvider({ provider: "claude", hostId: "this-mac" }),
    provider,
  ], { seed: async (store) => routed(store, claude, codex) });
  try {
    for (const [index, code] of providerSpecificCodes.entries()) {
      provider.deferredCode = code;
      const sent = await table.handlers.send({
        fromAlias: claude.alias,
        toAlias: codex.alias,
        text: `deferred ${code}`,
        replyAddress: "uds:/test/claude-reply.sock",
        expectsReply: false,
      });
      assert.equal(sent.accepted, true);
      await provider.waitForDispatchCount(index + 1);
      await eventually(async () => {
        const status = await table.handlers.deliveryStatus({ token: sent.deliveryToken });
        return status.found && status.terminal &&
          status.state === "failed" && status.safeErrorCode === code;
      });
    }
    table.clock.advance(table.config.limits.messageDeadlineMs);
    await table.timers.runDue();
    assert.equal(provider.dispatches.length, providerSpecificCodes.length);
  } finally {
    await table.close();
  }
});

test("Codex correlated acceptance is durable before terminal and removal binds its loss outcome", async () => {
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "pause_accepted");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => {
      await routed(store, claude, codex);
      await store.enqueueMessage({ sourceAlias: claude.alias, targetAlias: codex.alias, body: "accepted", dedupeKey: "accepted" });
    },
  });
  try {
    await codexProvider.pauseEntered.promise;
    const accepted = await subject.store.publicSnapshot();
    assert.equal(accepted.messages.at(-1)?.state, "transport_written");
    await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle });
    const terminal = await subject.store.publicSnapshot();
    assert.equal(terminal.messages.at(-1)?.state, "unconfirmed");
    codexProvider.pauseRelease.resolve();
    await eventually(() => codexProvider.dispatches.length === 1);
    assert.equal((await subject.store.publicSnapshot()).messages.at(-1)?.state, "unconfirmed");
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("three STEER writes reach the exact accepted Codex operation while ordinary FIFO is paused", async () => {
  const codexProvider = new FakeProvider(
    { provider: "codex", hostId: "this-mac" },
    "pause_accepted",
  );
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const start = await subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "long running start",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: false,
    });
    assert.equal(start.accepted, true);
    await codexProvider.pauseEntered.promise;
    for (let index = 1; index <= 3; index += 1) {
      const steer = await subject.handlers.send({
        fromAlias: claude.alias,
        toAlias: codex.alias,
        text: `STEER: correction ${index}`,
        replyAddress: "uds:/test/claude-reply.sock",
        expectsReply: false,
      });
      assert.equal(steer.accepted, true);
    }
    await eventually(() => codexProvider.dispatches.filter((row) => row.steer === true).length === 3);
    const steerAttempts = codexProvider.dispatches
      .filter((row) => row.steer === true)
      .map((row) => row.attemptId);
    assert.equal(new Set(steerAttempts).size, 3);
    assert.equal(codexProvider.dispatches[0]?.text, "long running start");

    const fourth = await subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "STEER: correction 4",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: false,
    });
    assert.equal(fourth.accepted, true);
    await eventually(() => codexProvider.dispatches.filter(
      (row) => row.text === "STEER: correction 4",
    ).length === 1);
    const fourthStatus = await subject.handlers.deliveryStatus({ token: fourth.deliveryToken });
    assert.equal(fourthStatus.found && fourthStatus.state, "queued");
    codexProvider.pauseRelease.resolve();
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("exact-leading native STEER uses the separate lane while native mail stays FIFO", async () => {
  const codexProvider = new FakeProvider(
    { provider: "codex", hostId: "this-mac" },
    "pause_accepted",
  );
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const native = (text: string): void => claudeProvider.callbacks?.onClaudeMessage?.({
    endpoint: {
      provider: "claude",
      hostId: "this-mac",
      routeHandle: claude.binding.routeHandle,
    },
    sourceAlias: claude.alias,
    targetAlias: codex.alias,
    text,
  });
  try {
    assert.equal((await subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "paused native lane owner",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: false,
    })).accepted, true);
    await codexProvider.pauseEntered.promise;
    native("ordinary native FIFO");
    await eventually(async () => (await subject.store.publicSnapshot()).messages.some(
      (message) => message.body === "ordinary native FIFO" && message.state === "queued",
    ));
    native("STEER: exact native correction");
    await eventually(() => codexProvider.dispatches.some(
      (dispatch) => dispatch.text === "STEER: exact native correction" && dispatch.steer === true,
    ));
    assert.equal(codexProvider.dispatches.some(
      (dispatch) => dispatch.text === "ordinary native FIFO",
    ), false);
    codexProvider.pauseRelease.resolve();
    await eventually(() => codexProvider.dispatches.some(
      (dispatch) => dispatch.text === "ordinary native FIFO" && dispatch.steer !== true,
    ));
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("retiring a route after authorization makes the exact armed attempt ambiguous", async () => {
  const source = route("codex", "codex-source@this-mac", THREAD_A, "reg_source");
  const peer = route("peer", "peer-one@this-mac", "peer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reg_peer_one");
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const peerProvider = new FakeProvider({ provider: "peer", hostId: "this-mac" }, "pause_armed");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider, peerProvider], {
    seed: async (store) => {
      await routed(store, source, peer);
      await store.enqueueMessage({ sourceAlias: source.alias, targetAlias: peer.alias, body: "armed", dedupeKey: "retire" });
    },
  });
  try {
    await peerProvider.pauseEntered.promise;
    const result = await subject.handlers.unregisterCodex({ alias: source.alias, threadId: THREAD_A });
    assert.deepEqual(result, { accepted: true, code: "ok" });
    assert.equal((await subject.store.publicSnapshot()).messages.at(-1)?.state, "ambiguous");
    peerProvider.pauseRelease.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await subject.store.publicSnapshot()).messages.at(-1)?.state, "ambiguous");
  } finally {
    peerProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("shutdown closes providers and store without joining a stuck model turn", async () => {
  const stuck = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "never");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, stuck], {
    seed: async (store) => {
      await routed(store, claude, codex);
      await store.enqueueMessage({ sourceAlias: claude.alias, targetAlias: codex.alias, body: "never", dedupeKey: "never" });
    },
  });
  await eventually(() => stuck.dispatches.length === 1);
  await Promise.race([
    subject.service.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close joined turn")), 1_000)),
  ]);
  assert.equal(stuck.closeCalls, 1);
  assert.equal(claudeProvider.closeCalls, 1);
  await rm(subject.root, { recursive: true, force: true });
});

test("delivery status and public observations stay native-ID-free", async () => {
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" }, "pause_accepted");
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const send = await subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "private body",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: true,
    });
    assert.equal(send.accepted, true);
    if (!send.accepted) assert.fail("send rejected");
    await codexProvider.pauseEntered.promise;
    const status = await subject.handlers.deliveryStatus({ token: send.deliveryToken });
    assert.equal(status.found && status.state, "stalled");
    const observation = await subject.service.observeSnapshot();
    assert.equal(JSON.stringify(observation).includes(THREAD_A), false);
    assert.equal(JSON.stringify(observation).includes("reg_codex_a"), false);
    codexProvider.pauseRelease.resolve();
    await eventually(async () => {
      const current = await subject.handlers.deliveryStatus({ token: send.deliveryToken });
      return current.found && current.state === "delivered";
    });
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("a foreign managed-socket holder degrades Codex with MANAGED_CODEX_UNAVAILABLE", async () => {
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([codexProvider], {
    seed: async (store) => store.registerRoute(codex),
    managedCodexSocketHeld: async () => true,
  });
  const connector = async () => (await subject.service.snapshot()).connectors[0]!;
  try {
    assert.equal((await connector()).health, "degraded");
    assert.equal((await connector()).safeErrorCode, "MANAGED_CODEX_UNAVAILABLE");
    codexProvider.callbacks?.onRouteState({
      route: codex.binding,
      state: "unobserved",
      observedAt: subject.clock.now().toISOString(),
      safeErrorCode: "THREAD_NOT_OBSERVED",
    });
    await eventually(async () => (await connector()).safeErrorCode === "THREAD_NOT_OBSERVED");
    codexProvider.callbacks?.onRouteState({
      route: codex.binding,
      state: "idle",
      observedAt: subject.clock.now().toISOString(),
    });
    await eventually(async () => (await connector()).safeErrorCode === "MANAGED_CODEX_UNAVAILABLE");
    subject.clock.advance(CONNECTOR_OBSERVATION_STALE_AFTER_MS + 1);
    assert.equal((await connector()).health, "degraded");
    assert.equal((await connector()).safeErrorCode, "CONNECTOR_OBSERVATION_STALE");
    assert.equal(Object.hasOwn(await connector(), "codexDoctor"), false);
  } finally {
    await subject.close();
  }
});

test("TRACK: and DONE: prefixes are ordinary body text and the snapshot carries no watch keys", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const opened = await subject.handlers.send({
      fromAlias: codex.alias, threadId: THREAD_A, toAlias: claude.alias,
      text: "TRACK: compile the release", expectsReply: true,
    });
    assert.equal(opened.accepted, true);
    if (!opened.accepted) assert.fail("send admission");
    await eventually(() => claudeProvider.dispatches.length === 1);
    assert.equal(claudeProvider.dispatches[0]?.text, "TRACK: compile the release");
    assert.equal(Object.hasOwn(claudeProvider.dispatches[0] ?? {}, "progressWatchActive"), false);
    const done = await subject.handlers.reply({
      conversationId: opened.conversationId, text: "DONE: complete",
      caller: { kind: "claude", alias: claude.alias, replyAddress: "uds:/test/claude-reply.sock" },
    });
    assert.equal(done.accepted, true);
    await eventually(() => codexProvider.dispatches.length === 1);
    assert.equal(codexProvider.dispatches[0]?.text, "DONE: complete");
    const snapshot = await subject.service.snapshot();
    for (const key of ["progressWatches", "progressWatchEvents"]) {
      assert.equal(Object.hasOwn(snapshot, key), false, key);
      assert.equal(Object.hasOwn(snapshot.truncation, key), false, key);
    }
    assert.equal(JSON.stringify(snapshot).includes("progressWatch"), false);
  } finally { await subject.close(); }
});

test("Claude reply correlation buffers fast replies and preserves FIFO across a clean retry", async () => {
  const retryingClaude = new FakeProvider(
    { provider: "claude", hostId: "this-mac" },
    "defer_once",
  );
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([retryingClaude, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const first = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "first question",
      expectsReply: true,
    });
    assert.equal(first.accepted, true);
    await eventually(() => retryingClaude.dispatches.length === 1);
    await eventually(() => subject.timers.rows.some(
      (row) => !row.cancelled && row.at <= subject.clock.now().getTime() + 500,
    ));
    subject.clock.advance(500);
    await subject.timers.runDue();
    await eventually(() => retryingClaude.dispatches.length === 2);
    const second = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "second question",
      expectsReply: true,
    });
    assert.equal(second.accepted, true);
    await eventually(() => retryingClaude.dispatches.length === 3);
    for (const text of ["first answer", "second answer"]) {
      retryingClaude.callbacks?.onClaudeReply({
        endpoint: {
          provider: "claude",
          hostId: "this-mac",
          routeHandle: claude.binding.routeHandle,
        },
        text,
      });
    }
    await eventually(() => codexProvider.dispatches.length === 2);
    assert.deepEqual(
      codexProvider.dispatches.map((dispatch) => dispatch.text),
      ["first answer", "second answer"],
    );
    const third = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "old source question",
      expectsReply: true,
    });
    assert.equal(third.accepted, true);
    await eventually(() => retryingClaude.dispatches.length === 4);
    assert.deepEqual(await subject.handlers.registerCodex({
      alias: "codex-next@this-mac",
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
      succeedsAlias: codex.alias,
    }), { accepted: true, code: "ok" });
    const fourth = await subject.handlers.send({
      fromAlias: "codex-next@this-mac",
      threadId: THREAD_B,
      toAlias: claude.alias,
      text: "new source question",
      expectsReply: true,
    });
    assert.equal(fourth.accepted, true);
    await eventually(() => retryingClaude.dispatches.length === 5);
    await eventually(async () => {
      if (!fourth.accepted) return false;
      const status = await subject.handlers.deliveryStatus({ token: fourth.deliveryToken });
      return status.found && status.state === "delivered";
    });
    retryingClaude.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "late old-source answer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(codexProvider.dispatches.length, 2);
    retryingClaude.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "new source answer",
    });
    await eventually(() => codexProvider.dispatches.length === 3);
    assert.equal(codexProvider.dispatches.at(-1)?.text, "new source answer");

    const fifth = await subject.handlers.send({
      fromAlias: "codex-next@this-mac",
      threadId: THREAD_B,
      toAlias: claude.alias,
      text: "retired target question",
      expectsReply: true,
    });
    assert.equal(fifth.accepted, true);
    await eventually(() => retryingClaude.dispatches.length === 6);
    // Another session takes the name: the old route is displaced, so the
    // retired session's late reply has nowhere to land.
    await subject.store.installClaudeRoute(
      route("claude", claude.alias, "claude-session-retired", "reg_claude_retired"));
    retryingClaude.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "late old-target answer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(codexProvider.dispatches.length, 3);
  } finally {
    await subject.close();
  }
});

test("a Claude reply arriving inside the authorized write is released only after delivered", async () => {
  const fastClaude = new FakeProvider(
    { provider: "claude", hostId: "this-mac" },
    "fast_reply",
  );
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([fastClaude, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const send = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "fast question",
      expectsReply: true,
    });
    assert.equal(send.accepted, true);
    await eventually(() => codexProvider.dispatches.length === 1);
    assert.equal(codexProvider.dispatches[0]?.text, "fast native reply");
  } finally {
    await subject.close();
  }
});

test("an ambiguous armed Claude write keeps its FIFO tombstone across source succession", async () => {
  const claudeProvider = new FakeProvider(
    { provider: "claude", hostId: "this-mac" },
    "pause_armed",
  );
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const first = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "armed old source",
      expectsReply: true,
    });
    assert.equal(first.accepted, true);
    await claudeProvider.pauseEntered.promise;
    assert.deepEqual(await subject.handlers.registerCodex({
      alias: "codex-next@this-mac",
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
      succeedsAlias: codex.alias,
    }), { accepted: true, code: "ok" });
    const second = await subject.handlers.send({
      fromAlias: "codex-next@this-mac",
      threadId: THREAD_B,
      toAlias: claude.alias,
      text: "new source after ambiguity",
      expectsReply: true,
    });
    assert.equal(second.accepted, true);
    claudeProvider.pauseRelease.resolve();
    await eventually(() => claudeProvider.dispatches.length === 2);
    await eventually(async () => {
      if (!second.accepted) return false;
      const status = await subject.handlers.deliveryStatus({ token: second.deliveryToken });
      return status.found && status.state === "delivered";
    });
    claudeProvider.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "late ambiguous answer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(codexProvider.dispatches.length, 0);
    claudeProvider.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "new exact answer",
    });
    await eventually(() => codexProvider.dispatches.length === 1);
    assert.equal(codexProvider.dispatches[0]?.text, "new exact answer");
  } finally {
    claudeProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("an ambiguous armed Claude write consumes one late reply after the source re-registers", async () => {
  const claudeProvider = new FakeProvider(
    { provider: "claude", hostId: "this-mac" },
    "pause_armed",
  );
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const first = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "armed before the source retires",
      expectsReply: true,
    });
    assert.equal(first.accepted, true);
    await claudeProvider.pauseEntered.promise;
    // Retiring the source makes the armed write ambiguous while the target's
    // installed route survives; the same task re-registers under its alias.
    assert.deepEqual(await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: THREAD_A }), {
      accepted: true,
      code: "ok",
    });
    assert.deepEqual(await subject.handlers.registerCodex({ alias: codex.alias, threadId: THREAD_A,
      hostId: "this-mac", busyPolicy: "queue" }), {
      accepted: true,
      code: "ok",
    });
    claudeProvider.pauseRelease.resolve();
    const second = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "after the source re-registers",
      expectsReply: true,
    });
    assert.equal(second.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 2);
    await eventually(async () => {
      if (!second.accepted) return false;
      const status = await subject.handlers.deliveryStatus({ token: second.deliveryToken });
      return status.found && status.state === "delivered";
    });
    for (const text of ["late ambiguous reply", "current reply"]) {
      claudeProvider.callbacks?.onClaudeReply({
        endpoint: {
          provider: "claude",
          hostId: "this-mac",
          routeHandle: claude.binding.routeHandle,
        },
        text,
      });
    }
    await eventually(() => codexProvider.dispatches.length === 1);
    assert.equal(codexProvider.dispatches[0]?.text, "current reply");
  } finally {
    claudeProvider.pauseRelease.resolve();
    await subject.close();
  }
});

test("a correlated Claude reply cannot cross a same-alias registration replacement", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const enqueue = subject.store.enqueueMessage.bind(subject.store);
  subject.store.enqueueMessage = async (input) => {
    if (input.body === "racing old reply") {
      entered.resolve();
      await release.promise;
    }
    return await enqueue(input);
  };
  try {
    const sent = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "question before replacement",
      expectsReply: true,
    });
    assert.equal(sent.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 1);
    await eventually(async () => {
      if (!sent.accepted) return false;
      const status = await subject.handlers.deliveryStatus({ token: sent.deliveryToken });
      return status.found && status.state === "delivered";
    });
    claudeProvider.callbacks?.onClaudeReply({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      text: "racing old reply",
    });
    await entered.promise;
    assert.deepEqual(
      await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle }),
      { accepted: true, code: "ok" },
    );
    assert.deepEqual(await subject.handlers.registerCodex({
      alias: codex.alias,
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
    }), { accepted: true, code: "ok" });
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(codexProvider.dispatches.length, 0);
    assert.equal(
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "racing old reply",
      ),
      false,
    );
  } finally {
    release.resolve();
    await subject.close();
  }
});

test("an initial send cannot inherit a same-alias caller replacement after attestation", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const enqueue = subject.store.enqueueMessage.bind(subject.store);
  subject.store.enqueueMessage = async (input) => {
    if (input.body === "racing initial send") {
      entered.resolve();
      await release.promise;
    }
    return await enqueue(input);
  };
  try {
    const sending = subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "racing initial send",
      expectsReply: false,
    });
    await entered.promise;
    await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle });
    await subject.handlers.registerCodex({
      alias: codex.alias,
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
    });
    release.resolve();
    assert.deepEqual(await sending, { accepted: false, code: "rejected", reason: "ROUTE_UNREGISTERED" });
    assert.equal(
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "racing initial send",
      ),
      false,
    );
  } finally {
    release.resolve();
    await subject.close();
  }
});

test("a reply-address send cannot cross a same-alias Claude route replacement", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const enqueue = subject.store.enqueueMessage.bind(subject.store);
  subject.store.enqueueMessage = async (input) => {
    if (input.body === "racing reply-address send") {
      entered.resolve();
      await release.promise;
    }
    return await enqueue(input);
  };
  try {
    const sending = subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "racing reply-address send",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: false,
    });
    await entered.promise;
    await subject.store.installClaudeRoute(
      route("claude", claude.alias, "claude-session-replacement", "reg_claude_replacement"));
    release.resolve();
    assert.deepEqual(await sending, { accepted: false, code: "rejected", reason: "ROUTE_UNREGISTERED" });
    assert.equal(
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "racing reply-address send",
      ),
      false,
    );
  } finally {
    release.resolve();
    await subject.close();
  }
});

test("reply attestation and an old conversation token cannot cross same-alias replacement", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const opened = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "open exact conversation",
      expectsReply: false,
    });
    if (!opened.accepted) assert.fail("conversation admission");
    await eventually(async () => {
      const status = await subject.handlers.deliveryStatus({ token: opened.deliveryToken });
      return status.found && status.state === "delivered";
    });
    const enqueue = subject.store.enqueueMessage.bind(subject.store);
    subject.store.enqueueMessage = async (input) => {
      if (input.body === "racing explicit reply") {
        entered.resolve();
        await release.promise;
      }
      return await enqueue(input);
    };
    const replying = subject.handlers.reply({
      conversationId: opened.conversationId,
      text: "racing explicit reply",
      caller: { kind: "codex", alias: codex.alias, threadId: THREAD_A },
    });
    await entered.promise;
    await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle });
    await subject.handlers.registerCodex({
      alias: codex.alias,
      threadId: THREAD_B,
      hostId: "this-mac",
      busyPolicy: "queue",
    });
    release.resolve();
    assert.deepEqual(await replying, { accepted: false, code: "rejected", reason: "ROUTE_UNREGISTERED" });
    assert.deepEqual(await subject.handlers.reply({
      conversationId: opened.conversationId,
      text: "reuse retired token",
      caller: { kind: "codex", alias: codex.alias, threadId: THREAD_B },
    }), { accepted: false, code: "rejected", reason: "CONVERSATION_ROUTE_RETIRED" });
    assert.equal(
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "racing explicit reply" ||
          message.body === "reuse retired token",
      ),
      false,
    );
  } finally {
    release.resolve();
    await subject.close();
  }
});

test("selected Claude replies require an exact inherited reply capability", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const opened = await subject.handlers.send({
      fromAlias: codex.alias,
      threadId: THREAD_A,
      toAlias: claude.alias,
      text: "open selected Claude reply",
      expectsReply: false,
    });
    if (!opened.accepted) assert.fail("conversation admission");
    assert.deepEqual(await subject.handlers.reply({
      conversationId: opened.conversationId,
      text: "alias only",
      caller: { kind: "claude", alias: claude.alias },
    }), { accepted: false, code: "route_mismatch", reason: "CLAUDE_REPLY_ADDRESS_INVALID" });
    claudeProvider.replyRouteHandle = "stale-claude-session";
    assert.deepEqual(await subject.handlers.reply({
      conversationId: opened.conversationId,
      text: "stale capability",
      caller: {
        kind: "claude",
        alias: claude.alias,
        replyAddress: "uds:/test/stale.sock",
      },
    }), { accepted: false, code: "route_mismatch", reason: "CLAUDE_REPLY_ADDRESS_INVALID" });
    claudeProvider.replyRouteHandle = claude.binding.routeHandle;
    const accepted = await subject.handlers.reply({
      conversationId: opened.conversationId,
      text: "exact capability",
      caller: {
        kind: "claude",
        alias: claude.alias,
        replyAddress: "uds:/test/exact.sock",
      },
    });
    assert.equal(accepted.accepted, true);
    await eventually(() => codexProvider.dispatches.some(
      (dispatch) => dispatch.text === "exact capability",
    ));
  } finally {
    await subject.close();
  }
});

test("native receipt settlement precedes teardown and closing ingress cannot persist mail", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider(
    { provider: "codex", hostId: "this-mac" },
    "pause_accepted",
  );
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    claudeProvider.effects.length = 0;
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "native work",
      receiptHandle: "receipt-one",
    });
    await codexProvider.pauseEntered.promise;
    subject.clock.advance(2_500);
    await subject.timers.runDue();
    assert.deepEqual(
      await subject.handlers.unregisterCodex({ alias: codex.alias, threadId: codex.binding.routeHandle }),
      { accepted: true, code: "ok" },
    );
    await eventually(() => claudeProvider.unadvertised.includes(codex.alias));
    assert.deepEqual(claudeProvider.effects, [
      "status:receipt-one:held",
      "stall:receipt-one:ROUTE_UNAVAILABLE:2500",
      "status:receipt-one:expired",
      "release:receipt-one",
      `unadvertise:${codex.alias}`,
    ]);
    codexProvider.pauseRelease.resolve();
    await subject.service.close();
    const statePath = path.join(subject.config.stateDir, "gateway-state.json");
    const beforeClosedIngress = await readFile(statePath, "utf8");
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "after close",
      receiptHandle: "receipt-two",
    });
    await eventually(() => claudeProvider.effects.includes("release:receipt-two"));
    assert.equal(await readFile(statePath, "utf8"), beforeClosedIngress);
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.service.close();
    await rm(subject.root, { recursive: true, force: true });
  }
});

test("provider replyText reverses an exact native ingress through the sender's installed route", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  codexProvider.terminalReplyText = "correlated result";
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "native request",
      receiptHandle: "receipt-native-reply",
    });
    await eventually(() => claudeProvider.dispatches.length === 1);
    assert.equal(claudeProvider.dispatches[0]?.text, "correlated result");
    // The native sender's route was installed by its own send, so the reverse
    // leg is an ordinary routed dispatch, not a transient native reply.
    assert.equal(claudeProvider.dispatches[0]?.authorization, "selected_route");
    assert.equal(
      claudeProvider.dispatches[0]?.binding.registrationId,
      claude.binding.registrationId,
    );
    await eventually(() => claudeProvider.effects.includes("release:receipt-native-reply"));
    assert.deepEqual(claudeProvider.effects.slice(0, 2), [
      "status:receipt-native-reply:delivered",
      "release:receipt-native-reply",
    ]);
    subject.clock.advance(3_000);
    await subject.timers.runDue();
    assert.equal(claudeProvider.effects.some((row) => row.includes(":held")), false);
    assert.equal(claudeProvider.effects.some((row) => row.startsWith("stall:")), false);

    codexProvider.terminalReplyText = undefined;
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "native explicit request",
    });
    await eventually(() => codexProvider.dispatches.length === 2);
    const explicit = await subject.handlers.reply({
      conversationId: codexProvider.dispatches[1]!.conversationId,
      text: "explicit native reply",
      caller: { kind: "codex", alias: codex.alias, threadId: THREAD_A },
    });
    assert.equal(explicit.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 2);
    assert.equal(claudeProvider.dispatches[1]?.text, "explicit native reply");

    const receiptEntered = deferred<void>();
    const receiptRelease = deferred<void>();
    const updateStatus = claudeProvider.updateNativeInboundStatus.bind(claudeProvider);
    claudeProvider.updateNativeInboundStatus = async (handle, status) => {
      if (handle === "receipt-native-race" && status === "delivered") {
        receiptEntered.resolve();
        await receiptRelease.promise;
      }
      await updateStatus(handle, status);
    };
    codexProvider.terminalReplyText = "racing native result";
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "native replacement race",
      receiptHandle: "receipt-native-race",
    });
    await receiptEntered.promise;
    await subject.store.removeOwnedRouteAtomic({
      alias: codex.alias,
      binding: (await subject.store.inspectPrivateRoute(codex.alias))!.binding,
    });
    const replacement = route("codex", codex.alias, THREAD_B, "reg_codex_race");
    await subject.store.registerRoute(replacement);
    receiptRelease.resolve();
    await eventually(() => claudeProvider.effects.includes("release:receipt-native-race"));
    assert.equal(claudeProvider.dispatches.length, 2);
  } finally {
    await subject.close();
  }
});

test("a never-routed native sender is replied to through its installed route", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  claudeProvider.claudeDiscovery = { alias: "visitor@this-mac", routeHandle: "visitor-session",
    kind: "interactive", state: "idle" };
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => store.registerRoute(codex),
  });
  try {
    // Nobody ever selected this session; its route installs on its own send.
    assert.equal(await subject.store.inspectPrivateRoute("visitor@this-mac"), undefined);
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: "visitor-session",
      },
      sourceAlias: "visitor@this-mac",
      targetAlias: codex.alias,
      text: "native request from a new session",
    });
    await eventually(() => codexProvider.dispatches.length === 1);
    const installed = await subject.store.inspectPrivateRoute("visitor@this-mac");
    assert.equal(installed?.registrationMode, "selected_live_peer");
    assert.equal(installed?.binding.routeHandle, "visitor-session");
    const reply = await subject.handlers.reply({
      conversationId: codexProvider.dispatches[0]!.conversationId,
      text: "reply to a never-selected session",
      caller: { kind: "codex", alias: codex.alias, threadId: THREAD_A },
    });
    assert.equal(reply.accepted, true);
    await eventually(() => claudeProvider.dispatches.length === 1);
    assert.equal(claudeProvider.dispatches[0]?.authorization, "selected_route");
    assert.equal(claudeProvider.dispatches[0]?.text, "reply to a never-selected session");
    assert.equal(claudeProvider.dispatches[0]?.binding.registrationId, installed?.binding.registrationId);
  } finally {
    await subject.close();
  }
});

test("shutdown cancels a queued native receipt before closing its helper", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider(
    { provider: "codex", hostId: "this-mac" },
    "pause_accepted",
  );
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  try {
    const blocking = await subject.handlers.send({
      fromAlias: claude.alias,
      toAlias: codex.alias,
      text: "block target",
      replyAddress: "uds:/test/claude-reply.sock",
      expectsReply: false,
    });
    assert.equal(blocking.accepted, true);
    await codexProvider.pauseEntered.promise;
    claudeProvider.effects.length = 0;
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "queued native",
      receiptHandle: "receipt-queued",
    });
    await eventually(async () =>
      (await subject.store.publicSnapshot()).messages.some(
        (message) => message.body === "queued native",
      ),
    );
    subject.clock.advance(1_000);
    await subject.timers.runDue();
    await eventually(() => claudeProvider.effects.includes("status:receipt-queued:held"));
    await subject.service.close();
    const denied = claudeProvider.effects.indexOf("status:receipt-queued:expired");
    const released = claudeProvider.effects.indexOf("release:receipt-queued");
    const closed = claudeProvider.effects.indexOf("close:claude");
    assert.ok(denied >= 0 && released > denied && closed > released);
    subject.clock.advance(5_000);
    await subject.timers.runDue();
    assert.equal(
      claudeProvider.effects.filter((row) => row.startsWith("stall:receipt-queued")).length,
      0,
    );
  } finally {
    codexProvider.pauseRelease.resolve();
    await subject.service.close();
    await rm(subject.root, { recursive: true, force: true });
  }
});

test("shutdown fences native ingress that is still crossing the durable enqueue boundary", async () => {
  const claudeProvider = new FakeProvider({ provider: "claude", hostId: "this-mac" });
  const codexProvider = new FakeProvider({ provider: "codex", hostId: "this-mac" });
  const subject = await fixture([claudeProvider, codexProvider], {
    seed: async (store) => routed(store, claude, codex),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = subject.store.enqueueNativeIngress.bind(subject.store);
  subject.store.enqueueNativeIngress = async (input) => {
    entered.resolve();
    await release.promise;
    return await original(input);
  };
  try {
    claudeProvider.effects.length = 0;
    claudeProvider.callbacks?.onClaudeMessage?.({
      endpoint: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: claude.binding.routeHandle,
      },
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      text: "crossing commit",
      receiptHandle: "receipt-crossing",
    });
    await entered.promise;
    let closed = false;
    const closing = subject.service.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release.resolve();
    await closing;
    assert.deepEqual(claudeProvider.effects, [
      "status:receipt-crossing:expired",
      "release:receipt-crossing",
      "close:claude",
    ]);
  } finally {
    release.resolve();
    await subject.service.close();
    await rm(subject.root, { recursive: true, force: true });
  }
});

test("restart composes queued, reserved, armed, and accepted phase truth without replay", async () => {
  const runCase = async (
    phase: "queued" | "reserved" | "armed" | "accepted",
    terminalState: "delivered" | "ambiguous" | "unconfirmed",
  ): Promise<void> => {
    const codexMode: DispatchMode = phase === "reserved"
      ? "never"
      : phase === "accepted"
        ? "pause_accepted"
        : "deliver";
    const firstClaude = new FakeProvider(
      { provider: "claude", hostId: "this-mac" },
      phase === "armed" ? "pause_armed" : "deliver",
    );
    const firstCodex = new FakeProvider({ provider: "codex", hostId: "this-mac" }, codexMode);
    const subject = await fixture([firstClaude, firstCodex], {
      seed: async (store) => routed(store, claude, codex),
    });
    let token: string;
    if (phase === "queued") {
      const queued = await subject.store.enqueueMessage({
        sourceAlias: claude.alias,
        targetAlias: codex.alias,
        body: `restart ${phase}`,
        dedupeKey: `restart-${phase}`,
      });
      if (!queued.accepted || queued.deliveryToken === undefined) assert.fail("queued admission");
      token = queued.deliveryToken;
    } else {
      const sent = phase === "armed"
        ? await subject.handlers.send({
            fromAlias: codex.alias,
            threadId: THREAD_A,
            toAlias: claude.alias,
            text: `restart ${phase}`,
            expectsReply: false,
          })
        : await subject.handlers.send({
            fromAlias: claude.alias,
            toAlias: codex.alias,
            text: `restart ${phase}`,
            replyAddress: "uds:/test/claude-reply.sock",
            expectsReply: false,
          });
      if (!sent.accepted) assert.fail("send admission");
      token = sent.deliveryToken;
      if (phase === "reserved") await eventually(() => firstCodex.dispatches.length === 1);
      else if (phase === "armed") await firstClaude.pauseEntered.promise;
      else await firstCodex.pauseEntered.promise;
    }
    await subject.service.close();

    const secondStore = new GatewayStore(subject.config, {
      now: subject.clock.now,
      randomId: subject.clock.randomId,
    });
    await secondStore.initialize();
    const secondClaude = new FakeProvider({ provider: "claude", hostId: "this-mac" });
    const secondCodex = new FakeProvider({ provider: "codex", hostId: "this-mac" });
    const secondService = new GatewayService({
      config: subject.config,
      adapters: [secondClaude, secondCodex],
      store: secondStore,
      now: subject.clock.now,
      timers: new TestTimers(subject.clock),
    });
    await secondService.start();
    const secondHandlers = secondService.handlers();
    const restartedTarget = phase === "armed" ? secondClaude : secondCodex;
    if (terminalState === "delivered") {
      await eventually(() => restartedTarget.dispatches.length === 1);
      await eventually(async () => {
        const status = await secondHandlers.deliveryStatus({ token });
        return status.found && status.state === "delivered";
      });
    } else {
      const status = await secondHandlers.deliveryStatus({ token });
      assert.equal(status.found && status.state, terminalState);
      assert.equal(restartedTarget.dispatches.length, 0);
    }
    const firstTarget = phase === "armed" ? firstClaude : firstCodex;
    assert.equal(firstTarget.writes + restartedTarget.writes, 1);
    await secondService.close();
    await rm(subject.root, { recursive: true, force: true });
  };

  await runCase("queued", "delivered");
  await runCase("reserved", "delivered");
  await runCase("armed", "ambiguous");
  await runCase("accepted", "unconfirmed");
});
