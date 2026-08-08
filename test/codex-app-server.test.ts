import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { test } from "node:test";

import {
  CODEX_APP_SERVER_V1_METHODS,
  CodexAppServerConnector,
  CodexConnectorError,
  WebSocketDuplexTransport,
  type CodexAppServerTransport,
  type CodexConnectorEvent,
  type CodexTransientTurnResult,
} from "../src/gateway/codex-app-server.js";

const THREAD_ID = "thread-opted-in-001";
const ENDPOINT_GENERATION = "local-generation-001";
const WORKSPACE_CWD = "/workspace/project";
const SAFE_APPROVAL_POLICY = "never";
const SAFE_SANDBOX = { networkAccess: false, type: "readOnly" } as const;

function futureDeadline(milliseconds = 60_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

type WireRecord = Record<string, unknown>;
type SendHandler = (
  message: WireRecord,
  transport: FakeTransport,
) => void | Promise<void>;

class FakeTransport implements CodexAppServerTransport {
  readonly sent: WireRecord[] = [];
  closed = false;
  emittedCount = 0;
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(payload: string) => void>();

  constructor(private readonly handler: SendHandler) {}

  onMessage(listener: (payload: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async send(payload: string): Promise<void> {
    if (this.closed) throw new Error("closed");
    const message: unknown = JSON.parse(payload);
    assert.equal(typeof message, "object");
    assert.notEqual(message, null);
    assert.equal(Array.isArray(message), false);
    const record = message as WireRecord;
    this.sent.push(record);
    await this.handler(record, this);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emit(message: unknown): void {
    this.emittedCount += 1;
    const payload = JSON.stringify(message);
    for (const listener of this.messageListeners) listener(payload);
  }

  emitRaw(payload: string): void {
    this.emittedCount += 1;
    for (const listener of this.messageListeners) listener(payload);
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener();
  }

  respond(request: WireRecord, result: unknown): void {
    this.emit({ id: request.id, result });
  }

  reject(request: WireRecord, code = -32602): void {
    this.emit({
      error: { code, data: { discarded: true }, message: "discarded" },
      id: request.id,
    });
  }
}

function fixture(
  handler: SendHandler = () => undefined,
  options: {
    maxDeadlineMs?: number;
    maxReplyBytes?: number;
    now?: () => Date;
    requestTimeoutMs?: number;
    writesEnabled?: boolean;
  } = {},
): {
  connect: () => Promise<CodexAppServerConnector>;
  events: CodexConnectorEvent[];
  replies: CodexTransientTurnResult[];
  transport: FakeTransport;
} {
  const events: CodexConnectorEvent[] = [];
  const replies: CodexTransientTurnResult[] = [];
  const transport = new FakeTransport(async (message, fake) => {
    if (message.method === "initialize") {
      fake.respond(message, {
        platformFamily: "unix",
        platformOs: "darwin",
        userAgent: "discarded",
      });
      return;
    }
    const emittedBefore = fake.emittedCount;
    await handler(message, fake);
    if (
      message.method === "thread/loaded/list" &&
      fake.emittedCount === emittedBefore
    ) {
      fake.respond(message, { data: [THREAD_ID] });
    }
  });
  return {
    connect: () =>
      CodexAppServerConnector.connect({
        compatibility: {
          appServerVersion: "0.147.0",
          endpointGeneration: ENDPOINT_GENERATION,
          protocol: "app-server-v2-stable",
        },
        onEvent: (event) => events.push(event),
        onTurnResult: (result) => replies.push(result),
        ...(options.maxReplyBytes === undefined
          ? {}
          : { maxReplyBytes: options.maxReplyBytes }),
        ...(options.maxDeadlineMs === undefined
          ? {}
          : { maxDeadlineMs: options.maxDeadlineMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        route: {
          endpointGeneration: ENDPOINT_GENERATION,
          threadId: THREAD_ID,
        },
        transport,
        writesEnabled: options.writesEnabled ?? true,
      }),
    events,
    replies,
    transport,
  };
}

async function observeRoute(
  connector: CodexAppServerConnector,
): Promise<void> {
  const result = await connector.observeLoadedThread(connector.guard());
  assert.equal(result.selectedThreadLoaded, true);
}

function requestMethods(transport: FakeTransport): string[] {
  return transport.sent.flatMap((message) =>
    typeof message.id === "number" && typeof message.method === "string"
      ? [message.method]
      : [],
  );
}

function assertConnectorError(
  error: unknown,
  code: CodexConnectorError["code"],
): boolean {
  return error instanceof CodexConnectorError && error.code === code;
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
      assertConnectorError(error, "TRANSPORT_WRITE_FAILED") &&
      (error as CodexConnectorError).ambiguous,
  );
});

test("initializes once with output opt-outs and exposes only the reviewed v1 methods", async () => {
  const { connect, events, transport } = fixture();
  const connector = await connect();

  assert.equal(transport.sent.length, 2);
  const initialize = transport.sent[0];
  const initialized = transport.sent[1];
  assert.equal(initialize?.method, "initialize");
  assert.equal(typeof initialize?.id, "number");
  assert.deepEqual(initialized, { method: "initialized", params: {} });

  const params = initialize?.params as WireRecord;
  const capabilities = params.capabilities as WireRecord;
  assert.deepEqual(Object.keys(capabilities).sort(), [
    "experimentalApi",
    "optOutNotificationMethods",
  ]);
  assert.equal(capabilities.experimentalApi, true);
  const optOuts = capabilities.optOutNotificationMethods as unknown[];
  assert.ok(optOuts.includes("item/agentMessage/delta"));
  assert.ok(optOuts.includes("item/reasoning/textDelta"));
  assert.ok(optOuts.includes("item/started"));
  assert.equal(optOuts.includes("item/completed"), false);

  const experimentalSentinel = "EXPERIMENTAL_NOTIFICATION_MUST_NOT_ESCAPE";
  transport.emit({
    method: "turn/moderationMetadata",
    params: { raw: experimentalSentinel, threadId: THREAD_ID },
  });
  assert.equal(JSON.stringify(events).includes(experimentalSentinel), false);

  assert.deepEqual(CODEX_APP_SERVER_V1_METHODS, [
    "thread/loaded/list",
    "thread/resume",
    "thread/unsubscribe",
    "turn/start",
    "turn/interrupt",
  ]);
  for (const forbidden of [
    "thread/list",
    "thread/read",
    "thread/archive",
    "thread/delete",
    "thread/shellCommand",
    "turn/steer",
    "config/read",
    "account/read",
    "process/spawn",
  ]) {
    assert.equal(CODEX_APP_SERVER_V1_METHODS.includes(forbidden as never), false);
  }
  assert.deepEqual(connector.observation(), {
    connection: "ready",
    eventSequence: 1,
    hasActiveTurn: false,
    queueDepth: 0,
    requestInFlight: false,
    routeStatus: "unknown",
    writableReady: true,
    writeBlockCode: null,
  });

  const incompatibleTransport = new FakeTransport(() => undefined);
  await assert.rejects(
    CodexAppServerConnector.connect({
      compatibility: {
        appServerVersion: "0.147.0",
        endpointGeneration: "different-generation",
        protocol: "app-server-v2-stable",
      },
      route: {
        endpointGeneration: ENDPOINT_GENERATION,
        threadId: THREAD_ID,
      },
      transport: incompatibleTransport,
      writesEnabled: true,
    }),
    (error) => assertConnectorError(error, "INVALID_CONFIGURATION"),
  );
  assert.equal(incompatibleTransport.sent.length, 0);
  await assert.rejects(
    CodexAppServerConnector.connect({
      compatibility: {
        appServerVersion: "0.148.0",
        endpointGeneration: ENDPOINT_GENERATION,
        protocol: "app-server-v2-stable",
      },
      route: {
        endpointGeneration: ENDPOINT_GENERATION,
        threadId: THREAD_ID,
      },
      transport: incompatibleTransport,
      writesEnabled: true,
    }),
    (error) => assertConnectorError(error, "INVALID_CONFIGURATION"),
  );
  assert.equal(incompatibleTransport.sent.length, 0);

  await connector.close();
});

test("monitor-only connectors can observe but can never start a turn", async () => {
  const current = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      }
    },
    { writesEnabled: false },
  );
  const connector = await current.connect();

  assert.equal(connector.observation().writeBlockCode, "WRITES_DISABLED");
  await observeRoute(connector);
  const resumed = await connector.resumeThread(connector.guard());
  assert.equal(resumed.connection, "ready");
  assert.equal(resumed.routeStatus, "idle");
  assert.equal(resumed.writableReady, false);
  assert.equal(resumed.writeBlockCode, "WRITES_DISABLED");

  await assert.rejects(
    connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-monitor-only",
      text: "must never be written",
    }),
    (error) => assertConnectorError(error, "WRITES_DISABLED"),
  );
  assert.equal(requestMethods(current.transport).includes("turn/start"), false);

  await connector.close();
});

