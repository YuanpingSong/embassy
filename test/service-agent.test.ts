import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import { acquireGatewayInstanceLease } from "../src/gateway/instance-lease.js";
import {
  SERVICE_AGENT_LABEL,
  installServiceAgent,
  renderLaunchAgentPlist,
  serviceAgentStatus,
  uninstallServiceAgent,
  type RunLaunchctlResult,
  type ServiceAgentDependencies,
} from "../src/gateway/service-agent.js";

const EXEC_PATH = "/usr/local/bin/node";
const CLI_PATH = "/opt/agent-embassy/dist/src/gateway/cli.js";
const LOG_PATH = "/Users/max/Library/Logs/agent-embassy/broker.log";
const UID = 501;

/**
 * A short-lived real temp directory standing in for a login home. Every
 * `homeDir` in this file is one of these — never the real ~/Library.
 */
async function homeFixture(t: TestContext): Promise<string> {
  const temporary = await realpath(os.tmpdir());
  const home = await mkdtemp(path.join(temporary, "embassy-service-agent-"));
  await chmod(home, 0o700);
  t.after(async () => rm(home, { recursive: true, force: true }));
  return home;
}

type RecordedCall = { args: readonly string[] };

function fakeRunLaunchctl(
  responses: readonly RunLaunchctlResult[] = [],
): { run: ServiceAgentDependencies["runLaunchctl"]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  return {
    calls,
    run: async (args) => {
      calls.push({ args });
      const next = responses[index] ?? { code: 0, stdout: "", stderr: "" };
      index += 1;
      return next;
    },
  };
}

function baseDeps(
  homeDir: string,
  overrides: Partial<ServiceAgentDependencies> = {},
): ServiceAgentDependencies {
  return {
    homeDir,
    runLaunchctl: fakeRunLaunchctl().run,
    env: {},
    execPath: EXEC_PATH,
    cliPath: CLI_PATH,
    uid: UID,
    ...overrides,
  };
}

test("plist rendering is an exact snapshot and leaks no env key beyond EMBASSY_STATE_DIR", () => {
  const withState = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [EXEC_PATH, CLI_PATH, "serve"],
    logPath: LOG_PATH,
    env: { EMBASSY_STATE_DIR: "/custom/state/dir" },
  });
  assert.equal(
    withState,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-embassy.broker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${EXEC_PATH}</string>
        <string>${CLI_PATH}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>EMBASSY_STATE_DIR</key>
        <string>/custom/state/dir</string>
    </dict>
</dict>
</plist>
`,
  );

  const withoutState = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [EXEC_PATH, CLI_PATH, "serve"],
    logPath: LOG_PATH,
    env: {},
  });
  assert.equal(
    withoutState,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-embassy.broker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${EXEC_PATH}</string>
        <string>${CLI_PATH}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
</dict>
</plist>
`,
  );
  assert.doesNotMatch(withoutState, /EnvironmentVariables/);

  // A caller's env can carry an arbitrary amount of unrelated and sensitive
  // material (secrets included) — none of it may leak into the plist, and
  // EnvironmentVariables must never carry more than the one allowed key.
  const noisy = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [EXEC_PATH, CLI_PATH, "serve"],
    logPath: LOG_PATH,
    env: {
      EMBASSY_STATE_DIR: "/custom/state/dir",
      PATH: "/usr/bin:/bin",
      HOME: "/Users/max",
      OPENAI_API_KEY: "sk-should-never-appear",
      SOME_OTHER_SECRET: "also-should-never-appear",
    },
  });
  const environmentKeys = [...noisy.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  // Label, ProgramArguments, RunAtLoad, KeepAlive, ThrottleInterval,
  // StandardOutPath, StandardErrorPath, EnvironmentVariables, plus exactly
  // one key inside the EnvironmentVariables dict.
  assert.deepEqual(environmentKeys, [
    "Label",
    "ProgramArguments",
    "RunAtLoad",
    "KeepAlive",
    "ThrottleInterval",
    "StandardOutPath",
    "StandardErrorPath",
    "EnvironmentVariables",
    "EMBASSY_STATE_DIR",
  ]);
  assert.doesNotMatch(noisy, /PATH|HOME|OPENAI_API_KEY|SOME_OTHER_SECRET|sk-should-never-appear|also-should-never-appear/);
});

test("install writes the plist under the injected home with the right modes and the expected launchctl argv sequence", async (t) => {
  const home = await homeFixture(t);
  const { run, calls } = fakeRunLaunchctl();
  const result = await installServiceAgent(baseDeps(home, { runLaunchctl: run }));

  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const logsDir = path.join(home, "Library", "Logs", "agent-embassy");
  assert.equal(result.plistPath, path.join(launchAgentsDir, `${SERVICE_AGENT_LABEL}.plist`));
  assert.equal(result.logPath, path.join(logsDir, "broker.log"));
  assert.equal(result.label, SERVICE_AGENT_LABEL);

  const plistStat = await lstat(result.plistPath);
  assert.equal(plistStat.mode & 0o777, 0o644);
  const launchAgentsStat = await lstat(launchAgentsDir);
  assert.equal(launchAgentsStat.mode & 0o777, 0o755);
  const logsStat = await lstat(logsDir);
  assert.equal(logsStat.mode & 0o777, 0o700);

  const plistContent = await readFile(result.plistPath, "utf8");
  assert.match(plistContent, new RegExp(`<string>${EXEC_PATH.replace(/\//g, "\\/")}</string>`));
  assert.match(plistContent, /<string>serve<\/string>/);

  const target = `gui/${UID}/${SERVICE_AGENT_LABEL}`;
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["bootout", target],
      ["bootstrap", `gui/${UID}`, result.plistPath],
      ["kickstart", "-k", target],
    ],
  );
});

