import { createHash } from "node:crypto";
import { BridgeError } from "../errors.js";

export type EndpointRef = Readonly<{ id: string; host: string; provider: "claude" | "codex" }>;
export type Endpoint = EndpointRef & { alias: string; handle: string };
export type Outcome = "delivered" | "failed" | "cancelled" | "expired" | "ambiguous" | "unconfirmed";
export type PreparedWake = Readonly<{ bytes: number; sha256: string; bodies: readonly string[] }>;
type Attempt = { attempt: string; tries: number };
export type DeliveryPhase =
  | { phase: "queued"; tries: number }
  | (Attempt & { phase: "reserved" })
  | (Attempt & { phase: "armed"; prepared: PreparedWake })
  | (Attempt & { phase: "accepted"; prepared: PreparedWake; loss: "ambiguous" | "unconfirmed" })
  | { phase: "terminal"; outcome: Outcome; at: number; code: string };
export type Delivery = {
  id: string; reply: string; token: string; source: EndpointRef; target: EndpointRef;
  body: string; admittedAt: number; deadline: number; steer: boolean;
  fingerprint: string; state: DeliveryPhase;
};
export type LedgerState = {
  schemaVersion: 6; commit: { sequence: number; id: string };
  endpoints: Endpoint[]; deliveries: Delivery[];
  retirements: { endpoint: EndpointRef; alias: string; at: number }[];
  rates: { source: EndpointRef; since: number; count: number }[];
};
export type LedgerLimits = Readonly<{
  endpoints: number; queued: number; perEndpoint: number; queueBytes: number;
  bodyBytes: number; wakeBytes: number; inFlight: number; retained: number; retainedBytes: number;
  retentionMs: number; dedupeMs: number; rateWindowMs: number; rate: number;
  deadlineMs: number;
}>;
export const ledgerDefaults: LedgerLimits = Object.freeze({
  endpoints: 128, queued: 100, perEndpoint: 20, queueBytes: 1_048_576,
  bodyBytes: 16_384, wakeBytes: 65_536, inFlight: 16, retained: 500, retainedBytes: 1_048_576,
  retentionMs: 86_400_000, dedupeMs: 300_000, rateWindowMs: 60_000,
  rate: 30, deadlineMs: 14_400_000,
});
export const sameEndpoint = (a: EndpointRef, b: EndpointRef): boolean =>
  a.id === b.id && a.host === b.host && a.provider === b.provider;
export const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex");
const ref = ({ id, host, provider }: EndpointRef): EndpointRef => ({ id, host, provider });
const reject = (code: string): never => { throw new BridgeError(code, "The ledger request was refused."); };
const pending = (d: Delivery): boolean => d.state.phase !== "terminal";

export function emptyLedger(): LedgerState {
  return { schemaVersion: 6, commit: { sequence: 0, id: "initial" }, endpoints: [], deliveries: [], retirements: [], rates: [] };
}

/** Pure synchronous transitions on a transaction-owned draft. No provider I/O, aliases in
 * message authority, callbacks, clocks, persistence or derived accounting live here. */
export class Ledger {
  constructor(readonly state: LedgerState, readonly host: string, readonly limits: LedgerLimits, readonly now: number) {}

  endpoint(identity: EndpointRef): Endpoint | undefined {
    return this.state.endpoints.find((e) => sameEndpoint(e, identity));
  }

  resolve(alias: string): Endpoint | undefined {
    const matches = this.state.endpoints.filter((e) => e.alias === alias);
    if (matches.length > 1) reject("PEER_ALIAS_COLLISION");
    return matches[0];
  }

