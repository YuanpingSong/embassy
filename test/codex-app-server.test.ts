import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { test } from "node:test";

import {
  CODEX_APP_SERVER_V1_METHODS,
  CODEX_PROBE_EFFORT,
  CODEX_PROBE_MODEL_PREFERENCE,
  CODEX_WRITE_PROBE_INPUT,
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
const STEERING_ATTESTATION = {
  method: "turn/steer",
  requestSchema: "expected-turn-id-text-v1",
  deliveryBoundary: "next-tool-call-boundary",
} as const;
const DEFAULT_PROBE_EFFORT = "low";

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
    appServerVersion?: string;
    maxDeadlineMs?: number;
    maxReplyBytes?: number;
    now?: () => Date;
    requestTimeoutMs?: number;
    turnWatchdogMs?: number;
    writesEnabled?: boolean;
    observedSchemaCandidate?: true;
    writeCompatibilityProbe?: true;
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
          appServerVersion: options.appServerVersion ?? "0.147.0",
          endpointGeneration: ENDPOINT_GENERATION,
          protocol: "app-server-v2-stable",
          ...(options.observedSchemaCandidate === true
            ? { observedSchemaCandidate: true as const }
            : {}),
          steering: STEERING_ATTESTATION,
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
        ...(options.turnWatchdogMs === undefined
          ? {}
          : { turnWatchdogMs: options.turnWatchdogMs }),
        route: {
          endpointGeneration: ENDPOINT_GENERATION,
          threadId: THREAD_ID,
        },
        transport,
        ...(options.writeCompatibilityProbe === true
          ? { writeCompatibilityProbe: true as const }
          : {}),
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

/**
 * Poll a real-timer outcome instead of sleeping for a fixed budget. Trigger
 * intervals stay short so the behaviour under test fires immediately, while the
 * observation deadline stays generous enough that a loaded runner cannot turn
 * late timer delivery into a failure.
 */
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

const PROBE_THREAD_ID = "019c0000-0000-7000-8000-000000000059";
const PROBE_TURN_ID = "turn-write-probe-1";

function unconstrainedRateLimits(
  overrides: Record<string, unknown> = {},
): WireRecord {
  return {
    rateLimits: {
      individualLimit: null,
      primary: null,
      rateLimitReachedType: null,
      secondary: null,
      spendControlReached: false,
      ...overrides,
    },
  };
}

function probeModelList(
  efforts: readonly string[] = ["high", DEFAULT_PROBE_EFFORT],
): WireRecord {
  return {
    data: [
      {
        hidden: false,
        model: CODEX_PROBE_MODEL_PREFERENCE[0],
        supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
          reasoningEffort,
        })),
      },
    ],
  };
}

function probeThreadStartResult(
  cwd: string,
  threadId = PROBE_THREAD_ID,
): WireRecord {
  return {
    approvalPolicy: "never",
    cwd,
    model: CODEX_PROBE_MODEL_PREFERENCE[0],
    runtimeWorkspaceRoots: [],
    sandbox: { type: "readOnly" },
    thread: {
      cwd,
      ephemeral: false,
      id: threadId,
      status: { type: "idle" },
      turns: [],
    },
  };
}

function emitProbeSettings(
  fake: FakeTransport,
  cwd: string,
  effort = DEFAULT_PROBE_EFFORT,
  threadId = PROBE_THREAD_ID,
): void {
  fake.emit({
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        collaborationMode: {
          mode: "default",
          settings: {
            model: CODEX_PROBE_MODEL_PREFERENCE[0],
            reasoning_effort: effort,
          },
        },
        cwd,
        effort,
        model: CODEX_PROBE_MODEL_PREFERENCE[0],
        modelProvider: "openai",
        sandboxPolicy: { networkAccess: false, type: "readOnly" },
      },
    },
  });
}

function emitSuccessfulProbeTurn(
  fake: FakeTransport,
  cwd: string,
  threadId = PROBE_THREAD_ID,
  turnId = PROBE_TURN_ID,
): void {
  fake.emit({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, items: [], status: "inProgress" },
    },
  });
  fake.emit({
    method: "item/started",
    params: {
      item: { type: "agentMessage" },
      startedAtMs: 1,
      threadId,
      turnId,
    },
  });
  fake.emit({
    method: "item/completed",
    params: {
      completedAtMs: 2,
      item: { type: "agentMessage" },
      threadId,
      turnId,
    },
  });
  fake.emit({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, items: [], status: "completed" },
    },
  });
  fake.emit({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      tokenUsage: { last: { totalTokens: 17 } },
      turnId,
    },
  });
}

type ProbeScenarioOptions = {
  archive?: SendHandler;
  loadedAfter?: unknown;
  loadedBefore?: unknown;
  model?: SendHandler;
  rateLimits?: SendHandler;
  settingsEffort?: string;
  threadStart?: SendHandler;
  turnStart?: SendHandler;
  unsubscribe?: SendHandler;
};

