import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The one Codex process check that changes public health: while the managed
 * Codex layout is missing, does a process outside Embassy's own tree hold the
 * managed control socket? `lsof` names the holders; each holder's ancestry is
 * then walked one `ps -o ppid=` step at a time up to launchd. A holder whose
 * chain never passes through Embassy's pid answers true. The walk never reads
 * the whole process table, so host size cannot fail the check; only malformed
 * or vanished evidence, an exhausted walk, or an inspector error answers
 * false, and that silence is never reported as health.
 */
export const CODEX_SOCKET_HOLDER_MAX_HOLDERS = 32;
export const CODEX_SOCKET_HOLDER_MAX_ANCESTRY_DEPTH = 64;
export type CodexSocketHolderInspector = Readonly<{
  /** Pids currently holding the socket; throws when there are more than `maximumHolders`. */
  socketHolders(socketPath: string, maximumHolders: number): Promise<readonly number[]>;
  /** Parent pid of one live process; undefined when the process is gone or unreadable. */
  parentOf(pid: number): Promise<number | undefined>;
}>;
export type CodexSocketHolderOptions = Readonly<{ socketPath: string; embassyPid: number; inspector: CodexSocketHolderInspector }>;

const run = promisify(execFile);
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Walk one holder toward launchd; true only when the chain ends (pid 0/1 or a cycle) without meeting Embassy. */
async function outsideEmbassy(holder: number, options: CodexSocketHolderOptions): Promise<boolean> {
  const seen = new Set<number>();
  let pid = holder;
  for (let depth = 0; depth < CODEX_SOCKET_HOLDER_MAX_ANCESTRY_DEPTH; depth += 1) {
    if (pid === options.embassyPid) return false;
    if (pid <= 1 || seen.has(pid)) return true;
    seen.add(pid);
    let parent: number | undefined;
    try { parent = await options.inspector.parentOf(pid); } catch { return false; }
    if (parent === undefined || !Number.isSafeInteger(parent) || parent < 0) return false;
    pid = parent;
  }
  return false;
}

export async function managedCodexSocketHeldOutsideEmbassy(options: CodexSocketHolderOptions): Promise<boolean> {
  if (!options.socketPath || options.socketPath.includes("\0") || !validPid(options.embassyPid)) return false;
  let holders: readonly number[];
  try { holders = await options.inspector.socketHolders(options.socketPath, CODEX_SOCKET_HOLDER_MAX_HOLDERS); } catch { return false; }
  if (holders.length > CODEX_SOCKET_HOLDER_MAX_HOLDERS) return false;
  for (const holder of new Set(holders)) {
    if (validPid(holder) && await outsideEmbassy(holder, options)) return true;
  }
  return false;
}

/** Bounded macOS inspection; commands and outputs are fixed and private. */
export function createSystemCodexSocketHolderInspector(): CodexSocketHolderInspector {
  const execOptions = { encoding: "utf8" as const, maxBuffer: 64 * 1024, timeout: 2_000 };
  return {
    socketHolders: async (socketPath, maximumHolders) => {
      const { stdout } = await run("/usr/sbin/lsof", ["-n", "-F", "p", "--", socketPath], execOptions);
      const holders = [...new Set(stdout.split("\n").flatMap((line) => /^p[1-9][0-9]*$/.test(line) ? [Number(line.slice(1))] : []))];
      if (holders.length > maximumHolders) throw new Error("bounded socket-holder evidence exceeded");
      return holders;
    },
    parentOf: async (pid) => {
      const { stdout } = await run("/bin/ps", ["-o", "ppid=", "-p", String(pid)], execOptions);
      const match = /^\s*([0-9]+)\s*$/.exec(stdout);
      return match === null ? undefined : Number(match[1]);
    },
  };
}
