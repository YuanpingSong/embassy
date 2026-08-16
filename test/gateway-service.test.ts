import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AcpGatewayProvider } from "../src/gateway/acp-provider.js";
import {
  loadGatewayConfig as loadBaseGatewayConfig,
  type GatewayConfig,
} from "../src/gateway/config.js";
import type {
  GatewayControlHandlers,
  ValidatedRegisterCodexParams,
  ValidatedSendToClaudeParams,
  ValidatedSendToCodexParams,
} from "../src/gateway/control.js";
import {
  GatewayService,
  type GatewayAdapterCallbacks,
  type GatewayAdapterDelivery,
  type GatewayAdapterDiscovery,
  type GatewayAdapterDiscoverySnapshot,
  type GatewayAdapterDispatchInput,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterEndpointRefresh,
  type GatewayAdapterRouteObservationState,
  type GatewayAdapterRouteState,
  type GatewayAdapterRegistryObservation,
  type GatewayProviderAdapter,
} from "../src/gateway/service.js";
import {
  GatewayStore,
  type CodexSuccessionRecoveryAuthority,
} from "../src/gateway/store.js";
import type {
  GatewayPublicSnapshot,
  PrivateEndpointIdentity,
  PrivateRouteBinding,
} from "../src/gateway/types.js";
import { BridgeError } from "../src/errors.js";
import {
  createLocalClaudeGatewayProvider,
  createLocalCodexGatewayProvider,
} from "../src/gateway/providers.js";
import {
  LocalCodexTransportError,
  type LocalCodexOwnedTransport,
  type LocalCodexTransportFactory,
} from "../src/gateway/codex-local-transport.js";

/** Legacy scenario helper: tests opt into the former any-session policy. */
function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  return { ...loadBaseGatewayConfig(env), inboundMode: "open" };
}

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const OTHER_THREAD_ID = "00000000-0000-7000-8000-000000000702";
const THIRD_THREAD_ID = "00000000-0000-7000-8000-000000000703";
const CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000042";
const SECRET = "SYNTHETIC_BODY_MUST_STAY_MEMORY_ONLY_8e24";

function semanticSnapshot(generatedAt: string): GatewayPublicSnapshot {
  const counters = {
    accepted: 0,
    delivered: 0,
    unconfirmed: 0,
    failed: 0,
    ambiguous: 0,
    expired: 0,
    cancelled: 0,
    abandoned: 0,
    rejected: 0,
    bytesAccepted: 0,
  };
  return {
    schemaVersion: 2,
    generatedAt,
    inboundMode: "paired",
    health: "healthy",
    connectors: [
      {
        provider: "claude",
        host: "this-mac",
        health: "healthy",
        protocol: "claude-peer",
        protocolVersion: "1",
        lastSeenAt: generatedAt,
      },
    ],
    availablePeers: [],
    routes: [
      {
        alias: "codex-main@this-mac",
        provider: "codex",
        host: "this-mac",
        enabled: true,
        state: "idle",
        busyPolicy: "queue",
        lastSeenAt: generatedAt,
        queueDepth: 0,
        counters,
      },
    ],
    consentEdges: [],
    messages: [],
    accounting: {
      accepted: 0,
      duplicates: 0,
      delivered: 0,
      unconfirmed: 0,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 0,
      queuedBytes: 0,
    },
    alerts: [],
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      consentEdges: 0,
      messages: 0,
      alerts: 0,
    },
  };
}

function consentEdgeAliases(snapshot: GatewayPublicSnapshot): string[][] {
  return snapshot.consentEdges.map(({ endpoints }) => endpoints.map(({ alias }) => alias));
}

class MutableSnapshotStore extends GatewayStore {
  current: GatewayPublicSnapshot;

  constructor(
    config: ReturnType<typeof loadGatewayConfig>,
    snapshot: GatewayPublicSnapshot,
  ) {
    super(config);
    this.current = snapshot;
  }

  override async publicSnapshot(): Promise<GatewayPublicSnapshot> {
    return structuredClone(this.current);
  }
}

class UnprovablePreparedAuthorityStore extends GatewayStore {
  maskNextPreparedAuthority = false;

  override async inspectCodexSuccessionRecoveryAuthority(): Promise<CodexSuccessionRecoveryAuthority> {
    const authority = await super.inspectCodexSuccessionRecoveryAuthority();
    if (
      this.maskNextPreparedAuthority &&
      authority.authority === "old" &&
      authority.journal.stage === "prepared"
    ) {
      this.maskNextPreparedAuthority = false;
      return { authority: "none" };
    }
    return authority;
  }
}

class EndpointRefreshFaultStore extends GatewayStore {
  failReanchorBefore = 0;
  failReanchorAfter = 0;
  reanchorGate: Promise<void> | undefined;
  onReanchorEntered: (() => void) | undefined;

  override async reanchorCodexRoutes(
    input: Parameters<GatewayStore["reanchorCodexRoutes"]>[0],
  ): ReturnType<GatewayStore["reanchorCodexRoutes"]> {
    if (this.failReanchorBefore > 0) {
      this.failReanchorBefore -= 1;
      throw new BridgeError(
        "SYNTHETIC_REANCHOR_PRECOMMIT",
        "Synthetic pre-commit endpoint refresh failure.",
        true,
      );
    }
    this.onReanchorEntered?.();
    await this.reanchorGate;
    const result = await super.reanchorCodexRoutes(input);
    if (this.failReanchorAfter > 0) {
      this.failReanchorAfter -= 1;
      throw new BridgeError(
        "SYNTHETIC_REANCHOR_OUTCOME_UNKNOWN",
        "Synthetic endpoint refresh outcome uncertainty.",
      );
    }
    return result;
  }
}

class ProgressWatchResolutionStore extends GatewayStore {
  readonly resolutions: Array<
    Parameters<GatewayStore["resolveProgressWatchDispatch"]>[0]
  > = [];

  override async resolveProgressWatchDispatch(
    input: Parameters<GatewayStore["resolveProgressWatchDispatch"]>[0],
  ): ReturnType<GatewayStore["resolveProgressWatchDispatch"]> {
    this.resolutions.push(structuredClone(input));
    return await super.resolveProgressWatchDispatch(input);
  }
}

class OrphanRemovalFaultStore extends GatewayStore {
  failRemovalBefore = 0;
  failRemovalAfter = 0;

  override async removeStaleCodexOrphan(
    input: Parameters<GatewayStore["removeStaleCodexOrphan"]>[0],
  ): ReturnType<GatewayStore["removeStaleCodexOrphan"]> {
    if (this.failRemovalBefore > 0) {
      this.failRemovalBefore -= 1;
      throw new BridgeError(
        "SYNTHETIC_ORPHAN_REMOVAL_PRECOMMIT",
        "Synthetic orphan-removal persistence failure.",
        true,
      );
    }
    const result = await super.removeStaleCodexOrphan(input);
    if (this.failRemovalAfter > 0) {
      this.failRemovalAfter -= 1;
      throw new BridgeError(
        "SYNTHETIC_ORPHAN_REMOVAL_OUTCOME_UNKNOWN",
        "Synthetic post-commit orphan-removal failure.",
      );
    }
    return result;
  }
}

async function fixture(): Promise<{
  root: string;
  stateDir: string;
  workspace: string;
}> {
  const created = await mkdtemp(path.join(os.tmpdir(), "gateway-service-"));
  const root = await realpath(created);
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return { root, stateDir, workspace };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic dispatch timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("synthetic dispatch timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class ManualGatewayClock {
  nowMs = Date.parse("2026-08-08T12:00:00.000Z");
  private readonly jobs = new Map<
    ReturnType<typeof setTimeout>,
    { at: number; callback: () => void }
  >();

  readonly now = (): Date => new Date(this.nowMs);

  readonly setTimeout = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const handle = {
      unref(): void {},
    } as unknown as ReturnType<typeof setTimeout>;
    this.jobs.set(handle, {
      at: this.nowMs + Math.max(0, delayMs),
      callback,
    });
    return handle;
  };

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.jobs.delete(handle);
  };

  async advanceBy(milliseconds: number): Promise<void> {
    this.nowMs += milliseconds;
    for (;;) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined) break;
      this.jobs.delete(next[0]);
      next[1].callback();
      await immediate();
      await immediate();
    }
  }

}

class FakeProvider implements GatewayProviderAdapter {
  readonly identity: PrivateEndpointIdentity;
  readonly protocol: string;
  readonly protocolVersion: string;
  discoveries: GatewayAdapterDiscovery[] = [];
  discoveryComplete = true;
  callbacks: GatewayAdapterCallbacks | undefined;
  selectedEndpointRefresh: GatewayAdapterEndpointRefresh | undefined;
  activatedEndpointGenerations: string[] = [];
  activateEndpointGenerationBefore: (() => void) | undefined;
  releasedEndpointRefreshSelectorClaims: string[] = [];
  rearmedEndpointRefreshActivations: string[] = [];
  dispatches: GatewayAdapterDispatchInput[] = [];
  attested: string[] = [];
  selectedRoutes: Array<{ alias: string; routeHandle: string }> = [];
  selectRouteFailures: Error[] = [];
  selectRouteBeforeReturn: (() => void) | undefined;
  selectRouteGate: Promise<void> | undefined;
  releasedRoutes: string[] = [];
  selectedRouteHandleOverride: string | undefined;
  closed = false;
  registryObservation: GatewayAdapterRegistryObservation | undefined;
  closeError: Error | undefined;
  state: GatewayAdapterRouteState = "idle";
  dispatchResults: GatewayAdapterDispatchResult[] = [];
  synchronousDispatchDelivery: GatewayAdapterDelivery | undefined;
  nativeCodexStatuses: Array<{
    alias: string;
    status: "idle" | "busy" | "waiting";
  }> = [];
  nativeCodexAdvertisements: string[] = [];
  nativeCodexAdvertisementFailures: Array<{
    error: Error;
    afterWrite?: boolean;
  }> = [];
  nativeCodexUnadvertisements: string[] = [];
  nativeCodexUnadvertisementFailures: Error[] = [];
  nativeCodexUnadvertisementFailuresAfterRemove: Error[] = [];
  nativeCodexStatusFailures: Error[] = [];
  nativeCodexStatusAfterUpdate: (() => void) | undefined;
  nativeCodexActiveAlias: string | undefined;
  nativeCodexGenerations = new Map<string, string>();
  nativeCodexPreparedAlias: string | undefined;
  nativeCodexActiveGeneration = "initial";
  nativeCodexPreparedGeneration: string | undefined;
  nativeCodexRetiredGeneration: string | undefined;
  nativeCodexIngressQuiesced = false;
  nativeCodexMonitorFrozen = false;
  nativeSuccessionBarrierClean = true;
  nativeSuccessionBarrierBeforeReturn: (() => void) | undefined;
  codexSuccessionBarrierClean = true;
  codexRouteCreationInFlight = false;
  codexEndpointActivationRetryPending = false;
  currentNativeCodexGenerationFailures: Error[] = [];
  nativeSuccessionPublishOutcomes: Array<
    "published" | "not_published" | "unknown"
  > = [];
  successionFailures = new Map<string, Error[]>();
  nativeInboundStatuses: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];
  nativeInboundStatusAttempts: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];
  nativeInboundStatusFailures: Error[] = [];
  nativeInboundProgress: Array<{
    receiptHandle: string;
    reason:
      | "ROUTE_BUSY"
      | "CODEX_ROUTE_STALE"
      | "ROUTE_UNAVAILABLE"
      | "AWAITING_EXTERNAL_APPROVAL";
    queuedForMs: number;
  }> = [];
  nativeInboundProgressAttempts: Array<{
    receiptHandle: string;
    reason:
      | "ROUTE_BUSY"
      | "CODEX_ROUTE_STALE"
      | "ROUTE_UNAVAILABLE"
      | "AWAITING_EXTERNAL_APPROVAL";
    queuedForMs: number;
  }> = [];
  nativeInboundProgressFailures: Error[] = [];
  releasedNativeReceipts: string[] = [];
  lifecycleEvents: string[] = [];
  nativeMessageOnQuiesce:
    | Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
    | undefined;
  nativeMessageAfterSuccessionActivation:
    | Parameters<NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>>[0]
    | undefined;
  assertWorkspaceDisjoint?: (
    routeHandle: string,
    stateRoot: string,
  ) => Promise<void>;

  constructor(
    provider: PrivateEndpointIdentity["provider"],
    endpointGeneration = `generation_${provider}`,
    protocolVersion = "synthetic-1",
  ) {
    this.identity = {
      provider,
      hostId: "this-mac",
      endpointGeneration,
    };
    this.protocol = provider === "codex" ? "codex-app-server" : provider === "claude" ? "claude-peer" : "synthetic-acp";
    this.protocolVersion = protocolVersion;
    if (provider === "claude") {
      this.assertWorkspaceDisjoint = async (routeHandle) => {
        this.attested.push(routeHandle);
      };
    }
  }

  async initialize(callbacks: GatewayAdapterCallbacks) {
    this.callbacks = callbacks;
    this.activateEndpointGeneration(this.identity.endpointGeneration);
    return {
      health: "healthy" as const,
    };
  }

  async discoverClaudePeers(): Promise<GatewayAdapterDiscoverySnapshot> {
    return {
      peers: this.discoveries.map((peer) => ({ ...peer })),
      complete: this.discoveryComplete,
      ...(this.registryObservation === undefined
        ? {}
        : { registry: structuredClone(this.registryObservation) }),
    };
  }

  latestRegistryObservation(): GatewayAdapterRegistryObservation | undefined {
    return this.registryObservation === undefined
      ? undefined
      : structuredClone(this.registryObservation);
  }

  activateEndpointGeneration(endpointGeneration: string): void {
    this.activateEndpointGenerationBefore?.();
    if (endpointGeneration !== this.identity.endpointGeneration) {
      throw new BridgeError(
        "ENDPOINT_GENERATION_CHANGED",
        "Synthetic activation must match the adapter's exact current generation.",
      );
    }
    this.activatedEndpointGenerations.push(endpointGeneration);
  }

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{
    routeHandle: string;
    state: GatewayAdapterRouteState;
    endpointRefresh?: GatewayAdapterEndpointRefresh;
  }> {
    const failure = this.selectRouteFailures.shift();
    if (failure !== undefined) throw failure;
    this.selectedRoutes.push({ ...input });
    this.selectRouteBeforeReturn?.();
    const gate = this.selectRouteGate;
    this.selectRouteGate = undefined;
    await gate;
    return {
      routeHandle: this.selectedRouteHandleOverride ?? input.routeHandle,
      state: this.state,
      ...(this.selectedEndpointRefresh === undefined
        ? {}
        : { endpointRefresh: this.selectedEndpointRefresh }),
    };
  }

  releaseEndpointRefreshSelectorClaim(endpointGeneration: string): void {
    this.releasedEndpointRefreshSelectorClaims.push(endpointGeneration);
  }

  rearmEndpointRefreshActivation(endpointGeneration: string): void {
    this.rearmedEndpointRefreshActivations.push(endpointGeneration);
  }

  async releaseRoute(routeHandle: string): Promise<void> {
    if (this.codexEndpointActivationRetryPending) {
      throw new BridgeError(
        "CODEX_ENDPOINT_ACTIVATION_PENDING",
        "Synthetic endpoint activation retry still owns this task.",
      );
    }
    this.releasedRoutes.push(routeHandle);
  }

  async resolveReplyAddress(
    address: string,
  ): Promise<{ routeHandle: string }> {
    if (address !== "uds:/synthetic/claude.sock") {
      throw new BridgeError(
        "REPLY_ADDRESS_MISMATCH",
        "Synthetic unrelated socket.",
      );
    }
    return { routeHandle: "claude_target_1" };
  }

  async dispatch(
    input: GatewayAdapterDispatchInput,
  ): Promise<GatewayAdapterDispatchResult> {
    this.dispatches.push({ ...input, binding: { ...input.binding } });
    if (this.synchronousDispatchDelivery !== undefined) {
      this.callbacks?.onDelivery({
        ...this.synchronousDispatchDelivery,
        messageId: input.messageId,
      });
    }
    return (
      this.dispatchResults.shift() ??
      (this.identity.provider === "codex"
        ? { state: "accepted" }
        : { state: "pending" })
    );
  }

  async updateNativeSourcePeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    const failure = this.nativeCodexStatusFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeCodexStatuses.push({ alias, status });
    this.nativeCodexStatusAfterUpdate?.();
  }

  async advertiseNativeSourcePeer(input: {
    alias: string;
    sourceProvider: PrivateEndpointIdentity["provider"];
    cwd: string;
  }): Promise<void> {
    const failure = this.nativeCodexAdvertisementFailures.shift();
    if (failure?.afterWrite === true) {
      this.nativeCodexAdvertisements.push(input.alias);
      this.nativeCodexActiveAlias = input.alias;
      this.nativeCodexGenerations.set(
        input.alias,
        this.nativeCodexGenerations.size === 0
          ? "initial"
          : `initial_${this.nativeCodexGenerations.size + 1}`,
      );
    }
    if (failure !== undefined) throw failure.error;
    this.nativeCodexAdvertisements.push(input.alias);
    this.nativeCodexActiveAlias = input.alias;
    if (!this.nativeCodexGenerations.has(input.alias)) {
      this.nativeCodexGenerations.set(
        input.alias,
        this.nativeCodexGenerations.size === 0
          ? "initial"
          : `initial_${this.nativeCodexGenerations.size + 1}`,
      );
    }
    this.nativeCodexActiveGeneration = this.nativeCodexGenerations.get(
      input.alias,
    )!;
  }

  async unadvertiseNativeSourcePeer(alias: string): Promise<void> {
    this.lifecycleEvents.push(`native:unadvertise:${alias}`);
    const failure = this.nativeCodexUnadvertisementFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeCodexUnadvertisements.push(alias);
    this.nativeCodexGenerations.delete(alias);
    if (this.nativeCodexActiveAlias === alias) {
      this.nativeCodexActiveAlias = undefined;
    }
    const failureAfterRemove =
      this.nativeCodexUnadvertisementFailuresAfterRemove.shift();
    if (failureAfterRemove !== undefined) throw failureAfterRemove;
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    const row = {
      receiptHandle,
      status,
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    };
    this.nativeInboundStatusAttempts.push(row);
    this.lifecycleEvents.push(`status:${status}`);
    const failure = this.nativeInboundStatusFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeInboundStatuses.push(row);
  }

  async notifyNativeInboundProgress(
    receiptHandle: string,
    progress: {
      kind: "stall";
      reason:
        | "ROUTE_BUSY"
        | "CODEX_ROUTE_STALE"
        | "ROUTE_UNAVAILABLE"
        | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    },
  ): Promise<void> {
    this.nativeInboundProgressAttempts.push({
      receiptHandle,
      reason: progress.reason,
      queuedForMs: progress.queuedForMs,
    });
    const failure = this.nativeInboundProgressFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeInboundProgress.push({
      receiptHandle,
      reason: progress.reason,
      queuedForMs: progress.queuedForMs,
    });
    this.lifecycleEvents.push("progress:stall");
  }

  async releaseNativeInboundReceipt(receiptHandle: string): Promise<boolean> {
    this.releasedNativeReceipts.push(receiptHandle);
    this.lifecycleEvents.push("receipt:release");
    return true;
  }

  async quiesceNativeInbound(): Promise<void> {
    this.lifecycleEvents.push("provider:quiesce-native");
    if (this.nativeMessageOnQuiesce !== undefined) {
      this.callbacks?.onClaudeMessage?.(this.nativeMessageOnQuiesce);
      this.nativeMessageOnQuiesce = undefined;
    }
  }

  private maybeFailSuccession(step: string): void {
    const failures = this.successionFailures.get(step);
    const failure = failures?.shift();
    if (failure !== undefined) throw failure;
  }

  currentNativeCodexPeerGeneration(alias: string): string {
    const failure = this.currentNativeCodexGenerationFailures.shift();
    if (failure !== undefined) throw failure;
    this.maybeFailSuccession("current");
    const generation = this.nativeCodexGenerations.get(alias);
    if (generation === undefined) {
      throw new BridgeError(
        "CODEX_PEER_GENERATION_MISMATCH",
        "Synthetic active alias mismatch.",
      );
    }
    this.nativeCodexActiveAlias = alias;
    this.nativeCodexActiveGeneration = generation;
    return generation;
  }

  async prepareNativeCodexPeerGeneration(input: {
    alias: string;
    cwd: string;
    generation: string;
  }): Promise<void> {
    this.lifecycleEvents.push(`succession:prepare:${input.generation}`);
    this.maybeFailSuccession("prepare");
    this.nativeCodexPreparedGeneration = input.generation;
    this.nativeCodexPreparedAlias = input.alias;
  }

  async quiesceNativeCodexPeerGeneration(generation: string): Promise<void> {
    this.lifecycleEvents.push(`succession:quiesce:${generation}`);
    this.maybeFailSuccession("quiesce");
    if (generation !== this.nativeCodexActiveGeneration) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "Synthetic quiesce generation mismatch.",
      );
    }
    this.nativeCodexIngressQuiesced = true;
    this.nativeCodexMonitorFrozen = true;
    if (this.nativeMessageOnQuiesce !== undefined) {
      this.callbacks?.onClaudeMessage?.(this.nativeMessageOnQuiesce);
      this.nativeMessageOnQuiesce = undefined;
    }
  }

  observeNativeCodexSuccessionBarrier(generation: string): {
    generation: string;
    activeGenerationMatched: boolean;
    ingressQuiesced: boolean;
    monitorFrozen: boolean;
    discoveryInFlight: boolean;
    pendingOutboundReceipts: number;
    pendingInboundReceipts: number;
    rejectedInboundSettlements: number;
    clean: boolean;
  } {
    this.lifecycleEvents.push(`succession:barrier-claude:${generation}`);
    this.maybeFailSuccession("claude_barrier");
    const activeGenerationMatched =
      generation === this.nativeCodexActiveGeneration;
    this.nativeSuccessionBarrierBeforeReturn?.();
    return {
      generation,
      activeGenerationMatched,
      ingressQuiesced: this.nativeCodexIngressQuiesced,
      monitorFrozen: this.nativeCodexMonitorFrozen,
      discoveryInFlight: false,
      pendingOutboundReceipts: 0,
      pendingInboundReceipts: 0,
      rejectedInboundSettlements: 0,
      clean:
        this.nativeSuccessionBarrierClean &&
        activeGenerationMatched &&
        this.nativeCodexIngressQuiesced &&
        this.nativeCodexMonitorFrozen,
    };
  }

  async publishPreparedNativeCodexPeer(input: {
    currentGeneration: string;
    preparedGeneration: string;
  }): Promise<"published" | "not_published" | "unknown"> {
    this.lifecycleEvents.push(
      `succession:publish:${input.currentGeneration}:${input.preparedGeneration}`,
    );
    this.maybeFailSuccession("publish");
    return this.nativeSuccessionPublishOutcomes.shift() ?? "published";
  }

  activatePreparedNativeCodexPeerGeneration(generation: string): void {
    this.lifecycleEvents.push(`succession:activate:${generation}`);
    this.maybeFailSuccession("activate");
    if (this.nativeCodexPreparedGeneration !== generation) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "Synthetic activation generation mismatch.",
      );
    }
    const retiredAlias = this.nativeCodexActiveAlias;
    this.nativeCodexRetiredGeneration = this.nativeCodexActiveGeneration;
    this.nativeCodexActiveGeneration = generation;
    this.nativeCodexActiveAlias = this.nativeCodexPreparedAlias;
    if (retiredAlias !== undefined) this.nativeCodexGenerations.delete(retiredAlias);
    if (this.nativeCodexActiveAlias !== undefined) {
      this.nativeCodexGenerations.set(
        this.nativeCodexActiveAlias,
        generation,
      );
    }
    this.nativeCodexPreparedAlias = undefined;
    this.nativeCodexPreparedGeneration = undefined;
    this.nativeCodexIngressQuiesced = false;
    this.nativeCodexMonitorFrozen = false;
    if (this.nativeMessageAfterSuccessionActivation !== undefined) {
      this.callbacks?.onClaudeMessage?.(
        this.nativeMessageAfterSuccessionActivation,
      );
      this.nativeMessageAfterSuccessionActivation = undefined;
    }
  }

  async cleanupPreparedNativeCodexPeerGeneration(
    generation: string,
  ): Promise<void> {
    this.lifecycleEvents.push(`succession:cleanup-prepared:${generation}`);
    this.maybeFailSuccession("cleanup_prepared");
    if (this.nativeCodexPreparedGeneration === generation) {
      this.nativeCodexPreparedGeneration = undefined;
      this.nativeCodexPreparedAlias = undefined;
    }
  }

  resumeNativeCodexPeerGeneration(generation: string): void {
    this.lifecycleEvents.push(`succession:resume:${generation}`);
    this.maybeFailSuccession("resume");
    if (generation !== this.nativeCodexActiveGeneration) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "Synthetic resume generation mismatch.",
      );
    }
    this.nativeCodexIngressQuiesced = false;
    this.nativeCodexMonitorFrozen = false;
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
    this.lifecycleEvents.push(
      `succession:retire:${input.retiredGeneration}:${input.protectedActiveGeneration}`,
    );
    this.maybeFailSuccession("retire");
    if (
      this.nativeCodexRetiredGeneration !== input.retiredGeneration ||
      this.nativeCodexActiveGeneration !== input.protectedActiveGeneration
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_GENERATION_MISMATCH",
        "Synthetic retirement generation mismatch.",
      );
    }
    this.nativeCodexRetiredGeneration = undefined;
  }

  purgeNativeCodexPeerGenerationReplyCapabilities(generation: string): number {
    this.lifecycleEvents.push(`succession:purge:${generation}`);
    this.maybeFailSuccession("purge");
    return 0;
  }

  observeRouteSuccessionBarrier(routeHandle: string): {
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
  } {
    this.lifecycleEvents.push(`succession:barrier-codex:${routeHandle}`);
    this.maybeFailSuccession("codex_barrier");
    const routePresent = this.selectedRoutes.some(
      (route) => route.routeHandle === routeHandle,
    ) && !this.releasedRoutes.includes(routeHandle);
    return {
      routePresent,
      connection: routePresent ? "ready" : "absent",
      routeStatus: routePresent ? this.state : "absent",
      queueDepth: 0,
      hasActiveTurn: false,
      requestInFlight: false,
      routeCreationInFlight:
        this.codexRouteCreationInFlight ||
        this.codexEndpointActivationRetryPending,
      routeReleaseInFlight: false,
      pendingReplyCorrelations: 0,
      pendingCallbacks: 0,
      clean:
        this.codexSuccessionBarrierClean &&
        !this.codexRouteCreationInFlight &&
        !this.codexEndpointActivationRetryPending &&
        routePresent &&
        this.state === "idle",
    };
  }

  emitDelivery(event: GatewayAdapterDelivery): void {
    this.callbacks?.onDelivery(event);
  }

  emitClaudeReply(text: string): void {
    this.callbacks?.onClaudeReply({
      endpoint: { ...this.identity, routeHandle: "claude_target_1" },
      text,
    });
  }

  emitRouteState(
    routeHandle: string,
    state: GatewayAdapterRouteObservationState,
    safeErrorCode?: string,
  ): void {
    this.callbacks?.onRouteState({
      endpoint: { ...this.identity, routeHandle },
      state,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    });
  }

  async close(): Promise<void> {
    this.lifecycleEvents.push("provider:close");
    this.closed = true;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

function codexRegistration(): ValidatedRegisterCodexParams {
  return {
    alias: "codex-main@this-mac",
    threadId: THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  };
}

function successorCodexRegistration(): ValidatedRegisterCodexParams {
  return {
    alias: "codex-next@this-mac",
    threadId: OTHER_THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
    succeedsAlias: "codex-main@this-mac",
  };
}

function successorExactRegistration(): ValidatedRegisterCodexParams {
  return {
    alias: "codex-next@this-mac",
    threadId: OTHER_THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  };
}

function independentCodexRegistration(): ValidatedRegisterCodexParams {
  return {
    alias: "codex-side@this-mac",
    threadId: THIRD_THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  };
}

type SyntheticServiceCodexTransport = LocalCodexOwnedTransport & {
  readonly sent: Array<Record<string, unknown>>;
  disconnectUnexpectedly(): void;
  emit(message: unknown): void;
};

function syntheticServiceCodexFactory(input: Readonly<{
  version: string;
  endpointGeneration: string;
  connectFailureAt?: Readonly<{ attempt: number; error: Error }>;
  missingThreadAt?: number;
  closeFailureAt?: Readonly<{ attempt: number; error: Error }>;
}>): {
  factory: LocalCodexTransportFactory;
  evidence: {
    connectAttempts: number;
    endpointGenerationChanged: boolean;
    methods: string[];
    transports: SyntheticServiceCodexTransport[];
  };
} {
  const evidence = {
    connectAttempts: 0,
    endpointGenerationChanged: false,
    methods: [] as string[],
    transports: [] as SyntheticServiceCodexTransport[],
  };
  const factory = {
    appServerVersion: input.version,
    endpointGeneration: input.endpointGeneration,
    hostId: "this-mac",
    protocol: "codex-app-server" as const,
    protocolVersion: input.version,
    close: async () => undefined,
    connectTransport: async (): Promise<LocalCodexOwnedTransport> => {
      evidence.connectAttempts += 1;
      const attempt = evidence.connectAttempts;
      if (evidence.endpointGenerationChanged) {
        throw new LocalCodexTransportError("ENDPOINT_GENERATION_CHANGED");
      }
      if (input.connectFailureAt?.attempt === attempt) {
        throw input.connectFailureAt.error;
      }
      let cleanupConfirmed = false;
      const messageListeners = new Set<(payload: string) => void>();
      const closeListeners = new Set<() => void>();
      const errorListeners = new Set<() => void>();
      const sent: Array<Record<string, unknown>> = [];
      const transport = {
        sent,
        get cleanupConfirmed() {
          return cleanupConfirmed;
        },
        onMessage(listener: (payload: string) => void): () => void {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onClose(listener: () => void): () => void {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        onError(listener: () => void): () => void {
          errorListeners.add(listener);
          return () => errorListeners.delete(listener);
        },
        async send(payload: string): Promise<void> {
          const request = JSON.parse(payload) as {
            id?: unknown;
            method?: unknown;
          };
          sent.push(request);
          const method =
            typeof request.method === "string" ? request.method : "";
          evidence.methods.push(method);
          let result: unknown;
          if (method === "initialize") {
            result = { platformFamily: "unix", platformOs: "darwin" };
          } else if (method === "thread/loaded/list") {
            result = {
              data: input.missingThreadAt === attempt ? [] : [THREAD_ID],
            };
          } else if (method === "thread/resume") {
            result = {
              approvalPolicy: "never",
              cwd: "/synthetic/workspace",
              sandbox: { networkAccess: false, type: "readOnly" },
              thread: {
                id: THREAD_ID,
                status: { type: "idle" },
                turns: [],
              },
            };
          } else if (method === "thread/unsubscribe") {
            result = { status: "unsubscribed" };
          } else if (method === "turn/start") {
            result = { turn: { id: "turn-service-1", status: "inProgress" } };
          } else {
            result = {};
          }
          if (request.id !== undefined) {
            const response = JSON.stringify({ id: request.id, result });
            for (const listener of messageListeners) listener(response);
          }
        },
        disconnectUnexpectedly(): void {
          for (const listener of [...closeListeners]) listener();
        },
        emit(message: unknown): void {
          const payload = JSON.stringify(message);
          for (const listener of [...messageListeners]) listener(payload);
        },
        async close(): Promise<void> {
          if (cleanupConfirmed) return;
          if (input.closeFailureAt?.attempt === attempt) {
            throw input.closeFailureAt.error;
          }
          cleanupConfirmed = true;
          for (const listener of closeListeners) listener();
        },
      } satisfies SyntheticServiceCodexTransport;
      evidence.transports.push(transport);
      return transport;
    },
  } as unknown as LocalCodexTransportFactory;
  return { factory, evidence };
}

function toClaude(text = SECRET): ValidatedSendToClaudeParams {
  return {
    fromAlias: "codex-main@this-mac",
    threadId: THREAD_ID,
    toAlias: "claude-one@this-mac",
    text,
    expectsReply: true,
  };
}

function toCodex(replyAddress: string): ValidatedSendToCodexParams {
  return {
    fromAlias: "claude-one@this-mac",
    toAlias: "codex-main@this-mac",
    text: SECRET,
    replyAddress,
    expectsReply: true,
  };
}

function dispatchProvenance(input: GatewayAdapterDispatchInput): {
  sourceAlias: string;
  targetAlias: string;
  conversationId: string;
  text: string;
} {
  return {
    sourceAlias: input.sourceAlias,
    targetAlias: input.targetAlias,
    conversationId: input.conversationId,
    text: input.text,
  };
}

async function selectAndRegister(
  handlers: GatewayControlHandlers,
): Promise<void> {
  const refreshed = await handlers.refreshDashboard();
  assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.code, "ok");
  assert.equal(Number.isSafeInteger(refreshed.revision), true);
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.selectClaude({
      alias: "claude-one@this-mac",
      codexThreadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
}

async function discoverAndRegisterCodexOnly(
  handlers: GatewayControlHandlers,
): Promise<void> {
  const refreshed = await handlers.refreshDashboard();
  assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.code, "ok");
  assert.equal(Number.isSafeInteger(refreshed.revision), true);
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
}

test("config-owned ACP routes register at boot before any subprocess exists", async (t) => {
  const current = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const deepseek = new AcpGatewayProvider({
    provider: "deepseek",
    alias: "dsh-main@this-mac",
    hostId: "this-mac",
    unavailableCode: "DEEPSEEK_HARNESS_HOME_UNAVAILABLE",
    endpointGeneration: "deepseek_generation",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({ EMBASSY_STATE_DIR: current.stateDir }),
    adapters: [claude, codex, deepseek],
  });
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  });
  await service.start();
  await service.handlers().registerCodex(codexRegistration());
  const snapshot = await service.handlers().listSnapshot();
  const route = snapshot.routes.find(({ alias }) => alias === "dsh-main@this-mac");
  assert.equal(route?.provider, "deepseek");
  assert.equal(route?.state, "idle");
  assert.equal(
    snapshot.connectors.find(({ provider }) => provider === "deepseek")?.health,
    "degraded",
  );
  assert.deepEqual(await service.handlers().pair({
    aliases: ["codex-main@this-mac", "dsh-main@this-mac"],
  }), { accepted: true, code: "ok" });
});

test("status carries bounded registry evidence from startup and remembers parseable records", async (t) => {
  const current = await fixture();
  t.after(async () => {
    await rm(current.root, { recursive: true, force: true });
  });
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  claude.registryObservation = {
    entriesScanned: 0,
    parseableRecords: 0,
    rejected: [],
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: current.stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  t.after(async () => {
    await service.close().catch(() => undefined);
  });
  await service.start();

  const startup = await service.handlers().listSnapshot();
  assert.deepEqual(
    startup.connectors.find((connector) => connector.provider === "claude")
      ?.registry,
    {
      entriesScanned: 0,
      parseableRecords: 0,
      parseableRecordSeenSinceBoot: false,
      rejected: [],
      rejectedCodesOmitted: 0,
    },
  );

  claude.registryObservation = {
    entriesScanned: 4,
    parseableRecords: 1,
    rejected: [
      { safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 2 },
      { safeErrorCode: "PID_MISMATCH", count: 1 },
      { safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 1 },
    ],
  };
  await service.handlers().refreshDashboard();
  const observed = await service.handlers().listSnapshot();
  assert.deepEqual(
    observed.connectors.find((connector) => connector.provider === "claude")
      ?.registry,
    {
      entriesScanned: 4,
      parseableRecords: 1,
      parseableRecordSeenSinceBoot: true,
      rejected: [
        { safeErrorCode: "PID_MISMATCH", count: 1 },
        { safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 3 },
      ],
      rejectedCodesOmitted: 0,
    },
  );

  claude.registryObservation = {
    entriesScanned: 0,
    parseableRecords: 0,
    rejected: [],
  };
  await service.handlers().refreshDashboard();
  const emptyAfterValid = await service.handlers().listSnapshot();
  assert.equal(
    emptyAfterValid.connectors.find(
      (connector) => connector.provider === "claude",
    )?.registry?.parseableRecordSeenSinceBoot,
    true,
  );
});

test("an unsafe Claude sessions directory quarantines only Claude", async (t) => {
  const current = await fixture();
  const sessionsDir = path.join(current.root, "claude-sessions");
  const socketDir = path.join(current.root, "claude-sockets");
  await Promise.all([
    mkdir(sessionsDir, { mode: 0o700 }),
    mkdir(socketDir, { mode: 0o700 }),
  ]);
  await chmod(sessionsDir, 0o755);
  // Claude's socket root is shared provider infrastructure; its mode remains
  // intentionally outside Embassy's exact private-session policy.
  await chmod(socketDir, 0o755);
  const claude = createLocalClaudeGatewayProvider({
    runtime: {
      claudeExecutable: "/synthetic/claude/2.1.227",
      claudeCodeVersion: "2.1.227",
      sessionsDir,
      socketDir,
    },
  });
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: current.stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  });

  await service.start();
  assert.notEqual(codex.callbacks, undefined);
  assert.deepEqual(await service.handlers().health(), {
    status: "ok",
    revision: 0,
  });
  const snapshot = await service.handlers().listSnapshot();
  assert.deepEqual(
    snapshot.connectors
      .filter(({ provider }) => provider === "claude")
      .map(({ health, safeErrorCode, registry }) => ({
        health,
        safeErrorCode,
        registry,
      })),
    [
      {
        health: "degraded",
        safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE",
        registry: {
          entriesScanned: 0,
          parseableRecords: 0,
          parseableRecordSeenSinceBoot: false,
          rejected: [
            { safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE", count: 1 },
          ],
          rejectedCodesOmitted: 0,
        },
      },
    ],
  );
  assert.deepEqual(
    snapshot.alerts
      .filter(({ code }) => code === "CLAUDE_REGISTRY_UNAVAILABLE")
      .map(({ severity }) => severity),
    ["warning"],
  );
});

test("boot reactivation rethrows endpoint trust failures after exact cleanup", async (t) => {
  const current = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: current.stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstCodex = new FakeProvider("codex");
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), firstCodex],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const secondCodex = new FakeProvider("codex");
  secondCodex.selectRouteFailures.push(
    new LocalCodexTransportError("LOCAL_APP_SERVER_ENDPOINT_UNSAFE"),
  );
  const second = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), secondCodex],
  });
  t.after(async () => {
    await second.close().catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  });

  await assert.rejects(
    second.start(),
    (error: unknown) =>
      error instanceof LocalCodexTransportError &&
      error.code === "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
  );
  assert.deepEqual(secondCodex.selectedRoutes, []);
  assert.deepEqual(secondCodex.releasedRoutes, []);
  const persisted = JSON.parse(
    await readFile(first.store.stateFilePath, "utf8"),
  ) as {
    routes: Array<{
      alias: string;
      binding: { endpointGeneration: string };
      state: string;
    }>;
  };
  const retained = persisted.routes.find(
    ({ alias }) => alias === "codex-main@this-mac",
  );
  assert.equal(
    retained?.binding.endpointGeneration,
    firstCodex.identity.endpointGeneration,
  );
  // Failed startup never commits its in-memory restart migration; the prior
  // binary's exact durable route remains untouched.
  assert.equal(retained?.state, "idle");
});

