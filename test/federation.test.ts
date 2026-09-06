import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import type { WakeInput } from "../src/gateway/coordinator.js";
import {
  FEDERATION_PROTOCOL_VERSION,
  Federation,
  runFederationStdio,
  type FederatedHandoff,
  type FederationSpawn,
  type PublicEndpoint,
} from "../src/gateway/federation.js";
import type { Delivery, Endpoint } from "../src/gateway/ledger.js";

const local: Endpoint = {
  id: "reg_local_claude", host: "local", provider: "claude",
  alias: "advisor@local", handle: "session-local",
};
const remote: PublicEndpoint = {
  id: "reg_remote_codex", host: "remote", provider: "codex",
  alias: "codex-builder@remote",
};
const remoteEndpoint: Endpoint = { ...remote, handle: remote.id };

function delivery(id: string, body: string): Delivery {
  return {
    id: `msg_${id}`, reply: `conv_${id}`, token: `dlv_${id}`,
    source: { id: local.id, host: local.host, provider: local.provider },
    target: { id: remote.id, host: remote.host, provider: remote.provider },
    sourceAlias: local.alias,
    body, admittedAt: 1_000, deadline: 10_000, steer: false,
    state: { phase: "reserved", attempt: "attempt_send", tries: 1 },
  };
}

function wake(overrides: Partial<WakeInput> = {}): WakeInput {
  const messages = [delivery("00000000-0000-4000-8000-000000000001", "one"),
    delivery("00000000-0000-4000-8000-000000000002", "two")];
  return {
    attempt: "attempt_send", target: remoteEndpoint, text: "unused framed local text",
    deadline: 10_000, steer: false,
    messages: messages.map((item) => ({ delivery: item, source: local })),
    authorize: async () => true,
    accepted: async () => undefined,
    ...overrides,
  };
}

function harness(handlers: Parameters<typeof runFederationStdio>[0]["handlers"]) {
  const spawns: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const sessions: ReturnType<typeof runFederationStdio>[] = [];
  const requests: string[] = [];
  const spawn: FederationSpawn = (command, args, options) => {
    spawns.push({ command, args, options });
    const toRunner = new PassThrough();
    const fromRunner = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let killed = false;
    let requestBuffer = "";
    toRunner.on("data", (chunk) => {
      requestBuffer += chunk.toString("utf8");
      for (;;) {
        const newline = requestBuffer.indexOf("\n");
        if (newline < 0) break;
        requests.push(`${requestBuffer.slice(0, newline)}\n`);
        requestBuffer = requestBuffer.slice(newline + 1);
      }
    });
    const session = runFederationStdio({ host: "remote", nodes: ["local"], handlers,
      input: toRunner, output: fromRunner });
    sessions.push(session);
    return {
      stdin: toRunner,
      stdout: fromRunner,
      stderr,
      once: events.once.bind(events),
      kill: () => {
        if (killed) return true;
        killed = true;
        session.close();
        toRunner.end();
        fromRunner.end();
        stderr.end();
        events.emit("exit", 0, null);
        return true;
      },
    } as unknown as ReturnType<FederationSpawn>;
  };
  return { spawn, spawns, sessions, requests };
}

function networkHarness(catalogs: Readonly<Record<string, readonly PublicEndpoint[]>>) {
  let requests = 0;
  const failures = new Set<string>();
  const sessions: ReturnType<typeof runFederationStdio>[] = [];
  const spawn: FederationSpawn = (_command, args) => {
    const remoteHost = args.at(-3)!;
    const toRunner = new PassThrough();
    const fromRunner = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let killed = false;
    const runner = runFederationStdio({ host: remoteHost, nodes: ["local"], input: toRunner, output: fromRunner,
      handlers: {
        resolve: async () => null,
        catalog: async () => {
          requests += 1;
          if (failures.has(remoteHost)) throw new Error("bounded catalog failure");
          return catalogs[remoteHost] ?? [];
        },
        handoff: async () => ({ accepted: true }),
      } });
    sessions.push(runner);
    return { stdin: toRunner, stdout: fromRunner, stderr, once: events.once.bind(events), kill: () => {
      if (killed) return true;
      killed = true; runner.close(); toRunner.end(); fromRunner.end(); stderr.end(); events.emit("exit", 0, null); return true;
    } } as unknown as ReturnType<FederationSpawn>;
  };
  return { spawn, requests: () => requests, failures, sessions };
}

