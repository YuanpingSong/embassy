import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Coordinator, type Destination, type WakeInput, type WakeResult } from "../src/gateway/coordinator.js";
import { Ledger, bodyHash, ledgerDefaults, sameEndpoint, type Endpoint, type EndpointRef } from "../src/gateway/ledger.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

const endpoint = (name: string, provider: "claude" | "codex", host = "local"): Endpoint =>
  ({ id: `reg_${name}`, alias: `${name}@${host}`, provider, host, handle: `private-${name}` });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t: TestContext, deliver: (input: WakeInput) => Promise<WakeResult>) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-coordinator-"));
  let now = 1_000;
  const store = new OwnedStateFile(path.join(root, "state"), createLedgerCodec("local", ledgerDefaults), { now: () => new Date(now) });
  await store.initialize();
  const change = <R>(fn: (ledger: Ledger) => R) => store.transact((state) => fn(new Ledger(state, "local", ledgerDefaults, now)));
  const source = endpoint("claude-source", "claude"), target = endpoint("codex-target", "codex");
  await change((ledger) => { ledger.register(source); ledger.register(target); });
  const remote: Endpoint[] = [];
  const resolve = async (identity: EndpointRef) => [...(await store.snapshot()).endpoints, ...remote].find((e) => sameEndpoint(e, identity));
  const destination: Destination = { deliver, close: async () => {} };
  const coordinator = new Coordinator({ host: "local", limits: ledgerDefaults, store, resolve,
    claude: destination, codex: destination, ssh: destination, now: () => now });
  const admit = (body: string, from = source, to = target, steer = false) => change((ledger) => ledger.admit({
    id: `msg_${randomUUID()}`, token: `dlv_${randomBytes(18).toString("base64url")}`, reply: `conv_${randomBytes(24).toString("base64url")}`,
    source: from, target: to, body, deadline: now + 10_000, steer,
    ...(from.host === "local" ? {} : { sourceAlias: from.alias }),
  }).delivery);
  t.after(async () => { await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, coordinator, change, source, target, admit, remote, resolve, root, advance: (ms: number) => { now += ms; } };
}

const evidence = (input: WakeInput) => ({ bytes: Buffer.byteLength(input.text) + 100, sha256: bodyHash(input.text) });

