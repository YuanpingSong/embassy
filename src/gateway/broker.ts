import { randomBytes, randomUUID } from "node:crypto";
import { BridgeError } from "../errors.js";
import { Coordinator } from "./coordinator.js";
import { EndpointDirectory, type EndpointCaller } from "./endpoint-directory.js";
import { Ledger, type Delivery, type Endpoint, type EndpointRef, type LedgerLimits, type LedgerState } from "./ledger.js";
import type { OwnedStateFile } from "./owned-state.js";
import type { FederatedHandoff, Federation } from "./federation.js";

export type BrokerOptions = Readonly<{
  host: string; store: OwnedStateFile<LedgerState>; limits: LedgerLimits;
  directory: EndpointDirectory; coordinator: Coordinator;
  now?: () => number;
  nodes?: readonly string[];
  steeringEnabled?: boolean;
  federation?: Pick<Federation, "catalog" | "snapshot">;
}>;
const publicEndpoint = ({ id, alias, provider, host }: Endpoint) => ({ id, alias, provider, host });
const admissionRefusals = new Set(["INVALID_PEER_HANDOFF", "ROUTE_UNREGISTERED", "INVALID_MESSAGE_BODY",
  "MESSAGE_EXPIRED", "QUEUE_FULL", "RATE_LIMITED"]);
class PreEnqueueRefusal extends Error { constructor(readonly code: string) { super(code); } }

