import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import { loadGatewayNodeInventory } from "../src/gateway/federation-nodes.js";

async function stateFixture(t: TestContext): Promise<string> {
  const stateDir = await realpath(await mkdtemp("/tmp/embassy-nodes-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

async function writeInventory(stateDir: string, value: unknown): Promise<string> {
  const filePath = path.join(stateDir, "nodes.json");
  await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
  return filePath;
}

async function rejectsConfiguration(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "INVALID_GATEWAY_CONFIGURATION");
    assert.match(error.message, pattern);
    return true;
  });
}

test("missing nodes.json refuses without inventing a local identity", async (t) => {
  const stateDir = await stateFixture(t);
  await assert.rejects(loadGatewayNodeInventory(stateDir), (error: unknown) =>
    error instanceof BridgeError && error.code === "GATEWAY_NODE_INVENTORY_REQUIRED");
});

test("loads an exact bounded static inventory and freezes its result", async (t) => {
  const stateDir = await stateFixture(t);
  await writeInventory(stateDir, {
    version: 1,
    host: "studio",
    nodes: ["m5dev", "lab-mac"],
  });
  const inventory = await loadGatewayNodeInventory(stateDir);
  assert.deepEqual(inventory, {
    host: "studio",
    nodes: ["m5dev", "lab-mac"],
  });
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.nodes), true);
});

test("rejects non-exact schemas, invalid hosts, duplicates, and local loops", async (t) => {
  const invalid = [
    { version: 2, host: "studio", nodes: [] },
    { version: 1, host: "Studio", nodes: [] },
    { version: 1, host: "studio", nodes: [], extra: true },
    { version: 1, host: "studio", nodes: ["m5dev", "m5dev"] },
    { version: 1, host: "studio", nodes: ["studio"] },
    { version: 1, host: "studio", nodes: Array.from({ length: 32 }, (_, index) => `node-${index}`) },
  ];
  for (const value of invalid) {
    const stateDir = await stateFixture(t);
    await writeInventory(stateDir, value);
    await rejectsConfiguration(loadGatewayNodeInventory(stateDir), /nodes\.json/);
  }
});

test("rejects unsafe roots and unsafe inventory artifacts", async (t) => {
  const publicRoot = await stateFixture(t);
  await chmod(publicRoot, 0o755);
  await rejectsConfiguration(loadGatewayNodeInventory(publicRoot), /mode-0700/);

  const stateDir = await stateFixture(t);
  const target = path.join(stateDir, "target.json");
  await writeFile(target, '{"version":1,"host":"studio","nodes":[]}', { mode: 0o600 });
  await symlink(target, path.join(stateDir, "nodes.json"));
  await rejectsConfiguration(loadGatewayNodeInventory(stateDir), /mode-0600 regular file/);

  const looseDir = await stateFixture(t);
  const looseFile = await writeInventory(looseDir, { version: 1, host: "studio", nodes: [] });
  await chmod(looseFile, 0o644);
  await rejectsConfiguration(loadGatewayNodeInventory(looseDir), /mode-0600 regular file/);
});

test("rejects oversized inventories before parsing", async (t) => {
  const stateDir = await stateFixture(t);
  const filePath = path.join(stateDir, "nodes.json");
  await writeFile(filePath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
  await rejectsConfiguration(loadGatewayNodeInventory(stateDir), /64 KiB/);
});

test("rejects an inventory owned by another uid through the audit seam", async (t) => {
  const stateDir = await stateFixture(t);
  await writeInventory(stateDir, { version: 1, host: "studio", nodes: [] });
  await rejectsConfiguration(
    loadGatewayNodeInventory(stateDir, { getuid: () => 2 ** 31 - 1 }),
    /owned by the current process user/,
  );
});

test("preserves permission-denied inventory inspection as a recoverable access failure", async () => {
  const denied = Object.assign(new Error("private errno detail"), { code: "EPERM" });
  await assert.rejects(loadGatewayNodeInventory("/private/state", {
    lstat: async () => { throw denied; },
  }), (error: unknown) => error instanceof BridgeError &&
    error.code === "CONTROL_CONNECT_DENIED" && error.recoverable &&
    !error.message.includes("EPERM"));
});

test("preserves denied nodes.json lstat, open, and read branches independently", async (t) => {
  const stateDir = await stateFixture(t);
  const filePath = await writeInventory(stateDir, { version: 1, host: "studio", nodes: [] });
  const denied = () => Object.assign(new Error("private errno detail"), { code: "EPERM" });
  const cases = [
    { lstat: (async (target: string) => {
      if (target === filePath) throw denied();
      return await lstat(target);
    }) as typeof lstat },
    { open: (async () => { throw denied(); }) as typeof open },
    { open: (async (target: string, flags: number) => {
      const handle = await open(target, flags);
      handle.read = (async () => { throw denied(); }) as typeof handle.read;
      return handle;
    }) as typeof open },
  ];
  for (const dependencies of cases) await assert.rejects(
    loadGatewayNodeInventory(stateDir, dependencies),
    (error: unknown) => error instanceof BridgeError && error.code === "CONTROL_CONNECT_DENIED",
  );

  const unexpected = new Error("unexpected read failure");
  await assert.rejects(loadGatewayNodeInventory(stateDir, {
    open: (async (target: string, flags: number) => {
      const handle = await open(target, flags);
      handle.read = (async () => { throw unexpected; }) as typeof handle.read;
      return handle;
    }) as typeof open,
  }), (error: unknown) => error === unexpected);
});
