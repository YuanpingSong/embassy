import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import {
  buildLoadedThreadListRequest,
  buildProbeSshArguments,
  buildProbeSshEnvironment,
  classifyLoadedThreadListError,
  classifyProbeObservationOutcome,
  commandHasExactToken,
  commandIsDesktopProxy,
  signalProbeProcessGroup,
  terminateProbeProcessGroup,
} from "../scripts/probe-codex-remote.js";

test("remote probe uses the Codex 0.145-compatible loaded-list parameter object", () => {
  assert.deepEqual(JSON.parse(buildLoadedThreadListRequest()), {
    id: 1,
    method: "thread/loaded/list",
    params: {},
  });
  assert.equal(
    classifyLoadedThreadListError({ code: -32601, message: "discarded" }),
    "LIST_METHOD_UNAVAILABLE",
  );
  assert.equal(
    classifyLoadedThreadListError({ code: -32602, message: "discarded" }),
    "LIST_INVALID_PARAMS",
  );
  assert.equal(
    classifyLoadedThreadListError({ code: -32000, message: "discarded" }),
    "LIST_REJECTED",
  );
  assert.equal(
    classifyProbeObservationOutcome({
      cleanupConfirmed: true,
      desktopProxyStillAlive: true,
      gracefulCleanupConfirmed: true,
      loadedThreadCount: 2,
    }),
    "graceful",
  );
  assert.equal(
    classifyProbeObservationOutcome({
      cleanupConfirmed: true,
      desktopProxyStillAlive: true,
      gracefulCleanupConfirmed: false,
      loadedThreadCount: 2,
    }),
    "forced",
  );
  assert.equal(
    classifyProbeObservationOutcome({
      cleanupConfirmed: false,
      desktopProxyStillAlive: true,
      gracefulCleanupConfirmed: false,
      loadedThreadCount: 2,
    }),
    "failed",
  );
  assert.equal(
    classifyProbeObservationOutcome({
      cleanupConfirmed: true,
      desktopProxyStillAlive: true,
      gracefulCleanupConfirmed: false,
      loadedThreadCount: null,
    }),
    "failed",
  );
});

test("remote probe SSH environment is an explicit non-secret allowlist", () => {
  const environment = buildProbeSshEnvironment({
    HOME: "/Users/tester",
    USER: "tester",
    LOGNAME: "tester",
    SHELL: "/bin/zsh",
    SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
    PATH: "/untrusted/bin:/usr/bin",
    ANTHROPIC_API_KEY: "must-not-pass",
    CLAUDE_CONFIG_DIR: "/must/not/pass",
    CODEX_HOME: "/must/not/pass",
    GITHUB_TOKEN: "must-not-pass",
    OPENAI_API_KEY: "must-not-pass",
    RANDOM_OAUTH_TOKEN: "must-not-pass",
  });

  assert.deepEqual(environment, {
    HOME: "/Users/tester",
    LC_ALL: "C",
    LOGNAME: "tester",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/zsh",
    SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
    USER: "tester",
  });
});

test("remote probe SSH arguments disable environment and connection forwarding", () => {
  const args = buildProbeSshArguments("m5dev", "safe-remote-command");

  assert.ok(args.includes("SendEnv=-*"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("PermitLocalCommand=no"));
  assert.deepEqual(args.slice(-2), ["m5dev", "safe-remote-command"]);
});

test("remote proxy discovery matches a complete host argument", () => {
  const command = "/usr/bin/ssh -T m5dev exec codex app-server proxy";

  assert.equal(commandHasExactToken(command, "m5dev"), true);
  assert.equal(commandHasExactToken(command, "m5"), false);
  assert.equal(commandHasExactToken(command, "dev"), false);
  assert.equal(commandIsDesktopProxy(command, "m5dev"), true);
  assert.equal(
    commandIsDesktopProxy("/usr/bin/ssh -T m5dev sh -c 'exec codex app-server proxy'", "m5dev"),
    true,
  );
  assert.equal(commandIsDesktopProxy(command, "m5"), false);
});

test("remote probe cleanup terminates only its exact detached process group", async () => {
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

  try {
    assert.equal(
      signalProbeProcessGroup(child, processGroupId + 1, "SIGTERM"),
      false,
    );
    assert.equal(
      await terminateProbeProcessGroup(child, processGroupId),
      true,
    );
    assert.throws(
      () => process.kill(-processGroupId, 0),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH",
    );
  } finally {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The expected path has already confirmed the owned group is gone.
    }
  }
});
