import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import type { GatewayAdapterCallbacks, GatewayAdapterDispatchResult } from "./service.js";
import { gatewayRegistrationIngressPrefixes, isGatewayProvider, type GatewayProvider, type LogicalRouteBinding } from "./types.js";
import {
  assertClaudeNativeHelperIpcSize, CLAUDE_NATIVE_HELPER_MAX_REQUESTS,
  CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION, isClaudeNativeHelperChildMessage,
  type ClaudeNativeHelperChildMessage, type ClaudeNativeHelperCommand,
  type ClaudeNativeHelperEvent, type ClaudeNativeHelperInitialization,
  type ClaudeNativeHelperRegistration, type ClaudeNativeHelperResult,
} from "./claude-helper-protocol.js";

const TIMEOUT = 5_000, CLOSE_TIMEOUT = 2_000;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION = /^conv_[A-Za-z0-9_-]{16,64}$/;
function fault(code: string, recoverable = false): BridgeError {
  return new BridgeError(code, "The supervised native Claude helper could not complete its bounded operation.", recoverable);
}
const id = (): string => randomBytes(18).toString("base64url");
function requireOk(result: ClaudeNativeHelperResult): void {
  if (!("ok" in result) || result.ok !== true) throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
}

export type ClaudeNativeHelperClientCallbacks = Readonly<{
  onEvent: (event: ClaudeNativeHelperEvent) => void;
  onExit: (event: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
}>;
export type ClaudeNativeHelperClientStartOptions = Readonly<{
  entryPath?: string; runtime: AttestedClaudePeerRuntime; hostId: string;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number; registration: ClaudeNativeHelperRegistration;
  callbacks: ClaudeNativeHelperClientCallbacks;
}>;
export interface ClaudeNativeHelperClientLike {
  readonly pid: number; readonly registration: ClaudeNativeHelperRegistration; generation: string;
  request(command: ClaudeNativeHelperCommand, timeoutMs?: number): Promise<ClaudeNativeHelperResult>;
  close(): Promise<void>; forceClose(): Promise<void>;
}
export type ClaudeNativeHelperFactory = (options: ClaudeNativeHelperClientStartOptions) => Promise<ClaudeNativeHelperClientLike>;
type Pending = { resolve: (value: ClaudeNativeHelperResult) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout };

export class ClaudeNativeHelperClient implements ClaudeNativeHelperClientLike {
  readonly pid: number; readonly registration: ClaudeNativeHelperRegistration; generation = "";
  readonly #pending = new Map<string, Pending>(); readonly #exit: Promise<void>; #resolveExit!: () => void;
  #closed = false; #exited = false;
  private constructor(readonly child: ChildProcess, registration: ClaudeNativeHelperRegistration,
    readonly callbacks: ClaudeNativeHelperClientCallbacks) {
    if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) throw fault("CLAUDE_NATIVE_HELPER_PID_INVALID");
    this.pid = child.pid!; this.registration = registration;
    this.#exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    child.on("message", (value) => this.#message(value));
    child.once("error", () => this.#fail(fault("CLAUDE_NATIVE_HELPER_SPAWN_FAILED")));
    child.once("exit", (code, signal) => { if (this.#exited) return; this.#exited = true;
      this.#fail(fault("CLAUDE_NATIVE_HELPER_EXITED")); this.#resolveExit(); callbacks.onExit({ code, signal }); });
  }
  static async start(options: ClaudeNativeHelperClientStartOptions): Promise<ClaudeNativeHelperClient> {
    const child = fork(options.entryPath ?? fileURLToPath(new URL("./claude-helper.js", import.meta.url)), [], {
      cwd: "/", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" }, execPath: process.execPath,
      execArgv: [], serialization: "json", stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const client = new ClaudeNativeHelperClient(child, options.registration, options.callbacks);
    const init: ClaudeNativeHelperInitialization = { protocolVersion: 1, type: "initialize", requestId: id(),
      runtime: options.runtime, hostId: options.hostId, deliveryNotices: options.deliveryNotices,
      maxPendingMessages: options.maxPendingMessages, registration: options.registration };
    try { const result = await client.#send(init); if (!("generation" in result)) throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
      client.generation = result.generation; return client; }
    catch (error) { await client.forceClose(); throw error; }
  }
  request(command: ClaudeNativeHelperCommand, timeoutMs = TIMEOUT): Promise<ClaudeNativeHelperResult> {
    return this.#send({ protocolVersion: 1, type: "request", requestId: id(), command }, timeoutMs);
  }
  async close(): Promise<void> {
    if (!this.#closed) { try { await this.request({ method: "close" }, CLOSE_TIMEOUT); } catch { this.child.kill("SIGTERM"); }
      this.#closed = true; } await this.#awaitExit();
  }
  async forceClose(): Promise<void> { this.#closed = true; if (!this.#exited) this.child.kill("SIGTERM"); await this.#awaitExit(); }
  async #awaitExit(): Promise<void> { const timer = setTimeout(() => this.child.kill("SIGKILL"), CLOSE_TIMEOUT); timer.unref();
    await this.#exit; clearTimeout(timer); }
  async #send(message: ClaudeNativeHelperInitialization | Readonly<{ protocolVersion: 1; type: "request"; requestId: string; command: ClaudeNativeHelperCommand }>, timeoutMs = TIMEOUT): Promise<ClaudeNativeHelperResult> {
    if (this.#closed || this.#exited || !this.child.connected || this.child.killed) throw fault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true);
    if (this.#pending.size >= CLAUDE_NATIVE_HELPER_MAX_REQUESTS) throw fault("CLAUDE_NATIVE_HELPER_REQUEST_CAPACITY", true);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw fault("CLAUDE_NATIVE_HELPER_TIMEOUT_INVALID");
    assertClaudeNativeHelperIpcSize(message);
    const pending = new Promise<ClaudeNativeHelperResult>((resolve, reject) => { const timer = setTimeout(() => {
      this.#pending.delete(message.requestId); reject(fault("CLAUDE_NATIVE_HELPER_REQUEST_TIMEOUT")); }, timeoutMs); timer.unref();
      this.#pending.set(message.requestId, { resolve, reject, timer }); });
    this.child.send(message as Serializable, (error) => { if (error === null) return; const entry = this.#pending.get(message.requestId);
      if (entry) { clearTimeout(entry.timer); this.#pending.delete(message.requestId); entry.reject(fault("CLAUDE_NATIVE_HELPER_IPC_FAILED", true)); } });
    return await pending;
  }
  #message(value: unknown): void {
    try { assertClaudeNativeHelperIpcSize(value); if (!isClaudeNativeHelperChildMessage(value)) throw fault("CLAUDE_NATIVE_HELPER_PROTOCOL_INVALID"); }
    catch (error) { this.#fail(error); this.child.kill("SIGTERM"); return; }
    const message: ClaudeNativeHelperChildMessage = value;
    if (message.type === "event") { this.callbacks.onEvent(message.value); return; }
    const pending = this.#pending.get(message.requestId); if (!pending) return;
    clearTimeout(pending.timer); this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result); else pending.reject(fault(message.error.code, message.error.recoverable));
  }
  #fail(error: unknown): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear(); }
}
export const createClaudeNativeHelper: ClaudeNativeHelperFactory = ClaudeNativeHelperClient.start;

type Helper = { client: ClaudeNativeHelperClientLike; alias: string; sourceProvider: GatewayProvider; closing: boolean };
type Receipt = Readonly<{ helper: Helper; childHandle: string }>;
type Preparation = { helper: Helper; cancel: () => Promise<void> };
export type ClaudeNativeHelperPreparedDispatch = Readonly<{ frameBytes: number; sha256: string;
  perform: () => Promise<GatewayAdapterDispatchResult>; cancel: () => Promise<void> }>;
export type ClaudeNativeHelperSupervisorOptions = Readonly<{
  identity: Pick<LogicalRouteBinding, "provider" | "hostId">; runtime: AttestedClaudePeerRuntime;
  deliveryNotices: GatewayDeliveryNoticeMode; maxPendingMessages: number;
  maxHelpers: number; callbacks: () => GatewayAdapterCallbacks | undefined; factory?: ClaudeNativeHelperFactory;
}>;

export class ClaudeNativeHelperSupervisor {
  readonly #helpers = new Map<string, Helper>(); readonly #receipts = new Map<string, Receipt>();
  readonly #preparations = new Set<Preparation>(); readonly #factory: ClaudeNativeHelperFactory; #closed = false;
  constructor(readonly options: ClaudeNativeHelperSupervisorOptions) { this.#factory = options.factory ?? createClaudeNativeHelper; }
  get size(): number { return this.#helpers.size; }
  async advertise(input: ClaudeNativeHelperRegistration): Promise<void> {
    if (this.#closed) throw fault("CLAUDE_NATIVE_HELPER_SUPERVISOR_CLOSED");
    if (!isGatewayProvider(input.sourceProvider) || !gatewayRegistrationIngressPrefixes[input.sourceProvider] ||
      !input.alias.startsWith(gatewayRegistrationIngressPrefixes[input.sourceProvider]!)) throw fault("PROVENANCE_ENVELOPE_INVALID");
    const old = this.#helpers.get(input.alias); if (old) { if (old.sourceProvider !== input.sourceProvider) throw fault("PROVENANCE_ENVELOPE_INVALID"); return; }
    if (this.#helpers.size >= this.options.maxHelpers) throw fault("CLAUDE_NATIVE_HELPER_CAPACITY", true);
    let helper: Helper | undefined, earlyExit = false; const buffered: ClaudeNativeHelperEvent[] = [];
    const client = await this.#factory({ runtime: this.options.runtime, hostId: this.options.identity.hostId,
      deliveryNotices: this.options.deliveryNotices, maxPendingMessages: this.options.maxPendingMessages, registration: input,
      callbacks: { onEvent: (event) => helper ? this.#event(helper, event) : buffered.push(event),
        onExit: () => helper ? this.#exit(helper) : earlyExit = true } });
    if (this.#closed || earlyExit) { await client.forceClose().catch(() => undefined); throw fault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true); }
    helper = { client, alias: input.alias, sourceProvider: input.sourceProvider, closing: false };
    this.#helpers.set(input.alias, helper); for (const event of buffered) this.#event(helper, event);
  }
  async updateStatus(alias: string, status: "idle" | "busy" | "waiting"): Promise<void> {
    const helper = this.#helpers.get(alias); if (helper && !helper.closing) requireOk(await helper.client.request({ method: "update_status", alias, status }));
  }
  async unadvertise(alias: string): Promise<void> {
    const helper = this.#helpers.get(alias); if (!helper) return; helper.closing = true; let failure: unknown;
    try { requireOk(await helper.client.request({ method: "unadvertise", alias })); } catch (error) { failure = error; }
    await helper.client.close().catch((error) => { failure ??= error; }); this.#remove(helper); if (failure) throw failure;
  }
  async prepareDispatch(input: Readonly<{ sourceAlias: string; sourceProvider: GatewayProvider; targetAlias: string;
    conversationId: string; selectedAlias?: string; stateRoot?: string; binding: LogicalRouteBinding;
    authorization: "selected_route" | "native_reply"; messageId: string; text: string; expectsReply: boolean;
    deadlineAt: string }>): Promise<ClaudeNativeHelperPreparedDispatch> {
    if (!ALIAS.test(input.sourceAlias) || !ALIAS.test(input.targetAlias) || !CONVERSATION.test(input.conversationId) ||
      !isGatewayProvider(input.sourceProvider)) throw fault("PROVENANCE_ENVELOPE_INVALID");
    if (Buffer.byteLength(input.text) > 16 * 1024) throw fault("PROVENANCE_ENVELOPE_TOO_LARGE");
    const helper = this.#helpers.get(input.sourceAlias);
    if (!helper || helper.closing) throw fault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true);
    if (helper.sourceProvider !== input.sourceProvider) throw fault("PROVENANCE_ENVELOPE_INVALID");
    if (input.authorization === "selected_route" && !input.stateRoot)
      throw fault("CLAUDE_ROUTE_UNAVAILABLE", true);
    const result = await helper.client.request({ method: "prepare_dispatch", binding: input.binding,
      authorization: input.authorization, ...(input.authorization === "selected_route" ? { stateRoot: input.stateRoot! } : {}),
      messageId: input.messageId, sourceAlias: helper.alias, sourceProvider: helper.sourceProvider,
      targetAlias: input.targetAlias, conversationId: input.conversationId, text: input.text,
      expectsReply: input.expectsReply, deadlineAt: input.deadlineAt }, this.#deadline(input.deadlineAt));
    if (!("preparationId" in result)) throw fault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
    let state: "prepared" | "consumed" = "prepared"; let tracked!: Preparation;
    const cancel = async (): Promise<void> => { if (state !== "prepared") return; state = "consumed"; this.#preparations.delete(tracked);
      try { requireOk(await helper.client.request({ method: "cancel_dispatch", preparationId: result.preparationId })); }
      catch (error) { if (!(error instanceof BridgeError) || error.code !== "CLAUDE_NATIVE_PREPARATION_UNKNOWN") throw error; } };
    const perform = (): Promise<GatewayAdapterDispatchResult> => { if (state !== "prepared") return Promise.resolve({ state: "failed", safeErrorCode: "CLAUDE_NATIVE_PREPARATION_CONSUMED" });
      state = "consumed"; this.#preparations.delete(tracked);
      return helper.client.request({ method: "perform_dispatch", preparationId: result.preparationId }, this.#deadline(input.deadlineAt)).then(
        (value) => "state" in value ? value : { state: "ambiguous", safeErrorCode: "CLAUDE_NATIVE_HELPER_INVALID_RESPONSE" },
        (error: unknown) => error instanceof BridgeError && ["CLAUDE_NATIVE_PREPARATION_UNKNOWN", "CLAUDE_NATIVE_PREPARATION_MISMATCH", "CLAUDE_PEER_PREPARATION_CONSUMED"].includes(error.code)
          ? { state: "failed", safeErrorCode: error.code } : { state: "ambiguous", safeErrorCode: "CLAUDE_NATIVE_HELPER_PERFORM_UNCERTAIN" }); };
    tracked = { helper, cancel }; this.#preparations.add(tracked);
    return Object.freeze({ frameBytes: result.frameBytes, sha256: result.sha256, perform, cancel });
  }
  async updateInboundStatus(receiptHandle: string, status: "held" | "delivered" | "denied" | "expired", diagnosticCode?: string): Promise<void> {
    const owner = this.#receipt(receiptHandle);
    try { requireOk(await owner.helper.client.request({ method: "update_inbound_status",
      receiptHandle: owner.childHandle, status, ...(diagnosticCode ? { diagnosticCode } : {}) }));
      if (status !== "held") this.#receipts.delete(receiptHandle); }
    catch (error) { if (status !== "held" && (!(error instanceof BridgeError) || !error.recoverable)) this.#receipts.delete(receiptHandle); throw error; }
  }
  async notifyInboundProgress(receiptHandle: string, progress: import("./claude-peer.js").ClaudePeerInboundProgress): Promise<void> {
    const owner = this.#receipt(receiptHandle); requireOk(await owner.helper.client.request({ method: "notify_inbound_progress", receiptHandle: owner.childHandle, progress }));
  }
  async releaseInboundReceipt(receiptHandle: string): Promise<boolean> {
    const owner = this.#receipts.get(receiptHandle); if (!owner) return false; this.#receipts.delete(receiptHandle);
    const result = await owner.helper.client.request({ method: "release_inbound_receipt", receiptHandle: owner.childHandle });
    return "released" in result && result.released;
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; await Promise.allSettled([...this.#preparations].map((item) => item.cancel()));
    const helpers = [...this.#helpers.values()]; for (const helper of helpers) helper.closing = true;
    const results = await Promise.allSettled(helpers.map((helper) => helper.client.close())); for (const helper of helpers) this.#remove(helper);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (failed) throw failed.reason;
  }
  #event(helper: Helper, event: ClaudeNativeHelperEvent): void {
    if (helper.closing || this.#closed) return; const callbacks = this.options.callbacks();
    if (event.event === "protocol_notice") { callbacks?.onProtocolNotice?.(event.value); return; }
    if (event.value.targetAlias !== helper.alias) { callbacks?.onProtocolNotice?.({ code: "CLAUDE_NATIVE_HELPER_TARGET_MISMATCH" }); return; }
    let receiptHandle: string | undefined;
    if (event.value.receiptHandle) { if (this.#receipts.size >= this.options.maxPendingMessages) { void helper.client.request({ method: "update_inbound_status",
        receiptHandle: event.value.receiptHandle, status: "expired", diagnosticCode: "CLAUDE_NATIVE_INGRESS_CAPACITY" }).catch(() => undefined); return; }
      receiptHandle = `nrc_${id()}`; this.#receipts.set(receiptHandle, { helper, childHandle: event.value.receiptHandle }); }
    callbacks?.onClaudeMessage?.({ endpoint: { ...this.options.identity, routeHandle: event.value.routeHandle },
      sourceAlias: event.value.sourceAlias, targetAlias: event.value.targetAlias, text: event.value.text,
      ...(receiptHandle ? { receiptHandle } : {}) });
  }
  #exit(helper: Helper): void { if (!helper.closing && !this.#closed) this.options.callbacks()?.onProtocolNotice?.({ code: "CLAUDE_NATIVE_HELPER_EXITED" }); this.#remove(helper); }
  #remove(helper: Helper): void { if (this.#helpers.get(helper.alias) === helper) this.#helpers.delete(helper.alias);
    for (const [id, owner] of this.#receipts) if (owner.helper === helper) this.#receipts.delete(id);
    for (const prepared of [...this.#preparations]) if (prepared.helper === helper) this.#preparations.delete(prepared); }
  #receipt(id: string): Receipt { const owner = this.#receipts.get(id); if (!owner || owner.helper.closing) throw fault("CLAUDE_PEER_RECEIPT_UNKNOWN"); return owner; }
  #deadline(value: string): number { return Math.max(1, Math.min(60_000, Date.parse(value) - Date.now())); }
}
