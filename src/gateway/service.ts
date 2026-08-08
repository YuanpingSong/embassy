import { createHash, randomBytes } from "node:crypto";

import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import type { GatewayConfig } from "./config.js";
import {
  createGatewayConversationId,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewayDeliveryStatusResult,
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
  type GatewayPrivateRouteInspection,
  type GatewayPublicSnapshot,
  type PrivateEndpointIdentity,
  type PrivateRouteBinding,
  type PublicAvailablePeerSnapshot,
  type RouteState,
  type SafeGatewayAlert,
  type TerminalMessageSettlement,
} from "./types.js";

const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MESSAGE_ID = /^msg_[0-9a-f-]{36}$/i;
const DELIVERY_TOKEN = /^dlv_[A-Za-z0-9_-]{24}$/;
const PRIVATE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CONVERSATIONS = 1_024;
const DELIVERY_ACK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const DELIVERY_ACK_GRACE_MS = 5_000;
const DELIVERY_DASHBOARD_REFRESH_MS = 15_000;

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

/**
 * One bounded discovery pass. `complete` is false when the provider stopped
 * before it could inspect the full registry; such a pass may be displayed but
 * cannot authorize selection restoration.
 */
export type GatewayAdapterDiscoverySnapshot = {
  peers: readonly GatewayAdapterDiscovery[];
  complete: boolean;
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
  /** Provider accepted the turn, but its final result/reply remains pending. */
  | { state: "accepted" }
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
  discoverClaudePeers?(): Promise<GatewayAdapterDiscoverySnapshot>;
  selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }>;
  /** Claude-only workspace guard. Codex registration has no workspace gate. */
  assertWorkspaceDisjoint?(
    routeHandle: string,
    stateRoot: string,
  ): Promise<void>;
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
  notifyNativeInboundProgress?(
    receiptHandle: string,
    progress: {
      kind: "stall";
      reason:
        | "ROUTE_BUSY"
        | "ROUTE_UNAVAILABLE"
        | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    },
  ): Promise<void>;
  releaseNativeInboundReceipt?(
    receiptHandle: string,
  ): boolean | Promise<boolean>;
  /** Fence new native ingress while keeping receipt writes available. */
  quiesceNativeInbound?(): Promise<void>;
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
  /** Store/body delivery settled at provider acceptance; reply turn still live. */
  providerAccepted?: boolean;
};

type DeliveryTerminalState =
  | "delivered"
  | "expired"
  | "failed"
  | "ambiguous"
  | "cancelled";

type DeliveryTrackerState = "queued" | "stalled" | DeliveryTerminalState;

type NativeTerminalNotification = {
  status: "delivered" | "denied" | "expired";
  diagnosticCode?: string;
  attempt: number;
  nextAttemptAt: number;
  retryUntil: number;
};

type NativeReceiptTracker = {
  hostId: string;
  receiptHandle: string;
  terminal?: NativeTerminalNotification;
};

type MessageDeliveryTracker = {
  messageId: string;
  conversationId: string;
  targetAlias: string;
  enqueuedAt: number;
  stallAt: number;
  deadlineAt: number;
  state: DeliveryTrackerState;
  updatedAt: number;
  stallSent: boolean;
  stallAttempt: number;
  stallNextAttemptAt: number;
  deliveryToken?: string;
  terminalAt?: number;
  safeErrorCode?: string;
  nativeReceipt?: NativeReceiptTracker;
};

type EnqueuedMessageResult = {
  conversationId: string;
  messageId: string;
  deliveryToken?: string;
};

type GatewayServiceTimer = ReturnType<typeof setTimeout>;

