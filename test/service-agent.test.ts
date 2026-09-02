import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { BridgeError } from "../src/errors.js";
import { acquireGatewayInstanceLease } from "../src/gateway/instance-lease.js";
import {
  SERVICE_AGENT_LABEL,
  captureAgentEnvironment,
  installServiceAgent,
  renderLaunchAgentPlist,
  serviceAgentStatus,
  uninstallServiceAgent,
  type RunLaunchctl,
  type RunLaunchctlResult,
  type ServiceAgentDependencies,
} from "../src/gateway/service-agent.js";

/** Literals for the pure rendering snapshot; nothing on disk is implied. */
const RENDERED_EXEC_PATH = "/usr/local/bin/node";
const RENDERED_CLI_PATH = "/opt/agent-embassy/dist/src/gateway/cli.js";
const LOG_PATH = "/Users/max/Library/Logs/agent-embassy/broker.log";

/** Real, existing absolute paths, so `status` can check ProgramArguments honestly. */
const EXEC_PATH = process.execPath;
const CLI_PATH = fileURLToPath(import.meta.url);
const UID = process.getuid!();
const TARGET = `gui/${UID}/${SERVICE_AGENT_LABEL}`;
const DOMAIN = `gui/${UID}`;

const RUNNING_PRINT =
  `${TARGET} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n`;
const NOT_RUNNING_PRINT =
  `${TARGET} = {\n\tactive count = 0\n\tstate = not running\n\tlast exit code = 1\n}\n`;
const NOT_FOUND_STDERR =
  `Could not find service "${SERVICE_AGENT_LABEL}" in domain for login\n`;

/**
 * A short-lived real temp directory standing in for a login home. Every
 * `homeDir` in this file is one of these — never the real ~/Library — and no
 * test ever runs the real `launchctl`.
 */
async function homeFixture(t: TestContext): Promise<string> {
  const temporary = await realpath(os.tmpdir());
  const home = await mkdtemp(path.join(temporary, "embassy-service-agent-"));
  await chmod(home, 0o700);
  t.after(async () => rm(home, { recursive: true, force: true }));
  return home;
}

type LaunchdScript = Readonly<{
  /** Whether the label is loaded when the fake starts. */
  loaded?: boolean;
  /** What `print` reports while loaded. */
  printStdout?: string;
  /** Force one verb to fail, without applying its effect. */
  fail?: Readonly<Record<string, RunLaunchctlResult>>;
}>;

/**
 * A fake launchd: enough state to answer `print` honestly after `bootout`
 * and `bootstrap`, so the ordering the install path depends on is actually
 * exercised rather than assumed.
 */
function fakeLaunchd(script: LaunchdScript = {}): {
  run: RunLaunchctl;
  calls: string[][];
  isLoaded: () => boolean;
} {
  const calls: string[][] = [];
  let loaded = script.loaded ?? false;
  const printStdout = script.printStdout ?? RUNNING_PRINT;
  const run: RunLaunchctl = async (args) => {
    calls.push([...args]);
    const verb = args[0] ?? "";
    const forced = script.fail?.[verb];
    if (forced !== undefined) return forced;
    switch (verb) {
      case "print":
        return loaded
          ? { code: 0, stdout: printStdout, stderr: "" }
          : { code: 113, stdout: "", stderr: NOT_FOUND_STDERR };
      case "bootout":
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      case "bootstrap":
        loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      case "kickstart":
        return { code: 0, stdout: "", stderr: "" };
      default:
        return { code: 64, stdout: "", stderr: `unexpected launchctl verb ${verb}` };
    }
  };
  return { run, calls, isLoaded: () => loaded };
}

function baseDeps(
  homeDir: string,
  overrides: Partial<ServiceAgentDependencies> = {},
): ServiceAgentDependencies {
  return {
    homeDir,
    runLaunchctl: fakeLaunchd().run,
    env: {},
    execPath: EXEC_PATH,
    cliPath: CLI_PATH,
    uid: UID,
    ...overrides,
  };
}

const plistPathIn = (home: string): string =>
  path.join(home, "Library", "LaunchAgents", `${SERVICE_AGENT_LABEL}.plist`);
