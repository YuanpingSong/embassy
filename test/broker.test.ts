import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessagingBroker } from "../src/gateway/broker.js";
import { Coordinator, type Destination } from "../src/gateway/coordinator.js";
import { EndpointDirectory } from "../src/gateway/endpoint-directory.js";
import { bodyHash, ledgerDefaults } from "../src/gateway/ledger.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

test("broker resolves inherited callers, sends/replies in one step, and retires exact identities", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-broker-"));
  const store = new OwnedStateFile(path.join(root, "state"), createLedgerCodec("local", ledgerDefaults));
  await store.initialize();
  const claude = { targetId: "00000000-0000-4000-8000-000000000001", alias: "advisor", kind: "bg" as const,
    status: "idle" as const, compatibility: "compatible" as const };
  const codex = { kind: "codex" as const, handle: "00000000-0000-4000-8000-000000000002" };
  const caller = { kind: "claude" as const, address: "uds:/test-owned/123.sock" };
  const directory = new EndpointDirectory({ host: "local", store, limits: ledgerDefaults,
    claude: {
      discover: async () => ({ peers: [claude], rejected: {}, truncated: false, entriesScanned: 1, parseableRecords: 1 }),
      resolveReplyAddress: async (address) => { assert.equal(address, caller.address); return claude; },
      assertTargetWorkspaceDisjoint: async () => {},
    } });
  const writes: string[] = [];
  const destination: Destination = { close: async () => {}, deliver: async (input) => {
    assert.equal(await input.authorize({ bytes: Buffer.byteLength(input.text) + 100, sha256: bodyHash(input.text) }), true);
    writes.push(input.text);
    return { outcome: "delivered", code: "TRANSPORT_WRITTEN" };
  } };
  const coordinator = new Coordinator({ host: "local", store, limits: ledgerDefaults,
    resolve: (ref) => directory.exact(ref), claude: destination, codex: destination, ssh: destination });
  const broker = new MessagingBroker({ host: "local", store, limits: ledgerDefaults, directory, coordinator });
  t.after(async () => { await broker.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  await broker.start();
  const registered = await broker.register(codex, "codex-builder@local");
  assert.equal(JSON.stringify(registered).includes(codex.handle), false);
  await directory.reconcileCodex([{ id: codex.handle, loaded: false, status: "dormant" }]);
  assert.equal((await directory.named("codex-builder@local"))?.id, registered.id);
  const outbound = await broker.send(caller, { to: "codex-builder@local" }, "hello");
  await coordinator.wake((await store.snapshot()).endpoints.find((e) => e.provider === "codex")!);
  const sent = await broker.delivery(outbound.deliveryToken);
  assert.equal(sent.found && sent.state, "delivered");
  const reply = await broker.send(codex, { conversation: outbound.conversationId }, "received");
  await coordinator.wake((await store.snapshot()).endpoints.find((e) => e.provider === "claude")!);
  const replied = await broker.delivery(reply.deliveryToken);
  assert.equal(replied.found && replied.state, "delivered");
  assert.equal(writes.length, 2);
  assert.match(writes[0]!, /from-name="advisor@local"/);
  assert.match(writes[1]!, /from-name="codex-builder@local"/);
  const snapshot = JSON.stringify(await broker.status());
  for (const privateValue of [codex.handle, claude.targetId, caller.address, outbound.conversationId, outbound.deliveryToken]) {
    assert.equal(snapshot.includes(privateValue), false);
  }
  assert.deepEqual(await broker.retire("codex-builder@local"), { cancelled: 0, ambiguous: 0, unconfirmed: 0 });
  await assert.rejects(broker.send(caller, { conversation: outbound.conversationId }, "old reply"), { code: "ROUTE_UNREGISTERED" });
});

test("an admission during the pump's empty snapshot re-arms without another command", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-wake-"));
  const store = new OwnedStateFile(path.join(root, "state"), createLedgerCodec("local", ledgerDefaults));
  await store.initialize();
  const directory = new EndpointDirectory({ host: "local", store, limits: ledgerDefaults, claude: {
    discover: async () => ({ peers: [], rejected: {}, truncated: false, entriesScanned: 0, parseableRecords: 0 }),
    resolveReplyAddress: async () => { throw new Error("not Claude"); }, assertTargetWorkspaceDisjoint: async () => {},
  } });
  let woke!: () => void;
  const delivered = new Promise<void>((resolve) => { woke = resolve; });
  const destination: Destination = { close: async () => {}, deliver: async (input) => {
    assert.equal(await input.authorize({ bytes: Buffer.byteLength(input.text), sha256: bodyHash(input.text) }), true);
    woke(); return { outcome: "delivered", code: "DELIVERED" };
  } };
  const coordinator = new Coordinator({ host: "local", store, limits: ledgerDefaults, resolve: (ref) => directory.exact(ref),
    claude: destination, codex: destination, ssh: destination });
  const broker = new MessagingBroker({ host: "local", store, limits: ledgerDefaults, directory, coordinator });
  t.after(async () => { await broker.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const caller = { kind: "codex" as const, handle: "00000000-0000-4000-8000-000000000001" };
  await broker.register(caller, "codex-source@local");
  await broker.register({ ...caller, handle: "00000000-0000-4000-8000-000000000002" }, "codex-target@local");
  const snapshot = store.snapshot.bind(store);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const captured = new Promise<void>((resolve) => { reached = resolve; });
  let first = true;
  store.snapshot = async () => {
    const state = await snapshot();
    if (first) { first = false; reached(); await held; }
    return state;
  };
  await broker.start(); await captured;
  await broker.send(caller, { to: "codex-target@local" }, "must wake without a second kick");
  release();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([delivered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("lost wake")), 1_000); })]); }
  finally { clearTimeout(timeout); }
});

