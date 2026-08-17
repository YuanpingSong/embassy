import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CODEX_DOCTOR_MAX_PROCESSES = 512;
export const CODEX_DOCTOR_MAX_SOCKET_HOLDERS = 32;
export type CodexDoctorCondition = "split_brain" | "orphaned" | "attached" | "managed_layout_missing" | "unknown";
export type CodexDoctorProcess = Readonly<{ pid: number; parentPid?: number; executablePath: string;
  bundleIdentifier?: string }>;
export type CodexDoctorInspection = Readonly<{ processes: readonly CodexDoctorProcess[];
  socketHolderPids: readonly number[] }>;
export type CodexDoctorInspector = Readonly<{
  inspect(request: Readonly<{
    socketPath: string;
    maximumProcesses: number;
    maximumSocketHolders: number;
  }>): Promise<CodexDoctorInspection>;
}>;
export type CodexDoctorOptions = Readonly<{ socketPath: string; daemonExecutablePath: string;
  embassyPid: number; inspector: CodexDoctorInspector }>;
export type MissingManagedCodexLayoutOptions = Readonly<Omit<CodexDoctorOptions, "daemonExecutablePath">>;
export type CodexDoctorResult = Readonly<{ conditions: readonly CodexDoctorCondition[] }>;

const run = promisify(execFile);
const UNKNOWN: CodexDoctorResult = Object.freeze({ conditions: ["unknown"] });
const validPid = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const desktop = (process: CodexDoctorProcess): boolean =>
  process.bundleIdentifier === "com.openai.codex" && /^\/Applications\/[^/]+\.app\/.+/.test(process.executablePath);
function embassyOwned(pid: number, embassyPid: number, processes: ReadonlyMap<number, CodexDoctorProcess>): boolean {
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

function validate(inspection: CodexDoctorInspection): Readonly<{
  processes: ReadonlyMap<number, CodexDoctorProcess>; holders: ReadonlySet<number>;
}> | undefined {
  if (inspection.processes.length > CODEX_DOCTOR_MAX_PROCESSES || inspection.socketHolderPids.length > CODEX_DOCTOR_MAX_SOCKET_HOLDERS) return undefined;
  const processes = new Map<number, CodexDoctorProcess>();
  for (const process of inspection.processes) {
    if (!validPid(process.pid) || typeof process.executablePath !== "string" || process.executablePath.includes("\0") ||
      processes.has(process.pid) || (process.parentPid !== undefined && !validPid(process.parentPid))) return undefined;
    processes.set(process.pid, process);
  }
  const holders = new Set<number>();
  for (const pid of inspection.socketHolderPids) {
    if (!validPid(pid)) return undefined;
    holders.add(pid);
  }
  return { processes, holders };
}

function classify(inspection: CodexDoctorInspection, options: CodexDoctorOptions): CodexDoctorResult {
  const validated = validate(inspection);
  if (validated === undefined) return UNKNOWN;
  const { processes, holders } = validated;
  const daemon = [...holders].filter((pid) => processes.get(pid)?.executablePath === options.daemonExecutablePath);
  if (daemon.length !== 1) return UNKNOWN;
  const external: CodexDoctorProcess[] = [];
  for (const pid of holders) {
    if (pid === daemon[0] || embassyOwned(pid, options.embassyPid, processes)) continue;
    const process = processes.get(pid);
    if (process === undefined) return UNKNOWN;
    external.push(process);
  }
  if (external.some(desktop)) return { conditions: ["attached"] };
  if (external.length) return UNKNOWN;
  return { conditions: [inspection.processes.some(desktop) ? "split_brain" : "orphaned"] };
}

async function inspect(options: MissingManagedCodexLayoutOptions): Promise<CodexDoctorInspection> {
  return await options.inspector.inspect({ socketPath: options.socketPath,
    maximumProcesses: CODEX_DOCTOR_MAX_PROCESSES, maximumSocketHolders: CODEX_DOCTOR_MAX_SOCKET_HOLDERS });
}

/** Returns bounded public state; raw process evidence never crosses this module. */
export async function diagnoseCodexAttachment(options: CodexDoctorOptions): Promise<CodexDoctorResult> {
  if (!options.socketPath || options.socketPath.includes("\0") || !options.daemonExecutablePath.startsWith("/") ||
    options.daemonExecutablePath.includes("\0") || !validPid(options.embassyPid)) return UNKNOWN;
  try {
    return classify(await inspect(options), options);
  } catch { return UNKNOWN; }
}

/** Missing managed files are actionable only when the fixed private socket is still held outside Embassy. */
export async function diagnoseMissingManagedCodexLayout(options: MissingManagedCodexLayoutOptions): Promise<CodexDoctorResult> {
  if (!options.socketPath || options.socketPath.includes("\0") || !validPid(options.embassyPid)) return UNKNOWN;
  try {
    const validated = validate(await inspect(options));
    if (validated === undefined) return UNKNOWN;
    return [...validated.holders].some((pid) => validated.processes.has(pid) &&
      !embassyOwned(pid, options.embassyPid, validated.processes))
      ? { conditions: ["managed_layout_missing"] } : UNKNOWN;
  } catch { return UNKNOWN; }
}

/** Bounded macOS inspection; commands and outputs are fixed and private. */
export function createSystemCodexDoctorInspector(): CodexDoctorInspector {
  return { inspect: async ({ socketPath, maximumProcesses, maximumSocketHolders }) => {
    const execOptions = { encoding: "utf8" as const, maxBuffer: 64 * 1024, timeout: 2_000 };
    const [{ stdout: lsof }, { stdout: ps }] = await Promise.all([
      run("/usr/sbin/lsof", ["-n", "-F", "p", "--", socketPath], execOptions),
      run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm="], execOptions),
    ]);
    const socketHolderPids = [...new Set(lsof.split("\n").flatMap((line) =>
      /^p[1-9][0-9]*$/.test(line) ? [Number(line.slice(1))] : [],
    ))];
    if (socketHolderPids.length > maximumSocketHolders) throw new Error("bounded socket-holder evidence exceeded");
    const processes = ps.split("\n").flatMap((line): CodexDoctorProcess[] => {
      const match = /^\s*([1-9][0-9]*)\s+([1-9][0-9]*)\s+(.+?)\s*$/.exec(line);
      return match === null ? [] : [{ pid: Number(match[1]), parentPid: Number(match[2]), executablePath: match[3]! }];
    });
    if (processes.length > maximumProcesses) throw new Error("bounded process evidence exceeded");
    const appRoots = [...new Set(processes.flatMap(({ executablePath }) =>
      /^(\/Applications\/[^/]+\.app)\//.exec(executablePath)?.[1] ?? [],
    ))];
    if (appRoots.length > 32) throw new Error("bounded app evidence exceeded");
    const identifiers = new Map<string, string>();
    await Promise.all(appRoots.map(async (root) => {
      const { stdout } = await run("/usr/bin/mdls", ["-raw", "-name", "kMDItemCFBundleIdentifier", root], execOptions);
      identifiers.set(root, stdout.trim());
    }));
    return { socketHolderPids, processes: processes.map((process) => {
      const root = /^(\/Applications\/[^/]+\.app)\//.exec(process.executablePath)?.[1];
      const bundleIdentifier = root === undefined ? undefined : identifiers.get(root);
      return { ...process, ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }) };
    }) };
  } };
}
