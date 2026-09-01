import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BridgeError } from "../src/errors.js";
import {
  GATEWAY_CONTROL_PROTOCOL_VERSION,
  GatewayControlTransportError,
  startGatewayControlServer,
  type GatewayControlHandlers,
  type GatewaySnapshot,
  type PairParams,
  type ReplyParams,
  type ValidatedRegisterCodexParams,
  type ValidatedSendParams,
} from "../src/gateway/control.js";
import {
  EMBASSY_VERSION,
  type GatewayCliDependencies,
  gatewayCliCommands,
  gatewayCliExitCodes,
  runGatewayCli as runGatewayCliBase,
} from "../src/gateway/cli.js";
import { PeerHandlerError } from "../src/gateway/peer-stdio.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const OLD_THREAD_ID_SENTINEL = "00000000-0000-7000-8000-000000000702";
const CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000042";
const CLAUDE_SOCKET_PATH = "/tmp/cc-socks/45201.sock";
const REPLY_ADDRESS = `uds:${CLAUDE_SOCKET_PATH}`;
const CONVERSATION_ID = "conv_0123456789abcdef";
const DELIVERY_TOKEN = "dlv_0123456789abcdefghijklmn";
const PEER_TOKEN = `peer_${"a".repeat(32)}`;
const PEER_RECEIPT = `prc_${"b".repeat(24)}`;
const TEST_INVENTORY = { host: "this-mac", nodes: [] } as const;
const runGatewayCli: typeof runGatewayCliBase = (argv, dependencies = {}) =>
  runGatewayCliBase(argv, { loadNodeInventory: async () => TEST_INVENTORY, ...dependencies });
const NOW = "2026-08-07T12:34:56.000Z";
const DEADLINE = "2099-08-07T12:35:56.000Z";
const SECRET_BODY = "BODY_SENTINEL_NEVER_RENDER";
const BOTH_IDENTITIES = {
  CODEX_THREAD_ID: THREAD_ID,
  CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
} as const;
const CALLER_IDENTITY_CONFLICT_HINT_EN =
  "[embassy] both agent identities were inherited; rerun this Codex-side call with env -u CLAUDE_CODE_MESSAGING_SOCKET, or this Claude-side call with env -u CODEX_THREAD_ID\n";
const CALLER_IDENTITY_CONFLICT_HINT_ZH_CN =
  "[embassy] 同时继承了两种代理身份；Codex 侧调用请使用 env -u CLAUDE_CODE_MESSAGING_SOCKET 重试，Claude 侧调用请使用 env -u CODEX_THREAD_ID 重试\n";
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
    assert.match(help, /register-peer/);
    assert.match(help, /unregister-peer/);
    assert.match(help, /--token-stdin/);
    assert.match(help, /dashboard --live \[--port <n>\]/);
    assert.match(help, /pair \[--from <[^>]+> --to <[^>]+>\]/);
    assert.match(help, /--port <n>.*1024.*65535.*41961/);
    assert.doesNotMatch(help, /compat-(?:check|certify)|--with-turn/);
    assert.equal(stderr.chunks.join(""), "");
  }
});