test("boot reactivation keeps every bounded Codex trust failure fatal", async (t) => {
  for (const code of [
    "CODEX_ROUTE_CLEANUP_FAILED",
    "CODEX_ENDPOINT_GENERATION_CHURN",
    "CODEX_FACTORY_ATTESTATION_INVALID",
  ] as const) {
    await t.test(code, async () => {
      const current = await fixture();
      const config = loadGatewayConfig({
        EMBASSY_STATE_DIR: current.stateDir,
        EMBASSY_HOSTS: "this-mac",
      });
      const first = new GatewayService({
        config,
        adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
      });
      await first.start();
      await first.handlers().registerCodex(codexRegistration());
      await first.close();

      const codex = new FakeProvider("codex");
      codex.selectRouteFailures.push(
        new BridgeError(code, "synthetic bounded boot trust failure"),
      );
      const second = new GatewayService({
        config,
        adapters: [new FakeProvider("claude"), codex],
      });
      try {
        await assert.rejects(
          second.start(),
          (error: unknown) =>
            error instanceof BridgeError && error.code === code,
        );
      } finally {
        await second.close().catch(() => undefined);
        await rm(current.root, { recursive: true, force: true });
      }
    });
  }
});

test("boot reactivation skips transient native registry publication failures", async (t) => {
  for (const code of ["REGISTRY_RACED", "REGISTRY_TOO_LARGE"] as const) {
    await t.test(code, async () => {
      const current = await fixture();
      const config = loadGatewayConfig({
        EMBASSY_STATE_DIR: current.stateDir,
        EMBASSY_HOSTS: "this-mac",
      });
      const first = new GatewayService({
        config,
        adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
      });
      await first.start();
      await first.handlers().registerCodex(codexRegistration());
      await first.close();

      const claude = new FakeProvider("claude");
      claude.nativeCodexAdvertisementFailures.push({
        error: new BridgeError(code, "synthetic transient registry failure"),
      });
      const codex = new FakeProvider("codex");
      const second = new GatewayService({ config, adapters: [claude, codex] });
      try {
        await second.start();
        assert.equal(
          (await second.handlers().listSnapshot()).routes.find(
            ({ alias }) => alias === "codex-main@this-mac",
          )?.state,
          "stale",
        );
        assert.deepEqual(codex.releasedRoutes, [THREAD_ID]);
        assert.deepEqual(claude.nativeCodexUnadvertisements, [
          "codex-main@this-mac",
        ]);
      } finally {
        await second.close().catch(() => undefined);
        await rm(current.root, { recursive: true, force: true });
      }
    });
  }
});

test("retained boot reactivation preserves real Codex route trust and cleanup failures", async (t) => {
  for (const scenario of [
    {
      name: "unsafe endpoint attachment",
      expectedCode: "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
      factoryInput: {
        connectFailureAt: {
          attempt: 1,
          error: new LocalCodexTransportError(
            "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
          ),
        },
      },
    },
    {
      name: "unconfirmed route cleanup",
      expectedCode: "CLEANUP_FAILED",
      factoryInput: {
        missingThreadAt: 1,
        closeFailureAt: {
          attempt: 1,
          error: new LocalCodexTransportError("CLEANUP_FAILED"),
        },
      },
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const current = await fixture();
      const config = loadGatewayConfig({
        EMBASSY_STATE_DIR: current.stateDir,
        EMBASSY_HOSTS: "this-mac",
      });
      const firstCodex = new FakeProvider("codex");
      const first = new GatewayService({
        config,
        adapters: [new FakeProvider("claude"), firstCodex],
      });
      await first.start();
      await first.handlers().registerCodex(codexRegistration());
      await first.close();

      const observed = syntheticServiceCodexFactory({
        version: "0.147.0",
        endpointGeneration: "codex_real_boot_g2",
        ...scenario.factoryInput,
      });
      const codex = createLocalCodexGatewayProvider({
        factory: observed.factory,
      });
      const second = new GatewayService({
        config,
        adapters: [new FakeProvider("claude"), codex],
      });
      try {
        await assert.rejects(
          second.start(),
          (error: unknown) =>
            error instanceof LocalCodexTransportError &&
            error.code === scenario.expectedCode,
        );
        assert.equal(observed.evidence.connectAttempts, 1);
        const retained = JSON.parse(
          await readFile(first.store.stateFilePath, "utf8"),
        ) as {
          routes: Array<{
            alias: string;
            binding: { endpointGeneration: string };
            state: string;
          }>;
        };
        assert.equal(
          retained.routes.find(
            ({ alias }) => alias === "codex-main@this-mac",
          )?.binding.endpointGeneration,
          firstCodex.identity.endpointGeneration,
        );
      } finally {
        await second.close().catch(() => undefined);
        await rm(current.root, { recursive: true, force: true });
      }
    });
  }
});

test("retained boot reactivation preserves unsafe native-helper evidence", async (t) => {
  const current = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: current.stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  let helperFactoryCalls = 0;
  const claude = createLocalClaudeGatewayProvider({
    runtime: {
      claudeExecutable: "/synthetic/claude/2.1.227",
      claudeCodeVersion: "2.1.227",
      sessionsDir: "/synthetic/claude/sessions",
      socketDir: "/synthetic/claude/sockets",
    },
    peerFactory: () =>
      ({
        discover: async () => ({
          peers: [],
          rejected: {},
          truncated: false,
          entriesScanned: 0,
          parseableRecords: 0,
        }),
        close: async () => undefined,
      }) as never,
    nativeHelpers: {
      maxHelpers: 1,
      factory: async () => {
        helperFactoryCalls += 1;
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_UNSAFE",
          "synthetic unsafe callback evidence",
        );
      },
    },
  });
  const codex = new FakeProvider("codex");
  const second = new GatewayService({ config, adapters: [claude, codex] });
  t.after(async () => {
    await second.close().catch(() => undefined);
    await rm(current.root, { recursive: true, force: true });
  });

  await assert.rejects(
    second.start(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_CALLBACK_UNSAFE",
  );
  assert.equal(helperFactoryCalls, 1);
  assert.deepEqual(codex.releasedRoutes, [THREAD_ID]);
});

test("aborted startup cannot become active after an in-flight adapter initialization resumes", async () => {
  const { root, stateDir } = await fixture();
  const provider = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  let markInitializeEntered: (() => void) | undefined;
  let releaseInitialize: (() => void) | undefined;
  const initializeEntered = new Promise<void>((resolve) => {
    markInitializeEntered = resolve;
  });
  const initializeMayFinish = new Promise<void>((resolve) => {
    releaseInitialize = resolve;
  });
  let markCloseEntered: (() => void) | undefined;
  let releaseClose: (() => void) | undefined;
  const closeEntered = new Promise<void>((resolve) => {
    markCloseEntered = resolve;
  });
  const closeMayFinish = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  provider.initialize = async (callbacks) => {
    provider.callbacks = callbacks;
    markInitializeEntered?.();
    await initializeMayFinish;
    return { health: "healthy" };
  };
  provider.close = async () => {
    markCloseEntered?.();
    await closeMayFinish;
    provider.closed = true;
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [provider, codex],
  });
  const abort = new AbortController();

  try {
    const starting = service.start(abort.signal);
    await initializeEntered;
    abort.abort();
    releaseInitialize?.();
    await closeEntered;
    let concurrentCloseSettled = false;
    const closing = service.close().then(() => {
      concurrentCloseSettled = true;
    });
    await immediate();
    assert.equal(concurrentCloseSettled, false);
    releaseClose?.();

    await assert.rejects(
      starting,
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_START_CANCELLED",
    );
    await closing;
    assert.equal(concurrentCloseSettled, true);
    assert.equal(provider.closed, true);
    assert.equal((await service.handlers().health()).status, "degraded");
  } finally {
    releaseInitialize?.();
    releaseClose?.();
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent service close callers join the same provider cleanup", async () => {
  const { root, stateDir } = await fixture();
  const provider = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  let closeCalls = 0;
  let markCloseEntered: (() => void) | undefined;
  let releaseClose: (() => void) | undefined;
  const closeEntered = new Promise<void>((resolve) => {
    markCloseEntered = resolve;
  });
  const closeMayFinish = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  provider.close = async () => {
    closeCalls += 1;
    markCloseEntered?.();
    await closeMayFinish;
    provider.closed = true;
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [provider, codex],
  });

  try {
    await service.start();
    const first = service.close();
    await closeEntered;
    let secondSettled = false;
    const second = service.close().then(() => {
      secondSettled = true;
    });
    await immediate();
    assert.equal(secondSettled, false);
    assert.equal(closeCalls, 1);
    releaseClose?.();
    await Promise.all([first, second]);
    assert.equal(closeCalls, 1);
    assert.equal(secondSettled, true);
  } finally {
    releaseClose?.();
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex registration requires the native codex-* namespace", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    await service.handlers().registerCodex({
      ...codexRegistration(),
      alias: "reviewer@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal((await service.handlers().listSnapshot()).routes.length, 0);
});

for (const failurePoint of [
  "advertise_clean",
  "advertise_after_write",
  "status",
] as const) {
  test(`a fresh Codex ${failurePoint} failure rolls back and leaves identity unlocked`, async (t) => {
    const { root, stateDir } = await fixture();
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    if (failurePoint === "status") {
      claude.nativeCodexStatusFailures.push(new Error("synthetic status failure"));
    } else {
      claude.nativeCodexAdvertisementFailures.push({
        error: new Error("synthetic advertisement failure"),
        ...(failurePoint === "advertise_after_write"
          ? { afterWrite: true }
          : {}),
      });
    }
    const service = new GatewayService({
      config: loadGatewayConfig({
        EMBASSY_STATE_DIR: stateDir,
        EMBASSY_HOSTS: "this-mac",
      }),
      adapters: [claude, codex],
    });
    await service.start();
    t.after(async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const handlers = service.handlers();

    assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
      accepted: false,
      code: "rejected",
    });
    assert.deepEqual((await handlers.listSnapshot()).routes, []);
    assert.deepEqual(codex.releasedRoutes, [THREAD_ID]);
    assert.deepEqual(claude.nativeCodexUnadvertisements, [
      "codex-main@this-mac",
    ]);

    assert.deepEqual(
      await handlers.registerCodex({
        ...codexRegistration(),
        alias: "codex-next@this-mac",
      }),
      { accepted: true, code: "ok" },
    );
    assert.deepEqual(
      (await handlers.listSnapshot()).routes.map(({ alias }) => alias),
      ["codex-next@this-mac"],
    );
  });
}

test("incomplete fresh-registration rollback pins the provisional Codex identity", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.nativeCodexAdvertisementFailures.push({
    error: new Error("synthetic post-write failure"),
    afterWrite: true,
  });
  claude.nativeCodexUnadvertisementFailures.push(
    new Error("synthetic cleanup failure"),
  );
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: false,
    code: "rejected",
  });
  assert.deepEqual((await handlers.listSnapshot()).routes, []);
  const selectedBeforeConflict = codex.selectedRoutes.length;
  assert.deepEqual(
    await handlers.registerCodex({
      ...codexRegistration(),
      alias: "codex-next@this-mac",
    }),
    { accepted: false, code: "conflict" },
  );
  assert.equal(codex.selectedRoutes.length, selectedBeforeConflict);
  assert.deepEqual(claude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
  ]);
});

test("a failed exact Codex re-registration preserves its existing route and queue", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);
  codex.state = "busy";
  codex.emitRouteState(THREAD_ID, "busy");
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, state }) =>
        alias === "codex-main@this-mac" && state === "busy",
    ),
  );
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "preserve this queued synthetic body",
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );

  claude.nativeCodexStatusFailures.push(new Error("synthetic status failure"));
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: false,
    code: "rejected",
  });
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      ({ direction, state }) =>
        direction === "claude_to_codex" && state === "held",
    ),
    true,
  );
  assert.deepEqual(codex.releasedRoutes, []);
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
});

test("failed boot Codex reactivation preserves its identity for exact manual recovery", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  assert.deepEqual(
    await first.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  secondClaude.nativeCodexStatusFailures.push(
    new Error("synthetic status failure"),
  );
  const secondCodex = new FakeProvider("codex");
  second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  assert.equal(
    (await second.handlers().listSnapshot()).routes.find(
      ({ alias }) => alias === "codex-main@this-mac",
    )?.state,
    "stale",
  );
  assert.deepEqual(
    await second.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.equal(
    (await second.handlers().listSnapshot()).routes.some(
      ({ alias }) => alias === "codex-main@this-mac",
    ),
    true,
  );
  const selectedBeforeConflict = secondCodex.selectedRoutes.length;
  assert.deepEqual(
    await second.handlers().registerCodex({
      ...codexRegistration(),
      alias: "codex-next@this-mac",
    }),
    { accepted: false, code: "conflict" },
  );
  assert.equal(secondCodex.selectedRoutes.length, selectedBeforeConflict);
  assert.deepEqual(secondCodex.releasedRoutes, [THREAD_ID]);
  assert.deepEqual(secondClaude.nativeCodexUnadvertisements, [
    "codex-main@this-mac",
  ]);
});

test("broker restart reactivates an exact Codex task and wakes its durable queue", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  firstClaude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const firstCodex = new FakeProvider("codex", "codex_boot_generation_g1");
  firstCodex.state = "busy";
  const first = new GatewayService({
    config,
    adapters: [firstClaude, firstCodex],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  await selectAndRegister(first.handlers());
  const accepted = await first.handlers().sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "durable mail wakes after broker restart",
  });
  assert.equal(accepted.accepted, true);
  await waitForAsync(async () =>
    (await first.handlers().listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  const secondCodex = new FakeProvider("codex", "codex_boot_generation_g2");
  second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  await waitFor(() => secondCodex.dispatches.length === 1);

  assert.deepEqual(secondCodex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
  assert.deepEqual(secondClaude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
  ]);
  assert.equal(
    secondCodex.dispatches[0]?.text,
    "durable mail wakes after broker restart",
  );
  assert.deepEqual(
    consentEdgeAliases(await second.handlers().listSnapshot()),
    [["claude-one@this-mac", "codex-main@this-mac"]],
  );
  const route = await second.store.inspectPrivateRoute(
    "codex-main@this-mac",
  );
  assert.equal(
    route?.binding.endpointGeneration,
    "codex_boot_generation_g2",
  );
  const persisted = JSON.parse(
    await readFile(second.store.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshEvents: Array<{
      sequence: number;
      timestamp: string;
      alias: string;
      hostId: string;
      threadId: string;
      oldEndpointGeneration: string;
      newEndpointGeneration: string;
      reason?: string;
    }>;
  };
  assert.deepEqual(persisted.codexEndpointRefreshEvents, [
    {
      sequence: 1,
      timestamp: persisted.codexEndpointRefreshEvents[0]?.timestamp,
      alias: "codex-main@this-mac",
      hostId: "this-mac",
      threadId: THREAD_ID,
      oldEndpointGeneration: "codex_boot_generation_g1",
      newEndpointGeneration: "codex_boot_generation_g2",
      reason: "boot_reactivation",
    },
  ]);
  const publicText = JSON.stringify(await second.handlers().listSnapshot());
  assert.equal(publicText.includes(THREAD_ID), false);
  assert.equal(publicText.includes("codex_boot_generation_g2"), false);
});

test("boot reactivation completes a compatible daemon-generation change in flight", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [
      new FakeProvider("claude"),
      new FakeProvider("codex", "codex_boot_churn_g1", "0.147.0"),
    ],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_boot_churn_g2", "0.147.0");
  const previous = { ...codex.identity };
  const current = {
    ...codex.identity,
    endpointGeneration: "codex_boot_churn_g3",
  };
  codex.selectedEndpointRefresh = {
    previous,
    current,
    routes: [],
  };
  codex.selectRouteBeforeReturn = () => {
    codex.identity.endpointGeneration = current.endpointGeneration;
  };
  second = new GatewayService({ config, adapters: [claude, codex] });
  await second.start();

  const route = await second.store.inspectPrivateRoute(
    "codex-main@this-mac",
  );
  assert.equal(route?.binding.endpointGeneration, current.endpointGeneration);
  assert.equal(route?.state, "idle");
  assert.deepEqual(claude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
  ]);
  assert.equal(codex.activatedEndpointGenerations.length, 2);
  assert.deepEqual(codex.releasedRoutes, []);
  const persisted = JSON.parse(
    await readFile(second.store.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshEvents: Array<{
      oldEndpointGeneration: string;
      newEndpointGeneration: string;
      reason?: string;
    }>;
  };
  assert.deepEqual(
    persisted.codexEndpointRefreshEvents.map(
      ({ oldEndpointGeneration, newEndpointGeneration, reason }) => ({
        oldEndpointGeneration,
        newEndpointGeneration,
        reason,
      }),
    ),
    [
      {
        oldEndpointGeneration: "codex_boot_churn_g1",
        newEndpointGeneration: "codex_boot_churn_g3",
        reason: "boot_reactivation",
      },
    ],
  );
});

test("boot endpoint refresh aborts when native activation fails after staging", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstCodex = new FakeProvider(
    "codex",
    "codex_boot_activation_failure_g1",
    "0.147.0",
  );
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), firstCodex],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const claude = new FakeProvider("claude");
  claude.nativeCodexAdvertisementFailures.push({
    error: new Error("synthetic boot advertisement failure"),
    afterWrite: false,
  });
  const codex = new FakeProvider(
    "codex",
    "codex_boot_activation_failure_g2",
    "0.147.0",
  );
  codex.selectedEndpointRefresh = {
    previous: { ...firstCodex.identity },
    current: { ...codex.identity },
    routes: [],
  };
  second = new GatewayService({ config, adapters: [claude, codex] });
  await assert.rejects(
    second.start(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_BOOT_REACTIVATION_CLEANUP_FAILED",
  );
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  assert.deepEqual(codex.releasedRoutes, [THREAD_ID]);
  assert.deepEqual(claude.nativeCodexUnadvertisements, [
    "codex-main@this-mac",
  ]);
  const persisted = JSON.parse(
    await readFile(first.store.stateFilePath, "utf8"),
  ) as {
    routes: Array<{
      alias: string;
      binding: { endpointGeneration: string };
    }>;
    codexEndpointRefreshEvents: unknown[];
  };
  assert.equal(
    persisted.routes.find(({ alias }) => alias === "codex-main@this-mac")
      ?.binding.endpointGeneration,
    firstCodex.identity.endpointGeneration,
  );
  assert.deepEqual(persisted.codexEndpointRefreshEvents, []);
});

test("a retained Codex route permits a distinct registered task after restart", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  assert.deepEqual(
    await first.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  const secondCodex = new FakeProvider("codex");
  second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  assert.deepEqual(
    await second.handlers().registerCodex({
      ...codexRegistration(),
      alias: "codex-next@this-mac",
      threadId: OTHER_THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(secondCodex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
    { alias: "codex-next@this-mac", routeHandle: OTHER_THREAD_ID },
  ]);
  assert.deepEqual(secondClaude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
    "codex-next@this-mac",
  ]);
  assert.deepEqual(
    (await second.handlers().listSnapshot()).routes.map(({ alias }) => alias),
    ["codex-main@this-mac", "codex-next@this-mac"],
  );
});

test("concurrent duplicate-task registrations serialize to one alias owner", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    await Promise.all([
      service.handlers().registerCodex(codexRegistration()),
      service.handlers().registerCodex({
        ...codexRegistration(),
        alias: "codex-next@this-mac",
      }),
    ]),
    [
      { accepted: true, code: "ok" },
      { accepted: false, code: "conflict" },
    ],
  );
  assert.deepEqual(codex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
  assert.deepEqual(claude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
  ]);
});

test("multiple distinct Codex registrations coexist and unregister independently", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();

  assert.deepEqual(
    await Promise.all([
      handlers.registerCodex(codexRegistration()),
      handlers.registerCodex(independentCodexRegistration()),
    ]),
    [
      { accepted: true, code: "ok" },
      { accepted: true, code: "ok" },
    ],
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).routes.map((route) => route.alias),
    ["codex-main@this-mac", "codex-side@this-mac"],
  );

  assert.deepEqual(
    await handlers.unregisterCodex({
      alias: codexRegistration().alias,
      threadId: codexRegistration().threadId,
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).routes.map((route) => route.alias),
    ["codex-side@this-mac"],
  );
  assert.equal(claude.nativeCodexGenerations.has("codex-side@this-mac"), true);
});

