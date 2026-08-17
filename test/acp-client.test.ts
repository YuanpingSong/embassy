import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as delayImmediate } from "node:timers/promises";
import test from "node:test";
import {
  ACP_MAX_REPLY_BYTES,
  AcpRequestError,
  spawnAcpClient,
  type AcpLaunchSpec,
  type AcpSpawn,
} from "../src/gateway/acp-client.js";

type RpcMessage = Record<string, unknown>;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

class FakeAgent {
  readonly child = new FakeChild();
  readonly received: RpcMessage[] = [];
  private input = "";

  constructor(
    private readonly respond: (message: RpcMessage, agent: FakeAgent) => void,
  ) {
    this.child.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString("utf8");
      for (;;) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) return;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const message = JSON.parse(line) as RpcMessage;
        this.received.push(message);
        this.respond(message, this);
      }
    });
  }

  send(message: RpcMessage): void {
    this.child.stdout.write(`${JSON.stringify(message)}\n`);
  }

  result(request: RpcMessage, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  error(request: RpcMessage, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }
}

function initializedAgent(
  handler: (message: RpcMessage, agent: FakeAgent) => void,
  agentCapabilities: RpcMessage = {},
  protocolVersion = 1,
): FakeAgent {
  return new FakeAgent((message, agent) => {
    if (message.method === "initialize") {
      agent.result(message, {
        protocolVersion,
        agentCapabilities,
        authMethods: [{ id: "login", name: "Login" }],
      });
      return;
    }
    handler(message, agent);
  });
}

function spawnFrom(agent: FakeAgent, calls: unknown[][] = []): AcpSpawn {
  return (command, args, options) => {
    calls.push([command, args, options]);
    return agent.child as unknown as ReturnType<AcpSpawn>;
  };
}

test("initializes once with no fs or terminal capability and keeps agent truth", async () => {
  const calls: unknown[][] = [];
  const capabilities = {
    loadSession: true,
    sessionCapabilities: { list: {}, resume: {} },
  };
  const agent = initializedAgent(() => {}, capabilities);
  const client = await spawnAcpClient(
    { kind: "npx", package: "agent@1", args: ["--acp"], cwd: "/work" },
    { spawn: spawnFrom(agent, calls) },
  );

  assert.deepEqual(calls, [
    [
      "npx",
      ["--yes", "agent@1", "--acp"],
      { cwd: "/work", shell: false, stdio: ["pipe", "pipe", "pipe"] },
    ],
  ]);
  assert.deepEqual(agent.received[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
  });
  assert.deepEqual(client.connectionInfo, {
    protocolVersion: 1,
    agentCapabilities: capabilities,
    authMethods: [{ id: "login", name: "Login" }],
  });
  client.close();
  assert.equal(agent.child.killed, true);
});

test("supports binary and local-checkout launch specs without attestation", async () => {
  for (const [launch, expected] of [
    [
      { kind: "binary", path: "/agent", sha256: "abc", args: ["acp"] },
      ["/agent", ["acp"]],
    ],
    [
      { kind: "local-checkout", command: "node", args: ["adapter.js"] },
      ["node", ["adapter.js"]],
    ],
  ] as const satisfies readonly [AcpLaunchSpec, readonly unknown[]][]) {
    const calls: unknown[][] = [];
    const agent = initializedAgent(() => {});
    const client = await spawnAcpClient(launch, {
      spawn: spawnFrom(agent, calls),
    });
    assert.deepEqual(calls[0]?.slice(0, 2), expected);
    client.close();
  }
});

