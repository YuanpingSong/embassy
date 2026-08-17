import { createHash } from "node:crypto";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  CLAUDE_PEER_COMPATIBILITY,
  ClaudePeerAdapter,
  type ClaudePeerDescriptor,
  type ClaudePeerDiscovery,
  type ClaudePeerInboundMessage,
  type ClaudePeerInboundProgress,
  type ClaudePeerListener,
  type ClaudePeerPreparedSend,
  type ClaudePeerProtocolNotice,
} from "./claude-peer.js";
import type { ClaudeNativeHelperCommand } from "./claude-helper-protocol.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import type { CodexAppServerTransport } from "./codex-app-server.js";
import type {
  LocalCodexTransportFactory,
} from "./codex-local-transport.js";
import type {
  StatelessCodexAcceptedOperation,
  StatelessCodexActiveSteerResult,
  StatelessCodexOperationResult,
  StatelessCodexOperationTransport,
  StatelessCodexSafeErrorCode,
} from "./codex-stateless-transport.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import {
  ClaudeNativeHelperSupervisor,
} from "./claude-helper-supervisor.js";
import type { ClaudeNativeHelperFactory } from "./claude-helper-client.js";
import { isDashboardLocale, type DashboardLocale } from "./locale.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDiscovery,
  GatewayAdapterDiscoverySnapshot,
  GatewayAdapterDispatchResult,
  GatewayAdapterDispatchInput,
  GatewayAdapterRouteState,
  GatewayAdapterRouteObservationState,
  GatewayAdapterRegistryObservation,
  GatewayAdapterStart,
  GatewayProviderAdapter,
} from "./service.js";
import type {
  GatewayProvider,
} from "./types.js";
import { gatewayRegistrationIngressPrefixes } from "./types.js";

const LOCAL_HOST = "this-mac";
const NATIVE_CLAUDE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const OPAQUE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CLAUDE_PENDING = 1_024;
const DEFAULT_CLAUDE_DISCOVERY_POLL_MS = 1_000;
const CLAUDE_REJECTION_RECEIPT_RETRY_DELAYS_MS = [25, 100, 250] as const;
const MAX_TRANSIENT_REPLY_BYTES = 64 * 1024;
const DEFAULT_CODEX_OBSERVATION_POLL_MS = 15_000;
const DEFAULT_CODEX_OBSERVATION_TIMEOUT_MS = 15_000;
const DEFAULT_CODEX_OBSERVATION_BACKOFF_MAX_MS = 60_000;
const MAX_CODEX_OBSERVED_ROUTES = 128;
const CLAUDE_CLEAN_PREWRITE_RETRY_CODES = new Set([
  "CLAUDE_PEER_TARGET_UNKNOWN",
  "CLAUDE_PEER_TARGET_STALE",
  "CLAUDE_PEER_TARGET_CHANGED",
  "CLAUDE_PEER_WORKSPACE_UNATTESTED",
]);
const CODEX_CLEAN_RETRY_CODES = new Set<StatelessCodexSafeErrorCode>([
  "THREAD_NOT_OBSERVED",
  "ROUTE_BUSY",
  "APPROVAL_REQUIRED",
  "MANAGED_CODEX_UNAVAILABLE",
  "LOCAL_APP_SERVER_NOT_RUNNING",
  "ENDPOINT_GENERATION_CHANGED",
  "SPAWN_FAILED",
  "SPAWN_TIMEOUT",
  "TRANSPORT_CONNECT_FAILED",
  "REQUEST_TIMEOUT",
]);

function claudeCleanPrewriteResult(
  error: unknown,
): GatewayAdapterDispatchResult {
  if (
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_MESSAGE_EXPIRED"
  ) {
    return { state: "expired", safeErrorCode: "MESSAGE_EXPIRED" };
  }
  if (
    error instanceof BridgeError &&
    CLAUDE_CLEAN_PREWRITE_RETRY_CODES.has(error.code)
  ) {
    return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
  }
  const systemCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    state: "failed",
    safeErrorCode:
      error instanceof BridgeError
        ? error.code
        : systemCode === "ENOENT"
          ? "CLAUDE_DISPATCH_PREWRITE_PATH_MISSING"
          : systemCode === "EACCES" || systemCode === "EPERM"
            ? "CLAUDE_DISPATCH_PREWRITE_ACCESS_DENIED"
            : systemCode === "ETIMEDOUT"
              ? "CLAUDE_DISPATCH_PREWRITE_TIMEOUT"
              : "CLAUDE_DISPATCH_PREWRITE_FAILED",
  };
}

function claudePostAuthorizationResult(
  error: unknown,
): GatewayAdapterDispatchResult {
  if (error instanceof BridgeError && error.recoverable) {
    return {
      state: "failed",
      safeErrorCode:
        error.code === "CLAUDE_PEER_MESSAGE_EXPIRED"
          ? "MESSAGE_EXPIRED"
          : error.code,
    };
  }
  return {
    state: "ambiguous",
    safeErrorCode:
      error instanceof BridgeError &&
      /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
        ? error.code
        : "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS",
  };
}

async function cancelPreparedClaude(
  prepared: Pick<ClaudePreparedGatewayDispatch, "cancel">,
): Promise<void> {
  try {
    await prepared.cancel();
  } catch {
    // Cancellation is a no-write cleanup path. Its failure cannot turn a
    // denied or uncertain authorization into permission to perform.
  }
}

type ClaudePeerFactory = (
  runtime: AttestedClaudePeerRuntime,
  locale: DashboardLocale,
  deliveryNotices: GatewayDeliveryNoticeMode,
) => ClaudePeerAdapter;

export type LocalClaudeGatewayProviderOptions = {
  /** Exact result of attestClaudePeerRuntime; paths are never rediscovered. */
  runtime: AttestedClaudePeerRuntime;
  hostId?: "this-mac";
  /** Locale for bounded notices written into native Claude sessions. */
  locale?: DashboardLocale;
  /** Gateway-authored user-frame policy; native receipt status is unchanged. */
  deliveryNotices?: GatewayDeliveryNoticeMode;
  discoveryPollMs?: number;
  maxPendingMessages?: number;
  now?: () => number;
  /** Production-only real-PID advertisement helpers. Omit in child/test hosts. */
  nativeHelpers?: Readonly<{
    maxHelpers: number;
    factory?: ClaudeNativeHelperFactory;
  }>;
  nativeHelperSourceProvider?: GatewayProvider;
  /** Deterministic test seam. Production callers must omit this. */
  peerFactory?: ClaudePeerFactory;
};

type NativeCodexPeerRegistration = Readonly<{
  alias: string;
  sourceProvider: GatewayProvider;
  cwd: string;
  name: string;
}>;

type NativeCodexListenerGeneration = {
  readonly generation: string;
  readonly listener: ClaudePeerListener;
  registration?: NativeCodexPeerRegistration;
  registrationProvisional: boolean;
  provisionalIngressForwarded: boolean;
};

type NativeInboundRoute = Readonly<{
  alias: string;
  listenerGeneration: string;
}>;

type ClaudeRejectedInbound = {
  receiptHandle: string;
  listener: ClaudePeerListener;
  listenerGeneration: string;
  released: boolean;
  cancelRetry?: () => void;
  operation: Promise<void>;
};

type ClaudePreparedGatewayDispatch = Readonly<{
  frameBytes: number;
  sha256: string;
  perform: () => Promise<GatewayAdapterDispatchResult>;
  cancel: () => void | Promise<void>;
}>;

type ClaudePreparedDirectDispatch = ClaudePreparedGatewayDispatch &
  Readonly<{ messageId: string }>;

type ClaudeDispatchPreparationInput = Readonly<
  Pick<
    GatewayAdapterDispatchInput,
    | "sourceAlias"
    | "sourceProvider"
    | "targetAlias"
    | "conversationId"
    | "binding"
    | "authorization"
    | "messageId"
    | "text"
    | "expectsReply"
    | "deadlineAt"
    | "progressWatchActive"
  >
>;

function exactLocalHost(hostId: string | undefined): "this-mac" {
  if ((hostId ?? LOCAL_HOST) !== LOCAL_HOST) {
    throw new BridgeError(
      "GATEWAY_REMOTE_PROVIDER_DISABLED",
      "This provider is restricted to the exact local host boundary.",
    );
  }
  return LOCAL_HOST;
}

function positiveBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
      "A provider capacity is outside its reviewed bound.",
    );
  }
  return resolved;
}

function strictDeadline(value: string, now: number): number | undefined {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value ||
    parsed <= now
  ) {
    return undefined;
  }
  return parsed;
}

function sameEndpoint(
  binding: Readonly<{ provider: GatewayProvider; hostId: string }>,
  identity: Readonly<{ provider: GatewayProvider; hostId: string }>,
): boolean {
  return (
    binding.provider === identity.provider &&
    binding.hostId === identity.hostId
  );
}

function callbackEndpoint(
  identity: Readonly<{ provider: "claude"; hostId: string }>,
  routeHandle: string,
): Readonly<{ provider: "claude"; hostId: string; routeHandle: string }> {
  return { ...identity, routeHandle };
}

