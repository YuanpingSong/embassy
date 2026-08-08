import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { renameSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { BridgeError } from "../src/errors.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { acquireGatewayInstanceLease } from "../src/gateway/instance-lease.js";
import { GatewayStore } from "../src/gateway/store.js";

const HOST_LOCK = path.join(
  ".local",
  "state",
  "agent-embassy",
  ".gateway-host.lock",
);
const HOST_ROOT = path.dirname(HOST_LOCK);
const HOST_MARKER = ".agent-embassy-state";
const HOST_MARKER_CONTENT = "agent-embassy-state-v1\n";
const LEGACY_ROOT = path.join(
  ".local",
  "state",
  "claude-agent-bridge",
  "gateway",
);
const LEGACY_MARKER = ".claude-codex-gateway-state";
const LEGACY_LOCK = ".gateway-controller.lock";

async function homeFixture(t: TestContext): Promise<string> {
  const temporary = await realpath(os.tmpdir());
  const home = await mkdtemp(path.join(temporary, "embassy-instance-test-"));
  await chmod(home, 0o700);
  t.after(async () => rm(home, { recursive: true, force: true }));
  return home;
}

function lockRecord(pid: number, token: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    pid,
    hostname: os.hostname(),
    token,
  })}\n`;
}

async function assertPersistentHostLock(home: string): Promise<void> {
  const info = await lstat(path.join(home, HOST_LOCK));
  assert.equal(info.isFile(), true);
  assert.equal(info.mode & 0o777, 0o600);
}

async function createLegacyRoot(
  home: string,
  marker = "claude-codex-local-gateway-state-v1\n",
): Promise<string> {
  const root = path.join(home, LEGACY_ROOT);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(path.join(root, LEGACY_MARKER), marker, { mode: 0o600 });
  await chmod(path.join(root, LEGACY_MARKER), 0o600);
  return root;
}

test(
  "one host-wide lease blocks a second controller regardless of state-root choice",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const first = await acquireGatewayInstanceLease(home);
    await assert.rejects(
      acquireGatewayInstanceLease(home),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_INSTANCE_IN_USE",
    );
    await first.close();
    assert.equal(first.isLost(), false);

    const second = await acquireGatewayInstanceLease(home);
    await second.close();
    await assertPersistentHostLock(home);
    assert.equal(
      await readFile(path.join(home, HOST_ROOT, HOST_MARKER), "utf8"),
      HOST_MARKER_CONTENT,
    );
  },
);

test(
  "the host lease reports an unexpected helper exit and remains safely closable",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    let helper: ChildProcessWithoutNullStreams | undefined;
    const lease = await acquireGatewayInstanceLease(home, {
      spawnLeaseHelper: (command, args, options) => {
        helper = spawn(command, args, options);
        return helper;
      },
    });
    assert.ok(helper);
    assert.equal(lease.isLost(), false);

    helper.kill("SIGKILL");
    await lease.lost;
    assert.equal(lease.isLost(), true);

    // The exit event is emitted only after the kernel-held lock has gone, so a
    // successor can acquire the same fixed inode. Closing the lost generation
    // remains idempotent and never unlinks that inode.
    const successor = await acquireGatewayInstanceLease(home);
    await lease.close();
    await lease.close();
    await successor.close();
    await assertPersistentHostLock(home);
  },
);

test(
  "the host lease reports a post-READY helper error until cleanup releases ownership",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    let helper: ChildProcessWithoutNullStreams | undefined;
    const lease = await acquireGatewayInstanceLease(home, {
      spawnLeaseHelper: (command, args, options) => {
        helper = spawn(command, args, options);
        return helper;
      },
    });
    assert.ok(helper);

    helper.emit("error", new Error("synthetic helper error"));
    await lease.lost;
    assert.equal(lease.isLost(), true);
    await assert.rejects(
      acquireGatewayInstanceLease(home),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_INSTANCE_IN_USE",
    );

    await lease.close();
    const successor = await acquireGatewayInstanceLease(home);
    await successor.close();
  },
);

test(
  "failed acquisition force-terminates a TERM-resistant helper before returning",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    let helper: ChildProcessWithoutNullStreams | undefined;

    await assert.rejects(
      acquireGatewayInstanceLease(home, {
        hostLeaseExitTimeoutMs: 25,
        spawnLeaseHelper: (_command, args, options) => {
          const lockPath = args[3];
          assert.ok(lockPath);
          helper = spawn(
            process.execPath,
            [
              "--eval",
              "process.on('SIGTERM',()=>{});process.stdin.pipe(process.stdout);setInterval(()=>{},1000)",
            ],
            options,
          );
          helper.stdout.once("data", () => {
            renameSync(lockPath, `${lockPath}.displaced`);
          });
          return helper;
        },
      }),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_INSTANCE_IN_USE",
    );
    assert.ok(helper);
    assert.equal(helper.signalCode, "SIGKILL");
  },
);

test(
  "a fresh default host lease establishes store ownership before the real store initializes",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const stateDir = path.join(home, HOST_ROOT);
    const lease = await acquireGatewayInstanceLease(home);
    const config = loadGatewayConfig({ EMBASSY_STATE_DIR: stateDir });
    const store = new GatewayStore(config);

    await store.initialize();
    assert.equal(
      await readFile(path.join(stateDir, HOST_MARKER), "utf8"),
      HOST_MARKER_CONTENT,
    );
    await store.close();
    await lease.close();
  },
);

test("a non-empty unmarked default root is rejected without mutation", async (t) => {
  const home = await homeFixture(t);
  const stateDir = path.join(home, HOST_ROOT);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await writeFile(path.join(stateDir, "unrelated.txt"), "leave me alone\n", {
    mode: 0o600,
  });
  const before = await readdir(stateDir);

  await assert.rejects(
    acquireGatewayInstanceLease(home),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE",
  );
  assert.deepEqual(await readdir(stateDir), before);
  assert.equal(
    await readFile(path.join(stateDir, "unrelated.txt"), "utf8"),
    "leave me alone\n",
  );
});

test("the fixed owner record excludes a second operating-system process", { skip: process.platform !== "darwin" }, async (t) => {
  const home = await homeFixture(t);
  const sourceUrl = pathToFileURL(
    path.join(process.cwd(), "src", "gateway", "instance-lease.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { acquireGatewayInstanceLease } from ${JSON.stringify(sourceUrl)};
       const lease = await acquireGatewayInstanceLease(process.env.EMBASSY_TEST_HOME);
       process.stdout.write("READY\\n");
       process.on("SIGTERM", async () => { await lease.close(); process.exit(0); });
       setInterval(() => undefined, 1000);`,
    ],
    {
      cwd: process.cwd(),
      env: {
        HOME: home,
        EMBASSY_TEST_HOME: home,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`child lease did not become ready: ${stderr}`)),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`child lease exited early (${String(code)}): ${stderr}`),
      );
    });
  });

  await assert.rejects(
    acquireGatewayInstanceLease(home),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE",
  );
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(`child lease cleanup failed (${String(code)}): ${stderr}`),
        );
      }
    });
  });
  const lease = await acquireGatewayInstanceLease(home);
  await lease.close();
});

