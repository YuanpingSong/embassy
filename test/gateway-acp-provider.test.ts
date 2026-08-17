import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { setImmediate as delayImmediate } from "node:timers/promises";
import { test } from "node:test";

import type { AcpPromptReceipt } from "../src/gateway/acp-client.js";
import { AcpGatewayProvider, type AcpGatewayProviderOptions } from "../src/gateway/acp-provider.js";
import type { GatewayAdapterCallbacks, GatewayAdapterDispatchInput, GatewayAdapterRouteObservationState } from "../src/gateway/service.js";
const launch = { kind: "npx", package: "synthetic@1.0.0" } as const;
type State = { state: GatewayAdapterRouteObservationState; code?: string };

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delayImmediate();
  }
  throw new Error("synthetic condition was not reached");
}

class FakeClient {
  readonly connectionInfo = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  sessions = 0;
  prompts: string[] = [];
  receipts: Array<AcpPromptReceipt | Promise<AcpPromptReceipt>> = [];
  prepareError: Error | undefined;
  cancelled = 0;
  closed = false;
  async newSession() { this.sessions += 1; return { sessionId: "owned-session" }; }
  preparePrompt(_sessionId: string, text: string) {
    if (this.prepareError !== undefined) throw this.prepareError;
    const frame = `${JSON.stringify({ method: "session/prompt", text })}\n`;
    let used = false;
    return {
      bodyBytes: Buffer.byteLength(text, "utf8"),
      frameBytes: Buffer.byteLength(frame, "utf8"),
      sha256: createHash("sha256").update(frame).digest("hex"),
      cancel: () => { if (used) throw new Error("used"); used = true; this.cancelled += 1; },
      perform: async () => {
        if (used) throw new Error("used");
        used = true;
        this.prompts.push(text);
        return await this.receipts.shift()!;
      },
    };
  }
  close(): void { this.closed = true; }
}
function callbacks(states: State[]): GatewayAdapterCallbacks {
  return {
    onClaudeReply: () => undefined,
    onRouteState: ({ state, safeErrorCode }) => states.push({ state, ...(safeErrorCode ? { code: safeErrorCode } : {}) }),
  };
}
async function dispatchFixture(provider: "deepseek" | "grok", clients: FakeClient[], extra: Partial<AcpGatewayProviderOptions> = {}) {
  const alias = provider === "deepseek" ? "dsh-main@this-mac" : "grok-main@this-mac";
  const adapter = new AcpGatewayProvider({
    provider, alias, hostId: "this-mac", launch,
    spawnClient: async () => clients.shift()!,
    ...extra,
  });
  const states: State[] = [];
  const start = await adapter.initialize(callbacks(states));
  assert.ok(start.ownedRoute);
  adapter.observeLogicalRoute({
    alias,
    routeHandle: start.ownedRoute.routeHandle,
    registrationId: `${provider}_registration`,
  });
  const input: GatewayAdapterDispatchInput = {
    sourceAlias: provider === "deepseek" ? "codex-main@this-mac" : "dsh-main@this-mac",
    sourceProvider: provider === "deepseek" ? "codex" : "deepseek",
    targetAlias: alias,
    conversationId: "conv_0123456789abcdef",
    binding: {
      ...adapter.identity,
      routeHandle: start.ownedRoute.routeHandle,
      registrationId: `${provider}_registration`,
    },
    authorization: "selected_route",
    attemptId: `${provider}_attempt_1`,
    authorizeWrite: async () => true,
    onAccepted: async () => undefined,
    messageId: "msg_00000000-0000-7000-8000-000000000001",
    text: "hello",
    expectsReply: true,
    deadlineAt: "2030-01-01T00:00:00.000Z",
  };
  return { adapter, input, states };
}

test("DeepSeek owns one lazy session and preserves coarse and cancelled outcomes", async () => {
  const client = new FakeClient();
  client.receipts.push(
    { terminalState: "delivered", stopReason: "end_turn", text: "reply", textTruncated: false },
    { terminalState: "cancelled", stopReason: "cancelled", text: "", textTruncated: false },
  );
  const { adapter, input } = await dispatchFixture("deepseek", [client]);
  assert.deepEqual(await adapter.dispatch(input), { state: "unconfirmed", safeErrorCode: "ACP_OUTCOME_COARSE", replyText: "reply" });
  assert.deepEqual(await adapter.dispatch(input), { state: "cancelled" });
  assert.equal(client.sessions, 1);
  assert.match(client.prompts[0]!, /from-provider="codex"/u);
  await adapter.close();
});