test("creates sessions and preserves all five stop reasons with text chunks", async () => {
  const stops = [
    ["end_turn", "delivered"],
    ["max_tokens", "failed"],
    ["max_turn_requests", "failed"],
    ["refusal", "failed"],
    ["cancelled", "cancelled"],
  ] as const;
  let nextSession = 0;
  let nextStop = 0;
  const agent = initializedAgent((message, peer) => {
    if (message.method === "session/new") {
      peer.result(message, { sessionId: `session-${nextSession++}` });
      return;
    }
    if (message.method === "session/prompt") {
      const params = message.params as RpcMessage;
      peer.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { text: "no" } },
        },
      });
      peer.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "answer" },
          },
        },
      });
      peer.result(message, { stopReason: stops[nextStop++]?.[0] });
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  for (const [stopReason, terminalState] of stops) {
    const { sessionId } = await client.newSession("/workspace");
    const receipt = await client.prompt(sessionId, "hello");
    assert.deepEqual(receipt, {
      terminalState,
      stopReason,
      text: "answer",
      textTruncated: false,
    });
  }
  const newRequest = agent.received.find((message) => message.method === "session/new");
  assert.deepEqual(newRequest?.params, { cwd: "/workspace", mcpServers: [] });
  const promptRequest = agent.received.find(
    (message) => message.method === "session/prompt",
  );
  assert.deepEqual(promptRequest?.params, {
    sessionId: "session-0",
    prompt: [{ type: "text", text: "hello" }],
  });
  client.close();
});