type GatewayServiceTimers = {
  setTimeout: (callback: () => void, delayMs: number) => GatewayServiceTimer;
  clearTimeout: (timer: GatewayServiceTimer) => void;
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
      receivedAt: number;
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
  adapters?: readonly GatewayProviderAdapter[];
  store?: GatewayStore;
  publishDashboard?: typeof publishGatewayDashboard;
  now?: () => Date;
  nativePeerCwd?: string;
  timers?: GatewayServiceTimers;
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

type CodexRegistrationLock = Readonly<{
  alias: string;
  threadId: string;
  hostId: string;
}>;

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
  private readonly adapters: readonly GatewayProviderAdapter[];
  private readonly publishDashboard: typeof publishGatewayDashboard;
  private readonly now: () => Date;
  private readonly timers: GatewayServiceTimers;
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
  private readonly deliveryTrackers = new Map<string, MessageDeliveryTracker>();
  private readonly deliveryTokens = new Map<string, string>();
  private readonly runtimeAlerts: SafeGatewayAlert[] = [];
  private readonly detachedReceiptWrites = new Set<Promise<void>>();
  private readonly nativeIngressByConversation = new Map<
    string,
    NativeIngressCapability
  >();
  private readonly callbackQueue: CallbackEvent[] = [];
  private callbackWorker: Promise<void> | undefined;
  private callbackScheduled = false;
  private readonly callbackCapacity: number;
  private readonly deliveryTokenCapacity: number;
  private lifecycleTimer: GatewayServiceTimer | undefined;
  private nextDashboardRefreshAt: number | undefined;
  private control: GatewayControlServer | undefined;
  private revision = 0;
  private running = false;
  private closing = false;
  private closeInFlight: Promise<void> | undefined;
  private acceptingCallbacks = true;
  private dashboardHealthy = true;
  /**
   * Process-lifetime identity guard. Unregistering removes reachability but
   * cannot turn the same native callback socket into a differently named
   * Codex peer. A new GatewayService process starts with no such lock.
   */
  private codexRegistrationLock: CodexRegistrationLock | undefined;

  constructor(options: GatewayServiceOptions) {
    this.config = options.config;
    this.adapters = [...(options.adapters ?? [])];
    this.publishDashboard = options.publishDashboard ?? publishGatewayDashboard;
    this.now = options.now ?? (() => new Date());
    this.store =
      options.store ?? new GatewayStore(options.config, { now: this.now });
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.nativePeerCwd = options.nativePeerCwd ?? process.cwd();
    this.callbackCapacity = Math.max(
      64,
      options.config.limits.maxRoutes +
        options.config.limits.maxInFlightMessages * 8,
    );
    this.deliveryTokenCapacity = Math.max(
      64,
      options.config.limits.maxQueueMessages * 4,
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running || this.closing) return;
    const assertStartActive = (): void => {
      if (signal?.aborted === true || this.closing) {
        throw new BridgeError(
          "GATEWAY_START_CANCELLED",
          "Gateway startup was cancelled before it became ready.",
          true,
        );
      }
    };
    assertStartActive();
    await this.store.initialize();
    try {
      assertStartActive();
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
        assertStartActive();
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
        assertStartActive();
      }
      const control = await startGatewayControlServer({
        stateDir: this.store.rootDir,
        socketPath: this.config.controlSocketPath,
        handlers: this.handlers(),
      });
      try {
        assertStartActive();
      } catch (error) {
        await control.close();
        throw error;
      }
      this.control = control;
      this.running = true;
      this.nextDashboardRefreshAt = undefined;
      this.scheduleLifecycleWakeLocked();
      await this.publish();
      assertStartActive();
    } catch (error) {
      this.running = false;
      // Startup and the server's lease-loss path may observe the same failure
      // from opposite sides. Join the one canonical cleanup so no caller can
      // release host ownership while an adapter/store close is still active.
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closeInFlight !== undefined) {
      return await this.closeInFlight;
    }
    this.closing = true;
    const close = this.closeOnce();
    this.closeInFlight = close;
    return await close;
  }

  private async closeOnce(): Promise<void> {
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
        this.acceptingCallbacks = false;
        if (this.lifecycleTimer !== undefined) {
          this.timers.clearTimeout(this.lifecycleTimer);
          this.lifecycleTimer = undefined;
        }
        const quiesceResults = await Promise.allSettled(
          this.adapters.map(async (adapter) =>
            await adapter.quiesceNativeInbound?.(),
          ),
        );
        if (quiesceResults.some((result) => result.status === "rejected")) {
          closeFailed = true;
        }
        await this.drainCallbackQueueLocked();
        for (const messageId of [...this.messageContexts.keys()]) {
          const cancelled = await this.store.cancelQueuedMessage(messageId);
          if (cancelled) {
            await this.applyTerminalSettlementLocked({
              messageId,
              state: "cancelled",
              safeErrorCode: "GATEWAY_SHUTDOWN",
            });
            continue;
          }
          const settled = await this.store.settleMessage({
            messageId,
            state: "ambiguous",
            safeErrorCode: "GATEWAY_SHUTDOWN",
          });
          if (settled.status === "settled") {
            await this.applyTerminalSettlementLocked(settled.settlement);
          }
        }
        for (const tracker of this.deliveryTrackers.values()) {
          if (!this.isTerminalDeliveryState(tracker.state)) {
            await this.markSenderTerminalLocked(
              tracker.messageId,
              "cancelled",
              "GATEWAY_SHUTDOWN",
            );
          }
          if (tracker.nativeReceipt?.terminal !== undefined) {
            await this.flushNativeReceiptLocked(
              tracker,
              this.now().getTime(),
              true,
            );
          }
        }
        await this.drainDetachedReceiptWritesLocked();
        await this.publish();
      } catch {
        closeFailed = true;
      }
      const adapterResults = await Promise.allSettled(
        this.adapters.map(async (adapter) => adapter.close()),
      );
      for (const result of adapterResults) {
        if (result.status === "rejected") closeFailed = true;
      }
      try {
        this.conversations.clear();
        this.messageContexts.clear();
        this.activeDispatchByTarget.clear();
        this.pendingClaudeReplies.clear();
        this.deliveryTrackers.clear();
        this.deliveryTokens.clear();
        this.runtimeAlerts.length = 0;
        this.detachedReceiptWrites.clear();
        this.nativeIngressByConversation.clear();
        this.callbackQueue.length = 0;
        this.candidates.clear();
        this.routeBindings.clear();
        this.routeStates.clear();
        this.bindingAliases.clear();
        await this.store.close().catch(() => {
          closeFailed = true;
        });
      } catch {
        closeFailed = true;
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
      deliveryStatus: async (params) => await this.deliveryStatus(params.token),
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
      const changed = await this.processLifecycleLocked();
      if (changed) {
        this.revision += 1;
        await this.publish();
      }
      return await this.publicSnapshotLocked();
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
          receivedAt: this.now().getTime(),
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
        const ingressFailureCode = this.closing
          ? "GATEWAY_SHUTDOWN"
          : "NATIVE_INGRESS_INVALID";
        const invalid =
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
            this.config.limits.maxMessageBytes;
        if (invalid) {
          if (source.provider === "claude" && event.receiptHandle !== undefined) {
            this.rejectDetachedNativeReceipt(
              source.hostId,
              event.receiptHandle,
              ingressFailureCode,
            );
          }
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
          this.rejectDetachedNativeReceipt(
            source.hostId,
            event.receiptHandle,
            "GATEWAY_CALLBACK_CAPACITY",
          );
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
        const retained = this.callbackQueue[duplicate];
        // A terminal's first service-boundary observation is authoritative.
        // Replacing it with a duplicate received at/after the deadline would
        // erase proof that the provider settled before the cutoff.
        if (
          retained?.type !== "delivery" ||
          !this.isTerminalAdapterDelivery(event.value) ||
          event.receivedAt < retained.receivedAt
        ) {
          this.callbackQueue[duplicate] = event;
        }
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
    const lifecycleChanged = await this.processLifecycleLocked();
    if (lifecycleChanged) {
      this.revision += 1;
      await this.publish();
    }
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

  private isTerminalAdapterDelivery(event: GatewayAdapterDelivery): boolean {
    return event.state !== "transport_written" && event.state !== "held";
  }

  /**
   * A terminal observed strictly before its delivery deadline must win even
   * if event-loop scheduling delays its callback worker until after that
   * deadline. Events observed at/after the cutoff remain behind the lifecycle
   * sweep and cannot reopen an expired attempt.
   */
  private async drainPreDeadlineTerminalCallbacksLocked(): Promise<void> {
    while (true) {
      const index = this.callbackQueue.findIndex((candidate) => {
        if (
          candidate.type !== "delivery" ||
          !this.isTerminalAdapterDelivery(candidate.value)
        ) {
          return false;
        }
        const context = this.messageContexts.get(candidate.value.messageId);
        return (
          context !== undefined &&
          candidate.receivedAt < Date.parse(context.deadlineAt)
        );
      });
      if (index < 0) return;
      const [event] = this.callbackQueue.splice(index, 1);
      if (event?.type === "delivery") {
        await this.onDelivery(event.source, event.value);
      }
    }
  }

  /**
   * A provider may synchronously emit a terminal callback before its dispatch
   * promise resolves to `pending`. Consume those already-retained callbacks
   * before interpreting `pending` as successful provider acceptance, otherwise
   * the sender can observe a false delivered result that wins the terminal
   * race against the queued failure.
   */
  private async drainDeliveryCallbacksForMessageLocked(
    messageId: string,
  ): Promise<void> {
    while (true) {
      const index = this.callbackQueue.findIndex((candidate) => {
        if (
          candidate.type !== "delivery" ||
          candidate.value.messageId !== messageId
        ) {
          return false;
        }
        if (!this.isTerminalAdapterDelivery(candidate.value)) return true;
        const context = this.messageContexts.get(messageId);
        return (
          context !== undefined &&
          candidate.receivedAt < Date.parse(context.deadlineAt)
        );
      });
      if (index < 0) return;
      const [event] = this.callbackQueue.splice(index, 1);
      if (event?.type === "delivery") {
        await this.onDelivery(event.source, event.value);
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

  private async assertClaudeWorkspaceDisjoint(
    adapter: GatewayProviderAdapter,
    routeHandle: string,
  ): Promise<void> {
    if (adapter.identity.provider !== "claude") {
      throw new BridgeError(
        "CLAUDE_PROVIDER_MISMATCH",
        "The selected workspace guard does not belong to Claude.",
      );
    }
    const assertWorkspaceDisjoint = adapter.assertWorkspaceDisjoint;
    if (assertWorkspaceDisjoint === undefined) {
      throw new BridgeError(
        "CLAUDE_WORKSPACE_ATTESTATION_UNAVAILABLE",
        "The selected Claude provider cannot revalidate its workspace.",
        true,
      );
    }
    await assertWorkspaceDisjoint.call(
      adapter,
      routeHandle,
      this.store.rootDir,
    );
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
    const registrationLock = this.codexRegistrationLock;
    if (
      registrationLock !== undefined &&
      (registrationLock.alias !== params.alias ||
        registrationLock.threadId !== params.threadId ||
        registrationLock.hostId !== params.hostId)
    ) {
      throw new BridgeError(
        "CODEX_REGISTRATION_REBIND_FORBIDDEN",
        "A Codex registration cannot change alias, task, or host during one Embassy process lifetime.",
      );
    }
    const persistedCodexRoutes = await this.store.inspectPrivateCodexRoutes();
    const persistedCodexRoute =
      persistedCodexRoutes.length === 1
        ? persistedCodexRoutes[0]
        : undefined;
    if (
      persistedCodexRoutes.length > 0 &&
      (persistedCodexRoute === undefined ||
        persistedCodexRoute.alias !== params.alias ||
        persistedCodexRoute.binding.hostId !== params.hostId ||
        persistedCodexRoute.binding.routeHandle !== params.threadId ||
        persistedCodexRoute.binding.ownerLease !==
          stableLease("codex", `${params.hostId}\0${params.threadId}`))
    ) {
      throw new BridgeError(
        "CODEX_REGISTRATION_REBIND_FORBIDDEN",
        "A retained Codex registration must be explicitly retired before another identity can register.",
      );
    }
    const routeBeforeRegistration = await this.store.inspectPrivateRoute(
      params.alias,
    );
    const adapter = this.adapter("codex", params.hostId);
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
    let advertiseAttempted = false;
    try {
      this.rememberBinding(params.alias, binding, registered.state);
      const claudeAdapter = this.adapter("claude", params.hostId);
      const advertise = claudeAdapter.advertiseNativeCodexPeer;
      if (advertise !== undefined) {
        advertiseAttempted = true;
        await advertise.call(claudeAdapter, {
          alias: params.alias,
          cwd: this.nativePeerCwd,
        });
      }
      await claudeAdapter.updateNativeCodexPeerStatus?.(
        params.alias,
        registered.state === "idle"
          ? "idle"
          : registered.state === "awaiting_approval"
            ? "waiting"
            : "busy",
      );
      await this.changed();
    } catch (error) {
      if (routeBeforeRegistration !== undefined) {
        // A persisted or live exact route, its queue, and any advertisement
        // predate this invocation, so a later status/dashboard failure cannot
        // safely delete them as "rollback". A post-restart reactivation also
        // establishes the process-lifetime identity even if publication fails.
        this.lockCodexRegistration(params);
        this.dashboardHealthy = false;
        throw error;
      }
      try {
        await this.rollbackCodexRegistration(
          params,
          binding,
          advertiseAttempted,
        );
      } catch (rollbackError) {
        // Some exact side effect may remain. Pin the provisional identity so a
        // second alias or task can never enter the adapter while cleanup is
        // uncertain.
        this.lockCodexRegistration(params);
        throw rollbackError;
      }
      throw error;
    }
    this.lockCodexRegistration(params);
    // The provider may have reported its initial idle observation before this
    // binding was remembered. Explicit registration is itself an authoritative
    // wake-up point, so do not require a second route notification to release a
    // message that was already held for this exact target.
    if (registered.state === "idle") this.scheduleDispatch(params.alias);
  }

  private lockCodexRegistration(
    params: ValidatedRegisterCodexParams,
  ): void {
    this.codexRegistrationLock ??= Object.freeze({
      alias: params.alias,
      threadId: params.threadId,
      hostId: params.hostId,
    });
  }

  private async rollbackCodexRegistration(
    params: ValidatedRegisterCodexParams,
    binding: PrivateRouteBinding,
    advertiseAttempted: boolean,
  ): Promise<void> {
    let cleanupFailed = false;
    try {
      const settlements = await this.store.unregisterRoute(
        params.alias,
        binding.ownerLease,
      );
      for (const settlement of settlements) {
        await this.applyTerminalSettlementLocked(settlement);
      }
    } catch {
      cleanupFailed = true;
    }
    this.forgetBinding(params.alias);
    await this.adapter("codex", params.hostId)
      .releaseRoute?.(params.threadId)
      .catch(() => {
        cleanupFailed = true;
      });
    if (advertiseAttempted) {
      await this.adapter("claude", params.hostId)
        .unadvertiseNativeCodexPeer?.(params.alias)
        .catch(() => {
          cleanupFailed = true;
        });
    }
    await this.changed().catch(() => {
      cleanupFailed = true;
    });
    if (cleanupFailed) {
      this.dashboardHealthy = false;
      throw new BridgeError(
        "CODEX_REGISTRATION_ROLLBACK_FAILED",
        "The failed Codex registration could not be fully rolled back.",
      );
    }
  }

  private async unregisterCodex(params: UnregisterCodexParams): Promise<void> {
    const host = params.alias.slice(params.alias.lastIndexOf("@") + 1);
    const lease = stableLease("codex", `${host}\0${params.threadId}`);
    const settlements = await this.store.unregisterRoute(params.alias, lease);
    for (const settlement of settlements) {
      await this.applyTerminalSettlementLocked(settlement);
    }
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

  private async discoveryPublicFingerprint(): Promise<string> {
    const base = await this.store.publicSnapshot();
    const snapshot = projectGatewayPublicSnapshot({
      ...base,
      availablePeers: this.availablePeers.map((peer) => ({ ...peer })),
    });
    return JSON.stringify({
      health: snapshot.health,
      connectors: snapshot.connectors.map(
        ({ lastSeenAt: _lastSeenAt, ...connector }) => connector,
      ),
      availablePeers: snapshot.availablePeers.map(
        ({ lastSeenAt: _lastSeenAt, ...peer }) => peer,
      ),
      routes: snapshot.routes.map(
        ({ lastSeenAt: _lastSeenAt, ...route }) => route,
      ),
      messages: snapshot.messages,
      accounting: snapshot.accounting,
      alerts: snapshot.alerts.map(({ timestamp: _timestamp, ...alert }) =>
        alert,
      ),
      truncation: snapshot.truncation,
    });
  }

  private async refreshClaudeDiscovery(): Promise<boolean> {
    const publicBefore = await this.discoveryPublicFingerprint();
    this.candidates.clear();
    const rowsByAlias = new Map<
      string,
      {
        peer: GatewayAdapterDiscovery;
        adapter: GatewayProviderAdapter;
        safeErrorCode?: "PEER_ALIAS_COLLISION" | "PEER_SESSION_COLLISION" | "PEER_DISCOVERY_INCOMPLETE";
      }
    >();
    const discoveredCandidates: Candidate[] = [];
    const observedSelected = new Set<string>();
    for (const adapter of this.adapters.filter(
      (item) => item.identity.provider === "claude",
    )) {
      const discovered = (await adapter.discoverClaudePeers?.()) ?? {
        peers: [],
        complete: false,
      };
      const grouped = new Map<string, GatewayAdapterDiscovery[]>();
      const byHandle = new Map<string, GatewayAdapterDiscovery[]>();
      for (const peer of discovered.peers) {
        if (
          !PUBLIC_ALIAS.test(peer.alias) ||
          !peer.alias.endsWith(`@${adapter.identity.hostId}`) ||
          peer.kind !== "interactive"
        ) {
          continue;
        }
        grouped.set(peer.alias, [...(grouped.get(peer.alias) ?? []), peer]);
        byHandle.set(peer.routeHandle, [
          ...(byHandle.get(peer.routeHandle) ?? []),
          peer,
        ]);
      }
      for (const [alias, matches] of grouped) {
        const peer = matches[0];
        if (peer === undefined) continue;
        if (matches.length !== 1) {
          rowsByAlias.set(alias, {
            peer,
            adapter,
            safeErrorCode: "PEER_ALIAS_COLLISION",
          });
          continue;
        }
        if (!discovered.complete) {
          rowsByAlias.set(alias, {
            peer,
            adapter,
            safeErrorCode: "PEER_DISCOVERY_INCOMPLETE",
          });
          continue;
        }
        if ((byHandle.get(peer.routeHandle)?.length ?? 0) !== 1) {
          rowsByAlias.set(alias, {
            peer,
            adapter,
            safeErrorCode: "PEER_SESSION_COLLISION",
          });
          continue;
        }
        rowsByAlias.set(alias, { peer, adapter });
        discoveredCandidates.push({ ...peer, adapter });
      }
    }

    for (const candidate of discoveredCandidates) {
      const { alias, adapter, routeHandle } = candidate;
      const row = rowsByAlias.get(alias);
      if (row?.safeErrorCode !== undefined) continue;
      try {
        const existing = [...this.routeBindings.entries()].find(
          ([, binding]) =>
            binding.provider === "claude" &&
            binding.hostId === adapter.identity.hostId &&
            binding.endpointGeneration === adapter.identity.endpointGeneration &&
            binding.routeHandle === routeHandle,
        );
        if (existing !== undefined && existing[0] !== alias) {
          const collision = this.routeBindings.get(alias);
          if (
            collision !== undefined &&
              bindingKey(collision) !== bindingKey(existing[1])
          ) {
            rowsByAlias.set(alias, {
              peer: candidate,
              adapter,
              safeErrorCode: "PEER_ALIAS_COLLISION",
            });
            continue;
          }
          await this.renameClaudeRoute(existing[0], alias, existing[1]);
        }
        this.candidates.set(alias, candidate);
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        rowsByAlias.set(alias, {
          peer: candidate,
          adapter,
          safeErrorCode: "PEER_ALIAS_COLLISION",
        });
      }
    }

    const persisted = await this.store.inspectPrivateClaudeRoutes();
    for (const route of persisted) {
      if (
        !route.enabled ||
        route.state !== "stale" ||
        route.compatibility !== "expired" ||
        !CLAUDE_SESSION_ID.test(route.binding.routeHandle) ||
        route.binding.ownerLease !==
          stableLease("claude", route.binding.routeHandle)
      ) {
        continue;
      }
      const matches = [...this.candidates.values()].filter(
        (candidate) =>
          candidate.adapter.identity.provider === route.binding.provider &&
          candidate.adapter.identity.hostId === route.binding.hostId &&
          candidate.routeHandle === route.binding.routeHandle,
      );
      if (matches.length !== 1) continue;
      const candidate = matches[0];
      if (candidate === undefined) continue;
      await this.activatePersistedClaudeCandidate(
        candidate,
        route,
        "peer_identity_reobserved",
      ).catch(() => undefined);
    }

    const rows: PublicAvailablePeerSnapshot[] = [];
    for (const [alias, row] of rowsByAlias) {
      if (row.safeErrorCode !== undefined) {
        this.candidates.delete(alias);
        rows.push({
          alias,
          provider: "claude",
          host: row.adapter.identity.hostId,
          state: "incompatible",
          compatibility: "incompatible",
          selected: false,
          safeErrorCode: row.safeErrorCode,
        });
        continue;
      }
      const selectedBinding = this.routeBindings.get(alias);
      const selected =
        selectedBinding?.provider === "claude" &&
        selectedBinding.hostId === row.adapter.identity.hostId &&
        selectedBinding.endpointGeneration ===
          row.adapter.identity.endpointGeneration &&
        selectedBinding.routeHandle === row.peer.routeHandle;
      rows.push({
        alias,
        provider: "claude",
        host: row.adapter.identity.hostId,
        state: row.peer.state,
        compatibility: row.peer.compatibility,
        selected,
      });
      if (selected && selectedBinding !== undefined) {
        observedSelected.add(bindingKey(selectedBinding));
        await this.store.observeRoute({
          binding: selectedBinding,
          state: row.peer.state,
          compatibility: "compatible",
        });
      }
    }

    for (const [alias, binding] of [...this.routeBindings.entries()]) {
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
        const settlements = await this.store.invalidateRoute(
          binding,
          "PEER_NOT_OBSERVED",
        );
        for (const settlement of settlements) {
          await this.applyTerminalSettlementLocked(settlement);
        }
      }
      await this.adapter("claude", binding.hostId)
        .releaseRoute?.(binding.routeHandle)
        .catch(() => {
          this.dashboardHealthy = false;
        });
      this.forgetBinding(alias);
    }
    this.availablePeers = rows.sort((left, right) =>
      left.alias.localeCompare(right.alias),
    );
    const changed =
      publicBefore !== (await this.discoveryPublicFingerprint());
    if (changed) this.revision += 1;
    return changed;
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
    for (const tracker of this.deliveryTrackers.values()) {
      if (tracker.targetAlias === oldAlias) tracker.targetAlias = newAlias;
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
      const matches = [...this.candidates.values()].filter(
        (candidate) => candidate.routeHandle.toLowerCase() === normalized,
      );
      return matches.length === 1 ? matches[0] : undefined;
    }
    return this.candidates.get(selector);
  }

  private async activatePersistedClaudeCandidate(
    candidate: Candidate,
    persisted: GatewayPrivateRouteInspection,
    reason: "peer_explicitly_reselected" | "peer_identity_reobserved",
  ): Promise<void> {
    const expectedLease = stableLease("claude", candidate.routeHandle);
    if (
      !persisted.enabled ||
      persisted.state !== "stale" ||
      persisted.compatibility !== "expired" ||
      persisted.binding.provider !== "claude" ||
      candidate.adapter.identity.provider !== "claude" ||
      persisted.binding.hostId !== candidate.adapter.identity.hostId ||
      persisted.binding.routeHandle !== candidate.routeHandle ||
      persisted.binding.ownerLease !== expectedLease
    ) {
      throw new BridgeError(
        "ROUTE_REBIND_IDENTITY_MISMATCH",
        "The persisted Claude selection does not match the exact live session identity.",
      );
    }
    await this.assertClaudeWorkspaceDisjoint(
      candidate.adapter,
      candidate.routeHandle,
    );
    try {
      const selected = await candidate.adapter.selectRoute({
        alias: candidate.alias,
        routeHandle: candidate.routeHandle,
      });
      if (selected.routeHandle !== candidate.routeHandle) {
        throw new BridgeError(
          "ROUTE_MISMATCH",
          "The peer identity changed during selection.",
        );
      }
      const binding: PrivateRouteBinding = {
        ...candidate.adapter.identity,
        routeHandle: candidate.routeHandle,
        ownerLease: expectedLease,
      };
      await this.store.rebindStaleRoute({
        alias: persisted.alias,
        newAlias: candidate.alias,
        currentOwnerLease: persisted.binding.ownerLease,
        newBinding: binding,
        reason,
        state: selected.state,
      });
      if (persisted.alias !== candidate.alias) {
        this.forgetBinding(persisted.alias);
      }
      this.rememberBinding(candidate.alias, binding, selected.state);
    } catch (error) {
      await candidate.adapter.releaseRoute?.(candidate.routeHandle).catch(() => {
        this.dashboardHealthy = false;
      });
      throw error;
    }
  }

  private async selectClaudeCandidate(
    candidate: Candidate,
    persisted?: GatewayPrivateRouteInspection,
  ): Promise<void> {
    if (persisted !== undefined) {
      await this.activatePersistedClaudeCandidate(
        candidate,
        persisted,
        "peer_explicitly_reselected",
      );
      return;
    }
    await this.assertClaudeWorkspaceDisjoint(
      candidate.adapter,
      candidate.routeHandle,
    );
    const binding: PrivateRouteBinding = {
      ...candidate.adapter.identity,
      routeHandle: candidate.routeHandle,
      ownerLease: stableLease("claude", candidate.routeHandle),
    };
    try {
      const selected = await candidate.adapter.selectRoute({
        alias: candidate.alias,
        routeHandle: candidate.routeHandle,
      });
      if (selected.routeHandle !== candidate.routeHandle) {
        throw new BridgeError(
          "ROUTE_MISMATCH",
          "The peer identity changed during selection.",
        );
      }
      await this.store.registerRoute({
        alias: candidate.alias,
        binding,
        registrationMode: "selected_live_peer",
        state: selected.state,
        compatibility: "compatible",
      });
      this.rememberBinding(candidate.alias, binding, selected.state);
    } catch (error) {
      await candidate.adapter.releaseRoute?.(candidate.routeHandle).catch(() => {
        this.dashboardHealthy = false;
      });
      throw error;
    }
  }

  private async resolveSelectedClaudeDestination(
    selector: string,
  ): Promise<{ alias: string; discoveryChanged: boolean }> {
    const discoveryChanged = await this.refreshClaudeDiscovery();
    try {
      const candidate = this.claudeCandidate(selector);
      if (candidate === undefined) {
        throw new BridgeError(
          "PEER_NOT_FOUND",
          "No unique compatible interactive peer matches that current name or session UUID.",
        );
      }
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
      return { alias: candidate.alias, discoveryChanged };
    } catch (error) {
      if (discoveryChanged) await this.publish();
      throw error;
    }
  }

  private async selectClaude(params: SelectClaudeParams): Promise<void> {
    const discoveryChanged = await this.refreshClaudeDiscovery();
    const candidate = this.claudeCandidate(params.alias);
    if (candidate === undefined) throw new BridgeError("PEER_NOT_FOUND", "No unique compatible interactive peer matches that current name or session UUID.");
    const persisted = await this.store.inspectPrivateClaudeRoutes();
    const byAlias = persisted.find((route) => route.alias === candidate.alias);
    const byIdentity = persisted.find(
      (route) =>
        route.binding.hostId === candidate.adapter.identity.hostId &&
        route.binding.routeHandle === candidate.routeHandle,
    );
    if (
      byAlias !== undefined &&
      byAlias.binding.routeHandle !== candidate.routeHandle
    ) {
      throw new BridgeError(
        "ROUTE_ALIAS_COLLISION",
        "That current name belongs to a different durable Claude selection; unselect it before selecting another session.",
      );
    }
    const live = this.routeBindings.get(candidate.alias);
    if (
      live?.provider === "claude" &&
      live.hostId === candidate.adapter.identity.hostId &&
      live.routeHandle === candidate.routeHandle
    ) {
      if (discoveryChanged) await this.publish();
      return;
    }
    await this.selectClaudeCandidate(candidate, byIdentity);
    await this.refreshClaudeDiscovery();
    await this.publish();
  }

  private async unselectClaude(params: SelectClaudeParams): Promise<void> {
    const persisted = await this.store.inspectPrivateClaudeRoutes();
    const selected = CLAUDE_SESSION_ID.test(params.alias)
      ? persisted.find(
          (route) =>
            route.binding.routeHandle.toLowerCase() ===
            params.alias.toLowerCase(),
        )
      : persisted.find((route) => route.alias === params.alias);
    if (selected === undefined) throw new BridgeError("PEER_NOT_FOUND", "No selected Claude session matches that selector.");
    const { alias, binding } = selected;
    const settlements = await this.store.unregisterRoute(
      alias,
      binding.ownerLease,
    );
    for (const settlement of settlements) {
      await this.applyTerminalSettlementLocked(settlement);
    }
    this.forgetBinding(alias);
    await this.adapters
      .find(
        (adapter) =>
          adapter.identity.provider === "claude" &&
          adapter.identity.hostId === binding.hostId,
      )
      ?.releaseRoute?.(binding.routeHandle)
      .catch(() => {
        this.dashboardHealthy = false;
      });
    this.availablePeers = this.availablePeers.map((peer) =>
      peer.alias === alias ? { ...peer, selected: false } : peer,
    );
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
    await this.assertClaudeWorkspaceDisjoint(adapter, binding.routeHandle);
    return binding;
  }

  private acceptedControlResult(
    enqueued: EnqueuedMessageResult,
  ): GatewaySendResult {
    if (enqueued.deliveryToken === undefined) {
      throw new BridgeError(
        "DELIVERY_TOKEN_UNAVAILABLE",
        "The accepted message is missing its delivery correlation handle.",
      );
    }
    return {
      accepted: true,
      code: "ok",
      conversationId: enqueued.conversationId,
      deliveryToken: enqueued.deliveryToken,
    };
  }

  private reserveDeliveryToken(): string {
    this.pruneDeliveryTrackers(this.now().getTime());
    while (this.deliveryTokens.size >= this.deliveryTokenCapacity) {
      const oldestTerminal = [...this.deliveryTrackers.values()]
        .filter(
          (tracker) =>
            tracker.deliveryToken !== undefined &&
            this.isTerminalDeliveryState(tracker.state),
        )
        .sort(
          (left, right) =>
            (left.terminalAt ?? left.updatedAt) -
              (right.terminalAt ?? right.updatedAt) ||
            left.messageId.localeCompare(right.messageId),
        )[0];
      if (oldestTerminal?.deliveryToken === undefined) break;
      this.deliveryTokens.delete(oldestTerminal.deliveryToken);
      delete oldestTerminal.deliveryToken;
      if (oldestTerminal.nativeReceipt === undefined) {
        this.deliveryTrackers.delete(oldestTerminal.messageId);
      }
    }
    if (this.deliveryTokens.size >= this.deliveryTokenCapacity) {
      throw new BridgeError(
        "DELIVERY_STATUS_CAPACITY",
        "The bounded delivery status table is full.",
        true,
      );
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = `dlv_${randomBytes(18).toString("base64url")}`;
      if (DELIVERY_TOKEN.test(token) && !this.deliveryTokens.has(token)) {
        return token;
      }
    }
    throw new BridgeError(
      "DELIVERY_TOKEN_COLLISION",
      "The gateway could not allocate a unique delivery token.",
      true,
    );
  }

  private armDeliveryTracker(input: {
    messageId: string;
    conversationId: string;
    targetAlias: string;
    enqueuedAt: number;
    deadlineAt: string;
    deliveryToken?: string;
  }): void {
    const deadlineAt = Date.parse(input.deadlineAt);
    const tracker: MessageDeliveryTracker = {
      messageId: input.messageId,
      conversationId: input.conversationId,
      targetAlias: input.targetAlias,
      enqueuedAt: input.enqueuedAt,
      stallAt: Math.min(
        input.enqueuedAt + this.config.stallNoticeMs,
        deadlineAt - 1,
      ),
      deadlineAt,
      state: "queued",
      updatedAt: input.enqueuedAt,
      stallSent: false,
      stallAttempt: 0,
      stallNextAttemptAt: input.enqueuedAt + this.config.stallNoticeMs,
      ...(input.deliveryToken === undefined
        ? {}
        : { deliveryToken: input.deliveryToken }),
    };
    this.deliveryTrackers.set(input.messageId, tracker);
    if (input.deliveryToken !== undefined) {
      this.deliveryTokens.set(input.deliveryToken, input.messageId);
    }
    this.nextDashboardRefreshAt ??=
      input.enqueuedAt + DELIVERY_DASHBOARD_REFRESH_MS;
    this.scheduleLifecycleWakeLocked();
  }

  private isTerminalDeliveryState(
    state: DeliveryTrackerState,
  ): state is DeliveryTerminalState {
    return (
      state === "delivered" ||
      state === "expired" ||
      state === "failed" ||
      state === "ambiguous" ||
      state === "cancelled"
    );
  }

  private settlementDeliveryState(
    settlement: TerminalMessageSettlement,
  ): DeliveryTerminalState {
    return settlement.state === "abandoned" ? "failed" : settlement.state;
  }

  private pruneDeliveryTrackers(now: number): void {
    const retentionMs = Math.max(
      60_000,
      this.config.limits.messageDeadlineMs * 2,
    );
    for (const [messageId, tracker] of this.deliveryTrackers) {
      if (!this.isTerminalDeliveryState(tracker.state)) continue;
      const tokenExpired =
        tracker.deliveryToken === undefined ||
        (tracker.terminalAt ?? tracker.updatedAt) + retentionMs <= now;
      if (!tokenExpired || tracker.nativeReceipt !== undefined) continue;
      this.deliveryTrackers.delete(messageId);
      if (tracker.deliveryToken !== undefined) {
        this.deliveryTokens.delete(tracker.deliveryToken);
      }
    }
  }

  private addRuntimeAlert(
    code: string,
    severity: SafeGatewayAlert["severity"],
    details: Pick<SafeGatewayAlert, "provider" | "host" | "alias"> = {},
  ): void {
    this.runtimeAlerts.push({
      code: safeCode(code, "GATEWAY_RUNTIME_ALERT"),
      severity,
      timestamp: this.now().toISOString(),
      ...details,
    });
    if (this.runtimeAlerts.length > 64) {
      this.runtimeAlerts.splice(0, this.runtimeAlerts.length - 64);
    }
  }

  private setNativeTerminalLocked(
    tracker: MessageDeliveryTracker,
    status: NativeTerminalNotification["status"],
    diagnosticCode?: string,
  ): void {
    const receipt = tracker.nativeReceipt;
    if (receipt === undefined || receipt.terminal !== undefined) return;
    const now = this.now().getTime();
    receipt.terminal = {
      status,
      ...(diagnosticCode === undefined
        ? {}
        : { diagnosticCode: safeCode(diagnosticCode, "CODEX_DELIVERY_FAILED") }),
      attempt: 0,
      nextAttemptAt: now,
      retryUntil: Math.max(tracker.deadlineAt, now + DELIVERY_ACK_GRACE_MS),
    };
  }

  private async releaseNativeReceiptLocked(
    tracker: MessageDeliveryTracker,
    diagnosticCode: string,
  ): Promise<void> {
    const receipt = tracker.nativeReceipt;
    if (receipt === undefined) return;
    try {
      await this.adapter("claude", receipt.hostId)
        .releaseNativeInboundReceipt?.(receipt.receiptHandle);
    } catch {
      // The transport is already unconfirmed. Never keep an authority-bearing
      // receipt forever merely because explicit release also failed.
    }
    delete tracker.nativeReceipt;
    this.addRuntimeAlert("NATIVE_RECEIPT_UNCONFIRMED", "warning", {
      provider: "claude",
      host: receipt.hostId,
      alias: tracker.targetAlias,
    });
    tracker.safeErrorCode ??= safeCode(
      diagnosticCode,
      "NATIVE_RECEIPT_UNCONFIRMED",
    );
  }

  private async flushNativeReceiptLocked(
    tracker: MessageDeliveryTracker,
    now: number,
    shutdown = false,
  ): Promise<boolean> {
    const receipt = tracker.nativeReceipt;
    const terminal = receipt?.terminal;
    if (receipt === undefined || terminal === undefined) return false;
    if (!shutdown && terminal.nextAttemptAt > now) return false;
    try {
      const adapter = this.adapter("claude", receipt.hostId);
      const update = adapter.updateNativeInboundStatus;
      if (update === undefined) {
        throw new BridgeError(
          "NATIVE_RECEIPT_TRANSPORT_UNAVAILABLE",
          "The Claude adapter cannot settle a native receipt.",
        );
      }
      await update.call(
        adapter,
        receipt.receiptHandle,
        terminal.status,
        terminal.diagnosticCode,
      );
      delete tracker.nativeReceipt;
      return true;
    } catch (error) {
      const cleanPrewrite = error instanceof BridgeError && error.recoverable;
      terminal.attempt += 1;
      const delay =
        DELIVERY_ACK_RETRY_DELAYS_MS[
          Math.min(
            terminal.attempt - 1,
            DELIVERY_ACK_RETRY_DELAYS_MS.length - 1,
          )
        ] ?? DELIVERY_ACK_RETRY_DELAYS_MS.at(-1) ?? 2_000;
      const nextAttemptAt = now + delay;
      if (
        !shutdown &&
        cleanPrewrite &&
        terminal.attempt <= DELIVERY_ACK_RETRY_DELAYS_MS.length &&
        nextAttemptAt <= terminal.retryUntil
      ) {
        terminal.nextAttemptAt = nextAttemptAt;
        return true;
      }
      await this.releaseNativeReceiptLocked(
        tracker,
        error instanceof BridgeError
          ? error.code
          : "NATIVE_RECEIPT_UNCONFIRMED",
      );
      return true;
    }
  }

  private async markSenderTerminalLocked(
    messageId: string,
    state: DeliveryTerminalState,
    safeErrorCode?: string,
  ): Promise<boolean> {
    const tracker = this.deliveryTrackers.get(messageId);
    if (tracker === undefined || this.isTerminalDeliveryState(tracker.state)) {
      return false;
    }
    const now = this.now().getTime();
    tracker.state = state;
    tracker.updatedAt = now;
    tracker.terminalAt = now;
    if (safeErrorCode !== undefined) {
      tracker.safeErrorCode = safeCode(
        safeErrorCode,
        state === "delivered" ? "DELIVERED" : "CODEX_DELIVERY_FAILED",
      );
    }
    this.setNativeTerminalLocked(
      tracker,
      state === "delivered" ? "delivered" : "expired",
      state === "delivered"
        ? undefined
        : safeCode(safeErrorCode, "CODEX_DELIVERY_FAILED"),
    );
    await this.flushNativeReceiptLocked(tracker, now);
    if (
      tracker.deliveryToken === undefined &&
      tracker.nativeReceipt === undefined
    ) {
      this.deliveryTrackers.delete(messageId);
    }
    return true;
  }

  private async applyTerminalSettlementLocked(
    settlement: TerminalMessageSettlement,
  ): Promise<MessageContext | undefined> {
    const state = this.settlementDeliveryState(settlement);
    await this.markSenderTerminalLocked(
      settlement.messageId,
      state,
      settlement.safeErrorCode,
    );
    return this.takeMessageContextLocked(settlement.messageId, state);
  }

  private takeMessageContextLocked(
    messageId: string,
    state: DeliveryTerminalState,
  ): MessageContext | undefined {
    const context = this.messageContexts.get(messageId);
    if (context === undefined) return undefined;
    this.messageContexts.delete(messageId);
    if (
      this.activeDispatchByTarget.get(context.targetAlias) ===
      messageId
    ) {
      this.activeDispatchByTarget.delete(context.targetAlias);
      if (!this.closing) this.scheduleDispatch(context.targetAlias);
    }
    const conversation = this.conversations.get(context.conversationId);
    if (state !== "delivered" && state !== "ambiguous") {
      this.releasePendingClaude(conversation);
    }
    if (state !== "delivered") {
      this.nativeIngressByConversation.delete(context.conversationId);
    }
    return context;
  }

  /**
   * Codex App Server acceptance is a terminal delivery boundary for the
   * original message body, but not for its later model reply. Settle the
   * durable ledger/body now and retain only bounded in-memory reply
   * correlation until completion or the original deadline.
   */
  private async acceptProviderDeliveryLocked(messageId: string): Promise<boolean> {
    const result = await this.store.settleMessage({
      messageId,
      state: "delivered",
    });
    if (result.status !== "settled") return false;
    const context = this.messageContexts.get(messageId);
    if (context === undefined) return false;
    context.providerAccepted = true;
    await this.markSenderTerminalLocked(messageId, "delivered");
    return true;
  }

  private stallReasonFor(
    tracker: MessageDeliveryTracker,
  ):
    | "ROUTE_BUSY"
    | "ROUTE_UNAVAILABLE"
    | "AWAITING_EXTERNAL_APPROVAL" {
    const state = this.routeStates.get(tracker.targetAlias);
    if (state === "awaiting_approval") return "AWAITING_EXTERNAL_APPROVAL";
    if (state === "busy") return "ROUTE_BUSY";
    return "ROUTE_UNAVAILABLE";
  }

  private async processLifecycleLocked(): Promise<boolean> {
    const nowDate = this.now();
    const now = nowDate.getTime();
    let changed = false;
    await this.drainPreDeadlineTerminalCallbacksLocked();
    const due = await this.store.expireDueMessages(nowDate);
    for (const settlement of due) {
      await this.applyTerminalSettlementLocked(settlement);
      changed = true;
    }
    for (const [messageId, context] of this.messageContexts) {
      if (
        context.providerAccepted !== true ||
        Date.parse(context.deadlineAt) > now
      ) {
        continue;
      }
      this.takeMessageContextLocked(messageId, "expired");
      this.addRuntimeAlert("PROVIDER_REPLY_DEADLINE_EXPIRED", "warning", {
        alias: context.targetAlias,
      });
      changed = true;
    }
    for (const tracker of this.deliveryTrackers.values()) {
      if (
        this.closing ||
        this.isTerminalDeliveryState(tracker.state) ||
        tracker.stallSent ||
        tracker.stallAt > now ||
        tracker.stallNextAttemptAt > now
      ) {
        continue;
      }
      tracker.state = "stalled";
      tracker.updatedAt = now;
      changed = true;
      const receipt = tracker.nativeReceipt;
      if (receipt === undefined) {
        tracker.stallSent = true;
        continue;
      }
      try {
        const adapter = this.adapter("claude", receipt.hostId);
        const notify = adapter.notifyNativeInboundProgress;
        if (notify === undefined) {
          throw new BridgeError(
            "NATIVE_PROGRESS_TRANSPORT_UNAVAILABLE",
            "The Claude adapter cannot publish delivery progress.",
          );
        }
        await notify.call(adapter, receipt.receiptHandle, {
          kind: "stall",
          reason: this.stallReasonFor(tracker),
          queuedForMs: Math.max(0, now - tracker.enqueuedAt),
        });
        tracker.stallSent = true;
      } catch (error) {
        const cleanPrewrite = error instanceof BridgeError && error.recoverable;
        tracker.stallAttempt += 1;
        const delay =
          DELIVERY_ACK_RETRY_DELAYS_MS[
            Math.min(
              tracker.stallAttempt - 1,
              DELIVERY_ACK_RETRY_DELAYS_MS.length - 1,
            )
          ] ?? DELIVERY_ACK_RETRY_DELAYS_MS.at(-1) ?? 2_000;
        const nextAttemptAt = now + delay;
        if (
          cleanPrewrite &&
          tracker.stallAttempt <= DELIVERY_ACK_RETRY_DELAYS_MS.length &&
          nextAttemptAt < tracker.deadlineAt
        ) {
          tracker.stallNextAttemptAt = nextAttemptAt;
          continue;
        }
        // A non-recoverable/ambiguous write may already have reached Claude;
        // never replay it. Exhausted clean pre-write retries are also bounded.
        tracker.stallSent = true;
        this.addRuntimeAlert("NATIVE_STALL_NOTICE_UNCONFIRMED", "warning", {
          provider: "claude",
          host: receipt.hostId,
          alias: tracker.targetAlias,
        });
      }
    }
    for (const tracker of this.deliveryTrackers.values()) {
      const receipt = tracker.nativeReceipt;
      if (
        receipt?.terminal !== undefined &&
        receipt.terminal.nextAttemptAt <= now
      ) {
        changed =
          (await this.flushNativeReceiptLocked(tracker, now)) || changed;
      }
    }
    if (
      this.nextDashboardRefreshAt !== undefined &&
      this.nextDashboardRefreshAt <= now
    ) {
      changed = true;
      this.nextDashboardRefreshAt = now + DELIVERY_DASHBOARD_REFRESH_MS;
    }
    this.pruneTransient();
    this.pruneDeliveryTrackers(now);
    this.scheduleLifecycleWakeLocked();
    return changed;
  }

  private scheduleLifecycleWakeLocked(): void {
    if (this.lifecycleTimer !== undefined) {
      this.timers.clearTimeout(this.lifecycleTimer);
      this.lifecycleTimer = undefined;
    }
    if (!this.running || this.closing) return;
    const now = this.now().getTime();
    let wakeAt: number | undefined;
    let hasNonterminal = false;
    const consider = (candidate: number): void => {
      wakeAt = wakeAt === undefined ? candidate : Math.min(wakeAt, candidate);
    };
    for (const tracker of this.deliveryTrackers.values()) {
      if (!this.isTerminalDeliveryState(tracker.state)) {
        hasNonterminal = true;
        if (!tracker.stallSent) {
          consider(Math.max(tracker.stallAt, tracker.stallNextAttemptAt));
        }
        consider(tracker.deadlineAt);
      }
      const nextAttemptAt = tracker.nativeReceipt?.terminal?.nextAttemptAt;
      if (nextAttemptAt !== undefined) consider(nextAttemptAt);
      if (
        this.isTerminalDeliveryState(tracker.state) &&
        tracker.deliveryToken !== undefined
      ) {
        consider(
          (tracker.terminalAt ?? tracker.updatedAt) +
            Math.max(60_000, this.config.limits.messageDeadlineMs * 2),
        );
      }
    }
    // Provider acceptance may settle the original body while its bounded
    // reply correlation remains live; plain pending stays nonterminal. Keep
    // every retained reply context's deadline scheduled independently.
    for (const context of this.messageContexts.values()) {
      const deadlineAt = Date.parse(context.deadlineAt);
      if (Number.isFinite(deadlineAt)) consider(deadlineAt);
    }
    if (hasNonterminal) {
      this.nextDashboardRefreshAt ??= now + DELIVERY_DASHBOARD_REFRESH_MS;
      consider(this.nextDashboardRefreshAt);
    } else {
      this.nextDashboardRefreshAt = undefined;
    }
    if (wakeAt === undefined) return;
    const timer = this.timers.setTimeout(() => {
      if (this.lifecycleTimer !== timer) return;
      this.lifecycleTimer = undefined;
      void this.mutex
        .run("service", async () => {
          const changed = await this.processLifecycleLocked();
          if (changed) {
            this.revision += 1;
            await this.publish();
          }
        })
        .catch(() => {
          this.dashboardHealthy = false;
        });
    }, Math.max(0, wakeAt - now));
    this.lifecycleTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  private async deliveryStatus(
    token: string,
  ): Promise<GatewayDeliveryStatusResult> {
    return await this.mutex.run("service", async () => {
      if (!DELIVERY_TOKEN.test(token)) return { found: false };
      const changed = await this.processLifecycleLocked();
      if (changed) {
        this.revision += 1;
        await this.publish();
      }
      const messageId = this.deliveryTokens.get(token);
      const tracker =
        messageId === undefined
          ? undefined
          : this.deliveryTrackers.get(messageId);
      if (tracker === undefined || tracker.deliveryToken !== token) {
        return { found: false };
      }
      const terminal = this.isTerminalDeliveryState(tracker.state);
      return {
        found: true,
        state: tracker.state,
        terminal,
        updatedAt: new Date(tracker.updatedAt).toISOString(),
        deadlineAt: new Date(tracker.deadlineAt).toISOString(),
        ...(!terminal
          ? { pendingForMs: Math.max(0, this.now().getTime() - tracker.enqueuedAt) }
          : {}),
        ...(tracker.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: tracker.safeErrorCode }),
      };
    });
  }

  private async acceptToClaude(params: ValidatedSendToClaudeParams): Promise<GatewaySendResult> {
    return await this.mutex.run("service", async () => {
      let discoveryChanged = false;
      try {
        await this.verifyCodex(params.fromAlias, params.threadId);
        const resolved = await this.resolveSelectedClaudeDestination(
          params.toAlias,
        );
        discoveryChanged = resolved.discoveryChanged;
        return this.acceptedControlResult(await this.enqueue(
          params.fromAlias,
          resolved.alias,
          params.text,
          params.expectsReply,
          false,
        ));
      } catch (error) {
        // A successful enqueue publishes both the discovery and message
        // changes once. If the enqueue fails after discovery succeeded, the
        // dashboard still needs the new peer/route projection.
        if (discoveryChanged) await this.publish();
        return decisionFor(error);
      }
    });
  }

  private async acceptToCodex(params: ValidatedSendToCodexParams): Promise<GatewaySendResult> {
    return await this.mutex.run("service", async () => {
      try {
        await this.verifyClaude(params.fromAlias, params.replyAddress);
        return this.acceptedControlResult(
          await this.enqueue(
            params.fromAlias,
            params.toAlias,
            params.text,
            params.expectsReply,
            false,
          ),
        );
      } catch (error) {
        return decisionFor(error);
      }
    });
  }

  private async acceptReply(params: ReplyParams): Promise<GatewaySendResult> {
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
        return this.acceptedControlResult(result);
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
    exposeDeliveryToken = true,
  ): Promise<EnqueuedMessageResult> {
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
    const enqueuedAt = this.now().getTime();
    const deliveryToken = exposeDeliveryToken
      ? this.reserveDeliveryToken()
      : undefined;
    const deadlineAt = new Date(
      enqueuedAt + this.config.limits.messageDeadlineMs,
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
    this.armDeliveryTracker({
      messageId: queued.messageId,
      conversationId,
      targetAlias,
      enqueuedAt,
      deadlineAt,
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
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
    return {
      conversationId,
      messageId: queued.messageId,
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
    };
  }

  private async enqueueNativeReply(
    conversation: Conversation,
    sourceAlias: string,
    text: string,
    requestedHopCount: number,
    exposeDeliveryToken = true,
  ): Promise<EnqueuedMessageResult> {
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
    const enqueuedAt = this.now().getTime();
    const deliveryToken = exposeDeliveryToken
      ? this.reserveDeliveryToken()
      : undefined;
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
    this.armDeliveryTracker({
      messageId: queued.messageId,
      conversationId: conversation.id,
      targetAlias: capability.sourceAlias,
      enqueuedAt,
      deadlineAt,
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
    });
    this.nativeIngressByConversation.delete(conversation.id);
    await this.changed();
    this.scheduleDispatch(capability.sourceAlias);
    return {
      conversationId: conversation.id,
      messageId: queued.messageId,
      ...(deliveryToken === undefined ? {} : { deliveryToken }),
    };
  }

  private pruneTransient(): void {
    const now = this.now().getTime();
    // Message deadlines are owned by the service lifecycle sweep. Never drop
    // correlation here: doing so previously made store expiry sender-silent.
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
    if (await this.processLifecycleLocked()) {
      await this.changed();
    }
    const item = await this.store.dequeueMessage(targetAlias);
    if (item === undefined) return;
    const context = this.messageContexts.get(item.messageId);
    const selectedBinding = this.routeBindings.get(targetAlias);
    const binding = context?.nativeReplyBinding ?? selectedBinding;
    if (context === undefined) {
      const result = await this.store.settleMessage({
        messageId: item.messageId,
        state: "failed",
        safeErrorCode: "MESSAGE_CONTEXT_UNAVAILABLE",
      });
      if (result.status === "settled") {
        await this.applyTerminalSettlementLocked(result.settlement);
        await this.changed();
      }
      return;
    }
    if (binding === undefined) {
      const result = await this.store.requeueInFlightMessage(
        item.messageId,
        item.body,
      );
      if (result.status === "settled") {
        await this.applyTerminalSettlementLocked(result.settlement);
      }
      await this.changed();
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
        const result = await this.store.requeueInFlightMessage(
          item.messageId,
          item.body,
        );
        if (result.status === "settled") {
          await this.applyTerminalSettlementLocked(result.settlement);
        }
        await this.changed();
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
        if (requeued.status === "requeued") {
          if (context.authorization === "selected_route") {
            this.routeStates.set(currentTargetAlias, "idle");
            await this.store.observeRoute({
              binding,
              state: "idle",
              compatibility: "compatible",
            });
            await this.setNativeCodexStatus(currentTargetAlias, "waiting");
          }
          const retry = this.timers.setTimeout(
            () => this.scheduleDispatch(currentTargetAlias),
            500,
          );
          (retry as { unref?: () => void }).unref?.();
        } else if (requeued.status === "settled") {
          await this.applyTerminalSettlementLocked(requeued.settlement);
        }
        await this.changed();
        return;
      }
      if (result.state === "pending" || result.state === "accepted") {
        await this.drainDeliveryCallbacksForMessageLocked(item.messageId);
        if (await this.processLifecycleLocked()) {
          await this.changed();
        }
        if (!this.messageContexts.has(item.messageId)) {
          this.scheduleDispatch(
            this.bindingAliases.get(bindingKey(binding)) ?? targetAlias,
          );
          return;
        }
        if (
          result.state === "accepted" &&
          (await this.acceptProviderDeliveryLocked(item.messageId))
        ) {
          await this.changed();
        }
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
    const result = await this.store.settleMessage({
      messageId: event.messageId,
      state: event.state,
      ...(event.safeErrorCode === undefined
        ? {}
        : {
            safeErrorCode: safeCode(
              event.safeErrorCode,
              "PROVIDER_DELIVERY_FAILED",
            ),
          }),
    });
    let context: MessageContext | undefined;
    let terminalState: DeliveryTerminalState;
    if (result.status === "settled") {
      terminalState = this.settlementDeliveryState(result.settlement);
      context = await this.applyTerminalSettlementLocked(result.settlement);
    } else {
      const accepted = this.messageContexts.get(event.messageId);
      if (accepted?.providerAccepted !== true) return;
      terminalState = event.state;
      context = this.takeMessageContextLocked(event.messageId, terminalState);
      if (terminalState !== "delivered") {
        this.addRuntimeAlert("PROVIDER_TURN_FAILED_AFTER_ACCEPTANCE", "warning", {
          alias: accepted.targetAlias,
        });
      }
    }
    if (context === undefined) {
      await this.changed();
      return;
    }
    const conversation = this.conversations.get(context.conversationId);
    if (
      !this.closing &&
      terminalState === "delivered" &&
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
            false,
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
            false,
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
      false,
    );
  }

  private async onClaudeMessage(event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    sourceAlias: string;
    targetAlias: string;
    text: string;
    receiptHandle?: string;
  }): Promise<void> {
    if (this.closing) {
      if (event.receiptHandle !== undefined) {
        await this.settleDetachedNativeReceipt(
          event.endpoint.hostId,
          event.receiptHandle,
          "GATEWAY_SHUTDOWN",
        );
      }
      return;
    }
    let acceptedMessageId: string | undefined;
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
      const enqueuedAt = this.now().getTime();
      const deadlineAt = new Date(
        enqueuedAt + this.config.limits.messageDeadlineMs,
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
      acceptedMessageId = queued.messageId;
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
      this.armDeliveryTracker({
        messageId: queued.messageId,
        conversationId,
        targetAlias: event.targetAlias,
        enqueuedAt,
        deadlineAt,
      });
      this.nativeIngressByConversation.set(conversationId, {
        sourceAlias: event.sourceAlias,
        binding: sourceBinding,
        deadlineAt,
      });
      if (event.receiptHandle !== undefined) {
        const tracker = this.deliveryTrackers.get(queued.messageId);
        if (tracker === undefined) {
          throw new BridgeError(
            "DELIVERY_TRACKER_MISSING",
            "The accepted native message lost its delivery tracker.",
          );
        }
        tracker.nativeReceipt = {
          hostId: event.endpoint.hostId,
          receiptHandle: event.receiptHandle,
        };
      }
      await this.changed();
      await this.setNativeCodexStatus(event.targetAlias, "waiting");
      this.scheduleDispatch(event.targetAlias);
    } catch (error) {
      const code = safeCode(
        error instanceof BridgeError ? error.code : undefined,
        "NATIVE_INGRESS_REJECTED",
      );
      if (acceptedMessageId !== undefined) {
        const cancelled = await this.store.cancelQueuedMessage(
          acceptedMessageId,
        );
        if (cancelled) {
          await this.applyTerminalSettlementLocked({
            messageId: acceptedMessageId,
            state: "expired",
            safeErrorCode: code,
          });
          await this.changed();
        }
        return;
      }
      if (event.receiptHandle !== undefined) {
        this.rejectDetachedNativeReceipt(
          event.endpoint.hostId,
          event.receiptHandle,
          code,
        );
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

  private rejectDetachedNativeReceipt(
    hostId: string,
    receiptHandle: string,
    diagnosticCode: string,
  ): void {
    const work = this.settleDetachedNativeReceipt(
      hostId,
      receiptHandle,
      diagnosticCode,
    ).finally(() => {
      this.detachedReceiptWrites.delete(work);
    });
    this.detachedReceiptWrites.add(work);
  }

  private async drainDetachedReceiptWritesLocked(): Promise<void> {
    while (this.detachedReceiptWrites.size > 0) {
      await Promise.allSettled([...this.detachedReceiptWrites]);
    }
  }

  private async settleDetachedNativeReceipt(
    hostId: string,
    receiptHandle: string,
    diagnosticCode: string,
  ): Promise<void> {
    try {
      const adapter = this.adapter("claude", hostId);
      const update = adapter.updateNativeInboundStatus;
      if (update === undefined) {
        throw new BridgeError(
          "NATIVE_RECEIPT_TRANSPORT_UNAVAILABLE",
          "The Claude adapter cannot settle a native receipt.",
        );
      }
      await update.call(
        adapter,
        receiptHandle,
        "expired",
        safeCode(diagnosticCode, "NATIVE_INGRESS_REJECTED"),
      );
    } catch {
      try {
        await this.adapter("claude", hostId)
          .releaseNativeInboundReceipt?.(receiptHandle);
      } catch {
        // The capability remains owned by the listener only until its bounded
        // process lifetime. Never retry an outcome-ambiguous status write.
      }
      this.addRuntimeAlert("NATIVE_RECEIPT_UNCONFIRMED", "warning", {
        provider: "claude",
        host: hostId,
      });
      this.dashboardHealthy = false;
    }
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
    this.scheduleLifecycleWakeLocked();
    await this.publish();
  }

  private async publicSnapshotLocked(): Promise<GatewayPublicSnapshot> {
    const base = await this.store.publicSnapshot();
    const peers = this.availablePeers.map((peer) => ({ ...peer }));
    if (!arePublicAvailablePeerSnapshots(peers)) {
      throw new BridgeError(
        "INVALID_TRANSIENT_INVENTORY",
        "The transient peer inventory is unsafe.",
      );
    }
    const now = this.now().getTime();
    const stalledAlerts: SafeGatewayAlert[] = base.routes.flatMap((route) => {
      const oldest =
        route.oldestQueuedAt === undefined
          ? Number.NaN
          : Date.parse(route.oldestQueuedAt);
      if (
        !Number.isFinite(oldest) ||
        oldest > now ||
        now - oldest < this.config.stallNoticeMs
      ) {
        return [];
      }
      return [
        {
          code: "QUEUE_STALLED",
          severity: "warning" as const,
          timestamp: route.oldestQueuedAt ?? base.generatedAt,
          provider: route.provider,
          host: route.host,
          alias: route.alias,
        },
      ];
    });
    return projectGatewayPublicSnapshot({
      ...base,
      availablePeers: peers,
      alerts: [
        ...base.alerts,
        ...this.runtimeAlerts.map((alert) => ({ ...alert })),
        ...stalledAlerts,
      ],
    });
  }

  private async publish(): Promise<void> {
    try {
      const snapshot = await this.publicSnapshotLocked();
      await this.publishDashboard(this.store.rootDir, snapshot);
      this.dashboardHealthy = true;
    } catch {
      this.dashboardHealthy = false;
    }
  }
}