test("Grok keeps uncertainty stale until bounded recovery, then preserves end_turn", async () => {
  let now = 0;
  let wake: (() => void) | undefined;
  const first = new FakeClient();
  first.receipts.push({ terminalState: "unknown", text: "partial", textTruncated: false });
  const second = new FakeClient();
  second.receipts.push({ terminalState: "delivered", stopReason: "end_turn", text: "done", textTruncated: false });
  const { adapter, input, states } = await dispatchFixture("grok", [first, second], {
    now: () => now,
    setTimeout: ((callback: () => void) => { wake = callback; return { unref: () => undefined }; }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  assert.deepEqual(await adapter.dispatch(input), { state: "ambiguous", safeErrorCode: "ACP_SUBPROCESS_EXITED", replyText: "partial" });
  assert.deepEqual(states, [{ state: "unobserved", code: "ACP_SUBPROCESS_EXITED" }]);
  assert.deepEqual(await adapter.dispatch(input), {
    state: "deferred",
    safeErrorCode: "ROUTE_BUSY",
  });
  assert.deepEqual(states.at(-1), {
    state: "unobserved",
    code: "ACP_RESTART_BACKOFF",
  });
  now = 250;
  wake?.();
  assert.deepEqual(await adapter.dispatch(input), { state: "delivered", replyText: "done" });
  assert.equal(first.closed, true);
  assert.deepEqual(states.map(({ state }) => state), ["unobserved", "unobserved", "idle", "idle"]);
  await adapter.close();
});

test("ACP normalizes clean retries while preserving exact health observations", async () => {
  const seed = await dispatchFixture("grok", [new FakeClient()]);
  const unavailable = new AcpGatewayProvider({
    alias: seed.input.targetAlias,
    hostId: "this-mac",
    provider: "grok",
  });
  const start = await unavailable.initialize(callbacks([]));
  assert.ok(start.ownedRoute);
  assert.equal(start.safeErrorCode, "ACP_LAUNCH_UNAVAILABLE");
  unavailable.observeLogicalRoute({
    alias: seed.input.targetAlias,
    registrationId: "grok_unavailable_registration",
    routeHandle: start.ownedRoute.routeHandle,
  });
  assert.deepEqual(
    await unavailable.dispatch({
      ...seed.input,
      binding: {
        ...unavailable.identity,
        registrationId: "grok_unavailable_registration",
        routeHandle: start.ownedRoute.routeHandle,
      },
    }),
    { state: "deferred", safeErrorCode: "ROUTE_BUSY" },
  );

  const busyClient = new FakeClient();
  busyClient.prepareError = new Error(
    "ACP session already has an outstanding prompt",
  );
  const busy = await dispatchFixture("deepseek", [busyClient]);
  assert.deepEqual(await busy.adapter.dispatch(busy.input), {
    state: "deferred",
    safeErrorCode: "ROUTE_BUSY",
  });
  assert.deepEqual(busy.states.at(-1), {
    state: "busy",
    code: "ACP_SESSION_BUSY",
  });
  assert.equal(busyClient.prompts.length, 0);

  await busy.adapter.close();
  await unavailable.close();
  await seed.adapter.close();
});

test("ACP authorizes the exact prepared prompt and never writes on denial", async () => {
  const client = new FakeClient();
  client.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "done",
    textTruncated: false,
  });
  const { adapter, input } = await dispatchFixture("grok", [client]);
  let evidence: Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0] | undefined;
  const denied = {
    ...input,
    authorizeWrite: async (
      current: Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0],
    ) => {
      evidence = current;
      return false;
    },
  };
  assert.deepEqual(await adapter.dispatch(denied), {
    state: "failed",
    safeErrorCode: "WRITE_AUTHORIZATION_DENIED",
  });
  assert.equal(client.prompts.length, 0);
  assert.equal(client.cancelled, 1);
  assert.equal(evidence?.kind, "acp_prompt");
  assert.equal(evidence?.bodyBytes, Buffer.byteLength(input.text, "utf8"));
  assert.equal(
    evidence?.bodySha256,
    createHash("sha256").update(input.text).digest("hex"),
  );
  await adapter.close();
});