  register(endpoint: Endpoint): void {
    if (endpoint.host !== this.host) reject("FEDERATED_ROUTE_READ_ONLY");
    const owned = this.state.endpoints.find((e) => e.id === endpoint.id);
    if (owned && (!sameEndpoint(owned, endpoint) || owned.handle !== endpoint.handle)) reject("ROUTE_BINDING_MISMATCH");
    if (this.state.endpoints.some((e) => e.provider === endpoint.provider && e.handle === endpoint.handle && e.id !== endpoint.id)) reject("ROUTE_BINDING_MISMATCH");
    if (this.state.retirements.some((r) => sameEndpoint(r.endpoint, endpoint))) reject("ROUTE_UNREGISTERED");
    if (!owned && this.state.endpoints.length >= this.limits.endpoints) reject("ROUTE_CAPACITY_EXCEEDED");
    if (owned) owned.alias = endpoint.alias;
    else this.state.endpoints.push({ ...endpoint });
  }

  private assertLocal(identity: EndpointRef): void {
    if (identity.host === this.host && !this.endpoint(identity)) reject("ROUTE_UNREGISTERED");
  }

  replyTarget(reply: string, caller: EndpointRef): EndpointRef {
    const delivery = this.state.deliveries.find((d) => d.reply === reply);
    if (!delivery) return reject("CONVERSATION_NOT_FOUND");
    this.assertLocal(caller);
    const target = sameEndpoint(delivery.target, caller) ? delivery.source
      : sameEndpoint(delivery.source, caller) ? delivery.target : undefined;
    if (!target) return reject("ROUTE_BINDING_MISMATCH");
    this.assertLocal(target);
    return ref(target);
  }

  admit(input: Omit<Delivery, "admittedAt" | "fingerprint" | "state">): { delivery: Delivery; duplicate: boolean } {
    if (input.source.host !== this.host && input.target.host !== this.host) reject("INVALID_PEER_HANDOFF");
    this.assertLocal(input.source);
    this.assertLocal(input.target);
    const bytes = Buffer.byteLength(input.body);
    if (!bytes || input.body.includes("\0") || bytes > this.limits.bodyBytes) reject("INVALID_MESSAGE_BODY");
    if (input.deadline <= this.now || input.deadline > this.now + this.limits.deadlineMs) reject("MESSAGE_EXPIRED");
    if (input.steer && (input.source.provider !== "claude" || input.target.provider !== "codex" || !input.body.startsWith("STEER:"))) reject("INVALID_MESSAGE_BODY");
    const fingerprint = bodyHash(JSON.stringify([ref(input.source), ref(input.target), input.body, input.steer]));
    const duplicate = this.state.deliveries.find((d) => d.fingerprint === fingerprint && d.admittedAt + this.limits.dedupeMs > this.now);
    if (duplicate) return { delivery: duplicate, duplicate: true };
    const active = this.state.deliveries.filter(pending);
    const steers = active.filter((d) => sameEndpoint(d.target, input.target) && d.steer && d.state.phase === "queued");
    if (input.steer && steers.length >= 3) reject("QUEUE_FULL");
    if (active.length >= this.limits.queued || active.filter((d) => sameEndpoint(d.target, input.target)).length >= this.limits.perEndpoint ||
      active.reduce((sum, d) => sum + Buffer.byteLength(d.body), bytes) > this.limits.queueBytes) reject("QUEUE_FULL");
    const rate = this.state.rates.find((r) => sameEndpoint(r.source, input.source) && r.since + this.limits.rateWindowMs > this.now);
    if (rate && rate.count >= this.limits.rate) reject("RATE_LIMITED");
    if (rate) rate.count++;
    else {
      this.state.rates = this.state.rates.filter((r) => r.since + this.limits.rateWindowMs > this.now);
      // Remote first contacts cannot create an unbounded source-rate table.
      if (this.state.rates.length >= this.limits.retained) reject("RATE_LIMITED");
      this.state.rates.push({ source: ref(input.source), since: this.now, count: 1 });
    }
    const delivery: Delivery = { ...input, source: ref(input.source), target: ref(input.target),
      admittedAt: this.now, fingerprint, state: { phase: "queued", tries: 0 } };
    this.state.deliveries.push(delivery);
    this.prune();
    return { delivery, duplicate: false };
  }

