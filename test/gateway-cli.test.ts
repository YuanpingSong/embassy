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
  type ReplyParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendToClaudeParams,
  type ValidatedSendToCodexParams,
} from "../src/gateway/control.js";
import {
  EMBASSY_VERSION,
  type GatewayCliDependencies,
  gatewayCliExitCodes,
  runGatewayCli,
} from "../src/gateway/cli.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
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
    health: "healthy",
    connectors: [],
    availablePeers: [],
    routes: [],
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
  const sendsToClaude: ValidatedSendToClaudeParams[] = [];
  const sendsToCodex: ValidatedSendToCodexParams[] = [];
  const replies: ReplyParams[] = [];
  const deliveryStatuses: string[] = [];
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
    selectClaude: ({ alias }) => {
      selected.push(alias);
      return { accepted: true, code: "ok" };
    },
    unselectClaude: ({ alias }) => {
      unselected.push(alias);
      return { accepted: true, code: "ok" };
    },
    listSnapshot: () => emptySnapshot(),
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
    { argv: ["refresh-dashboard"], env: BOTH_IDENTITIES },
    {
      argv: ["register-codex", "--alias", "codex-reviewer@this-mac"],
      env: { CODEX_THREAD_ID: THREAD_ID },
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
    const result = await invoke(state.stateDir, current.argv, current);
    assert.equal(result.code, gatewayCliExitCodes.ok);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      result?: { deliveryToken?: string };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, current.argv[0]);
    assert.ok(Buffer.byteLength(result.stdout) <= 256 * 1024);
    assert.doesNotMatch(result.stdout, new RegExp(THREAD_ID, "i"));
    assert.doesNotMatch(result.stdout, /cc-socks|45201|BODY_SENTINEL/);
    if (
      current.argv[0] === "send-to-claude" ||
      current.argv[0] === "send-to-codex" ||
      current.argv[0] === "reply"
    ) {
      assert.equal(parsed.result?.deliveryToken, DELIVERY_TOKEN);
    }
  }

  assert.deepEqual(registrations, [
    {
      alias: "codex-reviewer@this-mac",
      threadId: THREAD_ID,
      hostId: "this-mac",
      busyPolicy: "queue",
    },
  ]);
  assert.deepEqual(unregisters, [
    { alias: "codex-reviewer@this-mac", threadId: THREAD_ID },
  ]);
  assert.deepEqual(selected, ["advisor@this-mac", CLAUDE_SESSION_ID]);
  assert.deepEqual(unselected, ["advisor@this-mac"]);
  assert.deepEqual(deliveryStatuses, [DELIVERY_TOKEN, DELIVERY_TOKEN]);
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
    "[embassy] gateway rejected the request.\n",
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
    "[embassy] gateway unavailable.\n",
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
    assert.equal(
      stderr.chunks.join(""),
      "[embassy] request rejected.\n",
    );
    assert.doesNotMatch(stdout.chunks.join(""), /BODY_SENTINEL|cc-socks|45201/);
  }
});

test("serve emits one normalized ready result without using the client socket or stdin", async () => {
  const stdout = capture();
  const stderr = capture();
  const env = {
    CODEX_THREAD_ID: THREAD_ID,
    CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
    SECRET_SENTINEL: SECRET_BODY,
  };
  let calls = 0;
  const exitCode = await runGatewayCli(["serve"], {
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
      selectClaude: () => ({ accepted: true, code: "ok" }),
      unselectClaude: () => ({ accepted: true, code: "ok" }),
      listSnapshot: () => emptySnapshot(),
      observeSnapshot: () => ({
        snapshotRevision: 0,
        snapshot: emptySnapshot(),
      }),
      deliveryStatus: () => ({ found: false }),
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
    "[embassy] request rejected.\n",
  );
  assert.doesNotMatch(result.stdout, new RegExp(state.root.replaceAll("/", "\\/")));
});

test("oversized and non-UTF-8 stdin are rejected without a request", async () => {
  const cases = [
    {
      body: Buffer.alloc(16 * 1024 + 1, 0x61),
      expected: "MESSAGE_TOO_LARGE",
    },
    {
      body: Buffer.from([0xc3, 0x28]),
      expected: "INVALID_MESSAGE_INPUT",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
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
        env: { CODEX_THREAD_ID: THREAD_ID },
        stdin: Readable.from([current.body]),
        stdout,
        stderr: capture(),
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
  assert.equal(packageJson.version, "1.0.0");
  assert.equal(packageJson.version, EMBASSY_VERSION);
  assert.deepEqual(packageJson.os, ["darwin"]);
  assert.equal(packageJson.bin.embassy, "dist/src/gateway/cli.js");
  assert.equal(
    packageJson.bin["claude-codex-gateway"],
    "dist/src/gateway/cli.js",
  );
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
