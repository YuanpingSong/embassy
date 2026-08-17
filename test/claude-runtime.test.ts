import assert from "node:assert/strict";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import { attestClaudePeerRuntime } from "../src/gateway/claude-runtime.js";

const uid = process.getuid?.() ?? 501;

test("Claude runtime derives only the current user's consumed roots", async () => {
  const runtime = await attestClaudePeerRuntime({
    platform: "darwin",
    userInfo: () => ({ username: "fixture", uid, homedir: "/Users/fixture" }),
  });
  assert.deepEqual(runtime, {
    sessionsDir: "/Users/fixture/.claude/sessions",
    socketDir: "/tmp/cc-socks",
  });
  assert.equal("claudeExecutable" in runtime, false);
  assert.equal("claudeCodeVersion" in runtime, false);
});

test("Claude runtime rejects non-macOS and non-current identities", async () => {
  await assert.rejects(
    attestClaudePeerRuntime({
      platform: "linux",
      userInfo: () => ({ username: "fixture", uid, homedir: "/home/fixture" }),
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CLAUDE_PEER_PLATFORM_UNSUPPORTED",
  );
  await assert.rejects(
    attestClaudePeerRuntime({
      platform: "darwin",
      userInfo: () => ({
        username: "fixture",
        uid: uid + 1,
        homedir: "/Users/fixture",
      }),
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_LOCAL_USER_IDENTITY",
  );
});

test("Claude runtime rejects non-canonical or NUL-bearing homes", async () => {
  for (const homedir of ["relative", "/Users/fixture/..", "/Users/fixture\0x"]) {
    await assert.rejects(
      attestClaudePeerRuntime({
        platform: "darwin",
        userInfo: () => ({ username: "fixture", uid, homedir }),
      }),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "INVALID_LOCAL_USER_IDENTITY",
    );
  }
});
