import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BridgeError } from "../src/errors.js";
import {
  GatewayControlTransportError,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewaySnapshot,
  type PairParams,
  type ReplyParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendToClaudeParams,
  type ValidatedSendToCodexParams,
} from "../src/gateway/control.js";
import {
  EMBASSY_VERSION,
  type GatewayCliDependencies,
  gatewayCliCommands,
  gatewayCliExitCodes,
  runGatewayCli,
} from "../src/gateway/cli.js";
import {
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
} from "../src/gateway/compatibility.js";
import { projectPublicCompatibilityCheck } from "../src/gateway/types.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const OLD_THREAD_ID_SENTINEL = "00000000-0000-7000-8000-000000000702";
const CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000042";
const CLAUDE_SOCKET_PATH = "/tmp/cc-socks/45201.sock";
const REPLY_ADDRESS = `uds:${CLAUDE_SOCKET_PATH}`;
const CONVERSATION_ID = "conv_0123456789abcdef";
const DELIVERY_TOKEN = "dlv_0123456789abcdefghijklmn";
const NOW = "2026-08-07T12:34:56.000Z";
const DEADLINE = "2099-08-07T12:35:56.000Z";
const SECRET_BODY = "BODY_SENTINEL_NEVER_RENDER";
const BOTH_IDENTITIES = {
  CODEX_THREAD_ID: THREAD_ID,
  CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
} as const;
const CALLER_IDENTITY_CONFLICT_HINT_EN =
  "[embassy] both agent identities were inherited; the Codex App Server daemon may have been started inside an agent session. From a normal terminal, run: codex app-server daemon restart\n";
const CALLER_IDENTITY_CONFLICT_HINT_ZH_CN =
  "[embassy] 同时继承了两种代理身份；Codex App Server 守护进程可能是在代理会话内启动的。请在普通终端中运行：codex app-server daemon restart\n";
const roots = new Set<string>();

const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      roots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

test("version flags are deterministic and never contact the gateway", async () => {
  for (const flag of ["--version", "-v"] as const) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runGatewayCli([flag], {
      env: {
        EMBASSY_LOCALE: "zh-CN",
        LANG: "zh_CN.UTF-8",
        LC_ALL: "zh_CN.UTF-8",
        LANGUAGE: "zh_CN:zh",
      },
      stdout,
      stderr,
      loadConfig: () => {
        throw new Error("version must not load configuration");
      },
      sendRequest: async () => {
        throw new Error("version must not contact the gateway");
      },
    });
    assert.equal(exitCode, gatewayCliExitCodes.ok);
    assert.equal(stdout.chunks.join(""), `embassy ${EMBASSY_VERSION}\n`);
    assert.equal(stderr.chunks.join(""), "");
  }
});

test("bare invocation and help flags print localized usage without side effects", async () => {
  const cases = [
    { argv: [] as string[], env: {}, expected: /Usage:/ },
    { argv: ["-h"], env: {}, expected: /dashboard --live/ },
    {
      argv: ["--help", "--lang", "zh-CN"],
      env: { EMBASSY_LOCALE: "unsupported" },
      expected: /用法：/,
    },
  ];
  for (const current of cases) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runGatewayCli(current.argv, {
      env: current.env,
      stdout,
      stderr,
      loadConfig: () => {
        throw new Error("help must not load configuration");
      },
      sendRequest: async () => {
        throw new Error("help must not contact the gateway");
      },
      runServer: async () => {
        throw new Error("help must not start the broker");
      },
    });
    assert.equal(exitCode, gatewayCliExitCodes.ok);
    const help = stdout.chunks.join("");
    assert.match(help, current.expected);
    assert.match(help, /refresh-dashboard/);
    assert.match(help, /wait-delivery/);
    assert.match(help, /untrack/);
    assert.match(help, /dashboard --live \[--port <n>\]/);
    assert.match(help, /--port <n>.*1024.*65535.*41961/);
    assert.doesNotMatch(help, /compat-(?:check|certify)|--with-turn/);
    assert.equal(stderr.chunks.join(""), "");
  }
});

test("removed compatibility commands fail before configuration or control work", async () => {
  for (const command of ["compat-check", "compat-certify"]) {
    let worked = false;
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runGatewayCli([command], {
      env: {},
      stdout,
      stderr,
      loadConfig: () => {
        worked = true;
        throw new Error("removed commands must not load configuration");
      },
      validateControlSocket: async () => {
        worked = true;
      },
      sendRequest: async () => {
        worked = true;
        throw new Error("removed commands must not contact the gateway");
      },
    });
    assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
    assert.equal(worked, false);
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } })
        .error.code,
      "UNKNOWN_COMMAND",
    );
    assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n");
  }
});

test("an npm-style symlink invokes the installed CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-bin-"));
  roots.add(root);
  const installedBin = path.join(root, "embassy");
  const compiledCli = fileURLToPath(
    new URL("../dist/src/gateway/cli.js", import.meta.url),
  );
  await symlink(compiledCli, installedBin);

  const result = await execFileAsync(
    process.execPath,
    [installedBin, "--version"],
    { encoding: "utf8" },
  );
  assert.equal(result.stdout, `embassy ${EMBASSY_VERSION}\n`);
  assert.equal(result.stderr, "");
});

function emptySnapshot(): GatewaySnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-07T12:34:56.000Z",
    inboundMode: "paired" as const,
    health: "healthy",
    connectors: [],
    availablePeers: [],
    routes: [],
    pairs: [],
    messages: [],
    accounting: {
      accepted: 0,
      duplicates: 0,
      delivered: 0,
      unconfirmed: 0,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 0,
      queuedBytes: 0,
    },
    alerts: [],
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      pairs: 0,
      messages: 0,
      alerts: 0,
    },
  };
}

type Capture = {
  readonly chunks: string[];
  write(chunk: string): void;
};

function capture(): Capture {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
}

function input(body = ""): Readable {
  return Readable.from(body.length === 0 ? [] : [Buffer.from(body, "utf8")]);
}

async function privateState(): Promise<{
  root: string;
  stateDir: string;
  socketPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cli-"));
  roots.add(root);
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  return { root, stateDir, socketPath: path.join(stateDir, "control.sock") };
}

