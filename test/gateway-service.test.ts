import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
  type GatewayAdapterDispatchResult,
  type GatewayAdapterRouteObservationState,
  type GatewayAdapterRouteState,
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
    schemaVersion: 1,
    generatedAt,
    inboundMode: "paired",
    health: "healthy",
    connectors: [
      {
        provider: "claude",
        host: "this-mac",
        health: "healthy",
        compatibility: "compatible",
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
        compatibility: "compatible",
        busyPolicy: "queue",
        lastSeenAt: generatedAt,
        queueDepth: 0,
        counters,
      },
    ],
    pairs: [],
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
      pairs: 0,
      messages: 0,
      alerts: 0,
    },
  };
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
  readonly protocolVersion = "synthetic-1";
  discoveries: GatewayAdapterDiscovery[] = [];
  discoveryComplete = true;
  callbacks: GatewayAdapterCallbacks | undefined;
  dispatches: Array<{
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
    steer?: true;
  }> = [];
  attested: string[] = [];
  selectedRoutes: Array<{ alias: string; routeHandle: string }> = [];
  releasedRoutes: string[] = [];
  selectedRouteHandleOverride: string | undefined;
  closed = false;
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
  nativeCodexStatusFailures: Error[] = [];
  nativeCodexActiveAlias: string | undefined;
  nativeCodexGenerations = new Map<string, string>();
  nativeCodexPreparedAlias: string | undefined;
  nativeCodexActiveGeneration = "initial";
  nativeCodexPreparedGeneration: string | undefined;
  nativeCodexRetiredGeneration: string | undefined;
  nativeCodexIngressQuiesced = false;
  nativeCodexMonitorFrozen = false;
  nativeSuccessionBarrierClean = true;
  codexSuccessionBarrierClean = true;
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
    provider: "codex" | "claude",
    endpointGeneration = `generation_${provider}`,
  ) {
    this.identity = {
      provider,
      hostId: "this-mac",
      endpointGeneration,
    };
    this.protocol = provider === "codex" ? "codex-app-server" : "claude-peer";
    if (provider === "claude") {
      this.assertWorkspaceDisjoint = async (routeHandle) => {
        this.attested.push(routeHandle);
      };
    }
  }

  async initialize(callbacks: GatewayAdapterCallbacks): Promise<{
    health: "healthy";
    compatibility: "compatible";
  }> {
    this.callbacks = callbacks;
    return { health: "healthy", compatibility: "compatible" };
  }

  async discoverClaudePeers(): Promise<GatewayAdapterDiscoverySnapshot> {
    return {
      peers: this.discoveries.map((peer) => ({ ...peer })),
      complete: this.discoveryComplete,
    };
  }

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }> {
    this.selectedRoutes.push({ ...input });
    return {
      routeHandle: this.selectedRouteHandleOverride ?? input.routeHandle,
      state: this.state,
    };
  }

  async releaseRoute(routeHandle: string): Promise<void> {
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

  async dispatch(input: {
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
    steer?: true;
  }): Promise<GatewayAdapterDispatchResult> {
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

  async updateNativeCodexPeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    const failure = this.nativeCodexStatusFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeCodexStatuses.push({ alias, status });
  }

  async advertiseNativeCodexPeer(input: {
    alias: string;
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

  async unadvertiseNativeCodexPeer(alias: string): Promise<void> {
    const failure = this.nativeCodexUnadvertisementFailures.shift();
    if (failure !== undefined) throw failure;
    this.nativeCodexUnadvertisements.push(alias);
    this.nativeCodexGenerations.delete(alias);
    if (this.nativeCodexActiveAlias === alias) {
      this.nativeCodexActiveAlias = undefined;
    }
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
      routeCreationInFlight: false,
      routeReleaseInFlight: false,
      pendingReplyCorrelations: 0,
      pendingCallbacks: 0,
      clean:
        this.codexSuccessionBarrierClean &&
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

test("aborted startup cannot become active after an in-flight adapter initialization resumes", async () => {
  const { root, stateDir } = await fixture();
  const provider = new FakeProvider("claude");
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
    return { health: "healthy", compatibility: "compatible" };
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
    adapters: [provider],
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
    adapters: [provider],
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

test("failed post-restart Codex reactivation preserves and pins its persisted identity", async (t) => {
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
  assert.deepEqual(
    await second.handlers().registerCodex(codexRegistration()),
    { accepted: false, code: "rejected" },
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
  assert.deepEqual(secondCodex.releasedRoutes, []);
  assert.deepEqual(secondClaude.nativeCodexUnadvertisements, []);
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
    { alias: "codex-next@this-mac", routeHandle: OTHER_THREAD_ID },
  ]);
  assert.deepEqual(secondClaude.nativeCodexAdvertisements, [
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      ({ enabled, state, compatibility }) =>
        !enabled && state === "disabled" && compatibility === "expired",
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
    snapshot.routes.map(({ alias, enabled, state, compatibility }) => ({
      alias,
      enabled,
      state,
      compatibility,
    })),
    [
      {
        alias: "codex-main@this-mac",
        enabled: false,
        state: "disabled",
        compatibility: "expired",
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
      ({ enabled, state, compatibility }) =>
        !enabled && state === "disabled" && compatibility === "expired",
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
          compatibility: side.compatibility,
        },
    { enabled: true, state: "idle", compatibility: "compatible" },
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
      ({ alias, enabled, state, compatibility, queueDepth }) => ({
        alias,
        enabled,
        state,
        compatibility,
        queueDepth,
      }),
    ),
    [
      {
        alias: "codex-next@this-mac",
        enabled: false,
        state: "disabled",
        compatibility: "expired",
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
  assert.deepEqual(
    await second.handlers().registerCodex(codexRegistration()),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(secondCodex.selectedRoutes, [
    { alias: "codex-main@this-mac", routeHandle: THREAD_ID },
  ]);
});

test("fake end-to-end selection, dispatch, correlation, and reply authority stay metadata-only", async (t) => {
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
      compatibility: "compatible",
    },
    // Unsafe native names are not transformed into a public selector.
    {
      alias: "Claude Mixed@this-mac",
      routeHandle: "never_selected",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  // The mutation handler returns before any provider call is attempted.
  assert.equal(claude.dispatches.length, 0);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches.length, 1);
  assert.equal(claude.dispatches[0]?.text, SECRET);

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
  await waitFor(() => codex.dispatches.length === 2);
  const codexTurn = codex.dispatches[1];
  assert.ok(codexTurn);
  codex.emitDelivery({
    messageId: codexTurn.messageId,
    state: "completed",
    replyText: "bounded codex final",
  });
  await waitFor(() => claude.dispatches.length === 3);
  const codexReply = claude.dispatches[2];
  assert.ok(codexReply);
  assert.equal(codexReply.text, "bounded codex final");
  assert.equal(codexReply.expectsReply, false);
  assert.equal(Number.isFinite(Date.parse(codexReply.deadlineAt)), true);
  claude.emitDelivery({ messageId: codexReply.messageId, state: "released" });
  await immediate();

  const finalSnapshot = await handlers.listSnapshot();
  assert.equal(
    finalSnapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.hopCount === 1,
    ),
    true,
  );
  const stateText = await readFile(service.store.stateFilePath, "utf8");
  const dashboardText = await readFile(
    path.join(stateDir, "gateway-dashboard.html"),
    "utf8",
  );
  for (const forbidden of [
    SECRET,
    "synthetic reply",
    "late reply probe",
    "must be ignored after deadline",
    "bounded codex final",
  ]) {
    assert.equal(stateText.includes(forbidden), false);
  }
  // Exact route handles may exist only in the private controller state. They
  // must never enter the public dashboard or normalized snapshot.
  for (const forbidden of [
    SECRET,
    "synthetic reply",
    "late reply probe",
    "must be ignored after deadline",
    "bounded codex final",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  assert.deepEqual(snapshot.pairs.map(({ claudeAlias, codexAlias }) => ({
    claudeAlias,
    codexAlias,
  })), [
    {
      claudeAlias: "claude-one@this-mac",
      codexAlias: "codex-main@this-mac",
    },
    {
      claudeAlias: "claude-two@this-mac",
      codexAlias: "codex-main@this-mac",
    },
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
    afterUnpair.pairs.map(({ claudeAlias, codexAlias }) => ({
      claudeAlias,
      codexAlias,
    })),
    [
      {
        claudeAlias: "claude-two@this-mac",
        codexAlias: "codex-main@this-mac",
      },
    ],
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
      compatibility: "compatible",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-first-edge-unpair",
      status: "expired",
      diagnosticCode: "PAIR_REMOVED",
    },
  ]);
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
  await waitFor(() => claude.nativeInboundStatuses.length === 2);
  assert.equal(codex.dispatches[0]?.text, "adjacent edge remains queued");
  assert.deepEqual(claude.nativeInboundStatuses[1], {
    receiptHandle: "receipt-adjacent-edge-unpair",
    status: "delivered",
  });
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
      compatibility: "compatible",
    },
    {
      alias: "claude-two@this-mac",
      routeHandle: "claude_target_2",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
    snapshot.pairs.map(({ claudeAlias, codexAlias }) => ({
      claudeAlias,
      codexAlias,
    })),
    [
      {
        claudeAlias: "claude-one@this-mac",
        codexAlias: "codex-main@this-mac",
      },
    ],
  );
  assert.deepEqual(claude.releasedRoutes, ["claude_target_2"]);
  assert.equal(
    snapshot.availablePeers.find(
      (peer) => peer.alias === "claude-two@this-mac",
    )?.selected,
    false,
  );
});

test("a failed send publishes discovery invalidation exactly once", async (t) => {
  const { root, stateDir } = await fixture();
  const published: GatewayPublicSnapshot[] = [];
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "advisor@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("peer disappeared"),
      toAlias: "advisor@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "not_found" },
  );
  assert.equal((await handlers.health()).revision, revisionBefore + 1);
  assert.equal(published.length, publishedBefore + 1);
  assert.deepEqual(published.at(-1)?.availablePeers, []);
  assert.equal(
    published.at(-1)?.routes.find(
      (route) => route.alias === "advisor@this-mac",
    )?.state,
    "stale",
  );
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
      compatibility: "compatible",
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

test("authorized discovery restores one exact Claude UUID and atomically adopts only its latest name", async (t) => {
  const { root, stateDir } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude", "claude_generation_before");
  const firstCodex = new FakeProvider("codex");
  firstClaude.discoveries = [
    {
      alias: "old-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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

  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  const secondCodex = new FakeProvider("codex");
  secondClaude.discoveries = [
    {
      alias: "latest-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const second = new GatewayService({ config, adapters: [secondClaude, secondCodex] });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  await second.handlers().registerCodex(codexRegistration());

  const before = await second.snapshot();
  assert.equal(secondClaude.selectedRoutes.length, 0);
  assert.deepEqual(before.availablePeers, []);
  assert.equal(
    before.routes.find((route) => route.alias === "old-name@this-mac")?.state,
    "stale",
  );

  assert.deepEqual(await second.handlers().refreshDashboard(), {
    accepted: true,
    code: "ok",
    revision: 2,
  });
  assert.deepEqual(await second.handlers().refreshDashboard(), {
    accepted: true,
    code: "ok",
    revision: 2,
  });
  const restored = await second.snapshot();
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
    "claude_generation_after",
  );
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
        compatibility: "compatible",
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
    const second = new GatewayService({ config, adapters: [secondClaude] });
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
      state: "unconfirmed",
      safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
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
        compatibility: "compatible",
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

test("discovery invalidation fails only unwritten in-flight delivery", async () => {
  const cases = [
    {
      label: "unwritten",
      delivery: undefined,
      state: "failed",
      safeErrorCode: "PEER_NOT_OBSERVED",
    },
    {
      label: "confirmed",
      delivery: { state: "transport_written" } as const,
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
        compatibility: "compatible",
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
        ...toClaude(`route invalidation ${candidate.label}`),
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
      claude.discoveries = [];
      assert.equal(
        (await service.handlers().refreshDashboard()).accepted,
        true,
        candidate.label,
      );
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
      const snapshot = await service.handlers().listSnapshot();
      assert.equal(snapshot.accounting[candidate.state], 1, candidate.label);
      assert.equal(
        snapshot.routes.find(
          ({ alias }) => alias === "claude-one@this-mac",
        )?.state,
        "stale",
        candidate.label,
      );
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("restoring a durable Claude UUID never replays pre-restart queue or conversation state", async (t) => {
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
      compatibility: "compatible",
    },
  ];
  const firstCodex = new FakeProvider("codex");
  const first = new GatewayService({
    config,
    adapters: [firstClaude, firstCodex],
  });
  await first.start();
  await first.handlers().refreshDashboard();
  await first.handlers().registerCodex(codexRegistration());
  await first.handlers().selectClaude({ alias: "busy-peer@this-mac" });
  assert.equal(
    (
      await first.handlers().sendToClaude({
        ...toClaude("must not survive restart"),
        toAlias: "busy-peer@this-mac",
        expectsReply: true,
      })
    ).accepted,
    true,
  );
  assert.equal(firstClaude.dispatches.length, 0);
  await first.close();

  const secondClaude = new FakeProvider("claude", "claude_generation_after");
  secondClaude.discoveries = [
    {
      ...firstClaude.discoveries[0]!,
      state: "idle",
    },
  ];
  const secondCodex = new FakeProvider("codex", "codex_generation_after");
  const second = new GatewayService({
    config,
    adapters: [secondClaude, secondCodex],
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });
  await second.handlers().refreshDashboard();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const snapshot = await second.snapshot();
  assert.equal(secondClaude.dispatches.length, 0);
  assert.equal(secondCodex.dispatches.length, 0);
  assert.equal(snapshot.accounting.queuedBytes, 0);
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.state === "cancelled" || event.state === "abandoned",
    ),
    true,
  );
  assert.equal(JSON.stringify(snapshot).includes("must not survive restart"), false);
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
      compatibility: "compatible",
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
  await waitFor(() => codex.dispatches.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    codex.dispatches.length,
    2,
    JSON.stringify(snapshot.routes, null, 2),
  );
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

test("a stale Codex route terminally fails held work and rejects new sends", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const secondAccepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
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
    const current = await handlers.deliveryStatus({
      token: accepted.deliveryToken,
    });
    return current.found && current.terminal;
  }, 5_000);
  await waitForAsync(async () => {
    const current = await handlers.deliveryStatus({
      token: secondAccepted.deliveryToken,
    });
    return current.found && current.terminal;
  }, 5_000);
  const status = await handlers.deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found && status.terminal, true);
  if (status.found) {
    assert.equal(status.state, "failed");
    assert.equal(status.safeErrorCode, "CODEX_ROUTE_STALE");
  }
  const secondStatus = await handlers.deliveryStatus({
    token: secondAccepted.deliveryToken,
  });
  assert.equal(secondStatus.found && secondStatus.terminal, true);
  if (secondStatus.found) {
    assert.equal(secondStatus.state, "failed");
    assert.equal(secondStatus.safeErrorCode, "CODEX_ROUTE_STALE");
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
        connector.compatibility === "expired" &&
        connector.safeErrorCode === "CODEX_ROUTE_STALE",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" &&
        event.state === "failed" &&
        event.safeErrorCode === "CODEX_ROUTE_STALE",
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
          route.state === "idle" &&
          route.compatibility === "compatible",
      ) &&
      recovered.connectors.some(
        (connector) =>
          connector.provider === "codex" &&
          connector.health === "healthy" &&
          connector.compatibility === "compatible",
      )
    );
  });
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
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.equal(codex.dispatches[0]?.text, "STEER: inspect the next tool result");
  assert.equal(codex.dispatches[0]?.steer, true);
  assert.equal(codex.dispatches[0]?.expectsReply, false);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-steer-direct", status: "delivered" },
  ]);
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

test("Claude control ingress classifies only the exact leading STEER prefix", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches[0]?.steer, true);
  assert.equal(codex.dispatches[0]?.expectsReply, false);

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
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.steer, undefined);
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
      compatibility: "compatible",
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
      ) && claude.nativeInboundStatuses.length === 1
    );
  });
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-steer-cap-1",
      status: "expired",
      diagnosticCode: "STEER_QUEUE_SUPERSEDED",
    },
  ]);
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

test("native Claude ingress reports delivery without approval-like held notices while internal queueing remains visible", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
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

test("open inbound accepts an exact unselected native Claude peer and returns only its correlated reply", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  assert.equal(codex.dispatches[0]?.authorization, "selected_route");
  assert.equal(claude.dispatches[0]?.authorization, "native_reply");
  assert.equal(claude.dispatches[0]?.binding.routeHandle, "claude_target_1");
  assert.equal(claude.dispatches[0]?.text, "correlated reply only");
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
  assert.deepEqual(claude.nativeInboundStatuses, []);
  const stalled = await handlers.listSnapshot();
  assert.equal(
    stalled.alerts.some(
      ({ code, alias }) =>
        code === "QUEUE_STALLED" && alias === "codex-main@this-mac",
    ),
    true,
  );

  await clock.advanceBy(500);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-deadline",
      status: "expired",
      diagnosticCode: "MESSAGE_EXPIRED",
    },
  ]);
  assert.equal(
    claude.nativeInboundStatusAttempts.some(({ status }) => status === "held"),
    false,
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
      compatibility: "compatible",
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
      expectedState: "unconfirmed",
      expectedCode: "CLAUDE_RECEIPT_UNCONFIRMED",
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
        compatibility: "compatible",
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
      compatibility: "compatible",
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
  await clock.advanceBy(500);
  assert.equal(claude.dispatches.length, 1);
  const pending = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(pending.found, true);
  if (pending.found) assert.equal(pending.terminal, false);

  await clock.advanceBy(500);
  const terminal = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(terminal.found, true);
  if (terminal.found) {
    assert.equal(terminal.state, "unconfirmed");
    assert.equal(terminal.safeErrorCode, "CLAUDE_RECEIPT_UNCONFIRMED");
  }
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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

test("confirmed Claude transport without a native receipt settles unconfirmed", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  await clock.advanceBy(1_000);
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) {
    assert.equal(status.terminal, true);
    assert.equal(status.state, "unconfirmed");
    assert.equal(status.safeErrorCode, "CLAUDE_RECEIPT_UNCONFIRMED");
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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

test("ambiguous native acknowledgement is never replayed and releases its receipt", async (t) => {
  const { root, stateDir } = await fixture();
  const clock = new ManualGatewayClock();
  const claude = new FakeProvider("claude");
  claude.nativeInboundStatusFailures.push(
    new BridgeError("SYNTHETIC_AMBIGUOUS", "write may have started"),
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
    text: "ambiguous terminal status",
    receiptHandle: "receipt-native-ambiguous",
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
  assert.deepEqual(claude.releasedNativeReceipts, [
    "receipt-native-ambiguous",
  ]);
  await clock.advanceBy(5_000);
  assert.equal(claude.nativeInboundStatusAttempts.length, 1);
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

test("shutdown settles native ingress before closing its provider", async () => {
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
      status: "expired",
      diagnosticCode: "ROUTE_UNREGISTERED",
    },
  ]);
  assert.deepEqual((await handlers.listSnapshot()).routes, []);
});

test("a busy Claude peer can receive a native reply without deadlocking the conversation", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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
  await selectAndRegister(service.handlers());

  assert.equal(
    (await service.handlers().sendToClaude(toClaude("reply while Claude is busy")))
      .accepted,
    true,
  );
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.text, "reply while Claude is busy");
});