test("removed compatibility commands fail before configuration or control work", async () => {
  for (const command of ["compat-check", "compat-certify", "send-to-claude", "send-to-codex"]) {
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
    schemaVersion: 2,
    generatedAt: "2026-08-07T12:34:56.000Z",
    inboundMode: "paired" as const,
    health: "healthy",
    connectors: [],
    availablePeers: [],
    routes: [],
    consentEdges: [],
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
      consentEdges: 0,
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

test("peer registration emits its credential once and authenticated lifecycle never echoes it", async () => {
  const config = { stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true, inboundMode: "paired" as const,
    stallNoticeMs: 30_000, limits: {} as never };
  const requests: unknown[] = [];
  const dependencies = (stdout: Capture, env: NodeJS.ProcessEnv = {}, stdin = input()): GatewayCliDependencies => ({
    env, stdin, stdout, stderr: capture(), loadConfig: () => config,
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: { method: string; params: Record<string, unknown> } }) => {
      requests.push(request);
      return request.method === "register_peer" && !("token" in request.params)
        ? { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { accepted: true, code: "ok", token: PEER_TOKEN } }
        : { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { accepted: true, code: "ok" } };
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  });

  const minted = capture();
  assert.equal(await runGatewayCli(["register-peer", "--alias", "peer-cursor@this-mac"], dependencies(minted)), 0);
  assert.equal(minted.chunks.join("").split(PEER_TOKEN).length - 1, 1);
  assert.equal(JSON.parse(minted.chunks.join("")).result.token, PEER_TOKEN);

  const exported = capture();
  assert.equal(await runGatewayCli(["register-peer", "--alias", "peer-shell@this-mac", "--emit-env"], dependencies(exported)), 0);
  assert.equal(exported.chunks.join(""), `export EMBASSY_PEER_TOKEN='${PEER_TOKEN}'\n`);

  const authenticated = capture();
  assert.equal(await runGatewayCli(["register-peer", "--alias", "peer-cursor@this-mac"],
    dependencies(authenticated, { EMBASSY_PEER_TOKEN: PEER_TOKEN })), 0);
  assert.equal(authenticated.chunks.join("").includes(PEER_TOKEN), false);
  assert.equal(await runGatewayCli(["unregister-peer", "--alias", "peer-cursor@this-mac", "--token-stdin"],
    dependencies(capture(), {}, input(`${PEER_TOKEN}\n`))), 0);
  const invalid = capture();
  assert.equal(await runGatewayCli(["register-peer", "--alias", "peer-cursor@this-mac", "--emit-env"],
    dependencies(invalid, { EMBASSY_PEER_TOKEN: PEER_TOKEN })), gatewayCliExitCodes.invalidInput);
  assert.equal(JSON.parse(invalid.chunks.join("")).error.code, "INVALID_ARGUMENTS");
  assert.deepEqual(requests, [
    { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "register_peer", params: { alias: "peer-cursor@this-mac" } },
    { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "register_peer", params: { alias: "peer-shell@this-mac" } },
    { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "register_peer", params: { alias: "peer-cursor@this-mac", token: PEER_TOKEN } },
    { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "unregister_peer", params: { alias: "peer-cursor@this-mac", token: PEER_TOKEN } },
  ]);
});

test("peer stdin framing preserves the body and the three caller principals stay exclusive", async () => {
  const requests: unknown[] = [], stdout = capture(); let control = 0;
  const base: GatewayCliDependencies = {
    env: {}, stdout, stderr: capture(), loadConfig: () => ({ stateDir: "/private/state",
      controlSocketPath: "/private/state/control.sock", allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true,
      inboundMode: "paired", stallNoticeMs: 30_000, limits: {} as never }),
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: unknown }) => { control += 1; requests.push(request);
      return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { accepted: true, code: "ok",
        conversationId: CONVERSATION_ID, deliveryToken: DELIVERY_TOKEN } }; }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  };
  const fragmented = Readable.from([Buffer.from(PEER_TOKEN.slice(0, 9)), Buffer.from(`${PEER_TOKEN.slice(9)}\n`), Buffer.from("\nexact body")]);
  assert.equal(await runGatewayCli(["send", "--from", "peer-cursor@this-mac", "--to", "advisor@this-mac", "--token-stdin"],
    { ...base, stdin: fragmented }), 0);
  assert.deepEqual(requests[0], { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "send", params: {
    fromAlias: "peer-cursor@this-mac", toAlias: "advisor@this-mac", text: "\nexact body",
    expectsReply: false, peerToken: PEER_TOKEN } });

  assert.equal(await runGatewayCli(["reply", "--conversation", CONVERSATION_ID, "--alias", "peer-cursor@this-mac"],
    { ...base, env: { EMBASSY_PEER_TOKEN: PEER_TOKEN }, stdin: input("reply body") }), 0);
  assert.deepEqual(requests[1], { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "reply", params: {
    conversationId: CONVERSATION_ID, text: "reply body",
    caller: { kind: "peer", alias: "peer-cursor@this-mac", token: PEER_TOKEN } } });

  for (const current of [
    { env: { EMBASSY_PEER_TOKEN: PEER_TOKEN, CODEX_THREAD_ID: THREAD_ID }, body: "body" },
    { env: { EMBASSY_PEER_TOKEN: PEER_TOKEN }, body: `${PEER_TOKEN}\nbody` },
    { env: {}, body: `${PEER_TOKEN}\r\nbody` },
  ]) {
    const before = control, out = capture();
    const code = await runGatewayCli(["send", "--from", "peer-cursor@this-mac", "--to", "codex-main@this-mac", "--token-stdin"],
      { ...base, ...current, stdin: input(current.body), stdout: out });
    assert.equal(code, gatewayCliExitCodes.invalidInput);
    assert.equal(control, before);
  }
});

