import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  buildClaudeCliEnvironment,
  buildClaudeCliInvocation,
  buildClaudeCliSettings,
  ClaudeCliDriver,
  type ClaudeSpawn,
} from "../src/claude-driver.js";
import { BridgeError } from "../src/errors.js";
import type {
  AgentCallbacks,
  AgentStartRequest,
  FinalReport,
} from "../src/types.js";

async function fixture(
  permissionProfile: AgentStartRequest["permissionProfile"] = "read_only",
): Promise<AgentStartRequest> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-test-"));
  const cwd = path.join(root, "workspace");
  const state = path.join(root, "state");
  const temporary = path.join(state, "tmp", "task");
  const profile = path.join(state, "profiles", "task");
  await Promise.all(
    [cwd, temporary, profile].map(
      async (directory) =>
        await mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  const [
    canonicalCwd,
    canonicalState,
    canonicalTemporary,
    canonicalProfile,
  ] =
    await Promise.all([
      realpath(cwd),
      realpath(state),
      realpath(temporary),
      realpath(profile),
    ]);
  return {
    taskId: "claude_00000000-0000-0000-0000-000000000001",
    title: "driver test",
    initialPrompt: "Inspect safely.",
    cwd: canonicalCwd,
    permissionProfile,
    networkAccess: "none",
    maxTurns: 10,
    stateDir: canonicalState,
    tempDir: canonicalTemporary,
    profileDir: canonicalProfile,
    execEnabled: permissionProfile === "workspace_exec",
    webEnabled: false,
  };
}

function argumentValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  const value = args[index + 1];
  assert.ok(value !== undefined, `missing value for ${name}`);
  return value;
}

function initMessage(
  request: AgentStartRequest,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const invocation = buildClaudeCliInvocation("/trusted/claude", request);
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-test",
    apiKeySource: "oauth",
    claude_code_version: "test",
    cwd: request.cwd,
    tools: invocation.tools,
    mcp_servers: [],
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    plugins: [],
    agents: ["built-in-a", "built-in-b"],
    ...overrides,
  };
}

test("CLI invocation is local-login-only, prompt-on-stdin, and sandbox-aware", async () => {
  const request = await fixture("workspace_exec");
  const invocation = buildClaudeCliInvocation("/trusted/claude", request);
  const settings = buildClaudeCliSettings(request);
  const environment = buildClaudeCliEnvironment(request, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    USER: "tester",
    LANG: "en_US.UTF-8",
    UNRELATED_AUTH_SECRET: "must-not-pass",
    UNRELATED_AUTH_MODE: "must-not-pass",
    UNRELATED_CLOUD_IDENTITY: "must-not-pass",
    CLAUDE_CONFIG_DIR: "/must/not/pass",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "/must/not/pass",
    GITHUB_TOKEN: "must-not-pass",
    LC_TOKEN: "must-not-pass",
  });

  assert.equal(invocation.executable, "/trusted/claude");
  assert.ok(invocation.args.includes("--print"));
  assert.ok(invocation.args.includes("--setting-sources"));
  assert.equal(argumentValue(invocation.args, "--setting-sources"), "");
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.ok(!invocation.args.includes("--safe-mode"));
  assert.equal(
    argumentValue(invocation.args, "--mcp-config"),
    '{"mcpServers":{}}',
  );
  assert.ok(invocation.args.includes("--disable-slash-commands"));
  assert.ok(invocation.args.includes("--session-id"));
  assert.ok(!invocation.args.includes("--resume"));
  assert.ok(!invocation.args.includes("--bare"));
  assert.ok(!invocation.args.includes("--no-session-persistence"));
  assert.ok(!invocation.args.some((argument) => argument.includes(request.initialPrompt)));
  assert.match(invocation.stdin, /Inspect safely/);
  assert.equal(
    argumentValue(invocation.args, "--tools"),
    "Read,Glob,Grep,Edit,Write,Bash",
  );
  assert.deepEqual(
    JSON.parse(argumentValue(invocation.args, "--settings")),
    settings,
  );
  assert.equal(settings.sandbox?.enabled, true);
  assert.equal(settings.sandbox?.failIfUnavailable, true);
  assert.equal(settings.sandbox?.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox?.network.allowedDomains, []);
  assert.deepEqual(settings.sandbox?.network.deniedDomains, ["*"]);
  assert.ok(
    settings.permissions.allow.some((rule) => rule.startsWith("Read(//")),
  );
  assert.ok(
    settings.permissions.deny.some((rule) => rule.includes("/.claude/**")),
  );
  assert.ok(
    settings.permissions.deny.every(
      (rule) =>
        !["AskUserQuestion", "Agent", "mcp__*"].includes(rule),
    ),
  );

  assert.equal(environment.HOME, "/Users/tester");
  assert.equal(environment.TMPDIR, request.tempDir);
  assert.equal(environment.UNRELATED_AUTH_SECRET, undefined);
  assert.equal(environment.UNRELATED_AUTH_MODE, undefined);
  assert.equal(environment.UNRELATED_CLOUD_IDENTITY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.LC_TOKEN, undefined);
  assert.equal(environment.CLAUDE_CONFIG_DIR, request.profileDir);
  assert.equal(
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    process.platform === "darwin" ? "" : undefined,
  );
  assert.equal(environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
});

