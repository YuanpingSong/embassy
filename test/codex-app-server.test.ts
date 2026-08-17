import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  CodexAppServerTransportError,
  WebSocketDuplexTransport,
} from "../src/gateway/codex-app-server.js";

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("WebSocket transport treats nullish send callbacks as success", async () => {
  class FakeSocket extends EventEmitter {
    readonly readyState = 1;

    constructor(private readonly sendError: Error | null | undefined) {
      super();
    }

    send(
      _payload: string,
      callback: (error: Error | null | undefined) => void,
    ): void {
      callback(this.sendError);
    }
  }

  const TransportConstructor = WebSocketDuplexTransport as unknown as new (
    socket: never,
    maxFrameBytes: number,
    closeTimeoutMs: number,
  ) => WebSocketDuplexTransport;
  for (const success of [null, undefined]) {
    const transport = new TransportConstructor(
      new FakeSocket(success) as never,
      1_024,
      100,
    );
    await transport.send("ok");
  }

  const failed = new TransportConstructor(
    new FakeSocket(new Error("discarded socket diagnostic")) as never,
    1_024,
    100,
  );
  await assert.rejects(
    failed.send("fail"),
    (error) =>
      error instanceof CodexAppServerTransportError &&
      error.code === "TRANSPORT_WRITE_FAILED" &&
      error.ambiguous,
  );
});

test("WebSocket heartbeat terminates a socket that stops answering pings", async () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    pings = 0;
    terminations = 0;

    ping(
      _data: undefined,
      _mask: undefined,
      callback: (error?: Error) => void,
    ): void {
      this.pings += 1;
      callback();
    }

    terminate(): void {
      this.terminations += 1;
      this.readyState = 3;
    }
  }

  const TransportConstructor = WebSocketDuplexTransport as unknown as new (
    socket: never,
    maxFrameBytes: number,
    closeTimeoutMs: number,
    heartbeatIntervalMs: number,
    heartbeatTimeoutMs: number,
  ) => WebSocketDuplexTransport;
  const socket = new FakeSocket();
  const transport = new TransportConstructor(
    socket as never,
    1_024,
    100,
    50,
    10,
  );
  let errors = 0;
  transport.onError(() => {
    errors += 1;
  });

  await waitFor(
    () => socket.terminations > 0,
    "the unanswered heartbeat to terminate the socket",
  );
  assert.equal(socket.pings, 1);
  assert.equal(socket.terminations, 1);
  assert.equal(socket.readyState, 3);
  assert.equal(errors, 1);
});
