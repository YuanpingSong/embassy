import { randomUUID } from "node:crypto";
import { BridgeError } from "../errors.js";
import { Ledger, NATIVE_FRAME_RESERVE_BYTES, bodyHash, sameEndpoint, type Delivery, type Endpoint, type EndpointRef, type LedgerLimits, type LedgerState, type Outcome } from "./ledger.js";
import { OwnedStateFile } from "./owned-state.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";

export type WakeResult = Readonly<{
  outcome: Outcome | "deferred";
  code: string;
  unwritten?: true;
}>;
export type WakeInput = Readonly<{
  attempt: string; target: Endpoint; text: string; deadline: number; steer: boolean;
  messages: readonly Readonly<{ delivery: Delivery; source: Endpoint }>[];
  authorize: (evidence: Readonly<{ bytes: number; sha256: string }>) => Promise<boolean>;
  accepted: (loss: "ambiguous" | "unconfirmed") => Promise<void>;
}>;
export interface Destination {
  deliver(input: WakeInput): Promise<WakeResult>;
  close(): Promise<void>;
}
export type CoordinatorOptions = Readonly<{
  host: string; limits: LedgerLimits; store: OwnedStateFile<LedgerState>;
  claude: Destination; codex: Destination; ssh: Destination;
  /** Exact-ID resolution/attestation, never mutable-name fallback. Remote resolution
   * is authenticated by the owning broker; a catalog observation alone is not authority. */
  resolve: (identity: EndpointRef) => Promise<Endpoint | undefined>;
  now?: () => number; attemptId?: () => string;
  assertWritable?: () => void;
}>;