test("a compatible Codex endpoint refresh reanchors exact tasks and preserves pair authority", async (t) => {
  const { root, stateDir } = await fixture();
  const beforeGeneration = "codex_generation_before_refresh";
  const afterGeneration = "codex_generation_after_refresh";
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider(
    "codex",
    beforeGeneration,
    "0.147.0",
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);
  assert.deepEqual(
    consentEdgeAliases(await handlers.listSnapshot()),
    [["claude-one@this-mac", "codex-main@this-mac"]],
  );

  codex.state = "busy";
  codex.emitRouteState(THREAD_ID, "busy");
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, state }) =>
        alias === "codex-main@this-mac" && state === "busy",
    ),
  );
  const queued = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "queued mail survives a live endpoint refresh",
  });
  assert.equal(queued.accepted, true);
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );

  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = afterGeneration;
  codex.callbacks?.onEndpointRefresh?.({
    previous,
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "busy" }],
  });
  // G2 can become idle after the provider freezes its transition evidence but
  // before the controller installs G2's durable binding.
  codex.emitRouteState(THREAD_ID, "idle");

  await waitForAsync(async () =>
    (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration === afterGeneration,
  );
  await waitFor(() => codex.dispatches.length === 1);
  let snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes
      .filter(({ provider }) => provider === "codex")
      .map(({ alias, state }) => ({
        alias,
        state,
      })),
    [
      {
        alias: "codex-main@this-mac",
        state: "idle",
      },
    ],
  );
  assert.deepEqual(
    consentEdgeAliases(snapshot),
    [["claude-one@this-mac", "codex-main@this-mac"]],
  );
  assert.deepEqual(
    snapshot.activityEvents
      ?.filter(({ action }) => action === "endpoint_refreshed")
      .map(({ kind, outcome, aliases, operatorAction }) => ({
        kind,
        outcome,
        aliases,
        operatorAction,
      })),
    [
      {
        kind: "endpoint",
        outcome: "accepted",
        aliases: ["codex-main@this-mac"],
        operatorAction: false,
      },
    ],
  );
  const privateRoute = await service.store.inspectPrivateRoute(
    "codex-main@this-mac",
  );
  assert.equal(privateRoute?.binding.routeHandle, THREAD_ID);
  assert.equal(privateRoute?.binding.endpointGeneration, afterGeneration);
  assert.equal(
    codex.dispatches[0]?.text,
    "queued mail survives a live endpoint refresh",
  );
  assert.equal(
    snapshot.messages.some(
      ({ body, state }) =>
        body === "queued mail survives a live endpoint refresh" &&
        state === "abandoned",
    ),
    false,
  );
  const persisted = JSON.parse(
    await readFile(service.store.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshEvents: Array<{
      sequence: number;
      timestamp: string;
      alias: string;
      hostId: string;
      threadId: string;
      oldEndpointGeneration: string;
      newEndpointGeneration: string;
    }>;
  };
  assert.deepEqual(persisted.codexEndpointRefreshEvents, [
    {
      sequence: 1,
      timestamp: persisted.codexEndpointRefreshEvents[0]?.timestamp,
      alias: "codex-main@this-mac",
      hostId: "this-mac",
      threadId: THREAD_ID,
      oldEndpointGeneration: beforeGeneration,
      newEndpointGeneration: afterGeneration,
    },
  ]);

  // A callback carrying the retired exact endpoint cannot stale the rebound
  // route even though its native task handle is unchanged.
  codex.callbacks?.onRouteState({
    endpoint: { ...previous, routeHandle: THREAD_ID },
    state: "stale",
    safeErrorCode: "CODEX_ROUTE_STALE",
  });
  await immediate();
  await immediate();
  assert.equal(
    (await handlers.listSnapshot()).routes.find(
      ({ alias }) => alias === "codex-main@this-mac",
    )?.state,
    "idle",
  );

  assert.deepEqual(
    await handlers.registerCodex(independentCodexRegistration()),
    { accepted: true, code: "ok" },
  );
  snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes
      .filter(({ provider }) => provider === "codex")
      .map(({ alias }) => alias),
    ["codex-main@this-mac", "codex-side@this-mac"],
  );
  const publicText = JSON.stringify(snapshot);
  for (const privateValue of [
    THREAD_ID,
    THIRD_THREAD_ID,
    beforeGeneration,
    afterGeneration,
  ]) {
    assert.equal(publicText.includes(privateValue), false);
  }
});

test("a real Codex provider reanchors runtime routes and drains mail after endpoint restart", async (t) => {
  const { root, stateDir } = await fixture();
  const first = syntheticServiceCodexFactory({
    version: "0.147.0",
    endpointGeneration: "codex_runtime_reanchor_g1",
  });
  const second = syntheticServiceCodexFactory({
    version: "0.147.0",
    endpointGeneration: "codex_runtime_reanchor_g2",
  });
  let refreshCalls = 0;
  const codex = createLocalCodexGatewayProvider({
    factory: first.factory,
    refreshFactory: async () => {
      refreshCalls += 1;
      return second.factory;
    },
    recoveryInitialMs: 60_000,
    recoveryMaxMs: 60_000,
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const firstRoute = first.evidence.transports.find((transport) =>
    transport.sent.some((message) => message.method === "thread/resume"),
  )!;
  firstRoute.emit({
    method: "thread/status/changed",
    params: { status: { type: "active" }, threadId: THREAD_ID },
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) => route.alias === "codex-main@this-mac" && route.state === "busy",
    ),
  );
  const queued = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "queued across the endpoint restart",
    expectsReply: false,
  });
  assert.equal(queued.accepted, true, JSON.stringify(queued));
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) => route.alias === "codex-main@this-mac" && route.queueDepth === 1,
    ),
  );

  first.evidence.endpointGenerationChanged = true;
  firstRoute.disconnectUnexpectedly();
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) =>
        route.alias === "codex-main@this-mac" &&
        route.state === "stale" &&
        route.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
  );
  const degraded = await handlers.listSnapshot();
  assert.equal(
    degraded.routes.some((route) => route.alias === "codex-main@this-mac"),
    true,
  );

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  await waitForAsync(
    async () =>
      (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
        .endpointGeneration === "codex_runtime_reanchor_g2",
  );
  await waitFor(() =>
    second.evidence.transports.some((transport) =>
      transport.sent.some((message) => message.method === "turn/start"),
    ),
  );
  assert.equal(refreshCalls, 1);
  const queuedStatus = await handlers.deliveryStatus({
    token: queued.deliveryToken,
  });
  assert.equal(queuedStatus.found, true);
  if (!queuedStatus.found) assert.fail("queued delivery status was evicted");
  assert.equal(queuedStatus.state, "delivered");

  const secondRoute = second.evidence.transports.find((transport) =>
    transport.sent.some((message) => message.method === "turn/start"),
  )!;
  secondRoute.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-service-1", status: "completed" },
    },
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) => route.alias === "codex-main@this-mac" && route.state === "idle",
    ),
  );
  const fresh = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "new mail after the endpoint restart",
    expectsReply: false,
  });
  assert.equal(fresh.accepted, true);
  await waitFor(
    () =>
      second.evidence.transports
        .flatMap((transport) => transport.sent)
        .filter((message) => message.method === "turn/start").length >= 2,
  );
  const freshStatus = await handlers.deliveryStatus({
    token: fresh.deliveryToken,
  });
  assert.equal(freshStatus.found, true);
  if (!freshStatus.found) assert.fail("fresh delivery status was evicted");
  assert.equal(freshStatus.state, "delivered");
  assert.equal(
    (await handlers.listSnapshot()).activityEvents?.some(
      (event) => event.action === "endpoint_refreshed",
    ),
    true,
  );
  const persisted = JSON.parse(
    await readFile(service.store.stateFilePath, "utf8"),
  ) as { codexEndpointRefreshEvents: unknown[] };
  assert.equal(persisted.codexEndpointRefreshEvents.length, 1);
});

test("endpoint refresh retries complete once across precommit, uncertain-commit, and native-update failures", async () => {
  for (const failurePoint of [
    "before_reanchor",
    "after_reanchor",
    "native_status",
  ] as const) {
    const { root, stateDir } = await fixture();
    const config = loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    });
    const store = new EndpointRefreshFaultStore(config);
    if (failurePoint === "before_reanchor") store.failReanchorBefore = 1;
    if (failurePoint === "after_reanchor") store.failReanchorAfter = 1;
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider(
      "codex",
      `codex_${failurePoint}_g1`,
      "0.147.0",
    );
    const service = new GatewayService({
      config,
      store,
      adapters: [claude, codex],
    });
    try {
      await service.start();
      await service.handlers().registerCodex(codexRegistration());
      if (failurePoint === "native_status") {
        claude.nativeCodexStatusFailures.push(
          new Error("synthetic refreshed status failure"),
        );
      }
      const previous = { ...codex.identity };
      codex.identity.endpointGeneration = `codex_${failurePoint}_g2`;
      const refresh: GatewayAdapterEndpointRefresh = {
        previous,
        current: { ...codex.identity },
        routes: [{ routeHandle: THREAD_ID, state: "idle" }],
      };
      codex.callbacks?.onEndpointRefresh?.(refresh);
      await waitForAsync(async () => {
        const internal = service as unknown as {
          callbackWorker?: Promise<void>;
        };
        return (
          internal.callbackWorker === undefined &&
          store.failReanchorBefore === 0 &&
          store.failReanchorAfter === 0 &&
          claude.nativeCodexStatusFailures.length === 0
        );
      });
      assert.equal(
        codex.activatedEndpointGenerations.length,
        1,
        failurePoint,
      );
      assert.deepEqual(
        codex.releasedEndpointRefreshSelectorClaims,
        [codex.identity.endpointGeneration],
        failurePoint,
      );

      codex.callbacks?.onEndpointRefresh?.(refresh);
      await waitForAsync(
        async () =>
          codex.activatedEndpointGenerations.length === 2 &&
          (await store.inspectPrivateRoute("codex-main@this-mac"))?.binding
            .endpointGeneration === codex.identity.endpointGeneration,
      );
      const persisted = JSON.parse(
        await readFile(store.stateFilePath, "utf8"),
      ) as { codexEndpointRefreshEvents: unknown[] };
      assert.equal(persisted.codexEndpointRefreshEvents.length, 1);
      assert.equal(
        (await service.handlers().listSnapshot()).activityEvents?.filter(
          ({ action }) => action === "endpoint_refreshed",
        ).length,
        1,
      );
      codex.callbacks?.onEndpointRefresh?.(refresh);
      await immediate();
      await immediate();
      assert.equal(codex.activatedEndpointGenerations.length, 2);
      assert.equal(
        (
          JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
            codexEndpointRefreshEvents: unknown[];
          }
        ).codexEndpointRefreshEvents.length,
        1,
      );
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("endpoint refresh activation requires one exact live native listener and status method", async (t) => {
  for (const failurePoint of [
    "listener_missing",
    "status_method_missing",
    "listener_exits_after_status",
    "listener_exits_during_publish",
  ] as const) {
    const { root, stateDir } = await fixture();
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider(
      "codex",
      `codex_native_continuity_${failurePoint}_g1`,
      "0.147.0",
    );
    let removeListenerDuringPublish = false;
    const service = new GatewayService({
      config: loadGatewayConfig({
        EMBASSY_STATE_DIR: stateDir,
        EMBASSY_HOSTS: "this-mac",
      }),
      adapters: [claude, codex],
      publishDashboard: async () => {
        if (removeListenerDuringPublish) {
          claude.nativeCodexGenerations.delete("codex-main@this-mac");
          removeListenerDuringPublish = false;
        }
        return "<html></html>";
      },
    });
    await service.start();
    t.after(async () => {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    await service.handlers().registerCodex(codexRegistration());
    const listenerGeneration = claude.nativeCodexGenerations.get(
      "codex-main@this-mac",
    )!;
    const originalUpdate =
      claude.updateNativeSourcePeerStatus.bind(claude);
    if (failurePoint === "listener_missing") {
      claude.nativeCodexGenerations.delete("codex-main@this-mac");
    } else if (failurePoint === "status_method_missing") {
      (claude as unknown as Record<string, unknown>)[
        "updateNativeSourcePeerStatus"
      ] = undefined;
    } else if (failurePoint === "listener_exits_after_status") {
      claude.nativeCodexStatusAfterUpdate = () => {
        claude.nativeCodexGenerations.delete("codex-main@this-mac");
        claude.nativeCodexStatusAfterUpdate = undefined;
      };
    } else {
      removeListenerDuringPublish = true;
    }

    const previous = { ...codex.identity };
    codex.identity.endpointGeneration =
      `codex_native_continuity_${failurePoint}_g2`;
    const refresh: GatewayAdapterEndpointRefresh = {
      previous,
      current: { ...codex.identity },
      routes: [{ routeHandle: THREAD_ID, state: "idle" }],
    };
    codex.callbacks?.onEndpointRefresh?.(refresh);
    await waitForAsync(async () => {
      const internal = service as unknown as {
        callbackWorker?: Promise<void>;
      };
      const route = await service.store.inspectPrivateRoute(
        "codex-main@this-mac",
      );
      return (
        internal.callbackWorker === undefined &&
        route?.binding.endpointGeneration ===
          codex.identity.endpointGeneration &&
        route.state === "stale"
      );
    });
    assert.equal(codex.activatedEndpointGenerations.length, 1);
    assert.equal(
      (await service.handlers().listSnapshot()).routes.find(
        ({ alias }) => alias === "codex-main@this-mac",
      )?.state,
      "stale",
    );
    assert.deepEqual(codex.releasedEndpointRefreshSelectorClaims, [
      codex.identity.endpointGeneration,
    ]);

    claude.nativeCodexGenerations.set(
      "codex-main@this-mac",
      listenerGeneration,
    );
    claude.nativeCodexActiveAlias = "codex-main@this-mac";
    claude.nativeCodexActiveGeneration = listenerGeneration;
    (
      claude as unknown as {
        updateNativeSourcePeerStatus: FakeProvider["updateNativeSourcePeerStatus"];
      }
    ).updateNativeSourcePeerStatus = originalUpdate;
    codex.callbacks?.onRouteState?.({
      endpoint: { ...codex.identity, routeHandle: THREAD_ID },
      state: "idle",
    });
    await waitFor(
      () => codex.rearmedEndpointRefreshActivations.length === 1,
    );
    codex.callbacks?.onRouteState?.({
      endpoint: { ...codex.identity, routeHandle: THREAD_ID },
      state: "idle",
    });
    await immediate();
    await immediate();
    assert.deepEqual(codex.rearmedEndpointRefreshActivations, [
      codex.identity.endpointGeneration,
    ]);
    codex.callbacks?.onEndpointRefresh?.(refresh);
    await waitForAsync(
      async () => codex.activatedEndpointGenerations.length === 2,
    );
    assert.equal(
      (await service.handlers().listSnapshot()).routes.find(
        ({ alias }) => alias === "codex-main@this-mac",
      )?.state,
      "idle",
    );
  }
});

test("an uncertain durable reanchor can fail closed natively and then retry exactly", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const store = new EndpointRefreshFaultStore(config);
  store.failReanchorAfter = 1;
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_uncertain_native_g1", "0.147.0");
  const service = new GatewayService({ config, store, adapters: [claude, codex] });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  const listenerGeneration = claude.nativeCodexGenerations.get(
    "codex-main@this-mac",
  )!;
  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = "codex_uncertain_native_g2";
  const refresh: GatewayAdapterEndpointRefresh = {
    previous,
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "idle" }],
  };

  codex.callbacks?.onEndpointRefresh?.(refresh);
  await waitForAsync(async () => {
    const internal = service as unknown as { callbackWorker?: Promise<void> };
    return internal.callbackWorker === undefined && store.failReanchorAfter === 0;
  });
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  assert.equal(
    (await store.inspectPrivateRoute("codex-main@this-mac"))?.state,
    "stale",
  );
  claude.nativeCodexGenerations.delete("codex-main@this-mac");

  codex.callbacks?.onEndpointRefresh?.(refresh);
  await waitForAsync(
    async () =>
      (await store.inspectPrivateRoute("codex-main@this-mac"))?.state ===
      "stale",
  );
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  claude.nativeCodexGenerations.set(
    "codex-main@this-mac",
    listenerGeneration,
  );
  claude.nativeCodexActiveAlias = "codex-main@this-mac";
  claude.nativeCodexActiveGeneration = listenerGeneration;

  codex.callbacks?.onEndpointRefresh?.(refresh);
  await waitForAsync(
    async () =>
      codex.activatedEndpointGenerations.length === 2 &&
      (await store.inspectPrivateRoute("codex-main@this-mac"))?.state ===
        "idle",
  );
  const persisted = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    codexEndpointRefreshEvents: unknown[];
  };
  assert.equal(persisted.codexEndpointRefreshEvents.length, 1);
  assert.equal(
    (await service.handlers().listSnapshot()).activityEvents?.filter(
      ({ action }) => action === "endpoint_refreshed",
    ).length,
    1,
  );
});

test("a selector refresh preserves pre-return queued ingress across the generation boundary", async (t) => {
  const { root, stateDir } = await fixture();
  const beforeGeneration = "codex_selector_drain_g1";
  const afterGeneration = "codex_selector_drain_g2";
  const receiptHandle = "receipt-selector-drain";
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", beforeGeneration, "0.147.0");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  codex.callbacks?.onRouteState?.({
    endpoint: { ...codex.identity, routeHandle: THREAD_ID },
    state: "busy",
  });
  await waitForAsync(
    async () =>
      (await service.store.inspectPrivateRoute("codex-main@this-mac"))
        ?.state === "busy",
  );

  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = afterGeneration;
  codex.selectedEndpointRefresh = {
    previous,
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "idle" }],
  };
  codex.selectRouteBeforeReturn = () => {
    codex.selectRouteBeforeReturn = undefined;
    claude.callbacks?.onClaudeMessage?.({
      endpoint: {
        ...claude.identity,
        routeHandle: "claude_selector_drain_source",
      },
      sourceAlias: "claude-selector@this-mac",
      targetAlias: "codex-main@this-mac",
      text: "must settle before selector generation activation",
      receiptHandle,
    });
  };
  let queuedReceiptPreservedAtActivation = false;
  codex.activateEndpointGenerationBefore = () => {
    assert.equal(
      claude.nativeInboundStatuses.some(
        (status) =>
          status.receiptHandle === receiptHandle &&
          status.status === "expired" &&
          status.diagnosticCode === "ENDPOINT_GENERATION_CHANGED",
      ),
      false,
    );
    queuedReceiptPreservedAtActivation = true;
  };

  assert.deepEqual(
    await service.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.equal(queuedReceiptPreservedAtActivation, true);
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(
    codex.dispatches[0]?.text,
    "must settle before selector generation activation",
  );
  await waitFor(() =>
    claude.nativeInboundStatuses.some(
      (status) =>
        status.receiptHandle === receiptHandle &&
        status.status === "delivered",
    ),
  );
  assert.equal(
    (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration,
    afterGeneration,
  );
});

test("a selector refresh activates retained tasks before installing its fresh task", async (t) => {
  const { root, stateDir } = await fixture();
  const beforeGeneration = "codex_selector_refresh_g1";
  const afterGeneration = "codex_selector_refresh_g2";
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", beforeGeneration, "0.147.0");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = afterGeneration;
  codex.selectedEndpointRefresh = {
    previous,
    current: { ...codex.identity },
    routes: [
      { routeHandle: THREAD_ID, state: "idle" },
      { routeHandle: OTHER_THREAD_ID, state: "idle" },
    ],
  };

  assert.deepEqual(
    await service.handlers().registerCodex({
      alias: "codex-fresh@this-mac",
      threadId: OTHER_THREAD_ID,
      hostId: "this-mac",
      busyPolicy: "queue",
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    (await service.store.inspectPrivateCodexRoutes())
      .map(({ alias, binding }) => ({
        alias,
        endpointGeneration: binding.endpointGeneration,
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias)),
    [
      {
        alias: "codex-fresh@this-mac",
        endpointGeneration: afterGeneration,
      },
      {
        alias: "codex-main@this-mac",
        endpointGeneration: afterGeneration,
      },
    ],
  );
  assert.equal(codex.activatedEndpointGenerations.length, 2);
  const persisted = JSON.parse(
    await readFile(service.store.stateFilePath, "utf8"),
  ) as { codexEndpointRefreshEvents: Array<{ alias: string }> };
  assert.deepEqual(
    persisted.codexEndpointRefreshEvents.map(({ alias }) => alias),
    ["codex-main@this-mac"],
  );
});

test("exact re-registration finalizes a selector refresh only after rebuilding its native listener", async () => {
  for (const providerAlreadyTracksRoute of [false, true]) {
    const { root, stateDir } = await fixture();
    const config = loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    });
    const firstCodex = new FakeProvider(
      "codex",
      `codex_restart_${providerAlreadyTracksRoute ? "tracked" : "clean"}_g1`,
      "0.147.0",
    );
    const first = new GatewayService({
      config,
      adapters: [new FakeProvider("claude"), firstCodex],
    });
    let second: GatewayService | undefined;
    try {
      await first.start();
      await first.handlers().registerCodex(codexRegistration());
      await first.close();

      const claude = new FakeProvider("claude");
      const codex = new FakeProvider(
        "codex",
        `codex_restart_${providerAlreadyTracksRoute ? "tracked" : "clean"}_g2`,
        "0.147.0",
      );
      codex.selectedEndpointRefresh = {
        previous: { ...firstCodex.identity },
        current: { ...codex.identity },
        routes: providerAlreadyTracksRoute
          ? [{ routeHandle: THREAD_ID, state: "idle" }]
          : [],
      };
      second = new GatewayService({ config, adapters: [claude, codex] });
      await second.start();
      assert.deepEqual(
        await second.handlers().registerCodex(codexRegistration()),
        { accepted: true, code: "ok" },
      );
      const route = await second.store.inspectPrivateRoute(
        "codex-main@this-mac",
      );
      assert.equal(
        route?.binding.endpointGeneration,
        codex.identity.endpointGeneration,
      );
      assert.equal(route?.state, "idle");
      assert.equal(
        claude.currentNativeCodexPeerGeneration("codex-main@this-mac"),
        "initial",
      );
      assert.equal(codex.activatedEndpointGenerations.length, 2);
      const publicText = JSON.stringify(
        await second.handlers().listSnapshot(),
      );
      assert.equal(publicText.includes(THREAD_ID), false);
      assert.equal(publicText.includes(codex.identity.endpointGeneration), false);
    } finally {
      await second?.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("selector refresh registration failures remain stale and retry to one final activation", async () => {
  for (const failurePoint of ["advertise_after_write", "status"] as const) {
    const { root, stateDir } = await fixture();
    const config = loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    });
    const firstCodex = new FakeProvider(
      "codex",
      `codex_registration_retry_${failurePoint}_g1`,
      "0.147.0",
    );
    const first = new GatewayService({
      config,
      adapters: [new FakeProvider("claude"), firstCodex],
    });
    let second: GatewayService | undefined;
    try {
      await first.start();
      await first.handlers().registerCodex(codexRegistration());
      await first.close();
      const claude = new FakeProvider("claude");
      const codex = new FakeProvider(
        "codex",
        `codex_registration_retry_${failurePoint}_g2`,
        "0.147.0",
      );
      codex.selectedEndpointRefresh = {
        previous: { ...firstCodex.identity },
        current: { ...codex.identity },
        routes: [],
      };
      codex.selectRouteFailures.push(
        new BridgeError(
          "CODEX_THREAD_NOT_OBSERVED",
          "Synthetic retained task is absent during boot recovery.",
        ),
      );
      if (failurePoint === "advertise_after_write") {
        claude.nativeCodexAdvertisementFailures.push({
          error: new Error("synthetic advertise outcome unknown"),
          afterWrite: true,
        });
      } else {
        claude.nativeCodexStatusFailures.push(
          new Error("synthetic registration status failure"),
        );
      }
      second = new GatewayService({ config, adapters: [claude, codex] });
      await second.start();
      assert.deepEqual(
        await second.handlers().registerCodex(codexRegistration()),
        { accepted: false, code: "rejected" },
      );
      assert.equal(codex.activatedEndpointGenerations.length, 1);
      assert.equal(
        (await second.store.inspectPrivateRoute("codex-main@this-mac"))
          ?.state,
        "stale",
      );

      assert.deepEqual(
        await second.handlers().registerCodex(codexRegistration()),
        { accepted: true, code: "ok" },
      );
      const route = await second.store.inspectPrivateRoute(
        "codex-main@this-mac",
      );
      assert.equal(route?.binding.endpointGeneration, codex.identity.endpointGeneration);
      assert.equal(route?.state, "idle");
      assert.equal(codex.activatedEndpointGenerations.length, 2);
      assert.equal(
        claude.currentNativeCodexPeerGeneration("codex-main@this-mac"),
        "initial",
      );
    } finally {
      await second?.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("selector refresh retains a coalesced retry across deferred activation failure", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstCodex = new FakeProvider(
    "codex",
    "codex_deferred_retry_g1",
    "0.147.0",
  );
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), firstCodex],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  let releaseReanchor!: () => void;
  const reanchorGate = new Promise<void>((resolve) => {
    releaseReanchor = resolve;
  });
  let reanchorEntered = false;
  const store = new EndpointRefreshFaultStore(config);
  store.reanchorGate = reanchorGate;
  store.onReanchorEntered = () => {
    reanchorEntered = true;
  };
  const claude = new FakeProvider("claude");
  claude.nativeCodexStatusFailures.push(
    new Error("synthetic deferred activation status failure"),
  );
  const codex = new FakeProvider(
    "codex",
    "codex_deferred_retry_g2",
    "0.147.0",
  );
  const refresh: GatewayAdapterEndpointRefresh = {
    previous: { ...firstCodex.identity },
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "idle" }],
  };
  codex.selectedEndpointRefresh = refresh;
  codex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_THREAD_NOT_OBSERVED",
      "Synthetic retained task is absent during boot recovery.",
    ),
  );
  const second = new GatewayService({ config, store, adapters: [claude, codex] });
  await second.start();
  t.after(async () => {
    releaseReanchor();
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const registration = second.handlers().registerCodex(codexRegistration());
  await waitFor(() => reanchorEntered);
  codex.callbacks?.onEndpointRefresh?.(refresh);
  codex.callbacks?.onEndpointRefresh?.(refresh);
  codex.callbacks?.onEndpointRefresh?.(refresh);
  releaseReanchor();
  assert.deepEqual(await registration, { accepted: false, code: "rejected" });
  const internal = second as unknown as {
    endpointRefreshCallback?: unknown;
  };
  assert.notEqual(internal.endpointRefreshCallback, undefined);
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  assert.equal(
    (await store.inspectPrivateRoute("codex-main@this-mac"))?.state,
    "stale",
  );

  assert.deepEqual(
    await second.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.equal(codex.activatedEndpointGenerations.length, 2);
  assert.equal(
    (await store.inspectPrivateRoute("codex-main@this-mac"))?.state,
    "idle",
  );
});

test("a malformed selector endpoint refresh has no durable or native activation side effects", async (t) => {
  const { root, stateDir } = await fixture();
  const generation = "codex_malformed_selector_g1";
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", generation, "0.147.0");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  const previous = { ...codex.identity };
  codex.selectedEndpointRefresh = {
    previous,
    current: { ...previous },
    routes: [{ routeHandle: OTHER_THREAD_ID, state: "idle" }],
  };
  const advertisedBefore = [...claude.nativeCodexAdvertisements];

  assert.deepEqual(
    await service.handlers().registerCodex({
      alias: "codex-malformed@this-mac",
      threadId: OTHER_THREAD_ID,
      hostId: "this-mac",
      busyPolicy: "queue",
    }),
    { accepted: false, code: "route_mismatch" },
  );
  const retained = await service.store.inspectPrivateRoute(
    "codex-main@this-mac",
  );
  assert.equal(retained?.binding.endpointGeneration, generation);
  assert.equal(retained?.state, "idle");
  assert.equal(
    await service.store.inspectPrivateRoute("codex-malformed@this-mac"),
    undefined,
  );
  assert.deepEqual(claude.nativeCodexAdvertisements, advertisedBefore);
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  assert.equal(
    (
      JSON.parse(await readFile(service.store.stateFilePath, "utf8")) as {
        codexEndpointRefreshEvents: unknown[];
      }
    ).codexEndpointRefreshEvents.length,
    0,
  );
});

test("endpoint refresh retains one coalesced slot when the ordinary callback queue is saturated", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider(
    "codex",
    "codex_callback_capacity_g1",
    "0.147.0",
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  const internal = service as unknown as {
    callbackCapacity: number;
    callbackQueue: Array<Record<string, unknown>>;
    endpointRefreshCallback?: unknown;
  };
  const sentinel = {
    type: "delivery",
    source: { ...claude.identity },
    value: { messageId: "msg_callback-capacity-sentinel", state: "failed" },
    receivedAt: Date.now(),
  };
  internal.callbackQueue.push(sentinel);
  while (internal.callbackQueue.length < internal.callbackCapacity) {
    internal.callbackQueue.push({
      type: "delivery",
      source: { ...claude.identity },
      value: {
        messageId: `msg_callback-capacity-${internal.callbackQueue.length}`,
        state: "failed",
      },
      receivedAt: Date.now(),
    });
  }
  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = "codex_callback_capacity_g2";
  const refresh: GatewayAdapterEndpointRefresh = {
    previous,
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "idle" }],
  };
  codex.callbacks?.onEndpointRefresh?.(refresh);
  codex.callbacks?.onEndpointRefresh?.(refresh);
  assert.equal(internal.callbackQueue.includes(sentinel), true);
  assert.notEqual(internal.endpointRefreshCallback, undefined);
  assert.equal(internal.callbackQueue.length, internal.callbackCapacity);

  await waitForAsync(
    async () =>
      codex.activatedEndpointGenerations.length === 2 &&
      (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
        .endpointGeneration === codex.identity.endpointGeneration,
  );
  assert.equal(
    (
      JSON.parse(await readFile(service.store.stateFilePath, "utf8")) as {
        codexEndpointRefreshEvents: unknown[];
      }
    ).codexEndpointRefreshEvents.length,
    1,
  );
  assert.equal(
    (await service.handlers().listSnapshot()).activityEvents?.filter(
      ({ action }) => action === "endpoint_refreshed",
    ).length,
    1,
  );
});

test("owned orphan removal quiesces and drains native ingress before unadvertising", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_owned_orphan_g1");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.registerCodex(codexRegistration());
  await service.store.markConnectorOffline(
    { ...codex.identity },
    "ENDPOINT_GENERATION_CHANGED",
    [],
  );
  codex.releasedRoutes.push(THREAD_ID);
  claude.nativeMessageOnQuiesce = {
    endpoint: { ...claude.identity, routeHandle: "claude_target_late" },
    sourceAlias: "claude-late@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "late native ingress at orphan boundary",
    receiptHandle: "receipt-orphan-quiesce",
  };

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  const quiesceIndex = claude.lifecycleEvents.indexOf(
    "succession:quiesce:initial",
  );
  const barrierIndex = claude.lifecycleEvents.indexOf(
    "succession:barrier-claude:initial",
  );
  const receiptIndex = claude.lifecycleEvents.findIndex((event) =>
    event.startsWith("status:"),
  );
  const unadvertiseIndex = claude.lifecycleEvents.indexOf(
    "native:unadvertise:codex-main@this-mac",
  );
  assert.ok(quiesceIndex >= 0);
  assert.ok(barrierIndex > quiesceIndex);
  assert.ok(receiptIndex > quiesceIndex && receiptIndex < unadvertiseIndex);
  assert.ok(unadvertiseIndex > barrierIndex);
  assert.equal(
    claude.nativeInboundStatuses.some(
      ({ receiptHandle }) => receiptHandle === "receipt-orphan-quiesce",
    ),
    true,
  );
  assert.equal(
    await service.store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );

  await service.store.observeConnector({
    identity: codex.identity,
    health: "healthy",
    protocol: codex.protocol,
    protocolVersion: codex.protocolVersion,
  });
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
});

test("owned orphan removal resumes its exact listener after a barrier failure", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_barrier_g1");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.registerCodex(codexRegistration());
  await service.store.markConnectorOffline(
    { ...codex.identity },
    "ENDPOINT_GENERATION_CHANGED",
    [],
  );
  codex.releasedRoutes.push(THREAD_ID);
  claude.nativeSuccessionBarrierClean = false;

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "busy" },
  );
  assert.equal(
    claude.lifecycleEvents.includes("succession:resume:initial"),
    true,
  );
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
  assert.notEqual(
    await service.store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );

  claude.nativeSuccessionBarrierClean = true;
  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
});

