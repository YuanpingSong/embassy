import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type {
  ClaudePeerDescriptor,
  ClaudePeerInboundMessage,
  ClaudePeerInboundProgress,
  ClaudePeerListener,
  ClaudePeerListenerOptions,
  ClaudePeerRegistryPublicationOutcome,
  ClaudePeerSendOptions,
  ClaudePeerSendResult,
} from "../src/gateway/claude-peer.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import type { CodexAppServerTransport } from "../src/gateway/codex-app-server.js";
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

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const PROVIDER_MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_MESSAGE_ID = "gateway-message-001";
const SAFE_WORKSPACE = "/workspace/synthetic-project";
const INITIAL_LISTENER_GENERATION = "listener_generation_1";

function callbacks(): {
  callbacks: GatewayAdapterCallbacks;
  deliveries: GatewayAdapterDelivery[];
  replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][];
  messages: NonNullable<
    Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
  >[];
  notices: Array<{ code: string }>;
  routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][];
} {
  const deliveries: GatewayAdapterDelivery[] = [];
  const replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][] = [];
  const messages: NonNullable<
    Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
  >[] = [];
  const notices: Array<{ code: string }> = [];
  const routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][] = [];
  return {
    callbacks: {
      onDelivery: (event) => deliveries.push({ ...event }),
      onClaudeReply: (event) =>
        replies.push({ endpoint: { ...event.endpoint }, text: event.text }),
      onClaudeMessage: (event) =>
        messages.push({ ...event, endpoint: { ...event.endpoint } }),
      onProtocolNotice: (event) => notices.push({ ...event }),
      onRouteState: (event) =>
        routes.push({
          endpoint: { ...event.endpoint },
          state: event.state,
          ...(event.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: event.safeErrorCode }),
        }),
    },
    deliveries,
    replies,
    messages,
    notices,
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
    {
      targetId: "target-foreign-codex-advertisement",
      alias: "codex-other-gateway",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    },
  ];
  listenerOptions: ClaudePeerListenerOptions | undefined;
  readonly preparedListenerOptions = new Map<
    string,
    ClaudePeerListenerOptions
  >();
  readonly listeners = new Map<string, ClaudePeerListener>();
  listenerUsed = false;
  lastListenerGeneration: string | undefined;
  lastReceiptDeadlineAt: number | undefined;
  sendCalls = 0;
  truncated = false;
  asserted: Array<{ routeHandle: string; stateRoot: string }> = [];
  closed = false;
  sendMode:
    | "success"
    | "postwrite_ambiguous"
    | "held_then_postwrite_ambiguous"
    | "prewrite_failure" = "success";
  untracked: string[] = [];
  acknowledged: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];
  acknowledgeAttempts: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];
  progressed: Array<{
    receiptHandle: string;
    progress: ClaudePeerInboundProgress;
  }> = [];
  releasedInboundReceipts: string[] = [];
  closedListenerGenerations: string[] = [];
  quiescedListenerGenerations: string[] = [];
  resumedListenerGenerations: string[] = [];
  activationGrantedListenerGenerations: string[] = [];
  lifecycleCalls: string[] = [];
  advertised: Array<{ generation: string; name: string; cwd: string }> = [];
  unadvertised: Array<{ generation: string; name?: string }> = [];
  publications: Array<{
    currentGeneration: string;
    preparedGeneration: string;
    name: string;
    cwd: string;
  }> = [];
  publicationOutcome: ClaudePeerRegistryPublicationOutcome = "published";
  afterAdvertiseVisible:
    | ((generation: string) => void | Promise<void>)
    | undefined;
  acknowledgeError: Error | undefined;
  acknowledgeErrors: Error[] = [];
  progressError: Error | undefined;
  private readonly liveInboundReceipts = new Set([
    "synthetic-receipt-handle",
  ]);
  private nextDiscoveryHold:
    | { markStarted: () => void; wait: Promise<void> }
    | undefined;

  readonly listener = this.createListener(INITIAL_LISTENER_GENERATION);

  private createListener(generation: string): ClaudePeerListener {
    let closed = false;
    const listener = {
      address: `uds:/synthetic/callback.${generation}.sock`,
      generation,
      get closed() {
        return closed;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.closedListenerGenerations.push(generation);
      },
      untrack: (messageId: string) => this.untracked.push(messageId),
      acknowledge: async (
        receiptHandle: string,
        status: "held" | "delivered" | "denied" | "expired",
        diagnostic?: { code: string },
      ) => {
        const attempt = {
          receiptHandle,
          status,
          ...(diagnostic === undefined
            ? {}
            : { diagnosticCode: diagnostic.code }),
        };
        this.acknowledgeAttempts.push(attempt);
        const error = this.acknowledgeErrors.shift() ?? this.acknowledgeError;
        if (error !== undefined) throw error;
        this.acknowledged.push(attempt);
        return { transportStatus: "transport_written" as const };
      },
      notifyInboundProgress: async (
        receiptHandle: string,
        progress: ClaudePeerInboundProgress,
      ) => {
        if (this.progressError !== undefined) throw this.progressError;
        this.progressed.push({ receiptHandle, progress: { ...progress } });
        return { transportStatus: "transport_written" as const };
      },
      releaseInboundReceipt: (receiptHandle: string) => {
        this.releasedInboundReceipts.push(receiptHandle);
        return this.liveInboundReceipts.delete(receiptHandle);
      },
      quiesceInbound: async () => {
        this.quiescedListenerGenerations.push(generation);
      },
      resumeInbound: () => {
        this.resumedListenerGenerations.push(generation);
        this.lifecycleCalls.push(`resume:${generation}`);
      },
      grantSuccessionActivation: () => {
        this.activationGrantedListenerGenerations.push(generation);
        this.lifecycleCalls.push(`grant:${generation}`);
      },
      advertise: async (name: string, cwd: string) => {
        this.advertised.push({ generation, name, cwd });
        await this.afterAdvertiseVisible?.(generation);
      },
      unadvertise: async (name?: string) => {
        this.unadvertised.push({ generation, ...(name === undefined ? {} : { name }) });
      },
      updateAdvertisedStatus: async () => undefined,
      publishReplacing: async (
        current: ClaudePeerListener,
        name: string,
        cwd: string,
      ) => {
        this.publications.push({
          currentGeneration: current.generation,
          preparedGeneration: generation,
          name,
          cwd,
        });
        return this.publicationOutcome;
      },
    } as unknown as ClaudePeerListener;
    this.listeners.set(generation, listener);
    return listener;
  }

  async listen(options: ClaudePeerListenerOptions): Promise<ClaudePeerListener> {
    this.listenerOptions = options;
    return this.listener;
  }

  async listenPrepared(
    generation: string,
    options: ClaudePeerListenerOptions,
  ): Promise<ClaudePeerListener> {
    this.preparedListenerOptions.set(generation, options);
    return this.createListener(generation);
  }

  async discover(): Promise<{
    peers: ClaudePeerDescriptor[];
    rejected: Record<string, never>;
    truncated: boolean;
  }> {
    const peers = this.peers.map((peer) => ({ ...peer }));
    const hold = this.nextDiscoveryHold;
    this.nextDiscoveryHold = undefined;
    if (hold !== undefined) {
      hold.markStarted();
      await hold.wait;
    }
    return { peers, rejected: {}, truncated: this.truncated };
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

  emitUnknownReceiptNotice(): void {
    this.listenerOptions?.onProtocolNotice?.({
      code: "UNKNOWN_RECEIPT",
    });
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
    this.lastListenerGeneration = options.listener?.generation;
    this.lastReceiptDeadlineAt = options.receiptDeadlineAt;
    if (this.sendMode === "prewrite_failure") {
      throw new BridgeError("CLAUDE_PEER_TARGET_STALE", "synthetic");
    }
    await options.onTransportStatus?.({
      messageId: PROVIDER_MESSAGE_ID,
      status: "connecting",
    });
    await options.onTransportStatus?.({
      messageId: PROVIDER_MESSAGE_ID,
      status: "write_started",
    });
    if (
      this.sendMode === "postwrite_ambiguous" ||
      this.sendMode === "held_then_postwrite_ambiguous"
    ) {
      if (this.sendMode === "held_then_postwrite_ambiguous") {
        await this.listenerOptions?.onReceipt?.({
          messageId: PROVIDER_MESSAGE_ID,
          status: "held",
          trust: "untrusted_same_uid_peer",
        });
      }
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

  emitReceipt(
    status:
      | "held"
      | "released"
      | "denied"
      | "expired"
      | "unconfirmed"
      | "ambiguous",
    generation = INITIAL_LISTENER_GENERATION,
  ): void {
    const options =
      generation === INITIAL_LISTENER_GENERATION
        ? this.listenerOptions
        : this.preparedListenerOptions.get(generation);
    void options?.onReceipt?.({
      messageId: PROVIDER_MESSAGE_ID,
      status,
      trust: "untrusted_same_uid_peer",
    });
  }

  async emitInbound(
    targetId = "target-selected",
    text = "synthetic reply",
  ): Promise<void> {
    await this.emitInboundFrame({
      inboundId: "inbound-private-id",
      content: text,
      sourceTargetId: targetId,
      sourceAlias: targetId === "target-selected" ? "advisor" : "other",
      receiptHandle: "synthetic-receipt-handle",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
  }

  async emitInboundFrame(
    message: ClaudePeerInboundMessage,
    generation = INITIAL_LISTENER_GENERATION,
  ): Promise<void> {
    if (message.receiptHandle !== undefined) {
      this.liveInboundReceipts.add(message.receiptHandle);
    }
    const options =
      generation === INITIAL_LISTENER_GENERATION
        ? this.listenerOptions
        : this.preparedListenerOptions.get(generation);
    await options?.onMessage(message);
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
    claudeExecutable: "/synthetic/home/.local/share/claude/versions/2.1.226",
    claudeCodeVersion: "2.1.226",
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

test("local Claude provider forwards the exact delivery notice policy", () => {
  const fake = new FakeClaudePeer();
  let receivedLocale: unknown;
  let receivedDeliveryNotices: unknown;
  createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    locale: "zh-CN",
    deliveryNotices: "quiet",
    peerFactory: (_runtime, locale, deliveryNotices) => {
      receivedLocale = locale;
      receivedDeliveryNotices = deliveryNotices;
      return fake as never;
    },
  });
  assert.equal(receivedLocale, "zh-CN");
  assert.equal(receivedDeliveryNotices, "quiet");
});

test("closing during Claude listen fences and closes the late listener", async () => {
  const fake = new FakeClaudePeer();
  let markListenEntered: (() => void) | undefined;
  let releaseListen: (() => void) | undefined;
  const listenEntered = new Promise<void>((resolve) => {
    markListenEntered = resolve;
  });
  const listenMayFinish = new Promise<void>((resolve) => {
    releaseListen = resolve;
  });
  let listenerClosed = false;
  fake.listener.close = async () => {
    listenerClosed = true;
  };
  fake.listen = async (options) => {
    fake.listenerOptions = options;
    markListenEntered?.();
    await listenMayFinish;
    return fake.listener;
  };
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    peerFactory: () => fake as never,
  });

  const initializing = provider.initialize(callbacks().callbacks);
  await listenEntered;
  const closing = provider.close();
  releaseListen?.();

  await assert.rejects(
    initializing,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_CALLBACK_UNAVAILABLE",
  );
  await closing;
  assert.equal(fake.closed, true);
  assert.equal(listenerClosed, true);
  await assert.rejects(
    provider.discoverClaudePeers(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CLAUDE_PROVIDER_UNAVAILABLE",
  );
});

test("local Claude provider publishes only canonical interactive names and generation-fences callbacks", async () => {
  const fake = new FakeClaudePeer();
  assert.equal(
    fake.peers.some((peer) => peer.alias === "codex-other-gateway"),
    true,
  );
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
  assert.deepEqual(discovered, {
    complete: true,
    peers: [
      {
        alias: "advisor@this-mac",
        routeHandle: "target-selected",
        kind: "interactive",
        state: "idle",
        compatibility: "compatible",
      },
    ],
  });
  assert.equal(
    discovered.peers.some((peer) => peer.alias.startsWith("codex-")),
    false,
  );
  fake.truncated = true;
  assert.equal((await provider.discoverClaudePeers()).complete, false);
  fake.truncated = false;
  assert.equal((await provider.discoverClaudePeers()).complete, true);
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
    authorization: "selected_route",
    binding: binding(provider),
    messageId: GATEWAY_MESSAGE_ID,
    text: "synthetic body",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.deepEqual(result, { state: "pending" });
  assert.equal(fake.listenerUsed, true);
  assert.deepEqual(observed.deliveries, [
    {
      messageId: GATEWAY_MESSAGE_ID,
      state: "transport_uncertain",
      safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
    },
    { messageId: GATEWAY_MESSAGE_ID, state: "transport_written" },
  ]);
  assert.equal(JSON.stringify(observed.deliveries).includes(PROVIDER_MESSAGE_ID), false);

  fake.emitReceipt("held");
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: GATEWAY_MESSAGE_ID,
    state: "held",
  });
  fake.emitReceipt("released");
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: GATEWAY_MESSAGE_ID,
    state: "released",
  });
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
      diagnosticCode: "CLAUDE_SOURCE_ROUTE_STALE",
    },
  ]);

  await provider.close();
  assert.equal(fake.closed, true);
});