test("observes and resumes only the exact opted-in thread", async () => {
  const { connect, events, transport } = fixture((message, fake) => {
    if (message.method === "thread/loaded/list") {
      fake.respond(message, { data: ["thread-other", THREAD_ID] });
    } else if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          preview: "must be discarded",
          status: { type: "idle" },
          turns: [],
        },
      });
    }
  });
  const connector = await connect();

  const staleGuard = connector.guard();
  const loaded = await connector.observeLoadedThread(staleGuard);
  assert.deepEqual(loaded, {
    loadedThreadCount: 2,
    observation: {
      connection: "ready",
      eventSequence: 3,
      hasActiveTurn: false,
      queueDepth: 0,
      requestInFlight: false,
      routeStatus: "unknown",
      writableReady: true,
      writeBlockCode: null,
    },
    selectedThreadLoaded: true,
  });
  assert.equal(JSON.stringify(loaded).includes(THREAD_ID), false);
  await assert.rejects(
    connector.resumeThread(staleGuard),
    (error) => assertConnectorError(error, "ROUTE_CAS_MISMATCH"),
  );
  const resumed = await connector.resumeThread(connector.guard());
  assert.equal(resumed.routeStatus, "idle");
  assert.equal(resumed.requestInFlight, false);
  assert.equal(resumed.writableReady, true);
  assert.equal(resumed.writeBlockCode, null);
  const resumeFrame = transport.sent.find(
    (message) => message.method === "thread/resume",
  );
  assert.deepEqual(resumeFrame?.params, {
    excludeTurns: true,
    threadId: THREAD_ID,
  });
  assert.equal(JSON.stringify(events).includes(THREAD_ID), false);
  assert.equal(JSON.stringify(events).includes("must be discarded"), false);
  assert.equal(JSON.stringify(events).includes(WORKSPACE_CWD), false);

  await connector.close();
});

