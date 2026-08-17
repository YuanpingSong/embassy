import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  spawnAcpClient,
  AcpRequestError,
  type AcpClient,
  type AcpLaunchSpec,
  type AcpPreparedPrompt,
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
type Client = Pick<
  AcpClient,
  "close" | "newSession" | "preparePrompt"
>;

export type AcpGatewayProviderOptions = Readonly<{
  provider: AcpOwnedProvider;
  alias: string;
  hostId: string;
  launch?: AcpLaunchSpec;
  unavailableCode?: string;
  workspace?: string;
  spawnClient?: (launch: AcpLaunchSpec) => Promise<Client>;
  now?: () => number;
}>;

const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const PRIVATE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class AcpGatewayProvider implements GatewayProviderAdapter {
  readonly identity;
  readonly protocol = "acp";
  readonly protocolVersion = "1";
  private readonly routeHandle: string;
  private readonly spawnClient;
  private readonly now;
  private callbacks: GatewayAdapterCallbacks | undefined;
  private client: Client | undefined;
  private sessionId: string | undefined;
  private retryAt = 0;
  private failures = 0;
  private registrationId: string | undefined;
  private closed = false;

  constructor(private readonly options: AcpGatewayProviderOptions) {
    this.identity = Object.freeze({
      provider: options.provider,
      hostId: options.hostId,
    });
    this.routeHandle = `acp_${createHash("sha256").update(options.alias).digest("base64url").slice(0, 24)}`;
    this.spawnClient = options.spawnClient ?? ((launch) => spawnAcpClient(launch));
    this.now = options.now ?? Date.now;
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

  observeLogicalRoute(input: {
    alias: string;
    routeHandle: string;
    registrationId: string;
  }): void {
    if (
      !this.closed &&
      input.alias === this.options.alias &&
      input.routeHandle === this.routeHandle &&
      PRIVATE_HANDLE.test(input.registrationId)
    ) {
      if (
        this.registrationId !== undefined &&
        this.registrationId !== input.registrationId
      ) {
        this.resetRegistrationClient();
      }
      this.registrationId = input.registrationId;
    }
  }

  forgetLogicalRoute(registrationId: string): void {
    if (this.registrationId !== registrationId) return;
    this.registrationId = undefined;
    this.resetRegistrationClient();
  }

  async dispatch(input: GatewayAdapterDispatchInput): Promise<GatewayAdapterDispatchResult> {
    if (
      this.closed || input.targetAlias !== this.options.alias ||
      input.binding.provider !== this.options.provider ||
      input.binding.hostId !== this.options.hostId ||
      input.binding.routeHandle !== this.routeHandle ||
      this.registrationId !== input.binding.registrationId
    ) {
      return { state: "failed", safeErrorCode: "ACP_ROUTE_MISMATCH" };
    }
    const registrationId = input.binding.registrationId;
    if (this.options.launch === undefined) {
      return this.options.unavailableCode === undefined
        ? { state: "deferred", safeErrorCode: "ROUTE_BUSY" }
        : { state: "failed", safeErrorCode: this.options.unavailableCode };
    }
    if (this.now() < this.retryAt) {
      this.emitState("unobserved", "ACP_RESTART_BACKOFF", registrationId);
      return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
    }
    const client = await this.connect(registrationId);
    if (
      client === undefined ||
      this.sessionId === undefined ||
      this.registrationId !== registrationId
    ) {
      return this.closed || this.registrationId !== registrationId
        ? { state: "failed", safeErrorCode: "ACP_ROUTE_MISMATCH" }
        : { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
    }
    const sessionId = this.sessionId;
    let content: string;
    try {
      content = composeProvenanceEnvelope({
        sourceProvider: input.sourceProvider,
        recipientProvider: this.options.provider,
        sourceAlias: input.sourceAlias,
        targetAlias: input.targetAlias,
        conversationId: input.conversationId,
        body: input.text,
        ...(input.progressWatchActive ? { progressWatchActive: true } : {}),
      });
    } catch {
      return { state: "failed", safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" };
    }
    let prepared: AcpPreparedPrompt;
    try {
      prepared = client.preparePrompt(sessionId, content);
    } catch (error) {
      if (error instanceof AcpRequestError) {
        return { state: "failed", safeErrorCode: "ACP_REQUEST_FAILED" };
      }
      if (
        error instanceof Error &&
        error.message === "ACP session already has an outstanding prompt"
      ) {
        this.emitState("busy", "ACP_SESSION_BUSY", registrationId);
        return { state: "deferred", safeErrorCode: "ROUTE_BUSY" };
      }
      return { state: "failed", safeErrorCode: "ACP_REQUEST_FAILED" };
    }
    const evidence = {
      attemptId: input.attemptId,
      kind: "acp_prompt" as const,
      bodyBytes: Buffer.byteLength(input.text, "utf8"),
      bodySha256: createHash("sha256").update(input.text).digest("hex"),
      frameBytes: prepared.frameBytes,
      sha256: prepared.sha256,
    };
    let authorized: boolean;
    try {
      authorized = await input.authorizeWrite(evidence);
    } catch {
      cancelPreparedPrompt(prepared);
      return {
        state: "ambiguous",
        safeErrorCode: "WRITE_AUTHORIZATION_UNCERTAIN",
      };
    }
    if (!authorized) {
      cancelPreparedPrompt(prepared);
      return {
        state: "failed",
        safeErrorCode: "WRITE_AUTHORIZATION_DENIED",
      };
    }
    let prompt: Promise<AcpPromptReceipt>;
    try {
      // Authorization is the consent linearization point. Do not add an await
      // or yield before invoking the one body-bearing ACP method.
      prompt = prepared.perform();
    } catch {
      this.markStale("ACP_DISPATCH_OUTCOME_UNKNOWN", registrationId);
      return { state: "ambiguous", safeErrorCode: "ACP_DISPATCH_OUTCOME_UNKNOWN" };
    }
    let receipt: AcpPromptReceipt;
    try {
      receipt = await prompt;
    } catch {
      this.markStale("ACP_DISPATCH_OUTCOME_UNKNOWN", registrationId);
      return { state: "ambiguous", safeErrorCode: "ACP_DISPATCH_OUTCOME_UNKNOWN" };
    }
    if (receipt.terminalState === "unknown") {
      this.markStale("ACP_SUBPROCESS_EXITED", registrationId);
      return result("ambiguous", "ACP_SUBPROCESS_EXITED", receipt.text);
    }
    this.emitState("idle", undefined, registrationId);
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
    this.registrationId = undefined;
    this.callbacks = undefined;
    this.dropClient();
  }

  private async connect(registrationId: string): Promise<Client | undefined> {
    if (this.closed || this.registrationId !== registrationId) return undefined;
    if (this.client !== undefined) return this.client;
    if (this.options.launch === undefined || this.now() < this.retryAt) {
      this.markStale(
        this.options.unavailableCode ?? "ACP_LAUNCH_UNAVAILABLE",
        registrationId,
      );
      return undefined;
    }
    let client: Client | undefined;
    try {
      client = await this.spawnClient(this.options.launch);
      if (this.closed || this.registrationId !== registrationId) {
        client.close();
        return undefined;
      }
      const session = await client.newSession(
        this.options.workspace ?? this.options.launch.cwd ?? process.cwd(),
      );
      if (this.closed || this.registrationId !== registrationId) {
        client.close();
        return undefined;
      }
      this.client = client;
      this.sessionId = session.sessionId;
      this.failures = 0;
      this.retryAt = 0;
      return client;
    } catch {
      client?.close();
      this.markStale("ACP_SUBPROCESS_UNAVAILABLE", registrationId);
      return undefined;
    }
  }

  private markStale(code: string, registrationId: string): void {
    if (this.closed || this.registrationId !== registrationId) return;
    this.dropClient();
    const delay = BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)]!;
    this.retryAt = this.now() + delay;
    this.emitState("unobserved", code, registrationId);
  }

  private dropClient(): void {
    this.client?.close();
    this.client = undefined;
    this.sessionId = undefined;
  }

  private resetRegistrationClient(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.dropClient();
  }

  private emitState(
    state: "idle" | "busy" | "unobserved",
    safeErrorCode?: string,
    registrationId = this.registrationId,
  ): void {
    if (
      registrationId === undefined ||
      this.registrationId !== registrationId
    ) return;
    try {
      this.callbacks?.onRouteState({
        route: {
          ...this.identity,
          routeHandle: this.routeHandle,
          registrationId,
        },
        state,
        observedAt: new Date(this.now()).toISOString(),
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      });
    } catch {
      // Observation is best-effort and never changes semantic settlement.
    }
  }
}

function cancelPreparedPrompt(
  prepared: Pick<AcpPreparedPrompt, "cancel">,
): void {
  try {
    prepared.cancel();
  } catch {
    // A cancelled preparation has no semantic write authority. Cleanup
    // failure cannot convert denial or authorization uncertainty into a send.
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
