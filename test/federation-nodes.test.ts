import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import { ensureGatewayNodeInventoryFile, isAttestedGatewayNodeInventory,
  isDefaultedGatewayNodeInventory, loadGatewayNodeInventory } from "../src/gateway/federation-nodes.js";

const injectedHostname = () => "Fixture-Host.local";

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

test("absent nodes.json defaults to an attested single-machine inventory named by the hostname", async (t) => {
  const stateDir = await stateFixture(t);
  const inventory = await loadGatewayNodeInventory(stateDir, { hostname: injectedHostname });
  assert.deepEqual(inventory, { host: "fixture-host", nodes: [] });
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.nodes), true);
  assert.equal(isAttestedGatewayNodeInventory(inventory, "fixture-host"), true);
  // The provenance marker the CLI reads to say where a host identity came
  // from; it lives beside the inventory, never on it.
  assert.equal(isDefaultedGatewayNodeInventory(inventory), true);
  assert.deepEqual(Object.keys(inventory).sort(), ["host", "nodes"]);
});

test("absent state directory defaults the same way, without ever creating it", async (t) => {
  const stateDir = path.join(await stateFixture(t), "does-not-exist");
  const inventory = await loadGatewayNodeInventory(stateDir, { hostname: injectedHostname });
  assert.deepEqual(inventory, { host: "fixture-host", nodes: [] });
  assert.equal(isAttestedGatewayNodeInventory(inventory, "fixture-host"), true);
  await assert.rejects(lstat(stateDir));
});