async function invoke(
  stateDir: string,
  argv: readonly string[],
  options: {
    body?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const code = await runGatewayCli(argv, {
    env: {
      EMBASSY_STATE_DIR: stateDir,
      ...options.env,
    },
    stdin: input(options.body),
    stdout,
    stderr,
  });
  return {
    code,
    stdout: stdout.chunks.join(""),
    stderr: stderr.chunks.join(""),
  };
}

test("all client commands use one private control socket and expose only normalized output", async (t) => {
  const state = await privateState();
  const registrations: ValidatedRegisterCodexParams[] = [];
  const unregisters: Array<{ alias: string; threadId: string }> = [];
  const selected: string[] = [];
  const unselected: string[] = [];
  const pairs: PairParams[] = [];
  const unpairs: PairParams[] = [];
  const sendsToClaude: ValidatedSendToClaudeParams[] = [];
  const sendsToCodex: ValidatedSendToCodexParams[] = [];
  const replies: ReplyParams[] = [];
  const deliveryStatuses: string[] = [];
  const untracked: string[] = [];
  const statusSnapshot = emptySnapshot();
  statusSnapshot.compatibilityChecks = [
    projectPublicCompatibilityCheck(
      evaluateCompatibilityAttestation({
        surface: "claude",
        version: "2.1.228",
        checkedAt: NOW,
        certifiedVersions: certifiedCompatibilityVersions.claude,
        probes: compatibilityProbeNames.claude.map((name) => ({
          name,
          outcome: "pass" as const,
        })),
      }),
    ),
  ];
  const handlers: GatewayControlHandlers = {
    health: () => ({ status: "ok", revision: 1 }),
    registerCodex: (params) => {
      registrations.push({ ...params });
      return { accepted: true, code: "ok" };
    },
    unregisterCodex: (params) => {
      unregisters.push({ ...params });
      return { accepted: true, code: "ok" };
    },
    removeStaleCodexRegistration: () => ({ accepted: true, code: "ok" }),
    selectClaude: ({ alias }) => {
      selected.push(alias);
      return { accepted: true, code: "ok" };
    },
    unselectClaude: ({ alias }) => {
      unselected.push(alias);
      return { accepted: true, code: "ok" };
    },
    pair: (params) => {
      pairs.push({ ...params });
      return { accepted: true, code: "ok" };
    },
    unpair: (params) => {
      unpairs.push({ ...params });
      return { accepted: true, code: "ok" };
    },
    listSnapshot: () => statusSnapshot,
    observeSnapshot: () => ({
      snapshotRevision: 0,
      snapshot: emptySnapshot(),
    }),
    deliveryStatus: ({ token }) => {
      deliveryStatuses.push(token);
      return {
        found: true,
        state: "delivered",
        terminal: true,
        updatedAt: NOW,
        deadlineAt: DEADLINE,
      };
    },
    untrack: ({ conversationId }) => {
      untracked.push(conversationId);
      return { accepted: true, code: "ok" };
    },
    sendToClaude: (params) => {
      sendsToClaude.push({ ...params });
      return {
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      };
    },
    sendToCodex: (params) => {
      sendsToCodex.push({ ...params });
      return {
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      };
    },
    reply: (params) => {
      replies.push({
        ...params,
        caller: { ...params.caller },
      });
      return {
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      };
    },
    refreshDashboard: () => ({
      accepted: true,
      code: "ok",
      revision: 2,
    }),
  };
  const server = await startGatewayControlServer({
    stateDir: state.stateDir,
    socketPath: state.socketPath,
    handlers,
  });
  t.after(async () => await server.close());

  const cases: Array<{
    argv: string[];
    body?: string;
    env?: NodeJS.ProcessEnv;
  }> = [
    { argv: ["health"], env: BOTH_IDENTITIES },
    { argv: ["status"], env: BOTH_IDENTITIES },
    {
      argv: ["delivery-status", "--token", DELIVERY_TOKEN],
      env: BOTH_IDENTITIES,
    },
    {
      argv: ["wait-delivery", "--token", DELIVERY_TOKEN],
      env: BOTH_IDENTITIES,
    },
    {
      argv: ["untrack", "--conversation", CONVERSATION_ID],
      env: BOTH_IDENTITIES,
    },
    { argv: ["refresh-dashboard"], env: BOTH_IDENTITIES },
    {
      argv: ["register-codex", "--alias", "codex-reviewer@this-mac"],
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@build-mac",
        "--succeeds",
        "codex-reviewer@build-mac",
      ],
      env: {
        CODEX_THREAD_ID: THREAD_ID,
        OLD_CODEX_THREAD_ID: OLD_THREAD_ID_SENTINEL,
      },
    },
    {
      argv: ["unregister-codex", "--alias", "codex-reviewer@this-mac"],
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: ["select-claude", "--alias", "advisor@this-mac"],
      env: BOTH_IDENTITIES,
    },
    {
      argv: ["select-claude", "--session", CLAUDE_SESSION_ID.toUpperCase()],
      env: BOTH_IDENTITIES,
    },
    {
      argv: ["unselect-claude", "--alias", "advisor@this-mac"],
      env: BOTH_IDENTITIES,
    },
    {
      argv: [
        "pair",
        "--claude",
        "advisor@this-mac",
        "--codex",
        "codex-reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "unpair",
        "--claude",
        "advisor@this-mac",
        "--codex",
        "codex-reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        "advisor@this-mac",
        "--expects-reply",
      ],
      body: SECRET_BODY,
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        CLAUDE_SESSION_ID,
      ],
      body: SECRET_BODY,
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "send-to-codex",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
        "--track",
        "--idle-minutes",
        "7",
      ],
      body: SECRET_BODY,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH },
    },
    {
      argv: [
        "reply",
        "--conversation",
        CONVERSATION_ID,
        "--alias",
        "codex-reviewer@this-mac",
        "--track",
      ],
      body: SECRET_BODY,
      env: { CODEX_THREAD_ID: THREAD_ID },
    },
    {
      argv: [
        "reply",
        "--conversation",
        CONVERSATION_ID,
        "--alias",
        "advisor@this-mac",
      ],
      body: SECRET_BODY,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH },
    },
  ];

  for (const current of cases) {
    const result = await invoke(
      state.stateDir,
      [...current.argv, "--lang", "zh-CN"],
      {
        ...current,
        env: {
          ...current.env,
          // A valid explicit option must override an invalid environment.
          EMBASSY_LOCALE: "unsupported",
        },
      },
    );
    assert.equal(result.code, gatewayCliExitCodes.ok);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      result?: {
        deliveryToken?: string;
        compatibilityChecks?: Array<{
          version: string;
          testedVersion: string;
          supportedMajor: string;
        }>;
      };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, current.argv[0]);
    assert.ok(Buffer.byteLength(result.stdout) <= 256 * 1024);
    assert.doesNotMatch(result.stdout, new RegExp(THREAD_ID, "i"));
    assert.doesNotMatch(
      result.stdout,
      new RegExp(OLD_THREAD_ID_SENTINEL, "i"),
    );
    assert.doesNotMatch(result.stdout, /cc-socks|45201|BODY_SENTINEL/);
    if (
      current.argv[0] === "send-to-claude" ||
      current.argv[0] === "send-to-codex" ||
      current.argv[0] === "reply"
    ) {
      assert.equal(parsed.result?.deliveryToken, DELIVERY_TOKEN);
    }
    if (current.argv[0] === "status") {
      assert.deepEqual(parsed.result?.compatibilityChecks, [
        {
          schemaVersion: 1,
          surface: "claude",
          version: "2.1.228",
          tier: "schema_attested",
          checkedAt: NOW,
          probes: compatibilityProbeNames.claude.map((name) => ({
            name,
            outcome: "pass",
          })),
          testedVersion: "2.1.227",
          supportedMajor: "2",
          writesCovered: false,
        },
      ]);
    }
  }

  assert.deepEqual(registrations, [
    {
      alias: "codex-reviewer@this-mac",
      threadId: THREAD_ID,
      hostId: "this-mac",
      busyPolicy: "queue",
    },
    {
      alias: "codex-next@build-mac",
      threadId: THREAD_ID,
      hostId: "build-mac",
      busyPolicy: "queue",
      succeedsAlias: "codex-reviewer@build-mac",
    },
  ]);
  assert.deepEqual(unregisters, [
    { alias: "codex-reviewer@this-mac", threadId: THREAD_ID },
  ]);
  assert.deepEqual(selected, ["advisor@this-mac", CLAUDE_SESSION_ID]);
  assert.deepEqual(unselected, ["advisor@this-mac"]);
  assert.deepEqual(pairs, [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-reviewer@this-mac",
      codexThreadId: THREAD_ID,
    },
  ]);
  assert.deepEqual(unpairs, pairs);
  assert.deepEqual(deliveryStatuses, [DELIVERY_TOKEN, DELIVERY_TOKEN]);
  assert.deepEqual(untracked, [CONVERSATION_ID]);
  assert.deepEqual(sendsToClaude, [
    {
      fromAlias: "codex-reviewer@this-mac",
      threadId: THREAD_ID,
      toAlias: "advisor@this-mac",
      text: SECRET_BODY,
      expectsReply: true,
    },
    {
      fromAlias: "codex-reviewer@this-mac",
      threadId: THREAD_ID,
      toAlias: CLAUDE_SESSION_ID,
      text: SECRET_BODY,
      expectsReply: false,
    },
  ]);
  assert.deepEqual(sendsToCodex, [
    {
      fromAlias: "advisor@this-mac",
      toAlias: "codex-reviewer@this-mac",
      text: SECRET_BODY,
      replyAddress: REPLY_ADDRESS,
      expectsReply: false,
      trackIdleMinutes: 7,
    },
  ]);
  assert.deepEqual(replies, [
    {
      conversationId: CONVERSATION_ID,
      text: SECRET_BODY,
      caller: {
        kind: "codex",
        alias: "codex-reviewer@this-mac",
        threadId: THREAD_ID,
      },
      trackIdleMinutes: 5,
    },
    {
      conversationId: CONVERSATION_ID,
      text: SECRET_BODY,
      caller: {
        kind: "claude",
        alias: "advisor@this-mac",
        replyAddress: REPLY_ADDRESS,
      },
    },
  ]);
});

