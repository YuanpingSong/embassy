import { createHash } from "node:crypto";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  CLAUDE_PEER_COMPATIBILITY,
  ClaudePeerAdapter,
  type ClaudePeerDescriptor,
  type ClaudePeerListener,
  type ClaudePeerReceiptEvent,
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
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDelivery,
  GatewayAdapterDiscovery,
  GatewayAdapterDispatchResult,
  GatewayAdapterRouteState,
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
const MAX_CODEX_ROUTES = 128;
const MAX_CODEX_CALLBACKS = 512;
const MAX_TRANSIENT_REPLY_BYTES = 64 * 1024;
const DEFAULT_CODEX_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_CLEANUP_POLL_MS = 25;

type ClaudePeerFactory = (
  runtime: AttestedClaudePeerRuntime,
) => ClaudePeerAdapter;

export type LocalClaudeGatewayProviderOptions = {
  /** Exact result of attestClaudePeerRuntime; paths are never rediscovered. */
  runtime: AttestedClaudePeerRuntime;
  hostId?: "this-mac";
  discoveryPollMs?: number;
  maxPendingMessages?: number;
  now?: () => number;
  /** Deterministic test seam. Production callers must omit this. */
  peerFactory?: ClaudePeerFactory;
};

type ClaudePending = {
  gatewayMessageId: string;
  targetId: string;
  timer: NodeJS.Timeout;
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
  private readonly nativeInbound = new Map<string, string>();
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
  private discoveryInFlight:
    | Promise<readonly GatewayAdapterDiscovery[]>
    | undefined;
  private monitorTimer: NodeJS.Timeout | undefined;
  private callbacks: GatewayAdapterCallbacks | undefined;
  private listener: ClaudePeerListener | undefined;
  private advertisedCodexAlias: string | undefined;
  private initialized = false;
  private closed = false;

  constructor(options: LocalClaudeGatewayProviderOptions) {
    validateAttestedClaudeRuntime(options.runtime);
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
      ((runtime) =>
        new ClaudePeerAdapter({
          sessionsDir: runtime.sessionsDir,
          socketDir: runtime.socketDir,
          attestedClaudeCodeVersion: runtime.claudeCodeVersion,
        })))(options.runtime);
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
      const listener = await this.peer.listen({
        onMessage: async (message) => {
          if (
            message.sourceTargetId === undefined ||
            message.sourceAlias === undefined ||
            !message.replySupported
          ) {
            if (message.receiptHandle !== undefined) {
              await this.listener?.acknowledge?.(
                message.receiptHandle,
                "expired",
                { code: "CLAUDE_SOURCE_ROUTE_INVALID" },
              );
            }
            return;
          }
          let sourceAlias: string | undefined;
          try {
            await this.refreshClaudeDiscovery();
            const current = this.discovered.get(message.sourceTargetId);
            const expectedAlias = `${message.sourceAlias}@${this.identity.hostId}`;
            if (current?.alias === expectedAlias) sourceAlias = expectedAlias;
          } catch {
            sourceAlias = undefined;
          }
          if (sourceAlias === undefined) {
            if (message.receiptHandle !== undefined) {
              await this.listener?.acknowledge?.(
                message.receiptHandle,
                "expired",
                { code: "CLAUDE_SOURCE_ROUTE_STALE" },
              );
            }
            return;
          }
          invokeCallback(() => {
            if (this.advertisedCodexAlias !== undefined) {
              if (
                !this.nativeInbound.has(message.sourceTargetId as string) &&
                this.nativeInbound.size >= this.maxPending
              ) {
                if (message.receiptHandle !== undefined) {
                  void this.listener?.acknowledge?.(
                    message.receiptHandle,
                    "expired",
                    { code: "CLAUDE_NATIVE_INGRESS_CAPACITY" },
                  );
                }
                return;
              }
              this.nativeInbound.set(
                message.sourceTargetId as string,
                sourceAlias as string,
              );
              callbacks.onClaudeMessage?.({
                endpoint: callbackEndpoint(
                  this.identity,
                  message.sourceTargetId as string,
                ),
                sourceAlias,
                targetAlias: this.advertisedCodexAlias,
                text: message.content,
                ...(message.receiptHandle === undefined
                  ? {}
                  : { receiptHandle: message.receiptHandle }),
              });
            } else {
              if (
                this.selected.get(message.sourceTargetId as string) ===
                sourceAlias
              ) {
                callbacks.onClaudeReply({
                  endpoint: callbackEndpoint(
                    this.identity,
                    message.sourceTargetId as string,
                  ),
                  text: message.content,
                });
              }
            }
          });
        },
        onReceipt: (event) => this.onReceipt(event),
      });
      if (this.closed) {
        await listener.close();
        throw new BridgeError(
          "CLAUDE_PROVIDER_CLOSED",
          "The local Claude provider closed during initialization.",
        );
      }
      this.listener = listener;
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

  async discoverClaudePeers(): Promise<readonly GatewayAdapterDiscovery[]> {
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
    this.assertReady();
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
    if (this.listener === undefined) {
      throw new BridgeError(
        "CLAUDE_CALLBACK_UNAVAILABLE",
        "The private Claude callback listener is unavailable.",
      );
    }
    await this.listener.advertise?.(name, input.cwd);
    this.advertisedCodexAlias = input.alias;
  }

  async unadvertiseNativeCodexPeer(alias: string): Promise<void> {
    if (alias !== this.advertisedCodexAlias) return;
    await this.listener?.unadvertise?.(
      alias.slice(0, alias.lastIndexOf("@")),
    );
    this.advertisedCodexAlias = undefined;
  }

  async updateNativeCodexPeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    if (alias !== this.advertisedCodexAlias) return;
    await this.listener?.updateAdvertisedStatus?.(status);
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    await this.listener?.acknowledge?.(
      receiptHandle,
      status,
      diagnosticCode === undefined ? undefined : { code: diagnosticCode },
    );
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
      this.closed ||
      this.listener === undefined ||
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
      const observedAlias = this.nativeInbound.get(input.binding.routeHandle);
      const current = this.discovered.get(input.binding.routeHandle);
      if (observedAlias === undefined || current?.alias !== observedAlias) {
        this.nativeInbound.delete(input.binding.routeHandle);
        return { state: "failed", safeErrorCode: "CLAUDE_NATIVE_REPLY_STALE" };
      }
    } else if (this.selected.get(input.binding.routeHandle) === undefined) {
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
        this.emitDelivery({
          messageId: input.messageId,
          state: "transport_written",
        });
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
          listener: this.listener,
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
      this.listener.untrack(result.messageId);
      this.finishClaudeMessage(result.messageId, "released");
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
      this.selectedDispatchEpoch.clear();
      this.selectedObservationDirty.clear();
      this.selectedObservations.clear();
      this.discovered.clear();
      if (this.monitorTimer !== undefined) clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
      this.listener = undefined;
      this.advertisedCodexAlias = undefined;
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

  private trackClaudeMessage(
    providerId: string,
    gatewayMessageId: string,
    targetId: string,
    deadline: number,
  ): boolean {
    if (
      this.pendingByProviderId.has(providerId) ||
      this.providerIdByGatewayId.get(gatewayMessageId) !== "" ||
      this.pendingByProviderId.size >= this.maxPending
    ) {
      return false;
    }
    const timer = setTimeout(() => {
      this.listener?.untrack(providerId);
      this.finishClaudeMessage(providerId, "expired", "MESSAGE_EXPIRED");
    }, Math.max(1, deadline - this.now()));
    timer.unref();
    this.pendingByProviderId.set(providerId, {
      gatewayMessageId,
      targetId,
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
        this.listener?.untrack(providerId);
      }
    }
    this.providerIdByGatewayId.delete(gatewayMessageId);
    this.pendingTargetByGatewayId.delete(gatewayMessageId);
  }

  private onReceipt(event: ClaudePeerReceiptEvent): void {
    const pending = this.pendingByProviderId.get(event.messageId);
    if (pending === undefined) return;
    if (event.status === "held") {
      this.emitDelivery({ messageId: pending.gatewayMessageId, state: "held" });
      return;
    }
    const state =
      event.status === "released"
        ? "released"
        : event.status === "denied"
          ? "denied"
          : event.status === "expired"
            ? "expired"
            : "ambiguous";
    this.finishClaudeMessage(event.messageId, state);
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

  private async refreshClaudeDiscovery(): Promise<
    readonly GatewayAdapterDiscovery[]
  > {
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

  private async refreshClaudeDiscoveryOnce(): Promise<
    readonly GatewayAdapterDiscovery[]
  > {
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
    for (const [routeHandle, alias] of this.nativeInbound) {
      if (this.discovered.get(routeHandle)?.alias !== alias) {
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
    return rows;
  }

  private emitClaudeRouteObservation(
    routeHandle: string,
    state: GatewayAdapterRouteState,
    safeErrorCode?: string,
    authoritative = false,
  ): void {
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
  factory: LocalCodexTransportFactory;
  cleanupPollMs?: number;
  cleanupTimeoutMs?: number;
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
      state: GatewayAdapterRouteState;
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
): GatewayAdapterRouteState {
  if (observation.routeStatus === "idle") return "idle";
  if (observation.routeStatus === "waiting_approval") {
    return "awaiting_approval";
  }
  return "busy";
}

function codexRouteSafeCode(
  observation: CodexConnectorObservation,
): string | undefined {
  if (observation.connection !== "ready") return "CODEX_ROUTE_STALE";
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
  private readonly now: () => Date;
  private readonly routes = new Map<string, CodexRoute>();
  private readonly routeCreations = new Map<string, Promise<CodexRoute>>();
  private readonly routeReleases = new Map<string, Promise<void>>();
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
    const route = await this.ensureRoute(input.routeHandle);
    const observation = route.connector.observation();
    if (observation.connection !== "ready") {
      await this.releaseRoute(input.routeHandle);
      throw new BridgeError(
        "CODEX_ROUTE_SETUP_REJECTED",
        "The exact Codex task connection closed during route selection.",
      );
    }
    this.queueRouteObservation(route, observation);
    return {
      routeHandle: input.routeHandle,
      state: codexRouteState(observation),
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
      return { state: "pending" };
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
    const entries = [...this.routes.entries()];
    const routeResults = await Promise.allSettled(
      entries.map(async ([routeHandle]) => this.releaseRoute(routeHandle)),
    );
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
      // protocol faults. Explicit route selection is the operator's recovery
      // boundary: fully release that exact connector before constructing a
      // fresh one. releaseRoute is identity-checked, so a concurrent selector
      // joins the same cleanup instead of closing a replacement.
      await this.releaseRoute(threadId);
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
      if (this.closed) {
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