function invokeCallback(operation: () => void): void {
  try {
    operation();
  } catch {
    // Provider observation consumers cannot change a transport outcome.
  }
}

function validateAttestedClaudeRuntime(
  runtime: AttestedClaudePeerRuntime,
): void {
  validateClaudeRuntimePathEvidence(runtime);
}

function validateClaudeRuntimePathEvidence(
  runtime: AttestedClaudePeerRuntime,
): void {
  if (
    [
      runtime.claudeExecutable,
      runtime.sessionsDir,
      runtime.socketDir,
    ].some(
      (value) =>
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value.includes("\0"),
    )
  ) {
    throw new BridgeError(
      "CLAUDE_RUNTIME_ATTESTATION_INVALID",
      "The local Claude provider requires bounded absolute runtime evidence.",
    );
  }
}

function claudeRouteState(
  peer: ClaudePeerDescriptor,
): GatewayAdapterRouteState {
  return peer.status === "idle" ? "idle" : "busy";
}

function claudeRegistryObservation(
  discovery: Pick<
    ClaudePeerDiscovery,
    "entriesScanned" | "parseableRecords" | "rejected"
  >,
): GatewayAdapterRegistryObservation {
  const rejected = Object.entries(discovery.rejected)
    .filter(
      (entry): entry is [string, number] =>
        Number.isSafeInteger(entry[1]) && entry[1] > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([safeErrorCode, count]) =>
      Object.freeze({ safeErrorCode, count }),
    );
  return Object.freeze({
    entriesScanned: discovery.entriesScanned,
    parseableRecords: discovery.parseableRecords,
    rejected: Object.freeze(rejected),
  });
}

function unavailableClaudeRegistryObservation(): GatewayAdapterRegistryObservation {
  return Object.freeze({
    entriesScanned: 0,
    parseableRecords: 0,
    rejected: Object.freeze([
      Object.freeze({
        safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE",
        count: 1,
      }),
    ]),
  });
}

function isClaudeRegistryAvailabilityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "ENOENT" ||
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "UNSAFE_PEER_DIRECTORY"
  );
}

export class LocalClaudeGatewayProvider implements GatewayProviderAdapter {
  readonly identity: Readonly<{
    provider: "claude";
    hostId: "this-mac";
  }>;
  readonly protocol = "claude-peer";
  readonly protocolVersion = `${CLAUDE_PEER_COMPATIBILITY.peerProtocol}`;

  private readonly peer: ClaudePeerAdapter;
  private readonly maxPending: number;
  private readonly discoveryPollMs: number;
  private readonly now: () => number;
  private readonly selectedStateRoots = new Map<string, string>();
  private readonly nativeHelpers: ClaudeNativeHelperSupervisor | undefined;
  private readonly nativeHelperSourceProvider: GatewayProvider | undefined;
  private readonly discovered = new Map<string, GatewayAdapterDiscovery>();
  private readonly selected = new Map<string, string>();
  /** Durable logical identity mirrored only for exact observation callbacks. */
  private readonly logicalRoutes = new Map<
    string,
    Readonly<{ alias: string; registrationId: string }>
  >();
  /** Exact live same-UID sessions observed through native inbound frames. */
  private readonly nativeInbound = new Map<string, NativeInboundRoute>();
  /** Exact listener owner for every receipt capability handed to the service. */
  private readonly nativeInboundReceiptOwners = new Map<
    string,
    NativeCodexListenerGeneration
  >();
  private readonly selectedObservations = new Map<string, string>();
  /** Invalidates any discovery that overlaps a dispatch on this route. */
  private readonly selectedDispatchEpoch = new Map<string, number>();
  /**
   * A dispatch invalidates the pre-dispatch registry observation. The first
   * subsequent successful discovery must therefore be published even when
   * the native peer completed between polls and is idle again.
   */
  private readonly selectedObservationDirty = new Set<string>();
  /** Provider-owned terminal rejections that never enter the service queue. */
  private readonly rejectedNativeInbound = new Map<
    string,
    ClaudeRejectedInbound
  >();
  private discoveryInFlight:
    | Promise<GatewayAdapterDiscoverySnapshot>
    | undefined;
  private registryObservation: GatewayAdapterRegistryObservation | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  /** Invocation-ordered registry mutations; the tail itself never rejects. */
  private nativeCodexRegistrationTail: Promise<void> = Promise.resolve();
  private callbacks: GatewayAdapterCallbacks | undefined;
  private activeNativeCodexListener:
    | NativeCodexListenerGeneration
    | undefined;
  /** External registry trust/availability failures degrade Claude only. */
  private unavailableCode: string | undefined;
  private initialized = false;
  private closed = false;

  constructor(options: LocalClaudeGatewayProviderOptions) {
    validateAttestedClaudeRuntime(options.runtime);
    if (options.locale !== undefined && !isDashboardLocale(options.locale)) {
      throw new BridgeError(
        "DASHBOARD_LOCALE_UNSUPPORTED",
        "The Claude provider notice locale is unsupported.",
      );
    }
    const hostId = exactLocalHost(options.hostId);
    this.identity = {
      provider: "claude",
      hostId,
    };
    this.maxPending = positiveBounded(
      options.maxPendingMessages,
      MAX_CLAUDE_PENDING,
      4_096,
    );
    this.discoveryPollMs = positiveBounded(
      options.discoveryPollMs,
      DEFAULT_CLAUDE_DISCOVERY_POLL_MS,
      30_000,
    );
    this.now = options.now ?? Date.now;
    const protocolRuntime: AttestedClaudePeerRuntime = {
      claudeExecutable: options.runtime.claudeExecutable,
      claudeCodeVersion: options.runtime.claudeCodeVersion,
      sessionsDir: options.runtime.sessionsDir,
      socketDir: options.runtime.socketDir,
    };
    this.peer = (options.peerFactory ??
      ((runtime, locale, deliveryNotices) =>
        new ClaudePeerAdapter({
          sessionsDir: runtime.sessionsDir,
          socketDir: runtime.socketDir,
          attestedClaudeCodeVersion: runtime.claudeCodeVersion,
          locale,
          deliveryNotices,
        })))(
      protocolRuntime,
      options.locale ?? "en",
      options.deliveryNotices ?? "merged",
    );
    this.nativeHelpers =
      options.nativeHelpers === undefined
        ? undefined
        : new ClaudeNativeHelperSupervisor({
            identity: this.identity,
            runtime: protocolRuntime,
            locale: options.locale ?? "en",
            deliveryNotices: options.deliveryNotices ?? "merged",
            maxPendingMessages: this.maxPending,
            maxHelpers: positiveBounded(
              options.nativeHelpers.maxHelpers,
              256,
              128,
            ),
            callbacks: () => this.callbacks,
            ...(options.nativeHelpers.factory === undefined
              ? {}
              : { factory: options.nativeHelpers.factory }),
          });
    this.nativeHelperSourceProvider = options.nativeHelperSourceProvider;
  }

  latestRegistryObservation(): GatewayAdapterRegistryObservation | undefined {
    return this.registryObservation;
  }

  async initialize(
    callbacks: GatewayAdapterCallbacks,
  ): Promise<GatewayAdapterStart> {
    if (this.closed) {
      throw new BridgeError(
        "CLAUDE_PROVIDER_CLOSED",
        "The local Claude provider is closed.",
      );
    }
    if (this.initialized) {
      throw new BridgeError(
        "CLAUDE_PROVIDER_ALREADY_INITIALIZED",
        "The local Claude provider can be initialized only once.",
      );
    }
    this.callbacks = callbacks;
    if (this.nativeHelpers !== undefined) {
      this.initialized = true;
      return { health: "healthy" };
    }
    try {
      let listenerGeneration: NativeCodexListenerGeneration | undefined;
      const listener = await this.peer.listen({
        onMessage: async (message) => {
          if (listenerGeneration !== undefined) {
            await this.onListenerMessage(listenerGeneration, message);
          }
        },
        onProtocolNotice: (notice: ClaudePeerProtocolNotice) => {
          this.callbacks?.onProtocolNotice?.({ code: notice.code });
        },
      });
      listenerGeneration = {
        generation: listener.generation,
        listener,
        registrationProvisional: false,
        provisionalIngressForwarded: false,
      };
      if (this.closed) {
        await listener.close();
        throw new BridgeError(
          "CLAUDE_PROVIDER_CLOSED",
          "The local Claude provider closed during initialization.",
        );
      }
      this.activeNativeCodexListener = listenerGeneration;
      this.initialized = true;
      return { health: "healthy" };
    } catch (error) {
      if (
        error instanceof BridgeError &&
        error.code === "UNSAFE_PEER_DIRECTORY"
      ) {
        this.unavailableCode = "CLAUDE_REGISTRY_UNAVAILABLE";
        this.registryObservation = unavailableClaudeRegistryObservation();
        this.initialized = true;
        return {
          health: "degraded",
          safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE",
        };
      }
      this.callbacks = undefined;
      if (
        error instanceof BridgeError &&
        error.code === "CLAUDE_PEER_CALLBACK_UNSAFE"
      ) {
        throw error;
      }
      throw new BridgeError(
        "CLAUDE_CALLBACK_UNAVAILABLE",
        "The private Claude callback listener could not be established.",
      );
    }
  }