test("common locale precedence is exact and malformed locale input fails before all command work", async () => {
  const precedenceCases = [
    {
      argv: ["health", "--unexpected"],
      env: {},
      stderr: "[embassy] request rejected.\n",
    },
    {
      argv: ["health", "--unexpected"],
      env: { EMBASSY_LOCALE: "" },
      stderr: "[embassy] request rejected.\n",
    },
    {
      argv: ["health", "--unexpected"],
      env: {
        LANG: "zh_CN.UTF-8",
        LC_ALL: "zh_CN.UTF-8",
        LANGUAGE: "zh_CN:zh",
      },
      stderr: "[embassy] request rejected.\n",
    },
    {
      argv: ["health", "--unexpected"],
      env: { EMBASSY_LOCALE: "zh-CN" },
      stderr: "[embassy] 请求被拒绝。\n",
    },
    {
      argv: ["health", "--unexpected", "--lang", "en"],
      env: { EMBASSY_LOCALE: "zh-CN" },
      stderr: "[embassy] request rejected.\n",
    },
    {
      argv: ["health", "--unexpected", "--lang", "zh-CN"],
      env: { EMBASSY_LOCALE: "not-a-locale" },
      stderr: "[embassy] 请求被拒绝。\n",
    },
  ] as const;

  for (const current of precedenceCases) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(current.argv, {
      env: current.env,
      stdout,
      stderr,
      loadConfig: () => {
        throw new Error("locale/argument failure must precede configuration");
      },
      validateControlSocket: async () => {
        throw new Error("locale/argument failure must precede socket work");
      },
      sendRequest: async () => {
        throw new Error("locale/argument failure must precede a request");
      },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput);
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: false,
      command: "health",
      error: {
        code: "INVALID_ARGUMENTS",
        ambiguous: false,
        retryable: false,
      },
    });
    assert.equal(stderr.chunks.join(""), current.stderr);
  }

  const malformed = [
    ["--lang"],
    ["--lang", "zh"],
    ["--lang", "EN"],
    ["--lang=zh-CN"],
    ["--lang", "en", "--lang", "zh-CN"],
  ] as const;
  for (const command of gatewayCliCommands) {
    for (const suffix of malformed) {
      const stdout = capture();
      const stderr = capture();
      let worked = false;
      const code = await runGatewayCli([command, ...suffix], {
        env: {},
        stdin: {
          async *[Symbol.asyncIterator]() {
            worked = true;
            yield SECRET_BODY;
          },
        },
        stdout,
        stderr,
        loadConfig: () => {
          worked = true;
          throw new Error("must not load configuration");
        },
        validateControlSocket: async () => {
          worked = true;
        },
        sendRequest: async () => {
          worked = true;
          throw new Error("must not send");
        },
        runServer: async () => {
          worked = true;
        },
        runLiveDashboard: async () => {
          worked = true;
        },
      });
      assert.equal(
        code,
        gatewayCliExitCodes.invalidInput,
        `${command} ${suffix.join(" ")}`,
      );
      assert.equal(worked, false, `${command} ${suffix.join(" ")}`);
      assert.equal(
        (JSON.parse(stdout.chunks.join("")) as { error: { code: string } })
          .error.code,
        "INVALID_ARGUMENTS",
      );
      assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n");
    }
  }

  for (const command of gatewayCliCommands) {
    let worked = false;
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli([command], {
      env: { EMBASSY_LOCALE: "unsupported" },
      stdin: {
        async *[Symbol.asyncIterator]() {
          worked = true;
          yield SECRET_BODY;
        },
      },
      stdout,
      stderr,
      loadConfig: () => {
        worked = true;
        throw new Error("must not load configuration");
      },
      validateControlSocket: async () => {
        worked = true;
      },
      sendRequest: async () => {
        worked = true;
        throw new Error("must not send");
      },
      runServer: async () => {
        worked = true;
      },
      runLiveDashboard: async () => {
        worked = true;
      },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput, command);
    assert.equal(worked, false, command);
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } }).error
        .code,
      "INVALID_ARGUMENTS",
    );
    assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n");
  }

  for (const invalidEnvironment of ["zh", "EN", " zh-CN", "zh-CN "]) {
    let worked = false;
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(["health"], {
      env: { EMBASSY_LOCALE: invalidEnvironment },
      stdout,
      stderr,
      loadConfig: () => {
        worked = true;
        throw new Error("must not load configuration");
      },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput);
    assert.equal(worked, false);
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } }).error
        .code,
      "INVALID_ARGUMENTS",
    );
    assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n");
  }
});

