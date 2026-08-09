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
import { isDashboardLocale, type DashboardLocale } from "./locale.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDelivery,
  GatewayAdapterDiscovery,
  GatewayAdapterDiscoverySnapshot,
  GatewayAdapterDispatchResult,
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

type ClaudePeerFactory = (
  runtime: AttestedClaudePeerRuntime,
  locale: DashboardLocale,
) => ClaudePeerAdapter;

export type LocalClaudeGatewayProviderOptions = {
  /** Exact result of attestClaudePeerRuntime; paths are never rediscovered. */
  runtime: AttestedClaudePeerRuntime;
  hostId?: "this-mac";
  /** Locale for bounded notices written into native Claude sessions. */
  locale?: DashboardLocale;
  discoveryPollMs?: number;
  maxPendingMessages?: number;
  now?: () => number;
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
  private readonly maxPending: number;
  private readonly discoveryPollMs: number;
  private readonly now: () => number;
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
      ((runtime, locale) =>
        new ClaudePeerAdapter({
          sessionsDir: runtime.sessionsDir,
          socketDir: runtime.socketDir,
          attestedClaudeCodeVersion: runtime.claudeCodeVersion,
          locale,
        })))(options.runtime, options.locale ?? "en");
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
    const active = this.requireActiveNativeCodexListener();
    if (active.registration?.alias !== alias) {
      throw new BridgeError(
        "CODEX_PEER_GENERATION_MISMATCH",
        "The requested Codex alias is not the active listener generation.",
      );
    }
    return active.generation;
  }

  async prepareNativeCodexPeerGeneration(input: {
    alias: string;
    cwd: string;
    generation: string;
  }): Promise<void> {
    this.assertReady();
    const active = this.requireActiveNativeCodexListener();
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

  observeNativeCodexSuccessionBarrier(
    generation: string,
  ): ClaudeNativeCodexSuccessionBarrier {
    this.assertReady();
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
    if (!this.observeNativeCodexSuccessionBarrier(current.generation).clean) {
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

  activatePreparedNativeCodexPeerGeneration(generation: string): void {
    this.assertReady();
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
    this.purgeNativeCodexPeerGenerationReplyCapabilities(current.generation);
    this.scheduleClaudeMonitor();
  }

  async cleanupPreparedNativeCodexPeerGeneration(
    generation: string,
  ): Promise<void> {
    this.assertReady();
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

  resumeNativeCodexPeerGeneration(generation: string): void {
    this.assertReady();
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
    await this.cleanupPreparedNativeCodexPeerGeneration(
      input.preparedGeneration,
    );
    this.resumeNativeCodexPeerGeneration(input.resumeGeneration);
  }

  async retireNativeCodexPeerGeneration(input: {
    retiredGeneration: string;
    protectedActiveGeneration: string;
  }): Promise<void> {
    this.assertReady();
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

  purgeNativeCodexPeerGenerationReplyCapabilities(
    generation: string,
  ): number {
    let purged = 0;
    for (const [routeHandle, route] of this.nativeInbound) {
      if (route.listenerGeneration !== generation) continue;
      this.nativeInbound.delete(routeHandle);
      purged += 1;
    }
    return purged;
  }

  async unadvertiseNativeCodexPeer(alias: string): Promise<void> {
    await this.serializeNativeCodexRegistration(async () => {
      const active = this.activeNativeCodexListener;
      if (active?.registration?.alias !== alias) return;
      await active.listener.unadvertise(active.registration.name);
      this.purgeNativeCodexPeerGenerationReplyCapabilities(active.generation);
      delete active.registration;
      active.registrationProvisional = false;
      active.provisionalIngressForwarded = false;
    });
  }

  async updateNativeCodexPeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    const active = this.activeNativeCodexListener;
    if (active?.registration?.alias !== alias) return;
    await active.listener.updateAdvertisedStatus(status);
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
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
    const owner = this.requireNativeInboundReceiptOwner(receiptHandle);
    await owner.listener.notifyInboundProgress(receiptHandle, progress);
  }

  async releaseNativeInboundReceipt(
    receiptHandle: string,
  ): Promise<boolean> {
    const owner = this.nativeInboundReceiptOwners.get(receiptHandle);
    if (owner === undefined) return false;
    this.nativeInboundReceiptOwners.delete(receiptHandle);
    return owner.listener.releaseInboundReceipt(receiptHandle);
  }

  async quiesceNativeInbound(): Promise<void> {
    if (this.closed) return;
    const active = this.activeNativeCodexListener;
    if (active === undefined) return;
    await active.listener.quiesceInbound();
    active.inboundQuiesced = true;
  }

  async dispatch(input: {
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }): Promise<GatewayAdapterDispatchResult> {
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
      try {
        await this.refreshClaudeDiscovery();
      } catch {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      const observedRoute = this.nativeInbound.get(input.binding.routeHandle);
      const current = this.discovered.get(input.binding.routeHandle);
      if (
        observedRoute === undefined ||
        observedRoute.listenerGeneration !== activeListener.generation ||
        current?.alias !== observedRoute.alias
      ) {
        this.nativeInbound.delete(input.binding.routeHandle);
        return { state: "failed", safeErrorCode: "CLAUDE_NATIVE_REPLY_STALE" };
      }
    } else if (this.selected.get(input.binding.routeHandle) === undefined) {
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

    this.providerIdByGatewayId.set(input.messageId, "");
    this.pendingTargetByGatewayId.set(
      input.messageId,
      input.binding.routeHandle,
    );
    if (input.authorization === "selected_route") {
      this.selectedDispatchEpoch.set(
        input.binding.routeHandle,
        (this.selectedDispatchEpoch.get(input.binding.routeHandle) ?? 0) + 1,
      );
      // Once a selected-route dispatch begins, keep the route conservatively
      // busy until a later registry refresh observes authoritative state.
      this.selectedObservationDirty.add(input.binding.routeHandle);
      this.emitClaudeRouteObservation(input.binding.routeHandle, "busy");
    }
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
        input.text,
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
      if (
        error instanceof BridgeError &&
        error.code === "CLAUDE_PEER_MESSAGE_EXPIRED"
      ) {
        return { state: "failed", safeErrorCode: "MESSAGE_EXPIRED" };
      }
      return { state: "failed", safeErrorCode: "CLAUDE_DISPATCH_REJECTED" };
    }
  }

  async releaseRoute(routeHandle: string): Promise<void> {
    this.selected.delete(routeHandle);
    this.selectedDispatchEpoch.delete(routeHandle);
    this.selectedObservationDirty.delete(routeHandle);
    this.selectedObservations.delete(routeHandle);
    this.discovered.delete(routeHandle);
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
      await this.peer.close();
    } finally {
      for (const pending of this.pendingByProviderId.values()) {
        clearTimeout(pending.timer);
      }
      this.pendingByProviderId.clear();
      this.providerIdByGatewayId.clear();
      this.pendingTargetByGatewayId.clear();
      this.selected.clear();
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
    for (const [routeHandle, route] of this.nativeInbound) {
      const current = this.discovered.get(routeHandle);
      if (current !== undefined) {
        // The stable session UUID owns native reply authority. A rename only
        // updates its current public coordinate.
        this.nativeInbound.set(routeHandle, {
          alias: current.alias,
          listenerGeneration: route.listenerGeneration,
        });
      } else if (!discovery.truncated) {
        this.nativeInbound.delete(routeHandle);
      }
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
        if (row.alias !== selectedAlias) {
          // A Claude rename changes only the live name index. The native
          // session UUID remains the selected logical route.
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
  generation: symbol;
  threadId: string;
  transport: LocalCodexOwnedTransport;
};

type CodexCallbackEvent =
  | { type: "delivery"; value: GatewayAdapterDelivery }
  | {
      type: "route";
      generation: symbol;
      routeHandle: string;
      state: GatewayAdapterRouteObservationState;
      safeErrorCode?: string;
    };

function validateCodexFactory(factory: LocalCodexTransportFactory): void {
  const schema = factory.schemaCompatibility;
  const write = factory.writeCompatibility;
  if (
    factory.hostId !== LOCAL_HOST ||
    factory.protocol !== "codex-app-server" ||
    factory.appServerVersion !== "0.147.0" ||
    factory.protocolVersion !== factory.appServerVersion ||
    !CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(
      factory.appServerVersion as "0.147.0",
    ) ||
    schema.appServerVersion !== factory.appServerVersion ||
    schema.endpointGeneration !== factory.endpointGeneration ||
    schema.protocol !== "app-server-v2-stable" ||
    (write !== null &&
      (write.appServerVersion !== schema.appServerVersion ||
        write.endpointGeneration !== schema.endpointGeneration ||
        write.protocol !== schema.protocol)) ||
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
  readonly identity: PrivateEndpointIdentity;
  readonly protocol: string;
  readonly protocolVersion: string;

  private readonly factory: LocalCodexTransportFactory;
  private readonly maxCallbacks: number;
  private readonly maxRoutes: number;
  private readonly maxReplyBytes: number;
  private readonly cleanupPollMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly recoveryInitialMs: number;
  private readonly recoveryMaxMs: number;
  private readonly now: () => Date;
  private readonly routes = new Map<string, CodexRoute>();
  private readonly routeCreations = new Map<string, Promise<CodexRoute>>();
  private readonly routeReleases = new Map<string, Promise<void>>();
  private readonly routeRecoveryAttempts = new Map<string, number>();
  private readonly routeRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly routeRecoveries = new Map<string, Promise<void>>();
  private readonly routesRequiringRecovery = new Set<string>();
  private readonly expectsReply = new Map<string, boolean>();
  private readonly callbackQueue: CodexCallbackEvent[] = [];
  private callbackScheduled = false;
  private callbacks: GatewayAdapterCallbacks | undefined;
  private initialized = false;
  private closing = false;
  private closed = false;

  constructor(options: LocalCodexGatewayProviderOptions) {
    validateCodexFactory(options.factory);
    this.factory = options.factory;
    this.identity = {
      provider: "codex",
      hostId: exactLocalHost(options.factory.hostId),
      endpointGeneration: options.factory.endpointGeneration,
    };
    this.protocol = options.factory.protocol;
    this.protocolVersion = options.factory.protocolVersion;
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
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }> {
    this.assertReady();
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
    this.cancelRouteRecovery(input.routeHandle);
    const route = await this.ensureRoute(input.routeHandle);
    const observation = route.connector.observation();
    const state = codexRouteState(observation);
    if (state === "stale") {
      await this.releaseRoute(input.routeHandle);
      throw new BridgeError(
        "CODEX_ROUTE_SETUP_REJECTED",
        "The exact Codex task connection closed during route selection.",
      );
    }
    this.queueRouteObservation(route, observation);
    return {
      routeHandle: input.routeHandle,
      state,
    };
  }

  observeRouteSuccessionBarrier(
    routeHandle: string,
  ): CodexRouteSuccessionBarrier {
    this.assertReady();
    const route = this.routes.get(routeHandle);
    const observation = route?.connector.observation();
    const routeCreationInFlight = this.routeCreations.has(routeHandle);
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

  async dispatch(input: {
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }): Promise<GatewayAdapterDispatchResult> {
    if (
      !this.initialized ||
      this.closing ||
      this.closed ||
      input.authorization !== "selected_route" ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      return { state: "failed", safeErrorCode: "CODEX_ROUTE_UNAVAILABLE" };
    }
    const route = this.routes.get(input.binding.routeHandle);
    if (
      route === undefined ||
      this.routeReleases.has(input.binding.routeHandle)
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
    this.expectsReply.set(input.messageId, input.expectsReply);
    try {
      await route.connector.submitMessage(guard, {
        deadlineAt: input.deadlineAt,
        messageId: input.messageId,
        text: input.text,
      });
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
    this.cancelRouteRecovery(routeHandle);
    const recovery = this.routeRecoveries.get(routeHandle);
    if (recovery !== undefined) await recovery;
    await this.releaseRouteInternal(routeHandle);
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
    const entries = [...this.routes.entries()];
    const routeResults = await Promise.allSettled(
      entries.map(async ([routeHandle]) => this.releaseRoute(routeHandle)),
    );
    await Promise.allSettled([
      ...this.routeRecoveries.values(),
      ...this.routeCreations.values(),
    ]);
    this.drainCallbackQueue();
    if (routeResults.some((result) => result.status === "rejected")) {
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
    this.expectsReply.clear();
    this.callbacks = undefined;
  }

  private assertReady(): void {
    if (!this.initialized || this.closing || this.closed) {
      throw new BridgeError(
        "CODEX_PROVIDER_UNAVAILABLE",
        "The local Codex provider is unavailable.",
        true,
      );
    }
  }

  private async ensureRoute(threadId: string): Promise<CodexRoute> {
    this.assertReady();
    const pendingRelease = this.routeReleases.get(threadId);
    if (pendingRelease !== undefined) {
      await pendingRelease;
      return await this.ensureRoute(threadId);
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
      return await this.ensureRoute(threadId);
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
    const creation = this.createRoute(threadId);
    this.routeCreations.set(threadId, creation);
    try {
      const route = await creation;
      if (this.closing || this.closed) {
        await this.closeRoute(route);
        throw new BridgeError(
          "CODEX_PROVIDER_UNAVAILABLE",
          "The local Codex provider closed during route creation.",
        );
      }
      this.routes.set(threadId, route);
      return route;
    } finally {
      this.routeCreations.delete(threadId);
    }
  }

  private async createRoute(threadId: string): Promise<CodexRoute> {
    let transport: LocalCodexOwnedTransport | undefined;
    let connector: CodexAppServerConnector | undefined;
    const generation = Symbol(threadId);
    try {
      transport = await this.factory.connectTransport();
      const writesEnabled =
        this.factory.writableReady &&
        this.factory.writeCompatibility !== null;
      connector = await CodexAppServerConnector.connect({
        compatibility:
          this.factory.writeCompatibility ??
          this.factory.schemaCompatibility,
        writesEnabled,
        route: {
          endpointGeneration: this.identity.endpointGeneration,
          threadId,
        },
        transport,
        maxReplyBytes: this.maxReplyBytes,
        now: this.now,
        onEvent: (event) =>
          this.onConnectorEvent(threadId, generation, event),
        onTurnResult: (result) => this.onTurnResult(result),
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
        generation,
        threadId,
        transport,
      };
      this.queueRouteObservation(route, connector.observation());
      return route;
    } catch (error) {
      if (connector !== undefined) {
        await connector.close().catch(() => undefined);
      } else if (transport !== undefined) {
        await transport.close().catch(() => undefined);
      }
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
    } catch {
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

  private onTurnResult(result: CodexTransientTurnResult): void {
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
          endpoint: callbackEndpoint(this.identity, event.routeHandle),
          state: event.state,
          ...(event.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: event.safeErrorCode }),
        }),
      );
    }
  }

  private drainCallbackQueue(): void {
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
