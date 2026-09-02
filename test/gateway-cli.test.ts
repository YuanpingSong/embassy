import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
import { ensureGatewayNodeInventoryFile, loadGatewayNodeInventory } from "../src/gateway/federation-nodes.js";
import type { GatewayInstanceLease } from "../src/gateway/instance-lease.js";
import { runGatewayServer as runGatewayServerBase } from "../src/gateway/server.js";
import { GatewayStore } from "../src/gateway/store.js";
import { PeerHandlerError } from "../src/gateway/peer-stdio.js";
import { SERVICE_AGENT_LABEL } from "../src/gateway/service-agent.js";

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
const CALLER_IDENTITY_CONFLICT_HINT =
  "[embassy] both agent identities were inherited; rerun this Codex-side call with env -u CLAUDE_CODE_MESSAGING_SOCKET, or this Claude-side call with env -u CODEX_THREAD_ID\n";
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

test("bare invocation and help flags print usage without side effects", async () => {
  const cases = [
    { argv: [] as string[], env: {}, expected: /Usage:/ },
    { argv: ["-h"], env: {}, expected: /Rescan for Claude sessions/ },
    // There is no locale switch; inherited locale environment is inert.
    {
      argv: ["--help"],
      env: { EMBASSY_LOCALE: "zh-CN", LANG: "zh_CN.UTF-8" },
      expected: /^ {2}embassy <command> \[options\]$/m,
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
    assert.match(help, /^ {2}refresh {2,}\S/m);
    assert.match(help, /wait-delivery/);
    assert.doesNotMatch(help, /untrack|--track|--idle-minutes/);
    assert.match(help, /register-peer/);
    assert.match(help, /unregister-peer/);
    assert.match(help, /--token-stdin/);
    assert.doesNotMatch(help, /select-claude|unselect-claude|\bpair\b|unpair|--inbound/);
    assert.doesNotMatch(help, /compat-(?:check|certify)|--with-turn/);
    assert.doesNotMatch(help, /dashboard/i);
    assert.doesNotMatch(help, /--lang|zh-CN/);
    assert.equal(stderr.chunks.join(""), "");
  }
});

test("removed compatibility commands fail before configuration or control work", async () => {
  for (const command of ["compat-check", "compat-certify", "send-to-claude", "send-to-codex", "untrack",
    "select-claude", "unselect-claude", "pair", "unpair"]) {
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

test("peer registration emits its credential once and authenticated lifecycle never echoes it", async () => {
  const config = { stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true,     stallNoticeMs: 30_000, limits: {} as never };
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
      stallNoticeMs: 30_000, limits: {} as never }),
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
      allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true, stallNoticeMs: 30_000, limits: {} as never }),
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
      allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], steeringEnabled: true, stallNoticeMs: 30_000, limits: {} as never }),
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
  const sendsToClaude: ValidatedSendParams[] = [];
  const sendsToCodex: ValidatedSendParams[] = [];
  const replies: ReplyParams[] = [];
  const deliveryStatuses: string[] = [];
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
    refreshDiscovery: () => ({
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
    {
      argv: ["delivery-status", "--token", DELIVERY_TOKEN],
      env: BOTH_IDENTITIES,
    },
    {
      argv: ["wait-delivery", "--token", DELIVERY_TOKEN],
      env: BOTH_IDENTITIES,
    },
    { argv: ["refresh"], env: BOTH_IDENTITIES },
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
    const result = await invoke(state.stateDir, current.argv, {
      ...current,
      env: { ...current.env },
    });
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

test("the removed --lang option is an argument error and locale environment is inert", async () => {
  const fakeConfig = () => ({
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
        limits: {} as never,
  });
  // Locale-shaped environment (including the removed EMBASSY_LOCALE) never
  // changes stderr and never fails an invocation on its own.
  const inertEnvironments = [
    {},
    { EMBASSY_LOCALE: "" },
    { EMBASSY_LOCALE: "zh-CN" },
    { EMBASSY_LOCALE: "unsupported" },
    { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", LANGUAGE: "zh_CN:zh" },
  ] as const;
  for (const env of inertEnvironments) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(["health", "--unexpected"], {
      env,
      stdout,
      stderr,
      loadConfig: () => {
        throw new Error("argument failure must precede configuration");
      },
      validateControlSocket: async () => {
        throw new Error("argument failure must precede socket work");
      },
      sendRequest: async () => {
        throw new Error("argument failure must precede a request");
      },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput, JSON.stringify(env));
    assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
      ok: false,
      command: "health",
      error: {
        code: "INVALID_ARGUMENTS",
        ambiguous: false,
        retryable: false,
      },
    });
    assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n");
  }
  for (const env of inertEnvironments) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(["health"], {
      env,
      stdout,
      stderr,
      loadConfig: fakeConfig,
      validateControlSocket: async () => undefined,
      sendRequest: (async () => ({
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        ok: true,
        result: { status: "ok" },
      })) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    });
    assert.equal(code, gatewayCliExitCodes.ok, JSON.stringify(env));
    assert.equal(stderr.chunks.join(""), "");
  }

  const removed = [
    ["--lang"],
    ["--lang", "en"],
    ["--lang", "zh-CN"],
    ["--lang=en"],
    ["--track"],
    ["--idle-minutes", "5"],
  ] as const;
  for (const command of gatewayCliCommands) {
    for (const suffix of removed) {
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

  // For send and reply the loop above is satisfied by the missing required
  // options alone. Pin the removed flags against otherwise-valid invocations,
  // so a reintroduced --track or --idle-minutes cannot pass unnoticed.
  const otherwiseValid = [
    ["send", "--from", "codex-reviewer@this-mac", "--to", "advisor@this-mac", "--track"],
    ["send", "--from", "codex-reviewer@this-mac", "--to", "advisor@this-mac", "--idle-minutes", "5"],
    ["reply", "--conversation", CONVERSATION_ID, "--alias", "advisor@this-mac", "--track"],
    ["reply", "--conversation", CONVERSATION_ID, "--alias", "advisor@this-mac", "--idle-minutes", "5"],
  ] as const;
  for (const argv of otherwiseValid) {
    const stdout = capture();
    const stderr = capture();
    let worked = false;
    const code = await runGatewayCli(argv, {
      env: { CODEX_THREAD_ID: THREAD_ID },
      stdin: input(SECRET_BODY),
      stdout,
      stderr,
      loadConfig: () => { worked = true; throw new Error("must not load configuration"); },
      validateControlSocket: async () => { worked = true; },
      sendRequest: async () => { worked = true; throw new Error("must not send"); },
      runServer: async () => { worked = true; },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput, argv.join(" "));
    assert.equal(worked, false, argv.join(" "));
    assert.equal(
      (JSON.parse(stdout.chunks.join("")) as { error: { code: string } }).error.code,
      "INVALID_ARGUMENTS",
      argv.join(" "),
    );
    assert.equal(stdout.chunks.join("").includes(SECRET_BODY), false);
  }
});

test("all five stderr categories print fixed one-line summaries without private detail", async () => {
  const fakeConfig = () => ({
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
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
      argv: ["refresh"],
      code: gatewayCliExitCodes.rejected,
      sendRequest: async () => ({
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        ok: true as const,
        result: { accepted: false as const, code: "unavailable", revision: 4 },
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
    input: "[embassy] request rejected.\n",
    decision: "[embassy] gateway rejected the request.\n",
    unavailable: "[embassy] gateway unavailable.\n",
    ambiguous:
      "[embassy] outcome ambiguous; do not retry automatically.\n",
    failure: "[embassy] command failed.\n",
  } as const;

  for (const scenario of scenarios) {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli([...scenario.argv], {
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
    });
    assert.equal(code, scenario.code, scenario.kind);
    assert.equal(stderr.chunks.join(""), expected[scenario.kind]);
    assert.doesNotMatch(stdout.chunks.join(""), /private/);
  }
});

test("genuine control-version mismatches name version skew and client recovery", async () => {
  const expected =
    "[embassy] gateway unavailable.\n[embassy] rebuild or repoint this client to the broker's Embassy installation, then retry.\n";

  {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(["health"], {
      env: {},
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
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
    assert.equal(stderr.chunks.join(""), expected);
    assert.doesNotMatch(
      `${stdout.chunks.join("")} ${stderr.chunks.join("")}`,
      /private skew detail/,
    );
  }
});

test("connect denial and invalid responses print their distinct honest remedies", async () => {
  const hints = {
    CONTROL_CONNECT_DENIED: "[embassy] the broker may be running, but this process cannot connect; grant this task write access to the gateway state directory, then retry. Do not start a second broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.\n",
    CONTROL_INVALID_RESPONSE: "[embassy] if either Embassy installation changed recently, rebuild or repoint this client to the broker's installation; otherwise restart the broker, then retry.\n",
  } as const;
  for (const code of ["CONTROL_CONNECT_DENIED", "CONTROL_INVALID_RESPONSE"] as const) {
    const stdout = capture(), stderr = capture();
    await runGatewayCli(["health"], { env: {}, stdout, stderr,
      loadConfig: () => ({ stateDir: "/private/fake-state", controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], stallNoticeMs: 30_000,
        steeringEnabled: true, limits: {} as never }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => { throw new GatewayControlTransportError(code, "private detail"); } });
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, code);
    assert.match(stderr.chunks.join(""), new RegExp(hints[code].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (code === "CONTROL_CONNECT_DENIED") assert.doesNotMatch(stderr.chunks.join(""), /embassy serve/);
  }
});

test("every no-broker transport code points at embassy service install and names the state directory", async () => {
  for (const code of ["CONTROL_SOCKET_MISSING", "CONTROL_LISTENER_UNAVAILABLE"] as const) {
    const stdout = capture(), stderr = capture();
    const exitCode = await runGatewayCli(["status"], {
      env: { EMBASSY_STATE_DIR: "/private/fake-state" }, stdout, stderr,
    loadConfig: () => ({ stateDir: "/private/fake-state", controlSocketPath: "/private/fake-state/control.sock",
      allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [], stallNoticeMs: 30_000,
      steeringEnabled: true, inboundMode: "paired", limits: {} as never }),
      validateControlSocket: async () => undefined,
      sendRequest: async () => {
        throw new GatewayControlTransportError(code, "private detail");
      },
    });
    assert.equal(exitCode, gatewayCliExitCodes.unavailable, code);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, code);
    assert.equal(
      stderr.chunks.join(""),
      "[embassy] gateway unavailable.\n[embassy] No broker is running (state dir /private/fake-state). Run `embassy service install` once, or `embassy serve` in a terminal — or verify EMBASSY_STATE_DIR is not scrubbed or misdirected (for example by a sandboxed task's HOME).\n",
    );
    assert.doesNotMatch(stderr.chunks.join(""), /private detail/);
  }
});

test("a state directory with no socket prints the same hint through the real socket check", async () => {
  // No validateControlSocket stub. This is the path a real caller takes: the
  // socket check maps a missing socket to CONTROL_SOCKET_UNAVAILABLE before
  // any transport runs, so CONTROL_SOCKET_MISSING alone would never fire.
  const stateDir = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-no-broker-"));
  roots.add(stateDir);
  await chmod(stateDir, 0o700);
  for (const command of ["status", "health"] as const) {
    const stdout = capture(), stderr = capture();
    const code = await runGatewayCli([command], {
      env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
      sendRequest: async () => { throw new Error("must not reach the transport"); },
    });
    assert.equal(code, gatewayCliExitCodes.unavailable, command);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "CONTROL_SOCKET_UNAVAILABLE", command);
    assert.equal(
      stderr.chunks.join(""),
      `[embassy] gateway unavailable.\n[embassy] No broker is running (state dir ${stateDir}). Run \`embassy service install\` once, or \`embassy serve\` in a terminal — or verify EMBASSY_STATE_DIR is not scrubbed or misdirected (for example by a sandboxed task's HOME).\n`,
      command,
    );
  }
});

test("register-codex against a broker's real durable host passes CLI validation (emb-106 F9)", async (t) => {
  // The broker's own first-boot write, reproduced directly rather than
  // through a full runGatewayServer boot (covered end to end in
  // gateway-server.test.ts): a real nodes.json this CLI call reads for
  // itself, through the unmocked loader — not the file's TEST_INVENTORY
  // stand-in.
  const stateDir = await realpath(await mkdtemp("/tmp/embassy-cli-durable-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, "nodes.json"), '{"version":1,"host":"injected-host","nodes":[]}\n', { mode: 0o600 });

  const stdout = capture(), stderr = capture();
  let sentRequest: unknown;
  const exitCode = await runGatewayCliBase(["register-codex", "--alias", "codex-x@injected-host"], {
    env: { EMBASSY_STATE_DIR: stateDir, CODEX_THREAD_ID: THREAD_ID },
    stdout, stderr,
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ request }: { request: unknown }) => {
      sentRequest = request;
      return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { accepted: true, code: "ok" } };
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  });
  assert.equal(stderr.chunks.join(""), "");
  assert.equal(exitCode, gatewayCliExitCodes.ok);
  assert.ok(sentRequest);

  // The mismatch hint still fires for a alias not naming that same host.
  const stdout2 = capture(), stderr2 = capture();
  const mismatch = await runGatewayCliBase(["register-codex", "--alias", "codex-x@wrong-host"], {
    env: { EMBASSY_STATE_DIR: stateDir, CODEX_THREAD_ID: THREAD_ID }, stdout: stdout2, stderr: stderr2,
  });
  assert.equal(mismatch, gatewayCliExitCodes.invalidInput);
  assert.match(
    stderr2.chunks.join(""),
    new RegExp(`@injected-host \\(from ${stateDir}/nodes\\.json\\); found @wrong-host`),
  );
});

const inertLease = (): GatewayInstanceLease => ({
  lost: new Promise<void>(() => undefined),
  isLost: () => false,
  close: async () => undefined,
});

// A refused boot's BridgeError message never reaches a terminal by design, so
// these run the real store's real refusals through `embassy serve` and assert
// what an operator actually sees. Only the host-wide lease is stubbed, so
// nothing outside the temporary state directory is touched.
test("a refused serve prints the remedy for each state-directory refusal it can hit", async (t) => {
  const marker = "agent-embassy-state-v1\n";
  const lock = (owner: Readonly<Record<string, unknown>>): string =>
    `${JSON.stringify({ schemaVersion: 1, token: "00000000-0000-4000-8000-00000000a11e", ...owner })}\n`;
  const cases = [
    {
      name: "a live pid holds the lock",
      plant: async (dir: string) => {
        await writeFile(path.join(dir, ".agent-embassy-state"), marker, { mode: 0o600 });
        await writeFile(path.join(dir, ".gateway-controller.lock"),
          lock({ pid: 4242, hostname: "the-old-name.local" }), { mode: 0o600 });
      },
      alive: true,
      exitCode: gatewayCliExitCodes.unavailable,
      code: "GATEWAY_STATE_IN_USE",
      hint: (dir: string) =>
        `another broker may own ${dir}: if \`embassy serve\` is not running anywhere, the lock ${dir}/.gateway-controller.lock is stale (recorded host the-old-name.local, pid 4242) — remove it and start again.`,
      kind: "[embassy] gateway unavailable.\n",
    },
    {
      name: "a live pid under a machine name that cannot be represented",
      plant: async (dir: string) => {
        await writeFile(path.join(dir, ".agent-embassy-state"), marker, { mode: 0o600 });
        await writeFile(path.join(dir, ".gateway-controller.lock"),
          lock({ pid: 4242, hostname: "a name with spaces" }), { mode: 0o600 });
      },
      alive: true,
      exitCode: gatewayCliExitCodes.unavailable,
      code: "GATEWAY_STATE_IN_USE",
      hint: (dir: string) =>
        `another broker may own ${dir}: if \`embassy serve\` is not running anywhere, the lock ${dir}/.gateway-controller.lock is stale — remove it and start again.`,
      kind: "[embassy] gateway unavailable.\n",
    },
    {
      name: "the lock cannot be read as a record",
      plant: async (dir: string) => {
        await writeFile(path.join(dir, ".agent-embassy-state"), marker, { mode: 0o600 });
        await writeFile(path.join(dir, ".gateway-controller.lock"), "{not json at all\n", { mode: 0o600 });
      },
      alive: true,
      exitCode: gatewayCliExitCodes.invalidInput,
      code: "GATEWAY_STATE_LOCK_UNVERIFIED",
      hint: (dir: string) =>
        `the lock ${dir}/.gateway-controller.lock cannot be read as a controller record; if \`embassy serve\` is not running anywhere, remove that file and start again.`,
      kind: "[embassy] request rejected.\n",
    },
    {
      name: "nodes.json changed under the starting broker",
      plant: async (dir: string) => {
        await writeFile(path.join(dir, "nodes.json"), '{"version":1,"host":"other-host","nodes":[]}\n', { mode: 0o600 });
      },
      alive: false,
      exitCode: gatewayCliExitCodes.invalidInput,
      code: "GATEWAY_NODE_INVENTORY_CHANGED",
      hint: (dir: string) => `nodes.json at ${dir} changed while the broker was starting; start again.`,
      kind: "[embassy] request rejected.\n",
    },
  ] as const;

  for (const current of cases) {
    const stateDir = await realpath(await mkdtemp("/tmp/embassy-cli-serve-"));
    await chmod(stateDir, 0o700);
    t.after(async () => rm(stateDir, { recursive: true, force: true }));
    await current.plant(stateDir);

    const stdout = capture(), stderr = capture();
    const exitCode = await runGatewayCliBase(["serve"], {
      env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
      runServer: (options) => runGatewayServerBase(options, {
        loadNodeInventory: async () => ({ host: "injected-host", nodes: [] }),
        acquireInstanceLease: async () => inertLease(),
        createStore: (config) => new GatewayStore(config, { isProcessAlive: () => current.alive }),
        createService: () => { throw new Error("startup must refuse before any service is built"); },
      }),
    });
    assert.equal(exitCode, current.exitCode, current.name);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, current.code, current.name);
    assert.equal(stderr.chunks.join(""), `${current.kind}[embassy] ${current.hint(stateDir)}\n`, current.name);
  }
});

test("a first-boot write that fails tells the operator which of the two outcomes happened", async (t) => {
  // The distinction the operator acts on: nothing was written, or the file is
  // there and only the directory entry never reached the disk.
  const full = () => Object.assign(new Error("simulated device full"), { code: "ENOSPC" });
  const cases = [
    {
      name: "nothing was written",
      open: () => (async () => { throw full(); }) as never,
      hint: (dir: string) => `nodes.json could not be written at ${dir} (disk full, read-only, or quota?)`,
    },
    {
      name: "written, but the directory could not be synced",
      open: (dir: string) => (async (target: unknown, ...rest: unknown[]) => {
        if (target === dir) throw Object.assign(new Error("simulated io error"), { code: "EIO" });
        return (await import("node:fs/promises")).open(target as string, rest[0] as number, rest[1] as number);
      }) as never,
      hint: (dir: string) =>
        `nodes.json was written at ${dir} but the directory could not be synced; start again and check the volume`,
    },
  ] as const;

  for (const current of cases) {
    const stateDir = await realpath(await mkdtemp("/tmp/embassy-cli-write-"));
    await chmod(stateDir, 0o700);
    t.after(async () => rm(stateDir, { recursive: true, force: true }));
    const stdout = capture(), stderr = capture();
    const exitCode = await runGatewayCliBase(["serve"], {
      env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
      runServer: (options) => runGatewayServerBase(options, {
        loadNodeInventory: async () => ({ host: "injected-host", nodes: [] }),
        acquireInstanceLease: async () => inertLease(),
        ensureNodeInventoryFile: async (dir, host) =>
          ensureGatewayNodeInventoryFile(dir, host, { open: current.open(stateDir) }),
        createService: () => { throw new Error("startup must refuse before any service is built"); },
      }),
    });
    assert.equal(exitCode, gatewayCliExitCodes.unavailable, current.name);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "GATEWAY_STATE_WRITE_FAILED", current.name);
    assert.equal(
      stderr.chunks.join(""),
      `[embassy] gateway unavailable.\n[embassy] ${current.hint(stateDir)}\n`,
      current.name,
    );
  }
});

test("a hint substitutes once: a value that itself looks like a placeholder is left alone", async () => {
  // A state directory literally named with braces. One pass means the {given}
  // inside the substituted path stays text instead of becoming the alias host.
  const stdout = capture(), stderr = capture();
  const exitCode = await runGatewayCliBase(["register-codex", "--alias", "codex-x@wrong-host"], {
    env: { EMBASSY_STATE_DIR: "/tmp/{given}", CODEX_THREAD_ID: THREAD_ID }, stdout, stderr,
    loadNodeInventory: async (dir) => loadGatewayNodeInventory(dir, { hostname: () => "fixture-host" }),
    sendRequest: (async () => { throw new Error("must not be called"); }) as never,
  });
  assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
  assert.equal(
    stderr.chunks.join(""),
    "[embassy] request rejected.\n[embassy] no nodes.json has been written at /tmp/{given} yet — a broker writes it on first start; until then this machine defaults to @fixture-host; found @wrong-host\n",
  );
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
  const decide = async (
    argv: readonly string[],
    result: { accepted: false; code: string },
    env: NodeJS.ProcessEnv,
  ) => {
    const stdout = capture();
    const stderr = capture();
    const code = await runGatewayCli(argv, {
      env,
      stdin: input(SECRET_BODY),
      stdout,
      stderr,
      loadConfig: () => ({
        stateDir: "/private/fake-state",
        controlSocketPath: "/private/fake-state/control.sock",
        allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
        stallNoticeMs: 30_000,
        steeringEnabled: true,
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      sendRequest: (async () => ({
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        ok: true,
        result,
      })) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    });
    return { code, stdout: stdout.chunks.join(""), stderr: stderr.chunks.join("") };
  };

  // A busy target route is a decision, not a fault: fixed rejected exit, the
  // broker's own code on stdout, one fixed line on stderr, nothing else.
  const busy = await decide(
    ["send", "--from", "codex-reviewer@this-mac", "--to", "advisor@this-mac"],
    { accepted: false, code: "busy" },
    { CODEX_THREAD_ID: THREAD_ID },
  );
  assert.equal(busy.code, gatewayCliExitCodes.rejected);
  assert.deepEqual(JSON.parse(busy.stdout), {
    ok: true,
    command: "send",
    result: { accepted: false, code: "busy" },
  });
  assert.equal(busy.stderr, "[embassy] gateway rejected the request.\n");
  assert.equal(busy.stdout.includes(SECRET_BODY), false);

  const busyReply = await decide(
    ["reply", "--conversation", CONVERSATION_ID, "--alias", "advisor@this-mac"],
    { accepted: false, code: "busy" },
    { CODEX_THREAD_ID: THREAD_ID },
  );
  assert.equal(busyReply.code, gatewayCliExitCodes.rejected);
  assert.deepEqual(JSON.parse(busyReply.stdout), {
    ok: true,
    command: "reply",
    result: { accepted: false, code: "busy" },
  });
  assert.equal(busyReply.stderr, "[embassy] gateway rejected the request.\n");

  // An unknown target is the one rejection with a remedy the operator cannot
  // guess: routes install on first send, so the fix is a rescan.
  const unknown = await decide(
    ["send", "--from", "codex-reviewer@this-mac", "--to", "advisor@this-mac"],
    { accepted: false, code: "not_found" },
    { CODEX_THREAD_ID: THREAD_ID },
  );
  assert.equal(unknown.code, gatewayCliExitCodes.rejected);
  assert.deepEqual(JSON.parse(unknown.stdout), {
    ok: true,
    command: "send",
    result: { accepted: false, code: "not_found" },
  });
  assert.equal(
    unknown.stderr,
    "[embassy] gateway rejected the request.\n" +
      "[embassy] no current route answers to that name. A Claude session is addressed by its live name: " +
      "run embassy refresh, then read embassy status for the name it has now.\n",
  );

  // The hint is bound to the unknown-target decision, never to every rejection.
  const refused = await decide(
    ["register-codex", "--alias", "codex-reviewer@this-mac"],
    { accepted: false, code: "not_found" },
    { CODEX_THREAD_ID: THREAD_ID },
  );
  assert.equal(refused.code, gatewayCliExitCodes.rejected);
  assert.equal(refused.stderr, "[embassy] gateway rejected the request.\n");
});

test("registration stays record-only and localizes the rejection", async () => {
  const config = {
    stateDir: "/private/fake-state",
    controlSocketPath: "/private/fake-state/control.sock",
    allowedHosts: ["this-mac"], hostId: "this-mac", peerNodes: [],
    stallNoticeMs: 30_000,
    steeringEnabled: true,
        limits: {} as never,
  };

  const expected = "[embassy] gateway rejected the request.\n";
  {
    let calls = 0;
    const stderr = capture();
    const code = await runGatewayCli([
      "register-codex",
      "--alias",
      "codex-reviewer@this-mac",
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
    assert.equal(stderr.chunks.join(""), expected);
    assert.doesNotMatch(stderr.chunks.join(""), /App Server|\/usr\/bin\/open/u);
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
    assert.equal(
      stderr.chunks.join(""),
      `[embassy] request rejected.\n${
        hasBothIdentities ? CALLER_IDENTITY_CONFLICT_HINT : ""
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
      stallNoticeMs: 2_500, limits: {} as never }),
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
      stallNoticeMs: 2_500, limits: {} as never }),
    loadNodeInventory: async () => ({ host: "m5dev", nodes: ["this-mac"] }),
    validateControlSocket: async () => undefined,
    sendRequest: async () => ({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: false,
      error: { code: "HANDLER_FAILURE", message: "The gateway could not complete the control request." } }),
    runPeerStdio: (options) => { handler = options; return { done: Promise.resolve(), close: () => undefined }; },
  });
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.ok(handler);
  await assert.rejects(Promise.resolve(handler.handlers.initialize({ protocolVersion: 2, host: "this-mac" })),
    (error: unknown) => error instanceof PeerHandlerError && error.detail.code === -32000 &&
      error.detail.message === "Local broker refused peer authority");
});

test("peer-stdio consumes its initialization catalog once, then returns to broker authority", async () => {
  let handler: Parameters<NonNullable<GatewayCliDependencies["runPeerStdio"]>>[0] | undefined, requests = 0;
  const catalog = { revision: 1, complete: true, truncated: false, generatedAt: "2026-08-17T12:00:00.000Z",
    health: "healthy", connectors: [], routes: [], alerts: [] } as const;
  const code = await runGatewayCli(["peer-stdio"], {
    env: {}, stdout: capture(), stderr: capture(),
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["m5dev", "this-mac"], hostId: "m5dev", peerNodes: ["this-mac"], steeringEnabled: true,
      stallNoticeMs: 2_500, limits: {} as never }),
    loadNodeInventory: async () => ({ host: "m5dev", nodes: ["this-mac"] }),
    validateControlSocket: async () => undefined,
    sendRequest: (async () => { requests += 1; return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: catalog }; }) as
      NonNullable<GatewayCliDependencies["sendRequest"]>,
    runPeerStdio: (options) => { handler = options; return { done: Promise.resolve(), close: () => undefined }; },
  });
  assert.equal(code, gatewayCliExitCodes.ok); assert.ok(handler);
  await handler.handlers.initialize({ protocolVersion: 2, host: "this-mac" });
  assert.equal(requests, 1);
  assert.deepEqual(await handler.handlers.catalog(), catalog); assert.equal(requests, 1);
  assert.deepEqual(await handler.handlers.catalog(), catalog); assert.equal(requests, 2);
});

test("send preserves cross-host aliases exactly as typed", async () => {
  const stdout = capture(), stderr = capture(); let request: unknown;
  const code = await runGatewayCli(["send", "--from", "codex-main@studio", "--to", "advisor@m5dev"], {
    env: { CODEX_THREAD_ID: THREAD_ID }, stdin: input(SECRET_BODY), stdout, stderr,
    loadConfig: () => ({ stateDir: "/private/state", controlSocketPath: "/private/state/control.sock",
      allowedHosts: ["studio", "m5dev"], hostId: "studio", peerNodes: ["m5dev"], steeringEnabled: true,
      stallNoticeMs: 2_500, limits: {} as never }), validateControlSocket: async () => undefined,
    sendRequest: ((input: { request: unknown }) => { request = input.request; return Promise.resolve({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true,
      result: { accepted: false, code: "unavailable" } }); }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
  });
  assert.equal(code, gatewayCliExitCodes.rejected);
  assert.deepEqual(request, { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "send",
    params: { fromAlias: "codex-main@studio", toAlias: "advisor@m5dev", text: SECRET_BODY,
      expectsReply: false, threadId: THREAD_ID } });
  assert.match(stderr.chunks.join(""), /gateway rejected/);
  assert.equal(stdout.chunks.join("").includes(SECRET_BODY), false);
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
    },
  });
  assert.equal(stderr.chunks.join(""), "");
  assert.equal(stdout.chunks.join("").includes(SECRET_BODY), false);
  assert.equal(stdout.chunks.join("").includes(THREAD_ID), false);
  assert.equal(stdout.chunks.join("").includes(CLAUDE_SOCKET_PATH), false);
});

test("serve takes no options at all", async () => {
  // The broker has one inbound posture: same UID, same host (or a configured
  // node), addressed by alias. There is no mode to opt out of.
  for (const argv of [
    ["serve", "--inbound", "open"],
    ["serve", "--inbound"],
    ["serve", "--inbound", "paired"],
    ["serve", "--open"],
    ["serve", "extra"],
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

test("refresh reports a failed rescan as a decision, not a client-side transport fault", async (t) => {
  const state = await privateState();
  let outcome: "fail" | "ok" = "fail";
  const server = await startGatewayControlServer({
    stateDir: state.stateDir,
    socketPath: state.socketPath,
    handlers: {
      health: () => ({ status: "ok", revision: 4 }),
      registerCodex: () => ({ accepted: true, code: "ok" }),
      unregisterCodex: () => ({ accepted: true, code: "ok" }),
      listSnapshot: () => emptySnapshot(),
      observeSnapshot: () => ({ snapshotRevision: 0, snapshot: emptySnapshot() }),
      deliveryStatus: () => ({ found: false }),
      send: () => ({ accepted: true, code: "ok", conversationId: CONVERSATION_ID, deliveryToken: DELIVERY_TOKEN }),
      reply: () => ({ accepted: true, code: "ok", conversationId: CONVERSATION_ID, deliveryToken: DELIVERY_TOKEN }),
      refreshDiscovery: () => outcome === "ok"
        ? { accepted: true, code: "ok", revision: 4 }
        : { accepted: false, code: "unavailable", revision: 4 },
      registerPeer: () => ({ accepted: true, code: "ok", token: PEER_TOKEN }),
      unregisterPeer: () => ({ accepted: true, code: "ok" }),
      awaitPeer: () => ({ state: "timeout" }),
      peerReceipt: () => ({ accepted: true, code: "ok" }),
    },
  });
  t.after(async () => await server.close());

  const failed = await invoke(state.stateDir, ["refresh"]);
  assert.equal(failed.code, gatewayCliExitCodes.rejected);
  assert.deepEqual(JSON.parse(failed.stdout), {
    ok: true,
    command: "refresh",
    result: { accepted: false, code: "unavailable", revision: 4 },
  });
  // The rejection must reach the operator as the broker's own decision code.
  // A shape the response validator refuses would instead surface as
  // CONTROL_INVALID_RESPONSE with a "rebuild or repoint this client" hint.
  assert.equal(failed.stderr, "[embassy] gateway rejected the request.\n");
  assert.doesNotMatch(failed.stderr, /rebuild or repoint|CONTROL_INVALID_RESPONSE|CONTROL_VERSION_MISMATCH/);

  outcome = "ok";
  const accepted = await invoke(state.stateDir, ["refresh"]);
  assert.equal(accepted.code, gatewayCliExitCodes.ok);
  assert.deepEqual(JSON.parse(accepted.stdout), {
    ok: true,
    command: "refresh",
    result: { accepted: true, code: "ok", revision: 4 },
  });
  assert.equal(accepted.stderr, "");
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
      listSnapshot: () => emptySnapshot(),
      observeSnapshot: () => ({
        snapshotRevision: 0,
        snapshot: emptySnapshot(),
      }),
      deliveryStatus: () => ({ found: false }),
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
      refreshDiscovery: () => ({
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
    {
      const hint = "local policy denied access to the gateway state directory; grant this process access, then retry starting the broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.";
      const serve = await actual(["serve"]);
      assert.equal(serve.code, gatewayCliExitCodes.unavailable);
      assert.match(serve.stderr, new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(serve.stderr, /broker may be running|second broker/);
    }
  } finally { await chmod(state.root, 0o700); }
});

test("oversized stdin renders its hint while generic input rejection does not", async () => {
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

test("every alias-carrying route command rejects another host's alias, naming the file it read", async (t) => {
  // Every command that names a route this machine owns, in both directions.
  // pair and select take arbitrary peer endpoints and are deliberately absent.
  const cases: readonly (readonly string[])[] = [
    ["register-codex", "--alias", "codex-x@wrong-host"],
    ["register-codex", "--alias", "codex-x@this-mac", "--succeeds", "codex-y@wrong-host"],
    ["unregister-codex", "--alias", "codex-x@wrong-host"],
    ["register-peer", "--alias", "peer-x@wrong-host"],
    ["unregister-peer", "--alias", "peer-x@wrong-host", "--token-stdin"],
    ["await", "--alias", "peer-x@wrong-host", "--token-stdin"],
  ];
  // A real nodes.json read by the real loader: the hint names the file it
  // actually read, so the assertion cannot pass against a directory that has none.
  const stateDir = await realpath(await mkdtemp("/tmp/embassy-cli-arms-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}\n', { mode: 0o600 });
  const expected =
    `[embassy] request rejected.\n[embassy] aliases on this machine end with @this-mac (from ${stateDir}/nodes.json); found @wrong-host\n`;
  for (const argv of cases) {
    const stdout = capture(), stderr = capture();
    const codexSide = argv[0]!.endsWith("-codex");
    const exitCode = await runGatewayCliBase(argv, {
      env: { EMBASSY_STATE_DIR: stateDir, ...(codexSide ? { CODEX_THREAD_ID: THREAD_ID } : {}) },
      stdin: Readable.from([Buffer.from(`${PEER_TOKEN}\n`)]),
      stdout, stderr,
      validateControlSocket: async () => { throw new Error("must not reach the socket"); },
      sendRequest: (async () => { throw new Error("must not be called"); }) as never,
    });
    assert.equal(exitCode, gatewayCliExitCodes.invalidInput, argv.join(" "));
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "INVALID_ARGUMENTS");
    assert.equal(stderr.chunks.join(""), expected, argv.join(" "));
  }
});

test("a host identity that is still the transient default says so, and where it would be recorded", async (t) => {
  // No nodes.json at this state directory: the CLI is running before any
  // broker ever booted here, so its host is provisional and the hint must
  // not point at a file that does not exist.
  const stateDir = await realpath(await mkdtemp("/tmp/embassy-cli-defaulted-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));

  const stdout = capture(), stderr = capture();
  const exitCode = await runGatewayCliBase(["register-codex", "--alias", "codex-x@wrong-host"], {
    env: { EMBASSY_STATE_DIR: stateDir, CODEX_THREAD_ID: THREAD_ID }, stdout, stderr,
    loadNodeInventory: async (dir) => loadGatewayNodeInventory(dir, { hostname: () => "fixture-host" }),
    sendRequest: (async () => { throw new Error("must not be called"); }) as never,
  });
  assert.equal(exitCode, gatewayCliExitCodes.invalidInput);
  assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "INVALID_ARGUMENTS");
  assert.equal(
    stderr.chunks.join(""),
    `[embassy] request rejected.\n[embassy] no nodes.json has been written at ${stateDir} yet — a broker writes it on first start; until then this machine defaults to @fixture-host; found @wrong-host\n`,
  );
});

test("unsupported and corrupt private state print the reset instruction", async () => {
  const codes = ["GATEWAY_STATE_SCHEMA_UNSUPPORTED", "CORRUPT_GATEWAY_STATE"] as const;
  // 2.0.x is the last line that reads pre-schema-5 state.
  const hint =
    "state reset required; follow docs/CONFIGURATION.md#private-state-reset. Resetting abandons unsettled work. To check for unsettled work after upgrading, temporarily use Embassy 2.0.x before resetting.";
  for (const code of codes) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runGatewayCli(["serve"], {
      env: {},
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
      `[embassy] request rejected.\n[embassy] ${hint}\n`,
    );
    assert.doesNotMatch(stderr.chunks.join(""), /private loader detail|1\.9\.x/u);
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

test("service without a subcommand is an argument error, before any control-socket work", async () => {
  for (const argv of [["service"], ["service", "bogus"], ["service", "install", "extra"]]) {
    const stdout = capture(), stderr = capture();
    let worked = false;
    const code = await runGatewayCli(argv, {
      env: {}, stdout, stderr,
      loadConfig: () => { worked = true; throw new Error("must not load configuration"); },
      validateControlSocket: async () => { worked = true; },
      sendRequest: async () => { worked = true; throw new Error("must not contact the gateway"); },
      runLaunchctl: async () => { worked = true; return { code: 0, stdout: "", stderr: "" }; },
    });
    assert.equal(code, gatewayCliExitCodes.invalidInput, argv.join(" "));
    assert.equal(worked, false, argv.join(" "));
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "INVALID_ARGUMENTS", argv.join(" "));
    assert.equal(stderr.chunks.join(""), "[embassy] request rejected.\n", argv.join(" "));
  }
});

/**
 * A fake launchd for the CLI-level service tests: enough state that `print`
 * answers honestly after `bootout` and `bootstrap`, so the ordering install
 * depends on is exercised rather than assumed.
 */
function cliFakeLaunchd(
  script: { loaded?: boolean; fail?: Record<string, { code: number; stdout: string; stderr: string }> } = {},
): { run: NonNullable<GatewayCliDependencies["runLaunchctl"]>; calls: string[][] } {
  const calls: string[][] = [];
  let loaded = script.loaded ?? false;
  const label = SERVICE_AGENT_LABEL;
  const run: NonNullable<GatewayCliDependencies["runLaunchctl"]> = async (args) => {
    calls.push([...args]);
    const verb = args[0] ?? "";
    const forced = script.fail?.[verb];
    if (forced !== undefined) return forced;
    switch (verb) {
      case "print":
        return loaded
          ? { code: 0, stdout: `state = running\n\tpid = 4242\n`, stderr: "" }
          : { code: 113, stdout: "", stderr: `Could not find service "${label}" in domain for login\n` };
      case "bootout": loaded = false; return { code: 0, stdout: "", stderr: "" };
      case "bootstrap": loaded = true; return { code: 0, stdout: "", stderr: "" };
      default: return { code: 0, stdout: "", stderr: "" };
    }
  };
  return { run, calls };
}

async function serviceFixture(): Promise<{ home: string; stateDir: string; plistPath: string }> {
  const temporary = await realpath(os.tmpdir());
  const home = await mkdtemp(path.join(temporary, "embassy-cli-service-"));
  await chmod(home, 0o700);
  roots.add(home);
  const stateDir = await mkdtemp(path.join(temporary, "embassy-cli-service-state-"));
  roots.add(stateDir);
  return {
    home, stateDir,
    plistPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_AGENT_LABEL}.plist`),
  };
}

/**
 * The host lease is free. The real probe spawns /usr/bin/lockf (macOS only),
 * so every CLI service test injects its answer and runs on every platform.
 */
const freeHostLease: NonNullable<GatewayCliDependencies["probeHostLease"]> =
  async () => ({ held: false });

/** Wall clock that only moves when the code under test sleeps. */
function sleepDrivenClock(): { now: () => number; delay: (ms: number) => Promise<void> } {
  let clock = 0;
  return { now: () => clock, delay: async (ms: number) => { clock += ms; } };
}

const healthySendRequest = (async ({ request }: { request: { method: string } }) => {
  assert.equal(request.method, "health");
  return { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ok: true, result: { status: "ok" } };
}) as NonNullable<GatewayCliDependencies["sendRequest"]>;

test("service install writes a real plist under a temp home, drives the fake launchctl runner, and reports health", async () => {
  const { home, stateDir, plistPath } = await serviceFixture();
  const uid = process.getuid!();
  const target = `gui/${uid}/${SERVICE_AGENT_LABEL}`;
  const launchd = cliFakeLaunchd();

  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir, OPENAI_API_KEY: "sk-never" },
    stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: launchd.run,
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.ok);
  assert.deepEqual(launchd.calls, [
    ["print", target],
    ["bootstrap", `gui/${uid}`, plistPath],
    ["print", target],
  ]);
  const parsed = JSON.parse(stdout.chunks.join("")) as {
    ok: boolean; command: string;
    result: {
      subcommand: string; label: string; plistPath: string; logPath: string;
      capturedEnv: string[]; health: { ok: boolean };
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "service");
  assert.equal(parsed.result.subcommand, "install");
  assert.equal(parsed.result.label, SERVICE_AGENT_LABEL);
  assert.equal(parsed.result.plistPath, plistPath);
  assert.deepEqual(parsed.result.capturedEnv, ["EMBASSY_STATE_DIR"]);
  assert.equal(parsed.result.health.ok, true);
  assert.equal(stderr.chunks.join(""), "");

  const plistStat = await lstat(plistPath);
  assert.equal(plistStat.mode & 0o777, 0o644);
  const plistContent = await readFile(plistPath, "utf8");
  assert.match(plistContent, /<string>serve<\/string>/);
  assert.match(plistContent, /<key>KeepAlive<\/key>\n    <dict>\n        <key>Crashed<\/key>\n        <true\/>\n    <\/dict>/);
  assert.doesNotMatch(plistContent, /sk-never|OPENAI_API_KEY/);
});

test("service install over its own loaded agent boots it out and re-installs", async () => {
  const { home, stateDir, plistPath } = await serviceFixture();
  const uid = process.getuid!();
  const target = `gui/${uid}/${SERVICE_AGENT_LABEL}`;
  const launchd = cliFakeLaunchd({ loaded: true });

  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: launchd.run,
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.ok);
  assert.deepEqual(launchd.calls, [
    ["print", target],
    ["bootout", target],
    ["print", target],
    ["bootstrap", `gui/${uid}`, plistPath],
    ["print", target],
  ]);
  assert.equal(stderr.chunks.join(""), "");
});

test("service install stops before launchd when the node inventory cannot be read", async () => {
  // A real refusal from the real loader: nodes.json is optional now, so the
  // pre-launchd stop has to be provoked by a file that is present and wrong.
  for (const plant of [
    async (dir: string) => writeFile(path.join(dir, "nodes.json"), "{ not json", { mode: 0o600 }),
    async (dir: string) => writeFile(path.join(dir, "nodes.json"),
      '{"version":1,"host":"this-mac","nodes":[]}\n', { mode: 0o644 }),
  ]) {
    const { home, stateDir, plistPath } = await serviceFixture();
    await chmod(stateDir, 0o700);
    await plant(stateDir);
    const launchd = cliFakeLaunchd();
    const stdout = capture(), stderr = capture();
    const code = await runGatewayCliBase(["service", "install"], {
      env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
      serviceHomeDir: () => home, probeHostLease: freeHostLease,
      runLaunchctl: launchd.run,
      validateControlSocket: async () => { throw new Error("must not check the socket"); },
      sendRequest: async () => { throw new Error("must not contact the gateway"); },
    });

    assert.equal(code, gatewayCliExitCodes.invalidInput);
    assert.equal(JSON.parse(stdout.chunks.join("")).error.code, "INVALID_GATEWAY_CONFIGURATION");
    assert.deepEqual(launchd.calls, []);
    await assert.rejects(lstat(plistPath));
    await assert.rejects(lstat(path.join(home, "Library")));
  }
});

test("a failing launchctl bootstrap exits non-zero and prints launchctl's own stderr", async () => {
  const { home, stateDir, plistPath } = await serviceFixture();
  const launchd = cliFakeLaunchd({
    fail: { bootstrap: { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" } },
  });
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: launchd.run,
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false, command: "service",
    error: { code: "SERVICE_AGENT_COMMAND_FAILED", ambiguous: false, retryable: true },
  });
  assert.equal(
    stderr.chunks.join(""),
    "[embassy] gateway unavailable.\n[embassy] launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error — rollback: the new agent was unloaded and its plist removed; there was no previous install.\n",
  );
  await assert.rejects(lstat(plistPath));
});

test("the install health probe is bounded by wall clock, not by an attempt count", async () => {
  const { home, stateDir } = await serviceFixture();
  const launchd = cliFakeLaunchd();
  const clock = sleepDrivenClock();
  const timeouts: (number | undefined)[] = [];
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: launchd.run,
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ timeoutMs }: { timeoutMs?: number }) => {
      timeouts.push(timeoutMs);
      throw new GatewayControlTransportError("CONTROL_SOCKET_MISSING", "private detail");
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    delay: clock.delay, now: clock.now,
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  // The deadline, not the attempt count, ends it: 10 s of injected clock.
  assert.equal(clock.now(), 10_000);
  // Every attempt is capped at 1 s, and the tail attempts are capped tighter
  // by what is left of the deadline, so one stalled socket cannot stretch the
  // window past the 10 s the message promises.
  assert.equal(timeouts[0], 1_000);
  assert.equal(
    timeouts.every((value) => value !== undefined && Number.isInteger(value) &&
      value >= 50 && value <= 1_000),
    true, JSON.stringify(timeouts),
  );
  assert.equal(timeouts.at(-1), 200);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false, command: "service",
    error: {
      code: "SERVICE_HEALTH_UNAVAILABLE", ambiguous: false, retryable: true,
      lastObserved: "CONTROL_SOCKET_MISSING",
    },
  });
  assert.equal(
    stderr.chunks.join(""),
    `[embassy] gateway unavailable.\n[embassy] Installed, but the broker did not answer within 10.0 s; last observed CONTROL_SOCKET_MISSING. Run \`embassy service status\` or \`embassy health\`; log: ${path.join(home, "Library", "Logs", "agent-embassy", "broker.log")}.\n`,
  );
  assert.doesNotMatch(stderr.chunks.join(""), /private detail/);
});

test("a decisive last observed code exits with that code's own class, not a retryable timeout", async () => {
  const cases = [
    {
      thrown: () => new GatewayControlTransportError("CONTROL_VERSION_MISMATCH", "private skew"),
      code: "CONTROL_VERSION_MISMATCH", exit: gatewayCliExitCodes.unavailable,
      summary: "[embassy] gateway unavailable.\n", retryable: true,
      hint: "[embassy] rebuild or repoint this client to the broker's Embassy installation, then retry.\n",
    },
    {
      thrown: () => new BridgeError("CONTROL_STATE_UNSAFE", "private modes", false),
      code: "CONTROL_STATE_UNSAFE", exit: gatewayCliExitCodes.invalidInput,
      summary: "[embassy] gateway state directory or socket has unexpected permissions or ownership. Verify the exact path, owner, and modes before retrying.\n",
      retryable: false, hint: "",
    },
  ] as const;
  for (const scenario of cases) {
    const { home, stateDir } = await serviceFixture();
    const clock = sleepDrivenClock();
    const stdout = capture(), stderr = capture();
    const code = await runGatewayCli(["service", "install"], {
      env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
      serviceHomeDir: () => home, probeHostLease: freeHostLease,
      runLaunchctl: cliFakeLaunchd().run,
      validateControlSocket: async () => undefined,
      sendRequest: async () => { throw scenario.thrown(); },
      delay: clock.delay, now: clock.now,
    });

    assert.equal(code, scenario.exit, scenario.code);
    const parsed = JSON.parse(stdout.chunks.join("")) as { error: Record<string, unknown> };
    assert.deepEqual(parsed.error, {
      code: "SERVICE_HEALTH_UNAVAILABLE", ambiguous: false,
      retryable: scenario.retryable, lastObserved: scenario.code,
    });
    assert.equal(
      stderr.chunks.join(""),
      `${scenario.summary}[embassy] Installed, but the broker answered ${scenario.code} after 10.0 s. Run \`embassy health\` to diagnose it; log: ${path.join(home, "Library", "Logs", "agent-embassy", "broker.log")}.\n${scenario.hint}`,
    );
    assert.doesNotMatch(stderr.chunks.join(""), /private skew|private modes/);
  }
});

test("launchctl print stdout never reaches stderr, however the service command fails", async () => {
  const { home, stateDir, plistPath } = await serviceFixture();
  const dump = `state = running\n\tpid = 4242\n\tenvironment = {\n\t\tEMBASSY_STATE_DIR => /secret/state\n\t}\n`;
  const clock = sleepDrivenClock();
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    // Loaded, and bootout never actually clears it.
    runLaunchctl: async (args) => args[0] === "print"
      ? { code: 0, stdout: dump, stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
    validateControlSocket: async () => { throw new Error("must not reach the health probe"); },
    sendRequest: async () => { throw new Error("must not contact the gateway"); },
    delay: clock.delay, now: clock.now,
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.equal(
    stderr.chunks.join(""),
    "[embassy] gateway unavailable.\n[embassy] Could not replace the loaded launchd agent: the previous agent is still unloading after 10.0 s, although launchctl bootout returned 0. Nothing was changed.\n",
  );
  assert.doesNotMatch(`${stdout.chunks.join("")} ${stderr.chunks.join("")}`, /secret|4242/);
  await assert.rejects(lstat(plistPath));
});

test("an errno filesystem failure on the service path is a service failure, not an internal error", async () => {
  const { home, stateDir } = await serviceFixture();
  await mkdir(path.join(home, "Library"), { mode: 0o755 });
  // Read-only: creating LaunchAgents underneath fails with a raw EACCES.
  await chmod(path.join(home, "Library"), 0o500);

  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: cliFakeLaunchd().run,
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });
  await chmod(path.join(home, "Library"), 0o755);

  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false, command: "service",
    error: { code: "SERVICE_AGENT_FILESYSTEM_FAILED", ambiguous: false, retryable: true },
  });
  assert.match(stderr.chunks.join(""), /^\[embassy\] gateway unavailable\.\n\[embassy\] The service command could not complete: EACCES/);
});

test("an unsafe service path reports the unsafe class, not a plain input rejection", async () => {
  const { home, stateDir } = await serviceFixture();
  const elsewhere = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-cli-service-agents-"));
  roots.add(elsewhere);
  await mkdir(path.join(home, "Library"), { mode: 0o755 });
  await symlink(elsewhere, path.join(home, "Library", "LaunchAgents"));

  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: cliFakeLaunchd().run,
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.invalidInput);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false, command: "service",
    error: { code: "SERVICE_AGENT_PATH_UNSAFE", ambiguous: false, retryable: false },
  });
  assert.match(
    stderr.chunks.join(""),
    /^\[embassy\] gateway state directory or socket has unexpected permissions or ownership\./,
  );
  await assert.rejects(lstat(path.join(elsewhere, `${SERVICE_AGENT_LABEL}.plist`)));
});