test("all five stderr categories localize without changing stdout protocol", async () => {
  const fakeConfig = () => ({
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
    inboundMode: "paired" as const,
    limits: {} as never,
  });
  const scenarios = [
    {
      kind: "input",
      argv: ["health", "--unexpected"],
      code: gatewayCliExitCodes.invalidInput,
      sendRequest: async () => {
        throw new Error("input failure must precede the request");
      },
    },
    {
      kind: "decision",
      argv: ["select-claude", "--alias", "advisor@this-mac"],
      code: gatewayCliExitCodes.rejected,
      sendRequest: async () => ({
        protocolVersion: 1 as const,
        ok: true as const,
        result: { accepted: false as const, code: "not_found" },
      }),
    },
    {
      kind: "unavailable",
      argv: ["health"],
      code: gatewayCliExitCodes.unavailable,
      sendRequest: async () => {
        throw new GatewayControlTransportError(
          "CONTROL_CONNECT_FAILED",
          "private diagnostic",
        );
      },
    },
    {
      kind: "ambiguous",
      argv: ["health"],
      code: gatewayCliExitCodes.ambiguous,
      sendRequest: async () => {
        throw new GatewayControlTransportError(
          "CONTROL_OUTCOME_AMBIGUOUS",
          "private diagnostic",
          true,
        );
      },
    },
    {
      kind: "failure",
      argv: ["health"],
      code: gatewayCliExitCodes.failure,
      sendRequest: async () => ({
        protocolVersion: 1 as const,
        ok: false as const,
        error: {
          code: "HANDLER_FAILURE" as const,
          message: "private diagnostic",
        },
      }),
    },
  ] as const;
  const expected = {
    en: {
      input: "[embassy] request rejected.\n",
      decision: "[embassy] gateway rejected the request.\n",
      unavailable: "[embassy] gateway unavailable.\n",
      ambiguous:
        "[embassy] outcome ambiguous; do not retry automatically.\n",
      failure: "[embassy] command failed.\n",
    },
    "zh-CN": {
      input: "[embassy] 请求被拒绝。\n",
      decision: "[embassy] 网关拒绝了该请求。\n",
      unavailable: "[embassy] 网关不可用。\n",
      ambiguous: "[embassy] 结果不确定；请勿自动重试。\n",
      failure: "[embassy] 命令失败。\n",
    },
  } as const;

  for (const scenario of scenarios) {
    let englishStdout: string | undefined;
    for (const locale of ["en", "zh-CN"] as const) {
      const stdout = capture();
      const stderr = capture();
      const code = await runGatewayCli(
        [...scenario.argv, "--lang", locale],
        {
          env: {},
          stdin: input(),
          stdout,
          stderr,
          loadConfig: fakeConfig,
          validateControlSocket: async () => undefined,
          sendRequest:
            scenario.sendRequest as NonNullable<
              GatewayCliDependencies["sendRequest"]
            >,
        },
      );
      assert.equal(code, scenario.code, scenario.kind);
      assert.equal(stderr.chunks.join(""), expected[locale][scenario.kind]);
      assert.doesNotMatch(stdout.chunks.join(""), /private|zh-CN|\u8bf7求|\u7f51关/);
      if (englishStdout === undefined) {
        englishStdout = stdout.chunks.join("");
      } else {
        assert.equal(stdout.chunks.join(""), englishStdout, scenario.kind);
      }
    }
  }
});

test("invalid live-upgrade control responses name version skew and client recovery", async () => {
  const expected = {
    en:
      "[embassy] gateway unavailable.\n[embassy] client/broker version skew is likely; rebuild or repoint this client to the broker's Embassy installation, then retry.\n",
    "zh-CN":
      "[embassy] 网关不可用。\n[embassy] 客户端与网关进程的版本可能不一致；请重新构建客户端，或将其重新指向网关进程所使用的 Embassy 安装，然后重试。\n",
  } as const;

  for (const locale of ["en", "zh-CN"] as const) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(["health", "--lang", locale], {
      env: {},
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => {
        throw new GatewayControlTransportError(
          "CONTROL_INVALID_RESPONSE",
          "private skew detail",
        );
      },
    });

    assert.equal(code, gatewayCliExitCodes.unavailable);
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: false,
      command: "health",
      error: {
        code: "CONTROL_INVALID_RESPONSE",
        ambiguous: false,
        retryable: true,
      },
    });
    assert.equal(stderr.chunks.join(""), expected[locale]);
    assert.doesNotMatch(
      `${stdout.chunks.join("")} ${stderr.chunks.join("")}`,
      /private skew detail/,
    );
  }
});

