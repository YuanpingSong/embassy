import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadGatewayConfig } from "../src/gateway/config.js";
import type {
  GatewayControlHandlers,
  ValidatedRegisterCodexParams,
  ValidatedSendToClaudeParams,
  ValidatedSendToCodexParams,
} from "../src/gateway/control.js";
import {
  GatewayService,
  type GatewayAdapterCallbacks,
  type GatewayAdapterDelivery,
  type GatewayAdapterDiscovery,
  type GatewayAdapterDispatchResult,
  type GatewayAdapterRouteState,
  type GatewayProviderAdapter,
} from "../src/gateway/service.js";
import type {
  PrivateEndpointIdentity,
  PrivateRouteBinding,
} from "../src/gateway/types.js";
import { BridgeError } from "../src/errors.js";

const THREAD_ID = "019f9a56-9fca-75b1-80e4-48ccef693abc";
const CLAUDE_SESSION_ID = "00000000-0000-4000-8000-000000000042";
const SECRET = "SYNTHETIC_BODY_MUST_STAY_MEMORY_ONLY_8e24";
async function fixture(): Promise<{
  root: string;
  stateDir: string;
  workspace: string;
}> {
  const created = await mkdtemp(path.join(os.tmpdir(), "gateway-service-"));
  const root = await realpath(created);
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return { root, stateDir, workspace };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic dispatch timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeProvider implements GatewayProviderAdapter {
  readonly identity: PrivateEndpointIdentity;
  readonly protocol: string;
  readonly protocolVersion = "synthetic-1";
  discoveries: GatewayAdapterDiscovery[] = [];
  callbacks: GatewayAdapterCallbacks | undefined;
  dispatches: Array<{
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }> = [];
  attested: string[] = [];
  closed = false;
  closeError: Error | undefined;
  state: GatewayAdapterRouteState = "idle";
  dispatchResults: GatewayAdapterDispatchResult[] = [];
  nativeCodexStatuses: Array<{
    alias: string;
    status: "idle" | "busy" | "waiting";
  }> = [];
  nativeInboundStatuses: Array<{
    receiptHandle: string;
    status: "held" | "delivered" | "denied" | "expired";
    diagnosticCode?: string;
  }> = [];

  constructor(provider: "codex" | "claude") {
    this.identity = {
      provider,
      hostId: "this-mac",
      endpointGeneration: `generation_${provider}`,
    };
    this.protocol = provider === "codex" ? "codex-app-server" : "claude-peer";
  }

  async initialize(callbacks: GatewayAdapterCallbacks): Promise<{
    health: "healthy";
    compatibility: "compatible";
  }> {
    this.callbacks = callbacks;
    return { health: "healthy", compatibility: "compatible" };
  }

  async discoverClaudePeers(): Promise<readonly GatewayAdapterDiscovery[]> {
    return this.discoveries.map((peer) => ({ ...peer }));
  }

  async selectRoute(input: {
    alias: string;
    routeHandle: string;
  }): Promise<{ routeHandle: string; state: GatewayAdapterRouteState }> {
    return { routeHandle: input.routeHandle, state: this.state };
  }

  async assertWorkspaceDisjoint(
    routeHandle: string,
    _stateRoot: string,
  ): Promise<void> {
    this.attested.push(routeHandle);
  }

  async resolveReplyAddress(
    address: string,
  ): Promise<{ routeHandle: string }> {
    if (address !== "uds:/synthetic/claude.sock") {
      throw new BridgeError(
        "REPLY_ADDRESS_MISMATCH",
        "Synthetic unrelated socket.",
      );
    }
    return { routeHandle: "claude_target_1" };
  }

  async dispatch(input: {
    binding: PrivateRouteBinding;
    authorization: "selected_route" | "native_reply";
    messageId: string;
    text: string;
    expectsReply: boolean;
    deadlineAt: string;
  }): Promise<GatewayAdapterDispatchResult> {
    this.dispatches.push({ ...input, binding: { ...input.binding } });
    return this.dispatchResults.shift() ?? { state: "pending" };
  }

  async updateNativeCodexPeerStatus(
    alias: string,
    status: "idle" | "busy" | "waiting",
  ): Promise<void> {
    this.nativeCodexStatuses.push({ alias, status });
  }

  async updateNativeInboundStatus(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnosticCode?: string,
  ): Promise<void> {
    this.nativeInboundStatuses.push({
      receiptHandle,
      status,
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }

  emitDelivery(event: GatewayAdapterDelivery): void {
    this.callbacks?.onDelivery(event);
  }

  emitClaudeReply(text: string): void {
    this.callbacks?.onClaudeReply({
      endpoint: { ...this.identity, routeHandle: "claude_target_1" },
      text,
    });
  }

  emitRouteState(routeHandle: string, state: GatewayAdapterRouteState): void {
    this.callbacks?.onRouteState({
      endpoint: { ...this.identity, routeHandle },
      state,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

function codexRegistration(): ValidatedRegisterCodexParams {
  return {
    alias: "codex-main@this-mac",
    threadId: THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  };
}

function toClaude(text = SECRET): ValidatedSendToClaudeParams {
  return {
    fromAlias: "codex-main@this-mac",
    threadId: THREAD_ID,
    toAlias: "claude-one@this-mac",
    text,
    expectsReply: true,
  };
}

function toCodex(replyAddress: string): ValidatedSendToCodexParams {
  return {
    fromAlias: "claude-one@this-mac",
    toAlias: "codex-main@this-mac",
    text: SECRET,
    replyAddress,
    expectsReply: true,
  };
}

async function selectAndRegister(
  handlers: GatewayControlHandlers,
): Promise<void> {
  assert.deepEqual(await handlers.refreshDashboard(), {
    accepted: true,
    code: "ok",
    revision: 0,
  });
  assert.deepEqual(
    await handlers.selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
}

async function discoverAndRegisterCodexOnly(
  handlers: GatewayControlHandlers,
): Promise<void> {
  assert.deepEqual(await handlers.refreshDashboard(), {
    accepted: true,
    code: "ok",
    revision: 0,
  });
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });
}

test("Codex registration requires the native codex-* namespace", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [new FakeProvider("claude"), new FakeProvider("codex")],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    await service.handlers().registerCodex({
      ...codexRegistration(),
      alias: "reviewer@this-mac",
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal((await service.handlers().listSnapshot()).routes.length, 0);
});

test("fake end-to-end selection, dispatch, correlation, and reply authority stay metadata-only", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  let clock = new Date();
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
    // Unsafe native names are not transformed into a public selector.
    {
      alias: "Claude Mixed@this-mac",
      routeHandle: "never_selected",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
    now: () => clock,
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.availablePeers.map((peer) => peer.alias),
    ["claude-one@this-mac"],
  );
  assert.equal(JSON.stringify(snapshot).includes("claude_target_1"), false);
  assert.deepEqual(claude.attested, ["claude_target_1"]);
  assert.deepEqual(codex.attested, [THREAD_ID]);

  const accepted = await handlers.sendToClaude(toClaude());
  assert.equal(accepted.accepted, true);
  // The mutation handler returns before any provider call is attempted.
  assert.equal(claude.dispatches.length, 0);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches.length, 1);
  assert.equal(claude.dispatches[0]?.text, SECRET);

  const second = await handlers.sendToClaude(toClaude("second body"));
  assert.deepEqual(second, { accepted: false, code: "busy" });

  const unrelated = await handlers.sendToCodex(
    toCodex("uds:/tmp/unrelated-agent.sock"),
  );
  assert.deepEqual(unrelated, { accepted: false, code: "route_mismatch" });
  assert.equal(codex.dispatches.length, 0);

  const firstDispatch = claude.dispatches[0];
  assert.ok(firstDispatch);
  // A callback from a different provider/generation cannot settle this ID.
  codex.emitDelivery({ messageId: firstDispatch.messageId, state: "released" });
  await immediate();
  assert.equal(
    (await handlers.listSnapshot()).messages.some(
      (event) =>
        event.direction === "codex_to_claude" && event.state === "delivered",
    ),
    false,
  );
  claude.emitDelivery({
    messageId: firstDispatch.messageId,
    state: "transport_written",
  });
  claude.emitDelivery({ messageId: firstDispatch.messageId, state: "held" });
  await immediate();
  claude.emitDelivery({
    messageId: firstDispatch.messageId,
    state: "released",
  });
  claude.emitClaudeReply("synthetic reply");
  await waitFor(() => codex.dispatches.length === 1);
  assert.equal(codex.dispatches.length, 1);
  assert.equal(codex.dispatches[0]?.text, "synthetic reply");
  const replyDispatch = codex.dispatches[0];
  assert.ok(replyDispatch);
  codex.emitDelivery({
    messageId: replyDispatch.messageId,
    state: "completed",
  });
  codex.emitRouteState(THREAD_ID, "idle");
  await immediate();

  claude.emitRouteState("claude_target_1", "idle");
  await immediate();

  const late = await handlers.sendToClaude(toClaude("late reply probe"));
  assert.equal(late.accepted, true);
  await waitFor(() => claude.dispatches.length === 2);
  const lateDispatch = claude.dispatches[1];
  assert.ok(lateDispatch);
  claude.emitDelivery({ messageId: lateDispatch.messageId, state: "released" });
  clock = new Date(
    clock.getTime() + config.limits.messageDeadlineMs + 1,
  );
  const blockedByTombstone = await handlers.sendToClaude(
    toClaude("must not reuse tainted callback generation"),
  );
  assert.deepEqual(blockedByTombstone, {
    accepted: false,
    code: "busy",
  });
  claude.emitClaudeReply("must be ignored after deadline");
  await immediate();
  await immediate();
  assert.equal(codex.dispatches.length, 1);
  claude.emitRouteState("claude_target_1", "idle");
  await immediate();
  clock = new Date();

  const fromClaude = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(fromClaude.accepted, true);
  await waitFor(() => codex.dispatches.length === 2);
  const codexTurn = codex.dispatches[1];
  assert.ok(codexTurn);
  codex.emitDelivery({
    messageId: codexTurn.messageId,
    state: "completed",
    replyText: "bounded codex final",
  });
  await waitFor(() => claude.dispatches.length === 3);
  const codexReply = claude.dispatches[2];
  assert.ok(codexReply);
  assert.equal(codexReply.text, "bounded codex final");
  assert.equal(codexReply.expectsReply, false);
  assert.equal(Number.isFinite(Date.parse(codexReply.deadlineAt)), true);
  claude.emitDelivery({ messageId: codexReply.messageId, state: "released" });
  await immediate();

  const finalSnapshot = await handlers.listSnapshot();
  assert.equal(
    finalSnapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.hopCount === 1,
    ),
    true,
  );
  const stateText = await readFile(service.store.stateFilePath, "utf8");
  const dashboardText = await readFile(
    path.join(stateDir, "gateway-dashboard.html"),
    "utf8",
  );
  for (const forbidden of [
    SECRET,
    "synthetic reply",
    "late reply probe",
    "must be ignored after deadline",
    "bounded codex final",
  ]) {
    assert.equal(stateText.includes(forbidden), false);
  }
  // Exact route handles may exist only in the private controller state. They
  // must never enter the public dashboard or normalized snapshot.
  for (const forbidden of [
    SECRET,
    "synthetic reply",
    "late reply probe",
    "must be ignored after deadline",
    "bounded codex final",
    "claude_target_1",
    THREAD_ID,
  ]) {
    assert.equal(dashboardText.includes(forbidden), false);
  }

  await service.close();
  assert.equal(claude.closed, true);
  assert.equal(codex.closed, true);
});

test("Claude sends require explicit selection while UUID routing survives rename and endpoint refresh", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "old-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await handlers.refreshDashboard();
  assert.deepEqual(await handlers.registerCodex(codexRegistration()), {
    accepted: true,
    code: "ok",
  });

  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("unselected UUID must not route"),
      toAlias: CLAUDE_SESSION_ID,
      expectsReply: false,
    }),
    { accepted: false, code: "rejected" },
  );
  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("unselected name must not route"),
      toAlias: "old-name@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "rejected" },
  );
  assert.equal(claude.dispatches.length, 0);

  assert.deepEqual(await handlers.selectClaude({ alias: CLAUDE_SESSION_ID }), {
    accepted: true,
    code: "ok",
  });
  const byUuid = await handlers.sendToClaude({
    ...toClaude("addressed by UUID"),
    toAlias: CLAUDE_SESSION_ID,
    expectsReply: false,
  });
  assert.equal(byUuid.accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  const first = claude.dispatches[0];
  assert.ok(first);
  assert.equal(first.binding.routeHandle, CLAUDE_SESSION_ID);
  claude.emitDelivery({ messageId: first.messageId, state: "released" });
  claude.emitRouteState(CLAUDE_SESSION_ID, "idle");
  await immediate();

  claude.discoveries = [
    {
      alias: "new-name@this-mac",
      routeHandle: CLAUDE_SESSION_ID,
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  await handlers.refreshDashboard();
  const renamed = await handlers.listSnapshot();
  assert.deepEqual(
    renamed.availablePeers.map(({ alias, selected }) => ({ alias, selected })),
    [{ alias: "new-name@this-mac", selected: true }],
  );
  assert.equal(
    renamed.routes.some((route) => route.alias === "old-name@this-mac"),
    false,
  );
  assert.equal(
    renamed.routes.some((route) => route.alias === "new-name@this-mac"),
    true,
  );

  assert.deepEqual(
    await handlers.sendToClaude({
      ...toClaude("old name must not resolve"),
      toAlias: "old-name@this-mac",
      expectsReply: false,
    }),
    { accepted: false, code: "not_found" },
  );
  const byCurrentName = await handlers.sendToClaude({
    ...toClaude("current name resolves"),
    toAlias: "new-name@this-mac",
    expectsReply: false,
  });
  assert.equal(byCurrentName.accepted, true);
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.binding.routeHandle, CLAUDE_SESSION_ID);
});

test("explicit Claude selection reactivates its persisted stale alias after restart", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const firstClaude = new FakeProvider("claude");
  firstClaude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const first = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [firstClaude],
  });
  await first.start();
  assert.deepEqual(
    await first.handlers().selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
  await first.close();

  const secondClaude = new FakeProvider("claude");
  secondClaude.discoveries = firstClaude.discoveries.map((peer) => ({
    ...peer,
  }));
  const second = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [secondClaude],
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    await second.handlers().selectClaude({ alias: "claude-one@this-mac" }),
    { accepted: true, code: "ok" },
  );
});