const logPathIn = (home: string): string =>
  path.join(home, "Library", "Logs", "agent-embassy", "broker.log");

test("plist rendering is an exact snapshot: KeepAlive restarts only after a crash", () => {
  const rendered = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [RENDERED_EXEC_PATH, RENDERED_CLI_PATH, "serve"],
    logPath: LOG_PATH,
    environment: { EMBASSY_STATE_DIR: "/custom/state/dir", XDG_STATE_HOME: "/custom/state" },
  });
  assert.equal(
    rendered,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-embassy.broker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${RENDERED_EXEC_PATH}</string>
        <string>${RENDERED_CLI_PATH}</string>
        <string>serve</string>
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
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>EMBASSY_STATE_DIR</key>
        <string>/custom/state/dir</string>
        <key>XDG_STATE_HOME</key>
        <string>/custom/state</string>
    </dict>
</dict>
</plist>
`,
  );
  // A deliberate boot refusal (unsupported schema, instance in use) is a
  // clean non-zero exit, and must not be relaunched forever.
  assert.doesNotMatch(rendered, /<key>KeepAlive<\/key>\s*<true\/>/);

  const withoutEnvironment = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [RENDERED_EXEC_PATH, RENDERED_CLI_PATH, "serve"],
    logPath: LOG_PATH,
    environment: {},
  });
  assert.doesNotMatch(withoutEnvironment, /EnvironmentVariables/);
  assert.match(withoutEnvironment, /<key>StandardErrorPath<\/key>\n    <string>[^<]+<\/string>\n<\/dict>/);
});

test("env capture takes EMBASSY_* and XDG_STATE_HOME, leaks nothing else, and demands absolute state roots", () => {
  const captured = captureAgentEnvironment({
    EMBASSY_STATE_DIR: "/custom/state/dir",
    EMBASSY_MAX_ROUTES: "64",
    XDG_STATE_HOME: "/custom/state",
    PATH: "/usr/bin:/never-appears",
    HOME: "/Users/never-appears",
    OPENAI_API_KEY: "sk-should-never-appear",
    SOME_OTHER_SECRET: "also-should-never-appear",
    EMBASSY_EMPTY: "",
  });
  assert.deepEqual(captured, {
    EMBASSY_MAX_ROUTES: "64",
    EMBASSY_STATE_DIR: "/custom/state/dir",
    XDG_STATE_HOME: "/custom/state",
  });

  const plist = renderLaunchAgentPlist({
    label: SERVICE_AGENT_LABEL,
    programArguments: [RENDERED_EXEC_PATH, RENDERED_CLI_PATH, "serve"],
    logPath: LOG_PATH,
    environment: captured,
  });
  assert.deepEqual(
    [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]),
    [
      "Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "Crashed",
      "ThrottleInterval", "StandardOutPath", "StandardErrorPath",
      "EnvironmentVariables",
      "EMBASSY_MAX_ROUTES", "EMBASSY_STATE_DIR", "XDG_STATE_HOME",
    ],
  );
  // The exact key list above is the real guarantee; this catches values too.
  // (`HOME` and `PATH` as substrings are legitimate here: XDG_STATE_HOME is
  // captured on purpose and StandardOutPath is a plist key.)
  assert.doesNotMatch(plist, /never-appears|OPENAI_API_KEY|SOME_OTHER_SECRET/);

  for (const relative of [{ EMBASSY_STATE_DIR: "relative/state" }, { XDG_STATE_HOME: "relative" }]) {
    assert.throws(
      () => captureAgentEnvironment(relative),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "INVALID_GATEWAY_CONFIGURATION" &&
        error.recoverable === false && /absolute/.test(error.message),
    );
  }
  assert.throws(
    () => captureAgentEnvironment({ EMBASSY_STATE_DIR: "/state\ndir" }),
    (error: unknown) => error instanceof BridgeError && /control character/.test(error.message),
  );
});

test("install on a clean home writes the plist and bootstraps, without kickstart -k", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd();
  const stateDir = path.join(home, "state");
  const result = await installServiceAgent(
    baseDeps(home, {
      runLaunchctl: launchd.run,
      env: { EMBASSY_STATE_DIR: stateDir, OPENAI_API_KEY: "sk-never" },
    }),
  );

  assert.equal(result.plistPath, plistPathIn(home));
  assert.equal(result.logPath, logPathIn(home));
  assert.equal(result.label, SERVICE_AGENT_LABEL);
  assert.deepEqual(result.capturedEnv, ["EMBASSY_STATE_DIR"]);

  assert.deepEqual(launchd.calls, [
    ["print", TARGET],
    ["bootstrap", DOMAIN, result.plistPath],
    ["print", TARGET],
  ]);
  assert.equal(launchd.calls.some((call) => call.includes("-k")), false);

  const plistStat = await lstat(result.plistPath);
  assert.equal(plistStat.mode & 0o777, 0o644);
  assert.equal((await lstat(path.join(home, "Library", "LaunchAgents"))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(home, "Library", "Logs", "agent-embassy"))).mode & 0o777, 0o700);

  const plist = await readFile(result.plistPath, "utf8");
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, new RegExp(`<string>${stateDir}</string>`));
  assert.doesNotMatch(plist, /sk-never|OPENAI_API_KEY/);
  // The atomic write leaves no temp file behind next to the plist.
  assert.deepEqual(
    await readdir(path.join(home, "Library", "LaunchAgents")),
    [`${SERVICE_AGENT_LABEL}.plist`],
  );
});

test("re-install over its own loaded agent boots it out and succeeds, instead of refusing", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd({ loaded: true });
  const result = await installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run }));

  assert.deepEqual(launchd.calls, [
    ["print", TARGET],
    ["bootout", TARGET],
    ["print", TARGET],
    ["bootstrap", DOMAIN, result.plistPath],
    ["print", TARGET],
  ]);
  assert.equal(launchd.isLoaded(), true);
  assert.equal((await lstat(result.plistPath)).isFile(), true);
});

test("install kickstarts without -k only when the bootstrapped agent is loaded but not running", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd({ printStdout: NOT_RUNNING_PRINT });
  const result = await installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run }));
  assert.deepEqual(launchd.calls, [
    ["print", TARGET],
    ["bootstrap", DOMAIN, result.plistPath],
    ["print", TARGET],
    ["kickstart", TARGET],
  ]);
});

test("install refuses while a live broker holds the host lease, naming that pid and quoting the lease", async (t) => {
  const home = await homeFixture(t);
  const lease = await acquireGatewayInstanceLease(home);
  t.after(async () => {
    await lease.close();
  });

  const launchd = fakeLaunchd();
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_INSTANCE_IN_USE" &&
      error.recoverable &&
      error.message.startsWith(`Another Embassy broker holds the host lease (pid ${process.pid}, alive) — stop it (\`embassy service uninstall\` if it is the launchd agent, otherwise the \`embassy serve\` terminal), then re-run install.`) &&
      error.message.includes("The lease reported: "),
  );
  // The lease is probed after our own label is cleared, but still before any
  // write: nothing was installed.
  assert.deepEqual(launchd.calls, [["print", TARGET]]);
  await assert.rejects(lstat(path.join(home, "Library", "LaunchAgents")));
});