function probeScenarioHandler(
  cwd: string,
  options: ProbeScenarioOptions = {},
): SendHandler {
  let loadedCalls = 0;
  return async (message, fake) => {
    if (message.method === "account/rateLimits/read") {
      if (options.rateLimits !== undefined) {
        await options.rateLimits(message, fake);
      } else {
        fake.respond(message, unconstrainedRateLimits());
      }
    } else if (message.method === "model/list") {
      if (options.model !== undefined) await options.model(message, fake);
      else fake.respond(message, probeModelList());
    } else if (message.method === "thread/loaded/list") {
      loadedCalls += 1;
      fake.respond(
        message,
        loadedCalls === 1
          ? (options.loadedBefore ?? { data: [THREAD_ID] })
          : (options.loadedAfter ?? { data: [THREAD_ID] }),
      );
    } else if (message.method === "thread/start") {
      if (options.threadStart !== undefined) {
        await options.threadStart(message, fake);
      } else {
        emitProbeSettings(fake, cwd, options.settingsEffort);
        fake.respond(message, probeThreadStartResult(cwd));
      }
    } else if (message.method === "turn/start") {
      if (options.turnStart !== undefined) {
        await options.turnStart(message, fake);
      } else {
        emitSuccessfulProbeTurn(fake, cwd);
        fake.respond(message, {
          turn: { id: PROBE_TURN_ID, items: [], status: "completed" },
        });
      }
    } else if (message.method === "turn/interrupt") {
      fake.respond(message, {});
    } else if (message.method === "thread/archive") {
      if (options.archive !== undefined) await options.archive(message, fake);
      else fake.respond(message, {});
    } else if (message.method === "thread/unsubscribe") {
      if (options.unsubscribe !== undefined) {
        await options.unsubscribe(message, fake);
      } else {
        fake.respond(message, { status: "unsubscribed" });
      }
    }
  };
}