test("transient Codex dispatch failures return to held queue and retry", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push(
    { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" },
    { state: "pending" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const accepted = await handlers.sendToCodex(
    toCodex("uds:/synthetic/claude.sock"),
  );
  assert.equal(accepted.accepted, true);
  await waitFor(() => codex.dispatches.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const snapshot = await handlers.listSnapshot();
  assert.equal(
    codex.dispatches.length,
    2,
    JSON.stringify(snapshot.routes, null, 2),
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "held",
    ),
    true,
  );
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "failed",
    ),
    false,
  );
});

test("native Claude ingress reports delivery without approval-like held notices while internal queueing remains visible", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push(
    { state: "deferred", safeErrorCode: "CODEX_ROUTE_HELD" },
    { state: "pending" },
  );
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  const onClaudeMessage = claude.callbacks?.onClaudeMessage;
  assert.ok(onClaudeMessage);
  onClaudeMessage({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "native lifecycle status probe",
    receiptHandle: "receipt-native-1",
  });

  await waitFor(() => codex.dispatches.length === 2);
  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-native-1", status: "delivered" },
  ]);
  const snapshot = await service.handlers().listSnapshot();
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.direction === "claude_to_codex" && event.state === "held",
    ),
    true,
  );
  assert.equal(
    claude.nativeCodexStatuses.some(
      ({ alias, status }) =>
        alias === "codex-main@this-mac" && status === "waiting",
    ),
    true,
  );
});

