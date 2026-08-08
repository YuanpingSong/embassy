import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type WebSocket from "ws";

import {
  buildLocalInitializedNotification,
  buildLocalInitializeRequest,
  buildLocalLoadedThreadListRequest,
  buildLocalProbeChildEnvironment,
  managedCodexBinaryPath,
  runLocalProbeProtocol,
  signalLocalProbeProcessGroup,
  terminateLocalProbeProcessGroup,
  validateLocalProbeHome,
  validateManagedCodexBinary,
} from "../scripts/probe-codex-local.js";

const CURRENT_THREAD = "019f9a56-9fca-75b1-80e4-48ccef693abc";
const OTHER_THREAD = "019f9a1f-93f3-7512-8815-0d140adad0f3";

class FakeProtocolSocket extends EventEmitter {
  readonly sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }
}

test("local probe sends only initialize, initialized, and loaded-list", async () => {
  const fake = new FakeProtocolSocket();
  const observed = runLocalProbeProtocol(
    fake as unknown as WebSocket,
    CURRENT_THREAD,
  );

  assert.deepEqual(fake.sent.map((value) => JSON.parse(value)), [
    JSON.parse(buildLocalInitializeRequest()),
  ]);

  fake.emit("message", Buffer.from(JSON.stringify({ id: 0, result: {} })), false);
  assert.deepEqual(fake.sent.map((value) => JSON.parse(value)), [
    JSON.parse(buildLocalInitializeRequest()),
    JSON.parse(buildLocalInitializedNotification()),
    JSON.parse(buildLocalLoadedThreadListRequest()),
  ]);

  fake.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        id: 1,
        result: { data: [OTHER_THREAD, CURRENT_THREAD] },
      }),
    ),
    false,
  );

  assert.deepEqual(await observed, {
    currentTaskLoaded: true,
    loadedThreadCount: 2,
  });
  assert.deepEqual(
    fake.sent.map((value) => JSON.parse(value).method),
    ["initialize", "initialized", "thread/loaded/list"],
  );
});

test("local protocol returns only a boolean and count when the current task is absent", async () => {
  const fake = new FakeProtocolSocket();
  const observed = runLocalProbeProtocol(
    fake as unknown as WebSocket,
    CURRENT_THREAD,
  );
  fake.emit("message", Buffer.from(JSON.stringify({ id: 0, result: {} })), false);
  fake.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, result: { data: [OTHER_THREAD] } })),
    false,
  );

  const result = await observed;
  assert.deepEqual(result, {
    currentTaskLoaded: false,
    loadedThreadCount: 1,
  });
  assert.equal(JSON.stringify(result).includes(CURRENT_THREAD), false);
  assert.equal(JSON.stringify(result).includes(OTHER_THREAD), false);
});

test("local protocol rejects malformed loaded-list data without returning it", async () => {
  const fake = new FakeProtocolSocket();
  const observed = runLocalProbeProtocol(
    fake as unknown as WebSocket,
    CURRENT_THREAD,
  );
  fake.emit("message", Buffer.from(JSON.stringify({ id: 0, result: {} })), false);
  fake.emit(
    "message",
    Buffer.from(JSON.stringify({ id: 1, result: { data: [{ secret: "discard" }] } })),
    false,
  );

  await assert.rejects(observed, { message: "LIST_SCHEMA_MISMATCH" });
});

test("local probe child environment is an explicit non-secret allowlist", () => {
  const environment = buildLocalProbeChildEnvironment("/Users/tester", {
    HOME: "/Users/tester",
    USER: "tester",
    LOGNAME: "tester",
    PATH: "/untrusted/bin:/usr/bin",
    CODEX_THREAD_ID: CURRENT_THREAD,
    ANTHROPIC_API_KEY: "must-not-pass",
    CLAUDE_CONFIG_DIR: "/must/not/pass",
    GITHUB_TOKEN: "must-not-pass",
    OPENAI_API_KEY: "must-not-pass",
    RANDOM_OAUTH_TOKEN: "must-not-pass",
    SSH_AUTH_SOCK: "/must/not/pass",
  });

  assert.equal(environment["CODEX_THREAD_ID"], undefined);
  assert.deepEqual(environment, {
    CODEX_HOME: "/Users/tester/.codex",
    HOME: "/Users/tester",
    LC_ALL: "C",
    LOGNAME: "tester",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    USER: "tester",
  });
});

test("local probe pins the managed standalone entrypoint", () => {
  assert.equal(
    managedCodexBinaryPath("/Users/tester"),
    "/Users/tester/.codex/packages/standalone/current/codex",
  );
});

test("local probe rejects a caller-selected HOME that differs from the OS login home", () => {
  assert.throws(
    () => validateLocalProbeHome("/tmp/caller-selected", "/Users/tester"),
    { message: "HOME_INVALID" },
  );
  assert.equal(
    validateLocalProbeHome("/Users/tester", "/Users/tester"),
    "/Users/tester",
  );
});

test("managed Codex validation rejects a current symlink outside releases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-local-probe-outside-"));
  const home = path.join(root, "home");
  const standalone = path.join(home, ".codex", "packages", "standalone");
  const outsideRelease = path.join(root, "outside-release");
  try {
    await mkdir(standalone, { recursive: true, mode: 0o700 });
    await mkdir(path.join(standalone, "releases"), { mode: 0o700 });
    await mkdir(outsideRelease, { recursive: true, mode: 0o700 });
    await writeFile(path.join(outsideRelease, "codex"), "not executed\n", {
      mode: 0o700,
    });
    await symlink(outsideRelease, path.join(standalone, "current"));

    await assert.rejects(validateManagedCodexBinary(home), {
      message: "MANAGED_CODEX_INVALID",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Codex validation returns the resolved versioned release binary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-local-probe-valid-"));
  const home = path.join(root, "home");
  const standalone = path.join(home, ".codex", "packages", "standalone");
  const release = path.join(standalone, "releases", "0.147.0-test");
  const releaseBinary = path.join(release, "bin", "codex");
  try {
    await mkdir(path.dirname(releaseBinary), { recursive: true, mode: 0o700 });
    await writeFile(releaseBinary, "not executed\n", { mode: 0o700 });
    await chmod(releaseBinary, 0o700);
    await symlink("bin/codex", path.join(release, "codex"));
    await symlink(
      path.join("releases", path.basename(release)),
      path.join(standalone, "current"),
    );

    assert.equal(await validateManagedCodexBinary(home), await realpath(releaseBinary));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local probe cleanup terminates only its exact detached process group", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], {
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  await once(child, "spawn");
  const processGroupId = child.pid;
  assert.ok(processGroupId !== undefined);
  let cleanupConfirmed = false;

  try {
    assert.equal(
      signalLocalProbeProcessGroup(child, processGroupId + 1, "SIGTERM"),
      false,
    );
    cleanupConfirmed = await terminateLocalProbeProcessGroup(child, processGroupId);
    assert.equal(cleanupConfirmed, true);
    assert.throws(
      () => process.kill(-processGroupId, 0),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH",
    );
  } finally {
    if (!cleanupConfirmed) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The process group may already have exited on an assertion failure.
      }
    }
  }
});