test("orphan removal rechecks provider recovery claims after the native barrier", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_race_g1");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.registerCodex(codexRegistration());
  await service.store.markConnectorOffline(
    { ...codex.identity },
    "ENDPOINT_GENERATION_CHANGED",
    [],
  );
  codex.releasedRoutes.push(THREAD_ID);
  const releasesBefore = codex.releasedRoutes.length;
  claude.nativeSuccessionBarrierBeforeReturn = () => {
    claude.nativeSuccessionBarrierBeforeReturn = undefined;
    codex.codexRouteCreationInFlight = true;
  };

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "busy" },
  );
  assert.equal(codex.releasedRoutes.length, releasesBefore);
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
  assert.equal(codex.activatedEndpointGenerations.length, 1);
  assert.equal(
    (await service.store.inspectPrivateRoute("codex-main@this-mac"))
      ?.binding.endpointGeneration,
    "codex_orphan_race_g1",
  );
  const persisted = JSON.parse(
    await readFile(service.store.stateFilePath, "utf8"),
  ) as { codexEndpointRefreshEvents: unknown[] };
  assert.equal(persisted.codexEndpointRefreshEvents.length, 0);
});

test("orphan removal blocks a target-bearing provider activation retry", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_retry_barrier_g1");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await service.handlers().registerCodex(codexRegistration());
  await service.store.markConnectorOffline(
    { ...codex.identity },
    "ENDPOINT_GENERATION_CHANGED",
    [],
  );
  codex.releasedRoutes.push(THREAD_ID);
  const releasesBefore = codex.releasedRoutes.length;
  codex.codexEndpointActivationRetryPending = true;

  assert.deepEqual(
    await service.handlers().removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "busy" },
  );
  assert.equal(codex.releasedRoutes.length, releasesBefore);
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
  assert.equal(
    (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.state,
    "stale",
  );
});

test("orphan removal retries after native removal reports an ambiguous failure", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_ambiguous_g1");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.registerCodex(codexRegistration());
  await service.store.markConnectorOffline(
    { ...codex.identity },
    "ENDPOINT_GENERATION_CHANGED",
    [],
  );
  codex.releasedRoutes.push(THREAD_ID);
  claude.nativeCodexUnadvertisementFailuresAfterRemove.push(
    new Error("synthetic close outcome unknown"),
  );

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal(
    claude.nativeCodexGenerations.has("codex-main@this-mac"),
    false,
  );
  assert.notEqual(
    await service.store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: false,
    code: "rejected",
  });

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  assert.equal(
    claude.lifecycleEvents.filter(
      (event) => event === "native:unadvertise:codex-main@this-mac",
    ).length,
    1,
  );
  assert.equal(
    await service.store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );
});

test("restored orphan removal retries an exact native-absent store failure", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [
      new FakeProvider("claude"),
      new FakeProvider("codex", "codex_orphan_store_g1"),
    ],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const store = new OrphanRemovalFaultStore(config);
  store.failRemovalBefore = 1;
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_store_g2");
  codex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_THREAD_NOT_OBSERVED",
      "Synthetic retained task is absent during boot recovery.",
    ),
  );
  const second = new GatewayService({ config, store, adapters: [claude, codex] });
  await second.start();
  t.after(async () => {
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = second.handlers();
  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.notEqual(
    await store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );
  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(claude.nativeCodexUnadvertisements, []);
  assert.equal(
    await store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );
});

test("orphan removal finalizes an exact post-commit store outcome on retry", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [
      new FakeProvider("claude"),
      new FakeProvider("codex", "codex_orphan_postcommit_g1"),
    ],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const store = new OrphanRemovalFaultStore(config);
  store.failRemovalAfter = 1;
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex", "codex_orphan_postcommit_g2");
  codex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_THREAD_NOT_OBSERVED",
      "Synthetic retained task is absent during boot recovery.",
    ),
  );
  const second = new GatewayService({ config, store, adapters: [claude, codex] });
  await second.start();
  t.after(async () => {
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = second.handlers();
  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal(
    await store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.equal(
    (await store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration,
    "codex_orphan_postcommit_g2",
  );
});

test("dashboard recovery removes only a stale Codex registration on a superseded generation", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  firstClaude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const firstCodex = new FakeProvider("codex", "codex_orphan_generation");
  const first = new GatewayService({
    config,
    adapters: [firstClaude, firstCodex],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  await selectAndRegister(first.handlers());
  assert.equal((await first.handlers().listSnapshot()).consentEdges.length, 1);
  await first.close();

  const secondClaude = new FakeProvider("claude");
  const secondCodex = new FakeProvider(
    "codex",
    "codex_replacement_generation",
  );
  secondCodex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_THREAD_NOT_OBSERVED",
      "Synthetic retained task is absent during boot recovery.",
    ),
  );
  second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  const handlers = second.handlers();
  let snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.routes.find(({ alias }) => alias === "codex-main@this-mac")
      ?.state,
    "stale",
  );
  assert.equal(snapshot.consentEdges.length, 1);

  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.routes.some(({ alias }) => alias === "codex-main@this-mac"),
    false,
  );
  assert.deepEqual(snapshot.consentEdges, []);
  assert.equal(
    await second.store.inspectPrivateRoute("codex-main@this-mac"),
    undefined,
  );
  assert.deepEqual(secondCodex.releasedRoutes, [THREAD_ID]);
  assert.deepEqual(secondClaude.nativeCodexUnadvertisements, []);
  assert.deepEqual(
    snapshot.activityEvents
      ?.filter(({ action }) => action === "codex_orphan_removed")
      .map(({ kind, outcome, aliases, operatorAction }) => ({
        kind,
        outcome,
        aliases,
        operatorAction,
      })),
    [
      {
        kind: "recovery",
        outcome: "accepted",
        aliases: ["codex-main@this-mac"],
        operatorAction: true,
      },
    ],
  );

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.equal(
    (await second.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration,
    "codex_replacement_generation",
  );
});

test("dashboard recovery refuses a stale Codex registration when its exact generation is live", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const endpointGeneration = "codex_still_live_generation";
  const first = new GatewayService({
    config,
    adapters: [
      new FakeProvider("claude"),
      new FakeProvider("codex", endpointGeneration),
    ],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.close();

  const secondCodex = new FakeProvider("codex", endpointGeneration);
  secondCodex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_THREAD_NOT_OBSERVED",
      "Synthetic retained task is absent during boot recovery.",
    ),
  );
  second = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), secondCodex],
  });
  await second.start();
  const handlers = second.handlers();
  assert.equal(
    (await handlers.listSnapshot()).routes.find(
      ({ alias }) => alias === "codex-main@this-mac",
    )?.state,
    "stale",
  );
  assert.deepEqual(
    await handlers.removeStaleCodexRegistration({
      alias: "codex-main@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(secondCodex.releasedRoutes, []);
  assert.equal(
    (await second.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration,
    endpointGeneration,
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).activityEvents
      ?.filter(({ action }) => action === "codex_orphan_removed")
      .map(({ outcome, safeErrorCode }) => ({ outcome, safeErrorCode })),
    [
      {
        outcome: "rejected",
        safeErrorCode: "CODEX_ORPHAN_GENERATION_LIVE",
      },
    ],
  );
});

test("Codex registration identity is immutable for one service lifetime", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.unregisterCodex({
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );

  const selectedBeforeRejectedRebinds = codex.selectedRoutes.length;
  const advertisedBeforeRejectedRebinds =
    claude.nativeCodexAdvertisements.length;
  const statusesBeforeRejectedRebinds = claude.nativeCodexStatuses.length;
  const releasesBeforeRejectedRebinds = codex.releasedRoutes.length;
  const revisionBeforeRejectedRebinds = (await handlers.health()).revision;
  assert.deepEqual(
    await handlers.registerCodex({
      ...codexRegistration(),
      alias: "codex-renamed@this-mac",
    }),
    { accepted: false, code: "conflict" },
  );
  assert.deepEqual(
    await handlers.registerCodex({
      ...codexRegistration(),
      threadId: OTHER_THREAD_ID,
    }),
    { accepted: false, code: "conflict" },
  );
  assert.equal(codex.selectedRoutes.length, selectedBeforeRejectedRebinds);
  assert.equal(
    claude.nativeCodexAdvertisements.length,
    advertisedBeforeRejectedRebinds,
  );
  assert.equal(claude.nativeCodexStatuses.length, statusesBeforeRejectedRebinds);
  assert.equal(codex.releasedRoutes.length, releasesBeforeRejectedRebinds);
  assert.equal(
    (await handlers.health()).revision,
    revisionBeforeRejectedRebinds,
  );
  assert.deepEqual((await handlers.listSnapshot()).routes, []);

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    codex.selectedRoutes.map(({ alias, routeHandle }) => ({ alias, routeHandle })),
    [codexRegistration(), codexRegistration(), codexRegistration()].map(
      ({ alias, threadId }) => ({ alias, routeHandle: threadId }),
    ),
  );
  assert.deepEqual(claude.nativeCodexAdvertisements, [
    "codex-main@this-mac",
    "codex-main@this-mac",
    "codex-main@this-mac",
  ]);
  assert.deepEqual(claude.nativeCodexUnadvertisements, [
    "codex-main@this-mac",
  ]);
});

test("a new service lifetime can choose a new Codex registration identity", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });
  await first.start();
  assert.deepEqual(
    await first.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await first.handlers().unregisterCodex({
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await first.handlers().registerCodex({
      ...codexRegistration(),
      alias: "codex-next@this-mac",
    }),
    { accepted: false, code: "conflict" },
  );
  await first.close();

  const secondCodex = new FakeProvider("codex");
  second = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), secondCodex],
  });
  await second.start();
  assert.deepEqual(
    await second.handlers().registerCodex({
      ...codexRegistration(),
      alias: "codex-next@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(secondCodex.selectedRoutes, [
    { alias: "codex-next@this-mac", routeHandle: THREAD_ID },
  ]);
});

test("Codex succession atomically replaces one quiescent registration and retires the old generation", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_gen_1",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).routes.map(({ alias, state }) => ({
      alias,
      state,
    })),
    [{ alias: "codex-next@this-mac", state: "idle" }],
  );
  assert.deepEqual(await service.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
  assert.deepEqual(codex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
    { alias: "codex-next@this-mac", routeHandle: OTHER_THREAD_ID },
  ]);
  assert.deepEqual(codex.releasedRoutes, [THREAD_ID]);
  assert.equal(claude.nativeCodexActiveAlias, "codex-next@this-mac");
  assert.equal(claude.nativeCodexActiveGeneration, "successor_gen_1");
  assert.equal(claude.nativeCodexRetiredGeneration, undefined);
  const publishIndex = claude.lifecycleEvents.indexOf(
    "succession:publish:initial:successor_gen_1",
  );
  const activateIndex = claude.lifecycleEvents.indexOf(
    "succession:activate:successor_gen_1",
  );
  const retireIndex = claude.lifecycleEvents.indexOf(
    "succession:retire:initial:successor_gen_1",
  );
  assert.equal(publishIndex >= 0, true);
  assert.equal(activateIndex > publishIndex, true);
  assert.equal(retireIndex > activateIndex, true);

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.registerCodex(successorExactRegistration()),
    { accepted: true, code: "ok" },
  );
});

test("Codex succession leaves unrelated registration dispatch and authority live", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_route_scoped",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.registerCodex(independentCodexRegistration()),
    { accepted: true, code: "ok" },
  );

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude-side-session" },
    sourceAlias: "claude-side@this-mac",
    targetAlias: independentCodexRegistration().alias,
    text: "unrelated active delivery",
  });
  await waitForAsync(
    async () =>
      codex.dispatches.some(
        (dispatch) => dispatch.binding.routeHandle === THIRD_THREAD_ID,
      ),
  );

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: true, code: "ok" },
  );
  const aliases = (await handlers.listSnapshot()).routes.map(
    (route) => route.alias,
  );
  assert.equal(aliases.includes("codex-next@this-mac"), true);
  assert.equal(aliases.includes("codex-side@this-mac"), true);
  assert.equal(claude.nativeCodexGenerations.has("codex-side@this-mac"), true);
});

test("Codex succession preserves terminal delivery-token status but transfers no conversation or reply authority", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_gen_token",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);
  const accepted = await handlers.sendToClaude({
    ...toClaude("terminal token survives succession"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) throw new Error("synthetic send was rejected");
  await waitFor(() => claude.dispatches.length === 1);
  const dispatched = claude.dispatches[0];
  assert.ok(dispatched);
  claude.emitDelivery({
    messageId: dispatched.messageId,
    state: "transport_written",
  });
  claude.emitDelivery({
    messageId: dispatched.messageId,
    state: "released",
  });
  await waitForAsync(async () => {
    const status = await handlers.deliveryStatus({
      token: accepted.deliveryToken,
    });
    return status.found && status.terminal;
  });
  const before = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(before.found, true);
  if (!before.found) throw new Error("synthetic token was not retained");

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: true, code: "ok" },
  );
  const status = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) assert.equal(status.state, before.state);
  assert.deepEqual(
    await handlers.reply({
      conversationId: accepted.conversationId,
      text: "must not cross the identity boundary",
      caller: {
        kind: "codex",
        alias: "codex-next@this-mac",
        threadId: OTHER_THREAD_ID,
      },
    }),
    { accepted: false, code: "not_found" },
  );
});

test("a busy succession barrier rolls back the freeze without preparing or renaming anything", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_gen_2",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  codex.codexSuccessionBarrierClean = false;

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "busy" },
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).routes.map(({ alias }) => alias),
    ["codex-main@this-mac"],
  );
  assert.equal(claude.nativeCodexPreparedGeneration, undefined);
  assert.equal(claude.nativeCodexIngressQuiesced, false);
  assert.equal(claude.nativeCodexMonitorFrozen, false);
  assert.deepEqual(codex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
  assert.deepEqual(await service.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
});

test("known-absent succession publication cleans the successor and resumes the exact old registration", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  claude.nativeSuccessionPublishOutcomes.push("not_published");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_gen_3",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(
    (await handlers.listSnapshot()).routes.map(({ alias }) => alias),
    ["codex-main@this-mac"],
  );
  assert.equal(claude.nativeCodexActiveAlias, "codex-main@this-mac");
  assert.equal(claude.nativeCodexActiveGeneration, "initial");
  assert.equal(claude.nativeCodexPreparedGeneration, undefined);
  assert.equal(claude.nativeCodexIngressQuiesced, false);
  assert.deepEqual(codex.releasedRoutes, [OTHER_THREAD_ID]);
  assert.deepEqual(await service.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
});

test("a pre-publication listener failure resumes the exact old registration without a durable journal", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.successionFailures.set("prepare", [
    new Error("synthetic listener preparation failure"),
  ]);
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_prearm",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    await service.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await service.handlers().registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  assert.equal(claude.nativeCodexActiveAlias, "codex-main@this-mac");
  assert.equal(claude.nativeCodexIngressQuiesced, false);
  assert.deepEqual(codex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
  assert.deepEqual(await service.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
});

test("a failed first cleanup is retried under the reducer before the old registration resumes", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.nativeSuccessionPublishOutcomes.push("not_published");
  claude.successionFailures.set("cleanup_prepared", [
    new Error("synthetic first cleanup failure"),
  ]);
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_cleanup_retry",
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    await service.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await service.handlers().registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  assert.equal(
    claude.lifecycleEvents.filter((event) =>
      event.startsWith("succession:cleanup-prepared:"),
    ).length,
    2,
  );
  assert.equal(claude.nativeCodexActiveAlias, "codex-main@this-mac");
  assert.equal(claude.nativeCodexIngressQuiesced, false);
  assert.deepEqual(await service.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
});

test("an installed prepare journal is reconciled and cleared after a post-rename failure", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  let failNextRename = false;
  const store = new GatewayStore(config, {
    afterStateFileRename: async () => {
      if (!failNextRename) return;
      const installed = JSON.parse(
        await readFile(path.join(stateDir, "gateway-state.json"), "utf8"),
      ) as { codexSuccession?: { stage?: string } | null };
      if (installed.codexSuccession?.stage !== "prepared") return;
      failNextRename = false;
      throw new Error("synthetic installed prepare commit failure");
    },
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const generations = [
    "successor_prepare_unknown",
    "successor_after_reconcile",
  ];
  const service = new GatewayService({
    config,
    store,
    adapters: [claude, codex],
    successionGeneration: () => generations.shift() ?? "unexpected_generation",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  failNextRename = true;
  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(
    await service.store.inspectCodexSuccessionRecoveryAuthority(),
    { authority: "none" },
  );
  assert.equal(claude.nativeCodexActiveAlias, "codex-main@this-mac");
  assert.equal(claude.nativeCodexActiveGeneration, "initial");
  assert.equal(claude.nativeCodexPreparedGeneration, undefined);
  assert.equal(claude.nativeCodexIngressQuiesced, false);
  assert.equal(claude.nativeCodexMonitorFrozen, false);

  codex.dispatchResults.push({ state: "delivered" });
  const oldRouteSend = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    expectsReply: false,
  });
  assert.equal(oldRouteSend.accepted, true);
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches[0]?.binding.routeHandle, THREAD_ID);

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await service.store.inspectCodexSuccessionRecoveryAuthority(),
    { authority: "none" },
  );
  assert.equal(claude.nativeCodexActiveAlias, "codex-next@this-mac");
  assert.equal(
    claude.nativeCodexActiveGeneration,
    "successor_after_reconcile",
  );
});

test("an unprovable prepare commit stays poisoned and requires manual recovery", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  let failNextRename = false;
  const store = new UnprovablePreparedAuthorityStore(config, {
    afterStateFileRename: () => {
      if (!failNextRename) return;
      failNextRename = false;
      throw new Error("synthetic unprovable prepare commit failure");
    },
  });
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config,
    store,
    adapters: [claude, codex],
    successionGeneration: () => "successor_unprovable_prepare",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  store.maskNextPreparedAuthority = true;
  failNextRename = true;
  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  const authority =
    await service.store.inspectCodexSuccessionRecoveryAuthority();
  assert.equal(authority.authority, "old");
  assert.equal(
    authority.authority === "old" ? authority.journal.stage : undefined,
    "prepared",
  );
  assert.equal(claude.closed, false);
  assert.equal(codex.closed, false);
  assert.equal(
    (await handlers.registerCodex(codexRegistration())).accepted,
    false,
  );
  assert.equal(
    (
      await handlers.sendToClaude({
        ...toClaude("unprovable prepare must reject bodies"),
        expectsReply: false,
      })
    ).accepted,
    false,
  );
  assert.equal(
    (await handlers.listSnapshot()).routes.every(
      ({ enabled, state }) => !enabled && state === "disabled",
    ),
    true,
  );
});

test("a failed old-generation resume stays poisoned, offline, and closed to new work", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.successionFailures.set("prepare", [
    new Error("synthetic listener preparation failure before resume"),
  ]);
  claude.successionFailures.set("resume", [
    new Error("synthetic old-ingress resume failure"),
  ]);
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_resume_failure",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  const succession = await handlers.registerCodex(
    successorCodexRegistration(),
  );
  assert.equal(succession.accepted, false);
  const resumeIndex = claude.lifecycleEvents.indexOf(
    "succession:resume:initial",
  );
  const requiesceIndex = claude.lifecycleEvents.lastIndexOf(
    "succession:quiesce:initial",
  );
  assert.equal(resumeIndex >= 0, true);
  assert.equal(requiesceIndex > resumeIndex, true);
  assert.equal(claude.nativeCodexIngressQuiesced, true);
  assert.equal(claude.nativeCodexMonitorFrozen, true);
  assert.equal(claude.closed, false);
  assert.equal(codex.closed, false);
  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes.map(({ alias, enabled, state }) => ({
      alias,
      enabled,
      state,
    })),
    [
      {
        alias: "codex-main@this-mac",
        enabled: false,
        state: "disabled",
      },
    ],
  );
  assert.deepEqual(
    await service.store.inspectCodexSuccessionRecoveryAuthority(),
    { authority: "none" },
  );
  assert.equal(
    (await handlers.registerCodex(codexRegistration())).accepted,
    false,
  );
  assert.equal(
    (
      await handlers.sendToClaude({
        ...toClaude("resume failure must reject new bodies"),
        expectsReply: false,
      })
    ).accepted,
    false,
  );
  const barrier = await service.store.inspectCodexSuccessionBarrier(
    "codex-main@this-mac",
  );
  assert.equal(barrier.clean, true);
  assert.equal(barrier.queueCount, 0);
  assert.equal(barrier.inFlightCount, 0);
  assert.equal(barrier.transientBodyCount, 0);
});

test("an unknown succession publication outcome takes both registrations offline and forbids old rollback", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  claude.nativeSuccessionPublishOutcomes.push("unknown");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_gen_4",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.routes.every(
      ({ enabled, state }) => !enabled && state === "disabled",
    ),
    true,
  );
  const authority =
    await service.store.inspectCodexSuccessionRecoveryAuthority();
  assert.equal(authority.authority, "new");
  assert.equal(claude.closed, false);
  assert.equal(codex.closed, false);
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: false,
    code: "rejected",
  });
});

test("succession poison disables only the replaced edge and leaves unrelated Codex work live", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  claude.nativeSuccessionPublishOutcomes.push("unknown");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_route_poison",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.registerCodex(independentCodexRegistration()),
    { accepted: true, code: "ok" },
  );

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  const side = (await handlers.listSnapshot()).routes.find(
    (route) => route.alias === independentCodexRegistration().alias,
  );
  assert.deepEqual(
    side === undefined
        ? undefined
        : {
            enabled: side.enabled,
            state: side.state,
          },
    { enabled: true, state: "idle" },
  );
  assert.equal(claude.closed, false);
  assert.equal(codex.closed, false);
  assert.equal(claude.nativeCodexGenerations.has(side!.alias), true);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude-side-after-poison" },
    sourceAlias: "claude-side@this-mac",
    targetAlias: side!.alias,
    text: "unrelated delivery after succession poison",
  });
  await waitForAsync(
    async () =>
      codex.dispatches.some(
        (dispatch) => dispatch.binding.routeHandle === THIRD_THREAD_ID,
      ),
  );
});

for (const failurePoint of ["activate", "retire"] as const) {
  test(`a post-publication ${failurePoint} failure never restores the old registration`, async (t) => {
    const { root, stateDir } = await fixture();
    const claude = new FakeProvider("claude");
    claude.successionFailures.set(failurePoint, [
      new Error(`synthetic ${failurePoint} failure`),
    ]);
    const codex = new FakeProvider("codex");
    const service = new GatewayService({
      config: loadGatewayConfig({
        EMBASSY_STATE_DIR: stateDir,
        EMBASSY_HOSTS: "this-mac",
      }),
      adapters: [claude, codex],
      successionGeneration: () => `successor_${failurePoint}`,
    });
    await service.start();
    t.after(async () => {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    assert.deepEqual(
      await service.handlers().registerCodex(codexRegistration()),
      { accepted: true, code: "ok" },
    );
    assert.deepEqual(
      await service.handlers().registerCodex(successorCodexRegistration()),
      { accepted: false, code: "rejected" },
    );
    assert.equal(
      (await service.store.inspectCodexSuccessionRecoveryAuthority()).authority,
      "new",
    );
    assert.equal(claude.closed, false);
    assert.equal(codex.closed, false);
    assert.deepEqual(
      (await service.handlers().listSnapshot()).routes.map(({ alias }) => alias),
      ["codex-next@this-mac"],
    );
    assert.equal(
      (await service.handlers().listSnapshot()).routes.every(
        ({ enabled }) => !enabled,
      ),
      true,
    );
  });
}

test("post-activation poison drains an admitted native frame and its terminal receipt before close", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    successionGeneration: () => "successor_admitted_ingress",
  });
  await service.start();
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  const poisonBody = "synthetic successor ingress must be terminally rejected";
  const receiptHandle = "receipt-successor-poison";
  claude.nativeMessageAfterSuccessionActivation = {
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-next@this-mac",
    text: poisonBody,
    receiptHandle,
  };
  // The initial registration status is already complete. This failure lands
  // after listener activation, while the synthetic native callback is queued.
  claude.nativeCodexStatusFailures.push(
    new Error("synthetic post-activation status failure"),
  );

  assert.deepEqual(
    await handlers.registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(claude.nativeInboundStatusAttempts, [
    {
      receiptHandle,
      status: "expired",
      diagnosticCode: "CODEX_SUCCESSION_RECOVERY_REQUIRED",
    },
  ]);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle,
      status: "expired",
      diagnosticCode: "CODEX_SUCCESSION_RECOVERY_REQUIRED",
    },
  ]);
  assert.equal(
    claude.nativeInboundStatuses.some(
      ({ status }) => status === "held" || status === "delivered",
    ),
    false,
  );
  assert.equal(codex.dispatches.length, 0);
  const activateIndex = claude.lifecycleEvents.indexOf(
    "succession:activate:successor_admitted_ingress",
  );
  const quiesceIndex = claude.lifecycleEvents.indexOf(
    "succession:quiesce:successor_admitted_ingress",
  );
  const receiptIndex = claude.lifecycleEvents.indexOf("status:expired");
  assert.equal(activateIndex >= 0, true);
  assert.equal(quiesceIndex > activateIndex, true);
  assert.equal(receiptIndex > quiesceIndex, true);

  const barrier = await service.store.inspectCodexSuccessionBarrier(
    "codex-next@this-mac",
  );
  assert.deepEqual(
    {
      clean: barrier.clean,
      queueCount: barrier.queueCount,
      inFlightCount: barrier.inFlightCount,
      transientBodyCount: barrier.transientBodyCount,
      codexQueueDepth: barrier.codexQueueDepth,
    },
    {
      clean: true,
      queueCount: 0,
      inFlightCount: 0,
      transientBodyCount: 0,
      codexQueueDepth: 0,
    },
  );
  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes.map(
      ({ alias, enabled, state, queueDepth }) => ({
        alias,
        enabled,
        state,
        queueDepth,
      }),
    ),
    [
      {
        alias: "codex-next@this-mac",
        enabled: false,
        state: "disabled",
        queueDepth: 0,
      },
    ],
  );
  assert.equal(claude.closed, false);
  assert.equal(codex.closed, false);
  const internal = service as unknown as {
    conversations: Map<string, unknown>;
    messageContexts: Map<string, unknown>;
    providerTurnContinuations: Map<string, unknown>;
    activeDispatchByTarget: Map<string, unknown>;
    scheduledDispatchTargets: Set<string>;
    dispatchRunnerTargets: Set<string>;
    pendingClaudeReplies: Map<string, unknown>;
    deliveryTrackers: Map<string, unknown>;
    detachedReceiptWrites: Set<Promise<void>>;
    nativeIngressByConversation: Map<string, unknown>;
    callbackQueue: unknown[];
  };
  assert.deepEqual(
    {
      conversations: internal.conversations.size,
      messageContexts: internal.messageContexts.size,
      providerTurns: internal.providerTurnContinuations.size,
      activeDispatches: internal.activeDispatchByTarget.size,
      scheduledDispatches: internal.scheduledDispatchTargets.size,
      dispatchRunners: internal.dispatchRunnerTargets.size,
      pendingReplies: internal.pendingClaudeReplies.size,
      deliveryTrackers: internal.deliveryTrackers.size,
      detachedReceipts: internal.detachedReceiptWrites.size,
      nativeIngress: internal.nativeIngressByConversation.size,
      callbacks: internal.callbackQueue.length,
    },
    {
      conversations: 0,
      messageContexts: 0,
      providerTurns: 0,
      activeDispatches: 0,
      scheduledDispatches: 0,
      dispatchRunners: 0,
      pendingReplies: 0,
      deliveryTrackers: 0,
      detachedReceipts: 0,
      nativeIngress: 0,
      callbacks: 0,
    },
  );
  const stateText = await readFile(service.store.stateFilePath, "utf8");
  assert.equal(stateText.includes(poisonBody), false);
  assert.equal(stateText.includes(receiptHandle), false);
});