test("an exact live native sender stays outbound-unselected but can receive its correlated reply", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.discoverClaudePeers();
  await provider.advertiseNativeCodexPeer({
    alias: "codex-reviewer@this-mac",
    cwd: SAFE_WORKSPACE,
  });

  await fake.emitInbound("target-selected", "native unselected ingress");
  assert.deepEqual(observed.messages, [
    {
      endpoint: { ...provider.identity, routeHandle: "target-selected" },
      sourceAlias: "advisor@this-mac",
      targetAlias: "codex-reviewer@this-mac",
      text: "native unselected ingress",
      receiptHandle: "synthetic-receipt-handle",
    },
  ]);
  assert.deepEqual(observed.routes, []);

  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-message-unselected",
      text: "must remain blocked",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" },
  );
  assert.equal(fake.sendCalls, 0);

  assert.deepEqual(
    await provider.dispatch({
      authorization: "native_reply",
      binding: binding(provider),
      messageId: "gateway-message-native-reply",
      text: "correlated native reply",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(fake.sendCalls, 1);
  assert.deepEqual(observed.routes, []);

  fake.peers[0]!.alias = "renamed-advisor";
  assert.deepEqual(
    await provider.dispatch({
      authorization: "native_reply",
      binding: binding(provider),
      messageId: "gateway-message-native-reply-after-rename",
      text: "correlated native reply after same-session rename",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(fake.sendCalls, 2);

  fake.peers.splice(0, 1);
  assert.deepEqual(
    await provider.dispatch({
      authorization: "native_reply",
      binding: binding(provider),
      messageId: "gateway-message-stale-native-reply",
      text: "must not cross-deliver",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CLAUDE_NATIVE_REPLY_STALE" },
  );
  assert.equal(fake.sendCalls, 2);
  await provider.close();
});

test("native advertisement installs generation ownership before publication becomes visible", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  fake.afterAdvertiseVisible = async (generation) => {
    assert.equal(generation, INITIAL_LISTENER_GENERATION);
    await fake.emitInboundFrame({
      inboundId: "reentrant-advertise-inbound",
      content: "visible immediately after publication",
      sourceTargetId: "target-selected",
      sourceAlias: "advisor",
      receiptHandle: "reentrant-advertise-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
  };
  await provider.advertiseNativeCodexPeer({
    alias: "codex-visible@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  assert.deepEqual(observed.messages, [
    {
      endpoint: { ...provider.identity, routeHandle: "target-selected" },
      sourceAlias: "advisor@this-mac",
      targetAlias: "codex-visible@this-mac",
      text: "visible immediately after publication",
      receiptHandle: "reentrant-advertise-receipt",
    },
  ]);
  await provider.updateNativeInboundStatus(
    "reentrant-advertise-receipt",
    "delivered",
  );
  await provider.close();
});

test("recoverable advertisement failure retains provisional identity after re-entrant ingress", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  fake.afterAdvertiseVisible = async () => {
    await fake.emitInboundFrame({
      inboundId: "reentrant-failed-advertise-inbound",
      content: "must retain its provisional generation owner",
      sourceTargetId: "target-selected",
      sourceAlias: "advisor",
      receiptHandle: "reentrant-failed-advertise-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
    throw new BridgeError(
      "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
      "synthetic clean advertisement pre-write failure",
      true,
    );
  };
  await assert.rejects(
    provider.advertiseNativeCodexPeer({
      alias: "codex-provisional@this-mac",
      cwd: SAFE_WORKSPACE,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.recoverable,
  );
  assert.equal(observed.messages.length, 1);
  assert.equal(
    provider.currentNativeCodexPeerGeneration(
      "codex-provisional@this-mac",
    ),
    INITIAL_LISTENER_GENERATION,
  );
  await provider.updateNativeInboundStatus(
    "reentrant-failed-advertise-receipt",
    "expired",
    "ROUTE_UNAVAILABLE",
  );
  await provider.unadvertiseNativeCodexPeer("codex-provisional@this-mac");
  await assert.rejects(
    async () =>
      provider.currentNativeCodexPeerGeneration(
        "codex-provisional@this-mac",
      ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PEER_GENERATION_MISMATCH",
  );
  await provider.close();
});

test("overlapping same-alias advertisements reassert ownership after a clean first failure", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  await provider.initialize(callbacks().callbacks);
  let advertiseCalls = 0;
  let markFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  fake.afterAdvertiseVisible = async () => {
    advertiseCalls += 1;
    if (advertiseCalls !== 1) return;
    markFirstStarted();
    await firstMayFinish;
    throw new BridgeError(
      "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
      "synthetic clean first advertisement failure",
      true,
    );
  };
  const first = provider.advertiseNativeCodexPeer({
    alias: "codex-overlap@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  const firstRejected = assert.rejects(
    first,
    (error: unknown) =>
      error instanceof BridgeError && error.recoverable,
  );
  await firstStarted;
  const second = provider.advertiseNativeCodexPeer({
    alias: "codex-overlap@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  releaseFirst();
  await firstRejected;
  await second;
  assert.equal(advertiseCalls, 2);
  assert.equal(
    provider.currentNativeCodexPeerGeneration("codex-overlap@this-mac"),
    INITIAL_LISTENER_GENERATION,
  );
  await provider.close();
});

test("native Codex succession fences callbacks and retires only the exact old listener", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.advertiseNativeCodexPeer({
    alias: "codex-old@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  const initialGeneration = provider.currentNativeCodexPeerGeneration(
    "codex-old@this-mac",
  );
  assert.equal(initialGeneration, INITIAL_LISTENER_GENERATION);

  await provider.prepareNativeCodexPeerGeneration({
    alias: "codex-new@this-mac",
    cwd: SAFE_WORKSPACE,
    generation: "next_generation",
  });
  await assert.rejects(
    provider.prepareNativeCodexPeerGeneration({
      alias: "codex-third@this-mac",
      cwd: SAFE_WORKSPACE,
      generation: "third_generation",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PEER_SUCCESSION_CAPACITY",
  );

  await fake.emitInboundFrame(
    {
      inboundId: "prepared-before-activation",
      content: "must never reach the new alias",
      sourceTargetId: "target-selected",
      sourceAlias: "advisor",
      receiptHandle: "prepared-before-activation-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    },
    "next_generation",
  );
  assert.equal(observed.messages.length, 0);
  assert.deepEqual(fake.acknowledged.at(-1), {
    receiptHandle: "prepared-before-activation-receipt",
    status: "expired",
    diagnosticCode: "CLAUDE_NATIVE_GENERATION_STALE",
  });

  await fake.emitInboundFrame({
    inboundId: "old-owned-inbound",
    content: "old generation body",
    sourceTargetId: "target-selected",
    sourceAlias: "advisor",
    receiptHandle: "old-owned-receipt",
    replySupported: true,
    trust: "untrusted_same_uid_peer",
  });
  assert.equal(observed.messages.at(-1)?.targetAlias, "codex-old@this-mac");

  await provider.quiesceNativeCodexPeerGeneration(initialGeneration);
  assert.deepEqual(
    provider.observeNativeCodexSuccessionBarrier(initialGeneration),
    {
      generation: initialGeneration,
      activeGenerationMatched: true,
      ingressQuiesced: true,
      monitorFrozen: true,
      discoveryInFlight: false,
      pendingOutboundReceipts: 0,
      pendingInboundReceipts: 1,
      rejectedInboundSettlements: 0,
      clean: false,
    },
  );
  await provider.updateNativeInboundStatus("old-owned-receipt", "delivered");
  assert.equal(
    provider.observeNativeCodexSuccessionBarrier(initialGeneration).clean,
    true,
  );

  assert.equal(
    await provider.publishPreparedNativeCodexPeer({
      currentGeneration: initialGeneration,
      preparedGeneration: "next_generation",
    }),
    "published",
  );
  provider.activatePreparedNativeCodexPeerGeneration("next_generation");
  assert.deepEqual(fake.lifecycleCalls.slice(-2), [
    "grant:next_generation",
    "resume:next_generation",
  ]);
  assert.equal(
    provider.currentNativeCodexPeerGeneration("codex-new@this-mac"),
    "next_generation",
  );
  assert.deepEqual(fake.publications, [
    {
      currentGeneration: initialGeneration,
      preparedGeneration: "next_generation",
      name: "codex-new",
      cwd: SAFE_WORKSPACE,
    },
  ]);

  await fake.emitInboundFrame(
    {
      inboundId: "retired-generation-frame",
      content: "must not inherit the new alias",
      sourceTargetId: "target-selected",
      sourceAlias: "advisor",
      receiptHandle: "retired-generation-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    },
    initialGeneration,
  );
  assert.equal(observed.messages.length, 1);
  assert.deepEqual(fake.acknowledged.at(-1), {
    receiptHandle: "retired-generation-receipt",
    status: "expired",
    diagnosticCode: "CLAUDE_NATIVE_GENERATION_STALE",
  });

  await fake.emitInboundFrame(
    {
      inboundId: "new-generation-frame",
      content: "new generation body",
      sourceTargetId: "target-selected",
      sourceAlias: "advisor",
      receiptHandle: "new-generation-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    },
    "next_generation",
  );
  assert.equal(observed.messages.at(-1)?.targetAlias, "codex-new@this-mac");
  await provider.updateNativeInboundStatus("new-generation-receipt", "delivered");
  assert.deepEqual(
    await provider.dispatch({
      authorization: "native_reply",
      binding: binding(provider),
      messageId: "gateway-new-generation-reply",
      text: "reply through the exact new listener",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(fake.lastListenerGeneration, "next_generation");
  fake.emitReceipt("released", "next_generation");

  await assert.rejects(
    provider.prepareNativeCodexPeerGeneration({
      alias: "codex-third@this-mac",
      cwd: SAFE_WORKSPACE,
      generation: "third_generation",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PEER_SUCCESSION_CAPACITY",
  );
  await provider.retireNativeCodexPeerGeneration({
    retiredGeneration: initialGeneration,
    protectedActiveGeneration: "next_generation",
  });
  assert.deepEqual(fake.closedListenerGenerations, [
    initialGeneration,
  ]);
  assert.equal(fake.listeners.get("next_generation")?.closed, false);

  await provider.prepareNativeCodexPeerGeneration({
    alias: "codex-third@this-mac",
    cwd: SAFE_WORKSPACE,
    generation: "third_generation",
  });
  await provider.cleanupPreparedNativeCodexPeerGeneration("third_generation");
  assert.deepEqual(fake.closedListenerGenerations, [
    initialGeneration,
    "third_generation",
  ]);
  await provider.close();
});

test("native Codex succession rolls back only proven non-publication", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.advertiseNativeCodexPeer({
    alias: "codex-old@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  const initialGeneration = provider.currentNativeCodexPeerGeneration(
    "codex-old@this-mac",
  );
  await provider.prepareNativeCodexPeerGeneration({
    alias: "codex-rollback@this-mac",
    cwd: SAFE_WORKSPACE,
    generation: "rollback_generation",
  });
  await provider.quiesceNativeCodexPeerGeneration(initialGeneration);
  fake.publicationOutcome = "not_published";
  assert.equal(
    await provider.publishPreparedNativeCodexPeer({
      currentGeneration: initialGeneration,
      preparedGeneration: "rollback_generation",
    }),
    "not_published",
  );
  await provider.rollbackPreparedNativeCodexPeerGeneration({
    preparedGeneration: "rollback_generation",
    resumeGeneration: initialGeneration,
  });
  assert.deepEqual(fake.closedListenerGenerations, ["rollback_generation"]);
  assert.deepEqual(fake.resumedListenerGenerations, [
    initialGeneration,
  ]);

  await fake.emitInboundFrame({
    inboundId: "old-after-rollback",
    content: "old generation resumed",
    sourceTargetId: "target-selected",
    sourceAlias: "advisor",
    receiptHandle: "old-after-rollback-receipt",
    replySupported: true,
    trust: "untrusted_same_uid_peer",
  });
  assert.equal(observed.messages.at(-1)?.targetAlias, "codex-old@this-mac");
  await provider.updateNativeInboundStatus(
    "old-after-rollback-receipt",
    "delivered",
  );

  await provider.prepareNativeCodexPeerGeneration({
    alias: "codex-uncertain@this-mac",
    cwd: SAFE_WORKSPACE,
    generation: "uncertain_generation",
  });
  await provider.quiesceNativeCodexPeerGeneration(initialGeneration);
  fake.publicationOutcome = "unknown";
  assert.equal(
    await provider.publishPreparedNativeCodexPeer({
      currentGeneration: initialGeneration,
      preparedGeneration: "uncertain_generation",
    }),
    "unknown",
  );
  await assert.rejects(
    provider.cleanupPreparedNativeCodexPeerGeneration("uncertain_generation"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PEER_SUCCESSION_ROLLBACK_FORBIDDEN",
  );
  assert.equal(fake.listeners.get("uncertain_generation")?.closed, false);
  fake.publicationOutcome = "not_published";
  assert.equal(
    await provider.publishPreparedNativeCodexPeer({
      currentGeneration: initialGeneration,
      preparedGeneration: "uncertain_generation",
    }),
    "unknown",
  );
  await assert.rejects(
    provider.cleanupPreparedNativeCodexPeerGeneration("uncertain_generation"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_PEER_SUCCESSION_ROLLBACK_FORBIDDEN",
  );
  fake.publicationOutcome = "published";
  assert.equal(
    await provider.publishPreparedNativeCodexPeer({
      currentGeneration: initialGeneration,
      preparedGeneration: "uncertain_generation",
    }),
    "published",
  );
  provider.activatePreparedNativeCodexPeerGeneration("uncertain_generation");
  await provider.retireNativeCodexPeerGeneration({
    retiredGeneration: initialGeneration,
    protectedActiveGeneration: "uncertain_generation",
  });
  await provider.close();
});

test("native succession freezes discovery callbacks until resume", async () => {
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
  await provider.advertiseNativeCodexPeer({
    alias: "codex-old@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  const initialGeneration = provider.currentNativeCodexPeerGeneration(
    "codex-old@this-mac",
  );

  fake.setSelectedStatus("busy");
  const heldDiscovery = fake.holdNextDiscovery();
  const discovery = provider.discoverClaudePeers();
  await heldDiscovery.started;
  await provider.quiesceNativeCodexPeerGeneration(initialGeneration);
  assert.equal(
    provider.observeNativeCodexSuccessionBarrier(initialGeneration)
      .discoveryInFlight,
    true,
  );
  assert.equal(
    provider.observeNativeCodexSuccessionBarrier(initialGeneration).clean,
    false,
  );
  heldDiscovery.release();
  await discovery;
  assert.deepEqual(observed.routes, []);
  assert.equal(
    provider.observeNativeCodexSuccessionBarrier(initialGeneration).clean,
    true,
  );

  await provider.discoverClaudePeers();
  assert.deepEqual(observed.routes, []);
  provider.resumeNativeCodexPeerGeneration(initialGeneration);
  await provider.discoverClaudePeers();
  assert.deepEqual(observed.routes.at(-1), {
    endpoint: { ...provider.identity, routeHandle: "target-selected" },
    state: "busy",
  });
  await provider.close();
});

test("provider-owned invalid, stale, and capacity rejections retry only clean prewrites", async (t) => {
  const recoverable = () =>
    new BridgeError(
      "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
      "synthetic clean prewrite",
      true,
    );

  await t.test("invalid source", async () => {
    const fake = new FakeClaudePeer();
    fake.acknowledgeErrors.push(recoverable());
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      peerFactory: () => fake as never,
    });
    await provider.initialize(callbacks().callbacks);
    await fake.emitInboundFrame({
      inboundId: "invalid-inbound",
      content: "invalid source",
      receiptHandle: "invalid-receipt",
      replySupported: false,
      trust: "untrusted_anonymous_local_peer",
    });
    assert.equal(fake.acknowledgeAttempts.length, 2);
    assert.deepEqual(fake.acknowledged, [
      {
        receiptHandle: "invalid-receipt",
        status: "expired",
        diagnosticCode: "CLAUDE_SOURCE_ROUTE_INVALID",
      },
    ]);
    assert.deepEqual(fake.releasedInboundReceipts, []);
    await provider.close();
  });

  await t.test("stale source", async () => {
    const fake = new FakeClaudePeer();
    fake.acknowledgeErrors.push(recoverable());
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      peerFactory: () => fake as never,
    });
    await provider.initialize(callbacks().callbacks);
    await fake.emitInboundFrame({
      inboundId: "stale-inbound",
      content: "stale source",
      sourceTargetId: "missing-session-uuid",
      sourceAlias: "missing",
      receiptHandle: "stale-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
    assert.equal(fake.acknowledgeAttempts.length, 2);
    assert.deepEqual(fake.acknowledged, [
      {
        receiptHandle: "stale-receipt",
        status: "expired",
        diagnosticCode: "CLAUDE_SOURCE_ROUTE_STALE",
      },
    ]);
    assert.deepEqual(fake.releasedInboundReceipts, []);
    await provider.close();
  });

  await t.test("native ingress capacity", async () => {
    const fake = new FakeClaudePeer();
    fake.peers.push({
      targetId: "target-second",
      alias: "second",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    });
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      maxPendingMessages: 1,
      peerFactory: () => fake as never,
    });
    const observed = callbacks();
    await provider.initialize(observed.callbacks);
    await provider.advertiseNativeCodexPeer({
      alias: "codex-reviewer@this-mac",
      cwd: SAFE_WORKSPACE,
    });
    await fake.emitInbound("target-selected", "occupy native capacity");
    fake.acknowledgeErrors.push(recoverable());
    await fake.emitInboundFrame({
      inboundId: "capacity-inbound",
      content: "must be rejected at capacity",
      sourceTargetId: "target-second",
      sourceAlias: "second",
      receiptHandle: "capacity-receipt",
      replySupported: true,
      trust: "untrusted_same_uid_peer",
    });
    assert.equal(observed.messages.length, 1);
    assert.equal(fake.acknowledgeAttempts.length, 2);
    assert.deepEqual(fake.acknowledged, [
      {
        receiptHandle: "capacity-receipt",
        status: "expired",
        diagnosticCode: "CLAUDE_NATIVE_INGRESS_CAPACITY",
      },
    ]);
    assert.deepEqual(fake.releasedInboundReceipts, []);
    await provider.close();
  });
});

test("provider-owned rejection never replays ambiguity and releases exhausted or closing receipts", async (t) => {
  const invalidFrame = (receiptHandle: string): ClaudePeerInboundMessage => ({
    inboundId: `inbound-${receiptHandle}`,
    content: "invalid source",
    receiptHandle,
    replySupported: false,
    trust: "untrusted_anonymous_local_peer",
  });

  await t.test("ambiguous outcome", async () => {
    const fake = new FakeClaudePeer();
    fake.acknowledgeError = new BridgeError(
      "CLAUDE_PEER_RECEIPT_WRITE_AMBIGUOUS",
      "synthetic ambiguous receipt write",
    );
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      peerFactory: () => fake as never,
    });
    await provider.initialize(callbacks().callbacks);
    await fake.emitInboundFrame(invalidFrame("ambiguous-receipt"));
    assert.equal(fake.acknowledgeAttempts.length, 1);
    assert.deepEqual(fake.releasedInboundReceipts, ["ambiguous-receipt"]);
    await provider.close();
  });

  await t.test("retry budget exhausted", async () => {
    const fake = new FakeClaudePeer();
    fake.acknowledgeError = new BridgeError(
      "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
      "synthetic clean prewrite",
      true,
    );
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      peerFactory: () => fake as never,
    });
    await provider.initialize(callbacks().callbacks);
    await fake.emitInboundFrame(invalidFrame("exhausted-receipt"));
    assert.equal(fake.acknowledgeAttempts.length, 4);
    assert.deepEqual(fake.releasedInboundReceipts, ["exhausted-receipt"]);
    await provider.close();
  });

  await t.test("provider close", async () => {
    const fake = new FakeClaudePeer();
    fake.acknowledgeError = new BridgeError(
      "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
      "synthetic clean prewrite",
      true,
    );
    const provider = createLocalClaudeGatewayProvider({
      runtime: claudeRuntime(),
      discoveryPollMs: 30_000,
      peerFactory: () => fake as never,
    });
    await provider.initialize(callbacks().callbacks);
    const inbound = fake.emitInboundFrame(invalidFrame("closing-receipt"));
    await waitFor(() => fake.acknowledgeAttempts.length === 1);
    await provider.close();
    await inbound;
    assert.equal(fake.acknowledgeAttempts.length, 1);
    assert.deepEqual(fake.releasedInboundReceipts, ["closing-receipt"]);
  });
});

test("local Claude provider keeps progress distinct and propagates receipt outcomes", async () => {
  const fake = new FakeClaudePeer();
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
  });

  await assert.rejects(
    provider.updateNativeInboundStatus(
      "synthetic-receipt-handle",
      "delivered",
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PROVIDER_UNAVAILABLE",
  );

  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  fake.emitUnknownReceiptNotice();
  assert.deepEqual(observed.notices, [
    { code: "UNKNOWN_RECEIPT" },
  ]);
  await provider.advertiseNativeCodexPeer({
    alias: "codex-reviewer@this-mac",
    cwd: SAFE_WORKSPACE,
  });
  await fake.emitInbound();
  await provider.notifyNativeInboundProgress(
    "synthetic-receipt-handle",
    {
      kind: "stall",
      reason: "ROUTE_BUSY",
      queuedForMs: 12_345,
    },
  );
  assert.deepEqual(fake.progressed, [
    {
      receiptHandle: "synthetic-receipt-handle",
      progress: {
        kind: "stall",
        reason: "ROUTE_BUSY",
        queuedForMs: 12_345,
      },
    },
  ]);
  assert.deepEqual(fake.acknowledged, []);

  await fake.emitInboundFrame({
    inboundId: "terminal-success-inbound",
    content: "terminal success",
    sourceTargetId: "target-selected",
    sourceAlias: "advisor",
    receiptHandle: "terminal-success",
    replySupported: true,
    trust: "untrusted_same_uid_peer",
  });
  await provider.updateNativeInboundStatus(
    "terminal-success",
    "expired",
    "ROUTE_UNAVAILABLE",
  );
  assert.deepEqual(fake.acknowledged, [
    {
      receiptHandle: "terminal-success",
      status: "expired",
      diagnosticCode: "ROUTE_UNAVAILABLE",
    },
  ]);

  const terminalFailure = new BridgeError(
    "SYNTHETIC_ACK_FAILURE",
    "synthetic terminal failure",
  );
  fake.acknowledgeError = terminalFailure;
  await fake.emitInboundFrame({
    inboundId: "terminal-failure-inbound",
    content: "terminal failure",
    sourceTargetId: "target-selected",
    sourceAlias: "advisor",
    receiptHandle: "terminal-failure",
    replySupported: true,
    trust: "untrusted_same_uid_peer",
  });
  await assert.rejects(
    provider.updateNativeInboundStatus("terminal-failure", "denied"),
    (error: unknown) => error === terminalFailure,
  );

  const progressFailure = new BridgeError(
    "SYNTHETIC_PROGRESS_FAILURE",
    "synthetic progress failure",
  );
  fake.progressError = progressFailure;
  await fake.emitInboundFrame({
    inboundId: "progress-failure-inbound",
    content: "progress failure",
    sourceTargetId: "target-selected",
    sourceAlias: "advisor",
    receiptHandle: "progress-failure",
    replySupported: true,
    trust: "untrusted_same_uid_peer",
  });
  await assert.rejects(
    provider.notifyNativeInboundProgress("progress-failure", {
      kind: "stall",
      reason: "ROUTE_UNAVAILABLE",
      queuedForMs: 5_000,
    }),
    (error: unknown) => error === progressFailure,
  );

  assert.equal(
    await provider.releaseNativeInboundReceipt(
      "synthetic-receipt-handle",
    ),
    true,
  );
  assert.equal(
    await provider.releaseNativeInboundReceipt(
      "synthetic-receipt-handle",
    ),
    false,
  );
  assert.deepEqual(fake.releasedInboundReceipts, [
    "synthetic-receipt-handle",
  ]);
  await provider.close();
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
    authorization: "selected_route",
      binding: binding(provider),
      messageId: GATEWAY_MESSAGE_ID,
      text: "ambiguous synthetic body",
      expectsReply: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.deepEqual(observed.deliveries, [
    {
      messageId: GATEWAY_MESSAGE_ID,
      state: "transport_uncertain",
      safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
    },
  ]);
  fake.emitReceipt("released");
  assert.deepEqual(observed.deliveries, [
    {
      messageId: GATEWAY_MESSAGE_ID,
      state: "transport_uncertain",
      safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
    },
    { messageId: GATEWAY_MESSAGE_ID, state: "released" },
  ]);

  fake.sendMode = "prewrite_failure";
  assert.deepEqual(
    await provider.dispatch({
    authorization: "selected_route",
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

test("Claude provider settles deadline outcomes from transport evidence", async () => {
  const fake = new FakeClaudePeer();
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

  const confirmedDeadline = Date.now() + 120;
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-confirmed-no-native-ack",
      text: "confirmed transport only",
      expectsReply: false,
      deadlineAt: new Date(confirmedDeadline).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(fake.lastReceiptDeadlineAt, confirmedDeadline);
  await waitFor(() =>
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-confirmed-no-native-ack" &&
        event.state === "unconfirmed",
    ),
  );
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: "gateway-confirmed-no-native-ack",
    state: "unconfirmed",
    safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
  });

  const heldDeadline = Date.now() + 120;
  await provider.dispatch({
    authorization: "selected_route",
    binding: binding(provider),
    messageId: "gateway-held-no-terminal",
    text: "held transport",
    expectsReply: false,
    deadlineAt: new Date(heldDeadline).toISOString(),
  });
  fake.emitReceipt("held");
  await waitFor(() =>
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-held-no-terminal" &&
        event.state === "unconfirmed",
    ),
  );
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: "gateway-held-no-terminal",
    state: "unconfirmed",
    safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
  });

  fake.sendMode = "postwrite_ambiguous";
  const uncertainDeadline = Date.now() + 120;
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-uncertain-no-terminal",
      text: "uncertain transport",
      expectsReply: false,
      deadlineAt: new Date(uncertainDeadline).toISOString(),
    }),
    { state: "pending" },
  );
  await waitFor(() =>
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-uncertain-no-terminal" &&
        event.state === "ambiguous",
    ),
  );
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: "gateway-uncertain-no-terminal",
    state: "ambiguous",
    safeErrorCode: "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS",
  });

  fake.sendMode = "held_then_postwrite_ambiguous";
  const heldThenUncertainDeadline = Date.now() + 120;
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-held-then-uncertain",
      text: "held proves the write despite a later transport error",
      expectsReply: false,
      deadlineAt: new Date(heldThenUncertainDeadline).toISOString(),
    }),
    { state: "pending" },
  );
  await waitFor(() =>
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-held-then-uncertain" &&
        event.state === "unconfirmed",
    ),
  );
  assert.deepEqual(observed.deliveries.at(-1), {
    messageId: "gateway-held-then-uncertain",
    state: "unconfirmed",
    safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
  });
  assert.equal(
    observed.deliveries.some(
      (event) =>
        event.messageId === "gateway-held-then-uncertain" &&
        event.state === "ambiguous",
    ),
    false,
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
    authorization: "selected_route",
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
  assert.equal(observed.routes.at(-1)?.state, "busy");

  fake.emitReceipt("released");
  await provider.discoverClaudePeers();
  assert.equal(observed.routes.at(-1)?.state, "idle");
  await provider.close();
});

test("local Claude provider retains successful socket writes until exact receipts release capacity", async () => {
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
    authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-collision-1",
      text: "first",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  assert.equal(
    observed.deliveries.filter((event) => event.state === "released").length,
    0,
  );
  fake.emitReceipt("released");
  assert.deepEqual(
    await provider.dispatch({
    authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-collision-2",
      text: "second",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "pending" },
  );
  fake.emitReceipt("released");
  assert.equal(
    observed.deliveries.filter((event) => event.state === "released").length,
    2,
  );
  await provider.close();
});

test("an exact Claude receipt unlocks a second queued gateway send", async () => {
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
      EMBASSY_STATE_DIR: path.join(root, "state"),
      EMBASSY_HOSTS: "this-mac",
    }),
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

    assert.equal(fake.sendCalls, 1);
    fake.emitReceipt("released");
    await waitFor(() => fake.sendCalls === 2);
    fake.emitReceipt("released");
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
    private readonly faultAfterResume = false,
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
      if (this.faultAfterResume) {
        queueMicrotask(() => this.faultUnexpectedly());
      }
    } else if (message.method === "turn/start") {
      this.respond(message, {
        turn: { id: "turn-provider-1", status: "inProgress" },
      });
    } else if (message.method === "turn/steer") {
      const params = message.params as { expectedTurnId?: unknown };
      this.respond(message, { turnId: params.expectedTurnId });
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

  disconnectUnexpectedly(): void {
    for (const listener of [...this.closeListeners]) listener();
  }

  faultUnexpectedly(): void {
    for (const listener of [...this.errorListeners]) listener();
  }

  snapshotMessageListeners(): Array<(payload: string) => void> {
    return [...this.messageListeners];
  }

  emitTo(
    listeners: Array<(payload: string) => void>,
    message: unknown,
  ): void {
    const payload = JSON.stringify(message);
    for (const listener of listeners) listener(payload);
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
    steering: {
      method: "turn/steer" as const,
      requestSchema: "expected-turn-id-text-v1" as const,
      deliveryBoundary: "next-tool-call-boundary" as const,
    },
  };
  readonly writeCompatibility: typeof this.schemaCompatibility | null;
  readonly writableReady: boolean;
  readonly transports: FakeCodexTransport[] = [];
  connectAttempts = 0;
  connectGate: Promise<void> | undefined;
  closed = false;
  failNextConnect = false;
  faultNextRouteAfterResume = false;

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
    this.connectAttempts += 1;
    const gate = this.connectGate;
    this.connectGate = undefined;
    if (gate !== undefined) await gate;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("synthetic connection failure");
    }
    const faultAfterResume = this.faultNextRouteAfterResume;
    this.faultNextRouteAfterResume = false;
    const transport = new FakeCodexTransport(
      this.threadId,
      this.safePolicy,
      this.resumeStatus,
      this.completeInterrupt,
      faultAfterResume,
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
  options: {
    cleanupPollMs?: number;
    cleanupTimeoutMs?: number;
    recoveryInitialMs?: number;
    recoveryMaxMs?: number;
  } = {},
) {
  return createLocalCodexGatewayProvider({
    factory: factory as unknown as LocalCodexTransportFactory,
    ...options,
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

test("Codex succession barrier exposes only an exact quiet connector", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  assert.deepEqual(provider.observeRouteSuccessionBarrier(THREAD_ID), {
    routePresent: false,
    connection: "absent",
    routeStatus: "absent",
    queueDepth: 0,
    hasActiveTurn: false,
    requestInFlight: false,
    routeCreationInFlight: false,
    routeReleaseInFlight: false,
    pendingReplyCorrelations: 0,
    pendingCallbacks: 0,
    clean: false,
  });

  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await delayImmediate();
  assert.deepEqual(provider.observeRouteSuccessionBarrier(THREAD_ID), {
    routePresent: true,
    connection: "ready",
    routeStatus: "idle",
    queueDepth: 0,
    hasActiveTurn: false,
    requestInFlight: false,
    routeCreationInFlight: false,
    routeReleaseInFlight: false,
    pendingReplyCorrelations: 0,
    pendingCallbacks: 0,
    clean: true,
  });

  await provider.dispatch({
    authorization: "selected_route",
    binding: codexBinding(provider),
    messageId: "gateway-barrier-message",
    text: "keep the exact route non-quiet",
    expectsReply: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const busy = provider.observeRouteSuccessionBarrier(THREAD_ID);
  assert.equal(busy.clean, false);
  assert.equal(busy.hasActiveTurn, true);
  assert.equal(busy.pendingReplyCorrelations, 1);

  const transport = factory.transports[0]!;
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-barrier-final",
        phase: "final_answer",
        text: "barrier complete",
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
  assert.equal(provider.observeRouteSuccessionBarrier(THREAD_ID).clean, true);
  await provider.close();
});

test("local Codex provider attaches one exact route, refreshes it before write, and hands off a bounded final reply", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, {
    recoveryInitialMs: 1,
    recoveryMaxMs: 2,
  });
  const observed = callbacks();
  assert.deepEqual(await provider.initialize(observed.callbacks), {
    health: "healthy",
    compatibility: "compatible",
  });
  assert.deepEqual(
    await provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    { routeHandle: THREAD_ID, state: "idle" },
  );
  assert.equal(factory.transports.length, 1);

  assert.deepEqual(
    await provider.dispatch({
    authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: GATEWAY_MESSAGE_ID,
      text: "synthetic Codex request",
      expectsReply: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "accepted" },
  );
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(factory.transports.length, 1);
  await provider.close();
  assert.equal(factory.closed, true);
});

for (const failureMode of ["disconnect", "fault"] as const) {
  test(`explicit Codex route selection replaces a ${failureMode}ed connector without replaying ambiguous work`, async () => {
    const factory = new FakeCodexFactory(THREAD_ID, true);
    const provider = codexProvider(factory);
    const observed = callbacks();
    await provider.initialize(observed.callbacks);
    assert.deepEqual(
      await provider.selectRoute({
        alias: "codex-main@this-mac",
        routeHandle: THREAD_ID,
      }),
      { routeHandle: THREAD_ID, state: "idle" },
    );

    const first = factory.transports[0]!;
    const staleMessageListeners = first.snapshotMessageListeners();
    const messageId = `gateway-recover-${failureMode}`;
    assert.deepEqual(
      await provider.dispatch({
        authorization: "selected_route",
        binding: codexBinding(provider),
        messageId,
        text: "must become ambiguous, never replayed",
        expectsReply: false,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { state: "accepted" },
    );
    assert.equal(
      first.sent.filter((message) => message.method === "turn/start").length,
      1,
    );

    if (failureMode === "disconnect") first.disconnectUnexpectedly();
    else first.faultUnexpectedly();
    await delayImmediate();
    assert.equal(
      observed.deliveries.filter(
        (delivery) =>
          delivery.messageId === messageId && delivery.state === "ambiguous",
      ).length,
      1,
    );

    const recoveredSelections = await Promise.all([
      provider.selectRoute({
        alias: "codex-main@this-mac",
        routeHandle: THREAD_ID,
      }),
      provider.selectRoute({
        alias: "codex-main@this-mac",
        routeHandle: THREAD_ID,
      }),
    ]);
    assert.deepEqual(recoveredSelections, [
      { routeHandle: THREAD_ID, state: "idle" },
      { routeHandle: THREAD_ID, state: "idle" },
    ]);
    assert.equal(factory.transports.length, 2);
    assert.equal(first.cleanupConfirmed, true);
    const replacement = factory.transports[1]!;
    assert.equal(
      replacement.sent.some((message) => message.method === "turn/start"),
      false,
    );

    await delayImmediate();
    const routesBeforeStaleEvent = observed.routes.length;
    first.emitTo(staleMessageListeners, {
      method: "thread/status/changed",
      params: {
        status: { type: "active" },
        threadId: THREAD_ID,
      },
    });
    await delayImmediate();
    assert.equal(observed.routes.length, routesBeforeStaleEvent);

    await provider.close();
    assert.equal(replacement.cleanupConfirmed, true);
  });
}

test("a dead Codex connector becomes stale and auto-recovers without replay", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, {
    recoveryInitialMs: 1,
    recoveryMaxMs: 2,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  const first = factory.transports[0]!;
  const messageId = "gateway-auto-recovery";
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId,
      text: "settle once, then rebuild the route",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "accepted" },
  );
  first.disconnectUnexpectedly();

  await waitFor(() =>
    observed.routes.some(
      (event) =>
        event.endpoint.routeHandle === THREAD_ID &&
        event.state === "stale" &&
        event.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
  );
  assert.equal(
    observed.deliveries.filter(
      (event) => event.messageId === messageId && event.state === "ambiguous",
    ).length,
    1,
  );

  await waitFor(() => factory.transports.length === 2);
  await waitFor(() => observed.routes.at(-1)?.state === "idle");
  assert.equal(first.cleanupConfirmed, true);
  assert.equal(
    first.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  const replacement = factory.transports[1]!;
  assert.equal(
    replacement.sent.some((message) => message.method === "turn/start"),
    false,
  );

  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-after-auto-recovery",
      text: "use the rebuilt connector",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "accepted" },
  );
  assert.equal(
    replacement.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  await provider.close();
});

test("unusable Codex thread states are stale rather than busy and auto-recover", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, {
    recoveryInitialMs: 1,
    recoveryMaxMs: 2,
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  factory.transports[0]!.emit({
    method: "thread/closed",
    params: { threadId: THREAD_ID },
  });
  await waitFor(() =>
    observed.routes.some(
      (event) =>
        event.state === "stale" &&
        event.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
  );
  await waitFor(() => factory.transports.length === 2);
  await waitFor(() => observed.routes.at(-1)?.state === "idle");
  assert.equal(factory.transports[0]!.cleanupConfirmed, true);

  factory.transports[1]!.emit({
    method: "thread/status/changed",
    params: {
      status: { type: "systemError" },
      threadId: THREAD_ID,
    },
  });
  await waitFor(
    () =>
      observed.routes.filter((event) => event.state === "stale").length >= 2,
  );
  await waitFor(() => factory.transports.length === 3);
  await waitFor(() => observed.routes.at(-1)?.state === "idle");
  assert.equal(factory.transports[1]!.cleanupConfirmed, true);
  await provider.close();
});

test("explicit release joins an in-flight automatic recovery and closes its late replacement", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, {
    recoveryInitialMs: 1,
    recoveryMaxMs: 2,
  });
  await provider.initialize(callbacks().callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  let releaseConnect: (() => void) | undefined;
  factory.connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  factory.transports[0]!.disconnectUnexpectedly();
  await waitFor(() => factory.connectAttempts === 2);

  const released = provider.releaseRoute(THREAD_ID);
  releaseConnect?.();
  await released;
  assert.equal(factory.transports.length, 2);
  assert.equal(
    factory.transports.every((transport) => transport.cleanupConfirmed),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(factory.connectAttempts, 2);
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-after-explicit-release",
      text: "must not recreate the released route",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" },
  );
  await provider.close();
});

test("explicit selection can adopt an in-flight automatic recovery replacement", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory, {
    recoveryInitialMs: 1,
    recoveryMaxMs: 2,
  });
  await provider.initialize(callbacks().callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  let releaseConnect: (() => void) | undefined;
  factory.connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  factory.transports[0]!.disconnectUnexpectedly();
  await waitFor(() => factory.connectAttempts === 2);

  const selected = provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  releaseConnect?.();
  assert.deepEqual(await selected, { routeHandle: THREAD_ID, state: "idle" });
  assert.equal(factory.transports.length, 2);
  assert.equal(factory.transports[1]!.cleanupConfirmed, false);
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-after-explicit-reselection",
      text: "use the shared recovery replacement once",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "accepted" },
  );
  assert.equal(
    factory.transports[1]!.sent.filter(
      (message) => message.method === "turn/start",
    ).length,
    1,
  );
  await provider.close();
});

test("failed Codex route recovery removes the stale connector and leaves no writable route", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory);
  await provider.initialize(callbacks().callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });

  const stale = factory.transports[0]!;
  stale.disconnectUnexpectedly();
  factory.failNextConnect = true;
  await assert.rejects(
    provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    (error) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ROUTE_SETUP_REJECTED",
  );
  assert.equal(stale.cleanupConfirmed, true);
  assert.equal(factory.transports.length, 1);
  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-recovery-failed",
      text: "must not be written",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" },
  );
  assert.equal(
    stale.sent.some((message) => message.method === "turn/start"),
    false,
  );

  assert.deepEqual(
    await provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    { routeHandle: THREAD_ID, state: "idle" },
  );
  assert.equal(factory.transports.length, 2);
  await provider.close();
});

test("Codex route selection rejects a fresh connector that faults before acceptance", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  factory.faultNextRouteAfterResume = true;
  const provider = codexProvider(factory);
  await provider.initialize(callbacks().callbacks);

  await assert.rejects(
    provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    (error) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ROUTE_SETUP_REJECTED",
  );
  assert.equal(factory.transports.length, 1);
  assert.equal(factory.transports[0]!.cleanupConfirmed, true);
  assert.equal(
    factory.transports[0]!.sent.some(
      (message) => message.method === "turn/start",
    ),
    false,
  );

  assert.deepEqual(
    await provider.selectRoute({
      alias: "codex-main@this-mac",
      routeHandle: THREAD_ID,
    }),
    { routeHandle: THREAD_ID, state: "idle" },
  );
  assert.equal(factory.transports.length, 2);
  await provider.close();
});

test("an explicitly registered Codex route uses its native policy and remains reachable after settings updates", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true, false);
  const provider = codexProvider(factory);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
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
    authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-message-after-settings-update",
      text: "registered routes remain reachable",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "accepted" },
  );
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  assert.equal(observed.routes.some((event) => event.safeErrorCode !== undefined), false);

  await provider.close();
});