  async discoverClaudePeers(): Promise<GatewayAdapterDiscoverySnapshot> {
    this.assertReady();
    return await this.refreshClaudeDiscovery();
  }

  async assertWorkspaceDisjoint(
    routeHandle: string,
    stateRoot: string,
  ): Promise<void> {
    this.assertReady();
    await this.peer.assertTargetWorkspaceDisjoint(routeHandle, stateRoot);
    this.selectedStateRoots.set(routeHandle, stateRoot);
  }

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }> {
    this.assertReady();
    const candidate = this.discovered.get(input.routeHandle);
    if (candidate === undefined || candidate.alias !== input.alias) {
      throw new BridgeError(
        "CLAUDE_ROUTE_MISMATCH",
        "The selected Claude alias no longer matches that exact peer generation.",
      );
    }
    this.selected.set(input.routeHandle, input.alias);
    this.selectedDispatchEpoch.set(
      input.routeHandle,
      this.selectedDispatchEpoch.get(input.routeHandle) ?? 0,
    );
    this.selectedObservationDirty.delete(input.routeHandle);
    this.selectedObservations.set(
      input.routeHandle,
      `${candidate.state}:`,
    );
    this.scheduleClaudeMonitor();
    return { routeHandle: input.routeHandle, state: candidate.state };
  }

  observeLogicalRoute(input: {
    alias: string;
    routeHandle: string;
    registrationId: string;
  }): void {
    if (
      this.closed ||
      !PUBLIC_ALIAS.test(input.alias) ||
      !input.alias.endsWith(`@${this.identity.hostId}`) ||
      !OPAQUE_ROUTE.test(input.routeHandle) ||
      !OPAQUE_ROUTE.test(input.registrationId)
    ) {
      return;
    }
    this.logicalRoutes.set(input.routeHandle, {
      alias: input.alias,
      registrationId: input.registrationId,
    });
  }

  forgetLogicalRoute(registrationId: string): void {
    for (const [routeHandle, route] of this.logicalRoutes) {
      if (route.registrationId === registrationId) {
        this.logicalRoutes.delete(routeHandle);
      }
    }
  }

  async resolveReplyAddress(
    address: string,
  ): Promise<{ routeHandle: string }> {
    this.assertReady();
    const resolved = await this.peer.resolveReplyAddress(address);
    const selectedAlias = this.selected.get(resolved.targetId);
    if (
      selectedAlias === undefined ||
      resolved.kind !== "interactive" ||
      selectedAlias !== `${resolved.alias}@${this.identity.hostId}`
    ) {
      throw new BridgeError(
        "CLAUDE_REPLY_ROUTE_MISMATCH",
        "The reply capability is not the exact selected Claude generation.",
      );
    }
    return { routeHandle: resolved.targetId };
  }

  async advertiseNativeSourcePeer(input: {
    alias: string;
    sourceProvider: GatewayProvider;
    cwd: string;
  }): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      this.assertReady();
      await this.nativeHelpers.advertise(input);
      return;
    }
    if (
      input.sourceProvider !== "codex" &&
      input.sourceProvider !== this.nativeHelperSourceProvider
    ) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_UNAVAILABLE",
        "A non-Codex source requires a supervised native Claude helper.",
        true,
      );
    }
    const registration = this.nativeCodexRegistration(input);
    await this.serializeNativeCodexRegistration(async () => {
      this.assertReady();
      const active = this.requireActiveNativeCodexListener();
      if (
        active.registration !== undefined &&
        active.registration.alias !== registration.alias
      ) {
        throw new BridgeError(
          "CODEX_PEER_ALREADY_ADVERTISED",
          "This listener generation already advertises another Codex peer.",
        );
      }
      const installedProvisional = active.registration === undefined;
      if (installedProvisional) {
        active.registration = registration;
        active.registrationProvisional = true;
        active.provisionalIngressForwarded = false;
      }
      try {
        await active.listener.advertise(registration.name, registration.cwd);
        // Reassert exact ownership after publication. A preceding serialized
        // attempt may have removed its own clean provisional registration.
        active.registration = registration;
        active.registrationProvisional = false;
        active.provisionalIngressForwarded = false;
      } catch (error) {
        if (
          error instanceof BridgeError &&
          error.recoverable &&
          installedProvisional &&
          active.registration === registration &&
          !active.provisionalIngressForwarded
        ) {
          delete active.registration;
          active.registrationProvisional = false;
        }
        throw error;
      }
    });
  }

  /** Child-host initialization seam before its immutable advertisement exists. */
  currentUnadvertisedNativeCodexPeerGeneration(): string {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_NESTING_FORBIDDEN",
        "A supervised provider cannot itself act as a native helper host.",
      );
    }
    const active = this.requireActiveNativeCodexListener();
    if (active.registration !== undefined) {
      throw new BridgeError(
        "CODEX_PEER_ALREADY_ADVERTISED",
        "The native listener already owns an advertised Codex identity.",
      );
    }
    return active.generation;
  }

  async unadvertiseNativeSourcePeer(alias: string): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.unadvertise(alias);
      return;
    }
    await this.serializeNativeCodexRegistration(async () => {
      const active = this.activeNativeCodexListener;
      if (active?.registration?.alias !== alias) return;
      await active.listener.unadvertise(active.registration.name);
      for (const [routeHandle, route] of this.nativeInbound) {
        if (route.listenerGeneration === active.generation) {
          this.nativeInbound.delete(routeHandle);
        }
      }
      delete active.registration;
      active.registrationProvisional = false;
      active.provisionalIngressForwarded = false;
    });
  }

  async updateNativeSourcePeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.updateStatus(alias, status);
      return;
    }
    const active = this.activeNativeCodexListener;
    if (active?.registration?.alias !== alias) return;
    await active.listener.updateAdvertisedStatus(status);
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.updateInboundStatus(
        receiptHandle,
        status,
        diagnosticCode,
      );
      return;
    }
    const owner = this.requireNativeInboundReceiptOwner(receiptHandle);
    try {
      await owner.listener.acknowledge(
        receiptHandle,
        status,
        diagnosticCode === undefined ? undefined : { code: diagnosticCode },
      );
      if (status !== "held") {
        this.nativeInboundReceiptOwners.delete(receiptHandle);
      }
    } catch (error) {
      if (
        status !== "held" &&
        (!(error instanceof BridgeError) || !error.recoverable)
      ) {
        this.nativeInboundReceiptOwners.delete(receiptHandle);
      }
      throw error;
    }
  }

  async notifyNativeInboundProgress(
    receiptHandle: string,
    progress: ClaudePeerInboundProgress,
  ): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.notifyInboundProgress(receiptHandle, progress);
      return;
    }
    const owner = this.requireNativeInboundReceiptOwner(receiptHandle);
    await owner.listener.notifyInboundProgress(receiptHandle, progress);
  }

  async releaseNativeInboundReceipt(
    receiptHandle: string,
  ): Promise<boolean> {
    if (this.nativeHelpers !== undefined) {
      return await this.nativeHelpers.releaseInboundReceipt(receiptHandle);
    }
    const owner = this.nativeInboundReceiptOwners.get(receiptHandle);
    if (owner === undefined) return false;
    this.nativeInboundReceiptOwners.delete(receiptHandle);
    return owner.listener.releaseInboundReceipt(receiptHandle);
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    if (this.unavailableCode !== undefined) {
      return {
        state: "failed",
        safeErrorCode: this.unavailableCode,
      };
    }
    if (
      !this.initialized ||
      this.closed ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
    }
    if (input.authorization === "selected_route") {
      const logical = this.logicalRoutes.get(input.binding.routeHandle);
      if (
        logical === undefined ||
        logical.alias !== input.targetAlias ||
        logical.registrationId !== input.binding.registrationId
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      this.selectedDispatchEpoch.set(
        input.binding.routeHandle,
        (this.selectedDispatchEpoch.get(input.binding.routeHandle) ?? 0) + 1,
      );
      this.selectedObservationDirty.add(input.binding.routeHandle);
      this.emitClaudeRouteObservation(input.binding.routeHandle, "busy");
    }

    let prepared: ClaudePreparedGatewayDispatch;
    try {
      if (this.nativeHelpers !== undefined) {
        const selectedAlias = this.selected.get(input.binding.routeHandle);
        const stateRoot = this.selectedStateRoots.get(input.binding.routeHandle);
        prepared = await this.nativeHelpers.prepareDispatch({
          sourceAlias: input.sourceAlias,
          sourceProvider: input.sourceProvider,
          targetAlias: input.targetAlias,
          conversationId: input.conversationId,
          binding: input.binding,
          authorization: input.authorization,
          messageId: input.messageId,
          text: input.text,
          expectsReply: input.expectsReply,
          deadlineAt: input.deadlineAt,
          ...(selectedAlias === undefined ? {} : { selectedAlias }),
          ...(stateRoot === undefined ? {} : { stateRoot }),
          ...(input.progressWatchActive === true
            ? { progressWatchActive: true as const }
            : {}),
        });
      } else {
        prepared = await this.prepareDirectClaudeDispatch(input);
      }
    } catch (error) {
      if (
        error instanceof BridgeError &&
        CLAUDE_CLEAN_PREWRITE_RETRY_CODES.has(error.code)
      ) {
        this.emitClaudeRouteObservation(
          input.binding.routeHandle,
          "busy",
          error.code,
        );
      }
      return claudeCleanPrewriteResult(error);
    }
    const evidence = {
      attemptId: input.attemptId,
      kind: "claude_mailbox" as const,
      bodyBytes: Buffer.byteLength(input.text, "utf8"),
      bodySha256: createHash("sha256").update(input.text).digest("hex"),
      frameBytes: prepared.frameBytes,
      sha256: prepared.sha256,
    };
    let authorized: boolean;
    try {
      authorized = await input.authorizeWrite(evidence);
    } catch {
      await cancelPreparedClaude(prepared);
      return {
        state: "ambiguous",
        safeErrorCode: "WRITE_AUTHORIZATION_UNCERTAIN",
      };
    }
    if (!authorized) {
      await cancelPreparedClaude(prepared);
      return {
        state: "failed",
        safeErrorCode: "WRITE_AUTHORIZATION_DENIED",
      };
    }
    try {
      // Authorization is the consent linearization point. Invoke the exact
      // prepared mailbox write in the same continuation with no intervening
      // await. Claude has no separate acceptance phase: confirmed mailbox
      // completion is terminal delivered.
      const operation = prepared.perform();
      const result = await operation;
      if (result.state === "deferred") {
        return {
          state: "ambiguous",
          safeErrorCode: "CLAUDE_PREPARED_RESULT_INVALID",
        };
      }
      return result.state === "expired"
        ? { state: "failed", safeErrorCode: "MESSAGE_EXPIRED" }
        : result;
    } catch (error) {
      return claudePostAuthorizationResult(error);
    }
  }

  async prepareNativeHelperDispatch(
    command: Extract<
      ClaudeNativeHelperCommand,
      { method: "prepare_dispatch" }
    >,
  ): Promise<ClaudePreparedDirectDispatch> {
    if (this.nativeHelpers !== undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_INVALID_HOST",
        "A supervising provider cannot recursively prepare a native helper write.",
      );
    }
    return await this.prepareDirectClaudeDispatch(command);
  }

  private async prepareDirectClaudeDispatch(
    input: ClaudeDispatchPreparationInput,
  ): Promise<ClaudePreparedDirectDispatch> {
    const activeListener = this.activeNativeCodexListener;
    if (
      !this.initialized ||
      this.closed ||
      activeListener === undefined ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      throw new BridgeError(
        "CLAUDE_ROUTE_UNAVAILABLE",
        "The exact Claude route is unavailable.",
        true,
      );
    }
    if (input.authorization === "native_reply") {
      const observedRoute = this.nativeInbound.get(input.binding.routeHandle);
      if (
        observedRoute === undefined ||
        observedRoute.alias !== input.targetAlias ||
        observedRoute.listenerGeneration !== activeListener.generation
      ) {
        this.nativeInbound.delete(input.binding.routeHandle);
        throw new BridgeError(
          "CLAUDE_NATIVE_REPLY_STALE",
          "The exact native Claude reply route is stale.",
        );
      }
    } else if (
      this.selected.get(input.binding.routeHandle) === undefined ||
      this.selectedStateRoots.get(input.binding.routeHandle) === undefined
    ) {
      throw new BridgeError(
        "CLAUDE_ROUTE_UNAVAILABLE",
        "The exact selected Claude route is unavailable.",
        true,
      );
    }
    if (
      activeListener.registration?.alias !== input.sourceAlias ||
      activeListener.registration.sourceProvider !== input.sourceProvider ||
      this.activeNativeCodexListener !== activeListener
    ) {
      throw new BridgeError(
        "CLAUDE_ROUTE_UNAVAILABLE",
        "The exact native source advertisement is unavailable.",
        true,
      );
    }
    const deadline = strictDeadline(input.deadlineAt, this.now());
    if (deadline === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_MESSAGE_EXPIRED",
        "The Claude mailbox deadline elapsed before preparation.",
        true,
      );
    }
    const content = composeProvenanceEnvelope({
      sourceProvider: input.sourceProvider,
      recipientProvider: "claude",
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      conversationId: input.conversationId,
      body: input.text,
      ...(input.progressWatchActive === true
        ? { progressWatchActive: true as const }
        : {}),
    });
    const prepared: ClaudePeerPreparedSend = await this.peer.prepareSend(
      input.binding.routeHandle,
      content,
      {
        deadlineAt: deadline,
        replyListener: activeListener.listener,
      },
    );
    return Object.freeze({
      messageId: prepared.messageId,
      frameBytes: prepared.frameBytes,
      sha256: prepared.sha256,
      cancel: prepared.cancel,
      perform: () => {
        const operation = prepared.perform();
        return operation.then(
          () => ({ state: "delivered" as const }),
          (error) => claudePostAuthorizationResult(error),
        );
      },
    });
  }

  async releaseRoute(routeHandle: string): Promise<void> {
    this.selected.delete(routeHandle);
    this.selectedDispatchEpoch.delete(routeHandle);
    this.selectedObservationDirty.delete(routeHandle);
    this.selectedObservations.delete(routeHandle);
    this.discovered.delete(routeHandle);
    this.selectedStateRoots.delete(routeHandle);
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.releaseRoute(routeHandle);
    }
    if (this.selected.size === 0 && this.monitorTimer !== undefined) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const rejection of this.rejectedNativeInbound.values()) {
      this.releaseRejectedNativeInbound(rejection);
    }
    this.rejectedNativeInbound.clear();
    try {
      await this.nativeHelpers?.close();
      await this.peer.close();
    } finally {
      this.selected.clear();
      this.logicalRoutes.clear();
      this.selectedStateRoots.clear();
      this.nativeInbound.clear();
      this.nativeInboundReceiptOwners.clear();
      this.selectedDispatchEpoch.clear();
      this.selectedObservationDirty.clear();
      this.selectedObservations.clear();
      this.discovered.clear();
      if (this.monitorTimer !== undefined) clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
      this.activeNativeCodexListener = undefined;
      this.callbacks = undefined;
    }
  }

  private assertReady(): void {
    if (!this.initialized || this.closed || this.unavailableCode !== undefined) {
      throw new BridgeError(
        "CLAUDE_PROVIDER_UNAVAILABLE",
        "The local Claude provider is not available.",
        true,
      );
    }
  }

  private serializeNativeCodexRegistration<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const queued = this.nativeCodexRegistrationTail.then(operation);
    this.nativeCodexRegistrationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private nativeCodexRegistration(input: {
    alias: string;
    sourceProvider: GatewayProvider;
    cwd: string;
  }): NativeCodexPeerRegistration {
    const suffix = `@${this.identity.hostId}`;
    if (!input.alias.endsWith(suffix)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_ALIAS",
        "The native Codex peer alias must target this host.",
      );
    }
    const name = input.alias.slice(0, -suffix.length);
    const prefix = gatewayRegistrationIngressPrefixes[input.sourceProvider];
    if (prefix === undefined || !name.startsWith(prefix) || !NATIVE_CLAUDE_NAME.test(name)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_ALIAS",
        "The native source peer alias must use its provider prefix.",
      );
    }
    if (!path.isAbsolute(input.cwd) || input.cwd.includes("\0")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_CWD",
        "A native Codex peer requires an absolute working directory.",
      );
    }
    return { alias: input.alias, sourceProvider: input.sourceProvider, cwd: input.cwd, name };
  }

  private requireActiveNativeCodexListener(): NativeCodexListenerGeneration {
    this.assertReady();
    const active = this.activeNativeCodexListener;
    if (active === undefined) {
      throw new BridgeError(
        "CLAUDE_CALLBACK_UNAVAILABLE",
        "The private Claude callback listener is unavailable.",
        true,
      );
    }
    return active;
  }

  private requireNativeInboundReceiptOwner(
    receiptHandle: string,
  ): NativeCodexListenerGeneration {
    this.assertReady();
    const owner = this.nativeInboundReceiptOwners.get(receiptHandle);
    if (owner === undefined || !this.ownsNativeCodexListener(owner)) {
      throw new BridgeError(
        "CLAUDE_PEER_RECEIPT_UNKNOWN",
        "The native Claude peer receipt is unknown or already settled.",
      );
    }
    return owner;
  }

  private ownsNativeCodexListener(
    listenerGeneration: NativeCodexListenerGeneration,
  ): boolean {
    return this.activeNativeCodexListener === listenerGeneration;
  }

  private async onListenerMessage(
    listenerGeneration: NativeCodexListenerGeneration,
    message: ClaudePeerInboundMessage,
  ): Promise<void> {
    const reject = async (diagnosticCode: string): Promise<void> => {
      if (message.receiptHandle !== undefined) {
        await this.rejectNativeInboundReceipt(
          listenerGeneration,
          message.receiptHandle,
          diagnosticCode,
        );
      }
    };
    if (
      this.unavailableCode !== undefined ||
      this.closed ||
      listenerGeneration.listener.closed ||
      !this.ownsNativeCodexListener(listenerGeneration)
    ) {
      try {
        if (message.receiptHandle !== undefined) {
          listenerGeneration.listener.releaseInboundReceipt(
            message.receiptHandle,
          );
        }
      } catch {
        // A detached generation has no safe callback or settlement authority.
      }
      return;
    }
    if (
      this.activeNativeCodexListener !== listenerGeneration
    ) {
      await reject("CLAUDE_NATIVE_GENERATION_STALE");
      return;
    }
    const registrationAtIngress = listenerGeneration.registration;
    if (
      message.sourceTargetId === undefined ||
      message.sourceAlias === undefined ||
      !message.replySupported
    ) {
      await reject("CLAUDE_SOURCE_ROUTE_INVALID");
      return;
    }

    const sourceTargetId = message.sourceTargetId;
    let sourceAlias: string | undefined;
    try {
      await this.refreshClaudeDiscovery();
      const current = this.discovered.get(sourceTargetId);
      const expectedAlias = `${message.sourceAlias}@${this.identity.hostId}`;
      if (current?.alias === expectedAlias) sourceAlias = expectedAlias;
    } catch {
      sourceAlias = undefined;
    }
    // Discovery is asynchronous. Recheck exact generation ownership before
    // giving the body or its receipt capability to a service callback.
    if (
      this.activeNativeCodexListener !== listenerGeneration ||
      listenerGeneration.registration !== registrationAtIngress
    ) {
      await reject("CLAUDE_NATIVE_GENERATION_STALE");
      return;
    }
    if (sourceAlias === undefined) {
      await reject("CLAUDE_SOURCE_ROUTE_STALE");
      return;
    }

    const callbacks = this.callbacks;
    const registration = registrationAtIngress;
    if (registration !== undefined) {
      if (
        callbacks?.onClaudeMessage === undefined ||
        (!this.nativeInbound.has(sourceTargetId) &&
          this.nativeInbound.size >= this.maxPending) ||
        (message.receiptHandle !== undefined &&
          !this.nativeInboundReceiptOwners.has(message.receiptHandle) &&
          this.nativeInboundReceiptOwners.size >= this.maxPending)
      ) {
        await reject("CLAUDE_NATIVE_INGRESS_CAPACITY");
        return;
      }
      if (
        message.receiptHandle !== undefined &&
        this.nativeInboundReceiptOwners.has(message.receiptHandle)
      ) {
        await reject("CLAUDE_NATIVE_RECEIPT_COLLISION");
        return;
      }
      this.nativeInbound.set(sourceTargetId, {
        alias: sourceAlias,
        listenerGeneration: listenerGeneration.generation,
      });
      if (message.receiptHandle !== undefined) {
        this.nativeInboundReceiptOwners.set(
          message.receiptHandle,
          listenerGeneration,
        );
      }
      if (listenerGeneration.registrationProvisional) {
        listenerGeneration.provisionalIngressForwarded = true;
      }
      invokeCallback(() =>
        callbacks.onClaudeMessage?.({
          endpoint: callbackEndpoint(this.identity, sourceTargetId),
          sourceAlias,
          targetAlias: registration.alias,
          text: message.content,
          ...(message.receiptHandle === undefined
            ? {}
            : { receiptHandle: message.receiptHandle }),
        }),
      );
      return;
    }
    if (callbacks !== undefined && this.selected.get(sourceTargetId) === sourceAlias) {
      invokeCallback(() =>
        callbacks.onClaudeReply({
          endpoint: callbackEndpoint(this.identity, sourceTargetId),
          text: message.content,
        }),
      );
      return;
    }
    await reject("CLAUDE_ROUTE_UNAVAILABLE");
  }

  private rejectNativeInboundReceipt(
    listenerGeneration: NativeCodexListenerGeneration,
    receiptHandle: string,
    diagnosticCode: string,
  ): Promise<void> {
    const rejectionKey = `${listenerGeneration.generation}\0${receiptHandle}`;
    const existing = this.rejectedNativeInbound.get(rejectionKey);
    if (existing !== undefined) return existing.operation;
    const listener = listenerGeneration.listener;
    if (
      this.closed ||
      listener.closed ||
      !this.ownsNativeCodexListener(listenerGeneration)
    ) {
      try {
        listener.releaseInboundReceipt(receiptHandle);
      } catch {
        // A missing/closing listener leaves no safe terminal write path.
      }
      return Promise.resolve();
    }
    const rejection: ClaudeRejectedInbound = {
      receiptHandle,
      listener,
      listenerGeneration: listenerGeneration.generation,
      released: false,
      operation: Promise.resolve(),
    };
    this.rejectedNativeInbound.set(rejectionKey, rejection);
    rejection.operation = this.settleRejectedNativeInbound(
      rejection,
      diagnosticCode,
    ).finally(() => {
      if (this.rejectedNativeInbound.get(rejectionKey) === rejection) {
        this.rejectedNativeInbound.delete(rejectionKey);
      }
    });
    return rejection.operation;
  }

  private async settleRejectedNativeInbound(
    rejection: ClaudeRejectedInbound,
    diagnosticCode: string,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= CLAUDE_REJECTION_RECEIPT_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      if (
        this.closed ||
        rejection.released ||
        rejection.listener.closed ||
        !this.ownsNativeCodexListenerGeneration(
          rejection.listenerGeneration,
          rejection.listener,
        )
      ) {
        this.releaseRejectedNativeInbound(rejection);
        return;
      }
      try {
        await rejection.listener.acknowledge(
          rejection.receiptHandle,
          "expired",
          { code: diagnosticCode },
        );
        return;
      } catch (error) {
        if (rejection.released) return;
        const cleanPrewrite =
          error instanceof BridgeError && error.recoverable;
        if (
          !cleanPrewrite ||
          attempt === CLAUDE_REJECTION_RECEIPT_RETRY_DELAYS_MS.length
        ) {
          // Ambiguous/nonrecoverable writes are never replayed. Explicit
          // release is idempotent even if the listener already consumed the
          // terminal capability after a possibly-written attempt.
          this.releaseRejectedNativeInbound(rejection);
          return;
        }
      }
      await this.waitForRejectedNativeInboundRetry(
        rejection,
        CLAUDE_REJECTION_RECEIPT_RETRY_DELAYS_MS[attempt]!,
      );
    }
  }

  private ownsNativeCodexListenerGeneration(
    generation: string,
    listener: ClaudePeerListener,
  ): boolean {
    const active = this.activeNativeCodexListener;
    return active?.generation === generation && active.listener === listener;
  }

  private async waitForRejectedNativeInboundRetry(
    rejection: ClaudeRejectedInbound,
    delayMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rejection.cancelRetry === finish) {
          delete rejection.cancelRetry;
        }
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      rejection.cancelRetry = finish;
      if (this.closed || rejection.released) finish();
    });
  }

  private releaseRejectedNativeInbound(
    rejection: ClaudeRejectedInbound,
  ): void {
    if (rejection.released) return;
    rejection.released = true;
    rejection.cancelRetry?.();
    try {
      rejection.listener.releaseInboundReceipt(rejection.receiptHandle);
    } catch {
      // The listener owns a bounded process-lifetime capability. Closing must
      // remain best-effort even if its explicit release path is unavailable.
    }
  }

  private async refreshClaudeDiscovery(): Promise<GatewayAdapterDiscoverySnapshot> {
    if (this.discoveryInFlight !== undefined) {
      return await this.discoveryInFlight;
    }
    const operation = this.refreshClaudeDiscoveryOnce();
    this.discoveryInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.discoveryInFlight === operation) {
        this.discoveryInFlight = undefined;
      }
    }
  }

  private async refreshClaudeDiscoveryOnce(): Promise<GatewayAdapterDiscoverySnapshot> {
    const dispatchEpochAtStart = new Map<string, number>();
    for (const routeHandle of this.selected.keys()) {
      dispatchEpochAtStart.set(
        routeHandle,
        this.selectedDispatchEpoch.get(routeHandle) ?? 0,
      );
    }
    let discovery: ClaudePeerDiscovery;
    try {
      discovery = await this.peer.discover();
    } catch (error) {
      this.registryObservation = unavailableClaudeRegistryObservation();
      throw error;
    }
    const registry = claudeRegistryObservation(discovery);
    this.registryObservation = registry;
    this.discovered.clear();
    const rows: GatewayAdapterDiscovery[] = [];
    for (const peer of discovery.peers) {
      if (
        peer.kind !== "interactive" ||
        !NATIVE_CLAUDE_NAME.test(peer.alias)
      ) {
        continue;
      }
      const alias = `${peer.alias}@${this.identity.hostId}`;
      if (!PUBLIC_ALIAS.test(alias)) continue;
      const row: GatewayAdapterDiscovery = {
        alias,
        routeHandle: peer.targetId,
        kind: "interactive",
        state: claudeRouteState(peer),
      };
      this.discovered.set(peer.targetId, row);
      rows.push(row);
    }
    for (const [routeHandle, selectedAlias] of this.selected) {
      const row = this.discovered.get(routeHandle);
      if (row === undefined) {
        this.emitClaudeRouteObservation(
          routeHandle,
          "busy",
          "CLAUDE_PEER_NOT_OBSERVED",
          true,
        );
      } else {
        if (!discovery.truncated && row.alias !== selectedAlias) {
          // A Claude rename changes only the live name index. The native
          // session UUID remains the selected logical route. An incomplete
          // scan is display evidence only and cannot rename dispatch authority.
          this.selected.set(routeHandle, row.alias);
        }
        if (
          row.state === "idle" &&
          (dispatchEpochAtStart.get(routeHandle) !==
              (this.selectedDispatchEpoch.get(routeHandle) ?? 0))
        ) {
          // Never publish an idle sample from a discovery that overlapped the
          // exact mailbox write. A wholly post-terminal discovery may clear
          // the dirty epoch.
          continue;
        }
        this.emitClaudeRouteObservation(routeHandle, row.state, undefined, true);
      }
    }
    return { peers: rows, complete: !discovery.truncated, registry };
  }

  private emitClaudeRouteObservation(
    routeHandle: string,
    state: GatewayAdapterRouteState,
    safeErrorCode?: string,
    authoritative = false,
  ): void {
    const signature = `${state}:${safeErrorCode ?? ""}`;
    const mustPublish =
      authoritative && this.selectedObservationDirty.delete(routeHandle);
    if (!mustPublish && this.selectedObservations.get(routeHandle) === signature) {
      return;
    }
    this.selectedObservations.set(routeHandle, signature);
    const callbacks = this.callbacks;
    const logicalRoute = this.logicalRoutes.get(routeHandle);
    if (callbacks === undefined || this.closed || logicalRoute === undefined) {
      return;
    }
    invokeCallback(() =>
      callbacks.onRouteState({
        route: {
          ...this.identity,
          routeHandle,
          registrationId: logicalRoute.registrationId,
        },
        observedAt: new Date(this.now()).toISOString(),
        state,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      }),
    );
  }

  private scheduleClaudeMonitor(): void {
    if (
      this.closed ||
      this.selected.size === 0 ||
      this.monitorTimer !== undefined
    ) {
      return;
    }
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = undefined;
      void this.refreshClaudeDiscovery()
        .catch(() => {
          for (const routeHandle of this.selected.keys()) {
            this.emitClaudeRouteObservation(
              routeHandle,
              "busy",
              "CLAUDE_DISCOVERY_UNAVAILABLE",
            );
          }
        })
        .finally(() => this.scheduleClaudeMonitor());
    }, this.discoveryPollMs);
    this.monitorTimer.unref();
  }
}

