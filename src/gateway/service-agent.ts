/**
 * Run the broker as a macOS launchd agent. This module renders the plist,
 * drives `launchctl` through an injected runner (real callers spawn the
 * system binary; tests inject a fake), and refuses to install while another
 * Embassy broker holds the host-wide instance lease
 * (src/gateway/instance-lease.ts). It never touches the real ~/Library
 * itself — every path is derived from an injected `homeDir`.
 *
 * Install order is load-bearing. Our own agent is booted out *first* (that
 * is what re-install means), and only then is the host lease probed: probing
 * first made `install` refuse over the very agent it was replacing. Every
 * input is validated before the first side effect, and any failure after
 * `bootstrap` is rolled back, so a rejected install never leaves a
 * half-registered agent behind.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { acquireGatewayInstanceLease } from "./instance-lease.js";

export const SERVICE_AGENT_LABEL = "com.agent-embassy.broker";

/** Bounded read of our own rendered plist when `status` inspects it or a rollback restores it. */
const MAX_PLIST_BYTES = 64 * 1024;
/** Bounded read of the lease lock record, matching instance-lease.ts. */
const MAX_LEASE_RECORD_BYTES = 4 * 1024;
/**
 * Every byte this module puts into a message a caller may print passes
 * through boundedServiceDetail or boundedProgramList: launchctl stderr, the
 * instance lease's own message, an errno string, and the program paths in a
 * status note. cli.ts holds the invariant that stderr never carries private
 * detail, and `launchctl print` stdout is private detail — it dumps the
 * agent's whole EnvironmentVariables dict, values included — so its stdout is
 * parsed but never quoted.
 */
const MAX_LAUNCHCTL_DETAIL_BYTES = 512;
/** A status note names at most this many missing programs, each capped. */
const MAX_PROGRAM_LIST_ENTRIES = 3;
const MAX_PROGRAM_PATH_BYTES = 256;
/**
 * launchd tears a job down asynchronously and `bootout` can return 36
 * ("operation in progress") while it is still going; the broker's own close
 * awaits its providers, its store, and the lease helper, up to 5 s. So a
 * bootout is confirmed by polling `print` for not-found, not by one shot.
 */
const BOOTOUT_POLL_INTERVAL_MS = 250;
const BOOTOUT_WAIT_TIMEOUT_MS = 10_000;
const BOOTOUT_MAX_ATTEMPTS = BOOTOUT_WAIT_TIMEOUT_MS / BOOTOUT_POLL_INTERVAL_MS;

/**
 * The host-wide advisory lease lives at this fixed path under the login
 * home, independent of EMBASSY_STATE_DIR (see instance-lease.ts). The path
 * components are not exported by that module (they are load-bearing only
 * for its own lock file), so they are named again here — the same
 * duplication test/gateway-instance-lease.test.ts already carries — solely
 * to read the current holder's pid for a friendlier refusal message.
 */
const HOST_LEASE_LOCK_RELATIVE_PATH = path.join(
  ".local",
  "state",
  "agent-embassy",
  ".gateway-host.lock",
);

/**
 * `launchctl print` on a label that is not loaded. Every other non-zero
 * result is a launchctl problem, not an answer about the agent, and is
 * reported as such rather than rendered as "not loaded".
 */
const SERVICE_NOT_FOUND_PATTERN =
  /could not find (?:the )?(?:specified )?service|no such process/i;

const isServiceNotFound = (result: RunLaunchctlResult): boolean =>
  SERVICE_NOT_FOUND_PATTERN.test(`${result.stderr}\n${result.stdout}`);

