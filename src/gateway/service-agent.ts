/**
 * Run the broker as a macOS launchd agent. This module renders the plist,
 * drives `launchctl` through an injected runner (real callers spawn the
 * system binary; tests inject a fake), and refuses to install over a
 * foreground broker that already holds the host-wide instance lease
 * (src/gateway/instance-lease.ts). It never touches the real ~/Library
 * itself — every path is derived from an injected `homeDir`.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { acquireGatewayInstanceLease } from "./instance-lease.js";

export const SERVICE_AGENT_LABEL = "com.agent-embassy.broker";

// The host-wide advisory lease lives at this fixed path under the login
// home, independent of EMBASSY_STATE_DIR (see instance-lease.ts). The path
// components are not exported by that module (they are load-bearing only
// for its own lock file), so they are named again here — the same
// duplication test/gateway-instance-lease.test.ts already carries — solely
// to read the current holder's pid for a friendlier refusal message.
const HOST_LEASE_LOCK_RELATIVE_PATH = path.join(
  ".local",
  "state",
  "agent-embassy",
  ".gateway-host.lock",
);

export type LaunchAgentPlistOptions = Readonly<{
  label: string;
  programArguments: readonly string[];
  logPath: string;
  env: NodeJS.ProcessEnv;
}>;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stringElement(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

/**
 * Render the launchd agent plist. EnvironmentVariables carries only
 * EMBASSY_STATE_DIR, and only when the installing process's env sets it —
 * PATH is not needed (every child process this broker spawns — the codex
 * standalone binary, /bin/ps, /usr/bin/lockf, /bin/cat — is invoked by an
 * absolute path already; see codex-local-transport.ts, claude-peer.ts, and
 * instance-lease.ts). No other key ever leaks, secrets included.
 */
export function renderLaunchAgentPlist(options: LaunchAgentPlistOptions): string {
  const stateDir = options.env.EMBASSY_STATE_DIR;
  const hasStateDir = typeof stateDir === "string" && stateDir.length > 0;
  const argumentsXml = options.programArguments
    .map((argument) => `        ${stringElement(argument)}`)
    .join("\n");
  const environmentXml = hasStateDir
    ? [
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        "        <key>EMBASSY_STATE_DIR</key>",
        `        ${stringElement(stateDir)}`,
        "    </dict>",
        "",
      ].join("\n")
    : "";
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
    <true/>
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

export type ServiceAgentFsDependencies = Readonly<{
  mkdir: (target: string, options: { recursive: boolean; mode: number }) => Promise<unknown>;
  writeFile: (target: string, data: string, options: { mode: number }) => Promise<void>;
  chmod: (target: string, mode: number) => Promise<void>;
  rm: (target: string, options: { force: boolean }) => Promise<void>;
}>;

const defaultFs: ServiceAgentFsDependencies = { mkdir, writeFile, chmod, rm };

export type ServiceAgentDependencies = Readonly<{
  homeDir: string;
  runLaunchctl: RunLaunchctl;
  env: NodeJS.ProcessEnv;
  execPath: string;
  cliPath: string;
  uid: number;
  fs?: ServiceAgentFsDependencies;
}>;

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

async function readHeldLeasePid(homeDir: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(homeDir, HOST_LEASE_LOCK_RELATIVE_PATH), "utf8");
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
 * Refuse to install over a foreground broker. This reuses the exact
 * detection the broker itself relies on for single-instance correctness: a
 * non-blocking probe of the host-wide advisory lease
 * (acquireGatewayInstanceLease, unmodified). If nobody holds it, the probe
 * itself briefly acquires it and is released immediately. If it is held,
 * the current holder's pid is read (best effort, for the message only) from
 * the same lock file the lease already writes.
 */
async function refuseIfForegroundBrokerHoldsLease(homeDir: string): Promise<void> {
  let lease;
  try {
    lease = await acquireGatewayInstanceLease(homeDir);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE") {
      const pid = await readHeldLeasePid(homeDir);
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        pid === undefined
          ? "A foreground Embassy broker already holds the host lease. Stop it, then run `embassy service install` again."
          : `A foreground Embassy broker (pid ${pid}) already holds the host lease. Stop it, then run \`embassy service install\` again.`,
        true,
      );
    }
    throw error;
  }
  await lease.close();
}

export type ServiceAgentInstallResult = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
}>;