export function createLocalClaudeGatewayProvider(
  options: LocalClaudeGatewayProviderOptions,
): LocalClaudeGatewayProvider {
  return new LocalClaudeGatewayProvider(options);
}

export type LocalCodexGatewayProviderOptions = {
  hostId: string;
  operation: StatelessCodexOperationTransport;
  createObservationFactory?: () => Promise<LocalCodexTransportFactory>;
  observationPollMs?: number;
  observationTimeoutMs?: number;
  observationBackoffMaxMs?: number;
  maxObservedRoutes?: number;
  now?: () => Date;
  timers?: Readonly<{
    setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimeout: (timer: NodeJS.Timeout) => void;
  }>;
};

type ObservedCodexRoute = {
  alias: string;
  registrationId: string;
  routeHandle: string;
  attempt: number;
  nextAt: number;
};

type ActiveCodexTurn = {
  attemptId: string;
  accepted: StatelessCodexAcceptedOperation;
  alias: string;
  routeHandle: string;
};

type CodexObservation = Readonly<{
  state: GatewayAdapterRouteObservationState;
  safeErrorCode?: string;
}>;

function boundedProviderOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate <= 0 ||
    candidate > maximum
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
      "The local Codex provider has an invalid bounded option.",
    );
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observerRouteState(value: unknown): CodexObservation {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { state: "unobserved", safeErrorCode: "CODEX_OBSERVER_PROTOCOL_ERROR" };
  }
  if (value.type === "idle") return { state: "idle" };
  if (value.type === "active") {
    const flags = value.activeFlags;
    if (
      flags !== undefined &&
      (!Array.isArray(flags) ||
        flags.some((flag) => typeof flag !== "string"))
    ) {
      return {
        state: "unobserved",
        safeErrorCode: "CODEX_OBSERVER_PROTOCOL_ERROR",
      };
    }
    return Array.isArray(flags) && flags.includes("waitingOnApproval")
      ? { state: "awaiting_approval" }
      : { state: "busy" };
  }
  return { state: "unobserved", safeErrorCode: "THREAD_NOT_OBSERVED" };
}

