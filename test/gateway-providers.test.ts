import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type {
  ClaudePeerDescriptor,
  ClaudePeerListener,
  ClaudePeerListenerOptions,
  ClaudePeerSendOptions,
  ClaudePeerSendResult,
} from "../src/gateway/claude-peer.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import type {
  CodexAppServerTransport,
  CodexWorkspaceAttestationRequest,
} from "../src/gateway/codex-app-server.js";
import type {
  LocalCodexOwnedTransport,
  LocalCodexTransportFactory,
} from "../src/gateway/codex-local-transport.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
import {
  createLocalClaudeGatewayProvider,
  createLocalCodexGatewayProvider,
} from "../src/gateway/providers.js";
import {
  GatewayService,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterCallbacks,
  type GatewayAdapterDelivery,
  type GatewayProviderAdapter,
} from "../src/gateway/service.js";
import type {
  PrivateEndpointIdentity,
  PrivateRouteBinding,
} from "../src/gateway/types.js";

const THREAD_ID = "019f9a56-9fca-75b1-80e4-48ccef693abc";
const PROVIDER_MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_MESSAGE_ID = "gateway-message-001";
const SAFE_WORKSPACE = "/workspace/synthetic-project";

function callbacks(): {
  callbacks: GatewayAdapterCallbacks;
  deliveries: GatewayAdapterDelivery[];
  replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][];
  routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][];
} {
  const deliveries: GatewayAdapterDelivery[] = [];
  const replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][] = [];
  const routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][] = [];
  return {
    callbacks: {
      onDelivery: (event) => deliveries.push({ ...event }),
      onClaudeReply: (event) =>
        replies.push({ endpoint: { ...event.endpoint }, text: event.text }),
      onRouteState: (event) =>
        routes.push({ endpoint: { ...event.endpoint }, state: event.state }),
    },
    deliveries,
    replies,
    routes,
  };
}

