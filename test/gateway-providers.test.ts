import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { after, test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type {
  ClaudePeerDescriptor,
  ClaudePeerInboundMessage,
  ClaudePeerInboundProgress,
  ClaudePeerListener,
  ClaudePeerListenerOptions,
  ClaudePeerPreparedSend,
} from "../src/gateway/claude-peer.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import type {
  ClaudeNativeHelperClientLike,
  ClaudeNativeHelperClientStartOptions,
} from "../src/gateway/claude-helper-client.js";
import type {
  ClaudeNativeHelperCommand,
  ClaudeNativeHelperResult,
} from "../src/gateway/claude-helper-protocol.js";
import type { CodexAppServerTransport } from "../src/gateway/codex-app-server.js";
import type { LocalCodexTransportFactory } from "../src/gateway/codex-local-transport.js";
import type {
  StatelessCodexAcceptedOperation,
  StatelessCodexActiveSteerInput,
  StatelessCodexActiveSteerResult,
  StatelessCodexOperationInput,
  StatelessCodexOperationResult,
  StatelessCodexOperationTransport,
  StatelessCodexWriteEvidence,
} from "../src/gateway/codex-stateless-transport.js";
import { createStatelessCodexOperationTransport } from "../src/gateway/codex-stateless-transport.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { loadGatewayNodeInventory } from "../src/gateway/federation-nodes.js";
import { composeProvenanceEnvelope } from "../src/gateway/provenance-envelope.js";
import { GatewayStore } from "../src/gateway/store.js";
import {
  createLocalClaudeGatewayProvider as createLocalClaudeGatewayProviderBase,
  createLocalCodexGatewayProvider,
} from "../src/gateway/providers.js";
import {
  GatewayService,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterDispatchInput,
  type GatewayAdapterCallbacks,
  type GatewayProviderAdapter,
} from "../src/gateway/service.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const PROVIDER_MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_MESSAGE_ID = "gateway-message-001";
const SAFE_WORKSPACE = "/workspace/synthetic-project";
const INITIAL_LISTENER_GENERATION = "listener_generation_1";
const SYNTHETIC_CONVERSATION_ID = "conv_0123456789abcdef";
const inventoryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "embassy-provider-inventory-")));
await writeFile(path.join(inventoryRoot, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}', { mode: 0o600 });
const nodeInventory = await loadGatewayNodeInventory(inventoryRoot);
await writeFile(path.join(inventoryRoot, "nodes.json"), '{"version":1,"host":"studio","nodes":[]}', { mode: 0o600 });
const studioInventory = await loadGatewayNodeInventory(inventoryRoot);
const localIdentity = { hostId: "this-mac", nodeInventory } as const;
const createLocalClaudeGatewayProvider = (options: Omit<Parameters<typeof createLocalClaudeGatewayProviderBase>[0], "hostId" | "nodeInventory">) =>
  createLocalClaudeGatewayProviderBase({ ...localIdentity, ...options });
after(async () => await rm(inventoryRoot, { recursive: true, force: true }));

function claudeProvenance(
  sourceAlias = "codex-reviewer@this-mac",
  targetAlias = "advisor@this-mac",
): Readonly<{
  attemptId: string;
  sourceProvider: "codex";
  sourceAlias: string;
  targetAlias: string;
  conversationId: string;
  authorizeWrite: GatewayAdapterDispatchInput["authorizeWrite"];
  onAccepted: GatewayAdapterDispatchInput["onAccepted"];
}> {
  return {
    attemptId: "attempt_claude_synthetic",
    sourceProvider: "codex",
    sourceAlias,
    targetAlias,
    conversationId: SYNTHETIC_CONVERSATION_ID,
    authorizeWrite: async () => true,
    onAccepted: async () => undefined,
  };
}

function callbacks(): {
  callbacks: GatewayAdapterCallbacks;
  replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][];
  messages: NonNullable<
    Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
  >[];
  notices: Array<{ code: string }>;
  routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][];
} {
  const replies: Parameters<GatewayAdapterCallbacks["onClaudeReply"]>[0][] = [];
  const messages: NonNullable<
    Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
  >[] = [];
  const notices: Array<{ code: string }> = [];
  const routes: Parameters<GatewayAdapterCallbacks["onRouteState"]>[0][] = [];
  return {
    callbacks: {
      onClaudeReply: (event) =>
        replies.push({ endpoint: { ...event.endpoint }, text: event.text }),
      onClaudeMessage: (event) =>
        messages.push({ ...event, endpoint: { ...event.endpoint } }),
      onProtocolNotice: (event) => notices.push({ ...event }),
      onRouteState: (event) =>
        routes.push({
          route: { ...event.route },
          state: event.state,
          observedAt: event.observedAt,
          ...(event.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: event.safeErrorCode }),
        }),
    },
    replies,
    messages,
    notices,
    routes,
  };
}

class CapturingNativeHelper implements ClaudeNativeHelperClientLike {
  readonly commands: ClaudeNativeHelperCommand[] = [];
  readonly pid: number;
  readonly registration: ClaudeNativeHelperClientLike["registration"];
  generation: string;
  performResult: GatewayAdapterDispatchResult = { state: "delivered" };
  prepareError: BridgeError | undefined;

  constructor(
    private readonly options: ClaudeNativeHelperClientStartOptions,
    index: number,
  ) {
    this.pid = 70_000 + index;
    this.registration = options.registration;
    this.generation = `capturing_helper_${index}`;
  }

  async request(
    command: ClaudeNativeHelperCommand,
  ): Promise<ClaudeNativeHelperResult> {
    this.commands.push(command);
    if (command.method === "prepare_dispatch") {
      if (this.prepareError !== undefined) throw this.prepareError;
      return {
        preparationId: `prep_${"a".repeat(24)}`,
        frameBytes: 321,
        sha256: "b".repeat(64),
      };
    }
    if (command.method === "perform_dispatch") return this.performResult;
    return { ok: true };
  }

  async close(): Promise<void> {
    this.options.callbacks.onExit({ code: 0, signal: null });
  }