async function observerRequest(
  transport: CodexAppServerTransport,
  id: number,
  method: "initialize" | "thread/resume",
  params: Record<string, unknown>,
  timeoutMs: number,
  timers: NonNullable<LocalCodexGatewayProviderOptions["timers"]>,
  signal?: AbortSignal,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let failSend: (error: unknown) => void = () => undefined;
  let abort = (): void => undefined;
  const result = new Promise<unknown>((resolve, reject) => {
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      removeMessage();
      removeClose();
      removeError();
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const removeMessage = transport.onMessage((payload) => {
      if (Buffer.byteLength(payload, "utf8") > 1024 * 1024) {
        finish(() => reject(new Error("CODEX_OBSERVER_PROTOCOL_ERROR")));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(payload);
      } catch {
        finish(() => reject(new Error("CODEX_OBSERVER_PROTOCOL_ERROR")));
        return;
      }
      if (!isRecord(frame)) {
        finish(() => reject(new Error("CODEX_OBSERVER_PROTOCOL_ERROR")));
        return;
      }
      if (typeof frame.method === "string" && frame.id === undefined) return;
      if (frame.id !== id || ("result" in frame) === ("error" in frame)) {
        finish(() => reject(new Error("CODEX_OBSERVER_PROTOCOL_ERROR")));
        return;
      }
      if ("error" in frame) {
        finish(() => reject(new Error("CODEX_OBSERVER_RPC_REJECTED")));
        return;
      }
      finish(() => resolve(frame.result));
    });
    const removeClose = transport.onClose(() =>
      finish(() => reject(new Error("CODEX_OBSERVER_TRANSPORT_CLOSED"))),
    );
    const removeError = transport.onError(() =>
      finish(() => reject(new Error("CODEX_OBSERVER_TRANSPORT_CLOSED"))),
    );
    timer = timers.setTimeout(() => {
      finish(() => reject(new Error("CODEX_OBSERVER_REQUEST_TIMEOUT")));
    }, timeoutMs);
    timer.unref();
    abort = () =>
      finish(() => reject(new Error("CODEX_OBSERVER_TRANSPORT_CLOSED")));
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    failSend = () =>
      finish(() => reject(new Error("CODEX_OBSERVER_TRANSPORT_CLOSED")));
  });
  if (settled || signal?.aborted === true) return await result;
  try {
    void transport
      .send(JSON.stringify({ id, method, params }))
      .catch(failSend);
  } catch (error) {
    failSend(error);
  }
  return await result;
}