test("permission rules reject workspace paths containing rule syntax", async () => {
  const request = await fixture();
  assert.throws(
    () =>
      buildClaudeCliInvocation("/trusted/claude", {
        ...request,
        cwd: `${request.cwd}*`,
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSUPPORTED_POLICY_PATH",
  );
  if (path.sep === "/") {
    assert.throws(
      () =>
        buildClaudeCliInvocation("/trusted/claude", {
          ...request,
          cwd: `${request.cwd}\\..`,
        }),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "UNSUPPORTED_POLICY_PATH",
    );
  }
});

test("follow-up invocation resumes the exact controller-owned session", async () => {
  const request = await fixture();
  const sessionId = "00000000-0000-4000-8000-000000000123";
  const invocation = buildClaudeCliInvocation("/trusted/claude", {
    ...request,
    resumeSessionId: sessionId,
  });
  assert.equal(invocation.sessionId, sessionId);
  assert.equal(argumentValue(invocation.args, "--resume"), sessionId);
  assert.ok(!invocation.args.includes("--session-id"));
  assert.ok(!invocation.args.includes("--continue"));
  assert.ok(!invocation.args.includes("--fork-session"));
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly input: Buffer[] = [];
  pid: number | undefined;
  killed = false;
  autoCloseOnKill = true;
  finished = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.input.push(chunk));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.autoCloseOnKill) {
      queueMicrotask(() => this.finish(null, signal));
    }
    return true;
  }

  writeJson(value: unknown, split = false): void {
    const line = `${JSON.stringify(value)}\n`;
    if (!split) {
      this.stdout.write(line);
      return;
    }
    const midpoint = Math.floor(line.length / 2);
    this.stdout.write(line.slice(0, midpoint));
    this.stdout.write(line.slice(midpoint));
  }

  finish(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.stdout.destroyed) this.stdout.end();
    if (!this.stderr.destroyed) this.stderr.end();
    this.emit("close", code, signal);
  }
}

function fakeSpawner(fake: FakeChild, capture: { args?: string[] }): ClaudeSpawn {
  return (executable, args, options) => {
    assert.equal(executable, "/trusted/claude");
    assert.equal(options.shell, false);
    assert.equal(options.cwd, path.resolve(options.cwd));
    capture.args = [...args];
    return fake as unknown as ChildProcessWithoutNullStreams;
  };
}

function callbackRecorder(): {
  callbacks: AgentCallbacks;
  sessions: string[];
  progress: string[];
  reports: FinalReport[];
  errors: string[];
  closes: number;
} {
  const state = {
    sessions: [] as string[],
    progress: [] as string[],
    reports: [] as FinalReport[],
    errors: [] as string[],
    closes: 0,
  };
  return {
    ...state,
    callbacks: {
      onSession: async ({ sessionId }) => {
        state.sessions.push(sessionId);
      },
      onProgress: async (update) => {
        state.progress.push(update.message);
      },
      onResult: async ({ report }) => {
        state.reports.push(report);
      },
      onError: async ({ code }) => {
        state.errors.push(code);
      },
      onClose: async () => {
        state.closes += 1;
      },
    },
    get closes() {
      return state.closes;
    },
  };
}