  async forceClose(): Promise<void> {
    await this.close();
  }
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
      targetId: "target-background",
      alias: "bg9a04b5e9",
      kind: "bg",
      status: "idle",
      compatibility: "compatible",
    },
    {
      targetId: "target-daemon-worker",
      alias: "daemon-worker",
      kind: "daemon-worker",
      status: "idle",
      compatibility: "compatible",
    },
    {
      targetId: "target-codex-named-session",
      alias: "codex-cli",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    },
  ];
  listenerOptions: ClaudePeerListenerOptions | undefined;
  listenerUsed = false;
  prepareCalls = 0;
  performCalls = 0;
  cancelCalls = 0;
  lastPrepared:
    | { targetId: string; content: string; deadlineAt: number }
    | undefined;
  truncated = false;
  discoveryError: Error | undefined;
  rejectedDiscoveryRecords: Record<string, number> = {};
  parseableRejectedDiscoveryRecords = 0;
  asserted: Array<{ routeHandle: string; stateRoot: string }> = [];
  workspaceAttestationError: Error | undefined;
  closed = false;
  prepareError: Error | undefined;
  performError: Error | undefined;
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
      advertise: async (_name: string, _cwd: string) => {
        await this.afterAdvertiseVisible?.(generation);
      },
      unadvertise: async () => undefined,
      updateAdvertisedStatus: async () => undefined,
    } as unknown as ClaudePeerListener;
    return listener;
  }

  async listen(options: ClaudePeerListenerOptions): Promise<ClaudePeerListener> {
    this.listenerOptions = options;
    return this.listener;
  }

  async discover(): Promise<{
    peers: ClaudePeerDescriptor[];
    rejected: Record<string, number>;
    truncated: boolean;
    entriesScanned: number;
    parseableRecords: number;
  }> {
    if (this.discoveryError !== undefined) throw this.discoveryError;
    const peers = this.peers.map((peer) => ({ ...peer }));
    const hold = this.nextDiscoveryHold;
    this.nextDiscoveryHold = undefined;
    if (hold !== undefined) {
      hold.markStarted();
      await hold.wait;
    }
    const rejectedCount = Object.values(this.rejectedDiscoveryRecords).reduce(
      (sum, count) => sum + count,
      0,
    );
    return {
      peers,
      rejected: { ...this.rejectedDiscoveryRecords },
      truncated: this.truncated,
      entriesScanned: peers.length + rejectedCount,
      parseableRecords: peers.length + this.parseableRejectedDiscoveryRecords,
    };
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
    if (this.workspaceAttestationError !== undefined) {
      throw this.workspaceAttestationError;
    }
  }

  async resolveReplyAddress(address: string): Promise<ClaudePeerDescriptor> {
    if (address === "uds:/synthetic/selected.sock") return { ...this.peers[0]! };
    if (address === "uds:/synthetic/background.sock") return { ...this.peers[3]! };
    return {
      targetId: "target-unselected",
      alias: "other",
      kind: "interactive",
      status: "idle",
      compatibility: "compatible",
    };
  }

  async prepareSend(
    targetId: string,
    content: string,
    options: Readonly<{
      deadlineAt: number;
      replyListener?: ClaudePeerListener;
    }>,
  ): Promise<ClaudePeerPreparedSend> {
    this.prepareCalls += 1;
    this.lastPrepared = { targetId, content, deadlineAt: options.deadlineAt };
    this.listenerUsed = options.replyListener === this.listener;
    if (this.workspaceAttestationError !== undefined) {
      throw this.workspaceAttestationError;
    }
    if (this.prepareError !== undefined) throw this.prepareError;
    const frame = Buffer.from(`synthetic-frame:${targetId}:${content}`, "utf8");
    let state: "prepared" | "performed" | "cancelled" = "prepared";
    return Object.freeze({
      messageId: PROVIDER_MESSAGE_ID,
      frameBytes: frame.length,
      sha256: createHash("sha256").update(frame).digest("hex"),
      perform: async () => {
        if (state !== "prepared") {
          throw new BridgeError(
            "CLAUDE_PEER_PREPARATION_CONSUMED",
            "synthetic preparation consumed",
          );
        }
        state = "performed";
        this.performCalls += 1;
        if (this.performError !== undefined) throw this.performError;
        return {
          messageId: PROVIDER_MESSAGE_ID,
          transportStatus: "transport_written" as const,
        };
      },
      cancel: () => {
        if (state !== "prepared") return;
        state = "cancelled";
        this.cancelCalls += 1;
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
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
  ): Promise<void> {
    if (message.receiptHandle !== undefined) {
      this.liveInboundReceipts.add(message.receiptHandle);
    }
    await this.listenerOptions?.onMessage(message);
  }

  setSelectedStatus(status: "idle" | "busy" | "shell" | "waiting"): void {
    this.peers[0]!.status = status;
  }
}

class RegistrationOnlyCodexProvider implements GatewayProviderAdapter {
  readonly identity = {
    provider: "codex",
    hostId: "this-mac",
  } as const;
  readonly protocol = "synthetic-codex";
  readonly protocolVersion = "synthetic-1";

  async initialize(): Promise<{
    health: "healthy";
  }> {
    return { health: "healthy" };
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
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("synthetic wait timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function claudeRuntime(): AttestedClaudePeerRuntime {
  return {
    sessionsDir: "/synthetic/home/.claude/sessions",
    socketDir: "/synthetic/tmp/cc-socks",
  };
}

function binding(
  provider: ReturnType<typeof createLocalClaudeGatewayProvider>,
  routeHandle = "target-selected",
): GatewayAdapterDispatchInput["binding"] {
  const current = {
    ...provider.identity,
    routeHandle,
    registrationId: "registration_claude_synthetic",
  };
  provider.observeLogicalRoute({
    alias: "advisor@this-mac",
    routeHandle,
    registrationId: current.registrationId,
  });
  return current;
}

test("local Claude provider forwards the exact delivery notice policy", () => {
  const fake = new FakeClaudePeer();
  let receivedLocale: unknown;
  let receivedDeliveryNotices: unknown;
  createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    stateRoot: "/synthetic/controller-state",
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

test("Claude logical identity stays independent of runtime evidence", () => {
  const first = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    stateRoot: "/synthetic/controller-state",
    peerFactory: () => new FakeClaudePeer() as never,
  });
  const changedRuntime = {
    ...claudeRuntime(),
    sessionsDir: "/synthetic/alternate/.claude/sessions",
    socketDir: "/synthetic/tmp/alternate-cc-socks",
  };
  const changed = createLocalClaudeGatewayProvider({
    runtime: changedRuntime,
    stateRoot: "/synthetic/controller-state",
    peerFactory: () => new FakeClaudePeer() as never,
  });
  const future = createLocalClaudeGatewayProviderBase({
    hostId: "studio", nodeInventory: studioInventory,
    runtime: changedRuntime,
    stateRoot: "/synthetic/controller-state",
    peerFactory: () => new FakeClaudePeer() as never,
  });

  assert.deepEqual(first.identity, { provider: "claude", hostId: "this-mac" });
  assert.deepEqual(changed.identity, first.identity);
  assert.deepEqual(future.identity, { provider: "claude", hostId: "studio" });
  assert.throws(() => createLocalClaudeGatewayProviderBase({ hostId: "this-mac", nodeInventory: studioInventory,
    runtime: claudeRuntime(), stateRoot: "/synthetic/controller-state", peerFactory: () => new FakeClaudePeer() as never }),
  (error: unknown) => error instanceof BridgeError && error.code === "GATEWAY_REMOTE_PROVIDER_DISABLED");
});

test("Claude discovery admits named background sessions but never helper daemons", async () => {
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(), stateRoot: "/synthetic/controller-state",
    peerFactory: () => new FakeClaudePeer() as never,
  });
  await provider.initialize(callbacks().callbacks);
  try {
    assert.deepEqual((await provider.discoverClaudePeers()).peers, [
      { alias: "advisor@this-mac", routeHandle: "target-selected", kind: "interactive", state: "idle" },
      { alias: "bg9a04b5e9@this-mac", routeHandle: "target-background", kind: "bg", state: "idle" },
      { alias: "codex-cli@this-mac", routeHandle: "target-codex-named-session", kind: "interactive", state: "idle" },
    ]);
    assert.deepEqual(await provider.selectRoute({
      alias: "bg9a04b5e9@this-mac",
      routeHandle: "target-background",
    }), { routeHandle: "target-background", state: "idle" });
    assert.deepEqual(await provider.resolveReplyAddress("uds:/synthetic/background.sock"), {
      routeHandle: "target-background",
    });
  } finally {
    await provider.close();
  }
});

test("supervised Claude helpers preserve prepared-write evidence and provider binding", async () => {
  const fake = new FakeClaudePeer();
  const helpers: CapturingNativeHelper[] = [];
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    stateRoot: "/synthetic/controller-state",
    discoveryPollMs: 30_000,
    peerFactory: () => fake as never,
    nativeHelpers: {
      maxHelpers: 4,
      factory: async (options) => {
        const helper = new CapturingNativeHelper(options, helpers.length + 1);
        helpers.push(helper);
        return helper;
      },
    },
  });
  await provider.initialize(callbacks().callbacks);
  await provider.discoverClaudePeers();
  await provider.assertWorkspaceDisjoint(
    "target-selected",
    "/synthetic/controller-state",
  );
  await provider.selectRoute({
    alias: "advisor@this-mac",
    routeHandle: "target-selected",
  });

  await provider.advertiseNativeSourcePeer({
    alias: "dsh-misleading@this-mac",
    sourceProvider: "deepseek",
    cwd: SAFE_WORKSPACE,
  });
  await provider.advertiseNativeSourcePeer({
    alias: "grok-misleading@this-mac",
    sourceProvider: "grok",
    cwd: SAFE_WORKSPACE,
  });
  assert.deepEqual(
    helpers.map((helper) => helper.registration),
    [
      {
        alias: "dsh-misleading@this-mac",
        sourceProvider: "deepseek",
        cwd: SAFE_WORKSPACE,
      },
      {
        alias: "grok-misleading@this-mac",
        sourceProvider: "grok",
        cwd: SAFE_WORKSPACE,
      },
    ],
  );

  const send = async (
    sourceAlias: string,
    sourceProvider: "deepseek" | "grok",
    messageId: string,
  ) => {
    const helper = helpers.find(
      (candidate) => candidate.registration.alias === sourceAlias,
    )!;
    const performsBefore = helper.commands.filter(
      (command) => command.method === "perform_dispatch",
    ).length;
    let acceptedCalled = false;
    let evidence:
      | Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0]
      | undefined;
    const result =
    await provider.dispatch({
      attemptId: `attempt_${messageId}`,
      sourceAlias,
      sourceProvider,
      targetAlias: "advisor@this-mac",
      conversationId: SYNTHETIC_CONVERSATION_ID,
      authorization: "selected_route",
      binding: binding(provider),
      messageId,
      text: `${sourceProvider} to Claude`,
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      authorizeWrite: async (current) => {
        assert.equal(
          helper.commands.filter((command) => command.method === "perform_dispatch")
            .length,
          performsBefore,
        );
        evidence = current;
        return true;
      },
      onAccepted: async () => {
        acceptedCalled = true;
      },
    });
    if (evidence !== undefined) {
      assert.deepEqual(evidence, {
        attemptId: `attempt_${messageId}`,
        kind: "claude_mailbox",
        bodyBytes: Buffer.byteLength(`${sourceProvider} to Claude`, "utf8"),
        bodySha256: createHash("sha256")
          .update(`${sourceProvider} to Claude`)
          .digest("hex"),
        frameBytes: 321,
        sha256: "b".repeat(64),
      });
    }
    assert.equal(acceptedCalled, false);
    return result;
  };
  assert.deepEqual(
    await send(
      "dsh-misleading@this-mac",
      "deepseek",
      "gateway-deepseek-to-claude",
    ),
    { state: "delivered" },
  );
  assert.deepEqual(
    await send(
      "grok-misleading@this-mac",
      "grok",
      "gateway-grok-to-claude",
    ),
    { state: "delivered" },
  );
  const deepseekPreparations = helpers[0]!.commands.filter(
    (command) => command.method === "prepare_dispatch",
  );
  const grokPreparations = helpers[1]!.commands.filter(
    (command) => command.method === "prepare_dispatch",
  );
  assert.equal(deepseekPreparations.length, 1);
  assert.equal(grokPreparations.length, 1);
  assert.equal(deepseekPreparations[0]?.sourceProvider, "deepseek");
  assert.equal(grokPreparations[0]?.sourceProvider, "grok");
  assert.equal(deepseekPreparations[0]?.stateRoot, "/synthetic/controller-state");
  assert.equal(grokPreparations[0]?.stateRoot, "/synthetic/controller-state");

  assert.deepEqual(
    await provider.dispatch({
      ...claudeProvenance("dsh-misleading@this-mac"),
      sourceProvider: "deepseek",
      authorization: "native_reply",
      binding: binding(provider),
      messageId: "gateway-helper-native-reply",
      text: "reply through the selected UUID",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    { state: "delivered" },
  );
  const nativeReply = helpers[0]!.commands.filter(
    (command) => command.method === "prepare_dispatch",
  ).at(-1);
  assert.equal(nativeReply?.authorization, "native_reply");
  assert.equal(Object.hasOwn(nativeReply ?? {}, "stateRoot"), false);
  assert.equal(
    helpers[0]!.commands.filter((command) => command.method === "perform_dispatch")
      .length,
    2,
  );
  assert.equal(
    helpers[1]!.commands.filter((command) => command.method === "perform_dispatch")
      .length,
    1,
  );

  assert.deepEqual(
    await send(
      "dsh-misleading@this-mac",
      "grok",
      "gateway-wrong-source-provider",
    ),
    { state: "failed", safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" },
  );
  assert.equal(
    helpers[0]!.commands.filter((command) => command.method === "prepare_dispatch")
      .length,
    2,
  );

  const helper = helpers[0]!;
  const performsBeforeDenial = helper.commands.filter(
    (command) => command.method === "perform_dispatch",
  ).length;
  assert.deepEqual(
    await provider.dispatch({
      attemptId: "attempt_helper_denied",
      sourceAlias: "dsh-misleading@this-mac",
      sourceProvider: "deepseek",
      targetAlias: "advisor@this-mac",
      conversationId: SYNTHETIC_CONVERSATION_ID,
      authorization: "selected_route",
      binding: binding(provider),
      messageId: "gateway-helper-denied",
      text: "deny helper write",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      authorizeWrite: async () => false,
      onAccepted: async () => {
        assert.fail("Claude helper writes have no acceptance phase");
      },
    }),
    { state: "failed", safeErrorCode: "WRITE_AUTHORIZATION_DENIED" },
  );
  assert.equal(
    helper.commands.filter((command) => command.method === "perform_dispatch")
      .length,
    performsBeforeDenial,
  );
  assert.equal(helper.commands.at(-1)?.method, "cancel_dispatch");

  helper.performResult = {
    state: "ambiguous",
    safeErrorCode: "CLAUDE_PEER_WRITE_AMBIGUOUS",
  };
  assert.deepEqual(
    await send(
      "dsh-misleading@this-mac",
      "deepseek",
      "gateway-helper-ambiguous",
    ),
    { state: "ambiguous", safeErrorCode: "CLAUDE_PEER_WRITE_AMBIGUOUS" },
  );
  assert.equal(
    helper.commands.filter((command) => command.method === "perform_dispatch")
      .length,
    performsBeforeDenial + 1,
  );
  await provider.close();
});

test("service restart restores selected Claude authority into per-operation preparation", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "embassy-claude-restart-")));
  const config = loadGatewayConfig({ EMBASSY_STATE_DIR: path.join(root, "state") }, { host: "this-mac", nodes: [] });
  const storedClaude = {
    alias: "advisor@this-mac",
    binding: { provider: "claude" as const, hostId: "this-mac", routeHandle: "target-selected",
      registrationId: "reg_claude_restored" }, registrationMode: "selected_live_peer" as const,
  };
  const storedCodex = {
    alias: "codex-main@this-mac",
    binding: { provider: "codex" as const, hostId: "this-mac", routeHandle: THREAD_ID,
      registrationId: "reg_codex_restored" }, registrationMode: "explicit_opt_in" as const,
  };
  const seed = new GatewayStore(config);
  await seed.initialize();
  await seed.registerRoute(storedClaude); await seed.registerRoute(storedCodex);
  await seed.addConsentEdge({ aliases: [storedClaude.alias, storedCodex.alias],
    expectedRegistrationIds: [storedClaude.binding.registrationId, storedCodex.binding.registrationId] });
  await seed.close();

  const peer = new FakeClaudePeer(), helpers: CapturingNativeHelper[] = [];
  const provider = createLocalClaudeGatewayProvider({ runtime: claudeRuntime(), stateRoot: config.stateDir,
    discoveryPollMs: 30_000, peerFactory: () => peer as never, nativeHelpers: { maxHelpers: 1,
      factory: async (options) => { const helper = new CapturingNativeHelper(options, 1); helpers.push(helper); return helper; } } });
  const service = new GatewayService({ config, adapters: [provider, new RegistrationOnlyCodexProvider()],
    nativePeerCwd: root });
  try {
    await service.start(); await waitFor(() => helpers.length === 1);
    const sent = await service.handlers().send({ fromAlias: storedCodex.alias, threadId: THREAD_ID,
      toAlias: storedClaude.alias, text: "post-restart", expectsReply: false });
    assert.equal(sent.accepted, true);
    await waitFor(() => helpers[0]!.commands.some((command) => command.method === "prepare_dispatch"));
    const prepared = helpers[0]!.commands.find((command) => command.method === "prepare_dispatch");
    assert.equal(prepared?.method, "prepare_dispatch");
    if (prepared?.method !== "prepare_dispatch") assert.fail("expected restored preparation");
    assert.deepEqual(prepared.binding, storedClaude.binding);
    assert.equal(prepared.stateRoot, config.stateDir);
    await waitFor(async () => {
      if (!sent.accepted) return false;
      const status = await service.handlers().deliveryStatus({ token: sent.deliveryToken });
      return status.found && status.state === "delivered";
    });
  } finally {
    await service.close().catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});

