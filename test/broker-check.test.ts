import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LoopbackDestination } from "../src/gateway/broker-check.js";
import { Coordinator, type Destination } from "../src/gateway/coordinator.js";
import { Ledger, ledgerDefaults, sameEndpoint, type Endpoint } from "../src/gateway/ledger.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-check-"));
  const stateDir = path.join(root, "state");
  const persistedPhases: string[][] = [];
  const store = new OwnedStateFile(stateDir, createLedgerCodec("local", ledgerDefaults), {
    afterStateFileRename: async () => {
      const state = JSON.parse(await readFile(path.join(stateDir, "gateway-state.json"), "utf8")) as { deliveries: { state: { phase: string } }[] };
      persistedPhases.push(state.deliveries.map((row) => row.state.phase));
    },
  });
  await store.initialize();
  let nativeCalls = 0;
  const inner: Destination = { deliver: async () => { nativeCalls++; throw new Error("native adapter called"); }, close: async () => {} };
  const loopback = new LoopbackDestination(inner);
  const resolve = async (identity: Parameters<typeof sameEndpoint>[0]) =>
    (await store.snapshot()).endpoints.find((endpoint) => sameEndpoint(endpoint, identity));
  const coordinator = new Coordinator({ host: "local", limits: ledgerDefaults, store, resolve,
    claude: inner, codex: loopback, ssh: inner, attemptId: () => `attempt_${randomUUID()}` });
  const change = <R>(operation: (ledger: Ledger) => R) => store.transact((state, now) =>
    operation(new Ledger(state, "local", ledgerDefaults, now.getTime())));
  t.after(async () => { await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, loopback, coordinator, change, persistedPhases, nativeCalls: () => nativeCalls };
}

test("broker self-test uses the actual ledger, coordinator, acceptance and reply path without native I/O", async (t) => {
  const f = await fixture(t);
  const unrelated: Endpoint = { id: "reg_user", host: "local", provider: "codex",
    alias: "codex-user@local", handle: "00000000-0000-4000-8000-000000000001" };
  const unrelatedDelivery = await f.change((ledger) => {
    ledger.register(unrelated);
    return ledger.admit({ id: `msg_${randomUUID()}`, token: `dlv_${randomBytes(18).toString("base64url")}`,
      reply: `conv_${randomBytes(24).toString("base64url")}`, source: unrelated, target: unrelated,
      body: "unrelated queued work", deadline: ledger.now + ledgerDefaults.deadlineMs, steer: false }).delivery;
  });
  assert.deepEqual(await f.loopback.check({ host: "local", limits: ledgerDefaults,
    store: f.store, coordinator: f.coordinator }), { status: "ok", scope: "broker-loopback" });
  const state = await f.store.snapshot();
  assert.equal(f.nativeCalls(), 0);
  assert.deepEqual(state.endpoints, [unrelated]);
  assert.equal(state.deliveries.length, 3);
  assert.deepEqual(state.deliveries.find((row) => row.id === unrelatedDelivery.id), unrelatedDelivery);
  const loopback = state.deliveries.filter((row) => row.id !== unrelatedDelivery.id);
  assert.deepEqual(loopback.map((row) => row.state.phase === "terminal" && row.state.outcome), ["delivered", "delivered"]);
  assert.equal(loopback[1]?.target.id, loopback[0]?.source.id);
  assert.ok(f.persistedPhases.filter((phases) => phases.includes("accepted")).length >= 2);
  assert.equal(state.retirements.filter((row) => row.endpoint.id.startsWith("reg_loopback_")).length, 2);
});

test("only exact internal loopback identities are cleaned and production destinations still delegate", async (t) => {
  const f = await fixture(t);
  const nonce = randomUUID();
  const stale: Endpoint = { id: `reg_loopback_${nonce}`, host: "local", provider: "codex",
    alias: "stale-check@local", handle: `loopback:${nonce}` };
  const lookalike: Endpoint = { id: "reg_lookalike", host: "local", provider: "codex",
    alias: "lookalike@local", handle: `loopback:${randomUUID()}` };
  await f.change((ledger) => { ledger.register(stale); ledger.register(lookalike); });
  await f.loopback.cleanup({ host: "local", limits: ledgerDefaults, store: f.store });
  const state = await f.store.snapshot();
  assert.equal(state.endpoints.some((row) => sameEndpoint(row, stale)), false);
  assert.equal(state.endpoints.some((row) => sameEndpoint(row, lookalike)), true);

  await assert.rejects(f.loopback.deliver({ attempt: "attempt_delegate", target: lookalike, text: "x", deadline: Date.now() + 1_000,
    steer: false, messages: [], authorize: async () => false, accepted: async () => {} }), /native adapter called/u);
  assert.equal(f.nativeCalls(), 1);
});