test("a hostname that fails HOST_TOKEN defaults to localhost instead", async (t) => {
  const stateDir = await stateFixture(t);
  const inventory = await loadGatewayNodeInventory(stateDir, { hostname: () => "My_Weird_Host!" });
  assert.deepEqual(inventory, { host: "localhost", nodes: [] });
  assert.equal(isAttestedGatewayNodeInventory(inventory, "localhost"), true);
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

test("a present file with the wrong mode still refuses; it never falls back to the default", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  // chmod 0 fails the exact-mode-0600 check before any open() is attempted,
  // so this yields INVALID_GATEWAY_CONFIGURATION, not CONTROL_CONNECT_DENIED
  // (that EPERM/EACCES class is already covered by the injected-errno tests
  // below, which simulate a real syscall denial past the mode check).
  const stateDir = await stateFixture(t);
  const filePath = await writeInventory(stateDir, { version: 1, host: "studio", nodes: [] });
  await chmod(filePath, 0o000);
  await rejectsConfiguration(loadGatewayNodeInventory(stateDir), /mode-0600 regular file/);
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

test("ensureGatewayNodeInventoryFile writes the exact default schema on a first boot and reloads it attested", async (t) => {
  const stateDir = await stateFixture(t);
  const inventory = await ensureGatewayNodeInventoryFile(stateDir, "fixture-host");
  assert.deepEqual(inventory, { host: "fixture-host", nodes: [] });
  assert.equal(isAttestedGatewayNodeInventory(inventory, "fixture-host"), true);
  const filePath = path.join(stateDir, "nodes.json");
  const info = await lstat(filePath);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await readFile(filePath, "utf8"), '{"version":1,"host":"fixture-host","nodes":[]}\n');
  // No leftover temp file from the write.
  assert.deepEqual((await readdir(stateDir)).sort(), ["nodes.json"]);
});

test("ensureGatewayNodeInventoryFile never rewrites a present nodes.json", async (t) => {
  const stateDir = await stateFixture(t);
  const filePath = await writeInventory(stateDir, { version: 1, host: "studio", nodes: ["peer-a"] });
  const before = await lstat(filePath);
  const inventory = await ensureGatewayNodeInventoryFile(stateDir, "fixture-host");
  assert.deepEqual(inventory, { host: "studio", nodes: ["peer-a"] });
  const after = await lstat(filePath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

test("a hostname change after the file exists never changes the durable identity", async (t) => {
  const stateDir = await stateFixture(t);
  const first = await ensureGatewayNodeInventoryFile(stateDir, "original-host");
  assert.deepEqual(first, { host: "original-host", nodes: [] });
  // Simulate the machine renaming itself on a later boot: the host passed in
  // is what defaultInventory() would now compute, but the file already exists.
  const second = await ensureGatewayNodeInventoryFile(stateDir, "renamed-host");
  assert.deepEqual(second, { host: "original-host", nodes: [] });
  assert.equal(isAttestedGatewayNodeInventory(second, "original-host"), true);
});

test("a write failure refuses with a classified code; it never runs on the transient identity", async (t) => {
  const stateDir = await stateFixture(t);
  const denied = Object.assign(new Error("private errno detail"), { code: "EACCES" });
  await assert.rejects(ensureGatewayNodeInventoryFile(stateDir, "fixture-host", {
    open: (async () => { throw denied; }) as typeof open,
  }), (error: unknown) => error instanceof BridgeError &&
    error.code === "CONTROL_CONNECT_DENIED" && error.recoverable && !error.message.includes("EACCES"));
  await assert.rejects(lstat(path.join(stateDir, "nodes.json")));
});

test("an install failure refuses as a write failure, not a configuration error, and leaves no litter", async (t) => {
  const stateDir = await stateFixture(t);
  const full = Object.assign(new Error("simulated device full"), { code: "ENOSPC" });
  await assert.rejects(ensureGatewayNodeInventoryFile(stateDir, "fixture-host", {
    link: (async () => { throw full; }) as typeof link,
  }), (error: unknown) => error instanceof BridgeError &&
    error.code === "GATEWAY_STATE_WRITE_FAILED" && error.recoverable &&
    error.message.includes("ENOSPC") && error.message.includes(path.join(stateDir, "nodes.json")));
  await assert.rejects(lstat(path.join(stateDir, "nodes.json")));
  // The temp file is unlinked on the failure path too.
  assert.deepEqual(await readdir(stateDir), []);
});

test("a full disk during the write is a recoverable write failure naming its errno and path", async (t) => {
  const stateDir = await stateFixture(t);
  const full = Object.assign(new Error("simulated device full"), { code: "ENOSPC" });
  await assert.rejects(ensureGatewayNodeInventoryFile(stateDir, "fixture-host", {
    open: (async () => { throw full; }) as typeof open,
  }), (error: unknown) => error instanceof BridgeError &&
    error.code === "GATEWAY_STATE_WRITE_FAILED" && error.recoverable &&
    error.message.includes("ENOSPC") && error.message.includes(stateDir));
  await assert.rejects(lstat(path.join(stateDir, "nodes.json")));
  assert.deepEqual(await readdir(stateDir), []);
});

test("the written file is mode 0600 even under a umask that would not grant it", async (t) => {
  const stateDir = await stateFixture(t);
  // 0o600 & ~0o277 is 0o400: without the explicit chmod the reload below
  // would refuse the very file this function just wrote.
  const previous = process.umask(0o277);
  try {
    const inventory = await ensureGatewayNodeInventoryFile(stateDir, "fixture-host");
    assert.deepEqual(inventory, { host: "fixture-host", nodes: [] });
  } finally {
    process.umask(previous);
  }
  assert.equal((await lstat(path.join(stateDir, "nodes.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(stateDir), ["nodes.json"]);
});

test("a nodes.json created in the stat-to-write window is never clobbered", async (t) => {
  const stateDir = await stateFixture(t);
  const filePath = await writeInventory(stateDir, { version: 1, host: "studio", nodes: ["peer-a"] });
  const before = await lstat(filePath);
  // The race: this boot's absence check misses a file that is already there,
  // so the install must lose to it rather than replace it.
  let blind = true;
  const missOnce = (async (target: unknown) => {
    if (blind && target === filePath) {
      blind = false;
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    }
    return lstat(target as string);
  }) as unknown as typeof lstat;
  const inventory = await ensureGatewayNodeInventoryFile(stateDir, "fixture-host", { lstat: missOnce });
  assert.deepEqual(inventory, { host: "studio", nodes: ["peer-a"] });
  const after = await lstat(filePath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(stateDir), ["nodes.json"]);
});
