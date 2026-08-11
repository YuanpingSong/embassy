import assert from "node:assert/strict";
import {
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
import { CLAUDE_PEER_COMPATIBILITY } from "../src/gateway/claude-peer.js";
import {
  attestClaudePeerRuntime,
  type ClaudeVersionCommand,
} from "../src/gateway/claude-runtime.js";
import { UNKNOWN_COMPATIBILITY_VERSION } from "../src/gateway/compatibility.js";

const UID = process.getuid?.() ?? 501;
const PINNED_VERSION = CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion;
const PINNED_VERSION_OUTPUT = `${PINNED_VERSION} (Claude Code)\n`;

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
  await writeFile(
    executable,
    `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\nprintf "${PINNED_VERSION} (Claude Code)\\n"\n`,
    { mode: 0o700 },
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    home,
    executable,
    user: { username: "synthetic-user", uid: UID, homedir: home },
  };
}

test("runtime attestation invokes only --version with a closed non-secret environment", async (t) => {
  const current = await fixture(t);
  let captured: ClaudeVersionCommand | undefined;
  const runtime = await attestClaudePeerRuntime(
    {
      claudeExecutable: current.executable,
      versionTimeoutMs: 750,
    },
    {
      userInfo: () => current.user,
      runVersion: async (command) => {
        captured = command;
        return { stdout: PINNED_VERSION_OUTPUT, stderr: "" };
      },
    },
  );

  assert.deepEqual(captured?.args, ["--version"]);
  assert.equal(captured?.executable, current.executable);
  assert.equal(captured?.cwd, current.home);
  assert.equal(captured?.timeoutMs, 750);
  assert.equal(captured?.maxOutputBytes, 4_096);
  assert.deepEqual(Object.keys(captured?.env ?? {}).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "TERM",
    "USER",
  ]);
  assert.equal(captured?.env.HOME, current.home);
  assert.equal(captured?.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(captured?.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(captured?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(runtime, {
    claudeExecutable: current.executable,
    claudeCodeVersion: PINNED_VERSION,
    sessionsDir: path.join(current.home, ".claude", "sessions"),
    socketDir: "/tmp/cc-socks",
  });
});

test("runtime reports bounded Claude versions across major changes", async (t) => {
  const current = await fixture(t);
  for (const version of ["2.1.228", "2.2.0", "3.0.0"] as const) {
    const runtime = await attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      {
        userInfo: () => current.user,
        runVersion: async () => ({
          stdout: `${version} (Claude Code)\n`,
          stderr: "",
        }),
      },
    );
    assert.equal(runtime.claudeCodeVersion, version);
  }
});

test("default runner executes the synthetic binary and no provider command", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    { userInfo: () => current.user },
  );
  assert.equal(runtime.claudeCodeVersion, PINNED_VERSION);
});

test("runtime accepts only an official same-home versioned launcher symlink", async (t) => {
  const current = await fixture(t);
  const versionsDir = path.join(
    current.home,
    ".local",
    "share",
    "claude",
    "versions",
  );
  const target = path.join(versionsDir, PINNED_VERSION);
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await writeFile(target, `#!/bin/sh\nprintf "${PINNED_VERSION} (Claude Code)\\n"\n`, {
    mode: 0o700,
  });
  await unlink(current.executable);
  await symlink(target, current.executable);
  let invokedExecutable: string | undefined;
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async (command) => {
        invokedExecutable = command.executable;
        return { stdout: PINNED_VERSION_OUTPUT, stderr: "" };
      },
    },
  );
  assert.equal(invokedExecutable, target);
  assert.equal(runtime.claudeExecutable, target);

  const targetEvidence = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "Claude Code development build\n",
        stderr: "nonfatal launcher notice\n",
      }),
    },
  );
  assert.equal(
    targetEvidence.claudeCodeVersion,
    UNKNOWN_COMPATIBILITY_VERSION,
  );
  assert.equal(targetEvidence.launcherVersionEvidence, PINNED_VERSION);

  await unlink(current.executable);
  const observedTarget = path.join(versionsDir, "2.2.0");
  await writeFile(observedTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(observedTarget, current.executable);
  const observed = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "2.2.0 (Claude Code)\n",
        stderr: "",
      }),
    },
  );
  assert.equal(observed.claudeCodeVersion, "2.2.0");

  await unlink(current.executable);
  const unsupportedTarget = path.join(versionsDir, "3.0.0");
  await writeFile(unsupportedTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(unsupportedTarget, current.executable);
  const unsupported = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "3.0.0 (Claude Code)\n",
        stderr: "",
      }),
    },
  );
  assert.equal(unsupported.claudeCodeVersion, "3.0.0");
  const unsupportedTargetOnly = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "Claude Code development build\n",
        stderr: "",
      }),
    },
  );
  assert.equal(
    unsupportedTargetOnly.claudeCodeVersion,
    UNKNOWN_COMPATIBILITY_VERSION,
  );
  assert.equal(unsupportedTargetOnly.launcherVersionEvidence, "3.0.0");

  // A non-version-shaped target inside the versions directory is never
  // classified as drift and never reflected.
  await unlink(current.executable);
  const oddTarget = path.join(versionsDir, "evil name");
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
      !error.message.includes("evil"),
  );
});