test("Claude clean prewrite conditions retain exact diagnostics without authorization", async () => {
  const fake = new FakeClaudePeer();
  let helper: CapturingNativeHelper | undefined;
  const provider = createLocalClaudeGatewayProvider({
    runtime: claudeRuntime(),
    stateRoot: "/synthetic/controller-state",
    peerFactory: () => fake as never,
    nativeHelpers: {
      maxHelpers: 1,
      factory: async (options) => helper = new CapturingNativeHelper(options, 1),
    },
  });
  const observed = callbacks();
  await provider.initialize(observed.callbacks);
  await provider.discoverClaudePeers();
  await provider.assertWorkspaceDisjoint("target-selected", "/synthetic/controller-state");
  await provider.selectRoute({ alias: "advisor@this-mac", routeHandle: "target-selected" });
  await provider.advertiseNativeSourcePeer({
    alias: "dsh-main@this-mac",
    sourceProvider: "deepseek",
    cwd: SAFE_WORKSPACE,
  });

  let authorizationCalls = 0;
  for (const code of [
    "CLAUDE_PEER_TARGET_UNKNOWN",
    "CLAUDE_PEER_TARGET_STALE",
    "CLAUDE_PEER_TARGET_CHANGED",
    "CLAUDE_PEER_WORKSPACE_UNATTESTED",
  ]) {
    helper!.prepareError = new BridgeError(code, "synthetic clean prewrite", true);
    const performs = helper!.commands.filter(
      (command) => command.method === "perform_dispatch",
    ).length;
    assert.deepEqual(await provider.dispatch({
      ...claudeProvenance("dsh-main@this-mac"),
      sourceProvider: "deepseek",
      authorization: "selected_route",
      binding: binding(provider),
      messageId: `gateway-${code.toLowerCase()}`,
      text: "clean prewrite retry",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      authorizeWrite: async () => { authorizationCalls += 1; return true; },
    }), { state: "deferred", safeErrorCode: "ROUTE_BUSY" });
    assert.equal(authorizationCalls, 0);
    assert.equal(helper!.commands.filter(
      (command) => command.method === "perform_dispatch",
    ).length, performs);
    assert.equal(observed.routes.at(-1)?.safeErrorCode, code);
    assert.equal(observed.routes.at(-1)?.state, "busy");
  }
  await provider.close();
});

