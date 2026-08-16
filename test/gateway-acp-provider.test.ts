import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpPromptReceipt } from "../src/gateway/acp-client.js";
import { AcpGatewayProvider, type AcpGatewayProviderOptions } from "../src/gateway/acp-provider.js";
import type { GatewayAdapterCallbacks, GatewayAdapterDispatchInput, GatewayAdapterRouteObservationState } from "../src/gateway/service.js";
const launch = { kind: "npx", package: "synthetic@1.0.0" } as const;
type State = { state: GatewayAdapterRouteObservationState; code?: string };

class FakeClient {
  readonly connectionInfo = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  sessions = 0;
  prompts: string[] = [];
  receipts: AcpPromptReceipt[] = [];
  closed = false;
  async newSession() { this.sessions += 1; return { sessionId: "owned-session" }; }
  async prompt(_sessionId: string, text: string) {
    this.prompts.push(text);
    return this.receipts.shift()!;
  }
  close(): void { this.closed = true; }
}
function callbacks(states: State[]): GatewayAdapterCallbacks {
  return {
    onDelivery: () => undefined,
    onClaudeReply: () => undefined,
    onRouteState: ({ state, safeErrorCode }) => states.push({ state, ...(safeErrorCode ? { code: safeErrorCode } : {}) }),
  };
}
async function dispatchFixture(provider: "deepseek" | "grok", clients: FakeClient[], extra: Partial<AcpGatewayProviderOptions> = {}) {
  const alias = provider === "deepseek" ? "dsh-main@this-mac" : "grok-main@this-mac";
  const adapter = new AcpGatewayProvider({
    provider, alias, hostId: "this-mac", launch,
    endpointGeneration: `${provider}_generation`,
    spawnClient: async () => clients.shift()!,
    ...extra,
  });
  const states: State[] = [];
  const start = await adapter.initialize(callbacks(states));
  assert.ok(start.ownedRoute);
  const input: GatewayAdapterDispatchInput = {
    sourceAlias: provider === "deepseek" ? "codex-main@this-mac" : "dsh-main@this-mac",
    sourceProvider: provider === "deepseek" ? "codex" : "deepseek",
    targetAlias: alias,
    conversationId: "conv_0123456789abcdef",
    binding: { ...adapter.identity, routeHandle: start.ownedRoute.routeHandle, ownerLease: "lease_synthetic" },
    authorization: "selected_route",
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
  assert.deepEqual(states, [{ state: "stale", code: "ACP_SUBPROCESS_EXITED" }]);
  now = 250;
  wake?.();
  assert.deepEqual(await adapter.dispatch(input), { state: "delivered", replyText: "done" });
  assert.equal(first.closed, true);
  assert.deepEqual(states.map(({ state }) => state), ["stale", "idle", "idle"]);
  await adapter.close();
});
