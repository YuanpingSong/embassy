import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeError } from "../../src/errors.js";
import { Ledger, bodyHash, ledgerDefaults, sameEndpoint, type Delivery, type Endpoint } from "../../src/gateway/ledger.js";
import { createLedgerCodec } from "../../src/gateway/ledger-codec.js";
import { OwnedStateFile } from "../../src/gateway/owned-state.js";

const limits = { ...ledgerDefaults, endpoints: 64, queued: 300, perEndpoint: 100, inFlight: 32, rate: 1_000 };
const fixed = (n: number, width: number) => n.toString(36).padStart(width, "0").slice(-width);
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0").slice(-width);
const endpoint = (n: number): Endpoint => ({ id: `reg_${fixed(n, 8)}`, host: "local",
  provider: n % 2 ? "claude" : "codex", alias: `agent-${fixed(n, 4)}@local`, handle: `native-${fixed(n, 8)}` });
const phase = (delivery: Delivery) => delivery.state.phase;

test("seeded ledger transactions stay codec-valid across restart, loss and retirement", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-soak-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { mode: 0o700 });
  const codec = createLedgerCodec("local", limits);
  let now = 1_000, seed = 0x51a7e, nextEndpoint = 1, nextMessage = 1, nextAttempt = 1;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  const choose = <T>(rows: readonly T[]): T | undefined => rows.length ? rows[random() % rows.length] : undefined;
  const store = new OwnedStateFile(stateDir, codec, { now: () => new Date(now) });
  await store.initialize();
  for (let i = 0; i < 8; i++) await store.transact((state) => new Ledger(state, "local", limits, now).register(endpoint(nextEndpoint++)));

  for (let step = 0; step < 1_000; step++) {
    let action = "";
    try { await store.transact((state) => {
      const ledger = new Ledger(state, "local", limits, now), operation = random() % 9;
      action = String(operation);
      if (operation === 0 && state.endpoints.length < 48) ledger.register(endpoint(nextEndpoint++));
      else if (operation === 1 && state.endpoints.length > 1) {
        const source = choose(state.endpoints)!, target = choose(state.endpoints.filter((row) => !sameEndpoint(row, source)))!;
        const n = nextMessage++;
        try { ledger.admit({ id: `msg_00000000-0000-4000-8000-${hex(n, 12)}`,
          reply: `conv_${fixed(n, 16)}`, token: `dlv_${fixed(n, 24)}`, source, target,
          body: `seeded message ${n}`, deadline: now + limits.deadlineMs, steer: false }); } catch (error) {
          assert.ok(error instanceof BridgeError && ["QUEUE_FULL", "RATE_LIMITED"].includes(error.code));
        }
      } else if (operation === 2) {
        const target = choose(state.endpoints), attempt = `attempt_${fixed(nextAttempt++, 8)}`;
        if (target) ledger.reserve(target, attempt);
      } else if (operation === 3) {
        const row = choose(state.deliveries.filter((item) => phase(item) === "reserved"));
        if (row?.state.phase === "reserved") {
          const attempt = row.state.attempt;
          const batch = state.deliveries.filter((item) => item.state.phase === "reserved" && item.state.attempt === attempt);
          ledger.authorize(batch.map((item) => item.id), attempt,
            { bytes: 100, sha256: bodyHash(batch.map((item) => item.body).join("\n")), bodies: batch.map((item) => bodyHash(item.body)) });
        }
      } else if (operation === 4) {
        const row = choose(state.deliveries.filter((item) => phase(item) === "armed"));
        if (row?.state.phase === "armed") {
          const attempt = row.state.attempt;
          ledger.accept(state.deliveries.filter((item) => item.state.phase === "armed" &&
            item.state.attempt === attempt).map((item) => item.id), attempt, "unconfirmed");
        }
      } else if (operation === 5) {
        const row = choose(state.deliveries.filter((item) => !["queued", "terminal"].includes(phase(item))));
        if (row && row.state.phase !== "queued" && row.state.phase !== "terminal") {
          const attempt = row.state.attempt;
          const ids = state.deliveries.filter((item) => item.state.phase !== "queued" && item.state.phase !== "terminal" &&
            item.state.attempt === attempt).map((item) => item.id);
          ledger.settle(ids, attempt, row.state.phase === "reserved" ? "failed" : "delivered", "SOAK_SETTLED");
        }
      } else if (operation === 6) ledger.restart();
      else if (operation === 7 && state.endpoints.length > 2) ledger.retire(choose(state.endpoints)!);
      else { now += random() % 750; ledger.expire(); }
    }); } catch (error) { throw new Error(`seeded transition ${step}/${action} failed: ${String(error)}`, { cause: error }); }
    const state = await store.snapshot();
    assert.ok(codec.decode(state));
    assert.equal(new Set(state.deliveries.map((row) => row.id)).size, state.deliveries.length);
    assert.ok(state.deliveries.filter((row) => row.state.phase !== "terminal").every((row) =>
      row.source.host !== "local" || state.endpoints.some((item) => sameEndpoint(item, row.source))));
    if (step % 100 === 99) { await store.close(); await store.initialize(); }
  }
  await store.transact((state) => new Ledger(state, "local", limits, now).restart());
  const final = await store.snapshot();
  assert.ok(final.deliveries.every((row) => !["reserved", "armed", "accepted"].includes(row.state.phase)));
  await store.close();
});