test("host lease preparation rejects a symlinked state ancestor before creating through it", async (t) => {
  const home = await homeFixture(t);
  const external = path.join(home, "external");
  await mkdir(external, { mode: 0o700 });
  await symlink(external, path.join(home, ".local"));

  await assert.rejects(
    acquireGatewayInstanceLease(home),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE",
  );
  assert.deepEqual(await readdir(external), []);
});

test(
  "a live exact legacy controller blocks Embassy and releases the new host lease",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const legacy = await createLegacyRoot(home);
    const existing = lockRecord(
      process.pid,
      "11111111-1111-4111-8111-111111111111",
    );
    await writeFile(path.join(legacy, LEGACY_LOCK), existing, { mode: 0o600 });

    await assert.rejects(
      acquireGatewayInstanceLease(home),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_INSTANCE_IN_USE",
    );
    assert.equal(
      await readFile(path.join(legacy, LEGACY_LOCK), "utf8"),
      existing,
    );
    await assertPersistentHostLock(home);
  },
);

test(
  "a dead legacy lock is preserved and blocks automatic migration",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const legacy = await createLegacyRoot(home);
    const existing = lockRecord(
      2_147_483_000,
      "22222222-2222-4222-8222-222222222222",
    );
    await writeFile(path.join(legacy, LEGACY_LOCK), existing, { mode: 0o600 });

    await assert.rejects(
      acquireGatewayInstanceLease(home),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_INSTANCE_IN_USE",
    );
    assert.equal(
      await readFile(path.join(legacy, LEGACY_LOCK), "utf8"),
      existing,
    );
    await assertPersistentHostLock(home);
  },
);

test(
  "a missing legacy root is not created",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const lease = await acquireGatewayInstanceLease(home);
    await lease.close();
    await assert.rejects(lstat(path.join(home, LEGACY_ROOT)), { code: "ENOENT" });
  },
);

test(
  "unsafe and unrecognized legacy roots are left untouched",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const unsafeHome = await homeFixture(t);
    const unsafeRoot = await createLegacyRoot(unsafeHome);
    await chmod(unsafeRoot, 0o755);
    const unsafeLease = await acquireGatewayInstanceLease(unsafeHome);
    await unsafeLease.close();
    assert.equal((await lstat(unsafeRoot)).mode & 0o777, 0o755);
    await assert.rejects(lstat(path.join(unsafeRoot, LEGACY_LOCK)), {
      code: "ENOENT",
    });

    const unknownHome = await homeFixture(t);
    const unknownRoot = await createLegacyRoot(unknownHome, "not-our-state\n");
    const before = await readFile(
      path.join(unknownRoot, LEGACY_MARKER),
      "utf8",
    );
    const unknownLease = await acquireGatewayInstanceLease(unknownHome);
    await unknownLease.close();
    assert.equal(
      await readFile(path.join(unknownRoot, LEGACY_MARKER), "utf8"),
      before,
    );
    await assert.rejects(lstat(path.join(unknownRoot, LEGACY_LOCK)), {
      code: "ENOENT",
    });
  },
);

test(
  "shutdown releases only its exact lease and preserves path replacements",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await homeFixture(t);
    const lease = await acquireGatewayInstanceLease(home);
    const lockPath = path.join(home, HOST_LOCK);
    const displaced = `${lockPath}.displaced`;
    await rename(lockPath, displaced);
    const replacement = lockRecord(
      process.pid,
      "33333333-3333-4333-8333-333333333333",
    );
    await writeFile(lockPath, replacement, { mode: 0o600 });
    await lease.close();

    assert.equal(await readFile(lockPath, "utf8"), replacement);
    assert.ok(await lstat(displaced));
  },
);