test("ACP remains armed until its terminal result without inventing acceptance", async () => {
  const client = new FakeClient();
  client.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "done",
    textTruncated: false,
  });
  const { adapter, input } = await dispatchFixture("grok", [client]);
  const order: string[] = [];

  assert.deepEqual(await adapter.dispatch({
    ...input,
    authorizeWrite: async () => {
      order.push("authorize");
      return true;
    },
    onAccepted: async () => {
      order.push("accepted");
      throw new Error("ACP has no correlated acceptance event");
    },
  }), { state: "delivered", replyText: "done" });
  assert.deepEqual(order, ["authorize"]);
  assert.equal(client.prompts.length, 1);
  await adapter.close();
});

test("ACP rejects a superseded registration before preparing a prompt", async () => {
  const client = new FakeClient();
  client.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "done",
    textTruncated: false,
  });
  const { adapter, input } = await dispatchFixture("grok", [client]);
  adapter.observeLogicalRoute({
    alias: input.targetAlias,
    routeHandle: input.binding.routeHandle,
    registrationId: "grok_registration_replacement",
  });

  assert.deepEqual(await adapter.dispatch(input), {
    state: "failed",
    safeErrorCode: "ACP_ROUTE_MISMATCH",
  });
  assert.equal(client.sessions, 0);
  assert.equal(client.prompts.length, 0);
  await adapter.close();
});

test("ACP replacement registration never inherits the prior provider session", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  first.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "first",
    textTruncated: false,
  });
  second.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "second",
    textTruncated: false,
  });
  const { adapter, input } = await dispatchFixture("grok", [first, second]);
  assert.deepEqual(await adapter.dispatch(input), {
    state: "delivered",
    replyText: "first",
  });
  adapter.observeLogicalRoute({
    alias: input.targetAlias,
    routeHandle: input.binding.routeHandle,
    registrationId: "grok_registration_replacement",
  });
  assert.deepEqual(
    await adapter.dispatch({
      ...input,
      attemptId: "grok_attempt_2",
      binding: {
        ...input.binding,
        registrationId: "grok_registration_replacement",
      },
    }),
    { state: "delivered", replyText: "second" },
  );
  assert.equal(first.closed, true);
  assert.equal(first.sessions, 1);
  assert.equal(second.sessions, 1);
  await adapter.close();
});

test("ACP closes a client that resolves after provider shutdown", async () => {
  const client = new FakeClient();
  let release!: (client: FakeClient) => void;
  const spawned = new Promise<FakeClient>((resolve) => {
    release = resolve;
  });
  const alias = "grok-main@this-mac";
  const adapter = new AcpGatewayProvider({
    alias,
    hostId: "this-mac",
    launch,
    provider: "grok",
    spawnClient: async () => await spawned,
  });
  const start = await adapter.initialize(callbacks([]));
  assert.ok(start.ownedRoute);
  adapter.observeLogicalRoute({
    alias,
    registrationId: "grok_registration",
    routeHandle: start.ownedRoute.routeHandle,
  });
  const input: GatewayAdapterDispatchInput = {
    ...(await dispatchFixture("grok", [new FakeClient()])).input,
    binding: {
      ...adapter.identity,
      registrationId: "grok_registration",
      routeHandle: start.ownedRoute.routeHandle,
    },
  };
  const dispatch = adapter.dispatch(input);
  await Promise.resolve();
  await adapter.close();
  release(client);

  assert.deepEqual(await dispatch, {
    state: "failed",
    safeErrorCode: "ACP_ROUTE_MISMATCH",
  });
  assert.equal(client.closed, true);
  assert.equal(client.sessions, 0);
});

test("ACP drops a late old-registration observation but preserves terminal truth", async () => {
  const client = new FakeClient();
  let finish!: (receipt: AcpPromptReceipt) => void;
  client.receipts.push(new Promise<AcpPromptReceipt>((resolve) => {
    finish = resolve;
  }));
  const { adapter, input, states } = await dispatchFixture("grok", [client]);
  const dispatch = adapter.dispatch(input);
  await waitFor(() => client.prompts.length === 1);
  adapter.observeLogicalRoute({
    alias: input.targetAlias,
    registrationId: "grok_registration_replacement",
    routeHandle: input.binding.routeHandle,
  });
  finish({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "done",
    textTruncated: false,
  });

  assert.deepEqual(await dispatch, { state: "delivered", replyText: "done" });
  assert.deepEqual(states, []);
  await adapter.close();
});