test("owner RPC resolution and catalog cache expose only public endpoint coordinates", async () => {
  const seen: Array<string | object> = [];
  const h = harness({
    resolve: async (node, selector) => { assert.equal(node, "local"); seen.push(selector); return remote; },
    catalog: async () => [remote],
    handoff: async () => ({ accepted: true }),
  });
  const federation = new Federation({ host: "local", nodes: ["remote"], spawn: h.spawn });
  assert.deepEqual(await federation.named(remote.alias), [remoteEndpoint]);
  assert.deepEqual(await federation.exact({ id: remote.id, host: remote.host,
    provider: remote.provider }), remoteEndpoint);
  assert.deepEqual(await federation.catalog(), [remote]);
  assert.deepEqual(seen, [remote.alias, { id: remote.id, host: remote.host,
    provider: remote.provider }]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0]?.command, "/usr/bin/ssh");
  assert.deepEqual(h.spawns[0]?.args, ["-T", "-x", "-o", "BatchMode=yes", "-o",
    "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no",
    "-o", "SendEnv=-*", "-o", "Tunnel=no", "remote", "embassy", "peer-stdio"]);
  const env = (h.spawns[0]?.options as { env: NodeJS.ProcessEnv }).env;
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LOGNAME", "SSH_AUTH_SOCK", "USER"]
    .filter((key) => process.env[key] !== undefined).sort());
  await federation.close();
});

test("display snapshot is cold without I/O, retains labelled stale rows, and clears the fault after success", async () => {
  let fail = false, calls = 0, clock = Date.parse("2026-09-06T12:00:00.000Z");
  const h = harness({
    resolve: async () => remote,
    catalog: async () => {
      calls += 1;
      if (fail) throw new Error("bounded remote failure");
      return [remote];
    },
    handoff: async () => ({ accepted: true }),
  });
  const federation = new Federation({ host: "local", nodes: ["remote"], spawn: h.spawn, now: () => clock });
  assert.deepEqual(federation.snapshot(), { nodes: [{ host: "remote", routes: [] }], truncated: false });
  assert.equal(calls, 0, "snapshot must not poll a broker or touch a native provider");

  assert.deepEqual(await federation.catalog(), [remote]);
  assert.deepEqual(federation.snapshot(), { nodes: [{ host: "remote",
    observedAt: "2026-09-06T12:00:00.000Z", routes: [remote] }], truncated: false });
  assert.equal(calls, 1);

  fail = true; clock += 60_000;
  assert.deepEqual(await federation.catalog(), [remote], "a failed refresh retains the last display observation");
  assert.deepEqual(federation.snapshot(), { nodes: [{ host: "remote",
    observedAt: "2026-09-06T12:00:00.000Z", safeErrorCode: "PEER_TUNNEL_UNAVAILABLE", routes: [remote] }],
  truncated: false });
  const afterFailure = calls;
  federation.snapshot(); federation.snapshot();
  assert.equal(calls, afterFailure, "reading stale observations cannot cause a retry");

  fail = false;
  assert.deepEqual(await federation.catalog(), [remote]);
  assert.deepEqual(federation.snapshot(), { nodes: [{ host: "remote",
    observedAt: "2026-09-06T12:01:00.000Z", routes: [remote] }], truncated: false });
  await federation.close();
});

