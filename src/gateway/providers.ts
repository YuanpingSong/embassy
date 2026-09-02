import { createHash } from "node:crypto";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { isAttestedGatewayNodeInventory, type GatewayNodeInventory } from "./federation-nodes.js";
import {
  CLAUDE_PEER_COMPATIBILITY,
  ClaudePeerAdapter,
  type ClaudePeerDescriptor,
  type ClaudePeerDiscovery,
  type ClaudePeerInboundProgress,
} from "./claude-peer.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
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

const NATIVE_CLAUDE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const OPAQUE_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_CLAUDE_PENDING = 1_024;
const DEFAULT_CLAUDE_DISCOVERY_POLL_MS = 1_000;
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
  deliveryNotices: GatewayDeliveryNoticeMode,
) => ClaudePeerAdapter;

export type LocalClaudeGatewayProviderOptions = {
  /** Exact result of attestClaudePeerRuntime; paths are never rediscovered. */
  runtime: AttestedClaudePeerRuntime;
  /** Fixed controller-owned root re-attested by each selected-route dispatch. */
  stateRoot: string;
  hostId: string;
  nodeInventory: GatewayNodeInventory;
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

type ClaudePreparedGatewayDispatch = Readonly<{
  frameBytes: number;
  sha256: string;
  perform: () => Promise<GatewayAdapterDispatchResult>;
  cancel: () => void | Promise<void>;
}>;

type ClaudeSelectedRoute = {
  alias: string;
  registrationId?: string;
  stateRoot?: string;
  observation?: string;
  dispatchEpoch: number;
  observationDirty: boolean;
};

function exactLocalHost(hostId: string, inventory: GatewayNodeInventory): string {
  if (!isAttestedGatewayNodeInventory(inventory, hostId)) {
    throw new BridgeError(
      "GATEWAY_REMOTE_PROVIDER_DISABLED",
      "The local host coordinate requires the attested nodes.json inventory.",
    );
  }
  return hostId;
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

function sameEndpoint(
  binding: Readonly<{ provider: GatewayProvider; hostId: string }>,
  identity: Readonly<{ provider: GatewayProvider; hostId: string }>,
): boolean {
  return (
    binding.provider === identity.provider &&
    binding.hostId === identity.hostId
  );
}

function invokeCallback(operation: () => void): void {
  try {
    operation();
  } catch {
    // Provider observation consumers cannot change a transport outcome.
  }
}

function validateClaudeRuntimePathEvidence(
  runtime: AttestedClaudePeerRuntime,
): void {
  if (
    [runtime.sessionsDir, runtime.socketDir].some(
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

export class LocalClaudeGatewayProvider implements GatewayProviderAdapter {
  readonly identity: Readonly<{
    provider: "claude";
    hostId: string;
  }>;
  readonly protocol = "claude-peer";
  readonly protocolVersion = `${CLAUDE_PEER_COMPATIBILITY.peerProtocol}`;

  private readonly peer: ClaudePeerAdapter;
  private readonly stateRoot: string;
  private readonly maxPending: number;
  private readonly discoveryPollMs: number;
  private readonly now: () => number;
  private readonly nativeHelpers: ClaudeNativeHelperSupervisor | undefined;
  private readonly discovered = new Map<string, GatewayAdapterDiscovery>();
  /** Exact UUID selection plus its display-only observation bookkeeping. */
  private readonly selected = new Map<string, ClaudeSelectedRoute>();
  private discoveryInFlight:
    | Promise<GatewayAdapterDiscoverySnapshot>
    | undefined;
  private registryObservation: GatewayAdapterRegistryObservation | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private callbacks: GatewayAdapterCallbacks | undefined;
  private initialized = false;
  private closed = false;

  constructor(options: LocalClaudeGatewayProviderOptions) {
    validateClaudeRuntimePathEvidence(options.runtime);
    if (!path.isAbsolute(options.stateRoot) || options.stateRoot.includes("\0")) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "The Claude provider state root must be an absolute path.",
      );
    }
    const hostId = exactLocalHost(options.hostId, options.nodeInventory);
    this.identity = {
      provider: "claude",
      hostId,
    };
    this.stateRoot = options.stateRoot;
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
    const protocolRuntime = options.runtime;
    this.peer = (options.peerFactory ??
      ((runtime, deliveryNotices) =>
        new ClaudePeerAdapter({
          sessionsDir: runtime.sessionsDir,
          socketDir: runtime.socketDir,
          deliveryNotices,
        })))(
      protocolRuntime,
      options.deliveryNotices ?? "merged",
    );
    this.nativeHelpers =
      options.nativeHelpers === undefined
        ? undefined
        : new ClaudeNativeHelperSupervisor({
            identity: this.identity,
            runtime: protocolRuntime,
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
    this.initialized = true;
    return { health: "healthy" };
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
    const route = this.selected.get(routeHandle);
    const alias = route?.alias ?? this.discovered.get(routeHandle)?.alias;
    if (alias !== undefined) {
      this.selected.set(routeHandle, {
        alias,
        dispatchEpoch: route?.dispatchEpoch ?? 0,
        observationDirty: route?.observationDirty ?? false,
        ...(route?.registrationId === undefined ? {} : { registrationId: route.registrationId }),
        ...(route?.observation === undefined ? {} : { observation: route.observation }),
        stateRoot,
      });
    }
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
    const route = this.selected.get(input.routeHandle);
    this.selected.set(input.routeHandle, {
      alias: input.alias,
      dispatchEpoch: route?.dispatchEpoch ?? 0,
      observation: `${candidate.state}:`,
      observationDirty: false,
      ...(route?.registrationId === undefined ? {} : { registrationId: route.registrationId }),
      ...(route?.stateRoot === undefined ? {} : { stateRoot: route.stateRoot }),
    });
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
    const route = this.selected.get(input.routeHandle);
    this.selected.set(input.routeHandle, {
      alias: input.alias,
      registrationId: input.registrationId,
      stateRoot: this.stateRoot,
      dispatchEpoch: route?.dispatchEpoch ?? 0,
      observationDirty: route?.observationDirty ?? false,
      ...(route?.observation === undefined ? {} : { observation: route.observation }),
    });
  }

  forgetLogicalRoute(registrationId: string): void {
    for (const [routeHandle, route] of this.selected) {
      if (route.registrationId === registrationId) {
        this.selected.delete(routeHandle);
      }
    }
  }

  async resolveReplyAddress(
    address: string,
  ): Promise<{ routeHandle: string }> {
    this.assertReady();
    const resolved = await this.peer.resolveReplyAddress(address);
    const selectedAlias = this.selected.get(resolved.targetId)?.alias;
    if (
      selectedAlias === undefined ||
      (resolved.kind !== "interactive" && resolved.kind !== "bg") ||
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
    await this.helpers().advertise(input);
  }

  async unadvertiseNativeSourcePeer(alias: string): Promise<void> {
    await this.helpers().unadvertise(alias);
  }

  async updateNativeSourcePeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    await this.helpers().updateStatus(alias, status);
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    await this.helpers().updateInboundStatus(receiptHandle, status, diagnosticCode);
  }

  async notifyNativeInboundProgress(
    receiptHandle: string,
    progress: ClaudePeerInboundProgress,
  ): Promise<void> {
    await this.helpers().notifyInboundProgress(receiptHandle, progress);
  }

  async releaseNativeInboundReceipt(
    receiptHandle: string,
  ): Promise<boolean> {
    return await this.helpers().releaseInboundReceipt(receiptHandle);
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    if (
      !this.initialized ||
      this.closed ||
      !sameEndpoint(input.binding, this.identity)
    ) {
      return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
    }
    if (input.authorization === "selected_route") {
      const logical = this.selected.get(input.binding.routeHandle);
      if (
        logical === undefined ||
        logical.alias !== input.targetAlias ||
        logical.registrationId !== input.binding.registrationId
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      logical.dispatchEpoch += 1;
      logical.observationDirty = true;
      this.emitClaudeRouteObservation(input.binding.routeHandle, "busy");
    }

    let prepared: ClaudePreparedGatewayDispatch;
    try {
      const selected = this.selected.get(input.binding.routeHandle);
      prepared = await this.helpers().prepareDispatch({
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
        ...(selected?.alias === undefined ? {} : { selectedAlias: selected.alias }),
        ...(input.authorization !== "selected_route" || selected?.stateRoot === undefined
          ? {}
          : { stateRoot: selected.stateRoot }),
        ...(input.progressWatchActive === true ? { progressWatchActive: true as const } : {}),
      });
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

  async releaseRoute(routeHandle: string): Promise<void> {
    this.selected.delete(routeHandle);
    this.discovered.delete(routeHandle);
    if (this.selected.size === 0 && this.monitorTimer !== undefined) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.nativeHelpers?.close();
      await this.peer.close();
    } finally {
      this.selected.clear();
      this.discovered.clear();
      if (this.monitorTimer !== undefined) clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
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

  private helpers(): ClaudeNativeHelperSupervisor {
    this.assertReady();
    if (this.nativeHelpers === undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_UNAVAILABLE",
        "The supervised native Claude helper is unavailable.",
        true,
      );
    }
    return this.nativeHelpers;
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
    for (const [routeHandle, route] of this.selected) {
      dispatchEpochAtStart.set(routeHandle, route.dispatchEpoch);
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
        (peer.kind !== "interactive" && peer.kind !== "bg") ||
        !NATIVE_CLAUDE_NAME.test(peer.alias)
      ) {
        continue;
      }
      const alias = `${peer.alias}@${this.identity.hostId}`;
      if (!PUBLIC_ALIAS.test(alias)) continue;
      const row: GatewayAdapterDiscovery = {
        alias,
        routeHandle: peer.targetId,
        kind: peer.kind,
        state: claudeRouteState(peer),
      };
      this.discovered.set(peer.targetId, row);
      rows.push(row);
    }
    for (const [routeHandle, selected] of this.selected) {
      const row = this.discovered.get(routeHandle);
      if (row === undefined) {
        this.emitClaudeRouteObservation(
          routeHandle,
          "busy",
          "CLAUDE_PEER_NOT_OBSERVED",
          true,
        );
      } else {
        if (!discovery.truncated && row.alias !== selected.alias) {
          // A Claude rename changes only the live name index. The native
          // session UUID remains the selected logical route. An incomplete
          // scan is display evidence only and cannot rename dispatch authority.
          selected.alias = row.alias;
        }
        if (
          row.state === "idle" &&
          (dispatchEpochAtStart.get(routeHandle) !==
            selected.dispatchEpoch)
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
    const selected = this.selected.get(routeHandle);
    const mustPublish = authoritative && selected?.observationDirty === true;
    if (selected !== undefined && mustPublish) selected.observationDirty = false;
    if (!mustPublish && selected?.observation === signature) {
      return;
    }
    if (selected !== undefined) selected.observation = signature;
    const callbacks = this.callbacks;
    const registrationId = selected?.registrationId;
    if (
      callbacks === undefined ||
      this.closed ||
      registrationId === undefined
    ) {
      return;
    }
    invokeCallback(() =>
      callbacks.onRouteState({
        route: {
          ...this.identity,
          routeHandle,
          registrationId,
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
  nodeInventory: GatewayNodeInventory;
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
      !isAttestedGatewayNodeInventory(options.nodeInventory, options.hostId) ||
      options.operation === undefined ||
      typeof options.operation.execute !== "function"
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_PROVIDER_CONFIGURATION",
        "The stateless Codex provider requires the exact attested local host.",
      );
    }
    this.hostId = options.hostId;
    this.operation = options.operation;
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
    const timeout = this.timers.setTimeout(
      () => controller.abort(),
      this.observationTimeoutMs,
    );
    timeout.unref();
    try {
      observation = await this.operation.observe(
        {
          alias: route.alias,
          hostId: this.hostId,
          registrationId: route.registrationId,
          threadId: route.routeHandle,
        },
        controller.signal,
      );
    } finally {
      this.timers.clearTimeout(timeout);
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