type CodexOperationHandler = (
  input: StatelessCodexOperationInput,
) => Promise<StatelessCodexOperationResult>;

class FakeStatelessCodexOperation implements StatelessCodexOperationTransport {
  readonly inputs: StatelessCodexOperationInput[] = [];
  readonly observations: string[] = [];
  observationHandler: StatelessCodexOperationTransport["observe"] = async () => ({
    state: "idle",
  });
  handler: CodexOperationHandler = async (input) => ({
    attemptId: input.attemptId,
    cleanupConfirmed: true,
    outcome: "delivered",
    phase: "terminal",
    replyCode: null,
    replyText: null,
    state: "terminal",
  });

  async execute(input: StatelessCodexOperationInput) {
    this.inputs.push(input);
    return await this.handler(input);
  }

  async observe(
    route: Parameters<StatelessCodexOperationTransport["observe"]>[0],
    signal?: AbortSignal,
  ) {
    this.observations.push(route.threadId);
    return await this.observationHandler(route, signal);
  }
}

function createCodexProviderFixture(
  operation = new FakeStatelessCodexOperation(),
  options: Partial<Parameters<typeof createLocalCodexGatewayProvider>[0]> = {},
) {
  if (
    operation instanceof FakeStatelessCodexOperation &&
    options.createObservationFactory !== undefined
  ) {
    const observer = createStatelessCodexOperationTransport({}, {
      createFactory: async () => await options.createObservationFactory!(),
    });
    operation.observationHandler = observer.observe;
  }
  const provider = createLocalCodexGatewayProvider({
    ...options,
    hostId: options.hostId ?? localIdentity.hostId,
    nodeInventory: options.nodeInventory ?? localIdentity.nodeInventory,
    operation,
  });
  const observed = callbacks();
  return { observed, operation, provider };
}