async function createProbeCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "emb59-connector-probe-"));
  await chmod(cwd, 0o700);
  return cwd;
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
  // Real socket timers: keep the trigger fast (ping at 50ms, unanswered pong
  // deadline 10ms later) but observe the outcome by polling, never by sleeping
  // for a fixed budget a loaded runner can overrun.
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
    "account/rateLimits/read",
    "model/list",
    "thread/archive",
    "thread/loaded/list",
    "thread/resume",
    "thread/start",
    "thread/unsubscribe",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ]);
  for (const forbidden of [
    "thread/list",
    "thread/read",
    "thread/delete",
    "thread/shellCommand",
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

  const coveredCandidate = fixture(undefined, {
    appServerVersion: "0.147.1",
    observedSchemaCandidate: true,
    writesEnabled: true,
  });
  const coveredConnector = await coveredCandidate.connect();
  assert.equal(coveredConnector.guard().writableReady, true);
  await coveredConnector.close();

  const incompatibleTransport = new FakeTransport(() => undefined);
  await assert.rejects(
    CodexAppServerConnector.connect({
      compatibility: {
        appServerVersion: "0.147.0",
        endpointGeneration: "different-generation",
        protocol: "app-server-v2-stable",
        steering: STEERING_ATTESTATION,
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
    fixture(undefined, {
      appServerVersion: "0.147.1-rc.1",
      observedSchemaCandidate: true,
      writesEnabled: true,
    }).connect(),
    (error) => assertConnectorError(error, "INVALID_CONFIGURATION"),
  );
  await assert.rejects(
    CodexAppServerConnector.connect({
      compatibility: {
        appServerVersion: "0.148.0",
        endpointGeneration: ENDPOINT_GENERATION,
        protocol: "app-server-v2-stable",
        steering: STEERING_ATTESTATION,
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
        appServerVersion: "0.147.0",
        endpointGeneration: ENDPOINT_GENERATION,
        protocol: "app-server-v2-stable",
        steering: {
          ...STEERING_ATTESTATION,
          deliveryBoundary: "mid-generation" as never,
        },
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

test("the bounded write probe pins policy, tolerates response races, and confirms cleanup", async (t) => {
  const cwd = await createProbeCwd();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const current = fixture(probeScenarioHandler(cwd), {
    writeCompatibilityProbe: true,
  });
  const connector = await current.connect();

  assert.deepEqual(CODEX_PROBE_EFFORT, [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  ]);

  const initialize = current.transport.sent[0]?.params as WireRecord;
  const capabilities = initialize.capabilities as WireRecord;
  assert.equal(
    (capabilities.optOutNotificationMethods as unknown[]).includes(
      "item/started",
    ),
    false,
  );
  const result = await connector.runWriteCompatibilityProbe({
    cwd,
    forbiddenThreadIds: [],
  });
  assert.deepEqual(result, {
    archivedThreadCount: 1,
    outcome: "pass",
    settingsEchoObserved: true,
    tokenCount: 17,
  });
  assert.equal(JSON.stringify(result).includes(PROBE_THREAD_ID), false);
  assert.equal(JSON.stringify(result).includes(CODEX_WRITE_PROBE_INPUT), false);
  assert.deepEqual(requestMethods(current.transport), [
    "initialize",
    "account/rateLimits/read",
    "model/list",
    "thread/loaded/list",
    "thread/start",
    "turn/start",
    "thread/archive",
    "thread/unsubscribe",
    "thread/loaded/list",
  ]);

  const request = (method: string) =>
    current.transport.sent.find((message) => message.method === method);
  assert.equal(request("account/rateLimits/read")?.params, null);
  assert.deepEqual(request("model/list")?.params, {
    includeHidden: true,
    limit: 100,
  });
  assert.deepEqual(request("thread/start")?.params, {
    allowProviderModelFallback: false,
    approvalPolicy: "never",
    cwd,
    dynamicTools: [],
    environments: [],
    ephemeral: false,
    model: CODEX_PROBE_MODEL_PREFERENCE[0],
    runtimeWorkspaceRoots: [],
    sandbox: "read-only",
    selectedCapabilityRoots: [],
  });
  assert.deepEqual(request("turn/start")?.params, {
    approvalPolicy: "never",
    cwd,
    effort: DEFAULT_PROBE_EFFORT,
    environments: [],
    input: [{ text: CODEX_WRITE_PROBE_INPUT, type: "text" }],
    model: CODEX_PROBE_MODEL_PREFERENCE[0],
    runtimeWorkspaceRoots: [],
    sandboxPolicy: { networkAccess: false, type: "readOnly" },
    threadId: PROBE_THREAD_ID,
  });
  assert.deepEqual(request("thread/archive")?.params, {
    threadId: PROBE_THREAD_ID,
  });

  const sentAfterFirstAttempt = current.transport.sent.length;
  assert.deepEqual(
    await connector.runWriteCompatibilityProbe({
      cwd,
      forbiddenThreadIds: [],
    }),
    {
      outcome: "fail",
      safeErrorCode: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
      settingsEchoObserved: false,
    },
  );
  assert.equal(current.transport.sent.length, sentAfterFirstAttempt);
  await connector.close();

  await t.test("records an absent settings echo without requiring it", async () => {
    const withoutEcho = fixture(
      probeScenarioHandler(cwd, {
        threadStart: (message, fake) =>
          fake.respond(message, probeThreadStartResult(cwd)),
      }),
      { writeCompatibilityProbe: true },
    );
    const withoutEchoConnector = await withoutEcho.connect();
    assert.deepEqual(
      await withoutEchoConnector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        archivedThreadCount: 1,
        outcome: "pass",
        settingsEchoObserved: false,
        tokenCount: 17,
      },
    );
    await withoutEchoConnector.close();
  });

  await t.test("rejects a settings echo that changes the selected effort", async () => {
    const mismatch = fixture(
      probeScenarioHandler(cwd, { settingsEffort: "high" }),
      { writeCompatibilityProbe: true },
    );
    const mismatchConnector = await mismatch.connect();
    assert.deepEqual(
      await mismatchConnector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        archivedThreadCount: 1,
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
        settingsEchoObserved: true,
      },
    );
    assert.equal(requestMethods(mismatch.transport).includes("turn/start"), false);
    await mismatchConnector.close();
  });
});

test("the write probe declines before creation at the reviewed quota and model boundaries", async (t) => {
  const rateCases: Array<[string, unknown]> = [
    [
      "reached flag",
      unconstrainedRateLimits({ rateLimitReachedType: "primary" }),
    ],
    ["spend control", unconstrainedRateLimits({ spendControlReached: true })],
    [
      "individual remainder",
      unconstrainedRateLimits({ individualLimit: { remainingPercent: 5 } }),
    ],
    ["primary window", unconstrainedRateLimits({ primary: { usedPercent: 95 } })],
    [
      "preferred Codex secondary window",
      {
        ...unconstrainedRateLimits(),
        rateLimitsByLimitId: {
          codex: {
            individualLimit: null,
            primary: null,
            rateLimitReachedType: null,
            secondary: { usedPercent: 95 },
            spendControlReached: false,
          },
        },
      },
    ],
  ];
  for (const [name, rateResult] of rateCases) {
    await t.test(name, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          rateLimits: (message, fake) => fake.respond(message, rateResult),
        }),
        { writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      assert.deepEqual(
        await connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        }),
        {
          outcome: "fail",
          safeErrorCode: "CODEX_WRITE_PROBE_RATE_LIMIT_CONSTRAINED",
          settingsEchoObserved: false,
        },
      );
      assert.equal(requestMethods(current.transport).includes("model/list"), false);
      assert.equal(requestMethods(current.transport).includes("thread/start"), false);
      await connector.close();
    });
  }

  const modelCases: Array<[string, SendHandler]> = [
    ["missing", (message, fake) => fake.respond(message, { data: [] })],
    [
      "hidden",
      (message, fake) =>
        fake.respond(message, {
          data: [
            {
              ...((probeModelList().data as WireRecord[])[0] ?? {}),
              hidden: true,
            },
          ],
        }),
    ],
    [
      "no recognized effort",
      (message, fake) =>
        fake.respond(message, {
          data: [
            {
              ...((probeModelList().data as WireRecord[])[0] ?? {}),
              supportedReasoningEfforts: [
                null,
                {},
                { reasoningEffort: "future" },
              ],
            },
          ],
        }),
    ],
    [
      "later duplicate cannot rescue the first visible row",
      (message, fake) =>
        fake.respond(message, {
          data: [
            {
              hidden: false,
              model: CODEX_PROBE_MODEL_PREFERENCE[0],
              supportedReasoningEfforts: [{ reasoningEffort: "future" }],
            },
            ...((probeModelList(["none"]).data as WireRecord[]) ?? []),
          ],
        }),
    ],
    ["RPC rejected", (message, fake) => fake.reject(message)],
  ];
  for (const [name, model] of modelCases) {
    await t.test(`model pin ${name}`, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(probeScenarioHandler(cwd, { model }), {
        writeCompatibilityProbe: true,
      });
      const connector = await current.connect();
      assert.deepEqual(
        await connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        }),
        {
          outcome: "fail",
          safeErrorCode: "CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE",
          settingsEchoObserved: false,
        },
      );
      assert.equal(requestMethods(current.transport).includes("thread/start"), false);
      await connector.close();
    });
  }

  const effortCases: Array<{
    expected: string;
    modelResult: WireRecord;
    name: string;
  }> = [
    {
      expected: "none",
      modelResult: probeModelList([...CODEX_PROBE_EFFORT].reverse()),
      name: "canonical order beats advertised order",
    },
    {
      expected: "high",
      modelResult: {
        data: [
          {
            hidden: false,
            model: "other-model",
            supportedReasoningEfforts: [{ reasoningEffort: "none" }],
          },
          {
            hidden: true,
            model: CODEX_PROBE_MODEL_PREFERENCE[0],
            supportedReasoningEfforts: [{ reasoningEffort: "none" }],
          },
          ...((probeModelList(["high"]).data as WireRecord[]) ?? []),
        ],
      },
      name: "unpinned and hidden rows cannot donate a cheaper effort",
    },
  ];
  for (const currentCase of effortCases) {
    await t.test(currentCase.name, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          model: (message, fake) =>
            fake.respond(message, currentCase.modelResult),
          settingsEffort: currentCase.expected,
        }),
        { writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      assert.equal(
        (await connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        })).outcome,
        "pass",
      );
      assert.equal(
        (current.transport.sent.find((message) =>
          message.method === "turn/start")?.params as WireRecord).effort,
        currentCase.expected,
      );
      await connector.close();
    });
  }
});