test("restart recovery after an irreversible succession authorizes only exact successor re-registration", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  const firstCodex = new FakeProvider("codex");
  firstClaude.nativeSuccessionPublishOutcomes.push("unknown");
  const first = new GatewayService({
    config,
    adapters: [firstClaude, new FakeProvider("codex")],
    successionGeneration: () => "successor_restart",
  });
  let second: GatewayService | undefined;
  await first.start();
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    await first.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await first.handlers().registerCodex(successorCodexRegistration()),
    { accepted: false, code: "rejected" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  const secondCodex = new FakeProvider("codex");
  second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  assert.deepEqual(
    await second.handlers().registerCodex(codexRegistration()),
    { accepted: false, code: "route_mismatch" },
  );
  assert.deepEqual(secondCodex.selectedRoutes, []);
  assert.deepEqual(
    await second.handlers().registerCodex(successorExactRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(await second.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
  assert.deepEqual(
    (await second.handlers().listSnapshot()).routes.map(({ alias, state }) => ({
      alias,
      state,
    })),
    [{ alias: "codex-next@this-mac", state: "idle" }],
  );
});

test("restart clears a pre-publication succession journal and preserves only the old registration authority", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstCodex = new FakeProvider("codex");
  const first = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), firstCodex],
  });
  let second: GatewayService | undefined;
  await first.start();
  t.after(async () => {
    await second?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    await first.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  const oldRoute = await first.store.inspectPrivateRoute(
    "codex-main@this-mac",
  );
  assert.ok(oldRoute);
  const newBinding: PrivateRouteBinding = {
    ...firstCodex.identity,
    routeHandle: OTHER_THREAD_ID,
    ownerLease: `lease_${createHash("sha256")
      .update("codex")
      .update("\0")
      .update(`this-mac\0${OTHER_THREAD_ID}`)
      .digest("base64url")}`,
  };
  await first.store.prepareCodexSuccession({
    old: {
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
      hostId: "this-mac",
      generation: "initial",
      binding: oldRoute.binding,
    },
    new: {
      alias: "codex-next@this-mac",
      threadId: OTHER_THREAD_ID,
      hostId: "this-mac",
      generation: "prepared_restart",
      binding: newBinding,
    },
  });
  await first.close();

  const secondCodex = new FakeProvider("codex");
  second = new GatewayService({
    config,
    adapters: [new FakeProvider("claude"), secondCodex],
  });
  await second.start();
  assert.deepEqual(await second.store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
  assert.deepEqual(secondCodex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
  assert.deepEqual(
    (await second.handlers().listSnapshot()).routes.map(({ alias, state }) => ({
      alias,
      state,
    })),
    [{ alias: "codex-main@this-mac", state: "idle" }],
  );
});

test("fake end-to-end delivery retains bodies while keeping route and conversation authority private", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  let clock = new Date();
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
    // Unsafe native names are not transformed into a public selector.
    {
      alias: "Claude Mixed@this-mac",
      routeHandle: "never_selected",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config,
    adapters: [claude, codex],
    now: () => clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.availablePeers.map((peer) => peer.alias),
    ["claude-one@this-mac"],
  );
  assert.equal(JSON.stringify(snapshot).includes("claude_target_1"), false);
  assert.deepEqual(claude.attested, ["claude_target_1"]);
  assert.deepEqual(codex.attested, []);

  const accepted = await handlers.sendToClaude(toClaude());
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  // The mutation handler returns before any provider call is attempted.
  assert.equal(claude.dispatches.length, 0);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches.length, 1);
  assert.equal(claude.dispatches[0]?.text, SECRET);
  assert.deepEqual(dispatchProvenance(claude.dispatches[0]!), {
    sourceAlias: "codex-main@this-mac",
    targetAlias: "claude-one@this-mac",
    conversationId: accepted.conversationId,
    text: SECRET,
  });

  const second = await handlers.sendToClaude(toClaude("second body"));
  assert.deepEqual(second, { accepted: false, code: "busy" });

  const unrelated = await handlers.sendToCodex(
    toCodex("uds:/tmp/unrelated-agent.sock"),
  );
  assert.deepEqual(unrelated, { accepted: false, code: "route_mismatch" });
  assert.equal(codex.dispatches.length, 0);

  const firstDispatch = claude.dispatches[0];
  assert.ok(firstDispatch);
  // A callback from a different provider/generation cannot settle this ID.
  codex.emitDelivery({ messageId: firstDispatch.messageId, state: "released" });
  await immediate();
  assert.equal(
    (await handlers.listSnapshot()).messages.some(
      (event) =>
        event.direction === "codex_to_claude" && event.state === "delivered",
    ),
    false,
  );
  claude.emitDelivery({
    messageId: firstDispatch.messageId,
    state: "transport_written",
  });
  claude.emitDelivery({ messageId: firstDispatch.messageId, state: "held" });
  await immediate();
  claude.emitDelivery({
    messageId: firstDispatch.messageId,
    state: "released",
  });
  claude.emitClaudeReply("synthetic reply");
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches.length, 1);
  assert.equal(codex.dispatches[0]?.text, "synthetic reply");
  const replyDispatch = codex.dispatches[0];
  assert.ok(replyDispatch);
  assert.deepEqual(dispatchProvenance(replyDispatch), {
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    conversationId: accepted.conversationId,
    text: "synthetic reply",
  });
  codex.emitDelivery({
    messageId: replyDispatch.messageId,
    state: "completed",
  });
  codex.emitRouteState(THREAD_ID, "idle");
  await immediate();

  claude.emitRouteState("claude_target_1", "idle");
  await immediate();

  const late = await handlers.sendToClaude(toClaude("late reply probe"));
  assert.equal(late.accepted, true);
  await waitFor(() => claude.dispatches.length === 2);
  const lateDispatch = claude.dispatches[1];
  assert.ok(lateDispatch);
  claude.emitDelivery({ messageId: lateDispatch.messageId, state: "released" });
  clock = new Date(
    clock.getTime() + config.limits.messageDeadlineMs + 1,
  );
  const blockedByTombstone = await handlers.sendToClaude(
    toClaude("must not reuse tainted callback generation"),
  );
  assert.deepEqual(blockedByTombstone, {
    accepted: false,
    code: "busy",
  });
  claude.emitClaudeReply("must be ignored after deadline");
  await immediate();
  await immediate();
  assert.equal(codex.dispatches.length, 1);
  claude.emitRouteState("claude_target_1", "idle");
  await immediate();
  clock = new Date();

  const fromClaude = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(fromClaude.accepted, true);
  if (!fromClaude.accepted) return;
  await waitFor(() => codex.dispatches.length === 2);
  const codexTurn = codex.dispatches[1];
  assert.ok(codexTurn);
  assert.deepEqual(dispatchProvenance(codexTurn), {
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    conversationId: fromClaude.conversationId,
    text: SECRET,
  });
  codex.emitDelivery({
    messageId: codexTurn.messageId,
    state: "completed",
    replyText: "bounded codex final",
  });
  await waitFor(() => claude.dispatches.length === 3);
  const codexReply = claude.dispatches[2];
  assert.ok(codexReply);
  assert.equal(codexReply.text, "bounded codex final");
  assert.deepEqual(dispatchProvenance(codexReply), {
    sourceAlias: "codex-main@this-mac",
    targetAlias: "claude-one@this-mac",
    conversationId: fromClaude.conversationId,
    text: "bounded codex final",
  });
  assert.equal(codexReply.expectsReply, false);
  assert.equal(Number.isFinite(Date.parse(codexReply.deadlineAt)), true);
  claude.emitDelivery({ messageId: codexReply.messageId, state: "released" });
  await immediate();

  const finalSnapshot = await handlers.listSnapshot();
  assert.equal(
    finalSnapshot.messages.some(
      (event) =>
        event.direction === "codex_to_claude" &&
        event.body === "bounded codex final",
    ),
    true,
  );
  const stateText = await readFile(service.store.stateFilePath, "utf8");
  const dashboardText = await readFile(
    path.join(stateDir, "gateway-dashboard.html"),
    "utf8",
  );
  for (const retained of [
    SECRET,
    "synthetic reply",
    "late reply probe",
    "bounded codex final",
  ]) {
    assert.equal(stateText.includes(retained), true);
  }
  for (const forbidden of [
    "must be ignored after deadline",
    accepted.conversationId,
    fromClaude.conversationId,
  ]) {
    assert.equal(stateText.includes(forbidden), false);
  }
  // Exact route handles may exist only in the private controller state. They
  // must never enter the public dashboard or normalized snapshot.
  for (const forbidden of [
    accepted.conversationId,
    fromClaude.conversationId,
    "claude_target_1",
    THREAD_ID,
  ]) {
    assert.equal(dashboardText.includes(forbidden), false);
  }

  await service.close();
  assert.equal(claude.closed, true);
  assert.equal(codex.closed, true);
});

test("Claude sends require explicit selection while UUID routing survives rename and endpoint refresh", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "old-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("unselected UUID must not route"),
      toAlias: CLAUDE_SESSION_ID,
      expectsReply: false,
    }),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("unselected name must not route"),
      toAlias: "old-name@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal(claude.dispatches.length, 0);

  assert.deepEqual(await handlers.selectClaude({ alias: CLAUDE_SESSION_ID }), {
    accepted: true,
    code: "ok",
  });
  const byUuid = await handlers.sendToClaude({
    ...toClaude("addressed by UUID"),
    toAlias: CLAUDE_SESSION_ID,
    expectsReply: false,
  });
  assert.equal(byUuid.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  const first = claude.dispatches[0];
  assert.ok(first);
  assert.equal(first.binding.routeHandle, CLAUDE_SESSION_ID);
  claude.emitDelivery({ messageId: first.messageId, state: "released" });
  claude.emitRouteState(CLAUDE_SESSION_ID, "idle");
  await immediate();

  claude.discoveries = [
    {
      alias: "new-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  await handlers.refreshDashboard();
  const renamed = await handlers.listSnapshot();
  assert.deepEqual(
    renamed.availablePeers.map(({ alias, selected }) => ({ alias, selected })),
    [{ alias: "new-name@this-mac", selected: true }],
  );
  assert.equal(
    renamed.routes.some((route) => route.alias === "old-name@this-mac"),
    false,
  );
  assert.equal(
    renamed.routes.some((route) => route.alias === "new-name@this-mac"),
    true,
  );

  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("old name must not resolve"),
      toAlias: "old-name@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "not_found" },
  );
  const byCurrentName = await handlers.sendToClaude({
    ...toClaude("current name resolves"),
    toAlias: "new-name@this-mac",
    expectsReply: false,
  });
  assert.equal(byCurrentName.accepted, true);
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.binding.routeHandle, CLAUDE_SESSION_ID);
});

test("fresh Claude selection releases provider state when the selected handle changes", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.selectedRouteHandleOverride =
    "00000000-0000-4000-8000-000000000099";
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  await service.handlers().refreshDashboard();
  assert.deepEqual(
    await service.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await service
      .handlers()
      .selectClaude({ alias: "advisor@this-mac" }),
    { accepted: false, code: "route_mismatch" },
  );
  assert.deepEqual(claude.selectedRoutes, [
    { alias: "advisor@this-mac", routeHandle: CLAUDE_SESSION_ID },
  ]);
  assert.deepEqual(claude.releasedRoutes, [CLAUDE_SESSION_ID]);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.availablePeers[0]?.selected, false);
  assert.equal(
    snapshot.routes.some((route) => route.provider === "claude"),
    false,
  );
});

test("pairing a second Claude session selects it additively and preserves old work", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );

  const oldDelivery = await handlers.sendToClaude({
    ...toClaude("settle this attempt during the pair swap"),
    expectsReply: false,
  });
  assert.equal(oldDelivery.accepted, true);
  if (!oldDelivery.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);

  assert.deepEqual(
    await handlers.pair({
      claudeAlias: "claude-two@this-mac",
      codexAlias: "codex-main@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes
      .filter((route) => route.provider === "claude")
      .map((route) => route.alias)
      .sort(),
    ["claude-one@this-mac", "claude-two@this-mac"],
  );
  assert.deepEqual(
    snapshot.availablePeers.map(({ alias, selected }) => ({
      alias,
      selected,
    })),
    [
      { alias: "claude-one@this-mac", selected: true },
      { alias: "claude-two@this-mac", selected: true },
    ],
  );
  assert.deepEqual(consentEdgeAliases(snapshot), [
    ["claude-one@this-mac", "codex-main@this-mac"],
    ["claude-two@this-mac", "codex-main@this-mac"],
  ]);
  assert.deepEqual(claude.releasedRoutes, []);
  const oldStatus = await handlers.deliveryStatus({
    token: oldDelivery.deliveryToken,
  });
  assert.equal(oldStatus.found, true);
  if (oldStatus.found) {
    assert.equal(oldStatus.terminal, false);
  }

  const originalEdgeDelivery = await handlers.sendToClaude({
    ...toClaude("the original edge remains routable"),
    expectsReply: false,
  });
  assert.equal(originalEdgeDelivery.accepted, true);
  const replacementDelivery = await handlers.sendToClaude({
    ...toClaude("the replacement peer owns the only route"),
    toAlias: "claude-two@this-mac",
    expectsReply: false,
  });
  assert.equal(replacementDelivery.accepted, true);
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(
    claude.dispatches[1]?.binding.routeHandle,
    "claude_target_2",
  );

  assert.deepEqual(
    await handlers.unpair({
      claudeAlias: "claude-one@this-mac",
      codexAlias: "codex-main@this-mac",
      codexThreadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  const afterUnpair = await handlers.listSnapshot();
  assert.deepEqual(
    consentEdgeAliases(afterUnpair),
    [["claude-two@this-mac", "codex-main@this-mac"]],
  );
  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("the removed edge cannot send"),
      toAlias: "claude-one@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "rejected" },
  );
  const removedStatus = await handlers.deliveryStatus({
    token: oldDelivery.deliveryToken,
  });
  assert.deepEqual(
    removedStatus.found
      ? {
          terminal: removedStatus.terminal,
          state: removedStatus.state,
          safeErrorCode: removedStatus.safeErrorCode,
        }
      : removedStatus,
    {
      terminal: true,
      state: "cancelled",
      safeErrorCode: "PAIR_REMOVED",
    },
  );
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "released",
  });
  assert.deepEqual(
    await handlers.deliveryStatus({ token: oldDelivery.deliveryToken }),
    removedStatus,
  );

  const adjacentPending = await handlers.deliveryStatus({
    token: replacementDelivery.deliveryToken,
  });
  assert.equal(adjacentPending.found, true);
  if (adjacentPending.found) assert.equal(adjacentPending.terminal, false);
  claude.emitDelivery({
    messageId: claude.dispatches[1]!.messageId,
    state: "released",
  });
  await waitForAsync(async () => {
    const status = await handlers.deliveryStatus({
      token: replacementDelivery.deliveryToken,
    });
    return status.found && status.terminal && status.state === "delivered";
  });
  assert.equal(
    (
      await handlers.sendToClaude({
        ...toClaude("the adjacent edge remains authorized"),
        toAlias: "claude-two@this-mac",
        expectsReply: false,
      })
    ).accepted,
    true,
  );
});

test("unpair settles only that edge's native receipt while an adjacent receipt remains live", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await handlers.pair({
      claudeAlias: "claude-two@this-mac",
      codexAlias: "codex-main@this-mac",
      codexThreadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "first edge waits for its exact unpair",
    receiptHandle: "receipt-first-edge-unpair",
  });
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_2" },
    sourceAlias: "claude-two@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "adjacent edge remains queued",
    receiptHandle: "receipt-adjacent-edge-unpair",
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) => route.alias === "codex-main@this-mac" && route.queueDepth === 2,
    ),
  );

  assert.deepEqual(
    await handlers.unpair({
      claudeAlias: "claude-one@this-mac",
      codexAlias: "codex-main@this-mac",
      codexThreadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  await waitFor(() =>
    claude.nativeInboundStatuses.some(
      ({ receiptHandle, status }) =>
        receiptHandle === "receipt-first-edge-unpair" && status === "expired",
    ),
  );
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-first-edge-unpair",
    ),
    [
      {
        receiptHandle: "receipt-first-edge-unpair",
        status: "held",
      },
      {
        receiptHandle: "receipt-first-edge-unpair",
        status: "expired",
        diagnosticCode: "PAIR_REMOVED",
      },
    ],
  );
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-adjacent-edge-unpair",
    ),
    [
      {
        receiptHandle: "receipt-adjacent-edge-unpair",
        status: "held",
      },
    ],
  );
  assert.equal(codex.dispatches.length, 0);
  assert.equal(
    (await handlers.listSnapshot()).routes.find(
      (route) => route.alias === "codex-main@this-mac",
    )?.queueDepth,
    1,
  );

  codex.dispatchResults.push({ state: "delivered" });
  codex.state = "idle";
  codex.emitRouteState(THREAD_ID, "idle");
  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() =>
    claude.nativeInboundStatuses.some(
      ({ receiptHandle, status }) =>
        receiptHandle === "receipt-adjacent-edge-unpair" &&
        status === "delivered",
    ),
  );
  assert.equal(codex.dispatches[0]?.text, "adjacent edge remains queued");
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-adjacent-edge-unpair",
    ),
    [
      {
        receiptHandle: "receipt-adjacent-edge-unpair",
        status: "held",
      },
      {
        receiptHandle: "receipt-adjacent-edge-unpair",
        status: "delivered",
      },
    ],
  );
});

test("a pair-capacity rejection rolls a fresh Claude selection back", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MAX_PAIRS: "1",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-two@this-mac" }),
    { accepted: false, code: "busy" },
  );

  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes
      .filter((route) => route.provider === "claude")
      .map((route) => route.alias),
    ["claude-one@this-mac"],
  );
  assert.deepEqual(
    consentEdgeAliases(snapshot),
    [["claude-one@this-mac", "codex-main@this-mac"]],
  );
  assert.deepEqual(claude.releasedRoutes, ["claude_target_2"]);
  assert.equal(
    snapshot.availablePeers.find(
      (peer) => peer.alias === "claude-two@this-mac",
    )?.selected,
    false,
  );
});

test("a send survives discovery absence without revoking the selected route", async (t) => {
  const { root, stateDir } = await fixture();
  const published: GatewayPublicSnapshot[] = [];
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    publishDashboard: async (_stateDirectory, snapshot) => {
      published.push(snapshot);
      return path.join(stateDir, "gateway-dashboard.html");
    },
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  await handlers.registerCodex(codexRegistration());
  await handlers.selectClaude({ alias: "advisor@this-mac" });

  const publishedBefore = published.length;
  const revisionBefore = (await handlers.health()).revision;
  claude.discoveries = [];
  const accepted = await handlers.sendToClaude({
      ...toClaude("peer disappeared"),
      toAlias: "advisor@this-mac",
      expectsReply: false,
    });
  assert.equal(accepted.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal((await handlers.health()).revision > revisionBefore, true);
  assert.equal(published.length > publishedBefore, true);
  assert.deepEqual(published.at(-1)?.availablePeers, []);
  assert.notEqual(
    published.at(-1)?.routes.find((route) => route.alias === "advisor@this-mac")
      ?.state,
    "stale",
  );
  assert.deepEqual(claude.releasedRoutes, []);
});

test("explicit Claude selection reactivates its persisted stale alias after restart", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({
    config,
    adapters: [firstClaude, firstCodex],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  assert.deepEqual(
    await first.handlers().selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  const secondCodex = new FakeProvider("codex");
  secondClaude.discoveries = firstClaude.discoveries.map((peer) => ({
    ...peer,
  }));
  const second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });

  await second.handlers().registerCodex(codexRegistration());
  assert.deepEqual(
    await second.handlers().selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
});

test("retained stale Codex authority cannot replace a Claude route before pairing rejects", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({
    config,
    adapters: [firstClaude, firstCodex],
  });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  assert.deepEqual(
    await first.handlers().selectClaude({ alias: "advisor@this-mac" }),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  const secondCodex = new FakeProvider("codex");
  secondCodex.selectRouteFailures.push(
    new BridgeError(
      "CODEX_ROUTE_STALE",
      "synthetic retained task is not loaded",
      true,
    ),
  );
  const replacementSession = "00000000-0000-4000-8000-000000000099";
  secondClaude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: replacementSession,
      kind: "interactive",
      state: "idle",
    },
  ];
  let discoveryCalls = 0;
  const discoverClaudePeers = secondClaude.discoverClaudePeers.bind(secondClaude);
  secondClaude.discoverClaudePeers = async () => {
    discoveryCalls += 1;
    return await discoverClaudePeers();
  };
  const second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  t.after(async () => {
    await second.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await second.start();

  const routesBefore = await second.store.inspectPrivateClaudeRoutes();
  const edgesBefore = (await second.snapshot()).consentEdges;
  const decision = await second.handlers().selectClaude({
    alias: "advisor@this-mac",
  });
  assert.equal(decision.accepted, false);
  assert.equal(discoveryCalls, 1);
  assert.deepEqual(await second.store.inspectPrivateClaudeRoutes(), routesBefore);
  assert.deepEqual((await second.snapshot()).consentEdges, edgesBefore);
  assert.equal(
    (await second.store.inspectPrivateClaudeRoutes()).some(
      (route) => route.binding.routeHandle === replacementSession,
    ),
    false,
  );
});

test("authorized discovery heals one legacy hashed Claude generation and adopts only its latest name", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider(
    "claude",
    "claude_0123456789abcdef0123456789abcdef",
  );
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "old-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({ config, adapters: [firstClaude, firstCodex] });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  assert.deepEqual(
    await first.handlers().selectClaude({ alias: "old-name@this-mac" }),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude", "claude_local_endpoint");
  const secondCodex = new FakeProvider("codex");
  const clock = new ManualGatewayClock();
  secondClaude.discoveries = [
    {
      alias: "latest-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
    now: clock.now,
    timers: clock,
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  await second.handlers().registerCodex(codexRegistration());

  let restored = await second.snapshot();
  assert.deepEqual(secondClaude.selectedRoutes, [
    { alias: "latest-name@this-mac", routeHandle: CLAUDE_SESSION_ID },
  ]);
  assert.deepEqual(secondClaude.attested, [CLAUDE_SESSION_ID]);
  assert.equal(secondClaude.dispatches.length, 0);
  assert.deepEqual(
    restored.availablePeers.map(({ alias, selected }) => ({ alias, selected })),
    [{ alias: "latest-name@this-mac", selected: true }],
  );
  assert.equal(
    restored.routes.some((route) => route.alias === "old-name@this-mac"),
    false,
  );
  assert.equal(
    restored.routes.find((route) => route.alias === "latest-name@this-mac")
      ?.state,
    "idle",
  );
  assert.equal(JSON.stringify(restored).includes(CLAUDE_SESSION_ID), false);
  const privateRoute = await second.store.inspectPrivateRoute(
    "latest-name@this-mac",
  );
  assert.equal(privateRoute?.binding.routeHandle, CLAUDE_SESSION_ID);
  assert.equal(
    privateRoute?.binding.endpointGeneration,
    "claude_local_endpoint",
  );

  secondClaude.discoveries = secondClaude.discoveries.map((peer) => ({
    ...peer,
    state: "busy",
  }));
  await clock.advanceBy(30_000);
  await waitForAsync(async () =>
    (await second.snapshot()).routes.some(
      (route) => route.alias === "latest-name@this-mac" && route.state === "busy",
    ),
  );
  restored = await second.snapshot();
  assert.equal(
    restored.routes.find((route) => route.alias === "latest-name@this-mac")
      ?.state,
    "busy",
  );
});

test("timed exact-UUID Claude reobservation wakes a retained queue after boot absence", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude", "claude_generation_before");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "advisor-old@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({ config, adapters: [firstClaude, firstCodex] });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "advisor-old@this-mac" });
  firstClaude.state = "busy";
  firstClaude.emitRouteState(CLAUDE_SESSION_ID, "busy");
  await waitForAsync(async () =>
    (await first.snapshot()).routes.some(
      ({ alias, state }) =>
        alias === "advisor-old@this-mac" && state === "busy",
    ),
  );
  await first.handlers().sendToClaude({
    ...toClaude("retained until timed reobservation"),
    toAlias: "advisor-old@this-mac",
  });
  await first.close();

  const clock = new ManualGatewayClock();
  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  const second = new GatewayService({
    config,
    adapters: [secondClaude, new FakeProvider("codex")],
    now: clock.now,
    timers: clock,
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.equal(secondClaude.dispatches.length, 0);

  secondClaude.discoveries = [
    {
      alias: "advisor-latest@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  await clock.advanceBy(30_000);
  await waitFor(() => secondClaude.dispatches.length === 1);
  assert.equal(secondClaude.dispatches[0]?.text, "retained until timed reobservation");
  assert.equal(
    (await second.snapshot()).routes.some(
      ({ alias, state }) =>
        alias === "advisor-latest@this-mac" && state === "idle",
    ),
    true,
  );
});

test("periodic Claude cleanup cannot release a concurrent exact manual rebind", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude", "claude_stable_generation");
  const first = new GatewayService({
    config,
    adapters: [firstClaude, new FakeProvider("codex")],
  });
  firstClaude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "advisor@this-mac" });
  await first.close();

  const clock = new ManualGatewayClock();
  const secondClaude = new FakeProvider("claude", "claude_stable_generation");
  const second = new GatewayService({
    config,
    adapters: [secondClaude, new FakeProvider("codex")],
    now: clock.now,
    timers: clock,
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  secondClaude.discoveries = firstClaude.discoveries.map((peer) => ({ ...peer }));
  let releasePeriodicSelect: (() => void) | undefined;
  secondClaude.selectRouteGate = new Promise<void>((resolve) => {
    releasePeriodicSelect = resolve;
  });
  await clock.advanceBy(30_000);
  await waitFor(() => secondClaude.selectedRoutes.length === 1);

  await second.handlers().refreshDashboard();
  assert.equal(
    (await second.snapshot()).routes.find(
      ({ alias }) => alias === "advisor@this-mac",
    )?.state,
    "idle",
  );
  releasePeriodicSelect?.();
  await waitFor(() => secondClaude.selectedRoutes.length === 2);
  await immediate();
  assert.deepEqual(secondClaude.releasedRoutes, []);

  await second.handlers().sendToClaude({
    ...toClaude("manual winner remains live"),
    toAlias: "advisor@this-mac",
  });
  await waitFor(() => secondClaude.dispatches.length === 1);
});

test("incomplete, colliding, and workspace-failed discovery cannot restore a durable Claude UUID", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({ config, adapters: [firstClaude, firstCodex] });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "advisor@this-mac" });
  await first.close();

  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  const secondCodex = new FakeProvider("codex");
  secondClaude.discoveries = firstClaude.discoveries.map((peer) => ({ ...peer }));
  secondClaude.discoveryComplete = false;
  const second = new GatewayService({ config, adapters: [secondClaude, secondCodex] });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  await second.handlers().registerCodex(codexRegistration());

  const completeDiscovery = secondClaude.discoverClaudePeers.bind(secondClaude);
  Object.defineProperty(secondClaude, "discoverClaudePeers", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  await second.handlers().refreshDashboard();
  let snapshot = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.deepEqual(snapshot.availablePeers, []);
  assert.equal(snapshot.routes[0]?.state, "stale");

  Object.defineProperty(secondClaude, "discoverClaudePeers", {
    configurable: true,
    value: completeDiscovery,
    writable: true,
  });
  await second.handlers().refreshDashboard();
  snapshot = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.equal(
    snapshot.availablePeers[0]?.safeErrorCode,
    "PEER_DISCOVERY_INCOMPLETE",
  );
  assert.equal(snapshot.routes[0]?.state, "stale");

  secondClaude.discoveryComplete = true;
  secondClaude.discoveries = [
    ...firstClaude.discoveries,
    {
      alias: "duplicate-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  await second.handlers().refreshDashboard();
  snapshot = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.equal(
    snapshot.availablePeers.every(
      (peer) => peer.safeErrorCode === "PEER_SESSION_COLLISION",
    ),
    true,
  );
  assert.equal(snapshot.routes[0]?.state, "stale");

  secondClaude.discoveries = firstClaude.discoveries.map((peer) => ({ ...peer }));
  secondClaude.assertWorkspaceDisjoint = async () => {
    throw new BridgeError(
      "WORKSPACE_REVALIDATION_FAILED",
      "Synthetic workspace changed.",
    );
  };
  await second.handlers().refreshDashboard();
  snapshot = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.equal(snapshot.availablePeers[0]?.selected, false);
  assert.equal(snapshot.routes[0]?.state, "stale");

  secondClaude.assertWorkspaceDisjoint = async (routeHandle) => {
    secondClaude.attested.push(routeHandle);
  };
  await second.handlers().refreshDashboard();
  snapshot = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 1);
  assert.equal(snapshot.availablePeers[0]?.selected, true);
  assert.equal(snapshot.routes[0]?.state, "idle");
});

test("a same-name different UUID requires an explicit atomic selection swap", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const otherSession = "00000000-0000-4000-8000-000000000043";
  const firstClaude = new FakeProvider("claude");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "second@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const first = new GatewayService({ config, adapters: [firstClaude, firstCodex] });
  await first.start();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "second@this-mac" });
  await first.close();

  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  const secondCodex = new FakeProvider("codex");
  secondClaude.discoveries = [
    {
      alias: "second@this-mac",
      routeHandle: otherSession,
      kind: "interactive",
      state: "idle",
    },
  ];
  const second = new GatewayService({ config, adapters: [secondClaude, secondCodex] });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });

  await second.handlers().registerCodex(codexRegistration());

  await second.handlers().refreshDashboard();
  let snapshot = await second.snapshot();
  assert.deepEqual(secondClaude.selectedRoutes, []);
  assert.deepEqual(secondClaude.releasedRoutes, []);
  assert.equal(snapshot.availablePeers[0]?.selected, false);
  assert.equal(
    snapshot.routes
      .filter((route) => route.provider === "claude")
      .every((route) => route.state === "stale"),
    true,
  );

  assert.deepEqual(
    await second.handlers().selectClaude({ alias: "second@this-mac" }),
    { accepted: true, code: "ok" },
  );
  snapshot = await second.snapshot();
  assert.deepEqual(secondClaude.selectedRoutes, [
    { alias: "second@this-mac", routeHandle: otherSession },
  ]);
  assert.deepEqual(secondClaude.releasedRoutes, [CLAUDE_SESSION_ID]);
  assert.equal(snapshot.availablePeers[0]?.selected, true);
  assert.deepEqual(
    snapshot.routes
      .filter((route) => route.provider === "claude")
      .map((route) => route.alias),
    ["second@this-mac"],
  );
});

