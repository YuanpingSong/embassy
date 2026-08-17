import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { BridgeError } from "../errors.js";
import { composeProvenanceEnvelope, PROVENANCE_ENVELOPE_MAX_BYTES } from "./provenance-envelope.js";
import type { GatewayAdapterDispatchInput, GatewayProviderAdapter } from "./service.js";

export type PeerMailboxAwaitInput = Readonly<{ alias: string; routeHandle: string; registrationId: string; timeoutMs?: number }>;
export type PeerMailboxAwaitResult = Readonly<{ state: "timeout" }> | Readonly<{ state: "message"; frame: string; receipt: string }>;
export type PeerMailboxReceiptInput = Readonly<{ alias: string; routeHandle: string; registrationId: string; receipt: string }>;
export type PeerMailboxReceiptResult = "acknowledged" | "duplicate" | "rejected";
export type LocalPeerMailboxProviderOptions = Readonly<{
  hostId: string; awaitTimeoutMs?: number; receiptTimeoutMs?: number; createReceipt?: () => string; now?: () => number;
}>;
type Binding = Readonly<{ alias: string; routeHandle: string; registrationId: string }>;
type Waiter = Binding & { resolve: (value: PeerMailboxAwaitResult) => void; timer: ReturnType<typeof setTimeout> };
type PendingReceipt = Binding & { resolve: (acked: boolean) => void; timer: ReturnType<typeof setTimeout>; acked: boolean; accepted: boolean };
const TIMEOUT = Object.freeze({ state: "timeout" as const });
const MAX_WAITERS = 16;
const RECEIPT = /^prc_[A-Za-z0-9_-]{24}$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION = /^conv_[A-Za-z0-9_-]{16,64}$/;

export function isPeerMailboxAwaitResult(value: unknown): value is PeerMailboxAwaitResult {
  if (!record(value)) return false;
  if (value.state === "timeout") return Object.keys(value).length === 1;
  if (value.state !== "message" || Object.keys(value).length !== 3 || typeof value.receipt !== "string" || !RECEIPT.test(value.receipt) || typeof value.frame !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value.frame);
    if (!record(parsed) || Object.keys(parsed).length !== 3 || parsed.ok !== true || parsed.command !== "await" || !record(parsed.result) || Object.keys(parsed.result).length !== 5) return false;
    const result = parsed.result;
    return typeof result.fromAlias === "string" && ALIAS.test(result.fromAlias) && typeof result.toAlias === "string" && result.toAlias.startsWith("peer-") && ALIAS.test(result.toAlias) &&
      typeof result.conversationId === "string" && CONVERSATION.test(result.conversationId) && typeof result.text === "string" && Buffer.byteLength(result.text) <= PROVENANCE_ENVELOPE_MAX_BYTES &&
      typeof result.expectsReply === "boolean" && Buffer.byteLength(value.frame) <= PROVENANCE_ENVELOPE_MAX_BYTES && value.frame === `${JSON.stringify(parsed)}\n`;
  } catch { return false; }
}