test("the write probe rejects reused identities and unproved fresh-thread fences", async (t) => {
  const cases: Array<{
    name: string;
    forbidden?: string[];
    loadedBefore?: unknown;
    result: (cwd: string) => WireRecord;
    archived: boolean;
  }> = [
    {
      name: "route sentinel",
      result: (cwd) => probeThreadStartResult(cwd, THREAD_ID),
      archived: false,
    },
    {
      name: "forbidden retained route",
      forbidden: [PROBE_THREAD_ID],
      result: (cwd) => probeThreadStartResult(cwd),
      archived: false,
    },
    {
      name: "already loaded identity",
      loadedBefore: { data: [THREAD_ID, PROBE_THREAD_ID] },
      result: (cwd) => probeThreadStartResult(cwd),
      archived: false,
    },
    {
      name: "non-v7 identity",
      result: (cwd) => probeThreadStartResult(cwd, "not-a-v7-identity"),
      archived: false,
    },
    {
      name: "already active thread",
      result: (cwd) => {
        const result = probeThreadStartResult(cwd);
        (result.thread as WireRecord).status = { type: "active" };
        return result;
      },
      archived: false,
    },
    {
      name: "ephemeral thread",
      result: (cwd) => {
        const result = probeThreadStartResult(cwd);
        (result.thread as WireRecord).ephemeral = true;
        return result;
      },
      archived: false,
    },
    {
      name: "network-enabled sandbox",
      result: (cwd) => ({
        ...probeThreadStartResult(cwd),
        sandbox: { networkAccess: true, type: "readOnly" },
      }),
      archived: false,
    },
  ];
  for (const currentCase of cases) {
    await t.test(currentCase.name, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          ...(currentCase.loadedBefore === undefined
            ? {}
            : { loadedBefore: currentCase.loadedBefore }),
          threadStart: (message, fake) =>
            fake.respond(message, currentCase.result(cwd)),
        }),
        { writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      const result = await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: currentCase.forbidden ?? [],
      });
      assert.deepEqual(result, {
        ...(currentCase.archived ? { archivedThreadCount: 1 } : {}),
        outcome: "fail",
        safeErrorCode: currentCase.archived
          ? "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED"
          : "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
        settingsEchoObserved: false,
      });
      assert.equal(requestMethods(current.transport).includes("turn/start"), false);
      assert.equal(
        requestMethods(current.transport).includes("thread/archive"),
        currentCase.archived,
      );
      await connector.close();
    });
  }
  await t.test("unrelated tool activity does not void probe evidence", async (t) => {
    const cwd = await createProbeCwd();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const current = fixture(
      probeScenarioHandler(cwd, {
        turnStart: (message, fake) => {
          fake.emit({
            method: "item/commandExecution/terminalInteraction",
            params: { threadId: THREAD_ID, turnId: PROBE_TURN_ID },
          });
          emitSuccessfulProbeTurn(fake, cwd);
          fake.respond(message, {
            turn: { id: PROBE_TURN_ID, items: [], status: "completed" },
          });
        },
      }),
      { writeCompatibilityProbe: true },
    );
    const connector = await current.connect();
    assert.deepEqual(
      await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        archivedThreadCount: 1,
        outcome: "pass",
        settingsEchoObserved: true,
        tokenCount: 17,
      },
    );
    await connector.close();
  });
});