function codexDispatchInput(
  provider: ReturnType<typeof createLocalCodexGatewayProvider>,
  overrides: Partial<GatewayAdapterDispatchInput> = {},
): GatewayAdapterDispatchInput {
  return {
    attemptId: "attempt_codex_start_1",
    authorization: "selected_route",
    authorizeWrite: async () => true,
    binding: {
      ...provider.identity,
      registrationId: "registration_codex_1",
      routeHandle: THREAD_ID,
    },
    conversationId: SYNTHETIC_CONVERSATION_ID,
    deadlineAt: "2099-01-01T00:00:00.000Z",
    expectsReply: true,
    messageId: "msg_00000000-0000-7000-8000-000000000702",
    onAccepted: async () => undefined,
    sourceAlias: "claude-advisor@this-mac",
    sourceProvider: "claude",
    targetAlias: "codex-main@this-mac",
    text: "synthetic raw body",
    ...overrides,
  };
}

function observeCodexFixture(
  provider: ReturnType<typeof createLocalCodexGatewayProvider>,
  input: GatewayAdapterDispatchInput,
): void {
  provider.observeLogicalRoute({
    alias: input.targetAlias,
    registrationId: input.binding.registrationId,
    routeHandle: input.binding.routeHandle,
  });
}

function observationTransport(threadId: string): CodexAppServerTransport & {
  readonly cleanupConfirmed: true;
  sent: Array<{ method?: string }>;
} {
  const listeners = new Set<(payload: string) => void>();
  const sent: Array<{ id?: number; method?: string }> = [];
  return {
    cleanupConfirmed: true,
    sent,
    close: async () => undefined,
    onClose: () => () => undefined,
    onError: () => () => undefined,
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (payload) => {
      const frame = JSON.parse(payload) as { id?: number; method?: string };
      sent.push(frame);
      if (frame.id === undefined) return;
      const result = frame.method === "thread/resume"
        ? { thread: { id: threadId, status: { type: "idle" }, turns: [] } }
        : {};
      for (const listener of listeners) {
        listener(JSON.stringify({ id: frame.id, result }));
      }
    },
  };
}

