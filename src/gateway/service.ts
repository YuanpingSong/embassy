import { createHash } from "node:crypto";

import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import type { GatewayConfig } from "./config.js";
import {
  createGatewayConversationId,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewayControlServer,
  type GatewayDecision,
  type GatewayReplyCaller,
  type GatewaySendResult,
  type ReplyParams,
  type SelectClaudeParams,
  type UnregisterCodexParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendToClaudeParams,
  type ValidatedSendToCodexParams,
} from "./control.js";
import { publishGatewayDashboard } from "./dashboard.js";
import { GatewayStore } from "./store.js";
import {
  arePublicAvailablePeerSnapshots,
  projectGatewayPublicSnapshot,
  type CompatibilityState,
  type GatewayPublicSnapshot,
  type PrivateEndpointIdentity,
  type PrivateRouteBinding,
  type PublicAvailablePeerSnapshot,
  type RouteState,
} from "./types.js";

const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MESSAGE_ID = /^msg_[0-9a-f-]{36}$/i;
const PRIVATE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONVERSATIONS = 1_024;

export type GatewayAdapterRouteState = Extract<
  RouteState,
  "idle" | "busy" | "awaiting_approval"
>;

export type GatewayAdapterDiscovery = {
  /** Canonical public alias. The service never lowercases or truncates it. */
  alias: string;
  /** Stable provider identity; for Claude this is its native session UUID. */
  routeHandle: string;
  kind: "interactive";
  state: GatewayAdapterRouteState;
  compatibility: "compatible";
};

export type GatewayAdapterDeliveryState =
  | "transport_written"
  | "held"
  | "released"
  | "denied"
  | "expired"
  | "ambiguous"
  | "completed"
  | "failed"
  | "cancelled";

export type GatewayAdapterDelivery = {
  messageId: string;
  state: GatewayAdapterDeliveryState;
  safeErrorCode?: string;
  /** Transient, bounded by the adapter. Never copied into normalized state. */
  replyText?: string;
};

export type GatewayAdapterCallbacks = {
  onDelivery: (event: GatewayAdapterDelivery) => void;
  onRouteState: (event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    state: GatewayAdapterRouteState;
    safeErrorCode?: string;
  }) => void;
  /** A callback user frame has no conversation ID; correlation is service-owned. */
  onClaudeReply: (event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    text: string;
  }) => void;
  onClaudeMessage?: (event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    sourceAlias: string;
    targetAlias: string;
    text: string;
    receiptHandle?: string;
  }) => void;
};

export type GatewayAdapterStart = {
  health: "healthy" | "degraded";
  compatibility: CompatibilityState;
  safeErrorCode?: string;
};

export type GatewayAdapterDispatchResult =
  | { state: "pending" }
  | { state: "deferred"; safeErrorCode?: string }
  | {
      state: "delivered" | "failed" | "ambiguous" | "cancelled";
      safeErrorCode?: string;
      replyText?: string;
    };

/**
 * Narrow provider boundary. Production adapters wrap ClaudePeerAdapter or one
 * exact CodexAppServerConnector; tests use in-memory fakes. Implementations
 * must never retry a dispatch after a write may have occurred.
 */