test("targeted probe activity and out-of-order lifecycle frames fail before archival", async (t) => {
  const started = (fake: FakeTransport) =>
    fake.emit({
      method: "turn/started",
      params: {
        threadId: PROBE_THREAD_ID,
        turn: { id: PROBE_TURN_ID, items: [], status: "inProgress" },
      },
    });
  const completedItem = (fake: FakeTransport) =>
    fake.emit({
      method: "item/completed",
      params: {
        completedAtMs: 2,
        item: { type: "agentMessage" },
        threadId: PROBE_THREAD_ID,
        turnId: PROBE_TURN_ID,
      },
    });
  const completedTurn = (fake: FakeTransport) =>
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: PROBE_THREAD_ID,
        turn: { id: PROBE_TURN_ID, items: [], status: "completed" },
      },
    });
  const cases: Array<{
    code:
      | "CODEX_WRITE_PROBE_MODEL_REROUTED"
      | "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED"
      | "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED";
    emit: (fake: FakeTransport) => void;
    name: string;
  }> = [
    {
      name: "model reroute",
      code: "CODEX_WRITE_PROBE_MODEL_REROUTED",
      emit: (fake) => {
        started(fake);
        fake.emit({
          method: "model/rerouted",
          params: {
            fromModel: CODEX_PROBE_MODEL_PREFERENCE[0],
            reason: "highRiskCyberActivity",
            threadId: PROBE_THREAD_ID,
            toModel: "gpt-5.6-sol",
            turnId: PROBE_TURN_ID,
          },
        });
      },
    },
    {
      name: "model reroute with an unrelated thread id",
      code: "CODEX_WRITE_PROBE_MODEL_REROUTED",
      emit: (fake) => {
        started(fake);
        fake.emit({
          method: "model/rerouted",
          params: {
            fromModel: CODEX_PROBE_MODEL_PREFERENCE[0],
            reason: "highRiskCyberActivity",
            threadId: "unrelated-thread",
            toModel: "gpt-5.6-sol",
            turnId: PROBE_TURN_ID,
          },
        });
      },
    },
    {
      name: "model reroute with an unknown reason and no thread id",
      code: "CODEX_WRITE_PROBE_MODEL_REROUTED",
      emit: (fake) => {
        started(fake);
        fake.emit({
          method: "model/rerouted",
          params: {
            fromModel: CODEX_PROBE_MODEL_PREFERENCE[0],
            reason: "futureUnknownReason",
            toModel: "gpt-5.6-sol",
            turnId: PROBE_TURN_ID,
          },
        });
      },
    },
    {
      name: "tool item before turn start",
      code: "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED",
      emit: (fake) =>
        fake.emit({
          method: "item/started",
          params: {
            item: { type: "commandExecution" },
            startedAtMs: 1,
            threadId: PROBE_THREAD_ID,
            turnId: PROBE_TURN_ID,
          },
        }),
    },
    {
      name: "correlated server request",
      code: "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED",
      emit: (fake) =>
        fake.emit({
          id: "probe-server-request",
          method: "item/tool/call",
          params: { threadId: PROBE_THREAD_ID, turnId: PROBE_TURN_ID },
        }),
    },
    {
      name: "item completed before turn start",
      code: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
      emit: completedItem,
    },
    {
      name: "turn completed before item",
      code: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
      emit: (fake) => {
        started(fake);
        completedTurn(fake);
      },
    },
    {
      name: "duplicate turn start",
      code: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
      emit: (fake) => {
        started(fake);
        started(fake);
      },
    },
    {
      name: "passive item after terminal",
      code: "CODEX_WRITE_PROBE_THREAD_SETUP_FAILED",
      emit: (fake) => {
        started(fake);
        completedItem(fake);
        completedTurn(fake);
        fake.emit({
          method: "item/started",
          params: {
            item: { type: "reasoning" },
            startedAtMs: 3,
            threadId: PROBE_THREAD_ID,
            turnId: PROBE_TURN_ID,
          },
        });
      },
    },
  ];
  for (const currentCase of cases) {
    await t.test(currentCase.name, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          turnStart: (message, fake) => {
            currentCase.emit(fake);
            fake.respond(message, {
              turn: { id: PROBE_TURN_ID, items: [], status: "inProgress" },
            });
          },
        }),
        { writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      assert.deepEqual(
        await connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        }),
        {
          archivedThreadCount: 1,
          outcome: "fail",
          safeErrorCode: currentCase.code,
          settingsEchoObserved: true,
        },
      );
      const methods = requestMethods(current.transport);
      assert.ok(methods.indexOf("turn/interrupt") < methods.indexOf("thread/archive"));
      await connector.close();
    });
  }
});

