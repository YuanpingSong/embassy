import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The one Codex process check that changes public health: whether a process Embassy did
 * not spawn holds the managed Codex control socket while the managed layout
 * is missing. That is the only condition that changes public health.
 */
export const CODEX_SOCKET_HOLDER_MAX_PROCESSES = 512;
export const CODEX_SOCKET_HOLDER_MAX_HOLDERS = 32;
export type CodexSocketHolderProcess = Readonly<{ pid: number; parentPid?: number }>;
export type CodexSocketHolderInspection = Readonly<{
  processes: readonly CodexSocketHolderProcess[]; socketHolderPids: readonly number[];
}>;
export type CodexSocketHolderInspector = Readonly<{
  inspect(request: Readonly<{ socketPath: string; maximumProcesses: number; maximumSocketHolders: number }>):
    Promise<CodexSocketHolderInspection>;
}>;
export type CodexSocketHolderOptions = Readonly<{ socketPath: string; embassyPid: number; inspector: CodexSocketHolderInspector }>;

const run = promisify(execFile);
const validPid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function embassyOwned(pid: number, embassyPid: number, processes: ReadonlyMap<number, CodexSocketHolderProcess>): boolean {
  const seen = new Set<number>();
  while (!seen.has(pid) && seen.size <= processes.size) {
    if (pid === embassyPid) return true;
    seen.add(pid);
    const parent = processes.get(pid)?.parentPid;
    if (parent === undefined || !validPid(parent) || parent === pid) return false;
    pid = parent;
  }
  return false;
}

/** True only on bounded, well-formed evidence of a non-Embassy holder; every other outcome is false, never a guess. */
export async function managedCodexSocketHeldOutsideEmbassy(options: CodexSocketHolderOptions): Promise<boolean> {
  if (!options.socketPath || options.socketPath.includes("\0") || !validPid(options.embassyPid)) return false;
  let inspection: CodexSocketHolderInspection;
  try {
    inspection = await options.inspector.inspect({ socketPath: options.socketPath,
      maximumProcesses: CODEX_SOCKET_HOLDER_MAX_PROCESSES, maximumSocketHolders: CODEX_SOCKET_HOLDER_MAX_HOLDERS });
  } catch { return false; }
  if (inspection.processes.length > CODEX_SOCKET_HOLDER_MAX_PROCESSES ||
    inspection.socketHolderPids.length > CODEX_SOCKET_HOLDER_MAX_HOLDERS) return false;
  const processes = new Map<number, CodexSocketHolderProcess>();
  for (const process of inspection.processes) {
    if (!validPid(process.pid) || processes.has(process.pid) ||
      (process.parentPid !== undefined && !validPid(process.parentPid))) return false;
    processes.set(process.pid, process);
  }
  if (!inspection.socketHolderPids.every(validPid)) return false;
  return inspection.socketHolderPids.some((pid) => processes.has(pid) && !embassyOwned(pid, options.embassyPid, processes));
}

/** Bounded macOS inspection; commands and outputs are fixed and private. */
export function createSystemCodexSocketHolderInspector(): CodexSocketHolderInspector {
  return { inspect: async ({ socketPath, maximumProcesses, maximumSocketHolders }) => {
    const execOptions = { encoding: "utf8" as const, maxBuffer: 64 * 1024, timeout: 2_000 };
    const [{ stdout: lsof }, { stdout: ps }] = await Promise.all([
      run("/usr/sbin/lsof", ["-n", "-F", "p", "--", socketPath], execOptions),
      run("/bin/ps", ["-axo", "pid=,ppid="], execOptions),
    ]);
    const socketHolderPids = [...new Set(lsof.split("\n").flatMap((line) =>
      /^p[1-9][0-9]*$/.test(line) ? [Number(line.slice(1))] : [],
    ))];
    if (socketHolderPids.length > maximumSocketHolders) throw new Error("bounded socket-holder evidence exceeded");
    const processes = ps.split("\n").flatMap((line): CodexSocketHolderProcess[] => {
      const match = /^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s*$/.exec(line);
      return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]) }];
    });
    if (processes.length > maximumProcesses) throw new Error("bounded process evidence exceeded");
    return { socketHolderPids, processes };
  } };
}
