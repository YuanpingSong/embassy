import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClaudePeerDiscovery } from "../src/gateway/claude-peer.js";
import type { CodexThread } from "../src/gateway/codex-discovery.js";
import { EndpointDirectory, type ClaudeDirectoryAdapter } from "../src/gateway/endpoint-directory.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { Ledger, bodyHash, ledgerDefaults, type LedgerLimits } from "../src/gateway/ledger.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

const HOST = "local";
const IDS = [
  "00000000-0000-7000-8000-000000000001",
  "00000000-0000-7000-8000-000000000002",
  "00000000-0000-7000-8000-000000000003",
] as const;
const thread = (id: string, name?: string, extra: Partial<CodexThread> = {}): CodexThread => ({
  id, ...(name === undefined ? {} : { name }), status: "idle", loaded: true, ...extra,
});

class FailingClaude implements ClaudeDirectoryAdapter {
  discoveries = 0;
  async discover(): Promise<ClaudePeerDiscovery> {
    this.discoveries += 1;
    throw new Error("Claude unavailable");
  }
  async resolveReplyAddress(): Promise<never> { throw new Error("unused"); }
  async assertTargetWorkspaceDisjoint(): Promise<void> {}
}

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, limits: LedgerLimits = ledgerDefaults) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-codex-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  const store = new OwnedStateFile(stateDir, createLedgerCodec(HOST, limits), {
    now: () => new Date(1_000),
    randomId: (() => { let value = 0; return () => `commit-${++value}`; })(),
  });
  await store.initialize();
  const claude = new FailingClaude();
  let registration = 0;
  const directory = new EndpointDirectory({ host: HOST, limits, store, claude,
    createRegistrationId: () => `reg_public${++registration}` });
  return { claude, directory, store };
}

