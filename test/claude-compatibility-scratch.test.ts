import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { startClaudeCompatibilityScratch } from "../src/gateway/claude-compatibility-scratch.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const exit = (signal: NodeJS.Signals | null): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = signal === null ? 0 : null;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, child.signalCode);
  };
  child.kill = (signal = "SIGTERM") => {
    exit(typeof signal === "string" ? signal : "SIGTERM");
    return true;
  };
  child.stdin.once("finish", () => queueMicrotask(() => exit(null)));
  return child;
}

test("Claude certification scratch uses one scrubbed no-input print session and exact cleanup", async () => {
  const child = fakeChild();
  let invocation:
    | {
        command: string;
        args: readonly string[];
        options: Record<string, unknown>;
      }
    | undefined;
  const started = startClaudeCompatibilityScratch(
    {
      claudeExecutable: "/Users/synthetic/.local/bin/claude",
      claudeCodeVersion: "2.1.226",
      sessionsDir: "/Users/synthetic/.claude/sessions",
      socketDir: "/private/tmp/synthetic-sockets",
    },
    {
      userInfo: () => ({
        homedir: "/Users/synthetic",
        username: "synthetic",
      }),
      spawn: (command, args, options) => {
        invocation = {
          command,
          args: [...args],
          options: options as unknown as Record<string, unknown>,
        };
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    },
  );
  const scratch = await started;
  assert.equal(invocation?.command, "/Users/synthetic/.local/bin/claude");
  assert.deepEqual(
    invocation?.args.slice(0, 5),
    ["--print", "--input-format", "stream-json", "--output-format", "stream-json"],
  );
  assert.ok(invocation?.args.includes("--no-session-persistence"));
  assert.ok(invocation?.args.includes("--strict-mcp-config"));
  assert.ok(invocation?.args.includes('{"crossSessionInbound":"accept"}'));
  assert.match(scratch.name, /^embassy-compat-[a-f0-9]{12}$/);
  assert.match(
    scratch.sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const env = invocation?.options.env as NodeJS.ProcessEnv;
  assert.deepEqual(Object.keys(env).sort(), [
    "HOME",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
  ]);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  scratch.assertRunning();
  await Promise.all([scratch.close(), scratch.close()]);
  assert.equal(child.exitCode, 0);
});
