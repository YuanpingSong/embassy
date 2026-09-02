import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { BridgeError } from "../errors.js";
import type { GatewayConfig } from "./config.js";
import {
  createGatewayConversationId,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewayControlServer,
  type GatewayDecision,
  type GatewayDeliveryStatusResult,
  type GatewayReplyCaller,
  type GatewayRegisterPeerResult,
  type GatewaySendResult,
  type GatewaySnapshotObservation,
  type PairParams,
  type PeerPrincipalParams,
  type PeerReceiptParams,
  type RegisterPeerParams,
  type ReplyParams,
  type SelectClaudeParams,
  type UnregisterCodexParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendParams,
} from "./control.js";
import type { CodexDoctorResult } from "./codex-doctor.js";
import { spawnPeerClient, type PeerClient } from "./peer-client.js";
import type { LocalPeerMailboxProvider, PeerMailboxAwaitResult } from "./peer-mailbox.js";
import { peerEdgeRef, peerRouteRef, type PeerCatalogResult, type PeerHandoffParams } from "./peer-protocol.js";
import {
  PROGRESS_WATCH_DEFAULT_CAPACITY,
  PROGRESS_WATCH_DEFAULT_IDLE_MS,
  PROGRESS_WATCH_HARD_CAPACITY,
  commitProgressWatchNudge,
  createProgressWatch,
  deferProgressWatchNudge,
  inspectProgressWatchDue,
  recordProgressWatchActivity,
  type ProgressWatch,
} from "./progress-watch-machine.js";
import { GatewayStore } from "./store.js";
import {
  CONNECTOR_OBSERVATION_STALE_AFTER_MS,
  GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  gatewayPublicSnapshotLimits,
  gatewayRegistrationIngressPrefixes,
  parseDirection,
  projectGatewayPublicSnapshot,
  type GatewayMessageRecord,
  type GatewayActivityAction,
  type GatewayActivityKind,
  type GatewayPreparedWriteEvidence,
  type GatewayPrivateRouteInspection,
  type GatewayProvider,
  type GatewayPublicSnapshot,
  type LogicalRouteBinding,
  type PublicAvailablePeerSnapshot,
  type PublicCodexDoctorCondition,
  type PublicConnectorSnapshot,
  type PublicRegistryObservationSnapshot,
  type PublicProgressWatchEventSnapshot,
  type PublicProgressWatchSnapshot,
  type SafeGatewayAlert,
  type TerminalMessageSettlement,
} from "./types.js";

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PRIVATE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PEER_TOKEN = /^peer_[A-Za-z0-9_-]{32}$/;
const DISCOVERY_INTERVAL_MS = 30_000;
const CODEX_DOCTOR_INTERVAL_MS = 30_000;
const PEER_REFRESH_INTERVAL_MS = 30_000;
const CLEAN_RETRY_DELAY_MS = 500;
const MAX_CONVERSATIONS = 1_024;
const MAX_PENDING_CLAUDE_REPLIES = MAX_CONVERSATIONS;
const CLEAN_RETRY_CODES = new Set([
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
  "PEER_NOT_AWAITING",
]);

export type GatewayAdapterRouteState = "idle" | "busy" | "awaiting_approval";
export type GatewayAdapterRouteObservationState =
  | GatewayAdapterRouteState
  | "unobserved";

export type GatewayAdapterDiscovery = Readonly<{
  alias: string; routeHandle: string; kind: "interactive" | "bg"; state: GatewayAdapterRouteState;
}>;

export type GatewayAdapterRegistryObservation = Readonly<{
  entriesScanned: number; parseableRecords: number;
  rejected: readonly Readonly<{ safeErrorCode: string; count: number }>[];
}>;

export type GatewayAdapterDiscoverySnapshot = Readonly<{
  peers: readonly GatewayAdapterDiscovery[]; complete: boolean;
  registry?: GatewayAdapterRegistryObservation;
}>;

export type GatewayAdapterRouteObservation = Readonly<{
  route: LogicalRouteBinding; state: GatewayAdapterRouteObservationState; observedAt: string;
  safeErrorCode?: string;
}>;

export type GatewayAdapterNativeEndpoint = Readonly<{
  provider: GatewayProvider; hostId: string; routeHandle: string;
}>;

export type GatewayAdapterCallbacks = Readonly<{
  onRouteState: (event: GatewayAdapterRouteObservation) => void;
  onClaudeReply: (event: Readonly<{ endpoint: GatewayAdapterNativeEndpoint; text: string }>) => void;
  onClaudeMessage?: (event: Readonly<{
    endpoint: GatewayAdapterNativeEndpoint; sourceAlias: string; targetAlias: string; text: string;
    receiptHandle?: string;
  }>) => void;
  onProtocolNotice?: (event: Readonly<{ code: string }>) => void;
}>;

export type GatewayAdapterStart = Readonly<{
  health: "healthy" | "degraded"; safeErrorCode?: string;
  ownedRoute?: Readonly<{ alias: string; routeHandle: string; state: GatewayAdapterRouteState }>;
}>;

export type GatewayAdapterDispatchResult =
  | Readonly<{ state: "deferred"; safeErrorCode?: string }>
  | Readonly<{
      state: "delivered" | "unconfirmed" | "failed" | "ambiguous" | "expired" | "cancelled";
      safeErrorCode?: string; replyText?: string;
    }>;

export type GatewayAdapterDispatchInput = Readonly<{
  attemptId: string; sourceAlias: string; sourceProvider: GatewayProvider; targetAlias: string;
  conversationId: string; binding: LogicalRouteBinding;
  authorization: "selected_route" | "native_reply";
  messageId: string; text: string; expectsReply: boolean; deadlineAt: string;
  steer?: true; progressWatchActive?: true; queuedAhead?: number;
  authorizeWrite: (
    evidence: GatewayPreparedWriteEvidence & Readonly<{ attemptId: string }>,
  ) => Promise<boolean>;
  onAccepted: (evidence: Readonly<{ attemptId: string }>) => Promise<void>;
}>;

export interface GatewayProviderAdapter {
  readonly identity: Readonly<{ provider: GatewayProvider; hostId: string }>;
  readonly protocol: string;
  readonly protocolVersion: string;
  latestRegistryObservation?(): GatewayAdapterRegistryObservation | undefined;
  initialize(callbacks: GatewayAdapterCallbacks): Promise<GatewayAdapterStart>;
  observeLogicalRoute?(input: Readonly<{
    alias: string; routeHandle: string; registrationId: string;
  }>): void;
  forgetLogicalRoute?(registrationId: string): void;
  discoverClaudePeers?(): Promise<GatewayAdapterDiscoverySnapshot>;
  selectRoute?(input: Readonly<{ alias: string; routeHandle: string }>): Promise<{
    routeHandle: string;
    state: GatewayAdapterRouteState;
  }>;
  assertWorkspaceDisjoint?(routeHandle: string, stateRoot: string): Promise<void>;
  resolveReplyAddress?(address: string): Promise<{ routeHandle: string }>;
  advertiseNativeSourcePeer?(input: Readonly<{
    alias: string; sourceProvider: GatewayProvider; cwd: string;
  }>): Promise<void>;
  unadvertiseNativeSourcePeer?(alias: string): Promise<void>;
  updateNativeSourcePeerStatus?(
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
    progress: Readonly<{
      kind: "stall"; reason: "ROUTE_BUSY" | "ROUTE_UNAVAILABLE" | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    }>,
  ): Promise<void>;
  releaseNativeInboundReceipt?(receiptHandle: string): Promise<boolean>;
  dispatch(input: GatewayAdapterDispatchInput): Promise<GatewayAdapterDispatchResult>;
  releaseRoute?(routeHandle: string): Promise<void>;
  close(): Promise<void>;
}

type GatewayServiceTimer = ReturnType<typeof setTimeout>;
type GatewayServiceTimers = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => GatewayServiceTimer;
  clearTimeout: (timer: GatewayServiceTimer) => void;
}>;

export type GatewayServiceOptions = Readonly<{
  config: GatewayConfig; adapters?: readonly GatewayProviderAdapter[]; store?: GatewayStore;
  now?: () => Date;
  nativePeerCwd?: string; timers?: GatewayServiceTimers;
  codexDoctor?: () => Promise<CodexDoctorResult>;
  spawnPeer?: typeof spawnPeerClient;
}>;

type ConnectorRuntime = {
  adapter: GatewayProviderAdapter; health: "healthy" | "degraded";
  safeErrorCode?: string; observedAt?: string; registry?: PublicRegistryObservationSnapshot;
};

type Candidate = GatewayAdapterDiscovery & {
  adapter: GatewayProviderAdapter; observedAt: string;
};

type Conversation = {
  id: string; sourceAlias: string; targetAlias: string;
  sourceBinding?: LogicalRouteBinding; targetBinding?: LogicalRouteBinding;
  expectsReply: boolean; pair?: true;
  nativeTarget?: Readonly<{ alias: string; binding: LogicalRouteBinding }>;
  nextSequence: number;
};

type MessageContext = Readonly<{ conversationId: string; expectsReply: boolean }>;

type PendingClaudeReply = {
  messageId: string; conversationId: string; sourceAlias: string; targetAlias: string;
  sourceBinding: LogicalRouteBinding; targetBinding: LogicalRouteBinding; deadlineAt: string;
  state: "armed" | "delivered" | "retired";
  bufferedReply?: string;
};

type ActiveAttempt = { messageId: string; attemptId: string };

type NativeReceipt = {
  adapter: GatewayProviderAdapter; receiptHandle: string; targetAlias: string;
  enqueuedAt: number; heldWrite: Promise<void>; heldTimer?: GatewayServiceTimer;
  stallTimer?: GatewayServiceTimer; settled: boolean;
};

type RuntimeWatch = ProgressWatch & Readonly<{
  ownerRegistrationId: string;
  workerRegistrationId: string;
}>;

function registrationId(): string {
  return `reg_${randomBytes(18).toString("base64url")}`;
}

function aliasHost(alias: string): string {
  return alias.slice(alias.lastIndexOf("@") + 1);
}

function safeCode(value: string | undefined, fallback: string): string {
  return value !== undefined && SAFE_CODE.test(value) ? value : fallback;
}
class ConsentOwnerError extends BridgeError {
  constructor(readonly ownerHost: string) {
    super("CONSENT_OWNER_HOST_REQUIRED", `Run pair or unpair on the edge owner host ${ownerHost}.`);
  }
}

function decisionFor(error: unknown, peerPrincipal = false): Extract<GatewayDecision, { accepted: false }> {
  if (error instanceof ConsentOwnerError) return { accepted: false, code: "conflict", ownerHost: error.ownerHost };
  if (!(error instanceof BridgeError)) return { accepted: false, code: "rejected" };
  if (error.code.includes("NOT_FOUND") || error.code.includes("NOT_AVAILABLE")) {
    return { accepted: false, code: "not_found" };
  }
  if (error.code.includes("COLLISION") || error.code.includes("ALREADY") || error.code.includes("OWNER")) {
    return { accepted: false, code: "conflict" };
  }
  if (error.code.includes("BUSY") || error.code.includes("CAPACITY")) {
    return { accepted: false, code: "busy" };
  }
  if (error.code.includes("UNAVAILABLE") || error.code.includes("OFFLINE") || error.code.includes("UNOBSERVED")) {
    return { accepted: false, code: "unavailable" };
  }
  if ((peerPrincipal && error.code === "ROUTE_UNREGISTERED") || error.code.includes("MISMATCH") || error.code.includes("ADDRESS")) {
    return { accepted: false, code: "route_mismatch" };
  }
  return { accepted: false, code: "rejected" };
}

function sameBinding(left: LogicalRouteBinding, right: LogicalRouteBinding): boolean {
  return left.provider === right.provider && left.hostId === right.hostId &&
    left.routeHandle === right.routeHandle && left.registrationId === right.registrationId;
}

function connectorKey(identity: Readonly<{ provider: GatewayProvider; hostId: string }>): string {
  return `${identity.provider}\0${identity.hostId}`;
}

function publicRegistry(
  value: GatewayAdapterRegistryObservation,
  previouslyParseable: boolean,
): PublicRegistryObservationSnapshot {
  const counts = new Map<string, number>();
  for (const row of value.rejected)
    if (SAFE_CODE.test(row.safeErrorCode) && Number.isSafeInteger(row.count) && row.count > 0)
      counts.set(row.safeErrorCode, (counts.get(row.safeErrorCode) ?? 0) + row.count);
  const rejected = [...counts].map(([safeErrorCode, count]) => ({ safeErrorCode, count }))
    .sort((left, right) => left.safeErrorCode < right.safeErrorCode ? -1 :
      left.safeErrorCode > right.safeErrorCode ? 1 : 0);
  const retained = rejected.slice(0, gatewayPublicSnapshotLimits.registryRejectionCodes);
  return {
    entriesScanned: Math.max(0, value.entriesScanned),
    parseableRecords: Math.max(0, Math.min(value.entriesScanned, value.parseableRecords)),
    parseableRecordSeenSinceBoot: previouslyParseable || value.parseableRecords > 0,
    rejected: retained.map((row) => ({ ...row })),
    rejectedCodesOmitted: Math.max(0, rejected.length - retained.length),
  };
}