test("an exact unselected native Claude peer can reach Codex and receive only its correlated reply", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({
    state: "delivered",
    replyText: "correlated reply only",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await discoverAndRegisterCodexOnly(handlers);

  claude.callbacks?.onClaudeMessage?.({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "unselected native ingress",
    receiptHandle: "receipt-unselected-native",
  });

  await waitFor(() => codex.dispatches.length === 1);
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(codex.dispatches[0]?.authorization, "selected_route");
  assert.equal(claude.dispatches[0]?.authorization, "native_reply");
  assert.equal(claude.dispatches[0]?.binding.routeHandle, "claude_target_1");
  assert.equal(claude.dispatches[0]?.text, "correlated reply only");
  assert.deepEqual(claude.nativeInboundStatuses, [
    { receiptHandle: "receipt-unselected-native", status: "delivered" },
  ]);

  assert.deepEqual(await handlers.sendToClaude(toClaude("unsolicited")), {
    accepted: false,
    code: "rejected",
  });
  const snapshot = await handlers.listSnapshot();
  assert.deepEqual(
    snapshot.routes.map((route) => route.alias),
    ["codex-main@this-mac"],
  );
  assert.deepEqual(
    snapshot.availablePeers.map(({ alias, selected }) => ({ alias, selected })),
    [{ alias: "claude-one@this-mac", selected: false }],
  );
});

test("native Claude ingress reports delivery errors as expired with a safe diagnostic", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.dispatchResults.push({
    state: "failed",
    safeErrorCode: "CODEX_ROUTE_UNAVAILABLE",
  });
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  claude.callbacks?.onClaudeMessage?.({
    endpoint: {
      ...claude.identity,
      routeHandle: "claude_target_1",
    },
    sourceAlias: "claude-one@this-mac",
    targetAlias: "codex-main@this-mac",
    text: "native delivery failure",
    receiptHandle: "receipt-native-failed",
  });

  await waitFor(() => claude.nativeInboundStatuses.length === 1);
  assert.deepEqual(claude.nativeInboundStatuses, [
    {
      receiptHandle: "receipt-native-failed",
      status: "expired",
      diagnosticCode: "CODEX_ROUTE_UNAVAILABLE",
    },
  ]);
});