test("a late old-registration failure cannot close or back off the replacement client", async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  let finishOld!: (receipt: AcpPromptReceipt) => void;
  first.receipts.push(new Promise<AcpPromptReceipt>((resolve) => {
    finishOld = resolve;
  }));
  second.receipts.push(
    {
      terminalState: "delivered",
      stopReason: "end_turn",
      text: "replacement",
      textTruncated: false,
    },
    {
      terminalState: "delivered",
      stopReason: "end_turn",
      text: "replacement reused",
      textTruncated: false,
    },
  );
  const { adapter, input } = await dispatchFixture("grok", [first, second]);
  const oldDispatch = adapter.dispatch(input);
  await waitFor(() => first.prompts.length === 1);
  const replacementId = "grok_registration_replacement";
  adapter.observeLogicalRoute({
    alias: input.targetAlias,
    registrationId: replacementId,
    routeHandle: input.binding.routeHandle,
  });
  const replacementInput: GatewayAdapterDispatchInput = {
    ...input,
    attemptId: "grok_attempt_replacement_1",
    binding: { ...input.binding, registrationId: replacementId },
  };
  assert.deepEqual(await adapter.dispatch(replacementInput), {
    state: "delivered",
    replyText: "replacement",
  });

  finishOld({ terminalState: "unknown", text: "", textTruncated: false });
  assert.deepEqual(await oldDispatch, {
    state: "ambiguous",
    safeErrorCode: "ACP_SUBPROCESS_EXITED",
  });
  assert.equal(second.closed, false);
  assert.deepEqual(await adapter.dispatch({
    ...replacementInput,
    attemptId: "grok_attempt_replacement_2",
  }), {
    state: "delivered",
    replyText: "replacement reused",
  });
  assert.equal(second.sessions, 1);
  await adapter.close();
});

test("ACP close fences late prompt callbacks and recovery scheduling", async () => {
  const client = new FakeClient();
  let finish!: (receipt: AcpPromptReceipt) => void;
  client.receipts.push(new Promise<AcpPromptReceipt>((resolve) => {
    finish = resolve;
  }));
  let timers = 0;
  const { adapter, input, states } = await dispatchFixture("grok", [client], {
    setTimeout: ((callback: () => void) => {
      timers += 1;
      return { callback, unref: () => undefined };
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
  });
  const dispatch = adapter.dispatch(input);
  await waitFor(() => client.prompts.length === 1);
  await adapter.close();
  finish({ terminalState: "unknown", text: "", textTruncated: false });

  assert.deepEqual(await dispatch, {
    state: "ambiguous",
    safeErrorCode: "ACP_SUBPROCESS_EXITED",
  });
  assert.deepEqual(states, []);
  assert.equal(timers, 0);
});

test("ACP observation callback failure cannot overwrite terminal delivery", async () => {
  const client = new FakeClient();
  client.receipts.push({
    terminalState: "delivered",
    stopReason: "end_turn",
    text: "done",
    textTruncated: false,
  });
  const alias = "grok-main@this-mac";
  const adapter = new AcpGatewayProvider({
    alias,
    hostId: "this-mac",
    launch,
    provider: "grok",
    spawnClient: async () => client,
  });
  const start = await adapter.initialize({
    onClaudeReply: () => undefined,
    onRouteState: () => {
      throw new Error("synthetic observation failure");
    },
  });
  assert.ok(start.ownedRoute);
  adapter.observeLogicalRoute({
    alias,
    registrationId: "grok_registration",
    routeHandle: start.ownedRoute.routeHandle,
  });
  const fixture = await dispatchFixture("grok", [new FakeClient()]);
  const input: GatewayAdapterDispatchInput = {
    ...fixture.input,
    binding: {
      ...adapter.identity,
      registrationId: "grok_registration",
      routeHandle: start.ownedRoute.routeHandle,
    },
  };

  assert.deepEqual(await adapter.dispatch(input), {
    state: "delivered",
    replyText: "done",
  });
  await fixture.adapter.close();
  await adapter.close();
});