test("a stale Claude selection can be unselected by stored alias or bounded UUID without discovery", async () => {
  const selectors = ["offline@this-mac", CLAUDE_SESSION_ID] as const;
  for (const [index, selector] of selectors.entries()) {
    const { root, stateDir } = await fixture();
    const config = loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    });
    const firstClaude = new FakeProvider("claude");
    const firstCodex = new FakeProvider("codex");
    firstClaude.discoveries = [
      {
        alias: "offline@this-mac",
        routeHandle: CLAUDE_SESSION_ID,
        kind: "interactive",
        state: "idle",
      },
    ];
    const first = new GatewayService({
      config,
      adapters: [firstClaude, firstCodex],
    });
    await first.start();
    await first.handlers().registerCodex(codexRegistration());
    await first.handlers().selectClaude({ alias: "offline@this-mac" });
    await first.close();

    const secondClaude = new FakeProvider(
      "claude",
      `claude_generation_offline_${index}`,
    );
    const secondCodex = new FakeProvider("codex");
    const second = new GatewayService({
      config,
      adapters: [secondClaude, secondCodex],
    });
    await second.start();
    assert.deepEqual(
      await second.handlers().unselectClaude({ alias: selector }),
      { accepted: true, code: "ok" },
    );
    assert.equal(secondClaude.selectedRoutes.length, 0);
    assert.deepEqual(secondClaude.releasedRoutes, [CLAUDE_SESSION_ID]);
    assert.equal(
      (await second.snapshot()).routes.some(
        (route) => route.provider === "claude",
      ),
      false,
    );
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unselect settles in-flight delivery from exact write evidence once", async () => {
  const cases = [
    {
      label: "unwritten",
      delivery: undefined,
      state: "cancelled",
      safeErrorCode: "PAIR_REMOVED",
    },
    {
      label: "confirmed",
      delivery: { state: "transport_written" } as const,
      state: "delivered",
      safeErrorCode: undefined,
    },
    {
      label: "held",
      delivery: { state: "held" } as const,
      state: "unconfirmed",
      safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
    },
    {
      label: "uncertain",
      delivery: {
        state: "transport_uncertain",
        safeErrorCode: "SYNTHETIC_TRANSPORT_OUTCOME_UNCERTAIN",
      } as const,
      state: "ambiguous",
      safeErrorCode: "SYNTHETIC_TRANSPORT_OUTCOME_UNCERTAIN",
    },
  ] as const;

  for (const candidate of cases) {
    const { root, stateDir } = await fixture();
    const claude = new FakeProvider("claude");
    claude.discoveries = [
      {
        alias: "claude-one@this-mac",
        routeHandle: "claude_target_1",
        kind: "interactive",
        state: "idle",
      },
    ];
    claude.dispatchResults.push({ state: "pending" });
    const codex = new FakeProvider("codex");
    const service = new GatewayService({
      config: loadGatewayConfig({
        EMBASSY_STATE_DIR: stateDir,
        EMBASSY_HOSTS: "this-mac",
      }),
      adapters: [claude, codex],
    });
    try {
      await service.start();
      await selectAndRegister(service.handlers());
      const accepted = await service.handlers().sendToClaude({
        ...toClaude(`route teardown ${candidate.label}`),
        expectsReply: false,
      });
      assert.equal(accepted.accepted, true, candidate.label);
      if (!accepted.accepted) continue;
      await waitFor(() => claude.dispatches.length === 1);
      if (candidate.delivery !== undefined) {
        claude.emitDelivery({
          messageId: claude.dispatches[0]!.messageId,
          ...candidate.delivery,
        });
      }
      assert.deepEqual(
        await service.handlers().unselectClaude({
          alias: "claude-one@this-mac",
        }),
        { accepted: true, code: "ok" },
        candidate.label,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const status = await service.handlers().deliveryStatus({
          token: accepted.deliveryToken,
        });
        assert.equal(status.found, true, candidate.label);
        if (status.found) {
          assert.equal(status.state, candidate.state, candidate.label);
          assert.equal(
            status.safeErrorCode,
            candidate.safeErrorCode,
            candidate.label,
          );
        }
      }
      const snapshot = await service.handlers().listSnapshot();
      assert.equal(snapshot.accounting[candidate.state], 1, candidate.label);
      assert.equal(
        snapshot.messages.filter(
          ({ state }) => state === candidate.state,
        ).length,
        1,
        candidate.label,
      );
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing discovery is display-only and does not revoke Claude mailbox authority", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, new FakeProvider("codex")],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  claude.discoveries = [];
  claude.emitRouteState(
    "claude_target_1",
    "busy",
    "CLAUDE_PEER_NOT_OBSERVED",
  );
  assert.equal((await service.handlers().refreshDashboard()).accepted, true);
  const unobserved = (await service.handlers().listSnapshot()).routes.find(
    ({ alias }) => alias === "claude-one@this-mac",
  );
  assert.equal(unobserved?.state, "busy");
  assert.equal(unobserved?.safeErrorCode, "CLAUDE_PEER_NOT_OBSERVED");
  assert.deepEqual(claude.releasedRoutes, []);

  const accepted = await service.handlers().sendToClaude({
    ...toClaude("write through an unobserved selected route"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(
    claude.dispatches[0]?.text,
    "write through an unobserved selected route",
  );
  assert.deepEqual(claude.releasedRoutes, []);
});

test("a discovery read failure does not gate an exact selected Claude mailbox write", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, new FakeProvider("codex")],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  claude.discoverClaudePeers = async () => {
    throw new BridgeError(
      "SYNTHETIC_DISCOVERY_UNAVAILABLE",
      "Synthetic discovery read failure.",
      true,
    );
  };
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("write despite a failed display observation"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(
    claude.dispatches[0]?.text,
    "write despite a failed display observation",
  );
  assert.deepEqual(claude.releasedRoutes, []);
});

test("a renamed-session collision revokes the exact selected Claude route", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, new FakeProvider("codex")],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  await handlers.registerCodex(codexRegistration());
  await handlers.selectClaude({ alias: "advisor@this-mac" });

  claude.discoveries = [
    {
      ...claude.discoveries[0]!,
      alias: "renamed-one@this-mac",
    },
    {
      ...claude.discoveries[0]!,
      alias: "renamed-two@this-mac",
    },
  ];
  assert.equal((await handlers.refreshDashboard()).accepted, true);
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.availablePeers.every(
      ({ safeErrorCode }) => safeErrorCode === "PEER_SESSION_COLLISION",
    ),
    true,
  );
  assert.equal(
    snapshot.routes.find(({ alias }) => alias === "advisor@this-mac")?.state,
    "stale",
  );
  assert.deepEqual(claude.releasedRoutes, [CLAUDE_SESSION_ID]);
  assert.equal(
    (
      await handlers.sendToClaude({
        ...toClaude("collision must not reach the mailbox"),
        toAlias: "advisor@this-mac",
        expectsReply: false,
      })
    ).accepted,
    false,
  );
  assert.deepEqual(claude.dispatches, []);
});

test("a recovered watch reuses its exact conversation for queued mail", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  firstClaude.state = "busy";
  firstClaude.discoveries = [
    {
      alias: "busy-peer@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "busy",
    },
  ];
  firstClaude.dispatchResults.push({
    state: "deferred",
    safeErrorCode: "CLAUDE_ROUTE_HELD",
  });
  const firstCodex = new FakeProvider("codex");
  const firstStore = new GatewayStore(config);
  const first = new GatewayService({
    config,
    store: firstStore,
    adapters: [firstClaude, firstCodex],
  });
  await first.start();
  await first.handlers().refreshDashboard();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "busy-peer@this-mac" });
  const accepted = await first.handlers().sendToClaude({
    ...toClaude("must survive restart"),
    toAlias: "busy-peer@this-mac",
    expectsReply: true,
    trackIdleMinutes: 1,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const queuedFollowup = await first.handlers().reply({
    conversationId: accepted.conversationId,
    text: "second queued item in the watched conversation",
    caller: {
      kind: "codex",
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    },
  });
  assert.equal(queuedFollowup.accepted, true, JSON.stringify(queuedFollowup));
  assert.equal((await firstStore.publicSnapshot()).progressWatches?.length, 1);
  await waitForAsync(async () =>
    (await first.snapshot()).messages.some(
      ({ safeErrorCode }) => safeErrorCode === "CLAUDE_ROUTE_HELD",
    ),
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  secondClaude.dispatchResults.push(
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
    { state: "delivered" },
  );
  secondClaude.discoveries = [
    {
      ...firstClaude.discoveries[0]!,
      state: "idle",
    },
  ];
  secondClaude.resolveReplyAddress = async (address) => {
    if (address !== "uds:/synthetic/claude.sock") {
      throw new BridgeError(
        "REPLY_ADDRESS_MISMATCH",
        "Synthetic unrelated socket.",
      );
    }
    return { routeHandle: CLAUDE_SESSION_ID };
  };
  const secondCodex = new FakeProvider("codex", "codex_generation_after");
  const secondStore = new ProgressWatchResolutionStore(config);
  const second = new GatewayService({
    config,
    store: secondStore,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => secondClaude.dispatches.length === 1);
  const snapshot = await second.snapshot();
  assert.equal((await secondStore.publicSnapshot()).progressWatches?.length, 1);
  assert.equal(secondClaude.dispatches.length, 1);
  assert.equal(secondCodex.dispatches.length, 0);
  assert.equal(
    snapshot.accounting.queuedBytes,
    Buffer.byteLength("second queued item in the watched conversation"),
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.state === "cancelled" || event.state === "abandoned",
    ),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes("must survive restart"), true);
  assert.equal(
    snapshot.routes.find(({ alias }) => alias === "busy-peer@this-mac")?.state,
    "idle",
  );
  const unrelated = await second.handlers().sendToClaude({
    ...toClaude("DONE: unrelated conversation must not close the watch"),
    toAlias: "busy-peer@this-mac",
    expectsReply: false,
  });
  assert.equal(unrelated.accepted, true, JSON.stringify(unrelated));
  if (!unrelated.accepted) return;
  assert.notEqual(unrelated.conversationId, accepted.conversationId);
  assert.equal((await secondStore.publicSnapshot()).progressWatches?.length, 1);
  secondClaude.emitRouteState(CLAUDE_SESSION_ID, "idle");
  await waitFor(() => secondClaude.dispatches.length === 3);
  assert.equal(secondClaude.dispatches[0]?.text, "must survive restart");
  assert.equal(secondClaude.dispatches[0]?.progressWatchActive, true);
  assert.equal(
    secondClaude.dispatches[0]?.conversationId,
    accepted.conversationId,
  );
  assert.equal(
    secondClaude.dispatches[0]?.conversationId.endsWith(
      snapshot.messages.find((event) => event.body === "must survive restart")
        ?.conversationIdSuffix ?? "missing",
    ),
    true,
  );
  assert.equal(
    secondClaude.dispatches[1]?.text,
    "second queued item in the watched conversation",
  );
  assert.equal(
    secondClaude.dispatches[1]?.conversationId,
    accepted.conversationId,
  );
  assert.equal(secondClaude.dispatches[1]?.progressWatchActive, true);
  assert.equal(
    secondClaude.dispatches[2]?.text,
    "DONE: unrelated conversation must not close the watch",
  );
  assert.equal(
    secondClaude.dispatches[2]?.conversationId,
    unrelated.conversationId,
  );
  assert.equal(secondClaude.dispatches[2]?.progressWatchActive, undefined);
  assert.equal((await secondStore.publicSnapshot()).progressWatches?.length, 1);
  assert.equal(secondStore.resolutions.length, 3);
  assert.deepEqual(secondStore.resolutions.slice(0, 2), [
    {
      recoveredConversationIdSuffix: accepted.conversationId.slice(-8),
      sourceAlias: "codex-main@this-mac",
      targetAlias: "busy-peer@this-mac",
    },
    {
      recoveredConversationIdSuffix: accepted.conversationId.slice(-8),
      sourceAlias: "codex-main@this-mac",
      targetAlias: "busy-peer@this-mac",
    },
  ]);
  assert.deepEqual(secondStore.resolutions[2], {
    conversationId: unrelated.conversationId,
    sourceAlias: "codex-main@this-mac",
    targetAlias: "busy-peer@this-mac",
  });
  const recoveredConversationId = secondClaude.dispatches[0]?.conversationId;
  assert.ok(recoveredConversationId);
  assert.equal(
    (await secondStore.publicSnapshot()).progressWatchEvents?.at(-1)?.kind,
    "opened",
  );
  const continued = await second.handlers().reply({
    conversationId: recoveredConversationId,
    text: "continue after canonical recovery",
    caller: {
      kind: "codex",
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    },
  });
  assert.equal(continued.accepted, true, JSON.stringify(continued));
  await waitFor(() => secondClaude.dispatches.length === 4);
  assert.equal(
    secondClaude.dispatches[3]?.conversationId,
    recoveredConversationId,
  );
  assert.equal(secondClaude.dispatches[3]?.progressWatchActive, true);
  assert.deepEqual(secondStore.resolutions[3], {
    conversationId: recoveredConversationId,
    sourceAlias: "codex-main@this-mac",
    targetAlias: "busy-peer@this-mac",
  });
  const completion = await second.handlers().reply({
    conversationId: recoveredConversationId,
    text: "DONE: recovered work is complete",
    caller: {
      kind: "claude",
      alias: "busy-peer@this-mac",
      replyAddress: "uds:/synthetic/claude.sock",
    },
  });
  assert.equal(completion.accepted, true, JSON.stringify(completion));
  await waitFor(() => secondCodex.dispatches.length === 1);
  assert.deepEqual(
    (await secondStore.publicSnapshot()).progressWatches ?? [],
    [],
  );
  const completionEvent = (
    await secondStore.publicSnapshot()
  ).progressWatchEvents?.at(-1);
  assert.equal(
    completionEvent?.conversationIdSuffix,
    accepted.conversationId.slice(-8),
  );
  assert.equal(completionEvent?.ownerAlias, "codex-main@this-mac");
  assert.equal(completionEvent?.workerAlias, "busy-peer@this-mac");
  assert.equal(completionEvent?.kind, "settled");
  assert.equal(completionEvent?.actor, "worker");
  assert.equal(completionEvent?.reason, "done");
});

test("transient Codex dispatch failures return to held queue and retry", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push(
    { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" },
    { state: "accepted" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  claude.callbacks?.onProtocolNotice?.({
    code: "UNKNOWN_RECEIPT",
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).alerts.some(
      (alert) =>
        alert.code === "UNKNOWN_RECEIPT" &&
        alert.provider === "claude" &&
        alert.host === "this-mac",
    ),
  );

  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => codex.dispatches.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    codex.dispatches.length,
    2,
    JSON.stringify(snapshot.routes, null, 2),
  );
  assert.deepEqual(codex.dispatches.map(dispatchProvenance), [
    {
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      conversationId: accepted.conversationId,
      text: SECRET,
    },
    {
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      conversationId: accepted.conversationId,
      text: SECRET,
    },
  ]);
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "held",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "failed",
    ),
    false,
  );
});

test("a Codex deferral inside the last retry slice settles failed, not expired", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    // Land the clean prewrite failure 400 ms before the deadline, so the exact
    // 500 ms Codex retry slice no longer fits inside it.
    clock.nowMs += 600;
    return { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const accepted = await service.handlers().sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => codex.dispatches.length === 1);
  const terminal = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(terminal.found, true);
  if (terminal.found) {
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.safeErrorCode, "CODEX_ROUTE_HELD");
  }
  await clock.advanceBy(1_000);
  assert.equal(codex.dispatches.length, 1);
});

test("a stale Codex route preserves held work and rejects new sends", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const accepted = await handlers.sendToCodex(
    { ...toCodex("uds:/synthetic/claude.sock"), expectsReply: false },
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const secondAccepted = await handlers.sendToCodex(
    { ...toCodex("uds:/synthetic/claude.sock"), expectsReply: false },
  );
  assert.equal(secondAccepted.accepted, true);
  if (!secondAccepted.accepted) return;
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      (route) =>
        route.alias === "codex-main@this-mac" && route.queueDepth === 2,
    ),
  );

  codex.emitRouteState(THREAD_ID, "stale", "CODEX_ROUTE_STALE");
  await waitForAsync(async () => {
    const current = await handlers.listSnapshot();
    return current.routes.some(
      (route) =>
        route.alias === "codex-main@this-mac" && route.state === "stale",
    );
  });
  const status = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found && !status.terminal, true);
  if (status.found) {
    assert.equal(status.state, "queued");
  }
  const secondStatus = await handlers.deliveryStatus({
    token: secondAccepted.deliveryToken,
  });
  assert.equal(secondStatus.found && !secondStatus.terminal, true);
  if (secondStatus.found) {
    assert.equal(secondStatus.state, "queued");
  }
  assert.equal(codex.dispatches.length, 0);
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    snapshot.routes.some(
      (route) =>
        route.alias === "codex-main@this-mac" &&
        route.state === "stale" &&
        route.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
    true,
    JSON.stringify(snapshot.routes),
  );
  assert.equal(
    snapshot.connectors.some(
      (connector) =>
        connector.provider === "codex" &&
        connector.health === "degraded" &&
        connector.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" &&
        event.state === "held",
    ),
    true,
  );
  assert.equal(
    snapshot.alerts.some(
      (alert) =>
        alert.code === "CODEX_ROUTE_STALE" &&
        alert.severity === "error" &&
        alert.alias === "codex-main@this-mac",
    ),
    true,
  );
  assert.deepEqual(
    await handlers.sendToCodex(toCodex("uds:/synthetic/claude.sock")),
    { accepted: false, code: "unavailable" },
  );

  codex.emitRouteState(THREAD_ID, "idle");
  await waitForAsync(async () => {
    const recovered = await handlers.listSnapshot();
    return (
      recovered.routes.some(
        (route) =>
          route.alias === "codex-main@this-mac" &&
          route.state === "idle",
      ) &&
      recovered.connectors.some(
        (connector) =>
          connector.provider === "codex" &&
          connector.health === "healthy",
      )
    );
  });
  await waitFor(() => codex.dispatches.length === 1);
  const delivered = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(delivered.found && delivered.state === "delivered", true);
  const stillQueued = await handlers.deliveryStatus({
    token: secondAccepted.deliveryToken,
  });
  assert.equal(
    stillQueued.found &&
      !stillQueued.terminal &&
      stillQueued.state === "queued",
    true,
  );
});

test("idle Codex re-registration wakes an already-held native message without another route notification", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "wake this exact held body once",
    receiptHandle: "receipt-reregister-wake",
  });

  await waitForAsync(async () => {
    const snapshot = await handlers.listSnapshot();
    return (
      snapshot.routes.some(
        (route) =>
          route.alias === "codex-main@this-mac" && route.queueDepth === 1,
      ) &&
      snapshot.messages.some(
        (event) =>
          event.direction === "claude_to_codex" && event.state === "held",
      )
    );
  });
  assert.equal(codex.dispatches.length, 0);

  codex.dispatchResults.push({ state: "delivered" });
  codex.state = "idle";
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  // No emitRouteState call follows registration: the returned idle state must
  // wake the existing queue by itself.
  await waitFor(() => codex.dispatches.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(codex.dispatches.length, 1);
  assert.equal(codex.dispatches[0]?.text, "wake this exact held body once");
  await waitForAsync(async () => {
    const snapshot = await handlers.listSnapshot();
    return (
      snapshot.routes.some(
        (route) =>
          route.alias === "codex-main@this-mac" && route.queueDepth === 0,
      ) &&
      snapshot.messages.some(
        (event) =>
          event.direction === "claude_to_codex" && event.state === "delivered",
      )
    );
  });
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-reregister-wake",
      status: "held",
    },
    {
      receiptHandle: "receipt-reregister-wake",
      status: "delivered",
    },
  ]);
});

test("exact STEER prefix bypasses older ordinary work only at a busy Codex boundary", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  codex.dispatchResults.push({ state: "delivered" });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());

  const endpoint = { ...claude.identity, routeHandle: "claude_target_1" };
  claude.callbacks?.onClaudeMessage?.({
    endpoint,
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "ordinary work remains in normal queue order",
    receiptHandle: "receipt-ordinary-before-steer",
  });
  claude.callbacks?.onClaudeMessage?.({
    endpoint,
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "STEER: inspect the next tool result",
    receiptHandle: "receipt-steer-direct",
  });

  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() =>
    claude.nativeInboundStatuses.some(
      ({ receiptHandle, status }) =>
        receiptHandle === "receipt-steer-direct" && status === "delivered",
    ),
  );
  assert.equal(codex.dispatches[0]?.text, "STEER: inspect the next tool result");
  assert.equal(codex.dispatches[0]?.steer, true);
  assert.equal(codex.dispatches[0]?.expectsReply, false);
  assert.equal(codex.dispatches[0]?.queuedAhead, 1);
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-steer-direct",
    ),
    [{ receiptHandle: "receipt-steer-direct", status: "delivered" }],
  );
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-ordinary-before-steer",
    ),
    [{ receiptHandle: "receipt-ordinary-before-steer", status: "held" }],
  );
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(
    snapshot.messages.some(
      (event) => event.steer === true && event.state === "delivered",
    ),
    true,
  );
  assert.equal(
    snapshot.routes.find(({ alias }) => alias === "codex-main@this-mac")
      ?.queueDepth,
    1,
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.state === "queued" &&
        event.steer === undefined &&
        event.direction === "claude_to_codex",
    ),
    true,
  );

});

test("clean Claude prewrite gaps retry boundedly without waiting for an idle observation", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.dispatchResults.push(
    {
      state: "deferred",
      safeErrorCode: "CLAUDE_PEER_WORKSPACE_UNATTESTED",
    },
    { state: "pending" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "5000",
    }),
    adapters: [claude, new FakeProvider("codex")],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const accepted = await service.handlers().sendToClaude({
    ...toClaude("reattest after the route returns"),
    expectsReply: false,
    trackIdleMinutes: 1,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.progressWatchActive, true);

  await clock.advanceBy(499);
  assert.equal(claude.dispatches.length, 1);
  assert.equal(
    (await service.handlers().listSnapshot()).messages.some(
      (event) =>
        event.state === "held" &&
        event.safeErrorCode === "CLAUDE_PEER_WORKSPACE_UNATTESTED",
    ),
    true,
  );

  await clock.advanceBy(1);
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.progressWatchActive, true);
  claude.emitDelivery({
    messageId: claude.dispatches[1]!.messageId,
    state: "transport_written",
  });
  await waitForAsync(async () => {
    const status = await service.handlers().deliveryStatus({
      token: accepted.deliveryToken,
    });
    return status.found && status.terminal;
  });
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.state, "delivered");
    assert.equal(status.safeErrorCode, undefined);
  }
});

test("a long Claude prewrite outage backs off without observing route idle", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.state = "busy";
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "busy",
    },
  ];
  claude.dispatchResults.push(
    ...Array.from({ length: 20 }, () => ({
      state: "deferred" as const,
      safeErrorCode: "CLAUDE_PEER_TARGET_STALE",
    })),
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "3600000",
    }),
    adapters: [claude, new FakeProvider("codex")],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("bounded mailbox retry"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const internal = service as unknown as {
    dispatchRunnerTargets: Set<string>;
    deliveryTrackers: Map<
      string,
      { machine: { dispatchRetryAt: number | null } }
    >;
  };
  await waitFor(() => claude.dispatches.length === 1);

  const retryDelays = [
    500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000,
    128_000, 256_000, 300_000, 300_000, 300_000,
  ];
  for (const [index, expectedDelay] of retryDelays.entries()) {
    await waitFor(
      () =>
        typeof [...internal.deliveryTrackers.values()][0]?.machine
          .dispatchRetryAt === "number" &&
        internal.dispatchRunnerTargets.size === 0,
    );
    const retryAt = [...internal.deliveryTrackers.values()][0]?.machine
      .dispatchRetryAt;
    assert.equal(typeof retryAt, "number");
    if (typeof retryAt !== "number") return;
    const delay = retryAt - clock.nowMs;
    assert.equal(delay, expectedDelay);
    await clock.advanceBy(delay);
    await waitFor(() => claude.dispatches.length === index + 2).catch(() => {
      assert.fail(
        `retry ${index + 1} expected ${index + 2} dispatches, observed ${claude.dispatches.length}`,
      );
    });
  }
  assert.equal(claude.dispatches.length, 14);
  assert.equal(
    (await service.handlers().listSnapshot()).messages.some(
      ({ safeErrorCode }) => safeErrorCode === "CLAUDE_PEER_TARGET_STALE",
    ),
    true,
  );
});

test("Claude control ingress classifies only the exact leading STEER prefix", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  codex.dispatchResults.push({ state: "delivered" });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const exact = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "STEER: classify this exact leading prefix",
  });
  assert.equal(exact.accepted, true);
  if (!exact.accepted) return;
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches[0]?.steer, true);
  assert.equal(codex.dispatches[0]?.expectsReply, false);
  assert.equal(codex.dispatches[0]?.queuedAhead, undefined);
  assert.deepEqual(dispatchProvenance(codex.dispatches[0]!), {
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    conversationId: exact.conversationId,
    text: "STEER: classify this exact leading prefix",
  });

  const inexact = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: " STEER: leading whitespace remains ordinary",
  });
  assert.equal(inexact.accepted, true);
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(codex.dispatches.length, 1);
  assert.equal(
    (await handlers.listSnapshot()).messages.some(
      (event) =>
        event.state === "queued" &&
        event.steer === undefined &&
        event.direction === "claude_to_codex",
    ),
    true,
  );

  const reverse = await handlers.sendToClaude(
    toClaude("STEER: the reverse direction remains ordinary"),
  );
  assert.equal(reverse.accepted, true);
  if (!reverse.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.steer, undefined);
  assert.deepEqual(dispatchProvenance(claude.dispatches[0]!), {
    sourceAlias: "codex-main@this-mac",
    targetAlias: "claude-one@this-mac",
    conversationId: reverse.conversationId,
    text: "STEER: the reverse direction remains ordinary",
  });
});

test("a steering dispatch does not replace the active ordinary turn owner", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push(
    { state: "accepted" },
    { state: "delivered" },
    { state: "delivered" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const ordinary = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    expectsReply: false,
    text: "ordinary turn owns the active dispatch slot",
  });
  assert.equal(ordinary.accepted, true);
  await waitFor(() => codex.dispatches.length === 1);
  const ordinaryMessageId = codex.dispatches[0]?.messageId;
  assert.ok(ordinaryMessageId);

  const steer = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "STEER: coexist without replacing the owner",
  });
  assert.equal(steer.accepted, true);
  await waitFor(() => codex.dispatches.length === 2);
  assert.equal(codex.dispatches[1]?.steer, true);

  const waiting = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    expectsReply: false,
    text: "ordinary work must still wait for the original owner",
  });
  assert.equal(waiting.accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(codex.dispatches.length, 2);

  codex.emitDelivery({ messageId: ordinaryMessageId, state: "completed" });
  codex.state = "idle";
  codex.emitRouteState(THREAD_ID, "idle");
  await waitFor(() => codex.dispatches.length === 3);
  assert.equal(
    codex.dispatches[2]?.text,
    "ordinary work must still wait for the original owner",
  );
  assert.equal(codex.dispatches[2]?.steer, undefined);
});

test("steering kill switch leaves exact prefixes in the ordinary queue", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_STEERING_ENABLED: "0",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "STEER: globally disabled",
    receiptHandle: "receipt-steer-disabled",
  });

  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(codex.dispatches.length, 0);
  assert.equal(
    (await service.handlers().listSnapshot()).messages.some(
      (event) => event.steer === true,
    ),
    false,
  );
});

test("a fourth queued steer supersedes the oldest with one normal terminal receipt", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "awaiting_approval";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  for (let index = 1; index <= 4; index += 1) {
    claude.callbacks?.onClaudeMessage?.({
      endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      text: `STEER: queued instruction ${index}`,
      receiptHandle: `receipt-steer-cap-${index}`,
    });
  }

  await waitForAsync(async () => {
    const snapshot = await service.handlers().listSnapshot();
    return (
      snapshot.routes.some(
        ({ alias, queueDepth }) =>
          alias === "codex-main@this-mac" && queueDepth === 3,
      ) &&
      claude.nativeInboundStatuses.some(
        ({ receiptHandle, status }) =>
          receiptHandle === "receipt-steer-cap-1" && status === "expired",
      )
    );
  });
  assert.deepEqual(
    claude.nativeInboundStatuses.filter(
      ({ receiptHandle }) => receiptHandle === "receipt-steer-cap-1",
    ),
    [
      {
        receiptHandle: "receipt-steer-cap-1",
        status: "held",
      },
      {
        receiptHandle: "receipt-steer-cap-1",
        status: "expired",
        diagnosticCode: "STEER_QUEUE_SUPERSEDED",
      },
    ],
  );
  assert.deepEqual(
    new Set(
      claude.nativeInboundStatuses
        .filter(({ receiptHandle, status }) =>
          receiptHandle.startsWith("receipt-steer-cap-") && status === "held",
        )
        .map(({ receiptHandle }) => receiptHandle),
    ),
    new Set([
      "receipt-steer-cap-1",
      "receipt-steer-cap-2",
      "receipt-steer-cap-3",
      "receipt-steer-cap-4",
    ]),
  );
  assert.equal(codex.dispatches.length, 0);
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.steer === true &&
        event.state === "cancelled" &&
        event.safeErrorCode === "STEER_QUEUE_SUPERSEDED",
    ),
    true,
  );
});

test("native Claude ingress acknowledges held only after a real provider deferral", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push(
    { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" },
    { state: "accepted" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const onClaudeMessage = claude.callbacks?.onClaudeMessage;
  assert.ok(onClaudeMessage);
  onClaudeMessage({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "native lifecycle status probe",
    receiptHandle: "receipt-native-1",
  });

  await waitFor(() => codex.dispatches.length === 2);
  await waitFor(() => claude.nativeInboundStatuses.length === 2);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-native-1", status: "held" },
    { receiptHandle: "receipt-native-1", status: "delivered" },
  ]);
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "held",
    ),
    true,
  );
  assert.equal(
    claude.nativeCodexStatuses.some(
      ({ alias, status }) =>
        alias === "codex-main@this-mac" && status === "waiting",
    ),
    true,
  );
});

test("native ingress emits held after the prompt boundary and then one terminal acknowledgement", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "accepted" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "5000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    releaseDispatch?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "prompt-boundary receipt probe",
    receiptHandle: "receipt-prompt-boundary",
  });
  await dispatchEntered;
  await clock.advanceBy(999);
  assert.deepEqual(claude.nativeInboundStatuses, []);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-prompt-boundary", status: "held" },
  ]);

  releaseDispatch?.();
  await waitFor(() => claude.nativeInboundStatuses.length === 2);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-prompt-boundary", status: "held" },
    { receiptHandle: "receipt-prompt-boundary", status: "delivered" },
  ]);
});

test("a long provider dispatch does not starve control or later Codex observations", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "accepted" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    releaseDispatch?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  await dispatchEntered;

  await clock.advanceBy(90_000);
  codex.emitRouteState(THREAD_ID, "busy");
  const firstObservation = handlers.listSnapshot();
  assert.equal(
    await Promise.race([
      Promise.resolve(firstObservation).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]),
    true,
  );
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, lastSeenAt }) =>
        alias === "codex-main@this-mac" &&
        lastSeenAt === "2026-08-08T12:01:30.000Z",
    ),
  );

  await clock.advanceBy(1_000);
  codex.emitRouteState(THREAD_ID, "busy");
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, lastSeenAt }) =>
        alias === "codex-main@this-mac" &&
        lastSeenAt === "2026-08-08T12:01:31.000Z",
    ),
  );

  releaseDispatch?.();
  await waitForAsync(async () => {
    const snapshot = await handlers.deliveryStatus({
      token: accepted.deliveryToken,
    });
    return snapshot.found && snapshot.terminal;
  });
  assert.equal(codex.dispatches.length, 1);
});

test("connector freshness expiry republishes the static dashboard after one publish failure", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const published: GatewayPublicSnapshot[] = [];
  let failNextPublish = false;
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [
      new FakeProvider("claude"),
      new FakeProvider("codex"),
      new FakeProvider("grok"),
    ],
    now: clock.now,
    timers: clock,
    publishDashboard: async (_stateDirectory, snapshot) => {
      if (failNextPublish) {
        failNextPublish = false;
        throw new Error("synthetic one-shot dashboard failure");
      }
      published.push(snapshot);
      return path.join(stateDir, "gateway-dashboard.html");
    },
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(
    published.at(-1)?.connectors.find(({ provider }) => provider === "grok")
      ?.health,
    "healthy",
  );

  failNextPublish = true;
  await clock.advanceBy(35_001);
  await clock.advanceBy(250);
  await waitFor(
    () =>
      published.at(-1)?.connectors.find(
        ({ provider }) => provider === "grok",
      )?.health === "degraded",
  );
});

test("a dispatch whose selected endpoint changes settles ambiguous without replay", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex", "codex_generation_before_dispatch");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "accepted" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    releaseDispatch?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  await dispatchEntered;

  const previous = { ...codex.identity };
  codex.identity.endpointGeneration = "codex_generation_after_dispatch";
  codex.callbacks?.onEndpointRefresh?.({
    previous,
    current: { ...codex.identity },
    routes: [{ routeHandle: THREAD_ID, state: "busy" }],
  });
  await waitForAsync(async () =>
    (await service.store.inspectPrivateRoute("codex-main@this-mac"))?.binding
      .endpointGeneration === "codex_generation_after_dispatch",
  );

  releaseDispatch?.();
  let terminalState: string | undefined;
  await waitForAsync(async () => {
    const status = await handlers.deliveryStatus({
      token: accepted.deliveryToken,
    });
    if (!status.found || !status.terminal) return false;
    terminalState = status.state;
    return true;
  });
  assert.equal(terminalState, "ambiguous");
  assert.equal(codex.dispatches.length, 1);
});