test("wait-delivery polls at fixed intervals and emits only the terminal status", async () => {
  const stdout = capture();
  const stderr = capture();
  const startedAt = Date.parse(NOW);
  const deadlineAt = new Date(startedAt + 10_000).toISOString();
  let clock = startedAt;
  const delays: number[] = [];
  const requestTimeouts: Array<number | undefined> = [];
  const statuses = [
    {
      found: true,
      state: "queued",
      terminal: false,
      updatedAt: NOW,
      deadlineAt,
      pendingForMs: 0,
    },
    {
      found: true,
      state: "stalled",
      terminal: false,
      updatedAt: new Date(startedAt + 250).toISOString(),
      deadlineAt,
      pendingForMs: 250,
      safeErrorCode: "DELIVERY_STALLED",
    },
    {
      found: true,
      state: "delivered",
      terminal: true,
      updatedAt: new Date(startedAt + 500).toISOString(),
      deadlineAt,
    },
  ] as const;
  let attempts = 0;
  const code = await runGatewayCli(
    ["wait-delivery", "--token", DELIVERY_TOKEN],
    {
      env: {},
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async (options: {
        request: { method: string; params: { token?: string } };
        timeoutMs?: number;
      }) => {
        assert.equal(options.request.method, "delivery_status");
        assert.equal(options.request.params.token, DELIVERY_TOKEN);
        requestTimeouts.push(options.timeoutMs);
        const result = statuses[attempts];
        attempts += 1;
        assert.ok(result);
        return { protocolVersion: 1, ok: true, result };
      }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
      now: () => clock,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    },
  );

  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 250]);
  assert.deepEqual(requestTimeouts, [3_000, 3_000, 3_000]);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: true,
    command: "wait-delivery",
    result: statuses[2],
  });
  assert.equal(stdout.chunks.length, 1);
  assert.equal(stderr.chunks.join(""), "");
});

test("wait-delivery returns a retained terminal result after its deadline window", async () => {
  const stdout = capture();
  const stderr = capture();
  const deadlineAt = "2026-08-08T12:05:00.000Z";
  const result = {
    found: true as const,
    state: "delivered" as const,
    terminal: true as const,
    updatedAt: "2026-08-08T12:01:00.000Z",
    deadlineAt,
  };
  let attempts = 0;
  const code = await runGatewayCli(
    ["wait-delivery", "--token", DELIVERY_TOKEN],
    {
      env: {},
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async () => {
        attempts += 1;
        return { protocolVersion: 1, ok: true, result };
      }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
      now: () => Date.parse("2026-08-08T12:10:00.000Z"),
    },
  );

  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(attempts, 1);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: true,
    command: "wait-delivery",
    result,
  });
  assert.equal(stderr.chunks.join(""), "");
});

test("wait-delivery preserves every non-delivered terminal state and uses one failure exit", async () => {
  const states = [
    "unconfirmed",
    "expired",
    "failed",
    "ambiguous",
    "cancelled",
  ] as const;

  for (const state of states) {
    const stdout = capture();
    const stderr = capture();
    const result = {
      found: true as const,
      state,
      terminal: true as const,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      pendingForMs: 750,
      safeErrorCode: `DELIVERY_${state.toUpperCase()}`,
    };
    let attempts = 0;
    const code = await runGatewayCli(
      ["wait-delivery", "--token", DELIVERY_TOKEN],
      {
        env: {},
        stdout,
        stderr,
        loadConfig: () => ({
          stateDir: "/private/fake-state",
          controlSocketPath: "/private/fake-state/control.sock",
          allowedHosts: ["this-mac"],
          stallNoticeMs: 30_000,
          steeringEnabled: true,
          inboundMode: "paired",
          limits: {} as never,
        }),
        validateControlSocket: async () => undefined,
        sendRequest: (async () => {
          attempts += 1;
          return { protocolVersion: 1, ok: true, result };
        }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
      },
    );

    assert.equal(code, gatewayCliExitCodes.failure, state);
    assert.equal(attempts, 1, state);
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: true,
      command: "wait-delivery",
      result,
    });
    assert.equal(stderr.chunks.join(""), "[embassy] command failed.\n");
  }
});