/** Application commands over the directory and the single delivery ledger. */
export class MessagingBroker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;
  private pumping: Promise<void> | undefined;
  private fault: string | undefined;
  private readonly now: () => number;

  constructor(readonly options: BrokerOptions) { this.now = options.now ?? Date.now; }

  private change<R>(operation: (ledger: Ledger) => R): Promise<R> {
    return this.options.store.transact((state) => operation(new Ledger(state, this.options.host, this.options.limits, this.now())));
  }

  async start(): Promise<void> {
    await this.change((ledger) => ledger.restart());
    this.started = true;
    this.kick();
  }

  async register(caller: EndpointCaller, alias: string, succeeds?: string) {
    if (caller.kind !== "codex") throw new BridgeError("ROUTE_BINDING_MISMATCH", "Codex registration requires its inherited task identity.");
    const endpoint = await this.options.directory.registerCodex(caller.handle, alias, succeeds);
    return publicEndpoint(endpoint);
  }

  async send(caller: EndpointCaller, address: { to: string } | { conversation: string }, body: string) {
    if (this.stopped) throw new BridgeError("GATEWAY_SHUTDOWN", "The gateway is stopping.");
    const source = await this.options.directory.caller(caller);
    const target = "to" in address ? await this.options.directory.named(address.to)
      : await this.options.directory.exact(new Ledger(await this.options.store.snapshot(), this.options.host,
        this.options.limits, this.now()).replyTarget(address.conversation, source));
    if (!target) throw new BridgeError("ROUTE_UNREGISTERED", "The exact destination is unavailable.");
    const deadline = this.now() + this.options.limits.deadlineMs;
    const admitted = await this.change((ledger) => ledger.admit({
      id: `msg_${randomUUID()}`, token: `dlv_${randomBytes(18).toString("base64url")}`,
      reply: `conv_${randomBytes(24).toString("base64url")}`, source, target, body,
      deadline,
      steer: this.options.steeringEnabled !== false && source.provider === "claude" && target.provider === "codex" && body.startsWith("STEER:"),
    }));
    this.kick();
    return { accepted: true as const, conversationId: admitted.delivery.reply, deliveryToken: admitted.delivery.token };
  }

  async retire(alias: string) {
    if (!alias.endsWith(`@${this.options.host}`)) throw new BridgeError("FEDERATED_ROUTE_READ_ONLY", "Retire a remote route on its owning host.");
    // Retirement acts on owned state, not discovery: an exited session must remain removable.
    const counts = await this.change((ledger) => {
      const endpoint = ledger.resolve(alias);
      if (!endpoint) throw new BridgeError("ROUTE_UNREGISTERED", "The local route is absent.");
      return ledger.retire(endpoint);
    });
    this.kick();
    return counts;
  }

  async handoff(peerHost: string, input: FederatedHandoff) {
    if (this.stopped) throw new BridgeError("GATEWAY_SHUTDOWN", "The gateway is stopping.");
    if (!this.options.nodes?.includes(peerHost) || input.target.host !== this.options.host ||
      input.messages.some((m) => m.source.host !== peerHost)) return { accepted: false as const, code: "INVALID_PEER_HANDOFF" };
    try {
      await this.change((ledger) => {
        try {
          for (const message of input.messages) ledger.admit({
            id: message.id, reply: message.reply, token: `dlv_${randomBytes(18).toString("base64url")}`,
            source: message.source, sourceAlias: message.source.alias, target: input.target,
            body: message.body, deadline: message.deadline, steer: message.steer && this.options.steeringEnabled !== false,
          });
        } catch (error) {
          // The sentinel is created ONLY inside the transition, before any persist.
          // A later I/O throw carrying the same text is not a proven refusal.
          if (error instanceof BridgeError && admissionRefusals.has(error.code)) throw new PreEnqueueRefusal(error.code);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof PreEnqueueRefusal) return { accepted: false as const, code: error.code };
      throw error;
    }
    this.kick();
    return { accepted: true as const };
  }

  async delivery(token: string) {
    await this.change((ledger) => ledger.expire());
    const d = (await this.options.store.snapshot()).deliveries.find((d) => d.token === token);
    if (!d) return { found: false as const };
    return { found: true as const, state: d.state.phase === "terminal" ? d.state.outcome : "queued",
      terminal: d.state.phase === "terminal", deadlineAt: new Date(d.deadline).toISOString(),
      ...(d.state.phase === "terminal" ? { safeErrorCode: d.state.code } : { pendingForMs: Math.max(0, this.now() - d.admittedAt) }) };
  }

  async refresh() {
    const [endpoints] = await Promise.all([
      this.options.directory.refresh(), this.options.federation?.catalog(),
    ]);
    this.kick();
    return { routes: endpoints.map(publicEndpoint) };
  }

  async status() {
    await this.change((ledger) => ledger.expire());
    const state = await this.options.store.snapshot();
    const alias = (ref: EndpointRef) => state.endpoints.find((e) => e.id === ref.id && e.host === ref.host)?.alias;
    return {
      health: this.fault ? "degraded" : "healthy", ...(this.fault ? { safeErrorCode: this.fault } : {}),
      revision: state.commit.sequence,
      ...(this.options.federation ? { federation: this.options.federation.snapshot() } : {}),
      routes: state.endpoints.map((e) => ({ ...publicEndpoint(e),
        ...(this.options.coordinator.observation(e) === undefined ? {} : { lastOperation: this.options.coordinator.observation(e) }),
        queueDepth: state.deliveries.filter((d) => d.target.id === e.id && d.target.host === e.host && d.state.phase !== "terminal").length })),
      messages: state.deliveries.map((d) => ({ source: alias(d.source) ?? d.sourceAlias, target: alias(d.target),
        state: d.state.phase === "terminal" ? d.state.outcome : d.state.phase,
        ageMs: Math.max(0, this.now() - d.admittedAt),
        ...(d.state.phase === "terminal" ? { safeErrorCode: d.state.code } : {}) })),
      retirements: state.retirements.map(({ alias, at }) => ({ alias, at: new Date(at).toISOString() })),
    };
  }

  private kick(): void {
    if (this.stopped || this.pumping) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.pumping = this.pump().catch((error: unknown) => {
      this.fault = error instanceof BridgeError ? error.code : "DISPATCH_OUTCOME_AMBIGUOUS";
    }).finally(() => { this.pumping = undefined; });
  }

  private async pump(): Promise<void> {
    const state = await this.options.store.snapshot();
    const targets = new Map<string, Delivery>();
    for (const d of state.deliveries) {
      if (d.state.phase === "queued") targets.set(JSON.stringify([d.target, d.steer]), d);
    }
    for (const d of targets.values()) {
      // Do not await an agent's turn: another target or a STEER must remain dispatchable.
      void this.options.coordinator.wake(d.target, d.steer).catch((error: unknown) => {
        this.fault = error instanceof BridgeError ? error.code : "DISPATCH_OUTCOME_AMBIGUOUS";
      });
    }
    if (!this.stopped && state.deliveries.some((d) => d.state.phase !== "terminal")) {
      this.timer = setTimeout(() => { this.timer = undefined; this.kick(); }, 500);
      this.timer.unref();
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pumping;
    await this.options.coordinator.close(this.started);
  }
}