async function observerSend(
  transport: CodexAppServerTransport,
  payload: string,
  timeoutMs: number,
  timers: NonNullable<LocalCodexGatewayProviderOptions["timers"]>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    throw new Error("CODEX_OBSERVER_TRANSPORT_CLOSED");
  }
  let timer: NodeJS.Timeout | undefined;
  let removeAbort = (): void => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = timers.setTimeout(
      () => reject(new Error("CODEX_OBSERVER_REQUEST_TIMEOUT")),
      timeoutMs,
    );
    timer.unref();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error("CODEX_OBSERVER_TRANSPORT_CLOSED"));
    if (signal?.aborted === true) abort();
    else if (signal !== undefined) {
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    await Promise.race([transport.send(payload), timeout, aborted]);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
    removeAbort();
  }
}

const OBSERVER_SETUP_STOPPED = Symbol("observer-setup-stopped");

async function observerSetup<T>(
  start: () => Promise<T>,
  disposeLate: (value: T) => Promise<void>,
  timeoutMs: number,
  timers: NonNullable<LocalCodexGatewayProviderOptions["timers"]>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let abandoned = false;
  let timer: NodeJS.Timeout | undefined;
  let removeAbort = (): void => undefined;
  const operation = Promise.resolve()
    .then(async () => {
      if (signal.aborted) return OBSERVER_SETUP_STOPPED;
      return { value: await start() };
    })
    .then(
      (result) => {
        if (result === OBSERVER_SETUP_STOPPED) return result;
        if (abandoned) {
          void Promise.resolve()
            .then(async () => await disposeLate(result.value))
            .catch(() => undefined);
          return OBSERVER_SETUP_STOPPED;
        }
        return result;
      },
      (error) => {
        if (abandoned) return OBSERVER_SETUP_STOPPED;
        throw error;
      },
    );
  const stopped = new Promise<typeof OBSERVER_SETUP_STOPPED>((resolve) => {
    const stop = () => resolve(OBSERVER_SETUP_STOPPED);
    timer = timers.setTimeout(stop, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
    removeAbort = () => signal.removeEventListener("abort", stop);
  });
  try {
    const result = await Promise.race([operation, stopped]);
    abandoned = true;
    if (result === OBSERVER_SETUP_STOPPED) return undefined;
    return (result as { value: Awaited<T> }).value;
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
    removeAbort();
  }
}

async function observerCleanup(
  operation: () => Promise<void>,
  timeoutMs: number,
  timers: NonNullable<LocalCodexGatewayProviderOptions["timers"]>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = timers.setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

async function observeCodexRoute(
  createFactory: () => Promise<LocalCodexTransportFactory>,
  route: Pick<ObservedCodexRoute, "routeHandle">,
  timeoutMs: number,
  timers: NonNullable<LocalCodexGatewayProviderOptions["timers"]>,
  signal: AbortSignal,
): Promise<CodexObservation> {
  let factory: LocalCodexTransportFactory | undefined;
  let transport: CodexAppServerTransport | undefined;
  try {
    factory = await observerSetup(
      createFactory,
      async (late) => await late.close(),
      timeoutMs,
      timers,
      signal,
    );
    if (factory === undefined || signal.aborted) {
      return {
        state: "unobserved",
        safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE",
      };
    }
    transport = await observerSetup(
      async () => await factory!.connectTransport(),
      async (late) => await late.close(),
      timeoutMs,
      timers,
      signal,
    );
    if (transport === undefined || signal.aborted) {
      return {
        state: "unobserved",
        safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE",
      };
    }
    const initialized = await observerRequest(
      transport,
      1,
      "initialize",
      {
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            "item/started",
            "item/agentMessage/delta",
            "item/reasoning/textDelta",
            "item/reasoning/summaryTextDelta",
            "item/commandExecution/outputDelta",
            "turn/diff/updated",
            "turn/plan/updated",
          ],
        },
        clientInfo: {
          name: "agent_embassy_gateway_observer",
          title: "Embassy Gateway Observer",
          version: "1.8.0",
        },
      },
      timeoutMs,
      timers,
      signal,
    );
    if (!isRecord(initialized)) {
      return {
        state: "unobserved",
        safeErrorCode: "CODEX_OBSERVER_PROTOCOL_ERROR",
      };
    }
    await observerSend(
      transport,
      JSON.stringify({ method: "initialized", params: {} }),
      timeoutMs,
      timers,
      signal,
    );
    const resumed = await observerRequest(
      transport,
      2,
      "thread/resume",
      { excludeTurns: true, threadId: route.routeHandle },
      timeoutMs,
      timers,
      signal,
    );
    if (
      !isRecord(resumed) ||
      !isRecord(resumed.thread) ||
      resumed.thread.id !== route.routeHandle ||
      !Array.isArray(resumed.thread.turns) ||
      resumed.thread.turns.length !== 0
    ) {
      return {
        state: "unobserved",
        safeErrorCode: "CODEX_OBSERVER_PROTOCOL_ERROR",
      };
    }
    return observerRouteState(resumed.thread.status);
  } catch {
    return {
      state: "unobserved",
      safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE",
    };
  } finally {
    if (transport !== undefined) {
      const ownedTransport = transport;
      await observerCleanup(
        async () => await ownedTransport.close(),
        timeoutMs,
        timers,
      );
    }
    if (factory !== undefined) {
      const ownedFactory = factory;
      await observerCleanup(
        async () => await ownedFactory.close(),
        timeoutMs,
        timers,
      );
    }
  }
}