test("wait-delivery distinguishes an unknown token from its bounded deadline", async () => {
  const fakeConfig = () => ({
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
    inboundMode: "paired" as const,
    limits: {} as never,
  });

  const unknownOut = capture();
  const unknownErr = capture();
  let unknownAttempts = 0;
  const unknownCode = await runGatewayCli(
    ["wait-delivery", "--token", DELIVERY_TOKEN],
    {
      env: {},
      stdout: unknownOut,
      stderr: unknownErr,
      loadConfig: fakeConfig,
      validateControlSocket: async () => undefined,
      sendRequest: (async () => {
        unknownAttempts += 1;
        return {
          protocolVersion: 1,
          ok: true,
          result: { found: false },
        };
      }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    },
  );
  assert.equal(unknownCode, gatewayCliExitCodes.rejected);
  assert.equal(unknownAttempts, 1);
  assert.deepEqual(JSON.parse(unknownOut.chunks.join("")), {
    ok: false,
    command: "wait-delivery",
    error: {
      code: "DELIVERY_TOKEN_UNKNOWN",
      ambiguous: false,
      retryable: false,
    },
  });
  assert.equal(
    unknownErr.chunks.join(""),
    "[embassy] delivery token not recognized; it may have expired or belong to a previous gateway session.\n",
  );

  const timeoutOut = capture();
  const timeoutErr = capture();
  const startedAt = Date.parse(NOW);
  const deliveryDeadlineAt = new Date(startedAt - 2_750).toISOString();
  const clientDeadlineAt = Date.parse(deliveryDeadlineAt) + 3_000;
  let clock = startedAt;
  const delays: number[] = [];
  let timeoutAttempts = 0;
  const timeoutCode = await runGatewayCli(
    ["wait-delivery", "--token", DELIVERY_TOKEN],
    {
      env: {},
      stdout: timeoutOut,
      stderr: timeoutErr,
      loadConfig: fakeConfig,
      validateControlSocket: async () => undefined,
      sendRequest: (async () => {
        timeoutAttempts += 1;
        return {
          protocolVersion: 1,
          ok: true,
          result: {
            found: true,
            state: "queued",
            terminal: false,
            updatedAt: NOW,
            deadlineAt: deliveryDeadlineAt,
          },
        };
      }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
      now: () => clock,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
    },
  );
  assert.equal(timeoutCode, gatewayCliExitCodes.unavailable);
  assert.equal(timeoutAttempts, 1);
  assert.deepEqual(delays, [250]);
  assert.equal(clock, clientDeadlineAt);
  assert.deepEqual(JSON.parse(timeoutOut.chunks.join("")), {
    ok: false,
    command: "wait-delivery",
    error: {
      code: "DELIVERY_WAIT_TIMEOUT",
      ambiguous: false,
      retryable: true,
    },
  });
  assert.equal(
    timeoutErr.chunks.join(""),
    "[embassy] the delivery has not settled yet; the gateway is still running. Check again later with embassy delivery-status.\n",
  );
});

test("mutation response loss is normalized as ambiguous and is never retried", async () => {
  const stdout = capture();
  const stderr = capture();
  let attempts = 0;
  const code = await runGatewayCli(
    [
      "send-to-claude",
      "--from",
      "codex-reviewer@this-mac",
      "--to",
      "advisor@this-mac",
    ],
    {
      env: { CODEX_THREAD_ID: THREAD_ID },
      stdin: input(SECRET_BODY),
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => {
        attempts += 1;
        throw new GatewayControlTransportError(
          "CONTROL_OUTCOME_AMBIGUOUS",
          "private diagnostic sentinel",
          true,
        );
      },
    },
  );

  assert.equal(code, gatewayCliExitCodes.ambiguous);
  assert.equal(attempts, 1);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false,
    command: "send-to-claude",
    error: {
      code: "CONTROL_OUTCOME_AMBIGUOUS",
      ambiguous: true,
      retryable: false,
    },
  });
  assert.equal(
    stderr.chunks.join(""),
    "[embassy] outcome ambiguous; do not retry automatically.\n",
  );
  assert.doesNotMatch(stdout.chunks.join(""), /private diagnostic|BODY_SENTINEL/);
});

test("a broker decision rejection has a distinct fixed exit and no diagnostics", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runGatewayCli(
    ["select-claude", "--alias", "advisor@this-mac"],
    {
      env: {},
      stdin: input(),
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async () => ({
        protocolVersion: 1,
        ok: true,
        result: { accepted: false, code: "not_found" },
      })) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    },
  );

  assert.equal(code, gatewayCliExitCodes.rejected);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: true,
    command: "select-claude",
    result: { accepted: false, code: "not_found" },
  });
  assert.equal(
    stderr.chunks.join(""),
    "[embassy] gateway rejected the request.\n",
  );
});

test("watch-owner conflict preserves its code and localizes the untrack remedy", async () => {
  const expectedHint = {
    en:
      "[embassy] gateway rejected the request.\n[embassy] this pair already has a watch owned by the other participant; ask that owner to run `embassy untrack --conversation <conversation-token>` first.\n",
    "zh-CN":
      "[embassy] 网关拒绝了该请求。\n[embassy] 此配对已有由另一参与方拥有的监视；请先让该所有者运行 `embassy untrack --conversation <conversation-token>`。\n",
  } as const;
  let englishStdout: string | undefined;
  for (const locale of ["en", "zh-CN"] as const) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(
      [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        "advisor@this-mac",
        "--lang",
        locale,
      ],
      {
        env: { CODEX_THREAD_ID: THREAD_ID },
        stdin: input("TRACK: replacement attempt"),
        stdout,
        stderr,
        loadConfig: () => ({
          stateDir: "/private/fake-state",
          controlSocketPath: "/private/fake-state/control.sock",
          allowedHosts: ["this-mac"],
          stallNoticeMs: 30_000,
          steeringEnabled: true,
          inboundMode: "paired",
          limits: {} as never,
        }),
        validateControlSocket: async () => undefined,
        sendRequest: (async () => ({
          protocolVersion: 1,
          ok: true,
          result: {
            accepted: false,
            code: "watch_owner_conflict",
          },
        })) as NonNullable<GatewayCliDependencies["sendRequest"]>,
      },
    );
    assert.equal(code, gatewayCliExitCodes.rejected);
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: true,
      command: "send-to-claude",
      result: { accepted: false, code: "watch_owner_conflict" },
    });
    assert.equal(stderr.chunks.join(""), expectedHint[locale]);
    if (englishStdout === undefined) englishStdout = stdout.chunks.join("");
    else assert.equal(stdout.chunks.join(""), englishStdout);
  }
});

