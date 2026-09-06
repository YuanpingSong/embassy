import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ClaudePeerDiscovery } from "../src/gateway/claude-peer.js";
import type { CodexThread } from "../src/gateway/codex-discovery.js";
import { EndpointDirectory, type ClaudeDirectoryAdapter } from "../src/gateway/endpoint-directory.js";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { ledgerDefaults, type LedgerLimits } from "../src/gateway/ledger.js";
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

test("native discovery reuses manual identity, renames one row, and defensively deduplicates UUIDs", async (t) => {
  const f = await fixture(t);
  const manual = await f.directory.registerCodex(IDS[0], "codex-manual@local");
  const result = await f.directory.reconcileCodex([
    thread(IDS[0], "stale"),
    thread(IDS[0].toUpperCase(), "Review Agent", { agentNickname: "Original nickname" }),
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.endpoints, [{ ...manual, alias: "codex-review-agent@local" }]);
  assert.deepEqual((await f.store.snapshot()).endpoints, result.endpoints);
  await f.directory.reconcileCodex([thread(IDS[0], "Renamed", { agentNickname: "Original nickname" })]);
  assert.deepEqual((await f.store.snapshot()).endpoints, [{ ...manual, alias: "codex-renamed@local" }]);
});

test("unnamed and native-ID-shaped names derive stable aliases only from the public endpoint ID", async (t) => {
  const f = await fixture(t);
  const first = await f.directory.reconcileCodex([thread(IDS[0])]);
  assert.equal(first.endpoints[0]?.alias, "codex-agent-public1@local");
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
  assert.equal(complete.endpoints.length, 2, "absence without archive/delete evidence never removes an endpoint");
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
  assert.deepEqual(f.directory.codexMetadata(installed, []), {
    state: "unknown", canAcceptDirectInput: "unknown",
  });
  assert.deepEqual((await f.directory.reconcileCodex([thread(IDS[0], "gone")])).endpoints, []);
});

test("Codex metadata is memory-only and resolves parentage only to a public endpoint ID", async (t) => {
  const f = await fixture(t);
  const result = await f.directory.reconcileCodex([
    thread(IDS[0], "parent", { status: "active", canAcceptDirectInput: true }),
    thread(IDS[1], "child", { parentThreadId: IDS[0], status: "waitingOnApproval" }),
  ]);
  const parent = result.endpoints.find((row) => row.handle === IDS[0])!;
  const child = result.endpoints.find((row) => row.handle === IDS[1])!;
  assert.deepEqual(f.directory.codexMetadata(parent, result.endpoints), {
    state: "active", canAcceptDirectInput: true,
  });
  assert.deepEqual(f.directory.codexMetadata(child, result.endpoints), {
    state: "waitingOnApproval", canAcceptDirectInput: "unknown", parentEndpoint: parent.id,
  });
  assert.doesNotMatch(JSON.stringify(await f.store.snapshot()), /waitingOnApproval|canAcceptDirectInput|parentThreadId/u);
});
