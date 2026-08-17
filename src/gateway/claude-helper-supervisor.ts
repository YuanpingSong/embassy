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
  GatewayAdapterCallbacks,
  GatewayAdapterDispatchResult,
} from "./service.js";
import {
  isGatewayProvider,
  type GatewayProvider,
  type LogicalRouteBinding,
} from "./types.js";

type LogicalProviderIdentity = Readonly<
  Pick<LogicalRouteBinding, "provider" | "hostId">
>;

type HelperRecord = {
  client: ClaudeNativeHelperClientLike;
  alias: string;
  sourceProvider: GatewayProvider;
  authorizedRoutes: Map<string, string>;
  closing: boolean;
};

type ReceiptOwner = Readonly<{
  helper: HelperRecord;
  childHandle: string;
}>;

type SupervisorPreparation = {
  helper: HelperRecord;
  cancel: () => Promise<void>;
};

export type ClaudeNativeHelperPreparedDispatch = Readonly<{
  frameBytes: number;
  sha256: string;
  perform: () => Promise<GatewayAdapterDispatchResult>;
  cancel: () => Promise<void>;
}>;

export type ClaudeNativeHelperSupervisorOptions = Readonly<{
  identity: LogicalProviderIdentity;
  runtime: AttestedClaudePeerRuntime;
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number;
  maxHelpers: number;
  callbacks: () => GatewayAdapterCallbacks | undefined;
  factory?: ClaudeNativeHelperFactory;
}>;

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
  readonly #identity: LogicalProviderIdentity;
  readonly #runtime: AttestedClaudePeerRuntime;
  readonly #locale: DashboardLocale;
  readonly #deliveryNotices: GatewayDeliveryNoticeMode;
  readonly #maxPendingMessages: number;
  readonly #maxHelpers: number;
  readonly #callbacks: () => GatewayAdapterCallbacks | undefined;
  readonly #factory: ClaudeNativeHelperFactory;
  readonly #helpersByAlias = new Map<string, HelperRecord>();
  readonly #receiptOwners = new Map<string, ReceiptOwner>();
  readonly #preparations = new Set<SupervisorPreparation>();
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

  async advertise(input: Readonly<{
    alias: string;
    sourceProvider: GatewayProvider;
    cwd: string;
  }>): Promise<void> {
    this.#assertOpen();
    if (!isGatewayProvider(input.sourceProvider)) {
      throw fault("PROVENANCE_ENVELOPE_INVALID");
    }
    const incumbent = this.#helpersByAlias.get(input.alias);
    if (incumbent !== undefined) {
      if (incumbent.sourceProvider !== input.sourceProvider) {
        throw fault("PROVENANCE_ENVELOPE_INVALID");
      }
      return;
    }
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
      alias: input.alias,
      sourceProvider: input.sourceProvider,
      authorizedRoutes: new Map(),
      closing: false,
    };
    this.#helpersByAlias.set(input.alias, record);
    for (const event of buffered) this.#onEvent(record, event);
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

  async prepareDispatch(input: Readonly<{
    sourceAlias: string;
    sourceProvider: GatewayProvider;
    targetAlias: string;
    conversationId: string;
    selectedAlias?: string;
    stateRoot?: string;
    binding: LogicalRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
    progressWatchActive?: true;
  }>): Promise<ClaudeNativeHelperPreparedDispatch> {
    if (
      typeof input.sourceAlias !== "string" ||
      !PUBLIC_ALIAS.test(input.sourceAlias) ||
      !isGatewayProvider(input.sourceProvider) ||
      typeof input.targetAlias !== "string" ||
      !PUBLIC_ALIAS.test(input.targetAlias) ||
      typeof input.conversationId !== "string" ||
      !CONVERSATION_ID.test(input.conversationId) ||
      typeof input.text !== "string"
    ) {
      throw fault("PROVENANCE_ENVELOPE_INVALID");
    }
    if (Buffer.byteLength(input.text, "utf8") > MAX_RAW_BODY_BYTES) {
      throw fault("PROVENANCE_ENVELOPE_TOO_LARGE");
    }
    const helper = this.#helpersByAlias.get(input.sourceAlias);
    if (helper === undefined || helper.closing) {
      throw fault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true);
    }
    if (helper.sourceProvider !== input.sourceProvider) {
      throw fault("PROVENANCE_ENVELOPE_INVALID");
    }
    if (input.authorization === "selected_route") {
      if (
        input.selectedAlias === undefined ||
        input.stateRoot === undefined
      ) {
        throw fault("CLAUDE_ROUTE_UNAVAILABLE", true);
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
    const result = await helper.client.request(
      {
          method: "prepare_dispatch",
          binding: input.binding,
          authorization: input.authorization,
          messageId: input.messageId,
          sourceAlias: helper.alias,
          sourceProvider: helper.sourceProvider,
          targetAlias: input.targetAlias,
          conversationId: input.conversationId,
          text: input.text,
          expectsReply: input.expectsReply,
          deadlineAt: input.deadlineAt,
          ...(input.progressWatchActive === true
            ? { progressWatchActive: true as const }
            : {}),
      },
      Math.max(
        1,
        Math.min(60_000, Date.parse(input.deadlineAt) - Date.now()),
      ),
    );
    if (
      !("preparationId" in result) ||
      typeof result.preparationId !== "string" ||
      !("frameBytes" in result) ||
      !("sha256" in result)
    ) {
      throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
    }
    let state: "prepared" | "performed" | "cancelled" = "prepared";
    let tracked!: SupervisorPreparation;
    const cancel = async (): Promise<void> => {
      if (state !== "prepared") return;
      state = "cancelled";
      this.#preparations.delete(tracked);
      try {
        ok(
          await helper.client.request({
            method: "cancel_dispatch",
            preparationId: result.preparationId,
          }),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          error.code === "CLAUDE_NATIVE_PREPARATION_UNKNOWN"
        ) {
          return;
        }
        throw error;
      }
    };
    const perform = (): Promise<GatewayAdapterDispatchResult> => {
      if (state !== "prepared") {
        return Promise.resolve({
          state: "failed",
          safeErrorCode: "CLAUDE_NATIVE_PREPARATION_CONSUMED",
        });
      }
      state = "performed";
      this.#preparations.delete(tracked);
      const operation = helper.client.request(
        {
          method: "perform_dispatch",
          preparationId: result.preparationId,
        },
        Math.max(
          1,
          Math.min(60_000, Date.parse(input.deadlineAt) - Date.now()),
        ),
      );
      return operation.then(
        (performed): GatewayAdapterDispatchResult => {
          if (
            !("state" in performed) ||
            ![
              "delivered",
              "unconfirmed",
              "failed",
              "ambiguous",
              "expired",
              "cancelled",
            ].includes(String(performed.state))
          ) {
            return {
              state: "ambiguous",
              safeErrorCode: "CLAUDE_NATIVE_HELPER_INVALID_RESPONSE",
            };
          }
          return performed as GatewayAdapterDispatchResult;
        },
        (error: unknown): GatewayAdapterDispatchResult => {
          if (error instanceof BridgeError) {
            if (error.code === "CLAUDE_PEER_MESSAGE_EXPIRED") {
              return { state: "expired", safeErrorCode: error.code };
            }
            if (
              error.code === "CLAUDE_NATIVE_PREPARATION_UNKNOWN" ||
              error.code === "CLAUDE_NATIVE_PREPARATION_MISMATCH" ||
              error.code === "CLAUDE_PEER_PREPARATION_CONSUMED"
            ) {
              return { state: "failed", safeErrorCode: error.code };
            }
          }
          return {
            state: "ambiguous",
            safeErrorCode: "CLAUDE_NATIVE_HELPER_PERFORM_UNCERTAIN",
          };
        },
      );
    };
    tracked = { helper, cancel };
    this.#preparations.add(tracked);
    return Object.freeze({
      frameBytes: result.frameBytes,
      sha256: result.sha256,
      perform,
      cancel,
    });
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#preparations].map(async (prepared) => await prepared.cancel()),
    );
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
    if (event.value.targetAlias !== helper.alias) {
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
    callbacks?.onProtocolNotice?.({ code: "CLAUDE_NATIVE_HELPER_EXITED" });
    this.#removeHelper(helper);
  }

  #removeHelper(helper: HelperRecord): void {
    for (const [alias, candidate] of this.#helpersByAlias) {
      if (candidate === helper) this.#helpersByAlias.delete(alias);
    }
    for (const [handle, owner] of this.#receiptOwners) {
      if (owner.helper === helper) this.#receiptOwners.delete(handle);
    }
    for (const prepared of [...this.#preparations]) {
      if (prepared.helper === helper) this.#preparations.delete(prepared);
    }
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