export class LocalPeerMailboxProvider implements GatewayProviderAdapter {
  readonly identity; readonly protocol = "peer-mailbox"; readonly protocolVersion = "1";
  private readonly routes = new Map<string, Binding>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly receipts = new Map<string, PendingReceipt>();
  private readonly tombstones = new Map<string, Readonly<{ receipt: string; key: string }>>();
  private closed = false;
  constructor(private readonly options: LocalPeerMailboxProviderOptions) {
    this.identity = Object.freeze({ provider: "peer" as const, hostId: options.hostId });
  }
  async initialize() { return { health: "healthy" as const }; }
  observeLogicalRoute(input: Binding): void {
    const current = this.routes.get(input.registrationId);
    if (!this.closed && (!current || same(current, input))) this.routes.set(input.registrationId, Object.freeze({ ...input }));
  }
  forgetLogicalRoute(registrationId: string): void {
    this.routes.delete(registrationId); this.cancelRegistration(registrationId); this.tombstones.delete(registrationId);
  }
  async awaitMessage(input: PeerMailboxAwaitInput): Promise<PeerMailboxAwaitResult> {
    const route = this.routes.get(input.registrationId);
    if (this.closed || !same(route, input)) throw new BridgeError("ROUTE_UNREGISTERED", "The peer mailbox binding is not current.");
    if (this.waiters.has(input.registrationId)) throw new BridgeError("ROUTE_BUSY", "The peer registration already has a waiter.", true);
    if (this.waiters.size >= MAX_WAITERS) throw new BridgeError("ROUTE_CAPACITY_REACHED", "The peer waiter limit is full.", true);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(input.registrationId); resolve(TIMEOUT); }, input.timeoutMs ?? this.options.awaitTimeoutMs ?? 30_000);
      this.waiters.set(input.registrationId, { alias: input.alias, routeHandle: input.routeHandle, registrationId: input.registrationId, resolve, timer });
    });
  }
  acknowledgeReceipt(input: PeerMailboxReceiptInput): PeerMailboxReceiptResult {
    const key = receiptKey(input);
    const tombstone = this.tombstones.get(input.registrationId);
    if (tombstone?.receipt === input.receipt && tombstone.key === key) return "duplicate";
    const pending = this.receipts.get(input.receipt);
    if (!same(pending, input)) return "rejected";
    if (pending!.acked) return "duplicate";
    pending!.acked = true; if (pending!.accepted) this.finishReceipt(input.receipt, pending!, key);
    return "acknowledged";
  }
  async dispatch(input: GatewayAdapterDispatchInput) {
    const route = this.routes.get(input.binding.registrationId);
    if (this.closed || input.binding.provider !== "peer" || input.binding.hostId !== this.identity.hostId || input.targetAlias !== route?.alias || input.binding.routeHandle !== route.routeHandle) return { state: "failed" as const, safeErrorCode: "ROUTE_UNREGISTERED" };
    const waiter = this.waiters.get(route.registrationId);
    if (waiter === undefined) return { state: "deferred" as const, safeErrorCode: "PEER_NOT_AWAITING" };
    let text: string;
    try { text = composeProvenanceEnvelope({ sourceProvider: input.sourceProvider, recipientProvider: "peer", sourceAlias: input.sourceAlias, targetAlias: input.targetAlias, conversationId: input.conversationId, body: input.text }); }
    catch { return { state: "failed" as const, safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" }; }
    const result = { fromAlias: input.sourceAlias, toAlias: input.targetAlias, conversationId: input.conversationId, text, expectsReply: input.expectsReply };
    const frame = `${JSON.stringify({ ok: true, command: "await", result })}\n`;
    if (Buffer.byteLength(frame) > PROVENANCE_ENVELOPE_MAX_BYTES) return { state: "failed" as const, safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" };
    const receipt = this.newReceipt();
    const evidence = { attemptId: input.attemptId, kind: "peer_mailbox" as const, bodyBytes: Buffer.byteLength(input.text), bodySha256: hash(input.text), frameBytes: Buffer.byteLength(frame), sha256: hash(frame) };
    let authorized: boolean;
    try { authorized = await input.authorizeWrite(evidence); }
    catch { return { state: "ambiguous" as const, safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" }; }
    if (!authorized) return { state: "failed" as const, safeErrorCode: "WRITE_AUTHORIZATION_DENIED" };
    if (this.closed || this.waiters.get(route.registrationId) !== waiter) return { state: "ambiguous" as const, safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" };
    clearTimeout(waiter.timer); this.waiters.delete(route.registrationId);
    const acked = new Promise<boolean>((resolve) => {
      const waitMs = Math.max(0, Math.min(this.options.receiptTimeoutMs ?? 2_147_483_647, Date.parse(input.deadlineAt) - (this.options.now?.() ?? Date.now())));
      const timer = setTimeout(() => { this.receipts.delete(receipt); resolve(false); }, waitMs);
      this.receipts.set(receipt, { ...route, resolve, timer, acked: false, accepted: false });
    });
    waiter.resolve({ state: "message", frame, receipt });
    try { await input.onAccepted({ attemptId: input.attemptId }); }
    catch { this.cancelReceipt(receipt); return { state: "ambiguous" as const, safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" }; }
    const pending = this.receipts.get(receipt); if (pending) { pending.accepted = true; if (pending.acked) this.finishReceipt(receipt, pending, receiptKey({ ...route, receipt })); }
    return await acked ? { state: "delivered" as const } : { state: "unconfirmed" as const, safeErrorCode: "DELIVERY_UNCONFIRMED" };
  }
  async close(): Promise<void> {
    this.closed = true; for (const id of [...this.routes.keys()]) this.cancelRegistration(id); this.routes.clear(); this.tombstones.clear();
  }
  private cancelRegistration(id: string): void {
    const waiter = this.waiters.get(id); if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(id); waiter.resolve(TIMEOUT); }
    for (const [receipt, pending] of this.receipts) if (pending.registrationId === id) this.cancelReceipt(receipt);
  }
  private cancelReceipt(receipt: string): void { const pending = this.receipts.get(receipt); if (pending) { clearTimeout(pending.timer); this.receipts.delete(receipt); pending.resolve(false); } }
  private finishReceipt(receipt: string, pending: PendingReceipt, key: string): void { clearTimeout(pending.timer); this.receipts.delete(receipt); this.tombstones.set(pending.registrationId, { receipt, key }); pending.resolve(true); }
  private newReceipt(): string { const value = this.options.createReceipt?.() ?? `prc_${randomBytes(18).toString("base64url")}`; if (!RECEIPT.test(value) || this.receipts.has(value) || [...this.tombstones.values()].some((item) => item.receipt === value)) throw new Error("invalid receipt"); return value; }
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const same = (left: Binding | undefined, right: Binding): boolean => left?.alias === right.alias && left.routeHandle === right.routeHandle && left.registrationId === right.registrationId;
const receiptKey = (input: PeerMailboxReceiptInput): string => `${input.registrationId}\0${input.routeHandle}\0${input.alias}\0${input.receipt}`;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