export type LaunchAgentPlistOptions = Readonly<{
  label: string;
  programArguments: readonly string[];
  logPath: string;
  /** Already-captured, already-validated agent environment (see captureAgentEnvironment). */
  environment: Readonly<Record<string, string>>;
}>;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function stringElement(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

/**
 * Render the launchd agent plist.
 *
 * `KeepAlive` is `{ Crashed: true }`, never plain `true`. Per launchd.plist(5)
 * `Crashed` relaunches the job only when it died from a signal typically
 * associated with a crash — SIGSEGV, SIGBUS, SIGILL, SIGABRT. Nothing else
 * brings it back: not a clean exit, not a non-zero exit, not a plain `kill`
 * (SIGTERM), and not one of the broker's deliberate boot refusals (an
 * unsupported state schema, another instance already holding the lease).
 * Under plain `KeepAlive` every one of those refusals would relaunch forever,
 * throttled to once every 5 seconds, into one log file that nothing rotates.
 * A refusal now exits once and stays down, where `embassy service status` and
 * the log can explain it. ThrottleInterval still bounds a genuine crash loop.
 *
 * EnvironmentVariables carries exactly the captured configuration keys and
 * nothing else — see captureAgentEnvironment for the rule. PATH is not
 * needed (every child process this broker spawns — the codex standalone
 * binary, /bin/ps, /usr/bin/lockf, /bin/cat — is invoked by an absolute path
 * already; see codex-local-transport.ts, claude-peer.ts, and
 * instance-lease.ts).
 */
export function renderLaunchAgentPlist(options: LaunchAgentPlistOptions): string {
  const argumentsXml = options.programArguments
    .map((argument) => `        ${stringElement(argument)}`)
    .join("\n");
  const environmentEntries = Object.entries(options.environment);
  const environmentXml = environmentEntries.length === 0
    ? ""
    : [
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...environmentEntries.flatMap(([key, value]) => [
          `        <key>${xmlEscape(key)}</key>`,
          `        ${stringElement(value)}`,
        ]),
        "    </dict>",
        "",
      ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    ${stringElement(options.label)}
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    ${stringElement(options.logPath)}
    <key>StandardErrorPath</key>
    ${stringElement(options.logPath)}
${environmentXml}</dict>
</plist>
`;
}

export type RunLaunchctlResult = Readonly<{ code: number; stdout: string; stderr: string }>;
export type RunLaunchctl = (
  args: readonly string[],
) => RunLaunchctlResult | Promise<RunLaunchctlResult>;

export type ServiceAgentDependencies = Readonly<{
  homeDir: string;
  runLaunchctl: RunLaunchctl;
  env: NodeJS.ProcessEnv;
  execPath: string;
  cliPath: string;
  uid: number;
  /** Bounded waits for launchd to finish unloading; injected by tests. */
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  /**
   * The host-lease probe. The default spawns /usr/bin/lockf through
   * instance-lease.ts and so only answers on macOS; tests inject a fake.
   */
  probeHostLease?: ProbeHostLease;
}>;

const defaultDelay = async (milliseconds: number): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export type ServiceAgentPaths = Readonly<{
  launchAgentsDir: string;
  logsDir: string;
  plistPath: string;
  logPath: string;
}>;

export function serviceAgentPaths(homeDir: string): ServiceAgentPaths {
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logsDir = path.join(homeDir, "Library", "Logs", "agent-embassy");
  return {
    launchAgentsDir,
    logsDir,
    plistPath: path.join(launchAgentsDir, `${SERVICE_AGENT_LABEL}.plist`),
    logPath: path.join(logsDir, "broker.log"),
  };
}

const launchctlDomain = (uid: number): string => `gui/${uid}`;
const launchctlTarget = (uid: number): string => `gui/${uid}/${SERVICE_AGENT_LABEL}`;

/**
 * stderr only, trimmed, and capped — never launchctl's stdout. Everything the
 * service path puts on the CLI's stderr goes through this, including the
 * errno text of a filesystem failure the CLI itself renders.
 */
export function boundedServiceDetail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "no stderr output";
  const bytes = Buffer.from(trimmed, "utf8");
  return bytes.length <= MAX_LAUNCHCTL_DETAIL_BYTES
    ? trimmed
    : `${bytes.subarray(0, MAX_LAUNCHCTL_DETAIL_BYTES).toString("utf8")}… (truncated)`;
}
const launchctlDetail = (result: RunLaunchctlResult): string =>
  boundedServiceDetail(result.stderr);
const formatSeconds = (milliseconds: number): string =>
  (Math.max(0, milliseconds) / 1000).toFixed(1);
/** Elapsed time is measured monotonically; a wall-clock step must not move it. */
const monotonicNow = (): number => performance.now();

/** The missing-program list as it appears in a note: bounded in both directions. */
function boundedProgramList(programs: readonly string[]): string {
  const shown = programs.slice(0, MAX_PROGRAM_LIST_ENTRIES).map((program) => {
    const bytes = Buffer.from(program, "utf8");
    return bytes.length <= MAX_PROGRAM_PATH_BYTES
      ? program
      : `${bytes.subarray(0, MAX_PROGRAM_PATH_BYTES).toString("utf8")}… (truncated)`;
  });
  const remaining = programs.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")}, and ${remaining} more` : shown.join(", ");
}
/** An errno-bearing filesystem failure, rendered without a stack. */
const errnoDetail = (error: unknown): string =>
  boundedServiceDetail(error instanceof Error ? error.message : "unknown filesystem failure");

/**
 * launchctl failures are transient by class: the binary was unavailable, the
 * gui domain was not up, another tool held the label. The CLI reports them
 * as unavailable and prints this message, which carries launchctl's own
 * stderr, rather than discarding it behind a generic input rejection.
 */
function launchctlFailure(
  verb: string,
  result: RunLaunchctlResult,
  suffix = "",
): BridgeError {
  return new BridgeError(
    "SERVICE_AGENT_COMMAND_FAILED",
    `launchctl ${verb} failed (exit ${result.code}): ${launchctlDetail(result)}${suffix}`,
    true,
  );
}

const rejectInput = (message: string): never => {
  throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", message, false);
};

function requireAbsolutePath(value: string, description: string): string {
  if (value.length === 0 || value.includes("\0") || !path.isAbsolute(value) ||
      path.resolve(value) !== value) {
    rejectInput(`${description} must be an absolute, already-resolved path.`);
  }
  return value;
}

function requireUid(uid: number): number {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    rejectInput("The launchd agent needs this process's numeric uid.");
  }
  return uid;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * The environment the installed agent runs with. launchd agents inherit
 * almost nothing, so Embassy's own configuration has to be copied into the
 * plist: every `EMBASSY_*` variable (EMBASSY_STATE_DIR included) plus
 * XDG_STATE_HOME, which decides the state root when EMBASSY_STATE_DIR is
 * unset. These are configuration, not secrets — but nothing else is copied,
 * so an inherited API key or token cannot reach the plist.
 *
 * Both state roots must be absolute here, before capture: a relative value
 * resolves against the installing shell's working directory, and the agent
 * would silently resolve it somewhere else.
 */
export function captureAgentEnvironment(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (key !== "XDG_STATE_HOME" && !key.startsWith("EMBASSY_")) continue;
    const value = env[key];
    if (value === undefined || value.length === 0) continue;
    if (CONTROL_CHARACTER_PATTERN.test(value)) {
      rejectInput(`${key} contains a control character and cannot be captured into the launchd agent.`);
    }
    if (key === "EMBASSY_STATE_DIR" || key === "XDG_STATE_HOME") {
      requireAbsolutePath(value, key);
    }
    captured[key] = value;
  }
  return captured;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the lease holder's pid under the same discipline instance-lease.ts
 * applies in readPrivateFile: lstat first, regular file only, this user's
 * own, size-bounded, opened O_NOFOLLOW and re-verified against the same
 * inode. This value only decorates a refusal message, but it is read out of
 * a file another process writes, so it gets the same care.
 */
async function readHeldLeasePid(homeDir: string, uid: number): Promise<number | undefined> {
  const lockPath = path.join(homeDir, HOST_LEASE_LOCK_RELATIVE_PATH);
  try {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_LEASE_RECORD_BYTES ||
        info.uid !== uid) {
      return undefined;
    }
    const handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
          opened.size > MAX_LEASE_RECORD_BYTES || opened.uid !== uid) {
        return undefined;
      }
      const buffer = Buffer.alloc(MAX_LEASE_RECORD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const record: unknown = JSON.parse(raw.trim());
    const pid =
      record !== null && typeof record === "object" && "pid" in record
        ? (record as { pid?: unknown }).pid
        : undefined;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the host-wide lease says right now. `pid` is present only when a
 * *live* holder was identified; `message` is the lease's own words for why it
 * could not be taken.
 */
export type HostLeaseProbe =
  | Readonly<{ held: false }>
  | Readonly<{ held: true; pid?: number; message: string }>;
export type ProbeHostLease = (homeDir: string, uid: number) => Promise<HostLeaseProbe>;

/**
 * The production probe, and the reason this is an injected dependency at all.
 * It reuses the exact detection the broker relies on for single-instance
 * correctness — a non-blocking acquire of the host-wide advisory lease
 * (acquireGatewayInstanceLease, unmodified), released immediately when nobody
 * holds it. That helper spawns /usr/bin/lockf, which exists only on macOS, so
 * on any other platform it reports contention that is really a missing
 * binary. The product is macOS-only and that is correct in production, but it
 * makes every install path untestable off darwin; tests inject a fake probe
 * and one darwin-only test drives this default.
 *
 * `GATEWAY_INSTANCE_IN_USE` is not only contention: instance-lease.ts throws
 * it for roughly ten conditions that have nothing to do with another broker
 * (a symlinked path component, a non-empty unmarked lease root, a mode or
 * owner drift). So its message is always carried out of here unchanged, and a
 * pid is reported only when the recorded holder is genuinely alive — the lock
 * record keeps the *last* holder, and a successful probe writes its own pid
 * there, so an unchecked pid is routinely stale. Never tell someone to stop
 * a dead process.
 */
export async function defaultProbeHostLease(
  homeDir: string,
  uid: number,
): Promise<HostLeaseProbe> {
  let lease;
  try {
    lease = await acquireGatewayInstanceLease(homeDir);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE") {
      const pid = await readHeldLeasePid(homeDir, uid);
      if (pid !== undefined && isProcessAlive(pid)) {
        return { held: true, pid, message: error.message };
      }
      return { held: true, message: error.message };
    }
    throw error;
  }
  await lease.close();
  return { held: false };
}

/**
 * Refuse to install while the host lease cannot be taken. The lease's own
 * message is preserved — verbatim up to the same 512-byte bound every other
 * quoted string here carries, which no instance-lease message approaches —
 * and a pid is named only when the probe verified it alive.
 */
async function refuseIfAnotherBrokerHoldsLease(
  deps: ServiceAgentDependencies,
  homeDir: string,
  uid: number,
): Promise<void> {
  const probe = await (deps.probeHostLease ?? defaultProbeHostLease)(homeDir, uid);
  if (!probe.held) return;
  const reported = boundedServiceDetail(probe.message);
  throw new BridgeError(
    "GATEWAY_INSTANCE_IN_USE",
    probe.pid === undefined
      ? `The Embassy host lease could not be acquired, so nothing was installed. The lease reported: ${reported}`
      : `Another Embassy broker holds the host lease (pid ${probe.pid}, alive) — stop it (\`embassy service uninstall\` if it is the launchd agent, otherwise the \`embassy serve\` terminal), then re-run install. The lease reported: ${reported}`,
    true,
  );
}

/**
 * Create one path component if it is absent, then verify it. Nothing that
 * already exists is ever chmod-ed: a login home may deliberately keep
 * ~/Library or ~/Library/LaunchAgents tighter than the default, and an
 * installer has no business loosening it. This mirrors the discipline
 * prepareHostLeaseDirectory already applies in instance-lease.ts.
 */
async function ensureOwnedDirectory(
  target: string,
  mode: number,
  uid: number,
): Promise<void> {
  let created = false;
  try {
    await mkdir(target, { mode });
    created = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new BridgeError(
      "SERVICE_AGENT_PATH_UNSAFE",
      `${target} is not a real directory; refusing to install the launchd agent through it.`,
      false,
    );
  }
  if (info.uid !== uid) {
    throw new BridgeError(
      "SERVICE_AGENT_PATH_UNSAFE",
      `${target} is not owned by this user; refusing to install the launchd agent there.`,
      false,
    );
  }
  // mkdir's mode is masked by the process umask, so the requested mode is
  // applied explicitly — but only to a directory this call just created.
  if (created) await chmod(target, mode);
}

async function prepareServiceDirectories(homeDir: string, uid: number): Promise<void> {
  await ensureOwnedDirectory(path.join(homeDir, "Library"), 0o755, uid);
  await ensureOwnedDirectory(path.join(homeDir, "Library", "LaunchAgents"), 0o755, uid);
  await ensureOwnedDirectory(path.join(homeDir, "Library", "Logs"), 0o755, uid);
  await ensureOwnedDirectory(path.join(homeDir, "Library", "Logs", "agent-embassy"), 0o700, uid);
}

/**
 * Write the plist through a fresh O_EXCL temp file and one rename, so a
 * reader never sees a half-written plist and a pre-planted symlink at the
 * destination is replaced rather than written through.
 */
async function writePlistAtomically(plistPath: string, plist: string): Promise<void> {
  const existing = await lstat(plistPath).catch(() => undefined);
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new BridgeError(
      "SERVICE_AGENT_PATH_UNSAFE",
      `${plistPath} is not a regular file; refusing to replace it.`,
      false,
    );
  }
  const temporaryPath = `${plistPath}.tmp-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o644);
  try {
    await handle.writeFile(plist, "utf8");
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, plistPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

type BootoutWait =
  | Readonly<{ kind: "gone"; elapsedMs: number }>
  | Readonly<{ kind: "still-loaded"; elapsedMs: number }>
  | Readonly<{ kind: "print-failed"; result: RunLaunchctlResult; elapsedMs: number }>;

/** Poll `print` until launchctl says the label is not found, or the bound expires. */
async function waitForServiceGone(
  deps: ServiceAgentDependencies,
  target: string,
): Promise<BootoutWait> {
  const now = deps.now ?? monotonicNow;
  const delay = deps.delay ?? defaultDelay;
  const started = now();
  for (let attempt = 0; ; attempt += 1) {
    const printed = await deps.runLaunchctl(["print", target]);
    const elapsedMs = now() - started;
    if (printed.code !== 0) {
      return isServiceNotFound(printed)
        ? { kind: "gone", elapsedMs }
        : { kind: "print-failed", result: printed, elapsedMs };
    }
    if (elapsedMs >= BOOTOUT_WAIT_TIMEOUT_MS || attempt >= BOOTOUT_MAX_ATTEMPTS) {
      return { kind: "still-loaded", elapsedMs };
    }
    await delay(BOOTOUT_POLL_INTERVAL_MS);
  }
}

type BootoutOutcome = Readonly<{ gone: true }> | Readonly<{ gone: false; reason: string }>;

/**
 * Boot the label out and confirm it. `bootout`'s own exit code is not the
 * answer — it returns 0 while launchd is still tearing the job down, and it
 * returns non-zero for a job that was never loaded — so the confirmation is
 * always `print` reporting not-found. The reason strings quote launchctl's
 * stderr only; `print` stdout carries the agent's environment values and
 * never leaves this module.
 */
async function verifiedBootout(
  deps: ServiceAgentDependencies,
  target: string,
  subject: string,
): Promise<BootoutOutcome> {
  const bootout = await deps.runLaunchctl(["bootout", target]);
  const wait = await waitForServiceGone(deps, target);
  if (wait.kind === "gone") return { gone: true };
  if (wait.kind === "print-failed") {
    return {
      gone: false,
      reason: `launchctl print could not confirm the unload (exit ${wait.result.code}): ${launchctlDetail(wait.result)}`,
    };
  }
  if (bootout.code !== 0) {
    return {
      gone: false,
      reason: `launchctl bootout failed (exit ${bootout.code}): ${launchctlDetail(bootout)}`,
    };
  }
  return {
    gone: false,
    reason: `${subject} is still unloading after ${formatSeconds(wait.elapsedMs)} s, although launchctl bootout returned 0`,
  };
}

type PreviousPlist =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "bytes"; plist: string }>;

/**
 * The plist currently on disk, as three distinct answers. "Absent" and
 * "unreadable" must not collapse into one: a rollback deletes on absent, and
 * deleting a plist we merely failed to read would be a silent uninstall of an
 * install that already existed.
 */
async function readPreviousPlist(plistPath: string): Promise<PreviousPlist> {
  const info = await lstat(plistPath).catch(() => undefined);
  if (info === undefined) return { kind: "absent" };
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PLIST_BYTES) {
    return { kind: "unreadable" };
  }
  const plist = await readFile(plistPath, "utf8").catch(() => undefined);
  return plist === undefined ? { kind: "unreadable" } : { kind: "bytes", plist };
}

type RunConfirmation =
  | Readonly<{ running: true }>
  | Readonly<{ running: false; verb: string; result: RunLaunchctlResult }>;

/**
 * Confirm a bootstrapped agent is actually running, by `print` rather than by
 * an exit code — the same standard this module applies to a bootout. A job
 * that loaded but is not running gets one plain `kickstart`, never `-k`.
 */
async function confirmRunning(
  deps: ServiceAgentDependencies,
  target: string,
): Promise<RunConfirmation> {
  const printed = await deps.runLaunchctl(["print", target]);
  if (printed.code !== 0) return { running: false, verb: "print", result: printed };
  const parsed = parseLaunchctlPrintOutput(printed.stdout);
  if (parsed.pid !== undefined || parsed.launchdState === "running") return { running: true };
  const kickstart = await deps.runLaunchctl(["kickstart", target]);
  return kickstart.code === 0
    ? { running: true }
    : { running: false, verb: "kickstart", result: kickstart };
}

export type ServiceAgentInstallResult = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
  /** Names only: the configuration keys copied into the plist at install time. */
  capturedEnv: readonly string[];
}>;

/**
 * Register the broker as this user's launchd agent. Re-running it over a
 * prior install — including one that is loaded and running right now — is
 * the supported way to change what the agent runs with.
 */
export async function installServiceAgent(
  deps: ServiceAgentDependencies,
): Promise<ServiceAgentInstallResult> {
  // 1. Everything that can be rejected, rejected before the first side effect.
  const uid = requireUid(deps.uid);
  const homeDir = requireAbsolutePath(deps.homeDir, "The login home");
  requireAbsolutePath(deps.execPath, "The Node executable path");
  requireAbsolutePath(deps.cliPath, "The Embassy CLI path");
  const environment = captureAgentEnvironment(deps.env);
  const { plistPath, logPath } = serviceAgentPaths(homeDir);
  const target = launchctlTarget(uid);
  const domain = launchctlDomain(uid);

  // 2. Our own agent first. Re-install means replace, so a loaded copy of
  //    this exact label is booted out and confirmed gone before anything
  //    else — probing the host lease first made install refuse over the very
  //    agent it was replacing.
  const before = await deps.runLaunchctl(["print", target]);
  // Load-bearing for the rollback below: a plist that was on disk but *not*
  // loaded must never be bootstrapped by a failed install.
  const wasLoadedBefore = before.code === 0;
  if (before.code === 0) {
    const cleared = await verifiedBootout(deps, target, "the previous agent");
    if (!cleared.gone) {
      throw new BridgeError(
        "SERVICE_AGENT_COMMAND_FAILED",
        `Could not replace the loaded launchd agent: ${cleared.reason}. Nothing was changed.`,
        true,
      );
    }
  } else if (!isServiceNotFound(before)) {
    throw launchctlFailure("print", before, " — install stopped before changing anything.");
  }

  // 3. Only now can a held lease mean somebody else's broker.
  await refuseIfAnotherBrokerHoldsLease(deps, homeDir, uid);

  // 4. Side effects begin here. The plist already on disk is read first: a
  //    re-install overwrites it, and a rollback that merely deleted it would
  //    be a silent uninstall wearing the label of an inert failure.
  await prepareServiceDirectories(homeDir, uid);
  const previous = await readPreviousPlist(plistPath);
  await writePlistAtomically(
    plistPath,
    renderLaunchAgentPlist({
      label: SERVICE_AGENT_LABEL,
      programArguments: [deps.execPath, deps.cliPath, "serve"],
      logPath,
      environment,
    }),
  );

  /**
   * Undo this install as far as it can honestly be undone, and say what
   * happened. Two rules keep it from doing harm of its own: it never deletes
   * a plist it could not read, and it re-bootstraps only what was already
   * loaded when install started — starting a broker the user did not have
   * running would take the host lease behind their back.
   */
  const rollback = async (): Promise<string> => {
    const cleared = await verifiedBootout(deps, target, "the new agent");
    if (!cleared.gone) return `${cleared.reason}, so its plist was left in place`;
    if (previous.kind === "unreadable") {
      return "the new agent was unloaded, but the previous plist could not be read, so it was left in place rather than deleted; the plist on disk is the one this install wrote";
    }
    if (previous.kind === "absent") {
      try {
        await rm(plistPath, { force: true });
      } catch (error) {
        return `the new agent was unloaded, but its plist could not be removed (${errnoDetail(error)})`;
      }
      return "the new agent was unloaded and its plist removed; there was no previous install";
    }
    try {
      await writePlistAtomically(plistPath, previous.plist);
    } catch (error) {
      return `the new agent was unloaded, but the previous plist could not be restored (${errnoDetail(error)}), so the plist on disk is the one this install wrote`;
    }
    if (!wasLoadedBefore) {
      return "the previous plist was restored; it was not loaded before this install, so it stays unloaded";
    }
    const restored = await deps.runLaunchctl(["bootstrap", domain, plistPath]);
    if (restored.code !== 0) {
      return `the previous plist was restored, but re-bootstrapping it failed (launchctl bootstrap exit ${restored.code}: ${launchctlDetail(restored)}); run \`embassy service install\` again`;
    }
    const confirmed = await confirmRunning(deps, target);
    if (!confirmed.running) {
      return `the previous plist was restored and re-bootstrapped, but launchd did not confirm it is running (launchctl ${confirmed.verb} exit ${confirmed.result.code}: ${launchctlDetail(confirmed.result)}); run \`embassy service status\``;
    }
    return "the previous plist was restored and re-bootstrapped";
  };
  const failInstall = async (verb: string, result: RunLaunchctlResult): Promise<never> => {
    throw launchctlFailure(verb, result, ` — rollback: ${await rollback()}.`);
  };

  const bootstrap = await deps.runLaunchctl(["bootstrap", domain, plistPath]);
  if (bootstrap.code !== 0) await failInstall("bootstrap", bootstrap);

  // RunAtLoad starts the agent as part of bootstrap; `kickstart -k` would
  // additionally *kill* a healthy broker, so it is never used. A plain
  // kickstart is the fallback for the loaded-but-not-running case only.
  const confirmed = await confirmRunning(deps, target);
  if (!confirmed.running) await failInstall(confirmed.verb, confirmed.result);
  return {
    label: SERVICE_AGENT_LABEL,
    plistPath,
    logPath,
    capturedEnv: Object.keys(environment),
  };
}

