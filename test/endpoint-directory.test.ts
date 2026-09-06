import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClaudePeerDescriptor, ClaudePeerDiscovery } from "../src/gateway/claude-peer.js";
import { EndpointDirectory, type ClaudeDirectoryAdapter, type RemoteEndpointResolver } from "../src/gateway/endpoint-directory.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { Ledger, ledgerDefaults, type Endpoint, type EndpointRef } from "../src/gateway/ledger.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

const HOST = "local";
const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const UUID_C = "00000000-0000-4000-8000-000000000003";
const peer = (targetId: string, alias: string, kind: ClaudePeerDescriptor["kind"] = "interactive"):
ClaudePeerDescriptor => ({ targetId, alias, kind, status: "idle", compatibility: "compatible" });

class FakeClaude implements ClaudeDirectoryAdapter {
  peers: ClaudePeerDescriptor[] = [];
  replies = new Map<string, ClaudePeerDescriptor>();
  attested: string[] = [];
  truncated = false;
  error: Error | undefined;
  discoveries = 0;
  async discover(): Promise<ClaudePeerDiscovery> {
    this.discoveries += 1;
    if (this.error !== undefined) throw this.error;
    return { peers: this.peers, rejected: {}, truncated: this.truncated, entriesScanned: this.peers.length,
      parseableRecords: this.peers.length };
  }
  async resolveReplyAddress(address: string): Promise<ClaudePeerDescriptor> {
    const found = this.replies.get(address);
    if (found === undefined) throw new Error("unknown reply address");
    return found;
  }
  async assertTargetWorkspaceDisjoint(targetId: string): Promise<void> { this.attested.push(targetId); }
}

async function fixture(t: { after: (cleanup: () => Promise<void>) => void },
  remote?: RemoteEndpointResolver) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-directory-"));
  const stateDir = path.join(root, "state");
  await mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OwnedStateFile(stateDir, createLedgerCodec(HOST, ledgerDefaults), {
    randomId: (() => { let value = 0; return () => `commit-${++value}`; })(),
    now: () => new Date(1_000),
  });
  await store.initialize();
  const claude = new FakeClaude();
  const directory = new EndpointDirectory({ host: HOST, limits: ledgerDefaults, store, claude,
    ...(remote === undefined ? {} : { remote }),
    createRegistrationId: (provider, handle) => `reg_${provider}_${handle.slice(-12)}` });
  return { claude, directory, store };
}

test("Codex registration reuses one stable identity and successor replacement is one atomic commit", async (t) => {
  const f = await fixture(t);
  const first = await f.directory.registerCodex(UUID_A, "codex-first@local");
  const renamed = await f.directory.registerCodex(UUID_A, "codex-renamed@local");
  assert.equal(renamed.id, first.id);
  assert.deepEqual((await f.store.snapshot()).endpoints, [renamed]);
  const before = (await f.store.snapshot()).commit.sequence;
  const successor = await f.directory.registerCodex(UUID_B, "codex-next@local", "codex-renamed@local");
  const state = await f.store.snapshot();
  assert.equal(state.commit.sequence, before + 1);
  assert.deepEqual(state.endpoints, [successor]);
  assert.equal(state.retirements[0]?.endpoint.id, first.id);
});

test("caller identity comes only from an inherited Codex handle or Claude reply socket", async (t) => {
  const f = await fixture(t);
  const codex = await f.directory.registerCodex(UUID_A, "codex-main@local");
  assert.deepEqual(await f.directory.caller({ kind: "codex", handle: UUID_A }), codex);
  f.claude.replies.set("uds:/private/reply.sock", peer(UUID_B, "claude-main", "bg"));
  const claude = await f.directory.caller({ kind: "claude", address: "uds:/private/reply.sock" });
  assert.equal(claude.handle, UUID_B);
  assert.equal(claude.alias, "claude-main@local");
  await assert.rejects(f.directory.caller({ kind: "codex", handle: UUID_C }), { code: "ROUTE_UNREGISTERED" });
  f.claude.replies.set("uds:/private/daemon.sock", peer(UUID_C, "worker", "daemon"));
  await assert.rejects(f.directory.caller({ kind: "claude", address: "uds:/private/daemon.sock" }),
    { code: "CLAUDE_REPLY_ROUTE_MISMATCH" });
});

test("fresh discovery represents duplicate Claude names, named send refuses, and each UUID remains exact", async (t) => {
  const f = await fixture(t);
  f.claude.peers = [peer(UUID_A, "twins"), peer(UUID_B, "twins", "bg"), peer(UUID_C, "ignored", "daemon")];
  assert.equal((await f.directory.refresh()).filter((row) => row.alias === "twins@local").length, 2);
  await assert.rejects(f.directory.named("twins@local"), { code: "PEER_ALIAS_COLLISION" });
  const first = await f.directory.named(UUID_A);
  const second = await f.directory.named(UUID_B);
  assert.equal(first?.handle, UUID_A);
  assert.equal(second?.handle, UUID_B);
  assert.deepEqual(f.claude.attested, [UUID_A, UUID_B]);
});