test("refreshes the exact task but leaves changed native policy and workspace to Codex", async () => {
  let resumeCall = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCall += 1;
      fake.respond(message, {
        approvalPolicy:
          resumeCall === 1 ? SAFE_APPROVAL_POLICY : "on-request",
        cwd: resumeCall === 1 ? WORKSPACE_CWD : "/workspace/changed-project",
        sandbox:
          resumeCall === 1
            ? SAFE_SANDBOX
            : { networkAccess: true, type: "workspaceWrite" },
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-native-policy", status: "inProgress" },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  const disposition = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-native-policy",
    text: "use the task's existing native policy",
  });
  assert.equal(disposition.disposition, "started");
  assert.equal(resumeCall, 2);
  assert.equal(requestMethods(current.transport).includes("turn/start"), true);
  assert.equal(connector.observation().connection, "ready");
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().writeBlockCode, null);
  const start = current.transport.sent.find(
    (message) => message.method === "turn/start",
  );
  assert.deepEqual(start?.params, {
    input: [{ text: "use the task's existing native policy", type: "text" }],
    threadId: THREAD_ID,
  });
  assert.equal(JSON.stringify(current.events).includes("changed-project"), false);
  await connector.close();
});

test("rejects nonempty suppressed history before a start", async () => {
  const historySentinel = "SUPPRESSED_HISTORY_MUST_NOT_ESCAPE";
  let resumeCall = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCall += 1;
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          status: { type: "idle" },
          turns:
            resumeCall === 1
              ? []
              : [{ items: [{ text: historySentinel }] }],
        },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  let caught: unknown;
  await assert.rejects(
    connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-history-suppression-failed",
      text: "must not start if suppression is violated",
    }),
    (error) => {
      caught = error;
      return assertConnectorError(error, "RESULT_SCHEMA_MISMATCH");
    },
  );
  assert.equal(resumeCall, 2);
  assert.equal(requestMethods(current.transport).includes("turn/start"), false);
  assert.equal(connector.observation().connection, "faulted");
  assert.equal(
    JSON.stringify({
      error: String(caught),
      events: current.events,
      observation: connector.observation(),
      replies: current.replies,
    }).includes(historySentinel),
    false,
  );
});

test("settings updates preserve native reachability and exact-owned interruption", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-owned-before-settings-drift", status: "inProgress" },
      });
    } else if (message.method === "turn/interrupt") {
      fake.respond(message, {});
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-before-settings-drift",
    text: "owned turn",
  });

  current.transport.emit({
    method: "thread/settings/updated",
    params: {
      threadId: THREAD_ID,
      threadSettings: {
        approvalPolicy: "on-request",
        cwd: "/private/path-that-must-not-be-retained",
        sandboxPolicy: { type: "workspaceWrite" },
      },
    },
  });
  assert.equal(connector.observation().writeBlockCode, null);

  const interrupted = await connector.interruptOwnedTurn(connector.guard());
  assert.equal(interrupted.routeStatus, "interrupting");
  const interrupt = current.transport.sent.find(
    (message) => message.method === "turn/interrupt",
  );
  assert.deepEqual(interrupt?.params, {
    threadId: THREAD_ID,
    turnId: "turn-owned-before-settings-drift",
  });
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  assert.equal(
    JSON.stringify(current.events).includes(
      "/private/path-that-must-not-be-retained",
    ),
    false,
  );
  await connector.close();
});

test("rejects stale endpoint identities and stale status/turn CAS guards", async () => {
  const { connect, transport } = fixture();
  const connector = await connect();
  const initial = connector.guard();
  const sentBefore = transport.sent.length;

  await assert.rejects(
    connector.observeLoadedThread({
      ...initial,
      endpointGeneration: "different-generation",
    }),
    (error) => assertConnectorError(error, "STALE_ENDPOINT"),
  );
  await assert.rejects(
    connector.observeLoadedThread({ ...initial, threadId: "thread-other" }),
    (error) => assertConnectorError(error, "STALE_ENDPOINT"),
  );
  assert.equal(transport.sent.length, sentBefore);

  transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await assert.rejects(
    connector.submitMessage(initial, {
      deadlineAt: futureDeadline(),
      messageId: "message-1",
      text: "hello",
    }),
    (error) => assertConnectorError(error, "ROUTE_CAS_MISMATCH"),
  );
  await assert.rejects(
    connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-not-observed",
      text: "must not load a stored task implicitly",
    }),
    (error) => assertConnectorError(error, "THREAD_NOT_OBSERVED"),
  );

  await connector.close();
  await assert.rejects(
    connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-2",
      text: "never send",
    }),
    (error) => assertConnectorError(error, "CONNECTOR_CLOSED"),
  );
});