test("stateless Codex dispatch authorizes exact raw and framed evidence", async () => {
  const { observed, operation, provider } = createCodexProviderFixture();
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);
  let authorized:
    | Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0]
    | undefined;
  let acceptedAttempt: string | undefined;
  operation.handler = async (current) => {
    assert.deepEqual(current.route, {
      alias: input.targetAlias,
      hostId: "this-mac",
      registrationId: input.binding.registrationId,
      threadId: input.binding.routeHandle,
    });
    assert.equal(
      current.text,
      composeProvenanceEnvelope({
        body: input.text,
        conversationId: input.conversationId,
        recipientProvider: "codex",
        sourceAlias: input.sourceAlias,
        sourceProvider: input.sourceProvider,
        targetAlias: input.targetAlias,
      }),
    );
    assert.equal(
      await current.authorizeWrite({
        attemptId: current.attemptId,
        bodyBytes: Buffer.byteLength(current.text, "utf8"),
        frameBytes: 701,
        kind: "codex_turn_start",
        sha256: "a".repeat(64),
      }),
      true,
    );
    await current.onAccepted({
      attemptId: current.attemptId,
      steer: async () => ({
        attemptId: "unused",
        outcome: "delivered",
        phase: "terminal",
        replyCode: "REPLY_UNAVAILABLE",
        replyText: null,
        state: "terminal",
      }),
      turnId: "turn_ephemeral_never_projected",
    });
    return {
      attemptId: current.attemptId,
      cleanupConfirmed: false,
      outcome: "delivered",
      phase: "terminal",
      replyCode: null,
      replyText: "synthetic reply",
      state: "terminal",
    };
  };

  assert.deepEqual(
    await provider.dispatch({
      ...input,
      authorizeWrite: async (evidence) => {
        authorized = evidence;
        return true;
      },
      onAccepted: async ({ attemptId }) => {
        acceptedAttempt = attemptId;
      },
    }),
    { state: "delivered", replyText: "synthetic reply" },
  );
  assert.deepEqual(authorized, {
    attemptId: input.attemptId,
    bodyBytes: Buffer.byteLength(input.text, "utf8"),
    bodySha256: createHash("sha256").update(input.text).digest("hex"),
    frameBytes: 701,
    kind: "codex_turn_start",
    sha256: "a".repeat(64),
  });
  assert.equal(acceptedAttempt, input.attemptId);
  const cleanupObservation = observed.routes.at(-1);
  assert.equal(cleanupObservation?.state, "unobserved");
  assert.equal(cleanupObservation?.safeErrorCode, "CLEANUP_FAILED");
  assert.deepEqual(cleanupObservation?.route, {
    hostId: "this-mac",
    provider: "codex",
    registrationId: input.binding.registrationId,
    routeHandle: input.binding.routeHandle,
  });
  assert.equal(
    JSON.stringify(observed.routes).includes("turn_ephemeral_never_projected"),
    false,
  );
  await provider.close();
});

test("Codex STEER uses only the exact accepted registration and raw body evidence", async () => {
  const { observed, operation, provider } = createCodexProviderFixture();
  await provider.initialize(observed.callbacks);
  const startInput = codexDispatchInput(provider);
  observeCodexFixture(provider, startInput);
  let releaseStart!: () => void;
  const startTerminal = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let accepted!: () => void;
  const acceptedReady = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let steerEvidence:
    | Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0]
    | undefined;

  operation.handler = async (current) => {
    const active: StatelessCodexAcceptedOperation = {
      attemptId: current.attemptId,
      turnId: "turn_ephemeral_steer",
      steer: async (
        steerInput: StatelessCodexActiveSteerInput,
      ): Promise<StatelessCodexActiveSteerResult> => {
        await steerInput.authorizeWrite({
          attemptId: steerInput.attemptId,
          bodyBytes: Buffer.byteLength(steerInput.text, "utf8"),
          frameBytes: 811,
          kind: "codex_turn_steer",
          sha256: "b".repeat(64),
        });
        return {
          attemptId: steerInput.attemptId,
          outcome: "delivered",
          phase: "terminal",
          replyCode: "REPLY_UNAVAILABLE",
          replyText: null,
          state: "terminal",
        };
      },
    };
    await current.onAccepted(active);
    accepted();
    await startTerminal;
    return {
      attemptId: current.attemptId,
      cleanupConfirmed: true,
      outcome: "delivered",
      phase: "terminal",
      replyCode: null,
      replyText: null,
      state: "terminal",
    };
  };

  const start = provider.dispatch(startInput);
  await acceptedReady;
  const steer = codexDispatchInput(provider, {
    attemptId: "attempt_codex_steer_1",
    authorizeWrite: async (evidence) => {
      steerEvidence = evidence;
      return true;
    },
    messageId: "msg_00000000-0000-7000-8000-000000000703",
    steer: true,
    text: "STEER: synthetic direction",
  });
  assert.deepEqual(await provider.dispatch(steer), { state: "delivered" });
  assert.deepEqual(steerEvidence, {
    attemptId: steer.attemptId,
    bodyBytes: Buffer.byteLength(steer.text, "utf8"),
    bodySha256: createHash("sha256").update(steer.text).digest("hex"),
    frameBytes: 811,
    kind: "codex_turn_steer",
    sha256: "b".repeat(64),
  });
  assert.deepEqual(
    await provider.dispatch({
      ...steer,
      binding: { ...steer.binding, routeHandle: "different-thread" },
    }),
    { state: "deferred", safeErrorCode: "ROUTE_BUSY" },
  );
  provider.forgetLogicalRoute(startInput.binding.registrationId);
  assert.deepEqual(await provider.dispatch(steer), {
    state: "deferred",
    safeErrorCode: "ROUTE_BUSY",
  });
  releaseStart();
  assert.deepEqual(await start, { state: "delivered" });
  await provider.close();
});