test("a non-contention lease failure quotes the lease verbatim and names no pid", async (t) => {
  const home = await homeFixture(t);
  const elsewhere = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-service-elsewhere-"));
  t.after(async () => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(path.join(home, ".local"), { mode: 0o700 });
  await symlink(elsewhere, path.join(home, ".local", "state"));

  const launchd = fakeLaunchd();
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_INSTANCE_IN_USE" &&
      error.message ===
        "The Embassy host lease could not be acquired, so nothing was installed. The lease reported: An Embassy host-lease path component is not a current-user real directory." &&
      !/pid/.test(error.message),
  );
  await assert.rejects(lstat(plistPathIn(home)));
});

test("a failing bootstrap rolls the install back and carries launchctl's stderr", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd({
    fail: { bootstrap: { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" } },
  });
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "SERVICE_AGENT_COMMAND_FAILED" &&
      error.recoverable &&
      error.message ===
        "launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error The install was rolled back: the agent was booted out and the plist removed.",
  );
  assert.deepEqual(launchd.calls, [
    ["print", TARGET],
    ["bootstrap", DOMAIN, plistPathIn(home)],
    ["bootout", TARGET],
  ]);
  await assert.rejects(lstat(plistPathIn(home)));
});

test("a failing kickstart rolls the install back too", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd({
    printStdout: NOT_RUNNING_PRINT,
    fail: { kickstart: { code: 3, stdout: "", stderr: "Could not kickstart service\n" } },
  });
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "SERVICE_AGENT_COMMAND_FAILED" &&
      /Could not kickstart service The install was rolled back/.test(error.message),
  );
  await assert.rejects(lstat(plistPathIn(home)));
});