test("service status reports unknown and exits non-zero when launchctl cannot answer", async () => {
  const { home } = await serviceFixture();
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "status"], {
    env: {}, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: async () => ({ code: 1, stdout: "", stderr: "spawn /bin/launchctl ENOENT" }),
    loadConfig: () => { throw new Error("status must not load configuration"); },
    sendRequest: async () => { throw new Error("status must not contact the gateway"); },
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  const parsed = JSON.parse(stdout.chunks.join("")) as {
    ok: boolean; result: { state: string; plistExists: boolean; launchctlStderr: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.state, "unknown");
  assert.equal(parsed.result.plistExists, false);
  assert.equal(parsed.result.launchctlStderr, "spawn /bin/launchctl ENOENT");
  assert.match(stderr.chunks.join(""), /launchctl: spawn \/bin\/launchctl ENOENT\n$/);
});

test("the installed binary implements exactly the nineteen documented commands", () => {
  // docs/GATEWAY-ARCHITECTURE.md names this list and its count; README's
  // command table covers the same set.
  assert.deepEqual([...gatewayCliCommands], [
    "serve", "service", "health", "status", "delivery-status", "wait-delivery",
    "refresh", "register-codex", "unregister-codex", "select-claude",
    "unselect-claude", "pair", "unpair", "send", "reply", "register-peer",
    "unregister-peer", "await", "peer-stdio",
  ]);
  assert.equal(gatewayCliCommands.length, 19);
});

test("the health probe still terminates when the injected clock never advances", async () => {
  const { home, stateDir } = await serviceFixture();
  let attempts = 0;
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: cliFakeLaunchd().run,
    validateControlSocket: async () => undefined,
    sendRequest: async () => {
      attempts += 1;
      throw new GatewayControlTransportError("CONTROL_SOCKET_MISSING", "private detail");
    },
    // A deadline alone is not a bound: a clock that never moves would loop.
    now: () => 0, delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.equal(attempts, 50);
  assert.match(stderr.chunks.join(""), /did not answer within 0\.0 s; last observed CONTROL_SOCKET_MISSING/);
});

test("the tail of the health window never fabricates its own last observation", async () => {
  const { home, stateDir } = await serviceFixture();
  // A fractional monotonic clock, as performance.now() actually gives.
  let clock = 0;
  const observed: string[] = [];
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    runLaunchctl: cliFakeLaunchd().run,
    validateControlSocket: async () => undefined,
    sendRequest: (async ({ timeoutMs }: { timeoutMs?: number }) => {
      // control.ts's own guard, reproduced: below 50 ms, or non-integer, it
      // rejects the call as CONTROL_INVALID_RESPONSE — which would then be
      // reported as the last thing observed, a fault this client invented.
      if (timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs < 50) {
        observed.push("CONTROL_INVALID_RESPONSE");
        throw new GatewayControlTransportError("CONTROL_INVALID_RESPONSE", "fabricated");
      }
      observed.push("CONTROL_SOCKET_MISSING");
      throw new GatewayControlTransportError("CONTROL_SOCKET_MISSING", "private detail");
    }) as NonNullable<GatewayCliDependencies["sendRequest"]>,
    now: () => clock, delay: async (ms: number) => { clock += ms + 0.37; },
  });

  assert.equal(code, gatewayCliExitCodes.unavailable);
  assert.equal(observed.includes("CONTROL_INVALID_RESPONSE"), false);
  assert.equal(JSON.parse(stdout.chunks.join("")).error.lastObserved, "CONTROL_SOCKET_MISSING");
  // Elapsed is measured monotonically and clamped: never a negative window.
  const elapsed = /did not answer within ([\d.]+) s/.exec(stderr.chunks.join(""))?.[1];
  assert.equal(elapsed !== undefined && Number(elapsed) >= 0, true, stderr.chunks.join(""));
  assert.doesNotMatch(stderr.chunks.join(""), /within -|fabricated/);
});

test("a non-errno failure on the service path keeps its own class", async () => {
  const { home, stateDir } = await serviceFixture();
  const stdout = capture(), stderr = capture();
  const code = await runGatewayCli(["service", "install"], {
    env: { EMBASSY_STATE_DIR: stateDir }, stdout, stderr,
    serviceHomeDir: () => home, probeHostLease: freeHostLease,
    // A string `code` alone is not a filesystem failure: CliFault and the
    // lease's spawn failures look like this too.
    runLaunchctl: async () => {
      throw Object.assign(new Error("not a filesystem failure"), { code: "SOME_OTHER_CODE" });
    },
    validateControlSocket: async () => undefined,
    sendRequest: healthySendRequest,
    delay: async () => {},
  });

  assert.equal(code, gatewayCliExitCodes.failure);
  assert.deepEqual(JSON.parse(stdout.chunks.join("")), {
    ok: false, command: "service",
    error: { code: "INTERNAL_ERROR", ambiguous: false, retryable: false },
  });
  assert.equal(stderr.chunks.join(""), "[embassy] command failed.\n");
});