test("queued bodies are cancelled on close and never replayed after restart", async (t) => {
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
      compatibility: "compatible",
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
  // Busy routes retain the transient body only in this process.
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
    true,
  );
  assert.equal((await readFile(second.store.stateFilePath, "utf8")).includes(SECRET), false);
  await second.close();
});

test("one exact target has at most one active provider dispatch", async (t) => {
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
      compatibility: "compatible",
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
  claude.emitDelivery({ messageId: active.messageId, state: "released" });
  claude.emitRouteState("claude_target_1", "idle");
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.text, "serial-two");
  const next = claude.dispatches[1];
  assert.ok(next);
  claude.emitDelivery({ messageId: next.messageId, state: "released" });
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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
      compatibility: "compatible",
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

test("route teardown preserves a reply retained by a failed terminal ledger write", async (t) => {
  const { root, stateDir } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
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

  const accepted = await service.handlers().sendToClaude(
    toClaude("route teardown resolves retained reply"),
  );
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  await waitFor(() => claude.dispatches.length === 1);
  claude.emitDelivery({
    messageId: claude.dispatches[0]!.messageId,
    state: "released",
    replyText: "retained reply survives atomic route teardown settlement",
  });
  await waitFor(() => failFirstTerminal === false);

  assert.deepEqual(
    await service.handlers().unselectClaude({
      alias: "claude-one@this-mac",
    }),
    { accepted: true, code: "ok" },
  );
  const status = await service.handlers().deliveryStatus({
    token: accepted.deliveryToken,
  });
  assert.equal(status.found, true);
  if (status.found) assert.equal(status.state, "delivered");
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(
    codex.dispatches[0]?.text,
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
      compatibility: "compatible",
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
      compatibility: "compatible",
    },
  ];
  await handlers.refreshDashboard();
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(
    claude.dispatches[0]?.text,
    "scheduled body follows exact UUID rename",
  );
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
      compatibility: "compatible",
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
    hopCount: 0,
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
      compatibility: "compatible",
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