function cleanCodexResult(
  result:
    | Extract<StatelessCodexOperationResult, { phase: "clean" }>
    | Extract<StatelessCodexActiveSteerResult, { phase: "clean" }>,
): GatewayAdapterDispatchResult {
  if (result.safeErrorCode === "MESSAGE_EXPIRED") {
    return { state: "expired", safeErrorCode: "MESSAGE_EXPIRED" };
  }
  if (CODEX_CLEAN_RETRY_CODES.has(result.safeErrorCode)) {
    return { state: "deferred", safeErrorCode: result.safeErrorCode };
  }
  return { state: "failed", safeErrorCode: result.safeErrorCode };
}

function terminalCodexResult(
  result: Extract<StatelessCodexOperationResult, { phase: "terminal" }>,
  expectsReply: boolean,
): GatewayAdapterDispatchResult {
  if (result.outcome === "failed") {
    return { state: "failed", safeErrorCode: "CODEX_TURN_FAILED" };
  }
  if (result.outcome === "interrupted") {
    return { state: "cancelled", safeErrorCode: "CODEX_TURN_INTERRUPTED" };
  }
  return {
    state: "delivered",
    ...(result.replyCode === "REPLY_TOO_LARGE"
      ? { safeErrorCode: "CODEX_REPLY_TOO_LARGE" }
      : {}),
    ...(expectsReply && result.replyText !== null
      ? { replyText: result.replyText }
      : {}),
  };
}

function mapCodexStartResult(
  result: StatelessCodexOperationResult,
  expectsReply: boolean,
): GatewayAdapterDispatchResult {
  if (result.phase === "clean") return cleanCodexResult(result);
  if (result.phase === "armed") {
    return { state: "ambiguous", safeErrorCode: result.safeErrorCode };
  }
  if (result.phase === "accepted") {
    return { state: "unconfirmed", safeErrorCode: result.safeErrorCode };
  }
  return terminalCodexResult(result, expectsReply);
}

function mapCodexSteerResult(
  result: StatelessCodexActiveSteerResult,
): GatewayAdapterDispatchResult {
  if (result.phase === "clean") return cleanCodexResult(result);
  if (result.phase === "armed") {
    return { state: "ambiguous", safeErrorCode: result.safeErrorCode };
  }
  return { state: "delivered" };
}

/**
 * Thin logical Codex adapter. Registration and construction perform no App
 * Server I/O. Each semantic operation owns a fresh attested transport, while
 * the independent observer publishes only best-effort in-memory freshness.
 */
export class LocalCodexGatewayProvider implements GatewayProviderAdapter {
  private readonly hostId: string;
  private readonly operation: StatelessCodexOperationTransport;
  private readonly createObservationFactory:
    | (() => Promise<LocalCodexTransportFactory>)
    | undefined;
  private readonly observationPollMs: number;
  private readonly observationTimeoutMs: number;
  private readonly observationBackoffMaxMs: number;
  private readonly maxObservedRoutes: number;
  private readonly now: () => Date;
  private readonly timers: NonNullable<
    LocalCodexGatewayProviderOptions["timers"]
  >;
  private readonly observedRoutes = new Map<string, ObservedCodexRoute>();
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly operationControllers = new Set<AbortController>();
  private callbacks: GatewayAdapterCallbacks | undefined;
  private observationTimer: NodeJS.Timeout | undefined;
  private observationInFlight: Promise<void> | undefined;
  private observationController: AbortController | undefined;
  private initialized = false;
  private closing = false;
  private closed = false;