  /** Freeze the current FIFO prefix into ONE operation; later arrivals cannot enlarge it. */
  reserve(target: EndpointRef, attempt: string, steer = false): Delivery[] {
    this.expire();
    this.assertLocal(target);
    const active = this.state.deliveries.filter((d) => d.state.phase !== "queued" && d.state.phase !== "terminal");
    const operations = new Set(active.map((d) => (d.state as Attempt).attempt));
    if (operations.size >= this.limits.inFlight || active.some((d) => sameEndpoint(d.target, target) && d.steer === steer)) return [];
    let bytes = 0;
    const batch: Delivery[] = [];
    for (const d of this.state.deliveries) {
      if (d.state.phase !== "queued" || !sameEndpoint(d.target, target) || d.steer !== steer) continue;
      // Frame composition may reduce this prefix further before authorization.
      if (bytes + Buffer.byteLength(d.body) > this.limits.wakeBytes || (steer && batch.length === 1)) break;
      if (d.state.tries >= 1 + Math.ceil((d.deadline - d.admittedAt) / 500)) {
        this.finish(d, "failed", "MESSAGE_EXPIRED");
        continue;
      }
      bytes += Buffer.byteLength(d.body);
      d.state = { phase: "reserved", attempt, tries: d.state.tries + 1 };
      batch.push(d);
    }
    return batch;
  }

  authorize(ids: readonly string[], attempt: string, prepared: PreparedWake, attested: readonly Endpoint[] = []): boolean {
    const batch = this.batch(ids, attempt);
    if (!batch || batch.some((d) => d.state.phase !== "reserved" || d.deadline <= this.now)) return false;
    for (const d of batch) { this.assertLocal(d.source); this.assertLocal(d.target); }
    for (const observed of attested) {
      if (observed.host !== this.host) continue;
      const current = this.endpoint(observed);
      if (!current || current.alias !== observed.alias || current.handle !== observed.handle) return false;
    }
    if (!Number.isSafeInteger(prepared.bytes) || prepared.bytes < 1 || prepared.bytes > this.limits.wakeBytes ||
      !/^[a-f0-9]{64}$/.test(prepared.sha256) || prepared.bodies.length !== batch.length ||
      prepared.bodies.some((hash, i) => hash !== bodyHash(batch[i]!.body))) reject("INVALID_PREPARED_WRITE_EVIDENCE");
    for (const d of batch) d.state = { phase: "armed", attempt, tries: (d.state as Attempt).tries, prepared: structuredClone(prepared) };
    return true;
  }

  accept(ids: readonly string[], attempt: string, loss: "ambiguous" | "unconfirmed"): boolean {
    const batch = this.batch(ids, attempt, true);
    if (!batch || batch.some((d) => d.state.phase !== "armed")) return false;
    for (const d of batch) {
      if (d.state.phase === "armed") d.state = { ...d.state, phase: "accepted", loss };
    }
    return true;
  }

  /** Only a transport-proven no-write result may return reserved work to the queue. */
  defer(ids: readonly string[], attempt: string): boolean {
    const batch = this.batch(ids, attempt);
    if (!batch || batch.some((d) => d.state.phase !== "reserved")) return false;
    for (const d of batch) d.state = { phase: "queued", tries: (d.state as Attempt).tries };
    return true;
  }

  settle(ids: readonly string[], attempt: string, outcome: Outcome, code: string): boolean {
    const batch = this.batch(ids, attempt, true);
    if (!batch) return false;
    for (const d of batch) {
      if (d.state.phase === "reserved" && !["failed", "cancelled", "expired"].includes(outcome)) throw new RangeError("INVALID_ATTEMPT_SETTLEMENT_PHASE");
      if ((d.state.phase === "armed" || d.state.phase === "accepted") && outcome === "expired") throw new RangeError("INVALID_ATTEMPT_SETTLEMENT_PHASE");
    }
    for (const d of batch) this.finish(d, outcome, code);
    this.prune();
    return true;
  }