test("a busy Claude peer can receive a native reply without deadlocking the conversation", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const service = new GatewayService({
    config: loadGatewayConfig({
      EMBASSY_STATE_DIR: stateDir,
      EMBASSY_HOSTS: "this-mac",
    }),
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await selectAndRegister(service.handlers());

  assert.equal(
    (await service.handlers().sendToClaude(toClaude("reply while Claude is busy")))
      .accepted,
    true,
  );
  await waitFor(() => claude.dispatches.length === 1);
  assert.equal(claude.dispatches[0]?.text, "reply while Claude is busy");
});

test("queued bodies are cancelled on close and never replayed after restart", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  codex.state = "busy";
  const first = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await first.start();
  let second: GatewayService | undefined;
  t.after(async () => {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = first.handlers();
  await selectAndRegister(handlers);
  assert.equal(
    (await handlers.sendToCodex(toCodex("uds:/synthetic/claude.sock"))).accepted,
    true,
  );
  await immediate();
  // Busy routes retain the transient body only in this process.
  assert.equal(codex.dispatches.length, 0);
  await first.close();

  second = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [],
  });
  await second.start();
  const snapshot = await second.snapshot();
  assert.equal(
    snapshot.messages.some(
      (event) =>
        event.state === "cancelled" &&
        event.safeErrorCode === "MESSAGE_CANCELLED",
    ),
    true,
  );
  assert.equal((await readFile(second.store.stateFilePath, "utf8")).includes(SECRET), false);
  await second.close();
});