test("cleanup uncertainty dominates earlier probe failures and late activity still voids a pass", async (t) => {
  const cleanupCases: Array<{
    archived: boolean;
    name: string;
    options: ProbeScenarioOptions;
  }> = [
    {
      name: "archive rejected",
      archived: false,
      options: { archive: (message, fake) => fake.reject(message) },
    },
    {
      name: "unsubscribe rejected",
      archived: true,
      options: { unsubscribe: (message, fake) => fake.reject(message) },
    },
    {
      name: "archived thread remains loaded",
      archived: true,
      options: { loadedAfter: { data: [THREAD_ID, PROBE_THREAD_ID] } },
    },
    {
      name: "loaded set remains paginated",
      archived: true,
      options: { loadedAfter: { data: [THREAD_ID], nextCursor: "more" } },
    },
  ];
  for (const currentCase of cleanupCases) {
    await t.test(currentCase.name, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          ...currentCase.options,
          turnStart: (message, fake) => {
            fake.emit({
              method: "turn/started",
              params: {
                threadId: PROBE_THREAD_ID,
                turn: {
                  id: PROBE_TURN_ID,
                  items: [],
                  status: "inProgress",
                },
              },
            });
            fake.emit({
              method: "model/rerouted",
              params: {
                fromModel: CODEX_PROBE_MODEL_PREFERENCE[0],
                reason: "highRiskCyberActivity",
                threadId: PROBE_THREAD_ID,
                toModel: "gpt-5.6-sol",
                turnId: PROBE_TURN_ID,
              },
            });
            fake.respond(message, {
              turn: { id: PROBE_TURN_ID, items: [], status: "inProgress" },
            });
          },
        }),
        { writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      assert.deepEqual(
        await connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        }),
        {
          ...(currentCase.archived ? { archivedThreadCount: 1 } : {}),
          outcome: "fail",
          safeErrorCode: "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
          settingsEchoObserved: true,
        },
      );
      await connector.close();
    });
  }

  await t.test("late terminal activity", async (t) => {
    const cwd = await createProbeCwd();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const current = fixture(
      probeScenarioHandler(cwd, {
        archive: (message, fake) => {
          fake.emit({
            method: "item/commandExecution/terminalInteraction",
            params: { threadId: PROBE_THREAD_ID, turnId: PROBE_TURN_ID },
          });
          fake.respond(message, {});
        },
      }),
      { writeCompatibilityProbe: true },
    );
    const connector = await current.connect();
    assert.deepEqual(
      await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        archivedThreadCount: 1,
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED",
        settingsEchoObserved: true,
        tokenCount: 17,
      },
    );
    await connector.close();
  });

  await t.test("late activity plus archive rejection", async (t) => {
    const cwd = await createProbeCwd();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const current = fixture(
      probeScenarioHandler(cwd, {
        archive: (message, fake) => {
          fake.emit({
            method: "item/commandExecution/terminalInteraction",
            params: { threadId: PROBE_THREAD_ID, turnId: PROBE_TURN_ID },
          });
          fake.reject(message);
        },
      }),
      { writeCompatibilityProbe: true },
    );
    const connector = await current.connect();
    assert.deepEqual(
      await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
        settingsEchoObserved: true,
        tokenCount: 17,
      },
    );
    await connector.close();
  });
});

test("the write probe rejects a cwd mutation despite an otherwise clean turn", async (t) => {
  const cwd = await createProbeCwd();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const current = fixture(
    probeScenarioHandler(cwd, {
      turnStart: async (message, fake) => {
        await writeFile(join(cwd, "unexpected"), "mutation");
        emitSuccessfulProbeTurn(fake, cwd);
        fake.respond(message, {
          turn: { id: PROBE_TURN_ID, items: [], status: "completed" },
        });
      },
    }),
    { writeCompatibilityProbe: true },
  );
  const connector = await current.connect();
  assert.deepEqual(
    await connector.runWriteCompatibilityProbe({
      cwd,
      forbiddenThreadIds: [],
    }),
    {
      archivedThreadCount: 1,
      outcome: "fail",
      safeErrorCode: "CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED",
      settingsEchoObserved: true,
      tokenCount: 17,
    },
  );
  await connector.close();
});

test("probe timeouts never retry creation and interrupt only an observed turn", async (t) => {
  await t.test("ambiguous thread creation", async (t) => {
    const cwd = await createProbeCwd();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const current = fixture(
      probeScenarioHandler(cwd, { threadStart: () => undefined }),
      { requestTimeoutMs: 10, writeCompatibilityProbe: true },
    );
    const connector = await current.connect();
    assert.deepEqual(
      await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
        settingsEchoObserved: false,
      },
    );
    const methods = requestMethods(current.transport);
    assert.equal(methods.filter((method) => method === "thread/start").length, 1);
    assert.equal(methods.includes("turn/interrupt"), false);
    assert.equal(methods.includes("thread/archive"), false);
    await connector.close();
  });

  await t.test("observed turn watchdog", async (t) => {
    const cwd = await createProbeCwd();
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const current = fixture(
      probeScenarioHandler(cwd, {
        turnStart: (message, fake) =>
          fake.respond(message, {
            turn: { id: PROBE_TURN_ID, items: [], status: "inProgress" },
          }),
      }),
      {
        requestTimeoutMs: 20,
        turnWatchdogMs: 5,
        writeCompatibilityProbe: true,
      },
    );
    const connector = await current.connect();
    assert.deepEqual(
      await connector.runWriteCompatibilityProbe({
        cwd,
        forbiddenThreadIds: [],
      }),
      {
        archivedThreadCount: 1,
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_TIMEOUT",
        settingsEchoObserved: true,
      },
    );
    const methods = requestMethods(current.transport);
    assert.ok(methods.indexOf("turn/interrupt") < methods.indexOf("thread/archive"));
    assert.equal(methods.filter((method) => method === "turn/start").length, 1);
    await connector.close();
  });

  for (const disconnect of ["error", "close"] as const) {
    await t.test(`connector ${disconnect} wakes the observed probe`, async (t) => {
      const cwd = await createProbeCwd();
      t.after(async () => rm(cwd, { recursive: true, force: true }));
      const current = fixture(
        probeScenarioHandler(cwd, {
          turnStart: (message, fake) => {
            fake.respond(message, {
              turn: { id: PROBE_TURN_ID, items: [], status: "inProgress" },
            });
            queueMicrotask(() => {
              if (disconnect === "error") fake.emitError();
              else void fake.close();
            });
          },
        }),
        { turnWatchdogMs: 10_000, writeCompatibilityProbe: true },
      );
      const connector = await current.connect();
      const result = await Promise.race([
        connector.runWriteCompatibilityProbe({
          cwd,
          forbiddenThreadIds: [],
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("probe wait did not wake")), 250),
        ),
      ]);
      assert.deepEqual(result, {
        outcome: "fail",
        safeErrorCode: "CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED",
        settingsEchoObserved: true,
      });
      assert.equal(
        requestMethods(current.transport).filter(
          (method) => method === "thread/start",
        ).length,
        1,
      );
      await connector.close();
    });
  }
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

