import type { Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  isCompatibilityVersion,
  UNKNOWN_COMPATIBILITY_VERSION,
} from "./compatibility.js";

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type ClaudePeerRuntimeOptions = {
  /** Trusted operator configuration; there is no PATH-based lookup. */
  claudeExecutable: string;
};

export type AttestedClaudePeerRuntime = {
  claudeExecutable: string;
  claudeCodeVersion: string;
  sessionsDir: string;
  socketDir: string;
};

type RuntimeUser = {
  username: string;
  uid: number;
  homedir: string;
};

/** Deterministic seams only; never populate from runtime or user config. */
export type ClaudePeerRuntimeTestOverrides = {
  userInfo?: () => RuntimeUser;
  platform?: NodeJS.Platform;
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
      return {
        executable: configuredExecutable,
      };
    }

    const officialLink = path.join(user.homedir, ".local", "bin", "claude");
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
        "The official Claude launcher symlink target is outside its versions directory.",
      );
    }
    const targetVersion = path.basename(linkTarget);
    if (!isCompatibilityVersion(targetVersion)) {
      throw new BridgeError(
        "UNSAFE_CLAUDE_EXECUTABLE",
        "The official Claude launcher symlink target is not a versioned executable.",
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
    await attestRegularExecutable(linkTarget, user);
    return {
      executable: linkTarget,
      linkTarget,
    };
  }
  throw new BridgeError(
    "INVALID_CLAUDE_EXECUTABLE",
    "The Claude executable path is malformed.",
  );
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
  const attested = await attestExecutablePath(
    configuredExecutable,
    user,
  );

  return {
    claudeExecutable: attested.executable,
    claudeCodeVersion:
      attested.linkTarget === undefined
        ? UNKNOWN_COMPATIBILITY_VERSION
        : path.basename(attested.linkTarget),
    sessionsDir: path.join(user.homedir, ".claude", "sessions"),
    socketDir: path.join(path.sep, "tmp", "cc-socks"),
  };
}