export type ServiceAgentUninstallResult = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
}>;

/**
 * Boot the agent out, confirm that launchctl reports the label as *not
 * found*, and only then unlink the plist. The confirmation must be that exact
 * answer: treating any launchctl error (a missing binary, a gui domain that
 * is not up, a timeout) as "gone" would unlink the plist while the agent is
 * still loaded — invisible to `install`, unstoppable by `uninstall`. Logs are
 * left in place.
 */
export async function uninstallServiceAgent(
  deps: ServiceAgentDependencies,
): Promise<ServiceAgentUninstallResult> {
  const uid = requireUid(deps.uid);
  const homeDir = requireAbsolutePath(deps.homeDir, "The login home");
  const { plistPath, logPath } = serviceAgentPaths(homeDir);
  const target = launchctlTarget(uid);
  const cleared = await verifiedBootout(deps, target, "the agent");
  if (!cleared.gone) {
    throw new BridgeError(
      "SERVICE_AGENT_COMMAND_FAILED",
      `Could not unload the launchd agent: ${cleared.reason}. Its plist was left in place.`,
      true,
    );
  }
  const existing = await lstat(plistPath).catch(() => undefined);
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new BridgeError(
      "SERVICE_AGENT_PATH_UNSAFE",
      `${plistPath} is not a regular file; refusing to remove it.`,
      false,
    );
  }
  await rm(plistPath, { force: true });
  return { label: SERVICE_AGENT_LABEL, plistPath, logPath };
}