test("same Claude UUID renames one row while exact resolution never falls back by name", async (t) => {
  const f = await fixture(t);
  f.claude.peers = [peer(UUID_A, "before")];
  const original = await f.directory.named("before@local");
  assert.ok(original);
  f.claude.peers = [peer(UUID_A, "after")];
  const renamed = await f.directory.named("after@local");
  assert.equal(renamed?.id, original.id);
  assert.equal((await f.store.snapshot()).endpoints.filter((row) => row.handle === UUID_A).length, 1);
  assert.equal(await f.directory.named("before@local"), undefined);
  assert.equal(await f.directory.exact({ ...original, id: "reg_missing" }), undefined);
  assert.equal((await f.directory.exact(reference(renamed!)))?.alias, "after@local");
  f.claude.peers = [];
  assert.equal(await f.directory.exact(reference(renamed!)), undefined);
});

test("retirement fences the same native identity when discovery sees it again", async (t) => {
  const f = await fixture(t);
  f.claude.peers = [peer(UUID_A, "retired")];
  const installed = await f.directory.named("retired@local");
  assert.ok(installed);
  await f.store.transact((state, now) =>
    new Ledger(state, HOST, ledgerDefaults, now.getTime()).retire(reference(installed)));
  await assert.rejects(f.directory.named("retired@local"), { code: "ROUTE_UNREGISTERED" });
  f.claude.replies.set("uds:/private/retired.sock", peer(UUID_A, "retired"));
  await assert.rejects(f.directory.caller({ kind: "claude", address: "uds:/private/retired.sock" }),
    { code: "ROUTE_UNREGISTERED" });
  assert.deepEqual(await f.directory.refresh(), []);
  assert.deepEqual((await f.store.snapshot()).endpoints, []);
});

test("Claude discovery failure cannot block an unambiguous registered Codex name", async (t) => {
  const f = await fixture(t);
  const codex = await f.directory.registerCodex(UUID_A, "codex-main@local");
  f.claude.error = new Error("provider unavailable");
  assert.deepEqual(await f.directory.named(codex.alias), codex);
  assert.equal(f.claude.discoveries, 1);

  f.claude.error = undefined;
  f.claude.peers = [peer(UUID_B, "codex-main")];
  await assert.rejects(f.directory.named(codex.alias), { code: "PEER_ALIAS_COLLISION" });
  f.claude.peers = [];
  await f.directory.refresh();
  f.claude.error = new Error("provider unavailable");
  assert.deepEqual(await f.directory.named(codex.alias), codex);

  f.claude.error = undefined;
  f.claude.peers = [peer(UUID_B, "shared"), peer(UUID_C, "shared")];
  await f.directory.refresh();
  f.claude.error = new Error("provider unavailable");
  await assert.rejects(f.directory.named("shared@local"), { code: "PEER_ALIAS_COLLISION" });
});

test("explicit Codex registration cannot claim another endpoint's alias", async (t) => {
  const f = await fixture(t);
  f.claude.peers = [peer(UUID_A, "codex-taken")];
  await f.directory.refresh();
  const before = JSON.stringify(await f.store.snapshot());
  await assert.rejects(f.directory.registerCodex(UUID_B, "codex-taken@local"),
    { code: "PEER_ALIAS_COLLISION" });
  assert.equal(JSON.stringify(await f.store.snapshot()), before);
});

test("truncated discovery retains a known duplicate-name fence until a complete scan proves uniqueness", async (t) => {
  const f = await fixture(t);
  f.claude.peers = [peer(UUID_A, "shared"), peer(UUID_B, "shared")];
  await f.directory.refresh();
  f.claude.peers = [peer(UUID_A, "shared")];
  f.claude.truncated = true;
  await assert.rejects(f.directory.named("shared@local"), { code: "PEER_ALIAS_COLLISION" });
  f.claude.truncated = false;
  assert.equal((await f.directory.named("shared@local"))?.handle, UUID_A);
  f.claude.error = new Error("provider unavailable");
  await assert.rejects(f.directory.named("shared@local"), /provider unavailable/u);
});

test("owner-authenticated remote resolution is injected and never persists catalog rows", async (t) => {
  const remote: Endpoint = { id: "reg_remote", host: "other", provider: "codex",
    alias: "codex-remote@other", handle: UUID_C };
  const resolver: RemoteEndpointResolver = {
    named: async (alias) => alias === remote.alias ? [remote] : [],
    exact: async (identity) => same(identity, remote) ? remote : undefined,
  };
  const f = await fixture(t, resolver);
  assert.deepEqual(await f.directory.named(remote.alias), remote);
  assert.deepEqual(await f.directory.exact(reference(remote)), remote);
  assert.deepEqual((await f.store.snapshot()).endpoints, []);
});

const reference = ({ id, host, provider }: Endpoint): EndpointRef => ({ id, host, provider });
const same = (left: EndpointRef, right: EndpointRef): boolean => left.id === right.id &&
  left.host === right.host && left.provider === right.provider;
