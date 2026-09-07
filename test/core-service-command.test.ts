import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  runCoreServiceCommand,
  type CoreServiceCommandDependencies,
} from "../src/gateway/core-service-command.js";
import { serveLocalControl } from "../src/gateway/local-control.js";
import type { RunLaunchctl } from "../src/gateway/service-agent.js";

const notFound = { code: 3, stdout: "", stderr: "Could not find specified service\n" } as const;
const running = { code: 0, stdout: "state = running\npid = 4242\nlast exit code = 0\n", stderr: "" } as const;

async function fixture(t: TestContext, withInventory = true) {
  const root = await mkdtemp(path.join(await realpath(process.platform === "darwin" ? "/tmp" : os.tmpdir()), "emb-service-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  await mkdir(home, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  if (withInventory) {
    await writeFile(path.join(stateDir, "nodes.json"), `${JSON.stringify({ version: 1, host: "local", nodes: [] })}\n`, { mode: 0o600 });
    await chmod(path.join(stateDir, "nodes.json"), 0o600);
  }
  let loaded = false;
  const calls: readonly string[][] = [];
  const launchctl: RunLaunchctl = async (args) => {
    (calls as string[][]).push([...args]);
    if (args[0] === "print") return loaded ? running : notFound;
    if (args[0] === "bootstrap") { loaded = true; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "bootout") { loaded = false; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const dependencies = (overrides: Partial<CoreServiceCommandDependencies> = {}): CoreServiceCommandDependencies => ({
    homeDir: home,
    runLaunchctl: launchctl,
    execPath: process.execPath,
    cliPath: path.join(root, "core-cli.js"),
    uid: process.getuid?.() ?? 501,
    probeHostLease: async () => ({ held: false }),
    ...overrides,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, stateDir, calls, dependencies };
}

test("install writes its plist and waits for a real private control health response", async (t) => {
  const f = await fixture(t);
  const socketPath = path.join(f.stateDir, "control.sock");
  let elapsed = 0;
  let control: Awaited<ReturnType<typeof serveLocalControl>> | undefined;
  const result = await runCoreServiceCommand("install", { EMBASSY_STATE_DIR: f.stateDir }, f.dependencies({
    now: () => elapsed,
    delay: async (milliseconds) => {
      elapsed += milliseconds;
      control ??= await serveLocalControl({ stateDir: f.stateDir, socketPath,
        handle: async () => ({ ok: true, result: { status: "healthy" } }) });
    },
  }));
  t.after(() => control?.close());
  assert.equal(result.subcommand, "install");
  assert.deepEqual(result.health, { status: "healthy", elapsedMs: 200 });
  assert.deepEqual(f.calls.map((call) => call[0]), ["print", "bootstrap", "print"]);
  const plist = await readFile(result.plistPath, "utf8");
  assert.match(plist, new RegExp(`<string>${process.execPath}</string>`));
  assert.match(plist, /<string>serve<\/string>/);
});

test("install refuses boundedly when the installed broker never answers health", async (t) => {
  const f = await fixture(t);
  let elapsed = 0;
  await assert.rejects(runCoreServiceCommand("install", { EMBASSY_STATE_DIR: f.stateDir }, f.dependencies({
    now: () => elapsed,
    delay: async (milliseconds) => { elapsed += milliseconds; },
  })), (error: unknown) => error instanceof BridgeError && error.code === "SERVICE_HEALTH_UNAVAILABLE" &&
    error.recoverable && error.message.includes("within 10.0 s") && error.message.includes("CONTROL_SOCKET_MISSING"));
  assert.equal(elapsed, 10_000);
});

test("status and uninstall remain usable without a node inventory", async (t) => {
  const f = await fixture(t, false);
  const env = { EMBASSY_STATE_DIR: f.stateDir };
  const status = await runCoreServiceCommand("status", env, f.dependencies());
  assert.equal(status.subcommand, "status");
  assert.equal(status.state, "not loaded");
  const removed = await runCoreServiceCommand("uninstall", env, f.dependencies());
  assert.equal(removed.subcommand, "uninstall");
  assert.deepEqual(f.calls.map((call) => call[0]), ["print", "bootout", "print"]);
});