export interface GatewayProviderAdapter {
  readonly identity: PrivateEndpointIdentity;
  readonly protocol: string;
  readonly protocolVersion: string;
  initialize(callbacks: GatewayAdapterCallbacks): Promise<GatewayAdapterStart>;
  discoverClaudePeers?(): Promise<readonly GatewayAdapterDiscovery[]>;
  selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }>;
  /** Must attest the selected provider workspace against this controller root. */
  assertWorkspaceDisjoint(routeHandle: string, stateRoot: string): Promise<void>;
  /** Converts a UDS connect-back capability to an exact already-observed handle. */
  resolveReplyAddress?(address: string): Promise<{ routeHandle: string }>;
  advertiseNativeCodexPeer?(input: {
    alias: string;
    cwd: string;
  }): Promise<void>;
  unadvertiseNativeCodexPeer?(alias: string): Promise<void>;
  updateNativeCodexPeerStatus?(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void>;
  updateNativeInboundStatus?(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void>;
  dispatch(input: {
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }): Promise<GatewayAdapterDispatchResult>;
  releaseRoute?(routeHandle: string): Promise<void>;
  close(): Promise<void>;
}

type Conversation = {
  id: string;
  sourceAlias: string;
  targetAlias: string;
  expectsReply: boolean;
  nextSequence: number;
  lastHopCount: number;
  lastActivityAt: string;
};

type MessageContext = {
  conversationId: string;
  isReply: boolean;
  expectsReply: boolean;
  hopCount: number;
  sequence: number;
  targetBindingKey: string;
  nativeReplyBinding?: PrivateRouteBinding;
  authorization: "selected_route" | "native_reply";
  targetAlias: string;
  deadlineAt: string;
};

type NativeIngressCapability = {
  sourceAlias: string;
  binding: PrivateRouteBinding;
  deadlineAt: string;
};

type PendingClaudeReply = {
  conversationId: string;
  bindingKey: string;
  hopCount: number;
  deadlineAt: string;
  tainted: boolean;
};

type CallbackEvent =
  | {
      type: "delivery";
      source: PrivateEndpointIdentity;
      value: GatewayAdapterDelivery;
    }
  | {
      type: "route";
      source: PrivateEndpointIdentity;
      value: {
        routeHandle: string;
        state: GatewayAdapterRouteState;
        safeErrorCode?: string;
      };
    }
  | {
      type: "claude_reply";
      value: {
        endpoint: PrivateEndpointIdentity & { routeHandle: string };
        text: string;
      };
    }
  | {
      type: "claude_message";
      value: {
        endpoint: PrivateEndpointIdentity & { routeHandle: string };
        sourceAlias: string;
        targetAlias: string;
        text: string;
        receiptHandle?: string;
      };
    };

type Candidate = GatewayAdapterDiscovery & {
  adapter: GatewayProviderAdapter;
};

export type GatewayServiceOptions = {
  config: GatewayConfig;
  forbiddenWorkspaceRoots: readonly string[];
  adapters?: readonly GatewayProviderAdapter[];
  store?: GatewayStore;
  publishDashboard?: typeof publishGatewayDashboard;
  now?: () => Date;
  nativePeerCwd?: string;
};

function bindingKey(binding: PrivateRouteBinding): string {
  return [
    binding.provider,
    binding.hostId,
    binding.endpointGeneration,
    binding.routeHandle,
    binding.ownerLease,
  ].join("\0");
}

function stableLease(provider: "codex" | "claude", value: string): string {
  return `lease_${createHash("sha256").update(provider).update("\0").update(value).digest("base64url")}`;
}

function safeCode(value: string | undefined, fallback: string): string {
  return value !== undefined && SAFE_CODE.test(value) ? value : fallback;
}

type RejectedDecision = Extract<GatewayDecision, { accepted: false }>;

function decisionFor(error: unknown): RejectedDecision {
  if (!(error instanceof BridgeError)) {
    return { accepted: false, code: "rejected" };
  }
  if (error.code.includes("NOT_FOUND") || error.code === "ROUTE_UNAVAILABLE") {
    return { accepted: false, code: "not_found" };
  }
  if (
    error.code.includes("COLLISION") ||
    error.code.includes("OWNERSHIP") ||
    error.code.includes("REBIND")
  ) {
    return { accepted: false, code: "conflict" };
  }
  if (error.code.includes("BUSY") || error.code.includes("CAPACITY")) {
    return { accepted: false, code: "busy" };
  }
  if (
    error.code.includes("UNAVAILABLE") ||
    error.code.includes("OFFLINE") ||
    error.code.includes("STALE")
  ) {
    return { accepted: false, code: "unavailable" };
  }
  if (error.code.includes("MISMATCH") || error.code.includes("ADDRESS")) {
    return { accepted: false, code: "route_mismatch" };
  }
  return { accepted: false, code: "rejected" };
}

export class GatewayService {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  private readonly forbiddenWorkspaceRoots: readonly string[];
  private readonly adapters: readonly GatewayProviderAdapter[];
  private readonly publishDashboard: typeof publishGatewayDashboard;
  private readonly now: () => Date;
  private readonly nativePeerCwd: string;
  private readonly mutex = new KeyedMutex();
  private readonly routeBindings = new Map<string, PrivateRouteBinding>();
  private readonly routeStates = new Map<string, GatewayAdapterRouteState>();
  private readonly bindingAliases = new Map<string, string>();
  private readonly candidates = new Map<string, Candidate>();
  private availablePeers: PublicAvailablePeerSnapshot[] = [];
  private readonly conversations = new Map<string, Conversation>();
  private readonly messageContexts = new Map<string, MessageContext>();
  private readonly activeDispatchByTarget = new Map<string, string>();
  private readonly pendingClaudeReplies = new Map<string, PendingClaudeReply>();
  private readonly nativeReceipts = new Map<
    string,
    { hostId: string; receiptHandle: string }
  >();
  private readonly nativeIngressByConversation = new Map<
    string,
    NativeIngressCapability
  >();
  private readonly callbackQueue: CallbackEvent[] = [];
  private callbackWorker: Promise<void> | undefined;
  private callbackScheduled = false;
  private readonly callbackCapacity: number;
  private control: GatewayControlServer | undefined;
  private revision = 0;
  private running = false;
  private closing = false;
  private acceptingCallbacks = true;
  private dashboardHealthy = true;

  constructor(options: GatewayServiceOptions) {
    this.config = options.config;
    this.forbiddenWorkspaceRoots = [...options.forbiddenWorkspaceRoots];
    this.adapters = [...(options.adapters ?? [])];
    this.store = options.store ?? new GatewayStore(options.config);
    this.publishDashboard = options.publishDashboard ?? publishGatewayDashboard;
    this.now = options.now ?? (() => new Date());
    this.nativePeerCwd = options.nativePeerCwd ?? process.cwd();
    this.callbackCapacity = Math.max(
      64,
      options.config.limits.maxRoutes +
        options.config.limits.maxInFlightMessages * 8,
    );
  }

  async start(): Promise<void> {
    if (this.running || this.closing) return;
    await this.store.initialize(this.forbiddenWorkspaceRoots);
    try {
      const seen = new Set<string>();
      for (const adapter of this.adapters) {
        const key = `${adapter.identity.provider}@${adapter.identity.hostId}`;
        if (seen.has(key) || !this.config.allowedHosts.includes(adapter.identity.hostId)) {
          throw new BridgeError("GATEWAY_ADAPTER_NOT_ALLOWED", "A provider adapter is duplicated or outside the host allowlist.");
        }
        seen.add(key);
        const observation = await adapter.initialize(
          this.callbacksFor(adapter.identity),
        );
        await this.store.observeConnector({
          identity: adapter.identity,
          health: observation.health,
          compatibility: observation.compatibility,
          protocol: adapter.protocol,
          protocolVersion: adapter.protocolVersion,
          ...(observation.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: safeCode(observation.safeErrorCode, "ADAPTER_DEGRADED") }),
        });
      }
      this.control = await startGatewayControlServer({
        stateDir: this.store.rootDir,
        socketPath: this.config.controlSocketPath,
        handlers: this.handlers(),
      });
      this.running = true;
      await this.publish();
    } catch (error) {
      await Promise.allSettled(this.adapters.map(async (adapter) => adapter.close()));
      await this.store.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const control = this.control;
    this.control = undefined;
    let closeFailed = false;
    if (control !== undefined) {
      try {
        await control.close();
      } catch {
        closeFailed = true;
      }
    }
    await this.mutex.run("service", async () => {
      try {
        this.running = false;
        const adapterResults = await Promise.allSettled(
          this.adapters.map(async (adapter) => adapter.close()),
        );
        for (const result of adapterResults) {
          if (result.status === "rejected") closeFailed = true;
        }
        this.acceptingCallbacks = false;
        await this.drainCallbackQueueLocked();
        for (const messageId of [...this.messageContexts.keys()]) {
          const cancelled = await this.store.cancelQueuedMessage(messageId);
          if (!cancelled) {
            await this.store
              .settleMessage({
                messageId,
                state: "ambiguous",
                safeErrorCode: "GATEWAY_SHUTDOWN",
              })
              .catch(() => undefined);
          }
          this.messageContexts.delete(messageId);
        }
        await this.publish();
      } catch {
        closeFailed = true;
      } finally {
        // Adapter close must terminate owned work before the store lock is
        // released. Queued work is cancelled; unresolved writes are ambiguous.
        this.conversations.clear();
        this.messageContexts.clear();
        this.activeDispatchByTarget.clear();
        this.pendingClaudeReplies.clear();
        this.nativeReceipts.clear();
        this.nativeIngressByConversation.clear();
        this.callbackQueue.length = 0;
        this.candidates.clear();
        this.routeBindings.clear();
        this.routeStates.clear();
        this.bindingAliases.clear();
        await this.store.close().catch(() => {
          closeFailed = true;
        });
      }
    });
    if (closeFailed) {
      throw new BridgeError(
        "GATEWAY_CLEANUP_FAILED",
        "The gateway could not confirm cleanup of every owned resource.",
      );
    }
  }

  handlers(): GatewayControlHandlers {
    return {
      health: async () => ({
        status: this.running && this.dashboardHealthy ? "ok" : "degraded",
        revision: this.revision,
      }),
      registerCodex: async (params) =>
        await this.exclusiveDecision(async () => this.registerCodex(params)),
      unregisterCodex: async (params) =>
        await this.exclusiveDecision(async () => this.unregisterCodex(params)),
      selectClaude: async (params) =>
        await this.exclusiveDecision(async () => this.selectClaude(params)),
      unselectClaude: async (params) =>
        await this.exclusiveDecision(async () => this.unselectClaude(params)),
      listSnapshot: async () => await this.snapshot(),
      sendToClaude: async (params) => await this.acceptToClaude(params),
      sendToCodex: async (params) => await this.acceptToCodex(params),
      reply: async (params) => await this.acceptReply(params),
      refreshDashboard: async () => {
        const result = await this.exclusiveDecision(async () => {
          await this.refreshClaudeDiscovery();
          await this.publish();
        });
        return { ...result, revision: this.revision };
      },
    };
  }

  async snapshot(): Promise<GatewayPublicSnapshot> {
    return await this.mutex.run("service", async () => {
      this.pruneTransient();
      const base = await this.store.publicSnapshot();
      const peers = this.availablePeers.map((peer) => ({ ...peer }));
      if (!arePublicAvailablePeerSnapshots(peers)) {
        throw new BridgeError("INVALID_TRANSIENT_INVENTORY", "The transient peer inventory is unsafe.");
      }
      return projectGatewayPublicSnapshot({ ...base, availablePeers: peers });
    });
  }

  private callbacksFor(source: PrivateEndpointIdentity): GatewayAdapterCallbacks {
    return {
      onDelivery: (event) => {
        if (
          !this.running ||
          !MESSAGE_ID.test(event.messageId) ||
          !this.messageContexts.has(event.messageId) ||
          (event.safeErrorCode !== undefined && !SAFE_CODE.test(event.safeErrorCode)) ||
          (event.replyText !== undefined &&
            (event.replyText.length === 0 ||
              Buffer.byteLength(event.replyText, "utf8") >
                this.config.limits.maxMessageBytes))
        ) {
          return;
        }
        const context = this.messageContexts.get(event.messageId);
        const target =
          context === undefined
            ? undefined
            : this.contextTargetBinding(context);
        if (
          target === undefined ||
          target.provider !== source.provider ||
          target.hostId !== source.hostId ||
          target.endpointGeneration !== source.endpointGeneration
        ) {
          return;
        }
        this.enqueueCallback({
          type: "delivery",
          source: { ...source },
          value: { ...event },
        });
      },
      onRouteState: (event) => {
          if (
            !this.running ||
            event.endpoint.provider !== source.provider ||
            event.endpoint.hostId !== source.hostId ||
            event.endpoint.endpointGeneration !== source.endpointGeneration ||
            !PRIVATE_HANDLE.test(event.endpoint.routeHandle) ||
            (event.safeErrorCode !== undefined &&
              !SAFE_CODE.test(event.safeErrorCode))
          ) {
            return;
          }
          this.enqueueCallback({
            type: "route",
            source: { ...source },
            value: {
              routeHandle: event.endpoint.routeHandle,
              state: event.state,
              ...(event.safeErrorCode === undefined
                ? {}
                : { safeErrorCode: event.safeErrorCode }),
            },
          });
      },
      onClaudeReply: (event) => {
        if (
          !this.running ||
          event.endpoint.provider !== source.provider ||
          event.endpoint.hostId !== source.hostId ||
          event.endpoint.endpointGeneration !== source.endpointGeneration ||
          !PRIVATE_HANDLE.test(event.endpoint.routeHandle) ||
          event.text.length === 0 ||
          Buffer.byteLength(event.text, "utf8") >
            this.config.limits.maxMessageBytes
        ) {
          return;
        }
        const selected = [...this.routeBindings.values()].filter(
          (binding) =>
            binding.provider === event.endpoint.provider &&
            binding.hostId === event.endpoint.hostId &&
            binding.endpointGeneration ===
              event.endpoint.endpointGeneration &&
            binding.routeHandle === event.endpoint.routeHandle,
        );
        if (
          selected.length !== 1 ||
          selected[0] === undefined ||
          !this.pendingClaudeReplies.has(bindingKey(selected[0]))
        ) {
          return;
        }
        this.enqueueCallback({
          type: "claude_reply",
          value: { endpoint: { ...event.endpoint }, text: event.text },
        });
      },
      onClaudeMessage: (event) => {
        if (
          !this.running ||
          source.provider !== "claude" ||
          event.endpoint.provider !== source.provider ||
          event.endpoint.hostId !== source.hostId ||
          event.endpoint.endpointGeneration !== source.endpointGeneration ||
          !PRIVATE_HANDLE.test(event.endpoint.routeHandle) ||
          !PUBLIC_ALIAS.test(event.sourceAlias) ||
          !PUBLIC_ALIAS.test(event.targetAlias) ||
          event.text.length === 0 ||
          Buffer.byteLength(event.text, "utf8") >
            this.config.limits.maxMessageBytes
        ) {
          return;
        }
        const retained = this.enqueueCallback({
          type: "claude_message",
          value: {
            endpoint: { ...event.endpoint },
            sourceAlias: event.sourceAlias,
            targetAlias: event.targetAlias,
            text: event.text,
            ...(event.receiptHandle === undefined
              ? {}
              : { receiptHandle: event.receiptHandle }),
          },
        });
        if (!retained && event.receiptHandle !== undefined) {
          void this.adapter("claude", source.hostId)
            .updateNativeInboundStatus?.(
              event.receiptHandle,
              "expired",
              "GATEWAY_CALLBACK_CAPACITY",
            )
            .catch(() => {
              this.dashboardHealthy = false;
            });
        }
      },
    };
  }

  private enqueueCallback(event: CallbackEvent): boolean {
    if (!this.acceptingCallbacks) return false;
    if (event.type === "delivery") {
      const duplicate = this.callbackQueue.findIndex(
        (candidate) =>
          candidate.type === "delivery" &&
          candidate.value.messageId === event.value.messageId &&
          candidate.value.state === event.value.state,
      );
      if (duplicate >= 0) {
        this.callbackQueue[duplicate] = event;
        return true;
      }
    }
    if (this.callbackQueue.length >= this.callbackCapacity) {
      // Preserve bounded terminal/correlation events by evicting only an older
      // nonterminal observation. If none exists, fail closed and retain the
      // older authority-bearing event rather than creating an unbounded queue.
      const replaceable = this.callbackQueue.findIndex(
        (candidate) =>
          candidate.type === "route" ||
          (candidate.type === "delivery" &&
            (candidate.value.state === "transport_written" ||
              candidate.value.state === "held")),
      );
      if (replaceable < 0) {
        this.dashboardHealthy = false;
        return false;
      }
      this.callbackQueue.splice(replaceable, 1);
    }
    this.callbackQueue.push(event);
    if (this.callbackScheduled) return true;
    this.callbackScheduled = true;
    setImmediate(() => {
      this.callbackScheduled = false;
      const worker = this.mutex.run("service", async () => {
        await this.drainCallbackQueueLocked();
      });
      this.callbackWorker = worker;
      worker
        .catch(() => {
          this.dashboardHealthy = false;
        })
        .finally(() => {
          if (this.callbackWorker === worker) this.callbackWorker = undefined;
          if (this.callbackQueue.length > 0 && !this.closing) {
            this.enqueueCallbackWorkerOnly();
          }
        });
    });
    return true;
  }

  private enqueueCallbackWorkerOnly(): void {
    if (this.callbackScheduled) return;
    this.callbackScheduled = true;
    setImmediate(() => {
      this.callbackScheduled = false;
      const worker = this.mutex.run("service", async () => {
        await this.drainCallbackQueueLocked();
      });
      this.callbackWorker = worker;
      worker
        .catch(() => {
          this.dashboardHealthy = false;
        })
        .finally(() => {
          if (this.callbackWorker === worker) this.callbackWorker = undefined;
          if (this.callbackQueue.length > 0 && !this.closing) {
            this.enqueueCallbackWorkerOnly();
          }
        });
    });
  }

  private async drainCallbackQueueLocked(): Promise<void> {
    this.pruneTransient();
    while (this.callbackQueue.length > 0) {
      const event = this.callbackQueue.shift();
      if (event === undefined) continue;
      try {
        if (event.type === "delivery") {
          await this.onDelivery(event.source, event.value);
        } else if (event.type === "route") {
          await this.onRouteState(event.source, event.value);
        } else if (event.type === "claude_reply") {
          await this.onClaudeReply(event.value);
        } else {
          await this.onClaudeMessage(event.value);
        }
      } catch {
        this.dashboardHealthy = false;
      }
    }
  }

  private adapter(provider: "codex" | "claude", host: string): GatewayProviderAdapter {
    const adapter = this.adapters.find(
      (candidate) => candidate.identity.provider === provider && candidate.identity.hostId === host,
    );
    if (adapter === undefined) throw new BridgeError("PROVIDER_UNAVAILABLE", "The selected provider is unavailable.", true);
    return adapter;
  }

  private contextTargetBinding(
    context: MessageContext,
  ): PrivateRouteBinding | undefined {
    if (context.nativeReplyBinding !== undefined) {
      return context.nativeReplyBinding;
    }
    return [...this.routeBindings.values()].find(
      (binding) => bindingKey(binding) === context.targetBindingKey,
    );
  }

  private async registerCodex(params: ValidatedRegisterCodexParams): Promise<void> {
    if (!params.alias.startsWith("codex-")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_ALIAS",
        "A registered Codex alias must start with codex-.",
      );
    }
    const adapter = this.adapter("codex", params.hostId);
    await adapter.assertWorkspaceDisjoint(params.threadId, this.store.rootDir);
    const registered = await adapter.selectRoute({
      alias: params.alias,
      routeHandle: params.threadId,
    });
    if (registered.routeHandle !== params.threadId) {
      throw new BridgeError(
        "ROUTE_MISMATCH",
        "The connector registered a different task.",
      );
    }
    const binding: PrivateRouteBinding = {
      ...adapter.identity,
      routeHandle: params.threadId,
      ownerLease: stableLease("codex", `${params.hostId}\0${params.threadId}`),
    };
    try {
      await this.registerOrRebind(
        params.alias,
        binding,
        "endpoint_reobserved",
        registered.state,
      );
    } catch (error) {
      await adapter.releaseRoute?.(params.threadId).catch(() => undefined);
      throw error;
    }
    this.rememberBinding(params.alias, binding, registered.state);
    await this.adapter("claude", params.hostId).advertiseNativeCodexPeer?.({
      alias: params.alias,
      cwd: this.nativePeerCwd,
    });
    await this.adapter("claude", params.hostId).updateNativeCodexPeerStatus?.(
      params.alias,
      registered.state === "idle"
        ? "idle"
        : registered.state === "awaiting_approval"
          ? "waiting"
          : "busy",
    );
    await this.changed();
  }

  private async unregisterCodex(params: UnregisterCodexParams): Promise<void> {
    const host = params.alias.slice(params.alias.lastIndexOf("@") + 1);
    const lease = stableLease("codex", `${host}\0${params.threadId}`);
    await this.store.unregisterRoute(params.alias, lease);
    this.forgetBinding(params.alias);
    await this.adapter("claude", host)
      .unadvertiseNativeCodexPeer?.(params.alias)
      .catch(() => {
        this.dashboardHealthy = false;
      });
    await this.adapter("codex", host)
      .releaseRoute?.(params.threadId)
      .catch(() => {
        this.dashboardHealthy = false;
      });
    await this.changed();
  }

  private async refreshClaudeDiscovery(): Promise<void> {
    this.candidates.clear();
    const rows: PublicAvailablePeerSnapshot[] = [];
    const observedSelected = new Set<string>();
    for (const adapter of this.adapters.filter((item) => item.identity.provider === "claude")) {
      const discovered = await adapter.discoverClaudePeers?.() ?? [];
      const grouped = new Map<string, GatewayAdapterDiscovery[]>();
      for (const peer of discovered) {
        if (!PUBLIC_ALIAS.test(peer.alias) || !peer.alias.endsWith(`@${adapter.identity.hostId}`) || peer.kind !== "interactive") continue;
        grouped.set(peer.alias, [...(grouped.get(peer.alias) ?? []), peer]);
      }
      for (const [alias, matches] of grouped) {
        if (matches.length !== 1) {
          rows.push({ alias, provider: "claude", host: adapter.identity.hostId, state: "incompatible", compatibility: "incompatible", selected: false, safeErrorCode: "PEER_ALIAS_COLLISION" });
          continue;
        }
        const peer = matches[0];
        if (peer === undefined) continue;
        const candidate: Candidate = { ...peer, adapter };
        const existing = [...this.routeBindings.entries()].find(
          ([, binding]) =>
            binding.provider === "claude" &&
            binding.hostId === adapter.identity.hostId &&
            binding.endpointGeneration === adapter.identity.endpointGeneration &&
            binding.routeHandle === peer.routeHandle,
        );
        if (existing !== undefined && existing[0] !== alias) {
          const collision = this.routeBindings.get(alias);
          if (
            collision !== undefined &&
            bindingKey(collision) !== bindingKey(existing[1])
          ) {
            rows.push({ alias, provider: "claude", host: adapter.identity.hostId, state: "incompatible", compatibility: "incompatible", selected: false, safeErrorCode: "PEER_ALIAS_COLLISION" });
            continue;
          }
          await this.renameClaudeRoute(existing[0], alias, existing[1]);
        }
        this.candidates.set(alias, candidate);
        const selectedBinding = this.routeBindings.get(alias);
        const selected = selectedBinding?.routeHandle === peer.routeHandle;
        rows.push({ alias, provider: "claude", host: adapter.identity.hostId, state: peer.state, compatibility: peer.compatibility, selected });
        if (selected && selectedBinding !== undefined) {
          observedSelected.add(bindingKey(selectedBinding));
          await this.store.observeRoute({ binding: selectedBinding, state: peer.state, compatibility: "compatible" });
        }
      }
    }
    for (const [alias, binding] of this.routeBindings) {
      if (
        binding.provider !== "claude" ||
        observedSelected.has(bindingKey(binding))
      ) {
        continue;
      }
      const inspection = await this.store.inspectPrivateRoute(alias);
      if (
        inspection !== undefined &&
        inspection.enabled &&
        inspection.compatibility === "compatible"
      ) {
        await this.store.invalidateRoute(binding, "PEER_NOT_OBSERVED");
      }
      this.routeStates.delete(alias);
    }
    this.availablePeers = rows.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  private async renameClaudeRoute(
    oldAlias: string,
    newAlias: string,
    binding: PrivateRouteBinding,
  ): Promise<void> {
    if (oldAlias === newAlias) return;
    await this.store.renameRoute(oldAlias, newAlias, binding.ownerLease);
    const state = this.routeStates.get(oldAlias) ?? "busy";
    this.routeBindings.delete(oldAlias);
    this.routeStates.delete(oldAlias);
    this.routeBindings.set(newAlias, binding);
    this.routeStates.set(newAlias, state);
    this.bindingAliases.set(bindingKey(binding), newAlias);

    for (const conversation of this.conversations.values()) {
      if (conversation.sourceAlias === oldAlias) conversation.sourceAlias = newAlias;
      if (conversation.targetAlias === oldAlias) conversation.targetAlias = newAlias;
    }
    for (const context of this.messageContexts.values()) {
      if (context.targetAlias === oldAlias) context.targetAlias = newAlias;
    }
    const active = this.activeDispatchByTarget.get(oldAlias);
    if (active !== undefined) {
      this.activeDispatchByTarget.delete(oldAlias);
      this.activeDispatchByTarget.set(newAlias, active);
    }
  }

  private claudeCandidate(selector: string): Candidate | undefined {
    if (CLAUDE_SESSION_ID.test(selector)) {
      const normalized = selector.toLowerCase();
      return [...this.candidates.values()].find(
        (candidate) => candidate.routeHandle.toLowerCase() === normalized,
      );
    }
    return this.candidates.get(selector);
  }

  private async selectClaudeCandidate(
    candidate: Candidate,
    currentOwnerLease?: string,
  ): Promise<void> {
    await candidate.adapter.assertWorkspaceDisjoint(candidate.routeHandle, this.store.rootDir);
    const selected = await candidate.adapter.selectRoute({ alias: candidate.alias, routeHandle: candidate.routeHandle });
    if (selected.routeHandle !== candidate.routeHandle) throw new BridgeError("ROUTE_MISMATCH", "The peer identity changed during selection.");
    const binding: PrivateRouteBinding = {
      ...candidate.adapter.identity,
      routeHandle: candidate.routeHandle,
      ownerLease: stableLease("claude", candidate.routeHandle),
    };
    try {
      await this.registerOrRebind(
        candidate.alias,
        binding,
        "peer_explicitly_reselected",
        selected.state,
        currentOwnerLease,
      );
    } catch (error) {
      await candidate.adapter.releaseRoute?.(candidate.routeHandle).catch(() => undefined);
      throw error;
    }
    this.rememberBinding(candidate.alias, binding, selected.state);
  }

  private async resolveSelectedClaudeDestination(
    selector: string,
  ): Promise<string> {
    await this.refreshClaudeDiscovery();
    const candidate = this.claudeCandidate(selector);
    if (candidate === undefined) throw new BridgeError("PEER_NOT_FOUND", "No unique compatible interactive peer matches that current name or session UUID.");
    const existing = this.routeBindings.get(candidate.alias);
    if (
      existing === undefined ||
      existing.provider !== "claude" ||
      existing.routeHandle !== candidate.routeHandle
    ) {
      throw new BridgeError(
        "PEER_NOT_SELECTED",
        "The Claude session must be explicitly selected before messaging.",
      );
    }
    return candidate.alias;
  }

  private async selectClaude(params: SelectClaudeParams): Promise<void> {
    await this.refreshClaudeDiscovery();
    const candidate = this.claudeCandidate(params.alias);
    if (candidate === undefined) throw new BridgeError("PEER_NOT_FOUND", "No unique compatible interactive peer matches that current name or session UUID.");
    const old =
      this.routeBindings.get(candidate.alias) ??
      (await this.store.inspectPrivateRoute(candidate.alias))?.binding;
    if (
      old !== undefined &&
      (old.provider !== "claude" || old.routeHandle !== candidate.routeHandle)
    ) {
      const inspection = await this.store.inspectPrivateRoute(candidate.alias);
      if (
        inspection?.enabled === true &&
        inspection.compatibility === "compatible"
      ) {
        await this.store.invalidateRoute(old, "PEER_RESELECTED");
      }
    }
    await this.selectClaudeCandidate(candidate, old?.ownerLease);
    await this.refreshClaudeDiscovery();
    await this.changed();
  }

  private async unselectClaude(params: SelectClaudeParams): Promise<void> {
    await this.refreshClaudeDiscovery();
    const candidate = this.claudeCandidate(params.alias);
    const selected: [string, PrivateRouteBinding] | undefined = CLAUDE_SESSION_ID.test(params.alias)
      ? [...this.routeBindings.entries()].find(
          (entry): entry is [string, PrivateRouteBinding] =>
            entry[1].provider === "claude" &&
            entry[1].routeHandle.toLowerCase() === params.alias.toLowerCase(),
        )
      : candidate === undefined
        ? undefined
        : (() => {
            const binding = this.routeBindings.get(candidate.alias);
            return binding === undefined ? undefined : [candidate.alias, binding];
          })();
    if (selected === undefined) throw new BridgeError("PEER_NOT_FOUND", "No selected Claude session matches that selector.");
    const [alias, binding] = selected;
    await this.store.unregisterRoute(alias, binding.ownerLease);
    this.forgetBinding(alias);
    await this.adapter("claude", binding.hostId)
      .releaseRoute?.(binding.routeHandle)
      .catch(() => {
        this.dashboardHealthy = false;
      });
    await this.refreshClaudeDiscovery();
    await this.changed();
  }

  private async registerOrRebind(
    alias: string,
    binding: PrivateRouteBinding,
    reason: "endpoint_reobserved" | "peer_explicitly_reselected",
    state: GatewayAdapterRouteState,
    currentOwnerLease: string = binding.ownerLease,
  ): Promise<void> {
    try {
      await this.store.registerRoute({
        alias,
        binding,
        registrationMode: binding.provider === "codex" ? "explicit_opt_in" : "selected_live_peer",
        state,
        compatibility: "compatible",
      });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "ROUTE_ALIAS_COLLISION") throw error;
      await this.store.rebindStaleRoute({ alias, currentOwnerLease, newBinding: binding, reason, state });
    }
  }

  private rememberBinding(
    alias: string,
    binding: PrivateRouteBinding,
    state: GatewayAdapterRouteState,
  ): void {
    const previous = this.routeBindings.get(alias);
    if (
      previous !== undefined &&
      bindingKey(previous) !== bindingKey(binding)
    ) {
      this.pendingClaudeReplies.delete(bindingKey(previous));
    }
    this.routeBindings.set(alias, binding);
    this.routeStates.set(alias, state);
    this.bindingAliases.set(bindingKey(binding), alias);
  }

  private forgetBinding(alias: string): void {
    const binding = this.routeBindings.get(alias);
    if (binding !== undefined) {
      this.bindingAliases.delete(bindingKey(binding));
      this.pendingClaudeReplies.delete(bindingKey(binding));
    }
    this.routeBindings.delete(alias);
    this.routeStates.delete(alias);
  }

  private async verifyCodex(alias: string, threadId: string): Promise<PrivateRouteBinding> {
    const binding = await this.store.resolveRoute(alias);
    if (binding.provider !== "codex" || binding.routeHandle !== threadId) throw new BridgeError("ROUTE_MISMATCH", "The caller does not own this exact task route.");
    return binding;
  }

  private async verifyClaude(alias: string, replyAddress: string | undefined): Promise<PrivateRouteBinding> {
    if (replyAddress === undefined) throw new BridgeError("REPLY_ADDRESS_MISMATCH", "An exact Claude reply capability is required.");
    const binding = await this.store.resolveRoute(alias);
    if (binding.provider !== "claude") throw new BridgeError("ROUTE_MISMATCH", "The caller is not a selected Claude route.");
    const adapter = this.adapter("claude", binding.hostId);
    const resolved = await adapter.resolveReplyAddress?.(replyAddress);
    if (resolved === undefined || resolved.routeHandle !== binding.routeHandle) throw new BridgeError("REPLY_ADDRESS_MISMATCH", "The reply capability does not match the selected peer generation.");
    await adapter.assertWorkspaceDisjoint(binding.routeHandle, this.store.rootDir);
    return binding;
  }

  private async acceptToClaude(params: ValidatedSendToClaudeParams): Promise<GatewaySendResult> {
    return await this.mutex.run("service", async () => {
      try {
        await this.verifyCodex(params.fromAlias, params.threadId);
        const targetAlias = await this.resolveSelectedClaudeDestination(
          params.toAlias,
        );
        return await this.enqueue(params.fromAlias, targetAlias, params.text, params.expectsReply, false);
      } catch (error) {
        return decisionFor(error);
      }
    });
  }

  private async acceptToCodex(params: ValidatedSendToCodexParams): Promise<GatewaySendResult> {
    return await this.mutex.run("service", async () => {
      try {
        await this.verifyClaude(params.fromAlias, params.replyAddress);
        return await this.enqueue(params.fromAlias, params.toAlias, params.text, params.expectsReply, false);
      } catch (error) {
        return decisionFor(error);
      }
    });
  }

  private async acceptReply(params: ReplyParams): Promise<GatewayDecision> {
    return await this.mutex.run("service", async () => {
      try {
        const conversation = this.conversations.get(params.conversationId);
        if (conversation === undefined) throw new BridgeError("CONVERSATION_NOT_FOUND", "The conversation is not active.");
        const caller = params.caller;
        if (caller.kind === "codex") await this.verifyCodex(caller.alias, caller.threadId);
        else await this.verifyClaude(caller.alias, caller.replyAddress);
        const from = caller.alias;
        const to = from === conversation.sourceAlias ? conversation.targetAlias : from === conversation.targetAlias ? conversation.sourceAlias : undefined;
        if (to === undefined) throw new BridgeError("ROUTE_MISMATCH", "The caller is not a conversation participant.");
        const result =
          caller.kind === "codex" &&
          this.nativeIngressByConversation.has(conversation.id)
            ? await this.enqueueNativeReply(
                conversation,
                from,
                params.text,
                conversation.lastHopCount + 1,
              )
            : await this.enqueue(
                from,
                to,
                params.text,
                false,
                true,
                conversation.id,
                conversation.lastHopCount + 1,
              );
        return result.accepted ? { accepted: true, code: "ok" } : result;
      } catch (error) {
        return decisionFor(error);
      }
    });
  }

  private async enqueue(
    sourceAlias: string,
    targetAlias: string,
    text: string,
    expectsReply: boolean,
    isReply: boolean,
    existingConversationId?: string,
    requestedHopCount?: number,
  ): Promise<GatewaySendResult> {
    this.pruneTransient();
    if (
      existingConversationId === undefined &&
      this.conversations.size >= MAX_CONVERSATIONS
    ) {
      throw new BridgeError("CONVERSATION_CAPACITY", "The transient conversation table is full.", true);
    }
    const target = await this.store.resolveRoute(targetAlias);
    if (expectsReply && target.provider === "claude") {
      const owner = this.pendingClaudeReplies.get(bindingKey(target));
      if (owner !== undefined) throw new BridgeError("REPLY_ROUTE_BUSY", "That exact peer already owns a pending reply.", true);
    }
    const conversationId = existingConversationId ?? createGatewayConversationId();
    const conversation = this.conversations.get(conversationId) ?? {
      id: conversationId,
      sourceAlias,
      targetAlias,
      expectsReply,
      nextSequence: 0,
      lastHopCount: 0,
      lastActivityAt: this.now().toISOString(),
    };
    const hopCount = requestedHopCount ?? (isReply ? conversation.lastHopCount + 1 : 0);
    const sequence = conversation.nextSequence;
    const deadlineAt = new Date(
      this.now().getTime() + this.config.limits.messageDeadlineMs,
    ).toISOString();
    const queued = await this.store.enqueueMessage({
      sourceAlias,
      targetAlias,
      body: text,
      dedupeKey: `${conversationId}:${sequence}`,
      hopCount,
      deadlineAt,
    });
    if (!queued.accepted || queued.messageId === undefined) throw new BridgeError("MESSAGE_REJECTED", "The message was not accepted.");
    this.conversations.set(conversationId, conversation);
    conversation.nextSequence += 1;
    conversation.lastHopCount = hopCount;
    conversation.lastActivityAt = this.now().toISOString();
    this.messageContexts.set(queued.messageId, {
      conversationId,
      isReply,
      expectsReply,
      hopCount,
      sequence,
      targetBindingKey: bindingKey(target),
      authorization: "selected_route",
      targetAlias,
      deadlineAt,
    });
    if (expectsReply && target.provider === "claude") {
      this.pendingClaudeReplies.set(bindingKey(target), {
        conversationId,
        bindingKey: bindingKey(target),
        hopCount,
        deadlineAt,
        tainted: false,
      });
    }
    await this.changed();
    // Provider I/O starts only after the enqueueing handler can return.
    this.scheduleDispatch(targetAlias);
    return { accepted: true, code: "ok", conversationId };
  }

  private async enqueueNativeReply(
    conversation: Conversation,
    sourceAlias: string,
    text: string,
    requestedHopCount: number,
  ): Promise<GatewaySendResult> {
    this.pruneTransient();
    const capability = this.nativeIngressByConversation.get(conversation.id);
    if (
      capability === undefined ||
      sourceAlias !== conversation.targetAlias ||
      capability.sourceAlias !== conversation.sourceAlias ||
      Date.parse(capability.deadlineAt) <= this.now().getTime()
    ) {
      throw new BridgeError(
        "NATIVE_REPLY_CAPABILITY_EXPIRED",
        "The correlated native Claude reply capability is no longer active.",
      );
    }
    const sequence = conversation.nextSequence;
    const deadlineAt = new Date(
      Math.min(
        Date.parse(capability.deadlineAt),
        this.now().getTime() + this.config.limits.messageDeadlineMs,
      ),
    ).toISOString();
    const queued = await this.store.enqueueNativeReply({
      sourceAlias,
      target: {
        alias: capability.sourceAlias,
        binding: capability.binding,
      },
      body: text,
      dedupeKey: `${conversation.id}:${sequence}`,
      hopCount: requestedHopCount,
      deadlineAt,
    });
    if (!queued.accepted || queued.messageId === undefined) {
      throw new BridgeError(
        "MESSAGE_REJECTED",
        "The native reply was not accepted.",
      );
    }
    conversation.nextSequence += 1;
    conversation.lastHopCount = requestedHopCount;
    conversation.lastActivityAt = this.now().toISOString();
    this.messageContexts.set(queued.messageId, {
      conversationId: conversation.id,
      isReply: true,
      expectsReply: false,
      hopCount: requestedHopCount,
      sequence,
      targetBindingKey: bindingKey(capability.binding),
      nativeReplyBinding: { ...capability.binding },
      authorization: "native_reply",
      targetAlias: capability.sourceAlias,
      deadlineAt,
    });
    this.nativeIngressByConversation.delete(conversation.id);
    await this.changed();
    this.scheduleDispatch(capability.sourceAlias);
    return {
      accepted: true,
      code: "ok",
      conversationId: conversation.id,
    };
  }

  private pruneTransient(): void {
    const now = this.now().getTime();
    for (const [messageId, context] of this.messageContexts) {
      if (Date.parse(context.deadlineAt) > now) continue;
      this.messageContexts.delete(messageId);
      if (this.activeDispatchByTarget.get(context.targetAlias) === messageId) {
        this.activeDispatchByTarget.delete(context.targetAlias);
      }
    }
    for (const [key, pending] of this.pendingClaudeReplies) {
      if (Date.parse(pending.deadlineAt) <= now) {
        pending.tainted = true;
      }
    }
    for (const [conversationId, capability] of this.nativeIngressByConversation) {
      if (Date.parse(capability.deadlineAt) <= now) {
        this.nativeIngressByConversation.delete(conversationId);
      }
    }
    const active = new Set(
      [...this.messageContexts.values()].map((context) => context.conversationId),
    );
    for (const pending of this.pendingClaudeReplies.values()) {
      active.add(pending.conversationId);
    }
    for (const conversationId of this.nativeIngressByConversation.keys()) {
      active.add(conversationId);
    }
    const ttl = Math.max(60_000, this.config.limits.messageDeadlineMs * 2);
    for (const id of this.conversations.keys()) {
      const conversation = this.conversations.get(id);
      if (
        conversation === undefined ||
        active.has(id) ||
        (this.conversations.size < MAX_CONVERSATIONS &&
          Date.parse(conversation.lastActivityAt) + ttl > now)
      ) {
        continue;
      }
      this.conversations.delete(id);
      if (this.conversations.size < MAX_CONVERSATIONS) break;
    }
  }

  private async dispatchOne(targetAlias: string): Promise<void> {
    if (!this.running || this.closing) return;
    if (this.activeDispatchByTarget.has(targetAlias)) return;
    const item = await this.store.dequeueMessage(targetAlias);
    if (item === undefined) return;
    const context = this.messageContexts.get(item.messageId);
    const selectedBinding = this.routeBindings.get(targetAlias);
    const binding = context?.nativeReplyBinding ?? selectedBinding;
    if (context === undefined || binding === undefined) {
      await this.store.requeueInFlightMessage(item.messageId, item.body);
      return;
    }

    if (context.authorization === "selected_route") {
      const routeState = this.routeStates.get(targetAlias);
      const dispatchable =
        routeState === "idle" ||
        (binding.provider === "claude" && routeState === "busy");
      const inspection = await this.store.inspectPrivateRoute(targetAlias);
      const storedDispatchable =
        inspection?.state === "idle" ||
        (binding.provider === "claude" && inspection?.state === "busy");
      if (
        selectedBinding === undefined ||
        !dispatchable ||
        inspection === undefined ||
        !inspection.enabled ||
        inspection.compatibility !== "compatible" ||
        !storedDispatchable ||
        bindingKey(inspection.binding) !== bindingKey(binding) ||
        bindingKey(selectedBinding) !== bindingKey(binding)
      ) {
        await this.store.requeueInFlightMessage(item.messageId, item.body);
        return;
      }
      this.routeStates.set(targetAlias, "busy");
    } else if (
      binding.provider !== "claude" ||
      bindingKey(binding) !== context.targetBindingKey
    ) {
      await this.finishDelivery({
        messageId: item.messageId,
        state: "failed",
        safeErrorCode: "NATIVE_REPLY_BINDING_MISMATCH",
      });
      return;
    }

    this.activeDispatchByTarget.set(targetAlias, item.messageId);
    try {
      const result = await this.adapter(binding.provider, binding.hostId).dispatch({
        binding,
        authorization: context.authorization,
        messageId: item.messageId,
        text: item.body,
        expectsReply: context?.expectsReply ?? false,
        deadlineAt: item.deadlineAt,
      });
      if (result.state === "deferred") {
        const currentTargetAlias =
          this.bindingAliases.get(bindingKey(binding)) ?? targetAlias;
        const requeued = await this.store.requeueInFlightMessage(
          item.messageId,
          item.body,
        );
        this.activeDispatchByTarget.delete(currentTargetAlias);
        if (requeued) {
          if (context.authorization === "selected_route") {
            this.routeStates.set(currentTargetAlias, "idle");
            await this.store.observeRoute({
              binding,
              state: "idle",
              compatibility: "compatible",
            });
            await this.setNativeCodexStatus(currentTargetAlias, "waiting");
          }
          setTimeout(() => this.scheduleDispatch(currentTargetAlias), 500);
        } else {
          await this.ackNativeReceipt(context?.conversationId, "expired");
          this.messageContexts.delete(item.messageId);
        }
        await this.changed();
        return;
      }
      if (result.state === "pending") {
        await this.ackNativeReceipt(context?.conversationId, "delivered");
      } else {
        await this.finishDelivery({ messageId: item.messageId, state: result.state, ...(result.safeErrorCode === undefined ? {} : { safeErrorCode: result.safeErrorCode }), ...(result.replyText === undefined ? {} : { replyText: result.replyText }) });
      }
    } catch {
      await this.finishDelivery({ messageId: item.messageId, state: "ambiguous", safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" });
    }
    this.scheduleDispatch(
      this.bindingAliases.get(bindingKey(binding)) ?? targetAlias,
    );
  }

  private scheduleDispatch(targetAlias: string): void {
    setImmediate(() => {
      this.mutex
        .run("service", async () => this.dispatchOne(targetAlias))
        .catch(() => {
          this.dashboardHealthy = false;
        });
    });
  }

  private async onDelivery(
    source: PrivateEndpointIdentity,
    event: GatewayAdapterDelivery,
  ): Promise<void> {
    const context = this.messageContexts.get(event.messageId);
    if (context === undefined) return;
    const target = this.contextTargetBinding(context);
    if (
      target === undefined ||
      target.provider !== source.provider ||
      target.hostId !== source.hostId ||
      target.endpointGeneration !== source.endpointGeneration
    ) {
      return;
    }
    if (event.state === "transport_written" || event.state === "held") {
      try {
        await this.store.markMessageProgress(event.messageId, event.state);
      } catch {
        // A duplicate/late progress event is observational and cannot reopen a
        // settled delivery.
      }
      return;
    }
    const state =
      event.state === "released" || event.state === "completed"
        ? "delivered"
        : event.state === "expired"
          ? "expired"
          : event.state === "denied" || event.state === "failed"
            ? "failed"
            : event.state;
    await this.finishDelivery({ messageId: event.messageId, state, ...(event.safeErrorCode === undefined ? {} : { safeErrorCode: event.safeErrorCode }), ...(event.replyText === undefined ? {} : { replyText: event.replyText }) });
  }

  private async finishDelivery(event: {
    messageId: string;
    state: "delivered" | "failed" | "ambiguous" | "expired" | "cancelled";
    safeErrorCode?: string;
    replyText?: string;
  }): Promise<void> {
    const context = this.messageContexts.get(event.messageId);
    if (context === undefined) return;
    try {
      await this.store.settleMessage({ messageId: event.messageId, state: event.state, ...(event.safeErrorCode === undefined ? {} : { safeErrorCode: safeCode(event.safeErrorCode, "PROVIDER_DELIVERY_FAILED") }) });
    } catch {
      return;
    }
    if (event.state !== "delivered") {
      await this.ackNativeReceipt(
        context.conversationId,
        "expired",
        safeCode(event.safeErrorCode, "CODEX_DELIVERY_FAILED"),
      );
      this.nativeIngressByConversation.delete(context.conversationId);
    } else {
      await this.ackNativeReceipt(context.conversationId, "delivered");
    }
    this.messageContexts.delete(event.messageId);
    if (
      this.activeDispatchByTarget.get(context.targetAlias) === event.messageId
    ) {
      this.activeDispatchByTarget.delete(context.targetAlias);
      this.scheduleDispatch(context.targetAlias);
    }
    const conversation = this.conversations.get(context.conversationId);
    if (event.state !== "delivered" && event.state !== "ambiguous") {
      this.releasePendingClaude(conversation);
    }
    if (
      !this.closing &&
      event.state === "delivered" &&
      event.replyText !== undefined &&
      event.replyText.length > 0 &&
      context.expectsReply &&
      conversation !== undefined
    ) {
      try {
        if (this.nativeIngressByConversation.has(conversation.id)) {
          await this.enqueueNativeReply(
            conversation,
            conversation.targetAlias,
            event.replyText,
            context.hopCount + 1,
          );
        } else {
          await this.enqueue(
            conversation.targetAlias,
            conversation.sourceAlias,
            event.replyText,
            false,
            true,
            conversation.id,
            context.hopCount + 1,
          );
        }
      } catch {
        this.dashboardHealthy = false;
      }
    }
    await this.changed();
  }

  private async onClaudeReply(event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    text: string;
  }): Promise<void> {
    if (this.closing) return;
    const selected = [...this.routeBindings.values()].filter(
      (binding) =>
        binding.provider === "claude" &&
        binding.hostId === event.endpoint.hostId &&
        binding.endpointGeneration === event.endpoint.endpointGeneration &&
        binding.routeHandle === event.endpoint.routeHandle,
    );
    if (selected.length !== 1) return;
    const binding = selected[0];
    if (binding === undefined) return;
    const key = bindingKey(binding);
    const pending = this.pendingClaudeReplies.get(key);
    if (pending === undefined || pending.bindingKey !== key) return;
    if (
      pending.tainted ||
      Date.parse(pending.deadlineAt) <= this.now().getTime()
    ) {
      this.pendingClaudeReplies.delete(key);
      return;
    }
    const conversation = this.conversations.get(pending.conversationId);
    if (conversation === undefined) return;
    this.pendingClaudeReplies.delete(key);
    await this.enqueue(
      conversation.targetAlias,
      conversation.sourceAlias,
      event.text,
      false,
      true,
      conversation.id,
      pending.hopCount + 1,
    );
  }

  private async onClaudeMessage(event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    sourceAlias: string;
    targetAlias: string;
    text: string;
    receiptHandle?: string;
  }): Promise<void> {
    if (this.closing) return;
    try {
      this.pruneTransient();
      if (this.conversations.size >= MAX_CONVERSATIONS) {
        throw new BridgeError(
          "CONVERSATION_CAPACITY",
          "The transient conversation table is full.",
          true,
        );
      }
      const target = this.routeBindings.get(event.targetAlias);
      const sourceBinding: PrivateRouteBinding = {
        ...event.endpoint,
        ownerLease: stableLease("claude", event.endpoint.routeHandle),
      };
      const collision = this.routeBindings.get(event.sourceAlias);
      if (
        target === undefined ||
        target.provider !== "codex" ||
        target.hostId !== event.endpoint.hostId ||
        (collision !== undefined &&
          bindingKey(collision) !== bindingKey(sourceBinding))
      ) {
        throw new BridgeError(
          "NATIVE_INGRESS_ROUTE_MISMATCH",
          "The native sender or registered Codex target no longer matches this exact host generation.",
        );
      }
      const conversationId = createGatewayConversationId();
      const deadlineAt = new Date(
        this.now().getTime() + this.config.limits.messageDeadlineMs,
      ).toISOString();
      const queued = await this.store.enqueueNativeIngress({
        source: { alias: event.sourceAlias, binding: sourceBinding },
        targetAlias: event.targetAlias,
        body: event.text,
        dedupeKey: `${conversationId}:0`,
        hopCount: 0,
        deadlineAt,
      });
      if (!queued.accepted || queued.messageId === undefined) {
        throw new BridgeError(
          "MESSAGE_REJECTED",
          "The native message was not accepted.",
        );
      }
      const conversation: Conversation = {
        id: conversationId,
        sourceAlias: event.sourceAlias,
        targetAlias: event.targetAlias,
        expectsReply: true,
        nextSequence: 1,
        lastHopCount: 0,
        lastActivityAt: this.now().toISOString(),
      };
      this.conversations.set(conversationId, conversation);
      this.messageContexts.set(queued.messageId, {
        conversationId,
        isReply: false,
        expectsReply: true,
        hopCount: 0,
        sequence: 0,
        targetBindingKey: bindingKey(target),
        authorization: "selected_route",
        targetAlias: event.targetAlias,
        deadlineAt,
      });
      this.nativeIngressByConversation.set(conversationId, {
        sourceAlias: event.sourceAlias,
        binding: sourceBinding,
        deadlineAt,
      });
      if (event.receiptHandle !== undefined) {
        this.nativeReceipts.set(conversationId, {
          hostId: event.endpoint.hostId,
          receiptHandle: event.receiptHandle,
        });
      }
      await this.changed();
      await this.setNativeCodexStatus(event.targetAlias, "waiting");
      this.scheduleDispatch(event.targetAlias);
    } catch (error) {
      if (event.receiptHandle !== undefined) {
        await this.adapter("claude", event.endpoint.hostId)
          .updateNativeInboundStatus?.(
            event.receiptHandle,
            "expired",
            safeCode(
              error instanceof BridgeError ? error.code : undefined,
              "NATIVE_INGRESS_REJECTED",
            ),
          )
          .catch(() => {
            this.dashboardHealthy = false;
          });
      }
    }
  }

  private releasePendingClaude(conversation: Conversation | undefined): void {
    if (conversation === undefined) return;
    for (const [key, owner] of this.pendingClaudeReplies) {
      if (owner.conversationId === conversation.id) {
        this.pendingClaudeReplies.delete(key);
      }
    }
  }

  private async onRouteState(
    source: PrivateEndpointIdentity,
    event: {
      routeHandle: string;
      state: GatewayAdapterRouteState;
      safeErrorCode?: string;
    },
  ): Promise<void> {
    if (this.closing) return;
    const entry = [...this.routeBindings.entries()].find(
      ([, binding]) =>
        binding.provider === source.provider &&
        binding.hostId === source.hostId &&
        binding.endpointGeneration === source.endpointGeneration &&
        binding.routeHandle === event.routeHandle,
    );
    if (entry === undefined) return;
    const [alias, binding] = entry;
    this.routeStates.set(alias, event.state);
    await this.store.observeRoute({ binding, state: event.state, compatibility: "compatible", ...(event.safeErrorCode === undefined ? {} : { safeErrorCode: safeCode(event.safeErrorCode, "ROUTE_DEGRADED") }) });
    await this.changed();
    if (binding.provider === "codex") {
      await this.setNativeCodexStatus(
        alias,
        event.state === "idle"
          ? "idle"
          : event.state === "awaiting_approval"
            ? "waiting"
            : "busy",
      );
    }
    if (event.state === "idle") this.scheduleDispatch(alias);
  }

  private async setNativeCodexStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    const binding = this.routeBindings.get(alias);
    if (binding?.provider !== "codex") return;
    await this.adapter("claude", binding.hostId)
      .updateNativeCodexPeerStatus?.(alias, status)
      .catch(() => {
        this.dashboardHealthy = false;
      });
  }

  private async ackNativeReceipt(
    conversationId: string | undefined,
    status: "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    if (conversationId === undefined) return;
    const receipt = this.nativeReceipts.get(conversationId);
    if (receipt === undefined) return;
    this.nativeReceipts.delete(conversationId);
    await this.adapter("claude", receipt.hostId)
      .updateNativeInboundStatus?.(
        receipt.receiptHandle,
        status,
        diagnosticCode,
      )
      .catch(() => {
        this.dashboardHealthy = false;
      });
  }

  private async exclusiveDecision(operation: () => Promise<void>): Promise<GatewayDecision> {
    return await this.mutex.run("service", async () => {
      try {
        await operation();
        return { accepted: true, code: "ok" };
      } catch (error) {
        return decisionFor(error);
      }
    });
  }

  private async changed(): Promise<void> {
    this.revision += 1;
    await this.publish();
  }

  private async publish(): Promise<void> {
    try {
      const base = await this.store.publicSnapshot();
      const snapshot = projectGatewayPublicSnapshot({ ...base, availablePeers: this.availablePeers.map((peer) => ({ ...peer })) });
      await this.publishDashboard(this.store.rootDir, snapshot);
      this.dashboardHealthy = true;
    } catch {
      this.dashboardHealthy = false;
    }
  }
}
