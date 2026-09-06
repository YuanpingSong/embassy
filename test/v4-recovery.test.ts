import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { MessagingBroker } from "../src/gateway/broker.js";
import { Coordinator, type Destination } from "../src/gateway/coordinator.js";
import { EndpointDirectory } from "../src/gateway/endpoint-directory.js";
import { Ledger, bodyHash, ledgerDefaults, sameEndpoint, type Delivery, type Endpoint } from "../src/gateway/ledger.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";
import { runCoreRuntime } from "../src/gateway/runtime.js";

type Phase = "queued" | "reserved" | "armed" | "accepted";
const source: Endpoint = { id: "reg_source", host: "local", provider: "claude", alias: "source@local", handle: "private-source" };
const target: Endpoint = { id: "reg_target", host: "local", provider: "codex", alias: "codex-target@local",
  handle: "00000000-0000-4000-8000-000000000001" };
const nextHandle = "00000000-0000-4000-8000-000000000002";

async function fixture(t: TestContext, phase: Phase) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-recovery-"));
  const store = new OwnedStateFile(path.join(root, "state"), createLedgerCodec("local", ledgerDefaults),
    { now: () => new Date(1_000) });
  await store.initialize();
  let seeded!: Delivery;
  await store.transact((state) => {
    const ledger = new Ledger(state, "local", ledgerDefaults, 1_000);
    ledger.register(source); ledger.register(target);
    seeded = ledger.admit({ id: `msg_${randomUUID()}`, reply: `conv_${randomBytes(24).toString("base64url")}`,
      token: `dlv_${randomBytes(18).toString("base64url")}`, source, target, body: "recover me",
      deadline: 11_000, steer: false }).delivery;
    if (phase !== "queued") ledger.reserve(target, "attempt_seed");
    if (phase === "armed" || phase === "accepted") ledger.authorize([seeded.id], "attempt_seed",
      { bytes: 100, sha256: bodyHash(seeded.body), bodies: [bodyHash(seeded.body)] });
    if (phase === "accepted") ledger.accept([seeded.id], "attempt_seed", "unconfirmed");
  });
  let now = 1_000, writes = 0;
  const destination: Destination = { close: async () => {}, deliver: async (input) => {
    writes++;
    assert.equal(await input.authorize({ bytes: Buffer.byteLength(input.text) + 100, sha256: bodyHash(input.text) }), true);
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  } };
  const claude = { discover: async () => ({ peers: [], rejected: {}, truncated: false, entriesScanned: 0, parseableRecords: 0 }),
    resolveReplyAddress: async () => { throw new Error("unused"); }, assertTargetWorkspaceDisjoint: async () => {} };
  const directory = new EndpointDirectory({ host: "local", limits: ledgerDefaults, store, claude });
  const coordinator = new Coordinator({ host: "local", limits: ledgerDefaults, store, now: () => now,
    resolve: async (ref) => (await store.snapshot()).endpoints.find((row) => sameEndpoint(row, ref)),
    claude: destination, codex: destination, ssh: destination });
  const broker = new MessagingBroker({ host: "local", limits: ledgerDefaults, store, directory, coordinator, now: () => now });
  t.after(async () => { await broker.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, broker, coordinator, seeded, setNow: (value: number) => { now = value; }, writes: () => writes };
}

test("broker restart resumes only queued and reserved work and terminalizes uncertain writes", async (t) => {
  for (const phase of ["queued", "reserved", "armed", "accepted"] as const) await t.test(phase, async (t) => {
    const f = await fixture(t, phase);
    await f.store.close(); await f.store.initialize();
    await f.broker.start(); f.setNow(1_500);
    await f.coordinator.wake(target);
    const row = (await f.store.snapshot()).deliveries.find((delivery) => delivery.id === f.seeded.id)!;
    const result = row.state.phase === "terminal" ? row.state.outcome : row.state.phase;
    assert.equal(result, phase === "armed" ? "ambiguous" : phase === "accepted" ? "unconfirmed" : "delivered");
    assert.equal(f.writes(), phase === "queued" || phase === "reserved" ? 1 : 0);
  });
});

test("retirement and Codex succession settle every durable phase exactly", async (t) => {
  for (const action of ["retire", "succeed"] as const) for (const phase of ["queued", "reserved", "armed", "accepted"] as const) {
    await t.test(`${action}/${phase}`, async (t) => {
      const f = await fixture(t, phase);
      const expected = phase === "armed" ? "ambiguous" : phase === "accepted" ? "unconfirmed" : "cancelled";
      if (action === "retire") {
        const counts = await f.broker.retire(target.alias);
        assert.deepEqual(counts, { cancelled: expected === "cancelled" ? 1 : 0,
          ambiguous: expected === "ambiguous" ? 1 : 0, unconfirmed: expected === "unconfirmed" ? 1 : 0 });
      } else {
        await f.broker.register({ kind: "codex", handle: nextHandle }, "codex-next@local", target.alias);
      }
      const state = await f.store.snapshot(), row = state.deliveries.find((delivery) => delivery.id === f.seeded.id)!;
      assert.equal(row.state.phase === "terminal" && row.state.outcome, expected);
      assert.equal(state.endpoints.some((endpoint) => sameEndpoint(endpoint, target)), false);
      assert.equal(f.writes(), 0);
    });
  }
});

test("unsupported and corrupt state refuse byte-identically before provider setup", async (t) => {
  for (const [name, body, code] of [["old", '{"schemaVersion":5}\n', "GATEWAY_STATE_SCHEMA_UNSUPPORTED"],
    ["corrupt", "not-json\n", "CORRUPT_GATEWAY_STATE"]] as const) await t.test(name, async (t) => {
    const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-refusal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateDir = path.join(root, "state"); await mkdir(stateDir, { mode: 0o700 });
    await writeFile(path.join(stateDir, ".agent-embassy-state"), "agent-embassy-state-v1\n", { mode: 0o600 });
    const stateFile = path.join(stateDir, "gateway-state.json"); await writeFile(stateFile, body, { mode: 0o600 });
    await chmod(stateFile, 0o600);
    const before = await readdir(stateDir);
    let providerCalls = 0, leaseCloses = 0;
    await assert.rejects(runCoreRuntime({ env: { EMBASSY_STATE_DIR: stateDir }, onReady: () => assert.fail("not ready") }, {
      loginHome: () => root,
      loadInventory: async () => ({ version: 1, host: "local", nodes: [] }),
      acquireLease: async () => ({ lost: new Promise(() => {}), isLost: () => false,
        close: async () => { leaseCloses++; } }),
      attestClaudeRuntime: async () => { providerCalls++; throw new Error("provider setup reached"); },
      addSignalListener: () => {}, removeSignalListener: () => {},
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === code);
    assert.deepEqual(await readdir(stateDir), before);
    assert.equal(await readFile(path.join(stateDir, ".agent-embassy-state"), "utf8"), "agent-embassy-state-v1\n");
    assert.equal(await readFile(stateFile, "utf8"), body);
    assert.equal(providerCalls, 0); assert.equal(leaseCloses, 1);
  });
});
