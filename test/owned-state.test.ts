import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  OwnedStateFile,
  type OwnedStateCodec,
  type OwnedStateCommit,
} from "../src/gateway/owned-state.js";

type TestDocument = {
  schemaVersion: 41;
  commit: OwnedStateCommit;
  values: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const codec: OwnedStateCodec<TestDocument> = {
  schemaVersion: 41,
  maximumBytes: 4 * 1024,
  decode: (value) => {
    if (!isObject(value) || Object.keys(value).sort().join() !== "commit,schemaVersion,values") {
      return undefined;
    }
    if (
      value.schemaVersion !== 41 || !isObject(value.commit) ||
      Object.keys(value.commit).sort().join() !== "id,sequence" ||
      !Number.isSafeInteger(value.commit.sequence) || (value.commit.sequence as number) < 0 ||
      typeof value.commit.id !== "string" || !Array.isArray(value.values) ||
      !value.values.every((entry) => typeof entry === "string")
    ) {
      return undefined;
    }
    return value as TestDocument;
  },
  create: ({ commit }) => ({ schemaVersion: 41, commit, values: [] }),
  assertBounds: (value) => {
    if (value.values.length > 4) {
      throw new BridgeError("CORRUPT_GATEWAY_STATE", "The test document exceeds its configured bounds.");
    }
  },
};

async function fixture(
  dependencies: ConstructorParameters<typeof OwnedStateFile<TestDocument>>[2] = {},
): Promise<{ root: string; stateDir: string; store: OwnedStateFile<TestDocument> }> {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-owned-state-"));
  const stateDir = path.join(root, "controller", "gateway");
  await mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  return { root, stateDir, store: new OwnedStateFile(stateDir, codec, dependencies) };
}

test("owned state creates a private exact-schema document and reloads it", async (t) => {
  const subject = await fixture({ randomId: () => "commit-initial" });
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  assert.deepEqual(await subject.store.snapshot(), {
    schemaVersion: 41,
    commit: { sequence: 0, id: "commit-initial" },
    values: [],
  });
  assert.equal((await lstat(subject.stateDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(subject.store.stateFilePath)).mode & 0o777, 0o600);
  await subject.store.close();
  const reopened = new OwnedStateFile(subject.stateDir, codec);
  await reopened.initialize();
  assert.equal((await reopened.snapshot()).commit.id, "commit-initial");
});

test("reset-only schema and corrupt documents refuse without mutation", async (t) => {
  const subject = await fixture();
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  await subject.store.close();
  for (const [body, code] of [
    ['{"schemaVersion":40,"commit":{"sequence":0,"id":"old"},"values":[]}\n',
      "GATEWAY_STATE_SCHEMA_UNSUPPORTED"],
    ['{"schemaVersion":41}\n', "CORRUPT_GATEWAY_STATE"],
  ] as const) {
    await writeFile(subject.store.stateFilePath, body, { mode: 0o600 });
    const reader = new OwnedStateFile(subject.stateDir, codec);
    await assert.rejects(reader.initialize(), (error: unknown) =>
      error instanceof BridgeError && error.code === code);
    assert.equal(await readFile(subject.store.stateFilePath, "utf8"), body);
  }
});

test("a transition refusal changes neither live nor durable state", async (t) => {
  const subject = await fixture();
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  const before = await readFile(subject.store.stateFilePath, "utf8");
  await assert.rejects(subject.store.transact((draft) => {
    draft.values.push("must roll back");
    throw new BridgeError("ROUTE_UNREGISTERED", "synthetic refusal");
  }), /synthetic refusal/u);
  assert.deepEqual((await subject.store.snapshot()).values, []);
  assert.equal(await readFile(subject.store.stateFilePath, "utf8"), before);
});

test("snapshots and transaction results cannot mutate installed state", async (t) => {
  const subject = await fixture();
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  const snapshot = await subject.store.snapshot();
  snapshot.values.push("snapshot mutation");
  const result = await subject.store.transact((draft) => {
    draft.values.push("installed");
    return { values: draft.values };
  });
  result.values.push("result mutation");
  assert.deepEqual((await subject.store.snapshot()).values, ["installed"]);
});

test("a byte-identical no-op returns an isolated result without a new commit", async (t) => {
  const subject = await fixture();
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  const before = await readFile(subject.store.stateFilePath, "utf8");
  const beforeCommit = (await subject.store.snapshot()).commit;
  const result = await subject.store.transact((draft) => ({ duplicate: true, values: draft.values }));
  result.values.push("outside mutation");
  assert.deepEqual((await subject.store.snapshot()).commit, beforeCommit);
  assert.deepEqual((await subject.store.snapshot()).values, []);
  assert.equal(await readFile(subject.store.stateFilePath, "utf8"), before);
});

test("an uncloneable transition result refuses before persistence", async (t) => {
  const subject = await fixture();
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  const before = await readFile(subject.store.stateFilePath, "utf8");
  await assert.rejects(subject.store.transact((draft) => {
    draft.values.push("must not commit");
    return { callback: () => undefined };
  }), /could not be cloned|DataCloneError/iu);
  assert.deepEqual((await subject.store.snapshot()).values, []);
  assert.equal(await readFile(subject.store.stateFilePath, "utf8"), before);
});

test("post-rename exact-current readback confirms the commit", async (t) => {
  let throwAfterRename = false;
  let id = 0;
  let directorySyncs = 0;
  const subject = await fixture({
    randomId: () => `commit-${++id}`,
    renameStateFile: async (source, target) => {
      await rename(source, target);
      if (throwAfterRename) throw new Error("rename installed then errored");
    },
    syncStateDirectory: async () => { directorySyncs += 1; },
  });
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  throwAfterRename = true;
  await subject.store.transact((draft) => draft.values.push("committed"));
  assert.deepEqual((await subject.store.snapshot()).values, ["committed"]);
  const installed = JSON.parse(await readFile(subject.store.stateFilePath, "utf8")) as TestDocument;
  assert.deepEqual(installed.values, ["committed"]);
  assert.equal(installed.commit.sequence, 1);
  assert.equal(directorySyncs, 2, "an exact-current reconciliation performs a fresh directory sync");
});

test("a post-rename directory sync failure poisons the installed outcome", async (t) => {
  let failSync = false;
  let directorySyncs = 0;
  const subject = await fixture({
    syncStateDirectory: async () => {
      directorySyncs += 1;
      if (failSync) throw new Error("directory sync failed");
    },
  });
  t.after(() => rm(subject.root, { recursive: true, force: true }));
  await subject.store.initialize();
  failSync = true;
  await assert.rejects(
    subject.store.transact((draft) => draft.values.push("not acknowledged")),
    (error: unknown) => error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(directorySyncs, 2);
  const installed = JSON.parse(await readFile(subject.store.stateFilePath, "utf8")) as TestDocument;
  assert.deepEqual(installed.values, ["not acknowledged"], "the unsynced installed value is never reported as committed");
  await assert.rejects(subject.store.snapshot(), (error: unknown) =>
    error instanceof BridgeError && error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN");
});

test("a throwing rename distinguishes exact prior from an unknown install", async (t) => {
  for (const mode of ["prior", "unknown"] as const) {
    let active = false;
    let id = 0;
    const subject = await fixture({
      randomId: () => `${mode}-commit-${++id}`,
      renameStateFile: async (source, target) => {
        if (!active) return rename(source, target);
        if (mode === "unknown") await writeFile(target, "{}\n", { mode: 0o600 });
        throw new Error(`injected ${mode} rename failure`);
      },
    });
    t.after(() => rm(subject.root, { recursive: true, force: true }));
    await subject.store.initialize();
    const before = await readFile(subject.store.stateFilePath, "utf8");
    active = true;
    if (mode === "prior") {
      await assert.rejects(
        subject.store.transact((draft) => draft.values.push("not committed")),
        /injected prior rename failure/u,
      );
      assert.deepEqual((await subject.store.snapshot()).values, []);
      assert.equal(await readFile(subject.store.stateFilePath, "utf8"), before);
    } else {
      await assert.rejects(
        subject.store.transact((draft) => draft.values.push("unknown")),
        (error: unknown) => error instanceof BridgeError &&
          error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
      );
      await assert.rejects(subject.store.snapshot(), (error: unknown) =>
        error instanceof BridgeError && error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN");
    }
  }
});

test("state path and file ownership remain closed", async (t) => {
  const loose = await fixture();
  t.after(() => rm(loose.root, { recursive: true, force: true }));
  await mkdir(loose.stateDir, { mode: 0o755 });
  await assert.rejects(loose.store.initialize(), /exact mode 700/u);

  const file = await fixture();
  t.after(() => rm(file.root, { recursive: true, force: true }));
  await file.store.initialize();
  await file.store.close();
  await chmod(file.store.stateFilePath, 0o644);
  await assert.rejects(new OwnedStateFile(file.stateDir, codec).initialize(), /exact mode 600/u);
});