test("native discovery preserves registered aliases while automatic aliases follow native names", async (t) => {
  const f = await fixture(t);
  const manual = await f.directory.registerCodex(IDS[0], "codex-manual@local");
  const result = await f.directory.reconcileCodex([
    thread(IDS[0], "stale"),
    thread(IDS[0].toUpperCase(), "Review Agent"),
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.endpoints, [manual]);
  assert.deepEqual((await f.store.snapshot()).endpoints, result.endpoints);
  await f.directory.reconcileCodex([thread(IDS[0], "Renamed")]);
  assert.deepEqual((await f.store.snapshot()).endpoints, [manual]);
  await f.directory.reconcileCodex([thread(IDS[0])]);
  assert.deepEqual(await f.directory.named(manual.alias), manual);
  const renamed = await f.directory.registerCodex(IDS[0], "codex-explicit@local", manual.alias);
  await f.directory.reconcileCodex([thread(IDS[0], "Native name"), thread(IDS[1], "Automatic")]);
  assert.deepEqual(await f.directory.named(renamed.alias), renamed);
  await f.directory.reconcileCodex([thread(IDS[1], "Renamed")]);
  assert.equal((await f.directory.named("codex-renamed@local"))?.handle, IDS[1]);
});

test("unnamed and native-ID-shaped names derive stable aliases only from the public endpoint ID", async (t) => {
  const f = await fixture(t);
  const first = await f.directory.reconcileCodex([thread(IDS[0])]);
  assert.equal(first.endpoints[0]?.alias, "codex-agent-public1@local");
  const untitled = await f.directory.reconcileCodex([thread(IDS[0], "Untitled task")]);
  assert.equal(untitled.endpoints[0]?.alias, first.endpoints[0]?.alias);
  const renamed = await f.directory.reconcileCodex([thread(IDS[0], `task ${IDS[0]}`)]);
  assert.equal(renamed.endpoints[0]?.id, first.endpoints[0]?.id);
  assert.equal(renamed.endpoints[0]?.alias, "codex-agent-public1@local");
  assert.doesNotMatch(renamed.endpoints[0]?.alias ?? "", /00000000|000000000001/u);
});

test("duplicate native names remain ambiguous even when Claude discovery is unavailable", async (t) => {
  const f = await fixture(t);
  await f.directory.reconcileCodex([thread(IDS[0], "same"), thread(IDS[1], "same")]);
  await assert.rejects(f.directory.named("codex-same@local"), { code: "PEER_ALIAS_COLLISION" });
  assert.equal(f.claude.discoveries, 0);
});

test("an unavailable observer does not fence a known manual Codex route", async (t) => {
  const f = await fixture(t);
  const manual = await f.directory.registerCodex(IDS[0], "codex-manual@local");
  assert.equal((await f.directory.reconcileCodex([])).truncated, false);
  assert.deepEqual(await f.directory.named(manual.alias), manual);
  assert.equal(f.claude.discoveries, 1);
});

test("incomplete and capacity-truncated scans fence names, preserve unseen rows, and keep exact identity usable", async (t) => {
  const f = await fixture(t, { ...ledgerDefaults, endpoints: 2 });
  const partial = await f.directory.reconcileCodex([
    thread(IDS[0], "one"), thread(IDS[1], "two"), thread(IDS[2], "three"),
  ]);
  assert.equal(partial.truncated, true);
  assert.equal(partial.endpoints.length, 2);
  await assert.rejects(f.directory.named("codex-one@local"), { code: "PEER_ALIAS_COLLISION" });
  assert.deepEqual(await f.directory.exact(partial.endpoints[0]!), partial.endpoints[0]);

  const complete = await f.directory.reconcileCodex([thread(IDS[0], "one")]);
  assert.equal(complete.truncated, false);
  assert.equal(complete.endpoints.length, 1, "a confirmed window releases unused automatic rows");
  assert.equal((await f.store.snapshot()).retirements.length, 0);
  assert.equal((await f.directory.named("codex-one@local"))?.id, partial.endpoints[0]?.id);

  const interrupted = await f.directory.reconcileCodex([thread(IDS[0], "one")], [], true);
  assert.equal(interrupted.truncated, true);
  await assert.rejects(f.directory.named("codex-one@local"), { code: "PEER_ALIAS_COLLISION" });
});

test("positive archive/delete evidence retires exact identity and suppresses rediscovery", async (t) => {
  const f = await fixture(t);
  const installed = (await f.directory.reconcileCodex([thread(IDS[0], "gone")])).endpoints[0]!;
  const removed = await f.directory.reconcileCodex([], [IDS[0]]);
  assert.deepEqual(removed.endpoints, []);
  const state = await f.store.snapshot();
  assert.equal(state.retirements[0]?.endpoint.id, installed.id);
  assert.equal(state.retirements[0]?.nativeKey.length, 64);
  assert.deepEqual(f.directory.codexMetadata(installed), {
    state: "unknown",
  });
  assert.deepEqual((await f.directory.reconcileCodex([thread(IDS[0], "gone")])).endpoints, []);
});

test("Codex root status is memory-only", async (t) => {
  const f = await fixture(t);
  const result = await f.directory.reconcileCodex([
    thread(IDS[0], "working", { status: "busy" }),
    thread(IDS[1], "approval", { status: "waiting" }),
  ]);
  const parent = result.endpoints.find((row) => row.handle === IDS[0])!;
  const child = result.endpoints.find((row) => row.handle === IDS[1])!;
  assert.deepEqual(f.directory.codexMetadata(parent), {
    state: "busy",
  });
  assert.deepEqual(f.directory.codexMetadata(child), {
    state: "waiting",
  });
  assert.doesNotMatch(JSON.stringify(await f.store.snapshot()), /waitingOnApproval|canAcceptDirectInput|parentThreadId/u);
});

test("window aging hides without retiring, preserves admitted identities, and fallback survives restart", async (t) => {
  const f = await fixture(t);
  const initial = await f.directory.reconcileCodex([thread(IDS[0], "old"), thread(IDS[1], "kept")]);
  const old = initial.endpoints[0]!, kept = initial.endpoints[1]!;
  await f.store.transact((state) => new Ledger(state, HOST, ledgerDefaults, 1_000).admit({
    id: "msg_00000000-0000-4000-8000-000000000011", token: "dlv_abcdefghijklmnopqrstuvwx",
    reply: "conv_abcdefghijklmnop", source: old, target: kept, body: "queued before aging",
    deadline: 10_000, steer: false,
  }));
  const deliveries = (await f.store.snapshot()).deliveries;
  const registered = await f.directory.registerCodex(IDS[1], kept.alias);
  assert.equal(registered.id, kept.id); assert.equal(registered.retained, true);
  await f.directory.reconcileCodex([thread(IDS[2], "new")]);
  const state = await f.store.snapshot();
  assert.equal(state.retirements.length, 0);
  assert.deepEqual(state.deliveries, deliveries);
  assert.equal((await f.directory.exact(old))!.id, old.id);
  assert.deepEqual(f.directory.listed(state.endpoints).map((e) => e.alias), ["codex-new@local", "codex-kept@local"]);
  const restarted = new EndpointDirectory({ ...f.directory.options, automaticCodex: true });
  assert.deepEqual(restarted.listed((await f.store.snapshot()).endpoints).map((e) => e.id), [kept.id]);
  await restarted.reconcileCodex([thread(IDS[0], "returned")]);
  assert.equal(restarted.listed((await f.store.snapshot()).endpoints)[0]!.id, old.id);
  assert.equal((await f.store.snapshot()).retirements.length, 0);
});

test("rolling past 128 roots releases unused rows but keeps retained and pending identities", async (t) => {
  const f = await fixture(t);
  const initial = await f.directory.reconcileCodex([thread(IDS[0], "retained"), thread(IDS[1], "pending")]);
  const retained = initial.endpoints[0]!, pending = initial.endpoints[1]!;
  await f.directory.registerCodex(retained.handle, retained.alias);
  await f.store.transact((state) => new Ledger(state, HOST, ledgerDefaults, 1_000).admit({
    id: "msg_00000000-0000-4000-8000-000000000012", token: "dlv_abcdefghijklmnopqrstuvwx",
    reply: "conv_abcdefghijklmnop", source: retained, target: pending, body: "keep this identity",
    deadline: 10_000, steer: false,
  }));
  const before = (await f.store.snapshot()).deliveries;
  let window: CodexThread[] = [];
  for (let page = 0; page < 10; page++) {
    window = Array.from({ length: 20 }, (_, n) => thread(
      `00000000-0000-7000-8000-${(100 + page * 20 + n).toString(16).padStart(12, "0")}`, `root-${page}-${n}`));
    assert.equal((await f.directory.reconcileCodex(window)).truncated, false);
    const state = await f.store.snapshot();
    assert.equal(state.endpoints.length, 22);
    assert.deepEqual(state.deliveries, before); assert.equal(state.retirements.length, 0);
    assert.equal(f.directory.listed(state.endpoints).length, 21);
  }
  await f.store.transact((state) => new Ledger(state, HOST, ledgerDefaults, 20_000).expire());
  await f.directory.reconcileCodex(window);
  assert.equal((await f.store.snapshot()).endpoints.some((row) => row.id === pending.id), false);
  assert.equal((await f.store.snapshot()).endpoints.some((row) => row.id === retained.id), true);
  await f.directory.reconcileCodex([thread(pending.handle, "returns")]);
  const returned = (await f.store.snapshot()).endpoints.find((row) => row.handle === pending.handle)!;
  assert.notEqual(returned.id, pending.id, "a pruned identity is not rebound to old receipts");
  assert.equal((await f.store.snapshot()).deliveries[0]!.target.id, pending.id);
});

test("an unconfirmed observation cannot prune the prior window", async (t) => {
  const f = await fixture(t); await f.directory.reconcileCodex([thread(IDS[0], "last-known")]);
  const before = (await f.store.snapshot()).endpoints;
  await f.directory.reconcileCodex([], [], false, false);
  assert.deepEqual((await f.store.snapshot()).endpoints, before);
  assert.deepEqual(f.directory.listed(before), before);
});

test("window pruning preserves both endpoints and exact delivery bytes in every pending phase", async (t) => {
  for (const phase of ["queued", "reserved", "armed", "accepted"] as const) await t.test(phase, async (t) => {
    const f = await fixture(t);
    const rows = (await f.directory.reconcileCodex([thread(IDS[0], "source"), thread(IDS[1], "target")])).endpoints;
    await f.store.transact((state) => {
      const ledger = new Ledger(state, HOST, ledgerDefaults, 1_000);
      ledger.admit({ id: "msg_00000000-0000-4000-8000-000000000020", token: "dlv_abcdefghijklmnopqrstuvwx",
        reply: "conv_abcdefghijklmnop", source: rows[0]!, target: rows[1]!, body: "preserve every phase",
        deadline: 10_000, steer: false });
      if (phase !== "queued") {
        const batch = ledger.reserve(rows[1]!, "attempt_window"), ids = batch.map((row) => row.id);
        if (phase !== "reserved") assert.equal(ledger.authorize(ids, "attempt_window", {
          bytes: 100, sha256: "a".repeat(64), bodies: batch.map((row) => bodyHash(row.body)),
        }), true);
        if (phase === "accepted") assert.equal(ledger.accept(ids, "attempt_window", "unconfirmed"), true);
      }
    });
    const before = (await f.store.snapshot()).deliveries;
    await f.directory.reconcileCodex([thread(IDS[2], "new-window")]);
    const state = await f.store.snapshot();
    assert.deepEqual(state.deliveries, before); assert.equal(state.retirements.length, 0);
    for (const row of rows) assert.deepEqual(state.endpoints.find((e) => e.id === row.id), row);
  });
});
