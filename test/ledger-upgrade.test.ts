import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { Ledger, emptyLedger, ledgerDefaults, type Endpoint } from "../src/gateway/ledger.js";
import { OwnedStateFile } from "../src/gateway/owned-state.js";

const endpoint = (id: string): Endpoint => ({ id: `reg_${id}`, provider: "codex", host: "local",
  alias: `codex-${id}@local`, handle: `handle-${id}` });

test("schema 6 reads forward without loss, writes 7 on mutation, and the old reader refuses 7", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "state"); await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, ".agent-embassy-state"), "agent-embassy-state-v1\n", { mode: 0o600 });
  const state = emptyLedger(), a = endpoint("a"), b = endpoint("b");
  const ledger = new Ledger(state, "local", ledgerDefaults, 1_000);
  ledger.register(a); ledger.register(b);
  ledger.admit({ id: "msg_00000000-0000-4000-8000-000000000001", token: "dlv_abcdefghijklmnopqrstuvwx",
    reply: "conv_abcdefghijklmnop", source: a, target: b, body: "preserve queued work", deadline: 10_000, steer: false });
  const prior = { ...state, schemaVersion: 6 };
  const bytes = `${JSON.stringify(prior)}\n`, file = path.join(dir, "gateway-state.json");
  await writeFile(file, bytes, { mode: 0o600 }); await chmod(file, 0o600);
  const codec = createLedgerCodec("local", ledgerDefaults);
  const store = new OwnedStateFile(dir, codec, { now: () => new Date(1_000) }); await store.initialize();
  const upgraded = await store.snapshot();
  assert.equal(upgraded.schemaVersion, 7);
  assert.deepEqual(upgraded.endpoints, state.endpoints.map((row) => ({ ...row, retained: true })));
  assert.deepEqual(upgraded.deliveries, state.deliveries);
  assert.equal(await readFile(file, "utf8"), bytes, "read alone leaves the rollback source untouched");
  await store.transact((draft) => new Ledger(draft, "local", ledgerDefaults, 1_000).register(endpoint("c")));
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.schemaVersion, 7); assert.deepEqual(written.deliveries, state.deliveries);
  await store.close();
  const reopened = new OwnedStateFile(dir, codec); await reopened.initialize();
  assert.equal((await reopened.snapshot()).endpoints[0]!.retained, true); await reopened.close();
  let decodes = 0;
  const oldReader = new OwnedStateFile(dir, { ...codec, schemaVersion: 6, previousSchemaVersion: 5,
    decode: () => { decodes++; return undefined; } });
  await assert.rejects(oldReader.initialize(), { code: "GATEWAY_STATE_SCHEMA_UNSUPPORTED" });
  assert.equal(decodes, 0);
  assert.equal(codec.decode({ ...prior, endpoints: [{ ...a, retained: true }] }), undefined,
    "a schema-6 marker cannot be laundered through normalization");
  assert.equal(codec.decode({ ...state, endpoints: [{ ...a, retained: "yes" }] }), undefined);
});