test("an unpinned monitor candidate can never enable writes", async () => {
  const tested = fixture(undefined, {
    appServerVersion: "0.148.0",
    observedSchemaCandidate: true,
    writesEnabled: true,
  });
  await assert.rejects(
    tested.connect(),
    (error: unknown) => assertConnectorError(error, "INVALID_CONFIGURATION"),
  );
  assert.deepEqual(tested.transport.sent, []);
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

test("rejects duplicate exact loaded-thread claims before resume", async () => {
  const { connect, transport } = fixture((message, fake) => {
    if (message.method === "thread/loaded/list") {
      fake.respond(message, { data: [THREAD_ID, "thread-other", THREAD_ID] });
    }
  });
  const connector = await connect();

  await assert.rejects(
    connector.observeLoadedThread(connector.guard()),
    (error) => assertConnectorError(error, "RESULT_SCHEMA_MISMATCH"),
  );
  assert.equal(
    transport.sent.some((message) => message.method === "thread/resume"),
    false,
  );
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
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-before-drain", status: "completed" },
    },
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
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-before-drain", status: "completed" },
    },
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

test("steers only an exact observed active turn without interrupting it", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/steer") {
      fake.respond(message, { turnId: "turn-external-steer" });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  current.transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external-steer", status: "inProgress" },
    },
  });
  const result = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-steer-external",
    steer: true,
    text: "STEER: inspect the newest tool result",
  });

  assert.equal(result.disposition, "steered");
  assert.equal(connector.observation().routeStatus, "active");
  const steer = current.transport.sent.find(
    (message) => message.method === "turn/steer",
  );
  assert.deepEqual(steer?.params, {
    expectedTurnId: "turn-external-steer",
    input: [{ text: "STEER: inspect the newest tool result", type: "text" }],
    threadId: THREAD_ID,
  });
  assert.equal(requestMethods(current.transport).includes("turn/interrupt"), false);
  assert.equal(
    current.events.some((event) => event.kind === "turn_steered"),
    true,
  );

  await connector.close();
});

test("an item boundary reveals a pre-attach active turn for steering", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        thread: { id: THREAD_ID, status: { type: "active" }, turns: [] },
      });
    } else if (message.method === "turn/steer") {
      const params = message.params as { expectedTurnId?: unknown };
      fake.respond(message, { turnId: params.expectedTurnId });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(connector.observation().hasActiveTurn, false);
  assert.deepEqual(
    await connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-steer-before-item-boundary",
      steer: true,
      text: "STEER: wait for the first observed boundary",
    }),
    { disposition: "deferred", observation: connector.observation() },
  );
  assert.equal(
    current.transport.sent.some((message) => message.method === "turn/steer"),
    false,
  );

  current.transport.emit({
    method: "item/completed",
    params: {
      completedAtMs: 1,
      item: {
        output: "PRIVATE_ITEM_OUTPUT_MUST_NOT_BE_RETAINED",
        type: "commandExecution",
      },
      threadId: THREAD_ID,
      turnId: "turn-active-before-attach",
    },
  });

  assert.equal(connector.observation().hasActiveTurn, true);
  assert.equal(
    current.events.some(
      (event) =>
        event.kind === "turn_started" && event.hasActiveTurn === true,
    ),
    true,
  );
  assert.equal(
    JSON.stringify(current.events).includes(
      "PRIVATE_ITEM_OUTPUT_MUST_NOT_BE_RETAINED",
    ),
    false,
  );
  const result = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-steer-before-item-boundary",
    steer: true,
    text: "STEER: wait for the first observed boundary",
  });
  assert.equal(result.disposition, "steered");
  const steer = current.transport.sent.find(
    (message) => message.method === "turn/steer",
  );
  assert.deepEqual(steer?.params, {
    expectedTurnId: "turn-active-before-attach",
    input: [
      { text: "STEER: wait for the first observed boundary", type: "text" },
    ],
    threadId: THREAD_ID,
  });
  assert.equal(
    current.transport.sent.some(
      (message) => message.method === "turn/interrupt",
    ),
    false,
  );

  await connector.close();
});

test("an idle steering message starts an ordinary turn without invoking turn/steer", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/start") {
      fake.respond(message, {
        turn: {
          error: null,
          id: "turn-steer-idle-fallback",
          items: [],
          status: "inProgress",
        },
      });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());

  const result = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-steer-idle-fallback",
    steer: true,
    text: "STEER: start normally because no turn is active",
  });

  assert.equal(result.disposition, "started");
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/start")
      .length,
    1,
  );
  assert.equal(
    current.transport.sent.some((message) => message.method === "turn/steer"),
    false,
  );
  assert.equal(
    current.transport.sent.some(
      (message) => message.method === "turn/interrupt",
    ),
    false,
  );

  await connector.close();
});

test("falls back cleanly when an active turn cannot accept a steer", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/steer") {
      fake.reject(message);
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  current.transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-steer-rejected", status: "inProgress" },
    },
  });

  const rejected = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-steer-rejected",
    steer: true,
    text: "STEER: wait for the next boundary",
  });
  assert.equal(rejected.disposition, "deferred");
  assert.equal(connector.observation().connection, "ready");
  assert.equal(connector.observation().routeStatus, "active");
  assert.equal(requestMethods(current.transport).includes("turn/interrupt"), false);

  current.transport.emit({
    id: "approval-steer-fallback",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: THREAD_ID,
      turnId: "turn-steer-rejected",
    },
  });
  const approvalWait = await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-steer-approval-wait",
    steer: true,
    text: "STEER: this stays queued normally",
  });
  assert.equal(approvalWait.disposition, "deferred");
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/steer")
      .length,
    1,
  );
  assert.equal(
    current.transport.sent.some(
      (message) => message.id === "approval-steer-fallback",
    ),
    false,
  );

  await connector.close();
});