/** Idempotent: safe to call again over a prior install (its own launchd agent). */
export async function installServiceAgent(
  deps: ServiceAgentDependencies,
): Promise<ServiceAgentInstallResult> {
  await refuseIfForegroundBrokerHoldsLease(deps.homeDir);
  const fs = deps.fs ?? defaultFs;
  const { launchAgentsDir, logsDir, plistPath, logPath } = serviceAgentPaths(deps.homeDir);
  await fs.mkdir(launchAgentsDir, { recursive: true, mode: 0o755 });
  await fs.chmod(launchAgentsDir, 0o755);
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(logsDir, 0o700);
  const plist = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [deps.execPath, deps.cliPath, "serve"],
    logPath,
    env: deps.env,
  });
  await fs.writeFile(plistPath, plist, { mode: 0o644 });
  await fs.chmod(plistPath, 0o644);
  const target = launchctlTarget(deps.uid);
  // Ignore bootout's result: "not currently loaded" is the expected,
  // ignorable common case (first install, or re-install after a crash), and
  // any genuine problem still surfaces from the bootstrap call right after.
  await deps.runLaunchctl(["bootout", target]);
  const bootstrap = await deps.runLaunchctl(["bootstrap", launchctlDomain(deps.uid), plistPath]);
  if (bootstrap.code !== 0) {
    throw new BridgeError(
      "SERVICE_AGENT_COMMAND_FAILED",
      `launchctl bootstrap failed (exit ${bootstrap.code}): ${bootstrap.stderr.trim() || bootstrap.stdout.trim() || "no output"}`,
    );
  }
  const kickstart = await deps.runLaunchctl(["kickstart", "-k", target]);
  if (kickstart.code !== 0) {
    throw new BridgeError(
      "SERVICE_AGENT_COMMAND_FAILED",
      `launchctl kickstart failed (exit ${kickstart.code}): ${kickstart.stderr.trim() || kickstart.stdout.trim() || "no output"}`,
    );
  }
  return { label: SERVICE_AGENT_LABEL, plistPath, logPath };
}

export type ServiceAgentUninstallResult = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
}>;

/** Bootout, then unlink the plist. Logs are left in place. */
export async function uninstallServiceAgent(
  deps: ServiceAgentDependencies,
): Promise<ServiceAgentUninstallResult> {
  const fs = deps.fs ?? defaultFs;
  const { plistPath, logPath } = serviceAgentPaths(deps.homeDir);
  await deps.runLaunchctl(["bootout", launchctlTarget(deps.uid)]);
  await fs.rm(plistPath, { force: true });
  return { label: SERVICE_AGENT_LABEL, plistPath, logPath };
}

function parseLaunchctlPrintOutput(
  stdout: string,
): Readonly<{ pid?: number; state?: string; lastExitStatus?: number }> {
  const result: { pid?: number; state?: string; lastExitStatus?: number } = {};
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1];
  if (pid !== undefined) result.pid = Number(pid);
  const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(stdout)?.[1];
  if (state !== undefined) result.state = state;
  const lastExitStatus = /^\s*last exit code\s*=\s*(-?\d+)\s*$/m.exec(stdout)?.[1];
  if (lastExitStatus !== undefined) result.lastExitStatus = Number(lastExitStatus);
  return result;
}

export type ServiceAgentStatus = Readonly<{
  label: string;
  plistPath: string;
  logPath: string;
  loaded: boolean;
  pid?: number;
  state?: string;
  lastExitStatus?: number;
  note?: string;
}>;

export async function serviceAgentStatus(deps: ServiceAgentDependencies): Promise<ServiceAgentStatus> {
  const { plistPath, logPath } = serviceAgentPaths(deps.homeDir);
  const printed = await deps.runLaunchctl(["print", launchctlTarget(deps.uid)]);
  const base = { label: SERVICE_AGENT_LABEL, plistPath, logPath };
  if (printed.code !== 0) {
    return { ...base, loaded: false, note: "The broker is not loaded as a launchd agent." };
  }
  return { ...base, loaded: true, ...parseLaunchctlPrintOutput(printed.stdout) };
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
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** The one production launchctl call site; every other reference to it in this module is through this runner. */
export async function defaultRunLaunchctl(args: readonly string[]): Promise<RunLaunchctlResult> {
  return await execFileResult("/bin/launchctl", args);
}