test("driver parses chunked JSONL and returns a sanitized structured report", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");

  fake.writeJson(initMessage(request, sessionId), true);
  fake.writeJson({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Raw text and password=supersecretvalue must not persist.",
        },
        { type: "tool_use", name: "Read", input: { file_path: "/secret" } },
        {
          type: "tool_use",
          name: "StructuredOutput",
          input: { summary: "internal report mechanism" },
        },
      ],
    },
  });
  fake.writeJson({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    structured_output: {
      outcome: "completed",
      summary:
        'Completed; password=supersecretvalue and {"access_token":"anothersecretvalue"}\u0000 were removed.',
      changed_files: [],
      verification: [],
      decisions_needed: [],
      warnings: [],
    },
    duration_ms: 5,
    num_turns: 1,
    permission_denials: [],
    stop_reason: `password=stopreasonsecretvalue \u0000 ${"x".repeat(200)}`,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recorder.reports.length, 0);
  fake.finish();
  await handle.done;

  assert.deepEqual(recorder.sessions, [sessionId]);
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.reports.length, 1);
  assert.equal(
    recorder.reports[0]?.summary,
    'Completed; password=[REDACTED] and {"access_token":[REDACTED]} were removed.',
  );
  assert.equal(recorder.reports[0]?.metrics.turns, 1);
  const stopReason = recorder.reports[0]?.metrics.stopReason;
  assert.equal(typeof stopReason, "string");
  assert.match(stopReason as string, /password=\[REDACTED\]/);
  assert.ok((stopReason as string).length <= 80);
  assert.doesNotMatch(
    stopReason as string,
    /stopreasonsecretvalue|\u0000/,
  );
  assert.deepEqual(recorder.progress, [
    "Claude Code produced an assistant progress update.",
    "Claude Code started Read.",
  ]);
  assert.doesNotMatch(JSON.stringify(recorder), /supersecretvalue/);
  assert.doesNotMatch(JSON.stringify(recorder), /anothersecretvalue/);
  assert.doesNotMatch(JSON.stringify(recorder), /\\u0000/);
  assert.doesNotMatch(JSON.stringify(recorder), /file_path/);
  assert.match(Buffer.concat(fake.input).toString("utf8"), /Inspect safely/);
  assert.equal(recorder.closes, 1);
  assert.equal(handle.closed, true);
});

test("unrelated remote-settings diagnostics do not reject an attested turn", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(initMessage(request, sessionId));
  fake.writeJson({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    structured_output: {
      outcome: "completed",
      summary: "Completed safely.",
      changed_files: [],
      verification: [],
      decisions_needed: [],
      warnings: [],
    },
    num_turns: 1,
  });
  fake.stderr.write(
    "Remote settings: Settings validation failed - no fields could be salvaged",
  );
  fake.finish();
  await handle.done;
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.reports.length, 1);
});

test("an unmatched enabled permission rule rejects the turn", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(initMessage(request, sessionId));
  fake.stderr.write(
    "Permission allow rule Read(//workspace/**) not matched",
  );
  fake.finish(1);
  await handle.done;
  assert.deepEqual(recorder.reports, []);
  assert.deepEqual(recorder.errors, [
    "CLAUDE_CLI_SAFETY_CONFIGURATION_FAILED",
  ]);
});

test("session mismatch fails closed without exposing CLI output", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  fake.writeJson({
    type: "system",
    subtype: "init",
    session_id: "00000000-0000-4000-8000-000000000999",
    model: "claude-test",
  });
  fake.finish();
  await handle.done;
  assert.deepEqual(recorder.sessions, []);
  assert.deepEqual(recorder.errors, ["SESSION_ID_MISMATCH"]);
  assert.equal(recorder.closes, 1);
});

test("non-subscription authentication is rejected from init metadata", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(
    initMessage(request, sessionId, { apiKeySource: "user" }),
  );
  await handle.done;
  assert.deepEqual(recorder.sessions, []);
  assert.deepEqual(recorder.errors, [
    "LOCAL_CLAUDE_SUBSCRIPTION_REQUIRED",
  ]);
});