test("queues by default while active or awaiting approval and never answers approvals", async () => {
  const { connect, events, replies, transport } = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          status: { activeFlags: ["waitingOnApproval"], type: "active" },
          turns: [],
        },
      });
    }
  });
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  const first = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-active-1",
    text: "sensitive queued prompt one",
  });
  assert.equal(first.disposition, "queued");
  assert.equal(requestMethods(transport).includes("turn/start"), false);

  const sentBeforeApproval = transport.sent.length;
  transport.emit({
    id: "server-request-1",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "sensitive command",
      threadId: THREAD_ID,
      turnId: "turn-external-1",
    },
  });
  assert.equal(transport.sent.length, sentBeforeApproval);
  assert.equal(connector.observation().routeStatus, "waiting_approval");

  const second = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-active-2",
    text: "sensitive queued prompt two",
  });
  assert.equal(second.disposition, "queued");
  assert.equal(connector.observation().queueDepth, 2);
  assert.equal(JSON.stringify(events).includes("sensitive queued prompt"), false);
  assert.equal(JSON.stringify(events).includes("sensitive command"), false);

  await transport.close();
  assert.deepEqual(connector.observation(), {
    connection: "closed",
    eventSequence: connector.observation().eventSequence,
    hasActiveTurn: false,
    queueDepth: 0,
    requestInFlight: false,
    routeStatus: "stale",
    writableReady: false,
    writeBlockCode: null,
  });
  assert.equal(requestMethods(transport).includes("turn/start"), false);
  assert.deepEqual(replies, [
    {
      messageId: "message-active-1",
      outcome: "abandoned",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
    {
      messageId: "message-active-2",
      outcome: "abandoned",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);
});

test("external approval completion releases queued work without answering approval", async () => {
  let resumeCalls = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCalls += 1;
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          status:
            resumeCalls === 1
              ? { activeFlags: ["waitingOnApproval"], type: "active" }
              : { type: "idle" },
          turns: [],
        },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-after-external-approval", status: "inProgress" },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  const queued = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-after-external-approval",
    text: "start after the external approval turn finishes",
  });
  assert.equal(queued.disposition, "queued");

  current.transport.emit({
    id: "external-approval-request",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "external command",
      threadId: THREAD_ID,
      turnId: "turn-external-approval",
    },
  });
  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await delayImmediate();
  assert.equal(requestMethods(current.transport).includes("turn/start"), false);

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-approval", status: "completed" },
    },
  });
  await delayImmediate();

  assert.equal(resumeCalls, 2);
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  assert.equal(
    current.transport.sent.some(
      (message) => message.id === "external-approval-request",
    ),
    false,
  );
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 0);
  await connector.close();
});

test("delayed external idle cannot overlap an owned start in flight", async () => {
  let resumeCalls = 0;
  let startCalls = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCalls += 1;
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          status:
            resumeCalls === 1
              ? { activeFlags: ["waitingOnApproval"], type: "active" }
              : { type: "idle" },
          turns: [],
        },
      });
    } else if (message.method === "turn/start") {
      startCalls += 1;
      if (startCalls === 1) {
        return;
      }
      fake.respond(message, {
        turn: { id: "turn-owned-after-race-2", status: "inProgress" },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  current.transport.emit({
    id: "external-approval-race-request",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "external command",
      threadId: THREAD_ID,
      turnId: "turn-external-before-start-race",
    },
  });
  for (const [messageId, text] of [
    ["message-after-external-race-1", "first queued message"],
    ["message-after-external-race-2", "second queued message"],
  ] as const) {
    const queued = await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId,
      text,
    });
    assert.equal(queued.disposition, "queued");
  }

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-before-start-race", status: "completed" },
    },
  });
  await delayImmediate();

  const firstStartRequest = current.transport.sent.find(
    (message) => message.method === "turn/start",
  );
  assert.notEqual(firstStartRequest, undefined);
  if (firstStartRequest === undefined) {
    throw new Error("expected the first turn/start request");
  }
  assert.equal(startCalls, 1);
  assert.equal(connector.observation().requestInFlight, true);
  assert.equal(connector.observation().routeStatus, "starting");
  assert.equal(connector.observation().queueDepth, 1);

  // This belongs to the just-completed external turn. It arrives only after
  // Embassy has claimed the first queued message and sent turn/start, but
  // before the response supplies Embassy's owned turn ID.
  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await delayImmediate();

  assert.equal(startCalls, 1);
  assert.equal(connector.observation().requestInFlight, true);
  assert.equal(connector.observation().routeStatus, "starting");
  assert.equal(connector.observation().queueDepth, 1);

  current.transport.respond(firstStartRequest, {
    turn: { id: "turn-owned-after-race-1", status: "inProgress" },
  });
  await delayImmediate();

  assert.equal(startCalls, 1);
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 1);

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-after-race-1", status: "completed" },
    },
  });
  await delayImmediate();

  assert.equal(startCalls, 2);
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 0);
  const starts = current.transport.sent.filter(
    (message) => message.method === "turn/start",
  );
  assert.deepEqual(
    starts.map((message) => message.params),
    [
      {
        input: [{ text: "first queued message", type: "text" }],
        threadId: THREAD_ID,
      },
      {
        input: [{ text: "second queued message", type: "text" }],
        threadId: THREAD_ID,
      },
    ],
  );
  assert.equal(
    current.transport.sent.some(
      (message) => message.id === "external-approval-race-request",
    ),
    false,
  );

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-after-race-2", status: "completed" },
    },
  });
  await delayImmediate();
  assert.equal(connector.observation().routeStatus, "idle");

  await connector.close();
});