test("local Codex provider settles an exact active-turn steer at acceptance", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true, true, "active");
  const provider = codexProvider(factory);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  const transport = factory.transports[0]!;
  transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-provider-external", status: "inProgress" },
    },
  });

  assert.deepEqual(
    await provider.dispatch({
      authorization: "selected_route",
      binding: codexBinding(provider),
      messageId: "gateway-steer-active",
      text: "STEER: continue from the next tool boundary",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      steer: true,
    }),
    { state: "delivered" },
  );
  const steer = transport.sent.find(
    (message) => message.method === "turn/steer",
  );
  assert.deepEqual(steer?.params, {
    expectedTurnId: "turn-provider-external",
    input: [
      { text: "STEER: continue from the next tool boundary", type: "text" },
    ],
    threadId: THREAD_ID,
  });
  assert.equal(
    transport.sent.some((message) => message.method === "turn/interrupt"),
    false,
  );
  assert.equal(
    provider.observeRouteSuccessionBarrier(THREAD_ID).pendingReplyCorrelations,
    0,
  );
  await provider.close();
});

test("local Codex provider remains monitor-only without the distinct write attestation", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, false);
  const provider = codexProvider(factory);
  const observed = callbacks();
  assert.deepEqual(await provider.initialize(observed.callbacks), {
    health: "degraded",
    compatibility: "compatible",
    safeErrorCode: "CODEX_MONITOR_ONLY",
  });
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  assert.deepEqual(
    await provider.dispatch({
    authorization: "selected_route",
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
  await provider.close();
});

test("local Codex provider cancels queued work and confirms only its exact owned turn before proxy cleanup", async () => {
  const factory = new FakeCodexFactory(THREAD_ID, true);
  const provider = codexProvider(factory);
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await provider.dispatch({
    authorization: "selected_route",
    binding: codexBinding(provider),
    messageId: "gateway-active-owned",
    text: "active synthetic turn",
    expectsReply: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await provider.dispatch({
    authorization: "selected_route",
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
  const provider = codexProvider(factory);
  await provider.initialize(callbacks().callbacks);
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
  const provider = codexProvider(factory);
  await provider.initialize(callbacks().callbacks);
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
  const provider = codexProvider(factory, {
    cleanupPollMs: 5,
    cleanupTimeoutMs: 25,
  });
  await provider.initialize(callbacks().callbacks);
  await provider.selectRoute({
    alias: "codex-main@this-mac",
    routeHandle: THREAD_ID,
  });
  await provider.dispatch({
    authorization: "selected_route",
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
