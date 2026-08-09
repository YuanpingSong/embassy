import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { CLAUDE_PEER_COMPATIBILITY } from "./claude-peer.js";

const MAX_VERSION_OUTPUT_BYTES = 4_096;
const VERSION_OUTPUT_PATTERN = new RegExp(
  `^${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion.replaceAll(".", "\\.")} \\(Claude Code\\)\\r?\\n?$`,
);
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type ClaudePeerRuntimeOptions = {
  /** Trusted operator configuration; there is no PATH-based lookup. */
  claudeExecutable: string;
  versionTimeoutMs?: number;
};

export type AttestedClaudePeerRuntime = {
  claudeExecutable: string;
  claudeCodeVersion: typeof CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion;
  sessionsDir: string;
  socketDir: string;
};

export type ClaudeVersionCommand = {
  executable: string;
  args: readonly ["--version"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ClaudeVersionCommandResult = {
  stdout: string;
  stderr: string;
};

export type ClaudeVersionRunner = (
  command: ClaudeVersionCommand,
) => Promise<ClaudeVersionCommandResult>;

type RuntimeUser = {
  username: string;
  uid: number;
  homedir: string;
};

/** Deterministic seams only; never populate from runtime or user config. */
export type ClaudePeerRuntimeTestOverrides = {
  userInfo?: () => RuntimeUser;
  platform?: NodeJS.Platform;
  runVersion?: ClaudeVersionRunner;
};

type ExecutableGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
};

type ExecutableAttestation = {
  executable: string;
  configuredGeneration: ExecutableGeneration;
  executableGeneration: ExecutableGeneration;
  linkTarget?: string;
};

function exactMode(mode: number): number {
  return mode & 0o7777;
}

function executableGeneration(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
}): ExecutableGeneration {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: exactMode(stat.mode),
    uid: stat.uid,
  };
}

function sameExecutableGeneration(
  left: ExecutableGeneration,
  right: ExecutableGeneration,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? 2_000;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > 10_000
  ) {
    throw new BridgeError(
      "INVALID_CLAUDE_VERSION_TIMEOUT",
      "The Claude version timeout must be an integer from 100 through 10000 milliseconds.",
    );
  }
  return timeout;
}

function validateRuntimeUser(user: RuntimeUser): RuntimeUser {
  if (
    !USERNAME_PATTERN.test(user.username) ||
    !Number.isSafeInteger(user.uid) ||
    user.uid < 0 ||
    !path.isAbsolute(user.homedir) ||
    path.resolve(user.homedir) !== user.homedir ||
    user.homedir.includes("\0")
  ) {
    throw new BridgeError(
      "INVALID_LOCAL_USER_IDENTITY",
      "The operating-system user identity is not suitable for the local Claude peer bridge.",
    );
  }
  if (process.getuid === undefined || process.getuid() !== user.uid) {
    throw new BridgeError(
      "LOCAL_USER_IDENTITY_MISMATCH",
      "The Claude peer runtime must run as the attested operating-system user.",
    );
  }
  return user;
}

function validateConfiguredExecutable(
  configured: string,
  home: string,
): string {
  if (
    !path.isAbsolute(configured) ||
    path.resolve(configured) !== configured ||
    configured.includes("\0") ||
    configured.includes(path.delimiter) ||
    path.basename(configured) !== "claude"
  ) {
    throw new BridgeError(
      "INVALID_CLAUDE_EXECUTABLE",
      "The trusted Claude executable must be an absolute normalized path to a file named claude.",
    );
  }
  const relative = path.relative(home, configured);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new BridgeError(
      "CLAUDE_EXECUTABLE_OUTSIDE_HOME",
      "The local Claude executable must remain inside the operating-system user's home directory.",
    );
  }
  const firstSegment = relative.split(path.sep)[0];
  if (
    firstSegment === undefined ||
    [".claude", ".ssh", ".gnupg", ".aws", ".config"].includes(
      firstSegment,
    )
  ) {
    throw new BridgeError(
      "CLAUDE_EXECUTABLE_IN_SENSITIVE_ROOT",
      "The Claude executable cannot be loaded from a sensitive configuration directory.",
    );
  }
  return configured;
}

function assertSafeExecutableStat(
  stat: Stats,
): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (exactMode(stat.mode) & 0o022) !== 0 ||
    (exactMode(stat.mode) & 0o111) === 0 ||
    (exactMode(stat.mode) & 0o6000) !== 0
  ) {
    throw new BridgeError(
      "UNSAFE_CLAUDE_EXECUTABLE",
      "The Claude executable must be a non-writable regular executable without set-id mode bits.",
    );
  }
}