test("delayed external idle cannot invalidate a reserved start refresh", async () => {
  let resumeCalls = 0;
  let startCalls = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCalls += 1;
      if (resumeCalls === 2) return;
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: {
          id: THREAD_ID,
          status:
            resumeCalls === 1
              ? { activeFlags: ["waitingOnApproval"], type: "active" }
              : { type: "idle" },
          turns: [],
        },
      });
    } else if (message.method === "turn/start") {
      startCalls += 1;
      fake.respond(message, {
        turn: {
          id: `turn-owned-after-refresh-race-${startCalls}`,
          status: "inProgress",
        },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  current.transport.emit({
    id: "external-refresh-race-request",
    method: "item/commandExecution/requestApproval",
    params: {
      command: "external command",
      threadId: THREAD_ID,
      turnId: "turn-external-before-refresh-race",
    },
  });
  for (const [messageId, text] of [
    ["message-after-refresh-race-1", "first refresh-race message"],
    ["message-after-refresh-race-2", "second refresh-race message"],
  ] as const) {
    const queued = await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId,
      text,
    });
    assert.equal(queued.disposition, "queued");
  }

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-before-refresh-race", status: "completed" },
    },
  });
  await delayImmediate();

  const heldRefreshRequest = current.transport.sent.filter(
    (message) => message.method === "thread/resume",
  )[1];
  assert.notEqual(heldRefreshRequest, undefined);
  if (heldRefreshRequest === undefined) {
    throw new Error("expected the reserved start's refresh request");
  }
  assert.equal(startCalls, 0);
  assert.equal(connector.observation().requestInFlight, true);
  assert.equal(connector.observation().routeStatus, "starting");
  assert.equal(connector.observation().queueDepth, 1);

  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await delayImmediate();

  assert.equal(startCalls, 0);
  assert.equal(connector.observation().requestInFlight, true);
  assert.equal(connector.observation().routeStatus, "starting");
  assert.equal(connector.observation().queueDepth, 1);

  current.transport.respond(heldRefreshRequest, {
    approvalPolicy: SAFE_APPROVAL_POLICY,
    cwd: WORKSPACE_CWD,
    sandbox: SAFE_SANDBOX,
    thread: {
      id: THREAD_ID,
      status: { type: "idle" },
      turns: [],
    },
  });
  await delayImmediate();

  assert.equal(startCalls, 1);
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 1);

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-after-refresh-race-1", status: "completed" },
    },
  });
  await delayImmediate();

  assert.equal(startCalls, 2);
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 0);
  const starts = current.transport.sent.filter(
    (message) => message.method === "turn/start",
  );
  assert.deepEqual(
    starts.map((message) => message.params),
    [
      {
        input: [{ text: "first refresh-race message", type: "text" }],
        threadId: THREAD_ID,
      },
      {
        input: [{ text: "second refresh-race message", type: "text" }],
        threadId: THREAD_ID,
      },
    ],
  );
  assert.equal(
    current.transport.sent.some(
      (message) => message.id === "external-refresh-race-request",
    ),
    false,
  );

  current.transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-after-refresh-race-2", status: "completed" },
    },
  });
  await delayImmediate();
  assert.equal(connector.observation().routeStatus, "idle");
  assert.deepEqual(
    current.replies.map(({ messageId, outcome }) => ({ messageId, outcome })),
    [
      { messageId: "message-after-refresh-race-1", outcome: "completed" },
      { messageId: "message-after-refresh-race-2", outcome: "completed" },
    ],
  );

  await connector.close();
});

test("queued work refreshes the exact route after an external turn", async () => {
  let resumeCalls = 0;
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      resumeCalls += 1;
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-after-external-refresh", status: "inProgress" },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "active" }, threadId: THREAD_ID },
  });
  const queued = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-after-external-turn",
    text: "start only after a fresh exact-thread boundary",
  });
  assert.equal(queued.disposition, "queued");
  assert.equal(requestMethods(current.transport).includes("turn/start"), false);

  current.transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-before-drain", status: "inProgress" },
    },
  });
  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await delayImmediate();

  assert.equal(resumeCalls, 2);
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().queueDepth, 0);
  await connector.close();
});