test("ambiguous local-auth metadata is accepted only for the pinned macOS version", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(
    initMessage(request, sessionId, {
      apiKeySource: "none",
      permissionMode: "default",
      claude_code_version: "2.1.221",
    }),
  );
  await handle.done;
  assert.deepEqual(recorder.sessions, []);
  assert.deepEqual(recorder.errors, [
    "LOCAL_CLAUDE_SUBSCRIPTION_REQUIRED",
  ]);
});

test(
  "Claude Code 2.1.220 macOS init compatibility remains narrowly supported",
  { skip: process.platform !== "darwin" },
  async () => {
    const request = await fixture();
    const fake = new FakeChild();
    const capture: { args?: string[] } = {};
    const recorder = callbackRecorder();
    const driver = new ClaudeCliDriver(
      "/trusted/claude",
      fakeSpawner(fake, capture),
    );
    const handle = driver.start(request, recorder.callbacks);
    assert.ok(capture.args);
    const sessionId = argumentValue(capture.args, "--session-id");
    fake.writeJson(
      initMessage(request, sessionId, {
        apiKeySource: "none",
        permissionMode: "default",
        claude_code_version: "2.1.220",
      }),
    );
    fake.writeJson({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      structured_output: {
        outcome: "completed",
        summary: "Compatibility path completed.",
        changed_files: [],
        verification: [],
        decisions_needed: [],
        warnings: [],
      },
      num_turns: 1,
    });
    fake.finish();
    await handle.done;
    assert.deepEqual(recorder.errors, []);
    assert.equal(recorder.reports.length, 1);
  },
);

test(
  "Claude Code 2.1.220 macOS auth compatibility is independent of dontAsk attestation",
  { skip: process.platform !== "darwin" },
  async () => {
    const request = await fixture();
    const fake = new FakeChild();
    const capture: { args?: string[] } = {};
    const recorder = callbackRecorder();
    const driver = new ClaudeCliDriver(
      "/trusted/claude",
      fakeSpawner(fake, capture),
    );
    const handle = driver.start(request, recorder.callbacks);
    assert.ok(capture.args);
    const sessionId = argumentValue(capture.args, "--session-id");
    fake.writeJson(
      initMessage(request, sessionId, {
        apiKeySource: "none",
        permissionMode: "dontAsk",
        claude_code_version: "2.1.220",
      }),
    );
    fake.writeJson({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      structured_output: {
        outcome: "completed",
        summary: "Independent compatibility checks completed.",
        changed_files: [],
        verification: [],
        decisions_needed: [],
        warnings: [],
      },
      num_turns: 1,
    });
    fake.finish();
    await handle.done;
    assert.deepEqual(recorder.errors, []);
    assert.equal(recorder.reports.length, 1);
  },
);

test(
  "Claude Code 2.1.220 macOS permission compatibility is independent of oauth attestation",
  { skip: process.platform !== "darwin" },
  async () => {
    const request = await fixture();
    const fake = new FakeChild();
    const capture: { args?: string[] } = {};
    const recorder = callbackRecorder();
    const driver = new ClaudeCliDriver(
      "/trusted/claude",
      fakeSpawner(fake, capture),
    );
    const handle = driver.start(request, recorder.callbacks);
    assert.ok(capture.args);
    const sessionId = argumentValue(capture.args, "--session-id");
    fake.writeJson(
      initMessage(request, sessionId, {
        apiKeySource: "oauth",
        permissionMode: "default",
        claude_code_version: "2.1.220",
      }),
    );
    fake.writeJson({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      structured_output: {
        outcome: "completed",
        summary: "Independent permission compatibility completed.",
        changed_files: [],
        verification: [],
        decisions_needed: [],
        warnings: [],
      },
      num_turns: 1,
    });
    fake.finish();
    await handle.done;
    assert.deepEqual(recorder.errors, []);
    assert.equal(recorder.reports.length, 1);
  },
);