test("a clean-prewrite result cannot overwrite a newer stale route observation", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "deferred", safeErrorCode: "ROUTE_UNAVAILABLE" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    releaseDispatch?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);
  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await dispatchEntered;

  codex.emitRouteState(THREAD_ID, "stale", "CODEX_ROUTE_STALE");
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, state }) =>
        alias === "codex-main@this-mac" && state === "stale",
    ),
  );
  releaseDispatch?.();
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, state, queueDepth }) =>
        alias === "codex-main@this-mac" &&
        state === "stale" &&
        queueDepth === 1,
    ),
  );
  await clock.advanceBy(500);
  assert.equal(codex.dispatches.length, 1);
  const status = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found && status.terminal, false);
});

test("shutdown settles an invoked provider dispatch ambiguous and never replays it", async () => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "accepted" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  try {
    await service.start();
    const handlers = service.handlers();
    await selectAndRegister(handlers);
    await handlers.sendToCodex(toCodex("uds:/synthetic/claude.sock"));
    await dispatchEntered;
    const stateFilePath = service.store.stateFilePath;

    await service.close();
    const persisted = JSON.parse(await readFile(stateFilePath, "utf8")) as {
      events: Array<{ state: string; safeErrorCode?: string }>;
    };
    assert.equal(
      persisted.events.some(
        ({ state, safeErrorCode }) =>
          state === "ambiguous" &&
          safeErrorCode === "DISPATCH_OUTCOME_AMBIGUOUS",
      ),
      true,
    );
    releaseDispatch?.();
    await immediate();
    assert.equal(codex.dispatches.length, 1);
  } finally {
    releaseDispatch?.();
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a commit preamble failure preserves provider outcome uncertainty", async () => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "accepted" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  try {
    await service.start();
    const handlers = service.handlers();
    await selectAndRegister(handlers);
    await handlers.sendToCodex(toCodex("uds:/synthetic/claude.sock"));
    await dispatchEntered;
    const internal = service as unknown as {
      processLifecycleLocked: () => Promise<boolean>;
      dispatchRunnerTargets: Set<string>;
    };
    const processLifecycleLocked =
      internal.processLifecycleLocked.bind(service);
    let failOnce = true;
    internal.processLifecycleLocked = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("synthetic commit preamble failure");
      }
      return await processLifecycleLocked();
    };
    const stateFilePath = service.store.stateFilePath;

    releaseDispatch?.();
    await waitFor(() => internal.dispatchRunnerTargets.size === 0);
    await service.close();
    const persisted = JSON.parse(await readFile(stateFilePath, "utf8")) as {
      events: Array<{ state: string; safeErrorCode?: string }>;
    };
    assert.equal(
      persisted.events.some(
        ({ state, safeErrorCode }) =>
          state === "ambiguous" &&
          safeErrorCode === "DISPATCH_OUTCOME_AMBIGUOUS",
      ),
      true,
    );
    assert.equal(codex.dispatches.length, 1);
  } finally {
    releaseDispatch?.();
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex doctor evidence refreshes outside routing authority", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  let condition: "split_brain" | "orphaned" = "split_brain";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
    codexDoctor: async () => ({ conditions: [condition] }),
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    (await service.snapshot()).connectors.find(
      (connector) => connector.provider === "codex",
    )?.codexDoctor?.conditions,
    ["split_brain"],
  );
  condition = "orphaned";
  await clock.advanceBy(30_000);
  assert.deepEqual(
    (await service.snapshot()).connectors.find(
      (connector) => connector.provider === "codex",
    )?.codexDoctor?.conditions,
    ["orphaned"],
  );
});

test("a terminal provider callback observed before the prompt boundary suppresses held", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  let markDispatchEntered: (() => void) | undefined;
  let releaseDispatch: (() => void) | undefined;
  const dispatchEntered = new Promise<void>((resolve) => {
    markDispatchEntered = resolve;
  });
  const dispatchMayFinish = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  codex.dispatch = async (input) => {
    codex.dispatches.push({ ...input, binding: { ...input.binding } });
    markDispatchEntered?.();
    await dispatchMayFinish;
    return { state: "pending" };
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "5000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    releaseDispatch?.();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "pre-boundary terminal probe",
    receiptHandle: "receipt-pre-boundary-terminal",
  });
  await dispatchEntered;
  await clock.advanceBy(999);
  const messageId = codex.dispatches[0]?.messageId;
  assert.ok(messageId);
  codex.callbacks?.onDelivery({ messageId, state: "completed" });
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-pre-boundary-terminal", status: "delivered" },
  ]);

  releaseDispatch?.();
  await immediate();
  await immediate();
  assert.equal(
    claude.nativeInboundStatusAttempts.some(({ status }) => status === "held"),
    false,
  );
});

test("native held retries only a proven clean pre-write and never duplicates progress", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.nativeInboundStatusFailures.push(
    new BridgeError("SYNTHETIC_HELD_PREWRITE", "not written", true),
  );
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "5000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "clean held retry probe",
    receiptHandle: "receipt-held-clean-retry",
  });
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, []);
  await clock.advanceBy(249);
  assert.equal(claude.nativeInboundStatusAttempts.length, 1);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 2);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-held-clean-retry", status: "held" },
  ]);
  await clock.advanceBy(1_000);
  assert.equal(
    claude.nativeInboundStatusAttempts.filter(({ status }) => status === "held")
      .length,
    2,
  );
});

test("an ambiguous native held write is never replayed or allowed to downgrade terminal truth", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.nativeInboundStatusFailures.push(
    new BridgeError("SYNTHETIC_HELD_AMBIGUOUS", "write may have started"),
  );
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "ambiguous held probe",
    receiptHandle: "receipt-held-ambiguous",
  });
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 1);
  await clock.advanceBy(999);
  assert.equal(claude.nativeInboundStatusAttempts.length, 1);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-held-ambiguous",
      status: "expired",
      diagnosticCode: "MESSAGE_EXPIRED",
    },
  ]);
  assert.equal(
    claude.nativeInboundStatusAttempts.filter(({ status }) => status === "held")
      .length,
    1,
  );
});

test("open inbound accepts an exact unselected native Claude peer and returns only its correlated reply", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({
    state: "delivered",
    replyText: "correlated reply only",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "unselected native ingress",
    receiptHandle: "receipt-unselected-native",
  });

  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() => claude.dispatches.length === 1);
  const nativeConversationId = codex.dispatches[0]!.conversationId;
  assert.match(nativeConversationId, /^conv_[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(dispatchProvenance(codex.dispatches[0]!), {
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    conversationId: nativeConversationId,
    text: "unselected native ingress",
  });
  assert.equal(codex.dispatches[0]?.authorization, "selected_route");
  assert.equal(claude.dispatches[0]?.authorization, "native_reply");
  assert.equal(claude.dispatches[0]?.binding.routeHandle, "claude_target_1");
  assert.equal(claude.dispatches[0]?.text, "correlated reply only");
  assert.deepEqual(dispatchProvenance(claude.dispatches[0]!), {
    sourceAlias: "codex-main@this-mac",
    targetAlias: "claude-one@this-mac",
    conversationId: nativeConversationId,
    text: "correlated reply only",
  });
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-unselected-native", status: "delivered" },
  ]);

  assert.deepEqual(await handlers.sendToClaude(toClaude("unsolicited")), {
    accepted: false,
    code: "rejected",
  });
  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes.map((route) => route.alias),
    ["codex-main@this-mac"],
  );
  assert.deepEqual(
    snapshot.availablePeers.map(({ alias, selected }) => ({ alias, selected })),
    [{ alias: "claude-one@this-mac", selected: false }],
  );
  assert.equal(snapshot.inboundMode, "open");
  assert.equal(JSON.stringify(snapshot).includes(nativeConversationId), false);
  assert.equal(
    (await readFile(service.store.stateFilePath, "utf8")).includes(
      nativeConversationId,
    ),
    false,
  );
  assert.equal(
    (
      await readFile(
        path.join(stateDir, "gateway-dashboard.html"),
        "utf8",
      )
    ).includes(nativeConversationId),
    false,
  );
});

test("paired inbound terminally refuses an unselected native sender and accepts it after selection", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadBaseGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "PAIRED_REFUSAL_PRIVATE_BODY",
    receiptHandle: "receipt-not-paired",
  });
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-not-paired",
      status: "expired",
      diagnosticCode: "SENDER_NOT_PAIRED",
    },
  ]);
  assert.equal(codex.dispatches.length, 0);
  const refused = await handlers.listSnapshot();
  assert.equal(refused.inboundMode, "paired");
  assert.equal(
    refused.routes.find((route) => route.provider === "codex")?.queueDepth,
    0,
  );
  assert.equal(
    refused.messages.some(
      (event) =>
        event.state === "rejected" &&
        event.safeErrorCode === "SENDER_NOT_PAIRED" &&
        event.sourceAlias === "claude-one@this-mac" &&
        event.targetAlias === "codex-main@this-mac",
    ),
    true,
  );
  assert.equal(
    JSON.stringify(refused).includes("PAIRED_REFUSAL_PRIVATE_BODY"),
    false,
  );

  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  codex.dispatchResults.push({ state: "delivered" });
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "paired sender accepted",
    receiptHandle: "receipt-paired",
  });
  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() => claude.nativeInboundStatuses.length === 2);
  assert.deepEqual(claude.nativeInboundStatuses.at(-1), {
    receiptHandle: "receipt-paired",
    status: "delivered",
  });
  assert.equal(
    claude.nativeInboundStatusAttempts.some(
      ({ receiptHandle, status }) =>
        receiptHandle === "receipt-paired" && status === "held",
    ),
    false,
  );
});

test("native Claude ingress reports delivery errors as expired with a safe diagnostic", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({
    state: "failed",
    safeErrorCode: "CODEX_ROUTE_UNAVAILABLE",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "native delivery failure",
    receiptHandle: "receipt-native-failed",
  });

  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-failed",
      status: "expired",
      diagnosticCode: "CODEX_ROUTE_UNAVAILABLE",
    },
  ]);
});

test("a held native message emits one distinct stall notice then one terminal expiry", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "bounded native deadline probe",
    receiptHandle: "receipt-native-deadline",
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );

  await clock.advanceBy(499);
  assert.deepEqual(claude.nativeInboundProgress, []);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundProgress.length === 1);
  assert.deepEqual(claude.nativeInboundProgress, [
    {
      receiptHandle: "receipt-native-deadline",
      reason: "ROUTE_BUSY",
      queuedForMs: 500,
    },
  ]);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-deadline",
      status: "held",
    },
  ]);
  const stalled = await handlers.listSnapshot();
  assert.equal(
    stalled.alerts.some(
      ({ code, alias }) =>
        code === "QUEUE_STALLED" && alias === "codex-main@this-mac",
    ),
    true,
  );

  await clock.advanceBy(500);
  await waitFor(() => claude.nativeInboundStatuses.length === 2);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-deadline",
      status: "held",
    },
    {
      receiptHandle: "receipt-native-deadline",
      status: "expired",
      diagnosticCode: "MESSAGE_EXPIRED",
    },
  ]);
  assert.equal(
    claude.nativeInboundStatusAttempts.filter(({ status }) => status === "held")
      .length,
    1,
  );
  assert.equal(
    (await handlers.listSnapshot()).routes.find(
      ({ alias }) => alias === "codex-main@this-mac",
    )?.queueDepth,
    0,
  );
  codex.emitRouteState(THREAD_ID, "idle");
  await immediate();
  await immediate();
  assert.equal(codex.dispatches.length, 0);
});

test("a recoverable stall pre-write retries without duplicating the sender notice", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.nativeInboundProgressFailures.push(
    new BridgeError("SYNTHETIC_STALL_PREWRITE", "not written", true),
  );
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "retry only a proven stall pre-write",
    receiptHandle: "receipt-stall-retry",
  });
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ queueDepth }) => queueDepth === 1,
    ),
  );

  await clock.advanceBy(499);
  assert.equal(claude.nativeInboundProgressAttempts.length, 0);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundProgressAttempts.length === 1);
  assert.equal(claude.nativeInboundProgress.length, 0);
  await clock.advanceBy(249);
  assert.equal(claude.nativeInboundProgressAttempts.length, 1);
  await clock.advanceBy(1);
  await waitFor(() => claude.nativeInboundProgressAttempts.length === 2);
  assert.deepEqual(claude.nativeInboundProgress, [
    {
      receiptHandle: "receipt-stall-retry",
      reason: "ROUTE_BUSY",
      queuedForMs: 750,
    },
  ]);
  await clock.advanceBy(249);
  assert.equal(claude.nativeInboundProgressAttempts.length, 2);
  await clock.advanceBy(1);
  assert.equal(claude.nativeInboundProgressAttempts.length, 2);
});

test("a synchronous terminal callback wins over explicit provider acceptance", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.synchronousDispatchDelivery = {
    messageId: "msg_placeholder",
    state: "failed",
    safeErrorCode: "SYNCHRONOUS_PROVIDER_FAILURE",
  };
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitForAsync(async () => {
    const status = await service.handlers().deliveryStatus({
      token: accepted.deliveryToken,
    });
    return status.found && status.terminal;
  });
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.state, "failed");
    assert.equal(status.safeErrorCode, "SYNCHRONOUS_PROVIDER_FAILURE");
  }
  assert.equal(
    (await service.handlers().listSnapshot()).messages.some(
      ({ state }) => state === "delivered",
    ),
    false,
  );
});

test("dispatch drains predeadline write evidence before exact-cutoff result or throw", async () => {
  const cases = [
    {
      label: "terminal return after confirmed write",
      delivery: { state: "transport_written" } as const,
      throws: false,
      expectedState: "delivered",
      expectedCode: undefined,
    },
    {
      label: "throw after uncertain write",
      delivery: {
        state: "transport_uncertain",
        safeErrorCode: "SYNTHETIC_TRANSPORT_OUTCOME_UNCERTAIN",
      } as const,
      throws: true,
      expectedState: "ambiguous",
      expectedCode: "SYNTHETIC_TRANSPORT_OUTCOME_UNCERTAIN",
    },
  ] as const;

  for (const candidate of cases) {
    const { root, stateDir } = await fixture();
    const clock = new ManualGatewayClock();
    const claude = new FakeProvider("claude");
    claude.discoveries = [
      {
        alias: "claude-one@this-mac",
        routeHandle: "claude_target_1",
        kind: "interactive",
        state: "idle",
      },
    ];
    claude.dispatch = async (input) => {
      claude.dispatches.push({ ...input, binding: { ...input.binding } });
      clock.nowMs += 999;
      claude.callbacks?.onDelivery({
        messageId: input.messageId,
        ...candidate.delivery,
      });
      clock.nowMs += 1;
      if (candidate.throws) {
        throw new Error("synthetic dispatch throw after write evidence");
      }
      return {
        state: "failed",
        safeErrorCode: "SYNTHETIC_TERMINAL_RETURN_AT_CUTOFF",
      };
    };
    const codex = new FakeProvider("codex");
    const service = new GatewayService({
      config: loadGatewayConfig({
        EMBASSY_STATE_DIR: stateDir,
        EMBASSY_HOSTS: "this-mac",
        EMBASSY_MESSAGE_DEADLINE_MS: "1000",
      }),
      adapters: [claude, codex],
      now: clock.now,
      timers: clock,
    });
    try {
      await service.start();
      await selectAndRegister(service.handlers());
      const accepted = await service.handlers().sendToClaude({
        ...toClaude(candidate.label),
        expectsReply: false,
      });
      assert.equal(accepted.accepted, true, candidate.label);
      if (!accepted.accepted) continue;
      await waitFor(() => claude.dispatches.length === 1);
      const status = await service.handlers().deliveryStatus({
        token: accepted.deliveryToken,
      });
      assert.equal(status.found, true, candidate.label);
      if (status.found) {
        assert.equal(status.state, candidate.expectedState, candidate.label);
        assert.equal(status.safeErrorCode, candidate.expectedCode, candidate.label);
      }
      const snapshot = await service.handlers().listSnapshot();
      assert.equal(
        snapshot.accounting[candidate.expectedState],
        1,
        candidate.label,
      );
      assert.equal(snapshot.accounting.failed, 0, candidate.label);
      assert.equal(snapshot.accounting.expired, 0, candidate.label);
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("write evidence overrides a contradictory deferred return without replay", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.synchronousDispatchDelivery = {
    messageId: "msg_placeholder",
    state: "transport_written",
  };
  claude.dispatchResults.push({
    state: "deferred",
    safeErrorCode: "SYNTHETIC_CLEAN_PREWRITE_CONTRADICTION",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, new FakeProvider("codex")],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("contradictory deferred result must not replay"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  const terminal = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(terminal.found, true);
  if (terminal.found) {
    assert.equal(terminal.state, "delivered");
    assert.equal(terminal.safeErrorCode, undefined);
  }
  await clock.advanceBy(1_000);
  assert.equal(claude.dispatches.length, 1);
});

test("terminal callback arrival time arbitrates the exact delivery deadline", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({ state: "pending" });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const beforeDeadline = await service.handlers().sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(beforeDeadline.accepted, true);
  if (!beforeDeadline.accepted) return;
  await waitFor(() => codex.dispatches.length === 1);
  await clock.advanceBy(999);
  codex.emitDelivery({
    messageId: codex.dispatches[0]!.messageId,
    state: "completed",
  });
  // A duplicate of the same terminal at the exact cutoff must not overwrite
  // the authoritative pre-deadline observation retained above.
  clock.nowMs += 1;
  codex.emitDelivery({
    messageId: codex.dispatches[0]!.messageId,
    state: "completed",
  });
  const beforeStatus = await service.handlers().deliveryStatus({
    token: beforeDeadline.deliveryToken,
  });
  assert.equal(beforeStatus.found, true);
  if (beforeStatus.found) assert.equal(beforeStatus.state, "delivered");

  codex.emitRouteState(THREAD_ID, "idle");
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ alias, state }) =>
        alias === "codex-main@this-mac" && state === "idle",
    ),
  );
  codex.dispatchResults.push({ state: "pending" });
  const atDeadline = await service.handlers().sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(atDeadline.accepted, true);
  if (!atDeadline.accepted) return;
  await waitFor(() => codex.dispatches.length === 2);
  // Move to the exact cutoff without yielding to the due timer, enqueue the
  // provider terminal at that instant, then force one lifecycle read.
  clock.nowMs += 1_000;
  codex.emitDelivery({
    messageId: codex.dispatches[1]!.messageId,
    state: "completed",
  });
  const exactStatus = await service.handlers().deliveryStatus({
    token: atDeadline.deliveryToken,
  });
  assert.equal(exactStatus.found, true);
  if (exactStatus.found) {
    assert.equal(exactStatus.state, "expired");
    assert.equal(exactStatus.safeErrorCode, "DELIVERY_DEADLINE_EXPIRED");
  }
});

test("plain pending remains nonterminal and expires instead of leaking forever", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({ state: "pending" });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => codex.dispatches.length === 1);
  await clock.advanceBy(1_000);
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.terminal, true);
    assert.equal(status.state, "expired");
    assert.equal(status.safeErrorCode, "DELIVERY_DEADLINE_EXPIRED");
  }
  assert.equal((await service.handlers().listSnapshot()).accounting.queuedBytes, 0);
});

test("predeadline transport uncertainty survives callback delay and settles ambiguous", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("write began but never produced a native receipt"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);

  await clock.advanceBy(999);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "transport_uncertain",
    safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
  });
  // Do not yield the callback worker. Its service-boundary timestamp is still
  // predeadline and must be reduced before the deadline event below.
  clock.nowMs += 1;
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.terminal, true);
    assert.equal(status.state, "ambiguous");
    assert.equal(
      status.safeErrorCode,
      "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
    );
  }
});

test("confirmed Claude transport is the delivered boundary without a native receipt", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("confirmed socket write without universal native ack"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "transport_written",
  });
  await immediate();
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.terminal, true);
    assert.equal(status.state, "delivered");
    assert.equal(status.safeErrorCode, undefined);
  }
});

test("Codex acceptance settles the body while preserving final reply correlation", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "accepted body with later reply",
    receiptHandle: "receipt-accepted-reply",
  });
  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-accepted-reply", status: "delivered" },
  ]);
  assert.equal((await service.handlers().listSnapshot()).accounting.queuedBytes, 0);

  codex.emitDelivery({
    messageId: codex.dispatches[0]!.messageId,
    state: "completed",
    replyText: "final reply survives acceptance",
  });
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.authorization, "native_reply");
  assert.equal(claude.dispatches[0]?.text, "final reply survives acceptance");
});

test("accepted provider-turn correlation expires independently and releases its dispatch slot", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "accepted body whose provider turn never completes",
  });
  await waitFor(() => codex.dispatches.length === 1);
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).messages.some(
      ({ state }) => state === "delivered",
    ),
  );

  await clock.advanceBy(500);
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "next body waits only for the provider continuation slot",
  });
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ alias, queueDepth }) =>
        alias === "codex-main@this-mac" && queueDepth === 1,
    ),
  );
  await clock.advanceBy(500);
  codex.emitRouteState(THREAD_ID, "idle");
  await waitFor(() => codex.dispatches.length === 2);
  assert.equal(
    (await service.handlers().listSnapshot()).alerts.some(
      ({ code }) => code === "PROVIDER_REPLY_DEADLINE_EXPIRED",
    ),
    true,
  );
});

test("close terminally settles a native callback already queued for service handling", async () => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  try {
    await service.start();
    await discoverAndRegisterCodexOnly(service.handlers());
    claude.callbacks?.onClaudeMessage?.({
      endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      text: "queued immediately before close",
      receiptHandle: "receipt-queued-at-close",
    });
    await service.close();
    assert.deepEqual(claude.nativeInboundStatuses, [
      {
        receiptHandle: "receipt-queued-at-close",
        status: "expired",
        diagnosticCode: "GATEWAY_SHUTDOWN",
      },
    ]);
    assert.ok(
      claude.lifecycleEvents.indexOf("status:expired") <
        claude.lifecycleEvents.indexOf("provider:close"),
    );
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown quiesces late native ingress before its final detached drain", async () => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  try {
    await service.start();
    await discoverAndRegisterCodexOnly(service.handlers());
    claude.nativeMessageOnQuiesce = {
      endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      text: "arrived during shutdown quiescence",
      receiptHandle: "receipt-late-quiesce",
    };
    await service.close();
    assert.deepEqual(claude.nativeInboundStatuses, [
      {
        receiptHandle: "receipt-late-quiesce",
        status: "expired",
        diagnosticCode: "GATEWAY_SHUTDOWN",
      },
    ]);
    assert.ok(
      claude.lifecycleEvents.indexOf("provider:quiesce-native") <
        claude.lifecycleEvents.indexOf("status:expired"),
    );
    assert.ok(
      claude.lifecycleEvents.indexOf("status:expired") <
        claude.lifecycleEvents.indexOf("provider:close"),
    );
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery tokens expose queued, stalled, and exact terminal states", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);
  const deadlineAt = new Date(clock.nowMs + 1_000).toISOString();
  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  assert.match(accepted.deliveryToken, /^dlv_[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(await handlers.deliveryStatus({ token: accepted.deliveryToken }), {
    found: true,
    state: "queued",
    terminal: false,
    updatedAt: clock.now().toISOString(),
    deadlineAt,
    pendingForMs: 0,
  });

  await clock.advanceBy(500);
  assert.deepEqual(await handlers.deliveryStatus({ token: accepted.deliveryToken }), {
    found: true,
    state: "stalled",
    terminal: false,
    updatedAt: clock.now().toISOString(),
    deadlineAt,
    pendingForMs: 500,
  });
  await clock.advanceBy(500);
  assert.deepEqual(await handlers.deliveryStatus({ token: accepted.deliveryToken }), {
    found: true,
    state: "expired",
    terminal: true,
    updatedAt: clock.now().toISOString(),
    deadlineAt,
    safeErrorCode: "MESSAGE_EXPIRED",
  });
});

test("progress watches survive restart, nudge through the ordinary queue, and settle boundedly", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.dispatchResults.push({ state: "delivered" });
  const codex = new FakeProvider("codex");
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const store = new GatewayStore(config, { now: clock.now });
  const service = new GatewayService({
    config,
    store,
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const accepted = await handlers.sendToClaude({
    ...toClaude("please complete the bounded task"),
    expectsReply: false,
    trackIdleMinutes: 1,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(
    (await store.publicSnapshot()).progressWatches?.[0]?.nudgeCount,
    0,
  );
  await service.close();

  const recoveredClaude = new FakeProvider("claude");
  recoveredClaude.discoveries = claude.discoveries.map((peer) => ({ ...peer }));
  recoveredClaude.dispatchResults.push(
    { state: "delivered" },
    { state: "delivered" },
  );
  const recoveredStore = new GatewayStore(config, { now: clock.now });
  const recoveredService = new GatewayService({
    config,
    store: recoveredStore,
    adapters: [
      recoveredClaude,
      new FakeProvider("codex", "generation_codex_after_restart"),
    ],
    now: clock.now,
    timers: clock,
  });
  await recoveredService.start();
  t.after(async () => {
    await recoveredService.close();
    await rm(root, { recursive: true, force: true });
  });
  const recoveredHandlers = recoveredService.handlers();
  await recoveredHandlers.refreshDashboard();
  assert.equal(
    (await recoveredStore.publicSnapshot()).progressWatches?.length,
    1,
  );

  await clock.advanceBy(60_000);
  await recoveredHandlers.listSnapshot();
  await waitFor(() => recoveredClaude.dispatches.length === 1);
  assert.match(recoveredClaude.dispatches[0]!.text, /automated liveness check/);
  assert.match(
    recoveredClaude.dispatches[0]!.text,
    new RegExp(accepted.conversationId),
  );
  assert.deepEqual(
    (await recoveredStore.publicSnapshot()).progressWatches?.map(
      ({ nudgeCount }) => nudgeCount,
    ),
    [1],
  );

  await clock.advanceBy(60_000);
  await recoveredHandlers.listSnapshot();
  await waitFor(() => recoveredClaude.dispatches.length === 2);
  assert.deepEqual(
    (await recoveredStore.publicSnapshot()).progressWatches?.map(
      ({ nudgeCount }) => nudgeCount,
    ),
    [2],
  );

  await clock.advanceBy(120_000);
  await recoveredHandlers.listSnapshot();
  const settledSnapshot = await recoveredStore.publicSnapshot();
  assert.deepEqual(settledSnapshot.progressWatches ?? [], []);
  const settledEvent = settledSnapshot.progressWatchEvents?.at(-1);
  assert.deepEqual(
    settledEvent === undefined
      ? undefined
      : {
          kind: settledEvent.kind,
          actor: settledEvent.actor,
          reason: settledEvent.reason,
        },
    { kind: "settled", actor: "gateway", reason: "idle_timeout" },
  );
});

test("explicit Codex unregister attributes its progress-watch settlement to the operator", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.dispatchResults.push({ state: "delivered" });
  const codex = new FakeProvider("codex");
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const store = new GatewayStore(config);
  const service = new GatewayService({
    config,
    store,
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);
  const tracked = await handlers.sendToClaude({
    ...toClaude("operator-attributed unregister"),
    expectsReply: false,
    trackIdleMinutes: 1,
  });
  assert.equal(tracked.accepted, true);
  if (!tracked.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  await waitForAsync(async () => {
    const status = await handlers.deliveryStatus({
      token: tracked.deliveryToken,
    });
    return status.found && status.state === "delivered";
  });

  assert.deepEqual(
    await handlers.unregisterCodex({
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  const settlement = (await store.publicSnapshot()).progressWatchEvents?.at(-1);
  assert.deepEqual(
    settlement === undefined
      ? undefined
      : {
          kind: settlement.kind,
          actor: settlement.actor,
          reason: settlement.reason,
        },
    { kind: "settled", actor: "operator", reason: "endpoint_retired" },
  );
});

test("TRACK marks watched delivery and worker DONE closes the watch", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  claude.dispatchResults.push({ state: "delivered" }, { state: "delivered" });
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({ state: "delivered" });
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const store = new GatewayStore(config);
  const service = new GatewayService({
    config,
    store,
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const reverse = await handlers.sendToCodex({
    ...toCodex("uds:/synthetic/claude.sock"),
    text: "TRACK: supervise the Codex task",
    expectsReply: false,
  });
  assert.equal(reverse.accepted, true);
  if (!reverse.accepted) return;
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches[0]?.progressWatchActive, true);
  assert.equal(
    (await store.publicSnapshot()).progressWatches?.[0]?.workerAlias,
    "codex-main@this-mac",
  );
  const ownerConflict = await handlers.sendToClaude({
    ...toClaude("TRACK: counterparty cannot replace this watch"),
    expectsReply: false,
  });
  assert.deepEqual(ownerConflict, {
    accepted: false,
    code: "watch_owner_conflict",
  });
  assert.deepEqual(
    await handlers.untrack({ conversationId: reverse.conversationId }),
    { accepted: true, code: "ok" },
  );
  codex.dispatches.length = 0;
  codex.emitRouteState(THREAD_ID, "idle");
  await immediate();

  const opened = await handlers.sendToClaude({
    ...toClaude("TRACK: keep this long-running exchange visible"),
    expectsReply: true,
  });
  assert.equal(opened.accepted, true);
  if (!opened.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  assert.deepEqual(dispatchProvenance(claude.dispatches[0]!), {
    sourceAlias: "codex-main@this-mac",
    targetAlias: "claude-one@this-mac",
    conversationId: opened.conversationId,
    text: "TRACK: keep this long-running exchange visible",
  });
  assert.equal(claude.dispatches[0]?.progressWatchActive, true);
  assert.equal(
    (await store.publicSnapshot()).progressWatches?.[0]?.ownerAlias,
    "codex-main@this-mac",
  );

  const workerHint = await handlers.reply({
    conversationId: opened.conversationId,
    text: "DONE: worker reports the result is ready",
    caller: {
      kind: "claude",
      alias: "claude-one@this-mac",
      replyAddress: "uds:/synthetic/claude.sock",
    },
  });
  assert.equal(workerHint.accepted, true, JSON.stringify(workerHint));
  await waitFor(() => codex.dispatches.length === 1);
  assert.deepEqual(dispatchProvenance(codex.dispatches[0]!), {
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    conversationId: opened.conversationId,
    text: "DONE: worker reports the result is ready",
  });
  assert.equal(codex.dispatches[0]?.progressWatchActive, undefined);
  assert.deepEqual((await store.publicSnapshot()).progressWatches ?? [], []);
  const completionEvent = (
    await handlers.listSnapshot()
  ).progressWatchEvents?.at(-1);
  assert.equal(completionEvent?.kind, "settled");
  assert.equal(completionEvent?.actor, "worker");
  assert.equal(completionEvent?.reason, "done");

  const ownerDone = await handlers.reply({
    conversationId: opened.conversationId,
    text: "DONE: thank you",
    caller: {
      kind: "codex",
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    },
  });
  assert.equal(ownerDone.accepted, true);
  assert.deepEqual((await store.publicSnapshot()).progressWatches ?? [], []);

  const second = await handlers.sendToClaude({
    ...toClaude("TRACK: another bounded watch"),
    expectsReply: false,
  });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  assert.deepEqual(await handlers.untrack({ conversationId: second.conversationId }), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual((await store.publicSnapshot()).progressWatches ?? [], []);
});

test("every accepted send and reply gets a fresh process-local delivery token", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  claude.state = "busy";
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "busy",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const first = new GatewayService({
    config,
    adapters: [claude, codex],
  });
  let successor: GatewayService | undefined;
  await first.start();
  t.after(async () => {
    await successor?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });

  const handlers = first.handlers();
  await selectAndRegister(handlers);
  const sentToClaude = await handlers.sendToClaude({
    ...toClaude("token for Claude"),
    expectsReply: false,
  });
  assert.equal(sentToClaude.accepted, true);
  if (!sentToClaude.accepted) return;

  const sentToCodex = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(sentToCodex.accepted, true);
  if (!sentToCodex.accepted) return;

  const replied = await handlers.reply({
    conversationId: sentToClaude.conversationId,
    text: "fresh token for reply",
    caller: {
      kind: "codex",
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    },
  });
  assert.equal(replied.accepted, true);
  if (!replied.accepted) return;

  const tokens = [
    sentToClaude.deliveryToken,
    sentToCodex.deliveryToken,
    replied.deliveryToken,
  ];
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.match(token, /^dlv_[A-Za-z0-9_-]{24}$/);
    assert.equal((await handlers.deliveryStatus({ token })).found, true);
  }

  await first.close();
  successor = new GatewayService({ config, adapters: [] });
  await successor.start();
  for (const token of tokens) {
    assert.deepEqual(await successor.handlers().deliveryStatus({ token }), {
      found: false,
    });
  }
});

test("delivery-token pressure evicts only the oldest terminal cohort", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
    EMBASSY_MAX_QUEUE_MESSAGES: "16",
    EMBASSY_MAX_QUEUE_PER_ROUTE: "16",
    EMBASSY_MAX_IN_FLIGHT: "1",
    EMBASSY_RATE_LIMIT: "1000",
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config,
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const terminalCohorts: string[][] = [];
  for (const count of [16, 16, 16, 15]) {
    const cohort: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const accepted = await handlers.sendToCodex(
        toCodex("uds:/synthetic/claude.sock"),
      );
      assert.equal(accepted.accepted, true);
      if (accepted.accepted) cohort.push(accepted.deliveryToken);
    }
    terminalCohorts.push(cohort);
    assert.deepEqual(
      await handlers.unregisterCodex({
        alias: "codex-main@this-mac",
        threadId: THREAD_ID,
      }),
      { accepted: true, code: "ok" },
    );
    await clock.advanceBy(1);
    assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
      accepted: true,
      code: "ok",
    });
    assert.deepEqual(
      await handlers.pair({
        claudeAlias: "claude-one@this-mac",
        codexAlias: "codex-main@this-mac",
        codexThreadId: THREAD_ID,
      }),
      { accepted: true, code: "ok" },
    );
  }

  const active = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(active.accepted, true);
  if (!active.accepted) return;
  assert.equal(
    (await handlers.deliveryStatus({ token: active.deliveryToken })).found,
    true,
  );

  const afterPressure = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(afterPressure.accepted, true);
  if (!afterPressure.accepted) return;

  const firstCohortStatuses = await Promise.all(
    terminalCohorts[0]!.map(async (token) =>
      await handlers.deliveryStatus({ token }),
    ),
  );
  assert.equal(
    firstCohortStatuses.filter(({ found }) => !found).length,
    1,
  );
  for (const cohort of terminalCohorts.slice(1)) {
    for (const token of cohort) {
      assert.equal((await handlers.deliveryStatus({ token })).found, true);
    }
  }
  const activeStatus = await handlers.deliveryStatus({
    token: active.deliveryToken,
  });
  assert.equal(activeStatus.found, true);
  if (activeStatus.found) assert.equal(activeStatus.terminal, false);
  assert.equal(
    (await handlers.deliveryStatus({ token: afterPressure.deliveryToken }))
      .found,
    true,
  );
});

test("native terminal acknowledgement retries only clean pre-write failures", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.nativeInboundStatusFailures.push(
    new BridgeError("SYNTHETIC_PREWRITE", "not written", true),
    new BridgeError("SYNTHETIC_PREWRITE", "not written", true),
  );
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "retry terminal status only before write",
    receiptHandle: "receipt-native-retry",
  });
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ queueDepth }) => queueDepth === 1,
    ),
  );
  await clock.advanceBy(1_000);
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 1);
  assert.equal(claude.nativeInboundStatusAttempts.length, 1);
  assert.deepEqual(claude.nativeInboundStatuses, []);
  await clock.advanceBy(250);
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 2);
  assert.equal(claude.nativeInboundStatusAttempts.length, 2);
  await clock.advanceBy(500);
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 3);
  assert.equal(claude.nativeInboundStatusAttempts.length, 3);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-retry",
      status: "expired",
      diagnosticCode: "MESSAGE_EXPIRED",
    },
  ]);
  assert.deepEqual(claude.releasedNativeReceipts, []);
});

