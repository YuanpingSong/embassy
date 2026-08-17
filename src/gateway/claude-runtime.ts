import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";

type RuntimeUser = Readonly<{ username: string; uid: number; homedir: string }>;

export type AttestedClaudePeerRuntime = Readonly<{
  sessionsDir: string;
  socketDir: string;
}>;

/** Deterministic seams only; never populate from runtime or user config. */
export type ClaudePeerRuntimeTestOverrides = Readonly<{
  userInfo?: () => RuntimeUser;
  platform?: NodeJS.Platform;
}>;

/**
 * Derive only the provider artifacts Embassy actually consumes. Claude's
 * launcher and version are unrelated to registry/socket authority.
 */
export async function attestClaudePeerRuntime(
  testing: ClaudePeerRuntimeTestOverrides = {},
): Promise<AttestedClaudePeerRuntime> {
  if ((testing.platform ?? process.platform) !== "darwin") {
    throw new BridgeError(
      "CLAUDE_PEER_PLATFORM_UNSUPPORTED",
      "Claude peer messaging is supported only on macOS.",
    );
  }
  const user = (testing.userInfo ?? os.userInfo)() as RuntimeUser;
  if (
    process.getuid === undefined ||
    !Number.isSafeInteger(user.uid) ||
    user.uid < 0 ||
    process.getuid() !== user.uid ||
    !path.isAbsolute(user.homedir) ||
    path.resolve(user.homedir) !== user.homedir ||
    user.homedir.includes("\0")
  ) {
    throw new BridgeError(
      "INVALID_LOCAL_USER_IDENTITY",
      "The operating-system user identity is not suitable for the local Claude peer bridge.",
    );
  }
  return Object.freeze({
    sessionsDir: path.join(user.homedir, ".claude", "sessions"),
    socketDir: "/tmp/cc-socks",
  });
}