function conversationIdForSuffix(suffix: string | undefined): string {
  const fresh = createGatewayConversationId();
  return suffix === undefined ? fresh : `${fresh.slice(0, -8)}${suffix}`;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function peerCatalogAuthorityChanged(
  prior: PeerCatalogResult | undefined,
  current: PeerCatalogResult,
): boolean {
  const authority = (catalog: PeerCatalogResult) => JSON.stringify([
    catalog.routes.map(({ state: _state, queueDepth: _depth, lastSeenAt: _seen,
      safeErrorCode: _code, ...route }) => route).sort((a, b) => a.ref.localeCompare(b.ref)),
    [...catalog.consentEdges].sort((a, b) => a.ref.localeCompare(b.ref)),
  ]);
  return prior === undefined || authority(prior) !== authority(current);
}

function peerCatalogViewChanged(prior: PeerCatalogResult | undefined, current: PeerCatalogResult): boolean {
  const view = (catalog: PeerCatalogResult) => JSON.stringify([
    catalog.health,
    catalog.connectors.map(({ lastSeenAt: _seen, observationAgeMs: _age, ...row }) => row),
    catalog.routes.map(({ lastSeenAt: _seen, ...row }) => row).sort((a, b) => a.ref.localeCompare(b.ref)),
    [...catalog.consentEdges].sort((a, b) => a.ref.localeCompare(b.ref)),
    catalog.alerts.map(({ timestamp: _timestamp, ...row }) => row),
  ]);
  return prior === undefined || view(prior) !== view(current);
}

function peerHandle(uid: number, alias: string, token: string): string {
  return `peer:${createHash("sha256").update(`${uid}\0${alias}\0${token}`).digest("hex")}`;
}

export class GatewayService {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  private readonly adapters: readonly GatewayProviderAdapter[];
  private readonly now: () => Date;
  private readonly timers: GatewayServiceTimers;
  private readonly nativePeerCwd: string;
  private readonly codexDoctor: (() => Promise<CodexDoctorResult>) | undefined;
  private readonly spawnPeer: typeof spawnPeerClient;
  private readonly peerClients = new Map<string, PeerClient>();
  private readonly peerCatalogs = new Map<string, PeerCatalogResult>();
  private readonly peerCleanupAliases = new Set<string>();
  /** View-only freshness; never consulted by routing or write authorization. */
  private readonly peerRouteViews = new Map<string, GatewayAdapterRouteObservation>();
  private readonly connectors = new Map<string, ConnectorRuntime>();
  private readonly routeObservations = new Map<string, GatewayAdapterRouteObservation>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly collidingClaudeAliases = new Set<string>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messageContexts = new Map<string, MessageContext>();
  private readonly activeAttempts = new Map<string, ActiveAttempt>();
  private readonly reserveOperations = new Set<Promise<void>>();
  private readonly inboundOperations = new Set<Promise<void>>();
  private readonly peerRefreshOperations = new Set<Promise<void>>();
  private readonly pendingClaudeReplies = new Map<string, PendingClaudeReply[]>();
  private readonly nativeReceipts = new Map<string, NativeReceipt>();
  private readonly progressWatches = new Map<string, RuntimeWatch>();
  private readonly progressWatchEvents: PublicProgressWatchEventSnapshot[] = [];
  private readonly dispatchRunners = new Map<string, Promise<void>>();
  private readonly steerRunners = new Map<string, Promise<void>>();
  private readonly startingTargets = new Set<string>();
  private readonly runtimeAlerts: SafeGatewayAlert[] = [];
  private control: GatewayControlServer | undefined;
  private wakeTimer: GatewayServiceTimer | undefined;
  private nextDiscoveryAt = 0;
  private nextDoctorAt = 0;
  private nextPeerRefreshAt = 0;
  private codexDoctorResult: CodexDoctorResult | undefined;
  private revision = 0;
  private snapshotRevision = 0;
  private snapshotFingerprint: string | undefined;
  private running = false;
  private closing = false;
  private closeInFlight: Promise<void> | undefined;

  constructor(options: GatewayServiceOptions) {
    this.config = options.config;
    this.adapters = [...(options.adapters ?? [])];
    this.store = options.store ?? new GatewayStore(
      options.config,
      options.now === undefined ? {} : { now: options.now },
    );
    this.now = options.now ?? (() => new Date());
    this.nativePeerCwd = options.nativePeerCwd ?? process.cwd();
    this.codexDoctor = options.codexDoctor;
    this.spawnPeer = options.spawnPeer ?? spawnPeerClient;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running || this.closing) return;
    const assertActive = (): void => {
      if (signal?.aborted === true || this.closing) {
        throw new BridgeError("GATEWAY_START_CANCELLED", "Gateway startup was cancelled.", true);
      }
    };
    await this.store.initialize({ deferPersistence: true });
    try {
      assertActive();
      const seen = new Set<string>();
      for (const adapter of this.adapters) {
        const key = connectorKey(adapter.identity);
        if (seen.has(key) || !this.config.allowedHosts.includes(adapter.identity.hostId)) {
          throw new BridgeError(
            "GATEWAY_ADAPTER_NOT_ALLOWED",
            "A provider adapter is duplicated or outside the host allowlist.",
          );
        }
        seen.add(key);
        const started = await adapter.initialize(this.callbacksFor(adapter));
        assertActive();
        const observedAt = this.now().toISOString();
        const runtime: ConnectorRuntime = {
          adapter,
          health: started.health,
          observedAt,
          ...(started.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: safeCode(started.safeErrorCode, "ADAPTER_DEGRADED") }),
        };
        const registry = adapter.latestRegistryObservation?.();
        if (registry !== undefined) runtime.registry = publicRegistry(registry, false);
        this.connectors.set(key, runtime);
        if (started.ownedRoute !== undefined) {
          await this.installOwnedRoute(adapter, started.ownedRoute);
        }
      }
      await this.refreshClaudeDiscovery().catch(() => undefined);
      await this.refreshCodexDoctor().catch(() => undefined);
      const control = await startGatewayControlServer({
        stateDir: this.store.rootDir,
        socketPath: this.config.controlSocketPath,
        handlers: this.handlers(),
      });
      try {
        assertActive();
        await this.store.commitInitialization();
      } catch (error) {
        await control.close();
        throw error;
      }
      this.control = control;
      this.running = true;
      await this.observeLoadedRoutes();
      const now = this.now().getTime();
      this.nextDiscoveryAt = now + DISCOVERY_INTERVAL_MS;
      this.nextDoctorAt = now + CODEX_DOCTOR_INTERVAL_MS;
      this.nextPeerRefreshAt = this.config.peerNodes.length > 0 ? now : 0;
      for (const target of await this.store.inspectDispatchableTargets()) this.kick(target);
      this.scheduleWake();
      assertActive();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closeInFlight !== undefined) return await this.closeInFlight;
    this.closing = true;
    this.closeInFlight = this.closeOnce();
    return await this.closeInFlight;
  }

  private async closeOnce(): Promise<void> {
    this.running = false;
    if (this.wakeTimer !== undefined) {
      this.timers.clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    // The durable phase reducer wins before any provider cleanup I/O. Exact
    // reserved work requeues; armed and accepted work terminalize by phase.
    await Promise.all([...this.inboundOperations]);
    await Promise.all([...this.reserveOperations]);
    for (const attempt of [...this.activeAttempts.values()]) {
      const result = await this.store.settleAttemptForShutdown({
        messageId: attempt.messageId,
        attemptId: attempt.attemptId,
      });
      if (result.status === "settled") await this.finishSettlement(result.settlement);
      else if (result.status === "requeued") this.activeAttempts.delete(attempt.messageId);
    }
    // Native receipt capabilities are memory-only. Any exact message returned
    // to queued by the shutdown reducer must terminalize before its helper is
    // closed; ordinary queued mail without a live receipt remains restartable.
    for (const messageId of [...this.nativeReceipts.keys()]) {
      const result = await this.store.settleQueuedMessageForShutdown({ messageId });
      if (result.status === "settled") await this.finishSettlement(result.settlement);
    }
    const control = this.control;
    this.control = undefined;
    const failures: unknown[] = [];
    if (control !== undefined) await control.close().catch((error) => failures.push(error));
    for (const peer of this.peerClients.values()) peer.close();
    this.peerClients.clear();
    await Promise.all([...this.peerRefreshOperations]).catch((error) => failures.push(error));
    this.peerCatalogs.clear();
    this.peerRouteViews.clear();
    // Provider close aborts exact owned operations. It must never join a turn.
    await Promise.all(
      this.adapters.map(async (adapter) => {
        await adapter.close().catch((error) => failures.push(error));
      }),
    );
    this.activeAttempts.clear();
    this.dispatchRunners.clear();
    this.steerRunners.clear();
    await this.store.close().catch((error) => failures.push(error));
    if (failures.length > 0) {
      throw new BridgeError("GATEWAY_CLEANUP_FAILED", "Gateway cleanup could not be confirmed.");
    }
  }

  handlers(): GatewayControlHandlers {
    const decide = async (operation: () => Promise<void>, peerPrincipal = false): Promise<GatewayDecision> => {
      try {
        this.assertWritable();
        await operation();
        this.revision += 1;
        return { accepted: true, code: "ok" };
      } catch (error) {
        return decisionFor(error, peerPrincipal);
      }
    };
    return {
      health: () => ({ status: this.health(), revision: this.revision }),
      registerCodex: (params) => decide(async () => this.registerCodex(params)),
      registerPeer: async (params): Promise<GatewayRegisterPeerResult> => {
        try {
          this.assertWritable();
          const token = await this.registerPeer(params);
          this.revision += 1;
          return token === undefined ? { accepted: true, code: "ok" } : { accepted: true, code: "ok", token };
        } catch (error) { return decisionFor(error, true); }
      },
      unregisterPeer: (params) => decide(async () => this.unregisterPeer(params), true),
      awaitPeer: (params) => this.awaitPeer(params),
      peerReceipt: (params) => decide(async () => this.peerReceipt(params), true),
      unregisterCodex: (params) => decide(async () => this.unregisterCodex(params)),
      selectClaude: (params) => decide(async () => this.selectClaude(params)),
      unselectClaude: (params) => decide(async () => this.unselectClaude(params)),
      pair: (params) => decide(async () => this.pair(params)),
      unpair: (params) => decide(async () => this.unpair(params)),
      listSnapshot: () => this.snapshot(),
      observeSnapshot: () => this.observeSnapshot(),
      deliveryStatus: (params) => this.deliveryStatus(params.token),
      untrack: (params) => decide(async () => this.untrack(params.conversationId)),
      send: (params) => this.send(params),
      reply: (params) => this.reply(params),
      refreshDiscovery: async () => {
        if (this.closing) {
          return { accepted: false, code: "unavailable", revision: this.revision };
        }
        try {
          // An operator-triggered rescan reports its own failure. It must never
          // journal `discovery_refreshed` for a scan that did not complete, and
          // must never answer `accepted: true` for a provider that is down.
          await this.refreshClaudeDiscovery();
          await this.recordActivity("discovery", "discovery_refreshed", [], true);
        } catch (error) {
          return { accepted: false, code: decisionFor(error).code, revision: this.revision };
        }
        return { accepted: true, code: "ok", revision: this.revision };
      },
      peerCatalog: ({ peerHost }) => this.buildPeerCatalog(peerHost),
      peerHandoff: ({ peerHost, handoff }) => this.receivePeerHandoff(peerHost, handoff),
    };
  }

  private async buildPeerCatalog(peerHost: string): Promise<PeerCatalogResult> {
    const localHost = this.config.hostId;
    if (!this.config.peerNodes.includes(peerHost))
      throw new BridgeError("PEER_NOT_CONFIGURED", "The requested peer host is not configured.");
    const [snapshot, privateRoutes, privateEdges] = await Promise.all([
      this.snapshot(), this.store.inspectPrivateRoutes(), this.store.inspectPrivateConsentEdges(),
    ]);
    const localRoutes = privateRoutes.filter((route) => route.registrationMode !== "federated_peer" && route.binding.hostId === localHost);
    const publicRoutes = new Map(snapshot.routes.map((route) => [route.alias, route]));
    const routeByAlias = new Map(privateRoutes.map((route) => [route.alias, route]));
    const routes = localRoutes.map((route) => { const row = publicRoutes.get(route.alias)!; return {
      ref: peerRouteRef(localHost, route.binding.registrationId), alias: route.alias, provider: route.binding.provider, host: localHost,
      enabled: route.enabled, state: row?.state ?? (route.enabled ? "stale" as const : "disabled" as const),
      queueDepth: row?.queueDepth ?? 0, ...(row?.lastSeenAt === undefined ? {} : { lastSeenAt: row.lastSeenAt }),
      ...(row?.safeErrorCode === undefined ? {} : { safeErrorCode: row.safeErrorCode }),
    }; });
    const consentEdges = privateEdges.flatMap((edge) => {
      if (edge.endpoints.map((endpoint) => aliasHost(endpoint.alias)).sort()[0] !== localHost) return [];
      const rows = edge.endpoints.map((endpoint) => routeByAlias.get(endpoint.alias)) as
        [GatewayPrivateRouteInspection | undefined, GatewayPrivateRouteInspection | undefined];
      if (rows[0] === undefined || rows[1] === undefined ||
        !rows.some((route) => route?.binding.hostId === peerHost) ||
        !rows.some((route) => route?.binding.hostId === localHost)) return [];
      const endpoint = (route: GatewayPrivateRouteInspection) => ({ alias: route.alias, provider: route.binding.provider,
        host: route.binding.hostId, routeRef: route.registrationMode === "federated_peer"
          ? route.binding.routeHandle : peerRouteRef(localHost, route.binding.registrationId) });
      const endpoints: Parameters<typeof peerEdgeRef>[0] = [endpoint(rows[0]), endpoint(rows[1])];
      return [{ ref: peerEdgeRef(endpoints), ownerHost: localHost, endpoints }];
    });
    return { revision: this.revision, complete: true, truncated: false, generatedAt: snapshot.generatedAt,
      health: snapshot.health, connectors: snapshot.connectors.filter((row) => row.host === localHost).map((row) => ({
        provider: row.provider, host: row.host, health: row.health, protocol: row.protocol, protocolVersion: row.protocolVersion,
        ...(row.lastSeenAt === undefined ? {} : { lastSeenAt: row.lastSeenAt }),
        ...(row.observationAgeMs === undefined ? {} : { observationAgeMs: row.observationAgeMs }),
        ...(row.safeErrorCode === undefined ? {} : { safeErrorCode: row.safeErrorCode }),
      })), routes, consentEdges, alerts: snapshot.alerts.filter((alert) =>
        (alert.host === undefined || alert.host === localHost) && (alert.alias === undefined || aliasHost(alert.alias) === localHost)), };
  }

  private async receivePeerHandoff(peerHost: string, handoff: PeerHandoffParams): Promise<Readonly<{ accepted: true }>> {
    if (!this.config.peerNodes.includes(peerHost))
      throw new BridgeError("PEER_NOT_CONFIGURED", "The sending peer host is not configured.");
    const enqueued = await this.store.enqueuePeerHandoff(peerHost, handoff);
    if (enqueued.messageId !== undefined) {
      const source = await this.store.inspectPrivateRoute(handoff.source.alias);
      const target = await this.store.inspectPrivateRoute(handoff.target.alias);
      if (source === undefined || target === undefined) throw new BridgeError("ROUTE_UNREGISTERED", "The committed peer handoff endpoint is no longer current.");
      const conversationId = conversationIdForSuffix(handoff.conversationCorrelation);
      this.rememberConversation({ id: conversationId, sourceAlias: source.alias, targetAlias: target.alias,
        sourceBinding: source.binding, targetBinding: target.binding, expectsReply: handoff.expectsReply,
        pair: true, nextSequence: 1 });
      this.messageContexts.set(enqueued.messageId, { conversationId, expectsReply: handoff.expectsReply });
      this.kick(target.alias, target.binding.registrationId);
    }
    this.revision += 1;
    return { accepted: true };
  }

  async snapshot(): Promise<GatewayPublicSnapshot> {
    const base = await this.store.publicSnapshot();
    const now = this.now();
    const routes = base.routes.map((route) => {
      const peer = this.peerRouteViews.get(route.alias);
      if (peer !== undefined) {
        const age = now.getTime() - Date.parse(peer.observedAt);
        return { ...route, state: peer.state === "unobserved" || age > CONNECTOR_OBSERVATION_STALE_AFTER_MS ? "stale" as const : peer.state,
          lastSeenAt: peer.observedAt, ...(peer.safeErrorCode === undefined ? {} : { safeErrorCode: peer.safeErrorCode }) };
      }
      const persisted = this.routeObservations.get(route.alias);
      if (persisted === undefined) return route;
      const current = this.routeObservationStillCurrent(persisted);
      if (!current) return route;
      const age = now.getTime() - Date.parse(persisted.observedAt);
      const state: "stale" | GatewayAdapterRouteState = persisted.state === "unobserved" ||
        age > CONNECTOR_OBSERVATION_STALE_AFTER_MS ? "stale" : persisted.state;
      return {
        ...route,
        state,
        lastSeenAt: persisted.observedAt,
        ...(persisted.safeErrorCode === undefined ? {} : { safeErrorCode: persisted.safeErrorCode }),
      };
    });
    const connectors = [...this.connectors.values()].map((runtime): PublicConnectorSnapshot => {
      const observedAt = runtime.observedAt;
      const age = observedAt === undefined ? undefined : Math.max(0, now.getTime() - Date.parse(observedAt));
      const stale = runtime.health === "healthy" &&
        (age === undefined || age > CONNECTOR_OBSERVATION_STALE_AFTER_MS);
      const doctor = runtime.adapter.identity.provider === "codex" ? this.codexDoctorResult : undefined;
      const doctorConditions: PublicCodexDoctorCondition[] = doctor === undefined
        ? [] : [...new Set(doctor.conditions)];
      if (doctor !== undefined && stale && !doctorConditions.includes("observation_stale"))
        doctorConditions.push("observation_stale");
      const managedLayoutMissing = doctorConditions.includes("managed_layout_missing");
      const connectorCode = stale ? "CONNECTOR_OBSERVATION_STALE" : runtime.safeErrorCode ??
        (managedLayoutMissing ? "MANAGED_CODEX_UNAVAILABLE" : undefined);
      return {
        provider: runtime.adapter.identity.provider,
        host: runtime.adapter.identity.hostId,
        health: stale || managedLayoutMissing ? "degraded" : runtime.health,
        protocol: runtime.adapter.protocol,
        protocolVersion: runtime.adapter.protocolVersion,
        ...(observedAt === undefined ? {} : { lastSeenAt: observedAt }),
        ...(age === undefined ? {} : { observationAgeMs: age }),
        ...(doctorConditions.length === 0 ? {} : {
          codexDoctor: { conditions: doctorConditions.slice(0, 2) },
        }),
        ...(runtime.registry === undefined ? {} : { registry: runtime.registry }),
        ...(connectorCode === undefined ? {} : { safeErrorCode: connectorCode }),
      };
    });
    const availablePeers = [...this.candidates.values()]
      .filter((candidate) => !this.collidingClaudeAliases.has(candidate.alias))
      .slice(0, gatewayPublicSnapshotLimits.availablePeers)
      .map((candidate): PublicAvailablePeerSnapshot => ({
        alias: candidate.alias,
        provider: "claude",
        host: candidate.adapter.identity.hostId,
        state: candidate.state,
        validated: true,
        selected: routes.some(
          (route) => route.provider === "claude" && route.alias === candidate.alias,
        ),
        lastSeenAt: candidate.observedAt,
      }));
    const progressWatches: PublicProgressWatchSnapshot[] = [...this.progressWatches.values()]
      .slice(0, gatewayPublicSnapshotLimits.progressWatches)
      .map((watch) => ({
        conversationIdSuffix: watch.conversationId.slice(-8),
        ownerAlias: watch.ownerAlias,
        workerAlias: watch.workerAlias,
        lastActivityAt: watch.lastActivityAt,
        nextActionAt: watch.nextActionAt,
        nudgeCount: watch.nudgeCount,
      }));
    const progressWatchEvents = this.progressWatchEvents.slice(
      -gatewayPublicSnapshotLimits.progressWatchEvents,
    );
    return projectGatewayPublicSnapshot(
      {
        ...base,
        generatedAt: now.toISOString(),
        health: connectors.some((connector) => connector.health === "degraded")
          ? "degraded"
          : connectors.length === 0
            ? "offline"
            : "healthy",
        connectors,
        availablePeers,
        routes,
        progressWatches,
        progressWatchEvents,
        alerts: [...base.alerts, ...this.runtimeAlerts].slice(
          -gatewayPublicSnapshotLimits.alerts,
        ),
        truncation: {
          ...base.truncation,
          progressWatches: Math.max(0, this.progressWatches.size - progressWatches.length),
          progressWatchEvents: Math.max(
            0,
            this.progressWatchEvents.length - progressWatchEvents.length,
          ),
        },
      },
      GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
    );
  }

  async observeSnapshot(): Promise<GatewaySnapshotObservation> {
    const snapshot = await this.snapshot();
    const fingerprint = JSON.stringify({ ...snapshot, generatedAt: "" });
    if (this.snapshotFingerprint !== undefined && fingerprint !== this.snapshotFingerprint) {
      this.snapshotRevision += 1;
    }
    this.snapshotFingerprint = fingerprint;
    return { snapshotRevision: this.snapshotRevision, snapshot };
  }

  private health(): "ok" | "degraded" {
    return this.connectors.size > 0 &&
      [...this.connectors.values()].every((runtime) => runtime.health === "healthy") ? "ok" : "degraded";
  }

  private async installOwnedRoute(adapter: GatewayProviderAdapter,
    owned: NonNullable<GatewayAdapterStart["ownedRoute"]>): Promise<void> {
    const prefix = gatewayRegistrationIngressPrefixes[adapter.identity.provider];
    if (
      !PUBLIC_ALIAS.test(owned.alias) ||
      !owned.alias.endsWith(`@${adapter.identity.hostId}`) ||
      (prefix !== undefined && !owned.alias.startsWith(prefix)) ||
      !PRIVATE_HANDLE.test(owned.routeHandle)
    ) {
      throw new BridgeError("GATEWAY_OWNED_ROUTE_INVALID", "The configured route identity is invalid.");
    }
    const existing = await this.store.inspectPrivateRoute(owned.alias);
    if (existing !== undefined) {
      if (
        existing.binding.provider !== adapter.identity.provider ||
        existing.binding.hostId !== adapter.identity.hostId ||
        existing.binding.routeHandle !== owned.routeHandle
      ) {
        throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "The configured route conflicts with durable state.");
      }
      return;
    }
    await this.store.registerRoute({
      alias: owned.alias,
      binding: { ...adapter.identity, routeHandle: owned.routeHandle, registrationId: registrationId() },
      registrationMode: "explicit_opt_in",
    });
  }

  private async observeLoadedRoutes(): Promise<void> {
    for (const route of await this.store.listLogicalRoutes()) {
      if (route.registrationMode === "federated_peer") this.peerRouteViews.set(route.alias, { route: route.binding,
        state: "unobserved", observedAt: this.now().toISOString(), safeErrorCode: "PEER_TUNNEL_UNAVAILABLE" });
      this.observeRoute(route);
      if (route.binding.provider !== "claude") {
        this.reconcileAdvertisement(route);
      }
    }
  }

  private observeRoute(route: GatewayPrivateRouteInspection): void {
    const adapter = this.adapterFor(route.binding);
    try {
      adapter?.observeLogicalRoute?.({
        alias: route.alias,
        routeHandle: route.binding.routeHandle,
        registrationId: route.binding.registrationId,
      });
    } catch {
      this.alert("ROUTE_OBSERVATION_FAILED", route);
    }
  }

  private forgetRoute(route: GatewayPrivateRouteInspection): void {
    try {
      this.adapterFor(route.binding)?.forgetLogicalRoute?.(route.binding.registrationId);
    } catch {
      this.alert("ROUTE_OBSERVATION_FAILED", route);
    }
    this.routeObservations.delete(route.alias);
  }

  private adapterFor(binding: Pick<LogicalRouteBinding, "provider" | "hostId">): GatewayProviderAdapter | undefined {
    return this.connectors.get(connectorKey(binding))?.adapter ??
      this.adapters.find(
        (adapter) => adapter.identity.provider === binding.provider && adapter.identity.hostId === binding.hostId,
      );
  }

  private claudeAdapter(hostId: string): GatewayProviderAdapter | undefined {
    return this.adapterFor({ provider: "claude", hostId });
  }

  private async advertise(route: GatewayPrivateRouteInspection): Promise<void> {
    const hostId = route.registrationMode === "federated_peer"
      ? this.config.hostId : route.binding.hostId;
    await this.claudeAdapter(hostId)?.advertiseNativeSourcePeer?.({
      alias: route.alias,
      sourceProvider: route.binding.provider,
      cwd: this.nativePeerCwd,
    });
  }

  private async unadvertise(route: GatewayPrivateRouteInspection): Promise<void> {
    const hostId = route.registrationMode === "federated_peer"
      ? this.config.hostId : route.binding.hostId;
    await this.claudeAdapter(hostId)?.unadvertiseNativeSourcePeer?.(route.alias);
  }

  private reconcileAdvertisement(route: GatewayPrivateRouteInspection): void {
    void this.advertise(route).catch((error) =>
      this.alert("NATIVE_ADVERTISEMENT_FAILED", route, error),
    );
  }

  private async reconcileUnadvertisement(route: GatewayPrivateRouteInspection): Promise<void> {
    await this.unadvertise(route).catch((error) =>
      this.alert("NATIVE_UNADVERTISEMENT_FAILED", route, error),
    );
  }

  private async removeOwnedRoute(
    route: GatewayPrivateRouteInspection,
    notFoundCode: "CODEX_REGISTRATION_NOT_FOUND" | "CLAUDE_ROUTE_NOT_FOUND",
    releaseProviderRoute: boolean,
  ): Promise<void> {
    this.assertWritable();
    const result = await this.store.removeOwnedRouteAtomic({
      alias: route.alias,
      binding: route.binding,
      activity: { operatorAction: true },
    });
    if (!result.removed) throw new BridgeError(notFoundCode, "The exact route is absent.");
    await this.finishSettlements(result.settlements);
    this.settleWatchesForAlias(route.alias, "endpoint_retired", "operator");
    this.forgetRoute(route);
    if (releaseProviderRoute) {
      await this.adapterFor(route.binding)?.releaseRoute?.(route.binding.routeHandle);
    } else {
      await this.reconcileUnadvertisement(route);
    }
  }

  private async recordActivity(
    kind: GatewayActivityKind,
    action: GatewayActivityAction,
    aliases: string[],
    operatorAction: boolean,
  ): Promise<void> {
    await this.store.recordActivity({
      kind,
      action,
      outcome: "accepted",
      aliases,
      operatorAction,
    });
  }

  private async registerCodex(params: ValidatedRegisterCodexParams): Promise<void> {
    const existing = await this.store.inspectPrivateRoute(params.alias);
    if (existing !== undefined && params.succeedsAlias === undefined) {
      if (existing.binding.provider !== "codex" || existing.binding.routeHandle !== params.threadId) {
        throw new BridgeError("ROUTE_ALIAS_ALREADY_REGISTERED", "The alias belongs to another registration.");
      }
      this.observeRoute(existing);
      this.reconcileAdvertisement(existing);
      return;
    }
    const replacement = {
      alias: params.alias,
      binding: {
        provider: "codex" as const,
        hostId: params.hostId,
        routeHandle: params.threadId,
        registrationId: registrationId(),
      },
      registrationMode: "explicit_opt_in" as const,
    };
    if (params.succeedsAlias === undefined) {
      this.assertWritable();
      await this.store.registerRoute(replacement);
      const installed = (await this.store.inspectPrivateRoute(params.alias))!;
      await this.recordActivity(
        "registration",
        "codex_registered",
        [installed.alias],
        true,
      );
      this.observeRoute(installed);
      this.reconcileAdvertisement(installed);
      this.kick(params.alias);
      return;
    }
    const previous = await this.store.inspectPrivateRoute(params.succeedsAlias);
    if (previous === undefined) {
      const installed = await this.store.inspectPrivateRoute(params.alias);
      if (
        installed !== undefined &&
        installed.binding.provider === "codex" &&
        installed.binding.routeHandle === params.threadId
      ) {
        this.observeRoute(installed);
        this.reconcileAdvertisement(installed);
        return;
      }
      throw new BridgeError("CODEX_SUCCESSION_OWNER_MISMATCH", "The succeeded registration is absent.");
    }
    this.assertWritable();
    const result = await this.store.replaceCodexRegistrationAtomic({
      oldAlias: params.succeedsAlias,
      expectedOldRegistrationId: previous.binding.registrationId,
      replacement,
      activity: { operatorAction: true },
    });
    await this.finishSettlements(result.settlements);
    this.settleWatchesForAlias(previous.alias, "endpoint_retired", "operator");
    if (!result.idempotent) {
      this.forgetRoute(previous);
      this.reconcileUnadvertisement(previous);
    }
    const installed = (await this.store.inspectPrivateRoute(params.alias))!;
    this.observeRoute(installed);
    this.reconcileAdvertisement(installed);
    this.kick(params.alias);
  }

  private async registerPeer(params: RegisterPeerParams): Promise<string | undefined> {
    if (this.peerCleanupAliases.has(params.alias)) {
      throw new BridgeError("ROUTE_BUSY", "The route is still completing cleanup.", true);
    }
    const existing = await this.store.inspectPrivateRoute(params.alias);
    if (existing !== undefined) {
      if (params.token === undefined) throw new BridgeError("ROUTE_UNREGISTERED", "The route binding does not match.");
      await this.assertPeer({ alias: params.alias, token: params.token });
      this.observeRoute(existing); this.reconcileAdvertisement(existing);
      this.kick(existing.alias, existing.binding.registrationId);
      return undefined;
    }
    if (params.token !== undefined || !params.alias.endsWith(`@${this.config.hostId}`)) {
      throw new BridgeError("ROUTE_UNREGISTERED", "The route binding does not match.");
    }
    const token = `peer_${randomBytes(24).toString("base64url")}`;
    await this.store.registerRoute({ alias: params.alias, binding: {
      provider: "peer", hostId: this.config.hostId,
      routeHandle: peerHandle(process.getuid!(), params.alias, token), registrationId: registrationId(),
    }, registrationMode: "explicit_opt_in" });
    const installed = (await this.store.inspectPrivateRoute(params.alias))!;
    this.observeRoute(installed); this.reconcileAdvertisement(installed);
    return token;
  }

  private async assertPeer(params: PeerPrincipalParams): Promise<GatewayPrivateRouteInspection> {
    const route = await this.store.inspectPrivateRoute(params.alias);
    const expected = Buffer.from(peerHandle(process.getuid!(), params.alias, params.token));
    const actualHandle = route?.binding.provider === "peer" && /^peer:[0-9a-f]{64}$/.test(route.binding.routeHandle)
      ? route.binding.routeHandle : `peer:${"0".repeat(64)}`;
    const matches = timingSafeEqual(Buffer.from(actualHandle), expected);
    if (!PEER_TOKEN.test(params.token) || route?.binding.provider !== "peer" || !matches) {
      throw new BridgeError("ROUTE_UNREGISTERED", "The route binding does not match.");
    }
    return route;
  }

  private async unregisterPeer(params: PeerPrincipalParams): Promise<void> {
    const route = await this.assertPeer(params);
    if (this.peerCleanupAliases.has(route.alias)) throw new BridgeError("ROUTE_BUSY", "The route is still completing cleanup.", true);
    this.peerCleanupAliases.add(route.alias);
    try {
      const result = await this.store.removeOwnedRouteAtomic({ alias: route.alias, binding: route.binding });
      if (!result.removed) throw new BridgeError("ROUTE_UNREGISTERED", "The route binding does not match.");
      await this.finishSettlements(result.settlements); this.settleWatchesForAlias(route.alias, "endpoint_retired", "operator");
      this.forgetRoute(route); await this.reconcileUnadvertisement(route);
    } finally { this.peerCleanupAliases.delete(route.alias); }
  }

  private async awaitPeer(params: PeerPrincipalParams): Promise<PeerMailboxAwaitResult> {
    this.assertWritable();
    const route = await this.assertPeer(params);
    const adapter = this.adapterFor(route.binding) as LocalPeerMailboxProvider | undefined;
    if (adapter?.awaitMessage === undefined) throw new BridgeError("PROVIDER_UNAVAILABLE", "The provider is unavailable.", true);
    const pending = adapter.awaitMessage({ alias: route.alias, ...route.binding });
    this.kick(route.alias, route.binding.registrationId);
    return await pending;
  }

  private async peerReceipt(params: PeerReceiptParams): Promise<void> {
    const route = await this.assertPeer(params);
    const adapter = this.adapterFor(route.binding) as LocalPeerMailboxProvider | undefined;
    if (adapter?.acknowledgeReceipt({ alias: route.alias, ...route.binding, receipt: params.receipt }) === "rejected") {
      throw new BridgeError("ROUTE_UNREGISTERED", "The route binding does not match.");
    }
  }

  private async unregisterCodex(params: UnregisterCodexParams): Promise<void> {
    const route = await this.store.inspectPrivateRoute(params.alias);
    if (
      route === undefined ||
      route.binding.provider !== "codex" ||
      route.binding.routeHandle !== params.threadId
    ) {
      throw new BridgeError("CODEX_REGISTRATION_NOT_FOUND", "The exact Codex registration is absent.");
    }
    await this.removeOwnedRoute(route, "CODEX_REGISTRATION_NOT_FOUND", false);
  }

  private async selectClaude(params: SelectClaudeParams): Promise<void> {
    const selected = await this.resolveClaudeSelector(params.alias, true);
    if (selected === undefined) {
      throw new BridgeError("CLAUDE_ROUTE_NOT_FOUND", "The Claude session is not currently selectable.");
    }
    const adapter = selected.adapter;
    if (adapter.selectRoute === undefined) {
      throw new BridgeError("CLAUDE_PROVIDER_UNAVAILABLE", "The Claude provider cannot select routes.");
    }
    await adapter.assertWorkspaceDisjoint?.(selected.routeHandle, this.store.rootDir);
    const chosen = await adapter.selectRoute({ alias: selected.alias, routeHandle: selected.routeHandle });
    this.assertWritable();
    const before = (await this.store.listLogicalRoutes()).filter(
      (route) => route.binding.provider === "claude",
    );
    const existing = before.find(
      (route) =>
        route.binding.provider === "claude" &&
        route.binding.hostId === adapter.identity.hostId &&
        route.binding.routeHandle === chosen.routeHandle,
    );
    const result = await this.store.replaceClaudeSelection({
      alias: selected.alias,
      binding: {
        provider: "claude",
        hostId: adapter.identity.hostId,
        routeHandle: chosen.routeHandle,
        registrationId: existing?.binding.registrationId ?? registrationId(),
      },
      registrationMode: "selected_live_peer",
    });
    await this.finishSettlements(result.settlements);
    const after = (await this.store.listLogicalRoutes()).filter(
      (route) => route.binding.provider === "claude",
    );
    for (const prior of before) {
      const retained = after.find((route) => route.alias === prior.alias);
      if (retained === undefined || !sameBinding(retained.binding, prior.binding)) {
        this.settleWatchesForAlias(prior.alias, "endpoint_retired", "operator");
        this.forgetRoute(prior);
        void this.adapterFor(prior.binding)?.releaseRoute?.(prior.binding.routeHandle)
          .catch((error) => this.alert("ROUTE_RELEASE_FAILED", prior, error));
      }
    }
    const installed = (await this.store.inspectPrivateRoute(selected.alias))!;
    this.observeRoute(installed);
    this.routeObservations.set(selected.alias, {
      route: installed.binding,
      state: chosen.state,
      observedAt: this.now().toISOString(),
    });
    await this.recordActivity("selection", "claude_selected", [selected.alias], true);
    this.kick(selected.alias);
  }

  private async unselectClaude(params: SelectClaudeParams): Promise<void> {
    const route = await this.resolveSelectedClaudeRoute(params.alias);
    if (route === undefined || route.registrationMode === "federated_peer") throw new BridgeError("CLAUDE_ROUTE_NOT_FOUND", "The selected Claude route is absent.");
    await this.removeOwnedRoute(route, "CLAUDE_ROUTE_NOT_FOUND", true);
  }

  private async pair(params: PairParams): Promise<void> {
    const endpoints = await this.resolvePairEndpoints(params, true);
    const aliases = endpoints.aliases;
    const ownerHost = aliases.map(aliasHost).sort()[0]!;
    if (this.config.hostId !== ownerHost) throw new ConsentOwnerError(ownerHost);
    this.assertWritable();
    const existed = await this.store.hasConsentEdge(endpoints);
    await this.store.addConsentEdge(endpoints);
    if (!existed) await this.recordActivity("pairing", "routes_paired", [...aliases], true);
  }

  private async unpair(params: PairParams): Promise<void> {
    const endpoints = await this.resolvePairEndpoints(params, false);
    const aliases = endpoints.aliases;
    const ownerHost = aliases.map(aliasHost).sort()[0]!;
    if (this.config.hostId !== ownerHost) throw new ConsentOwnerError(ownerHost);
    this.assertWritable();
    const existed = await this.store.hasConsentEdge(endpoints);
    const result = await this.store.removeConsentEdge(endpoints);
    await this.finishSettlements(result.settlements);
    for (const alias of aliases) this.settleWatchesForAlias(alias, "pair_removed", "operator");
    if (existed) await this.recordActivity("pairing", "routes_unpaired", [...aliases], true);
    for (const alias of aliases) this.kick(alias);
  }

  private async resolvePairEndpoints(
    params: PairParams,
    maySelect: boolean,
  ): Promise<Readonly<{
    aliases: readonly [string, string];
    expectedRegistrationIds: readonly [string, string];
  }>> {
    const raw = params.aliases;
    const aliases: [string, string] = [raw[0], raw[1]];
    if (maySelect && aliases.some((alias) => PUBLIC_ALIAS.test(alias)))
      await this.refreshClaudeDiscovery().catch(() => undefined);
    for (let index = 0; index < aliases.length; index += 1) {
      if (maySelect && this.collidingClaudeAliases.has(aliases[index]!))
        throw new BridgeError("PEER_ALIAS_COLLISION", "The Claude alias is ambiguous.");
      if (PUBLIC_ALIAS.test(aliases[index]!)) continue;
      const selected = await this.resolveClaudeSelector(aliases[index]!, maySelect);
      if (selected === undefined) throw new BridgeError("CLAUDE_ROUTE_NOT_FOUND", "The Claude selector is unavailable.");
      if (maySelect) await this.selectClaude({ alias: aliases[index]! });
      aliases[index] = selected.alias;
    }
    const left = await this.store.inspectPrivateRoute(aliases[0]);
    const right = await this.store.inspectPrivateRoute(aliases[1]);
    if (left === undefined || right === undefined) {
      throw new BridgeError("ROUTE_NOT_AVAILABLE", "The pair endpoint is absent.");
    }
    return {
      aliases,
      expectedRegistrationIds: [
        left.binding.registrationId,
        right.binding.registrationId,
      ],
    };
  }

  private async assertThread(alias: string, threadId: string): Promise<GatewayPrivateRouteInspection> {
    const route = await this.store.inspectPrivateRoute(alias);
    if (route?.binding.provider !== "codex" || route.binding.routeHandle !== threadId) {
      throw new BridgeError("CODEX_THREAD_MISMATCH", "The task attestation does not match the route.");
    }
    return route;
  }

  private async send(params: ValidatedSendParams): Promise<GatewaySendResult> {
    const source = await this.store.inspectPrivateRoute(params.fromAlias);
    const directTarget = await this.store.inspectPrivateRoute(params.toAlias);
    const target = directTarget ?? await this.resolveSelectedClaudeRoute(params.toAlias);
    if (source?.binding.provider === "codex" && (target?.binding.provider === "claude" || target?.binding.provider === "peer") && "threadId" in params) {
      return this.sendToClaude(params);
    }
    if (source?.binding.provider === "claude" && (target?.binding.provider === "codex" || target?.binding.provider === "peer") && "replyAddress" in params) {
      return this.sendToCodex(params);
    }
    if (source?.binding.provider === "peer" && "peerToken" in params) {
      return target?.binding.provider === "claude" ? this.sendToClaude(params) : this.sendToCodex(params);
    }
    return { accepted: false, code: "route_mismatch" };
  }

  private async sendToClaude(params: ValidatedSendParams): Promise<GatewaySendResult> {
    try {
      this.assertWritable();
      const source = "peerToken" in params && params.peerToken !== undefined
        ? await this.assertPeer({ alias: params.fromAlias, token: params.peerToken })
        : params.threadId === undefined
          ? undefined
          : await this.assertThread(params.fromAlias, params.threadId);
      if (source === undefined) throw new BridgeError("ROUTE_NOT_AVAILABLE", "The source route is absent.");
      const direct = await this.store.inspectPrivateRoute(params.toAlias);
      const target = direct?.binding.provider === "peer" ? direct : await this.resolveSelectedClaudeRoute(params.toAlias);
      if (target === undefined) throw new BridgeError("CLAUDE_ROUTE_NOT_FOUND", "The selected Claude route is absent.");
      return await this.enqueueConversation({
        sourceAlias: params.fromAlias,
        targetAlias: target.alias,
        text: params.text,
        expectsReply: params.expectsReply,
        expectedSourceBinding: source.binding,
        expectedTargetBinding: target.binding,
        ...(params.trackIdleMinutes === undefined
          ? {}
          : { trackIdleMinutes: params.trackIdleMinutes }),
      });
    } catch (error) {
      return decisionFor(error, "peerToken" in params);
    }
  }

  private async sendToCodex(params: ValidatedSendParams): Promise<GatewaySendResult> {
    try {
      this.assertWritable();
      let source: GatewayPrivateRouteInspection | undefined;
      if ("peerToken" in params && params.peerToken !== undefined) {
        source = await this.assertPeer({ alias: params.fromAlias, token: params.peerToken });
      } else if (params.replyAddress === undefined) {
        throw new BridgeError("CLAUDE_REPLY_ADDRESS_INVALID", "The inherited reply capability is required.");
      } else {
        const resolved = await this.claudeAdapter(aliasHost(params.fromAlias))?.resolveReplyAddress?.(params.replyAddress);
        if (resolved === undefined) throw new BridgeError("CLAUDE_REPLY_ADDRESS_INVALID", "The reply capability is stale.");
        source = (await this.store.listLogicalRoutes()).find((route) => route.binding.provider === "claude" &&
          route.alias === params.fromAlias && route.binding.routeHandle === resolved.routeHandle);
        if (source === undefined) throw new BridgeError("CLAUDE_ROUTE_NOT_FOUND", "The reply route is not selected.");
      }
      const target = await this.store.inspectPrivateRoute(params.toAlias);
      if (source === undefined || target === undefined) {
        throw new BridgeError("ROUTE_NOT_AVAILABLE", "The selected route is absent.");
      }
      if (target.binding.provider !== "codex" && target.binding.provider !== "peer") {
        throw new BridgeError("ROUTE_NOT_AVAILABLE", "The selected route is absent.");
      }
      return await this.enqueueConversation({
        sourceAlias: params.fromAlias,
        targetAlias: params.toAlias,
        text: params.text,
        expectsReply: params.expectsReply,
        expectedSourceBinding: source.binding,
        expectedTargetBinding: target.binding,
        ...(params.trackIdleMinutes === undefined
          ? {}
          : { trackIdleMinutes: params.trackIdleMinutes }),
      });
    } catch (error) {
      return decisionFor(error, "peerToken" in params);
    }
  }

  private async reply(params: ReplyParams): Promise<GatewaySendResult> {
    try {
      this.assertWritable();
      const conversation = this.conversations.get(params.conversationId);
      if (conversation === undefined) throw new BridgeError("CONVERSATION_NOT_FOUND", "The conversation is absent.");
      const callerBinding = await this.assertReplyCaller(conversation, params.caller);
      const callerAlias = params.caller.alias;
      const targetAlias = callerAlias === conversation.sourceAlias
        ? conversation.targetAlias
        : conversation.sourceAlias;
      const targetBinding = callerAlias === conversation.sourceAlias
        ? conversation.targetBinding
        : conversation.sourceBinding;
      if (targetBinding === undefined) {
        throw new BridgeError("CONVERSATION_ROUTE_RETIRED", "The conversation endpoint is no longer available.");
      }
      if (
        params.caller.kind === "codex" &&
        conversation.nativeTarget !== undefined &&
        targetAlias === conversation.nativeTarget.alias
      ) {
        const enqueued = await this.enqueueNativeConversationReply({
          conversation,
          sourceAlias: callerAlias,
          sourceBinding: callerBinding,
          target: conversation.nativeTarget,
          text: params.text,
          exposeDeliveryToken: true,
        });
        if (enqueued.deliveryToken === undefined) {
          throw new BridgeError("MESSAGE_NOT_ACCEPTED", "The message was not accepted.");
        }
        return {
          accepted: true,
          code: "ok",
          conversationId: conversation.id,
          deliveryToken: enqueued.deliveryToken,
        };
      }
      return await this.enqueueConversation({
        sourceAlias: callerAlias,
        targetAlias,
        text: params.text,
        expectsReply: true,
        expectedSourceBinding: callerBinding,
        expectedTargetBinding: targetBinding,
        ...(params.trackIdleMinutes === undefined
          ? {}
          : { trackIdleMinutes: params.trackIdleMinutes }),
        existingConversation: conversation,
      });
    } catch (error) {
      return decisionFor(error, params.caller.kind === "peer");
    }
  }

  private async assertReplyCaller(
    conversation: Conversation,
    caller: GatewayReplyCaller,
  ): Promise<LogicalRouteBinding> {
    if (caller.alias !== conversation.sourceAlias && caller.alias !== conversation.targetAlias) {
      throw new BridgeError("CONVERSATION_CALLER_MISMATCH", "The caller does not own this conversation.");
    }
    const expected = caller.alias === conversation.sourceAlias
      ? conversation.sourceBinding
      : conversation.targetBinding;
    const route = await this.store.inspectPrivateRoute(caller.alias);
    if (expected === undefined || route === undefined || !sameBinding(route.binding, expected)) {
      throw new BridgeError("CONVERSATION_ROUTE_RETIRED", "The conversation endpoint is no longer available.");
    }
    if (caller.kind === "codex" &&
      (route.binding.provider !== "codex" || route.binding.routeHandle !== caller.threadId)) {
      throw new BridgeError("CODEX_THREAD_MISMATCH", "The task attestation does not match the conversation.");
    }
    if (caller.kind === "claude") {
      if (caller.replyAddress === undefined || route.binding.provider !== "claude") {
        throw new BridgeError("CLAUDE_REPLY_ADDRESS_INVALID", "The inherited reply capability is required.");
      }
      const resolved = await this.claudeAdapter(route.binding.hostId)
        ?.resolveReplyAddress?.(caller.replyAddress);
      if (resolved?.routeHandle !== route.binding.routeHandle) {
        throw new BridgeError("CLAUDE_REPLY_ADDRESS_INVALID", "The reply capability is stale.");
      }
    }
    if (caller.kind === "peer") await this.assertPeer({ alias: caller.alias, token: caller.token });
    return route.binding;
  }

  private async enqueueConversation(input: Readonly<{
    sourceAlias: string;
    targetAlias: string;
    text: string;
    expectsReply: boolean;
    expectedSourceBinding?: LogicalRouteBinding;
    expectedTargetBinding?: LogicalRouteBinding;
    existingConversation?: Conversation;
    trackIdleMinutes?: number;
    skipWatch?: true;
  }>): Promise<Extract<GatewaySendResult, { accepted: true }>> {
    const target = await this.store.inspectPrivateRoute(input.targetAlias);
    const source = await this.store.inspectPrivateRoute(input.sourceAlias);
    const conversationSourceBinding = input.existingConversation === undefined
      ? undefined
      : input.sourceAlias === input.existingConversation.sourceAlias
        ? input.existingConversation.sourceBinding
        : input.sourceAlias === input.existingConversation.targetAlias
          ? input.existingConversation.targetBinding
          : undefined;
    const conversationTargetBinding = input.existingConversation === undefined
      ? undefined
      : input.targetAlias === input.existingConversation.sourceAlias
        ? input.existingConversation.sourceBinding
        : input.targetAlias === input.existingConversation.targetAlias
          ? input.existingConversation.targetBinding
          : undefined;
    const sourceBinding = input.expectedSourceBinding ?? conversationSourceBinding ?? source?.binding;
    const targetBinding = input.expectedTargetBinding ?? conversationTargetBinding ?? target?.binding;
    const steer = input.text.startsWith("STEER:") && this.config.steeringEnabled &&
      sourceBinding?.provider === "claude" && targetBinding?.provider === "codex";
    if (
      input.existingConversation === undefined &&
      this.conversations.size >= MAX_CONVERSATIONS &&
      [...this.conversations.keys()].every((id) => this.conversationIsActive(id))
    ) {
      throw new BridgeError("CONVERSATION_CAPACITY_REACHED", "Conversation capacity is full.");
    }
    const conversation = input.existingConversation ?? {
      id: createGatewayConversationId(),
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      ...(sourceBinding === undefined ? {} : { sourceBinding: { ...sourceBinding } }),
      ...(targetBinding === undefined ? {} : { targetBinding: { ...targetBinding } }),
      expectsReply: input.expectsReply,
      pair: true as const,
      nextSequence: 0,
    };
    const previousWatch = this.progressWatches.get(conversation.id);
    const previousWatchEvents = this.progressWatchEvents.length;
    if (input.skipWatch !== true) {
      await this.updateProgressWatch(
        conversation,
        input.sourceAlias,
        input.text,
        input.trackIdleMinutes,
      );
    }
    const sequence = conversation.nextSequence++;
    let enqueued: Awaited<ReturnType<GatewayStore["enqueueMessage"]>>;
    try {
      this.assertWritable();
      enqueued = await this.store.enqueueMessage({
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        body: input.text,
        dedupeKey: `${conversation.id}:${sequence}`,
        conversationIdSuffix: conversation.id.slice(-8),
        ...(sourceBinding === undefined || targetBinding === undefined
          ? {}
          : {
              expectedSourceRegistrationId: sourceBinding.registrationId,
              expectedTargetRegistrationId: targetBinding.registrationId,
            }),
        ...(steer ? { steer: true as const } : {}),
      });
    } catch (error) {
      this.restoreProgressWatch(
        conversation.id,
        previousWatch,
        previousWatchEvents,
      );
      conversation.nextSequence -= 1;
      throw error;
    }
    if (!enqueued.accepted || enqueued.messageId === undefined || enqueued.deliveryToken === undefined) {
      this.restoreProgressWatch(
        conversation.id,
        previousWatch,
        previousWatchEvents,
      );
      conversation.nextSequence -= 1;
      throw new BridgeError("MESSAGE_NOT_ACCEPTED", "The message was not accepted.");
    }
    this.rememberConversation(conversation);
    this.messageContexts.set(enqueued.messageId, {
      conversationId: conversation.id,
      expectsReply: input.expectsReply,
    });
    if (enqueued.supersededSettlement !== undefined) {
      await this.finishSettlement(enqueued.supersededSettlement);
    }
    if (steer) this.kickSteer(input.targetAlias);
    this.kick(input.targetAlias);
    this.scheduleWake();
    return {
      accepted: true,
      code: "ok",
      conversationId: conversation.id,
      deliveryToken: enqueued.deliveryToken,
    };
  }

  private rememberConversation(conversation: Conversation): void {
    this.conversations.delete(conversation.id);
    this.conversations.set(conversation.id, conversation);
    while (this.conversations.size > MAX_CONVERSATIONS) {
      const oldest = [...this.conversations.keys()].find(
        (id) => id !== conversation.id && !this.conversationIsActive(id),
      );
      if (oldest === undefined) break;
      this.conversations.delete(oldest);
    }
  }

  private conversationIsActive(conversationId: string): boolean {
    if ([...this.messageContexts.values()].some((row) => row.conversationId === conversationId)) {
      return true;
    }
    return [...this.pendingClaudeReplies.values()].some((rows) =>
      rows.some((row) => row.conversationId === conversationId),
    );
  }

  private async deliveryStatus(token: string): Promise<GatewayDeliveryStatusResult> {
    const message = await this.store.deliveryStatus(token);
    if (message === undefined) return { found: false };
    const state = message.state.phase === "terminal"
      ? message.state.outcome === "abandoned"
        ? "failed"
        : message.state.outcome
      : message.state.phase === "queued"
        ? "queued"
        : "stalled";
    return {
      found: true,
      state,
      terminal: message.state.phase === "terminal",
      updatedAt: this.messageUpdatedAt(message),
      deadlineAt: message.deadlineAt,
      ...(message.state.phase === "terminal"
        ? message.state.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: message.state.safeErrorCode }
        : { pendingForMs: Math.max(0, this.now().getTime() - Date.parse(message.enqueuedAt)) }),
    };
  }

  private messageUpdatedAt(message: GatewayMessageRecord): string {
    switch (message.state.phase) {
      case "queued": return message.enqueuedAt;
      case "reserved": return message.state.reservedAt;
      case "armed": return message.state.armedAt;
      case "accepted": return message.state.acceptedAt;
      case "terminal": return message.state.terminalAt;
    }
  }

  private kick(targetAlias: string, preferredRegistrationId?: string): void {
    const startingKey = `${targetAlias}\0${preferredRegistrationId ?? "current"}`;
    if (!this.running || this.closing || this.startingTargets.has(startingKey)) return;
    this.startingTargets.add(startingKey);
    void this.kickExact(targetAlias, preferredRegistrationId)
      .catch((error) => this.alert("DISPATCH_RUNNER_FAILED", undefined, error))
      .finally(() => this.startingTargets.delete(startingKey));
  }

  private async kickExact(
    targetAlias: string,
    preferredRegistrationId?: string,
  ): Promise<void> {
    if (!this.running || this.closing) return;
    const route = await this.store.inspectPrivateRoute(targetAlias);
    const transient = [...this.messageContexts.values()].find(
      (context) => this.conversations.get(context.conversationId)?.nativeTarget?.alias === targetAlias,
    );
    const transientTarget = transient === undefined
      ? undefined
      : this.conversations.get(transient.conversationId)?.nativeTarget;
    const registration = preferredRegistrationId ?? route?.binding.registrationId ??
      transientTarget?.binding.registrationId;
    if (registration === undefined) return;
    this.startRunner(targetAlias, registration, "any");
  }

  private kickSteer(targetAlias: string): void {
    if (!this.running || this.closing) return;
    void this.store.inspectPrivateRoute(targetAlias).then((route) => {
      if (route === undefined || route.binding.provider !== "codex") return;
      this.startRunner(targetAlias, route.binding.registrationId, "steer_only", route);
    }).catch((error) => this.alert("STEER_RUNNER_FAILED", undefined, error));
  }

  private startRunner(
    targetAlias: string,
    registrationId: string,
    mode: "any" | "steer_only",
    route?: GatewayPrivateRouteInspection,
  ): void {
    const steer = mode === "steer_only";
    const runners = steer ? this.steerRunners : this.dispatchRunners;
    const key = `${targetAlias}\0${registrationId}${steer ? "\0steer" : ""}`;
    if (runners.has(key)) return;
    let retry = false;
    const runner = this.runTarget(targetAlias, registrationId, mode)
      .then((value) => { retry = value; })
      .finally(() => {
        if (runners.get(key) !== runner) return;
        runners.delete(key);
        if (retry) this.scheduleTargetRetry(targetAlias, registrationId, steer);
        else if (steer && this.running && !this.closing) this.kickSteer(targetAlias);
        else if (this.running) void Promise.all([this.store.inspectDispatchableTargets(), this.store.inspectPrivateRoute(targetAlias)]).then(([targets, route]) => {
          if (targets.includes(targetAlias) &&
            (route?.registrationMode !== "federated_peer" || this.peerClients.has(route.binding.hostId))) this.kick(targetAlias);
        }).catch(() => undefined);
      });
    runners.set(key, runner);
    void runner.catch((error) => this.alert(
      steer ? "STEER_RUNNER_FAILED" : "DISPATCH_RUNNER_FAILED",
      route,
      error,
    ));
  }

  private async runTarget(
    targetAlias: string,
    runnerRegistrationId: string,
    mode: "any" | "steer_only",
  ): Promise<boolean> {
    while (this.running && !this.closing) {
      let reserved: Awaited<ReturnType<GatewayStore["reserveMessage"]>> | undefined;
      const reserveOperation = this.store.reserveMessage(targetAlias, mode).then((result) => {
        reserved = result;
        if (result.status === "reserved") {
          this.activeAttempts.set(result.attempt.messageId, {
            messageId: result.attempt.messageId,
            attemptId: result.attempt.attemptId,
          });
        }
      });
      this.reserveOperations.add(reserveOperation);
      try {
        await reserveOperation;
      } finally {
        this.reserveOperations.delete(reserveOperation);
      }
      if (reserved === undefined) throw new RangeError("RESERVE_RESULT_MISSING");
      if (reserved.status === "empty") return false;
      if (reserved.status === "terminal") {
        await this.finishSettlement(reserved.settlement);
        return false;
      }
      const attempt = reserved.attempt;
      if (this.closing || !this.running) {
        await this.settleAttemptForShutdown(attempt.messageId, attempt.attemptId);
        return false;
      }
      if (attempt.targetRegistrationId !== runnerRegistrationId) {
        await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "requeue", "ENDPOINT_GENERATION_CHANGED");
        return false;
      }
      const messageContext = this.messageContexts.get(attempt.messageId);
      const conversation = messageContext === undefined
        ? undefined
        : this.conversations.get(messageContext.conversationId);
      const transientTarget = conversation?.nativeTarget?.alias === attempt.targetAlias
        ? conversation.nativeTarget
        : undefined;
      const persistedTarget = await this.store.inspectPrivateRoute(attempt.targetAlias);
      const target = transientTarget !== undefined
        ? {
            alias: transientTarget.alias,
            binding: transientTarget.binding,
            registrationMode: "selected_live_peer" as const,
            enabled: true,
          }
        : (persistedTarget === undefined
          ? undefined
          : persistedTarget);
      const source = await this.store.inspectPrivateRoute(attempt.sourceAlias);
      if (this.closing || !this.running) {
        await this.settleAttemptForShutdown(attempt.messageId, attempt.attemptId);
        return false;
      }
      if (
        target === undefined ||
        target.binding.registrationId !== attempt.targetRegistrationId ||
        (attempt.sourceRegistrationId !== null && source?.binding.registrationId !== attempt.sourceRegistrationId)
      ) {
        await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "failed", "ROUTE_UNREGISTERED");
        return false;
      }
      if (target.registrationMode === "federated_peer") {
        const peer = this.peerClients.get(target.binding.hostId);
        if (peer === undefined || source === undefined || source.registrationMode === "federated_peer") {
          await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "requeue", "PEER_TUNNEL_UNAVAILABLE");
          return false;
        }
        const sourceEndpoint = { alias: source.alias, provider: source.binding.provider,
          host: source.binding.hostId, routeRef: peerRouteRef(source.binding.hostId, source.binding.registrationId) } as const;
        const targetEndpoint = { alias: target.alias, provider: target.binding.provider,
          host: target.binding.hostId, routeRef: target.binding.routeHandle } as const;
        const params: PeerHandoffParams = {
          originAttemptId: attempt.attemptId, originMessageId: attempt.messageId,
          source: sourceEndpoint, target: targetEndpoint,
          edgeRef: peerEdgeRef([sourceEndpoint, targetEndpoint]),
          edgeOwnerHost: [sourceEndpoint.host, targetEndpoint.host].sort()[0]!,
          deadlineAt: attempt.deadlineAt, expectsReply: conversation?.expectsReply ?? true,
          body: attempt.body,
          ...(attempt.steer === true ? { steer: true as const } : {}),
          ...(attempt.conversationIdSuffix === undefined ? {} : { conversationCorrelation: attempt.conversationIdSuffix }),
        };
        let armed = false, authorizationUncertain = false, acceptanceObserved = false, result: GatewayAdapterDispatchResult;
        try {
          const prepared = peer.prepareHandoff(params);
          let authorized: Awaited<ReturnType<GatewayStore["authorizeMessage"]>>;
          try { authorized = await this.store.authorizeMessage({ messageId: attempt.messageId,
              attemptId: attempt.attemptId, sourceRegistrationId: attempt.sourceRegistrationId,
              targetRegistrationId: attempt.targetRegistrationId,
              prepared: { kind: "peer_handoff", bodyBytes: prepared.bodyBytes,
                bodySha256: prepared.bodySha256, frameBytes: prepared.frameBytes, sha256: prepared.sha256 } });
          } catch (error) { authorizationUncertain = true; throw error; }
          if (authorized.status !== "authorized") {
            prepared.cancel();
            if (authorized.status === "terminal") await this.finishSettlement(authorized.settlement);
            this.activeAttempts.delete(attempt.messageId);
            return false;
          }
          armed = true;
          await prepared.perform();
          acceptanceObserved = true;
          const accepted = await this.store.acceptMessage({ messageId: attempt.messageId,
            attemptId: attempt.attemptId, lossOutcome: "unconfirmed" });
          if (accepted.status !== "accepted") throw new BridgeError("ACCEPTANCE_UNCONFIRMED", "The peer acceptance fence is stale.");
          result = { state: "delivered", safeErrorCode: "PEER_HANDOFF_CONFIRMED" };
        } catch {
          if (!armed && !authorizationUncertain) {
            peer.close();
            this.peerClients.delete(target.binding.hostId);
            await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "requeue", "PEER_TUNNEL_UNAVAILABLE");
            return false;
          }
          result = acceptanceObserved
            ? { state: "unconfirmed", safeErrorCode: "PEER_HANDOFF_ACCEPTANCE_UNCONFIRMED" }
            : { state: "ambiguous", safeErrorCode: authorizationUncertain ? "WRITE_AUTHORIZATION_UNCERTAIN" : "PEER_HANDOFF_OUTCOME_UNKNOWN" };
        }
        const requeued = await this.applyDispatchResult(attempt.messageId, attempt.attemptId, result,
          armed, conversation, attempt.sourceAlias, attempt.targetAlias);
        this.activeAttempts.delete(attempt.messageId);
        return requeued;
      }
      const adapter = this.adapterFor(target.binding);
      if (adapter === undefined) {
        await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "failed", "PROVIDER_UNAVAILABLE");
        return false;
      }
      const active = this.activeAttempts.get(attempt.messageId)!;
      let authorizationUncertain = false;
      let armed = false;
      let accepted = false;
      const conversationId = messageContext?.conversationId ??
        conversationIdForSuffix(attempt.conversationIdSuffix);
      const parsed = parseDirection(attempt.direction)!;
      if (
        target.binding.provider === "claude" &&
        messageContext?.expectsReply === true &&
        ![...this.pendingClaudeReplies.values()].some((rows) =>
          rows.some((row) => row.messageId === attempt.messageId),
        ) &&
        [...this.pendingClaudeReplies.values()].reduce(
          (count, rows) => count + rows.length,
          0,
        ) >= MAX_PENDING_CLAUDE_REPLIES
      ) {
        await this.resolvePrewrite(attempt.messageId, attempt.attemptId, "requeue", "ROUTE_BUSY");
        return true;
      }
      let result: GatewayAdapterDispatchResult;
      try {
        result = await adapter.dispatch({
          attemptId: attempt.attemptId,
          sourceAlias: attempt.sourceAlias,
          sourceProvider: parsed.sourceProvider,
          targetAlias: attempt.targetAlias,
          conversationId,
          binding: target.binding,
          authorization: transientTarget === undefined
            ? "selected_route"
            : "native_reply",
          messageId: attempt.messageId,
          text: attempt.body,
          expectsReply: conversation?.expectsReply ?? true,
          deadlineAt: attempt.deadlineAt,
          ...(this.progressWatches.has(conversationId)
            ? { progressWatchActive: true as const }
            : {}),
          ...(attempt.steer === true ? { steer: true as const, queuedAhead: 0 } : {}),
          authorizeWrite: async (evidence) => {
            if (evidence.attemptId !== attempt.attemptId) return false;
            try {
              const authorized = await this.store.authorizeMessage({
                messageId: attempt.messageId,
                attemptId: attempt.attemptId,
                sourceRegistrationId: attempt.sourceRegistrationId,
                targetRegistrationId: attempt.targetRegistrationId,
                prepared: {
                  kind: evidence.kind,
                  bodyBytes: evidence.bodyBytes,
                  bodySha256: evidence.bodySha256,
                  frameBytes: evidence.frameBytes,
                  sha256: evidence.sha256,
                },
              });
              if (authorized.status === "terminal") {
                await this.finishSettlement(authorized.settlement);
              }
              if (authorized.status === "authorized") {
                armed = true;
                if (
                  target.binding.provider === "claude" &&
                  messageContext?.expectsReply === true &&
                  source !== undefined
                ) {
                  this.installPendingClaudeReply({
                    messageId: attempt.messageId,
                    conversationId,
                    sourceAlias: attempt.sourceAlias,
                    targetAlias: attempt.targetAlias,
                    sourceBinding: source.binding,
                    targetBinding: target.binding,
                    deadlineAt: attempt.deadlineAt,
                    state: "armed",
                  });
                }
              }
              return authorized.status === "authorized";
            } catch (error) {
              authorizationUncertain = true;
              throw error;
            }
          },
          onAccepted: async (evidence) => {
            if (
              (target.binding.provider !== "codex" && target.binding.provider !== "peer") ||
              evidence.attemptId !== attempt.attemptId
            ) {
              throw new BridgeError("ACCEPTANCE_UNCONFIRMED", "The provider accepted another attempt.");
            }
            const result = await this.store.acceptMessage({
              messageId: attempt.messageId,
              attemptId: attempt.attemptId,
              lossOutcome: attempt.steer === true ? "ambiguous" : "unconfirmed",
            });
            if (result.status !== "accepted") {
              throw new BridgeError("ACCEPTANCE_UNCONFIRMED", "The durable acceptance fence is stale.");
            }
            accepted = true;
          },
        });
      } catch {
        result = {
          state: accepted
            ? attempt.steer === true
              ? "ambiguous"
              : "unconfirmed"
            : armed || authorizationUncertain
              ? "ambiguous"
              : "failed",
          safeErrorCode: accepted
              ? "DELIVERY_UNCONFIRMED"
              : authorizationUncertain || armed
                ? "WRITE_AUTHORIZATION_UNCERTAIN"
              : "PROVIDER_DISPATCH_FAILED",
        };
      }
      const requeued = await this.applyDispatchResult(
        attempt.messageId,
        attempt.attemptId,
        result,
        armed,
        conversation,
        attempt.sourceAlias,
        attempt.targetAlias,
      );
      if (this.activeAttempts.get(attempt.messageId) === active) this.activeAttempts.delete(attempt.messageId);
      return requeued;
    }
    return false;
  }

  private async settleAttemptForShutdown(messageId: string, attemptId: string): Promise<void> {
    const result = await this.store.settleAttemptForShutdown({ messageId, attemptId });
    if (result.status === "settled") await this.finishSettlement(result.settlement);
  }

  private async resolvePrewrite(
    messageId: string,
    attemptId: string,
    outcome: "requeue" | "failed",
    safeErrorCode: string,
  ): Promise<void> {
    const result = await this.store.resolvePrewriteAttempt({
      messageId, attemptId, outcome, safeErrorCode,
    });
    if (result.status === "settled") await this.finishSettlement(result.settlement);
    else this.activeAttempts.delete(messageId);
  }

  private async applyDispatchResult(
    messageId: string,
    attemptId: string,
    result: GatewayAdapterDispatchResult,
    armed: boolean,
    conversation: Conversation | undefined,
    sourceAlias: string,
    targetAlias: string,
  ): Promise<boolean> {
    if (result.state === "deferred" && armed) {
      result = {
        state: "ambiguous",
        safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
      };
    }
    if (result.state === "deferred") {
      const code = safeCode(result.safeErrorCode, "PROVIDER_DEFERRED");
      const resolution = await this.store.resolvePrewriteAttempt({
        messageId,
        attemptId,
        outcome: CLEAN_RETRY_CODES.has(code) ? "requeue" : "failed",
        safeErrorCode: code,
      });
      if (resolution.status === "settled") await this.finishSettlement(resolution.settlement);
      return resolution.status === "requeued";
    }
    const terminal = result.state;
    const resultCode = "safeErrorCode" in result
      ? result.safeErrorCode
      : undefined;
    const prewrite = await this.store.resolvePrewriteAttempt({
      messageId,
      attemptId,
      outcome: "failed",
      ...(resultCode === undefined ? {} : { safeErrorCode: safeCode(resultCode, "PROVIDER_DISPATCH_FAILED") }),
    });
    if (prewrite.status === "settled") {
      await this.finishSettlement(prewrite.settlement);
      return false;
    }
    if (prewrite.status !== "stale") return false;
    const settlement = await this.store.settleAttempt({
      messageId,
      attemptId,
      state: terminal,
      ...(resultCode === undefined ? {} : { safeErrorCode: safeCode(resultCode, "PROVIDER_DISPATCH_FAILED") }),
    });
    if (settlement.status === "settled") {
      await this.finishSettlement(settlement.settlement);
      if (settlement.settlement.state === "delivered") {
        await this.activatePendingClaudeReply(messageId);
      }
      if (
        conversation !== undefined &&
        "replyText" in result &&
        result.replyText !== undefined
      ) {
        await this.enqueueCorrelatedReply(conversation, sourceAlias, targetAlias, result.replyText);
      }
    }
    return false;
  }

  private callbacksFor(adapter: GatewayProviderAdapter): GatewayAdapterCallbacks {
    return {
      onRouteState: (event) => {
        if (
          event.route.provider !== adapter.identity.provider ||
          event.route.hostId !== adapter.identity.hostId
        ) return;
        void this.onRouteState(event).catch((error) => this.alert("ROUTE_OBSERVATION_FAILED", undefined, error));
      },
      onClaudeReply: (event) => {
        if (
          adapter.identity.provider !== "claude" ||
          event.endpoint.provider !== adapter.identity.provider ||
          event.endpoint.hostId !== adapter.identity.hostId
        ) return;
        void this.onClaudeReply(event).catch((error) => this.alert("CLAUDE_REPLY_REJECTED", undefined, error));
      },
      onClaudeMessage: (event) => {
        if (
          adapter.identity.provider !== "claude" ||
          event.endpoint.provider !== adapter.identity.provider ||
          event.endpoint.hostId !== adapter.identity.hostId
        ) return;
        const operation = this.onClaudeMessage(event).catch((error) => {
          this.alert("CLAUDE_INGRESS_REJECTED", undefined, error);
          if (event.receiptHandle !== undefined) {
            void adapter.updateNativeInboundStatus?.(
              event.receiptHandle,
              "denied",
              safeCode(error instanceof BridgeError ? error.code : undefined, "CLAUDE_INGRESS_REJECTED"),
            ).finally(() => adapter.releaseNativeInboundReceipt?.(event.receiptHandle!));
          }
        }).finally(() => this.inboundOperations.delete(operation));
        this.inboundOperations.add(operation);
        void operation;
      },
      onProtocolNotice: (event) => this.alert(safeCode(event.code, "PROVIDER_PROTOCOL_NOTICE"), undefined),
    };
  }

  private async onRouteState(event: GatewayAdapterRouteObservation): Promise<void> {
    const route = await this.store.inspectPrivateRoute(
      (await this.store.listLogicalRoutes()).find(
        (candidate) => candidate.binding.registrationId === event.route.registrationId,
      )?.alias ?? "",
    );
    if (route === undefined || !sameBinding(route.binding, event.route)) return;
    if (!Number.isFinite(Date.parse(event.observedAt))) return;
    this.routeObservations.set(route.alias, {
      ...event,
      ...(event.safeErrorCode === undefined
        ? {}
        : { safeErrorCode: safeCode(event.safeErrorCode, "ROUTE_UNOBSERVED") }),
    });
    const runtime = this.connectors.get(connectorKey(event.route));
    if (runtime !== undefined) {
      runtime.observedAt = event.observedAt;
      runtime.health = event.state === "unobserved" ? "degraded" : "healthy";
      if (event.state === "unobserved") {
        runtime.safeErrorCode = safeCode(event.safeErrorCode, "ROUTE_UNOBSERVED");
      } else {
        delete runtime.safeErrorCode;
      }
    }
    this.revision += 1;
  }

  private async onClaudeMessage(event: Readonly<{
    endpoint: GatewayAdapterNativeEndpoint;
    sourceAlias: string;
    targetAlias: string;
    text: string;
    receiptHandle?: string;
  }>): Promise<void> {
    const target = await this.store.inspectPrivateRoute(event.targetAlias);
    const localHost = this.config.hostId;
    if (target === undefined || (target.binding.hostId !== event.endpoint.hostId &&
      !(target.registrationMode === "federated_peer" && event.endpoint.hostId === localHost))) {
      throw new BridgeError("ROUTE_NOT_AVAILABLE", "The native target is absent.");
    }
    const selected = (await this.store.listLogicalRoutes()).find(
      (route) =>
        route.binding.provider === "claude" &&
        route.alias === event.sourceAlias &&
        route.binding.routeHandle === event.endpoint.routeHandle &&
        route.binding.hostId === event.endpoint.hostId,
    );
    const sourceBinding: LogicalRouteBinding = selected?.binding ?? {
      provider: "claude",
      hostId: event.endpoint.hostId,
      routeHandle: event.endpoint.routeHandle,
      registrationId: `native_${bodyHash(`${event.endpoint.routeHandle}\0${event.sourceAlias}`).slice(0, 32)}`,
    };
    const conversationId = createGatewayConversationId();
    const steer = target.binding.provider === "codex" && event.text.startsWith("STEER:") && this.config.steeringEnabled;
    this.assertWritable();
    const enqueued = await this.store.enqueueNativeIngress({
      source: { alias: event.sourceAlias, binding: sourceBinding },
      targetAlias: event.targetAlias,
      expectedTargetRegistrationId: target.binding.registrationId,
      body: event.text,
      dedupeKey: `${conversationId}:0`,
      conversationIdSuffix: conversationId.slice(-8),
      ...(steer ? { steer: true as const } : {}),
    });
    if (!enqueued.accepted || enqueued.messageId === undefined) {
      throw new BridgeError("MESSAGE_NOT_ACCEPTED", "The native message was not accepted.");
    }
    const conversation: Conversation = {
      id: conversationId,
      sourceAlias: event.sourceAlias,
      targetAlias: event.targetAlias,
      sourceBinding,
      targetBinding: target.binding,
      expectsReply: true,
      ...(enqueued.pair === true ? { pair: true as const } : {}),
      nativeTarget: { alias: event.sourceAlias, binding: sourceBinding },
      nextSequence: 1,
    };
    this.rememberConversation(conversation);
    this.messageContexts.set(enqueued.messageId, { conversationId, expectsReply: true });
    if (event.receiptHandle !== undefined) {
      const adapter = this.claudeAdapter(event.endpoint.hostId);
      if (adapter !== undefined) {
        const receipt: NativeReceipt = {
          adapter,
          receiptHandle: event.receiptHandle,
          targetAlias: event.targetAlias,
          enqueuedAt: this.now().getTime(),
          heldWrite: Promise.resolve(),
          settled: false,
        };
        receipt.heldTimer = this.timers.setTimeout(() => {
          if (receipt.settled) return;
          delete receipt.heldTimer;
          receipt.heldWrite = Promise.resolve(
            adapter.updateNativeInboundStatus?.(receipt.receiptHandle, "held"),
          ).then(() => undefined).catch((error) =>
            this.alert("CLAUDE_RECEIPT_HELD_FAILED", undefined, error),
          );
        }, 1_000);
        if (this.config.deliveryNotices !== "quiet") {
          receipt.stallTimer = this.timers.setTimeout(() => {
            if (receipt.settled) return;
            delete receipt.stallTimer;
            void receipt.heldWrite.then(async () => {
              if (receipt.settled) return;
              const observation = this.routeObservations.get(receipt.targetAlias);
              const reason = observation?.state === "awaiting_approval"
                ? "AWAITING_EXTERNAL_APPROVAL"
                : observation?.state === "busy"
                  ? "ROUTE_BUSY"
                  : observation === undefined || observation.state === "unobserved"
                    ? "ROUTE_UNAVAILABLE"
                    : "ROUTE_BUSY";
              await adapter.notifyNativeInboundProgress?.(receipt.receiptHandle, {
                kind: "stall",
                reason,
                queuedForMs: Math.max(0, this.now().getTime() - receipt.enqueuedAt),
              });
            }).catch((error) => this.alert("CLAUDE_RECEIPT_PROGRESS_FAILED", undefined, error));
          }, this.config.stallNoticeMs);
        }
        this.nativeReceipts.set(enqueued.messageId, receipt);
      }
    }
    if (steer) this.kickSteer(event.targetAlias);
    this.kick(event.targetAlias);
    this.scheduleWake();
  }

  private async onClaudeReply(event: Readonly<{
    endpoint: GatewayAdapterNativeEndpoint;
    text: string;
  }>): Promise<void> {
    if (event.endpoint.provider !== "claude" || this.closing) return;
    const key = `${event.endpoint.hostId}\0${event.endpoint.routeHandle}`;
    const pending = this.pendingClaudeReplies.get(key) ?? [];
    while (pending.length > 0) {
      const row = pending[0]!;
      if (row.state === "retired") {
        pending.shift();
        if (pending.length === 0) this.pendingClaudeReplies.delete(key);
        else this.pendingClaudeReplies.set(key, pending);
        return;
      }
      const current = await this.store.inspectPrivateRoute(row.targetAlias);
      const currentSource = await this.store.inspectPrivateRoute(row.sourceAlias);
      if (
        current === undefined ||
        !sameBinding(current.binding, row.targetBinding) ||
        currentSource === undefined ||
        !sameBinding(currentSource.binding, row.sourceBinding)
      ) {
        pending.shift();
        if (pending.length === 0) this.pendingClaudeReplies.delete(key);
        else this.pendingClaudeReplies.set(key, pending);
        return;
      }
      if (row.state === "armed") {
        if (row.bufferedReply === undefined) row.bufferedReply = event.text;
        this.pendingClaudeReplies.set(key, pending);
        return;
      }
      pending.shift();
      if (pending.length === 0) this.pendingClaudeReplies.delete(key);
      else this.pendingClaudeReplies.set(key, pending);
      await this.deliverPendingClaudeReply(row, event.text);
      return;
    }
    this.pendingClaudeReplies.delete(key);
  }

  private async enqueueCorrelatedReply(
    conversation: Conversation,
    sourceAlias: string,
    targetAlias: string,
    text: string,
  ): Promise<void> {
    const sourceBinding = sourceAlias === conversation.sourceAlias
      ? conversation.sourceBinding
      : conversation.targetBinding;
    const targetBinding = targetAlias === conversation.targetAlias
      ? conversation.targetBinding
      : conversation.sourceBinding;
    if (
      conversation.nativeTarget === undefined ||
      sourceAlias !== conversation.nativeTarget.alias
    ) {
      if (sourceBinding === undefined || targetBinding === undefined) return;
      const currentSource = await this.store.inspectPrivateRoute(sourceAlias);
      if (
        currentSource === undefined ||
        !sameBinding(currentSource.binding, sourceBinding)
      ) return;
      await this.enqueueConversation({
        sourceAlias: targetAlias,
        targetAlias: sourceAlias,
        text,
        expectsReply: true,
        expectedSourceBinding: targetBinding,
        expectedTargetBinding: sourceBinding,
        existingConversation: conversation,
      });
      return;
    }
    if (targetBinding === undefined) return;
    await this.enqueueNativeConversationReply({
      conversation,
      sourceAlias: targetAlias,
      sourceBinding: targetBinding,
      target: conversation.nativeTarget,
      text,
    });
  }

  private async enqueueNativeConversationReply(input: Readonly<{
    conversation: Conversation;
    sourceAlias: string;
    sourceBinding: LogicalRouteBinding;
    target: Readonly<{ alias: string; binding: LogicalRouteBinding }>;
    text: string;
    exposeDeliveryToken?: true;
  }>): Promise<Awaited<ReturnType<GatewayStore["enqueueNativeReply"]>>> {
    const sequence = input.conversation.nextSequence++;
    let enqueued: Awaited<ReturnType<GatewayStore["enqueueNativeReply"]>>;
    try {
      enqueued = await this.store.enqueueNativeReply({
        sourceAlias: input.sourceAlias,
        expectedSourceRegistrationId: input.sourceBinding.registrationId,
        target: input.target,
        body: input.text,
        dedupeKey: `${input.conversation.id}:${sequence}`,
        conversationIdSuffix: input.conversation.id.slice(-8),
        ...(input.conversation.pair === true ? { pair: true as const } : {}),
        ...(input.exposeDeliveryToken === true ? { exposeDeliveryToken: true as const } : {}),
      });
    } catch (error) {
      input.conversation.nextSequence -= 1;
      throw error;
    }
    if (!enqueued.accepted || enqueued.messageId === undefined) {
      input.conversation.nextSequence -= 1;
      throw new BridgeError("MESSAGE_NOT_ACCEPTED", "The message was not accepted.");
    }
    this.messageContexts.set(enqueued.messageId, {
      conversationId: input.conversation.id,
      expectsReply: true,
    });
    this.kick(input.target.alias, input.target.binding.registrationId);
    this.scheduleWake();
    return enqueued;
  }

  private installPendingClaudeReply(row: PendingClaudeReply): void {
    const key = `${row.targetBinding.hostId}\0${row.targetBinding.routeHandle}`;
    const pending = this.pendingClaudeReplies.get(key) ?? [];
    if (!pending.some((candidate) => candidate.messageId === row.messageId)) {
      pending.push(row);
      this.pendingClaudeReplies.set(key, pending);
    }
  }

  private pruneExpiredPendingClaudeReplies(now: number): void {
    for (const [key, pending] of this.pendingClaudeReplies) {
      const retained = pending.filter((row) => Date.parse(row.deadlineAt) > now);
      if (retained.length === pending.length) continue;
      if (retained.length === 0) this.pendingClaudeReplies.delete(key);
      else this.pendingClaudeReplies.set(key, retained);
    }
  }

  private retirePendingClaudeReply(messageId: string): void {
    for (const pending of this.pendingClaudeReplies.values()) {
      const row = pending.find((candidate) => candidate.messageId === messageId);
      if (row === undefined) continue;
      row.state = "retired";
      delete row.bufferedReply;
      return;
    }
  }

  private async activatePendingClaudeReply(messageId: string): Promise<void> {
    for (const [key, pending] of this.pendingClaudeReplies) {
      const row = pending.find((candidate) => candidate.messageId === messageId);
      if (row === undefined) continue;
      row.state = "delivered";
      if (row.bufferedReply === undefined || pending[0] !== row) return;
      const text = row.bufferedReply;
      pending.shift();
      if (pending.length === 0) this.pendingClaudeReplies.delete(key);
      else this.pendingClaudeReplies.set(key, pending);
      await this.deliverPendingClaudeReply(row, text);
      return;
    }
  }

  private async deliverPendingClaudeReply(
    row: PendingClaudeReply,
    text: string,
  ): Promise<void> {
    const conversation = this.conversations.get(row.conversationId);
    if (conversation === undefined) return;
    const currentSource = await this.store.inspectPrivateRoute(row.sourceAlias);
    if (
      currentSource === undefined ||
      !sameBinding(currentSource.binding, row.sourceBinding)
    ) return;
    await this.enqueueConversation({
      sourceAlias: row.targetAlias,
      targetAlias: row.sourceAlias,
      text,
      expectsReply: true,
      expectedSourceBinding: row.targetBinding,
      expectedTargetBinding: row.sourceBinding,
      existingConversation: conversation,
    });
  }

  private async updateProgressWatch(
    conversation: Conversation,
    actorAlias: string,
    text: string,
    trackIdleMinutes: number | undefined,
  ): Promise<void> {
    const existing = this.progressWatches.get(conversation.id);
    if (this.config.trackingEnabled === false) {
      if (existing !== undefined) {
        this.settleProgressWatch(existing, "gateway", "tracking_disabled");
      }
      return;
    }
    if (text.startsWith("DONE:")) {
      if (existing !== undefined) {
        const actor = actorAlias === existing.ownerAlias
          ? "owner"
          : actorAlias === existing.workerAlias
            ? "worker"
            : undefined;
        if (actor !== undefined) this.settleProgressWatch(existing, actor, "done");
      }
      return;
    }
    const explicit = text.startsWith("TRACK:") || trackIdleMinutes !== undefined;
    if (existing !== undefined && !explicit) {
      this.progressWatches.set(conversation.id, {
        ...existing,
        ...recordProgressWatchActivity(existing, this.now().getTime()),
      });
      return;
    }
    if (!explicit) return;
    if (existing !== undefined && actorAlias !== existing.ownerAlias) {
      throw new BridgeError(
        "PROGRESS_WATCH_REPLACEMENT_OWNER_REQUIRED",
        "Only the progress-watch owner may replace its watch.",
      );
    }
    const capacity = Math.min(
      this.config.limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY,
      PROGRESS_WATCH_HARD_CAPACITY,
    );
    if (existing === undefined && this.progressWatches.size >= capacity) {
      throw new BridgeError("PROGRESS_WATCH_CAPACITY_REACHED", "Progress-watch capacity is full.");
    }
    const owner = await this.store.inspectPrivateRoute(actorAlias);
    const workerAlias = actorAlias === conversation.sourceAlias
      ? conversation.targetAlias
      : conversation.sourceAlias;
    const worker = await this.store.inspectPrivateRoute(workerAlias);
    if (owner === undefined || worker === undefined) {
      throw new BridgeError("PROGRESS_WATCH_ENDPOINT_NOT_FOUND", "A progress-watch endpoint is absent.");
    }
    const idleMs = trackIdleMinutes === undefined
      ? PROGRESS_WATCH_DEFAULT_IDLE_MS
      : trackIdleMinutes * 60_000;
    const watch = createProgressWatch({
      conversationId: conversation.id,
      ownerAlias: actorAlias,
      workerAlias,
      idleMs,
      at: this.now().getTime(),
    });
    this.progressWatches.set(conversation.id, {
      ...watch,
      ownerRegistrationId: owner.binding.registrationId,
      workerRegistrationId: worker.binding.registrationId,
    });
    this.recordProgressWatchEvent({
      watch,
      kind: existing === undefined ? "opened" : "replaced",
      actor: "owner",
    });
  }

  private restoreProgressWatch(
    conversationId: string,
    previous: RuntimeWatch | undefined,
    eventLength: number,
  ): void {
    if (previous === undefined) this.progressWatches.delete(conversationId);
    else this.progressWatches.set(conversationId, previous);
    this.progressWatchEvents.length = eventLength;
  }

  private untrack(conversationId: string): void {
    const watch = this.progressWatches.get(conversationId);
    if (watch === undefined) {
      throw new BridgeError("PROGRESS_WATCH_NOT_FOUND", "The progress watch is absent.");
    }
    this.settleProgressWatch(watch, "operator", "untracked");
  }

  private settleWatchesForAlias(
    alias: string,
    reason: "pair_removed" | "endpoint_retired",
    actor: "operator" | "gateway",
  ): void {
    for (const watch of [...this.progressWatches.values()]) {
      if (watch.ownerAlias === alias || watch.workerAlias === alias) {
        this.settleProgressWatch(watch, actor, reason);
      }
    }
  }

  private settleProgressWatch(
    watch: RuntimeWatch,
    actor: "owner" | "worker" | "operator" | "gateway",
    reason:
      | "done"
      | "untracked"
      | "idle_timeout"
      | "pair_removed"
      | "endpoint_retired"
      | "tracking_disabled",
  ): void {
    if (!this.progressWatches.delete(watch.conversationId)) return;
    this.recordProgressWatchEvent({ watch, kind: "settled", actor, reason });
  }

  private recordProgressWatchEvent(input: Readonly<{
    watch: ProgressWatch;
    kind: "opened" | "replaced" | "settled";
    actor: "owner" | "worker" | "operator" | "gateway" | "unknown";
    reason?: PublicProgressWatchEventSnapshot["reason"];
  }>): void {
    this.progressWatchEvents.push({
      sequence: (this.progressWatchEvents.at(-1)?.sequence ?? 0) + 1,
      timestamp: this.now().toISOString(),
      conversationIdSuffix: input.watch.conversationId.slice(-8),
      ownerAlias: input.watch.ownerAlias,
      workerAlias: input.watch.workerAlias,
      kind: input.kind,
      actor: input.actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    while (this.progressWatchEvents.length > gatewayPublicSnapshotLimits.progressWatchEvents) {
      this.progressWatchEvents.shift();
    }
  }

  private async processProgressWatches(): Promise<void> {
    const at = this.now().getTime();
    for (const watch of [...this.progressWatches.values()]) {
      const owner = await this.store.inspectPrivateRoute(watch.ownerAlias);
      const worker = await this.store.inspectPrivateRoute(watch.workerAlias);
      if (
        owner?.binding.registrationId !== watch.ownerRegistrationId ||
        worker?.binding.registrationId !== watch.workerRegistrationId
      ) {
        this.settleProgressWatch(watch, "gateway", "endpoint_retired");
        continue;
      }
      const ownerObservation = this.routeObservations.get(watch.ownerAlias);
      const workerObservation = this.routeObservations.get(watch.workerAlias);
      const due = inspectProgressWatchDue(watch, {
        at,
        bothIdle:
          ownerObservation?.state === "idle" &&
          workerObservation?.state === "idle" &&
          this.routeObservationStillCurrent(ownerObservation) &&
          this.routeObservationStillCurrent(workerObservation),
      });
      if (due.kind === "not_due") continue;
      if (due.kind === "rescheduled") {
        this.progressWatches.set(watch.conversationId, {
          ...watch,
          ...due.watch,
        });
        continue;
      }
      if (due.kind === "settled") {
        this.settleProgressWatch(watch, "gateway", "idle_timeout");
        continue;
      }
      const conversation = this.conversations.get(watch.conversationId);
      if (conversation === undefined) {
        this.settleProgressWatch(watch, "gateway", "endpoint_retired");
        continue;
      }
      const text = `[Embassy automated liveness check — ${due.nudgeNumber} / Embassy 自动活跃检查 — ${due.nudgeNumber}]\nReply with the result or a status. / 请回复结果或状态。`;
      try {
        await this.enqueueConversation({
          sourceAlias: watch.ownerAlias,
          targetAlias: watch.workerAlias,
          text,
          expectsReply: false,
          existingConversation: conversation,
          skipWatch: true,
        });
        this.progressWatches.set(watch.conversationId, {
          ...watch,
          ...commitProgressWatchNudge(watch, { at, nudgeNumber: due.nudgeNumber }),
        });
      } catch {
        this.progressWatches.set(watch.conversationId, {
          ...watch,
          ...deferProgressWatchNudge(watch, at),
        });
      }
    }
  }

  private async finishSettlements(settlements: readonly TerminalMessageSettlement[]): Promise<void> {
    await Promise.all(settlements.map(async (settlement) => this.finishSettlement(settlement)));
  }

  private async finishSettlement(settlement: TerminalMessageSettlement): Promise<void> {
    this.activeAttempts.delete(settlement.messageId);
    this.messageContexts.delete(settlement.messageId);
    const receipt = this.nativeReceipts.get(settlement.messageId);
    if (receipt !== undefined) {
      this.nativeReceipts.delete(settlement.messageId);
      receipt.settled = true;
      if (receipt.heldTimer !== undefined) this.timers.clearTimeout(receipt.heldTimer);
      if (receipt.stallTimer !== undefined) this.timers.clearTimeout(receipt.stallTimer);
      const status = settlement.state === "delivered"
        ? "delivered"
        : "expired";
      await receipt.heldWrite.then(() => receipt.adapter.updateNativeInboundStatus?.(
          receipt.receiptHandle,
          status,
          settlement.safeErrorCode,
        ))
        .catch((error) => this.alert("CLAUDE_RECEIPT_SETTLEMENT_FAILED", undefined, error))
        .finally(() => receipt.adapter.releaseNativeInboundReceipt?.(receipt.receiptHandle))
        .catch((error) => this.alert("CLAUDE_RECEIPT_RELEASE_FAILED", undefined, error));
    }
    if (settlement.state !== "delivered") {
      this.retirePendingClaudeReply(settlement.messageId);
    }
  }

  private scheduleTargetRetry(
    targetAlias: string,
    registrationId: string,
    steer = false,
  ): void {
    this.timers.setTimeout(
      () => steer
        ? this.kickSteer(targetAlias)
        : this.kick(targetAlias, registrationId),
      CLEAN_RETRY_DELAY_MS,
    );
  }

  private scheduleWake(): void {
    if (!this.running || this.closing) return;
    if (this.wakeTimer !== undefined) this.timers.clearTimeout(this.wakeTimer);
    void this.store.nextDeadlineAt().then((deadlineAt) => {
      if (!this.running || this.closing) return;
      const now = this.now().getTime();
      const due = [
        this.nextDiscoveryAt || now + DISCOVERY_INTERVAL_MS,
        this.nextDoctorAt || now + CODEX_DOCTOR_INTERVAL_MS,
        ...(this.config.peerNodes.length > 0
          ? [this.nextPeerRefreshAt || now + PEER_REFRESH_INTERVAL_MS]
          : []),
        ...(deadlineAt === undefined ? [] : [Date.parse(deadlineAt)]),
        ...[...this.pendingClaudeReplies.values()].flatMap((rows) =>
          rows.map((row) => Date.parse(row.deadlineAt))
        ),
        ...[...this.progressWatches.values()].map((watch) => Date.parse(watch.nextActionAt)),
      ].filter(Number.isFinite);
      const delay = Math.max(0, Math.min(...due) - now);
      this.wakeTimer = this.timers.setTimeout(() => {
        this.wakeTimer = undefined;
        void this.onWake().catch((error) => this.alert("GATEWAY_WAKE_FAILED", undefined, error));
      }, delay);
    }).catch((error) => this.alert("GATEWAY_WAKE_FAILED", undefined, error));
  }

  private async onWake(): Promise<void> {
    if (!this.running || this.closing) return;
    const now = this.now();
    await this.finishSettlements(await this.store.expireDueMessages(now));
    this.pruneExpiredPendingClaudeReplies(now.getTime());
    await this.processProgressWatches();
    if (now.getTime() >= this.nextDiscoveryAt) {
      await this.refreshClaudeDiscovery().catch(() => undefined);
      this.nextDiscoveryAt = now.getTime() + DISCOVERY_INTERVAL_MS;
    }
    if (now.getTime() >= this.nextDoctorAt) {
      await this.refreshCodexDoctor().catch(() => undefined);
      this.nextDoctorAt = now.getTime() + CODEX_DOCTOR_INTERVAL_MS;
    }
    if (this.nextPeerRefreshAt > 0 && now.getTime() >= this.nextPeerRefreshAt) {
      const operation = this.refreshPeers();
      this.peerRefreshOperations.add(operation);
      try { await operation; } finally { this.peerRefreshOperations.delete(operation); }
      this.nextPeerRefreshAt = now.getTime() + PEER_REFRESH_INTERVAL_MS;
    }
    if (!this.running || this.closing) return;
    for (const target of await this.store.inspectDispatchableTargets()) this.kick(target);
    this.scheduleWake();
  }

  private async refreshPeers(): Promise<void> {
    const localHost = this.config.hostId;
    await Promise.all(this.config.peerNodes.map(async (peerHost) => {
      let failureCode: "PEER_DIAL_FAILED" | "PEER_TUNNEL_UNAVAILABLE" = "PEER_TUNNEL_UNAVAILABLE";
      try {
        let client = this.peerClients.get(peerHost);
        if (client === undefined) {
          failureCode = "PEER_DIAL_FAILED";
          client = await this.spawnPeer({ node: peerHost, localHost });
          if (!this.running || this.closing) { client.close(); return; }
          this.peerClients.set(peerHost, client);
        }
        failureCode = "PEER_TUNNEL_UNAVAILABLE";
        const catalog = await client.catalog();
        if (!this.running || this.closing) return;
        this.recordPeerFailure(peerHost);
        const prior = this.peerCatalogs.get(peerHost);
        let routes = await this.store.inspectPrivateRoutes().then((rows) => rows.filter((route) =>
          route.registrationMode === "federated_peer" && route.binding.hostId === peerHost));
        if (!catalog.complete || catalog.truncated) {
          const observedAt = this.now().toISOString();
          for (const route of routes) this.peerRouteViews.set(route.alias, { route: route.binding,
            state: "unobserved", observedAt, safeErrorCode: "PEER_CATALOG_INCOMPLETE" });
          return;
        }
        const authorityChanged = peerCatalogAuthorityChanged(prior, catalog);
        const viewChanged = peerCatalogViewChanged(prior, catalog);
        if (authorityChanged) {
          const before = routes;
          const reconciled = await this.store.reconcilePeerCatalog(peerHost, catalog);
          routes = [...reconciled.routes]; await this.finishSettlements(reconciled.settlements);
          for (const old of before) if (!routes.some((route) => route.alias === old.alias &&
            route.binding.registrationId === old.binding.registrationId)) {
            this.peerRouteViews.delete(old.alias); await this.reconcileUnadvertisement(old);
          }
          for (const route of routes) if (!before.some((old) => old.alias === route.alias &&
            old.binding.registrationId === route.binding.registrationId)) this.reconcileAdvertisement(route);
        }
        this.peerCatalogs.set(peerHost, catalog);
        const observedAt = this.now().toISOString();
        for (const route of routes) {
          const row = catalog.routes.find((candidate) => candidate.ref === route.binding.routeHandle);
          const state = row?.state === "idle" || row?.state === "busy" || row?.state === "awaiting_approval"
            ? row.state : "unobserved";
          this.peerRouteViews.set(route.alias, { route: route.binding, state, observedAt,
            ...(state === "unobserved" ? { safeErrorCode: row?.safeErrorCode ?? "PEER_ROUTE_STALE" } : {}) });
          if (row?.enabled === true) this.kick(route.alias, route.binding.registrationId);
        }
        if (viewChanged) this.revision += 1;
      } catch {
        this.peerClients.get(peerHost)?.close(); this.peerClients.delete(peerHost);
        if (!this.running || this.closing) return;
        this.recordPeerFailure(peerHost, failureCode);
        const observedAt = this.now().toISOString();
        for (const route of await this.store.inspectPrivateRoutes()) if (route.registrationMode === "federated_peer" &&
          route.binding.hostId === peerHost) this.peerRouteViews.set(route.alias, { route: route.binding,
            state: "unobserved", observedAt, safeErrorCode: "PEER_TUNNEL_UNAVAILABLE" });
      }
    }));
  }

  private async refreshClaudeDiscovery(): Promise<void> {
    const seen = new Set<string>();
    const nextCollisions = new Set<string>();
    const refreshedHosts = new Set<string>();
    for (const adapter of this.adapters) {
      if (adapter.identity.provider !== "claude" || adapter.discoverClaudePeers === undefined) continue;
      const snapshot = await adapter.discoverClaudePeers();
      const observedAt = this.now().toISOString();
      const peers = snapshot.peers.filter((peer) => PUBLIC_ALIAS.test(peer.alias) &&
        peer.alias.endsWith(`@${adapter.identity.hostId}`) && PRIVATE_HANDLE.test(peer.routeHandle));
      const aliasHandles = new Map<string, Set<string>>();
      for (const peer of peers) {
        const handles = aliasHandles.get(peer.alias) ?? new Set<string>();
        handles.add(peer.routeHandle); aliasHandles.set(peer.alias, handles);
      }
      const collidingAliases = new Set([...aliasHandles].filter(([, handles]) => handles.size > 1).map(([alias]) => alias));
      refreshedHosts.add(adapter.identity.hostId);
      if (!snapshot.complete) for (const alias of this.collidingClaudeAliases)
        if (alias.endsWith(`@${adapter.identity.hostId}`)) collidingAliases.add(alias);
      for (const alias of collidingAliases) nextCollisions.add(alias);
      for (const peer of peers) {
        const key = `${adapter.identity.hostId}\0${peer.routeHandle}`;
        seen.add(key);
        this.candidates.set(key, { ...peer, adapter, observedAt });
      }
      const runtime = this.connectors.get(connectorKey(adapter.identity));
      if (runtime !== undefined) {
        runtime.observedAt = observedAt;
        runtime.health = snapshot.complete ? "healthy" : "degraded";
        const registry = snapshot.registry ?? adapter.latestRegistryObservation?.();
        if (registry !== undefined) {
          runtime.registry = publicRegistry(
            { ...registry, rejected: [
              ...registry.rejected,
              ...(collidingAliases.size === 0 ? [] : [{ safeErrorCode: "PEER_ALIAS_COLLISION",
                count: collidingAliases.size }]),
            ] },
            runtime.registry?.parseableRecordSeenSinceBoot ?? false,
          );
        }
      }
    }
    for (const [key] of this.candidates) if (!seen.has(key)) this.candidates.delete(key);
    for (const alias of this.collidingClaudeAliases)
      if (refreshedHosts.has(aliasHost(alias))) this.collidingClaudeAliases.delete(alias);
    const retainedCollisions = new Set(
      [...nextCollisions].slice(0, gatewayPublicSnapshotLimits.availablePeers),
    );
    // Discovery currently caps rows such that collisions cannot overflow this independent public bound.
    // If those constants diverge, discard overflow candidates rather than expose an unfenced alias.
    for (const [key, candidate] of this.candidates)
      if (nextCollisions.has(candidate.alias) && !retainedCollisions.has(candidate.alias))
        this.candidates.delete(key);
    for (const alias of retainedCollisions)
      this.collidingClaudeAliases.add(alias);
  }

  private async refreshCodexDoctor(): Promise<void> {
    if (this.codexDoctor === undefined) return;
    this.codexDoctorResult = await this.codexDoctor();
  }

  private assertWritable(): void {
    if (this.closing || !this.running) {
      throw new BridgeError("GATEWAY_CLOSING", "The gateway is not accepting mutations.");
    }
  }

  private async resolveClaudeSelector(selector: string, refresh: boolean): Promise<Candidate | undefined> {
    if (refresh) await this.refreshClaudeDiscovery().catch(() => undefined);
    if (this.collidingClaudeAliases.has(selector))
      throw new BridgeError("PEER_ALIAS_COLLISION", "The Claude alias is ambiguous.");
    return [...this.candidates.values()].find(
      (candidate) => candidate.routeHandle === selector ||
        candidate.alias === selector,
    );
  }

  private async resolveSelectedClaudeRoute(selector: string): Promise<GatewayPrivateRouteInspection | undefined> {
    return (await this.store.listLogicalRoutes()).find(
      (route) =>
        route.binding.provider === "claude" &&
        (route.alias === selector || route.binding.routeHandle === selector),
    );
  }

  private routeObservationStillCurrent(event: GatewayAdapterRouteObservation): boolean {
    return this.connectors.has(connectorKey(event.route));
  }

  private alert(code: string, route?: GatewayPrivateRouteInspection, error?: unknown): void {
    const errorCode = error instanceof BridgeError ? error.code : undefined;
    this.runtimeAlerts.push({
      code: safeCode(errorCode, safeCode(code, "GATEWAY_RUNTIME_NOTICE")),
      severity: "warning",
      timestamp: this.now().toISOString(),
      ...(route === undefined ? {} : {
        provider: route.binding.provider,
        host: route.binding.hostId,
        alias: route.alias,
      }),
    });
    while (this.runtimeAlerts.length > gatewayPublicSnapshotLimits.alerts) this.runtimeAlerts.shift();
  }

  private recordPeerFailure(host: string, code?: "PEER_DIAL_FAILED" | "PEER_TUNNEL_UNAVAILABLE"): void {
    for (let index = this.runtimeAlerts.length - 1; index >= 0; index -= 1) {
      const alert = this.runtimeAlerts[index];
      if (alert?.host === host && (alert.code === "PEER_DIAL_FAILED" || alert.code === "PEER_TUNNEL_UNAVAILABLE"))
        this.runtimeAlerts.splice(index, 1);
    }
    if (code !== undefined) this.runtimeAlerts.push({ code, severity: "warning", timestamp: this.now().toISOString(), host });
  }
}