test("treats a malformed steer response as ambiguous and never replays it", async () => {
  const current = fixture((message, fake) => {
    if (message.method === "thread/resume") {
      fake.respond(message, {
        thread: { id: THREAD_ID, status: { type: "idle" }, turns: [] },
      });
    } else if (message.method === "turn/steer") {
      fake.respond(message, { turnId: "turn-other" });
    }
  });
  const connector = await current.connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  current.transport.emit({
    method: "turn/started",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-steer-ambiguous", status: "inProgress" },
    },
  });

  await assert.rejects(
    connector.submitMessage(connector.guard(), {
      deadlineAt: futureDeadline(),
      messageId: "message-steer-ambiguous",
      steer: true,
      text: "STEER: ambiguous response",
    }),
    (error) =>
      error instanceof CodexConnectorError &&
      error.code === "RESULT_SCHEMA_MISMATCH" &&
      error.ambiguous,
  );
  assert.equal(connector.observation().connection, "faulted");
  assert.equal(
    current.transport.sent.filter((message) => message.method === "turn/steer")
      .length,
    1,
  );
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
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: "turn-external", status: "completed" },
    },
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

test("owned-turn watchdog releases a route whose completion notification was lost", async () => {
  let turnStarted = false;
  const { connect, replies, transport } = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        fake.respond(message, {
          thread: {
            id: THREAD_ID,
            status: { type: "idle" },
            turns: [],
          },
        });
      } else if (message.method === "turn/start") {
        turnStarted = true;
        fake.respond(message, {
          turn: { id: "turn-watchdog-reconcile", status: "inProgress" },
        });
      }
    },
    { requestTimeoutMs: 50, turnWatchdogMs: 10 },
  );
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-watchdog-reconcile",
    text: "reconcile the missing completion",
  });
  assert.equal(turnStarted, true);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(connector.observation().connection, "ready");
  assert.equal(connector.observation().routeStatus, "idle");
  assert.equal(connector.observation().hasActiveTurn, false);
  assert.deepEqual(replies, [
    {
      messageId: "message-watchdog-reconcile",
      outcome: "ambiguous",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
  assert.equal(
    transport.sent.filter((message) => message.method === "thread/resume")
      .length,
    3,
  );
  await connector.close();
});

test("two consecutive watchdog request timeouts fault the connector stale", async () => {
  let resumeCount = 0;
  const { connect, events, replies, transport } = fixture(
    (message, fake) => {
      if (message.method === "thread/resume") {
        resumeCount += 1;
        if (resumeCount <= 2) {
          fake.respond(message, {
            thread: {
              id: THREAD_ID,
              status: { type: "idle" },
              turns: [],
            },
          });
        }
      } else if (message.method === "turn/start") {
        fake.respond(message, {
          turn: { id: "turn-watchdog-timeout", status: "inProgress" },
        });
      }
    },
    { requestTimeoutMs: 10, turnWatchdogMs: 5 },
  );
  const connector = await connect();
  await observeRoute(connector);
  await connector.resumeThread(connector.guard());
  await connector.submitMessage(connector.guard(), {
    deadlineAt: futureDeadline(),
    messageId: "message-watchdog-timeout",
    text: "detect the missing app-server responses",
  });

  // Two watchdog probes must each time out before the fault: the trigger stays
  // fast (5ms watchdog, 10ms request timeout) while the observation deadline is
  // generous, so a loaded runner delays the fault instead of hiding it.
  await waitFor(
    () => connector.observation().connection === "faulted",
    "two consecutive watchdog timeouts to fault the connector",
  );
  assert.equal(connector.observation().connection, "faulted");
  assert.equal(connector.observation().routeStatus, "stale");
  // thread/resume 1 answered by resumeThread, 2 answered by the pre-turn route
  // refresh, then 3 and 4 unanswered: exactly two consecutive timeouts.
  assert.equal(resumeCount, 4);
  assert.deepEqual(replies, [
    {
      messageId: "message-watchdog-timeout",
      outcome: "ambiguous",
      replyCode: "REPLY_UNAVAILABLE",
      text: null,
    },
  ]);
  const fault = events.find((event) => event.kind === "protocol_fault");
  assert.equal(fault?.details?.errorCode, "REQUEST_TIMEOUT");
  assert.equal(
    transport.sent.filter((message) => message.method === "turn/start").length,
    1,
  );
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
    request: (method: string, params: WireRecord | null) => Promise<unknown>;
  };
  for (const forbiddenMethod of [
    "thread/list",
    "account/rateLimits/read",
    "model/list",
    "thread/archive",
    "thread/start",
  ]) {
    await assert.rejects(
      hiddenRequest.request(
        forbiddenMethod,
        forbiddenMethod === "account/rateLimits/read" ? null : {},
      ),
      (error) => assertConnectorError(error, "METHOD_NOT_ALLOWED"),
    );
    assert.equal(requestMethods(transport).includes(forbiddenMethod), false);
  }

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
