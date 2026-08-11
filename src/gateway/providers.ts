import { createHash } from "node:crypto";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  CLAUDE_PEER_COMPATIBILITY,
  ClaudePeerAdapter,
  type ClaudePeerDescriptor,
  type ClaudePeerInboundMessage,
  type ClaudePeerInboundProgress,
  type ClaudePeerListener,
  type ClaudePeerProtocolNotice,
  type ClaudePeerReceiptEvent,
  type ClaudePeerRegistryPublicationOutcome,
  type ClaudePeerTransportEvent,
} from "./claude-peer.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import {
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
  sharesCompatibilityMajor,
  type CompatibilityAttestation,
  type CompatibilityProbeName,
  type CompatibilityProbeResult,
  type CompatibilitySurfaceObservation,
} from "./compatibility.js";
import {
  CODEX_APP_SERVER_WRITABLE_VERSIONS,
  CodexAppServerConnector,
  CodexConnectorError,
  type CodexConnectorEvent,
  type CodexConnectorObservation,
  type CodexTransientTurnResult,
} from "./codex-app-server.js";
import type {
  LocalCodexOwnedTransport,
  LocalCodexTransportFactory,
} from "./codex-local-transport.js";
import { LocalCodexTransportError } from "./codex-local-transport.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import {
  ClaudeNativeHelperSupervisor,
} from "./claude-helper-supervisor.js";
import type { ClaudeNativeHelperFactory } from "./claude-helper-client.js";
import { isDashboardLocale, type DashboardLocale } from "./locale.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDelivery,
  GatewayAdapterDiscovery,
  GatewayAdapterDiscoverySnapshot,
  GatewayAdapterDispatchResult,
  GatewayAdapterEndpointRefresh,
  GatewayAdapterDispatchInput,
  GatewayAdapterRouteState,
  GatewayAdapterRouteObservationState,
  GatewayAdapterStart,
  GatewayProviderAdapter,
} from "./service.js";
import type {
  PrivateEndpointIdentity,
  PrivateRouteBinding,
} from "./types.js";

const LOCAL_HOST = "this-mac";
const NATIVE_CLAUDE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const OPAQUE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CLAUDE_PENDING = 1_024;
const DEFAULT_CLAUDE_DISCOVERY_POLL_MS = 1_000;
const CLAUDE_REJECTION_RECEIPT_RETRY_DELAYS_MS = [25, 100, 250] as const;
const MAX_CODEX_ROUTES = 128;
const MAX_CODEX_CALLBACKS = 512;
const MAX_TRANSIENT_REPLY_BYTES = 64 * 1024;
const DEFAULT_CODEX_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_CLEANUP_POLL_MS = 25;
const DEFAULT_CODEX_RECOVERY_INITIAL_MS = 250;
const DEFAULT_CODEX_RECOVERY_MAX_MS = 5_000;
const MAX_CODEX_ENDPOINT_REFRESH_CANDIDATES = 3;
const COMPATIBILITY_PROBE_THREAD_ID =
  "00000000-0000-7000-8000-000000000000";
const CLAUDE_CLEAN_PREWRITE_RETRY_CODES = new Set([
  "CLAUDE_PEER_TARGET_UNKNOWN",
  "CLAUDE_PEER_TARGET_STALE",
  "CLAUDE_PEER_TARGET_CHANGED",
  "CLAUDE_PEER_WORKSPACE_UNATTESTED",
]);

function claudeCleanPrewriteResult(
  error: unknown,
): GatewayAdapterDispatchResult {
  if (
    error instanceof BridgeError &&
    error.code === "CLAUDE_PEER_MESSAGE_EXPIRED"
  ) {
    return { state: "failed", safeErrorCode: "MESSAGE_EXPIRED" };
  }
  if (
    error instanceof BridgeError &&
    CLAUDE_CLEAN_PREWRITE_RETRY_CODES.has(error.code)
  ) {
    return { state: "deferred", safeErrorCode: error.code };
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

function passedProbe(name: CompatibilityProbeName): CompatibilityProbeResult {
  return { name, outcome: "pass" };
}

function failedProbe(
  name: CompatibilityProbeName,
  safeErrorCode: string,
): CompatibilityProbeResult {
  return { name, outcome: "fail", safeErrorCode };
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
  /** Deterministic test seam. Production callers must omit this. */
  peerFactory?: ClaudePeerFactory;
};

type ClaudePending = {
  gatewayMessageId: string;
  listener: ClaudePeerListener;
  listenerGeneration: string;
  targetId: string;
  writeEvidence: "none" | "transport_written" | "transport_uncertain";
  timer: NodeJS.Timeout;
};

type NativeCodexPeerRegistration = Readonly<{
  alias: string;
  cwd: string;
  name: string;
}>;

type NativeCodexListenerLifecycle =
  | "active"
  | "prepared"
  | "retired";

type NativeCodexListenerGeneration = {
  readonly generation: string;
  readonly listener: ClaudePeerListener;
  lifecycle: NativeCodexListenerLifecycle;
  registration?: NativeCodexPeerRegistration;
  registrationProvisional: boolean;
  provisionalIngressForwarded: boolean;
  inboundQuiesced: boolean;
  publicationAttempted: boolean;
  publicationUncertain: boolean;
  publicationOutcome?: ClaudePeerRegistryPublicationOutcome;
  publicationOperation?: Promise<ClaudePeerRegistryPublicationOutcome>;
};

type NativeInboundRoute = Readonly<{
  alias: string;
  listenerGeneration: string;
}>;

export type ClaudeNativeCodexSuccessionBarrier = Readonly<{
  generation: string;
  activeGenerationMatched: boolean;
  ingressQuiesced: boolean;
  monitorFrozen: boolean;
  discoveryInFlight: boolean;
  pendingOutboundReceipts: number;
  pendingInboundReceipts: number;
  rejectedInboundSettlements: number;
  clean: boolean;
}>;

export type CodexRouteSuccessionBarrier = Readonly<{
  routePresent: boolean;
  connection: CodexConnectorObservation["connection"] | "absent";
  routeStatus: CodexConnectorObservation["routeStatus"] | "absent";
  queueDepth: number;
  hasActiveTurn: boolean;
  requestInFlight: boolean;
  routeCreationInFlight: boolean;
  routeReleaseInFlight: boolean;
  pendingReplyCorrelations: number;
  pendingCallbacks: number;
  clean: boolean;
}>;

type ClaudeRejectedInbound = {
  receiptHandle: string;
  listener: ClaudePeerListener;
  listenerGeneration: string;
  released: boolean;
  cancelRetry?: () => void;
  operation: Promise<void>;
};

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
  binding: PrivateRouteBinding,
  identity: PrivateEndpointIdentity,
): boolean {
  return (
    binding.provider === identity.provider &&
    binding.hostId === identity.hostId &&
    binding.endpointGeneration === identity.endpointGeneration
  );
}

function callbackEndpoint(
  identity: PrivateEndpointIdentity,
  routeHandle: string,
): PrivateEndpointIdentity & { routeHandle: string } {
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
  if (
    runtime.claudeCodeVersion !==
      CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion ||
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
      "The local Claude provider requires exact pinned runtime evidence.",
    );
  }
}

function claudeEndpointGeneration(
  runtime: AttestedClaudePeerRuntime,
): string {
  return `claude_${createHash("sha256")
    .update(runtime.claudeCodeVersion)
    .update("\0")
    .update(runtime.claudeExecutable)
    .update("\0")
    .update(runtime.sessionsDir)
    .update("\0")
    .update(runtime.socketDir)
    .digest("hex")
    .slice(0, 32)}`;
}

function claudeRouteState(
  peer: ClaudePeerDescriptor,
): GatewayAdapterRouteState {
  return peer.status === "idle" ? "idle" : "busy";
}

export class LocalClaudeGatewayProvider implements GatewayProviderAdapter {
  readonly identity: PrivateEndpointIdentity;
  readonly protocol = "claude-peer";
  readonly protocolVersion = `${CLAUDE_PEER_COMPATIBILITY.peerProtocol}`;