test("an exact public endpoint retires one departed Claude twin when its shared alias cannot", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-retire-twin-"));
  const store = new OwnedStateFile(path.join(root, "state"), createLedgerCodec("local", ledgerDefaults));
  await store.initialize();
  let peers = [
    { targetId: "00000000-0000-4000-8000-000000000011", alias: "twins", kind: "interactive" as const,
      status: "idle" as const, compatibility: "compatible" as const },
    { targetId: "00000000-0000-4000-8000-000000000012", alias: "twins", kind: "bg" as const,
      status: "idle" as const, compatibility: "compatible" as const },
  ];
  const directory = new EndpointDirectory({ host: "local", store, limits: ledgerDefaults, claude: {
    discover: async () => ({ peers, rejected: {}, truncated: false, entriesScanned: peers.length, parseableRecords: peers.length }),
    resolveReplyAddress: async () => { throw new Error("not used"); }, assertTargetWorkspaceDisjoint: async () => {},
  } });
  let writes = 0;
  const destination: Destination = { close: async () => {}, deliver: async () => { writes++; throw new Error("not used"); } };
  const coordinator = new Coordinator({ host: "local", store, limits: ledgerDefaults,
    resolve: (ref) => directory.exact(ref), claude: destination, codex: destination, ssh: destination });
  const broker = new MessagingBroker({ host: "local", store, limits: ledgerDefaults, directory, coordinator });
  t.after(async () => { await broker.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const codex = await broker.register({ kind: "codex", handle: "00000000-0000-4000-8000-000000000013" },
    "codex-local@local");
  const twins = (await directory.refresh()).filter((row) => row.alias === "twins@local");
  assert.equal(twins.length, 2);
  peers = [];
  await assert.rejects(broker.retire("twins@local"), { code: "PEER_ALIAS_COLLISION" });
  assert.deepEqual(await broker.retire({ endpoint: twins[0]!.id }), { cancelled: 0, ambiguous: 0, unconfirmed: 0 });
  const remaining = (await store.snapshot()).endpoints;
  assert.deepEqual(remaining.map((row) => row.id).sort(), [codex.id, twins[1]!.id].sort());
  assert.equal(writes, 0);
});