test("starts one turn, queues the next, and drains only after correlated completion", async () => {
  let turnCounter = 0;
  const { connect, events, transport } = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      turnCounter += 1;
      fake.respond(message, {
        turn: {
          error: null,
          id: `turn-owned-${turnCounter}`,
          items: [{ secret: "discard result items" }],
          status: "inProgress",
        },
      });
    }
  });
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  const first = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-owned-1",
    text: "private first prompt",
  });
  assert.equal(first.disposition, "started");
  assert.equal(connector.observation().routeStatus, "active");

  const second = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-owned-2",
    text: "private second prompt",
  });
  assert.equal(second.disposition, "queued");
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );

  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-1", status: "completed" },
    },
  });
  await delayImmediate();
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    2,
  );
  const starts = transport.sent.filter(
    (message) => message.method === "turn/start",
  );
  const resumes = transport.sent.filter(
    (message) => message.method === "thread/resume",
  );
  assert.equal(resumes.length, 3);
  for (const resume of resumes) {
    assert.deepEqual(resume.params, {
      excludeTurns: true,
      threadId: THREAD_ID,
    });
  }
  assert.deepEqual(starts.map((message) => message.params), [
    {
      input: [{ text: "private first prompt", type: "text" }],
      threadId: THREAD_ID,
    },
    {
      input: [{ text: "private second prompt", type: "text" }],
      threadId: THREAD_ID,
    },
  ]);
  assert.equal(JSON.stringify(events).includes("private first prompt"), false);
  assert.equal(JSON.stringify(events).includes("private second prompt"), false);
  assert.equal(JSON.stringify(events).includes("discard result items"), false);
  assert.equal(JSON.stringify(events).includes("turn-owned"), false);

  await connector.close();
});

test("expires queued work before a later idle transition without starting it", async () => {
  let nowMs = Date.parse("2040-01-01T00:00:00.000Z");
  const current = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "active" }, turns: [] },
        });
      }
    },
    {
      maxDeadlineMs: 1_000,
      now: () => new Date(nowMs),
    },
  );
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  const deadlineAt = new Date(nowMs + 100).toISOString();
  const queued = await connector.submitMessage(connector.guard(), {
    deadlineAt,
    messageId: "message-expiring-in-queue",
    text: "must expire before idle",
  });
  assert.equal(queued.disposition, "queued");

  nowMs += 101;
  current.transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });
  await delayImmediate();

  assert.equal(requestMethods(current.transport).includes("turn/start"), false);
  assert.equal(connector.observation().queueDepth, 0);
  assert.deepEqual(current.replies, [
    {
      messageId: "message-expiring-in-queue",
      outcome: "expired",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);
  await connector.close();
});

test("cancel or close wins the completion-to-drain microtask race", async () => {
  for (const release of ["cancel", "close"] as const) {
    const current = fixture((message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      } else if (message.method === "turn/start") {
        fake.respond(message, {
          turn: { id: `turn-drain-race-${release}`, status: "inProgress" },
        });
      }
    });
    const connector = await current.connect();
    await observeRoute(connector);
    await connector.resumeThread(connector.guard());
    await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: `message-drain-active-${release}`,
      text: "first turn",
    });
    await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: `message-drain-queued-${release}`,
      text: "must remain cancellation-visible",
    });

    current.transport.emit({
      method: "turn/completed",
      params: {
        threadId: THREAD_ID,
        turn: { id: `turn-drain-race-${release}`, status: "completed" },
      },
    });
    if (release === "cancel") {
      connector.cancelQueuedMessages(connector.guard());
    } else {
      await connector.close();
    }
    await delayImmediate();

    assert.equal(
      current.transport.sent.filter((message) => message.method === "turn/start")
        .length,
      1,
    );
    assert.deepEqual(current.replies, [
      {
        messageId: `message-drain-active-${release}`,
        outcome: "completed",
        replyCode: "REPLY_UNAVAILABLE",
        text: null,
      },
      {
        messageId: `message-drain-queued-${release}`,
        outcome: "abandoned",
        replyCode: "REPLY_UNAVAILABLE",
        text: null,
      },
    ]);
    if (release === "cancel") await connector.close();
  }
});

