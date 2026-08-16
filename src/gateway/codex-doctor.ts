import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CODEX_DOCTOR_MAX_PROCESSES = 512;
export const CODEX_DOCTOR_MAX_SOCKET_HOLDERS = 32;

export type CodexDoctorCondition =
  | "split_brain"
  | "orphaned"
  | "attached"
  | "unknown";

export type CodexDoctorProcess = Readonly<{
  pid: number;
  parentPid?: number;
  executablePath: string;
  bundleIdentifier?: string;
}>;

export type CodexDoctorInspection = Readonly<{
  processes: readonly CodexDoctorProcess[];
  socketHolderPids: readonly number[];
}>;

export type CodexDoctorInspector = Readonly<{
  inspect(request: Readonly<{
    socketPath: string;
    maximumProcesses: number;
    maximumSocketHolders: number;
  }>): Promise<CodexDoctorInspection>;
}>;

export type CodexDoctorOptions = Readonly<{
  socketPath: string;
  daemonExecutablePath: string;
  embassyPid: number;
  inspector: CodexDoctorInspector;
}>;

export type CodexDoctorResult = Readonly<{
  conditions: readonly CodexDoctorCondition[];
}>;

const execFileAsync = promisify(execFile);
const MAX_INSPECTOR_OUTPUT_BYTES = 64 * 1024;
const INSPECTOR_TIMEOUT_MS = 2_000;

const UNKNOWN: CodexDoctorResult = Object.freeze({ conditions: ["unknown"] });

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isDesktop(process: CodexDoctorProcess): boolean {
  return process.bundleIdentifier === "com.openai.codex" &&
    /^\/Applications\/[^/]+\.app\/.+/.test(process.executablePath);
}

function ownedByEmbassy(
  pid: number,
  embassyPid: number,
  processes: ReadonlyMap<number, CodexDoctorProcess>,
): boolean {
  const visited = new Set<number>();
  let current = pid;
  while (!visited.has(current) && visited.size <= processes.size) {
    if (current === embassyPid) return true;
    visited.add(current);
    const parent = processes.get(current)?.parentPid;
    if (parent === undefined || !validPid(parent) || parent === current) return false;
    current = parent;
  }
  return false;
}

function classify(
  inspection: CodexDoctorInspection,
  options: Pick<CodexDoctorOptions, "daemonExecutablePath" | "embassyPid">,
): CodexDoctorResult {
  if (
    inspection.processes.length > CODEX_DOCTOR_MAX_PROCESSES ||
    inspection.socketHolderPids.length > CODEX_DOCTOR_MAX_SOCKET_HOLDERS
  ) {
    return UNKNOWN;
  }

  const processes = new Map<number, CodexDoctorProcess>();
  for (const process of inspection.processes) {
    if (
      !validPid(process.pid) ||
      typeof process.executablePath !== "string" ||
      process.executablePath.includes("\0") ||
      processes.has(process.pid) ||
      (process.parentPid !== undefined && !validPid(process.parentPid))
    ) {
      return UNKNOWN;
    }
    processes.set(process.pid, process);
  }

  const holders = new Set<number>();
  for (const pid of inspection.socketHolderPids) {
    if (!validPid(pid)) return UNKNOWN;
    holders.add(pid);
  }

  const daemonHolders = [...holders].filter((pid) =>
    processes.get(pid)?.executablePath === options.daemonExecutablePath
  );
  if (daemonHolders.length !== 1) return UNKNOWN;

  const externalHolders: CodexDoctorProcess[] = [];
  for (const pid of holders) {
    if (pid === daemonHolders[0] || ownedByEmbassy(pid, options.embassyPid, processes)) {
      continue;
    }
    const process = processes.get(pid);
    if (process === undefined) return UNKNOWN;
    externalHolders.push(process);
  }

  if (externalHolders.some(isDesktop)) {
    return { conditions: ["attached"] };
  }
  if (externalHolders.length > 0) return UNKNOWN;
  return {
    conditions: [inspection.processes.some(isDesktop) ? "split_brain" : "orphaned"],
  };
}

/** Returns only bounded public-safe state; process inspection failures stay provider-local. */
export async function diagnoseCodexAttachment(
  options: CodexDoctorOptions,
): Promise<CodexDoctorResult> {
  if (
    options.socketPath.length === 0 || options.socketPath.includes("\0") ||
    !options.daemonExecutablePath.startsWith("/") ||
    options.daemonExecutablePath.includes("\0") ||
    !validPid(options.embassyPid)
  ) {
    return UNKNOWN;
  }
  try {
    return classify(await options.inspector.inspect({
      socketPath: options.socketPath,
      maximumProcesses: CODEX_DOCTOR_MAX_PROCESSES,
      maximumSocketHolders: CODEX_DOCTOR_MAX_SOCKET_HOLDERS,
    }), options);
  } catch {
    return UNKNOWN;
  }
}

/** Bounded macOS process evidence. Raw output never leaves this module. */
export function createSystemCodexDoctorInspector(): CodexDoctorInspector {
  return {
    inspect: async ({ socketPath, maximumProcesses, maximumSocketHolders }) => {
      const options = {
        encoding: "utf8" as const,
        maxBuffer: MAX_INSPECTOR_OUTPUT_BYTES,
        timeout: INSPECTOR_TIMEOUT_MS,
      };
      const [{ stdout: lsofOutput }, { stdout: psOutput }] = await Promise.all([
        execFileAsync("/usr/sbin/lsof", ["-n", "-F", "p", "--", socketPath], options),
        execFileAsync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm="], options),
      ]);
      const socketHolderPids = [...new Set(
        lsofOutput.split("\n").flatMap((line) =>
          /^p[1-9][0-9]*$/.test(line) ? [Number(line.slice(1))] : []),
      )];
      if (socketHolderPids.length > maximumSocketHolders) {
        throw new Error("bounded socket-holder evidence exceeded");
      }
      const parsed = psOutput.split("\n").flatMap((line) => {
        const match = /^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s+(.+?)\s*$/.exec(line);
        if (match === null) return [];
        return [{
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          executablePath: match[3]!,
        }];
      });
      if (parsed.length > maximumProcesses) {
        throw new Error("bounded process evidence exceeded");
      }
      const appRoots = [...new Set(parsed.flatMap(({ executablePath }) => {
        const match = /^(\/Applications\/[^/]+\.app)\//.exec(executablePath);
        return match?.[1] === undefined ? [] : [match[1]];
      }))];
      if (appRoots.length > 32) throw new Error("bounded app evidence exceeded");
      const identifiers = new Map<string, string>();
      await Promise.all(appRoots.map(async (appRoot) => {
        const { stdout } = await execFileAsync(
          "/usr/bin/mdls",
          ["-raw", "-name", "kMDItemCFBundleIdentifier", appRoot],
          options,
        );
        identifiers.set(appRoot, stdout.trim());
      }));
      return {
        socketHolderPids,
        processes: parsed.map((process) => {
          const appRoot = /^(\/Applications\/[^/]+\.app)\//.exec(
            process.executablePath,
          )?.[1];
          const bundleIdentifier =
            appRoot === undefined ? undefined : identifiers.get(appRoot);
          return {
            ...process,
            ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
          };
        }),
      };
    },
  };
}