test("peer token framing is exact, bounded, and rejects before control work", async () => {
  const highByte = Buffer.from(`${PEER_TOKEN}\n`);
  highByte[5] = 0xe1;
  const cases: Array<{ argv: string[]; chunks: Buffer[]; code: string }> = [
    {
      argv: ["unregister-peer", "--alias", "peer-cursor@this-mac", "--token-stdin"],
      chunks: [Buffer.from(PEER_TOKEN)], code: "INVALID_MESSAGE_INPUT",
    },
    {
      argv: ["unregister-peer", "--alias", "peer-cursor@this-mac", "--token-stdin"],
      chunks: [Buffer.from(`${PEER_TOKEN}\ntrailing`)], code: "INVALID_MESSAGE_INPUT",
    },
    {
      argv: ["unregister-peer", "--alias", "peer-cursor@this-mac", "--token-stdin"],
      chunks: [highByte], code: "INVALID_MESSAGE_INPUT",
    },
    {
      argv: ["send", "--from", "peer-cursor@this-mac", "--to", "codex-main@this-mac", "--token-stdin"],
      chunks: [Buffer.from(`${PEER_TOKEN}\n`), Buffer.alloc(16 * 1024 + 1, 0x61)], code: "MESSAGE_TOO_LARGE",
    },
    {
      argv: ["send", "--from", "peer-cursor@this-mac", "--to", "codex-main@this-mac", "--token-stdin"],
      chunks: [Buffer.from(`${PEER_TOKEN}\n`), Buffer.from([0xc3, 0x28])], code: "INVALID_MESSAGE_INPUT",
    },
  ];
  for (const current of cases) {
    let configured = false, requested = false;
    const stdout = capture();
    const code = await runGatewayCli(current.argv, {
      env: {}, stdin: Readable.from(current.chunks), stdout, stderr: capture(),
      loadConfig: () => { configured = true; throw new Error("must not load"); },
      sendRequest: async () => { requested = true; throw new Error("must not send"); },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, current.code);
    assert.equal(configured, false);
    assert.equal(requested, false);
  }
});

test("await long-polls silently and acknowledges only after the exact frame flushes", async () => {
  const frame = "{\"from\":\"advisor@this-mac\",\"text\":\"hello\"}\n", methods: string[] = [];
  let release: ((error?: Error | null) => void) | undefined, polls = 0;
  const stdout = { chunks: [] as string[], write(chunk: string, callback?: (error?: Error | null) => void) {
    this.chunks.push(chunk); release = callback; return true;
  } };
  const running = runGatewayCli(["await", "--alias", "peer-cursor@this-mac", "--token-stdin"], {
    env: {}, stdin: input(`${PEER_TOKEN}\n`), stdout, stderr: capture(),
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true, inboundMode: "paired", stallNoticeMs: 30_000, limits: {} as never }),
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: { method: string } }) => {
      methods.push(request.method);
      if (request.method === "await_peer" && polls++ === 0) return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { state: "timeout" } };
      if (request.method === "await_peer") return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { state: "message", frame, receipt: PEER_RECEIPT } };
      assert.deepEqual(request, { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "peer_receipt", params: {
        alias: "peer-cursor@this-mac", token: PEER_TOKEN, receipt: PEER_RECEIPT } });
      return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { accepted: true, code: "ok" } };
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  });
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(methods, ["await_peer", "await_peer"]);
  assert.equal(stdout.chunks.join(""), frame);
  release();
  assert.equal(await running, gatewayCliExitCodes.ok);
  assert.deepEqual(methods, ["await_peer", "await_peer", "peer_receipt"]);
});