test("one exact target has at most one active provider dispatch", async (t) => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  claude.discoveries = [
    {
      alias: "claude-one@this-mac",
      routeHandle: "claude_target_1",
      kind: "interactive",
      state: "idle",
      compatibility: "compatible",
    },
  ];
  const codex = new FakeProvider("codex");
  const service = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  await service.start();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const handlers = service.handlers();
  await selectAndRegister(handlers);

  const first = toClaude("serial-one");
  first.expectsReply = false;
  const second = toClaude("serial-two");
  second.expectsReply = false;
  assert.equal((await handlers.sendToClaude(first)).accepted, true);
  assert.equal((await handlers.sendToClaude(second)).accepted, true);
  await waitFor(() => claude.dispatches.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(claude.dispatches.length, 1);

  const active = claude.dispatches[0];
  assert.ok(active);
  claude.emitDelivery({ messageId: active.messageId, state: "released" });
  claude.emitRouteState("claude_target_1", "idle");
  await waitFor(() => claude.dispatches.length === 2);
  assert.equal(claude.dispatches[1]?.text, "serial-two");
  const next = claude.dispatches[1];
  assert.ok(next);
  claude.emitDelivery({ messageId: next.messageId, state: "released" });
  await immediate();
  await service.close();
});

test("adapter cleanup failures reject close after controller cleanup completes", async () => {
  const { root, stateDir, workspace } = await fixture();
  const config = loadGatewayConfig({
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_HOSTS: "this-mac",
  });
  const claude = new FakeProvider("claude");
  const codex = new FakeProvider("codex");
  const claudeFailure = new BridgeError(
    "SYNTHETIC_CLAUDE_CLEANUP_FAILED",
    "Synthetic Claude cleanup was not confirmed.",
  );
  const codexFailure = new BridgeError(
    "SYNTHETIC_CODEX_CLEANUP_FAILED",
    "Synthetic Codex cleanup was not confirmed.",
  );
  claude.closeError = claudeFailure;
  codex.closeError = codexFailure;
  const service = new GatewayService({
    config,
    forbiddenWorkspaceRoots: [workspace],
    adapters: [claude, codex],
  });
  let successor: GatewayService | undefined;
  try {
    await service.start();
    await assert.rejects(service.close(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "GATEWAY_CLEANUP_FAILED");
      assert.equal(
        error.message,
        "The gateway could not confirm cleanup of every owned resource.",
      );
      assert.equal(error.message.includes("Synthetic"), false);
      return true;
    });
    assert.equal(claude.closed, true);
    assert.equal(codex.closed, true);

    // A failed provider cleanup must be visible to the caller, while the
    // controller-owned store lock and control socket are still released.
    successor = new GatewayService({
      config,
      forbiddenWorkspaceRoots: [workspace],
      adapters: [],
    });
    await successor.start();
    assert.equal((await successor.handlers().health()).status, "ok");
  } finally {
    await successor?.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