test("re-install is idempotent", async (t) => {
  const home = await homeFixture(t);
  const { run, calls } = fakeRunLaunchctl();
  const deps = baseDeps(home, { runLaunchctl: run });

  const first = await installServiceAgent(deps);
  const second = await installServiceAgent(deps);
  assert.deepEqual(first, second);

  const target = `gui/${UID}/${SERVICE_AGENT_LABEL}`;
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["bootout", target],
      ["bootstrap", `gui/${UID}`, first.plistPath],
      ["kickstart", "-k", target],
      ["bootout", target],
      ["bootstrap", `gui/${UID}`, first.plistPath],
      ["kickstart", "-k", target],
    ],
  );
});

test("install refuses when a foreground broker already holds the host lease, naming its pid", async (t) => {
  const home = await homeFixture(t);
  const lease = await acquireGatewayInstanceLease(home);
  t.after(async () => {
    await lease.close();
  });

  const { run, calls } = fakeRunLaunchctl();
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_INSTANCE_IN_USE" &&
      error.message.includes(`pid ${process.pid}`) &&
      error.message.includes("embassy service install"),
  );
  // The refusal happens before any launchctl call and before any write.
  assert.deepEqual(calls, []);
  await assert.rejects(lstat(path.join(home, "Library", "LaunchAgents")));
});

test("uninstall boots the agent out and unlinks the plist, leaving logs in place", async (t) => {
  const home = await homeFixture(t);
  const { run: installRun } = fakeRunLaunchctl();
  const installed = await installServiceAgent(baseDeps(home, { runLaunchctl: installRun }));

  // Leave evidence in the log file — uninstall must not touch it.
  await writeFile(installed.logPath, "broker output\n", { mode: 0o600 });

  const { run: uninstallRun, calls } = fakeRunLaunchctl();
  const result = await uninstallServiceAgent(baseDeps(home, { runLaunchctl: uninstallRun }));
  assert.deepEqual(result, installed);

  const target = `gui/${UID}/${SERVICE_AGENT_LABEL}`;
  assert.deepEqual(calls.map((c) => c.args), [["bootout", target]]);

  await assert.rejects(lstat(installed.plistPath));
  const logStat = await lstat(installed.logPath);
  assert.equal(logStat.isFile(), true);
  assert.equal(await readFile(installed.logPath, "utf8"), "broker output\n");
});

test("uninstall of a never-installed agent does not throw", async (t) => {
  const home = await homeFixture(t);
  const { run } = fakeRunLaunchctl();
  const result = await uninstallServiceAgent(baseDeps(home, { runLaunchctl: run }));
  await assert.rejects(lstat(result.plistPath));
});

test("status parses loaded-with-pid, loaded-not-running, and not-loaded", async (t) => {
  const home = await homeFixture(t);
  const target = `gui/${UID}/${SERVICE_AGENT_LABEL}`;

  const running = fakeRunLaunchctl([
    {
      code: 0,
      stdout: `${target} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n`,
      stderr: "",
    },
  ]);
  const runningStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: running.run }));
  assert.deepEqual(runningStatus, {
    label: SERVICE_AGENT_LABEL,
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_AGENT_LABEL}.plist`),
    logPath: path.join(home, "Library", "Logs", "agent-embassy", "broker.log"),
    loaded: true,
    pid: 4242,
    state: "running",
    lastExitStatus: 0,
  });
  assert.deepEqual(running.calls.map((c) => c.args), [["print", target]]);

  const notRunning = fakeRunLaunchctl([
    {
      code: 0,
      stdout: `${target} = {\n\tactive count = 0\n\tstate = not running\n\tlast exit code = 1\n}\n`,
      stderr: "",
    },
  ]);
  const notRunningStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: notRunning.run }));
  assert.equal(notRunningStatus.loaded, true);
  assert.equal(notRunningStatus.state, "not running");
  assert.equal(notRunningStatus.lastExitStatus, 1);
  assert.equal("pid" in notRunningStatus, false);

  const notLoaded = fakeRunLaunchctl([
    { code: 3, stdout: "", stderr: `Could not find service "${SERVICE_AGENT_LABEL}" in domain for port\n` },
  ]);
  const notLoadedStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: notLoaded.run }));
  assert.deepEqual(notLoadedStatus, {
    label: SERVICE_AGENT_LABEL,
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_AGENT_LABEL}.plist`),
    logPath: path.join(home, "Library", "Logs", "agent-embassy", "broker.log"),
    loaded: false,
    note: "The broker is not loaded as a launchd agent.",
  });
});