test("prepared prompts reserve and write one exact prehashed frame", async () => {
  const agent = initializedAgent((message, peer) => {
    if (message.method === "session/prompt") {
      peer.result(message, { stopReason: "end_turn" });
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  const prepared = client.preparePrompt("session-prepared", "exact body");
  assert.equal(
    agent.received.some((message) => message.method === "session/prompt"),
    false,
  );
  const receipt = await prepared.perform();
  assert.equal(receipt.terminalState, "delivered");
  const request = agent.received.find(
    (message) => message.method === "session/prompt",
  );
  assert.ok(request);
  const serialized = `${JSON.stringify(request)}\n`;
  assert.equal(prepared.bodyBytes, Buffer.byteLength("exact body", "utf8"));
  assert.equal(prepared.frameBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(
    prepared.sha256,
    createHash("sha256").update(serialized).digest("hex"),
  );
  await assert.rejects(prepared.perform(), /already consumed/u);
  assert.throws(() => prepared.cancel(), /already consumed/u);

  const cancelled = client.preparePrompt("session-cancelled", "never send");
  cancelled.cancel();
  await assert.rejects(cancelled.perform(), /already consumed/u);
  assert.equal(
    agent.received.some(
      (message) =>
        message.method === "session/prompt" &&
        (message.params as RpcMessage).sessionId === "session-cancelled",
    ),
    false,
  );
  client.close();
});

test("close fences a prepared prompt queued behind an earlier write", async () => {
  const agent = initializedAgent((message, peer) => {
    if (message.method === "session/new") {
      peer.result(message, { sessionId: "never-observed-after-close" });
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  agent.child.stdin.cork();
  const earlier = client.newSession("/workspace").catch(() => undefined);
  const prepared = client.preparePrompt("session-fenced", "must not write");
  const prompt = prepared.perform();
  client.close();
  agent.child.stdin.uncork();
  await earlier;
  assert.equal((await prompt).terminalState, "unknown");
  await delayImmediate();
  assert.equal(
    agent.received.some((message) => message.method === "session/prompt"),
    false,
  );
});

test("always cancels permission requests and rejects undeclared inbound requests", async () => {
  const agent = initializedAgent((message, peer) => {
    if (message.id === "permission") {
      assert.deepEqual(message.result, { outcome: { outcome: "cancelled" } });
    }
    if (message.id === "undeclared") {
      assert.deepEqual(message.error, {
        code: -32601,
        message: "Method not found",
      });
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  agent.send({
    jsonrpc: "2.0",
    id: "permission",
    method: "session/request_permission",
    params: { sessionId: "s", options: [{ optionId: "allow" }] },
  });
  agent.send({
    jsonrpc: "2.0",
    id: "undeclared",
    method: "fs/read_text_file",
    params: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(agent.received.some((message) => message.id === "permission"));
  assert.ok(agent.received.some((message) => message.id === "undeclared"));
  client.close();
});

test("surfaces JSON-RPC errors verbatim on prompt receipts", async () => {
  const errors = [
    [-32602, "invalid parameters", { field: "prompt" }],
    [-32603, "agent internal error", undefined],
    [-32002, "authentication required", { methodId: "login" }],
    [-32000, "agent error", { detail: "report me" }],
  ] as const;
  let index = 0;
  const agent = initializedAgent((message, peer) => {
    if (message.method === "session/prompt") {
      const [code, errorMessage, data] = errors[index++] ?? errors[0];
      peer.error(message, code, errorMessage, data);
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  for (const [code, message, data] of errors) {
    const receipt = await client.prompt(`s-${code}`, "hello");
    assert.equal(receipt.terminalState, "failed");
    assert.ok("error" in receipt);
    assert.deepEqual(receipt.error, {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    });
    assert.equal(receipt.reportOnly, code === -32000);
    assert.equal(receipt.textTruncated, false);
  }
  client.close();
});

test("subprocess death settles an outstanding prompt as unknown", async () => {
  const agent = initializedAgent(() => {});
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );

  const prompt = client.prompt("s", "hello");
  await new Promise((resolve) => setImmediate(resolve));
  agent.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      },
    },
  });
  agent.child.emit("exit", 1, null);
  assert.deepEqual(await prompt, {
    terminalState: "unknown",
    text: "partial",
    textTruncated: false,
  });
});

test("cancel is an exact notification", async () => {
  const agent = initializedAgent(() => undefined);
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );
  await client.cancel("s");
  const cancel = agent.received.find(
    (message) => message.method === "session/cancel",
  );
  assert.deepEqual(cancel, {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s" },
  });
  client.close();
});

test("non-optional request errors remain exact AcpRequestError values", async () => {
  const agent = initializedAgent((message, peer) => {
    if (message.method === "session/new") {
      peer.error(message, -32000, "agent refused session", { reason: "busy" });
    }
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );
  await assert.rejects(
    client.newSession("/work"),
    (error: unknown) =>
      error instanceof AcpRequestError &&
      error.message === "agent refused session" &&
      error.detail.code === -32000,
  );
  client.close();
});

test("failed initialization kills the owned subprocess", async () => {
  const agent = new FakeAgent((message, peer) => {
    peer.error(message, -32603, "initialize failed");
  });
  await assert.rejects(
    spawnAcpClient(
      { kind: "local-checkout", command: "agent" },
      { spawn: spawnFrom(agent) },
    ),
    (error: unknown) =>
      error instanceof AcpRequestError && error.message === "initialize failed",
  );
  assert.equal(agent.child.killed, true);
});

test("unsupported negotiated protocol version closes with both versions named", async () => {
  const agent = initializedAgent(() => {}, {}, 2);
  await assert.rejects(
    spawnAcpClient(
      { kind: "local-checkout", command: "agent" },
      { spawn: spawnFrom(agent) },
    ),
    /ACP protocol version mismatch: client supports 1, agent selected 2/,
  );
  assert.equal(agent.child.killed, true);
});

test("prompt reply text is byte-bounded and reports truncation", async () => {
  const oversized = `${"x".repeat(ACP_MAX_REPLY_BYTES - 1)}😀tail`;
  const agent = initializedAgent((message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: oversized },
        },
      },
    });
    peer.result(message, { stopReason: "end_turn" });
  });
  const client = await spawnAcpClient(
    { kind: "local-checkout", command: "agent" },
    { spawn: spawnFrom(agent) },
  );
  const receipt = await client.prompt("s", "hello");
  assert.equal(receipt.terminalState, "delivered");
  assert.equal(Buffer.byteLength(receipt.text, "utf8"), ACP_MAX_REPLY_BYTES - 1);
  assert.equal(receipt.text.endsWith("�"), false);
  assert.equal(receipt.textTruncated, true);
  client.close();
});
