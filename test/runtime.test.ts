import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ClaudePeerAdapter } from "../src/gateway/claude-peer.js";
import type { StatelessCodexOperationTransport } from "../src/gateway/codex-stateless-transport.js";
import type { GatewayInstanceLease } from "../src/gateway/instance-lease.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { Ledger, ledgerDefaults, type Endpoint } from "../src/gateway/ledger.js";
import { requestLocalControl } from "../src/gateway/local-control.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";
import { runCoreRuntime, type CoreRuntimeDependencies } from "../src/gateway/runtime.js";
import { createCodexDiscoveryObserver } from "../src/gateway/codex-discovery.js";
import { isBrokerResult } from "../src/gateway/broker-control.js";
import { LocalCodexTransportError } from "../src/gateway/codex-local-transport.js";

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

test("refresh preserves Claude and SSH success when the real Codex observer cannot find a daemon", async (t) => {
  const f = await fixture(t), stop = new AbortController(); let catalogs = 0;
  await runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal, onReady: async () => {
    try {
      const call = async (method: string) => await requestLocalControl({ stateDir: f.stateDir, socketPath: f.socketPath,
        request: { method, params: {} }, mutating: method === "refresh_discovery" }) as { ok: boolean; result: {
          routes: Array<{ alias: string }>; codex: { safeErrorCode: string; complete: boolean }; health: string;
        } };
      const refreshed = await call("refresh_discovery"); assert.equal(refreshed.ok, true);
      assert.equal(refreshed.result.routes[0]?.alias, "advisor@local"); assert.equal(catalogs, 1);
      const snapshot = await call("list_snapshot"); assert.equal(snapshot.ok, true);
      assert.equal(snapshot.result.codex.safeErrorCode, "MANAGED_CODEX_UNAVAILABLE");
      assert.equal(snapshot.result.codex.complete, false); assert.equal(snapshot.result.health, "healthy");
    } finally { stop.abort(); }
  } }, { ...f.dependencies,
    createClaudePeer: (native, config) => ({ ...f.dependencies.createClaudePeer!(native, config), discover: async () => ({
      peers: [{ targetId: "00000000-0000-4000-8000-000000000050", alias: "advisor", kind: "bg", status: "idle", compatibility: "compatible" }],
      rejected: {}, truncated: false, entriesScanned: 1, parseableRecords: 1,
    }) }),
    createCodexDiscovery: (options) => createCodexDiscoveryObserver(options, { createFactory: async () => {
      throw new LocalCodexTransportError("MANAGED_CODEX_UNAVAILABLE");
    } }),
    createFederation: () => ({ named: async () => [], exact: async () => undefined,
      deliver: async () => { throw new Error("no native sends"); }, close: async () => {},
      catalog: async () => { catalogs++; return []; }, snapshot: () => ({ nodes: [], truncated: false }),
    }),
  });
});