test("hands off only a bounded final agent reply for the correlated owned message", async () => {
  const { connect, events, replies, transport } = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      } else if (message.method === "turn/start") {
        fake.respond(message, {
          turn: { id: "turn-reply-1", status: "inProgress" },
        });
      }
    },
    { maxReplyBytes: 48 },
  );
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-reply-1",
    text: "ask for a short answer",
  });

  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-wrong-thread",
        phase: "final_answer",
        text: "wrong thread result",
        type: "agentMessage",
      },
      threadId: "thread-other",
      turnId: "turn-reply-1",
    },
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-other",
      turn: { id: "turn-reply-1", status: "completed" },
    },
  });
  assert.equal(replies.length, 0);
  assert.equal(connector.observation().routeStatus, "active");
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-wrong-turn",
        phase: "final_answer",
        text: "wrong turn result",
        type: "agentMessage",
      },
      threadId: THREAD_ID,
      turnId: "turn-other",
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-command",
        aggregatedOutput: "must never be relayed",
        type: "commandExecution",
      },
      threadId: THREAD_ID,
      turnId: "turn-reply-1",
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-commentary",
        phase: "commentary",
        text: "private commentary",
        type: "agentMessage",
      },
      threadId: THREAD_ID,
      turnId: "turn-reply-1",
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      item: {
        id: "item-final",
        phase: "final_answer",
        text: "A short safe result.",
        type: "agentMessage",
      },
      threadId: THREAD_ID,
      turnId: "turn-reply-1",
    },
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-reply-1", status: "completed" },
    },
  });

  assert.deepEqual(replies, [
    {
      messageId: "message-reply-1",
      outcome: "completed",
      replyCode: null,
      text: "A short safe result.",
    },
  ]);
  assert.equal(JSON.stringify(events).includes("A short safe result"), false);
  assert.equal(JSON.stringify(events).includes("private commentary"), false);
  assert.equal(JSON.stringify(events).includes("must never be relayed"), false);
  assert.equal(JSON.stringify(replies).includes("wrong turn result"), false);
  assert.equal(JSON.stringify(replies).includes("wrong thread result"), false);

  await connector.close();
});

test("faults closed when owned turn or final-item notifications omit route correlation", async () => {
  const malformedNotifications = [
    {
      method: "turn/started",
      params: { turn: { id: "turn-correlation", status: "inProgress" } },
    },
    {
      method: "turn/completed",
      params: { turn: { id: "turn-correlation", status: "completed" } },
    },
    {
      method: "item/completed",
      params: {
        item: {
          phase: "final_answer",
          text: "must not escape without correlation",
          type: "agentMessage",
        },
      },
    },
  ];

  for (const [index, notification] of malformedNotifications.entries()) {
    const current = fixture((message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      } else if (message.method === "turn/start") {
        fake.respond(message, {
          turn: { id: "turn-correlation", status: "inProgress" },
        });
      }
    });
    const connector = await current.connect();
    await observeRoute(connector);
    await connector.resumeThread(connector.guard());
    await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: `message-correlation-${index}`,
      text: "correlation test",
    });

    current.transport.emit(notification);
    assert.equal(connector.observation().connection, "faulted");
    assert.equal(connector.observation().routeStatus, "stale");
    assert.deepEqual(current.replies, [
      {
        messageId: `message-correlation-${index}`,
        outcome: "ambiguous",
        replyCode: "REPLY_UNAVAILABLE",
        text: null,
      },
    ]);
    assert.equal(
      JSON.stringify(current.events).includes(
        "must not escape without correlation",
      ),
      false,
    );
  }
});

test("drops oversized final replies and returns only a safe reply code", async () => {
  const { connect, events, replies, transport } = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      } else if (message.method === "turn/start") {
        fake.respond(message, {
          turn: { id: "turn-large-reply", status: "inProgress" },
        });
      }
    },
    { maxReplyBytes: 8 },
  );
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-large-reply",
    text: "answer",
  });
  const oversized = "this reply is too large";
  transport.emit({
    method: "item/completed",
    params: {
      item: { phase: "final_answer", text: oversized, type: "agentMessage" },
      threadId: THREAD_ID,
      turnId: "turn-large-reply",
    },
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-large-reply", status: "completed" },
    },
  });

  assert.deepEqual(replies, [
    {
      messageId: "message-large-reply",
      outcome: "completed",
      replyCode: "REPLY_TOO_LARGE",
      text: null,
    },
  ]);
  assert.equal(JSON.stringify(events).includes(oversized), false);
  await connector.close();
});