test("identity, stdin, and argument failures happen before any control request", async () => {
  const cases: Array<{
    argv: string[];
    env: NodeJS.ProcessEnv;
    body?: string;
    code: string;
  }> = [
    {
      argv: ["wait-delivery", "--token", "dlv_too-short"],
      env: {},
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: ["delivery-status", "--token", `${DELIVERY_TOKEN}x`],
      env: {},
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: ["register-codex", "--alias", "reviewer@this-mac"],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@this-mac",
        "--succeeds",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--succeeds",
        "codex-reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@this-mac",
        "--succeeds",
        "codex-reviewer@build-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@this-mac",
        "--succeeds",
        "codex-next@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@build-mac",
        "--succeeds",
        "codex-reviewer@build-mac",
        "--host",
        "build-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@this-mac",
        "--succeeds",
        "reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-next@this-mac",
        "--succeeds",
        "codex-reviewer@this-mac",
        "--old-thread-id",
        OLD_THREAD_ID_SENTINEL,
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-reviewer@this-mac",
        "--succeed",
        "codex-next@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: ["register-codex", "--alias", "codex-reviewer@this-mac"],
      env: {},
      code: "CODEX_IDENTITY_REQUIRED",
    },
    {
      argv: [
        "send-to-codex",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
      env: {},
      body: SECRET_BODY,
      code: "CLAUDE_IDENTITY_REQUIRED",
    },
    {
      argv: [
        "send-to-codex",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
      env: { CLAUDE_CODE_MESSAGING_SOCKET: REPLY_ADDRESS },
      body: SECRET_BODY,
      code: "CLAUDE_IDENTITY_INVALID",
    },
    {
      argv: [
        "reply",
        "--conversation",
        CONVERSATION_ID,
        "--alias",
        "codex-reviewer@this-mac",
      ],
      env: {
        ...BOTH_IDENTITIES,
      },
      body: SECRET_BODY,
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: ["register-codex", "--alias", "codex-reviewer@this-mac"],
      env: { ...BOTH_IDENTITIES },
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: [
        "register-codex",
        "--alias",
        "codex-reviewer@this-mac",
        "--lang",
        "zh-CN",
      ],
      env: { ...BOTH_IDENTITIES },
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: ["register-codex", "--alias", "codex-reviewer@this-mac"],
      env: { CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH },
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: ["unregister-codex", "--alias", "codex-reviewer@this-mac"],
      env: { ...BOTH_IDENTITIES },
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        "advisor@this-mac",
      ],
      env: { ...BOTH_IDENTITIES },
      body: SECRET_BODY,
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: [
        "send-to-codex",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
      env: { ...BOTH_IDENTITIES },
      body: SECRET_BODY,
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: [
        "send-to-codex",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      body: SECRET_BODY,
      code: "CALLER_IDENTITY_CONFLICT",
    },
    {
      argv: [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        "advisor@this-mac",
        "--text",
        SECRET_BODY,
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: ["serve", "--unexpected"],
      env: {},
      code: "INVALID_ARGUMENTS",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
    const stderr = capture();
    let requested = false;
    const exitCode = await runGatewayCli(current.argv, {
      env: current.env,
      stdin: input(current.body),
      stdout,
      stderr,
      loadConfig: () => {
        throw new Error("configuration must not be loaded");
      },
      validateControlSocket: async () => {
        throw new Error("socket must not be checked");
      },
      sendRequest: async () => {
        requested = true;
        throw new Error("request must not be sent");
      },
    });
    assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
    assert.equal(requested, false);
    const parsed = JSON.parse(stdout.chunks.join("")) as {
      error: { code: string };
    };
    assert.equal(parsed.error.code, current.code);
    const hasBothIdentities =
      typeof current.env.CODEX_THREAD_ID === "string" &&
      current.env.CODEX_THREAD_ID.length > 0 &&
      typeof current.env.CLAUDE_CODE_MESSAGING_SOCKET === "string" &&
      current.env.CLAUDE_CODE_MESSAGING_SOCKET.length > 0;
    const isZhCn = current.argv.includes("zh-CN");
    assert.equal(
      stderr.chunks.join(""),
      isZhCn
        ? `[embassy] 请求被拒绝。\n${
            hasBothIdentities ? CALLER_IDENTITY_CONFLICT_HINT_ZH_CN : ""
          }`
        : `[embassy] request rejected.\n${
            hasBothIdentities ? CALLER_IDENTITY_CONFLICT_HINT_EN : ""
          }`,
    );
    const rendered = `${stdout.chunks.join("")}${stderr.chunks.join("")}`;
    assert.equal(rendered.includes(SECRET_BODY), false);
    assert.equal(rendered.includes(THREAD_ID), false);
    assert.equal(rendered.includes(CLAUDE_SOCKET_PATH), false);
  }
});

test("serve emits one normalized ready result without using the client socket or stdin", async () => {
  const stdout = capture();
  const stderr = capture();
  const env = {
    EMBASSY_LOCALE: "unsupported",
    CODEX_THREAD_ID: THREAD_ID,
    CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
    SECRET_SENTINEL: SECRET_BODY,
  };
  let calls = 0;
  const exitCode = await runGatewayCli(["serve", "--lang", "zh-CN"], {
    env,
    stdin: {
      async *[Symbol.asyncIterator]() {
        throw new Error("serve must not consume stdin");
      },
    },
    stdout,
    stderr,
    loadConfig: () => {
      throw new Error("the injected server owns configuration");
    },
    validateControlSocket: async () => {
      throw new Error("serve must not use the client socket validator");
    },
    sendRequest: async () => {
      throw new Error("serve must not send a control request");
    },
    runServer: async (options) => {
      calls += 1;
      assert.equal(options.env, env);
      assert.equal(options.locale, "zh-CN");
      assert.equal(options.inboundMode, "paired");
      await options.onReady({
        status: "ready",
        hostId: "this-mac",
        codexMode: "native_messaging",
        dashboardFile: "gateway-dashboard.html",
      });
    },
  });

  assert.equal(exitCode, gatewayCliExitCodes.ok);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: true,
    command: "serve",
    result: {
      status: "ready",
      hostId: "this-mac",
      codexMode: "native_messaging",
      dashboardFile: "gateway-dashboard.html",
    },
  });
  assert.equal(stderr.chunks.join(""), "");
  assert.equal(stdout.chunks.join("").includes(SECRET_BODY), false);
  assert.equal(stdout.chunks.join("").includes(THREAD_ID), false);
  assert.equal(stdout.chunks.join("").includes(CLAUDE_SOCKET_PATH), false);
});

test("serve accepts only the exact explicit open-inbound opt-out", async () => {
  let observedMode: string | undefined;
  const exitCode = await runGatewayCli(["serve", "--inbound", "open"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    runServer: async (options) => {
      observedMode = options.inboundMode;
      await options.onReady({
        status: "ready",
        hostId: "this-mac",
        codexMode: "native_messaging",
        dashboardFile: "gateway-dashboard.html",
      });
    },
  });
  assert.equal(exitCode, gatewayCliExitCodes.ok);
  assert.equal(observedMode, "open");

  for (const argv of [
    ["serve", "--inbound"],
    ["serve", "--inbound", "paired"],
    ["serve", "--inbound", "OPEN"],
    ["serve", "--inbound", "open", "--inbound", "open"],
  ]) {
    let started = false;
    const stdout = capture();
    const invalid = await runGatewayCli(argv, {
      env: {},
      stdout,
      stderr: capture(),
      runServer: async () => {
        started = true;
      },
    });
    assert.equal(invalid, gatewayCliExitCodes.invalidInput);
    assert.equal(started, false);
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } })
        .error.code,
      "INVALID_ARGUMENTS",
    );
  }
});

