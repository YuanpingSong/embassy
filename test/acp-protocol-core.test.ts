import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ACP_MAX_REPLY_BYTES,
  spawnAcpClient,
  type AcpClient,
  type AcpSpawn,
} from "../src/gateway/acp-client.js";

type Rpc = Record<string, unknown>;
type Handler = (message: Rpc, peer: ProtocolPeer) => void;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

class ProtocolPeer {
  readonly child = new FakeChild();
  readonly received: Rpc[] = [];
  private input = "";

  constructor(private readonly handler: Handler) {
    this.child.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString("utf8");
      for (;;) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) return;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const message = JSON.parse(line) as Rpc;
        this.received.push(message);
        this.handler(message, this);
      }
    });
  }

  send(message: Rpc): void {
    this.raw(`${JSON.stringify(message)}\n`);
  }

  raw(text: string): void {
    this.child.stdout.write(text);
  }

  result(request: Rpc, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  error(request: Rpc, error: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, error });
  }

  exit(): void {
    this.child.exitCode = 1;
    this.child.emit("exit", 1, null);
  }
}

function spawnFrom(peer: ProtocolPeer): AcpSpawn {
  return () => peer.child as unknown as ReturnType<AcpSpawn>;
}

function initializedPeer(
  handler: Handler,
  capabilities: Rpc = {},
): ProtocolPeer {
  return new ProtocolPeer((message, peer) => {
    if (message.method === "initialize") {
      peer.result(message, {
        protocolVersion: 1,
        agentCapabilities: capabilities,
      });
    } else {
      handler(message, peer);
    }
  });
}

