import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import { attestClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import { UNKNOWN_COMPATIBILITY_VERSION } from "../src/gateway/compatibility.js";

const UID = process.getuid?.() ?? 501;

type RuntimeFixture = {
  root: string;
  home: string;
  executable: string;
  user: {
    username: string;
    uid: number;
    homedir: string;
  };
};

async function fixture(t: TestContext): Promise<RuntimeFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-claude-runtime-"));
  const home = path.join(root, "home");
  const bin = path.join(home, ".local", "bin");
  const executable = path.join(bin, "claude");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await writeFile(executable, "#!/bin/sh\nexit 73\n", { mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    home,
    executable,
    user: { username: "synthetic-user", uid: UID, homedir: home },
  };
}

test("a regular attested executable is never launched and reports unknown metadata", async (t) => {
  const current = await fixture(t);
  const marker = path.join(current.root, "version-command-ran");
  await writeFile(
    current.executable,
    `#!/bin/sh\nprintf touched > ${JSON.stringify(marker)}\nprintf '9.9.9 (Claude Code)\\n'\nexit 73\n`,
    { mode: 0o700 },
  );

  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    { userInfo: () => current.user },
  );

  assert.deepEqual(runtime, {
    claudeExecutable: current.executable,
    claudeCodeVersion: UNKNOWN_COMPATIBILITY_VERSION,
    sessionsDir: path.join(current.home, ".claude", "sessions"),
    socketDir: "/tmp/cc-socks",
  });
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("the attested official launcher leaf supplies metadata without executing it", async (t) => {
  const current = await fixture(t);
  const versionsDir = path.join(
    current.home,
    ".local",
    "share",
    "claude",
    "versions",
  );
  const marker = path.join(current.root, "launcher-target-ran");
  const target = path.join(versionsDir, "3.0.0");
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    target,
    `#!/bin/sh\nprintf touched > ${JSON.stringify(marker)}\nprintf '2.1.227 (Claude Code)\\n'\nexit 73\n`,
    { mode: 0o700 },
  );
  await unlink(current.executable);
  await symlink(target, current.executable);

  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    { userInfo: () => current.user },
  );

  assert.equal(runtime.claudeExecutable, target);
  assert.equal(runtime.claudeCodeVersion, "3.0.0");
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("runtime keeps executable ownership, path, mode, and symlink trust checks", async (t) => {
  const current = await fixture(t);
  await chmod(current.executable, 0o722);
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      { userInfo: () => current.user },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_CLAUDE_EXECUTABLE",
  );

  await unlink(current.executable);
  const unapprovedTarget = path.join(current.home, ".local", "bin", "real");
  await writeFile(unapprovedTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(unapprovedTarget, current.executable);
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      { userInfo: () => current.user },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_CLAUDE_EXECUTABLE",
  );

  const outside = path.join(current.root, "claude");
  await writeFile(outside, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: outside },
      { userInfo: () => current.user },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_EXECUTABLE_OUTSIDE_HOME",
  );
});

test("official launcher metadata requires an exact versioned in-home target", async (t) => {
  const current = await fixture(t);
  const versionsDir = path.join(
    current.home,
    ".local",
    "share",
    "claude",
    "versions",
  );
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await unlink(current.executable);
  const oddTarget = path.join(versionsDir, "development");
  await writeFile(oddTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(oddTarget, current.executable);
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      { userInfo: () => current.user },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_CLAUDE_EXECUTABLE" &&
      !error.message.includes("development"),
  );
});