test("Codex provider preserves the closed clean retry and phase mapping table", async () => {
  const { observed, operation, provider } = createCodexProviderFixture();
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);
  const results: StatelessCodexOperationResult[] = [
    { attemptId: "a", cleanupConfirmed: true, phase: "clean", safeErrorCode: "THREAD_NOT_OBSERVED", state: "deferred" },
    { attemptId: "b", cleanupConfirmed: true, phase: "clean", safeErrorCode: "MESSAGE_EXPIRED", state: "deferred" },
    { attemptId: "c", cleanupConfirmed: true, phase: "clean", safeErrorCode: "HOME_INVALID", state: "failed" },
    { attemptId: "d", cleanupConfirmed: true, phase: "armed", safeErrorCode: "TRANSPORT_WRITE_FAILED", state: "ambiguous" },
    { attemptId: "e", cleanupConfirmed: true, phase: "accepted", safeErrorCode: "ACCEPTANCE_UNCONFIRMED", state: "unconfirmed" },
    { attemptId: "f", cleanupConfirmed: false, outcome: "interrupted", phase: "terminal", replyCode: null, replyText: null, state: "terminal" },
  ];
  operation.handler = async () => results.shift()!;

  assert.deepEqual(await provider.dispatch(input), { state: "deferred", safeErrorCode: "THREAD_NOT_OBSERVED" });
  assert.deepEqual(await provider.dispatch(input), { state: "expired", safeErrorCode: "MESSAGE_EXPIRED" });
  assert.deepEqual(await provider.dispatch(input), { state: "failed", safeErrorCode: "HOME_INVALID" });
  assert.deepEqual(await provider.dispatch(input), { state: "ambiguous", safeErrorCode: "TRANSPORT_WRITE_FAILED" });
  assert.deepEqual(await provider.dispatch(input), { state: "unconfirmed", safeErrorCode: "ACCEPTANCE_UNCONFIRMED" });
  assert.deepEqual(await provider.dispatch(input), { state: "cancelled", safeErrorCode: "CODEX_TURN_INTERRUPTED" });
  await provider.close();
});

test("Codex provider close aborts its exact active operation without interrupt RPC", async () => {
  const { observed, operation, provider } = createCodexProviderFixture();
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  operation.handler = async (current) => {
    began();
    return await new Promise<StatelessCodexOperationResult>((resolve) => {
      current.signal?.addEventListener(
        "abort",
        () =>
          resolve({
            attemptId: current.attemptId,
            cleanupConfirmed: true,
            phase: "clean",
            safeErrorCode: "TRANSPORT_CLOSED",
            state: "failed",
          }),
        { once: true },
      );
    });
  };

  const dispatch = provider.dispatch(input);
  await started;
  await provider.close();
  assert.equal(operation.inputs[0]?.signal?.aborted, true);
  assert.deepEqual(await dispatch, {
    state: "failed",
    safeErrorCode: "TRANSPORT_CLOSED",
  });
});

test("Codex provider close does not wait for pre-connect operation work", async () => {
  const { observed, operation, provider } = createCodexProviderFixture();
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let finish!: (result: StatelessCodexOperationResult) => void;
  operation.handler = async () => {
    began();
    return await new Promise<StatelessCodexOperationResult>((resolve) => {
      finish = resolve;
    });
  };

  const dispatch = provider.dispatch(input);
  await started;
  await provider.close();
  assert.equal(operation.inputs[0]?.signal?.aborted, true);
  finish({
    attemptId: input.attemptId,
    cleanupConfirmed: true,
    phase: "clean",
    safeErrorCode: "TRANSPORT_CLOSED",
    state: "failed",
  });
  assert.deepEqual(await dispatch, {
    state: "failed",
    safeErrorCode: "TRANSPORT_CLOSED",
  });
});

function manualProviderTimers() {
  type Entry = {
    callback: () => void;
    delayMs: number;
    handle: NodeJS.Timeout;
  };
  const pending: Entry[] = [];
  return {
    timers: {
      clearTimeout: (handle: NodeJS.Timeout) => {
        const index = pending.findIndex((entry) => entry.handle === handle);
        if (index >= 0) pending.splice(index, 1);
      },
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
        pending.push({ callback, delayMs, handle });
        return handle;
      },
    },
    runNext: () => {
      const entry = pending.shift();
      assert.ok(entry);
      entry.callback();
      return entry.delayMs;
    },
    size: () => pending.length,
  };
}