test("display cache retains at most 128 routes in deterministic configured-host and endpoint order", async () => {
  const rows = (host: string, prefix: string): PublicEndpoint[] => Array.from({ length: 80 }, (_, index) => ({
    id: `reg_${prefix}_${String(index).padStart(3, "0")}`,
    host, provider: index % 2 ? "claude" : "codex",
    alias: `${prefix}${String(79 - index).padStart(3, "0")}@${host}`,
  }));
  const h = networkHarness({ one: rows("one", "a"), two: rows("two", "b") });
  const federation = new Federation({ host: "local", nodes: ["one", "two"], spawn: h.spawn,
    now: () => Date.parse("2026-09-06T12:00:00.000Z") });
  assert.equal((await federation.catalog()).length, 128);
  const snapshot = federation.snapshot();
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.nodes.map((node) => [node.host, node.routes.length]), [["one", 80], ["two", 48]]);
  assert.deepEqual(snapshot.nodes[0]!.routes.slice(0, 2).map((row) => row.alias), ["a000@one", "a001@one"]);
  assert.equal(snapshot.nodes.flatMap((node) => node.routes).length, 128);
  assert.equal(h.requests(), 2);
  federation.snapshot();
  assert.equal(h.requests(), 2);
  h.failures.add("two");
  await federation.catalog();
  const stale = federation.snapshot();
  assert.equal(stale.truncated, true, "a failed node retains knowledge that its cached catalog was truncated");
  assert.equal(stale.nodes[1]!.routes.length, 48);
  assert.equal(stale.nodes[1]!.safeErrorCode, "PEER_TUNNEL_UNAVAILABLE");
  await federation.close();
});

test("owner name collision crosses the readonly RPC as its exact bounded code", async () => {
  const h = harness({
    resolve: async () => { throw new BridgeError("PEER_ALIAS_COLLISION", "private owner detail"); },
    catalog: async () => [],
    handoff: async () => ({ accepted: true }),
  });
  const federation = new Federation({ host: "local", nodes: ["remote"], spawn: h.spawn });
  await assert.rejects(federation.named("shared@remote"), (error: unknown) =>
    error instanceof BridgeError && error.code === "PEER_ALIAS_COLLISION" &&
    !error.message.includes("private owner detail"));
  await federation.close();
});

test("one authorized handoff writes one batch, carries no sender token, and records acceptance", async () => {
  let received: FederatedHandoff | undefined;
  let accepted = 0;
  let preparedEvidence: Readonly<{ bytes: number; sha256: string }> | undefined;
  const h = harness({
    resolve: async () => remote,
    catalog: async () => [remote],
    handoff: async (peer, input) => {
      assert.equal(peer, "local");
      received = input;
      return { accepted: true };
    },
  });
  const federation = new Federation({ host: "local", nodes: ["remote"], spawn: h.spawn });
  const result = await federation.deliver(wake({
    authorize: async (evidence) => {
      assert.ok(evidence.bytes > 0);
      assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(received, undefined);
      preparedEvidence = evidence;
      return true;
    },
    accepted: async (loss) => { assert.equal(loss, "unconfirmed"); accepted += 1; },
  }));
  assert.deepEqual(result, { outcome: "delivered", code: "PEER_HANDOFF_CONFIRMED" });
  assert.equal(accepted, 1);
  assert.deepEqual(received?.target, remote);
  assert.deepEqual(received?.messages.map(({ body, source }) => ({ body, source })), [
    { body: "one", source: { id: local.id, host: local.host, provider: local.provider, alias: local.alias } },
    { body: "two", source: { id: local.id, host: local.host, provider: local.provider, alias: local.alias } },
  ]);
  assert.equal(JSON.stringify(received).includes("dlv_"), false);
  const handoffFrame = h.requests.find((frame) =>
    (JSON.parse(frame) as { method?: string }).method === "handoff");
  assert.ok(handoffFrame !== undefined);
  assert.deepEqual(preparedEvidence, {
    bytes: Buffer.byteLength(handoffFrame),
    sha256: createHash("sha256").update(handoffFrame).digest("hex"),
  });
  await federation.close();
});

