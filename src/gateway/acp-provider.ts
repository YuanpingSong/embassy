import { createHash, randomUUID } from "node:crypto";

import {
  spawnAcpClient,
  type AcpClient,
  type AcpLaunchSpec,
  type AcpPromptReceipt,
} from "./acp-client.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDispatchInput,
  GatewayAdapterDispatchResult,
  GatewayProviderAdapter,
} from "./service.js";
import type { GatewayProvider } from "./types.js";

type AcpOwnedProvider = Extract<GatewayProvider, "deepseek" | "grok">;
type Client = Pick<AcpClient, "close" | "connectionInfo" | "newSession" | "prompt">;

export type AcpGatewayProviderOptions = Readonly<{
  provider: AcpOwnedProvider;
  alias: string;
  hostId: string;
  launch?: AcpLaunchSpec;
  unavailableCode?: string;
  workspace?: string;
  endpointGeneration?: string;
  spawnClient?: (launch: AcpLaunchSpec) => Promise<Client>;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}>;

const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export class AcpGatewayProvider implements GatewayProviderAdapter {
  readonly identity;
  readonly protocol = "acp";
  readonly protocolVersion = "1";
  private readonly routeHandle: string;
  private readonly spawnClient;
  private readonly now;
  private readonly setTimer;
  private readonly clearTimer;
  private callbacks?: GatewayAdapterCallbacks;
  private client: Client | undefined;
  private sessionId: string | undefined;
  private retryAt = 0;
  private failures = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: AcpGatewayProviderOptions) {
    this.identity = Object.freeze({
      provider: options.provider,
      hostId: options.hostId,
      endpointGeneration: options.endpointGeneration ?? `acp_${randomUUID()}`,
    });
    this.routeHandle = `acp_${createHash("sha256").update(options.alias).digest("base64url").slice(0, 24)}`;
    this.spawnClient = options.spawnClient ?? ((launch) => spawnAcpClient(launch));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  activateEndpointGeneration(generation: string): void {
    if (generation !== this.identity.endpointGeneration) {
      throw new Error("ACP endpoint generation changed");
    }
  }

  async initialize(callbacks: GatewayAdapterCallbacks) {
    this.callbacks = callbacks;
    return {
      health: this.options.launch === undefined ? "degraded" as const : "healthy" as const,
      ...(this.options.launch === undefined
        ? { safeErrorCode: this.options.unavailableCode ?? "ACP_LAUNCH_UNAVAILABLE" }
        : {}),
      ownedRoute: { alias: this.options.alias, routeHandle: this.routeHandle, state: "idle" as const },
    };
  }

  async selectRoute(input: { alias: string; routeHandle: string }) {
    if (input.alias !== this.options.alias || input.routeHandle !== this.routeHandle) {
      throw new Error("ACP route identity mismatch");
    }
    return { routeHandle: this.routeHandle, state: "idle" as const };
  }

  async dispatch(input: GatewayAdapterDispatchInput): Promise<GatewayAdapterDispatchResult> {
    if (
      this.closed || input.targetAlias !== this.options.alias ||
      input.binding.provider !== this.options.provider ||
      input.binding.hostId !== this.options.hostId ||
      input.binding.endpointGeneration !== this.identity.endpointGeneration ||
      input.binding.routeHandle !== this.routeHandle
    ) {
      return { state: "failed", safeErrorCode: "ACP_ROUTE_MISMATCH" };
    }
    const client = await this.connect();
    if (client === undefined || this.sessionId === undefined) {
      return { state: "deferred", safeErrorCode: this.options.launch === undefined
        ? this.options.unavailableCode ?? "ACP_LAUNCH_UNAVAILABLE"
        : "ACP_RESTART_BACKOFF" };
    }
    let receipt: AcpPromptReceipt;
    try {
      receipt = await client.prompt(this.sessionId, composeProvenanceEnvelope({
        sourceProvider: input.sourceProvider,
        recipientProvider: this.options.provider,
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        conversationId: input.conversationId,
        body: input.text,
        ...(input.progressWatchActive ? { progressWatchActive: true } : {}),
      }));
    } catch {
      this.markStale("ACP_DISPATCH_OUTCOME_UNKNOWN");
      return { state: "ambiguous", safeErrorCode: "ACP_DISPATCH_OUTCOME_UNKNOWN" };
    }
    if (receipt.terminalState === "unknown") {
      this.markStale("ACP_SUBPROCESS_EXITED");
      return result("ambiguous", "ACP_SUBPROCESS_EXITED", receipt.text);
    }
    this.emitState("idle");
    if (receipt.terminalState === "cancelled") {
      return result("cancelled", undefined, receipt.text);
    }
    if (receipt.terminalState === "failed") {
      return result("failed", "error" in receipt ? "ACP_REQUEST_FAILED" : `ACP_${receipt.stopReason.toUpperCase()}`, receipt.text);
    }
    return result(
      this.options.provider === "deepseek" ? "unconfirmed" : "delivered",
      this.options.provider === "deepseek" ? "ACP_OUTCOME_COARSE" : undefined,
      receipt.text,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.recoveryTimer !== undefined) this.clearTimer(this.recoveryTimer);
    this.client?.close();
    this.client = undefined;
    this.sessionId = undefined;
  }

  private async connect(): Promise<Client | undefined> {
    if (this.client !== undefined) return this.client;
    if (this.options.launch === undefined || this.now() < this.retryAt) {
      if (this.recoveryTimer === undefined) this.markStale(
        this.options.unavailableCode ?? "ACP_LAUNCH_UNAVAILABLE",
      );
      return undefined;
    }
    let client: Client | undefined;
    try {
      client = await this.spawnClient(this.options.launch);
      const session = await client.newSession(
        this.options.workspace ?? this.options.launch.cwd ?? process.cwd(),
      );
      this.client = client;
      this.sessionId = session.sessionId;
      this.failures = 0;
      this.retryAt = 0;
      return client;
    } catch {
      client?.close();
      this.markStale("ACP_SUBPROCESS_UNAVAILABLE");
      return undefined;
    }
  }

  private markStale(code: string): void {
    this.client?.close();
    this.client = undefined;
    this.sessionId = undefined;
    const delay = BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)]!;
    this.retryAt = this.now() + delay;
    this.emitState("stale", code);
    if (this.recoveryTimer !== undefined) this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = undefined;
      if (!this.closed) this.emitState("idle");
    }, delay);
    (this.recoveryTimer as { unref?: () => void }).unref?.();
  }

  private emitState(state: "idle" | "stale", safeErrorCode?: string): void {
    this.callbacks?.onRouteState({
      endpoint: { ...this.identity, routeHandle: this.routeHandle },
      state,
      ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    });
  }
}

function result(
  state: "delivered" | "unconfirmed" | "failed" | "ambiguous" | "cancelled",
  safeErrorCode?: string,
  replyText?: string,
): GatewayAdapterDispatchResult {
  return {
    state,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    ...(replyText === undefined || replyText.length === 0 ? {} : { replyText }),
  };
}

export const createAcpGatewayProvider = (
  options: AcpGatewayProviderOptions,
): GatewayProviderAdapter => new AcpGatewayProvider(options);