test("await sends no receipt or second stdout frame when stdout fails", async () => {
  const methods: string[] = [], stderr = capture();
  const code = await runGatewayCli(["await", "--alias", "peer-cursor@this-mac"], {
    env: { EMBASSY_PEER_TOKEN: PEER_TOKEN }, stdin: input(), stderr,
    stdout: { write() { throw new Error("synthetic stdout failure"); } },
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true, inboundMode: "paired", stallNoticeMs: 30_000, limits: {} as never }),
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: { method: string } }) => { methods.push(request.method);
      return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { state: "message", frame: "one frame\n", receipt: PEER_RECEIPT } }; }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  });
  assert.equal(code, gatewayCliExitCodes.failure);
  assert.deepEqual(methods, ["await_peer"]);
  assert.equal(stderr.chunks.join(""), "[embassy] command failed.\n");
});

async function privateState(): Promise<{
  root: string;
  stateDir: string;
  socketPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cli-"));
  roots.add(root);
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(path.join(stateDir, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}', { mode: 0o600 });
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
  const sendsToClaude: ValidatedSendParams[] = [];
  const sendsToCodex: ValidatedSendParams[] = [];
  const replies: ReplyParams[] = [];
  const deliveryStatuses: string[] = [];
  const untracked: string[] = [];
  const statusSnapshot = emptySnapshot();
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
    removeCodexRegistration: () => ({ accepted: true, code: "ok" }),
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
    send: (params) => {
      ("replyAddress" in params ? sendsToCodex : sendsToClaude).push({ ...params });
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
    registerPeer: () => ({ accepted: true, code: "ok", token: PEER_TOKEN }),
    unregisterPeer: () => ({ accepted: true, code: "ok" }),
    awaitPeer: () => ({ state: "timeout" }),
    peerReceipt: () => ({ accepted: true, code: "ok" }),
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
    { argv: ["doctor"], env: BOTH_IDENTITIES },
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
        "codex-next@this-mac",
        "--succeeds",
        "codex-reviewer@this-mac",
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
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
    },
    {
      argv: [
        "unpair",
        "--from",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
    },
    {
      argv: [
        "pair",
        "--from",
        "grok-builder@this-mac",
        "--to",
        "dsh-reviewer@this-mac",
      ],
      env: {},
    },
    {
      argv: [
        "unpair",
        "--from",
        "codex-misleading@this-mac",
        "--to",
        "claude-misleading@this-mac",
      ],
      env: {},
    },
    {
      argv: [
        "send",
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
        "send",
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
        "send",
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
    assert.equal(result.code, gatewayCliExitCodes.ok, current.argv.join(" "));
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      result?: {
        deliveryToken?: string;
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
      current.argv[0] === "send" ||
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
    {
      alias: "codex-next@this-mac",
      threadId: THREAD_ID,
      hostId: "this-mac",
      busyPolicy: "queue",
      succeedsAlias: "codex-reviewer@this-mac",
    },
  ]);
  assert.deepEqual(unregisters, [
    { alias: "codex-reviewer@this-mac", threadId: THREAD_ID },
  ]);
  assert.deepEqual(selected, ["advisor@this-mac", CLAUDE_SESSION_ID]);
  assert.deepEqual(unselected, ["advisor@this-mac"]);
  assert.deepEqual(pairs, [
    {
      aliases: ["advisor@this-mac", "codex-reviewer@this-mac"],
    },
    {
      aliases: ["grok-builder@this-mac", "dsh-reviewer@this-mac"],
    },
  ]);
  assert.deepEqual(unpairs, [
    {
      aliases: ["advisor@this-mac", "codex-reviewer@this-mac"],
    },
    {
      aliases: ["codex-misleading@this-mac", "claude-misleading@this-mac"],
    },
  ]);
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
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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

test("genuine control-version mismatches name version skew and client recovery", async () => {
  const expected = {
    en:
      "[embassy] gateway unavailable.\n[embassy] rebuild or repoint this client to the broker's Embassy installation, then retry.\n",
    "zh-CN":
      "[embassy] 网关不可用。\n[embassy] 请重新构建客户端，或将其重新指向网关进程所使用的 Embassy 安装，然后重试。\n",
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
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => {
        throw new GatewayControlTransportError(
          "CONTROL_VERSION_MISMATCH",
          "private skew detail",
        );
      },
    });

    assert.equal(code, gatewayCliExitCodes.unavailable);
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: false,
      command: "health",
      error: {
        code: "CONTROL_VERSION_MISMATCH",
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

test("connect denial and invalid responses print their distinct honest remedies", async () => {
  const hints = {
    en: {
      CONTROL_CONNECT_DENIED: "[embassy] the broker may be running, but this process cannot connect; grant this task write access to the gateway state directory, then retry. Do not start a second broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.\n",
      CONTROL_INVALID_RESPONSE: "[embassy] if either Embassy installation changed recently, rebuild or repoint this client to the broker's installation; otherwise restart the broker, then retry.\n",
    },
    "zh-CN": {
      CONTROL_CONNECT_DENIED: "[embassy] 网关进程可能仍在运行，但当前进程无权连接；请授予此任务对网关状态目录的写入权限，然后重试。请勿启动第二个网关进程。如果本应已有访问权限，请确认 EMBASSY_STATE_DIR 指向此用户自己的状态目录。\n",
      CONTROL_INVALID_RESPONSE: "[embassy] 如果任一 Embassy 安装近期发生变化，请重新构建客户端或将其重新指向网关进程所用的安装；否则请重启网关进程，然后重试。\n",
    },
  } as const;
  for (const locale of ["en", "zh-CN"] as const) for (const code of
    ["CONTROL_CONNECT_DENIED", "CONTROL_INVALID_RESPONSE"] as const) {
    const stdout = capture(), stderr = capture();
    await runGatewayCli(["health", "--lang", locale], { env: {}, stdout, stderr,
      loadConfig: () => ({ stateDir: "/private/fake-state", controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], stallNoticeMs: 30_000,
        steeringEnabled: true, inboundMode: "paired", limits: {} as never }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => { throw new GatewayControlTransportError(code, "private detail"); } });
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, code);
    assert.match(stderr.chunks.join(""), new RegExp(hints[locale][code].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (code === "CONTROL_CONNECT_DENIED") assert.doesNotMatch(stderr.chunks.join(""), /embassy serve/);
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
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
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
        return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result };
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
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async () => {
        attempts += 1;
        return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result };
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
          allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
          stallNoticeMs: 30_000,
          steeringEnabled: true,
          inboundMode: "paired",
          limits: {} as never,
        }),
        validateControlSocket: async () => undefined,
        sendRequest: (async () => {
          attempts += 1;
          return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result };
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
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
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
          protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
    "[embassy] delivery token not recognized; it may have expired or left bounded retention.\n",
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
          protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
      "send",
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
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
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
    command: "send",
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
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        inboundMode: "paired",
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async () => ({
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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

test("doctor returns normalized conditions while registration stays record-only", async () => {
  const config = {
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
    inboundMode: "paired" as const,
    limits: {} as never,
  };
  const snapshot = (condition: "split_brain" | "orphaned") => ({
    ...emptySnapshot(),
    connectors: [{
      provider: "codex" as const,
      host: "this-mac",
      health: "degraded" as const,
      protocol: "codex-app-server",
      protocolVersion: "0.147.0",
      codexDoctor: { conditions: [condition] },
    }],
  });

  const doctorStdout = capture();
  assert.equal(await runGatewayCli(["doctor"], {
    env: {},
    stdin: input(),
    stdout: doctorStdout,
    stderr: capture(),
    loadConfig: () => config,
    validateControlSocket: async () => undefined,
    sendRequest: (async () => ({
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      ok: true,
      result: snapshot("split_brain"),
    })) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  }), gatewayCliExitCodes.ok);
  assert.deepEqual(JSON.parse(doctorStdout.chunks.join("")), {
    ok: true,
    command: "doctor",
    result: { conditions: ["split_brain"] },
  });

  const expected = {
    en: "[embassy] gateway rejected the request.\n",
    "zh-CN": "[embassy] 网关拒绝了该请求。\n",
  } as const;
  for (const locale of ["en", "zh-CN"] as const) {
    let calls = 0;
    const stderr = capture();
    const code = await runGatewayCli([
      "register-codex",
      "--alias",
      "codex-reviewer@this-mac",
      "--lang",
      locale,
    ], {
      env: { CODEX_THREAD_ID: THREAD_ID },
      stdin: input(),
      stdout: capture(),
      stderr,
      loadConfig: () => config,
      validateControlSocket: async () => undefined,
      sendRequest: (async () => {
        calls += 1;
        return {
          protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
          ok: true,
          result: { accepted: false, code: "rejected" },
        };
      }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    });
    assert.equal(code, gatewayCliExitCodes.rejected);
    assert.equal(calls, 1);
    assert.equal(stderr.chunks.join(""), expected[locale]);
    assert.doesNotMatch(stderr.chunks.join(""), /App Server|\/usr\/bin\/open/u);
  }
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
        "send",
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
          allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
          stallNoticeMs: 30_000,
          steeringEnabled: true,
          inboundMode: "paired",
          limits: {} as never,
        }),
        validateControlSocket: async () => undefined,
        sendRequest: (async () => ({
          protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
      command: "send",
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
        "pair",
        "--claude",
        "advisor@this-mac",
        "--to",
        "codex-reviewer@this-mac",
      ],
      env: { CODEX_THREAD_ID: THREAD_ID },
      code: "INVALID_ARGUMENTS",
    },
    {
      argv: [
        "send",
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
        "send",
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
        "send",
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
        "send",
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
        "send",
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

test("peer-stdio attests the private control socket before opening the protocol", async () => {
  let requested = false, opened = false;
  const code = await runGatewayCli(["peer-stdio"], {
    env: {}, stdout: capture(), stderr: capture(),
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["studio", "m5dev"], hostId: "studio", peerNodes: ["m5dev"], steeringEnabled: true,
      inboundMode: "paired", stallNoticeMs: 2_500, limits: {} as never }),
    loadNodeInventory: async () => ({ host: "studio", nodes: ["m5dev"] }),
    validateControlSocket: async () => { throw new Error("unsafe socket"); },
    sendRequest: async () => { requested = true; throw new Error("must not send"); },
    runPeerStdio: () => { opened = true; return { done: Promise.resolve(), close: () => undefined }; },
  });
  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.equal(requested, false);
  assert.equal(opened, false);
});

test("peer-stdio sources initialization authority from the running broker", async () => {
  // The helper's fresh nodes.json is not enough: the running broker owns peer authority.
  let handler: Parameters<NonNullable<GatewayCliDependencies["runPeerStdio"]>>[0] | undefined;
  const code = await runGatewayCli(["peer-stdio"], {
    env: {}, stdout: capture(), stderr: capture(),
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["m5dev", "this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true,
      inboundMode: "paired", stallNoticeMs: 2_500, limits: {} as never }),
    loadNodeInventory: async () => ({ host: "m5dev", nodes: ["this-mac"] }),
    validateControlSocket: async () => undefined,
    sendRequest: async () => ({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: false,
      error: { code: "HANDLER_FAILURE", message: "The gateway could not complete the control request." } }),
    runPeerStdio: (options) => { handler = options; return { done: Promise.resolve(), close: () => undefined }; },
  });
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.ok(handler);
  await assert.rejects(Promise.resolve(handler.handlers.initialize({ protocolVersion: 1, host: "this-mac" })),
    (error: unknown) => error instanceof PeerHandlerError && error.detail.code === -32000 &&
      error.detail.message === "Local broker refused peer authority");
});

test("peer-stdio consumes its initialization catalog once, then returns to broker authority", async () => {
  let handler: Parameters<NonNullable<GatewayCliDependencies["runPeerStdio"]>>[0] | undefined, requests = 0;
  const catalog = { revision: 1, complete: true, truncated: false, generatedAt: "2026-08-17T12:00:00.000Z",
    health: "healthy", connectors: [], routes: [], consentEdges: [], alerts: [] } as const;
  const code = await runGatewayCli(["peer-stdio"], {
    env: {}, stdout: capture(), stderr: capture(),
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["m5dev", "this-mac"], hostId: "m5dev", peerNodes: ["this-mac"], steeringEnabled: true,
      inboundMode: "paired", stallNoticeMs: 2_500, limits: {} as never }),
    loadNodeInventory: async () => ({ host: "m5dev", nodes: ["this-mac"] }),
    validateControlSocket: async () => undefined,
    sendRequest: (async () => { requests += 1; return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: catalog }; }) as
      NonNullable<GatewayCliDependencies["sendRequest"]>,
    runPeerStdio: (options) => { handler = options; return { done: Promise.resolve(), close: () => undefined }; },
  });
  assert.equal(code, gatewayCliExitCodes.ok); assert.ok(handler);
  await handler.handlers.initialize({ protocolVersion: 1, host: "this-mac" });
  assert.equal(requests, 1);
  assert.deepEqual(await handler.handlers.catalog(), catalog); assert.equal(requests, 1);
  assert.deepEqual(await handler.handlers.catalog(), catalog); assert.equal(requests, 2);
});

test("pair and unpair preserve cross-host aliases and owner authority", async () => {
  for (const command of ["pair", "unpair"] as const) {
    const stdout = capture(), stderr = capture(); let request: unknown;
    const code = await runGatewayCli([command, "--from", "advisor@studio", "--to", "codex-main@m5dev"], {
      env: {}, stdout, stderr, loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
        allowedHosts: ["studio", "m5dev"], hostId: "studio", peerNodes: ["m5dev"], steeringEnabled: true,
        inboundMode: "paired", stallNoticeMs: 2_500, limits: {} as never }), validateControlSocket: async () => undefined,
      sendRequest: ((input: { request: unknown }) => { request = input.request; return Promise.resolve({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true,
        result: { accepted: false, code: "conflict", ownerHost: "m5dev" } }); }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    });
    assert.equal(code, gatewayCliExitCodes.rejected);
    assert.deepEqual(request, { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: command,
      params: { aliases: ["advisor@studio", "codex-main@m5dev"] } });
    assert.equal((JSON.parse(stdout.chunks.join("")) as { result: { ownerHost: string } }).result.ownerHost, "m5dev");
    assert.match(stderr.chunks.join(""), /gateway rejected/);
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
      removeCodexRegistration: () => ({ accepted: true, code: "ok" }),
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
      send: () => ({
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
      registerPeer: () => ({ accepted: true, code: "ok", token: PEER_TOKEN }),
      unregisterPeer: () => ({ accepted: true, code: "ok" }),
      awaitPeer: () => ({ state: "timeout" }),
      peerReceipt: () => ({ accepted: true, code: "ok" }),
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
    "[embassy] gateway state directory or socket has unexpected permissions or ownership. Verify the exact path, owner, and modes before retrying.\n",
  );
  assert.doesNotMatch(result.stdout, new RegExp(state.root.replaceAll("/", "\\/")));
});

test("the unwrapped CLI reports an inaccessible inventory path as denied", async (t) => {
  const state = await privateState();
  const server = await startGatewayControlServer({ stateDir: state.stateDir, socketPath: state.socketPath,
    handlers: { health: () => ({ status: "ok", revision: 1 }) } as GatewayControlHandlers });
  t.after(async () => await server.close());
  const canonicalStateDir = await realpath(state.stateDir);
  const actual = async (argv: string[] = ["health"]) => {
    const stdout = capture(), stderr = capture();
    const code = await runGatewayCliBase(argv, {
      env: { EMBASSY_STATE_DIR: canonicalStateDir }, stdin: input(), stdout, stderr,
    });
    return { code, stdout: stdout.chunks.join(""), stderr: stderr.chunks.join("") };
  };
  const baseline = await actual();
  assert.equal(baseline.code, gatewayCliExitCodes.ok, JSON.stringify(baseline));
  await chmod(state.root, 0o000);
  try {
    const result = await actual();
    assert.equal(result.code, gatewayCliExitCodes.unavailable);
    assert.equal(JSON.parse(result.stdout).error.code, "CONTROL_CONNECT_DENIED");
    assert.match(result.stderr, /grant this task write access/);
    assert.match(result.stderr, /EMBASSY_STATE_DIR/);
    assert.doesNotMatch(result.stderr, /embassy serve/);
    for (const [locale, hint] of [["en", "local policy denied access to the gateway state directory; grant this process access, then retry starting the broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory."],
      ["zh-CN", "本地策略拒绝访问网关状态目录；请授予此进程访问权限，然后重新尝试启动网关。如果本应已有访问权限，请确认 EMBASSY_STATE_DIR 指向此用户自己的状态目录。"]] as const) {
      const serve = await actual(["serve", "--lang", locale]);
      assert.equal(serve.code, gatewayCliExitCodes.unavailable);
      assert.match(serve.stderr, new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(serve.stderr, /broker may be running|网关进程可能仍在运行|second broker|第二个网关/);
    }
  } finally { await chmod(state.root, 0o700); }
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
        "send",
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

test("unsupported and corrupt private state print the localized reset instruction", async () => {
  const codes = ["GATEWAY_STATE_SCHEMA_UNSUPPORTED", "CORRUPT_GATEWAY_STATE"] as const;
  const locales = [
    {
      env: {},
      rejection: "request rejected.",
      hint:
        "state reset required; follow docs/CONFIGURATION.md#private-state-reset. Resetting abandons unsettled work. To check for unsettled work after upgrading, temporarily use Embassy 1.9.x before resetting.",
    },
    {
      env: { EMBASSY_LOCALE: "zh-CN" },
      rejection: "请求被拒绝。",
      hint:
        "必须重置状态；请按照 docs/CONFIGURATION.zh-CN.md#私有状态重置 操作。重置会放弃所有未结算工作。升级后如需检查未结算工作，请在重置前暂时使用 Embassy 1.9.x。",
    },
  ] as const;
  for (const code of codes) {
    for (const locale of locales) {
      const stdout = capture();
      const stderr = capture();
      const exitCode = await runGatewayCli(["serve"], {
        env: locale.env,
        stdout,
        stderr,
        runServer: async () => {
          throw new BridgeError(code, "private loader detail must not render");
        },
      });
      assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
      assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
        ok: false,
        command: "serve",
        error: { code, ambiguous: false, retryable: false },
      });
      assert.equal(
        stderr.chunks.join(""),
        `[embassy] ${locale.rejection}\n[embassy] ${locale.hint}\n`,
      );
      assert.doesNotMatch(stderr.chunks.join(""), /private loader detail/u);
    }
  }
});

test("missing mandatory inventory prints its exact one-line fix in both locales", async () => {
  const locales = [["en", "request rejected.", 'at ~/.local/state/agent-embassy, create the directory as mode-0700, replace <host> with your chosen lowercase host in exactly {"version":1,"host":"<host>","nodes":[]}, save it there as mode-0600 nodes.json, then run embassy serve again.'],
    ["zh-CN", "请求被拒绝。", '请在 ~/.local/state/agent-embassy 将该目录创建为 mode-0700，把 {"version":1,"host":"<host>","nodes":[]} 中的 <host> 替换为所选的小写主机名，并在该目录中保存为 mode-0600 的 nodes.json，然后再次运行 embassy serve。'],
  ] as const;
  for (const [locale, rejection, hint] of locales) {
    const stdout = capture(), stderr = capture();
    const code = await runGatewayCli(["serve", "--lang", locale], { stdout, stderr,
      runServer: async () => { throw new BridgeError("GATEWAY_NODE_INVENTORY_REQUIRED", "private detail"); } });
    assert.equal(code, gatewayCliExitCodes.invalidInput); assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "GATEWAY_NODE_INVENTORY_REQUIRED");
    assert.equal(stderr.chunks.join(""), `[embassy] ${rejection}\n[embassy] ${hint}\n`);
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
  assert.equal(packageJson.version, "2.0.1");
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