async function attestRegularExecutable(
  executable: string,
  user: RuntimeUser,
): Promise<ExecutableGeneration> {
  const relative = path.relative(user.homedir, executable);
  const segments = relative.split(path.sep);
  let cursor = user.homedir;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment === "" || segment === ".") {
      throw new BridgeError(
        "INVALID_CLAUDE_EXECUTABLE",
        "The Claude executable path is malformed.",
      );
    }
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor);
    const isLeaf = index === segments.length - 1;
    if (
      stat.isSymbolicLink() ||
      stat.uid !== user.uid ||
      (exactMode(stat.mode) & 0o022) !== 0 ||
      (isLeaf ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new BridgeError(
        "UNSAFE_CLAUDE_EXECUTABLE",
        "The Claude executable path failed its type, owner, mode, or symlink policy.",
      );
    }
    if (isLeaf) {
      assertSafeExecutableStat(stat);
      return executableGeneration(stat);
    }
  }
  throw new BridgeError(
    "INVALID_CLAUDE_EXECUTABLE",
    "The Claude executable path is malformed.",
  );
}

async function attestExecutablePath(
  configuredExecutable: string,
  user: RuntimeUser,
): Promise<ExecutableAttestation> {
  const homeStat = await lstat(user.homedir);
  if (
    homeStat.isSymbolicLink() ||
    !homeStat.isDirectory() ||
    homeStat.uid !== user.uid ||
    (exactMode(homeStat.mode) & 0o022) !== 0
  ) {
    throw new BridgeError(
      "UNSAFE_LOCAL_HOME",
      "The operating-system home directory failed its ownership policy.",
    );
  }

  const relative = path.relative(user.homedir, configuredExecutable);
  const segments = relative.split(path.sep);
  let cursor = user.homedir;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment === "" || segment === ".") {
      throw new BridgeError(
        "INVALID_CLAUDE_EXECUTABLE",
        "The Claude executable path is malformed.",
      );
    }
    cursor = path.join(cursor, segment);
    const stat = await lstat(cursor);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf) {
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.uid !== user.uid ||
        (exactMode(stat.mode) & 0o022) !== 0
      ) {
        throw new BridgeError(
          "UNSAFE_CLAUDE_EXECUTABLE",
          "The Claude executable path failed its directory ownership or symlink policy.",
        );
      }
      continue;
    }

    if (!stat.isSymbolicLink()) {
      if (stat.uid !== user.uid) {
        throw new BridgeError(
          "UNSAFE_CLAUDE_EXECUTABLE",
          "The Claude executable path failed its owner policy.",
        );
      }
      assertSafeExecutableStat(stat);
      const generation = executableGeneration(stat);
      return {
        executable: configuredExecutable,
        configuredGeneration: generation,
        executableGeneration: generation,
      };
    }

    const officialLink = path.join(user.homedir, ".local", "bin", "claude");
    const officialTarget = path.join(
      user.homedir,
      ".local",
      "share",
      "claude",
      "versions",
      CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
    );
    if (configuredExecutable !== officialLink || stat.uid !== user.uid) {
      throw new BridgeError(
        "UNSAFE_CLAUDE_EXECUTABLE",
        "Only the exact owned official Claude launcher symlink is supported.",
      );
    }
    const configuredGeneration = executableGeneration(stat);
    const linkTarget = await readlink(configuredExecutable);
    if (
      !path.isAbsolute(linkTarget) ||
      path.resolve(linkTarget) !== linkTarget ||
      path.dirname(linkTarget) !==
        path.join(user.homedir, ".local", "share", "claude", "versions")
    ) {
      throw new BridgeError(
        "UNSAFE_CLAUDE_EXECUTABLE",
        "The official Claude launcher symlink target is outside its pinned version directory.",
      );
    }
    if (
      linkTarget !== officialTarget ||
      path.basename(linkTarget) !==
        CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion
    ) {
      // A version-shaped target inside the official versions directory that
      // is not the pinned version is drift from an auto-update, not
      // tampering. Still fail closed, but say what happened and how to move
      // forward. Only a strictly version-shaped basename is ever reflected.
      const foundVersion = /^\d+\.\d+\.\d+$/.test(path.basename(linkTarget))
        ? path.basename(linkTarget)
        : undefined;
      if (foundVersion !== undefined) {
        throw new BridgeError(
          "CLAUDE_VERSION_DRIFT",
          `Installed Claude Code is ${foundVersion}; this Embassy build is pinned to ${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion}. Update Embassy, then run embassy health.`,
        );
      }
      throw new BridgeError(
        "UNSAFE_CLAUDE_EXECUTABLE",
        "The official Claude launcher symlink target is outside its pinned version directory.",
      );
    }
    const linkAfterRead = await lstat(configuredExecutable);
    if (
      !linkAfterRead.isSymbolicLink() ||
      !sameExecutableGeneration(
        configuredGeneration,
        executableGeneration(linkAfterRead),
      )
    ) {
      throw new BridgeError(
        "CLAUDE_EXECUTABLE_CHANGED",
        "The Claude launcher symlink changed during attestation.",
      );
    }
    const targetGeneration = await attestRegularExecutable(linkTarget, user);
    return {
      executable: linkTarget,
      configuredGeneration,
      executableGeneration: targetGeneration,
      linkTarget,
    };
  }
  throw new BridgeError(
    "INVALID_CLAUDE_EXECUTABLE",
    "The Claude executable path is malformed.",
  );
}