/**
 * Tolerant reader for `launchctl print`. The sample below is synthetic — it
 * is the shape this parser is written against, not a captured transcript —
 * and the exit-status line is accepted under both spellings macOS has
 * shipped (`last exit code` and `last exit status`):
 *
 *     gui/501/com.agent-embassy.broker = {
 *             active count = 1
 *             state = running
 *             pid = 4242
 *             last exit code = 0
 *     }
 *
 * Anything this cannot recognize is reported as unknown, never as a loaded
 * agent with blank fields.
 */
function parseLaunchctlPrintOutput(
  stdout: string,
): Readonly<{ pid?: number; launchdState?: string; lastExitStatus?: number }> {
  const result: { pid?: number; launchdState?: string; lastExitStatus?: number } = {};
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1];
  if (pid !== undefined) result.pid = Number(pid);
  const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(stdout)?.[1];
  if (state !== undefined) result.launchdState = state;
  const lastExitStatus = /^\s*last exit (?:code|status)\s*=\s*(-?\d+)\s*$/m.exec(stdout)?.[1];
  if (lastExitStatus !== undefined) result.lastExitStatus = Number(lastExitStatus);
  return result;
}

/** The leading ProgramArguments entries of our own rendered plist, if recognizable. */
function parseProgramArguments(plist: string): readonly string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlUnescape(match[1] ?? ""));
}

