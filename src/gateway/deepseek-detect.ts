import { lstat } from "node:fs/promises";
import path from "node:path";

import type { AcpLaunchSpec } from "./acp-client.js";

export type DeepSeekDetectOptions = Readonly<{
  env: NodeJS.ProcessEnv;
  loginHome: string;
  expectedUid?: number;
  lstat?: typeof lstat;
}>;

export type DeepSeekAcpLaunch = Readonly<{
  launch?: AcpLaunchSpec;
  safeErrorCode?: string;
}>;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Attests only the checkout boundary; no credential or version file is read. */
export async function resolveDeepSeekAcpLaunch(
  options: DeepSeekDetectOptions,
): Promise<DeepSeekAcpLaunch> {
  const root = options.env.DSH_HOME ?? path.join(options.loginHome, ".dsh");
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0")) {
    return { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNAVAILABLE" };
  }
  const inspect = options.lstat ?? lstat;
  const uid = options.expectedUid ?? process.getuid?.();
  try {
    const [home, manifest] = await Promise.all([
      inspect(root),
      inspect(path.join(root, "package.json")),
    ]);
    if (
      uid === undefined || home.isSymbolicLink() || !home.isDirectory() ||
      home.uid !== uid || (Number(home.mode) & 0o022) !== 0 ||
      manifest.isSymbolicLink() || !manifest.isFile() || manifest.uid !== uid
    ) {
      return { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE" };
    }
  } catch (error) {
    if (missing(error)) {
      return { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNAVAILABLE" };
    }
    return { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE" };
  }
  return {
    launch: {
      kind: "local-checkout",
      command: "pnpm",
      args: ["--dir", root, "run", "demo:acp"],
      cwd: root,
    },
  };
}