test("real observer, directory and control discover roots, deduplicate fallback and honor retirement", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), stop = new AbortController(), observed = deferred();
  const parent = "00000000-0000-4000-8000-000000000010", child = "00000000-0000-4000-8000-000000000011";
  const listeners = new Set<(payload: string) => void>();
  let factoryCloses = 0, transportCloses = 0;
  const threads = [
    { id: parent, source: "cli", name: "planner", status: { type: "idle" } },
    { id: child, source: "cli", name: "worker", status: { type: "notLoaded" } },
  ];
  const transport = { cleanupConfirmed: true,
    onMessage: (fn: (payload: string) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onClose: () => () => {}, onError: () => () => {},
    close: async () => { transportCloses++; },
    send: async (payload: string) => {
      const request = JSON.parse(payload) as { id?: number; method: string };
      if (request.id === undefined) return;
      const result = request.method === "thread/list" ? { data: threads, nextCursor: null }
        : request.method === "thread/loaded/list" ? { data: [parent], nextCursor: null }
        : request.method === "thread/unsubscribe" ? { status: "unsubscribed" } : {};
      for (const listener of listeners) listener(JSON.stringify({ id: request.id, result }));
    } };
  const call = async (method: string, params: unknown = {}) => {
    const response = await requestLocalControl({ stateDir: f.stateDir, socketPath: f.socketPath,
      request: { method, params }, mutating: method !== "list_snapshot" }) as { ok: boolean; result: Record<string, unknown> };
    assert.equal(response.ok, true); return response.result;
  };
  await runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal, onReady: async () => {
    try {
      await observed.promise;
      const first = await call("list_snapshot"); assert.equal(isBrokerResult("list_snapshot", first), true);
      const routes = first.routes as Array<{ id: string; alias: string; codex: { state: string } }>;
      assert.equal(routes.length, 2);
      const root = routes.find((r) => r.alias === "codex-planner@local")!;
      const worker = routes.find((r) => r.alias === "codex-worker@local")!;
      assert.equal(worker.codex.state, "dormant"); assert.equal(root.codex.state, "idle");
      assert.equal(JSON.stringify(first).includes(parent), false); assert.equal(JSON.stringify(first).includes(child), false);
      const registered = await call("register_codex", { caller: { kind: "codex", handle: parent }, alias: "codex-fallback@local" });
      assert.equal(registered.id, root.id);
      await call("refresh_discovery");
      assert.equal(((await call("list_snapshot")).routes as unknown[]).length, 2);
      await call("retire_route", { endpoint: worker.id }); await call("refresh_discovery");
      assert.equal(((await call("list_snapshot")).routes as unknown[]).length, 1);
    } finally { stop.abort(); }
  } }, { ...f.dependencies, createCodexDiscovery: (options) => createCodexDiscoveryObserver({ ...options,
    onSnapshot: async (snapshot) => { await options.onSnapshot(snapshot); if (snapshot.observation.complete) observed.resolve(); },
  }, { createFactory: async () => ({ appServerVersion: "0.153.4", endpointGeneration: "fake", hostId: "local",
    protocol: "codex-app-server", protocolVersion: "fake", close: async () => { factoryCloses++; },
    connectTransport: async () => transport }) }) });
  assert.equal(factoryCloses, 1); assert.equal(transportCloses, 1); assert.equal(f.providerCalls(), 0);
});

function signalHarness() {
  const listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();
  return {
    dependencies: {
      addSignalListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        const current = listeners.get(signal) ?? new Set(); current.add(listener); listeners.set(signal, current);
      },
      removeSignalListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => listeners.get(signal)?.delete(listener),
    },
    emit: (signal: "SIGINT" | "SIGTERM") => { for (const listener of listeners.get(signal) ?? []) listener(); },
    count: () => [...listeners.values()].reduce((total, values) => total + values.size, 0),
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-runtime-"));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(path.join(stateDir, "nodes.json"), `${JSON.stringify({ version: 1, host: "local", nodes: [] })}\n`, { mode: 0o600 });
  await chmod(path.join(stateDir, "nodes.json"), 0o600);
  const stopped = deferred(); let lost = false, leaseCloses = 0, peerCloses = 0, providerCalls = 0;
  const lease: GatewayInstanceLease = { lost: stopped.promise, isLost: () => lost, close: async () => { leaseCloses++; } };
  const peer = {
    discover: async () => ({ peers: [], rejected: {}, truncated: false, entriesScanned: 0, parseableRecords: 0 }),
    resolveReplyAddress: async () => { providerCalls++; throw new Error("provider called"); },
    assertTargetWorkspaceDisjoint: async () => { providerCalls++; },
    prepareSend: async () => { providerCalls++; throw new Error("provider called"); },
    close: async () => { peerCloses++; },
  } as unknown as ClaudePeerAdapter;
  const operation = { execute: async () => { providerCalls++; throw new Error("provider called"); } } as
    StatelessCodexOperationTransport;
  const dependencies: CoreRuntimeDependencies = { loginHome: () => root, acquireLease: async () => lease,
    attestClaudeRuntime: async () => ({ sessionsDir: path.join(root, "sessions"), socketDir: path.join(root, "sockets") }),
    createClaudePeer: () => peer, createCodexOperation: () => operation, createCodexDiscovery: () => undefined };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, socketPath: path.join(stateDir, "control.sock"), dependencies,
    lose: () => { lost = true; stopped.resolve(); }, leaseCloses: () => leaseCloses,
    peerCloses: () => peerCloses, providerCalls: () => providerCalls };
}