async function connect(peer: ProtocolPeer): Promise<AcpClient> {
  return spawnAcpClient(
    { kind: "local-checkout", command: "fake-acp" },
    { spawn: spawnFrom(peer) },
  );
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function update(sessionId: string, text: string): Rpc {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

test("framing: fragmented, coalesced, blank, and malformed frames cannot break correlation", async () => {
  const pending: Rpc[] = [];
  const peer = initializedPeer((message) => pending.push(message));
  const client = await connect(peer);
  const first = client.newSession("/one");
  const second = client.newSession("/two");
  await immediate();
  const [one, two] = pending;
  assert.ok(one && two);

  peer.raw("\nnot-json\n[]\n42\n");
  peer.send({ jsonrpc: "2.0", id: 999, result: { sessionId: "wrong" } });
  const secondFrame = `${JSON.stringify({
    jsonrpc: "2.0",
    id: two.id,
    result: { sessionId: "second" },
  })}\n`;
  const firstFrame = `${JSON.stringify({
    jsonrpc: "2.0",
    id: one.id,
    result: { sessionId: "first" },
  })}\n`;
  peer.raw(secondFrame.slice(0, 7));
  peer.raw(`${secondFrame.slice(7)}${firstFrame}`);

  assert.deepEqual(await Promise.all([first, second]), [
    { sessionId: "first" },
    { sessionId: "second" },
  ]);
  client.close();
});

test("correlation: concurrent sessions keep updates and out-of-order receipts isolated", async () => {
  const prompts: Rpc[] = [];
  const peer = initializedPeer((message) => {
    if (message.method === "session/prompt") prompts.push(message);
  });
  const client = await connect(peer);
  const left = client.prompt("left", "L");
  const right = client.prompt("right", "R");
  await immediate();
  const [leftRequest, rightRequest] = prompts;
  assert.ok(leftRequest && rightRequest);

  peer.send(update("right", "R1"));
  peer.send(update("absent", "leak"));
  peer.send(update("left", "L1"));
  peer.result(rightRequest, { stopReason: "refusal" });
  peer.result(leftRequest, { stopReason: "end_turn" });

  assert.deepEqual(await left, {
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "L1",
    textTruncated: false,
  });
  assert.deepEqual(await right, {
    terminalState: "failed",
    stopReason: "refusal",
    text: "R1",
    textTruncated: false,
  });
  client.close();
});

test("correlation: wrong-id, duplicate, and late responses never resettle a prompt", async () => {
  let request: Rpc | undefined;
  const peer = initializedPeer((message) => {
    if (message.method === "session/prompt") request = message;
  });
  const client = await connect(peer);
  const prompt = client.prompt("s", "hello");
  await immediate();
  assert.ok(request);

  peer.send({ jsonrpc: "2.0", id: 98765, result: { stopReason: "cancelled" } });
  peer.result(request, { stopReason: "end_turn" });
  peer.error(request, { code: -32000, message: "late failure" });
  assert.deepEqual(await prompt, {
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "",
    textTruncated: false,
  });
  assert.equal(
    peer.received.filter((message) => message.method === "session/prompt").length,
    1,
  );
  client.close();
});

test("generation: frames from a closed child cannot settle a new connection", async () => {
  let oldRequest: Rpc | undefined;
  const oldPeer = initializedPeer((message) => {
    if (message.method === "session/prompt") oldRequest = message;
  });
  const oldClient = await connect(oldPeer);
  const oldPrompt = oldClient.prompt("old", "hello");
  await immediate();
  assert.ok(oldRequest);
  oldPeer.exit();
  assert.equal((await oldPrompt).terminalState, "unknown");

  let currentRequest: Rpc | undefined;
  const currentPeer = initializedPeer((message) => {
    if (message.method === "session/prompt") currentRequest = message;
  });
  const currentClient = await connect(currentPeer);
  const currentPrompt = currentClient.prompt("current", "hello");
  await immediate();
  assert.ok(currentRequest);
  oldPeer.result(oldRequest, { stopReason: "end_turn" });
  currentPeer.result(currentRequest, { stopReason: "cancelled" });
  assert.equal((await currentPrompt).terminalState, "cancelled");
  currentClient.close();
});

test("permissions and cancellation: races always deny and only the prompt response settles", async () => {
  let promptRequest: Rpc | undefined;
  const peer = initializedPeer((message, agent) => {
    if (message.method === "session/prompt") promptRequest = message;
    if (message.id === "permission-before" || message.id === "permission-after") {
      assert.deepEqual(message.result, { outcome: { outcome: "cancelled" } });
    }
    if (message.method === "unknown/notification") {
      assert.fail("client must not echo unknown notifications");
    }
    void agent;
  });
  const client = await connect(peer);
  const prompt = client.prompt("s", "hello");
  await immediate();
  assert.ok(promptRequest);

  for (const id of ["permission-before", "permission-after"]) {
    peer.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: { sessionId: "s", options: [{ optionId: "allow-always" }] },
    });
    if (id === "permission-before") await client.cancel("s");
  }
  peer.send({ jsonrpc: "2.0", method: "unknown/notification", params: {} });
  peer.result(promptRequest, { stopReason: "cancelled" });
  assert.equal((await prompt).terminalState, "cancelled");
  await immediate();
  assert.equal(
    peer.received.filter((message) => message.method === "session/cancel").length,
    1,
  );
  client.close();
});

test("unknown outbound method: -32601 is terminal and never replayed", async () => {
  let promptCalls = 0;
  const peer = initializedPeer((message, agent) => {
    if (message.method === "session/prompt") {
      promptCalls++;
      agent.error(message, { code: -32601, message: "prompt unavailable" });
    }
  });
  const client = await connect(peer);
  const first = await client.prompt("s", "one");
  const second = await client.prompt("s", "two");
  assert.equal(first.terminalState, "failed");
  assert.equal(second.terminalState, "failed");
  assert.ok("error" in first && first.error.code === -32601);
  assert.ok("error" in second && second.error.message === "prompt unavailable");
  assert.equal(promptCalls, 1);
  client.close();
});

