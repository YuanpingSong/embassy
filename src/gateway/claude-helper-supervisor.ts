import { randomBytes } from "node:crypto";

import { BridgeError } from "../errors.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import {
  createClaudeNativeHelper,
  type ClaudeNativeHelperClientLike,
  type ClaudeNativeHelperFactory,
} from "./claude-helper-client.js";
import type {
  ClaudeNativeHelperCommand,
  ClaudeNativeHelperEvent,
  ClaudeNativeHelperResult,
} from "./claude-helper-protocol.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import type { DashboardLocale } from "./locale.js";
import type {
  ClaudeNativeCodexSuccessionBarrier,
} from "./providers.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDispatchResult,
} from "./service.js";
import type {
  PrivateEndpointIdentity,
  PrivateRouteBinding,
} from "./types.js";

type HelperRecord = {
  client: ClaudeNativeHelperClientLike;
  activeAlias: string;
  activeGeneration: string;
  prepared?: Readonly<{ alias: string; generation: string }>;
  retiredGeneration?: string;
  authorizedRoutes: Map<string, string>;
  closing: boolean;
};

type ReceiptOwner = Readonly<{
  helper: HelperRecord;
  childHandle: string;
}>;

type PendingDispatch = {
  helper: HelperRecord;
  evidence: "none" | "transport_uncertain" | "transport_written";
};

export type ClaudeNativeHelperSupervisorOptions = Readonly<{
  identity: PrivateEndpointIdentity;
  runtime: AttestedClaudePeerRuntime;
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number;
  maxHelpers: number;
  callbacks: () => GatewayAdapterCallbacks | undefined;
  factory?: ClaudeNativeHelperFactory;
}>;

const TERMINAL_DELIVERY_STATES = new Set([
  "released",
  "unconfirmed",
  "denied",
  "expired",
  "ambiguous",
  "completed",
  "failed",
  "cancelled",
]);
const PUBLIC_ALIAS =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{16,64}$/;
const MAX_RAW_BODY_BYTES = 16 * 1024;

function fault(code: string, recoverable = false): BridgeError {
  return new BridgeError(
    code,
    "The supervised native Claude advertisement could not complete its bounded operation.",
    recoverable,
  );
}

function ok(result: ClaudeNativeHelperResult): void {
  if (!("ok" in result) || result.ok !== true) {
    throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
  }
}

export class ClaudeNativeHelperSupervisor {
  readonly #identity: PrivateEndpointIdentity;
  readonly #runtime: AttestedClaudePeerRuntime;
  readonly #locale: DashboardLocale;
  readonly #deliveryNotices: GatewayDeliveryNoticeMode;
  readonly #maxPendingMessages: number;
  readonly #maxHelpers: number;
  readonly #callbacks: () => GatewayAdapterCallbacks | undefined;
  readonly #factory: ClaudeNativeHelperFactory;
  readonly #helpersByAlias = new Map<string, HelperRecord>();
  readonly #helpersByGeneration = new Map<string, HelperRecord>();
  readonly #receiptOwners = new Map<string, ReceiptOwner>();
  readonly #pendingDispatches = new Map<string, PendingDispatch>();
  #closed = false;

  constructor(options: ClaudeNativeHelperSupervisorOptions) {
    this.#identity = { ...options.identity };
    this.#runtime = { ...options.runtime };
    this.#locale = options.locale;
    this.#deliveryNotices = options.deliveryNotices;
    this.#maxPendingMessages = options.maxPendingMessages;
    this.#maxHelpers = options.maxHelpers;
    this.#callbacks = options.callbacks;
    this.#factory = options.factory ?? createClaudeNativeHelper;
  }

  get size(): number {
    return this.#helpersByAlias.size;
  }