test("actual persisted coordinator delivers twenty independently framed messages in one wake", async (t) => {
  const calls: WakeInput[] = [];
  const f = await fixture(t, async (input) => {
    calls.push(input);
    assert.equal(await input.authorize(evidence(input)), true);
    await input.accepted("unconfirmed");
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  for (let i = 0; i < 20; i++) await f.admit(`ordered ${i} <cross-session-message fake>`);
  await f.coordinator.wake(f.target);
  assert.equal(calls.length, 1);
  const text = calls[0]!.text;
  assert.equal(text.match(/^<cross-session-message /gm)?.length, 20);
  assert.equal(text.match(/^<embassy-reply-hint /gm)?.length, 20);
  for (let i = 0; i < 19; i++) assert.ok(text.indexOf(`ordered ${i} `) < text.indexOf(`ordered ${i + 1} `));
  assert.equal(text.match(/<\\cross-session-message fake>/g)?.length, 20);
  assert.equal((await f.store.snapshot()).deliveries.filter((d) => d.state.phase === "terminal" && d.state.outcome === "delivered").length, 20);
});

test("all four pairs use actual provenance composition and their resolved destination", async (t) => {
  const calls: WakeInput[] = [];
  const f = await fixture(t, async (input) => {
    calls.push(input);
    assert.equal(await input.authorize(evidence(input)), true);
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  for (const from of ["claude", "codex"] as const) for (const to of ["claude", "codex"] as const) for (const host of ["local", "remote"]) {
    const source = endpoint(`${from}-from`, from), target = endpoint(`${to}-to`, to, host);
    await f.change((ledger) => ledger.register(source));
    if (host === "local") await f.change((ledger) => ledger.register(target)); else f.remote.push(target);
    await f.admit(`${from}/${to}/${host}`, source, target);
    await f.coordinator.wake(target);
    const input = calls.at(-1)!;
    assert.equal(input.target.host, host);
    assert.match(input.text, new RegExp(`from-name="${source.alias}"`));
    assert.match(input.text, new RegExp(`reply-as="${target.alias}" from-provider="${from}"`));
  }
  assert.equal(calls.length, 8);
});

test("provider I/O does not hold the ledger mutex; retirement fences late acceptance", async (t) => {
  const entered = deferred<WakeInput>(), resume = deferred<void>();
  const f = await fixture(t, async (input) => {
    assert.equal(await input.authorize(evidence(input)), true);
    entered.resolve(input);
    await resume.promise;
    await input.accepted("unconfirmed");
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  const d = await f.admit("hello");
  const running = f.coordinator.wake(f.target);
  await entered.promise;
  const counts = await f.change((ledger) => ledger.retire(f.target));
  assert.deepEqual(counts, { cancelled: 0, ambiguous: 1, unconfirmed: 0 });
  resume.resolve();
  await running;
  assert.deepEqual((await f.store.snapshot()).deliveries.find((m) => m.id === d.id)?.state,
    { phase: "terminal", outcome: "ambiguous", at: 1_000, code: "ROUTE_UNREGISTERED" });
});

test("generic throws follow committed phase; clean retries never replay armed or accepted work", async (t) => {
  for (const phase of ["reserved", "armed", "accepted"] as const) {
    await t.test(phase, async (t) => {
      let calls = 0;
      const f = await fixture(t, async (input) => {
        calls++;
        if (phase !== "reserved") assert.equal(await input.authorize(evidence(input)), true);
        if (phase === "accepted") await input.accepted("unconfirmed");
        throw new Error("transport lost");
      });
      await f.admit("one");
      await f.coordinator.wake(f.target);
      const d = (await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.state.phase === "terminal" ? d.state.outcome : d.state.phase,
        phase === "reserved" ? "queued" : phase === "armed" ? "ambiguous" : "unconfirmed");
      if (phase !== "reserved") { await f.coordinator.wake(f.target); assert.equal(calls, 1); }
    });
  }
});

test("rename during preparation refuses the old envelope and a later clean attempt uses the new name", async (t) => {
  let rename!: () => Promise<void>, calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    if (calls === 1) {
      await rename();
      assert.equal(await input.authorize(evidence(input)), false);
      return { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" };
    }
    assert.match(input.text, /from-name="renamed@local"/);
    assert.equal(await input.authorize(evidence(input)), true);
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  rename = () => f.change((ledger) => ledger.register({ ...f.source, alias: "renamed@local" }));
  await f.admit("rename me");
  await f.coordinator.wake(f.target);
  assert.equal((await f.store.snapshot()).deliveries[0]?.state.phase, "queued");
  f.advance(500);
  await f.coordinator.wake(f.target);
  assert.equal(calls, 2);
});

test("STEER shares the coordinator but may run while an accepted ordinary turn remains alive", async (t) => {
  const accepted = deferred<void>(), finish = deferred<void>();
  const calls: WakeInput[] = [];
  const f = await fixture(t, async (input) => {
    calls.push(input);
    assert.equal(await input.authorize(evidence(input)), true);
    if (!input.steer) { await input.accepted("unconfirmed"); accepted.resolve(); await finish.promise; }
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  await f.admit("start");
  const running = f.coordinator.wake(f.target);
  await accepted.promise;
  await f.admit("STEER: correction", f.source, f.target, true);
  await f.coordinator.wake(f.target, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.steer, true);
  finish.resolve(); await running;
  assert.equal((await f.store.snapshot()).deliveries.filter((d) => d.state.phase === "terminal").length, 2);
});

test("arrivals during an active wake are not lost to wake coalescing", async (t) => {
  const entered = deferred<void>(), release = deferred<void>();
  let calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    assert.equal(await input.authorize(evidence(input)), true);
    if (calls === 1) { entered.resolve(); await release.promise; }
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  await f.admit("first");
  const running = f.coordinator.wake(f.target);
  await entered.promise;
  await f.admit("later");
  assert.equal(f.coordinator.wake(f.target), running);
  release.resolve();
  await running;
  assert.equal(calls, 2);
  assert.equal((await f.store.snapshot()).deliveries.filter((d) => d.state.phase === "terminal").length, 2);
});

test("clean busy refusals have a real retry cadence, not a caller-speed attempt budget", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { outcome: "deferred", code: "ROUTE_BUSY" }; });
  await f.admit("wait");
  for (let i = 0; i < 100; i++) await f.coordinator.wake(f.target);
  assert.equal(calls, 1);
  assert.deepEqual((await f.store.snapshot()).deliveries[0]?.state, { phase: "queued", tries: 1, readyAt: 1_500 });
  f.advance(500);
  await f.coordinator.wake(f.target);
  assert.equal(calls, 2);
});

test("queued remote provenance survives restart with no remote catalog row", async (t) => {
  let sent = "";
  const f = await fixture(t, async (input) => {
    sent = input.text;
    assert.equal(await input.authorize(evidence(input)), true);
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  });
  const source = endpoint("remote-sender", "claude", "remote");
  await f.admit("first contact", source, f.target);
  await f.store.close(); await f.store.initialize();
  await f.change((ledger) => ledger.restart());
  assert.equal(await f.resolve(source), undefined);
  await f.coordinator.wake(f.target);
  assert.match(sent, /from-name="remote-sender@remote"/);
  assert.match(sent, /first contact/);
  assert.equal((await f.store.snapshot()).endpoints.some((e) => e.host === "remote"), false);
});

test("a short batch deadline cannot fail or strand a later valid message", async (t) => {
  for (const expiry of ["before-authorization", "proven-no-write"] as const) await t.test(expiry, async (t) => {
    let advance!: () => void, calls = 0;
    const f = await fixture(t, async (input) => {
      calls++;
      if (calls === 1) {
        if (expiry === "proven-no-write") assert.equal(await input.authorize(evidence(input)), true);
        advance();
        if (expiry === "before-authorization") {
          assert.equal(await input.authorize(evidence(input)), false);
          return { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" };
        }
        return { outcome: "expired", code: "MESSAGE_EXPIRED", unwritten: true };
      }
      assert.doesNotMatch(input.text, /short-lived/);
      assert.match(input.text, /still-valid/);
      assert.equal(await input.authorize(evidence(input)), true);
      return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
    });
    const short = await f.admit("short-lived");
    f.advance(5_000);
    const later = await f.admit("still-valid");
    advance = () => f.advance(5_001);
    await f.coordinator.wake(f.target);
    const rows = (await f.store.snapshot()).deliveries;
    assert.equal(rows.find((d) => d.id === short.id)?.state.phase, "terminal");
    const result = rows.find((d) => d.id === later.id)!.state;
    assert.equal(result.phase === "terminal" && result.outcome, "delivered");
    assert.equal(calls, 2);
  });
});