test("proved refusal is exact while generic failure and predial failure stay conservative", async () => {
  const refusedHarness = harness({ resolve: async () => remote, catalog: async () => [remote],
    handoff: async () => ({ accepted: false, code: "QUEUE_FULL" }) });
  const refused = new Federation({ host: "local", nodes: ["remote"], spawn: refusedHarness.spawn });
  assert.deepEqual(await refused.deliver(wake()), { outcome: "failed", code: "QUEUE_FULL" });
  await refused.close();

  const unknownHarness = harness({ resolve: async () => remote, catalog: async () => [remote],
    handoff: async () => { throw new Error("post-write handler failure"); } });
  const unknown = new Federation({ host: "local", nodes: ["remote"], spawn: unknownHarness.spawn });
  assert.deepEqual(await unknown.deliver(wake()),
    { outcome: "ambiguous", code: "PEER_HANDOFF_OUTCOME_UNKNOWN" });
  await unknown.close();

  const unavailable = new Federation({ host: "local", nodes: ["remote"],
    spawn: () => { throw new Error("ssh unavailable"); } });
  assert.deepEqual(await unavailable.deliver(wake()),
    { outcome: "deferred", code: "PEER_TUNNEL_UNAVAILABLE" });
});

test("runner requires an allowed direct peer and answers unknown methods without invoking handlers", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Obj[] = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(JSON.parse(buffer.slice(0, newline)) as Obj);
      buffer = buffer.slice(newline + 1);
    }
  });
  let handoffs = 0;
  const runner = runFederationStdio({ host: "remote", nodes: ["local"], input, output,
    handlers: { resolve: async () => null, catalog: async () => [],
      handoff: async () => { handoffs += 1; return { accepted: true }; } } });
  const send = async (value: unknown): Promise<Obj> => {
    const count = lines.length;
    input.write(`${JSON.stringify(value)}\n`);
    for (let attempt = 0; attempt < 100 && lines.length === count; attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    return lines[count]!;
  };
  const unauthorized = await send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { version: FEDERATION_PROTOCOL_VERSION, host: "stranger" } });
  assert.equal((unauthorized.error as Obj).code, INVALID_PARAMS);
  assert.deepEqual((await send({ jsonrpc: "2.0", id: 2, method: "initialize",
    params: { version: FEDERATION_PROTOCOL_VERSION, host: "local" } })).result,
  { version: FEDERATION_PROTOCOL_VERSION, host: "remote" });
  assert.equal(((await send({ jsonrpc: "2.0", id: 3, method: "surprise", params: {} }))
    .error as Obj).code, METHOD_NOT_FOUND);
  const wrongSource = { target: remote, messages: [{
    id: "msg_00000000-0000-4000-8000-000000000003",
    reply: "conv_0000000000000003",
    source: { ...remote, host: "other", alias: "codex-builder@other" }, body: "x",
    deadline: 2_000, steer: false }] };
  assert.equal(((await send({ jsonrpc: "2.0", id: 4, method: "handoff", params: wrongSource }))
    .error as Obj).code, INVALID_PARAMS);
  assert.equal(handoffs, 0);
  const beforeUtf8 = lines.length;
  input.write(Buffer.from([0xff, 0x0a]));
  for (let attempt = 0; attempt < 100 && lines.length === beforeUtf8; attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.equal((lines[beforeUtf8]?.error as Obj).code, -32700);
  input.write(Buffer.concat([Buffer.alloc(256 * 1024 + 1, 0x61), Buffer.from("\n")]));
  await runner.done;
});

test("pipe death after handoff authorization is unknown and never a clean retry", async () => {
  const spawn: FederationSpawn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let buffer = "";
    stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string };
        buffer = buffer.slice(newline + 1);
        if (request.method === "initialize") {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
            result: { version: FEDERATION_PROTOCOL_VERSION, host: "remote" } })}\n`);
        } else {
          events.emit("exit", 1, null);
        }
      }
    });
    return { stdin, stdout, stderr, once: events.once.bind(events), kill: () => true } as unknown as
      ReturnType<FederationSpawn>;
  };
  const federation = new Federation({ host: "local", nodes: ["remote"], spawn });
  let authorized = 0;
  assert.deepEqual(await federation.deliver(wake({ authorize: async () => {
    authorized += 1;
    return true;
  } })), { outcome: "ambiguous", code: "PEER_HANDOFF_OUTCOME_UNKNOWN" });
  assert.equal(authorized, 1);
  await federation.close();
});

type Obj = Record<string, unknown>;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