  private readonly peer: ClaudePeerAdapter;
  private readonly runtimeVersion: string;
  private readonly maxPending: number;
  private readonly discoveryPollMs: number;
  private readonly now: () => number;
  private readonly selectedStateRoots = new Map<string, string>();
  private readonly nativeHelpers: ClaudeNativeHelperSupervisor | undefined;
  private readonly discovered = new Map<string, GatewayAdapterDiscovery>();
  private readonly selected = new Map<string, string>();
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
  private readonly pendingByProviderId = new Map<string, ClaudePending>();
  private readonly providerIdByGatewayId = new Map<string, string>();
  /** Includes the pre-write reservation through exact terminal settlement. */
  private readonly pendingTargetByGatewayId = new Map<string, string>();
  /** Provider-owned terminal rejections that never enter the service queue. */
  private readonly rejectedNativeInbound = new Map<
    string,
    ClaudeRejectedInbound
  >();
  private discoveryInFlight:
    | Promise<GatewayAdapterDiscoverySnapshot>
    | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  /** Invocation-ordered registry mutations; the tail itself never rejects. */
  private nativeCodexRegistrationTail: Promise<void> = Promise.resolve();
  private callbacks: GatewayAdapterCallbacks | undefined;
  private activeNativeCodexListener:
    | NativeCodexListenerGeneration
    | undefined;
  private preparedNativeCodexListener:
    | NativeCodexListenerGeneration
    | undefined;
  private nativeCodexPreparationInFlight: string | undefined;
  private retiredNativeCodexListener:
    | NativeCodexListenerGeneration
    | undefined;
  /** Fences discovery callbacks and monitor restarts across listener rotation. */
  private nativeCodexSuccessionFreeze: string | undefined;
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
      endpointGeneration: claudeEndpointGeneration(options.runtime),
    };
    this.runtimeVersion = options.runtime.claudeCodeVersion;
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
    this.peer = (options.peerFactory ??
      ((runtime, locale, deliveryNotices) =>
        new ClaudePeerAdapter({
          sessionsDir: runtime.sessionsDir,
          socketDir: runtime.socketDir,
          attestedClaudeCodeVersion: runtime.claudeCodeVersion,
          locale,
          deliveryNotices,
        })))(
      options.runtime,
      options.locale ?? "en",
      options.deliveryNotices ?? "merged",
    );
    this.nativeHelpers =
      options.nativeHelpers === undefined
        ? undefined
        : new ClaudeNativeHelperSupervisor({
            identity: this.identity,
            runtime: options.runtime,
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
  }

  compatibilitySurface(): CompatibilitySurfaceObservation {
    return { surface: "claude", version: this.runtimeVersion };
  }

  async runCompatibilityProbes(): Promise<readonly CompatibilityProbeResult[]> {
    const [launcher, version, registry, socket, protocol] =
      compatibilityProbeNames.claude;
    try {
      const discovery = await this.peer.discover();
      // Runtime discovery is deliberately per-record fail-safe: malformed,
      // dead, unsafe, or non-routable records are omitted rather than allowed
      // to poison the whole registry. Startup compatibility must use the same
      // boundary. Fail only when the bounded scan itself is incomplete, or a
      // nonempty registry contains no record with a parseable closed schema.
      const registryUnusable =
        discovery.truncated ||
        (discovery.entriesScanned > 0 && discovery.parseableRecords === 0);
      return [
        passedProbe(launcher),
        passedProbe(version),
        registryUnusable
          ? failedProbe(registry, "CLAUDE_REGISTRY_SCHEMA_REJECTED")
          : passedProbe(registry),
        passedProbe(socket),
        passedProbe(protocol),
      ];
    } catch {
      return [
        passedProbe(launcher),
        passedProbe(version),
        failedProbe(registry, "CLAUDE_REGISTRY_UNAVAILABLE"),
        failedProbe(socket, "CLAUDE_SOCKET_VALIDATION_UNAVAILABLE"),
        passedProbe(protocol),
      ];
    }
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
      return { health: "healthy", compatibility: "compatible" };
    }
    try {
      let listenerGeneration: NativeCodexListenerGeneration | undefined;
      const listener = await this.peer.listen({
        onMessage: async (message) => {
          if (listenerGeneration !== undefined) {
            await this.onListenerMessage(listenerGeneration, message);
          }
        },
        onReceipt: (event) => {
          if (listenerGeneration !== undefined) {
            this.onReceipt(listenerGeneration, event);
          }
        },
        onProtocolNotice: (notice: ClaudePeerProtocolNotice) => {
          this.callbacks?.onProtocolNotice?.({ code: notice.code });
        },
      });
      listenerGeneration = {
        generation: listener.generation,
        listener,
        lifecycle: "active",
        registrationProvisional: false,
        provisionalIngressForwarded: false,
        inboundQuiesced: false,
        publicationAttempted: false,
        publicationUncertain: false,
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
      return { health: "healthy", compatibility: "compatible" };
    } catch {
      this.callbacks = undefined;
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

  async advertiseNativeCodexPeer(input: {
    alias: string;
    cwd: string;
  }): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      this.assertReady();
      await this.nativeHelpers.advertise(input);
      return;
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

  currentNativeCodexPeerGeneration(alias: string): string {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      return this.nativeHelpers.currentGeneration(alias);
    }
    const active = this.requireActiveNativeCodexListener();
    if (active.registration?.alias !== alias) {
      throw new BridgeError(
        "CODEX_PEER_GENERATION_MISMATCH",
        "The requested Codex alias is not the active listener generation.",
      );
    }
    return active.generation;
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

  async prepareNativeCodexPeerGeneration(input: {
    alias: string;
    cwd: string;
    generation: string;
    currentGeneration?: string;
  }): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      if (input.currentGeneration === undefined) {
        throw new BridgeError(
          "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
          "A supervised succession must name its exact current generation.",
        );
      }
      await this.nativeHelpers.prepareGeneration({
        alias: input.alias,
        cwd: input.cwd,
        generation: input.generation,
        currentGeneration: input.currentGeneration,
      });
      return;
    }
    const active = this.requireActiveNativeCodexListener();
    if (
      input.currentGeneration !== undefined &&
      input.currentGeneration !== active.generation
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "The prepared successor does not name the exact current generation.",
      );
    }
    if (active.registration === undefined) {
      throw new BridgeError(
        "CODEX_PEER_NOT_ADVERTISED",
        "A successor requires one active advertised Codex generation.",
      );
    }
    if (
      input.generation === active.generation ||
      this.nativeCodexPreparationInFlight !== undefined ||
      this.preparedNativeCodexListener !== undefined ||
      this.retiredNativeCodexListener !== undefined
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_CAPACITY",
        "Only one distinct prepared or retired Codex generation is allowed.",
      );
    }
    const registration = this.nativeCodexRegistration(input);
    this.nativeCodexPreparationInFlight = input.generation;
    let prepared: NativeCodexListenerGeneration | undefined;
    try {
      const listener = await this.peer.listenPrepared(input.generation, {
        onMessage: async (message) => {
          if (prepared !== undefined) {
            await this.onListenerMessage(prepared, message);
          }
        },
        onReceipt: (event) => {
          if (prepared !== undefined) this.onReceipt(prepared, event);
        },
      });
      prepared = {
        generation: listener.generation,
        listener,
        lifecycle: "prepared",
        registration,
        registrationProvisional: false,
        provisionalIngressForwarded: false,
        inboundQuiesced: true,
        publicationAttempted: false,
        publicationUncertain: false,
      };
      if (listener.generation !== input.generation || this.closed) {
        await listener.close().catch(() => undefined);
        throw new BridgeError(
          "CLAUDE_CALLBACK_UNAVAILABLE",
          "The prepared Claude callback generation could not be established.",
        );
      }
      this.preparedNativeCodexListener = prepared;
    } finally {
      if (this.nativeCodexPreparationInFlight === input.generation) {
        this.nativeCodexPreparationInFlight = undefined;
      }
    }
  }

  async quiesceNativeCodexPeerGeneration(generation: string): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.quiesceGeneration(generation);
      return;
    }
    const active = this.requireNativeCodexListenerGeneration(
      this.activeNativeCodexListener,
      generation,
      "active",
    );
    if (
      this.nativeCodexSuccessionFreeze !== undefined &&
      this.nativeCodexSuccessionFreeze !== generation
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "Another native Codex generation already owns the succession freeze.",
      );
    }
    this.nativeCodexSuccessionFreeze = generation;
    if (this.monitorTimer !== undefined) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    try {
      await active.listener.quiesceInbound();
      active.inboundQuiesced = true;
    } catch (error) {
      if (this.nativeCodexSuccessionFreeze === generation) {
        this.nativeCodexSuccessionFreeze = undefined;
      }
      this.scheduleClaudeMonitor();
      throw error;
    }
  }

  async observeNativeCodexSuccessionBarrier(
    generation: string,
  ): Promise<ClaudeNativeCodexSuccessionBarrier> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      return await this.nativeHelpers.observeBarrier(generation);
    }
    const active = this.activeNativeCodexListener;
    const activeGenerationMatched = active?.generation === generation;
    const pendingOutboundReceipts = this.providerIdByGatewayId.size;
    let pendingInboundReceipts = 0;
    for (const owner of this.nativeInboundReceiptOwners.values()) {
      if (owner.generation === generation) pendingInboundReceipts += 1;
    }
    let rejectedInboundSettlements = 0;
    for (const rejection of this.rejectedNativeInbound.values()) {
      if (rejection.listenerGeneration === generation) {
        rejectedInboundSettlements += 1;
      }
    }
    const ingressQuiesced =
      activeGenerationMatched && active.inboundQuiesced;
    const monitorFrozen =
      activeGenerationMatched &&
      this.nativeCodexSuccessionFreeze === generation;
    const discoveryInFlight = this.discoveryInFlight !== undefined;
    return {
      generation,
      activeGenerationMatched,
      ingressQuiesced,
      monitorFrozen,
      discoveryInFlight,
      pendingOutboundReceipts,
      pendingInboundReceipts,
      rejectedInboundSettlements,
      clean:
        activeGenerationMatched &&
        ingressQuiesced &&
        monitorFrozen &&
        !discoveryInFlight &&
        pendingOutboundReceipts === 0 &&
        pendingInboundReceipts === 0 &&
        rejectedInboundSettlements === 0,
    };
  }

  async publishPreparedNativeCodexPeer(input: {
    currentGeneration: string;
    preparedGeneration: string;
  }): Promise<ClaudePeerRegistryPublicationOutcome> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      return await this.nativeHelpers.publishPrepared(input);
    }
    const current = this.requireNativeCodexListenerGeneration(
      this.activeNativeCodexListener,
      input.currentGeneration,
      "active",
    );
    const prepared = this.requireNativeCodexListenerGeneration(
      this.preparedNativeCodexListener,
      input.preparedGeneration,
      "prepared",
    );
    if (!current.inboundQuiesced || prepared.registration === undefined) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_NOT_QUIET",
        "The old listener must be quiesced before publication.",
      );
    }
    if (!(await this.observeNativeCodexSuccessionBarrier(current.generation)).clean) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_NOT_QUIET",
        "Native Codex succession requires a clean provider-wide barrier.",
        true,
      );
    }
    if (
      prepared.publicationOutcome === "published" ||
      prepared.publicationOutcome === "not_published"
    ) {
      return prepared.publicationOutcome;
    }
    if (prepared.publicationOperation !== undefined) {
      return await prepared.publicationOperation;
    }
    prepared.publicationAttempted = true;
    const operation = prepared.listener.publishReplacing(
      current.listener,
      prepared.registration.name,
      prepared.registration.cwd,
    );
    prepared.publicationOperation = operation;
    try {
      const outcome = await operation;
      if (outcome === "published") {
        prepared.publicationOutcome = "published";
        return "published";
      }
      if (outcome === "unknown") {
        prepared.publicationUncertain = true;
        prepared.publicationOutcome = "unknown";
        return "unknown";
      }
      if (prepared.publicationUncertain) {
        prepared.publicationOutcome = "unknown";
        return "unknown";
      }
      prepared.publicationOutcome = "not_published";
      return "not_published";
    } catch (error) {
      prepared.publicationUncertain = true;
      prepared.publicationOutcome = "unknown";
      throw error;
    } finally {
      if (prepared.publicationOperation === operation) {
        delete prepared.publicationOperation;
      }
    }
  }

  async activatePreparedNativeCodexPeerGeneration(
    generation: string,
  ): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.activatePrepared(generation);
      return;
    }
    const prepared = this.requireNativeCodexListenerGeneration(
      this.preparedNativeCodexListener,
      generation,
      "prepared",
    );
    if (
      prepared.publicationOutcome !== "published" ||
      this.retiredNativeCodexListener !== undefined
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_NOT_PUBLISHED",
        "Only a confirmed published generation can become active.",
      );
    }
    const current = this.requireActiveNativeCodexListener();
    prepared.listener.grantSuccessionActivation();
    prepared.listener.resumeInbound();
    prepared.inboundQuiesced = false;
    current.lifecycle = "retired";
    prepared.lifecycle = "active";
    this.retiredNativeCodexListener = current;
    this.activeNativeCodexListener = prepared;
    this.preparedNativeCodexListener = undefined;
    if (this.nativeCodexSuccessionFreeze === current.generation) {
      this.nativeCodexSuccessionFreeze = undefined;
    }
    await this.purgeNativeCodexPeerGenerationReplyCapabilities(
      current.generation,
    );
    this.scheduleClaudeMonitor();
  }

  async cleanupPreparedNativeCodexPeerGeneration(
    generation: string,
  ): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.cleanupPrepared(generation);
      return;
    }
    const prepared = this.requireNativeCodexListenerGeneration(
      this.preparedNativeCodexListener,
      generation,
      "prepared",
    );
    if (
      prepared.publicationAttempted &&
      (prepared.publicationUncertain ||
        prepared.publicationOutcome !== "not_published")
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_ROLLBACK_FORBIDDEN",
        "A possibly published Codex generation cannot be rolled back.",
      );
    }
    await prepared.listener.close();
    if (this.preparedNativeCodexListener === prepared) {
      this.preparedNativeCodexListener = undefined;
    }
  }

  async resumeNativeCodexPeerGeneration(generation: string): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.resumeGeneration(generation);
      return;
    }
    const active = this.requireNativeCodexListenerGeneration(
      this.activeNativeCodexListener,
      generation,
      "active",
    );
    if (this.preparedNativeCodexListener !== undefined) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_CLEANUP_REQUIRED",
        "The prepared listener must be cleaned before resuming the old one.",
      );
    }
    active.listener.resumeInbound();
    active.inboundQuiesced = false;
    if (this.nativeCodexSuccessionFreeze === generation) {
      this.nativeCodexSuccessionFreeze = undefined;
    }
    this.scheduleClaudeMonitor();
  }

  async rollbackPreparedNativeCodexPeerGeneration(input: {
    preparedGeneration: string;
    resumeGeneration: string;
  }): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.rollbackPrepared(input);
      return;
    }
    await this.cleanupPreparedNativeCodexPeerGeneration(
      input.preparedGeneration,
    );
    await this.resumeNativeCodexPeerGeneration(input.resumeGeneration);
  }

  async retireNativeCodexPeerGeneration(input: {
    retiredGeneration: string;
    protectedActiveGeneration: string;
  }): Promise<void> {
    this.assertReady();
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.retireGeneration(input);
      return;
    }
    const active = this.requireNativeCodexListenerGeneration(
      this.activeNativeCodexListener,
      input.protectedActiveGeneration,
      "active",
    );
    const retired = this.requireNativeCodexListenerGeneration(
      this.retiredNativeCodexListener,
      input.retiredGeneration,
      "retired",
    );
    if (active === retired) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "The protected and retired listener generations must be distinct.",
      );
    }
    const ownsPendingReceipt = [...this.nativeInboundReceiptOwners.values()].some(
      (owner) => owner === retired,
    );
    const ownsRejectedSettlement = [
      ...this.rejectedNativeInbound.values(),
    ].some((rejection) => rejection.listener === retired.listener);
    const ownsOutboundReceipt = [...this.pendingByProviderId.values()].some(
      (pending) => pending.listener === retired.listener,
    );
    if (ownsPendingReceipt || ownsRejectedSettlement || ownsOutboundReceipt) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_NOT_QUIET",
        "A retired listener cannot close while it owns receipt capabilities.",
        true,
      );
    }
    await retired.listener.close();
    if (this.retiredNativeCodexListener === retired) {
      this.retiredNativeCodexListener = undefined;
    }
  }

  async purgeNativeCodexPeerGenerationReplyCapabilities(
    generation: string,
  ): Promise<number> {
    if (this.nativeHelpers !== undefined) {
      return await this.nativeHelpers.purgeGenerationReplies(generation);
    }
    let purged = 0;
    for (const [routeHandle, route] of this.nativeInbound) {
      if (route.listenerGeneration !== generation) continue;
      this.nativeInbound.delete(routeHandle);
      purged += 1;
    }
    return purged;
  }

  async unadvertiseNativeCodexPeer(alias: string): Promise<void> {
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.unadvertise(alias);
      return;
    }
    await this.serializeNativeCodexRegistration(async () => {
      const active = this.activeNativeCodexListener;
      if (active?.registration?.alias !== alias) return;
      await active.listener.unadvertise(active.registration.name);
      await this.purgeNativeCodexPeerGenerationReplyCapabilities(
        active.generation,
      );
      delete active.registration;
      active.registrationProvisional = false;
      active.provisionalIngressForwarded = false;
    });
  }

  async updateNativeCodexPeerStatus(
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

  async quiesceNativeInbound(): Promise<void> {
    if (this.closed) return;
    if (this.nativeHelpers !== undefined) {
      await this.nativeHelpers.quiesceAll();
      return;
    }
    const active = this.activeNativeCodexListener;
    if (active === undefined) return;
    await active.listener.quiesceInbound();
    active.inboundQuiesced = true;
  }

  async dispatch(input: {
    sourceAlias: string;
    targetAlias: string;
    conversationId: string;
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
    progressWatchActive?: true;
  }): Promise<GatewayAdapterDispatchResult> {
    if (this.nativeHelpers !== undefined) {
      if (
        input.sourceAlias === undefined ||
        !this.initialized ||
        this.closed ||
        !sameEndpoint(input.binding, this.identity)
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      const selectedAlias = this.selected.get(input.binding.routeHandle);
      const stateRoot = this.selectedStateRoots.get(input.binding.routeHandle);
      if (
        input.authorization === "selected_route" &&
        (selectedAlias === undefined || stateRoot === undefined)
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      if (input.authorization === "selected_route") {
        this.selectedDispatchEpoch.set(
          input.binding.routeHandle,
          (this.selectedDispatchEpoch.get(input.binding.routeHandle) ?? 0) + 1,
        );
        this.selectedObservationDirty.add(input.binding.routeHandle);
        this.emitClaudeRouteObservation(input.binding.routeHandle, "busy");
      }
      try {
        const sourceAlias = input.sourceAlias;
        const result = await this.nativeHelpers.dispatch({
          ...input,
          sourceAlias,
          ...(selectedAlias === undefined ? {} : { selectedAlias }),
          ...(stateRoot === undefined ? {} : { stateRoot }),
        });
        if (
          input.authorization === "selected_route" &&
          result.state === "pending"
        ) {
          this.selectedObservationDirty.delete(input.binding.routeHandle);
          this.emitClaudeRouteObservation(
            input.binding.routeHandle,
            "idle",
            undefined,
            true,
          );
        }
        return result;
      } catch (error) {
        if (error instanceof BridgeError && error.recoverable) {
          return {
            state: "failed",
            safeErrorCode: "CLAUDE_NATIVE_HELPER_UNAVAILABLE",
          };
        }
        return {
          state: "ambiguous",
          safeErrorCode: "CLAUDE_NATIVE_HELPER_OUTCOME_UNKNOWN",
        };
      }
    }
    const activeListener = this.activeNativeCodexListener;
    if (
      !this.initialized ||
      this.closed ||
      activeListener === undefined ||
      activeListener.inboundQuiesced ||
      this.nativeCodexSuccessionFreeze !== undefined ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
    }
    if (input.authorization === "native_reply") {
      const observedRoute = this.nativeInbound.get(input.binding.routeHandle);
      if (
        observedRoute === undefined ||
        observedRoute.listenerGeneration !== activeListener.generation
      ) {
        this.nativeInbound.delete(input.binding.routeHandle);
        return { state: "failed", safeErrorCode: "CLAUDE_NATIVE_REPLY_STALE" };
      }
    } else {
      const selectedAlias = this.selected.get(input.binding.routeHandle);
      const stateRoot = this.selectedStateRoots.get(input.binding.routeHandle);
      if (
        selectedAlias === undefined ||
        stateRoot === undefined
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
    }
    if (activeListener.registration?.alias !== input.sourceAlias) {
      return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
    }
    if (
      this.activeNativeCodexListener !== activeListener ||
      activeListener.inboundQuiesced ||
      this.nativeCodexSuccessionFreeze !== undefined
    ) {
      return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
    }
    const deadline = strictDeadline(input.deadlineAt, this.now());
    if (deadline === undefined) {
      return { state: "failed", safeErrorCode: "MESSAGE_EXPIRED" };
    }
    if (
      this.providerIdByGatewayId.size >= this.maxPending ||
      this.providerIdByGatewayId.has(input.messageId)
    ) {
      return { state: "failed", safeErrorCode: "CLAUDE_RECEIPT_CAPACITY" };
    }
    let content: string;
    try {
      content = composeProvenanceEnvelope({
        direction: "claude",
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        conversationId: input.conversationId,
        body: input.text,
        ...(input.progressWatchActive === true
          ? { progressWatchActive: true as const }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === "PROVENANCE_ENVELOPE_INVALID" ||
          error.code === "PROVENANCE_ENVELOPE_TOO_LARGE")
      ) {
        return { state: "failed", safeErrorCode: error.code };
      }
      throw error;
    }

    if (input.authorization === "selected_route") {
      const stateRoot = this.selectedStateRoots.get(input.binding.routeHandle);
      if (stateRoot === undefined) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      this.selectedDispatchEpoch.set(
        input.binding.routeHandle,
        (this.selectedDispatchEpoch.get(input.binding.routeHandle) ?? 0) + 1,
      );
      // The exact workspace attestation is refreshed before every send. A
      // clean prewrite failure remains retryable within the message deadline;
      // retry timing does not depend on the model turn's observed state.
      this.selectedObservationDirty.add(input.binding.routeHandle);
      this.emitClaudeRouteObservation(input.binding.routeHandle, "busy");
      try {
        await this.peer.assertTargetWorkspaceDisjoint(
          input.binding.routeHandle,
          stateRoot,
        );
      } catch (error) {
        return claudeCleanPrewriteResult(error);
      }
    }

    this.providerIdByGatewayId.set(input.messageId, "");
    this.pendingTargetByGatewayId.set(
      input.messageId,
      input.binding.routeHandle,
    );
    let providerId: string | undefined;
    let trackingFailed = false;
    let terminalDuringSend = false;
    const onTransportStatus = (event: ClaudePeerTransportEvent): void => {
      if (providerId === undefined) {
        providerId = event.messageId;
        trackingFailed = !this.trackClaudeMessage(
          event.messageId,
          input.messageId,
          input.binding.routeHandle,
          deadline,
          activeListener,
        );
      }
      if (trackingFailed) return;
      if (providerId !== event.messageId) {
        terminalDuringSend = true;
        this.finishClaudeMessage(
          providerId,
          "ambiguous",
          "CLAUDE_RECEIPT_ID_MISMATCH",
        );
        return;
      }
      if (event.status === "transport_written") {
        this.recordClaudeWriteEvidence(event.messageId, "transport_written");
        this.emitDelivery({
          messageId: input.messageId,
          state: "transport_written",
        });
      } else if (
        event.status === "write_started" ||
        event.status === "ambiguous"
      ) {
        const newlyUncertain = this.recordClaudeWriteEvidence(
          event.messageId,
          "transport_uncertain",
        );
        if (newlyUncertain) {
          this.emitDelivery({
            messageId: input.messageId,
            state: "transport_uncertain",
            safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
          });
        }
      } else if (event.status === "not_written") {
        terminalDuringSend = true;
        this.finishClaudeMessage(
          event.messageId,
          "failed",
          "CLAUDE_TRANSPORT_NOT_WRITTEN",
        );
      }
      // A post-write ambiguity remains tracked. The exact receipt or the
      // listener's bounded timeout is authoritative and may settle it later.
    };

    try {
      const result = await this.peer.send(
        input.binding.routeHandle,
        content,
        {
          listener: activeListener.listener,
          receiptDeadlineAt: deadline,
          onTransportStatus,
        },
      );
      if (
        providerId === undefined ||
        providerId !== result.messageId ||
        result.receiptStatus !== "pending" ||
        trackingFailed
      ) {
        if (trackingFailed) {
          this.abandonClaudeTracking(input.messageId, providerId);
          this.emitDelivery({
            messageId: input.messageId,
            state: "ambiguous",
            safeErrorCode: "CLAUDE_RECEIPT_TRACKING_FAILED",
          });
          return { state: "pending" };
        }
        if (providerId !== undefined) {
          this.finishClaudeMessage(
            providerId,
            "ambiguous",
            "CLAUDE_RECEIPT_TRACKING_FAILED",
          );
        } else {
          this.providerIdByGatewayId.delete(input.messageId);
          this.pendingTargetByGatewayId.delete(input.messageId);
        }
        return { state: "ambiguous", safeErrorCode: "CLAUDE_RECEIPT_TRACKING_FAILED" };
      }
      if (input.authorization === "selected_route") {
        this.selectedObservationDirty.delete(input.binding.routeHandle);
        this.emitClaudeRouteObservation(
          input.binding.routeHandle,
          "idle",
          undefined,
          true,
        );
      }
      return { state: "pending" };
    } catch (error) {
      if (trackingFailed) {
        this.abandonClaudeTracking(input.messageId, providerId);
        this.emitDelivery({
          messageId: input.messageId,
          state: "ambiguous",
          safeErrorCode: "CLAUDE_RECEIPT_TRACKING_FAILED",
        });
        return { state: "pending" };
      }
      if (terminalDuringSend) return { state: "pending" };
      if (providerId !== undefined) {
        if (
          error instanceof BridgeError &&
          error.code === "CLAUDE_PEER_WRITE_AMBIGUOUS"
        ) {
          return { state: "pending" };
        }
        this.finishClaudeMessage(
          providerId,
          "ambiguous",
          "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS",
        );
        return { state: "pending" };
      }
      this.providerIdByGatewayId.delete(input.messageId);
      this.pendingTargetByGatewayId.delete(input.messageId);
      return claudeCleanPrewriteResult(error);
    }
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
      for (const pending of this.pendingByProviderId.values()) {
        clearTimeout(pending.timer);
      }
      this.pendingByProviderId.clear();
      this.providerIdByGatewayId.clear();
      this.pendingTargetByGatewayId.clear();
      this.selected.clear();
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
      this.preparedNativeCodexListener = undefined;
      this.retiredNativeCodexListener = undefined;
      this.nativeCodexPreparationInFlight = undefined;
      this.nativeCodexSuccessionFreeze = undefined;
      this.callbacks = undefined;
    }
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) {
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
    if (!name.startsWith("codex-") || !NATIVE_CLAUDE_NAME.test(name)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_ALIAS",
        "The native Codex peer alias must start with codex-.",
      );
    }
    if (!path.isAbsolute(input.cwd) || input.cwd.includes("\0")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_CWD",
        "A native Codex peer requires an absolute working directory.",
      );
    }
    return { alias: input.alias, cwd: input.cwd, name };
  }

  private requireActiveNativeCodexListener(): NativeCodexListenerGeneration {
    this.assertReady();
    const active = this.activeNativeCodexListener;
    if (active === undefined || active.lifecycle !== "active") {
      throw new BridgeError(
        "CLAUDE_CALLBACK_UNAVAILABLE",
        "The private Claude callback listener is unavailable.",
        true,
      );
    }
    return active;
  }

  private requireNativeCodexListenerGeneration(
    listenerGeneration: NativeCodexListenerGeneration | undefined,
    generation: string,
    lifecycle: NativeCodexListenerLifecycle,
  ): NativeCodexListenerGeneration {
    if (
      listenerGeneration === undefined ||
      listenerGeneration.generation !== generation ||
      listenerGeneration.listener.generation !== generation ||
      listenerGeneration.lifecycle !== lifecycle
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "The requested native Codex listener generation is not the exact lifecycle owner.",
      );
    }
    return listenerGeneration;
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
    return (
      this.activeNativeCodexListener === listenerGeneration ||
      this.preparedNativeCodexListener === listenerGeneration ||
      this.retiredNativeCodexListener === listenerGeneration
    );
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
      this.activeNativeCodexListener !== listenerGeneration ||
      listenerGeneration.lifecycle !== "active" ||
      listenerGeneration.inboundQuiesced ||
      this.nativeCodexSuccessionFreeze !== undefined
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
      listenerGeneration.lifecycle !== "active" ||
      listenerGeneration.inboundQuiesced ||
      this.nativeCodexSuccessionFreeze !== undefined ||
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
    return [
      this.activeNativeCodexListener,
      this.preparedNativeCodexListener,
      this.retiredNativeCodexListener,
    ].some(
      (candidate) =>
        candidate?.generation === generation && candidate.listener === listener,
    );
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

  private trackClaudeMessage(
    providerId: string,
    gatewayMessageId: string,
    targetId: string,
    deadline: number,
    listenerGeneration: NativeCodexListenerGeneration,
  ): boolean {
    if (
      this.pendingByProviderId.has(providerId) ||
      this.providerIdByGatewayId.get(gatewayMessageId) !== "" ||
      this.pendingByProviderId.size >= this.maxPending
    ) {
      return false;
    }
    const timer = setTimeout(() => {
      const pending = this.pendingByProviderId.get(providerId);
      if (pending === undefined) return;
      pending.listener.untrack(providerId);
      if (pending.writeEvidence === "transport_written") {
        this.finishClaudeMessage(
          providerId,
          "unconfirmed",
          "CLAUDE_RECEIPT_UNCONFIRMED",
        );
      } else if (pending.writeEvidence === "transport_uncertain") {
        this.finishClaudeMessage(
          providerId,
          "ambiguous",
          "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS",
        );
      } else {
        this.finishClaudeMessage(providerId, "expired", "MESSAGE_EXPIRED");
      }
    }, Math.max(1, deadline - this.now()));
    timer.unref();
    this.pendingByProviderId.set(providerId, {
      gatewayMessageId,
      listener: listenerGeneration.listener,
      listenerGeneration: listenerGeneration.generation,
      targetId,
      writeEvidence: "none",
      timer,
    });
    this.providerIdByGatewayId.set(gatewayMessageId, providerId);
    return true;
  }

  private abandonClaudeTracking(
    gatewayMessageId: string,
    providerId: string | undefined,
  ): void {
    if (providerId !== undefined) {
      const pending = this.pendingByProviderId.get(providerId);
      if (pending?.gatewayMessageId === gatewayMessageId) {
        clearTimeout(pending.timer);
        this.pendingByProviderId.delete(providerId);
        pending.listener.untrack(providerId);
      }
    }
    this.providerIdByGatewayId.delete(gatewayMessageId);
    this.pendingTargetByGatewayId.delete(gatewayMessageId);
  }

  private onReceipt(
    listenerGeneration: NativeCodexListenerGeneration,
    event: ClaudePeerReceiptEvent,
  ): void {
    const pending = this.pendingByProviderId.get(event.messageId);
    if (
      pending === undefined ||
      pending.listenerGeneration !== listenerGeneration.generation ||
      pending.listener !== listenerGeneration.listener
    ) {
      return;
    }
    if (event.status === "held") {
      pending.writeEvidence = "transport_written";
      this.emitDelivery({ messageId: pending.gatewayMessageId, state: "held" });
      return;
    }
    // `released` is Claude's native approval-gate terminal: the frame reached
    // the recipient queue. It does not claim a model read or task completion.
    const state =
      event.status === "released"
        ? "released"
        : event.status === "denied"
          ? "denied"
          : event.status === "expired"
            ? "expired"
            : event.status === "unconfirmed"
              ? "unconfirmed"
              : "ambiguous";
    this.finishClaudeMessage(
      event.messageId,
      state,
      event.status === "unconfirmed"
        ? "CLAUDE_RECEIPT_UNCONFIRMED"
        : undefined,
    );
  }

  private recordClaudeWriteEvidence(
    providerId: string,
    evidence: ClaudePending["writeEvidence"],
  ): boolean {
    const pending = this.pendingByProviderId.get(providerId);
    if (pending === undefined) return false;
    const previous = pending.writeEvidence;
    if (
      pending.writeEvidence !== "transport_written" ||
      evidence === "transport_written"
    ) {
      pending.writeEvidence = evidence;
    }
    return pending.writeEvidence !== previous;
  }

  private finishClaudeMessage(
    providerId: string,
    state: GatewayAdapterDelivery["state"],
    safeErrorCode?: string,
  ): void {
    const pending = this.pendingByProviderId.get(providerId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingByProviderId.delete(providerId);
    this.providerIdByGatewayId.delete(pending.gatewayMessageId);
    this.pendingTargetByGatewayId.delete(pending.gatewayMessageId);
    this.emitDelivery({
      messageId: pending.gatewayMessageId,
      state,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    });
  }

  private emitDelivery(event: GatewayAdapterDelivery): void {
    const callbacks = this.callbacks;
    if (callbacks === undefined || this.closed) return;
    invokeCallback(() => callbacks.onDelivery(event));
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
    const pendingAtStart = new Set(this.pendingTargetByGatewayId.values());
    const discovery = await this.peer.discover();
    this.discovered.clear();
    const rows: GatewayAdapterDiscovery[] = [];
    for (const peer of discovery.peers) {
      if (
        peer.kind !== "interactive" ||
        !NATIVE_CLAUDE_NAME.test(peer.alias) ||
        peer.alias.startsWith("codex-")
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
        compatibility: "compatible",
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
          (pendingAtStart.has(routeHandle) ||
            this.hasPendingClaudeReceipt(routeHandle) ||
            dispatchEpochAtStart.get(routeHandle) !==
              (this.selectedDispatchEpoch.get(routeHandle) ?? 0))
        ) {
          // Never publish an idle sample from a discovery that overlapped a
          // dispatch or its receipt lifetime. The dirty epoch remains set for
          // a wholly post-terminal discovery.
          continue;
        }
        this.emitClaudeRouteObservation(routeHandle, row.state, undefined, true);
      }
    }
    return { peers: rows, complete: !discovery.truncated };
  }

  private emitClaudeRouteObservation(
    routeHandle: string,
    state: GatewayAdapterRouteState,
    safeErrorCode?: string,
    authoritative = false,
  ): void {
    if (this.nativeCodexSuccessionFreeze !== undefined) return;
    if (
      authoritative &&
      state === "idle" &&
      this.hasPendingClaudeReceipt(routeHandle)
    ) {
      // A registry peer can still report idle after our write but before it
      // consumes the inbox frame. Preserve the dirty dispatch epoch so only a
      // fresh discovery after exact terminal receipt can unlock this route.
      return;
    }
    const signature = `${state}:${safeErrorCode ?? ""}`;
    const mustPublish =
      authoritative && this.selectedObservationDirty.delete(routeHandle);
    if (!mustPublish && this.selectedObservations.get(routeHandle) === signature) {
      return;
    }
    this.selectedObservations.set(routeHandle, signature);
    const callbacks = this.callbacks;
    if (callbacks === undefined || this.closed) return;
    invokeCallback(() =>
      callbacks.onRouteState({
        endpoint: callbackEndpoint(this.identity, routeHandle),
        state,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      }),
    );
  }

  private hasPendingClaudeReceipt(routeHandle: string): boolean {
    for (const targetId of this.pendingTargetByGatewayId.values()) {
      if (targetId === routeHandle) return true;
    }
    return false;
  }

  private scheduleClaudeMonitor(): void {
    if (
      this.closed ||
      this.nativeCodexSuccessionFreeze !== undefined ||
      this.selected.size === 0 ||
      this.monitorTimer !== undefined
    ) {
      return;
    }
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = undefined;
      void this.refreshClaudeDiscovery()
        .catch(() => {
          if (this.nativeCodexSuccessionFreeze !== undefined) return;
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
  factory: LocalCodexTransportFactory;
  /** Re-resolves the exact pinned managed install after its generation moves. */
  refreshFactory?: () => Promise<LocalCodexTransportFactory>;
  cleanupPollMs?: number;
  cleanupTimeoutMs?: number;
  recoveryInitialMs?: number;
  recoveryMaxMs?: number;
  maxCallbackEvents?: number;
  maxRoutes?: number;
  maxReplyBytes?: number;
  now?: () => Date;
};

type CodexRoute = {
  connector: CodexAppServerConnector;
  endpointGeneration: string;
  generation: symbol;
  threadId: string;
  transport: LocalCodexOwnedTransport;
};

type CodexCallbackEvent =
  | {
      type: "delivery";
      endpointGeneration: string;
      value: GatewayAdapterDelivery;
    }
  | {
      type: "route";
      endpointGeneration: string;
      generation: symbol;
      routeHandle: string;
      state: GatewayAdapterRouteObservationState;
      safeErrorCode?: string;
    };

type CodexEndpointRefreshResult = {
  event: GatewayAdapterEndpointRefresh;
  delivery: "callback" | "selector";
  selectorClaimed: boolean;
};

function validateCodexFactory(factory: LocalCodexTransportFactory): void {
  const schema = factory.schemaCompatibility;
  const write = factory.writeCompatibility;
  const certified = CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
    factory.appServerVersion as (typeof CODEX_APP_SERVER_WRITABLE_VERSIONS)[number],
  );
  const schemaCandidate =
    schema.observedSchemaCandidate === true &&
    CODEX_APP_SERVER_WRITABLE_VERSIONS.some((version) =>
      sharesCompatibilityMajor(version, factory.appServerVersion),
    );
  if (
    factory.hostId !== LOCAL_HOST ||
    factory.protocol !== "codex-app-server" ||
    factory.protocolVersion !== factory.appServerVersion ||
    (!certified &&
      (!schemaCandidate || write !== null || factory.writableReady)) ||
    schema.appServerVersion !== factory.appServerVersion ||
    schema.endpointGeneration !== factory.endpointGeneration ||
    schema.protocol !== "app-server-v2-stable" ||
    schema.steering?.method !== "turn/steer" ||
    schema.steering.requestSchema !== "expected-turn-id-text-v1" ||
    schema.steering.deliveryBoundary !== "next-tool-call-boundary" ||
    (write !== null &&
      (write.appServerVersion !== schema.appServerVersion ||
        write.endpointGeneration !== schema.endpointGeneration ||
        write.protocol !== schema.protocol ||
        write.observedSchemaCandidate !== schema.observedSchemaCandidate ||
        write.steering?.method !== schema.steering.method ||
        write.steering.requestSchema !== schema.steering.requestSchema ||
        write.steering.deliveryBoundary !==
          schema.steering.deliveryBoundary)) ||
    factory.writableReady !== (write !== null)
  ) {
    throw new BridgeError(
      "CODEX_FACTORY_ATTESTATION_INVALID",
      "The local Codex provider requires exact schema and write attestations.",
    );
  }
}

function codexRouteState(
  observation: CodexConnectorObservation,
): GatewayAdapterRouteObservationState {
  if (observation.connection !== "ready") return "stale";
  if (observation.routeStatus === "idle") return "idle";
  if (observation.routeStatus === "waiting_approval") {
    return "awaiting_approval";
  }
  if (
    observation.routeStatus === "starting" ||
    observation.routeStatus === "active" ||
    observation.routeStatus === "interrupting"
  ) {
    return "busy";
  }
  // Unknown, not-loaded, uncertain, system-error, and explicit stale states
  // are never cosmetic busy. They cannot authorize another write.
  return "stale";
}

function codexRouteSafeCode(
  observation: CodexConnectorObservation,
): string | undefined {
  if (codexRouteState(observation) === "stale") {
    return "CODEX_ROUTE_STALE";
  }
  if (!observation.writableReady) {
    return "CODEX_WRITES_DISABLED";
  }
  return undefined;
}

export class LocalCodexGatewayProvider implements GatewayProviderAdapter {
  private factory: LocalCodexTransportFactory;
  private readonly refreshFactory:
    | (() => Promise<LocalCodexTransportFactory>)
    | undefined;
  private readonly maxCallbacks: number;
  private readonly maxRoutes: number;
  private readonly maxReplyBytes: number;
  private readonly cleanupPollMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly recoveryInitialMs: number;
  private readonly recoveryMaxMs: number;
  private readonly now: () => Date;
  private readonly routes = new Map<string, CodexRoute>();
  /** Exact public alias authority retained across internal route recovery. */
  private readonly routeAliases = new Map<string, string>();
  private readonly routeCreations = new Map<string, Promise<CodexRoute>>();
  private readonly routeReleases = new Map<string, Promise<void>>();
  private readonly routeRecoveryAttempts = new Map<string, number>();
  private readonly routeRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly routeRecoveries = new Map<string, Promise<void>>();
  private readonly routesRequiringRecovery = new Set<string>();
  private readonly trackedRoutes = new Set<string>();
  private retiredEndpointGeneration: string | undefined;
  private readonly expectsReply = new Map<string, boolean>();
  private readonly callbackQueue: CodexCallbackEvent[] = [];
  private callbackScheduled = false;
  private callbacks: GatewayAdapterCallbacks | undefined;
  private endpointRefresh:
    | Promise<CodexEndpointRefreshResult | undefined>
    | undefined;
  private endpointRefreshDelivery: "callback" | "selector" | undefined;
  private endpointActivationRetry:
    | Readonly<{
        event: GatewayAdapterEndpointRefresh;
        attempt: number;
      }>
    | undefined;
  private endpointActivationRetryTimer: NodeJS.Timeout | undefined;
  private callbackDrainFrozen = false;
  private compatibilityAttested: boolean;
  private endpointUnavailable = false;
  private pendingEndpointAttestation: CompatibilityAttestation | undefined;
  private pendingEndpointRefreshEvent:
    | Extract<GatewayAdapterEndpointRefresh, { outcome: "compatible" }>
    | undefined;
  private initialized = false;
  private closing = false;
  private closed = false;

  constructor(options: LocalCodexGatewayProviderOptions) {
    validateCodexFactory(options.factory);
    this.factory = options.factory;
    this.refreshFactory = options.refreshFactory;
    exactLocalHost(options.factory.hostId);
    this.compatibilityAttested = CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
      options.factory.appServerVersion as (typeof CODEX_APP_SERVER_WRITABLE_VERSIONS)[number],
    );
    this.maxCallbacks = positiveBounded(
      options.maxCallbackEvents,
      MAX_CODEX_CALLBACKS,
      4_096,
    );
    this.maxRoutes = positiveBounded(
      options.maxRoutes,
      MAX_CODEX_ROUTES,
      256,
    );
    this.maxReplyBytes = positiveBounded(
      options.maxReplyBytes,
      MAX_TRANSIENT_REPLY_BYTES,
      1024 * 1024,
    );
    this.cleanupPollMs = positiveBounded(
      options.cleanupPollMs,
      DEFAULT_CODEX_CLEANUP_POLL_MS,
      1_000,
    );
    this.cleanupTimeoutMs = positiveBounded(
      options.cleanupTimeoutMs,
      DEFAULT_CODEX_CLEANUP_TIMEOUT_MS,
      60_000,
    );
    if (this.cleanupPollMs >= this.cleanupTimeoutMs) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "The cleanup polling interval must be shorter than its deadline.",
      );
    }
    this.recoveryInitialMs = positiveBounded(
      options.recoveryInitialMs,
      DEFAULT_CODEX_RECOVERY_INITIAL_MS,
      60_000,
    );
    this.recoveryMaxMs = positiveBounded(
      options.recoveryMaxMs,
      DEFAULT_CODEX_RECOVERY_MAX_MS,
      5 * 60_000,
    );
    if (this.recoveryInitialMs > this.recoveryMaxMs) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "The Codex recovery initial delay cannot exceed its capped delay.",
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  get identity(): PrivateEndpointIdentity {
    return {
      provider: "codex",
      hostId: exactLocalHost(this.factory.hostId),
      endpointGeneration: this.factory.endpointGeneration,
    };
  }

  get protocol(): string {
    return this.factory.protocol;
  }

  get protocolVersion(): string {
    return this.factory.protocolVersion;
  }

  compatibilitySurface(): CompatibilitySurfaceObservation {
    return { surface: "codex", version: this.factory.appServerVersion };
  }

  acceptCompatibilityAttestation(attestation: CompatibilityAttestation): void {
    const pending = this.pendingEndpointAttestation;
    if (
      attestation.surface !== "codex" ||
      attestation.version !== this.factory.appServerVersion ||
      attestation.tier !== "certified" ||
      !CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
        attestation.version as (typeof CODEX_APP_SERVER_WRITABLE_VERSIONS)[number],
      ) ||
      (this.endpointUnavailable && pending === undefined) ||
      (pending !== undefined &&
        (attestation.checkedAt !== pending.checkedAt ||
          attestation.tier !== pending.tier ||
          attestation.safeErrorCode !== pending.safeErrorCode ||
          attestation.probes.length !== pending.probes.length ||
          attestation.probes.some(
            (probe, index) =>
              probe.name !== pending.probes[index]?.name ||
              probe.outcome !== pending.probes[index]?.outcome ||
              probe.safeErrorCode !== pending.probes[index]?.safeErrorCode,
          )))
    ) {
      throw new BridgeError(
        "CODEX_COMPATIBILITY_ATTESTATION_MISMATCH",
        "The Codex compatibility attestation does not match this endpoint.",
      );
    }
    this.pendingEndpointAttestation = undefined;
    this.pendingEndpointRefreshEvent = undefined;
    this.clearEndpointActivationRetry();
    this.compatibilityAttested = true;
    this.endpointUnavailable = false;
  }

  async runCompatibilityProbes(): Promise<readonly CompatibilityProbeResult[]> {
    return await this.runCompatibilityProbesFor(this.factory);
  }

  private async runCompatibilityProbesFor(
    factory: LocalCodexTransportFactory,
  ): Promise<readonly CompatibilityProbeResult[]> {
    const [installation, control, initialize, threadList] =
      compatibilityProbeNames.codex;
    let transport: LocalCodexOwnedTransport | undefined;
    let connector: CodexAppServerConnector | undefined;
    let stage: "transport" | "initialize" | "thread_list" = "transport";
    try {
      transport = await factory.connectTransport();
      stage = "initialize";
      connector = await CodexAppServerConnector.connect({
        compatibility: factory.schemaCompatibility,
        writesEnabled: false,
        route: {
          endpointGeneration: factory.endpointGeneration,
          threadId: COMPATIBILITY_PROBE_THREAD_ID,
        },
        transport,
        maxReplyBytes: this.maxReplyBytes,
        now: this.now,
        onEvent: () => undefined,
        onTurnResult: () => undefined,
      });
      stage = "thread_list";
      await connector.observeLoadedThread(connector.guard());
      return [
        passedProbe(installation),
        passedProbe(control),
        passedProbe(initialize),
        passedProbe(threadList),
      ];
    } catch (error) {
      if (this.isEndpointGenerationChanged(error)) throw error;
      if (stage === "transport") {
        const controlFailure =
          error instanceof LocalCodexTransportError &&
          [
            "LOCAL_APP_SERVER_NOT_RUNNING",
            "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
            "TRANSPORT_CONNECT_FAILED",
          ].includes(error.code);
        return [
          controlFailure
            ? passedProbe(installation)
            : failedProbe(installation, "CODEX_INSTALLATION_INVALID"),
          failedProbe(
            control,
            controlFailure
              ? "CODEX_CONTROL_SOCKET_UNAVAILABLE"
              : "CODEX_COMPAT_PROBE_BLOCKED",
          ),
          failedProbe(initialize, "CODEX_COMPAT_PROBE_BLOCKED"),
          failedProbe(threadList, "CODEX_COMPAT_PROBE_BLOCKED"),
        ];
      }
      return [
        passedProbe(installation),
        passedProbe(control),
        stage === "initialize"
          ? failedProbe(initialize, "CODEX_INITIALIZE_SCHEMA_REJECTED")
          : passedProbe(initialize),
        failedProbe(threadList, "CODEX_THREAD_LIST_SCHEMA_REJECTED"),
      ];
    } finally {
      if (connector !== undefined) {
        await connector.close().catch(() => undefined);
      } else if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  async initialize(
    callbacks: GatewayAdapterCallbacks,
  ): Promise<GatewayAdapterStart> {
    if (this.closed || this.initialized) {
      throw new BridgeError(
        "CODEX_PROVIDER_INITIALIZATION_REJECTED",
        "The local Codex provider cannot be initialized in this state.",
      );
    }
    this.callbacks = callbacks;
    this.initialized = true;
    return this.factory.writeCompatibility === null
      ? {
          health: "degraded",
          compatibility: "compatible",
          safeErrorCode: "CODEX_MONITOR_ONLY",
        }
      : { health: "healthy", compatibility: "compatible" };
  }

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{
    routeHandle: string;
    state: GatewayAdapterRouteState;
    endpointRefresh?: GatewayAdapterEndpointRefresh;
  }> {
    if (!this.initialized || this.closing || this.closed) {
      throw new BridgeError(
        "CODEX_PROVIDER_UNAVAILABLE",
        "The local Codex provider is unavailable.",
        true,
      );
    }
    if (
      !PUBLIC_ALIAS.test(input.alias) ||
      !input.alias.endsWith(`@${this.identity.hostId}`)
    ) {
      throw new BridgeError(
        "CODEX_ALIAS_MISMATCH",
        "The Codex alias is outside the exact local provider boundary.",
      );
    }
    if (!OPAQUE_ROUTE.test(input.routeHandle)) {
      throw new BridgeError(
        "CODEX_ROUTE_INVALID",
        "The Codex task identifier is outside the exact provider boundary.",
      );
    }
    const retainedAlias = this.routeAliases.get(input.routeHandle);
    if (retainedAlias !== undefined && retainedAlias !== input.alias) {
      throw new BridgeError(
        "CODEX_ALIAS_MISMATCH",
        "The Codex route is already bound to another exact public alias.",
      );
    }
    this.cancelRouteRecovery(input.routeHandle);
    let refreshResult: CodexEndpointRefreshResult | undefined;
    let selectorRefreshReserved = false;
    let route: CodexRoute;
    const stageRefreshedRoute = async (
      result: CodexEndpointRefreshResult | undefined,
    ): Promise<CodexRoute> => {
      if (
        result === undefined ||
        result.event.outcome !== "compatible"
      ) {
        throw new BridgeError(
          "CODEX_ROUTE_SETUP_REJECTED",
          "The exact Codex endpoint replacement was not compatibility-attested.",
        );
      }
      refreshResult = result;
      selectorRefreshReserved = this.reserveSelectorRefresh(result);
      if (!selectorRefreshReserved) {
        throw new BridgeError(
          "CODEX_PROVIDER_UNAVAILABLE",
          "The Codex endpoint replacement is awaiting controller activation.",
          true,
        );
      }
      try {
        return await this.ensureRoute(input.routeHandle, false, true);
      } catch (selectionError) {
        this.emitSelectorRefreshFallback(result, input.routeHandle);
        throw selectionError;
      }
    };

    if (this.endpointRefresh !== undefined) {
      route = await stageRefreshedRoute(
        await this.refreshEndpoint("selector"),
      );
    } else if (
      this.endpointUnavailable &&
      this.pendingEndpointAttestation === undefined
    ) {
      route = await stageRefreshedRoute(
        await this.refreshEndpoint("selector"),
      );
    } else {
      this.assertReady();
      try {
        route = await this.ensureRoute(input.routeHandle);
      } catch (error) {
        const refreshPending =
          error instanceof BridgeError &&
          error.code === "CODEX_ENDPOINT_REFRESH_PENDING";
        if (!this.isEndpointGenerationChanged(error) && !refreshPending) {
          throw error;
        }
        if (this.isEndpointGenerationChanged(error)) {
          this.endpointUnavailable = true;
          route = await stageRefreshedRoute(
            await this.refreshEndpoint("selector"),
          );
        } else if (this.endpointRefresh !== undefined) {
          route = await stageRefreshedRoute(
            await this.refreshEndpoint("selector"),
          );
        } else {
          throw new BridgeError(
            "CODEX_PROVIDER_UNAVAILABLE",
            "The Codex endpoint replacement is awaiting controller activation.",
            true,
          );
        }
      }
      if (
        refreshResult === undefined &&
        (route.endpointGeneration !== this.factory.endpointGeneration ||
          this.endpointUnavailable ||
          this.endpointRefresh !== undefined)
      ) {
        if (this.endpointRefresh === undefined) {
          throw new BridgeError(
            "CODEX_PROVIDER_UNAVAILABLE",
            "The Codex endpoint replacement is awaiting controller activation.",
            true,
          );
        }
        route = await stageRefreshedRoute(
          await this.refreshEndpoint("selector"),
        );
      }
    }
    const observation = route.connector.observation();
    const state = codexRouteState(observation);
    if (state === "stale") {
      if (refreshResult !== undefined && selectorRefreshReserved) {
        // Publish the transition before any asynchronous connector cleanup so
        // the controller can accept or durably reject the exact replacement
        // generation. A route which closed after refresh staging is not valid
        // re-anchoring evidence and must be removed from both the callback and
        // its retained retry authority.
        this.emitSelectorRefreshFallback(refreshResult, input.routeHandle);
      }
      this.routesRequiringRecovery.add(input.routeHandle);
      await this.releaseRouteInternal(input.routeHandle);
      if (this.trackedRoutes.has(input.routeHandle)) {
        this.scheduleRouteRecovery(input.routeHandle);
      }
      throw new BridgeError(
        "CODEX_ROUTE_SETUP_REJECTED",
        "The exact Codex task connection closed during route selection.",
      );
    }
    this.trackedRoutes.add(input.routeHandle);
    this.routeAliases.set(input.routeHandle, input.alias);
    if (refreshResult === undefined) {
      this.queueRouteObservation(route, observation);
    }
    const endpointRefresh =
      refreshResult === undefined || !selectorRefreshReserved
        ? undefined
        : refreshResult.event;
    if (endpointRefresh !== undefined) {
      this.armEndpointActivationRetry(endpointRefresh);
    }
    return {
      routeHandle: input.routeHandle,
      state,
      ...(endpointRefresh === undefined ? {} : { endpointRefresh }),
    };
  }

  observeRouteSuccessionBarrier(
    routeHandle: string,
  ): CodexRouteSuccessionBarrier {
    if (!this.initialized || this.closing || this.closed) {
      throw new BridgeError(
        "CODEX_PROVIDER_UNAVAILABLE",
        "The local Codex provider is unavailable.",
        true,
      );
    }
    const route = this.routes.get(routeHandle);
    const observation = route?.connector.observation();
    const routeCreationInFlight =
      this.routeCreations.has(routeHandle) ||
      this.routeRecoveries.has(routeHandle) ||
      (this.endpointRefresh !== undefined && this.trackedRoutes.has(routeHandle)) ||
      this.pendingEndpointActivationClaims(routeHandle);
    const routeReleaseInFlight = this.routeReleases.has(routeHandle);
    const pendingReplyCorrelations = this.expectsReply.size;
    const pendingCallbacks = Math.max(
      this.callbackQueue.length,
      this.callbackScheduled ? 1 : 0,
    );
    const routePresent = route !== undefined;
    const connection = observation?.connection ?? "absent";
    const routeStatus = observation?.routeStatus ?? "absent";
    const queueDepth = observation?.queueDepth ?? 0;
    const hasActiveTurn = observation?.hasActiveTurn ?? false;
    const requestInFlight = observation?.requestInFlight ?? false;
    return {
      routePresent,
      connection,
      routeStatus,
      queueDepth,
      hasActiveTurn,
      requestInFlight,
      routeCreationInFlight,
      routeReleaseInFlight,
      pendingReplyCorrelations,
      pendingCallbacks,
      clean:
        routePresent &&
        connection === "ready" &&
        routeStatus === "idle" &&
        queueDepth === 0 &&
        !hasActiveTurn &&
        !requestInFlight &&
        !routeCreationInFlight &&
        !routeReleaseInFlight &&
        pendingReplyCorrelations === 0 &&
        pendingCallbacks === 0,
    };
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      this.endpointUnavailable ||
      this.endpointRefresh !== undefined ||
      !this.compatibilityAttested ||
      input.authorization !== "selected_route" ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      return { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" };
    }
    const route = this.routes.get(input.binding.routeHandle);
    if (
      route === undefined ||
      this.routeAliases.get(input.binding.routeHandle) !== input.targetAlias ||
      this.routeReleases.has(input.binding.routeHandle) ||
      route.endpointGeneration !== input.binding.endpointGeneration ||
      route.endpointGeneration !== this.factory.endpointGeneration
    ) {
      return { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" };
    }
    if (
      !this.factory.writableReady ||
      this.factory.writeCompatibility === null
    ) {
      return { state: "failed", safeErrorCode: "CODEX_WRITES_DISABLED" };
    }
    const guard = route.connector.guard();
    if (!guard.writableReady) {
      return { state: "failed", safeErrorCode: "CODEX_WRITES_DISABLED" };
    }
    if (strictDeadline(input.deadlineAt, this.now().getTime()) === undefined) {
      return { state: "failed", safeErrorCode: "MESSAGE_EXPIRED" };
    }
    if (this.expectsReply.has(input.messageId)) {
      return { state: "failed", safeErrorCode: "CODEX_MESSAGE_DUPLICATE" };
    }
    let content: string;
    try {
      content = composeProvenanceEnvelope({
        direction: "codex",
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        conversationId: input.conversationId,
        body: input.text,
        ...(input.progressWatchActive === true
          ? { progressWatchActive: true as const }
          : {}),
      });
    } catch (error) {
      const safeErrorCode =
        error instanceof BridgeError &&
        (error.code === "PROVENANCE_ENVELOPE_INVALID" ||
          error.code === "PROVENANCE_ENVELOPE_TOO_LARGE")
          ? error.code
          : "PROVENANCE_ENVELOPE_INVALID";
      return { state: "failed", safeErrorCode };
    }
    this.expectsReply.set(input.messageId, input.expectsReply);
    try {
      const disposition = await route.connector.submitMessage(guard, {
        deadlineAt: input.deadlineAt,
        messageId: input.messageId,
        ...(input.steer === true ? { steer: true as const } : {}),
        text: content,
      });
      if (disposition.disposition === "deferred") {
        this.expectsReply.delete(input.messageId);
        return { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" };
      }
      if (disposition.disposition === "steered") {
        this.expectsReply.delete(input.messageId);
        return { state: "delivered" };
      }
      return { state: "accepted" };
    } catch (error) {
      if (!this.expectsReply.has(input.messageId)) {
        // The connector synchronously handed off an exact terminal result.
        return { state: "pending" };
      }
      this.expectsReply.delete(input.messageId);
      if (error instanceof CodexConnectorError && error.ambiguous) {
        return {
          state: "ambiguous",
          safeErrorCode: "CODEX_DISPATCH_OUTCOME_AMBIGUOUS",
        };
      }
      if (
        error instanceof CodexConnectorError &&
        [
          "ROUTE_NOT_READY",
          "ROUTE_BUSY",
        ].includes(error.code)
      ) {
        return { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" };
      }
      return { state: "failed", safeErrorCode: "CODEX_DISPATCH_REJECTED" };
    }
  }

  async releaseRoute(routeHandle: string): Promise<void> {
    if (this.pendingEndpointActivationClaims(routeHandle)) {
      throw new BridgeError(
        "CODEX_ENDPOINT_ACTIVATION_PENDING",
        "The exact Codex route still belongs to an unaccepted endpoint transition.",
        true,
      );
    }
    this.trackedRoutes.delete(routeHandle);
    this.cancelRouteRecovery(routeHandle);
    const recovery = this.routeRecoveries.get(routeHandle);
    if (recovery !== undefined) await recovery;
    const endpointRefresh = this.endpointRefresh;
    if (endpointRefresh !== undefined) await endpointRefresh;
    if (this.pendingEndpointActivationClaims(routeHandle)) {
      throw new BridgeError(
        "CODEX_ENDPOINT_ACTIVATION_PENDING",
        "The exact Codex route acquired endpoint-transition authority during release.",
        true,
      );
    }
    await this.releaseRouteInternal(routeHandle);
    this.routeAliases.delete(routeHandle);
  }

  private async releaseRouteInternal(routeHandle: string): Promise<void> {
    const pending = this.routeReleases.get(routeHandle);
    if (pending !== undefined) return await pending;
    const route = this.routes.get(routeHandle);
    if (route === undefined) return;
    const release = this.closeRoute(route).then(() => {
      if (this.routes.get(routeHandle) === route) {
        this.routes.delete(routeHandle);
      }
    });
    this.routeReleases.set(routeHandle, release);
    try {
      await release;
    } finally {
      this.routeReleases.delete(routeHandle);
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    for (const timer of this.routeRecoveryTimers.values()) clearTimeout(timer);
    this.routeRecoveryTimers.clear();
    this.routesRequiringRecovery.clear();
    this.clearEndpointActivationRetry();
    this.pendingEndpointRefreshEvent = undefined;
    this.pendingEndpointAttestation = undefined;
    const refreshResult =
      this.endpointRefresh === undefined
        ? []
        : await Promise.allSettled([this.endpointRefresh]);
    const entries = [...this.routes.entries()];
    const routeResults = await Promise.allSettled(
      entries.map(async ([routeHandle]) => this.releaseRoute(routeHandle)),
    );
    await Promise.allSettled([
      ...this.routeRecoveries.values(),
      ...this.routeCreations.values(),
    ]);
    this.drainCallbackQueue();
    if (
      refreshResult.some((result) => result.status === "rejected") ||
      routeResults.some((result) => result.status === "rejected")
    ) {
      this.closing = false;
      throw new BridgeError(
        "CODEX_PROVIDER_CLEANUP_FAILED",
        "An exact owned Codex turn did not confirm termination.",
      );
    }
    try {
      await this.factory.close();
    } catch {
      this.closing = false;
      throw new BridgeError(
        "CODEX_PROVIDER_CLEANUP_FAILED",
        "An exact owned Codex provider process did not confirm cleanup.",
      );
    }
    this.closed = true;
    this.closing = false;
    this.callbackQueue.length = 0;
    this.pendingEndpointAttestation = undefined;
    this.pendingEndpointRefreshEvent = undefined;
    this.trackedRoutes.clear();
    this.routeAliases.clear();
    this.expectsReply.clear();
    this.callbacks = undefined;
  }

  private assertReady(): void {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      this.endpointUnavailable ||
      this.endpointRefresh !== undefined ||
      !this.compatibilityAttested
    ) {
      throw new BridgeError(
        "CODEX_PROVIDER_UNAVAILABLE",
        "The local Codex provider is unavailable.",
        true,
      );
    }
  }

  private async ensureRoute(
    threadId: string,
    queueInitialObservation = true,
    allowPendingEndpointAttestation = false,
  ): Promise<CodexRoute> {
    if (allowPendingEndpointAttestation) {
      if (!this.initialized || this.closing || this.closed) {
        throw new BridgeError(
          "CODEX_PROVIDER_UNAVAILABLE",
          "The local Codex provider is unavailable.",
          true,
        );
      }
    } else {
      this.assertReady();
    }
    const pendingRelease = this.routeReleases.get(threadId);
    if (pendingRelease !== undefined) {
      await pendingRelease;
      return await this.ensureRoute(
        threadId,
        queueInitialObservation,
        allowPendingEndpointAttestation,
      );
    }
    const existing = this.routes.get(threadId);
    if (existing !== undefined) {
      if (existing.connector.observation().connection === "ready") {
        return existing;
      }
      // A cached connector cannot recover after its transport closes or the
      // protocol faults. Fully release that exact connector before constructing
      // a fresh one. The identity-checked release lets automatic recovery and
      // an explicit selector join the same cleanup safely.
      await this.releaseRouteInternal(threadId);
      return await this.ensureRoute(
        threadId,
        queueInitialObservation,
        allowPendingEndpointAttestation,
      );
    }
    const pending = this.routeCreations.get(threadId);
    if (pending !== undefined) return await pending;
    if (this.routes.size + this.routeCreations.size >= this.maxRoutes) {
      throw new BridgeError(
        "CODEX_ROUTE_CAPACITY",
        "The bounded local Codex route table is full.",
        true,
      );
    }
    const admittedFactory = this.factory;
    const creation = (async () => {
      const route = await this.createRoute(
        threadId,
        admittedFactory,
        queueInitialObservation,
      );
      if (this.closing || this.closed) {
        await this.closeRoute(route);
        throw new BridgeError(
          "CODEX_PROVIDER_UNAVAILABLE",
          "The local Codex provider closed during route creation.",
        );
      }
      if (
        !allowPendingEndpointAttestation &&
        (this.endpointUnavailable ||
          this.endpointRefresh !== undefined ||
          admittedFactory !== this.factory ||
          route.endpointGeneration !== this.factory.endpointGeneration)
      ) {
        await this.closeRoute(route);
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_PENDING",
          "The Codex endpoint moved during exact route creation.",
          true,
        );
      }
      this.routes.set(threadId, route);
      return route;
    })();
    this.routeCreations.set(threadId, creation);
    try {
      return await creation;
    } finally {
      this.routeCreations.delete(threadId);
    }
  }

  private async createRoute(
    threadId: string,
    factory: LocalCodexTransportFactory,
    queueInitialObservation: boolean,
  ): Promise<CodexRoute> {
    let transport: LocalCodexOwnedTransport | undefined;
    let connector: CodexAppServerConnector | undefined;
    const generation = Symbol(threadId);
    try {
      transport = await factory.connectTransport();
      const writesEnabled =
        factory.writableReady && factory.writeCompatibility !== null;
      connector = await CodexAppServerConnector.connect({
        compatibility:
          factory.writeCompatibility ?? factory.schemaCompatibility,
        writesEnabled,
        route: {
          endpointGeneration: factory.endpointGeneration,
          threadId,
        },
        transport,
        maxReplyBytes: this.maxReplyBytes,
        now: this.now,
        onEvent: (event) =>
          this.onConnectorEvent(threadId, generation, event),
        onTurnResult: (result) =>
          this.onTurnResult(factory.endpointGeneration, result),
      });
      const loaded = await connector.observeLoadedThread(connector.guard());
      if (!loaded.selectedThreadLoaded) {
        throw new BridgeError(
          "CODEX_THREAD_NOT_OBSERVED",
          "The exact opted-in Codex task is not loaded on this endpoint.",
        );
      }
      await connector.resumeThread(connector.guard());
      const route = {
        connector,
        endpointGeneration: factory.endpointGeneration,
        generation,
        threadId,
        transport,
      };
      if (queueInitialObservation) {
        this.queueRouteObservation(route, connector.observation());
      }
      return route;
    } catch (error) {
      if (connector !== undefined) {
        await connector.close().catch(() => undefined);
      } else if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
      if (this.isEndpointGenerationChanged(error)) throw error;
      if (error instanceof BridgeError) throw error;
      if (error instanceof CodexConnectorError) {
        throw new BridgeError(
          error.ambiguous
            ? "CODEX_ROUTE_SETUP_AMBIGUOUS"
            : "CODEX_ROUTE_SETUP_REJECTED",
          "The exact Codex task could not be safely observed and resumed.",
        );
      }
      throw new BridgeError(
        "CODEX_ROUTE_SETUP_REJECTED",
        "The exact Codex task could not be safely observed and resumed.",
      );
    }
  }

  private onConnectorEvent(
    threadId: string,
    generation: symbol,
    event: CodexConnectorEvent,
  ): void {
    const route = this.routes.get(threadId);
    if (route === undefined || route.generation !== generation) return;
    this.queueRouteObservation(route, event);
    if (
      event.kind === "protocol_fault" ||
      (event.kind === "connection_closed" &&
        event.details?.errorCode !== undefined) ||
      (event.kind === "route_status_changed" &&
        codexRouteState(event) === "stale")
    ) {
      this.routesRequiringRecovery.add(threadId);
      this.scheduleRouteRecovery(threadId);
    }
  }

  private scheduleRouteRecovery(threadId: string): void {
    if (
      this.closed ||
      this.closing ||
      !this.routesRequiringRecovery.has(threadId) ||
      this.routeRecoveryTimers.has(threadId) ||
      this.routeRecoveries.has(threadId)
    ) {
      return;
    }
    const attempt = this.routeRecoveryAttempts.get(threadId) ?? 0;
    const delay = Math.min(
      this.recoveryMaxMs,
      this.recoveryInitialMs * 2 ** Math.min(attempt, 16),
    );
    const timer = setTimeout(() => {
      if (this.routeRecoveryTimers.get(threadId) !== timer) return;
      this.routeRecoveryTimers.delete(threadId);
      const recovery = this.recoverRoute(threadId);
      this.routeRecoveries.set(threadId, recovery);
      void recovery.finally(() => {
        if (this.routeRecoveries.get(threadId) === recovery) {
          this.routeRecoveries.delete(threadId);
        }
        this.scheduleRouteRecovery(threadId);
      });
    }, delay);
    timer.unref();
    this.routeRecoveryTimers.set(threadId, timer);
  }

  private async recoverRoute(threadId: string): Promise<void> {
    if (
      this.closed ||
      this.closing ||
      !this.routesRequiringRecovery.has(threadId)
    ) {
      return;
    }
    try {
      if (this.endpointUnavailable) {
        if (this.pendingEndpointAttestation !== undefined) {
          throw new BridgeError(
            "CODEX_ENDPOINT_REFRESH_PENDING",
            "The replacement Codex endpoint is awaiting controller activation.",
            true,
          );
        }
        const refreshed = await this.refreshEndpoint("callback");
        if (
          refreshed?.event.outcome === "compatible" &&
          refreshed.event.routes.some(
            (route) => route.routeHandle === threadId,
          )
        ) {
          this.routesRequiringRecovery.delete(threadId);
          this.routeRecoveryAttempts.delete(threadId);
          return;
        }
        throw new BridgeError(
          "CODEX_ENDPOINT_REFRESH_PENDING",
          "The replacement Codex endpoint is not ready.",
          true,
        );
      }
      const current = this.routes.get(threadId);
      if (
        current !== undefined &&
        codexRouteState(current.connector.observation()) === "stale"
      ) {
        await this.releaseRouteInternal(threadId);
      }
      if (!this.routesRequiringRecovery.has(threadId)) return;
      const replacement = await this.ensureRoute(threadId);
      if (!this.routesRequiringRecovery.has(threadId)) {
        // An explicit selector can join this exact creation after cancelling
        // automatic recovery. In that case the replacement is now operator-
        // owned and must remain live. Explicit release waits for this recovery
        // promise before closing any late-created replacement.
        return;
      }
      this.routesRequiringRecovery.delete(threadId);
      this.routeRecoveryAttempts.delete(threadId);
      this.queueRouteObservation(
        replacement,
        replacement.connector.observation(),
      );
    } catch (error) {
      if (this.isEndpointGenerationChanged(error)) {
        this.endpointUnavailable = true;
        const refreshed = await this.refreshEndpoint("callback").catch(
          () => undefined,
        );
        if (
          refreshed?.event.outcome === "compatible" &&
          refreshed.event.routes.some(
            (route) => route.routeHandle === threadId,
          )
        ) {
          this.routesRequiringRecovery.delete(threadId);
          this.routeRecoveryAttempts.delete(threadId);
          return;
        }
      }
      this.routeRecoveryAttempts.set(
        threadId,
        (this.routeRecoveryAttempts.get(threadId) ?? 0) + 1,
      );
    }
  }

  private cancelRouteRecovery(threadId: string): void {
    this.routesRequiringRecovery.delete(threadId);
    this.routeRecoveryAttempts.delete(threadId);
    const timer = this.routeRecoveryTimers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.routeRecoveryTimers.delete(threadId);
  }

  private isEndpointGenerationChanged(error: unknown): boolean {
    return (
      error instanceof LocalCodexTransportError &&
      error.code === "ENDPOINT_GENERATION_CHANGED"
    );
  }

  private pendingEndpointActivationClaims(routeHandle: string): boolean {
    const event = this.pendingEndpointRefreshEvent;
    return (
      event !== undefined &&
      event.current.endpointGeneration === this.factory.endpointGeneration &&
      event.routes.some((route) => route.routeHandle === routeHandle)
    );
  }

  private async refreshEndpoint(
    delivery: "callback" | "selector",
  ): Promise<CodexEndpointRefreshResult | undefined> {
    if (this.refreshFactory === undefined || this.closing || this.closed) {
      return undefined;
    }
    const existing = this.endpointRefresh;
    if (existing !== undefined) {
      // A selector already running inside the controller lock takes ownership
      // of the transition result. This avoids waiting on a callback that needs
      // that same lock while still ensuring exactly one activation path.
      if (delivery === "selector") this.endpointRefreshDelivery = "selector";
      return await existing;
    }
    this.endpointRefreshDelivery = delivery;
    const refresh = this.performEndpointRefresh();
    this.endpointRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.endpointRefresh === refresh) {
        this.endpointRefresh = undefined;
        this.endpointRefreshDelivery = undefined;
      }
    }
  }

  private async performEndpointRefresh(): Promise<
    CodexEndpointRefreshResult | undefined
  > {
    const refreshFactory = this.refreshFactory;
    if (refreshFactory === undefined) return undefined;
    const previousFactory = this.factory;
    const previous = this.identity;
    let candidate: LocalCodexTransportFactory | undefined;
    try {
      const resolved = await this.resolveEndpointRefreshCandidate(
        refreshFactory,
        previousFactory,
        previous,
      );
      candidate = resolved.factory;
      const { attestation, identity: candidateIdentity } = resolved;
      await this.retireEndpointGeneration(
        previousFactory,
        previous.endpointGeneration,
      );
      if (attestation.tier === "incompatible") {
        await candidate.close();
        candidate = undefined;
        this.compatibilityAttested = false;
        this.pendingEndpointAttestation = undefined;
        this.pendingEndpointRefreshEvent = undefined;
        for (const routeHandle of this.trackedRoutes) {
          this.routesRequiringRecovery.add(routeHandle);
        }
        if (this.closing || this.closed) return undefined;
        const result: CodexEndpointRefreshResult = {
          event: {
            outcome: "incompatible",
            previous,
            candidate: candidateIdentity,
            attestation,
          },
          delivery: "callback",
          selectorClaimed: true,
        };
        this.emitEndpointRefresh(result.event);
        for (const routeHandle of this.routesRequiringRecovery) {
          if (this.trackedRoutes.has(routeHandle)) {
            this.scheduleRouteRecovery(routeHandle);
          }
        }
        return result;
      }
      if (this.closing || this.closed) {
        await candidate.close();
        candidate = undefined;
        return undefined;
      }

      this.factory = candidate;
      candidate = undefined;
      this.retiredEndpointGeneration = undefined;
      this.compatibilityAttested = false;
      this.endpointUnavailable = true;
      this.pendingEndpointAttestation = attestation;
      const refreshedRoutes: Array<{
        routeHandle: string;
        state: GatewayAdapterRouteState;
      }> = [];
      for (const routeHandle of [...this.trackedRoutes]) {
        if (this.closing || this.closed) break;
        try {
          const route = await this.createRoute(
            routeHandle,
            this.factory,
            false,
          );
          if (this.closing || this.closed) {
            await this.closeRoute(route);
            break;
          }
          const state = codexRouteState(route.connector.observation());
          if (state === "stale") {
            await this.closeRoute(route);
            throw new BridgeError(
              "CODEX_ROUTE_SETUP_REJECTED",
              "The exact Codex task was stale on the replacement endpoint.",
            );
          }
          this.routes.set(routeHandle, route);
          this.routesRequiringRecovery.delete(routeHandle);
          this.routeRecoveryAttempts.delete(routeHandle);
          refreshedRoutes.push({ routeHandle, state });
        } catch {
          this.routesRequiringRecovery.add(routeHandle);
        }
      }
      if (this.closing || this.closed) return undefined;
      const result: CodexEndpointRefreshResult = {
        event: {
          outcome: "compatible",
          previous,
          current: this.identity,
          attestation,
          routes: refreshedRoutes,
        },
        delivery: this.endpointRefreshDelivery ?? "callback",
        selectorClaimed: false,
      };
      if (result.event.outcome === "compatible") {
        this.pendingEndpointRefreshEvent = result.event;
      }
      if (result.delivery === "callback") {
        result.selectorClaimed = true;
        this.publishEndpointRefresh(result.event);
      }
      for (const routeHandle of this.routesRequiringRecovery) {
        if (this.trackedRoutes.has(routeHandle)) {
          this.scheduleRouteRecovery(routeHandle);
        }
      }
      return result;
    } catch (error) {
      if (candidate !== undefined && candidate !== previousFactory) {
        await candidate.close().catch(() => undefined);
      }
      throw error;
    } finally {
      if (this.callbackDrainFrozen) {
        this.callbackDrainFrozen = false;
        this.drainCallbackQueue();
      }
    }
  }

  private async resolveEndpointRefreshCandidate(
    refreshFactory: () => Promise<LocalCodexTransportFactory>,
    previousFactory: LocalCodexTransportFactory,
    previous: PrivateEndpointIdentity,
  ): Promise<Readonly<{
    factory: LocalCodexTransportFactory;
    identity: PrivateEndpointIdentity;
    attestation: CompatibilityAttestation;
  }>> {
    for (
      let attempt = 0;
      attempt < MAX_CODEX_ENDPOINT_REFRESH_CANDIDATES;
      attempt += 1
    ) {
      let candidate: LocalCodexTransportFactory | undefined;
      try {
        candidate = await refreshFactory();
        validateCodexFactory(candidate);
        if (
          candidate.hostId !== previous.hostId ||
          candidate.protocol !== previousFactory.protocol
        ) {
          throw new BridgeError(
            "CODEX_FACTORY_ATTESTATION_INVALID",
            "The replacement Codex factory moved outside its pinned boundary.",
          );
        }
        if (
          candidate === previousFactory ||
          candidate.endpointGeneration === previous.endpointGeneration
        ) {
          if (candidate !== previousFactory) await candidate.close();
          candidate = undefined;
          if (attempt + 1 < MAX_CODEX_ENDPOINT_REFRESH_CANDIDATES) {
            continue;
          }
          throw new BridgeError(
            "CODEX_ENDPOINT_GENERATION_CHURN",
            "The Codex endpoint did not stabilize within its bounded refresh window.",
            true,
          );
        }

        // Endpoint generations never inherit cached compatibility. Every
        // candidate independently proves all four read-only wire probes.
        const probes = await this.runCompatibilityProbesFor(candidate);
        const attestation = evaluateCompatibilityAttestation({
          surface: "codex",
          version: candidate.appServerVersion,
          checkedAt: this.now().toISOString(),
          certifiedVersions: certifiedCompatibilityVersions.codex,
          probes,
        });
        return {
          factory: candidate,
          identity: {
            provider: "codex",
            hostId: previous.hostId,
            endpointGeneration: candidate.endpointGeneration,
          },
          attestation,
        };
      } catch (error) {
        if (candidate !== undefined && candidate !== previousFactory) {
          await candidate.close();
        }
        if (this.isEndpointGenerationChanged(error)) {
          if (attempt + 1 < MAX_CODEX_ENDPOINT_REFRESH_CANDIDATES) {
            continue;
          }
          throw new BridgeError(
            "CODEX_ENDPOINT_GENERATION_CHURN",
            "The Codex endpoint did not stabilize within its bounded refresh window.",
            true,
          );
        }
        throw error;
      }
    }
    throw new BridgeError(
      "CODEX_ENDPOINT_GENERATION_CHURN",
      "The Codex endpoint did not stabilize within its bounded refresh window.",
      true,
    );
  }

  private async retireEndpointGeneration(
    factory: LocalCodexTransportFactory,
    endpointGeneration: string,
  ): Promise<void> {
    this.callbackDrainFrozen = true;
    this.drainCallbackQueue(true);
    // Fence every operation admitted on the previous immutable factory.
    // Ordinary route creation is blocked by endpointRefresh; joining these
    // exact promises ensures none can be inserted after the close sweep.
    await Promise.allSettled([...this.routeCreations.values()]);
    await Promise.allSettled([...this.routeReleases.values()]);
    this.drainCallbackQueue(true);
    for (const [routeHandle, route] of [...this.routes]) {
      if (route.endpointGeneration !== endpointGeneration) continue;
      await this.closeRoute(route);
      if (this.routes.get(routeHandle) === route) {
        this.routes.delete(routeHandle);
      }
    }
    this.drainCallbackQueue(true);
    await factory.close();
    this.drainCallbackQueue(true);
    this.retiredEndpointGeneration = endpointGeneration;
  }

  private reserveSelectorRefresh(result: CodexEndpointRefreshResult): boolean {
    if (result.delivery !== "selector" || result.selectorClaimed) {
      return false;
    }
    result.selectorClaimed = true;
    return true;
  }

  private emitSelectorRefreshFallback(
    result: CodexEndpointRefreshResult,
    staleRouteHandle?: string,
  ): void {
    if (result.delivery !== "selector" || !result.selectorClaimed) return;
    let event = result.event;
    if (
      staleRouteHandle !== undefined &&
      event.outcome === "compatible" &&
      event.routes.some((route) => route.routeHandle === staleRouteHandle)
    ) {
      event = {
        ...event,
        routes: event.routes.filter(
          (route) => route.routeHandle !== staleRouteHandle,
        ),
      };
      result.event = event;
      this.pendingEndpointRefreshEvent = event;
    }
    this.publishEndpointRefresh(event);
  }

  private publishEndpointRefresh(event: GatewayAdapterEndpointRefresh): void {
    this.emitEndpointRefresh(event);
    if (event.outcome === "compatible") {
      this.armEndpointActivationRetry(event);
    }
  }

  private armEndpointActivationRetry(
    event: GatewayAdapterEndpointRefresh,
  ): void {
    this.clearEndpointActivationRetry();
    this.endpointActivationRetry = { event, attempt: 0 };
    this.scheduleEndpointActivationRetry();
  }

  private scheduleEndpointActivationRetry(): void {
    const pending = this.endpointActivationRetry;
    if (
      pending === undefined ||
      this.closing ||
      this.closed ||
      pending.attempt >= 3 ||
      (pending.event.outcome === "compatible" &&
        this.pendingEndpointAttestation === undefined)
    ) {
      this.clearEndpointActivationRetry();
      return;
    }
    const delay = Math.max(
      DEFAULT_CODEX_RECOVERY_INITIAL_MS,
      Math.min(
        this.recoveryMaxMs,
        this.recoveryInitialMs * 2 ** pending.attempt,
      ),
    );
    const timer = setTimeout(() => {
      if (this.endpointActivationRetryTimer !== timer) return;
      this.endpointActivationRetryTimer = undefined;
      const current = this.endpointActivationRetry;
      if (current === undefined || current.event !== pending.event) return;
      if (
        current.event.outcome === "compatible" &&
        this.pendingEndpointAttestation === undefined
      ) {
        this.clearEndpointActivationRetry();
        return;
      }
      this.emitEndpointRefresh(current.event);
      if (
        this.endpointActivationRetry === undefined ||
        this.endpointActivationRetry.event !== current.event
      ) {
        return;
      }
      this.endpointActivationRetry = {
        event: current.event,
        attempt: current.attempt + 1,
      };
      this.scheduleEndpointActivationRetry();
    }, delay);
    timer.unref();
    this.endpointActivationRetryTimer = timer;
  }

  private clearEndpointActivationRetry(): void {
    if (this.endpointActivationRetryTimer !== undefined) {
      clearTimeout(this.endpointActivationRetryTimer);
    }
    this.endpointActivationRetryTimer = undefined;
    this.endpointActivationRetry = undefined;
  }

  private emitEndpointRefresh(event: GatewayAdapterEndpointRefresh): void {
    const callbacks = this.callbacks;
    if (callbacks?.onEndpointRefresh === undefined) return;
    invokeCallback(() => callbacks.onEndpointRefresh?.(event));
  }

  private onTurnResult(
    endpointGeneration: string,
    result: CodexTransientTurnResult,
  ): void {
    const wantsReply = this.expectsReply.get(result.messageId) === true;
    this.expectsReply.delete(result.messageId);
    let replyText: string | undefined;
    if (wantsReply && result.text !== null) {
      const bytes = Buffer.from(result.text, "utf8");
      if (bytes.length <= this.maxReplyBytes) {
        replyText = Buffer.from(bytes).toString("utf8");
      }
    }
    const state =
      result.outcome === "completed"
        ? "completed"
        : result.outcome === "interrupted"
          ? "cancelled"
          : result.outcome === "expired"
            ? "expired"
            : result.outcome === "failed"
              ? "failed"
              : "ambiguous";
    const safeErrorCode =
      result.outcome === "completed"
        ? result.replyCode === "REPLY_TOO_LARGE"
          ? "CODEX_REPLY_TOO_LARGE"
          : undefined
        : result.outcome === "expired"
          ? "MESSAGE_EXPIRED"
          : result.outcome === "interrupted"
            ? "CODEX_TURN_INTERRUPTED"
            : result.outcome === "failed"
              ? "CODEX_TURN_FAILED"
              : "CODEX_DELIVERY_AMBIGUOUS";
    this.enqueueCodexCallback({
      type: "delivery",
      endpointGeneration,
      value: {
        messageId: result.messageId,
        state,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
        ...(replyText === undefined ? {} : { replyText }),
      },
    });
  }

  private queueRouteObservation(
    route: CodexRoute,
    observation: CodexConnectorObservation,
  ): void {
    this.enqueueCodexCallback({
      type: "route",
      endpointGeneration: route.endpointGeneration,
      generation: route.generation,
      routeHandle: route.threadId,
      state: codexRouteState(observation),
      ...(codexRouteSafeCode(observation) === undefined
        ? {}
        : { safeErrorCode: codexRouteSafeCode(observation) as string }),
    });
  }

  private enqueueCodexCallback(event: CodexCallbackEvent): void {
    if (this.closed) return;
    if (this.callbackQueue.length >= this.maxCallbacks) {
      const routeIndex = this.callbackQueue.findIndex(
        (candidate) => candidate.type === "route",
      );
      if (routeIndex >= 0) {
        this.callbackQueue.splice(routeIndex, 1);
      } else {
        // The callback consumer is synchronous and itself queues safely. Drain
        // one exact terminal handoff before accepting another; never drop one.
        this.drainOneCallback();
      }
    }
    this.callbackQueue.push(event);
    if (this.callbackDrainFrozen) return;
    if (this.callbackScheduled) return;
    this.callbackScheduled = true;
    queueMicrotask(() => {
      this.callbackScheduled = false;
      this.drainCallbackQueue();
    });
  }

  private drainOneCallback(): void {
    const event = this.callbackQueue.shift();
    const callbacks = this.callbacks;
    if (event === undefined || callbacks === undefined) return;
    if (
      event.endpointGeneration !== this.factory.endpointGeneration ||
      this.retiredEndpointGeneration === event.endpointGeneration
    ) {
      return;
    }
    if (event.type === "delivery") {
      invokeCallback(() => callbacks.onDelivery(event.value));
    } else {
      if (
        this.routes.get(event.routeHandle)?.generation !== event.generation
      ) {
        return;
      }
      invokeCallback(() =>
        callbacks.onRouteState({
          endpoint: callbackEndpoint(
            {
              provider: "codex",
              hostId: this.identity.hostId,
              endpointGeneration: event.endpointGeneration,
            },
            event.routeHandle,
          ),
          state: event.state,
          ...(event.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: event.safeErrorCode }),
        }),
      );
    }
  }

  private drainCallbackQueue(force = false): void {
    if (this.callbackDrainFrozen && !force) return;
    while (this.callbackQueue.length > 0) this.drainOneCallback();
  }

  private async closeRoute(route: CodexRoute): Promise<void> {
    let observation = route.connector.observation();
    if (observation.connection === "ready") {
      try {
        route.connector.cancelQueuedMessages(route.connector.guard());
      } catch {
        throw new BridgeError(
          "CODEX_PROVIDER_CLEANUP_AMBIGUOUS",
          "The exact Codex queue could not be safely cancelled.",
        );
      }
      let guard = route.connector.guard();
      let externalTurnObserved = false;
      if (
        guard.activeTurnId !== null &&
        (guard.status === "active" || guard.status === "waiting_approval")
      ) {
        try {
          await route.connector.interruptOwnedTurn(guard);
        } catch (error) {
          if (
            error instanceof CodexConnectorError &&
            error.code === "TURN_NOT_OWNED"
          ) {
            // An approval request or turn notification can expose another
            // Desktop client's turn ID. The connector verifies ownership
            // before issuing RPC, so release must detach without waiting for
            // or attempting to control that external work.
            externalTurnObserved = true;
          } else {
            throw new BridgeError(
              "CODEX_PROVIDER_CLEANUP_AMBIGUOUS",
              "The exact bridge-owned Codex turn did not confirm interruption.",
            );
          }
        }
      }
      if (!externalTurnObserved) {
        guard = await this.waitForOwnedTurnToSettle(route.connector);
        observation = route.connector.observation();
        if (
          guard.activeTurnId !== null ||
          observation.hasActiveTurn ||
          observation.queueDepth !== 0
        ) {
          throw new BridgeError(
            "CODEX_PROVIDER_CLEANUP_AMBIGUOUS",
            "The exact bridge-owned Codex work did not reach a terminal state.",
          );
        }
        if (
          observation.routeStatus !== "active" &&
          observation.routeStatus !== "waiting_approval" &&
          observation.routeStatus !== "starting" &&
          observation.routeStatus !== "interrupting"
        ) {
          await route.connector
            .unsubscribeThread(route.connector.guard())
            .catch(() => undefined);
        }
      }
    }
    await route.connector.close();
    if (!route.transport.cleanupConfirmed) {
      await route.transport.close();
    }
    if (!route.transport.cleanupConfirmed) {
      throw new BridgeError(
        "CODEX_PROVIDER_CLEANUP_FAILED",
        "The exact owned Codex proxy did not confirm termination.",
      );
    }
  }

  private async waitForOwnedTurnToSettle(
    connector: CodexAppServerConnector,
  ): Promise<ReturnType<CodexAppServerConnector["guard"]>> {
    const deadline = Date.now() + this.cleanupTimeoutMs;
    while (true) {
      const guard = connector.guard();
      if (guard.activeTurnId === null) return guard;
      if (
        connector.observation().connection !== "ready" ||
        Date.now() >= deadline
      ) {
        throw new BridgeError(
          "CODEX_PROVIDER_CLEANUP_TIMEOUT",
          "The exact bridge-owned Codex turn did not confirm termination before the cleanup deadline.",
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.cleanupPollMs);
      });
    }
  }
}

export function createLocalCodexGatewayProvider(
  options: LocalCodexGatewayProviderOptions,
): LocalCodexGatewayProvider {
  return new LocalCodexGatewayProvider(options);
}
