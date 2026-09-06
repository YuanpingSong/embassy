import { randomUUID } from "node:crypto";
import { BridgeError } from "../errors.js";
import { Ledger, bodyHash, sameEndpoint, type Endpoint, type EndpointRef, type LedgerLimits, type LedgerState, type Outcome } from "./ledger.js";
import { OwnedStateFile } from "./owned-state.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";

export type WakeResult = Readonly<{
  outcome: Outcome | "deferred";
  code: string;
}>;
export type WakeInput = Readonly<{
  attempt: string; target: Endpoint; text: string; deadline: number; steer: boolean;
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
}>;

/** Owns scheduling and write phases, but never holds the state mutex during provider I/O. */
export class Coordinator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  private change<R>(operation: (ledger: Ledger) => R): Promise<R> {
    return this.options.store.transact((state) => operation(new Ledger(state, this.options.host, this.options.limits, this.now())));
  }

  wake(target: EndpointRef, steer = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const key = JSON.stringify([target.host, target.provider, target.id, steer]);
    const existing = this.running.get(key);
    if (existing) return existing;
    const operation = this.run(target, steer).finally(() => {
      if (this.running.get(key) === operation) this.running.delete(key);
    });
    this.running.set(key, operation);
    return operation;
  }

  private async run(identity: EndpointRef, steer: boolean): Promise<void> {
    const attempt = this.options.attemptId?.() ?? `attempt_${randomUUID()}`;
    let batch = await this.change((ledger) => ledger.reserve(identity, attempt, steer));
    if (!batch.length) return;
    const ids = () => batch.map((d) => d.id);
    try {
      const target = await this.options.resolve(identity);
      if (!target || !sameEndpoint(target, identity)) {
        await this.change((ledger) => ledger.settle(ids(), attempt, "failed", "ROUTE_UNREGISTERED"));
        return;
      }
      const frames: string[] = [];
      const sources: Endpoint[] = [];
      let bytes = 0;
      for (let index = 0; index < batch.length; index++) {
        const d = batch[index]!;
        const source = await this.options.resolve(d.source);
        if (!source || !sameEndpoint(source, d.source)) {
          await this.change((ledger) => ledger.settle([d.id], attempt, "failed", "ROUTE_UNREGISTERED"));
          continue;
        }
        const frame = composeProvenanceEnvelope({ sourceProvider: source.provider, recipientProvider: target.provider,
          sourceAlias: source.alias, targetAlias: target.alias, conversationId: d.reply, body: d.body });
        const framedBytes = Buffer.byteLength(frame) + (frames.length ? 1 : 0);
        if (bytes + framedBytes > this.options.limits.wakeBytes) {
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
      if (!batch.length) return;
      if (frames.length !== batch.length) throw new Error("INCOMPLETE_WAKE_PREPARATION");
      const destination = identity.host !== this.options.host ? this.options.ssh : identity.provider === "claude" ? this.options.claude : this.options.codex;
      const result = await destination.deliver({ attempt, target, text: frames.join("\n"),
        deadline: Math.min(...batch.map((d) => d.deadline)), steer,
        authorize: async (evidence) => {
          if (this.closed) return false;
          // Re-resolve after preparation: a rename requires new envelope bytes, and a
          // replacement must never inherit this operation's exact identity.
          const currentTarget = await this.options.resolve(identity);
          if (!currentTarget || !sameEndpoint(currentTarget, target) || currentTarget.alias !== target.alias || currentTarget.handle !== target.handle) return false;
          for (const source of sources) {
            const current = await this.options.resolve(source);
            if (!current || !sameEndpoint(current, source) || current.alias !== source.alias || current.handle !== source.handle) return false;
          }
          return this.change((ledger) => {
            if (this.closed) return false;
            return ledger.authorize(ids(), attempt, { ...evidence, bodies: batch.map((d) => bodyHash(d.body)) }, [target, ...sources]);
          });
        },
        accepted: async (loss) => {
          if (this.closed || !await this.change((ledger) => ledger.accept(ids(), attempt, loss))) {
            throw new BridgeError("ACCEPTANCE_UNCONFIRMED", "The operation's acceptance could not be recorded.");
          }
        },
      });
      if (result.outcome === "deferred") {
        const clean = await this.change((ledger) => ledger.defer(ids(), attempt));
        if (!clean) await this.change((ledger) => ledger.lose(ids(), attempt, result.code));
      } else await this.change((ledger) => ledger.settle(ids(), attempt, result.outcome as Outcome, result.code));
    } catch (error) {
      // A generic error is never evidence of a clean post-write refusal. The recorded
      // phase decides uncertainty; reserved operations alone remain safe to retry.
      await this.change((ledger) => ledger.lose(ids(), attempt,
        error instanceof BridgeError ? error.code : "DISPATCH_OUTCOME_AMBIGUOUS"));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.change((ledger) => ledger.restart());
    // Destination close preserves accepted-turn lifetime until its native transport
    // has actually closed; it does not issue an interrupt or invent completion.
    await Promise.allSettled([this.options.claude.close(), this.options.codex.close(), this.options.ssh.close()]);
    await Promise.allSettled(this.running.values());
  }
}