test("serve reports startup failure once and never appends protocol output after ready", async () => {
  const beforeReadyOut = capture();
  const beforeReadyErr = capture();
  const beforeReady = await runGatewayCli(["serve"], {
    env: {},
    stdout: beforeReadyOut,
    stderr: beforeReadyErr,
    runServer: async () => {
      throw new BridgeError("SYNTHETIC_STARTUP_FAILURE", "private detail");
    },
  });
  assert.equal(beforeReady, gatewayCliExitCodes.invalidInput);
  assert.deepEqual(JSON.parse(beforeReadyOut.chunks.join("")), {
    ok: false,
    command: "serve",
    error: {
      code: "SYNTHETIC_STARTUP_FAILURE",
      ambiguous: false,
      retryable: false,
    },
  });
  assert.equal(
    beforeReadyErr.chunks.join(""),
    "[embassy] request rejected.\n",
  );
  assert.equal(beforeReadyOut.chunks.join("").includes("private detail"), false);

  const afterReadyOut = capture();
  const afterReadyErr = capture();
  const afterReady = await runGatewayCli(["serve"], {
    env: {},
    stdout: afterReadyOut,
    stderr: afterReadyErr,
    runServer: async (options) => {
      await options.onReady({
        status: "ready",
        hostId: "this-mac",
        codexMode: "native_messaging",
        dashboardFile: "gateway-dashboard.html",
      });
      throw new Error("private shutdown detail");
    },
  });
  assert.equal(afterReady, gatewayCliExitCodes.failure);
  assert.equal(afterReadyOut.chunks.length, 1);
  assert.equal(
    (JSON.parse(afterReadyOut.chunks.join("")) as { ok: boolean }).ok,
    true,
  );
  assert.equal(
    afterReadyErr.chunks.join(""),
    "[embassy] command failed.\n",
  );
  assert.equal(afterReadyOut.chunks.join("").includes("private shutdown"), false);
});

test("the CLI refuses an insecure state directory before connecting", async (t) => {
  const state = await privateState();
  const server = await startGatewayControlServer({
    stateDir: state.stateDir,
    socketPath: state.socketPath,
    handlers: {
      health: () => ({ status: "ok", revision: 1 }),
      registerCodex: () => ({ accepted: true, code: "ok" }),
      unregisterCodex: () => ({ accepted: true, code: "ok" }),
      removeStaleCodexRegistration: () => ({ accepted: true, code: "ok" }),
      selectClaude: () => ({ accepted: true, code: "ok" }),
      unselectClaude: () => ({ accepted: true, code: "ok" }),
      pair: () => ({ accepted: true, code: "ok" }),
      unpair: () => ({ accepted: true, code: "ok" }),
      listSnapshot: () => emptySnapshot(),
      observeSnapshot: () => ({
        snapshotRevision: 0,
        snapshot: emptySnapshot(),
      }),
      deliveryStatus: () => ({ found: false }),
      untrack: () => ({ accepted: true, code: "ok" }),
      sendToClaude: () => ({
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      }),
      sendToCodex: () => ({
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      }),
      reply: () => ({
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: DELIVERY_TOKEN,
      }),
      refreshDashboard: () => ({
        accepted: true,
        code: "ok",
        revision: 2,
      }),
    },
  });
  t.after(async () => await server.close());
  await chmod(state.stateDir, 0o755);

  const result = await invoke(state.stateDir, ["health"]);
  assert.equal(result.code, gatewayCliExitCodes.invalidInput);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    command: "health",
    error: {
      code: "CONTROL_STATE_UNSAFE",
      ambiguous: false,
      retryable: false,
    },
  });
  assert.equal(
    result.stderr,
    "[embassy] gateway state directory or socket has unexpected permissions or ownership. Verify nothing else controls that path before running embassy serve.\n",
  );
  assert.doesNotMatch(result.stdout, new RegExp(state.root.replaceAll("/", "\\/")));
});

test("oversized stdin renders its localized hint while generic input rejection does not", async () => {
  const cases = [
    {
      body: Buffer.alloc(16 * 1024 + 1, 0x61),
      expected: "MESSAGE_TOO_LARGE",
      env: { CODEX_THREAD_ID: THREAD_ID },
      stderr:
        "[embassy] request rejected.\n[embassy] message exceeds the 16 KiB acceptance cap; shorten or split it. For long prose, pipe the body from a file.\n",
    },
    {
      body: Buffer.from([0xc3, 0x28]),
      expected: "INVALID_MESSAGE_INPUT",
      env: { CODEX_THREAD_ID: THREAD_ID },
      stderr: "[embassy] request rejected.\n",
    },
    {
      body: Buffer.alloc(16 * 1024 + 1, 0x61),
      expected: "MESSAGE_TOO_LARGE",
      env: { CODEX_THREAD_ID: THREAD_ID, EMBASSY_LOCALE: "zh-CN" },
      stderr:
        "[embassy] 请求被拒绝。\n[embassy] 消息超过 16 KiB 接收上限；请缩短消息或将其拆分。对于长篇内容，请通过管道从文件传入正文。\n",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
    const stderr = capture();
    let requested = false;
    const exitCode = await runGatewayCli(
      [
        "send-to-claude",
        "--from",
        "codex-reviewer@this-mac",
        "--to",
        "advisor@this-mac",
      ],
      {
        env: current.env,
        stdin: Readable.from([current.body]),
        stdout,
        stderr,
        sendRequest: async () => {
          requested = true;
          throw new Error("must not connect");
        },
      },
    );
    assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
    assert.equal(requested, false);
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } }).error
        .code,
      current.expected,
    );
    assert.equal(stderr.chunks.join(""), current.stderr);
  }
});

test("package metadata publishes the client and its runtime dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    os: string[];
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(packageJson.name, "agent-embassy");
  assert.equal(packageJson.version, "1.6.0");
  assert.equal(packageJson.version, EMBASSY_VERSION);
  assert.deepEqual(packageJson.os, ["darwin"]);
  assert.deepEqual(packageJson.bin, { embassy: "dist/src/gateway/cli.js" });
  assert.equal(packageJson.scripts.embassy, "node dist/src/gateway/cli.js");
  assert.match(packageJson.scripts.build ?? "", /npm run clean/);
  assert.ok(packageJson.files.includes("skills/embassy-peer"));
  assert.ok(packageJson.files.includes("dist/src/gateway"));
  assert.ok(packageJson.files.includes("SECURITY.md"));
  assert.ok(packageJson.files.includes("CONTRIBUTING.md"));
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.equal(packageJson.files.includes("dist/src"), false);
  assert.equal(packageJson.dependencies.ws, "8.21.3");
  assert.equal(packageJson.devDependencies.ws, undefined);
});