export function buildClaudeVersionEnvironment(
  user: RuntimeUser,
  executable: string,
): NodeJS.ProcessEnv {
  return {
    HOME: user.homedir,
    USER: user.username,
    LOGNAME: user.username,
    PATH: [
      path.dirname(executable),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter),
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

async function runVersionCommand(
  command: ClaudeVersionCommand,
): Promise<ClaudeVersionCommandResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      command.executable,
      [...command.args],
      {
        cwd: command.cwd,
        env: command.env,
        encoding: "utf8",
        timeout: command.timeoutMs,
        maxBuffer: command.maxOutputBytes,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new BridgeError(
              "CLAUDE_VERSION_CHECK_FAILED",
              "The bounded Claude Code version check failed without accessing provider state.",
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function attestClaudePeerRuntime(
  options: ClaudePeerRuntimeOptions,
  testing: ClaudePeerRuntimeTestOverrides = {},
): Promise<AttestedClaudePeerRuntime> {
  const platform = testing.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new BridgeError(
      "CLAUDE_PEER_PLATFORM_UNSUPPORTED",
      "Claude peer messaging is supported only on macOS and Linux.",
    );
  }
  const user = validateRuntimeUser(
    (testing.userInfo ?? os.userInfo)() as RuntimeUser,
  );
  const configuredExecutable = validateConfiguredExecutable(
    options.claudeExecutable,
    user.homedir,
  );
  const before = await attestExecutablePath(configuredExecutable, user);
  const executable = before.executable;
  const command: ClaudeVersionCommand = {
    executable,
    args: ["--version"],
    cwd: user.homedir,
    env: buildClaudeVersionEnvironment(user, executable),
    timeoutMs: boundedTimeout(options.versionTimeoutMs),
    maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
  };
  let output: ClaudeVersionCommandResult;
  try {
    output = await (testing.runVersion ?? runVersionCommand)(command);
  } catch (error) {
    if (
      error instanceof BridgeError &&
      error.code === "CLAUDE_VERSION_CHECK_FAILED"
    ) {
      throw error;
    }
    throw new BridgeError(
      "CLAUDE_VERSION_CHECK_FAILED",
      "The bounded Claude Code version check failed without accessing provider state.",
    );
  }
  if (
    Buffer.byteLength(output.stdout, "utf8") > MAX_VERSION_OUTPUT_BYTES ||
    Buffer.byteLength(output.stderr, "utf8") > MAX_VERSION_OUTPUT_BYTES ||
    output.stderr.length !== 0 ||
    !VERSION_OUTPUT_PATTERN.test(output.stdout)
  ) {
    // Well-formed output for a different version is auto-update drift and
    // gets the actionable code; anything else stays the strict refusal.
    const drifted =
      output.stderr.length === 0 &&
      Buffer.byteLength(output.stdout, "utf8") <= MAX_VERSION_OUTPUT_BYTES
        ? /^(\d+\.\d+\.\d+) \(Claude Code\)\r?\n?$/.exec(output.stdout)
        : null;
    if (drifted !== null) {
      throw new BridgeError(
        "CLAUDE_VERSION_DRIFT",
        `Installed Claude Code reports ${drifted[1]}; this Embassy build is pinned to ${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion}. Update Embassy, then run embassy health.`,
      );
    }
    throw new BridgeError(
      "CLAUDE_PEER_VERSION_UNSUPPORTED",
      `Claude peer compatibility is pinned to Claude Code ${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion}.`,
    );
  }
  const after = await attestExecutablePath(configuredExecutable, user);
  if (
    before.executable !== after.executable ||
    before.linkTarget !== after.linkTarget ||
    !sameExecutableGeneration(
      before.configuredGeneration,
      after.configuredGeneration,
    ) ||
    !sameExecutableGeneration(
      before.executableGeneration,
      after.executableGeneration,
    )
  ) {
    throw new BridgeError(
      "CLAUDE_EXECUTABLE_CHANGED",
      "The Claude executable changed during version attestation.",
    );
  }

  return {
    claudeExecutable: executable,
    claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
    sessionsDir: path.join(user.homedir, ".claude", "sessions"),
    socketDir: path.join(path.sep, "tmp", "cc-socks"),
  };
}