  constructor(options: LocalCodexGatewayProviderOptions) {
    if (
      options.hostId !== LOCAL_HOST ||
      options.operation === undefined ||
      typeof options.operation.execute !== "function"
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "The stateless Codex provider requires the exact local host.",
      );
    }
    this.hostId = options.hostId;
    this.operation = options.operation;
    this.createObservationFactory = options.createObservationFactory;
    this.observationPollMs = boundedProviderOption(
      options.observationPollMs,
      DEFAULT_CODEX_OBSERVATION_POLL_MS,
      60_000,
    );
    this.observationTimeoutMs = boundedProviderOption(
      options.observationTimeoutMs,
      DEFAULT_CODEX_OBSERVATION_TIMEOUT_MS,
      60_000,
    );
    this.observationBackoffMaxMs = boundedProviderOption(
      options.observationBackoffMaxMs,
      DEFAULT_CODEX_OBSERVATION_BACKOFF_MAX_MS,
      5 * 60_000,
    );
    if (this.observationPollMs > this.observationBackoffMaxMs) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "Codex observer backoff must cover its polling interval.",
      );
    }
    this.maxObservedRoutes = boundedProviderOption(
      options.maxObservedRoutes,
      MAX_CODEX_OBSERVED_ROUTES,
      256,
    );
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
  }

  get identity(): Readonly<{ provider: "codex"; hostId: string }> {
    return { provider: "codex", hostId: this.hostId };
  }

  get protocol(): string {
    return "codex-app-server";
  }

  get protocolVersion(): string {
    return "stateless-v1";
  }

  async initialize(
    callbacks: GatewayAdapterCallbacks,
  ): Promise<GatewayAdapterStart> {
    if (this.initialized || this.closing || this.closed) {
      throw new BridgeError(
        "CODEX_PROVIDER_INITIALIZATION_REJECTED",
        "The stateless Codex provider cannot initialize in this state.",
      );
    }
    this.callbacks = callbacks;
    this.initialized = true;
    this.scheduleObservation();
    return { health: "healthy" };
  }

  observeLogicalRoute(input: {
    alias: string;
    routeHandle: string;
    registrationId: string;
  }): void {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      !PUBLIC_ALIAS.test(input.alias) ||
      !input.alias.endsWith("@" + this.hostId) ||
      !OPAQUE_ROUTE.test(input.routeHandle) ||
      !OPAQUE_ROUTE.test(input.registrationId)
    ) {
      return;
    }
    const existing = this.observedRoutes.get(input.registrationId);
    if (
      existing === undefined &&
      this.observedRoutes.size >= this.maxObservedRoutes
    ) {
      return;
    }
    this.observedRoutes.set(input.registrationId, {
      ...input,
      attempt: 0,
      nextAt: this.now().getTime(),
    });
    this.scheduleObservation();
  }

  forgetLogicalRoute(registrationId: string): void {
    this.observedRoutes.delete(registrationId);
    this.activeTurns.delete(registrationId);
    this.scheduleObservation();
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      input.authorization !== "selected_route" ||
      input.binding.provider !== "codex" ||
      input.binding.hostId !== this.hostId ||
      !PUBLIC_ALIAS.test(input.targetAlias) ||
      !input.targetAlias.endsWith("@" + this.hostId)
    ) {
      return { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" };
    }
    let content: string;
    try {
      content = composeProvenanceEnvelope({
        sourceProvider: input.sourceProvider,
        recipientProvider: "codex",
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        conversationId: input.conversationId,
        body: input.text,
        ...(input.progressWatchActive === true
          ? { progressWatchActive: true as const }
          : {}),
        ...(input.steer === true && input.queuedAhead !== undefined
          ? { queuedAhead: input.queuedAhead }
          : {}),
      });
    } catch (error) {
      return {
        state: "failed",
        safeErrorCode:
          error instanceof BridgeError &&
          error.code === "PROVENANCE_ENVELOPE_TOO_LARGE"
            ? error.code
            : "PROVENANCE_ENVELOPE_INVALID",
      };
    }

    if (input.steer === true) {
      const active = this.activeTurns.get(input.binding.registrationId);
      if (
        active === undefined ||
        active.alias !== input.targetAlias ||
        active.routeHandle !== input.binding.routeHandle
      ) {
        return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
      }
      const steering = active.accepted.steer({
        attemptId: input.attemptId,
        authorizeWrite: async (evidence) =>
          await input.authorizeWrite({
            attemptId: input.attemptId,
            kind: "codex_turn_steer",
            bodyBytes: Buffer.byteLength(input.text, "utf8"),
            bodySha256: createHash("sha256").update(input.text).digest("hex"),
            frameBytes: evidence.frameBytes,
            sha256: evidence.sha256,
          }),
        deadlineAt: input.deadlineAt,
        text: content,
      });
      this.inFlightOperations.add(steering);
      try {
        return mapCodexSteerResult(await steering);
      } finally {
        this.inFlightOperations.delete(steering);
      }
    }

    if (this.activeTurns.has(input.binding.registrationId)) {
      return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
    }
    let accepted: StatelessCodexAcceptedOperation | undefined;
    const controller = new AbortController();
    this.operationControllers.add(controller);
    const operation = this.operation.execute({
      attemptId: input.attemptId,
      authorizeWrite: async (evidence) =>
        await input.authorizeWrite({
          attemptId: input.attemptId,
          kind: "codex_turn_start",
          bodyBytes: Buffer.byteLength(input.text, "utf8"),
          bodySha256: createHash("sha256").update(input.text).digest("hex"),
          frameBytes: evidence.frameBytes,
          sha256: evidence.sha256,
        }),
      deadlineAt: input.deadlineAt,
      kind: "start",
      signal: controller.signal,
      route: {
        alias: input.targetAlias,
        hostId: input.binding.hostId,
        registrationId: input.binding.registrationId,
        threadId: input.binding.routeHandle,
      },
      text: content,
      onAccepted: async (current) => {
        if (
          this.closing ||
          this.closed ||
          current.attemptId !== input.attemptId ||
          this.activeTurns.has(input.binding.registrationId)
        ) {
          throw new BridgeError(
            "ACCEPTANCE_UNCONFIRMED",
            "The exact Codex attempt cannot acquire its active-turn slot.",
          );
        }
        await input.onAccepted({ attemptId: input.attemptId });
        accepted = current;
        this.activeTurns.set(input.binding.registrationId, {
          attemptId: input.attemptId,
          accepted: current,
          alias: input.targetAlias,
          routeHandle: input.binding.routeHandle,
        });
      },
    });
    this.inFlightOperations.add(operation);
    try {
      const result = await operation;
      this.publishOperationObservation(input, result);
      return mapCodexStartResult(result, input.expectsReply);
    } finally {
      this.inFlightOperations.delete(operation);
      this.operationControllers.delete(controller);
      if (
        accepted !== undefined &&
        this.activeTurns.get(input.binding.registrationId)?.attemptId ===
          input.attemptId
      ) {
        this.activeTurns.delete(input.binding.registrationId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.observationTimer !== undefined) {
      this.timers.clearTimeout(this.observationTimer);
      this.observationTimer = undefined;
    }
    this.observationController?.abort();
    for (const controller of this.operationControllers) controller.abort();
    await this.observationInFlight?.catch(() => undefined);
    for (const operation of this.inFlightOperations) {
      void operation.catch(() => undefined);
    }
    this.operationControllers.clear();
    this.activeTurns.clear();
    this.observedRoutes.clear();
    this.callbacks = undefined;
    this.initialized = false;
    this.closed = true;
    this.closing = false;
  }

  private publishOperationObservation(
    input: GatewayAdapterDispatchInput,
    result: StatelessCodexOperationResult,
  ): void {
    const state: CodexObservation =
      !result.cleanupConfirmed
        ? { state: "unobserved", safeErrorCode: "CLEANUP_FAILED" }
        : result.phase === "terminal"
        ? { state: "idle" }
        : result.safeErrorCode === "ROUTE_BUSY"
          ? { state: "busy" }
          : result.safeErrorCode === "APPROVAL_REQUIRED"
            ? { state: "awaiting_approval" }
            : result.safeErrorCode === "THREAD_NOT_OBSERVED"
              ? {
                  state: "unobserved",
                  safeErrorCode: "THREAD_NOT_OBSERVED",
                }
              : {
                  state: "unobserved",
                  safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE",
                };
    this.emitObservation(
      {
        alias: input.targetAlias,
        registrationId: input.binding.registrationId,
        routeHandle: input.binding.routeHandle,
      },
      state,
    );
  }

  private scheduleObservation(): void {
    if (
      this.createObservationFactory === undefined ||
      !this.initialized ||
      this.closing ||
      this.closed ||
      this.observationInFlight !== undefined
    ) {
      return;
    }
    if (this.observationTimer !== undefined) {
      this.timers.clearTimeout(this.observationTimer);
      this.observationTimer = undefined;
    }
    const next = [...this.observedRoutes.values()].reduce<
      ObservedCodexRoute | undefined
    >(
      (selected, candidate) =>
        selected === undefined || candidate.nextAt < selected.nextAt
          ? candidate
          : selected,
      undefined,
    );
    if (next === undefined) return;
    const delay = Math.max(0, next.nextAt - this.now().getTime());
    const timer = this.timers.setTimeout(() => {
      if (this.observationTimer !== timer) return;
      this.observationTimer = undefined;
      const operation = this.runObservation(next);
      this.observationInFlight = operation;
      void operation.finally(() => {
        if (this.observationInFlight === operation) {
          this.observationInFlight = undefined;
        }
        this.scheduleObservation();
      });
    }, delay);
    timer.unref();
    this.observationTimer = timer;
  }

  private async runObservation(route: ObservedCodexRoute): Promise<void> {
    const controller = new AbortController();
    this.observationController = controller;
    let observation: CodexObservation;
    try {
      observation = await observeCodexRoute(
        this.createObservationFactory!,
        route,
        this.observationTimeoutMs,
        this.timers,
        controller.signal,
      );
    } finally {
      if (this.observationController === controller) {
        this.observationController = undefined;
      }
    }
    const current = this.observedRoutes.get(route.registrationId);
    if (current !== route || this.closing || this.closed) return;
    const failed = observation.state === "unobserved";
    current.attempt = failed ? Math.min(current.attempt + 1, 16) : 0;
    const delay = failed
      ? Math.min(
          this.observationBackoffMaxMs,
          this.observationPollMs * 2 ** Math.max(0, current.attempt - 1),
        )
      : this.observationPollMs;
    current.nextAt = this.now().getTime() + delay;
    this.emitObservation(current, observation);
  }

  private emitObservation(
    route: Pick<ObservedCodexRoute, "alias" | "routeHandle" | "registrationId">,
    observation: CodexObservation,
  ): void {
    const current = this.observedRoutes.get(route.registrationId);
    if (
      this.callbacks === undefined ||
      current === undefined ||
      current.alias !== route.alias ||
      current.routeHandle !== route.routeHandle
    ) {
      return;
    }
    invokeCallback(() =>
      this.callbacks!.onRouteState({
        route: {
          provider: "codex",
          hostId: this.hostId,
          routeHandle: route.routeHandle,
          registrationId: route.registrationId,
        },
        state: observation.state,
        observedAt: this.now().toISOString(),
        ...(observation.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: observation.safeErrorCode }),
      }),
    );
  }
}

export function createLocalCodexGatewayProvider(
  options: LocalCodexGatewayProviderOptions,
): LocalCodexGatewayProvider {
  return new LocalCodexGatewayProvider(options);
}