/** Owns scheduling and write phases, but never holds the state mutex during provider I/O. */
export class Coordinator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly observations = new Map<string, WakeResult>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  observation(identity: EndpointRef): WakeResult | undefined {
    return this.observations.get(JSON.stringify([identity.host, identity.provider, identity.id]));
  }

  private observed(identity: EndpointRef, result: WakeResult): void {
    const key = JSON.stringify([identity.host, identity.provider, identity.id]);
    this.observations.delete(key);
    this.observations.set(key, { outcome: result.outcome,
      code: /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) ? result.code : "DISPATCH_OUTCOME_AMBIGUOUS" });
    if (this.observations.size > this.options.limits.endpoints + this.options.limits.queued)
      this.observations.delete(this.observations.keys().next().value!);
  }

  private change<R>(operation: (ledger: Ledger) => R): Promise<R> {
    return this.options.store.transact((state) => operation(new Ledger(state, this.options.host, this.options.limits, this.now())));
  }

  wake(target: EndpointRef, steer = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = JSON.stringify([target.host, target.provider, target.id, steer]);
    const existing = this.running.get(key);
    if (existing) return existing;
    // Retiring a ledger row does not interrupt its already-running native turn.
    // Count actual operations too, so retirement cannot bypass the resource cap.
    if (this.running.size >= this.options.limits.inFlight) return Promise.resolve();
    const operation = (async () => {
      // Drain successful prefixes, including arrivals coalesced during I/O. A clean
      // busy result ends this pass; the ledger's readyAt bounds the next attempt.
      while (!this.closed && await this.run(target, steer)) {}
    })().finally(() => {
      if (this.running.get(key) === operation) this.running.delete(key);
    });
    this.running.set(key, operation);
    return operation;
  }

  private async run(identity: EndpointRef, steer: boolean): Promise<boolean> {
    const attempt = this.options.attemptId?.() ?? `attempt_${randomUUID()}`;
    let batch = await this.change((ledger) => ledger.reserve(identity, attempt, steer));
    if (!batch.length) return false;
    const ids = () => batch.map((d) => d.id);
    try {
      const target = await this.options.resolve(identity);
      if (!target || !sameEndpoint(target, identity)) {
        this.observed(identity, { outcome: "failed", code: "ROUTE_UNREGISTERED" });
        await this.change((ledger) => ledger.settle(ids(), attempt, "failed", "ROUTE_UNREGISTERED"));
        return true;
      }
      const frames: string[] = [];
      const sources: Endpoint[] = [];
      const resolved = new Map<string, Endpoint | undefined>();
      let bytes = 0;
      for (let index = 0; index < batch.length; index++) {
        const d = batch[index]!;
        const key = JSON.stringify(d.source);
        if (!resolved.has(key)) resolved.set(key, d.source.host !== this.options.host && d.sourceAlias
          ? { ...d.source, alias: d.sourceAlias, handle: d.source.id }
          : await this.options.resolve(d.source));
        const source = resolved.get(key);
        if (!source || !sameEndpoint(source, d.source)) {
          await this.change((ledger) => ledger.settle([d.id], attempt, "failed", "ROUTE_UNREGISTERED"));
          continue;
        }
        const frame = composeProvenanceEnvelope({ sourceProvider: source.provider, recipientProvider: target.provider,
          sourceAlias: source.alias, targetAlias: target.alias, conversationId: d.reply, body: d.body });
        // Count JSON escaping too: the native transports wrap this text in JSON.
        // Leave space for their bounded RPC/identity fields, then authorize against
        // the actual immutable native frame rather than this packing estimate.
        const framedBytes = Buffer.byteLength(JSON.stringify(frame)) + (frames.length ? 2 : 0);
        if (bytes + framedBytes + NATIVE_FRAME_RESERVE_BYTES > this.options.limits.wakeBytes) {
          if (!frames.length) {
            await this.change((ledger) => ledger.settle([d.id], attempt, "failed", "PROVENANCE_ENVELOPE_TOO_LARGE"));
            continue;
          }
          await this.change((ledger) => ledger.defer(batch.slice(index).map((m) => m.id), attempt));
          break;
        }
        bytes += framedBytes;
        sources.push(source);
        frames.push(frame);
      }
      // Some pre-write refusals or frame-size bounds can reduce the reserved prefix.
      const state = await this.options.store.snapshot();
      batch = batch.filter((d) => state.deliveries.some((m) => m.id === d.id && m.state.phase === "reserved" && m.state.attempt === attempt));
      if (!batch.length) return false;
      if (frames.length !== batch.length) throw new Error("INCOMPLETE_WAKE_PREPARATION");
      const destination = identity.host !== this.options.host ? this.options.ssh : identity.provider === "claude" ? this.options.claude : this.options.codex;
      const result = await destination.deliver({ attempt, target, text: frames.join("\n"),
        messages: batch.map((delivery, i) => ({ delivery, source: sources[i]! })),
        deadline: Math.min(...batch.map((d) => d.deadline)), steer,
        authorize: async (evidence) => {
          if (this.closed) return false;
          this.options.assertWritable?.();
          // Re-resolve after preparation: a rename requires new envelope bytes, and a
          // replacement must never inherit this operation's exact identity.
          const currentTarget = await this.options.resolve(identity);
          if (!currentTarget || !sameEndpoint(currentTarget, target) || currentTarget.alias !== target.alias || currentTarget.handle !== target.handle) return false;
          for (const source of sources) {
            if (source.host !== this.options.host) continue; // Owner-attested at destination handoff admission.
            const current = await this.options.resolve(source);
            if (!current || !sameEndpoint(current, source) || current.alias !== source.alias || current.handle !== source.handle) return false;
          }
          const authorized = await this.change((ledger) => {
            if (this.closed) return false;
            this.options.assertWritable?.();
            return ledger.authorize(ids(), attempt, { ...evidence, bodies: batch.map((d) => bodyHash(d.body)) }, [target, ...sources]);
          });
          this.options.assertWritable?.();
          return authorized && !this.closed;
        },
        accepted: async (loss) => {
          if (this.closed || !await this.change((ledger) => ledger.accept(ids(), attempt, loss))) {
            throw new BridgeError("ACCEPTANCE_UNCONFIRMED", "The operation's acceptance could not be recorded.");
          }
        },
      });
      if (result.outcome === "deferred") {
        const expiredMember = (await this.options.store.snapshot()).deliveries.some((d) => ids().includes(d.id) &&
          d.state.phase === "terminal" && d.state.outcome === "expired");
        const clean = await this.change((ledger) => ledger.defer(ids(), attempt, expiredMember ? 0 : 500));
        if (!clean) await this.change((ledger) => ledger.lose(ids(), attempt, result.code));
        const outcome = clean ? "deferred" : await this.committedOutcome(ids(), result.code);
        this.observed(identity, { outcome, code: result.code });
        return expiredMember;
      } else if (result.outcome === "expired" && result.unwritten) {
        await this.change((ledger) => ledger.unwritten(ids(), attempt));
        this.observed(identity, { outcome: await this.committedOutcome(ids(), result.code), code: result.code });
      } else if (result.outcome === "ambiguous" || result.outcome === "unconfirmed") {
        const outcome = await this.change((ledger) => {
          const live = ledger.state.deliveries.filter((d) => ids().includes(d.id) && d.state.phase !== "terminal" &&
            d.state.phase !== "queued" && d.state.attempt === attempt);
          if (live.length > 0 && live.every((d) => d.state.phase === "reserved")) {
            ledger.lose(ids(), attempt, result.code);
            return "deferred" as const;
          }
          const accepted = live.find((d) => d.state.phase === "accepted");
          const outcome = accepted?.state.phase === "accepted" ? accepted.state.loss : "ambiguous";
          ledger.settle(ids(), attempt, outcome, result.code);
          return outcome;
        });
        this.observed(identity, { outcome, code: result.code });
        if (outcome === "deferred") return false;
      } else {
        await this.change((ledger) => ledger.settle(ids(), attempt, result.outcome as Outcome, result.code));
        this.observed(identity, result);
      }
      return true;
    } catch (error) {
      // A generic error is never evidence of a clean post-write refusal. The recorded
      // phase decides uncertainty; reserved operations alone remain safe to retry.
      const code = error instanceof BridgeError ? error.code : "DISPATCH_OUTCOME_AMBIGUOUS";
      const outcome = await this.change((ledger) => {
        ledger.lose(ids(), attempt, code);
        const results = ledger.state.deliveries.filter((d) => ids().includes(d.id)).map((d) => d.state);
        return (["ambiguous", "unconfirmed", "failed", "cancelled", "expired", "delivered"] as const)
          .find((outcome) => results.some((s) => s.phase === "terminal" && s.outcome === outcome)) ?? "deferred";
      });
      this.observed(identity, { outcome, code });
      return false;
    }
  }

  private async committedOutcome(ids: readonly string[], code: string): Promise<WakeResult["outcome"]> {
    const rows = (await this.options.store.snapshot()).deliveries.filter((d) => ids.includes(d.id));
    return (["ambiguous", "unconfirmed", "failed", "cancelled", "expired", "delivered"] as const)
      .find((outcome) => rows.some((d) => d.state.phase === "terminal" && d.state.outcome === outcome)) ??
      (rows.some((d) => d.state.phase === "queued") ? "deferred" : (code === "ROUTE_BUSY" ? "deferred" : "failed"));
  }

  async close(settle = true): Promise<void> {
    this.closed = true;
    let failure: unknown;
    if (settle) try { await this.change((ledger) => ledger.restart()); } catch (error) { failure = error; }
    // Destination close preserves accepted-turn lifetime until its native transport
    // has actually closed; it does not issue an interrupt or invent completion.
    const closed = await Promise.allSettled([this.options.claude.close(), this.options.codex.close(), this.options.ssh.close()]);
    await Promise.allSettled(this.running.values());
    if (failure) throw failure;
    if (closed.some((result) => result.status === "rejected")) throw new BridgeError("GATEWAY_CLEANUP_FAILED", "A destination did not confirm cleanup.");
  }
}
