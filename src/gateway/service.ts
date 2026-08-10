import { createHash, randomBytes } from "node:crypto";

import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import type { GatewayConfig } from "./config.js";
import {
  certifiedCompatibilityVersions,
  compatibilitySurfaces,
  evaluateCompatibilityAttestation,
  isCompatibilityAttestation,
  type CompatibilityAttestation,
  type CompatibilityProbeResult,
  type CompatibilitySurfaceObservation,
} from "./compatibility.js";
import {
  createGatewayConversationId,
  isGatewaySnapshot,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewayDeliveryStatusResult,
  type GatewayControlServer,
  type GatewayDecision,
  type GatewayReplyCaller,
  type GatewaySendResult,
  type GatewaySnapshotObservation,
  type PairParams,
  type ReplyParams,
  type SelectClaudeParams,
  type UnregisterCodexParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendToClaudeParams,
  type ValidatedSendToCodexParams,
} from "./control.js";
import { publishGatewayDashboard } from "./dashboard.js";
import {
  createDeliveryMachine,
  isTerminalDeliveryMachine,
  projectDelivery,
  projectDeliveryWakeups,
  transitionDelivery,
  type DeliveryEffect,
  type DeliveryEvent,
  type DeliveryMachine,
  type DeliveryTerminalOutcome,
  type NativeReceiptNotification,
} from "./delivery-machine.js";
import {
  createCodexRegistrationSuccession,
  transitionCodexRegistrationSuccession,
  type CodexRegistrationIdentity,
  type CodexRegistrationSuccessionEffect,
  type CodexRegistrationSuccessionEvent,
  type CodexRegistrationSuccessionState,
  type CodexSuccessionFailurePhase,
} from "./codex-registration-succession.js";
import {
  createCodexRegistrationGeneration,
  isCodexRegistrationGeneration,
} from "./codex-registration-generation.js";
import { PROGRESS_WATCH_DEFAULT_IDLE_MS } from "./progress-watch-machine.js";
import {
  GatewayStore,
  type CodexSuccessionRecoveryAuthority,
  type CodexSuccessionStoreIdentity,
  type RouteInFlightSettlementInput,
} from "./store.js";
import {
  GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  arePublicAvailablePeerSnapshots,
  projectGatewayPublicSnapshot,
  type CompatibilityState,
  type EnqueueMessageInput,
  type GatewayPrivateRouteInspection,
  type GatewayPublicSnapshot,
  type GatewayActivityAction,
  type GatewayActivityKind,
  type PrivateEndpointIdentity,
  type PrivateRouteBinding,
  type PublicAvailablePeerSnapshot,
  type PublicGatewayActivityEvent,
  type RouteState,
  type SafeGatewayAlert,
  type TerminalMessageSettlement,
  type TransientQueuedMessage,
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
const NATIVE_HELD_THRESHOLD_MS = 1_000;
const RUNTIME_ACTIVITY_CAPACITY = 256;
const DELIVERY_SETTLEMENT_RETRY_MS = 250;
const DELIVERY_DASHBOARD_REFRESH_MS = 15_000;
const CLAUDE_CLEAN_PREWRITE_ROUTE_CODES = new Set([
  "CLAUDE_PEER_TARGET_UNKNOWN",
  "CLAUDE_PEER_TARGET_STALE",
  "CLAUDE_PEER_TARGET_CHANGED",
  "CLAUDE_PEER_WORKSPACE_UNATTESTED",
]);

function progressWatchActivity(
  text: string,
  conversationId: string,
  actorAlias: string,
  explicitIdleMinutes?: number,
): NonNullable<EnqueueMessageInput["progressWatch"]> {
  const prefixedOpen = text.startsWith("TRACK:");
  const completionSignal = text.startsWith("DONE:");
  if (completionSignal && (prefixedOpen || explicitIdleMinutes !== undefined)) {
    throw new BridgeError(
      "PROGRESS_WATCH_SIGNAL_CONFLICT",
      "A single message cannot both open and complete a progress watch.",
    );
  }
  const openIdleMs =
    explicitIdleMinutes === undefined
      ? prefixedOpen
        ? PROGRESS_WATCH_DEFAULT_IDLE_MS
        : undefined
      : explicitIdleMinutes * 60_000;
  return {
    conversationId,
    actorAlias,
    ...(openIdleMs === undefined ? {} : { openIdleMs }),
    ...(completionSignal ? { completionSignal: true as const } : {}),
  };
}

export type GatewayAdapterRouteState = Extract<
  RouteState,
  "idle" | "busy" | "awaiting_approval"
>;

export type GatewayAdapterRouteObservationState =
  | GatewayAdapterRouteState
  | "stale";

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
  | "transport_uncertain"
  | "transport_written"
  | "held"
  | "released"
  | "unconfirmed"
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

/**
 * One provider-wide Codex endpoint transition. Native thread and generation
 * identifiers stay inside this controller boundary and are never projected.
 */
export type GatewayAdapterEndpointRefresh =
  | Readonly<{
      outcome: "compatible";
      previous: PrivateEndpointIdentity;
      current: PrivateEndpointIdentity;
      attestation: CompatibilityAttestation;
      routes: readonly Readonly<{
        routeHandle: string;
        state: GatewayAdapterRouteState;
      }>[];
    }>
  | Readonly<{
      outcome: "incompatible";
      previous: PrivateEndpointIdentity;
      candidate: PrivateEndpointIdentity;
      attestation: CompatibilityAttestation;
    }>;

export type GatewayAdapterCallbacks = {
  onDelivery: (event: GatewayAdapterDelivery) => void;
  onRouteState: (event: {
    endpoint: PrivateEndpointIdentity & { routeHandle: string };
    state: GatewayAdapterRouteObservationState;
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
  /** Bounded provider protocol diagnostics; never includes raw frame data. */
  onProtocolNotice?: (event: { code: string }) => void;
  /** Provider-wide, compatibility-gated Codex endpoint replacement. */
  onEndpointRefresh?: (event: GatewayAdapterEndpointRefresh) => void;
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
 * One transient, service-authorized provider dispatch. Provenance fields are
 * carried beside the raw body so the provider can frame it exactly once at
 * its semantic write boundary. They must not be projected or persisted.
 */
export type GatewayAdapterDispatchInput = {
  sourceAlias: string;
  targetAlias: string;
  conversationId: string;
  binding: PrivateRouteBinding;
  authorization: "selected_route" | "native_reply";
  messageId: string;
  text: string;
  expectsReply: boolean;
  deadlineAt: string;
  steer?: true;
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
  /** Version identity is cheap; bounded probes run fresh on every startup. */
  compatibilitySurface?(): CompatibilitySurfaceObservation;
  runCompatibilityProbes?(): Promise<readonly CompatibilityProbeResult[]>;
  acceptCompatibilityAttestation?(
    attestation: CompatibilityAttestation,
  ): void;
  initialize(callbacks: GatewayAdapterCallbacks): Promise<GatewayAdapterStart>;
  discoverClaudePeers?(): Promise<GatewayAdapterDiscoverySnapshot>;
  selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{
    routeHandle: string;
    state: GatewayAdapterRouteState;
    endpointRefresh?: GatewayAdapterEndpointRefresh;
  }>;
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
        | "CODEX_ROUTE_STALE"
        | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    },
  ): Promise<void>;
  releaseNativeInboundReceipt?(
    receiptHandle: string,
  ): boolean | Promise<boolean>;
  /** Fence new native ingress while keeping receipt writes available. */
  quiesceNativeInbound?(): Promise<void>;
  /** Claude-only exact listener-generation succession controls. */
  currentNativeCodexPeerGeneration?(alias: string): string;
  prepareNativeCodexPeerGeneration?(input: {
    alias: string;
    cwd: string;
    generation: string;
    currentGeneration?: string;
  }): Promise<void>;
  quiesceNativeCodexPeerGeneration?(generation: string): Promise<void>;
  observeNativeCodexSuccessionBarrier?(generation: string): Readonly<{
    generation: string;
    activeGenerationMatched: boolean;
    ingressQuiesced: boolean;
    monitorFrozen: boolean;
    discoveryInFlight: boolean;
    pendingOutboundReceipts: number;
    pendingInboundReceipts: number;
    rejectedInboundSettlements: number;
    clean: boolean;
  }> | Promise<Readonly<{
    generation: string;
    activeGenerationMatched: boolean;
    ingressQuiesced: boolean;
    monitorFrozen: boolean;
    discoveryInFlight: boolean;
    pendingOutboundReceipts: number;
    pendingInboundReceipts: number;
    rejectedInboundSettlements: number;
    clean: boolean;
  }>>;
  publishPreparedNativeCodexPeer?(input: {
    currentGeneration: string;
    preparedGeneration: string;
  }): Promise<"published" | "not_published" | "unknown">;
  activatePreparedNativeCodexPeerGeneration?(generation: string): void | Promise<void>;
  cleanupPreparedNativeCodexPeerGeneration?(generation: string): Promise<void>;
  resumeNativeCodexPeerGeneration?(generation: string): void | Promise<void>;
  rollbackPreparedNativeCodexPeerGeneration?(input: {
    preparedGeneration: string;
    resumeGeneration: string;
  }): Promise<void>;
  retireNativeCodexPeerGeneration?(input: {
    retiredGeneration: string;
    protectedActiveGeneration: string;
  }): Promise<void>;
  purgeNativeCodexPeerGenerationReplyCapabilities?(generation: string): number | Promise<number>;
  /** Codex-only private provider-work barrier for one exact task route. */
  observeRouteSuccessionBarrier?(routeHandle: string): Readonly<{
    routePresent: boolean;
    connection: string;
    routeStatus: string;
    queueDepth: number;
    hasActiveTurn: boolean;
    requestInFlight: boolean;
    routeCreationInFlight: boolean;
    routeReleaseInFlight: boolean;
    pendingReplyCorrelations: number;
    pendingCallbacks: number;
    clean: boolean;
  }>;
  dispatch(input: GatewayAdapterDispatchInput): Promise<GatewayAdapterDispatchResult>;
  releaseRoute?(routeHandle: string): Promise<void>;
  close(): Promise<void>;
}

type Conversation = {
  id: string;
  sourceAlias: string;
  targetAlias: string;
  expectsReply: boolean;
  nextSequence: number;
  lastActivityAt: string;
  /** Conversation authority originated from one exact durable pair. */
  pair?: true;
};

type MessageContext = {
  conversationId: string;
  expectsReply: boolean;
  sequence: number;
  targetBindingKey: string;
  nativeReplyBinding?: PrivateRouteBinding;
  authorization: "selected_route" | "native_reply";
  targetAlias: string;
  deadlineAt: string;
  /** Rebuilt with a fresh conversation capability for durable queued mail. */
  recovered?: true;
};

type DeliveryTerminalState =
  | "delivered"
  | "unconfirmed"
  | "expired"
  | "failed"
  | "ambiguous"
  | "cancelled";

type NativeReceiptTracker = {
  hostId: string;
  receiptHandle: string;
};

type MessageDeliveryTracker = {
  messageId: string;
  conversationId: string;
  targetAlias: string;
  enqueuedAt: number;
  deadlineAt: number;
  machine: DeliveryMachine;
  updatedAt: number;
  deliverySafeErrorCode?: string;
  /** Retains an observed terminal decision until its atomic ledger write wins. */
  pendingTerminalEvent?: DeliveryEvent;
  pendingTerminalReplyText?: string;
  settlementRetryAt?: number;
  stallNoticeSent: boolean;
  stallNoticeAttempt: number;
  stallNoticeNextAttemptAt: number;
  nativeHeldSent: boolean;
  nativeHeldAttempt: number;
  nativeHeldNextAttemptAt: number;
  deliveryToken?: string;
  nativeReceipt?: NativeReceiptTracker;
};

/**
 * A provider turn may outlive terminal delivery of its original body. This
 * map retains only bounded correlation needed for a later final result/reply;
 * it is deliberately separate from the once-settled delivery machine.
 */
type ProviderTurnContinuation = MessageContext;

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
        state: GatewayAdapterRouteObservationState;
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
    }
  | {
      type: "protocol_notice";
      source: PrivateEndpointIdentity;
      value: { code: string };
    }
  | {
      type: "endpoint_refresh";
      adapter: GatewayProviderAdapter;
      value: GatewayAdapterEndpointRefresh;
    };

type EndpointRefreshCallback = Extract<
  CallbackEvent,
  { type: "endpoint_refresh" }
>;

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
  /** Test seam for opaque listener generations; production remains random. */
  successionGeneration?: () => string;
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

function endpointRefreshCallbackKey(
  event: GatewayAdapterEndpointRefresh,
): string {
  const attestation = {
    schemaVersion: event.attestation.schemaVersion,
    surface: event.attestation.surface,
    version: event.attestation.version,
    tier: event.attestation.tier,
    checkedAt: event.attestation.checkedAt,
    probes: event.attestation.probes.map((probe) => ({
      name: probe.name,
      outcome: probe.outcome,
      ...(probe.safeErrorCode === undefined
        ? {}
        : { safeErrorCode: probe.safeErrorCode }),
    })),
    ...(event.attestation.safeErrorCode === undefined
      ? {}
      : { safeErrorCode: event.attestation.safeErrorCode }),
  };
  return event.outcome === "compatible"
    ? JSON.stringify({
        outcome: event.outcome,
        previous: event.previous,
        current: event.current,
        attestation,
        routes: [...event.routes]
          .map((route) => ({ ...route }))
          .sort((left, right) =>
            left.routeHandle.localeCompare(right.routeHandle),
          ),
      })
    : JSON.stringify({
        outcome: event.outcome,
        previous: event.previous,
        candidate: event.candidate,
        attestation,
      });
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
  generation: string;
}>;

type PendingCodexSuccessionRecovery = Extract<
  CodexSuccessionRecoveryAuthority,
  { journal: unknown }
> & { authority: "new" };

type CodexSuccessionExecution = {
  state: CodexRegistrationSuccessionState;
  readonly oldRegistration: CodexRegistrationIdentity;
  readonly newRegistration: CodexRegistrationIdentity;
  readonly oldBinding: PrivateRouteBinding;
  readonly newBinding: PrivateRouteBinding;
  newRouteState?: GatewayAdapterRouteState;
  newCodexSelected: boolean;
  newListenerPrepared: boolean;
  newListenerActivated: boolean;
  storePrepared: boolean;
  publicationAbsenceConfirmed: boolean;
  poisonCleanupReady: boolean;
  storePrepareOutcomeUnproven: boolean;
  requestFailureCode?: string;
  recoveryFailed: boolean;
};

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
  private readonly successionGeneration: () => string;
  private readonly mutex = new KeyedMutex();
  private readonly routeBindings = new Map<string, PrivateRouteBinding>();
  private readonly routeStates = new Map<
    string,
    GatewayAdapterRouteObservationState
  >();
  private readonly bindingAliases = new Map<string, string>();
  private readonly candidates = new Map<string, Candidate>();
  private availablePeers: PublicAvailablePeerSnapshot[] = [];
  private readonly conversations = new Map<string, Conversation>();
  private readonly messageContexts = new Map<string, MessageContext>();
  private readonly providerTurnContinuations = new Map<
    string,
    ProviderTurnContinuation
  >();
  private readonly activeDispatchByTarget = new Map<string, string>();
  private readonly scheduledDispatchTargets = new Set<string>();
  private readonly dispatchRunnerTargets = new Set<string>();
  /** Claude sends that proved no write wait for exact provider-idle evidence. */
  private readonly claudePrewriteIdleWaitTargets = new Set<string>();
  private readonly heldRedispatchTimers = new Map<
    string,
    GatewayServiceTimer
  >();
  private readonly pendingClaudeReplies = new Map<string, PendingClaudeReply>();
  private readonly deliveryTrackers = new Map<string, MessageDeliveryTracker>();
  private readonly deliveryTokens = new Map<string, string>();
  private readonly runtimeAlerts: SafeGatewayAlert[] = [];
  private readonly activityEvents: PublicGatewayActivityEvent[] = [];
  private activeCodexIncompatibility: CompatibilityAttestation | undefined;
  private activitySequence = 0;
  private readonly detachedReceiptWrites = new Set<Promise<void>>();
  private readonly nativeIngressByConversation = new Map<
    string,
    NativeIngressCapability
  >();
  private readonly callbackQueue: CallbackEvent[] = [];
  /**
   * Endpoint replacement is authority-bearing lifecycle evidence, not an
   * ordinary refreshable observation. Keep one coalesced slot outside the
   * bounded callback queue so delivery evidence can never displace it (or be
   * displaced by it).
   */
  private endpointRefreshCallback: EndpointRefreshCallback | undefined;
  private activeEndpointRefreshCallback: EndpointRefreshCallback | undefined;
  private endpointRefreshRetryRequested: EndpointRefreshCallback | undefined;
  private endpointRefreshConflictBoundary: EndpointRefreshCallback | undefined;
  private activeEndpointRefreshCallbackKey: string | undefined;
  private endpointRefreshCallbackPoisoned = false;
  private endpointRefreshConflictPending = false;
  /** Last successfully activated transition per allowed Codex host. */
  private readonly activatedEndpointRefreshes = new Map<string, string>();
  /** Durable reanchors awaiting their exact native-listener activation. */
  private readonly durablyAppliedEndpointRefreshes = new Map<string, string>();
  /** Selector transitions staged until their exact registration owns a helper. */
  private readonly pendingSelectorEndpointActivations = new Map<
    string,
    {
      transitionKey: string;
      route: {
        alias: string;
        threadId: string;
        state: GatewayAdapterRouteState;
      };
    }
  >();
  /** Last incompatible transition already projected per allowed Codex host. */
  private readonly handledIncompatibleEndpointRefreshes = new Map<
    string,
    string
  >();
  /** Process-local dedupe for automatic public activity rows across retries. */
  private readonly endpointRefreshActivityKeys = new Set<string>();
  private callbackWorker: Promise<void> | undefined;
  private callbackScheduled = false;
  private readonly callbackCapacity: number;
  private readonly deliveryCallbackReserve: number;
  private readonly deliveryTokenCapacity: number;
  private lifecycleTimer: GatewayServiceTimer | undefined;
  private nextDashboardRefreshAt: number | undefined;
  private nextProgressWatchAt: number | undefined;
  private control: GatewayControlServer | undefined;
  /** Coarse controller mutation revision exposed by `health`. */
  private revision = 0;
  /**
   * Process-local semantic public-snapshot clock. The first observation
   * establishes revision zero; a new GatewayService process resets it.
   */
  private snapshotRevision = 0;
  private snapshotFingerprint: string | undefined;
  private running = false;
  private closing = false;
  private closeInFlight: Promise<void> | undefined;
  private acceptingCallbacks = true;
  private dashboardHealthy = true;
  /** Route-scoped fences; unrelated Codex registrations remain dispatchable. */
  private readonly codexSuccessionDispatchFrozen = new Set<string>();
  private readonly codexSuccessionPoisoned = new Set<string>();
  /**
   * Exact stale authority whose process-owned native advertisement was already
   * removed, but whose durable orphan deletion did not commit. Keep dispatch
   * frozen and permit only the same exact cleanup transaction to retry.
   */
  private readonly codexOrphanCleanupPending = new Map<
    string,
    { binding: PrivateRouteBinding; previousSequence: number }
  >();
  private codexSuccessionState: CodexRegistrationSuccessionState | undefined;
  private pendingCodexSuccessionRecovery:
    | PendingCodexSuccessionRecovery
    | undefined;
  /**
   * Exact active identity. It changes only through the journaled succession
   * machine; ordinary unregister/register cannot repurpose one listener.
   */
  private readonly codexRegistrationLocks = new Map<
    string,
    CodexRegistrationLock
  >();

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
    this.successionGeneration =
      options.successionGeneration ??
      createCodexRegistrationGeneration;
    this.callbackCapacity = Math.max(
      64,
      options.config.limits.maxRoutes +
        options.config.limits.maxInFlightMessages * 8,
    );
    // A callback flood must never crowd out write evidence. One selected route
    // may retain one accepted provider continuation, while each store-owned
    // in-flight message may contribute uncertain/written/held plus one first
    // terminal observation. Other callback kinds use only the remaining slots.
    this.deliveryCallbackReserve = Math.min(
      this.callbackCapacity,
      options.config.limits.maxRoutes +
        options.config.limits.maxInFlightMessages * 4,
    );
    this.deliveryTokenCapacity = Math.max(
      64,
      options.config.limits.maxQueueMessages * 4,
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running || this.closing) return;
    let bootReactivatedIdleAliases: string[] = [];
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
    // Keep additive state migrations and startup observations in memory until
    // every provider admission check and the private control-socket bind have
    // succeeded. A failed upgrade must leave the prior on-disk schema usable
    // by the previous binary.
    await this.store.initialize({ deferPersistence: true });
    try {
      assertStartActive();
      const seen = new Set<string>();
      for (const adapter of this.adapters) {
        const key = `${adapter.identity.provider}@${adapter.identity.hostId}`;
        if (seen.has(key) || !this.config.allowedHosts.includes(adapter.identity.hostId)) {
          throw new BridgeError("GATEWAY_ADAPTER_NOT_ALLOWED", "A provider adapter is duplicated or outside the host allowlist.");
        }
        seen.add(key);
        const observation = await adapter.initialize(this.callbacksFor(adapter));
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
      if (
        this.adapters.length > 0 &&
        this.adapters.every(
          (adapter) =>
            adapter.compatibilitySurface !== undefined &&
            adapter.runCompatibilityProbes !== undefined,
        )
      ) {
        const attestations =
          await this.runAutomaticCompatibilityProbesLocked();
        const incompatible = attestations.find(
          (surface) => surface.tier === "incompatible",
        );
        if (incompatible !== undefined) {
          throw new BridgeError(
            incompatible.safeErrorCode ?? "COMPATIBILITY_CHECK_FAILED",
            "A local provider failed bounded compatibility attestation.",
          );
        }
      }
      await this.recoverCodexSuccessionAfterRestartLocked();
      bootReactivatedIdleAliases =
        await this.reactivateRetainedCodexRoutesAfterRestartLocked();
      assertStartActive();
      const control = await startGatewayControlServer({
        stateDir: this.store.rootDir,
        socketPath: this.config.controlSocketPath,
        handlers: this.handlers(),
      });
      try {
        assertStartActive();
        await this.store.commitInitialization();
        assertStartActive();
      } catch (error) {
        await control.close();
        throw error;
      }
      this.control = control;
      this.running = true;
      this.nextDashboardRefreshAt = undefined;
      await this.refreshNextProgressWatchWakeLocked();
      this.scheduleLifecycleWakeLocked();
      for (const alias of bootReactivatedIdleAliases) {
        this.scheduleDispatch(alias);
      }
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
        for (const messageId of [...this.providerTurnContinuations.keys()]) {
          await this.finishProviderTurnContinuationLocked(
            messageId,
            "cancelled",
          );
        }
        const retainedQueuedMessageIds = new Set(
          await this.store.inspectQueuedMessageIds(),
        );
        for (const messageId of [...this.messageContexts.keys()]) {
          if (retainedQueuedMessageIds.has(messageId)) continue;
          const queued = await this.store.settleQueuedMessage({
            messageId,
            state: "cancelled",
            safeErrorCode: "GATEWAY_SHUTDOWN",
          });
          if (queued.status === "settled") {
            await this.applyTerminalSettlementLocked(queued.settlement);
            continue;
          }
          await this.advanceDeliveryLocked(messageId, {
            type: "shutdown",
            at: this.now().getTime(),
          });
        }
        for (const tracker of this.deliveryTrackers.values()) {
          if (retainedQueuedMessageIds.has(tracker.messageId)) continue;
          if (!isTerminalDeliveryMachine(tracker.machine)) {
            await this.advanceDeliveryLocked(tracker.messageId, {
              type: "shutdown",
              at: this.now().getTime(),
            });
          }
          for (
            let attempt = 0;
            attempt <= DELIVERY_ACK_RETRY_DELAYS_MS.length &&
            tracker.nativeReceipt !== undefined &&
            (tracker.machine.nativeReceipt.phase === "sending" ||
              tracker.machine.nativeReceipt.phase === "retry_wait");
            attempt += 1
          ) {
            const native = tracker.machine.nativeReceipt;
            if (native.phase === "retry_wait") {
              await this.advanceDeliveryLocked(tracker.messageId, {
                type: "native_receipt_retry_due",
                at: native.retryAt,
              });
            } else {
              await this.sendNativeReceiptLocked(tracker);
            }
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
        this.providerTurnContinuations.clear();
        this.activeDispatchByTarget.clear();
        this.scheduledDispatchTargets.clear();
        this.dispatchRunnerTargets.clear();
        this.claudePrewriteIdleWaitTargets.clear();
        for (const timer of this.heldRedispatchTimers.values()) {
          this.timers.clearTimeout(timer);
        }
        this.heldRedispatchTimers.clear();
        this.pendingClaudeReplies.clear();
        this.deliveryTrackers.clear();
        this.deliveryTokens.clear();
        this.runtimeAlerts.length = 0;
        this.detachedReceiptWrites.clear();
        this.nativeIngressByConversation.clear();
        this.callbackQueue.length = 0;
        this.endpointRefreshCallback = undefined;
        this.activeEndpointRefreshCallback = undefined;
        this.endpointRefreshRetryRequested = undefined;
        this.endpointRefreshConflictBoundary = undefined;
        this.activeEndpointRefreshCallbackKey = undefined;
        this.endpointRefreshConflictPending = false;
        this.endpointRefreshCallbackPoisoned = true;
        this.activatedEndpointRefreshes.clear();
        this.durablyAppliedEndpointRefreshes.clear();
        this.pendingSelectorEndpointActivations.clear();
        this.handledIncompatibleEndpointRefreshes.clear();
        this.endpointRefreshActivityKeys.clear();
        this.codexOrphanCleanupPending.clear();
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
        await this.exclusiveDecision(
          async () => this.registerCodex(params),
          {
            kind: "registration",
            action:
              params.succeedsAlias === undefined
                ? "codex_registered"
                : "codex_succeeded",
            aliases: [
              ...(params.succeedsAlias === undefined
                ? []
                : [params.succeedsAlias]),
              params.alias,
            ],
          },
        ),
      unregisterCodex: async (params) =>
        await this.exclusiveDecision(
          async () => this.unregisterCodex(params),
          {
            kind: "registration",
            action: "codex_unregistered",
            aliases: [params.alias],
          },
        ),
      removeStaleCodexRegistration: async (params) =>
        await this.exclusiveDecision(
          async () => this.removeStaleCodexRegistration(params.alias),
          {
            kind: "recovery",
            action: "codex_orphan_removed",
            aliases: [params.alias],
          },
        ),
      selectClaude: async (params) =>
        await this.exclusiveDecision(
          async () => this.selectClaude(params),
          {
            kind: "selection",
            action: "claude_selected",
            aliases: PUBLIC_ALIAS.test(params.alias) ? [params.alias] : [],
          },
        ),
      unselectClaude: async (params) =>
        await this.exclusiveDecision(
          async () => this.unselectClaude(params),
          {
            kind: "selection",
            action: "claude_unselected",
            aliases: PUBLIC_ALIAS.test(params.alias) ? [params.alias] : [],
          },
        ),
      pair: async (params) =>
        await this.exclusiveDecision(
          async () => this.pairRoutes(params),
          {
            kind: "pairing",
            action: "routes_paired",
            aliases: [params.claudeAlias, params.codexAlias],
          },
        ),
      unpair: async (params) =>
        await this.exclusiveDecision(
          async () => this.unpairRoutes(params),
          {
            kind: "pairing",
            action: "routes_unpaired",
            aliases: [params.claudeAlias, params.codexAlias],
          },
        ),
      listSnapshot: async () => (await this.observeSnapshot()).snapshot,
      observeSnapshot: async () => await this.observeSnapshot(),
      deliveryStatus: async (params) => await this.deliveryStatus(params.token),
      untrack: async (params) =>
        await this.exclusiveDecision(
          async () => {
            const settled = await this.store.settleProgressWatch({
              conversationId: params.conversationId,
              outcome: "done",
            });
            if (!settled) {
              throw new BridgeError(
                "PROGRESS_WATCH_NOT_FOUND",
                "No active progress watch matches that conversation token.",
              );
            }
            await this.changed();
          },
          { kind: "watch", action: "watch_ended", aliases: [] },
        ),
      sendToClaude: async (params) => await this.acceptToClaude(params),
      sendToCodex: async (params) => await this.acceptToCodex(params),
      reply: async (params) => await this.acceptReply(params),
      refreshDashboard: async () => {
        const result = await this.exclusiveDecision(
          async () => {
            await this.refreshClaudeDiscovery();
            await this.publish();
          },
          {
            kind: "discovery",
            action: "discovery_refreshed",
            aliases: [],
          },
        );
        return { ...result, revision: this.revision };
      },
    };
  }

  async snapshot(): Promise<GatewayPublicSnapshot> {
    return (await this.observeSnapshot()).snapshot;
  }

  private async runAutomaticCompatibilityProbesLocked(): Promise<
    readonly CompatibilityAttestation[]
  > {
    const bySurface = new Map(
      this.adapters.map((adapter) => {
        if (
          adapter.compatibilitySurface === undefined ||
          adapter.runCompatibilityProbes === undefined
        ) {
          throw new BridgeError(
            "COMPAT_PROVIDER_UNAVAILABLE",
            "Every local provider must expose the bounded compatibility probe contract.",
          );
        }
        const observation = adapter.compatibilitySurface();
        return [observation.surface, { adapter, observation }] as const;
      }),
    );
    if (
      bySurface.size !== compatibilitySurfaces.length ||
      compatibilitySurfaces.some((surface) => !bySurface.has(surface))
    ) {
      throw new BridgeError(
        "COMPAT_PROVIDER_UNAVAILABLE",
        "The bounded compatibility probe requires one Claude and one Codex surface.",
      );
    }

    const attestations: CompatibilityAttestation[] = [];
    for (const surface of compatibilitySurfaces) {
      const entry = bySurface.get(surface);
      if (entry === undefined) {
        throw new BridgeError(
          "COMPAT_PROVIDER_UNAVAILABLE",
          "A required compatibility surface is unavailable.",
        );
      }
      const probes = await entry.adapter.runCompatibilityProbes!();
      const attestation = evaluateCompatibilityAttestation({
        surface,
        version: entry.observation.version,
        checkedAt: this.now().toISOString(),
        certifiedVersions: certifiedCompatibilityVersions[surface],
        probes,
      });
      await this.store.recordCompatibilityAttestation(attestation);
      if (attestation.tier !== "incompatible") {
        entry.adapter.acceptCompatibilityAttestation?.(attestation);
      }
      attestations.push(attestation);
    }
    return attestations;
  }

  async observeSnapshot(): Promise<GatewaySnapshotObservation> {
    return await this.mutex.run("service", async () => {
      const changed = await this.processLifecycleLocked();
      if (changed) {
        this.revision += 1;
      }
      const snapshot = await this.publicSnapshotLocked();
      if (!isGatewaySnapshot(snapshot)) {
        throw new BridgeError(
          "INVALID_PUBLIC_SNAPSHOT",
          "The gateway public snapshot failed its closed-schema validation.",
        );
      }
      const fingerprint = this.fingerprintSnapshot(snapshot);
      if (this.snapshotFingerprint === undefined) {
        this.snapshotFingerprint = fingerprint;
      } else if (this.snapshotFingerprint !== fingerprint) {
        if (this.snapshotRevision >= Number.MAX_SAFE_INTEGER) {
          throw new BridgeError(
            "SNAPSHOT_REVISION_EXHAUSTED",
            "The process-local public snapshot revision is exhausted.",
          );
        }
        this.snapshotFingerprint = fingerprint;
        this.snapshotRevision += 1;
      }
      if (changed) await this.publish(snapshot);
      return {
        snapshotRevision: this.snapshotRevision,
        snapshot,
      };
    });
  }

  private fingerprintSnapshot(snapshot: GatewayPublicSnapshot): string {
    // Closed snapshot validation bounds every array and field before this
    // serialization. Omitting generatedAt is the sole semantic exception.
    const { generatedAt: _generatedAt, ...semanticSnapshot } = snapshot;
    const encoded = JSON.stringify(
      semanticSnapshot satisfies Omit<GatewayPublicSnapshot, "generatedAt">,
    );
    if (
      Buffer.byteLength(encoded, "utf8") >
      GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET
    ) {
      throw new BridgeError(
        "PUBLIC_SNAPSHOT_FINGERPRINT_TOO_LARGE",
        "The gateway public snapshot exceeds the semantic fingerprint budget.",
      );
    }
    return createHash("sha256").update(encoded, "utf8").digest("base64url");
  }

  private callbacksFor(adapter: GatewayProviderAdapter): GatewayAdapterCallbacks {
    return {
      onDelivery: (event) => {
        const source = adapter.identity;
        if (
          !this.running ||
          !MESSAGE_ID.test(event.messageId) ||
          this.deliveryCorrelation(event.messageId) === undefined ||
          (event.safeErrorCode !== undefined && !SAFE_CODE.test(event.safeErrorCode)) ||
          (event.replyText !== undefined &&
            (event.replyText.length === 0 ||
              Buffer.byteLength(event.replyText, "utf8") >
                this.config.limits.maxMessageBytes))
        ) {
          return;
        }
        const context = this.deliveryCorrelation(event.messageId);
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
          const source = adapter.identity;
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
        const source = adapter.identity;
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
        const source = adapter.identity;
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
      onProtocolNotice: (event) => {
        const source = adapter.identity;
        if (!this.running || !SAFE_CODE.test(event.code)) return;
        this.enqueueCallback({
          type: "protocol_notice",
          source: { ...source },
          value: { code: event.code },
        });
      },
      onEndpointRefresh: (event) => {
        if (
          !this.running ||
          adapter.identity.provider !== "codex" ||
          event.previous.provider !== "codex" ||
          event.previous.hostId !== adapter.identity.hostId ||
          !isCompatibilityAttestation(event.attestation) ||
          event.attestation.surface !== "codex"
        ) {
          return;
        }
        if (event.outcome === "compatible") {
          const routeHandles = event.routes.map((route) => route.routeHandle);
          if (
            event.current.provider !== "codex" ||
            event.current.hostId !== event.previous.hostId ||
            event.current.endpointGeneration !==
              adapter.identity.endpointGeneration ||
            event.attestation.version !== adapter.protocolVersion ||
            event.attestation.tier === "incompatible" ||
            routeHandles.length > this.config.limits.maxRoutes ||
            new Set(routeHandles).size !== routeHandles.length ||
            routeHandles.some((routeHandle) => !PRIVATE_HANDLE.test(routeHandle))
          ) {
            return;
          }
        } else if (
          event.candidate.provider !== "codex" ||
          event.candidate.hostId !== event.previous.hostId ||
          event.previous.endpointGeneration !==
            adapter.identity.endpointGeneration ||
          event.attestation.tier !== "incompatible"
        ) {
          return;
        }
        this.enqueueCallback({
          type: "endpoint_refresh",
          adapter,
          value:
            event.outcome === "compatible"
              ? {
                  ...event,
                  previous: { ...event.previous },
                  current: { ...event.current },
                  routes: event.routes.map((route) => ({ ...route })),
                }
              : {
                  ...event,
                  previous: { ...event.previous },
                  candidate: { ...event.candidate },
                },
        });
      },
    };
  }

  private enqueueCallback(event: CallbackEvent): boolean {
    if (!this.acceptingCallbacks) return false;
    if (event.type === "endpoint_refresh") {
      return this.enqueueEndpointRefreshCallback(event);
    }
    if (event.type === "delivery") {
      const duplicate = this.callbackQueue.findIndex(
        (candidate) =>
          candidate.type === "delivery" &&
          candidate.value.messageId === event.value.messageId &&
          candidate.value.state === event.value.state,
      );
      if (duplicate >= 0) {
        const retained = this.callbackQueue[duplicate];
        // The first service-boundary observation is authoritative. Replacing
        // delivery evidence with a duplicate observed at/after the cutoff
        // would erase proof that the provider acted before the deadline.
        if (
          retained?.type !== "delivery" ||
          event.receivedAt < retained.receivedAt
        ) {
          this.callbackQueue[duplicate] = event;
        }
        return true;
      }
      if (this.isTerminalAdapterDelivery(event.value)) {
        const firstTerminal = this.callbackQueue.findIndex(
          (candidate) =>
            candidate.type === "delivery" &&
            candidate.value.messageId === event.value.messageId &&
            this.isTerminalAdapterDelivery(candidate.value),
        );
        if (firstTerminal >= 0) {
          const retained = this.callbackQueue[firstTerminal];
          if (
            retained?.type !== "delivery" ||
            event.receivedAt < retained.receivedAt
          ) {
            this.callbackQueue[firstTerminal] = event;
          }
          return true;
        }
      }
    } else if (
      this.callbackQueue.length >=
      this.callbackCapacity - this.deliveryCallbackReserve
    ) {
      // Preserve a fixed authority-bearing delivery reserve. Native ingress
      // gets an immediate terminal receipt from its caller when this returns
      // false; route observations are refreshable and replies remain bounded
      // by their one-owner capability.
      this.dashboardHealthy = false;
      return false;
    }
    if (this.callbackQueue.length >= this.callbackCapacity) {
      // Delivery write/approval observations are authoritative evidence for
      // no-replay and deadline arbitration. Never evict them. A stale route
      // observation is safe to replace because discovery re-observes it.
      const replaceable = this.callbackQueue.findIndex(
        (candidate) =>
          candidate.type === "route" || candidate.type === "protocol_notice",
      );
      if (replaceable < 0) {
        this.dashboardHealthy = false;
        return false;
      }
      this.callbackQueue.splice(replaceable, 1);
    }
    this.callbackQueue.push(event);
    this.enqueueCallbackWorkerOnly();
    return true;
  }

  private enqueueEndpointRefreshCallback(
    event: EndpointRefreshCallback,
  ): boolean {
    if (this.endpointRefreshCallbackPoisoned) return false;
    const key = endpointRefreshCallbackKey(event.value);
    if (this.activeEndpointRefreshCallbackKey !== undefined) {
      if (this.activeEndpointRefreshCallbackKey === key) {
        this.endpointRefreshRetryRequested = event;
        return true;
      }
      this.poisonEndpointRefreshCallbacks(event);
      return false;
    }
    if (this.endpointRefreshCallback !== undefined) {
      if (
        endpointRefreshCallbackKey(this.endpointRefreshCallback.value) === key
      ) {
        return true;
      }
      this.poisonEndpointRefreshCallbacks(event);
      return false;
    }
    this.endpointRefreshCallback = event;
    this.enqueueCallbackWorkerOnly();
    return true;
  }

  private poisonEndpointRefreshCallbacks(
    conflicting: EndpointRefreshCallback,
  ): void {
    this.endpointRefreshConflictBoundary =
      this.activeEndpointRefreshCallback ??
      this.endpointRefreshCallback ??
      conflicting;
    this.endpointRefreshCallback = undefined;
    this.endpointRefreshRetryRequested = undefined;
    this.endpointRefreshCallbackPoisoned = true;
    this.endpointRefreshConflictPending = true;
    this.dashboardHealthy = false;
    this.enqueueCallbackWorkerOnly();
  }

  private hasPendingCallbackWork(): boolean {
    return (
      this.callbackQueue.length > 0 ||
      this.endpointRefreshCallback !== undefined ||
      this.endpointRefreshConflictPending
    );
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
          if (this.hasPendingCallbackWork() && !this.closing) {
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
    while (this.hasPendingCallbackWork()) {
      // Preserve the complete ordinary queue order. In particular, every
      // delivery observation already retained before endpoint replacement is
      // reduced before the lifecycle transition can settle its generation.
      const ordinaryBatch = this.callbackQueue.splice(
        0,
        this.callbackQueue.length,
      );
      for (const event of ordinaryBatch) {
        try {
          if (event.type === "delivery") {
            await this.onDelivery(event.source, event.value, event.receivedAt);
          } else if (event.type === "route") {
            await this.onRouteState(event.source, event.value);
          } else if (event.type === "claude_reply") {
            await this.onClaudeReply(event.value);
          } else if (event.type === "claude_message") {
            await this.onClaudeMessage(event.value);
          } else if (event.type === "protocol_notice") {
            this.addRuntimeAlert(event.value.code, "warning", {
              provider: event.source.provider,
              host: event.source.hostId,
            });
            await this.changed();
          }
        } catch {
          this.dashboardHealthy = false;
        }
      }
      await this.drainPreDeadlineDeliveryCallbacksLocked();
      if (this.endpointRefreshConflictPending) {
        this.endpointRefreshConflictPending = false;
        const boundary = this.endpointRefreshConflictBoundary;
        if (boundary !== undefined) {
          await this.failClosedEndpointRefreshConflict(boundary);
        } else {
          this.addRuntimeAlert(
            "CODEX_ENDPOINT_REFRESH_CONFLICT",
            "error",
            { provider: "codex" },
          );
          await this.changed();
        }
        continue;
      }
      const endpointRefresh = this.endpointRefreshCallback;
      if (endpointRefresh === undefined) continue;
      const key = endpointRefreshCallbackKey(endpointRefresh.value);
      this.endpointRefreshCallback = undefined;
      this.activeEndpointRefreshCallback = endpointRefresh;
      this.activeEndpointRefreshCallbackKey = key;
      let succeeded = false;
      try {
        await this.onCodexEndpointRefresh(
          endpointRefresh.adapter,
          endpointRefresh.value,
        );
        succeeded = true;
      } catch {
        this.dashboardHealthy = false;
      } finally {
        this.activeEndpointRefreshCallback = undefined;
        if (this.activeEndpointRefreshCallbackKey === key) {
          this.activeEndpointRefreshCallbackKey = undefined;
        }
      }
      const requestedRetry = this.endpointRefreshRetryRequested;
      this.endpointRefreshRetryRequested = undefined;
      if (
        !succeeded &&
        !this.endpointRefreshCallbackPoisoned &&
        requestedRetry !== undefined
      ) {
        this.endpointRefreshCallback = requestedRetry;
      }
    }
  }

  /**
   * A selector can synchronously admit callbacks while its promise is still
   * running under the service mutex. Drain exactly the ordinary work that was
   * retained before the selector returned before applying a returned endpoint
   * transition. Delivery evidence wins within that fixed snapshot; callbacks
   * admitted while it is reduced remain queued for the ordinary worker, and
   * the dedicated endpoint-transition slot is never consumed recursively.
   */
  private async drainSelectorCallbackSnapshotLocked(): Promise<void> {
    const snapshot = this.callbackQueue.splice(0, this.callbackQueue.length);
    const ordered = [
      ...snapshot.filter((event) => event.type === "delivery"),
      ...snapshot.filter((event) => event.type !== "delivery"),
    ];
    for (const event of ordered) {
      try {
        if (event.type === "delivery") {
          await this.onDelivery(event.source, event.value, event.receivedAt);
        } else if (event.type === "route") {
          await this.onRouteState(event.source, event.value);
        } else if (event.type === "claude_reply") {
          await this.onClaudeReply(event.value);
        } else if (event.type === "claude_message") {
          await this.onClaudeMessage(event.value);
        } else if (event.type === "protocol_notice") {
          this.addRuntimeAlert(event.value.code, "warning", {
            provider: event.source.provider,
            host: event.source.hostId,
          });
          await this.changed();
        }
      } catch {
        this.dashboardHealthy = false;
      }
    }
    // Synchronous dispatch may have admitted authoritative delivery evidence,
    // and rejected native ingress may have started a detached terminal write.
    // Join both before the endpoint boundary can move to its next generation.
    await this.drainPreDeadlineDeliveryCallbacksLocked();
    await this.drainDetachedReceiptWritesLocked();
  }

  private async failClosedEndpointRefreshConflict(
    boundary: EndpointRefreshCallback,
  ): Promise<void> {
    const identities = [
      boundary.value.previous,
      ...(boundary.value.outcome === "compatible"
        ? [boundary.value.current]
        : []),
    ];
    for (const identity of identities) {
      const routes = (await this.store.inspectPrivateCodexRoutes()).filter(
        (route) =>
          route.binding.hostId === identity.hostId &&
          route.binding.endpointGeneration === identity.endpointGeneration,
      );
      const aliases = routes.map((route) => route.alias);
      const inFlightSettlements =
        aliases.length === 0
          ? []
          : await this.planRoutesInFlightSettlementsLocked(aliases, {
              unwrittenOutcome: "failed",
              safeErrorCode: "CODEX_ENDPOINT_REFRESH_CONFLICT",
            });
      try {
        const settlements = await this.store.markConnectorOffline(
          identity,
          "CODEX_ENDPOINT_REFRESH_CONFLICT",
          inFlightSettlements,
          { preserveQueued: true },
        );
        for (const settlement of settlements) {
          await this.applyTerminalSettlementLocked(settlement);
        }
        for (const route of routes) {
          this.routeStates.set(route.alias, "stale");
        }
        break;
      } catch (error) {
        if (
          error instanceof BridgeError &&
          error.code === "CONNECTOR_NOT_FOUND"
        ) {
          continue;
        }
        throw error;
      }
    }
    this.addRuntimeAlert(
      "CODEX_ENDPOINT_REFRESH_CONFLICT",
      "error",
      { provider: "codex", host: boundary.value.previous.hostId },
    );
    await this.changed();
  }

  private async requireEndpointRefreshUnconflicted(): Promise<void> {
    if (!this.endpointRefreshCallbackPoisoned) return;
    this.endpointRefreshConflictPending = false;
    const boundary = this.endpointRefreshConflictBoundary;
    if (boundary !== undefined) {
      await this.failClosedEndpointRefreshConflict(boundary);
    }
    throw new BridgeError(
      "CODEX_ENDPOINT_REFRESH_CONFLICT",
      "Conflicting Codex endpoint transitions require a clean broker restart.",
    );
  }

  private isTerminalAdapterDelivery(event: GatewayAdapterDelivery): boolean {
    return (
      event.state !== "transport_uncertain" &&
      event.state !== "transport_written" &&
      event.state !== "held"
    );
  }

  /**
   * Delivery evidence observed strictly before the deadline must reach the
   * reducer before its deadline event, even when callback scheduling is late.
   * Evidence observed at/after the cutoff cannot reopen the terminal machine.
   */
  private async drainPreDeadlineDeliveryCallbacksLocked(): Promise<void> {
    while (true) {
      const index = this.callbackQueue.findIndex((candidate) => {
        if (candidate.type !== "delivery") {
          return false;
        }
        const context = this.deliveryCorrelation(candidate.value.messageId);
        return (
          context !== undefined &&
          candidate.receivedAt < Date.parse(context.deadlineAt)
        );
      });
      if (index < 0) return;
      const [event] = this.callbackQueue.splice(index, 1);
      if (event?.type === "delivery") {
        await this.onDelivery(event.source, event.value, event.receivedAt);
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
        const context = this.deliveryCorrelation(messageId);
        return (
          context !== undefined &&
          candidate.receivedAt < Date.parse(context.deadlineAt)
        );
      });
      if (index < 0) return;
      const [event] = this.callbackQueue.splice(index, 1);
      if (event?.type === "delivery") {
        await this.onDelivery(event.source, event.value, event.receivedAt);
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

  private async recoverCodexSuccessionAfterRestartLocked(): Promise<void> {
    const authority = await this.store.inspectCodexSuccessionRecoveryAuthority();
    if (authority.authority === "none") return;
    const exact = {
      oldGeneration: authority.journal.old.generation,
      newGeneration: authority.journal.new.generation,
    };
    if (authority.authority === "old") {
      // A prepared listener is process-owned and cannot survive restart. The
      // durable store proves publication was never armed, so the stale old
      // route remains the sole authority and may be explicitly re-observed.
      await this.store.clearCodexSuccession(exact);
      return;
    }
    // Armed or later recovery is canonicalized by the store to the new route.
    // Only an exact re-registration of that new task may clear the journal;
    // the old task is never restored after this boundary.
    this.pendingCodexSuccessionRecovery = {
      authority: "new",
      journal: authority.journal,
    };
    this.codexRegistrationLocks.set(authority.journal.new.alias, Object.freeze({
      alias: authority.journal.new.alias,
      threadId: authority.journal.new.threadId,
      hostId: authority.journal.new.hostId,
      generation: authority.journal.new.generation,
    }));
  }

  /**
   * Rebuild process-owned route and listener authority for retained Codex
   * registrations during staged startup. The provider's selectRoute performs
   * the exact loaded/list + history-free resume proof; durable state advances
   * only after the new native advertisement and status are live.
   */
  private async reactivateRetainedCodexRoutesAfterRestartLocked(): Promise<
    string[]
  > {
    const idleAliases: string[] = [];
    const retained = await this.store.inspectPrivateCodexRoutes();
    for (const route of retained) {
      if (
        !route.enabled ||
        route.state !== "stale" ||
        route.compatibility !== "expired" ||
        this.pendingCodexSuccessionRecovery?.journal.new.alias === route.alias ||
        this.codexSuccessionPoisoned.has(route.alias)
      ) {
        continue;
      }
      const codexAdapter = this.adapters.find(
        (adapter) =>
          adapter.identity.provider === "codex" &&
          adapter.identity.hostId === route.binding.hostId,
      );
      const claudeAdapter = this.adapters.find(
        (adapter) =>
          adapter.identity.provider === "claude" &&
          adapter.identity.hostId === route.binding.hostId,
      );
      if (codexAdapter === undefined || claudeAdapter === undefined) {
        this.addRuntimeAlert(
          "CODEX_BOOT_REACTIVATION_SKIPPED",
          "warning",
          { provider: "codex", host: route.binding.hostId, alias: route.alias },
        );
        continue;
      }
      let routeSelected = false;
      let advertiseAttempted = false;
      let storeReactivated = false;
      let deferredEndpointRefresh = false;
      try {
        const selected = await codexAdapter.selectRoute({
          alias: route.alias,
          routeHandle: route.binding.routeHandle,
        });
        routeSelected = true;
        await this.drainSelectorCallbackSnapshotLocked();
        if (selected.routeHandle !== route.binding.routeHandle) {
          throw new BridgeError(
            "CODEX_BOOT_REACTIVATION_MISMATCH",
            "The retained Codex task changed during broker startup reactivation.",
          );
        }
        if (selected.endpointRefresh !== undefined) {
          deferredEndpointRefresh = await this.onCodexEndpointRefresh(
            codexAdapter,
            selected.endpointRefresh,
            {
              deferActivation: true,
              deferredRoute: {
                alias: route.alias,
                threadId: route.binding.routeHandle,
                state: selected.state,
              },
            },
          );
          if (!deferredEndpointRefresh) {
            throw new BridgeError(
              "CODEX_BOOT_REACTIVATION_MISMATCH",
              "The retained Codex task could not stage a compatible endpoint refresh during startup.",
            );
          }
        }
        const binding: PrivateRouteBinding = {
          ...codexAdapter.identity,
          routeHandle: route.binding.routeHandle,
          ownerLease: route.binding.ownerLease,
        };
        if (deferredEndpointRefresh) {
          const afterStaging = await this.store.inspectPrivateRoute(route.alias);
          storeReactivated =
            afterStaging !== undefined &&
            afterStaging.enabled &&
            afterStaging.compatibility === "compatible" &&
            bindingKey(afterStaging.binding) === bindingKey(binding);
        }
        advertiseAttempted = true;
        const advertise = claudeAdapter.advertiseNativeCodexPeer;
        if (advertise === undefined) {
          throw new BridgeError(
            "CODEX_BOOT_REACTIVATION_UNAVAILABLE",
            "The retained Codex task cannot rebuild its native advertisement.",
          );
        }
        await advertise.call(claudeAdapter, {
          alias: route.alias,
          cwd: this.nativePeerCwd,
        });
        await claudeAdapter.updateNativeCodexPeerStatus?.(
          route.alias,
          selected.state === "idle"
            ? "idle"
            : selected.state === "awaiting_approval"
              ? "waiting"
              : "busy",
        );
        const listenerGeneration = this.requireCurrentNativeCodexGeneration(
          claudeAdapter,
          route.alias,
        );
        if (!storeReactivated) {
          await this.store.rebindStaleRoute({
            alias: route.alias,
            currentOwnerLease: route.binding.ownerLease,
            newBinding: binding,
            reason: "endpoint_reobserved",
            journalReason: "boot_reactivation",
            state: selected.state,
          });
          storeReactivated = true;
        }
        this.rememberBinding(route.alias, binding, selected.state);
        this.lockCodexRegistration(
          {
            alias: route.alias,
            threadId: route.binding.routeHandle,
            hostId: route.binding.hostId,
            busyPolicy: "queue",
          },
          listenerGeneration,
        );
        if (
          deferredEndpointRefresh &&
          selected.endpointRefresh !== undefined
        ) {
          await this.onCodexEndpointRefresh(
            codexAdapter,
            selected.endpointRefresh,
            {
              requiredRoute: {
                alias: route.alias,
                threadId: route.binding.routeHandle,
                state: selected.state,
              },
            },
          );
        }
        if (
          this.requireCurrentNativeCodexGeneration(
            claudeAdapter,
            route.alias,
          ) !== listenerGeneration
        ) {
          throw new BridgeError(
            "CODEX_BOOT_REACTIVATION_NATIVE_LISTENER_MISSING",
            "The retained Codex task's native listener changed during boot reactivation.",
          );
        }
        if (selected.state === "idle") idleAliases.push(route.alias);
      } catch {
        let cleanupFailed = false;
        if (advertiseAttempted) {
          await claudeAdapter
            .unadvertiseNativeCodexPeer?.(route.alias)
            .catch(() => {
              cleanupFailed = true;
            });
        }
        if (routeSelected) {
          await codexAdapter
            .releaseRoute?.(route.binding.routeHandle)
            .catch(() => {
              cleanupFailed = true;
            });
        }
        if (cleanupFailed || storeReactivated || deferredEndpointRefresh) {
          throw new BridgeError(
            "CODEX_BOOT_REACTIVATION_CLEANUP_FAILED",
            "A Codex boot reactivation crossed its durable boundary without exact live authority.",
          );
        }
        this.addRuntimeAlert(
          "CODEX_BOOT_REACTIVATION_SKIPPED",
          "warning",
          { provider: "codex", host: route.binding.hostId, alias: route.alias },
        );
      }
    }
    return idleAliases;
  }

  private async completePendingCodexSuccessionRecoveryLocked(
    params: ValidatedRegisterCodexParams,
  ): Promise<void> {
    const recovery = this.pendingCodexSuccessionRecovery;
    if (recovery === undefined) return;
    this.assertPendingCodexSuccessionRecoveryMatch(params, recovery);
    await this.store.completeCodexSuccession({
      oldGeneration: recovery.journal.old.generation,
      newGeneration: recovery.journal.new.generation,
    });
    this.pendingCodexSuccessionRecovery = undefined;
  }

  private assertPendingCodexSuccessionRecoveryMatch(
    params: ValidatedRegisterCodexParams,
    recovery = this.pendingCodexSuccessionRecovery,
  ): void {
    if (recovery === undefined) return;
    if (
      recovery.journal.new.alias !== params.alias ||
      recovery.journal.new.threadId !== params.threadId ||
      recovery.journal.new.hostId !== params.hostId
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_RECOVERY_MISMATCH",
        "Only the exact successor task may recover this Codex registration.",
      );
    }
  }

  private requireCurrentNativeCodexGeneration(
    adapter: GatewayProviderAdapter,
    alias: string,
  ): string {
    const current = adapter.currentNativeCodexPeerGeneration;
    if (current === undefined) {
      throw new BridgeError(
        "CODEX_SUCCESSION_UNAVAILABLE",
        "The Claude provider cannot identify its active Codex listener generation.",
      );
    }
    const generation = current.call(adapter, alias);
    if (!isCodexRegistrationGeneration(generation)) {
      throw new BridgeError(
        "CODEX_SUCCESSION_GENERATION_INVALID",
        "The active Codex listener generation is malformed.",
      );
    }
    return generation;
  }

  private nextCodexSuccessionGeneration(oldGeneration: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = this.successionGeneration();
      if (
        isCodexRegistrationGeneration(generation) &&
        generation !== oldGeneration
      ) {
        return generation;
      }
    }
    throw new BridgeError(
      "CODEX_SUCCESSION_GENERATION_UNAVAILABLE",
      "A fresh Codex listener generation could not be allocated.",
    );
  }

  private successionStoreIdentity(
    registration: CodexRegistrationIdentity,
    binding: PrivateRouteBinding,
  ): CodexSuccessionStoreIdentity {
    return {
      ...registration,
      binding: { ...binding },
    };
  }

  private sameSuccessionStoreIdentity(
    observed: CodexSuccessionStoreIdentity,
    registration: CodexRegistrationIdentity,
    binding: PrivateRouteBinding,
  ): boolean {
    return (
      observed.alias === registration.alias &&
      observed.threadId === registration.threadId &&
      observed.hostId === registration.hostId &&
      observed.generation === registration.generation &&
      bindingKey(observed.binding) === bindingKey(binding)
    );
  }

  private async reconcilePreparedCodexSuccessionAfterUnknownCommit(
    execution: CodexSuccessionExecution,
  ): Promise<boolean> {
    let authority: CodexSuccessionRecoveryAuthority;
    try {
      authority =
        await this.store.inspectCodexSuccessionRecoveryAuthority();
    } catch {
      return false;
    }
    if (
      authority.authority !== "old" ||
      authority.journal.stage !== "prepared" ||
      !this.sameSuccessionStoreIdentity(
        authority.journal.old,
        execution.oldRegistration,
        execution.oldBinding,
      ) ||
      !this.sameSuccessionStoreIdentity(
        authority.journal.new,
        execution.newRegistration,
        execution.newBinding,
      )
    ) {
      return false;
    }
    execution.storePrepared = true;
    return true;
  }

  private requireSuccessionMethod<K extends keyof GatewayProviderAdapter>(
    adapter: GatewayProviderAdapter,
    key: K,
  ): NonNullable<GatewayProviderAdapter[K]> {
    const method = adapter[key];
    if (typeof method !== "function") {
      throw new BridgeError(
        "CODEX_SUCCESSION_UNAVAILABLE",
        "A provider does not support exact Codex registration succession.",
      );
    }
    return method as NonNullable<GatewayProviderAdapter[K]>;
  }

  private async succeedCodexRegistration(
    params: ValidatedRegisterCodexParams,
  ): Promise<void> {
    const oldAlias = params.succeedsAlias;
    const lock =
      oldAlias === undefined
        ? undefined
        : this.codexRegistrationLocks.get(oldAlias);
    if (
      oldAlias === undefined ||
      lock === undefined ||
      lock.alias !== oldAlias ||
      lock.hostId !== params.hostId ||
      lock.alias === params.alias ||
      lock.threadId === params.threadId ||
      this.pendingCodexSuccessionRecovery !== undefined
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_OWNER_MISMATCH",
        "A successor must name the exact active Codex registration on the same host.",
      );
    }
    if (
      this.codexSuccessionState !== undefined &&
      this.codexSuccessionState.phase !== "active_old" &&
      !(
        this.codexSuccessionState.phase === "active_new" &&
        this.codexSuccessionState.retired === null
      )
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_ALREADY_ACTIVE",
        "Another Codex registration succession is still active.",
        true,
      );
    }
    const oldInspection = await this.store.inspectPrivateRoute(oldAlias);
    if (
      oldInspection === undefined ||
      oldInspection.binding.provider !== "codex" ||
      oldInspection.binding.hostId !== lock.hostId ||
      oldInspection.binding.routeHandle !== lock.threadId ||
      oldInspection.binding.ownerLease !==
        stableLease("codex", `${lock.hostId}\0${lock.threadId}`) ||
      !oldInspection.enabled ||
      oldInspection.compatibility !== "compatible"
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_OWNER_MISMATCH",
        "The active Codex registration is no longer exact and compatible.",
      );
    }
    const claudeAdapter = this.adapter("claude", params.hostId);
    const observedGeneration = this.requireCurrentNativeCodexGeneration(
      claudeAdapter,
      oldAlias,
    );
    if (lock.generation !== observedGeneration) {
      throw new BridgeError(
        "CODEX_SUCCESSION_GENERATION_MISMATCH",
        "The active Codex listener generation changed before succession.",
      );
    }
    const newGeneration =
      this.nextCodexSuccessionGeneration(observedGeneration);
    const oldRegistration: CodexRegistrationIdentity = {
      alias: oldAlias,
      threadId: lock.threadId,
      hostId: lock.hostId,
      generation: observedGeneration,
    };
    const newRegistration: CodexRegistrationIdentity = {
      alias: params.alias,
      threadId: params.threadId,
      hostId: params.hostId,
      generation: newGeneration,
    };
    const codexAdapter = this.adapter("codex", params.hostId);
    const newBinding: PrivateRouteBinding = {
      ...codexAdapter.identity,
      routeHandle: params.threadId,
      ownerLease: stableLease("codex", `${params.hostId}\0${params.threadId}`),
    };
    const execution: CodexSuccessionExecution = {
      state: createCodexRegistrationSuccession(oldRegistration),
      oldRegistration,
      newRegistration,
      oldBinding: { ...oldInspection.binding },
      newBinding,
      newCodexSelected: false,
      newListenerPrepared: false,
      newListenerActivated: false,
      storePrepared: false,
      publicationAbsenceConfirmed: false,
      poisonCleanupReady: false,
      storePrepareOutcomeUnproven: false,
      recoveryFailed: false,
    };
    this.codexSuccessionState = execution.state;
    await this.driveCodexSuccessionLocked(execution, {
      type: "begin",
      registration: newRegistration,
    });
    await this.changed().catch(() => {
      this.dashboardHealthy = false;
    });
    if (execution.requestFailureCode !== undefined) {
      throw new BridgeError(
        execution.requestFailureCode,
        this.codexSuccessionPoisoned.has(oldRegistration.alias) ||
          this.codexSuccessionPoisoned.has(newRegistration.alias)
          ? "Codex succession requires manual recovery."
          : "Codex succession did not pass its quiescence or publication boundary.",
        execution.requestFailureCode.includes("BUSY"),
      );
    }
    if (
      execution.state.phase !== "active_new" ||
      execution.state.retired !== null
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_INCOMPLETE",
        "Codex succession did not reach a stable active generation.",
      );
    }
    this.codexRegistrationLocks.delete(oldRegistration.alias);
    this.codexRegistrationLocks.set(
      newRegistration.alias,
      Object.freeze({ ...newRegistration }),
    );
    if (execution.newRouteState === "idle") {
      this.scheduleDispatch(newRegistration.alias);
    }
  }

  private async driveCodexSuccessionLocked(
    execution: CodexSuccessionExecution,
    event: CodexRegistrationSuccessionEvent,
    recoverFailures = true,
  ): Promise<void> {
    const transition = transitionCodexRegistrationSuccession(
      execution.state,
      event,
    );
    execution.state = transition.state;
    this.codexSuccessionState = transition.state;
    for (const effect of transition.effects) {
      try {
        const next = await this.executeCodexSuccessionEffectLocked(
          execution,
          effect,
        );
        if (next !== undefined) {
          if (!recoverFailures && execution.recoveryFailed) {
            continue;
          }
          await this.driveCodexSuccessionLocked(
            execution,
            next,
            recoverFailures,
          );
          return;
        }
      } catch (error) {
        const phase = this.codexSuccessionFailurePhase(effect);
        const code = safeCode(
          error instanceof BridgeError ? error.code : undefined,
          `CODEX_SUCCESSION_${phase.toUpperCase()}_FAILED`,
        );
        execution.requestFailureCode ??= code;
        if (
          effect.type === "prepare_new_store" &&
          execution.storePrepareOutcomeUnproven
        ) {
          this.dashboardHealthy = false;
          await this.driveCodexSuccessionLocked(
            execution,
            {
              type: "restart_evidence",
              generation: this.successionNewRegistration(execution).generation,
              publication: "unknown",
              safeErrorCode: code,
            },
            false,
          );
          return;
        }
        if (!recoverFailures) {
          if (phase === "resume" && execution.state.phase === "resuming_old") {
            execution.recoveryFailed = false;
            await this.recoverCodexSuccessionLocked(execution, phase, code);
            return;
          }
          execution.recoveryFailed = true;
          this.dashboardHealthy = false;
          continue;
        }
        await this.recoverCodexSuccessionLocked(execution, phase, code);
        return;
      }
    }
  }

  private async recoverCodexSuccessionLocked(
    execution: CodexSuccessionExecution,
    phase: CodexSuccessionFailurePhase,
    safeErrorCode: string,
  ): Promise<void> {
    await this.driveCodexSuccessionLocked(
      execution,
      {
        type: "phase_failed",
        generation: this.successionNewRegistration(execution).generation,
        phase,
        safeErrorCode,
      },
      false,
    );
    if (execution.recoveryFailed && execution.state.phase === "recovery_required") {
      execution.recoveryFailed = false;
      await this.driveCodexSuccessionLocked(
        execution,
        {
          type: "phase_failed",
          generation: this.successionNewRegistration(execution).generation,
          phase: "cleanup",
          safeErrorCode: "CODEX_SUCCESSION_CLEANUP_FAILED",
        },
        false,
      );
    }
  }

  private successionNewRegistration(
    execution: CodexSuccessionExecution,
  ): CodexRegistrationIdentity {
    return execution.newRegistration;
  }

  private codexSuccessionFailurePhase(
    effect: CodexRegistrationSuccessionEffect,
  ): CodexSuccessionFailurePhase {
    switch (effect.type) {
      case "freeze_old_ingress":
      case "freeze_old_dispatch":
      case "quiesce_and_join_old":
        return "freeze";
      case "verify_full_barrier":
        return "barrier";
      case "create_fresh_listener_generation":
        return "listener";
      case "purge_old_conversations":
      case "purge_old_reply_capabilities":
      case "prepare_new_store":
        return "store";
      case "arm_publication_journal":
        return "publication_arm";
      case "publish_new_registry":
        return "registry";
      case "activate_new_registration":
        return "activation";
      case "retire_old_generation":
      case "close_old_listener":
        return "retirement";
      case "cleanup_unpublished_generation":
      case "poison_new_generation":
      case "take_registrations_offline":
      case "cleanup_poisoned_generations":
      case "manual_recovery_required":
        return "cleanup";
      case "resume_old_ingress":
      case "resume_old_dispatch":
        return "resume";
    }
  }

  private async executeCodexSuccessionEffectLocked(
    execution: CodexSuccessionExecution,
    effect: CodexRegistrationSuccessionEffect,
  ): Promise<CodexRegistrationSuccessionEvent | undefined> {
    const newRegistration = this.successionNewRegistration(execution);
    const claudeAdapter = this.adapter("claude", newRegistration.hostId);
    const codexAdapter = this.adapter("codex", newRegistration.hostId);
    const exact = {
      oldGeneration: execution.oldRegistration.generation,
      newGeneration: newRegistration.generation,
    };
    switch (effect.type) {
      case "freeze_old_ingress": {
        const quiesce = this.requireSuccessionMethod(
          claudeAdapter,
          "quiesceNativeCodexPeerGeneration",
        );
        await quiesce.call(claudeAdapter, effect.registration.generation);
        return undefined;
      }
      case "freeze_old_dispatch":
        this.codexSuccessionDispatchFrozen.add(execution.oldRegistration.alias);
        this.codexSuccessionDispatchFrozen.add(execution.newRegistration.alias);
        this.scheduledDispatchTargets.delete(execution.oldRegistration.alias);
        this.scheduledDispatchTargets.delete(execution.newRegistration.alias);
        return undefined;
      case "quiesce_and_join_old":
        await this.drainCallbackQueueLocked();
        await this.drainDetachedReceiptWritesLocked();
        return undefined;
      case "verify_full_barrier": {
        if (await this.codexSuccessionBarrierCleanLocked(effect.registration)) {
          return { type: "barrier_clean", generation: newRegistration.generation };
        }
        execution.requestFailureCode ??= "CODEX_SUCCESSION_BARRIER_BUSY";
        return {
          type: "barrier_busy",
          generation: newRegistration.generation,
          safeErrorCode: "CODEX_SUCCESSION_BARRIER_BUSY",
        };
      }
      case "create_fresh_listener_generation": {
        const prepare = this.requireSuccessionMethod(
          claudeAdapter,
          "prepareNativeCodexPeerGeneration",
        );
        await prepare.call(claudeAdapter, {
          alias: effect.registration.alias,
          cwd: this.nativePeerCwd,
          generation: effect.registration.generation,
          currentGeneration: execution.oldRegistration.generation,
        });
        execution.newListenerPrepared = true;
        return {
          type: "listener_prepared",
          generation: effect.registration.generation,
        };
      }
      case "purge_old_conversations":
        // The barrier proves no accepted body or live continuation remains.
        // Inert conversation identifiers are deliberately not inherited by a
        // successor identity.
        this.purgeSuccessionTransientState(
          new Set([
            execution.oldRegistration.alias,
            execution.newRegistration.alias,
          ]),
        );
        return undefined;
      case "purge_old_reply_capabilities": {
        this.purgeSuccessionTransientState(
          new Set([
            execution.oldRegistration.alias,
            execution.newRegistration.alias,
          ]),
        );
        const purge = this.requireSuccessionMethod(
          claudeAdapter,
          "purgeNativeCodexPeerGenerationReplyCapabilities",
        );
        await purge.call(claudeAdapter, effect.registration.generation);
        return undefined;
      }
      case "prepare_new_store": {
        const selected = await codexAdapter.selectRoute({
          alias: effect.registration.alias,
          routeHandle: effect.registration.threadId,
        });
        execution.newCodexSelected = true;
        if (selected.routeHandle !== effect.registration.threadId) {
          throw new BridgeError(
            "ROUTE_MISMATCH",
            "The connector prepared a different successor task.",
          );
        }
        execution.newRouteState = selected.state;
        try {
          await this.store.prepareCodexSuccession({
            old: this.successionStoreIdentity(
              this.successionOldRegistration(execution),
              execution.oldBinding,
            ),
            new: this.successionStoreIdentity(
              effect.registration,
              execution.newBinding,
            ),
          });
          execution.storePrepared = true;
        } catch (error) {
          if (
            error instanceof BridgeError &&
            error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN"
          ) {
            const reconciled =
              await this.reconcilePreparedCodexSuccessionAfterUnknownCommit(
                execution,
              );
            if (!reconciled) execution.storePrepareOutcomeUnproven = true;
          }
          throw error;
        }
        return {
          type: "store_prepared",
          generation: effect.registration.generation,
        };
      }
      case "arm_publication_journal":
        await this.store.armCodexSuccessionPublication(exact);
        return {
          type: "publication_armed",
          generation: effect.registration.generation,
        };
      case "publish_new_registry": {
        const publish = this.requireSuccessionMethod(
          claudeAdapter,
          "publishPreparedNativeCodexPeer",
        );
        const outcome = await publish.call(claudeAdapter, {
          currentGeneration: exact.oldGeneration,
          preparedGeneration: exact.newGeneration,
        });
        if (outcome === "not_published") {
          execution.publicationAbsenceConfirmed = true;
          execution.requestFailureCode ??=
            "CODEX_SUCCESSION_PUBLICATION_NOT_PUBLISHED";
          return {
            type: "publication_absence_confirmed",
            generation: exact.newGeneration,
          };
        }
        if (outcome === "unknown") {
          throw new BridgeError(
            "CODEX_SUCCESSION_PUBLICATION_UNKNOWN",
            "The successor registry publication outcome is unknown.",
          );
        }
        await this.store.markCodexSuccessionPublished(exact);
        return {
          type: "registry_published",
          generation: exact.newGeneration,
        };
      }
      case "activate_new_registration": {
        const state = execution.newRouteState;
        if (state === undefined) {
          throw new BridgeError(
            "CODEX_SUCCESSION_STATE_MISMATCH",
            "The successor task has no prepared route state.",
          );
        }
        // Durable route authority changes before the prepared listener is
        // granted ingress. A published listener cannot accept a body while
        // the store still authorizes the old task.
        await this.store.activateCodexSuccession({ ...exact, state });
        const activate = this.requireSuccessionMethod(
          claudeAdapter,
          "activatePreparedNativeCodexPeerGeneration",
        );
        await activate.call(claudeAdapter, effect.registration.generation);
        execution.newListenerActivated = true;
        this.forgetBinding(this.successionOldRegistration(execution).alias);
        this.rememberBinding(
          effect.registration.alias,
          execution.newBinding,
          state,
        );
        this.codexRegistrationLocks.delete(
          this.successionOldRegistration(execution).alias,
        );
        this.codexRegistrationLocks.set(
          effect.registration.alias,
          Object.freeze({ ...effect.registration }),
        );
        await claudeAdapter.updateNativeCodexPeerStatus?.(
          effect.registration.alias,
          state === "idle"
            ? "idle"
            : state === "awaiting_approval"
              ? "waiting"
              : "busy",
        );
        return { type: "activate", generation: effect.registration.generation };
      }
      case "retire_old_generation":
        await codexAdapter.releaseRoute?.(effect.registration.threadId);
        return undefined;
      case "close_old_listener": {
        const retire = this.requireSuccessionMethod(
          claudeAdapter,
          "retireNativeCodexPeerGeneration",
        );
        await retire.call(claudeAdapter, {
          retiredGeneration: effect.registryUnlink.onlyIfOwnedGeneration,
          protectedActiveGeneration:
            effect.registryUnlink.protectedActiveGeneration,
        });
        await this.store.completeCodexSuccession(exact);
        this.codexSuccessionDispatchFrozen.delete(execution.oldRegistration.alias);
        this.codexSuccessionDispatchFrozen.delete(execution.newRegistration.alias);
        return {
          type: "cleanup_confirmed",
          generation: newRegistration.generation,
        };
      }
      case "cleanup_unpublished_generation": {
        let cleanupError: unknown;
        if (execution.newListenerPrepared) {
          try {
            const cleanup = this.requireSuccessionMethod(
              claudeAdapter,
              "cleanupPreparedNativeCodexPeerGeneration",
            );
            await cleanup.call(claudeAdapter, effect.registration.generation);
            execution.newListenerPrepared = false;
          } catch (error) {
            cleanupError = error;
          }
        }
        if (execution.newCodexSelected) {
          try {
            await codexAdapter.releaseRoute?.(effect.registration.threadId);
            execution.newCodexSelected = false;
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (execution.storePrepared) {
          try {
            await this.store.clearCodexSuccession({
              ...exact,
              ...(execution.publicationAbsenceConfirmed
                ? { publicationAbsenceConfirmed: true as const }
                : {}),
            });
            execution.storePrepared = false;
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (cleanupError !== undefined) throw cleanupError;
        return {
          type: "cleanup_confirmed",
          generation: effect.registration.generation,
        };
      }
      case "resume_old_ingress": {
        const resume = this.requireSuccessionMethod(
          claudeAdapter,
          "resumeNativeCodexPeerGeneration",
        );
        await resume.call(claudeAdapter, effect.registration.generation);
        return undefined;
      }
      case "resume_old_dispatch":
        this.codexSuccessionDispatchFrozen.delete(execution.oldRegistration.alias);
        this.codexSuccessionDispatchFrozen.delete(execution.newRegistration.alias);
        if (this.routeStates.get(execution.oldRegistration.alias) === "idle") {
          this.scheduleDispatch(execution.oldRegistration.alias);
        }
        return {
          type: "resume_confirmed",
          generation: newRegistration.generation,
        };
      case "poison_new_generation":
        this.codexSuccessionPoisoned.add(execution.oldRegistration.alias);
        this.codexSuccessionPoisoned.add(execution.newRegistration.alias);
        if (
          execution.state.phase === "offline_poisoned" &&
          execution.state.rollback === "old_allowed"
        ) {
          return undefined;
        }
        await this.store.forbidCodexSuccessionRecovery({
          ...exact,
          safeErrorCode:
            execution.requestFailureCode ?? "CODEX_SUCCESSION_RECOVERY_REQUIRED",
        });
        return undefined;
      case "take_registrations_offline": {
        if (
          execution.state.phase === "offline_poisoned" &&
          execution.state.rollback === "old_allowed" &&
          execution.state.failedPhase !== "resume"
        ) {
          return undefined;
        }
        await this.quiesceAndDrainPoisonedSuccessionLocked(
          execution,
          claudeAdapter,
        );
        const route =
          (await this.store.inspectPrivateRoute(
            effect.newRegistration.alias,
          )) ??
          (await this.store.inspectPrivateRoute(effect.oldRegistration.alias));
        if (route !== undefined && route.enabled) {
          const invalidated = await this.store.invalidateRoute(
            route.binding,
            "CODEX_SUCCESSION_RECOVERY_REQUIRED",
          );
          for (const settlement of invalidated) {
            await this.applyTerminalSettlementLocked(settlement);
          }
          const settlements = await this.store.disableRoute(
            route.alias,
            route.binding.ownerLease,
          );
          for (const settlement of settlements) {
            await this.applyTerminalSettlementLocked(settlement);
          }
        }
        this.forgetBinding(effect.oldRegistration.alias);
        this.forgetBinding(effect.newRegistration.alias);
        await this.drainCallbackQueueLocked();
        await this.drainDetachedReceiptWritesLocked();
        this.purgeSuccessionTransientState(
          new Set([
            execution.oldRegistration.alias,
            execution.newRegistration.alias,
          ]),
        );
        if (
          !(await this.codexSuccessionPoisonBarrierCleanLocked(
            execution,
            claudeAdapter,
            codexAdapter,
          ))
        ) {
          throw new BridgeError(
            "CODEX_SUCCESSION_DRAIN_INCOMPLETE",
            "Interrupted succession work did not reach a clean stopping point. Restart the gateway with embassy serve.",
          );
        }
        execution.poisonCleanupReady = true;
        return undefined;
      }
      case "cleanup_poisoned_generations": {
        if (
          execution.state.phase === "offline_poisoned" &&
          execution.state.rollback === "old_allowed" &&
          execution.state.failedPhase !== "resume"
        ) {
          await this.executeCodexSuccessionEffectLocked(execution, {
            type: "cleanup_unpublished_generation",
            registration: effect.newRegistration,
          });
          this.codexSuccessionPoisoned.delete(execution.oldRegistration.alias);
          this.codexSuccessionPoisoned.delete(execution.newRegistration.alias);
          return {
            type: "cleanup_confirmed",
            generation: effect.newRegistration.generation,
          };
        }
        if (!execution.poisonCleanupReady) {
          throw new BridgeError(
            "CODEX_SUCCESSION_DRAIN_INCOMPLETE",
            "Interrupted generations cannot close before pending work and receipts are drained. Restart the gateway with embassy serve.",
          );
        }
        const results = await Promise.allSettled([
          claudeAdapter.unadvertiseNativeCodexPeer?.(
            execution.oldRegistration.alias,
          ),
          claudeAdapter.unadvertiseNativeCodexPeer?.(
            execution.newRegistration.alias,
          ),
          codexAdapter.releaseRoute?.(execution.oldRegistration.threadId),
          codexAdapter.releaseRoute?.(execution.newRegistration.threadId),
        ]);
        if (results.some((result) => result.status === "rejected")) {
          throw new BridgeError(
            "CODEX_SUCCESSION_CLEANUP_FAILED",
            "The poisoned Codex generations could not be fully closed.",
          );
        }
        this.codexRegistrationLocks.delete(execution.oldRegistration.alias);
        this.codexRegistrationLocks.delete(execution.newRegistration.alias);
        return {
          type: "cleanup_confirmed",
          generation: effect.newRegistration.generation,
        };
      }
      case "manual_recovery_required":
        this.dashboardHealthy = false;
        this.addRuntimeAlert(effect.safeErrorCode, "error", {
          provider: "codex",
          host: effect.registration.hostId,
        });
        return undefined;
    }
  }

  private successionOldRegistration(
    execution: CodexSuccessionExecution,
  ): CodexRegistrationIdentity {
    return execution.oldRegistration;
  }

  private async quiesceAndDrainPoisonedSuccessionLocked(
    execution: CodexSuccessionExecution,
    claudeAdapter: GatewayProviderAdapter,
  ): Promise<void> {
    const current = this.requireSuccessionMethod(
      claudeAdapter,
      "currentNativeCodexPeerGeneration",
    );
    const candidates = execution.newListenerActivated
      ? [execution.newRegistration, execution.oldRegistration]
      : [execution.oldRegistration, execution.newRegistration];
    let active: CodexRegistrationIdentity | undefined;
    for (const candidate of candidates) {
      try {
        if (current.call(claudeAdapter, candidate.alias) === candidate.generation) {
          active = candidate;
          break;
        }
      } catch {
        // Exact-alias lookup is intentionally probed for both bounded
        // generations. A partially failed activation must not be guessed.
      }
    }
    if (active === undefined) {
      throw new BridgeError(
        "CODEX_SUCCESSION_ACTIVE_GENERATION_UNKNOWN",
        "The active Codex listener generation could not be proven before cleanup.",
      );
    }
    const quiesce = this.requireSuccessionMethod(
      claudeAdapter,
      "quiesceNativeCodexPeerGeneration",
    );
    await quiesce.call(claudeAdapter, active.generation);
    // Quiescence joins native ingress. Process every callback admitted before
    // the join, then join the detached terminal receipt writes those callbacks
    // may create, before any listener capability is closed.
    await this.drainCallbackQueueLocked();
    await this.drainDetachedReceiptWritesLocked();
    const codexAdapter = this.adapter("codex", active.hostId);
    if (
      !(await this.codexSuccessionPoisonBarrierCleanLocked(
        execution,
        claudeAdapter,
        codexAdapter,
        active,
      ))
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_DRAIN_INCOMPLETE",
        "Interrupted succession work did not reach a clean pre-cleanup point. Restart the gateway with embassy serve.",
      );
    }
  }

  private codexRouteSuccessionQuiet(
    observation: ReturnType<
      NonNullable<GatewayProviderAdapter["observeRouteSuccessionBarrier"]>
    >,
  ): boolean {
    return (
      observation.clean ||
      (!observation.routePresent &&
        observation.connection === "absent" &&
        observation.routeStatus === "absent" &&
        observation.queueDepth === 0 &&
        !observation.hasActiveTurn &&
        !observation.requestInFlight &&
        !observation.routeCreationInFlight &&
        !observation.routeReleaseInFlight &&
        observation.pendingReplyCorrelations === 0 &&
        observation.pendingCallbacks === 0)
    );
  }

  private conversationTouchesAliases(
    conversationId: string,
    aliases: ReadonlySet<string>,
  ): boolean {
    const conversation = this.conversations.get(conversationId);
    return (
      conversation !== undefined &&
      (aliases.has(conversation.sourceAlias) ||
        aliases.has(conversation.targetAlias))
    );
  }

  private successionServiceStateClean(
    aliases: ReadonlySet<string>,
  ): boolean {
    const contextTouches = (context: MessageContext): boolean =>
      aliases.has(context.targetAlias) ||
      this.conversationTouchesAliases(context.conversationId, aliases);
    return (
      [...this.messageContexts.values()].every(
        (context) => !contextTouches(context),
      ) &&
      [...this.providerTurnContinuations.values()].every(
        (context) => !contextTouches(context),
      ) &&
      [...this.activeDispatchByTarget.keys()].every(
        (alias) => !aliases.has(alias),
      ) &&
      [...this.scheduledDispatchTargets].every((alias) => !aliases.has(alias)) &&
      [...this.dispatchRunnerTargets].every((alias) => !aliases.has(alias)) &&
      [...this.pendingClaudeReplies.values()].every(
        (pending) =>
          !this.conversationTouchesAliases(pending.conversationId, aliases),
      ) &&
      [...this.nativeIngressByConversation.entries()].every(
        ([conversationId, capability]) =>
          !aliases.has(capability.sourceAlias) &&
          !this.conversationTouchesAliases(conversationId, aliases),
      ) &&
      [...this.deliveryTrackers.values()].every(
        (tracker) =>
          (!aliases.has(tracker.targetAlias) &&
            !this.conversationTouchesAliases(
              tracker.conversationId,
              aliases,
            )) ||
          (isTerminalDeliveryMachine(tracker.machine) &&
            tracker.pendingTerminalEvent === undefined &&
            tracker.pendingTerminalReplyText === undefined &&
            tracker.settlementRetryAt === undefined &&
            tracker.nativeReceipt === undefined),
      )
    );
  }

  private purgeSuccessionTransientState(aliases: ReadonlySet<string>): void {
    const conversationIds = new Set(
      [...this.conversations.values()]
        .filter(
          (conversation) =>
            aliases.has(conversation.sourceAlias) ||
            aliases.has(conversation.targetAlias),
        )
        .map((conversation) => conversation.id),
    );
    for (const conversationId of conversationIds) {
      this.conversations.delete(conversationId);
      this.nativeIngressByConversation.delete(conversationId);
    }
    for (const [key, pending] of this.pendingClaudeReplies) {
      if (conversationIds.has(pending.conversationId)) {
        this.pendingClaudeReplies.delete(key);
      }
    }
  }

  private async codexSuccessionPoisonBarrierCleanLocked(
    execution: CodexSuccessionExecution,
    claudeAdapter: GatewayProviderAdapter,
    codexAdapter: GatewayProviderAdapter,
    knownActive?: CodexRegistrationIdentity,
  ): Promise<boolean> {
    const active =
      knownActive ??
      (execution.newListenerActivated
        ? execution.newRegistration
        : execution.oldRegistration);
    const observeClaude = this.requireSuccessionMethod(
      claudeAdapter,
      "observeNativeCodexSuccessionBarrier",
    );
    const claude = await observeClaude.call(
      claudeAdapter,
      active.generation,
    );
    const observeCodex = this.requireSuccessionMethod(
      codexAdapter,
      "observeRouteSuccessionBarrier",
    );
    const codexRoutes = [execution.oldRegistration];
    if (execution.newCodexSelected) codexRoutes.push(execution.newRegistration);
    const codexQuiet = codexRoutes.every((registration) =>
      this.codexRouteSuccessionQuiet(
        observeCodex.call(codexAdapter, registration.threadId),
      ),
    );
    const persistedRoute =
      (await this.store.inspectPrivateRoute(execution.newRegistration.alias)) ??
      (await this.store.inspectPrivateRoute(execution.oldRegistration.alias));
    if (persistedRoute === undefined) return false;
    const store = await this.store.inspectCodexSuccessionBarrier(
      persistedRoute.alias,
    );
    const aliases = new Set([
      execution.oldRegistration.alias,
      execution.newRegistration.alias,
    ]);
    return (
      [...aliases].every((alias) => this.codexSuccessionPoisoned.has(alias)) &&
      [...aliases].every((alias) =>
        this.codexSuccessionDispatchFrozen.has(alias),
      ) &&
      store.clean &&
      store.codexRouteCount === 1 &&
      store.queueCount === 0 &&
      store.inFlightCount === 0 &&
      store.transientBodyCount === 0 &&
      store.codexQueueDepth === 0 &&
      claude.clean &&
      claude.generation === active.generation &&
      claude.activeGenerationMatched &&
      claude.ingressQuiesced &&
      claude.monitorFrozen &&
      !claude.discoveryInFlight &&
      claude.pendingOutboundReceipts === 0 &&
      claude.pendingInboundReceipts === 0 &&
      claude.rejectedInboundSettlements === 0 &&
      codexQuiet &&
      this.successionServiceStateClean(aliases) &&
      this.endpointCallbacksQuiet() &&
      this.detachedReceiptWrites.size === 0
    );
  }

  private async codexSuccessionBarrierCleanLocked(
    oldRegistration: CodexRegistrationIdentity,
  ): Promise<boolean> {
    await this.drainCallbackQueueLocked();
    await this.drainDetachedReceiptWritesLocked();
    const lifecycleChanged = await this.processLifecycleLocked();
    if (lifecycleChanged) await this.publish();
    const store = await this.store.inspectCodexSuccessionBarrier(
      oldRegistration.alias,
    );
    const claudeAdapter = this.adapter("claude", oldRegistration.hostId);
    const codexAdapter = this.adapter("codex", oldRegistration.hostId);
    const observeClaude = this.requireSuccessionMethod(
      claudeAdapter,
      "observeNativeCodexSuccessionBarrier",
    );
    const observeCodex = this.requireSuccessionMethod(
      codexAdapter,
      "observeRouteSuccessionBarrier",
    );
    const claude = await observeClaude.call(
      claudeAdapter,
      oldRegistration.generation,
    );
    const codex = observeCodex.call(codexAdapter, oldRegistration.threadId);
    const aliases = new Set([oldRegistration.alias]);
    return (
      !this.closing &&
      this.codexSuccessionDispatchFrozen.has(oldRegistration.alias) &&
      store.clean &&
      claude.clean &&
      claude.generation === oldRegistration.generation &&
      claude.activeGenerationMatched &&
      claude.ingressQuiesced &&
      claude.monitorFrozen &&
      codex.clean &&
      this.successionServiceStateClean(aliases) &&
      this.endpointCallbacksQuiet() &&
      this.detachedReceiptWrites.size === 0
    );
  }

  private rescheduleIdleRoutesLocked(): void {
    for (const [alias, state] of this.routeStates) {
      if (state === "idle") this.scheduleDispatch(alias);
    }
  }

  private codexSuccessionIsStable(): boolean {
    const state = this.codexSuccessionState;
    return (
      state === undefined ||
      state.phase === "active_old" ||
      (state.phase === "active_new" && state.retired === null)
    );
  }

  private async requireUnchangedStaleCodexOrphan(
    alias: string,
    expected: PrivateRouteBinding,
  ): Promise<void> {
    let current: PrivateRouteBinding;
    try {
      current = await this.store.inspectStaleCodexOrphan(alias);
    } catch {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_MISMATCH",
        "The stale Codex registration changed during recovery.",
      );
    }
    if (bindingKey(current) !== bindingKey(expected)) {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_MISMATCH",
        "The stale Codex registration changed during recovery.",
      );
    }
  }

  private nativeCodexOrphanBarrierClean(
    observation: Awaited<
      ReturnType<
        NonNullable<
          GatewayProviderAdapter["observeNativeCodexSuccessionBarrier"]
        >
      >
    >,
    generation: string,
  ): boolean {
    return (
      observation.clean &&
      observation.generation === generation &&
      observation.activeGenerationMatched &&
      observation.ingressQuiesced &&
      observation.monitorFrozen &&
      !observation.discoveryInFlight &&
      observation.pendingOutboundReceipts === 0 &&
      observation.pendingInboundReceipts === 0 &&
      observation.rejectedInboundSettlements === 0
    );
  }

  private endpointCallbacksQuiet(): boolean {
    return (
      !this.hasPendingCallbackWork() &&
      this.activeEndpointRefreshCallbackKey === undefined
    );
  }

  private async registerCodex(params: ValidatedRegisterCodexParams): Promise<void> {
    if (!params.alias.startsWith("codex-")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_ALIAS",
        "A registered Codex alias must start with codex-.",
      );
    }
    if (
      this.codexSuccessionPoisoned.has(params.alias) ||
      this.codexOrphanCleanupPending.has(params.alias) ||
      (params.succeedsAlias !== undefined &&
        (this.codexSuccessionPoisoned.has(params.succeedsAlias) ||
          this.codexOrphanCleanupPending.has(params.succeedsAlias)))
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_RECOVERY_REQUIRED",
        "Codex registration is offline until the incomplete succession is manually recovered.",
      );
    }
    if (params.succeedsAlias !== undefined) {
      await this.succeedCodexRegistration(params);
      return;
    }
    const registrationLock = this.codexRegistrationLocks.get(params.alias);
    if (
      registrationLock !== undefined &&
      (registrationLock.threadId !== params.threadId ||
        registrationLock.hostId !== params.hostId)
    ) {
      throw new BridgeError(
        "CODEX_REGISTRATION_REBIND_FORBIDDEN",
        "A Codex registration cannot change alias, task, or host during one Embassy process lifetime.",
      );
    }
    if (
      [...this.codexRegistrationLocks.values()].some(
        (lock) =>
          lock.alias !== params.alias &&
          lock.hostId === params.hostId &&
          lock.threadId === params.threadId,
      )
    ) {
      throw new BridgeError(
        "CODEX_REGISTRATION_REBIND_FORBIDDEN",
        "One Codex task cannot be registered under two aliases.",
      );
    }
    // An irreversible succession restart leaves one exact durable successor
    // authority. Reject every other identity before it can acquire provisional
    // connector or native-advertisement state.
    this.assertPendingCodexSuccessionRecoveryMatch(params);
    const persistedCodexRoute = (
      await this.store.inspectPrivateCodexRoutes()
    ).find((route) => route.alias === params.alias);
    if (
      persistedCodexRoute !== undefined &&
      (persistedCodexRoute.binding.hostId !== params.hostId ||
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
    await this.drainSelectorCallbackSnapshotLocked();
    if (registered.routeHandle !== params.threadId) {
      throw new BridgeError(
        "ROUTE_MISMATCH",
        "The connector registered a different task.",
      );
    }
    let deferredEndpointRefresh = false;
    if (registered.endpointRefresh !== undefined) {
      try {
        deferredEndpointRefresh = await this.onCodexEndpointRefresh(
          adapter,
          registered.endpointRefresh,
          {
            deferActivation: true,
            deferredRoute: {
              alias: params.alias,
              threadId: params.threadId,
              state: registered.state,
            },
          },
        );
      } catch (error) {
        await adapter.releaseRoute?.(params.threadId).catch(() => undefined);
        throw error;
      }
    }
    const binding: PrivateRouteBinding = {
      ...adapter.identity,
      routeHandle: params.threadId,
      ownerLease: stableLease("codex", `${params.hostId}\0${params.threadId}`),
    };
    try {
      const afterRefresh = await this.store.inspectPrivateRoute(params.alias);
      const alreadyInstalledExactly =
        afterRefresh !== undefined &&
        afterRefresh.enabled &&
        afterRefresh.compatibility === "compatible" &&
        bindingKey(afterRefresh.binding) === bindingKey(binding);
      if (!alreadyInstalledExactly || !deferredEndpointRefresh) {
        await this.registerOrRebind(
          params.alias,
          binding,
          "endpoint_reobserved",
          registered.state,
        );
      }
    } catch (error) {
      await adapter.releaseRoute?.(params.threadId).catch(() => undefined);
      throw error;
    }
    let advertiseAttempted = false;
    let listenerGeneration: string | undefined;
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
      listenerGeneration = this.requireCurrentNativeCodexGeneration(
        claudeAdapter,
        params.alias,
      );
      await this.completePendingCodexSuccessionRecoveryLocked(params);
      this.lockCodexRegistration(params, listenerGeneration);
      if (
        deferredEndpointRefresh &&
        registered.endpointRefresh !== undefined
      ) {
        await this.onCodexEndpointRefresh(
          adapter,
          registered.endpointRefresh,
          {
            requiredRoute: {
              alias: params.alias,
              threadId: params.threadId,
              state: registered.state,
            },
          },
        );
      }
      await this.changed();
    } catch (error) {
      if (routeBeforeRegistration !== undefined) {
        if (
          deferredEndpointRefresh &&
          registered.endpointRefresh?.outcome === "compatible"
        ) {
          try {
            await this.store.markConnectorOffline(
              registered.endpointRefresh.current,
              "CODEX_ENDPOINT_ACTIVATION_FAILED",
              [],
              { preserveQueued: true },
            );
            this.routeStates.set(params.alias, "stale");
            await this.changed();
          } catch {
            this.dashboardHealthy = false;
          }
        }
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
    this.lockCodexRegistration(params, listenerGeneration);
    // The provider may have reported its initial idle observation before this
    // binding was remembered. Explicit registration is itself an authoritative
    // wake-up point, so do not require a second route notification to release a
    // message that was already held for this exact target.
    if (registered.state === "idle") this.scheduleDispatch(params.alias);
  }

  private lockCodexRegistration(
    params: ValidatedRegisterCodexParams,
    generation = "unconfirmed",
  ): void {
    const existing = this.codexRegistrationLocks.get(params.alias);
    if (
      existing !== undefined &&
      (existing.threadId !== params.threadId ||
        existing.hostId !== params.hostId)
    ) {
      return;
    }
    const lock = Object.freeze({
      alias: params.alias,
      threadId: params.threadId,
      hostId: params.hostId,
      generation:
        generation === "unconfirmed" && existing !== undefined
          ? existing.generation
          : generation,
    });
    this.codexRegistrationLocks.set(params.alias, lock);
    if (generation !== "unconfirmed") {
      this.codexSuccessionState = createCodexRegistrationSuccession(
        lock,
      );
    }
  }

  private async rollbackCodexRegistration(
    params: ValidatedRegisterCodexParams,
    binding: PrivateRouteBinding,
    advertiseAttempted: boolean,
  ): Promise<void> {
    let cleanupFailed = false;
    try {
      await this.drainPreDeadlineDeliveryCallbacksLocked();
      const inFlightSettlements =
        await this.planRouteInFlightSettlementsLocked(params.alias, {
          unwrittenOutcome: "failed",
          safeErrorCode: "CODEX_REGISTRATION_ROLLBACK",
        });
      const settlements = await this.store.unregisterRoute(
        params.alias,
        binding.ownerLease,
        inFlightSettlements,
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
    await this.drainPreDeadlineDeliveryCallbacksLocked();
    const inFlightSettlements =
      await this.planRouteInFlightSettlementsLocked(params.alias, {
        unwrittenOutcome: "cancelled",
        safeErrorCode: "ROUTE_UNREGISTERED",
      });
    const settlements = await this.store.unregisterRoute(
      params.alias,
      lease,
      inFlightSettlements,
    );
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

  private finalizeStaleCodexOrphanRemovalLocked(alias: string): void {
    const aliases = new Set([alias]);
    this.forgetBinding(alias);
    this.purgeSuccessionTransientState(aliases);
    const lock = this.codexRegistrationLocks.get(alias);
    if (lock !== undefined) {
      this.codexRegistrationLocks.delete(alias);
      const state = this.codexSuccessionState;
      if (
        (state?.phase === "active_old" && state.active.alias === alias) ||
        (state?.phase === "active_new" && state.active.alias === alias)
      ) {
        this.codexSuccessionState = undefined;
      }
    }
    this.codexOrphanCleanupPending.delete(alias);
    this.codexSuccessionDispatchFrozen.delete(alias);
  }

  private async removeStaleCodexRegistration(alias: string): Promise<void> {
    const pendingCleanup = this.codexOrphanCleanupPending.get(alias);
    if (
      pendingCleanup !== undefined &&
      (await this.store.wasStaleCodexOrphanRemovalCommitted({
        alias,
        binding: pendingCleanup.binding,
        previousSequence: pendingCleanup.previousSequence,
      }))
    ) {
      this.finalizeStaleCodexOrphanRemovalLocked(alias);
      await this.changed();
      return;
    }
    const authority =
      await this.store.inspectStaleCodexOrphanRemovalAuthority(alias);
    const binding = authority.binding;
    const aliases = new Set([alias]);
    const resumesExactCleanup =
      pendingCleanup !== undefined &&
      bindingKey(pendingCleanup.binding) === bindingKey(binding) &&
      pendingCleanup.previousSequence === authority.previousSequence;
    if (pendingCleanup !== undefined && !resumesExactCleanup) {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_MISMATCH",
        "The stale Codex registration changed after native cleanup.",
      );
    }
    if (
      !this.codexSuccessionIsStable() ||
      this.pendingCodexSuccessionRecovery !== undefined ||
      this.codexSuccessionPoisoned.has(alias) ||
      (this.codexSuccessionDispatchFrozen.has(alias) && !resumesExactCleanup)
    ) {
      throw new BridgeError(
        "CODEX_ORPHAN_RECOVERY_BLOCKED",
        "Codex orphan recovery cannot run during registration succession.",
      );
    }
    const lock = this.codexRegistrationLocks.get(alias);
    if (
      lock !== undefined &&
      (lock.threadId !== binding.routeHandle ||
        lock.hostId !== binding.hostId ||
        lock.generation === "unconfirmed" ||
        !isCodexRegistrationGeneration(lock.generation))
    ) {
      throw new BridgeError(
        "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
        "The native Codex listener identity cannot be proven for orphan recovery.",
      );
    }

    const claudeAdapter = this.adapter("claude", binding.hostId);
    const codexAdapter = this.adapter("codex", binding.hostId);
    const currentNative = claudeAdapter.currentNativeCodexPeerGeneration;
    if (currentNative === undefined) {
      throw new BridgeError(
        "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
        "The Claude provider cannot prove whether the native Codex listener exists.",
      );
    }

    this.codexSuccessionDispatchFrozen.add(alias);
    this.scheduledDispatchTargets.delete(alias);
    let nativeGeneration: string | undefined;
    let nativeQuiesceAttempted = false;
    let irreversibleCleanupStarted = resumesExactCleanup;
    try {
      try {
        const observed = currentNative.call(claudeAdapter, alias);
        if (!isCodexRegistrationGeneration(observed)) {
          throw new BridgeError(
            "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
            "The native Codex listener generation is malformed.",
          );
        }
        if (lock !== undefined && lock.generation !== observed) {
          throw new BridgeError(
            "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
            "The native Codex listener generation changed before orphan recovery.",
          );
        }
        nativeGeneration = observed;
      } catch (error) {
        const exactAbsence =
          error instanceof BridgeError &&
          error.code === "CODEX_PEER_GENERATION_MISMATCH";
        if (!exactAbsence || (lock !== undefined && !resumesExactCleanup)) {
          if (
            error instanceof BridgeError &&
            error.code === "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN"
          ) {
            throw error;
          }
          throw new BridgeError(
            "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
            "The native Codex listener identity cannot be proven for orphan recovery.",
          );
        }
      }

      let observeNative:
        | NonNullable<
            GatewayProviderAdapter["observeNativeCodexSuccessionBarrier"]
          >
        | undefined;
      if (nativeGeneration !== undefined) {
        const quiesce = this.requireSuccessionMethod(
          claudeAdapter,
          "quiesceNativeCodexPeerGeneration",
        );
        // Require the inverse operation before acquiring the quiescence fence
        // so every pre-unadvertise failure has one exact cleanup path.
        this.requireSuccessionMethod(
          claudeAdapter,
          "resumeNativeCodexPeerGeneration",
        );
        observeNative = this.requireSuccessionMethod(
          claudeAdapter,
          "observeNativeCodexSuccessionBarrier",
        );
        nativeQuiesceAttempted = true;
        await quiesce.call(claudeAdapter, nativeGeneration);
      }

      // Join every native frame admitted before the exact generation fence,
      // and every detached terminal receipt write those frames create.
      await this.drainPreDeadlineDeliveryCallbacksLocked();
      await this.drainCallbackQueueLocked();
      await this.drainDetachedReceiptWritesLocked();
      await this.requireUnchangedStaleCodexOrphan(alias, binding);

      const observeCodex = codexAdapter.observeRouteSuccessionBarrier;
      if (observeCodex === undefined) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_BUSY",
          "The Codex provider cannot prove an empty orphan route boundary.",
        );
      }
      const beforeRelease = observeCodex.call(
        codexAdapter,
        binding.routeHandle,
      );
      if (
        beforeRelease.routePresent ||
        !this.codexRouteSuccessionQuiet(beforeRelease) ||
        beforeRelease.routeCreationInFlight ||
        beforeRelease.routeReleaseInFlight
      ) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_BUSY",
          "The stale Codex registration still has a live provider or endpoint-refresh claim.",
        );
      }
      if (nativeGeneration !== undefined) {
        const nativeBarrier = await observeNative!.call(
          claudeAdapter,
          nativeGeneration,
        );
        if (!this.nativeCodexOrphanBarrierClean(nativeBarrier, nativeGeneration)) {
          throw new BridgeError(
            "CODEX_ORPHAN_RECOVERY_BUSY",
            "The native Codex listener still owns ingress or receipt work.",
          );
        }
      }
      if (
        !this.successionServiceStateClean(aliases) ||
        !this.endpointCallbacksQuiet() ||
        this.detachedReceiptWrites.size !== 0
      ) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_BUSY",
          "The stale Codex registration still has a live service claim.",
        );
      }
      // The awaited native barrier can admit a provider-side route recovery
      // claim. Re-sample the Codex boundary after that last await and directly
      // before the generation-unqualified release call.
      const releaseBoundary = observeCodex.call(
        codexAdapter,
        binding.routeHandle,
      );
      if (
        releaseBoundary.routePresent ||
        !this.codexRouteSuccessionQuiet(releaseBoundary) ||
        releaseBoundary.routeCreationInFlight ||
        releaseBoundary.routeReleaseInFlight
      ) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_BUSY",
          "The stale Codex registration acquired a provider recovery claim before release.",
        );
      }

      // The pre-barrier proves this release targets an absent stale handle and
      // cannot join an already-observed creation. Revalidate immediately after
      // the provider join before touching the native advertisement.
      await codexAdapter.releaseRoute?.(binding.routeHandle);
      await this.drainCallbackQueueLocked();
      await this.drainDetachedReceiptWritesLocked();
      await this.requireUnchangedStaleCodexOrphan(alias, binding);
      const afterRelease = observeCodex.call(
        codexAdapter,
        binding.routeHandle,
      );
      if (
        afterRelease.routePresent ||
        !this.codexRouteSuccessionQuiet(afterRelease) ||
        afterRelease.routeCreationInFlight ||
        afterRelease.routeReleaseInFlight ||
        !this.successionServiceStateClean(aliases) ||
        !this.endpointCallbacksQuiet() ||
        this.detachedReceiptWrites.size !== 0
      ) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_BUSY",
          "The stale Codex registration changed at the provider cleanup boundary.",
        );
      }
      if (nativeGeneration !== undefined) {
        const nativeBarrier = await observeNative!.call(
          claudeAdapter,
          nativeGeneration,
        );
        if (!this.nativeCodexOrphanBarrierClean(nativeBarrier, nativeGeneration)) {
          throw new BridgeError(
            "CODEX_ORPHAN_RECOVERY_BUSY",
            "The native Codex listener changed during provider cleanup.",
          );
        }
        if (currentNative.call(claudeAdapter, alias) !== nativeGeneration) {
          throw new BridgeError(
            "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
            "The native Codex listener generation changed before removal.",
          );
        }
      }
      await this.requireUnchangedStaleCodexOrphan(alias, binding);

      if (nativeGeneration !== undefined) {
        const unadvertise = claudeAdapter.unadvertiseNativeCodexPeer;
        if (unadvertise === undefined) {
          throw new BridgeError(
            "CODEX_ORPHAN_NATIVE_IDENTITY_UNPROVEN",
            "The native Codex listener cannot be removed exactly.",
          );
        }
        irreversibleCleanupStarted = true;
        this.codexOrphanCleanupPending.set(alias, {
          binding: { ...binding },
          previousSequence: authority.previousSequence,
        });
        // The supervisor may remove the exact helper and then report an
        // ambiguous close failure. Retain retry authority before invoking the
        // irreversible operation; a retry proves whether the listener remains.
        await unadvertise.call(claudeAdapter, alias);
      }
      // Exact native absence is also an irreversible cleanup boundary: if the
      // durable mutation fails, only this same binding may resume removal.
      this.codexOrphanCleanupPending.set(alias, {
        binding: { ...binding },
        previousSequence: authority.previousSequence,
      });
      irreversibleCleanupStarted = true;
      const removed = await this.store.removeStaleCodexOrphan({ alias });
      if (bindingKey(removed.binding) !== bindingKey(binding)) {
        throw new BridgeError(
          "CODEX_ORPHAN_RECOVERY_MISMATCH",
          "The stale Codex registration changed during recovery.",
        );
      }
      this.finalizeStaleCodexOrphanRemovalLocked(alias);
      await this.changed();
    } catch (error) {
      if (!irreversibleCleanupStarted) {
        let resumeFailed = false;
        if (nativeGeneration !== undefined && nativeQuiesceAttempted) {
          try {
            const resume = this.requireSuccessionMethod(
              claudeAdapter,
              "resumeNativeCodexPeerGeneration",
            );
            await resume.call(claudeAdapter, nativeGeneration);
          } catch {
            resumeFailed = true;
            this.dashboardHealthy = false;
          }
        }
        if (!resumeFailed) {
          this.codexSuccessionDispatchFrozen.delete(alias);
          if (this.routeStates.get(alias) === "idle") {
            this.scheduleDispatch(alias);
          }
        } else {
          throw new BridgeError(
            "CODEX_ORPHAN_RECOVERY_CLEANUP_FAILED",
            "The native Codex listener could not be resumed after failed orphan recovery.",
          );
        }
      }
      throw error;
    }
  }

  private async discoveryPublicFingerprint(): Promise<string> {
    const base = await this.store.publicSnapshot();
    const snapshot = projectGatewayPublicSnapshot({
      ...base,
      availablePeers: this.availablePeers.map((peer) => ({ ...peer })),
    });
    return JSON.stringify({
      inboundMode: snapshot.inboundMode,
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
          validated: false,
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
        validated: true,
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
        await this.drainPreDeadlineDeliveryCallbacksLocked();
        const inFlightSettlements =
          await this.planRouteInFlightSettlementsLocked(alias, {
            unwrittenOutcome: "failed",
            safeErrorCode: "PEER_NOT_OBSERVED",
          });
        const settlements = await this.store.invalidateRoute(
          binding,
          "PEER_NOT_OBSERVED",
          inFlightSettlements,
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
    for (const continuation of this.providerTurnContinuations.values()) {
      if (continuation.targetAlias === oldAlias) {
        continuation.targetAlias = newAlias;
      }
    }
    for (const tracker of this.deliveryTrackers.values()) {
      if (tracker.targetAlias === oldAlias) tracker.targetAlias = newAlias;
    }
    const active = this.activeDispatchByTarget.get(oldAlias);
    if (active !== undefined) {
      this.activeDispatchByTarget.delete(oldAlias);
      this.activeDispatchByTarget.set(newAlias, active);
    }
    if (this.scheduledDispatchTargets.delete(oldAlias)) {
      // The already-created old-alias setImmediate may still run, but it can
      // only observe an empty queue. Give the renamed durable queue its own
      // runner so a rename between enqueue and dispatch cannot strand it.
      this.scheduleDispatch(newAlias);
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

  private async replaceClaudeSelectionCandidate(
    candidate: Candidate,
    retained: GatewayPrivateRouteInspection | undefined,
    retired: readonly GatewayPrivateRouteInspection[],
    alreadyLive: boolean,
  ): Promise<void> {
    await this.assertClaudeWorkspaceDisjoint(
      candidate.adapter,
      candidate.routeHandle,
    );
    const binding: PrivateRouteBinding = {
      ...candidate.adapter.identity,
      routeHandle: candidate.routeHandle,
      ownerLease: stableLease("claude", candidate.routeHandle),
    };
    const observedState = this.routeStates.get(candidate.alias);
    let selectedState: GatewayAdapterRouteState =
      observedState === undefined || observedState === "stale"
        ? candidate.state
        : observedState;
    let newlySelected = false;
    let storeCommitted = false;
    if (!alreadyLive) {
      const selected = await candidate.adapter.selectRoute({
        alias: candidate.alias,
        routeHandle: candidate.routeHandle,
      });
      newlySelected = true;
      if (selected.routeHandle !== candidate.routeHandle) {
        await candidate.adapter
          .releaseRoute?.(candidate.routeHandle)
          .catch(() => {
            this.dashboardHealthy = false;
          });
        throw new BridgeError(
          "ROUTE_MISMATCH",
          "The peer identity changed during selection.",
        );
      }
      selectedState = selected.state;
    }

    try {
      await this.drainPreDeadlineDeliveryCallbacksLocked();
      const inFlightSettlements =
        await this.planRoutesInFlightSettlementsLocked(
          retired.map((route) => route.alias),
          {
            unwrittenOutcome: "cancelled",
            safeErrorCode: "ROUTE_UNREGISTERED",
          },
        );
      const settlements = await this.store.replaceClaudeSelection({
        replacement: {
          alias: candidate.alias,
          binding,
          registrationMode: "selected_live_peer",
          state: selectedState,
          compatibility: "compatible",
        },
        inFlightSettlements,
      });
      storeCommitted = true;
      for (const settlement of settlements) {
        await this.applyTerminalSettlementLocked(settlement);
      }

      for (const route of retired) this.forgetBinding(route.alias);
      if (retained !== undefined && retained.alias !== candidate.alias) {
        this.forgetBinding(retained.alias);
      }
      this.rememberBinding(candidate.alias, binding, selectedState);
      for (const route of retired) {
        await this.adapters
          .find(
            (adapter) =>
              adapter.identity.provider === "claude" &&
              adapter.identity.hostId === route.binding.hostId,
          )
          ?.releaseRoute?.(route.binding.routeHandle)
          .catch(() => {
            this.dashboardHealthy = false;
          });
      }
    } catch (error) {
      if (newlySelected && !storeCommitted) {
        await candidate.adapter
          .releaseRoute?.(candidate.routeHandle)
          .catch(() => {
            this.dashboardHealthy = false;
          });
      }
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

  private async inferCodexAlias(codexThreadId?: string): Promise<string> {
    const candidates = (await this.store.inspectPrivateCodexRoutes()).filter(
      ({ binding }) =>
        codexThreadId === undefined || binding.routeHandle === codexThreadId,
    );
    const candidate = candidates[0];
    if (candidates.length !== 1 || candidate === undefined) {
      throw new BridgeError(
        codexThreadId === undefined
          ? "CODEX_PAIR_INFERENCE_AMBIGUOUS"
          : "CODEX_CALLER_MISMATCH",
        codexThreadId === undefined
          ? "Selecting Claude requires an inherited Codex task or exactly one registered Codex route."
          : "The inherited Codex task does not uniquely own a registered route.",
      );
    }
    return candidate.alias;
  }

  private assertCodexPairCaller(params: PairParams): void {
    const binding = this.routeBindings.get(params.codexAlias);
    if (
      binding?.provider !== "codex" ||
      (params.codexThreadId !== undefined &&
        binding.routeHandle !== params.codexThreadId)
    ) {
      throw new BridgeError(
        "CODEX_CALLER_MISMATCH",
        "The inherited Codex task does not own the requested pair endpoint.",
      );
    }
  }

  private async pairRoutes(params: PairParams): Promise<void> {
    this.assertCodexPairCaller(params);
    await this.selectAndPairClaude(params.claudeAlias, params.codexAlias);
  }

  private async unpairRoutes(params: PairParams): Promise<void> {
    this.assertCodexPairCaller(params);
    const selected = await this.selectedClaudeRoute(params.claudeAlias);
    await this.unpairClaudeRoute(selected, params.codexAlias);
  }

  private async unpairClaudeRoute(
    selected: GatewayPrivateRouteInspection,
    codexAlias: string,
  ): Promise<void> {
    await this.drainPreDeadlineDeliveryCallbacksLocked();
    const pair = {
      claudeAlias: selected.alias,
      codexAlias,
    } as const;
    const inFlightSettlements =
      await this.planPairInFlightSettlementsLocked(pair, {
        unwrittenOutcome: "cancelled",
        safeErrorCode: "PAIR_REMOVED",
      });
    const result = await this.store.unpairRoutes({
      ...pair,
      inFlightSettlements,
    });
    for (const settlement of result.settlements) {
      await this.applyTerminalSettlementLocked(settlement);
    }
    this.purgePairCapabilitiesLocked(pair);
    if (result.claudeRouteUnreferenced) {
      const settlements = await this.store.unregisterRoute(
        selected.alias,
        selected.binding.ownerLease,
      );
      for (const settlement of settlements) {
        await this.applyTerminalSettlementLocked(settlement);
      }
      this.forgetBinding(selected.alias);
      await this.adapters
        .find(
          (adapter) =>
            adapter.identity.provider === "claude" &&
            adapter.identity.hostId === selected.binding.hostId,
        )
        ?.releaseRoute?.(selected.binding.routeHandle)
        .catch(() => {
          this.dashboardHealthy = false;
        });
      this.availablePeers = this.availablePeers.map((peer) =>
        peer.alias === selected.alias ? { ...peer, selected: false } : peer,
      );
    }
    await this.changed();
  }

  private async selectClaude(params: SelectClaudeParams): Promise<void> {
    await this.selectAndPairClaude(
      params.alias,
      await this.inferCodexAlias(params.codexThreadId),
    );
  }

  private async selectAndPairClaude(
    selector: string,
    codexAlias: string,
  ): Promise<void> {
    const discoveryChanged = await this.refreshClaudeDiscovery();
    const candidate = this.claudeCandidate(selector);
    if (candidate === undefined) throw new BridgeError("PEER_NOT_FOUND", "No unique compatible interactive peer matches that current name or session UUID.");
    const persisted = await this.store.inspectPrivateClaudeRoutes();
    const byIdentity = persisted.find(
      (route) =>
        route.binding.hostId === candidate.adapter.identity.hostId &&
        route.binding.routeHandle === candidate.routeHandle,
    );
    const byAlias = persisted.find((route) => route.alias === candidate.alias);
    const live = this.routeBindings.get(candidate.alias);
    const alreadyLive =
      live?.provider === "claude" &&
      live.hostId === candidate.adapter.identity.hostId &&
      live.routeHandle === candidate.routeHandle;
    if (!alreadyLive) {
      if (byIdentity !== undefined) {
        await this.selectClaudeCandidate(candidate, byIdentity);
      } else if (byAlias !== undefined) {
        await this.replaceClaudeSelectionCandidate(
          candidate,
          undefined,
          [byAlias],
          false,
        );
      } else {
        await this.selectClaudeCandidate(candidate);
      }
    }
    let paired: { created: boolean };
    try {
      paired = await this.store.pairRoutes({
        claudeAlias: candidate.alias,
        codexAlias,
      });
    } catch (error) {
      if (
        !alreadyLive &&
        byIdentity === undefined &&
        byAlias === undefined
      ) {
        await this.rollbackFreshClaudeSelection(candidate);
      }
      await this.refreshClaudeDiscovery().catch(() => {
        this.dashboardHealthy = false;
      });
      await this.publish().catch(() => {
        this.dashboardHealthy = false;
      });
      throw error;
    }
    await this.refreshClaudeDiscovery();
    if (discoveryChanged || !alreadyLive || paired.created) await this.changed();
    else await this.publish();
  }

  private async rollbackFreshClaudeSelection(candidate: Candidate): Promise<void> {
    let cleanupFailed = false;
    try {
      await this.store.unregisterRoute(
        candidate.alias,
        stableLease("claude", candidate.routeHandle),
      );
    } catch {
      cleanupFailed = true;
    }
    this.forgetBinding(candidate.alias);
    await candidate.adapter.releaseRoute?.(candidate.routeHandle).catch(() => {
      cleanupFailed = true;
    });
    if (cleanupFailed) this.dashboardHealthy = false;
  }

  private async unselectClaude(params: SelectClaudeParams): Promise<void> {
    const codexAlias = await this.inferCodexAlias(params.codexThreadId);
    const selected = await this.selectedClaudeRoute(params.alias);
    await this.unpairClaudeRoute(selected, codexAlias);
  }

  private async selectedClaudeRoute(
    selector: string,
  ): Promise<GatewayPrivateRouteInspection> {
    const persisted = await this.store.inspectPrivateClaudeRoutes();
    const selected = CLAUDE_SESSION_ID.test(selector)
      ? persisted.find(
          (route) =>
            route.binding.routeHandle.toLowerCase() ===
            selector.toLowerCase(),
        )
      : persisted.find((route) => route.alias === selector);
    if (selected === undefined) throw new BridgeError("PEER_NOT_FOUND", "No selected Claude session matches that selector.");
    return selected;
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
      this.bindingAliases.delete(bindingKey(previous));
      this.pendingClaudeReplies.delete(bindingKey(previous));
    }
    this.routeBindings.set(alias, binding);
    this.routeStates.set(alias, state);
    this.bindingAliases.set(bindingKey(binding), alias);
    if (binding.provider === "claude" && state === "idle") {
      this.claudePrewriteIdleWaitTargets.delete(alias);
    }
  }

  private forgetBinding(alias: string): void {
    const heldTimer = this.heldRedispatchTimers.get(alias);
    if (heldTimer !== undefined) {
      this.timers.clearTimeout(heldTimer);
      this.heldRedispatchTimers.delete(alias);
    }
    const binding = this.routeBindings.get(alias);
    if (binding !== undefined) {
      this.bindingAliases.delete(bindingKey(binding));
      this.pendingClaudeReplies.delete(bindingKey(binding));
    }
    this.routeBindings.delete(alias);
    this.routeStates.delete(alias);
    this.claudePrewriteIdleWaitTargets.delete(alias);
    for (const [messageId, continuation] of this.providerTurnContinuations) {
      if (continuation.targetAlias !== alias) continue;
      this.providerTurnContinuations.delete(messageId);
      if (this.activeDispatchByTarget.get(alias) === messageId) {
        this.activeDispatchByTarget.delete(alias);
      }
      const conversation = this.conversations.get(continuation.conversationId);
      this.releasePendingClaude(conversation);
      this.nativeIngressByConversation.delete(continuation.conversationId);
      this.addRuntimeAlert("PROVIDER_TURN_ROUTE_REMOVED", "warning", {
        alias,
      });
    }
  }

  private async verifyCodex(alias: string, threadId: string): Promise<PrivateRouteBinding> {
    const binding = await this.store.resolveRoute(alias);
    if (binding.provider !== "codex" || binding.routeHandle !== threadId) throw new BridgeError("ROUTE_MISMATCH", "The caller does not own this exact task route.");
    const state = this.routeStates.get(alias);
    if (state === undefined || state === "stale") {
      throw new BridgeError(
        "ROUTE_UNAVAILABLE",
        "The caller's exact Codex route is not positively observed.",
        true,
      );
    }
    const adapter = this.adapter("codex", binding.hostId);
    await this.store.observeConnector({
      identity: adapter.identity,
      health: "healthy",
      compatibility: "compatible",
      protocol: adapter.protocol,
      protocolVersion: adapter.protocolVersion,
    });
    await this.store.observeRoute({
      binding,
      state,
      compatibility: "compatible",
    });
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
            this.isTerminalDeliveryState(tracker.machine),
        )
        .sort(
          (left, right) =>
            (isTerminalDeliveryMachine(left.machine)
              ? left.machine.terminalAt
              : left.updatedAt) -
              (isTerminalDeliveryMachine(right.machine)
                ? right.machine.terminalAt
                : right.updatedAt) ||
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
    nativeReceipt?: NativeReceiptTracker;
  }): void {
    const deadlineAt = Date.parse(input.deadlineAt);
    const stallAt = Math.min(
      input.enqueuedAt + this.config.stallNoticeMs,
      deadlineAt - 1,
    );
    const nativeHeldNextAttemptAt = Math.min(
      input.enqueuedAt + NATIVE_HELD_THRESHOLD_MS,
      deadlineAt - 1,
    );
    const tracker: MessageDeliveryTracker = {
      messageId: input.messageId,
      conversationId: input.conversationId,
      targetAlias: input.targetAlias,
      enqueuedAt: input.enqueuedAt,
      deadlineAt,
      machine: createDeliveryMachine({
        enqueuedAt: input.enqueuedAt,
        stallAt,
        deadlineAt,
        // Deferred means the provider proved no write. Permit one bounded
        // attempt per 500 ms slice until this message's immutable deadline.
        maxCleanPrewriteRetries: Math.max(
          0,
          Math.ceil((deadlineAt - input.enqueuedAt) / 500),
        ),
        nativeReceipt: input.nativeReceipt !== undefined,
        maxNativeReceiptCleanPrewriteRetries:
          DELIVERY_ACK_RETRY_DELAYS_MS.length,
      }),
      updatedAt: input.enqueuedAt,
      stallNoticeSent: false,
      stallNoticeAttempt: 0,
      stallNoticeNextAttemptAt: stallAt,
      nativeHeldSent: false,
      nativeHeldAttempt: 0,
      nativeHeldNextAttemptAt,
      ...(input.deliveryToken === undefined
        ? {}
        : { deliveryToken: input.deliveryToken }),
      ...(input.nativeReceipt === undefined
        ? {}
        : { nativeReceipt: { ...input.nativeReceipt } }),
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
    state: DeliveryMachine,
  ): state is Extract<DeliveryMachine, { phase: "terminal" }> {
    return isTerminalDeliveryMachine(state);
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
      if (!this.isTerminalDeliveryState(tracker.machine)) continue;
      const tokenExpired =
        tracker.deliveryToken === undefined ||
        tracker.machine.terminalAt + retentionMs <= now;
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

  private async releaseNativeReceiptLocked(
    tracker: MessageDeliveryTracker,
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
  }

  /**
   * Native `held` is progress, not terminal delivery or approval. Emit it
   * only after this exact message is known to be waiting, or after its prompt
   * dispatch threshold elapses. A clean pre-write may retry; an ambiguous
   * write is never replayed, and neither path consumes the terminal receipt.
   */
  private async publishNativeHeldLocked(
    tracker: MessageDeliveryTracker,
  ): Promise<boolean> {
    const receipt = tracker.nativeReceipt;
    if (
      receipt === undefined ||
      tracker.nativeHeldSent ||
      isTerminalDeliveryMachine(tracker.machine) ||
      this.now().getTime() >= tracker.deadlineAt
    ) {
      return false;
    }
    const now = this.now().getTime();
    tracker.nativeHeldAttempt += 1;
    try {
      const adapter = this.adapter("claude", receipt.hostId);
      const update = adapter.updateNativeInboundStatus;
      if (update === undefined) {
        throw new BridgeError(
          "NATIVE_RECEIPT_TRANSPORT_UNAVAILABLE",
          "The Claude adapter cannot publish native held progress.",
        );
      }
      await update.call(adapter, receipt.receiptHandle, "held");
      tracker.nativeHeldSent = true;
      return true;
    } catch (error) {
      const cleanPrewrite = error instanceof BridgeError && error.recoverable;
      const delay =
        DELIVERY_ACK_RETRY_DELAYS_MS[
          Math.min(
            tracker.nativeHeldAttempt - 1,
            DELIVERY_ACK_RETRY_DELAYS_MS.length - 1,
          )
        ] ?? DELIVERY_ACK_RETRY_DELAYS_MS.at(-1) ?? 2_000;
      const retryAt = now + delay;
      if (
        cleanPrewrite &&
        tracker.nativeHeldAttempt <= DELIVERY_ACK_RETRY_DELAYS_MS.length &&
        retryAt < tracker.deadlineAt
      ) {
        tracker.nativeHeldNextAttemptAt = retryAt;
        this.scheduleLifecycleWakeLocked();
        return true;
      }
      // The write may already have reached the sender. Mark this progress
      // attempt complete locally so no later timer can downgrade a terminal
      // acknowledgement or replay an ambiguous frame.
      tracker.nativeHeldSent = true;
      this.addRuntimeAlert("NATIVE_HELD_NOTICE_UNCONFIRMED", "warning", {
        provider: "claude",
        host: receipt.hostId,
        alias: tracker.targetAlias,
      });
      return true;
    }
  }

  private nativeReceiptNotificationFor(
    tracker: MessageDeliveryTracker,
  ): NativeReceiptNotification | undefined {
    if (!isTerminalDeliveryMachine(tracker.machine)) return undefined;
    return tracker.machine.outcome === "delivered"
      ? { status: "delivered" }
      : {
          status: "expired",
          diagnosticCode:
            tracker.deliverySafeErrorCode ??
            (tracker.machine.outcome === "unconfirmed"
              ? "DELIVERY_UNCONFIRMED"
              : `DELIVERY_${tracker.machine.outcome.toUpperCase()}`),
        };
  }

  private async sendNativeReceiptLocked(
    tracker: MessageDeliveryTracker,
  ): Promise<boolean> {
    const receipt = tracker.nativeReceipt;
    const native = tracker.machine.nativeReceipt;
    const notification = this.nativeReceiptNotificationFor(tracker);
    if (
      receipt === undefined ||
      native.phase !== "sending" ||
      notification === undefined
    ) {
      return false;
    }
    const now = this.now().getTime();
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
        notification.status,
        notification.status === "expired"
          ? notification.diagnosticCode
          : undefined,
      );
      await this.advanceDeliveryLocked(tracker.messageId, {
        type: "native_receipt_confirmed",
        at: now,
      });
      return true;
    } catch (error) {
      const cleanPrewrite = error instanceof BridgeError && error.recoverable;
      const delay =
        DELIVERY_ACK_RETRY_DELAYS_MS[
          Math.min(
            native.attempt - 1,
            DELIVERY_ACK_RETRY_DELAYS_MS.length - 1,
          )
        ] ?? DELIVERY_ACK_RETRY_DELAYS_MS.at(-1) ?? 2_000;
      const nextAttemptAt = now + delay;
      await this.advanceDeliveryLocked(
        tracker.messageId,
        cleanPrewrite
          ? {
              type: "native_receipt_clean_prewrite_failed",
              at: now,
              retryAt: nextAttemptAt,
            }
          : { type: "native_receipt_ambiguous", at: now },
      );
      return true;
    }
  }

  private deliveryCorrelation(
    messageId: string,
  ): MessageContext | ProviderTurnContinuation | undefined {
    return (
      this.messageContexts.get(messageId) ??
      this.providerTurnContinuations.get(messageId)
    );
  }

  private eventTime(event: DeliveryEvent): number {
    if ("observedAt" in event) return event.observedAt;
    return event.at;
  }

  private normalizeDeliverySafeCode(
    tracker: MessageDeliveryTracker,
    outcome: DeliveryTerminalOutcome,
    candidate: string | undefined,
  ): string | undefined {
    const normalized =
      candidate === undefined
        ? undefined
        : safeCode(candidate, "PROVIDER_DELIVERY_FAILED");
    if (outcome !== "unconfirmed") return normalized;
    const correlation = this.deliveryCorrelation(tracker.messageId);
    const target =
      correlation === undefined
        ? undefined
        : this.contextTargetBinding(correlation);
    return target?.provider === "claude"
      ? "CLAUDE_RECEIPT_UNCONFIRMED"
      : (normalized ?? "DELIVERY_UNCONFIRMED");
  }

  private async planRouteInFlightSettlementsLocked(
    alias: string,
    input: {
      unwrittenOutcome: "cancelled" | "failed";
      safeErrorCode: string;
    },
  ): Promise<RouteInFlightSettlementInput[]> {
    return await this.planRoutesInFlightSettlementsLocked([alias], input);
  }

  private async planRoutesInFlightSettlementsLocked(
    aliases: readonly string[],
    input: {
      unwrittenOutcome: "cancelled" | "failed";
      safeErrorCode: string;
    },
  ): Promise<RouteInFlightSettlementInput[]> {
    const affected = await this.store.inspectAffectedInFlightMessages(aliases);
    const observedAt = this.now().getTime();
    return affected.map(({ messageId }) => {
      const tracker = this.deliveryTrackers.get(messageId);
      if (tracker === undefined) {
        return {
          messageId,
          // In-flight without its reducer means write evidence is unknowable;
          // never downgrade that corruption to a proven clean cancellation.
          state: "ambiguous",
          safeErrorCode: "DELIVERY_TRACKER_MISSING",
        };
      }
      const event =
        tracker.pendingTerminalEvent ??
        ({
          type: "route_terminated",
          at: observedAt,
          unwrittenOutcome: input.unwrittenOutcome,
          safeErrorCode: input.safeErrorCode,
        } satisfies DeliveryEvent);
      const transition = transitionDelivery(tracker.machine, event);
      const settlement = transition.effects.find(
        (
          effect,
        ): effect is Extract<DeliveryEffect, { type: "settle_delivery" }> =>
          effect.type === "settle_delivery",
      );
      if (settlement === undefined) {
        throw new BridgeError(
          "ROUTE_TERMINATION_STATE_MISMATCH",
          "An affected in-flight delivery could not produce an exact terminal route settlement.",
          true,
        );
      }
      const safeErrorCode = this.normalizeDeliverySafeCode(
        tracker,
        settlement.outcome,
        settlement.safeErrorCode,
      );
      return {
        messageId,
        state: settlement.outcome,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      };
    });
  }

  private async planPairInFlightSettlementsLocked(
    pair: { claudeAlias: string; codexAlias: string },
    input: {
      unwrittenOutcome: "cancelled" | "failed";
      safeErrorCode: string;
    },
  ): Promise<RouteInFlightSettlementInput[]> {
    const affected =
      await this.store.inspectAffectedPairInFlightMessages(pair);
    const observedAt = this.now().getTime();
    return affected.map(({ messageId }) => {
      const tracker = this.deliveryTrackers.get(messageId);
      if (tracker === undefined) {
        return {
          messageId,
          state: "ambiguous",
          safeErrorCode: "DELIVERY_TRACKER_MISSING",
        };
      }
      const event =
        tracker.pendingTerminalEvent ??
        ({
          type: "route_terminated",
          at: observedAt,
          unwrittenOutcome: input.unwrittenOutcome,
          safeErrorCode: input.safeErrorCode,
        } satisfies DeliveryEvent);
      const transition = transitionDelivery(tracker.machine, event);
      const settlement = transition.effects.find(
        (
          effect,
        ): effect is Extract<DeliveryEffect, { type: "settle_delivery" }> =>
          effect.type === "settle_delivery",
      );
      if (settlement === undefined) {
        throw new BridgeError(
          "PAIR_TERMINATION_STATE_MISMATCH",
          "An affected in-flight delivery could not produce an exact terminal pair settlement.",
          true,
        );
      }
      const safeErrorCode = this.normalizeDeliverySafeCode(
        tracker,
        settlement.outcome,
        settlement.safeErrorCode,
      );
      return {
        messageId,
        state: settlement.outcome,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      };
    });
  }

  private purgePairCapabilitiesLocked(pair: {
    claudeAlias: string;
    codexAlias: string;
  }): void {
    const matches = (sourceAlias: string, targetAlias: string): boolean =>
      (sourceAlias === pair.claudeAlias && targetAlias === pair.codexAlias) ||
      (sourceAlias === pair.codexAlias && targetAlias === pair.claudeAlias);
    const conversationIds = new Set<string>();
    for (const [conversationId, conversation] of this.conversations) {
      if (
        conversation.pair !== true ||
        !matches(conversation.sourceAlias, conversation.targetAlias)
      ) {
        continue;
      }
      conversationIds.add(conversationId);
      this.conversations.delete(conversationId);
    }
    for (const [messageId, context] of this.messageContexts) {
      if (!conversationIds.has(context.conversationId)) continue;
      this.messageContexts.delete(messageId);
      if (this.activeDispatchByTarget.get(context.targetAlias) === messageId) {
        this.activeDispatchByTarget.delete(context.targetAlias);
      }
    }
    for (const [messageId, continuation] of this.providerTurnContinuations) {
      if (!conversationIds.has(continuation.conversationId)) continue;
      this.providerTurnContinuations.delete(messageId);
      if (
        this.activeDispatchByTarget.get(continuation.targetAlias) === messageId
      ) {
        this.activeDispatchByTarget.delete(continuation.targetAlias);
      }
    }
    for (const [key, pending] of this.pendingClaudeReplies) {
      if (conversationIds.has(pending.conversationId)) {
        this.pendingClaudeReplies.delete(key);
      }
    }
    for (const conversationId of conversationIds) {
      this.nativeIngressByConversation.delete(conversationId);
    }
  }

  private async settleDeliveryStoreLocked(
    tracker: MessageDeliveryTracker,
    outcome: DeliveryTerminalOutcome,
    safeErrorCode?: string,
  ): Promise<TerminalMessageSettlement | undefined> {
    if (
      outcome === "failed" ||
      outcome === "expired" ||
      outcome === "cancelled"
    ) {
      const queued = await this.store.settleQueuedMessage({
        messageId: tracker.messageId,
        state: outcome,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      });
      if (queued.status === "settled") return queued.settlement;
    }
    const settled = await this.store.settleMessage({
      messageId: tracker.messageId,
      state: outcome,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    });
    return settled.status === "settled" ? settled.settlement : undefined;
  }

  private async publishStallNoticeLocked(
    tracker: MessageDeliveryTracker,
    queuedForMs: number,
  ): Promise<void> {
    const receipt = tracker.nativeReceipt;
    if (receipt === undefined) {
      tracker.stallNoticeSent = true;
      return;
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
        queuedForMs,
      });
      tracker.stallNoticeSent = true;
    } catch (error) {
      const cleanPrewrite = error instanceof BridgeError && error.recoverable;
      tracker.stallNoticeAttempt += 1;
      const delay =
        DELIVERY_ACK_RETRY_DELAYS_MS[
          Math.min(
            tracker.stallNoticeAttempt - 1,
            DELIVERY_ACK_RETRY_DELAYS_MS.length - 1,
          )
        ] ?? DELIVERY_ACK_RETRY_DELAYS_MS.at(-1) ?? 2_000;
      const retryAt = this.now().getTime() + delay;
      if (
        cleanPrewrite &&
        tracker.stallNoticeAttempt <= DELIVERY_ACK_RETRY_DELAYS_MS.length &&
        retryAt < tracker.deadlineAt
      ) {
        tracker.stallNoticeNextAttemptAt = retryAt;
        return;
      }
      tracker.stallNoticeSent = true;
      this.addRuntimeAlert("NATIVE_STALL_NOTICE_UNCONFIRMED", "warning", {
        provider: "claude",
        host: receipt.hostId,
        alias: tracker.targetAlias,
      });
    }
  }

  private async applyDeliveryEffectsLocked(
    tracker: MessageDeliveryTracker,
    effects: readonly DeliveryEffect[],
    suppliedSettlement?: TerminalMessageSettlement,
  ): Promise<MessageContext | undefined> {
    let terminalContext: MessageContext | undefined;
    for (const effect of effects) {
      if (effect.type === "dispatch") {
        // dispatchOne owns provider I/O. This effect is the reducer's proof
        // that the exact attempt was authorized, not a second dispatch call.
        continue;
      }
      if (effect.type === "record_progress") {
        if (effect.progress !== "transport_uncertain") {
          await this.store
            .markMessageProgress(tracker.messageId, effect.progress)
            .catch(() => undefined);
        }
        continue;
      }
      if (effect.type === "publish_stall") {
        await this.publishStallNoticeLocked(tracker, effect.pendingForMs);
        continue;
      }
      if (effect.type === "settle_delivery") {
        const code = this.normalizeDeliverySafeCode(
          tracker,
          effect.outcome,
          effect.safeErrorCode,
        );
        if (code === undefined) delete tracker.deliverySafeErrorCode;
        else tracker.deliverySafeErrorCode = code;
        const settlement =
          suppliedSettlement ??
          (await this.settleDeliveryStoreLocked(
            tracker,
            effect.outcome,
            code,
          ));
        if (settlement !== undefined) {
          const settledCode = this.normalizeDeliverySafeCode(
            tracker,
            effect.outcome,
            settlement.safeErrorCode ?? code,
          );
          if (settledCode === undefined) delete tracker.deliverySafeErrorCode;
          else tracker.deliverySafeErrorCode = settledCode;
        }
        terminalContext = this.takeMessageContextLocked(
          tracker.messageId,
          effect.outcome,
          this.providerTurnContinuations.has(tracker.messageId),
        );
        continue;
      }
      if (effect.type === "send_native_receipt") {
        await this.sendNativeReceiptLocked(tracker);
        continue;
      }
      if (effect.type === "release_native_receipt") {
        await this.releaseNativeReceiptLocked(tracker);
      }
      // Retry effects are projected into the one lifecycle timer below.
    }
    if (
      isTerminalDeliveryMachine(tracker.machine) &&
      tracker.deliveryToken === undefined &&
      tracker.nativeReceipt === undefined
    ) {
      this.deliveryTrackers.delete(tracker.messageId);
    }
    return terminalContext;
  }

  private async advanceDeliveryLocked(
    messageId: string,
    event: DeliveryEvent,
    suppliedSettlement?: TerminalMessageSettlement,
    terminalReplyText?: string,
  ): Promise<MessageContext | undefined> {
    const tracker = this.deliveryTrackers.get(messageId);
    if (tracker === undefined) return undefined;
    // A pre-observed terminal event whose ledger write failed retains
    // precedence over later lifecycle events. If the store has already
    // supplied a different authoritative settlement, mirror that proof.
    const hasSuppliedSettlement = suppliedSettlement !== undefined;
    const resolvingPendingTerminal =
      tracker.pendingTerminalEvent !== undefined;
    const transitionEvent =
      tracker.pendingTerminalEvent !== undefined && !hasSuppliedSettlement
        ? tracker.pendingTerminalEvent
        : event;
    let transition = transitionDelivery(tracker.machine, transitionEvent);
    if (transition.state === tracker.machine && transition.effects.length === 0) {
      return undefined;
    }
    const settlementEffect = transition.effects.find(
      (effect): effect is Extract<DeliveryEffect, { type: "settle_delivery" }> =>
        effect.type === "settle_delivery",
    );
    let authoritativeSettlement = suppliedSettlement;
    if (settlementEffect !== undefined && authoritativeSettlement === undefined) {
      const code = this.normalizeDeliverySafeCode(
        tracker,
        settlementEffect.outcome,
        settlementEffect.safeErrorCode,
      );
      try {
        authoritativeSettlement = await this.settleDeliveryStoreLocked(
          tracker,
          settlementEffect.outcome,
          code,
        );
        if (authoritativeSettlement === undefined) {
          throw new BridgeError(
            "DELIVERY_SETTLEMENT_UNAVAILABLE",
            "The delivery ledger could not find the accepted message to settle.",
            true,
          );
        }
      } catch (error) {
        const firstFailure = tracker.pendingTerminalEvent === undefined;
        tracker.pendingTerminalEvent ??= transitionEvent;
        if (firstFailure && terminalReplyText !== undefined) {
          tracker.pendingTerminalReplyText = terminalReplyText;
        }
        tracker.settlementRetryAt =
          this.now().getTime() + DELIVERY_SETTLEMENT_RETRY_MS;
        if (firstFailure) {
          this.addRuntimeAlert("DELIVERY_SETTLEMENT_RETRY", "error", {
            alias: tracker.targetAlias,
          });
        }
        this.scheduleLifecycleWakeLocked();
        throw error;
      }
    }
    if (settlementEffect !== undefined && authoritativeSettlement !== undefined) {
      const authoritativeOutcome = this.settlementDeliveryState(
        authoritativeSettlement,
      );
      if (
        authoritativeOutcome !== settlementEffect.outcome ||
        authoritativeSettlement.safeErrorCode !==
          settlementEffect.safeErrorCode
      ) {
        transition = transitionDelivery(tracker.machine, {
          type: "external_settlement",
          at: this.eventTime(transitionEvent),
          outcome: authoritativeOutcome,
          ...(authoritativeSettlement.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: authoritativeSettlement.safeErrorCode }),
        });
      }
    }
    tracker.machine = transition.state;
    tracker.updatedAt = isTerminalDeliveryMachine(transition.state)
      ? transition.state.terminalAt
      : this.eventTime(transitionEvent);
    delete tracker.pendingTerminalEvent;
    delete tracker.settlementRetryAt;
    const context = await this.applyDeliveryEffectsLocked(
      tracker,
      transition.effects,
      authoritativeSettlement,
    );
    if (resolvingPendingTerminal) {
      const replyText = tracker.pendingTerminalReplyText;
      delete tracker.pendingTerminalReplyText;
      if (
        isTerminalDeliveryMachine(tracker.machine) &&
        tracker.machine.outcome === "delivered"
      ) {
        await this.finishDeliveredReplyLocked(context, replyText);
      }
      return undefined;
    }
    if (hasSuppliedSettlement) {
      delete tracker.pendingTerminalReplyText;
    }
    if (tracker.machine.nativeReceipt.phase === "confirmed") {
      delete tracker.nativeReceipt;
      if (
        isTerminalDeliveryMachine(tracker.machine) &&
        tracker.deliveryToken === undefined
      ) {
        this.deliveryTrackers.delete(tracker.messageId);
      }
    }
    return context;
  }

  private async applyTerminalSettlementLocked(
    settlement: TerminalMessageSettlement,
  ): Promise<MessageContext | undefined> {
    const state = this.settlementDeliveryState(settlement);
    if (!this.deliveryTrackers.has(settlement.messageId)) {
      const context = this.takeMessageContextLocked(
        settlement.messageId,
        state,
      );
      for (const [token, messageId] of this.deliveryTokens) {
        if (messageId === settlement.messageId) this.deliveryTokens.delete(token);
      }
      this.addRuntimeAlert("DELIVERY_TRACKER_MISSING", "error", {
        ...(context === undefined ? {} : { alias: context.targetAlias }),
      });
      return context;
    }
    return await this.advanceDeliveryLocked(
      settlement.messageId,
      {
        type: "external_settlement",
        at: this.now().getTime(),
        outcome: state,
        ...(settlement.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: settlement.safeErrorCode }),
      },
      settlement,
    );
  }

  private takeMessageContextLocked(
    messageId: string,
    state: DeliveryTerminalState,
    retainProviderTurn = false,
  ): MessageContext | undefined {
    const context = this.messageContexts.get(messageId);
    if (context === undefined) return undefined;
    this.messageContexts.delete(messageId);
    if (
      !retainProviderTurn &&
      this.activeDispatchByTarget.get(context.targetAlias) ===
      messageId
    ) {
      this.activeDispatchByTarget.delete(context.targetAlias);
      if (!this.closing) this.scheduleDispatch(context.targetAlias);
    }
    const conversation = this.conversations.get(context.conversationId);
    // Ambiguity remains active in the reducer until the immutable deadline;
    // once it becomes terminal there is no remaining reply window to own.
    if (state !== "delivered") {
      this.releasePendingClaude(conversation);
    }
    if (state !== "delivered") {
      this.nativeIngressByConversation.delete(context.conversationId);
    } else if (!context.expectsReply) {
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
    const context = this.messageContexts.get(messageId);
    if (context === undefined) return false;
    if (!context.expectsReply) {
      this.nativeIngressByConversation.delete(context.conversationId);
    }
    this.providerTurnContinuations.set(messageId, { ...context });
    await this.advanceDeliveryLocked(messageId, {
      type: "provider_released",
      observedAt: this.now().getTime(),
    });
    if (
      !this.messageContexts.has(messageId) &&
      this.providerTurnContinuations.has(messageId)
    ) {
      return true;
    }
    this.providerTurnContinuations.delete(messageId);
    return false;
  }

  private stallReasonFor(
    tracker: MessageDeliveryTracker,
  ):
    | "ROUTE_BUSY"
    | "ROUTE_UNAVAILABLE"
    | "CODEX_ROUTE_STALE"
    | "AWAITING_EXTERNAL_APPROVAL" {
    const state = this.routeStates.get(tracker.targetAlias);
    if (state === "awaiting_approval") return "AWAITING_EXTERNAL_APPROVAL";
    if (state === "stale") return "CODEX_ROUTE_STALE";
    if (state === "busy") return "ROUTE_BUSY";
    return "ROUTE_UNAVAILABLE";
  }

  private async refreshNextProgressWatchWakeLocked(): Promise<void> {
    const next = await this.store.nextProgressWatchActionAt();
    const parsed = next === undefined ? Number.NaN : Date.parse(next);
    this.nextProgressWatchAt = Number.isFinite(parsed) ? parsed : undefined;
  }

  private async processProgressWatchesLocked(now: number): Promise<boolean> {
    if (
      this.nextProgressWatchAt === undefined ||
      this.nextProgressWatchAt > now
    ) {
      return false;
    }
    const actions = await this.store.advanceDueProgressWatches();
    let changed = actions.length > 0;
    for (const action of actions) {
      if (action.type === "settled") {
        this.addRuntimeAlert(
          action.outcome === "unresponsive"
            ? "PROGRESS_WATCH_UNRESPONSIVE"
            : "PROGRESS_WATCH_ENDPOINT_RETIRED",
          action.outcome === "unresponsive" ? "error" : "warning",
          { alias: action.ownerAlias },
        );
        continue;
      }
      if (action.type === "notify_capability_degraded") {
        this.addRuntimeAlert("PROGRESS_WATCH_CAPABILITY_DEGRADED", "warning", {
          alias: action.ownerAlias,
        });
        continue;
      }
      const text =
        `[Embassy automated liveness check — ${action.conversationId} / ` +
        `Embassy 自动活跃检查 — ${action.conversationId}]\n` +
        "Reply with the result or a status. / 请回复结果或状态。";
      try {
        await this.enqueue(
          action.ownerAlias,
          action.workerAlias,
          text,
          false,
          {
            existingConversationId: action.conversationId,
            exposeDeliveryToken: false,
            skipProgressWatchActivity: true,
            progressWatchNudge: {
              conversationId: action.conversationId,
              nudgeNumber: action.nudgeNumber,
            },
          },
        );
        this.addRuntimeAlert("PROGRESS_WATCH_NUDGE", "warning", {
          alias: action.ownerAlias,
        });
      } catch {
        await this.store.deferProgressWatchNudge(action.conversationId);
        this.addRuntimeAlert("PROGRESS_WATCH_NUDGE_DEFERRED", "warning", {
          alias: action.ownerAlias,
        });
        changed = true;
      }
    }
    await this.refreshNextProgressWatchWakeLocked();
    return changed;
  }

  private async processLifecycleLocked(): Promise<boolean> {
    const now = this.now().getTime();
    let changed = false;
    if (await this.processProgressWatchesLocked(now)) changed = true;
    await this.drainPreDeadlineDeliveryCallbacksLocked();
    for (const tracker of this.deliveryTrackers.values()) {
      if (tracker.pendingTerminalEvent !== undefined) {
        if ((tracker.settlementRetryAt ?? 0) <= now) {
          await this.advanceDeliveryLocked(
            tracker.messageId,
            tracker.pendingTerminalEvent,
          );
          changed = true;
        }
        if (tracker.pendingTerminalEvent !== undefined) continue;
      }
      if (!isTerminalDeliveryMachine(tracker.machine)) {
        const wakeups = projectDeliveryWakeups(tracker.machine);
        if (wakeups.stallAt !== undefined && wakeups.stallAt <= now) {
          await this.advanceDeliveryLocked(tracker.messageId, {
            type: "stall_due",
            at: now,
          });
          changed = true;
        }
        if (
          !isTerminalDeliveryMachine(tracker.machine) &&
          tracker.machine.dispatchRetryAt !== null &&
          tracker.machine.dispatchRetryAt <= now &&
          !this.claudePrewriteIdleWaitTargets.has(tracker.targetAlias)
        ) {
          if (!this.dispatchRunnerTargets.has(tracker.targetAlias)) {
            this.scheduleDispatch(tracker.targetAlias);
          }
        }
        if (
          !isTerminalDeliveryMachine(tracker.machine) &&
          tracker.deadlineAt <= now
        ) {
          await this.advanceDeliveryLocked(tracker.messageId, {
            type: "deadline_due",
            at: now,
          });
          changed = true;
        }
      }
      if (
        tracker.machine.stall === "emitted" &&
        !tracker.stallNoticeSent &&
        tracker.stallNoticeNextAttemptAt <= now &&
        !isTerminalDeliveryMachine(tracker.machine)
      ) {
        await this.publishStallNoticeLocked(
          tracker,
          Math.max(0, now - tracker.enqueuedAt),
        );
        changed = true;
      }
      if (
        !isTerminalDeliveryMachine(tracker.machine) &&
        tracker.nativeReceipt !== undefined &&
        !tracker.nativeHeldSent &&
        tracker.nativeHeldNextAttemptAt <= now
      ) {
        if (await this.publishNativeHeldLocked(tracker)) changed = true;
      }
      const receiptRetryAt = projectDeliveryWakeups(
        tracker.machine,
      ).nativeReceiptRetryAt;
      if (receiptRetryAt !== undefined && receiptRetryAt <= now) {
        await this.advanceDeliveryLocked(tracker.messageId, {
          type: "native_receipt_retry_due",
          at: now,
        });
        changed = true;
      }
    }
    for (const [messageId, continuation] of this.providerTurnContinuations) {
      if (Date.parse(continuation.deadlineAt) > now) continue;
      await this.finishProviderTurnContinuationLocked(messageId, "expired");
      this.addRuntimeAlert("PROVIDER_REPLY_DEADLINE_EXPIRED", "warning", {
        alias: continuation.targetAlias,
      });
      changed = true;
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
      const wakeups = projectDeliveryWakeups(tracker.machine);
      if (tracker.settlementRetryAt !== undefined) {
        consider(tracker.settlementRetryAt);
      }
      if (!isTerminalDeliveryMachine(tracker.machine)) {
        hasNonterminal = true;
        if (wakeups.stallAt !== undefined) consider(wakeups.stallAt);
        if (
          tracker.machine.stall === "emitted" &&
          !tracker.stallNoticeSent
        ) {
          consider(tracker.stallNoticeNextAttemptAt);
        }
        if (
          tracker.nativeReceipt !== undefined &&
          !tracker.nativeHeldSent
        ) {
          consider(tracker.nativeHeldNextAttemptAt);
        }
        if (wakeups.deadlineAt !== undefined) consider(wakeups.deadlineAt);
        if (
          wakeups.dispatchRetryAt !== undefined &&
          !this.claudePrewriteIdleWaitTargets.has(tracker.targetAlias) &&
          !this.scheduledDispatchTargets.has(tracker.targetAlias) &&
          !this.dispatchRunnerTargets.has(tracker.targetAlias)
        ) {
          consider(wakeups.dispatchRetryAt);
        }
      }
      if (wakeups.nativeReceiptRetryAt !== undefined) {
        consider(wakeups.nativeReceiptRetryAt);
      }
      if (
        isTerminalDeliveryMachine(tracker.machine) &&
        tracker.deliveryToken !== undefined
      ) {
        consider(
          tracker.machine.terminalAt +
            Math.max(60_000, this.config.limits.messageDeadlineMs * 2),
        );
      }
    }
    // Provider acceptance may settle the original body while its bounded
    // reply correlation remains live; plain pending stays nonterminal. Keep
    // every retained reply context's deadline scheduled independently.
    for (const continuation of this.providerTurnContinuations.values()) {
      const deadlineAt = Date.parse(continuation.deadlineAt);
      if (Number.isFinite(deadlineAt)) consider(deadlineAt);
    }
    if (this.nextProgressWatchAt !== undefined) {
      consider(this.nextProgressWatchAt);
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
      const projection = projectDelivery(tracker.machine, this.now().getTime());
      const terminal = projection.terminal;
      return {
        found: true,
        state: terminal
          ? projection.outcome!
          : projection.stalled
            ? "stalled"
            : "queued",
        terminal,
        updatedAt: new Date(tracker.updatedAt).toISOString(),
        deadlineAt: new Date(tracker.deadlineAt).toISOString(),
        ...(!terminal
          ? { pendingForMs: Math.max(0, this.now().getTime() - tracker.enqueuedAt) }
          : {}),
        ...(tracker.deliverySafeErrorCode === undefined
          ? {}
          : { safeErrorCode: tracker.deliverySafeErrorCode }),
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
          params.trackIdleMinutes === undefined
            ? {}
            : { trackIdleMinutes: params.trackIdleMinutes },
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
        const steer =
          this.config.steeringEnabled && params.text.startsWith("STEER:");
        return this.acceptedControlResult(
          await this.enqueue(
            params.fromAlias,
            params.toAlias,
            params.text,
            steer ? false : params.expectsReply,
            {
              ...(steer ? { steer: true as const } : {}),
              ...(params.trackIdleMinutes === undefined
                ? {}
                : { trackIdleMinutes: params.trackIdleMinutes }),
            },
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
                true,
                params.trackIdleMinutes,
              )
            : await this.enqueue(
                from,
                to,
                params.text,
                false,
                {
                  existingConversationId: conversation.id,
                  ...(params.trackIdleMinutes === undefined
                    ? {}
                    : { trackIdleMinutes: params.trackIdleMinutes }),
                },
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
    options: {
      existingConversationId?: string;
      exposeDeliveryToken?: boolean;
      steer?: true;
      trackIdleMinutes?: number;
      skipProgressWatchActivity?: true;
      progressWatchNudge?: {
        conversationId: string;
        nudgeNumber: 1 | 2;
      };
    } = {},
  ): Promise<EnqueuedMessageResult> {
    if (
      this.codexSuccessionPoisoned.has(sourceAlias) ||
      this.codexSuccessionPoisoned.has(targetAlias)
    ) {
      throw new BridgeError(
        "CODEX_SUCCESSION_RECOVERY_REQUIRED",
        "No message can be accepted while Codex succession requires manual recovery.",
      );
    }
    this.pruneTransient();
    if (
      options.existingConversationId === undefined &&
      this.conversations.size >= MAX_CONVERSATIONS
    ) {
      throw new BridgeError("CONVERSATION_CAPACITY", "The transient conversation table is full.", true);
    }
    const target = await this.store.resolveRoute(targetAlias);
    if (expectsReply && target.provider === "claude") {
      const owner = this.pendingClaudeReplies.get(bindingKey(target));
      if (owner !== undefined) throw new BridgeError("REPLY_ROUTE_BUSY", "That exact peer already owns a pending reply.", true);
    }
    const conversationId =
      options.existingConversationId ?? createGatewayConversationId();
    const conversation = this.conversations.get(conversationId) ?? {
      id: conversationId,
      sourceAlias,
      targetAlias,
      expectsReply,
      nextSequence: 0,
      lastActivityAt: this.now().toISOString(),
    };
    const sequence = conversation.nextSequence;
    const enqueuedAt = this.now().getTime();
    const deliveryToken = (options.exposeDeliveryToken ?? true)
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
      conversationIdSuffix: conversationId.slice(-8),
      deadlineAt,
      ...(options.steer === true ? { steer: true as const } : {}),
      ...(options.skipProgressWatchActivity === true
        ? {}
        : {
            progressWatch: progressWatchActivity(
              text,
              conversationId,
              sourceAlias,
              options.trackIdleMinutes,
            ),
          }),
      ...(options.progressWatchNudge === undefined
        ? {}
        : { progressWatchNudge: options.progressWatchNudge }),
    });
    if (!queued.accepted || queued.messageId === undefined) throw new BridgeError("MESSAGE_REJECTED", "The message was not accepted.");
    if (queued.supersededSettlement !== undefined) {
      await this.applyTerminalSettlementLocked(queued.supersededSettlement);
    }
    this.conversations.set(conversationId, conversation);
    if (queued.pair === true) conversation.pair = true;
    conversation.nextSequence += 1;
    conversation.lastActivityAt = this.now().toISOString();
    this.messageContexts.set(queued.messageId, {
      conversationId,
      expectsReply,
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
    exposeDeliveryToken = true,
    trackIdleMinutes?: number,
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
      conversationIdSuffix: conversation.id.slice(-8),
      deadlineAt,
      ...(conversation.pair === true ? { pair: true as const } : {}),
      progressWatch: progressWatchActivity(
        text,
        conversation.id,
        sourceAlias,
        trackIdleMinutes,
      ),
    });
    if (!queued.accepted || queued.messageId === undefined) {
      throw new BridgeError(
        "MESSAGE_REJECTED",
        "The native reply was not accepted.",
      );
    }
    conversation.nextSequence += 1;
    conversation.lastActivityAt = this.now().toISOString();
    this.messageContexts.set(queued.messageId, {
      conversationId: conversation.id,
      expectsReply: false,
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

  /**
   * A provider reply observed before route teardown remains valid evidence
   * even when the same atomic mutation removes its selected Claude route.
   * Re-enter that already-observed reply through the existing transient
   * native-ingress boundary; this preserves the exact connector generation
   * without recreating route authority or accepting a new unsolicited send.
   */
  private async enqueueObservedClaudeReplyAfterRouteTeardownLocked(
    conversation: Conversation,
    sourceBinding: PrivateRouteBinding,
    text: string,
  ): Promise<void> {
    const target = await this.store.resolveRoute(conversation.sourceAlias);
    if (
      sourceBinding.provider !== "claude" ||
      target.provider !== "codex" ||
      sourceBinding.hostId !== target.hostId
    ) {
      throw new BridgeError(
        "RECOVERED_REPLY_ROUTE_MISMATCH",
        "The retained provider reply no longer matches an exact same-host Codex target.",
      );
    }
    const sequence = conversation.nextSequence;
    const enqueuedAt = this.now().getTime();
    const deadlineAt = new Date(
      enqueuedAt + this.config.limits.messageDeadlineMs,
    ).toISOString();
    const queued = await this.store.enqueueNativeIngress({
      source: {
        alias: conversation.targetAlias,
        binding: sourceBinding,
      },
      targetAlias: conversation.sourceAlias,
      body: text,
      dedupeKey: `${conversation.id}:${sequence}`,
      conversationIdSuffix: conversation.id.slice(-8),
      deadlineAt,
      authorizedPairTeardownReply: true,
      progressWatch: progressWatchActivity(
        text,
        conversation.id,
        conversation.targetAlias,
      ),
    });
    if (!queued.accepted || queued.messageId === undefined) {
      throw new BridgeError(
        "MESSAGE_REJECTED",
        "The retained provider reply was not accepted.",
      );
    }
    conversation.nextSequence += 1;
    conversation.lastActivityAt = this.now().toISOString();
    // The old edge has already been removed. Retain only this already-observed
    // reply attempt; the conversation no longer grants pair reply authority.
    delete conversation.pair;
    this.messageContexts.set(queued.messageId, {
      conversationId: conversation.id,
      expectsReply: false,
      sequence,
      targetBindingKey: bindingKey(target),
      authorization: "selected_route",
      targetAlias: conversation.sourceAlias,
      deadlineAt,
    });
    this.armDeliveryTracker({
      messageId: queued.messageId,
      conversationId: conversation.id,
      targetAlias: conversation.sourceAlias,
      enqueuedAt,
      deadlineAt,
    });
    await this.changed();
    await this.setNativeCodexStatus(conversation.sourceAlias, "waiting");
    this.scheduleDispatch(conversation.sourceAlias);
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
    for (const continuation of this.providerTurnContinuations.values()) {
      active.add(continuation.conversationId);
    }
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

  private async awaitDispatchWithNativeHeldLocked(
    tracker: MessageDeliveryTracker,
    operation: Promise<GatewayAdapterDispatchResult>,
  ): Promise<GatewayAdapterDispatchResult> {
    type Outcome =
      | { kind: "result"; value: GatewayAdapterDispatchResult }
      | { kind: "error"; error: unknown };
    const outcome: Promise<Outcome> = operation.then(
      (value) => ({ kind: "result", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const unwrap = (settled: Outcome): GatewayAdapterDispatchResult => {
      if (settled.kind === "error") throw settled.error;
      return settled.value;
    };

    while (true) {
      const current = this.deliveryTrackers.get(tracker.messageId);
      if (
        current === undefined ||
        current.nativeReceipt === undefined ||
        current.nativeHeldSent ||
        isTerminalDeliveryMachine(current.machine)
      ) {
        return unwrap(await outcome);
      }
      const now = this.now().getTime();
      if (now >= current.deadlineAt) return unwrap(await outcome);
      const delay = Math.max(0, current.nativeHeldNextAttemptAt - now);
      if (delay > 0) {
        let timer: GatewayServiceTimer | undefined;
        const due = new Promise<{ kind: "due" }>((resolve) => {
          timer = this.timers.setTimeout(() => resolve({ kind: "due" }), delay);
          (timer as { unref?: () => void }).unref?.();
        });
        const first = await Promise.race([outcome, due]);
        if (timer !== undefined) this.timers.clearTimeout(timer);
        if (first.kind !== "due") return unwrap(first);
      }

      // A terminal callback may have arrived before the provider's dispatch
      // promise resolved. Let that exact evidence win before emitting held.
      await this.drainDeliveryCallbacksForMessageLocked(tracker.messageId);
      const afterCallbacks = this.deliveryTrackers.get(tracker.messageId);
      if (
        afterCallbacks === undefined ||
        isTerminalDeliveryMachine(afterCallbacks.machine) ||
        this.now().getTime() >= afterCallbacks.deadlineAt
      ) {
        return unwrap(await outcome);
      }
      await this.publishNativeHeldLocked(afterCallbacks);
    }
  }

  private restoreQueuedMessageContextLocked(
    item: TransientQueuedMessage,
    binding: PrivateRouteBinding,
  ): MessageContext {
    this.pruneTransient();
    const generatedConversationId = createGatewayConversationId();
    const conversationId =
      item.conversationIdSuffix === undefined
        ? generatedConversationId
        : `${generatedConversationId.slice(0, -8)}${item.conversationIdSuffix}`;
    const conversation: Conversation = {
      id: conversationId,
      sourceAlias: item.sourceAlias,
      targetAlias: item.targetAlias,
      expectsReply: false,
      nextSequence: 1,
      lastActivityAt: this.now().toISOString(),
      ...(item.pair === true ? { pair: true as const } : {}),
    };
    const context: MessageContext = {
      conversationId,
      expectsReply: false,
      sequence: 0,
      targetBindingKey: bindingKey(binding),
      authorization: "selected_route",
      targetAlias: item.targetAlias,
      deadlineAt: item.deadlineAt,
      recovered: true,
    };
    this.conversations.set(conversationId, conversation);
    this.messageContexts.set(item.messageId, context);
    this.armDeliveryTracker({
      messageId: item.messageId,
      conversationId,
      targetAlias: item.targetAlias,
      enqueuedAt: Date.parse(item.enqueuedAt),
      deadlineAt: item.deadlineAt,
    });
    return context;
  }

  private async dispatchOne(targetAlias: string): Promise<void> {
    if (
      !this.running ||
      this.closing ||
      this.codexSuccessionDispatchFrozen.has(targetAlias) ||
      this.codexSuccessionPoisoned.has(targetAlias) ||
      this.claudePrewriteIdleWaitTargets.has(targetAlias)
    ) {
      return;
    }
    if (await this.processLifecycleLocked()) {
      await this.changed();
    }
    const selectedBeforeDequeue = this.routeBindings.get(targetAlias);
    const activeDispatch = this.activeDispatchByTarget.get(targetAlias);
    const steeringWhileBusy =
      selectedBeforeDequeue?.provider === "codex" &&
      this.routeStates.get(targetAlias) === "busy";
    if (activeDispatch !== undefined && !steeringWhileBusy) return;
    let item = await this.store.dequeueMessage(
      targetAlias,
      steeringWhileBusy ? "steer_only" : "any",
    );
    if (
      item === undefined &&
      steeringWhileBusy &&
      activeDispatch === undefined
    ) {
      // Preserve the ordinary busy-route waiting transition when no steer can
      // bypass it. A live provider turn still fences ordinary work.
      item = await this.store.dequeueMessage(targetAlias, "any");
    }
    if (item === undefined) return;
    const selectedBinding = this.routeBindings.get(targetAlias);
    let context = this.messageContexts.get(item.messageId);
    if (context === undefined && selectedBinding === undefined) {
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
    if (context === undefined && selectedBinding !== undefined) {
      context = this.restoreQueuedMessageContextLocked(item, selectedBinding);
    }
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
        (binding.provider === "claude" && routeState === "busy") ||
        (binding.provider === "codex" &&
          item.steer === true &&
          routeState === "busy");
      const inspection = await this.store.inspectPrivateRoute(targetAlias);
      const codexRouteStale =
        binding.provider === "codex" &&
        (routeState === "stale" ||
          inspection?.state === "stale" ||
          inspection?.safeErrorCode === "CODEX_ROUTE_STALE");
      if (codexRouteStale) {
        if (context.recovered === true) {
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
        await this.advanceDeliveryLocked(item.messageId, {
          type: "route_terminated",
          at: this.now().getTime(),
          unwrittenOutcome: "failed",
          safeErrorCode: "CODEX_ROUTE_STALE",
        });
        await this.changed();
        this.scheduleDispatch(targetAlias);
        return;
      }
      const storedDispatchable =
        inspection?.state === "idle" ||
        (binding.provider === "claude" && inspection?.state === "busy") ||
        (binding.provider === "codex" &&
          item.steer === true &&
          inspection?.state === "busy");
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
        if (
          binding.provider === "codex" &&
          (routeState === "busy" ||
            routeState === "awaiting_approval" ||
            inspection?.state === "busy" ||
            inspection?.state === "awaiting_approval")
        ) {
          this.scheduleHeldRedispatch(targetAlias);
        }
        await this.changed();
        return;
      }
      if (!steeringWhileBusy) this.routeStates.set(targetAlias, "busy");
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

    if (!steeringWhileBusy) {
      this.activeDispatchByTarget.set(targetAlias, item.messageId);
    }
    const tracker = this.deliveryTrackers.get(item.messageId);
    if (tracker === undefined) {
      const settled = await this.store.settleMessage({
        messageId: item.messageId,
        state: "failed",
        safeErrorCode: "DELIVERY_TRACKER_MISSING",
      });
      this.takeMessageContextLocked(item.messageId, "failed");
      if (this.activeDispatchByTarget.get(targetAlias) === item.messageId) {
        this.activeDispatchByTarget.delete(targetAlias);
      }
      for (const [token, messageId] of this.deliveryTokens) {
        if (messageId === item.messageId) this.deliveryTokens.delete(token);
      }
      this.addRuntimeAlert("DELIVERY_TRACKER_MISSING", "error", {
        alias: targetAlias,
      });
      if (settled.status !== "settled") {
        this.addRuntimeAlert("DELIVERY_LEDGER_RECOVERY_FAILED", "error", {
          alias: targetAlias,
        });
      }
      await this.changed();
      return;
    }
    const dispatchEvent: DeliveryEvent =
      tracker.machine.phase !== "terminal" &&
      tracker.machine.dispatchRetryAt !== null
        ? {
            type: "dispatch_retry_due",
            at: this.now().getTime(),
          }
        : { type: "dispatch_requested", at: this.now().getTime() };
    await this.advanceDeliveryLocked(item.messageId, dispatchEvent);
    if (isTerminalDeliveryMachine(tracker.machine)) return;
    if (tracker.machine.phase !== "dispatching") {
      const requeued = await this.store.requeueInFlightMessage(
        item.messageId,
        item.body,
      );
      if (this.activeDispatchByTarget.get(targetAlias) === item.messageId) {
        this.activeDispatchByTarget.delete(targetAlias);
      }
      if (requeued.status === "settled") {
        await this.applyTerminalSettlementLocked(requeued.settlement);
      }
      this.scheduleLifecycleWakeLocked();
      return;
    }
    let result: GatewayAdapterDispatchResult;
    try {
      result = await this.awaitDispatchWithNativeHeldLocked(
        tracker,
        this.adapter(binding.provider, binding.hostId).dispatch({
          sourceAlias: item.sourceAlias,
          targetAlias: item.targetAlias,
          conversationId: context.conversationId,
          binding,
          authorization: context.authorization,
          messageId: item.messageId,
          text: item.body,
          expectsReply: context?.expectsReply ?? false,
          deadlineAt: item.deadlineAt,
          ...(item.steer === true ? { steer: true as const } : {}),
        }),
      );
    } catch {
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
      await this.advanceDeliveryLocked(item.messageId, {
        type: "dispatch_ambiguous",
        at: this.now().getTime(),
        safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
      });
      await this.changed();
      this.scheduleDispatch(
        this.bindingAliases.get(bindingKey(binding)) ?? targetAlias,
      );
      return;
    }
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
    if (result.state === "deferred") {
      const currentTargetAlias =
        this.bindingAliases.get(bindingKey(binding)) ?? targetAlias;
      const now = this.now().getTime();
      const deferredSafeErrorCode = safeCode(
        result.safeErrorCode,
        "PROVIDER_DISPATCH_DEFERRED",
      );
      await this.advanceDeliveryLocked(item.messageId, {
        type: "dispatch_clean_prewrite_failed",
        at: now,
        retryAt: now + 500,
        safeErrorCode: deferredSafeErrorCode,
      });
      tracker.deliverySafeErrorCode = deferredSafeErrorCode;
      const postDeferred = this.deliveryTrackers.get(item.messageId)?.machine;
      if (
        postDeferred === undefined ||
        isTerminalDeliveryMachine(postDeferred)
      ) {
        await this.changed();
        return;
      }
      // A provider's clean-prewrite return cannot authorize replay after a
      // callback from the same dispatch has already established write
      // evidence. Only the reducer's explicit queued retry phase may return
      // the body to the store queue.
      if (postDeferred.phase !== "queued") {
        await this.advanceDeliveryLocked(item.messageId, {
          type: "await_terminal",
          at: this.now().getTime(),
        });
        await this.changed();
        return;
      }
      const requeued = await this.store.requeueInFlightMessage(
        item.messageId,
        item.body,
        deferredSafeErrorCode,
      );
      if (
        this.activeDispatchByTarget.get(currentTargetAlias) === item.messageId
      ) {
        this.activeDispatchByTarget.delete(currentTargetAlias);
      }
      if (requeued.status === "requeued") {
        if (context.authorization === "selected_route") {
          const waitForClaudeIdle =
            binding.provider === "claude" &&
            CLAUDE_CLEAN_PREWRITE_ROUTE_CODES.has(deferredSafeErrorCode);
          if (waitForClaudeIdle) {
            this.claudePrewriteIdleWaitTargets.add(currentTargetAlias);
          } else if (!steeringWhileBusy) {
            this.routeStates.set(currentTargetAlias, "idle");
            await this.store.observeRoute({
              binding,
              state: "idle",
              compatibility: "compatible",
            });
          } else {
            this.scheduleHeldRedispatch(currentTargetAlias);
          }
          await this.setNativeCodexStatus(currentTargetAlias, "waiting");
        }
      } else if (requeued.status === "settled") {
        await this.applyTerminalSettlementLocked(requeued.settlement);
      }
      await this.changed();
      return;
    }
    if (result.state === "pending" || result.state === "accepted") {
      if (
        result.state === "accepted" &&
        (await this.acceptProviderDeliveryLocked(item.messageId))
      ) {
        await this.changed();
      } else if (result.state === "pending") {
        await this.advanceDeliveryLocked(item.messageId, {
          type: "await_terminal",
          at: this.now().getTime(),
        });
      }
    } else {
      await this.finishDelivery({ messageId: item.messageId, state: result.state, ...(result.safeErrorCode === undefined ? {} : { safeErrorCode: result.safeErrorCode }), ...(result.replyText === undefined ? {} : { replyText: result.replyText }) });
    }
    this.scheduleDispatch(
      this.bindingAliases.get(bindingKey(binding)) ?? targetAlias,
    );
  }

  private scheduleDispatch(targetAlias: string): void {
    if (
      this.closing ||
      this.codexSuccessionDispatchFrozen.has(targetAlias) ||
      this.codexSuccessionPoisoned.has(targetAlias) ||
      this.claudePrewriteIdleWaitTargets.has(targetAlias)
    ) {
      return;
    }
    if (this.scheduledDispatchTargets.has(targetAlias)) return;
    this.scheduledDispatchTargets.add(targetAlias);
    setImmediate(() => {
      this.mutex
        .run("service", async () => {
          this.scheduledDispatchTargets.delete(targetAlias);
          if (
            this.closing ||
            this.codexSuccessionDispatchFrozen.has(targetAlias) ||
            this.codexSuccessionPoisoned.has(targetAlias)
          ) {
            return;
          }
          this.dispatchRunnerTargets.add(targetAlias);
          try {
            await this.dispatchOne(targetAlias);
          } finally {
            this.dispatchRunnerTargets.delete(targetAlias);
            this.scheduleLifecycleWakeLocked();
          }
        })
        .catch(() => {
          this.dashboardHealthy = false;
        });
    });
  }

  private scheduleHeldRedispatch(targetAlias: string): void {
    if (this.closing || this.heldRedispatchTimers.has(targetAlias)) return;
    const timer = this.timers.setTimeout(() => {
      if (this.heldRedispatchTimers.get(targetAlias) !== timer) return;
      this.heldRedispatchTimers.delete(targetAlias);
      this.scheduleDispatch(targetAlias);
    }, 500);
    this.heldRedispatchTimers.set(targetAlias, timer);
    (timer as { unref?: () => void }).unref?.();
  }

  private async onDelivery(
    source: PrivateEndpointIdentity,
    event: GatewayAdapterDelivery,
    receivedAt: number,
  ): Promise<void> {
    const context = this.deliveryCorrelation(event.messageId);
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
    if (
      this.providerTurnContinuations.has(event.messageId) &&
      !this.messageContexts.has(event.messageId)
    ) {
      if (
        event.state === "transport_uncertain" ||
        event.state === "transport_written" ||
        event.state === "held"
      ) {
        return;
      }
      const state =
        event.state === "released" || event.state === "completed"
          ? "delivered"
          : event.state === "expired"
            ? "expired"
            : event.state === "cancelled"
              ? "cancelled"
              : event.state === "ambiguous"
                ? "ambiguous"
                : "failed";
      await this.finishProviderTurnContinuationLocked(
        event.messageId,
        state,
        event.replyText,
      );
      await this.changed();
      return;
    }
    const deliveryEvent: DeliveryEvent =
      event.state === "transport_uncertain"
        ? {
            type: "dispatch_ambiguous",
            at: receivedAt,
            safeErrorCode: safeCode(
              event.safeErrorCode,
              "DISPATCH_OUTCOME_AMBIGUOUS",
            ),
          }
        : event.state === "transport_written"
        ? target.provider === "claude"
          ? { type: "provider_released", observedAt: receivedAt }
          : { type: "transport_written", observedAt: receivedAt }
        : event.state === "held"
          ? { type: "provider_held", observedAt: receivedAt }
          : event.state === "released" || event.state === "completed"
            ? { type: "provider_released", observedAt: receivedAt }
            : event.state === "unconfirmed"
              ? {
                  type: "provider_unconfirmed",
                  observedAt: receivedAt,
                  safeErrorCode: safeCode(
                    event.safeErrorCode,
                    "DELIVERY_UNCONFIRMED",
                  ),
                }
              : event.state === "expired"
                ? {
                    type: "provider_expired",
                    observedAt: receivedAt,
                    safeErrorCode: safeCode(
                      event.safeErrorCode,
                      "MESSAGE_EXPIRED",
                    ),
                  }
                : event.state === "denied" || event.state === "failed"
                  ? {
                      type: "provider_failed",
                      observedAt: receivedAt,
                      safeErrorCode: safeCode(
                        event.safeErrorCode,
                        "PROVIDER_DELIVERY_FAILED",
                      ),
                    }
                  : event.state === "ambiguous"
                    ? {
                        type: "dispatch_ambiguous",
                        at: receivedAt,
                        safeErrorCode: safeCode(
                          event.safeErrorCode,
                          "DISPATCH_OUTCOME_AMBIGUOUS",
                        ),
                      }
                    : {
                        type: "cancel",
                        at: receivedAt,
                        safeErrorCode: safeCode(
                          event.safeErrorCode,
                          "PROVIDER_DELIVERY_CANCELLED",
                        ),
                      };
    const terminalContext = await this.advanceDeliveryLocked(
      event.messageId,
      deliveryEvent,
      undefined,
      event.replyText,
    );
    await this.finishDeliveredReplyLocked(
      terminalContext,
      event.replyText,
    );
    await this.changed();
  }

  private async finishDelivery(event: {
    messageId: string;
    state:
      | "delivered"
      | "unconfirmed"
      | "failed"
      | "ambiguous"
      | "expired"
      | "cancelled";
    safeErrorCode?: string;
    replyText?: string;
  }): Promise<void> {
    if (
      this.providerTurnContinuations.has(event.messageId) &&
      !this.messageContexts.has(event.messageId)
    ) {
      await this.finishProviderTurnContinuationLocked(
        event.messageId,
        event.state,
        event.replyText,
      );
      await this.changed();
      return;
    }
    const now = this.now().getTime();
    const deliveryEvent: DeliveryEvent =
      event.state === "delivered"
        ? { type: "provider_released", observedAt: now }
        : event.state === "unconfirmed"
          ? {
              type: "provider_unconfirmed",
              observedAt: now,
              safeErrorCode: safeCode(
                event.safeErrorCode,
                "DELIVERY_UNCONFIRMED",
              ),
            }
          : event.state === "expired"
            ? {
                type: "provider_expired",
                observedAt: now,
                safeErrorCode: safeCode(event.safeErrorCode, "MESSAGE_EXPIRED"),
              }
            : event.state === "failed"
              ? {
                  type: "provider_failed",
                  observedAt: now,
                  safeErrorCode: safeCode(
                    event.safeErrorCode,
                    "PROVIDER_DELIVERY_FAILED",
                  ),
                }
              : event.state === "ambiguous"
                ? {
                    type: "dispatch_ambiguous",
                    at: now,
                    safeErrorCode: safeCode(
                      event.safeErrorCode,
                      "DISPATCH_OUTCOME_AMBIGUOUS",
                    ),
                  }
                : {
                    type: "cancel",
                    at: now,
                    safeErrorCode: safeCode(
                      event.safeErrorCode,
                      "PROVIDER_DELIVERY_CANCELLED",
                    ),
                  };
    const context = await this.advanceDeliveryLocked(
      event.messageId,
      deliveryEvent,
      undefined,
      event.replyText,
    );
    await this.finishDeliveredReplyLocked(context, event.replyText);
    await this.changed();
  }

  private async finishDeliveredReplyLocked(
    context: MessageContext | undefined,
    replyText: string | undefined,
  ): Promise<void> {
    if (context === undefined) return;
    const conversation = this.conversations.get(context.conversationId);
    if (
      !this.closing &&
      replyText !== undefined &&
      replyText.length > 0 &&
      context.expectsReply &&
      conversation !== undefined
    ) {
      try {
        if (this.nativeIngressByConversation.has(conversation.id)) {
          await this.enqueueNativeReply(
            conversation,
            conversation.targetAlias,
            replyText,
            false,
          );
        } else {
          const sourceBinding = this.routeBindings.get(
            conversation.targetAlias,
          );
          const sourceStillRoutable = await this.store
            .resolveRoute(conversation.targetAlias)
            .then(() => true)
            .catch(() => false);
          const pairStillActive =
            conversation.pair !== true ||
            (await this.store.hasPair({
              claudeAlias: conversation.targetAlias,
              codexAlias: conversation.sourceAlias,
            }));
          if (
            (!sourceStillRoutable || !pairStillActive) &&
            sourceBinding?.provider === "claude"
          ) {
            await this.enqueueObservedClaudeReplyAfterRouteTeardownLocked(
              conversation,
              sourceBinding,
              replyText,
            );
          } else {
            await this.enqueue(
              conversation.targetAlias,
              conversation.sourceAlias,
              replyText,
              false,
              {
                existingConversationId: conversation.id,
                exposeDeliveryToken: false,
              },
            );
          }
        }
      } catch {
        this.dashboardHealthy = false;
      }
    }
  }

  private async finishProviderTurnContinuationLocked(
    messageId: string,
    state: DeliveryTerminalState,
    replyText?: string,
  ): Promise<boolean> {
    const continuation = this.providerTurnContinuations.get(messageId);
    if (continuation === undefined) return false;
    this.providerTurnContinuations.delete(messageId);
    if (
      this.activeDispatchByTarget.get(continuation.targetAlias) === messageId
    ) {
      this.activeDispatchByTarget.delete(continuation.targetAlias);
      if (!this.closing) this.scheduleDispatch(continuation.targetAlias);
    }
    const conversation = this.conversations.get(continuation.conversationId);
    if (state !== "delivered") {
      this.releasePendingClaude(conversation);
      this.nativeIngressByConversation.delete(continuation.conversationId);
      this.addRuntimeAlert("PROVIDER_TURN_FAILED_AFTER_ACCEPTANCE", "warning", {
        alias: continuation.targetAlias,
      });
      return true;
    }
    await this.finishDeliveredReplyLocked(continuation, replyText);
    if (replyText === undefined || replyText.length === 0) {
      this.nativeIngressByConversation.delete(continuation.conversationId);
    }
    return true;
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
      {
        existingConversationId: conversation.id,
        exposeDeliveryToken: false,
      },
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
      if (this.codexSuccessionPoisoned.has(event.targetAlias)) {
        throw new BridgeError(
          "CODEX_SUCCESSION_RECOVERY_REQUIRED",
          "Native ingress is unavailable while Codex succession requires manual recovery.",
        );
      }
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
      const steer =
        this.config.steeringEnabled && event.text.startsWith("STEER:");
      const queued = await this.store.enqueueNativeIngress({
        source: { alias: event.sourceAlias, binding: sourceBinding },
        targetAlias: event.targetAlias,
        body: event.text,
        dedupeKey: `${conversationId}:0`,
        conversationIdSuffix: conversationId.slice(-8),
        deadlineAt,
        ...(steer ? { steer: true as const } : {}),
        progressWatch: progressWatchActivity(
          event.text,
          conversationId,
          event.sourceAlias,
        ),
      });
      if (!queued.accepted || queued.messageId === undefined) {
        throw new BridgeError(
          "MESSAGE_REJECTED",
          "The native message was not accepted.",
        );
      }
      acceptedMessageId = queued.messageId;
      if (queued.supersededSettlement !== undefined) {
        await this.applyTerminalSettlementLocked(
          queued.supersededSettlement,
        );
      }
      const conversation: Conversation = {
        id: conversationId,
        sourceAlias: event.sourceAlias,
        targetAlias: event.targetAlias,
        expectsReply: !steer,
        nextSequence: 1,
        lastActivityAt: this.now().toISOString(),
        ...(queued.pair === true ? { pair: true as const } : {}),
      };
      this.conversations.set(conversationId, conversation);
      this.messageContexts.set(queued.messageId, {
        conversationId,
        expectsReply: !steer,
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
        ...(event.receiptHandle === undefined
          ? {}
          : {
              nativeReceipt: {
                hostId: event.endpoint.hostId,
                receiptHandle: event.receiptHandle,
              },
            }),
      });
      this.nativeIngressByConversation.set(conversationId, {
        sourceAlias: event.sourceAlias,
        binding: sourceBinding,
        deadlineAt,
      });
      await this.changed();
      await this.setNativeCodexStatus(event.targetAlias, "waiting");
      // Native ingress gets one immediate dispatch opportunity. Only an
      // actual queued/waiting result earns a `held` acknowledgement; an idle
      // fast path can therefore settle with one terminal acknowledgement.
      await this.dispatchOne(event.targetAlias);
      const tracker = this.deliveryTrackers.get(queued.messageId);
      if (tracker?.machine.phase === "queued") {
        await this.publishNativeHeldLocked(tracker);
      }
    } catch (error) {
      const code = safeCode(
        error instanceof BridgeError ? error.code : undefined,
        "NATIVE_INGRESS_REJECTED",
      );
      if (acceptedMessageId !== undefined) {
        const cancelled = await this.store.settleQueuedMessage({
          messageId: acceptedMessageId,
          state: "expired",
          safeErrorCode: code,
        });
        if (cancelled.status === "settled") {
          await this.applyTerminalSettlementLocked(cancelled.settlement);
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

  private async onCodexEndpointRefresh(
    adapter: GatewayProviderAdapter,
    event: GatewayAdapterEndpointRefresh,
    options: {
      deferActivation?: boolean;
      deferredRoute?: {
        alias: string;
        threadId: string;
        state: GatewayAdapterRouteState;
      };
      requiredRoute?: {
        alias: string;
        threadId: string;
        state: GatewayAdapterRouteState;
      };
    } = {},
  ): Promise<boolean> {
    const transitionKey = endpointRefreshCallbackKey(event);
    if (
      this.endpointRefreshCallbackPoisoned &&
      this.activeEndpointRefreshCallbackKey !== transitionKey
    ) {
      throw new BridgeError(
        "CODEX_ENDPOINT_REFRESH_CONFLICT",
        "Conflicting Codex endpoint transitions require a clean broker restart.",
      );
    }
    const ownsActiveTransition =
      this.activeEndpointRefreshCallbackKey === undefined;
    if (
      !ownsActiveTransition &&
      this.activeEndpointRefreshCallbackKey !== transitionKey
    ) {
      this.poisonEndpointRefreshCallbacks({
        type: "endpoint_refresh",
        adapter,
        value: event,
      });
      throw new BridgeError(
        "CODEX_ENDPOINT_REFRESH_CONFLICT",
        "Conflicting Codex endpoint transitions require a clean broker restart.",
      );
    }
    if (ownsActiveTransition) {
      this.activeEndpointRefreshCallback = {
        type: "endpoint_refresh",
        adapter,
        value: event,
      };
      this.activeEndpointRefreshCallbackKey = transitionKey;
    }
    let succeeded = false;
    let activationDeferred = false;
    try {
      activationDeferred = await this.applyCodexEndpointRefresh(
        adapter,
        event,
        transitionKey,
        options,
      );
      succeeded = true;
      return activationDeferred;
    } finally {
      if (
        ownsActiveTransition &&
        this.activeEndpointRefreshCallbackKey === transitionKey
      ) {
        this.activeEndpointRefreshCallback = undefined;
        this.activeEndpointRefreshCallbackKey = undefined;
        const requestedRetry = this.endpointRefreshRetryRequested;
        this.endpointRefreshRetryRequested = undefined;
        if (
          (!succeeded || activationDeferred) &&
          !this.endpointRefreshCallbackPoisoned &&
          requestedRetry !== undefined
        ) {
          this.endpointRefreshCallback = requestedRetry;
          this.enqueueCallbackWorkerOnly();
        }
      }
    }
  }

  private async applyCodexEndpointRefresh(
    adapter: GatewayProviderAdapter,
    event: GatewayAdapterEndpointRefresh,
    transitionKey: string,
    options: {
      deferActivation?: boolean;
      deferredRoute?: {
        alias: string;
        threadId: string;
        state: GatewayAdapterRouteState;
      };
      requiredRoute?: {
        alias: string;
        threadId: string;
        state: GatewayAdapterRouteState;
      };
    },
  ): Promise<boolean> {
    if (
      this.closing ||
      (event.outcome !== "compatible" && event.outcome !== "incompatible") ||
      !isCompatibilityAttestation(event.attestation) ||
      event.attestation.surface !== "codex" ||
      event.previous.provider !== "codex" ||
      !PRIVATE_HANDLE.test(event.previous.endpointGeneration) ||
      adapter.identity.provider !== "codex" ||
      adapter.identity.hostId !== event.previous.hostId ||
      !this.config.allowedHosts.includes(event.previous.hostId)
    ) {
      throw new BridgeError(
        "CODEX_ENDPOINT_REFRESH_MISMATCH",
        "The Codex endpoint transition failed closed runtime validation.",
      );
    }
    if (event.outcome === "compatible") {
      const routeHandles = Array.isArray(event.routes)
        ? event.routes.map((route) => route.routeHandle)
        : [];
      if (
        event.current.provider !== "codex" ||
        event.current.hostId !== event.previous.hostId ||
        !PRIVATE_HANDLE.test(event.current.endpointGeneration) ||
        event.current.endpointGeneration ===
          event.previous.endpointGeneration ||
        adapter.identity.endpointGeneration !==
          event.current.endpointGeneration ||
        event.attestation.version !== adapter.protocolVersion ||
        event.attestation.tier === "incompatible" ||
        !Array.isArray(event.routes) ||
        event.routes.length > this.config.limits.maxRoutes ||
        new Set(routeHandles).size !== routeHandles.length ||
        event.routes.some(
          (route) =>
            !PRIVATE_HANDLE.test(route.routeHandle) ||
            !["idle", "busy", "awaiting_approval"].includes(route.state),
        )
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "The refreshed Codex provider identity changed before activation.",
        );
      }
      if (
        this.activatedEndpointRefreshes.get(event.current.hostId) ===
        transitionKey
      ) {
        return false;
      }
    } else {
      if (
        event.candidate.provider !== "codex" ||
        event.candidate.hostId !== event.previous.hostId ||
        !PRIVATE_HANDLE.test(event.candidate.endpointGeneration) ||
        event.candidate.endpointGeneration ===
          event.previous.endpointGeneration ||
        adapter.identity.endpointGeneration !==
          event.previous.endpointGeneration ||
        event.attestation.tier !== "incompatible"
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "The incompatible Codex candidate no longer matches the active endpoint.",
        );
      }
      if (
        this.handledIncompatibleEndpointRefreshes.get(
          event.previous.hostId,
        ) === transitionKey
      ) {
        return false;
      }
    }

    let inventory = await this.store.inspectPrivateCodexRoutes();
    const previousRoutes = inventory.filter(
      (route) =>
        route.binding.hostId === event.previous.hostId &&
        route.binding.endpointGeneration === event.previous.endpointGeneration,
    );
    const aliases = previousRoutes.map((route) => route.alias);
    await this.drainPreDeadlineDeliveryCallbacksLocked();
    const inFlightSettlements =
      aliases.length === 0
        ? []
        : await this.planRoutesInFlightSettlementsLocked(aliases, {
            unwrittenOutcome: "failed",
            safeErrorCode: "ENDPOINT_GENERATION_CHANGED",
          });
    let settlements: Awaited<
      ReturnType<GatewayStore["markConnectorOffline"]>
    > = [];
    try {
      settlements = await this.store.markConnectorOffline(
        event.previous,
        "ENDPOINT_GENERATION_CHANGED",
        inFlightSettlements,
        { preserveQueued: true },
      );
    } catch (error) {
      const alreadyInvalidatedCompatibleTransition =
        event.outcome === "compatible" &&
        error instanceof BridgeError &&
        error.code === "CONNECTOR_NOT_FOUND" &&
        previousRoutes.every(
          (route) =>
            route.state === "stale" && route.compatibility === "expired",
        );
      if (!alreadyInvalidatedCompatibleTransition) throw error;
    }
    for (const settlement of settlements) {
      await this.applyTerminalSettlementLocked(settlement);
    }
    for (const route of previousRoutes) {
      this.routeStates.set(route.alias, "stale");
    }
    await this.store.recordCompatibilityAttestation(event.attestation);
    if (event.outcome === "incompatible") {
      await this.requireEndpointRefreshUnconflicted();
      this.activeCodexIncompatibility = structuredClone(event.attestation);
      this.addRuntimeAlert(
        event.attestation.safeErrorCode ?? "CODEX_ENDPOINT_INCOMPATIBLE",
        "error",
        { provider: "codex", host: event.previous.hostId },
      );
      this.handledIncompatibleEndpointRefreshes.set(
        event.previous.hostId,
        transitionKey,
      );
      await this.changed();
      return false;
    }
    await this.store.observeConnector({
      identity: event.current,
      health: "healthy",
      compatibility: "compatible",
      protocol: adapter.protocol,
      protocolVersion: adapter.protocolVersion,
    });

    const refreshedByHandle = new Map(
      event.routes.map((route) => [route.routeHandle, route.state] as const),
    );
    const pendingReanchors = previousRoutes.flatMap((route) => {
      const state = refreshedByHandle.get(route.binding.routeHandle);
      return state === undefined
        ? []
        : [
            {
              alias: route.alias,
              threadId: route.binding.routeHandle,
              ownerLease: route.binding.ownerLease,
              state,
            },
          ];
    });
    if (pendingReanchors.length > 0) {
      try {
        await this.store.reanchorCodexRoutes({
          oldEndpoint: event.previous,
          newEndpoint: event.current,
          routes: pendingReanchors,
        });
        this.durablyAppliedEndpointRefreshes.set(
          event.current.hostId,
          transitionKey,
        );
      } catch (error) {
        // Persistence may commit and then report an unknown outcome. Because
        // service/store mutation is serialized, exact G2 ownership for every
        // requested G1 alias proves this transition durably applied and gives
        // a later identical retry authority to restore a fail-closed G2 route.
        const after = await this.store.inspectPrivateCodexRoutes();
        const committedExactly = pendingReanchors.every((expected) => {
          const matches = after.filter(
            (route) =>
              route.alias === expected.alias &&
              route.binding.provider === "codex" &&
              route.binding.hostId === event.current.hostId &&
              route.binding.endpointGeneration ===
                event.current.endpointGeneration &&
              route.binding.routeHandle === expected.threadId &&
              route.binding.ownerLease === expected.ownerLease &&
              route.enabled &&
              route.compatibility === "compatible",
          );
          return matches.length === 1;
        });
        if (committedExactly) {
          this.durablyAppliedEndpointRefreshes.set(
            event.current.hostId,
            transitionKey,
          );
          try {
            await this.store.markConnectorOffline(
              event.current,
              "CODEX_ENDPOINT_ACTIVATION_FAILED",
              [],
              { preserveQueued: true },
            );
            for (const route of pendingReanchors) {
              this.routeStates.set(route.alias, "stale");
            }
            await this.changed();
          } catch {
            this.dashboardHealthy = false;
          }
        }
        throw error;
      }
    }

    // A retry may arrive after the store commit but before native status or
    // provider activation. Re-read exact durable authority and accept only one
    // unique current-generation owner for every claimed task.
    inventory = await this.store.inspectPrivateCodexRoutes();
    if (
      this.durablyAppliedEndpointRefreshes.get(event.current.hostId) ===
      transitionKey
    ) {
      const observedStates = new Map(
        event.routes.map((route) => [route.routeHandle, route.state] as const),
      );
      for (const route of inventory) {
        const state = observedStates.get(route.binding.routeHandle);
        if (
          state === undefined ||
          route.binding.hostId !== event.current.hostId ||
          route.binding.endpointGeneration !==
            event.current.endpointGeneration ||
          route.state !== "stale" ||
          route.compatibility !== "expired"
        ) {
          continue;
        }
        await this.registerOrRebind(
          route.alias,
          route.binding,
          "endpoint_reobserved",
          state,
          route.binding.ownerLease,
        );
      }
      inventory = await this.store.inspectPrivateCodexRoutes();
    }
    const previousRouteHandles = new Set(
      previousRoutes.map((route) => route.binding.routeHandle),
    );
    const activatedRoutes = event.routes.flatMap((observed) => {
      const matches = inventory.filter(
        (route) =>
          route.binding.provider === "codex" &&
          route.binding.hostId === event.current.hostId &&
          route.binding.endpointGeneration ===
            event.current.endpointGeneration &&
          route.binding.routeHandle === observed.routeHandle &&
          route.enabled &&
          route.compatibility === "compatible",
      );
      if (matches.length > 1) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "A refreshed Codex task has multiple durable owners.",
        );
      }
      if (matches.length === 0) {
        // A selector-triggered refresh can report the freshly selected task
        // before registerRoute installs that new alias. It has no prior G1
        // owner to re-anchor, so activation covers only already-durable tasks;
        // the caller installs this one immediately after the provider ack.
        if (!previousRouteHandles.has(observed.routeHandle)) return [];
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "A previously durable Codex task was not re-anchored exactly.",
        );
      }
      const match = matches[0];
      if (match === undefined) return [];
      return {
        alias: match.alias,
        threadId: observed.routeHandle,
        ownerLease: match.binding.ownerLease,
        state: observed.state,
      };
    });
    const pendingSelector = this.pendingSelectorEndpointActivations.get(
      event.current.hostId,
    );
    const requiredRoute =
      options.deferActivation === true
        ? undefined
        : options.requiredRoute ??
          (pendingSelector?.transitionKey === transitionKey
            ? pendingSelector.route
            : undefined);
    if (
      requiredRoute !== undefined &&
      !activatedRoutes.some(
        (route) =>
          route.alias === requiredRoute.alias &&
          route.threadId === requiredRoute.threadId,
      )
    ) {
      const matches = inventory.filter(
        (route) =>
          route.alias === requiredRoute.alias &&
          route.binding.provider === "codex" &&
          route.binding.hostId === event.current.hostId &&
          route.binding.endpointGeneration ===
            event.current.endpointGeneration &&
          route.binding.routeHandle === requiredRoute.threadId &&
          route.enabled &&
          route.compatibility === "compatible",
      );
      const match = matches[0];
      if (matches.length !== 1 || match === undefined) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "The registering Codex task was not durably installed exactly.",
        );
      }
      activatedRoutes.push({
        alias: requiredRoute.alias,
        threadId: requiredRoute.threadId,
        ownerLease: match.binding.ownerLease,
        state: requiredRoute.state,
      });
    }
    if (options.deferActivation === true) {
      const deferredRoute = options.deferredRoute;
      if (deferredRoute === undefined) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_MISMATCH",
          "A deferred selector transition requires one exact registration.",
        );
      }
      const existing = this.pendingSelectorEndpointActivations.get(
        event.current.hostId,
      );
      if (
        existing !== undefined &&
        (existing.transitionKey !== transitionKey ||
          existing.route.alias !== deferredRoute.alias ||
          existing.route.threadId !== deferredRoute.threadId)
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_CONFLICT",
          "A different selector transition is already awaiting native activation.",
        );
      }
      this.pendingSelectorEndpointActivations.set(event.current.hostId, {
        transitionKey,
        route: { ...deferredRoute },
      });
      return true;
    }

    const requireNativeContinuity = (
      route: (typeof activatedRoutes)[number],
    ): void => {
      const registration = this.codexRegistrationLocks.get(route.alias);
      if (
        registration === undefined ||
        registration.hostId !== event.current.hostId ||
        registration.threadId !== route.threadId ||
        !isCodexRegistrationGeneration(registration.generation)
      ) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_NATIVE_LISTENER_MISSING",
          "The refreshed Codex route has no exact live native listener authority.",
        );
      }
      const nativeGeneration = this.requireCurrentNativeCodexGeneration(
        this.adapter("claude", event.current.hostId),
        route.alias,
      );
      if (nativeGeneration !== registration.generation) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_NATIVE_LISTENER_MISSING",
          "The refreshed Codex route's native listener generation changed before activation.",
        );
      }
    };

    try {
      for (const route of activatedRoutes) {
        const binding: PrivateRouteBinding = {
          ...event.current,
          routeHandle: route.threadId,
          ownerLease: route.ownerLease,
        };
        this.rememberBinding(route.alias, binding, route.state);
      }
      for (const route of activatedRoutes) {
        requireNativeContinuity(route);
        await this.setNativeCodexStatus(
          route.alias,
          route.state === "idle"
            ? "idle"
            : route.state === "awaiting_approval"
              ? "waiting"
              : "busy",
          true,
        );
        requireNativeContinuity(route);
      }
      await this.requireEndpointRefreshUnconflicted();
      for (const route of activatedRoutes) {
        const activityKey = `${transitionKey}\0${route.alias}`;
        if (!this.endpointRefreshActivityKeys.has(activityKey)) {
          this.endpointRefreshActivityKeys.add(activityKey);
          while (
            this.endpointRefreshActivityKeys.size > RUNTIME_ACTIVITY_CAPACITY
          ) {
            const oldest = this.endpointRefreshActivityKeys.values().next().value;
            if (oldest === undefined) break;
            this.endpointRefreshActivityKeys.delete(oldest);
          }
          this.activitySequence += 1;
          this.activityEvents.push({
            sequence: this.activitySequence,
            timestamp: this.now().toISOString(),
            kind: "endpoint",
            action: "endpoint_refreshed",
            outcome: "accepted",
            aliases: [route.alias],
            operatorAction: false,
          });
          while (this.activityEvents.length > RUNTIME_ACTIVITY_CAPACITY) {
            this.activityEvents.shift();
          }
        }
        if (route.state === "idle") this.scheduleDispatch(route.alias);
      }
      await this.changed();
      await this.requireEndpointRefreshUnconflicted();
      for (const route of activatedRoutes) {
        requireNativeContinuity(route);
      }
      // Provider writes remain closed until every durable and native transition
      // above is complete. This acknowledgement is deliberately the final
      // fallible activation step.
      const accept = adapter.acceptCompatibilityAttestation;
      if (accept === undefined) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_ACTIVATION_UNAVAILABLE",
          "The Codex provider cannot acknowledge the validated endpoint transition.",
        );
      }
      accept.call(adapter, event.attestation);
    } catch (error) {
      try {
        await this.store.markConnectorOffline(
          event.current,
          "CODEX_ENDPOINT_ACTIVATION_FAILED",
          [],
          { preserveQueued: true },
        );
        for (const route of activatedRoutes) {
          this.routeStates.set(route.alias, "stale");
        }
        await this.changed();
      } catch {
        this.dashboardHealthy = false;
      }
      throw error;
    }
    this.activatedEndpointRefreshes.set(event.current.hostId, transitionKey);
    if (
      this.pendingSelectorEndpointActivations.get(event.current.hostId)
        ?.transitionKey === transitionKey
    ) {
      this.pendingSelectorEndpointActivations.delete(event.current.hostId);
    }
    this.handledIncompatibleEndpointRefreshes.delete(event.current.hostId);
    this.activeCodexIncompatibility = undefined;
    return false;
  }

  private async onRouteState(
    source: PrivateEndpointIdentity,
    event: {
      routeHandle: string;
      state: GatewayAdapterRouteObservationState;
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
    const previousState = this.routeStates.get(alias);
    this.routeStates.set(alias, event.state);
    if (binding.provider === "claude" && event.state === "idle") {
      this.claudePrewriteIdleWaitTargets.delete(alias);
    }
    const staleSafeCode =
      binding.provider === "codex"
        ? "CODEX_ROUTE_STALE"
        : safeCode(event.safeErrorCode, "ROUTE_STALE");
    const adapter = this.adapter(source.provider, source.hostId);
    await this.store.observeConnector({
      identity: source,
      health: event.state === "stale" ? "degraded" : "healthy",
      compatibility: event.state === "stale" ? "expired" : "compatible",
      protocol: adapter.protocol,
      protocolVersion: adapter.protocolVersion,
      ...(event.safeErrorCode === undefined
        ? {}
        : {
            safeErrorCode: safeCode(
              event.safeErrorCode,
              "CONNECTOR_DEGRADED",
            ),
          }),
    });
    if (event.state === "stale") {
      if (previousState !== "stale") {
        this.addRuntimeAlert(
          staleSafeCode,
          "error",
          { provider: binding.provider, host: binding.hostId, alias },
        );
      }
      await this.store.observeRoute({
        binding,
        state: "stale",
        compatibility: "expired",
        safeErrorCode: staleSafeCode,
      });
    } else {
      await this.store.observeRoute({
        binding,
        state: event.state,
        compatibility: "compatible",
        ...(event.safeErrorCode === undefined
          ? {}
          : {
              safeErrorCode: safeCode(
                event.safeErrorCode,
                "ROUTE_DEGRADED",
              ),
        }),
      });
    }
    await this.store.touchProgressWatchesForAlias(alias);
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
    if (event.state === "idle" || event.state === "stale") {
      const heldTimer = this.heldRedispatchTimers.get(alias);
      if (heldTimer !== undefined) {
        this.timers.clearTimeout(heldTimer);
        this.heldRedispatchTimers.delete(alias);
      }
      this.scheduleDispatch(alias);
    }
  }

  private async setNativeCodexStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
    requireSuccess = false,
  ): Promise<void> {
    const binding = this.routeBindings.get(alias);
    if (binding?.provider !== "codex") return;
    const adapter = this.adapter("claude", binding.hostId);
    const update = adapter.updateNativeCodexPeerStatus;
    if (update === undefined) {
      if (requireSuccess) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_NATIVE_STATUS_FAILED",
          "The native listener does not support refreshed Codex status activation.",
          true,
        );
      }
      return;
    }
    try {
      await update.call(adapter, alias, status);
    } catch (error) {
      this.dashboardHealthy = false;
      if (requireSuccess) {
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_NATIVE_STATUS_FAILED",
          "The refreshed Codex route could not be activated in the native listener.",
          true,
        );
      }
    }
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

  private async exclusiveDecision(
    operation: () => Promise<void>,
    activity?: Readonly<{
      kind: GatewayActivityKind;
      action: GatewayActivityAction;
      aliases: readonly string[];
    }>,
  ): Promise<GatewayDecision> {
    return await this.mutex.run("service", async () => {
      let result: GatewayDecision;
      let rejectedSafeCode: string | undefined;
      try {
        await operation();
        result = { accepted: true, code: "ok" };
      } catch (error) {
        result = decisionFor(error);
        rejectedSafeCode =
          error instanceof BridgeError
            ? safeCode(error.code, "OPERATOR_ACTION_REJECTED")
            : "OPERATOR_ACTION_REJECTED";
      }
      if (activity !== undefined) {
        this.activitySequence += 1;
        this.activityEvents.push({
          sequence: this.activitySequence,
          timestamp: this.now().toISOString(),
          kind: activity.kind,
          action: activity.action,
          outcome: result.accepted ? "accepted" : "rejected",
          aliases: activity.aliases
            .filter((alias) => PUBLIC_ALIAS.test(alias))
            .slice(0, 2),
          operatorAction: true,
          ...(rejectedSafeCode === undefined
            ? {}
            : { safeErrorCode: rejectedSafeCode }),
        });
        while (this.activityEvents.length > RUNTIME_ACTIVITY_CAPACITY) {
          this.activityEvents.shift();
        }
      }
      return result;
    });
  }

  private async changed(): Promise<void> {
    this.revision += 1;
    await this.refreshNextProgressWatchWakeLocked();
    this.scheduleLifecycleWakeLocked();
    await this.publish();
  }

  private async publicSnapshotLocked(): Promise<GatewayPublicSnapshot> {
    const base = await this.store.publicSnapshot();
    const compatibilityChecks: CompatibilityAttestation[] = [];
    for (const surface of compatibilitySurfaces) {
      if (surface === "codex" && this.activeCodexIncompatibility !== undefined) {
        compatibilityChecks.push(
          structuredClone(this.activeCodexIncompatibility),
        );
        continue;
      }
      const currentVersions = [
        ...new Set(
          this.adapters.flatMap((adapter) => {
            const observation = adapter.compatibilitySurface?.();
            return observation?.surface === surface ? [observation.version] : [];
          }),
        ),
      ].sort((left, right) => left.localeCompare(right));
      const currentAttestations = (
        await Promise.all(
          currentVersions.map(
            async (version) =>
              await this.store.inspectCompatibilityAttestation(surface, version),
          ),
        )
      )
        .filter(
          (attestation): attestation is CompatibilityAttestation =>
            attestation !== undefined,
        )
        .sort((left, right) => {
          const checkedAt = right.checkedAt.localeCompare(left.checkedAt);
          if (checkedAt !== 0) return checkedAt;
          return left.version.localeCompare(right.version);
        });
      const selected = currentAttestations[0];
      if (selected !== undefined) compatibilityChecks.push(selected);
    }
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
      ...(compatibilityChecks.length === 0 ? {} : { compatibilityChecks }),
      availablePeers: peers,
      activityEvents: this.activityEvents.map((event) => ({
        ...event,
        aliases: [...event.aliases],
      })),
      truncation: {
        ...base.truncation,
        activityEvents: 0,
      },
      alerts: [
        ...base.alerts,
        ...this.runtimeAlerts.map((alert) => ({ ...alert })),
        ...stalledAlerts,
      ],
    });
  }

  private async publish(snapshot?: GatewayPublicSnapshot): Promise<void> {
    try {
      const current = snapshot ?? (await this.publicSnapshotLocked());
      await this.publishDashboard(this.store.rootDir, current);
      this.dashboardHealthy = true;
    } catch {
      this.dashboardHealthy = false;
    }
  }
}