test("ambiguous terminal native acknowledgement is never replayed and releases its receipt", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await discoverAndRegisterCodexOnly(service.handlers());
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "ambiguous terminal status",
    receiptHandle: "receipt-native-ambiguous",
  });
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).routes.some(
      ({ queueDepth }) => queueDepth === 1,
    ),
  );
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-native-ambiguous", status: "held" },
  ]);
  claude.nativeInboundStatusFailures.push(
    new BridgeError("SYNTHETIC_AMBIGUOUS", "write may have started"),
  );
  await clock.advanceBy(1_000);
  await waitFor(() => claude.nativeInboundStatusAttempts.length === 2);
  assert.equal(claude.nativeInboundStatusAttempts.length, 2);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-native-ambiguous", status: "held" },
  ]);
  assert.deepEqual(claude.releasedNativeReceipts, [
    "receipt-native-ambiguous",
  ]);
  await clock.advanceBy(5_000);
  assert.equal(claude.nativeInboundStatusAttempts.length, 2);
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(
    snapshot.alerts.some(
      ({ code }) => code === "NATIVE_RECEIPT_UNCONFIRMED",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      ({ state, safeErrorCode }) =>
        state === "expired" && safeErrorCode === "MESSAGE_EXPIRED",
    ),
    true,
  );
  assert.equal(JSON.stringify(snapshot).includes("SYNTHETIC_AMBIGUOUS"), false);
});

test("shutdown preserves queued native ingress as waiting before closing its provider", async () => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  try {
    await service.start();
    await discoverAndRegisterCodexOnly(service.handlers());
    claude.callbacks?.onClaudeMessage?.({
      endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
      sourceAlias: "claude-one@this-mac",
      targetAlias: "codex-main@this-mac",
      text: "shutdown terminal receipt",
      receiptHandle: "receipt-native-shutdown",
    });
    await waitForAsync(async () =>
      (await service.handlers().listSnapshot()).routes.some(
        ({ queueDepth }) => queueDepth === 1,
      ),
    );
    await service.close();
    assert.deepEqual(claude.nativeInboundStatuses, [
      {
        receiptHandle: "receipt-native-shutdown",
        status: "held",
      },
    ]);
    assert.ok(
      claude.lifecycleEvents.indexOf("status:held") <
        claude.lifecycleEvents.indexOf("provider:close"),
    );
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("route removal returns terminal settlements to held native senders", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "route removal settlement",
    receiptHandle: "receipt-native-unregister",
  });
  await waitForAsync(async () =>
    (await handlers.listSnapshot()).routes.some(
      ({ queueDepth }) => queueDepth === 1,
    ),
  );
  assert.deepEqual(
    await handlers.unregisterCodex({
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-unregister",
      status: "held",
    },
    {
      receiptHandle: "receipt-native-unregister",
      status: "expired",
      diagnosticCode: "ROUTE_UNREGISTERED",
    },
  ]);
  assert.deepEqual((await handlers.listSnapshot()).routes, []);
});

test("a selected busy Claude peer receives mailbox writes immediately", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "busy",
    },
  ];
  claude.state = "busy";
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const message = toClaude("mailbox write while Claude is busy");
  message.expectsReply = false;
  assert.equal((await service.handlers().sendToClaude(message)).accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.text, "mailbox write while Claude is busy");
  assert.equal(
    (await service.handlers().listSnapshot()).routes.find(
      ({ alias }) => alias === "claude-one@this-mac",
    )?.state,
    "busy",
  );
});

test("queued bodies survive close and remain held until exact route recovery", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const first = new GatewayService({
    config,
    adapters: [claude, codex],
  });
  await first.start();
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = first.handlers();
  await selectAndRegister(handlers);
  assert.equal(
    (await handlers.sendToCodex(toCodex("uds:/synthetic/claude.sock"))).accepted,
    true,
  );
  await immediate();
  // Busy routes durably retain the body without dispatching it.
  assert.equal(codex.dispatches.length, 0);
  await first.close();

  second = new GatewayService({
    config,
    adapters: [],
  });
  await second.start();
  const snapshot = await second.snapshot();
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.state === "cancelled" &&
        event.safeErrorCode === "GATEWAY_SHUTDOWN",
    ),
    false,
  );
  assert.equal(snapshot.accounting.queuedBytes, Buffer.byteLength(SECRET));
  assert.equal((await readFile(second.store.stateFilePath, "utf8")).includes(SECRET), true);
  await second.close();
});

test("Claude transport-written releases the next mailbox write without an idle observation", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config,
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const first = toClaude("serial-one");
  first.expectsReply = false;
  const second = toClaude("serial-two");
  second.expectsReply = false;
  assert.equal((await handlers.sendToClaude(first)).accepted, true);
  assert.equal((await handlers.sendToClaude(second)).accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(claude.dispatches.length, 1);

  const active = claude.dispatches[0];
  assert.ok(active);
  claude.emitDelivery({
    messageId: active.messageId,
    state: "transport_written",
  });
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.text, "serial-two");
  const next = claude.dispatches[1];
  assert.ok(next);
  claude.emitDelivery({
    messageId: next.messageId,
    state: "transport_written",
  });
  await immediate();
  await service.close();
});

test("adapter cleanup failures reject close after controller cleanup completes", async () => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const claudeFailure = new BridgeError(
    "SYNTHETIC_CLAUDE_CLEANUP_FAILED",
    "Synthetic Claude cleanup was not confirmed.",
  );
  const codexFailure = new BridgeError(
    "SYNTHETIC_CODEX_CLEANUP_FAILED",
    "Synthetic Codex cleanup was not confirmed.",
  );
  claude.closeError = claudeFailure;
  codex.closeError = codexFailure;
  const service = new GatewayService({
    config,
    adapters: [claude, codex],
  });
  let successor: GatewayService | undefined;
  try {
    await service.start();
    await assert.rejects(service.close(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "GATEWAY_CLEANUP_FAILED");
      assert.equal(
        error.message,
        "The gateway could not confirm cleanup of every owned resource.",
      );
      assert.equal(error.message.includes("Synthetic"), false);
      return true;
    });
    assert.equal(claude.closed, true);
    assert.equal(codex.closed, true);

    // A failed provider cleanup must be visible to the caller, while the
    // controller-owned store lock and control socket are still released.
    successor = new GatewayService({
      config,
      adapters: [],
    });
    await successor.start();
    assert.equal((await successor.handlers().health()).status, "ok");
  } finally {
    await successor?.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("callback pressure never evicts authoritative delivery write evidence", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("write evidence must survive callback pressure"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  await clock.advanceBy(999);
  const messageId = claude.dispatches[0]!.messageId;
  claude.emitDelivery({
    messageId,
    state: "transport_uncertain",
    safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
  });

  const internal = service as unknown as {
    callbackCapacity: number;
    callbackQueue: Array<{
      type: string;
      value?: { messageId?: string };
    }>;
    enqueueCallback(event: unknown): boolean;
  };
  while (internal.callbackQueue.length < internal.callbackCapacity) {
    internal.callbackQueue.push({
      type: "delivery",
      value: { messageId: `synthetic-capacity-${internal.callbackQueue.length}` },
    });
  }
  assert.equal(
    internal.enqueueCallback({
      type: "route",
      source: { ...claude.identity },
      value: { routeHandle: "capacity-probe", state: "idle" },
    }),
    false,
  );
  assert.equal(
    internal.callbackQueue.some(
      (candidate) => candidate.value?.messageId === messageId,
    ),
    true,
  );

  clock.nowMs += 1;
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.state, "ambiguous");
    assert.equal(
      status.safeErrorCode,
      "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
    );
  }
});

test("a missing delivery tracker settles the ledger and releases the target", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const first = await service.handlers().sendToClaude({
    ...toClaude("synthetic missing tracker"),
    expectsReply: false,
  });
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const internal = service as unknown as {
    deliveryTokens: Map<string, string>;
    deliveryTrackers: Map<string, unknown>;
  };
  const messageId = internal.deliveryTokens.get(first.deliveryToken);
  assert.ok(messageId);
  internal.deliveryTrackers.delete(messageId);

  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).alerts.some(
      ({ code }) => code === "DELIVERY_TRACKER_MISSING",
    ),
  );
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(snapshot.accounting.queuedBytes, 0);
  assert.equal(
    snapshot.messages.some(
      ({ state, safeErrorCode }) =>
        state === "failed" && safeErrorCode === "DELIVERY_TRACKER_MISSING",
    ),
    true,
  );
  assert.equal(claude.dispatches.length, 0);

  const second = await service.handlers().sendToClaude({
    ...toClaude("target remains usable after recovery"),
    expectsReply: false,
  });
  assert.equal(second.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
});

test("terminal write ambiguity releases the expired reply authority", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const first = await service.handlers().sendToClaude(
    toClaude("ambiguous request with reply authority"),
  );
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "transport_uncertain",
    safeErrorCode: "CLAUDE_TRANSPORT_OUTCOME_UNCERTAIN",
  });
  await clock.advanceBy(1_000);
  const terminal = await service.handlers().deliveryStatus({
    token: first.deliveryToken,
  });
  assert.equal(terminal.found, true);
  if (terminal.found) assert.equal(terminal.state, "ambiguous");

  const next = await service.handlers().sendToClaude(
    toClaude("new reply authority after ambiguity cutoff"),
  );
  assert.equal(next.accepted, true);
});

test("a failed terminal ledger write retries before the machine absorbs it", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const originalSettleMessage = service.store.settleMessage.bind(service.store);
  let settlementAttempts = 0;
  service.store.settleMessage = async (input) => {
    settlementAttempts += 1;
    if (settlementAttempts === 1) {
      throw new BridgeError(
        "SYNTHETIC_LEDGER_WRITE_FAILED",
        "Synthetic atomic write failure.",
        true,
      );
    }
    return await originalSettleMessage(input);
  };

  const accepted = await service.handlers().sendToClaude({
    ...toClaude("terminal settlement must retry"),
    expectsReply: true,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "released",
    replyText: "reply correlation survives the ledger retry",
  });
  await waitFor(() => settlementAttempts === 1);
  const beforeRetry = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(beforeRetry.found, true);
  if (beforeRetry.found) assert.equal(beforeRetry.terminal, false);

  await clock.advanceBy(250);
  await waitFor(() => settlementAttempts === 2);
  const afterRetry = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(afterRetry.found, true);
  if (afterRetry.found) {
    assert.equal(afterRetry.terminal, true);
    assert.equal(afterRetry.state, "delivered");
  }
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(
    codex.dispatches[0]?.text,
    "reply correlation survives the ledger retry",
  );
  assert.equal((await service.handlers().listSnapshot()).accounting.queuedBytes, 0);
});

test("route teardown preserves a non-Codex reply retained by a failed terminal ledger write", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const deepseek = new FakeProvider("deepseek");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex, deepseek],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const deepseekBinding: PrivateRouteBinding = {
    ...deepseek.identity,
    routeHandle: "deepseek_target_1",
    ownerLease: createHash("sha256").update("deepseek\0deepseek_target_1").digest("hex"),
  };
  await service.store.registerRoute({ alias: "dsh-main@this-mac", binding: deepseekBinding, registrationMode: "explicit_opt_in", state: "idle" });
  const internal = service as unknown as {
    rememberBinding(alias: string, binding: PrivateRouteBinding, state: GatewayAdapterRouteState): void;
    enqueue(source: string, target: string, text: string, expectsReply: boolean): Promise<{ conversationId: string; messageId: string; deliveryToken?: string }>;
    conversations: Map<string, unknown>;
    enqueueObservedClaudeReplyAfterRouteTeardownLocked(conversation: unknown, source: PrivateRouteBinding, expectedTarget: PrivateRouteBinding, text: string): Promise<void>;
  };
  internal.rememberBinding("dsh-main@this-mac", deepseekBinding, "idle");
  assert.deepEqual(await service.handlers().pair({ aliases: ["claude-one@this-mac", "dsh-main@this-mac"] }), { accepted: true, code: "ok" });
  assert.deepEqual(await service.handlers().unpair({ aliases: ["claude-one@this-mac", "codex-main@this-mac"] }), { accepted: true, code: "ok" });
  const claudeRoute = await service.store.inspectPrivateRoute("claude-one@this-mac");
  assert.ok(claudeRoute);
  const originalSettleMessage = service.store.settleMessage.bind(service.store);
  let failFirstTerminal = true;
  service.store.settleMessage = async (input) => {
    if (failFirstTerminal) {
      failFirstTerminal = false;
      throw new BridgeError(
        "SYNTHETIC_LEDGER_WRITE_FAILED",
        "Synthetic atomic write failure before route teardown.",
        true,
      );
    }
    return await originalSettleMessage(input);
  };

  const accepted = await internal.enqueue("dsh-main@this-mac", "claude-one@this-mac", "route teardown resolves retained reply", true);
  assert.ok(accepted.deliveryToken);
  await waitFor(() => claude.dispatches.length === 1);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "released",
    replyText: "retained reply survives atomic route teardown settlement",
  });
  await waitFor(() => failFirstTerminal === false);
  const conversation = internal.conversations.get(accepted.conversationId);
  assert.ok(conversation);
  await assert.rejects(
    internal.enqueueObservedClaudeReplyAfterRouteTeardownLocked(conversation, claudeRoute.binding, { ...deepseekBinding, ownerLease: "f".repeat(64) }, "must not transfer"),
    (error: unknown) => error instanceof BridgeError && error.code === "RECOVERED_REPLY_ROUTE_MISMATCH",
  );
  assert.equal(deepseek.dispatches.length, 0);
  deepseek.dispatchResults.push({ state: "delivered" });

  assert.deepEqual(
    await service.handlers().unpair({ aliases: ["claude-one@this-mac", "dsh-main@this-mac"] }),
    { accepted: true, code: "ok" },
  );
  assert.equal((await service.handlers().listSnapshot()).routes.some(({ provider }) => provider === "claude"), false);
  await waitFor(() => deepseek.dispatches.length === 1);
  const status = await service.handlers().deliveryStatus({ token: accepted.deliveryToken });
  assert.equal(status.found, true);
  if (status.found) assert.equal(status.state, "delivered");
  assert.equal(
    deepseek.dispatches[0]?.text,
    "retained reply survives atomic route teardown settlement",
  );
  await waitForAsync(async () =>
    (await service.handlers().listSnapshot()).accounting.delivered === 2,
  );
  assert.equal(
    (await service.handlers().listSnapshot()).accounting.delivered,
    2,
  );
});

test("a Claude rename migrates an enqueue that is already scheduled to dispatch", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "old-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  await handlers.registerCodex(codexRegistration());
  await handlers.selectClaude({ alias: "old-name@this-mac" });

  const accepted = await handlers.sendToClaude({
    ...toClaude("scheduled body follows exact UUID rename"),
    toAlias: "old-name@this-mac",
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);
  claude.discoveries = [
    {
      alias: "new-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
    },
  ];
  await handlers.refreshDashboard();
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(
    claude.dispatches[0]?.text,
    "scheduled body follows exact UUID rename",
  );
});

test("operator decisions expose a bounded body-free activity ledger", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const service = new GatewayService({ config, adapters: [claude, codex] });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();

  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
  assert.deepEqual(
    await handlers.registerCodex({
      ...codexRegistration(),
      alias: "codex-other@this-mac",
    }),
    { accepted: false, code: "conflict" },
  );

  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.activityEvents?.map(
      ({ kind, action, outcome, aliases, operatorAction, safeErrorCode }) => ({
        kind,
        action,
        outcome,
        aliases,
        operatorAction,
        safeErrorCode,
      }),
    ),
    [
      {
        kind: "registration",
        action: "codex_registered",
        outcome: "accepted",
        aliases: ["codex-main@this-mac"],
        operatorAction: true,
        safeErrorCode: undefined,
      },
      {
        kind: "registration",
        action: "codex_registered",
        outcome: "rejected",
        aliases: ["codex-other@this-mac"],
        operatorAction: true,
        safeErrorCode: "CODEX_REGISTRATION_REBIND_FORBIDDEN",
      },
    ],
  );
  assert.equal(snapshot.truncation.activityEvents, 0);
  assert.equal(JSON.stringify(snapshot.activityEvents).includes(THREAD_ID), false);
});

test("snapshot observations ignore generatedAt but revision every public semantic surface", async () => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const store = new MutableSnapshotStore(
    config,
    semanticSnapshot(clock.now().toISOString()),
  );
  const service = new GatewayService({
    config,
    store,
    now: clock.now,
    timers: clock,
  });
  const internal = service as unknown as {
    availablePeers: GatewayPublicSnapshot["availablePeers"];
  };
  internal.availablePeers = [
    {
      alias: "claude-one@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "idle",
      validated: true,
      selected: false,
      lastSeenAt: clock.now().toISOString(),
    },
  ];

  const revisions: number[] = [];
  const observe = async (): Promise<GatewayPublicSnapshot> => {
    const observation = await service.handlers().observeSnapshot();
    revisions.push(observation.snapshotRevision);
    return observation.snapshot;
  };

  await observe();
  store.current.generatedAt = new Date(clock.nowMs + 1_000).toISOString();
  await observe();

  store.current.health = "degraded";
  await observe();
  store.current.connectors[0]!.health = "degraded";
  await observe();
  store.current.connectors[0]!.lastSeenAt = new Date(
    clock.nowMs + 2_000,
  ).toISOString();
  await observe();
  internal.availablePeers[0]!.lastSeenAt = new Date(
    clock.nowMs + 3_000,
  ).toISOString();
  await observe();
  store.current.routes[0]!.state = "busy";
  await observe();
  store.current.routes[0]!.counters.accepted += 1;
  await observe();
  store.current.messages.push({
    sequence: 1,
    timestamp: clock.now().toISOString(),
    messageIdSuffix: "0123abcd",
    direction: "claude_to_codex",
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    state: "queued",
    bytes: 1,
  });
  await observe();
  store.current.accounting.accepted += 1;
  await observe();
  store.current.alerts.push({
    code: "SYNTHETIC_PUBLIC_ALERT",
    severity: "warning",
    timestamp: clock.now().toISOString(),
    provider: "codex",
    host: "this-mac",
    alias: "codex-main@this-mac",
  });
  await observe();
  store.current.truncation.messages += 1;
  await observe();

  const almostStalledAt = clock.nowMs - config.stallNoticeMs + 1;
  store.current.routes[0]!.queueDepth = 1;
  store.current.routes[0]!.oldestQueuedAt = new Date(
    almostStalledAt,
  ).toISOString();
  let latest = await observe();
  assert.equal(latest.alerts.some(({ code }) => code === "QUEUE_STALLED"), false);
  clock.nowMs += 1;
  latest = await observe();
  assert.equal(latest.alerts.some(({ code }) => code === "QUEUE_STALLED"), true);

  assert.deepEqual(
    revisions,
    [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  const encoded = JSON.stringify(latest);
  assert.equal(encoded.includes(THREAD_ID), false);
  assert.equal(encoded.includes(CLAUDE_SESSION_ID), false);
  assert.equal(encoded.includes("endpointGeneration"), false);
  assert.equal(encoded.includes(SECRET), false);

  const restartedStore = new MutableSnapshotStore(
    config,
    structuredClone(store.current),
  );
  const restarted = new GatewayService({
    config,
    store: restartedStore,
    now: clock.now,
    timers: clock,
  });
  const restartedInternal = restarted as unknown as {
    availablePeers: GatewayPublicSnapshot["availablePeers"];
  };
  restartedInternal.availablePeers = structuredClone(internal.availablePeers);
  assert.equal(
    (await restarted.handlers().observeSnapshot()).snapshotRevision,
    0,
  );
  await rm(root, { recursive: true, force: true });
});

test("generic consent routes all ordered provider pairs from exact binding truth", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const deepseek = new FakeProvider("deepseek");
  const grok = new FakeProvider("grok");
  const otherGrok = new FakeProvider("grok");
  otherGrok.identity.hostId = "other-mac";
  claude.discoveries = [{
    alias: "codex-mask@this-mac",
    routeHandle: "claude_target_1",
    kind: "interactive",
    state: "idle",
  }];
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac,other-mac",
    }),
    adapters: [claude, codex, deepseek, grok, otherGrok],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  await handlers.registerCodex(codexRegistration());
  await handlers.selectClaude({ alias: "codex-mask@this-mac" });
  const internal = service as unknown as {
    rememberBinding(alias: string, binding: PrivateRouteBinding, state: GatewayAdapterRouteState): void;
    enqueue(source: string, target: string, text: string, expectsReply: boolean): Promise<unknown>;
  };
  const register = async (
    alias: string,
    adapter: FakeProvider,
    handle: string,
    state: GatewayAdapterRouteState = "idle",
  ): Promise<PrivateRouteBinding> => {
    const binding: PrivateRouteBinding = {
      ...adapter.identity,
      routeHandle: handle,
      ownerLease: createHash("sha256").update(`${adapter.identity.provider}\0${handle}`).digest("hex"),
    };
    await service.store.registerRoute({ alias, binding, registrationMode: "explicit_opt_in", state });
    internal.rememberBinding(alias, binding, state);
    return binding;
  };
  await register("dsh-main@this-mac", deepseek, "deepseek-route");
  await register("grok-main@this-mac", grok, "grok-route");
  await register("dsh-two@this-mac", deepseek, "deepseek-route-2");
  await register("grok-stale@this-mac", grok, "grok-route-stale");
  grok.emitRouteState("grok-route-stale", "stale", "SYNTHETIC_STALE");
  await waitForAsync(async () => (await service.store.inspectPrivateRoute("grok-stale@this-mac"))?.state === "stale");
  await register("grok-other@other-mac", otherGrok, "grok-route-other");
  await assert.rejects(
    internal.enqueue("dsh-main@this-mac", "grok-main@this-mac", "no edge", false),
    (error: unknown) => error instanceof BridgeError && error.code === "SENDER_NOT_PAIRED",
  );
  assert.deepEqual(await handlers.pair({
    aliases: ["dsh-main@this-mac", "grok-main@this-mac"],
    threadAttestation: { alias: "dsh-main@this-mac", threadId: THREAD_ID },
  }), { accepted: false, code: "route_mismatch" });
  for (const pair of [
    ["dsh-main@this-mac", "dsh-two@this-mac"],
    ["dsh-main@this-mac", "grok-stale@this-mac"],
    ["dsh-main@this-mac", "grok-other@other-mac"],
  ] as const) {
    assert.equal((await handlers.pair({ aliases: pair })).accepted, false);
  }

  const aliases = [
    "codex-mask@this-mac",
    "codex-main@this-mac",
    "dsh-main@this-mac",
    "grok-main@this-mac",
  ] as const;
  for (let left = 0; left < aliases.length; left += 1) {
    for (let right = left + 1; right < aliases.length; right += 1) {
      assert.deepEqual(await handlers.pair({ aliases: [aliases[left]!, aliases[right]!] }), {
        accepted: true,
        code: "ok",
      });
    }
  }
  assert.equal((await handlers.listSnapshot()).consentEdges.length, 6);
  const adapters = { claude, codex, deepseek, grok } as const;
  const providerByAlias = new Map(aliases.map((alias) => [
    alias,
    alias === "codex-mask@this-mac" ? "claude" : alias.startsWith("codex-") ? "codex" : alias.startsWith("dsh-") ? "deepseek" : "grok",
  ] as const));
  for (const source of aliases) {
    for (const target of aliases) {
      if (source === target) continue;
      const targetProvider = providerByAlias.get(target)!;
      const adapter = adapters[targetProvider];
      const before = adapter.dispatches.length;
      adapter.dispatchResults.push({ state: "delivered" });
      await internal.enqueue(source, target, `${source}->${target}`, false);
      await waitFor(() => adapter.dispatches.length === before + 1);
      assert.equal(adapter.dispatches.at(-1)?.sourceProvider, providerByAlias.get(source));
      adapter.emitRouteState(adapter.dispatches.at(-1)!.binding.routeHandle, "idle");
    }
  }
  const beforeNative = deepseek.dispatches.length;
  deepseek.dispatchResults.push({ state: "delivered" });
  claude.callbacks?.onClaudeMessage?.({
    endpoint: { ...claude.identity, routeHandle: "claude_target_1" },
    sourceAlias: "codex-mask@this-mac",
    targetAlias: "dsh-main@this-mac",
    text: "native all-to-all",
  });
  await waitFor(() => deepseek.dispatches.length === beforeNative + 1);
  assert.equal(deepseek.dispatches.at(-1)?.sourceProvider, "claude");
});

test("observe_snapshot processes due delivery lifecycle before one atomic result", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.state = "busy";
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "busy",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
      EMBASSY_MESSAGE_DEADLINE_MS: "1000",
    }),
    adapters: [claude, codex],
    now: clock.now,
    timers: clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());
  const accepted = await service.handlers().sendToClaude({
    ...toClaude("atomic lifecycle observation"),
    expectsReply: false,
  });
  assert.equal(accepted.accepted, true);

  const before = await service.handlers().observeSnapshot();
  assert.equal(before.snapshotRevision, 0);
  assert.equal(before.snapshot.accounting.queuedBytes > 0, true);
  const coarseBefore = (await service.handlers().health()).revision;

  // Do not run the fake timer: the read itself must process the due deadline.
  clock.nowMs += 1_000;
  const after = await service.handlers().observeSnapshot();
  assert.equal(after.snapshotRevision, 1);
  assert.equal(after.snapshot.accounting.queuedBytes, 0);
  assert.equal(
    after.snapshot.messages.some(
      ({ state, safeErrorCode }) =>
        state === "expired" && safeErrorCode === "DELIVERY_DEADLINE_EXPIRED",
    ),
    true,
  );
  const coarseAfter = (await service.handlers().health()).revision;
  assert.equal(coarseAfter >= coarseBefore, true);
  assert.notEqual(coarseAfter, after.snapshotRevision);
});