  lose(ids: readonly string[], attempt: string, code: string): void {
    for (const id of ids) {
      const d = this.state.deliveries.find((m) => m.id === id);
      if (!d || d.state.phase === "terminal" || d.state.phase === "queued" || d.state.attempt !== attempt) continue;
      if (d.state.phase === "reserved") d.state = { phase: "queued", tries: d.state.tries };
      else this.finish(d, d.state.phase === "armed" ? "ambiguous" : d.state.loss, code);
    }
    this.prune();
  }

  retire(identity: EndpointRef): { cancelled: number; ambiguous: number; unconfirmed: number } {
    if (identity.host !== this.host) reject("FEDERATED_ROUTE_READ_ONLY");
    const endpoint = this.endpoint(identity);
    if (!endpoint) return reject("ROUTE_UNREGISTERED");
    const counts = { cancelled: 0, ambiguous: 0, unconfirmed: 0 };
    for (const d of this.state.deliveries.filter(pending)) {
      if (!sameEndpoint(d.source, identity) && !sameEndpoint(d.target, identity)) continue;
      const outcome = d.state.phase === "armed" ? "ambiguous" : d.state.phase === "accepted" ? d.state.loss : "cancelled";
      this.finish(d, outcome, "ROUTE_UNREGISTERED");
      counts[outcome]++;
    }
    this.state.endpoints = this.state.endpoints.filter((e) => !sameEndpoint(e, identity));
    this.state.retirements.push({ endpoint: ref(identity), alias: endpoint.alias, at: this.now });
    this.prune();
    return counts;
  }

  restart(): void {
    for (const d of this.state.deliveries) {
      if (d.state.phase !== "queued" && d.state.phase !== "terminal") this.lose([d.id], d.state.attempt, "CONTROLLER_RESTARTED");
    }
    this.expire();
    this.prune();
  }

  expire(): void {
    for (const d of this.state.deliveries.filter(pending)) {
      if (d.deadline > this.now) continue;
      const outcome = d.state.phase === "armed" ? "ambiguous" : d.state.phase === "accepted" ? d.state.loss : "expired";
      this.finish(d, outcome, "MESSAGE_EXPIRED");
    }
    this.prune();
  }

  private batch(ids: readonly string[], attempt: string, ignoreTerminal = false): Delivery[] | undefined {
    if (!ids.length || new Set(ids).size !== ids.length) return undefined;
    const batch = ids.map((id) => this.state.deliveries.find((d) => d.id === id));
    const live = ignoreTerminal ? batch.filter((d) => d && d.state.phase !== "terminal") : batch;
    if (!live.length || live.some((d) => !d || d.state.phase === "queued" || d.state.phase === "terminal" || d.state.attempt !== attempt)) return undefined;
    return live as Delivery[];
  }

  private finish(d: Delivery, outcome: Outcome, code: string): void {
    d.state = { phase: "terminal", outcome, at: this.now, code };
  }

  private prune(): void {
    const cutoff = this.now - this.limits.retentionMs;
    const recent = this.state.deliveries.filter((d) => d.state.phase === "terminal" && d.state.at > cutoff).slice(-this.limits.retained);
    let bytes = recent.reduce((sum, d) => sum + Buffer.byteLength(d.body), 0);
    while (bytes > this.limits.retainedBytes) bytes -= Buffer.byteLength(recent.shift()!.body);
    const retained = new Set(recent);
    this.state.deliveries = this.state.deliveries.filter((d) => pending(d) || retained.has(d));
    this.state.retirements = this.state.retirements.filter((r) => r.at > cutoff).slice(-this.limits.retained);
    this.state.rates = this.state.rates.filter((r) => r.since + this.limits.rateWindowMs > this.now);
  }
}