  async advertise(input: Readonly<{ alias: string; cwd: string }>): Promise<void> {
    this.#assertOpen();
    if (this.#helpersByAlias.has(input.alias)) return;
    if (this.#helpersByAlias.size >= this.#maxHelpers) {
      throw fault("CLAUDE_NATIVE_HELPER_CAPACITY", true);
    }
    let record: HelperRecord | undefined;
    const buffered: ClaudeNativeHelperEvent[] = [];
    let exitedBeforeReady = false;
    const client = await this.#factory({
      runtime: this.#runtime,
      hostId: "this-mac",
      locale: this.#locale,
      deliveryNotices: this.#deliveryNotices,
      maxPendingMessages: this.#maxPendingMessages,
      registration: input,
      callbacks: {
        onEvent: (event) => {
          if (record === undefined) buffered.push(event);
          else this.#onEvent(record, event);
        },
        onExit: () => {
          if (record === undefined) exitedBeforeReady = true;
          else this.#onExit(record);
        },
      },
    });
    if (this.#closed || exitedBeforeReady) {
      await client.forceClose().catch(() => undefined);
      throw fault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true);
    }
    record = {
      client,
      activeAlias: input.alias,
      activeGeneration: client.generation,
      authorizedRoutes: new Map(),
      closing: false,
    };
    this.#helpersByAlias.set(input.alias, record);
    this.#helpersByGeneration.set(client.generation, record);
    for (const event of buffered) this.#onEvent(record, event);
    try {
      ok(
        await client.request({
          method: "resume_generation",
          generation: client.generation,
        }),
      );
    } catch (error) {
      // The child may have activated before the response was lost. Preserve
      // exact ownership in the supervisor so ordinary rollback can close it.
      throw error;
    }
  }

  currentGeneration(alias: string): string {
    const helper = this.#helpersByAlias.get(alias);
    if (helper === undefined || helper.closing) {
      throw fault("CODEX_PEER_GENERATION_MISMATCH");
    }
    return helper.activeGeneration;
  }

  async updateStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    const helper = this.#helpersByAlias.get(alias);
    if (helper === undefined || helper.closing) return;
    ok(await helper.client.request({ method: "update_status", alias, status }));
  }

  async unadvertise(alias: string): Promise<void> {
    const helper = this.#helpersByAlias.get(alias);
    if (helper === undefined) return;
    helper.closing = true;
    let failure: unknown;
    try {
      ok(await helper.client.request({ method: "unadvertise", alias }));
    } catch (error) {
      failure = error;
    }
    await helper.client.close().catch((error) => {
      failure ??= error;
    });
    this.#removeHelper(helper);
    if (failure !== undefined) throw failure;
  }

  async dispatch(input: Readonly<{
    sourceAlias: string;
    targetAlias: string;
    conversationId: string;
    selectedAlias?: string;
    stateRoot?: string;
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }>): Promise<GatewayAdapterDispatchResult> {
    if (
      typeof input.sourceAlias !== "string" ||
      !PUBLIC_ALIAS.test(input.sourceAlias) ||
      !input.sourceAlias.startsWith("codex-") ||
      typeof input.targetAlias !== "string" ||
      !PUBLIC_ALIAS.test(input.targetAlias) ||
      typeof input.conversationId !== "string" ||
      !CONVERSATION_ID.test(input.conversationId) ||
      typeof input.text !== "string"
    ) {
      return { state: "failed", safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" };
    }
    if (Buffer.byteLength(input.text, "utf8") > MAX_RAW_BODY_BYTES) {
      return {
        state: "failed",
        safeErrorCode: "PROVENANCE_ENVELOPE_TOO_LARGE",
      };
    }
    const helper = this.#helpersByAlias.get(input.sourceAlias);
    if (helper === undefined || helper.closing) {
      return { state: "failed", safeErrorCode: "CLAUDE_NATIVE_HELPER_UNAVAILABLE" };
    }
    if (input.authorization === "selected_route") {
      if (
        input.selectedAlias === undefined ||
        input.stateRoot === undefined
      ) {
        return { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" };
      }
      const authority = `${input.selectedAlias}\0${input.stateRoot}`;
      if (helper.authorizedRoutes.get(input.binding.routeHandle) !== authority) {
        ok(
          await helper.client.request({
            method: "authorize_route",
            alias: input.selectedAlias,
            routeHandle: input.binding.routeHandle,
            stateRoot: input.stateRoot,
          }),
        );
        helper.authorizedRoutes.set(input.binding.routeHandle, authority);
      }
    }
    this.#pendingDispatches.set(input.messageId, {
      helper,
      evidence: "none",
    });
    try {
      const result = await helper.client.request(
        {
          method: "dispatch",
          binding: input.binding,
          authorization: input.authorization,
          messageId: input.messageId,
          sourceAlias: helper.activeAlias,
          targetAlias: input.targetAlias,
          conversationId: input.conversationId,
          text: input.text,
          expectsReply: input.expectsReply,
          deadlineAt: input.deadlineAt,
        },
        Math.max(
          1,
          Math.min(60_000, Date.parse(input.deadlineAt) - Date.now()),
        ),
      );
      if (
        !("state" in result) ||
        ![
          "pending",
          "accepted",
          "deferred",
          "delivered",
          "failed",
          "ambiguous",
          "cancelled",
        ].includes(String(result.state))
      ) {
        throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
      }
      if (result.state !== "pending") this.#pendingDispatches.delete(input.messageId);
      return result as GatewayAdapterDispatchResult;
    } catch (error) {
      const pending = this.#pendingDispatches.get(input.messageId);
      if (pending?.evidence === "none") this.#pendingDispatches.delete(input.messageId);
      throw error;
    }
  }

  async releaseRoute(routeHandle: string): Promise<void> {
    const results = await Promise.allSettled(
      [...new Set(this.#helpersByAlias.values())].map(async (helper) => {
        helper.authorizedRoutes.delete(routeHandle);
        ok(await helper.client.request({ method: "release_route", routeHandle }));
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }

  async updateInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    const owner = this.#requireReceipt(receiptHandle);
    try {
      ok(
        await owner.helper.client.request({
          method: "update_inbound_status",
          receiptHandle: owner.childHandle,
          status,
          ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
        }),
      );
      if (status !== "held") this.#receiptOwners.delete(receiptHandle);
    } catch (error) {
      if (
        status !== "held" &&
        (!(error instanceof BridgeError) || !error.recoverable)
      ) {
        this.#receiptOwners.delete(receiptHandle);
      }
      throw error;
    }
  }

  async notifyInboundProgress(
    receiptHandle: string,
    progress: Readonly<{
      kind: "stall";
      reason:
        | "ROUTE_BUSY"
        | "ROUTE_UNAVAILABLE"
        | "CODEX_ROUTE_STALE"
        | "AWAITING_EXTERNAL_APPROVAL";
      queuedForMs: number;
    }>,
  ): Promise<void> {
    const owner = this.#requireReceipt(receiptHandle);
    ok(
      await owner.helper.client.request({
        method: "notify_inbound_progress",
        receiptHandle: owner.childHandle,
        progress,
      }),
    );
  }

  async releaseInboundReceipt(receiptHandle: string): Promise<boolean> {
    const owner = this.#receiptOwners.get(receiptHandle);
    if (owner === undefined) return false;
    this.#receiptOwners.delete(receiptHandle);
    const result = await owner.helper.client.request({
      method: "release_inbound_receipt",
      receiptHandle: owner.childHandle,
    });
    return "released" in result && result.released === true;
  }

  async quiesceAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...new Set(this.#helpersByAlias.values())].map(async (helper) => {
        ok(
          await helper.client.request({
            method: "quiesce_generation",
            generation: helper.activeGeneration,
          }),
        );
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }

  async quiesceGeneration(generation: string): Promise<void> {
    const helper = this.#requireGeneration(generation);
    ok(await helper.client.request({ method: "quiesce_generation", generation }));
  }

  async observeBarrier(
    generation: string,
  ): Promise<ClaudeNativeCodexSuccessionBarrier> {
    const helper = this.#requireGeneration(generation);
    const result = await helper.client.request({ method: "observe_barrier", generation });
    if (!("clean" in result) || !("generation" in result)) {
      throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
    }
    return result as ClaudeNativeCodexSuccessionBarrier;
  }

  async prepareGeneration(input: Readonly<{
    alias: string;
    cwd: string;
    generation: string;
    currentGeneration: string;
  }>): Promise<void> {
    const helper = this.#helpersByGeneration.get(input.currentGeneration);
    if (
      helper === undefined ||
      helper.activeGeneration !== input.currentGeneration ||
      helper.prepared !== undefined
    ) {
      throw fault("CODEX_PEER_SUCCESSION_CAPACITY");
    }
    ok(
      await helper.client.request({
        method: "prepare_generation",
        alias: input.alias,
        cwd: input.cwd,
        generation: input.generation,
      }),
    );
    helper.prepared = { alias: input.alias, generation: input.generation };
    this.#helpersByGeneration.set(input.generation, helper);
  }

  async publishPrepared(input: Readonly<{
    currentGeneration: string;
    preparedGeneration: string;
  }>): Promise<"published" | "not_published" | "unknown"> {
    const helper = this.#requireGeneration(input.currentGeneration);
    if (this.#requireGeneration(input.preparedGeneration) !== helper) {
      throw fault("CODEX_PEER_SUCCESSION_GENERATION_MISMATCH");
    }
    const result = await helper.client.request({
      method: "publish_prepared",
      ...input,
    });
    if (!("publication" in result)) {
      throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
    }
    return result.publication;
  }

  async activatePrepared(generation: string): Promise<void> {
    const helper = this.#requireGeneration(generation);
    const prepared = helper.prepared;
    if (prepared?.generation !== generation) {
      throw fault("CODEX_PEER_SUCCESSION_GENERATION_MISMATCH");
    }
    const oldAlias = helper.activeAlias;
    const oldGeneration = helper.activeGeneration;
    ok(await helper.client.request({ method: "activate_prepared", generation }));
    this.#helpersByAlias.delete(oldAlias);
    helper.retiredGeneration = oldGeneration;
    helper.activeAlias = prepared.alias;
    helper.activeGeneration = prepared.generation;
    delete helper.prepared;
    helper.authorizedRoutes.clear();
    this.#helpersByAlias.set(helper.activeAlias, helper);
  }

  async cleanupPrepared(generation: string): Promise<void> {
    const helper = this.#requireGeneration(generation);
    ok(await helper.client.request({ method: "cleanup_prepared", generation }));
    if (helper.prepared?.generation === generation) delete helper.prepared;
    this.#helpersByGeneration.delete(generation);
  }

  async resumeGeneration(generation: string): Promise<void> {
    const helper = this.#requireGeneration(generation);
    ok(await helper.client.request({ method: "resume_generation", generation }));
  }

  async rollbackPrepared(input: Readonly<{
    preparedGeneration: string;
    resumeGeneration: string;
  }>): Promise<void> {
    const helper = this.#requireGeneration(input.resumeGeneration);
    if (this.#requireGeneration(input.preparedGeneration) !== helper) {
      throw fault("CODEX_PEER_SUCCESSION_GENERATION_MISMATCH");
    }
    ok(await helper.client.request({ method: "rollback_prepared", ...input }));
    if (helper.prepared?.generation === input.preparedGeneration) {
      delete helper.prepared;
    }
    this.#helpersByGeneration.delete(input.preparedGeneration);
  }

  async retireGeneration(input: Readonly<{
    retiredGeneration: string;
    protectedActiveGeneration: string;
  }>): Promise<void> {
    const helper = this.#requireGeneration(input.protectedActiveGeneration);
    if (this.#requireGeneration(input.retiredGeneration) !== helper) {
      throw fault("CODEX_PEER_SUCCESSION_GENERATION_MISMATCH");
    }
    ok(await helper.client.request({ method: "retire_generation", ...input }));
    if (helper.retiredGeneration === input.retiredGeneration) {
      delete helper.retiredGeneration;
    }
    this.#helpersByGeneration.delete(input.retiredGeneration);
  }

  async purgeGenerationReplies(generation: string): Promise<number> {
    const helper = this.#requireGeneration(generation);
    const result = await helper.client.request({
      method: "purge_generation_replies",
      generation,
    });
    if (!("purged" in result) || !Number.isSafeInteger(result.purged)) {
      throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
    }
    return result.purged;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const helpers = [...new Set(this.#helpersByAlias.values())];
    for (const helper of helpers) helper.closing = true;
    const results = await Promise.allSettled(
      helpers.map(async (helper) => await helper.client.close()),
    );
    for (const helper of helpers) this.#removeHelper(helper);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }

  #onEvent(helper: HelperRecord, event: ClaudeNativeHelperEvent): void {
    if (helper.closing || this.#closed) return;
    const callbacks = this.#callbacks();
    if (event.event === "delivery") {
      const pending = this.#pendingDispatches.get(event.value.messageId);
      if (pending?.helper !== helper) return;
      if (event.value.state === "transport_uncertain") {
        pending.evidence = "transport_uncertain";
      } else if (
        event.value.state === "transport_written" ||
        event.value.state === "held"
      ) {
        pending.evidence = "transport_written";
      }
      if (TERMINAL_DELIVERY_STATES.has(event.value.state)) {
        this.#pendingDispatches.delete(event.value.messageId);
      }
      callbacks?.onDelivery({ ...event.value });
      return;
    }
    if (event.event === "claude_reply") {
      callbacks?.onClaudeReply({
        endpoint: { ...this.#identity, routeHandle: event.value.routeHandle },
        text: event.value.text,
      });
      return;
    }
    if (event.event === "protocol_notice") {
      callbacks?.onProtocolNotice?.({ code: event.value.code });
      return;
    }
    if (event.value.targetAlias !== helper.activeAlias) {
      callbacks?.onProtocolNotice?.({ code: "CLAUDE_NATIVE_HELPER_TARGET_MISMATCH" });
      return;
    }
    let receiptHandle: string | undefined;
    if (event.value.receiptHandle !== undefined) {
      if (this.#receiptOwners.size >= this.#maxPendingMessages) {
        void helper.client
          .request({
            method: "update_inbound_status",
            receiptHandle: event.value.receiptHandle,
            status: "expired",
            diagnosticCode: "CLAUDE_NATIVE_INGRESS_CAPACITY",
          })
          .catch(() => undefined);
        return;
      }
      receiptHandle = `nrc_${randomBytes(18).toString("base64url")}`;
      this.#receiptOwners.set(receiptHandle, {
        helper,
        childHandle: event.value.receiptHandle,
      });
    }
    callbacks?.onClaudeMessage?.({
      endpoint: { ...this.#identity, routeHandle: event.value.routeHandle },
      sourceAlias: event.value.sourceAlias,
      targetAlias: event.value.targetAlias,
      text: event.value.text,
      ...(receiptHandle === undefined ? {} : { receiptHandle }),
    });
  }

  #onExit(helper: HelperRecord): void {
    const intentional = helper.closing || this.#closed;
    if (intentional) {
      this.#removeHelper(helper);
      return;
    }
    const callbacks = this.#callbacks();
    for (const [messageId, pending] of this.#pendingDispatches) {
      if (pending.helper !== helper) continue;
      this.#pendingDispatches.delete(messageId);
      callbacks?.onDelivery({
        messageId,
        state:
          pending.evidence === "transport_written"
            ? "unconfirmed"
            : pending.evidence === "transport_uncertain"
              ? "ambiguous"
              : "failed",
        safeErrorCode: "CLAUDE_NATIVE_HELPER_EXITED",
      });
    }
    callbacks?.onProtocolNotice?.({ code: "CLAUDE_NATIVE_HELPER_EXITED" });
    this.#removeHelper(helper);
  }

  #removeHelper(helper: HelperRecord): void {
    for (const [alias, candidate] of this.#helpersByAlias) {
      if (candidate === helper) this.#helpersByAlias.delete(alias);
    }
    for (const [generation, candidate] of this.#helpersByGeneration) {
      if (candidate === helper) this.#helpersByGeneration.delete(generation);
    }
    for (const [handle, owner] of this.#receiptOwners) {
      if (owner.helper === helper) this.#receiptOwners.delete(handle);
    }
    for (const [messageId, pending] of this.#pendingDispatches) {
      if (pending.helper === helper) this.#pendingDispatches.delete(messageId);
    }
  }

  #requireGeneration(generation: string): HelperRecord {
    const helper = this.#helpersByGeneration.get(generation);
    if (helper === undefined || helper.closing) {
      throw fault("CODEX_PEER_SUCCESSION_GENERATION_MISMATCH");
    }
    return helper;
  }

  #requireReceipt(receiptHandle: string): ReceiptOwner {
    const owner = this.#receiptOwners.get(receiptHandle);
    if (owner === undefined || owner.helper.closing) {
      throw fault("CLAUDE_PEER_RECEIPT_UNKNOWN");
    }
    return owner;
  }

  #assertOpen(): void {
    if (this.#closed) throw fault("CLAUDE_NATIVE_HELPER_SUPERVISOR_CLOSED");
  }
}