test("interrupts only an exact connector-owned active turn and clears queued work", async () => {
  const { connect, replies, transport } = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-owned-interrupt", status: "inProgress" },
      });
    } else if (message.method === "turn/interrupt") {
      fake.respond(message, {});
    }
  });
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external", status: "inProgress" },
    },
  });
  await assert.rejects(
    connector.interruptOwnedTurn(connector.guard()),
    (error) => assertConnectorError(error, "TURN_NOT_OWNED"),
  );
  assert.equal(requestMethods(transport).includes("turn/interrupt"), false);
  transport.emit({
    method: "thread/status/changed",
    params: { status: { type: "idle" }, threadId: THREAD_ID },
  });

  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-interrupt-1",
    text: "owned turn",
  });
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-after-interrupt",
    text: "queued turn to clear",
  });
  assert.equal(connector.observation().queueDepth, 1);

  const interrupted = await connector.interruptOwnedTurn(connector.guard());
  assert.equal(interrupted.routeStatus, "interrupting");
  assert.equal(interrupted.queueDepth, 0);
  assert.equal(interrupted.requestInFlight, false);
  const interruptFrame = transport.sent.find(
    (message) => message.method === "turn/interrupt",
  );
  assert.deepEqual(interruptFrame?.params, {
    threadId: THREAD_ID,
    turnId: "turn-owned-interrupt",
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-owned-interrupt", status: "interrupted" },
    },
  });
  await delayImmediate();
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  assert.deepEqual(replies, [
    {
      messageId: "message-after-interrupt",
      outcome: "abandoned",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
    {
      messageId: "message-interrupt-1",
      outcome: "interrupted",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);

  await connector.close();
});

test("faults on uncorrelated responses and never retries an ambiguous turn start", async () => {
  const uncorrelated = fixture();
  const firstConnector = await uncorrelated.connect();
  const pending = firstConnector.observeLoadedThread(firstConnector.guard());
  uncorrelated.transport.emit({ id: 999_999, result: { data: [] } });
  await assert.rejects(
    pending,
    (error) => assertConnectorError(error, "PROTOCOL_ERROR"),
  );
  assert.equal(firstConnector.observation().connection, "faulted");
  assert.equal(firstConnector.observation().routeStatus, "stale");

  const timeout = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          approvalPolicy: SAFE_APPROVAL_POLICY,
          cwd: WORKSPACE_CWD,
          sandbox: SAFE_SANDBOX,
          thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
        });
      }
      // Deliberately do not answer turn/start: its delivery is ambiguous.
    },
    { requestTimeoutMs: 10 },
  );
  const secondConnector = await timeout.connect();
  await observeRoute(secondConnector);
  await secondConnector.resumeThread(secondConnector.guard());
  await assert.rejects(
    secondConnector.submitMessage(secondConnector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-timeout",
      text: "send exactly once",
    }),
    (error) =>
      assertConnectorError(error, "REQUEST_TIMEOUT") &&
      (error as CodexConnectorError).ambiguous,
  );
  assert.equal(secondConnector.observation().routeStatus, "uncertain");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    timeout.transport.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  assert.deepEqual(timeout.replies, [
    {
      messageId: "message-timeout",
      outcome: "ambiguous",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);
  await secondConnector.close();
});

test("blocks method smuggling and faults on malformed targeted notifications", async () => {
  const { connect, events, transport } = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: { id: "turn-smuggling", status: "inProgress" },
      });
    }
  });
  const connector = await connect();

  const sentBeforeUnknownServerRequest = transport.sent.length;
  transport.emit({
    id: "server-unknown",
    method: "thread/list",
    params: { includeHistory: true },
  });
  assert.equal(transport.sent.length, sentBeforeUnknownServerRequest);
  assert.equal(events.at(-1)?.kind, "server_request_ignored");

  const hiddenRequest = connector as unknown as {
    request: (method: string, params: WireRecord) => Promise<unknown>;
  };
  await assert.rejects(
    hiddenRequest.request("thread/list", {}),
    (error) => assertConnectorError(error, "METHOD_NOT_ALLOWED"),
  );
  assert.equal(requestMethods(transport).includes("thread/list"), false);

  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  const injectedText =
    'hello"}],"method":"thread/archive","params":{"threadId":"other"}';
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-smuggling",
    text: injectedText,
  });
  const turnFrame = transport.sent.find(
    (message) => message.method === "turn/start",
  );
  assert.equal(turnFrame?.method, "turn/start");
  assert.deepEqual(turnFrame?.params, {
    input: [{ text: injectedText, type: "text" }],
    threadId: THREAD_ID,
  });
  assert.equal(requestMethods(transport).includes("thread/archive"), false);

  transport.emit({
    method: "thread/status/changed",
    params: { status: { activeFlags: "not-an-array", type: "active" }, threadId: THREAD_ID },
  });
  assert.equal(connector.observation().connection, "faulted");
  assert.equal(connector.observation().routeStatus, "stale");
});

test("unsubscribes only an idle exact route and rejects response schema drift", async () => {
  const valid = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        approvalPolicy: SAFE_APPROVAL_POLICY,
        cwd: WORKSPACE_CWD,
        sandbox: SAFE_SANDBOX,
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "thread/unsubscribe") {
      fake.respond(message, { status: "unsubscribed" });
    }
  });
  const connector = await valid.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  const result = await connector.unsubscribeThread(connector.guard());
  assert.equal(result.status, "unsubscribed");
  assert.equal(result.observation.routeStatus, "not_loaded");
  assert.equal(result.observation.requestInFlight, false);
  await connector.close();

  const invalid = fixture((message, fake) => {
    if (message.method === "thread/loaded/list") {
      fake.respond(message, { data: [{ rawSecret: "discard" }] });
    }
  });
  const invalidConnector = await invalid.connect();
  await assert.rejects(
    invalidConnector.observeLoadedThread(invalidConnector.guard()),
    (error) => assertConnectorError(error, "RESULT_SCHEMA_MISMATCH"),
  );
  assert.equal(invalidConnector.observation().connection, "faulted");
  assert.equal(invalidConnector.observation().routeStatus, "stale");
});