test("malformed responses settle as exact internal errors once a correlated frame arrives", async () => {
  const requests: Rpc[] = [];
  const peer = initializedPeer((message) => {
    if (message.method === "session/prompt") requests.push(message);
  });
  const client = await connect(peer);

  const badError = client.prompt("bad-error", "hello");
  await immediate();
  peer.error(requests[0] as Rpc, { code: "wrong", message: 42 });
  const errorReceipt = await badError;
  assert.ok("error" in errorReceipt);
  assert.deepEqual(errorReceipt.error, {
    code: -32603,
    message: "Invalid JSON-RPC error response",
  });

  const badResult = client.prompt("bad-result", "hello");
  await immediate();
  peer.result(requests[1] as Rpc, { stopReason: "future_reason" });
  const resultReceipt = await badResult;
  assert.ok("error" in resultReceipt);
  assert.deepEqual(resultReceipt.error, {
    code: -32603,
    message: "ACP session/prompt returned an invalid stopReason",
  });
  client.close();
});

test("process death: initialize and non-prompt requests fail without a false receipt", async () => {
  const initializing = new ProtocolPeer((message, peer) => {
    if (message.method === "initialize") peer.exit();
  });
  await assert.rejects(connect(initializing), /ACP subprocess exited/);

  for (const method of ["session/new", "authenticate"] as const) {
    const peer = initializedPeer((message, agent) => {
      if (message.method === method) agent.exit();
    });
    const client = await connect(peer);
    const operation =
      method === "session/new"
        ? client.newSession("/work")
        : client.authenticate("login");
    await assert.rejects(operation, /ACP subprocess exited/);
  }
});

test("process death: an uncertain prompt is UNKNOWN and cannot replay on the dead connection", async () => {
  let request: Rpc | undefined;
  const peer = initializedPeer((message) => {
    if (message.method === "session/prompt") request = message;
  });
  const client = await connect(peer);
  const first = client.prompt("s", "one");
  await immediate();
  assert.ok(request);
  peer.send(update("s", "partial"));
  peer.exit();
  assert.deepEqual(await first, {
    terminalState: "unknown",
    text: "partial",
    textTruncated: false,
  });
  peer.result(request, { stopReason: "end_turn" });
  await assert.rejects(
    client.prompt("s", "two"),
    /ACP prompt preparation is unavailable/,
  );
  await assert.rejects(client.cancel("s"), /ACP subprocess exited/);
  assert.equal(
    peer.received.filter((message) => message.method === "session/prompt").length,
    1,
  );
});

test("process death after a correlated response cannot downgrade delivered truth", async () => {
  const peer = initializedPeer((message, agent) => {
    if (message.method === "session/prompt") {
      agent.result(message, { stopReason: "end_turn" });
      agent.exit();
    }
  });
  const client = await connect(peer);
  assert.equal((await client.prompt("s", "hello")).terminalState, "delivered");
});

test("reply bound: cumulative chunks stop at 64 KiB and do not contaminate another session", async () => {
  const requests = new Map<string, Rpc>();
  const peer = initializedPeer((message) => {
    if (message.method !== "session/prompt") return;
    const sessionId = (message.params as Rpc).sessionId as string;
    requests.set(sessionId, message);
  });
  const client = await connect(peer);
  const bounded = client.prompt("bounded", "hello");
  const other = client.prompt("other", "hello");
  await immediate();

  peer.send(update("bounded", "a".repeat(ACP_MAX_REPLY_BYTES - 2)));
  peer.send(update("bounded", "😀ignored"));
  peer.send(update("bounded", "must-not-append"));
  peer.send(update("other", "independent"));
  peer.result(requests.get("bounded") as Rpc, { stopReason: "end_turn" });
  peer.result(requests.get("other") as Rpc, { stopReason: "end_turn" });

  const boundedReceipt = await bounded;
  assert.equal(Buffer.byteLength(boundedReceipt.text, "utf8"), ACP_MAX_REPLY_BYTES - 2);
  assert.equal(boundedReceipt.textTruncated, true);
  const otherReceipt = await other;
  assert.equal(otherReceipt.text, "independent");
  assert.equal(otherReceipt.textTruncated, false);
  client.close();
});