test("Codex observer aborts hung setup and disposes factory or transport that resolves late", async (t) => {
  await t.test("factory setup", async () => {
    const manual = manualProviderTimers();
    let started!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resolveFactory!: (factory: LocalCodexTransportFactory) => void;
    const lateFactory = new Promise<LocalCodexTransportFactory>((resolve) => {
      resolveFactory = resolve;
    });
    let factoryCloses = 0;
    const { observed, provider } = createCodexProviderFixture(
      new FakeStatelessCodexOperation(),
      {
        createObservationFactory: async () => {
          started();
          return await lateFactory;
        },
        observationPollMs: 10,
        observationTimeoutMs: 10,
        timers: manual.timers,
      },
    );
    await provider.initialize(observed.callbacks);
    const input = codexDispatchInput(provider);
    observeCodexFixture(provider, input);

    assert.equal(manual.runNext(), 0);
    await setupStarted;
    await provider.close();
    assert.equal(observed.routes.length, 0);
    assert.equal(manual.size(), 0);

    resolveFactory({
      appServerVersion: "synthetic",
      endpointGeneration: "late-observer-factory",
      hostId: "this-mac",
      protocol: "codex-app-server",
      protocolVersion: "synthetic",
      close: async () => {
        factoryCloses += 1;
      },
      connectTransport: async () => {
        assert.fail("an aborted late factory must never connect");
      },
    });
    await waitFor(() => factoryCloses === 1);
    assert.equal(observed.routes.length, 0);
  });

  await t.test("transport setup", async () => {
    const manual = manualProviderTimers();
    let started!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resolveTransport!: (transport: CodexAppServerTransport) => void;
    const lateTransport = new Promise<CodexAppServerTransport>((resolve) => {
      resolveTransport = resolve;
    });
    let factoryCloses = 0;
    let transportCloses = 0;
    const { observed, provider } = createCodexProviderFixture(
      new FakeStatelessCodexOperation(),
      {
        createObservationFactory: async () => ({
          appServerVersion: "synthetic",
          endpointGeneration: "late-observer-transport",
          hostId: "this-mac",
          protocol: "codex-app-server",
          protocolVersion: "synthetic",
          close: async () => {
            factoryCloses += 1;
          },
          connectTransport: async () => {
            started();
            return await lateTransport as never;
          },
        }),
        observationPollMs: 10,
        observationTimeoutMs: 10,
        timers: manual.timers,
      },
    );
    await provider.initialize(observed.callbacks);
    const input = codexDispatchInput(provider);
    observeCodexFixture(provider, input);

    assert.equal(manual.runNext(), 0);
    await setupStarted;
    await provider.close();
    assert.equal(factoryCloses, 1);
    assert.equal(observed.routes.length, 0);
    assert.equal(manual.size(), 0);

    resolveTransport({
      close: async () => {
        transportCloses += 1;
      },
      onClose: () => () => undefined,
      onError: () => () => undefined,
      onMessage: () => () => undefined,
      send: async () => undefined,
    });
    await waitFor(() => transportCloses === 1);
    assert.equal(observed.routes.length, 0);
  });
});

test("Codex observer bounds a hung transport write and schedules reconnect", async () => {
  const operation = new FakeStatelessCodexOperation();
  const manual = manualProviderTimers();
  const hanging: CodexAppServerTransport = {
    close: async () => undefined,
    onClose: () => () => undefined,
    onError: () => () => undefined,
    onMessage: () => () => undefined,
    send: async () => await new Promise<void>(() => undefined),
  };
  let factoryCloses = 0;
  const { observed, provider } = createCodexProviderFixture(operation, {
    createObservationFactory: async () => ({
      appServerVersion: "synthetic",
      endpointGeneration: "observer-hung-write",
      hostId: "this-mac",
      protocol: "codex-app-server",
      protocolVersion: "synthetic",
      close: async () => {
        factoryCloses += 1;
      },
      connectTransport: async () => hanging as never,
    }),
    observationBackoffMaxMs: 40,
    observationPollMs: 10,
    observationTimeoutMs: 10,
    timers: manual.timers,
  });
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);

  assert.equal(manual.runNext(), 0);
  await waitFor(() => manual.size() === 1);
  assert.equal(manual.runNext(), 10);
  await waitFor(() => observed.routes.length === 1);
  assert.equal(observed.routes[0]?.state, "unobserved");
  assert.equal(observed.routes[0]?.safeErrorCode, "CODEX_OBSERVER_UNAVAILABLE");
  assert.equal(factoryCloses, 1);
  assert.equal(manual.size(), 1);
  await provider.close();
});

test("Codex registration is zero-I/O and its observer reconnects without semantic writes", async () => {
  const operation = new FakeStatelessCodexOperation();
  const clock = new Date("2026-08-16T12:00:00.000Z");
  const manual = manualProviderTimers();
  const observer = observationTransport(THREAD_ID);
  let factoryAttempts = 0;
  let factoryCloses = 0;
  const createObservationFactory =
    async (): Promise<LocalCodexTransportFactory> => {
      factoryAttempts += 1;
      if (factoryAttempts === 1) {
        throw new Error("synthetic observer unavailable");
      }
      return {
        appServerVersion: "synthetic",
        endpointGeneration: "observer-only-never-authority",
        hostId: "this-mac",
        protocol: "codex-app-server",
        protocolVersion: "synthetic",
        close: async () => {
          factoryCloses += 1;
        },
        connectTransport: async () => observer,
      };
    };
  const { observed, provider } = createCodexProviderFixture(operation, {
    createObservationFactory,
    now: () => clock,
    observationBackoffMaxMs: 40,
    observationPollMs: 10,
    observationTimeoutMs: 10,
    timers: manual.timers,
  });
  await provider.initialize(observed.callbacks);
  const input = codexDispatchInput(provider);
  observeCodexFixture(provider, input);

  assert.equal(factoryAttempts, 0);
  assert.equal(operation.inputs.length, 0);
  assert.equal(manual.runNext(), 0);
  await waitFor(() => observed.routes.length === 1);
  assert.equal(factoryAttempts, 1);
  assert.deepEqual(observed.routes[0], {
    observedAt: clock.toISOString(),
    route: {
      hostId: "this-mac",
      provider: "codex",
      registrationId: input.binding.registrationId,
      routeHandle: input.binding.routeHandle,
    },
    safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE",
    state: "unobserved",
  });

  assert.equal(manual.runNext(), 10);
  await waitFor(() => observed.routes.length === 2);
  assert.equal(factoryAttempts, 2);
  assert.equal(operation.inputs.length, 0);
  assert.deepEqual(observed.routes[1], {
    observedAt: clock.toISOString(),
    route: {
      hostId: "this-mac",
      provider: "codex",
      registrationId: input.binding.registrationId,
      routeHandle: input.binding.routeHandle,
    },
    state: "idle",
  });
  assert.deepEqual(
    observer.sent.map(({ method }) => method),
    ["initialize", "initialized", "thread/resume"],
  );
  assert.equal(factoryCloses, 1);
  await provider.close();
});

// Type-only guard: the fake observer never acquires a live provider capability.
const _transportTypeGuard: CodexAppServerTransport | undefined = undefined;
void _transportTypeGuard;
