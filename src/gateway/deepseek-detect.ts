import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  UNKNOWN_COMPATIBILITY_VERSION,
  type CompatibilityProbeResult,
  type CompatibilitySurfaceObserver,
} from "./compatibility.js";

const VERSION_TIMEOUT_MS = 3_000;
const VERSION_OUTPUT_BYTES = 4_096;
const STABLE_VERSION = /(?:^|\s)([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})(?=$|\s)/u;

type VersionRunner = (
  executable: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export type DeepSeekDetectOptions = Readonly<{
  env: NodeJS.ProcessEnv;
  loginHome: string;
  expectedUid?: number;
  lstat?: typeof lstat;
  runVersion?: VersionRunner;
}>;

async function defaultRunVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        cwd: path.dirname(executable),
        env,
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}

function failed(name: CompatibilityProbeResult["name"], safeErrorCode: string) {
  return { name, outcome: "fail" as const, safeErrorCode };
}

function observer(
  version: string,
  probes: readonly CompatibilityProbeResult[],
): CompatibilitySurfaceObserver {
  return {
    compatibilitySurface: () => ({ surface: "deepseek", version }),
    runCompatibilityProbes: async () => probes.map((probe) => ({ ...probe })),
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Detects one local harness without opening its runtime or home contents. */
export async function detectDeepSeekSurface(
  options: DeepSeekDetectOptions,
): Promise<CompatibilitySurfaceObserver | undefined> {
  const inspect = options.lstat ?? lstat;
  const runVersion = options.runVersion ?? defaultRunVersion;
  const expectedUid = options.expectedUid ?? process.getuid?.();
  let executable: string | undefined;
  let executableStat: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const directory of (options.env.PATH ?? "").split(path.delimiter)) {
    if (
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      directory.includes("\0")
    ) continue;
    const candidate = path.join(directory, "dsh");
    try {
      executableStat = await inspect(candidate);
      executable = candidate;
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  if (executable === undefined || executableStat === undefined) return undefined;

  const installationSafe =
    expectedUid !== undefined &&
    !executableStat.isSymbolicLink() &&
    executableStat.isFile() &&
    executableStat.uid === expectedUid &&
    (Number(executableStat.mode) & 0o111) !== 0;
  const probes: CompatibilityProbeResult[] = [
    installationSafe
      ? { name: "installation", outcome: "pass" }
      : failed("installation", "DEEPSEEK_HARNESS_INSTALLATION_UNSAFE"),
  ];

  const configuredHome = options.env.DSH_HOME;
  const harnessHome = configuredHome ?? path.join(options.loginHome, ".dsh");
  let homeSafe = false;
  if (
    path.isAbsolute(harnessHome) &&
    path.resolve(harnessHome) === harnessHome &&
    !harnessHome.includes("\0")
  ) {
    try {
      const homeStat = await inspect(harnessHome);
      homeSafe =
        expectedUid !== undefined &&
        !homeStat.isSymbolicLink() &&
        homeStat.isDirectory() &&
        homeStat.uid === expectedUid &&
        (Number(homeStat.mode) & 0o022) === 0;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  probes.push(
    homeSafe
      ? { name: "harness_home", outcome: "pass" }
      : failed("harness_home", "DEEPSEEK_HARNESS_HOME_UNSAFE"),
  );

  if (!installationSafe || !homeSafe) {
    probes.push(failed("version", "DEEPSEEK_HARNESS_VERSION_UNOBSERVED"));
    return observer(UNKNOWN_COMPATIBILITY_VERSION, probes);
  }
  try {
    const output = await runVersion(executable, {
      HOME: options.loginHome,
      DSH_HOME: harnessHome,
      PATH: [path.dirname(executable), "/usr/bin", "/bin"].join(path.delimiter),
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      TERM: "dumb",
    });
    const version = STABLE_VERSION.exec(output)?.[1];
    probes.push(
      version === undefined
        ? failed("version", "DEEPSEEK_HARNESS_VERSION_UNPARSEABLE")
        : { name: "version", outcome: "pass" },
    );
    return observer(version ?? UNKNOWN_COMPATIBILITY_VERSION, probes);
  } catch {
    probes.push(failed("version", "DEEPSEEK_HARNESS_VERSION_CHECK_FAILED"));
    return observer(UNKNOWN_COMPATIBILITY_VERSION, probes);
  }
}