export type ServiceAgentStatusState = "loaded" | "not loaded" | "unknown";

export type ServiceAgentStatus = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
  plistExists: boolean;
  state: ServiceAgentStatusState;
  pid?: number;
  launchdState?: string;
  lastExitStatus?: number;
  /** ProgramArguments[0]/[1] that are no longer on disk (a version manager moved node). */
  programMissing?: readonly string[];
  /** launchctl's stderr, trimmed and capped at 512 bytes; its stdout is never quoted. */
  launchctlStderr?: string;
  note: string;
}>;

/**
 * Report what is actually knowable. A launchctl that cannot run, or output
 * this version does not recognize, is `unknown` with the reason quoted — not
 * "not loaded", and not "loaded" with blank fields. The plist's own
 * ProgramArguments are checked against the filesystem too: a node binary
 * under a version manager can be removed out from under an installed agent,
 * which launchd otherwise reports only as a repeated spawn failure.
 */
export async function serviceAgentStatus(
  deps: ServiceAgentDependencies,
): Promise<ServiceAgentStatus> {
  const uid = requireUid(deps.uid);
  const homeDir = requireAbsolutePath(deps.homeDir, "The login home");
  const { plistPath, logPath } = serviceAgentPaths(homeDir);

  let plistExists = false;
  const programMissing: string[] = [];
  const plistInfo = await lstat(plistPath).catch(() => undefined);
  if (plistInfo !== undefined && plistInfo.isFile()) {
    plistExists = true;
    if (plistInfo.size <= MAX_PLIST_BYTES) {
      const plist = await readFile(plistPath, "utf8").catch(() => undefined);
      if (plist !== undefined) {
        for (const program of parseProgramArguments(plist).slice(0, 2)) {
          if (program.length === 0) continue;
          const reachable = await stat(program).then(() => true, () => false);
          if (!reachable) programMissing.push(program);
        }
      }
    }
  }

  const printed = await deps.runLaunchctl(["print", launchctlTarget(uid)]);
  const base = { label: SERVICE_AGENT_LABEL, plistPath, logPath, plistExists };
  const suffix = `${plistExists ? "" : " The plist is missing."}${
    programMissing.length === 0
      ? ""
      : ` program missing: ${boundedProgramList(programMissing)} — re-run \`embassy service install\`.`
  }`;
  const missing = programMissing.length === 0 ? {} : { programMissing };

  if (printed.code !== 0) {
    if (isServiceNotFound(printed)) {
      return {
        ...base, ...missing, state: "not loaded",
        note: `The broker is not loaded as a launchd agent.${suffix}`,
      };
    }
    return {
      ...base, ...missing, state: "unknown",
      launchctlStderr: launchctlDetail(printed),
      note: `launchctl could not report on the agent (exit ${printed.code}); its stderr is reported, trimmed and capped at 512 bytes, and its stdout is never quoted.${suffix}`,
    };
  }
  const parsed = parseLaunchctlPrintOutput(printed.stdout);
  if (parsed.pid === undefined && parsed.launchdState === undefined &&
      parsed.lastExitStatus === undefined) {
    return {
      ...base, ...missing, state: "unknown",
      note: `launchctl answered, but this version does not recognize its output.${suffix}`,
    };
  }
  return {
    ...base, ...missing, ...parsed, state: "loaded",
    note: `The broker is loaded as a launchd agent.${suffix}`,
  };
}

function execFileResult(
  command: string,
  args: readonly string[],
): Promise<RunLaunchctlResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args as string[],
      { encoding: "utf8", timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof (error as NodeJS.ErrnoException).code === "number"
          ? ((error as unknown) as { code: number }).code
          : 1;
        // A launchctl that never ran (missing binary, timeout kill) reports
        // nothing on stderr; keep the spawn failure rather than an empty quote.
        resolve({ code, stdout, stderr: stderr.length > 0 ? stderr : error.message });
      },
    );
  });
}

/** The one production launchctl call site; every other reference to it in this module is through this runner. */
export async function defaultRunLaunchctl(args: readonly string[]): Promise<RunLaunchctlResult> {
  return await execFileResult("/bin/launchctl", args);
}