test("default permission mode is rejected outside the pinned compatibility version", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(
    initMessage(request, sessionId, {
      apiKeySource: "oauth",
      permissionMode: "default",
      claude_code_version: "2.1.221",
    }),
  );
  await handle.done;
  assert.deepEqual(recorder.sessions, []);
  assert.deepEqual(recorder.errors, [
    "CLAUDE_CLI_SAFETY_CONFIGURATION_FAILED",
  ]);
});

test("effective init metadata cannot widen the configured tool policy", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(
    initMessage(request, sessionId, {
      tools: ["Read", "Glob", "Grep", "Bash"],
    }),
  );
  await handle.done;
  assert.deepEqual(recorder.sessions, []);
  assert.deepEqual(recorder.errors, [
    "CLAUDE_CLI_SAFETY_CONFIGURATION_FAILED",
  ]);
});

test("exit before init produces the controlled local-login error", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  fake.stderr.write(
    "Please run /login; account=private-person@example.invalid",
  );
  fake.finish(1);
  await handle.done;
  assert.deepEqual(recorder.errors, ["LOCAL_CLAUDE_LOGIN_REQUIRED"]);
  assert.doesNotMatch(JSON.stringify(recorder), /private-person/);
});

test("a success result followed by a nonzero exit is not published", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(initMessage(request, sessionId));
  fake.writeJson({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    structured_output: {
      outcome: "completed",
      summary: "Must not be published.",
      changed_files: [],
      verification: [],
      decisions_needed: [],
      warnings: [],
    },
    num_turns: 1,
  });
  fake.finish(1);
  await handle.done;
  assert.deepEqual(recorder.reports, []);
  assert.deepEqual(recorder.errors, ["CLAUDE_CLI_UNCLEAN_EXIT"]);
});

test("a max-turn result preserves accounting across its expected error exit", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const capture: { args?: string[] } = {};
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, capture),
  );
  const handle = driver.start(request, recorder.callbacks);
  assert.ok(capture.args);
  const sessionId = argumentValue(capture.args, "--session-id");
  fake.writeJson(initMessage(request, sessionId));
  fake.writeJson({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    session_id: sessionId,
    num_turns: 2,
  });
  fake.finish(1);
  await handle.done;
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.reports.length, 1);
  assert.equal(recorder.reports[0]?.outcome, "failed");
  assert.equal(recorder.reports[0]?.metrics.turns, 2);
});

test("protocol failure terminates the CLI before releasing the runtime", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  fake.stdout.write("not-json\n");
  await handle.done;
  assert.deepEqual(fake.signals, ["SIGTERM"]);
  assert.deepEqual(recorder.errors, ["CLAUDE_CLI_PROTOCOL_ERROR"]);
  assert.equal(recorder.closes, 1);
});

test("interrupt terminates the local CLI process and suppresses crash errors", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  await handle.interrupt();
  await handle.done;
  assert.deepEqual(fake.signals, ["SIGTERM"]);
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.closes, 1);
});

test("an interrupted parse failure keeps the fence until process close", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  fake.autoCloseOnKill = false;
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  let settled = false;
  void handle.done.then(() => {
    settled = true;
  });
  await handle.interrupt();
  fake.stdout.write("not-json\n");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  fake.finish(null, "SIGTERM");
  await handle.done;
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.closes, 1);
});

test("a child error event alone does not confirm process exit", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  fake.autoCloseOnKill = false;
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  let settled = false;
  void handle.done.then(() => {
    settled = true;
  });
  fake.emit("error", new Error("synthetic child error"));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  fake.finish(1);
  await handle.done;
  assert.deepEqual(recorder.errors, ["LOCAL_CLAUDE_CODE_FAILED"]);
});

test("controller close escalates a hung interrupted process to SIGKILL", async () => {
  const request = await fixture();
  const fake = new FakeChild();
  fake.autoCloseOnKill = false;
  const recorder = callbackRecorder();
  const driver = new ClaudeCliDriver(
    "/trusted/claude",
    fakeSpawner(fake, {}),
  );
  const handle = driver.start(request, recorder.callbacks);
  await handle.interrupt();
  handle.close();
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
  fake.finish(null, "SIGKILL");
  await handle.done;
  assert.deepEqual(recorder.errors, []);
  assert.equal(recorder.closes, 1);
});
