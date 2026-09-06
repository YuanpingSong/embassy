import { randomBytes, randomUUID } from "node:crypto";
import { type Coordinator, type Destination, type WakeInput, type WakeResult } from "./coordinator.js";
import { Ledger, bodyHash, sameEndpoint, type Endpoint, type EndpointRef, type LedgerLimits, type LedgerState } from "./ledger.js";
import type { OwnedStateFile } from "./owned-state.js";

export type BrokerCheckOptions = Readonly<{
  host: string; limits: LedgerLimits; store: OwnedStateFile<LedgerState>; coordinator: Coordinator;
}>;
export type BrokerCheckResult = Readonly<{ status: "ok"; scope: "broker-loopback" }>;

type ExpectedWake = Readonly<{ source: EndpointRef; target: EndpointRef }>;
const LOOPBACK = /^loopback:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ref = ({ id, host, provider }: Endpoint): EndpointRef => ({ id, host, provider });
const ids = () => ({ id: `msg_${randomUUID()}`, token: `dlv_${randomBytes(18).toString("base64url")}`,
  reply: `conv_${randomBytes(24).toString("base64url")}` });

function isLoopback(endpoint: Endpoint, host: string): boolean {
  const match = endpoint.host === host && endpoint.provider === "codex" ? LOOPBACK.exec(endpoint.handle) : null;
  return match !== null && endpoint.id === `reg_loopback_${match[1]}`;
}

/** Adds a broker-only destination around the real Codex adapter. It intercepts only
 * identities minted for the duration of check(); every production write delegates. */
export class LoopbackDestination implements Destination {
  private readonly expected = new Map<string, ExpectedWake>();
  private checking: Promise<BrokerCheckResult> | undefined;

  constructor(private readonly innerCodex: Destination) {}

  async deliver(input: WakeInput): Promise<WakeResult> {
    const expected = this.expected.get(input.target.id);
    if (!expected) return this.innerCodex.deliver(input);
    if (!sameEndpoint(input.target, expected.target) || input.messages.length !== 1 ||
      !sameEndpoint(input.messages[0]!.source, expected.source)) throw new Error("INVALID_LOOPBACK_WAKE");
    if (!await input.authorize({ bytes: Buffer.byteLength(input.text), sha256: bodyHash(input.text) })) {
      return { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" };
    }
    await input.accepted("unconfirmed");
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  }

  async cleanup({ host, limits, store }: Omit<BrokerCheckOptions, "coordinator">): Promise<void> {
    await store.transact((state, now) => {
      const ledger = new Ledger(state, host, limits, now.getTime());
      for (const endpoint of [...state.endpoints]) if (isLoopback(endpoint, host)) ledger.retire(endpoint);
    });
  }

  check(options: BrokerCheckOptions): Promise<BrokerCheckResult> {
    return this.checking ??= this.runCheck(options).finally(() => { this.checking = undefined; });
  }

  private async runCheck({ host, limits, store, coordinator }: BrokerCheckOptions): Promise<BrokerCheckResult> {
    await this.cleanup({ host, limits, store });
    const nonceA = randomUUID(), nonceB = randomUUID();
    const source: Endpoint = { id: `reg_loopback_${nonceA}`, handle: `loopback:${nonceA}`,
      host, provider: "codex", alias: `loopback-a-${nonceA.slice(0, 8)}@${host}` };
    const target: Endpoint = { id: `reg_loopback_${nonceB}`, handle: `loopback:${nonceB}`,
      host, provider: "codex", alias: `loopback-b-${nonceB.slice(0, 8)}@${host}` };
    const change = <R>(operation: (ledger: Ledger) => R) => store.transact((state, now) =>
      operation(new Ledger(state, host, limits, now.getTime())));
    try {
      await change((ledger) => { ledger.register(source); ledger.register(target); });
      this.expected.set(target.id, { source: ref(source), target: ref(target) });
      const challenge = await change((ledger) => ledger.admit({ ...ids(), source: ref(source), target: ref(target),
        body: "Embassy broker loopback challenge.", deadline: ledger.now + limits.deadlineMs, steer: false }).delivery);
      await coordinator.wake(target);
      const delivered = (await store.snapshot()).deliveries.find((row) => row.id === challenge.id);
      if (delivered?.state.phase !== "terminal" || delivered.state.outcome !== "delivered") throw new Error("LOOPBACK_NOT_DELIVERED");

      this.expected.delete(target.id);
      this.expected.set(source.id, { source: ref(target), target: ref(source) });
      const response = await change((ledger) => {
        const replyTarget = ledger.replyTarget(challenge.reply, target);
        if (!sameEndpoint(replyTarget, source)) throw new Error("INVALID_LOOPBACK_REPLY_TARGET");
        return ledger.admit({ ...ids(), source: ref(target), target: replyTarget,
          body: "Embassy broker loopback reply.", deadline: ledger.now + limits.deadlineMs, steer: false }).delivery;
      });
      await coordinator.wake(source);
      const replied = (await store.snapshot()).deliveries.find((row) => row.id === response.id);
      if (replied?.state.phase !== "terminal" || replied.state.outcome !== "delivered") throw new Error("LOOPBACK_REPLY_NOT_DELIVERED");
      return { status: "ok", scope: "broker-loopback" };
    } finally {
      this.expected.delete(source.id); this.expected.delete(target.id);
      await change((ledger) => {
        if (ledger.endpoint(source)) ledger.retire(source);
        if (ledger.endpoint(target)) ledger.retire(target);
      });
    }
  }

  close(): Promise<void> { return this.innerCodex.close(); }
}