async function seedQueued(stateDir: string): Promise<void> {
  const store = new OwnedStateFile(stateDir, createLedgerCodec("local", ledgerDefaults));
  await store.initialize();
  await store.transact((state, now) => {
    const ledger = new Ledger(state, "local", ledgerDefaults, now.getTime());
    const source: Endpoint = { id: "reg_source", host: "local", provider: "codex",
      alias: "codex-source@local", handle: "00000000-0000-4000-8000-000000000001" };
    const target: Endpoint = { id: "reg_target", host: "local", provider: "codex",
      alias: "codex-target@local", handle: "00000000-0000-4000-8000-000000000002" };
    ledger.register(source); ledger.register(target);
    ledger.admit({ id: `msg_${randomUUID()}`, token: `dlv_${randomBytes(18).toString("base64url")}`,
      reply: `conv_${randomBytes(24).toString("base64url")}`, source, target, body: "recovered work",
      deadline: ledger.now + ledgerDefaults.deadlineMs, steer: false });
  });
  await store.close();
}

test("runtime serves schema-7 commands and a real broker loopback without provider I/O", async (t) => {
  const f = await fixture(t), stop = new AbortController();
  let checked: unknown;
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal, onReady: async () => {
    const registered = await requestLocalControl({ stateDir: f.stateDir, socketPath: f.socketPath, mutating: true,
      request: { method: "register_codex", params: { caller: { kind: "codex", handle: "00000000-0000-4000-8000-000000000001" }, alias: "codex-builder@local" } } });
    assert.equal((registered as { ok: boolean }).ok, true);
    checked = await requestLocalControl({ stateDir: f.stateDir, socketPath: f.socketPath, mutating: true,
      request: { method: "check", params: {} } });
    stop.abort();
  } }, f.dependencies);
  await running;
  assert.deepEqual(checked, { ok: true, result: { status: "ok", scope: "broker-loopback" } });
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.peerCloses(), 1);
  assert.equal(f.leaseCloses(), 1);
  assert.equal((JSON.parse(await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8")) as { schemaVersion: number }).schemaVersion, 7);
});

test("lease loss blocks shutdown persistence while every independent resource still closes", async (t) => {
  const f = await fixture(t);
  let before = "";
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, onReady: async () => {
    await requestLocalControl({ stateDir: f.stateDir, socketPath: f.socketPath, mutating: true,
      request: { method: "register_codex", params: { caller: { kind: "codex", handle: "00000000-0000-4000-8000-000000000001" }, alias: "codex-builder@local" } } });
    before = await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8");
    f.lose();
  } }, f.dependencies);
  await assert.rejects(running, (error: unknown) => error instanceof AggregateError &&
    error.errors.some((item) => item instanceof Error && "code" in item && item.code === "GATEWAY_INSTANCE_LEASE_LOST"));
  assert.equal(await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8"), before);
  assert.equal(f.peerCloses(), 1);
  assert.equal(f.leaseCloses(), 1);
});

test("runtime refuses a configured body larger than the native body bound before ownership or providers", async (t) => {
  const f = await fixture(t);
  let acquired = 0;
  await assert.rejects(runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir, EMBASSY_MAX_MESSAGE_BYTES: "16385" },
    onReady: async () => assert.fail("not ready") }, { ...f.dependencies,
    acquireLease: async () => { acquired++; return await f.dependencies.acquireLease!(f.root); } }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_GATEWAY_CONFIGURATION");
  assert.equal(acquired, 0);
  assert.equal(f.providerCalls(), 0);
});

test("one cleanup failure closes independent resources but keeps the host lease held", async (t) => {
  const f = await fixture(t), stop = new AbortController();
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal,
    onReady: async () => stop.abort() }, { ...f.dependencies,
    serveControl: async () => ({ close: async () => { throw new Error("control cleanup failed"); } }) });
  await assert.rejects(running, (error: unknown) => error instanceof AggregateError &&
    error.errors.some((item) => item instanceof Error && item.message === "control cleanup failed"));
  assert.equal(f.peerCloses(), 1);
  assert.equal(f.leaseCloses(), 0);
});