test("runtime accepts a trailing suffix and bounded stderr evidence", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "2.1.228 (Claude Code) [beta]\n",
        stderr: "update notice\n",
      }),
    },
  );
  assert.equal(runtime.claudeCodeVersion, "2.1.228");
});

test("runtime reports bounded stderr-only versions across major changes", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "",
        stderr: "2.1.228 (Claude Code) [release]\n",
      }),
    },
  );
  assert.equal(runtime.claudeCodeVersion, "2.1.228");

  const unsupported = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "",
        stderr: "3.0.0 (Claude Code)\n",
      }),
    },
  );
  assert.equal(unsupported.claudeCodeVersion, "3.0.0");
});

test("runtime quarantines conflicting recognized version evidence", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "2.1.228 (Claude Code)\n",
        stderr: "2.1.229 (Claude Code)\n",
      }),
    },
  );
  assert.equal(runtime.claudeCodeVersion, UNKNOWN_COMPATIBILITY_VERSION);
  assert.equal(
    runtime.versionEvidenceFailure,
    "CLAUDE_VERSION_EVIDENCE_CONFLICT",
  );
});

test("runtime records unparseable bounded version evidence as unknown", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => ({
        stdout: "Claude Code development build\n",
        stderr: "nonfatal launcher notice\n",
      }),
    },
  );
  assert.equal(runtime.claudeCodeVersion, UNKNOWN_COMPATIBILITY_VERSION);
});

test("runtime quarantines oversized version evidence without reflecting it", async (t) => {
  const current = await fixture(t);
  for (const output of [
    { stdout: "x".repeat(4_097), stderr: "" },
    { stdout: PINNED_VERSION_OUTPUT, stderr: "x".repeat(4_097) },
  ]) {
    const runtime = await attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      {
        userInfo: () => current.user,
        runVersion: async () => output,
      },
    );
    assert.equal(runtime.claudeCodeVersion, UNKNOWN_COMPATIBILITY_VERSION);
    assert.equal(
      runtime.versionEvidenceFailure,
      "CLAUDE_VERSION_EVIDENCE_TOO_LARGE",
    );
    assert.equal(JSON.stringify(runtime).includes("xxxx"), false);
  }
});

test("runtime quarantines a version command failure without exposing it", async (t) => {
  const current = await fixture(t);
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable },
    {
      userInfo: () => current.user,
      runVersion: async () => {
        throw new Error("private stderr /private/provider/path");
      },
    },
  );
  assert.equal(runtime.claudeCodeVersion, UNKNOWN_COMPATIBILITY_VERSION);
  assert.equal(runtime.versionEvidenceFailure, "CLAUDE_VERSION_CHECK_FAILED");
  assert.equal(JSON.stringify(runtime).includes("/private"), false);
});

test("runtime rejects executable symlinks, unsafe modes, and paths outside login home", async (t) => {
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
  const realExecutable = path.join(current.home, ".local", "bin", "real");
  await writeFile(realExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink(realExecutable, current.executable);
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

test("runtime rejects a binary generation changed during version attestation", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      {
        userInfo: () => current.user,
        runVersion: async () => {
          await writeFile(
            current.executable,
            '#!/bin/sh\nprintf "changed"\n',
            { mode: 0o700 },
          );
          return { stdout: PINNED_VERSION_OUTPUT, stderr: "" };
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_EXECUTABLE_CHANGED",
  );
});

test("runtime rejects an official launcher symlink replaced during attestation", async (t) => {
  const current = await fixture(t);
  const versionsDir = path.join(
    current.home,
    ".local",
    "share",
    "claude",
    "versions",
  );
  const target = path.join(versionsDir, PINNED_VERSION);
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await unlink(current.executable);
  await symlink(target, current.executable);
  await assert.rejects(
    attestClaudePeerRuntime(
      { claudeExecutable: current.executable },
      {
        userInfo: () => current.user,
        runVersion: async () => {
          await unlink(current.executable);
          await symlink(target, current.executable);
          return { stdout: PINNED_VERSION_OUTPUT, stderr: "" };
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_EXECUTABLE_CHANGED",
  );
});

test("default version runner quarantines its bounded timeout", async (t) => {
  const current = await fixture(t);
  await writeFile(current.executable, "#!/bin/sh\nwhile :; do :; done\n", {
    mode: 0o700,
  });
  const runtime = await attestClaudePeerRuntime(
    { claudeExecutable: current.executable, versionTimeoutMs: 100 },
    { userInfo: () => current.user },
  );
  assert.equal(runtime.claudeCodeVersion, UNKNOWN_COMPATIBILITY_VERSION);
  assert.equal(runtime.versionEvidenceFailure, "CLAUDE_VERSION_CHECK_FAILED");
});
