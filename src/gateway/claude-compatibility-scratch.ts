import { randomBytes, randomUUID } from "node:crypto";
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";

const MAX_SCRATCH_OUTPUT_BYTES = 64 * 1024;
const SCRATCH_START_TIMEOUT_MS = 2_000;
const SCRATCH_CLOSE_TIMEOUT_MS = 2_000;

export type ClaudeCompatibilityScratch = Readonly<{
  name: string;
  sessionId: string;
  assertRunning: () => void;
  close: () => Promise<void>;
}>;

export type ClaudeCompatibilityScratchFactory =
  () => Promise<ClaudeCompatibilityScratch>;

type ScratchDependencies = Readonly<{
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  userInfo?: () => { homedir: string; username: string };
}>;

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("scratch spawn timeout"));
    }, SCRATCH_START_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("scratch exited before ready"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function startClaudeCompatibilityScratch(
  runtime: AttestedClaudePeerRuntime,
  dependencies: ScratchDependencies = {},
): Promise<ClaudeCompatibilityScratch> {
  const user = (dependencies.userInfo ?? os.userInfo)();
  if (
    !path.isAbsolute(user.homedir) ||
    path.normalize(user.homedir) !== user.homedir ||
    user.homedir.includes("\0") ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(user.username)
  ) {
    throw new BridgeError(
      "CLAUDE_CERTIFICATION_USER_INVALID",
      "The bounded Claude certification scratch requires one canonical local user.",
    );
  }
  const sessionId = randomUUID();
  const name = `embassy-compat-${randomBytes(6).toString("hex")}`;
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    sessionId,
    "--name",
    name,
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--settings",
    '{"crossSessionInbound":"accept"}',
  ] as const;
  const spawn = dependencies.spawn ??
    ((command, argv, options) =>
      nodeSpawn(command, [...argv], options) as ChildProcessWithoutNullStreams);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(runtime.claudeExecutable, args, {
      cwd: user.homedir,
      detached: false,
      env: {
        HOME: user.homedir,
        USER: user.username,
        LOGNAME: user.username,
        SHELL: "/bin/zsh",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: os.tmpdir(),
      },
      shell: false,
      stdio: "pipe",
    });
  } catch {
    throw new BridgeError(
      "CLAUDE_CERTIFICATION_SCRATCH_UNAVAILABLE",
      "The bounded Claude certification scratch could not start.",
      true,
    );
  }

  let outputBytes = 0;
  let outputOverflow = false;
  const observeOutput = (chunk: Buffer | string): void => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_SCRATCH_OUTPUT_BYTES && !outputOverflow) {
      outputOverflow = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", observeOutput);
  child.stderr.on("data", observeOutput);
  try {
    await waitForSpawn(child);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, SCRATCH_CLOSE_TIMEOUT_MS);
    throw new BridgeError(
      "CLAUDE_CERTIFICATION_SCRATCH_UNAVAILABLE",
      "The bounded Claude certification scratch did not become ready.",
      true,
    );
  }

  let closeOperation: Promise<void> | undefined;
  return {
    name,
    sessionId,
    assertRunning: () => {
      if (
        outputOverflow ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new BridgeError(
          "CLAUDE_CERTIFICATION_SCRATCH_EXITED",
          "The bounded Claude certification scratch exited before settlement.",
          true,
        );
      }
    },
    close: () => {
      closeOperation ??= (async () => {
        child.stdin.end();
        if (await waitForExit(child, SCRATCH_CLOSE_TIMEOUT_MS)) return;
        child.kill("SIGTERM");
        if (await waitForExit(child, SCRATCH_CLOSE_TIMEOUT_MS)) return;
        child.kill("SIGKILL");
        await waitForExit(child, SCRATCH_CLOSE_TIMEOUT_MS);
      })();
      return closeOperation;
    },
  };
}