test("a changed node inventory refuses before provider construction", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir },
    onReady: async () => assert.fail("not ready") }, { ...f.dependencies,
    loadInventory: async () => ({ host: "local", nodes: [] }),
    ensureInventory: async () => ({ host: "other-host", nodes: [] }) }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_NODE_INVENTORY_CHANGED");
  const state = JSON.parse(await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8")) as { schemaVersion: number; endpoints: unknown[] };
  assert.equal(state.schemaVersion, 7);
  assert.deepEqual(state.endpoints, []);
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.leaseCloses(), 1);
});

test("an unsafe control target prevents recovered work from scheduling and leaves state untouched", async (t) => {
  const f = await fixture(t);
  await seedQueued(f.stateDir);
  const before = await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8");
  await writeFile(f.socketPath, "unsafe replacement", { mode: 0o600 });
  await assert.rejects(runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, onReady: async () => assert.fail("not ready") },
    f.dependencies), (error: unknown) => error instanceof Error && "code" in error && error.code === "UNSAFE_SOCKET_TARGET");
  assert.equal(f.providerCalls(), 0);
  assert.equal(await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8"), before);
  assert.equal(await readFile(f.socketPath, "utf8"), "unsafe replacement");
});

test("abort during native initialization cannot schedule recovered work", async (t) => {
  const f = await fixture(t), stop = new AbortController(), entered = deferred();
  await seedQueued(f.stateDir);
  const before = await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8");
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal,
    onReady: async () => assert.fail("not ready") }, { ...f.dependencies, attestClaudeRuntime: async () => {
      entered.resolve(); return await new Promise<never>(() => undefined);
    } });
  await entered.promise; stop.abort();
  await assert.rejects(running, (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_START_CANCELLED");
  assert.equal(f.providerCalls(), 0);
  assert.equal(await readFile(path.join(f.stateDir, "gateway-state.json"), "utf8"), before);
});

test("lease loss stops waiting for inert native initialization", async (t) => {
  const f = await fixture(t), entered = deferred();
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir },
    onReady: async () => assert.fail("not ready") }, { ...f.dependencies, attestClaudeRuntime: async () => {
      entered.resolve(); return await new Promise<never>(() => undefined);
    } });
  await entered.promise; f.lose();
  await assert.rejects(running, (error: unknown) => error instanceof Error && "code" in error &&
    error.code === "GATEWAY_INSTANCE_LEASE_LOST");
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.leaseCloses(), 1);
});

test("abort does not wait for lease acquisition and closes a lease that arrives late", async (t) => {
  const f = await fixture(t), stop = new AbortController(), entered = deferred(), pending = deferred<GatewayInstanceLease>();
  let lateCloses = 0;
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, signal: stop.signal,
    onReady: async () => assert.fail("not ready") }, { ...f.dependencies, acquireLease: async () => {
      entered.resolve(); return await pending.promise;
    } });
  await entered.promise; stop.abort();
  await assert.rejects(running, (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_START_CANCELLED");
  pending.resolve({ lost: new Promise(() => {}), isLost: () => false, close: async () => { lateCloses++; } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateCloses, 1);
  assert.equal(f.providerCalls(), 0);
});

test("SIGTERM wins an unresolved readiness callback and closes before releasing the lease", async (t) => {
  const f = await fixture(t), signals = signalHarness(), entered = deferred();
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, onReady: async () => {
    entered.resolve(); await new Promise<void>(() => undefined);
  } }, { ...f.dependencies, ...signals.dependencies });
  await entered.promise;
  signals.emit("SIGTERM");
  await running;
  assert.equal(f.peerCloses(), 1);
  assert.equal(f.leaseCloses(), 1);
  assert.equal(signals.count(), 0);
});

test("lease loss wins an unresolved readiness callback and never reports a clean stop", async (t) => {
  const f = await fixture(t), signals = signalHarness(), entered = deferred();
  const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: f.stateDir }, onReady: async () => {
    entered.resolve(); await new Promise<void>(() => undefined);
  } }, { ...f.dependencies, ...signals.dependencies });
  await entered.promise;
  f.lose();
  await assert.rejects(running, (error: unknown) => error instanceof AggregateError &&
    error.errors.some((item) => item instanceof Error && "code" in item && item.code === "GATEWAY_INSTANCE_LEASE_LOST"));
  assert.equal(f.peerCloses(), 1);
  assert.equal(f.leaseCloses(), 1);
  assert.equal(signals.count(), 0);
});