class FakeClaudePeer {
  readonly peers: ClaudePeerDescriptor[] = [
    {
      targetId: "target-selected",
      alias: "advisor",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    },
    {
      targetId: "target-uppercase",
      alias: "NotCanonical",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    },
    {
      targetId: "target-daemon",
      alias: "daemon",
      kind: "daemon",
      status: "idle",
      compatibility: "compatible",
    },
  ];
  listenerOptions: ClaudePeerListenerOptions | undefined;
  listenerUsed = false;
  sendCalls = 0;
  asserted: Array<{ routeHandle: string; stateRoot: string }> = [];
  closed = false;
  sendMode: "success" | "postwrite_ambiguous" | "prewrite_failure" =
    "success";
  untracked: string[] = [];
  acknowledged: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];
  private nextDiscoveryHold:
    | { markStarted: () => void; wait: Promise<void> }
    | undefined;

  readonly listener = {
    address: "uds:/synthetic/callback.sock",
    closed: false,
    close: async () => undefined,
    untrack: (messageId: string) => this.untracked.push(messageId),
    acknowledge: async (
      receiptHandle: string,
      status: "held" | "delivered" | "denied" | "expired",
      diagnostic?: { code: string },
    ) => {
      this.acknowledged.push({
        receiptHandle,
        status,
        ...(diagnostic === undefined
          ? {}
          : { diagnosticCode: diagnostic.code }),
      });
    },
  } as unknown as ClaudePeerListener;

  async listen(options: ClaudePeerListenerOptions): Promise<ClaudePeerListener> {
    this.listenerOptions = options;
    return this.listener;
  }

  async discover(): Promise<{
    peers: ClaudePeerDescriptor[];
    rejected: Record<string, never>;
    truncated: false;
  }> {
    const peers = this.peers.map((peer) => ({ ...peer }));
    const hold = this.nextDiscoveryHold;
    this.nextDiscoveryHold = undefined;
    if (hold !== undefined) {
      hold.markStarted();
      await hold.wait;
    }
    return { peers, rejected: {}, truncated: false };
  }

  holdNextDiscovery(): { release: () => void; started: Promise<void> } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextDiscoveryHold = { markStarted, wait };
    return { release, started };
  }

  async assertTargetWorkspaceDisjoint(
    routeHandle: string,
    stateRoot: string,
  ): Promise<void> {
    this.asserted.push({ routeHandle, stateRoot });
  }

  async resolveReplyAddress(address: string): Promise<ClaudePeerDescriptor> {
    if (address === "uds:/synthetic/selected.sock") return { ...this.peers[0]! };
    return {
      targetId: "target-unselected",
      alias: "other",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    };
  }

  async send(
    _targetId: string,
    _content: string,
    options: ClaudePeerSendOptions,
  ): Promise<ClaudePeerSendResult> {
    this.sendCalls += 1;
    this.listenerUsed = options.listener === this.listener;
    if (this.sendMode === "prewrite_failure") {
      throw new BridgeError("CLAUDE_PEER_TARGET_STALE", "synthetic");
    }
    await options.onTransportStatus?.({
      messageId: PROVIDER_MESSAGE_ID,
      status: "connecting",
    });
    if (this.sendMode === "postwrite_ambiguous") {
      await options.onTransportStatus?.({
        messageId: PROVIDER_MESSAGE_ID,
        status: "ambiguous",
      });
      throw new BridgeError("CLAUDE_PEER_WRITE_AMBIGUOUS", "synthetic");
    }
    await options.onTransportStatus?.({
      messageId: PROVIDER_MESSAGE_ID,
      status: "transport_written",
    });
    return {
      messageId: PROVIDER_MESSAGE_ID,
      receiptStatus: "pending",
      transportStatus: "transport_written",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitReceipt(status: "held" | "released" | "denied" | "expired" | "ambiguous"): void {
    void this.listenerOptions?.onReceipt?.({
      messageId: PROVIDER_MESSAGE_ID,
      status,
      trust: "untrusted_same_uid_peer",
    });
  }

  async emitInbound(
    targetId = "target-selected",
    text = "synthetic reply",
  ): Promise<void> {
    await this.listenerOptions?.onMessage({
      inboundId: "inbound-private-id",
      content: text,
      sourceTargetId: targetId,
      sourceAlias: targetId === "target-selected" ? "advisor" : "other",
      receiptHandle: "synthetic-receipt-handle",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
  }

  setSelectedStatus(status: "idle" | "busy" | "shell" | "waiting"): void {
    this.peers[0]!.status = status;
  }
}

class RegistrationOnlyCodexProvider implements GatewayProviderAdapter {
  readonly identity: PrivateEndpointIdentity = {
    provider: "codex",
    hostId: "this-mac",
    endpointGeneration: "synthetic-codex-registration-generation",
  };
  readonly protocol = "synthetic-codex";
  readonly protocolVersion = "synthetic-1";

  async initialize(): Promise<{
    health: "healthy";
    compatibility: "compatible";
  }> {
    return { health: "healthy", compatibility: "compatible" };
  }

  async assertWorkspaceDisjoint(): Promise<void> {}

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: "idle" }> {
    return { routeHandle: input.routeHandle, state: "idle" };
  }

  async dispatch(): Promise<GatewayAdapterDispatchResult> {
    return { state: "failed", safeErrorCode: "SYNTHETIC_UNUSED" };
  }

  async close(): Promise<void> {}
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic wait timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function claudeRuntime(): AttestedClaudePeerRuntime {
  return {
    claudeExecutable: "/synthetic/home/.local/share/claude/versions/2.1.225",
    claudeCodeVersion: "2.1.225",
    sessionsDir: "/synthetic/home/.claude/sessions",
    socketDir: "/synthetic/tmp/cc-socks",
  };
}

function binding(
  provider: ReturnType<typeof createLocalClaudeGatewayProvider>,
  routeHandle = "target-selected",
): PrivateRouteBinding {
  return {
    ...provider.identity,
    routeHandle,
    ownerLease: "lease_synthetic",
  };
}

test("local Claude provider publishes only canonical interactive names and generation-fences callbacks", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  assert.deepEqual(await provider.initialize(observed.callbacks), {
    health: "healthy",
    compatibility: "compatible",
  });

  const discovered = await provider.discoverClaudePeers();
  assert.deepEqual(discovered, [
    {
      alias: "advisor@this-mac",
      routeHandle: "target-selected",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ]);
  await provider.assertWorkspaceDisjoint(
    "target-selected",
    "/synthetic/controller-state",
  );
  assert.deepEqual(fake.asserted, [
    {
      routeHandle: "target-selected",
      stateRoot: "/synthetic/controller-state",
    },
  ]);
  assert.deepEqual(
    await provider.selectRoute({
      alias: "advisor@this-mac",
      routeHandle: "target-selected",
    }),
    { routeHandle: "target-selected", state: "idle" },
  );
  assert.deepEqual(
    await provider.resolveReplyAddress("uds:/synthetic/selected.sock"),
    { routeHandle: "target-selected" },
  );
  await assert.rejects(
    provider.resolveReplyAddress("uds:/synthetic/unselected.sock"),
    (error) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_REPLY_ROUTE_MISMATCH",
  );

  const result = await provider.dispatch({
    binding: binding(provider),
    messageId: GATEWAY_MESSAGE_ID,
    text: "synthetic body",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.deepEqual(result, { state: "pending" });
  assert.equal(fake.listenerUsed, true);
  assert.deepEqual(observed.deliveries, [
    { messageId: GATEWAY_MESSAGE_ID, state: "transport_written" },
    { messageId: GATEWAY_MESSAGE_ID, state: "released" },
  ]);
  assert.equal(JSON.stringify(observed.deliveries).includes(PROVIDER_MESSAGE_ID), false);

  fake.emitReceipt("held");
  fake.emitReceipt("released");
  assert.deepEqual(observed.deliveries.slice(2), []);
  const routesBeforeRefresh = observed.routes.length;
  // A receipt settles inbox delivery only; it cannot assert native idleness.
  assert.equal(observed.routes.length, routesBeforeRefresh);
  fake.setSelectedStatus("busy");
  await provider.discoverClaudePeers();
  assert.deepEqual(observed.routes.at(-1), {
    endpoint: { ...provider.identity, routeHandle: "target-selected" },
    state: "busy",
  });
  fake.setSelectedStatus("idle");
  await provider.discoverClaudePeers();
  assert.deepEqual(observed.routes.at(-1), {
    endpoint: { ...provider.identity, routeHandle: "target-selected" },
    state: "idle",
  });
  await fake.emitInbound();
  assert.deepEqual(observed.replies, [
    {
      endpoint: { ...provider.identity, routeHandle: "target-selected" },
      text: "synthetic reply",
    },
  ]);
  await fake.emitInbound("target-unselected", "must be dropped");
  assert.equal(observed.replies.length, 1);
  assert.deepEqual(fake.acknowledged, [
    {
      receiptHandle: "synthetic-receipt-handle",
      status: "expired",
      diagnosticCode: "CLAUDE_SOURCE_ROUTE_UNSELECTED",
    },
  ]);

  await provider.close();
  assert.equal(fake.closed, true);
});

test("local Claude provider waits for a late exact receipt after post-write ambiguity and fails clean prewrites", async () => {
  const fake = new FakeClaudePeer();
  fake.sendMode = "postwrite_ambiguous";
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.discoverClaudePeers();
  await provider.assertWorkspaceDisjoint(
    "target-selected",
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "advisor@this-mac",
    routeHandle: "target-selected",
  });

  assert.deepEqual(
    await provider.dispatch({
      binding: binding(provider),
      messageId: GATEWAY_MESSAGE_ID,
      text: "ambiguous synthetic body",
      expectsReply: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.deepEqual(observed.deliveries, []);
  fake.emitReceipt("released");
  assert.deepEqual(observed.deliveries, [
    { messageId: GATEWAY_MESSAGE_ID, state: "released" },
  ]);

  fake.sendMode = "prewrite_failure";
  assert.deepEqual(
    await provider.dispatch({
      binding: binding(provider),
      messageId: "gateway-message-002",
      text: "prewrite failure",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CLAUDE_DISPATCH_REJECTED" },
  );
  await provider.close();
});

test("Claude idle discovery overlapping an entire dispatch remains stale until the next poll", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.discoverClaudePeers();
  await provider.selectRoute({
    alias: "advisor@this-mac",
    routeHandle: "target-selected",
  });

  const heldDiscovery = fake.holdNextDiscovery();
  const staleDiscovery = provider.discoverClaudePeers();
  await heldDiscovery.started;
  assert.deepEqual(
    await provider.dispatch({
      binding: binding(provider),
      messageId: "gateway-overlapped-dispatch",
      text: "synthetic overlapped dispatch",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  heldDiscovery.release();
  await staleDiscovery;
  assert.equal(observed.routes.at(-1)?.state, "idle");

  await provider.discoverClaudePeers();
  assert.equal(observed.routes.at(-1)?.state, "idle");
  await provider.close();
});

test("local Claude provider releases successful socket writes without waiting for receipts", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    maxPendingMessages: 2,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.discoverClaudePeers();
  await provider.assertWorkspaceDisjoint(
    "target-selected",
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "advisor@this-mac",
    routeHandle: "target-selected",
  });
  assert.deepEqual(
    await provider.dispatch({
      binding: binding(provider),
      messageId: "gateway-collision-1",
      text: "first",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.deepEqual(
    await provider.dispatch({
      binding: binding(provider),
      messageId: "gateway-collision-2",
      text: "second",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(
    observed.deliveries.filter((event) => event.state === "released").length,
    2,
  );
  await provider.close();
});

test("successful Claude socket writes immediately unlock a second queued gateway send", async () => {
  const created = await mkdtemp(
    path.join(os.tmpdir(), "gateway-provider-repeat-"),
  );
  const root = await realpath(created);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const fake = new FakeClaudePeer();
  const claude = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      CLAUDE_BRIDGE_GATEWAY_STATE_DIR: path.join(root, "state"),
      CLAUDE_BRIDGE_GATEWAY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, new RegistrationOnlyCodexProvider()],
  });
  try {
    await service.start();
    const handlers = service.handlers();
    assert.equal((await handlers.refreshDashboard()).accepted, true);
    assert.deepEqual(
      await handlers.selectClaude({ alias: "advisor@this-mac" }),
      { accepted: true, code: "ok" },
    );
    assert.deepEqual(
      await handlers.registerCodex({
        alias: "codex-main@this-mac",
        busyPolicy: "queue",
        hostId: "this-mac",
        threadId: THREAD_ID,
      }),
      { accepted: true, code: "ok" },
    );
    const send = (text: string) =>
      handlers.sendToClaude({
        expectsReply: false,
        fromAlias: "codex-main@this-mac",
        text,
        threadId: THREAD_ID,
        toAlias: "advisor@this-mac",
      });
    assert.equal((await send("first synthetic body")).accepted, true);
    await waitFor(() => fake.sendCalls === 1);
    assert.equal((await send("second synthetic body")).accepted, true);

    // A successful native socket write is terminal for gateway delivery.
    fake.setSelectedStatus("idle");
    const heldDiscovery = fake.holdNextDiscovery();
    const preTerminalDiscovery = claude.discoverClaudePeers();
    await heldDiscovery.started;
    heldDiscovery.release();
    await preTerminalDiscovery;
    await waitFor(() => fake.sendCalls === 2);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

type Wire = Record<string, unknown>;

class FakeCodexTransport implements LocalCodexOwnedTransport {
  cleanupConfirmed = false;
  readonly sent: Wire[] = [];
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(payload: string) => void>();

  constructor(
    private readonly threadId: string,
    private readonly safePolicy: boolean,
    private readonly resumeStatus: "idle" | "active",
    private readonly completeInterrupt: boolean,
  ) {}

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
    const message = JSON.parse(payload) as Wire;
    this.sent.push(message);
    if (message.method === "initialize") {
      this.respond(message, { platformFamily: "unix", platformOs: "darwin" });
    } else if (message.method === "thread/loaded/list") {
      this.respond(message, { data: [this.threadId] });
    } else if (message.method === "thread/resume") {
      this.respond(message, {
        approvalPolicy: this.safePolicy ? "never" : "on-request",
        cwd: SAFE_WORKSPACE,
        sandbox: this.safePolicy
          ? { networkAccess: false, type: "readOnly" }
          : { type: "workspaceWrite" },
        thread: {
          id: this.threadId,
          status: { type: this.resumeStatus },
          turns: [],
        },
      });
    } else if (message.method === "turn/start") {
      this.respond(message, {
        turn: { id: "turn-provider-1", status: "inProgress" },
      });
    } else if (message.method === "thread/unsubscribe") {
      this.respond(message, { status: "unsubscribed" });
    } else if (message.method === "turn/interrupt") {
      this.respond(message, {});
      if (this.completeInterrupt) {
        queueMicrotask(() =>
          this.emit({
            method: "turn/completed",
            params: {
              threadId: this.threadId,
              turn: { id: "turn-provider-1", status: "interrupted" },
            },
          }),
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.cleanupConfirmed) return;
    this.cleanupConfirmed = true;
    for (const listener of this.closeListeners) listener();
  }

  emit(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const listener of this.messageListeners) listener(payload);
  }

  private respond(request: Wire, result: unknown): void {
    this.emit({ id: request.id, result });
  }
}

class FakeCodexFactory {
  readonly appServerVersion = "0.147.0";
  readonly endpointGeneration = "local-synthetic-generation";
  readonly hostId = "this-mac";
  readonly protocol = "codex-app-server" as const;
  readonly protocolVersion = "0.147.0";
  readonly schemaCompatibility = {
    appServerVersion: "0.147.0",
    endpointGeneration: this.endpointGeneration,
    protocol: "app-server-v2-stable" as const,
  };
  readonly writeCompatibility: typeof this.schemaCompatibility | null;
  readonly writableReady: boolean;
  readonly transports: FakeCodexTransport[] = [];
  closed = false;

  constructor(
    private readonly threadId: string,
    writesEnabled: boolean,
    private readonly safePolicy = true,
    private readonly resumeStatus: "idle" | "active" = "idle",
    private readonly completeInterrupt = true,
  ) {
    this.writableReady = writesEnabled;
    this.writeCompatibility = writesEnabled
      ? { ...this.schemaCompatibility }
      : null;
  }

  async connectTransport(): Promise<LocalCodexOwnedTransport> {
    const transport = new FakeCodexTransport(
      this.threadId,
      this.safePolicy,
      this.resumeStatus,
      this.completeInterrupt,
    );
    this.transports.push(transport);
    return transport;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.transports.map(async (transport) => transport.close()));
  }
}

function codexProvider(
  factory: FakeCodexFactory,
  attestations: CodexWorkspaceAttestationRequest[],
  cleanup: { cleanupPollMs?: number; cleanupTimeoutMs?: number } = {},
) {
  return createLocalCodexGatewayProvider({
    factory: factory as unknown as LocalCodexTransportFactory,
    stateRoot: "/synthetic/controller-state",
    attestWorkspace: async (request) => {
      attestations.push({ ...request });
      return request.canonicalCwd === SAFE_WORKSPACE;
    },
    ...cleanup,
  });
}

function codexBinding(
  provider: ReturnType<typeof codexProvider>,
): PrivateRouteBinding {
  return {
    ...provider.identity,
    routeHandle: THREAD_ID,
    ownerLease: "lease_codex_synthetic",
  };
}

test("local Codex provider attaches one exact route, reattests before write, and hands off a bounded final reply", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const attestations: CodexWorkspaceAttestationRequest[] = [];
  const provider = codexProvider(factory, attestations);
  const observed = callbacks();
  assert.deepEqual(await provider.initialize(observed.callbacks), {
    health: "healthy",
    compatibility: "compatible",
  });
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  assert.equal(factory.transports.length, 1);
  assert.deepEqual(
    await provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    { routeHandle: THREAD_ID, state: "idle" },
  );
  assert.equal(attestations.length, 0);

  assert.deepEqual(
    await provider.dispatch({
      binding: codexBinding(provider),
      messageId: GATEWAY_MESSAGE_ID,
      text: "synthetic Codex request",
      expectsReply: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(attestations.length, 0);
  const transport = factory.transports[0]!;
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-provider-final",
        phase: "final_answer",
        text: "bounded synthetic result",
        type: "agentMessage",
      },
      threadId: THREAD_ID,
      turnId: "turn-provider-1",
    },
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-provider-1", status: "completed" },
    },
  });
  await delayImmediate();
  assert.equal(
    observed.deliveries.some(
      (event) =>
        event.messageId === GATEWAY_MESSAGE_ID &&
        event.state === "completed" &&
        event.replyText === "bounded synthetic result",
    ),
    true,
  );
  assert.equal(
    observed.routes.every(
      (event) =>
        event.endpoint.provider === "codex" &&
        event.endpoint.hostId === "this-mac" &&
        event.endpoint.endpointGeneration === provider.identity.endpointGeneration &&
        event.endpoint.routeHandle === THREAD_ID,
    ),
    true,
  );

  await provider.releaseRoute(THREAD_ID);
  assert.equal(transport.cleanupConfirmed, true);
  await provider.close();
  assert.equal(factory.closed, true);
});

test("an explicitly registered Codex route remains reachable after settings invalidate observational workspace metadata", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, []);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  const transport = factory.transports[0]!;
  transport.emit({
    method: "thread/settings/updated",
    params: {
      threadId: THREAD_ID,
      threadSettings: {
        approvalPolicy: "on-request",
        cwd: "/synthetic/changed-workspace",
        sandboxPolicy: { type: "workspaceWrite" },
      },
    },
  });

  assert.deepEqual(
    await provider.dispatch({
      binding: codexBinding(provider),
      messageId: "gateway-message-after-settings-update",
      text: "registered routes remain reachable",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  assert.equal(
    observed.routes.some(
      (event) => event.safeErrorCode === "CODEX_WORKSPACE_UNATTESTED",
    ),
    false,
  );

  await provider.close();
});

test("local Codex provider remains monitor-only without the distinct write attestation", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, false);
  const attestations: CodexWorkspaceAttestationRequest[] = [];
  const provider = codexProvider(factory, attestations);
  const observed = callbacks();
  assert.deepEqual(await provider.initialize(observed.callbacks), {
    health: "degraded",
    compatibility: "compatible",
    safeErrorCode: "CODEX_MONITOR_ONLY",
  });
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  assert.deepEqual(
    await provider.dispatch({
      binding: codexBinding(provider),
      messageId: GATEWAY_MESSAGE_ID,
      text: "must never reach turn/start",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CODEX_WRITES_DISABLED" },
  );
  assert.equal(
    factory.transports[0]!.sent.some(
      (message) => message.method === "turn/start",
    ),
    false,
  );
  assert.equal(attestations.length, 0);
  await provider.close();
});

test("local Codex provider cancels queued work and confirms only its exact owned turn before proxy cleanup", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, []);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await provider.dispatch({
    binding: codexBinding(provider),
    messageId: "gateway-active-owned",
    text: "active synthetic turn",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await provider.dispatch({
    binding: codexBinding(provider),
    messageId: "gateway-queued-owned",
    text: "queued synthetic turn",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const transport = factory.transports[0]!;
  await provider.releaseRoute(THREAD_ID);
  await delayImmediate();
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/interrupt")
      .length,
    1,
  );
  assert.equal(transport.cleanupConfirmed, true);
  assert.equal(
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-active-owned" &&
        event.state === "cancelled",
    ),
    true,
  );
  assert.equal(
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-queued-owned" &&
        event.state === "ambiguous",
    ),
    true,
  );
  await provider.close();
});

test("local Codex provider never interrupts an external active turn", async () => {
  const factory = new FakeCodexFactory(
    THREAD_ID,
    true,
    true,
    "active",
  );
  const provider = codexProvider(factory, []);
  await provider.initialize(callbacks().callbacks);
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await provider.releaseRoute(THREAD_ID);
  const transport = factory.transports[0]!;
  assert.equal(
    transport.sent.some((message) => message.method === "turn/interrupt"),
    false,
  );
  assert.equal(transport.cleanupConfirmed, true);
  await provider.close();
});

test("local Codex provider detaches from an external approval without interrupting or waiting for it", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, []);
  await provider.initialize(callbacks().callbacks);
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  const transport = factory.transports[0]!;
  transport.emit({
    id: "external-approval-request",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "synthetic external command",
      threadId: THREAD_ID,
      turnId: "turn-external-approval",
    },
  });

  await provider.releaseRoute(THREAD_ID);
  assert.equal(
    transport.sent.some((message) => message.method === "turn/interrupt"),
    false,
  );
  assert.equal(
    transport.sent.some(
      (message) => message.id === "external-approval-request",
    ),
    false,
  );
  assert.equal(transport.cleanupConfirmed, true);
  await provider.close();
});

test("local Codex provider preserves the proxy when owned-turn termination is not confirmed by its deadline", async () => {
  const factory = new FakeCodexFactory(
    THREAD_ID,
    true,
    true,
    "idle",
    false,
  );
  const provider = codexProvider(factory, [], {
    cleanupPollMs: 5,
    cleanupTimeoutMs: 25,
  });
  await provider.initialize(callbacks().callbacks);
  await provider.assertWorkspaceDisjoint(
    THREAD_ID,
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await provider.dispatch({
    binding: codexBinding(provider),
    messageId: "gateway-timeout-owned",
    text: "active synthetic turn",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const transport = factory.transports[0]!;
  await assert.rejects(
    provider.releaseRoute(THREAD_ID),
    (error) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PROVIDER_CLEANUP_TIMEOUT",
  );
  assert.equal(transport.cleanupConfirmed, false);
  assert.equal(factory.closed, false);

  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-provider-1", status: "interrupted" },
    },
  });
  await provider.releaseRoute(THREAD_ID);
  assert.equal(transport.cleanupConfirmed, true);
  await provider.close();
});

// Type-only guard: the fake transport never acquires a network capability.
const _transportTypeGuard: CodexAppServerTransport | undefined = undefined;
void _transportTypeGuard;