test("install validates its inputs before any launchctl call or write", async (t) => {
  const home = await homeFixture(t);
  const launchd = fakeLaunchd();
  await assert.rejects(
    installServiceAgent(baseDeps(home, { runLaunchctl: launchd.run, env: { EMBASSY_STATE_DIR: "relative" } })),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.deepEqual(launchd.calls, []);
  await assert.rejects(lstat(path.join(home, "Library")));
});

test("install refuses a symlinked LaunchAgents directory and leaves a pre-hardened one alone", async (t) => {
  const symlinked = await homeFixture(t);
  const elsewhere = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-service-agents-"));
  t.after(async () => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(path.join(symlinked, "Library"), { mode: 0o755 });
  await symlink(elsewhere, path.join(symlinked, "Library", "LaunchAgents"));
  const symlinkLaunchd = fakeLaunchd();
  await assert.rejects(
    installServiceAgent(baseDeps(symlinked, { runLaunchctl: symlinkLaunchd.run })),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "SERVICE_AGENT_PATH_UNSAFE" &&
      /is not a real directory/.test(error.message),
  );
  await assert.rejects(lstat(path.join(elsewhere, `${SERVICE_AGENT_LABEL}.plist`)));

  const hardened = await homeFixture(t);
  await mkdir(path.join(hardened, "Library"), { mode: 0o755 });
  await mkdir(path.join(hardened, "Library", "LaunchAgents"), { mode: 0o700 });
  await chmod(path.join(hardened, "Library", "LaunchAgents"), 0o700);
  const result = await installServiceAgent(baseDeps(hardened, { runLaunchctl: fakeLaunchd().run }));
  // An installer has no business loosening a directory the user tightened.
  assert.equal((await lstat(path.join(hardened, "Library", "LaunchAgents"))).mode & 0o777, 0o700);
  assert.equal((await lstat(result.plistPath)).mode & 0o777, 0o644);
});

test("uninstall boots the agent out, confirms it is gone, and leaves the log", async (t) => {
  const home = await homeFixture(t);
  const installed = await installServiceAgent(baseDeps(home, { runLaunchctl: fakeLaunchd().run }));
  await writeFile(installed.logPath, "broker output\n", { mode: 0o600 });

  const launchd = fakeLaunchd({ loaded: true });
  const result = await uninstallServiceAgent(baseDeps(home, { runLaunchctl: launchd.run }));
  assert.deepEqual(result, {
    label: SERVICE_AGENT_LABEL, plistPath: installed.plistPath, logPath: installed.logPath,
  });
  assert.deepEqual(launchd.calls, [["bootout", TARGET], ["print", TARGET]]);

  await assert.rejects(lstat(installed.plistPath));
  assert.equal(await readFile(installed.logPath, "utf8"), "broker output\n");
});

test("uninstall keeps the plist when bootout fails, and reports launchctl's stderr", async (t) => {
  const home = await homeFixture(t);
  const installed = await installServiceAgent(baseDeps(home, { runLaunchctl: fakeLaunchd().run }));

  const launchd = fakeLaunchd({
    loaded: true,
    fail: { bootout: { code: 9, stdout: "", stderr: "Boot-out failed: 5: Input/output error\n" } },
  });
  await assert.rejects(
    uninstallServiceAgent(baseDeps(home, { runLaunchctl: launchd.run })),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "SERVICE_AGENT_COMMAND_FAILED" &&
      error.recoverable &&
      error.message ===
        "launchctl bootout failed (exit 9): Boot-out failed: 5: Input/output error — the agent is still loaded, so its plist was left in place.",
  );
  assert.equal((await lstat(installed.plistPath)).isFile(), true);
});

test("uninstall of a never-installed agent does not throw", async (t) => {
  const home = await homeFixture(t);
  const result = await uninstallServiceAgent(baseDeps(home, { runLaunchctl: fakeLaunchd().run }));
  await assert.rejects(lstat(result.plistPath));
});

test("status separates loaded, not loaded, and unknown, and notices a vanished program", async (t) => {
  const home = await homeFixture(t);
  const installed = await installServiceAgent(baseDeps(home, { runLaunchctl: fakeLaunchd().run }));

  const loaded = fakeLaunchd({ loaded: true });
  assert.deepEqual(await serviceAgentStatus(baseDeps(home, { runLaunchctl: loaded.run })), {
    label: SERVICE_AGENT_LABEL,
    plistPath: installed.plistPath,
    logPath: installed.logPath,
    plistExists: true,
    state: "loaded",
    pid: 4242,
    launchdState: "running",
    lastExitStatus: 0,
    note: "The broker is loaded as a launchd agent.",
  });
  assert.deepEqual(loaded.calls, [["print", TARGET]]);

  // macOS has shipped both spellings of the exit line.
  const spelled = fakeLaunchd({
    loaded: true,
    printStdout: `${TARGET} = {\n\tstate = not running\n\tlast exit status = 2\n}\n`,
  });
  const spelledStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: spelled.run }));
  assert.equal(spelledStatus.state, "loaded");
  assert.equal(spelledStatus.launchdState, "not running");
  assert.equal(spelledStatus.lastExitStatus, 2);
  assert.equal("pid" in spelledStatus, false);

  const notLoaded = fakeLaunchd();
  const notLoadedStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: notLoaded.run }));
  assert.equal(notLoadedStatus.state, "not loaded");
  assert.equal(notLoadedStatus.note, "The broker is not loaded as a launchd agent.");
  assert.equal(notLoadedStatus.launchctlStderr, undefined);

  // launchctl itself could not answer: never rendered as "not loaded".
  const broken = fakeLaunchd({
    fail: { print: { code: 1, stdout: "", stderr: "spawn /bin/launchctl ENOENT" } },
  });
  const brokenStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: broken.run }));
  assert.equal(brokenStatus.state, "unknown");
  assert.equal(brokenStatus.launchctlStderr, "spawn /bin/launchctl ENOENT");
  assert.match(brokenStatus.note, /launchctl could not report on the agent \(exit 1\)/);

  // Recognized nothing: never rendered as "loaded" with blank fields.
  const unrecognized = fakeLaunchd({ loaded: true, printStdout: "who knows\n" });
  const unrecognizedStatus = await serviceAgentStatus(baseDeps(home, { runLaunchctl: unrecognized.run }));
  assert.equal(unrecognizedStatus.state, "unknown");
  assert.equal(unrecognizedStatus.note, "launchctl answered, but this version does not recognize its output.");

  // No plist at all.
  await rm(installed.plistPath, { force: true });
  const plistless = await serviceAgentStatus(baseDeps(home, { runLaunchctl: fakeLaunchd().run }));
  assert.equal(plistless.plistExists, false);
  assert.equal(plistless.note, "The broker is not loaded as a launchd agent. The plist is missing.");
});

test("status reports a program the plist points at that is no longer on disk", async (t) => {
  const home = await homeFixture(t);
  const gone = path.join(home, "vanished-node");
  await installServiceAgent(baseDeps(home, { runLaunchctl: fakeLaunchd().run, execPath: gone }));

  const status = await serviceAgentStatus(baseDeps(home, { runLaunchctl: fakeLaunchd({ loaded: true }).run }));
  assert.equal(status.state, "loaded");
  assert.deepEqual(status.programMissing, [gone]);
  assert.equal(
    status.note,
    `The broker is loaded as a launchd agent. program missing: ${gone} — re-run \`embassy service install\`.`,
  );
});
