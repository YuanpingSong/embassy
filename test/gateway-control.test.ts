import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  GATEWAY_CONTROL_MAX_FRAME_BYTES,
  GATEWAY_CONTROL_MAX_CONNECTIONS,
  GATEWAY_CONTROL_MAX_RESPONSE_BYTES,
  GATEWAY_CONTROL_PROTOCOL_VERSION,
  type GatewayControlHandlers,
  type GatewayControlResponse,
  type GatewaySnapshot,
  GatewayControlTransportError,
  createGatewayConversationId,
  gatewayControlMethods,
  isGatewayAlias,
  isGatewayConversationId,
  isGatewayDeliveryToken,
  isGatewayHostId,
  isGatewayReplyAddress,
  sendGatewayControlRequest,
  startGatewayControlServer,
  type ValidatedRegisterCodexParams,
  type ValidatedSendToClaudeParams,
  type ValidatedSendToCodexParams,
} from "../src/gateway/control.js";
import { projectGatewayPublicSnapshot } from "../src/gateway/types.js";
import {
  attachCompatibilityCertification,
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
  type CompatibilityCertificationReport,
  type CompatibilityCheckReport,
} from "../src/gateway/compatibility.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const CONVERSATION_ID = "conv_0123456789abcdef";
const DELIVERY_TOKEN = "dlv_0123456789abcdefghijklmn";
const NOW = "2026-08-07T12:34:56.000Z";
const DEADLINE = "2026-08-07T12:35:56.000Z";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

async function privateState(): Promise<{
  root: string;
  stateDir: string;
  socketPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gw-ctl-"));
  roots.add(root);
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  return {
    root,
    stateDir,
    socketPath: path.join(stateDir, "control.sock"),
  };
}

function snapshot(): GatewaySnapshot {
  const counters = {
    accepted: 1,
    delivered: 1,
    unconfirmed: 0,
    failed: 0,
    ambiguous: 0,
    expired: 0,
    cancelled: 0,
    abandoned: 0,
    rejected: 0,
    bytesAccepted: 12,
  };
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    inboundMode: "paired",
    health: "healthy",
    connectors: [
      {
        provider: "codex",
        host: "this-mac",
        health: "healthy",
        compatibility: "compatible",
        protocol: "codex-app-server",
        protocolVersion: "0.147.0",
        lastSeenAt: NOW,
      },
      {
        provider: "claude",
        host: "build-mac",
        health: "healthy",
        compatibility: "compatible",
        protocol: "claude-peer",
        protocolVersion: "1",
        lastSeenAt: NOW,
      },
    ],
    availablePeers: [
      {
        alias: "claude-two@this-mac",
        provider: "claude",
        host: "this-mac",
        state: "idle",
        compatibility: "compatible",
        validated: true,
        selected: false,
        lastSeenAt: NOW,
      },
    ],
    routes: [
      {
        alias: "codex-main@this-mac",
        provider: "codex",
        host: "this-mac",
        enabled: true,
        state: "idle",
        compatibility: "compatible",
        busyPolicy: "queue",
        lastSeenAt: NOW,
        queueDepth: 1,
        oldestQueuedAt: NOW,
        counters: { ...counters },
      },
      {
        alias: "claude-one@build-mac",
        provider: "claude",
        host: "build-mac",
        enabled: true,
        state: "busy",
        compatibility: "compatible",
        busyPolicy: "queue",
        lastSeenAt: NOW,
        queueDepth: 0,
        counters: { ...counters },
      },
    ],
    pairs: [],
    progressWatches: [
      {
        conversationIdSuffix: "AbCd_123",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        phase: "quiet",
        capability: "conversation",
        lastActivityAt: NOW,
        nextActionAt: NOW,
        idleMs: 300_000,
        nudgeCount: 0,
        workerReportedComplete: false,
      },
    ],
    progressWatchEvents: [
      {
        sequence: 1,
        timestamp: NOW,
        conversationIdSuffix: "AbCd_123",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "opened",
      },
    ],
    activityEvents: [
      {
        sequence: 1,
        timestamp: NOW,
        kind: "pairing",
        action: "routes_paired",
        outcome: "accepted",
        aliases: ["claude-one@build-mac", "codex-main@this-mac"],
        operatorAction: true,
      },
    ],
    deadlinePressure: {
      configuredDeadlineMs: 300_000,
      retainedSince: NOW,
      terminalEvents: 1,
      expiredEvents: 1,
      buckets: [
        { bucket: "under_1m", settled: 1, expired: 1 },
        { bucket: "1m_to_5m", settled: 0, expired: 0 },
        { bucket: "5m_to_15m", settled: 0, expired: 0 },
        { bucket: "15m_to_60m", settled: 0, expired: 0 },
        { bucket: "over_60m", settled: 0, expired: 0 },
      ],
    },
    messages: [
      {
        sequence: 1,
        timestamp: NOW,
        messageIdSuffix: "89abcdef",
        conversationIdSuffix: "AbCd_123",
        direction: "codex_to_claude",
        sourceAlias: "codex-main@this-mac",
        targetAlias: "claude-one@build-mac",
        state: "transport_written",
        bytes: 12,
        latencyMs: 4,
      },
      {
        sequence: 2,
        timestamp: NOW,
        messageIdSuffix: "0123abcd",
        direction: "claude_to_codex",
        sourceAlias: "claude-one@build-mac",
        targetAlias: "codex-main@this-mac",
        state: "held",
        bytes: 8,
      },
      {
        sequence: 3,
        timestamp: NOW,
        messageIdSuffix: "fedcba98",
        direction: "codex_to_claude",
        sourceAlias: "codex-main@this-mac",
        targetAlias: "claude-one@build-mac",
        state: "unconfirmed",
        bytes: 14,
        safeErrorCode: "CLAUDE_NATIVE_ACK_UNAVAILABLE",
      },
    ],
    accounting: {
      accepted: 1,
      duplicates: 0,
      delivered: 1,
      unconfirmed: 1,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 12,
      queuedBytes: 0,
    },
    alerts: [],
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      pairs: 0,
      progressWatches: 0,
      progressWatchEvents: 0,
      activityEvents: 0,
      messages: 0,
      alerts: 0,
    },
  };
}

function handlers(
  overrides: Partial<GatewayControlHandlers> = {},
): GatewayControlHandlers {
  return {
    health: () => ({ status: "ok", revision: 7 }),
    registerCodex: () => ({ accepted: true, code: "ok" }),
    unregisterCodex: () => ({ accepted: true, code: "ok" }),
    removeStaleCodexRegistration: () => ({ accepted: true, code: "ok" }),
    selectClaude: () => ({ accepted: true, code: "ok" }),
    unselectClaude: () => ({ accepted: true, code: "ok" }),
    pair: () => ({ accepted: true, code: "ok" }),
    unpair: () => ({ accepted: true, code: "ok" }),
    listSnapshot: () => snapshot(),
    observeSnapshot: () => ({ snapshotRevision: 3, snapshot: snapshot() }),
    compatibilityCheck: () => compatibilityReport(),
    compatibilityCertify: () => compatibilityCertificationReport(),
    deliveryStatus: () => ({
      found: true,
      state: "delivered",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    }),
    untrack: () => ({ accepted: true, code: "ok" }),
    sendToClaude: () => ({
      accepted: true,
      code: "ok",
      conversationId: CONVERSATION_ID,
      deliveryToken: DELIVERY_TOKEN,
    }),
    sendToCodex: () => ({
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
    refreshDashboard: () => ({
      accepted: true,
      code: "ok",
      revision: 8,
    }),
    ...overrides,
  };
}

function compatibilityReport(): CompatibilityCheckReport {
  const surfaces = (["claude", "codex"] as const).map((surface) =>
    evaluateCompatibilityAttestation({
      surface,
      version: certifiedCompatibilityVersions[surface][0]!,
      checkedAt: NOW,
      policy: "observed",
      certifiedVersions: certifiedCompatibilityVersions[surface],
      probes: compatibilityProbeNames[surface].map((name) => ({
        name,
        outcome: "pass" as const,
      })),
    }),
  );
  return { policy: "observed", compatible: true, surfaces };
}

function compatibilityCertificationReport(): CompatibilityCertificationReport {
  const report = compatibilityReport();
  return {
    policy: report.policy,
    certified: true,
    withTurn: false,
    surfaces: report.surfaces.map((attestation) =>
      attachCompatibilityCertification(attestation, {
        depth: attestation.surface === "claude" ? "wire" : "thread_ops",
        outcome: "pass",
        certifiedAt: NOW,
      }),
    ),
  };
}

async function rawRequest(
  socketPath: string,
  payload: string | Buffer,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    socket.setTimeout(2_000);
    socket.once("connect", () => socket.write(payload));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      socket.destroy();
      resolve(
        JSON.parse(buffered.subarray(0, newline).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
    });
  });
}

function wireRequest(method: string, params: unknown): string {
  return `${JSON.stringify({
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    method,
    params,
  })}\n`;
}

function trackedServer(
  handler: (socket: net.Socket) => void,
): { server: net.Server; connections: Set<net.Socket> } {
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    handler(socket);
  });
  return { server, connections };
}

async function closeTrackedServer(
  server: net.Server,
  connections: Set<net.Socket>,
): Promise<void> {
  for (const socket of connections) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function assertWireError(
  response: Record<string, unknown>,
  code: string,
): void {
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.ok, false);
  assert.equal(
    (response.error as { code: string }).code,
    code,
  );
}

test("serves the two directional routes and emits metadata-only responses", async () => {
  const { stateDir, socketPath } = await privateState();
  let registered: ValidatedRegisterCodexParams | undefined;
  let toClaude: ValidatedSendToClaudeParams | undefined;
  let toCodex: ValidatedSendToCodexParams | undefined;
  let paired: unknown;
  let unpaired: unknown;
  let removedStaleCodexAlias: string | undefined;
  let reply: unknown;
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      registerCodex: (params) => {
        registered = { ...params };
        return { accepted: true, code: "ok" };
      },
      pair: (params) => {
        paired = { ...params };
        return { accepted: true, code: "ok" };
      },
      unpair: (params) => {
        unpaired = { ...params };
        return { accepted: true, code: "ok" };
      },
      removeStaleCodexRegistration: ({ alias }) => {
        removedStaleCodexAlias = alias;
        return { accepted: true, code: "ok" };
      },
      sendToClaude: (params) => {
        toClaude = { ...params };
        return {
          accepted: true,
          code: "ok",
          conversationId: CONVERSATION_ID,
          deliveryToken: DELIVERY_TOKEN,
        };
      },
      sendToCodex: (params) => {
        toCodex = { ...params };
        return {
          accepted: true,
          code: "ok",
          conversationId: CONVERSATION_ID,
          deliveryToken: DELIVERY_TOKEN,
        };
      },
      reply: (params) => {
        reply = structuredClone(params);
        return {
          accepted: true,
          code: "ok",
          conversationId: CONVERSATION_ID,
          deliveryToken: DELIVERY_TOKEN,
        };
      },
    }),
  });

  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await sendGatewayControlRequest({
      socketPath,
      request: { protocolVersion: 1, method: "health", params: {} },
    }),
    {
      protocolVersion: 1,
      ok: true,
      result: { status: "ok", revision: 7 },
    },
  );

  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "register_codex",
      params: {
        alias: "codex-main@this-mac",
        threadId: THREAD_ID.toUpperCase(),
      },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "select_claude",
      params: { alias: "claude-one@build-mac" },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "unselect_claude",
      params: { alias: "claude-one@build-mac" },
    },
  });
  assert.deepEqual(registered, {
    alias: "codex-main@this-mac",
    threadId: THREAD_ID,
    hostId: "this-mac",
    busyPolicy: "queue",
  });
  for (const method of ["pair", "unpair"] as const) {
    await sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method,
        params: {
          claudeAlias: "claude-one@this-mac",
          codexAlias: "codex-main@this-mac",
          codexThreadId: THREAD_ID.toUpperCase(),
        },
      },
    });
  }
  const expectedPair = {
    claudeAlias: "claude-one@this-mac",
    codexAlias: "codex-main@this-mac",
    codexThreadId: THREAD_ID,
  };
  assert.deepEqual(paired, expectedPair);
  assert.deepEqual(unpaired, expectedPair);
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "remove_stale_codex_registration",
      params: { alias: "codex-orphan@this-mac" },
    },
  });
  assert.equal(removedStaleCodexAlias, "codex-orphan@this-mac");
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "pair",
      params: {
        claudeAlias: "claude-two@this-mac",
        codexAlias: "codex-main@this-mac",
      },
    },
  });
  assert.deepEqual(paired, {
    claudeAlias: "claude-two@this-mac",
    codexAlias: "codex-main@this-mac",
  });

  const secretText = "transient body that must not appear in the response";
  const outbound = await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "send_to_claude",
      params: {
        fromAlias: "codex-main@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude-one@build-mac",
        text: secretText,
        expectsReply: true,
      },
    },
  });
  assert.deepEqual(toClaude, {
    fromAlias: "codex-main@this-mac",
    threadId: THREAD_ID,
    toAlias: "claude-one@build-mac",
    text: secretText,
    expectsReply: true,
  });
  assert.equal(JSON.stringify(outbound).includes(THREAD_ID), false);
  assert.equal(JSON.stringify(outbound).includes(secretText), false);
  assert.equal(
    outbound.ok && outbound.result.accepted
      ? outbound.result.deliveryToken
      : undefined,
    DELIVERY_TOKEN,
  );

  assert.deepEqual(
    await sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method: "delivery_status",
        params: { token: DELIVERY_TOKEN },
      },
    }),
    {
      protocolVersion: 1,
      ok: true,
      result: {
        found: true,
        state: "delivered",
        terminal: true,
        updatedAt: NOW,
        deadlineAt: DEADLINE,
      },
    },
  );

  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "send_to_codex",
      params: {
        fromAlias: "claude-one@build-mac",
        toAlias: "codex-main@this-mac",
        text: secretText,
        replyAddress: "uds:/tmp/cc-socks/12345.sock",
      },
    },
  });
  assert.deepEqual(toCodex, {
    fromAlias: "claude-one@build-mac",
    toAlias: "codex-main@this-mac",
    text: secretText,
    replyAddress: "uds:/tmp/cc-socks/12345.sock",
    expectsReply: false,
  });

  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "reply",
      params: {
        conversationId: CONVERSATION_ID,
        text: secretText,
        caller: {
          kind: "codex",
          alias: "codex-main@this-mac",
          threadId: THREAD_ID.toUpperCase(),
        },
      },
    },
  });
  assert.deepEqual(reply, {
    conversationId: CONVERSATION_ID,
    text: secretText,
    caller: {
      kind: "codex",
      alias: "codex-main@this-mac",
      threadId: THREAD_ID,
    },
  });

  const listed = await sendGatewayControlRequest({
    socketPath,
    request: { protocolVersion: 1, method: "list_snapshot", params: {} },
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) assert.fail("expected a projected public snapshot");
  assert.equal("snapshotRevision" in listed.result, false);
  assert.deepEqual(
    listed.result.messages.map((event) => event.state),
    ["transport_written", "held", "unconfirmed"],
  );
  assert.deepEqual(listed.result.truncation, {
    connectors: 0,
    availablePeers: 0,
    routes: 0,
    pairs: 0,
    progressWatches: 0,
    progressWatchEvents: 0,
    activityEvents: 0,
    messages: 0,
    alerts: 0,
  });
  assert.equal(JSON.stringify(listed).includes("threadId"), false);
  assert.equal(JSON.stringify(listed).includes(secretText), false);

  const observed = await sendGatewayControlRequest({
    socketPath,
    request: { protocolVersion: 1, method: "observe_snapshot", params: {} },
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) assert.fail("expected an atomic public observation");
  assert.equal(observed.result.snapshotRevision, 3);
  assert.deepEqual(observed.result.snapshot, snapshot());
  assert.equal(JSON.stringify(observed).includes("threadId"), false);
  assert.equal(JSON.stringify(observed).includes(secretText), false);

  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "unregister_codex",
      params: { alias: "codex-main@this-mac", threadId: THREAD_ID },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "refresh_dashboard",
      params: {},
    },
  });

  await server.close();
  await server.close();
  assert.equal(server.closed, true);
  await assert.rejects(lstat(socketPath), { code: "ENOENT" });
});

test("normalizes a same-host Codex succession without exposing private identifiers", async () => {
  const { stateDir, socketPath } = await privateState();
  let registered: ValidatedRegisterCodexParams | undefined;
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      registerCodex: (params) => {
        registered = { ...params };
        return { accepted: true, code: "ok" };
      },
    }),
  });

  const alias = "codex-next@build-mac";
  const succeedsAlias = "codex-reviewer@build-mac";
  const response = await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: 1,
      method: "register_codex",
      params: {
        alias,
        threadId: THREAD_ID.toUpperCase(),
        hostId: "build-mac",
        succeedsAlias,
      },
    },
  });

  assert.deepEqual(registered, {
    alias,
    threadId: THREAD_ID,
    hostId: "build-mac",
    busyPolicy: "queue",
    succeedsAlias,
  });
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(THREAD_ID), false);
  assert.equal(serialized.includes(alias), false);
  assert.equal(serialized.includes(succeedsAlias), false);
  await server.close();
});

test("only exposes queue-mode lifecycle methods", () => {
  assert.deepEqual(gatewayControlMethods, [
    "health",
    "register_codex",
    "unregister_codex",
    "remove_stale_codex_registration",
    "select_claude",
    "unselect_claude",
    "pair",
    "unpair",
    "list_snapshot",
    "observe_snapshot",
    "compat_check",
    "compat_certify",
    "delivery_status",
    "untrack",
    "send_to_claude",
    "send_to_codex",
    "reply",
    "refresh_dashboard",
  ]);
  assert.equal(isGatewayAlias("codex-main@this-mac"), true);
  assert.equal(isGatewayAlias("codex-main"), false);
  assert.equal(isGatewayAlias("Codex Main"), false);
  assert.equal(isGatewayHostId("lab-mac.example"), true);
  assert.equal(isGatewayHostId("Max WS"), false);
  assert.equal(isGatewayConversationId(createGatewayConversationId()), true);
  assert.equal(isGatewayDeliveryToken(DELIVERY_TOKEN), true);
  assert.equal(isGatewayDeliveryToken(`${DELIVERY_TOKEN}x`), false);
  assert.equal(isGatewayDeliveryToken("dlv_not+base64url____________"), false);
  assert.equal(isGatewayReplyAddress("uds:/tmp/cc-socks/123.sock"), true);
  assert.equal(isGatewayReplyAddress("/tmp/cc-socks/123.sock"), false);
  assert.equal(isGatewayReplyAddress("uds:relative.sock"), false);
  assert.equal(isGatewayReplyAddress("uds:/tmp/cc-socks/bad\0.sock"), false);
});

test("rejects untrusted fields, invalid ownership, steering, and unsafe reply routing", async () => {
  const { stateDir, socketPath } = await privateState();
  let called = 0;
  const count = (): { accepted: true; code: "ok" } => {
    called += 1;
    return { accepted: true, code: "ok" };
  };
  const countSend = () => {
    called += 1;
    return {
      accepted: true as const,
      code: "ok" as const,
      conversationId: CONVERSATION_ID,
      deliveryToken: DELIVERY_TOKEN,
    };
  };
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      registerCodex: count,
      unregisterCodex: count,
      removeStaleCodexRegistration: count,
      deliveryStatus: () => {
        called += 1;
        return { found: false };
      },
      reply: countSend,
    }),
  });

  const invalidRequests: Array<[string, unknown]> = [
    ["register_codex", { alias: "Bad Alias", threadId: THREAD_ID }],
    [
      "register_codex",
      { alias: "reviewer@this-mac", threadId: THREAD_ID },
    ],
    [
      "register_codex",
      { alias: "codex@this-mac", threadId: "not-a-uuid" },
    ],
    [
      "register_codex",
      { alias: "codex@this-mac", threadId: THREAD_ID, hostId: "M5 DEV" },
    ],
    [
      "register_codex",
      { alias: "codex@this-mac", threadId: THREAD_ID, hostId: "build-mac" },
    ],
    [
      "register_codex",
      {
        alias: "codex@this-mac",
        threadId: THREAD_ID,
        busyPolicy: "live_steer",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex@this-mac",
        threadId: THREAD_ID,
        endpoint: "/tmp/fake.sock",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: "reviewer@this-mac",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: "codex-next@this-mac",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: "codex-reviewer@build-mac",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: null,
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: "codex-reviewer@this-mac",
        oldThreadId: "00000000-0000-7000-8000-000000000702",
      },
    ],
    [
      "register_codex",
      {
        alias: "codex-next@this-mac",
        threadId: THREAD_ID,
        succeedsAlias: "codex-reviewer@this-mac",
        succeedsThreadId: "00000000-0000-7000-8000-000000000702",
      },
    ],
    [
      "send_to_claude",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "   ",
      },
    ],
    [
      "send_to_claude",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "hello\0smuggled",
      },
    ],
    [
      "send_to_claude",
      {
        fromAlias: "codex@this-mac",
        threadId: "not-a-uuid",
        toAlias: "claude@build-mac",
        text: "hello",
      },
    ],
    [
      "send_to_claude",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "x".repeat(16 * 1024 + 1),
      },
    ],
    [
      "send_to_codex",
      {
        fromAlias: "claude@build-mac",
        toAlias: "codex@this-mac",
        text: "hello",
        replyAddress: "uds:../outside.sock",
      },
    ],
    ["delivery_status", { token: "dlv_too-short" }],
    ["delivery_status", { token: DELIVERY_TOKEN, extra: true }],
    ["observe_snapshot", { extra: true }],
    ["compat_check", { extra: true }],
    ["remove_stale_codex_registration", { alias: "claude@this-mac" }],
    ["remove_stale_codex_registration", { alias: "codex-main" }],
    [
      "remove_stale_codex_registration",
      { alias: "codex-main@this-mac", threadId: THREAD_ID },
    ],
    [
      "remove_stale_codex_registration",
      { alias: "codex-main@this-mac", endpointGeneration: "old" },
    ],
    [
      "reply",
      {
        conversationId: CONVERSATION_ID,
        text: "hello",
        caller: {
          kind: "claude",
          alias: "claude@build-mac",
          destination: "codex@this-mac",
        },
      },
    ],
    [
      "reply",
      {
        conversationId: "bad-id",
        text: "hello",
        caller: {
          kind: "codex",
          alias: "codex@this-mac",
          threadId: THREAD_ID,
        },
      },
    ],
  ];

  for (const [method, params] of invalidRequests) {
    const response = await rawRequest(socketPath, wireRequest(method, params));
    assertWireError(response, "INVALID_REQUEST");
    assert.equal(JSON.stringify(response).includes(THREAD_ID), false);
  }
  assert.equal(called, 0);

  assertWireError(
    await rawRequest(socketPath, wireRequest("steer", {})),
    "UNKNOWN_METHOD",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      `${JSON.stringify({ protocolVersion: 2, method: "health", params: {} })}\n`,
    ),
    "UNSUPPORTED_VERSION",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      `${JSON.stringify({
        protocolVersion: 1,
        method: "health",
        params: {},
        extra: true,
      })}\n`,
    ),
    "INVALID_REQUEST",
  );
  await server.close();
});

test("delivery status and receipt results are closed and internally consistent", async () => {
  const { stateDir, socketPath } = await privateState();
  const statusCandidates: unknown[] = [
    { found: false },
    {
      found: true,
      state: "queued",
      terminal: false,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      pendingForMs: 125,
    },
    {
      found: true,
      state: "stalled",
      terminal: false,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      pendingForMs: 5_000,
      safeErrorCode: "DELIVERY_STALLED",
    },
    {
      found: true,
      state: "cancelled",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    },
    {
      found: true,
      state: "delivered",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    },
    {
      found: true,
      state: "unconfirmed",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      safeErrorCode: "CLAUDE_NATIVE_ACK_UNAVAILABLE",
    },
    {
      found: true,
      state: "expired",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      safeErrorCode: "DELIVERY_DEADLINE_EXPIRED",
    },
    {
      found: true,
      state: "failed",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      safeErrorCode: "DELIVERY_FAILED",
    },
    {
      found: true,
      state: "ambiguous",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      safeErrorCode: "DELIVERY_AMBIGUOUS",
    },
    {
      found: true,
      state: "queued",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    },
    {
      found: true,
      state: "unconfirmed",
      terminal: false,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    },
    {
      found: true,
      state: "delivered",
      terminal: true,
      updatedAt: "not-a-timestamp",
      deadlineAt: DEADLINE,
    },
    {
      found: true,
      state: "failed",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
      pendingForMs: -1,
    },
    { found: false, safeErrorCode: "MUST_NOT_BE_PRESENT" },
  ];
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      deliveryStatus: () => statusCandidates.shift() as never,
      sendToClaude: () =>
        ({
          accepted: true,
          code: "ok",
          conversationId: CONVERSATION_ID,
        }) as never,
      reply: () => ({
        accepted: true,
        code: "ok",
        conversationId: CONVERSATION_ID,
        deliveryToken: "dlv_invalid+token___________",
      }) as never,
    }),
  });

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await rawRequest(
      socketPath,
      wireRequest("delivery_status", { token: DELIVERY_TOKEN }),
    );
    assert.equal(response.ok, true);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertWireError(
      await rawRequest(
        socketPath,
        wireRequest("delivery_status", { token: DELIVERY_TOKEN }),
      ),
      "INVALID_HANDLER_RESPONSE",
    );
  }

  assertWireError(
    await rawRequest(
      socketPath,
      wireRequest("send_to_claude", {
        fromAlias: "codex-main@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude-one@build-mac",
        text: "bounded body",
      }),
    ),
    "INVALID_HANDLER_RESPONSE",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      wireRequest("reply", {
        conversationId: CONVERSATION_ID,
        text: "bounded reply",
        caller: {
          kind: "codex",
          alias: "codex-main@this-mac",
          threadId: THREAD_ID,
        },
      }),
    ),
    "INVALID_HANDLER_RESPONSE",
  );
  await server.close();
});

test("enforces one bounded JSONL frame per connection", async () => {
  const { stateDir, socketPath } = await privateState();
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers(),
    requestTimeoutMs: 50,
  });

  assertWireError(await rawRequest(socketPath, "not json\n"), "INVALID_JSON");
  assertWireError(
    await rawRequest(socketPath, Buffer.from([0xff, 0x0a])),
    "INVALID_JSON",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      `${wireRequest("health", {})}${wireRequest("health", {})}`,
    ),
    "MULTIPLE_FRAMES",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      Buffer.alloc(GATEWAY_CONTROL_MAX_FRAME_BYTES + 1, 0x20),
    ),
    "FRAME_TOO_LARGE",
  );

  const timedOut = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffered.subarray(0, newline).toString("utf8")));
    });
  });
  assertWireError(timedOut, "REQUEST_TIMEOUT");
  await server.close();
});

test("never reflects handler exceptions or invalid private response fields", async () => {
  const { stateDir, socketPath } = await privateState();
  const secretText = "do-not-reflect-this-body";
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      sendToClaude: () => {
        throw new Error(`${THREAD_ID} ${secretText}`);
      },
      listSnapshot: () =>
        ({ ...snapshot(), threadId: THREAD_ID, text: secretText }) as GatewaySnapshot,
    }),
  });

  const failed = await rawRequest(
    socketPath,
    wireRequest("send_to_claude", {
      fromAlias: "codex-main@this-mac",
      threadId: THREAD_ID,
      toAlias: "claude-one@build-mac",
      text: secretText,
    }),
  );
  assertWireError(failed, "HANDLER_FAILURE");
  assert.equal(JSON.stringify(failed).includes(THREAD_ID), false);
  assert.equal(JSON.stringify(failed).includes(secretText), false);

  const invalid = await rawRequest(
    socketPath,
    wireRequest("list_snapshot", {}),
  );
  assertWireError(invalid, "INVALID_HANDLER_RESPONSE");
  assert.equal(JSON.stringify(invalid).includes(THREAD_ID), false);
  assert.equal(JSON.stringify(invalid).includes(secretText), false);
  await server.close();
});

test("list_snapshot requires bounded projection and explicit omission counts", async () => {
  const { stateDir, socketPath } = await privateState();
  const { truncation: _omitted, ...withoutTruncation } = snapshot();
  const { inboundMode: _inboundMode, ...withoutInboundMode } = snapshot();
  const invalidInboundMode = { ...snapshot(), inboundMode: "closed" };
  const invalidCount = snapshot();
  invalidCount.truncation.messages = -1;
  const inconsistentQueueAge = snapshot();
  const queuedRoute = inconsistentQueueAge.routes.find(
    (route) => route.oldestQueuedAt !== undefined,
  );
  assert.ok(queuedRoute);
  queuedRoute.queueDepth = 0;
  const invalidWatch = snapshot();
  const watch = invalidWatch.progressWatches?.[0];
  assert.ok(watch);
  watch.conversationIdSuffix = "conv_SECRET";
  const invalidActivity = snapshot();
  const activity = invalidActivity.activityEvents?.[0];
  assert.ok(activity);
  activity.aliases = ["PRIVATE_TASK_ID"];
  const invalidActivityKindAction = snapshot();
  const kindAction = invalidActivityKindAction.activityEvents?.[0];
  assert.ok(kindAction);
  kindAction.kind = "endpoint";
  kindAction.action = "routes_paired";
  kindAction.operatorAction = false;
  const invalidAutomaticAuthority = snapshot();
  const automaticAuthority = invalidAutomaticAuthority.activityEvents?.[0];
  assert.ok(automaticAuthority);
  automaticAuthority.kind = "endpoint";
  automaticAuthority.action = "endpoint_refreshed";
  automaticAuthority.operatorAction = true;
  const invalidRecoveryAuthority = snapshot();
  const recoveryAuthority = invalidRecoveryAuthority.activityEvents?.[0];
  assert.ok(recoveryAuthority);
  recoveryAuthority.kind = "recovery";
  recoveryAuthority.action = "codex_orphan_removed";
  recoveryAuthority.operatorAction = false;
  const invalidDeadline = snapshot();
  assert.ok(invalidDeadline.deadlinePressure);
  invalidDeadline.deadlinePressure.expiredEvents = 2;
  const unprojected = snapshot();
  const baseEvent = unprojected.messages[0];
  assert.ok(baseEvent);
  unprojected.messages = Array.from({ length: 1_024 }, (_, index) => ({
    ...baseEvent,
    sequence: index,
    messageIdSuffix: index.toString(16).padStart(8, "0"),
    sourceAlias: `${"a".repeat(32)}@${"b".repeat(63)}`,
    targetAlias: `${"c".repeat(32)}@${"d".repeat(63)}`,
  }));
  const candidates = [
    withoutTruncation,
    withoutInboundMode,
    invalidInboundMode,
    invalidCount,
    inconsistentQueueAge,
    invalidWatch,
    invalidActivity,
    invalidActivityKindAction,
    invalidAutomaticAuthority,
    invalidRecoveryAuthority,
    invalidDeadline,
    unprojected,
  ];
  const attempts = candidates.length;
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      listSnapshot: () => candidates.shift() as GatewaySnapshot,
    }),
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await rawRequest(
      socketPath,
      wireRequest("list_snapshot", {}),
    );
    assertWireError(response, "INVALID_HANDLER_RESPONSE");
  }
  await server.close();
});

test("activity validation binds each kind to its exact action and authority", async () => {
  const { stateDir, socketPath } = await privateState();
  const endpoint = snapshot();
  endpoint.activityEvents = [
    {
      sequence: 1,
      timestamp: NOW,
      kind: "endpoint",
      action: "endpoint_refreshed",
      outcome: "accepted",
      aliases: ["codex-main@this-mac"],
      operatorAction: false,
    },
  ];
  const recovery = snapshot();
  recovery.activityEvents = [
    {
      sequence: 2,
      timestamp: NOW,
      kind: "recovery",
      action: "codex_orphan_removed",
      outcome: "accepted",
      aliases: ["codex-main@this-mac"],
      operatorAction: true,
    },
  ];
  const candidates = [endpoint, recovery];
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      listSnapshot: () => candidates.shift() as GatewaySnapshot,
    }),
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await rawRequest(
      socketPath,
      wireRequest("list_snapshot", {}),
    );
    assert.equal(response.ok, true);
  }
  await server.close();
});

test("observe_snapshot enforces a closed revision-and-snapshot result", async () => {
  const { stateDir, socketPath } = await privateState();
  const privateSnapshot = { ...snapshot(), threadId: THREAD_ID };
  const candidates: unknown[] = [
    { snapshotRevision: -1, snapshot: snapshot() },
    { snapshotRevision: 0, snapshot: privateSnapshot },
    { snapshotRevision: 0, snapshot: snapshot(), extra: true },
  ];
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      observeSnapshot: () => candidates.shift() as never,
    }),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await rawRequest(
      socketPath,
      wireRequest("observe_snapshot", {}),
    );
    assertWireError(response, "INVALID_HANDLER_RESPONSE");
    assert.equal(JSON.stringify(response).includes(THREAD_ID), false);
  }
  await server.close();
});

test("observe_snapshot carries a maximally projected snapshot under the control cap", async () => {
  const { stateDir, socketPath } = await privateState();
  const oversized = snapshot();
  const baseEvent = oversized.messages[0];
  assert.ok(baseEvent);
  oversized.messages = Array.from({ length: 1_024 }, (_, index) => ({
    ...baseEvent,
    sequence: index,
    messageIdSuffix: index.toString(16).padStart(8, "0"),
    sourceAlias: `${"a".repeat(32)}@${"b".repeat(63)}`,
    targetAlias: `${"c".repeat(32)}@${"d".repeat(63)}`,
    safeErrorCode: "MAXIMALLY_BOUNDED_SYNTHETIC_EVENT",
  }));
  const projected = projectGatewayPublicSnapshot(oversized);
  assert.ok(projected.truncation.messages > 0);

  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      observeSnapshot: () => ({
        snapshotRevision: Number.MAX_SAFE_INTEGER,
        snapshot: projected,
      }),
    }),
  });
  const response = await rawRequest(
    socketPath,
    wireRequest("observe_snapshot", {}),
  );
  assert.equal(response.ok, true);
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8") <=
      GATEWAY_CONTROL_MAX_RESPONSE_BYTES,
  );
  const result = response.result as {
    snapshotRevision: number;
    snapshot: GatewaySnapshot;
  };
  assert.equal(result.snapshotRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(
    result.snapshot.truncation.messages,
    projected.truncation.messages,
  );
  await server.close();
});

test("compat_check accepts only the exact bounded report schema", async () => {
  const { stateDir, socketPath } = await privateState();
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers(),
  });
  const accepted = await rawRequest(
    socketPath,
    wireRequest("compat_check", {}),
  );
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.result, compatibilityReport());
  await server.close();

  const invalidState = await privateState();
  const invalidServer = await startGatewayControlServer({
    stateDir: invalidState.stateDir,
    socketPath: invalidState.socketPath,
    handlers: handlers({
      compatibilityCheck: () => ({
        ...compatibilityReport(),
        compatible: false,
      }),
    }),
  });
  const rejected = await rawRequest(
    invalidState.socketPath,
    wireRequest("compat_check", {}),
  );
  assertWireError(rejected, "INVALID_HANDLER_RESPONSE");
  await invalidServer.close();
});

test("compat_certify accepts only one exact route choice and closed evidence", async () => {
  const { stateDir, socketPath } = await privateState();
  const observed: unknown[] = [];
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      compatibilityCertify: (params) => {
        observed.push(params);
        return compatibilityCertificationReport();
      },
    }),
  });
  const accepted = await rawRequest(
    socketPath,
    wireRequest("compat_certify", {
      codexAlias: "codex-main@this-mac",
      withTurn: false,
    }),
  );
  assert.equal(accepted.ok, true);
  assert.deepEqual(observed, [
    { codexAlias: "codex-main@this-mac", withTurn: false },
  ]);
  for (const params of [
    {},
    { withTurn: false, extra: true },
    { codexAlias: "claude-main@this-mac", withTurn: false },
    { withTurn: "false" },
  ]) {
    assertWireError(
      await rawRequest(socketPath, wireRequest("compat_certify", params)),
      "INVALID_REQUEST",
    );
  }
  await server.close();

  const invalidState = await privateState();
  const invalidServer = await startGatewayControlServer({
    stateDir: invalidState.stateDir,
    socketPath: invalidState.socketPath,
    handlers: handlers({
      compatibilityCertify: () => ({
        ...compatibilityCertificationReport(),
        certified: false,
      }),
    }),
  });
  assertWireError(
    await rawRequest(
      invalidState.socketPath,
      wireRequest("compat_certify", { withTurn: false }),
    ),
    "INVALID_HANDLER_RESPONSE",
  );
  await invalidServer.close();
});

test("caps concurrent same-user control connections with a normalized busy response", async () => {
  const { stateDir, socketPath } = await privateState();
  let healthCalls = 0;
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      health: () => {
        healthCalls += 1;
        return { status: "ok", revision: 1 };
      },
    }),
    requestTimeoutMs: 5_000,
  });

  const held = await Promise.all(
    Array.from(
      { length: GATEWAY_CONTROL_MAX_CONNECTIONS },
      async () =>
        await new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(socketPath);
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const busy = await rawRequest(socketPath, wireRequest("health", {}));
  assertWireError(busy, "SERVER_BUSY");
  assert.equal(
    (busy.error as { message: string }).message,
    "The gateway control server is at its connection limit.",
  );
  assert.equal(healthCalls, 0);

  for (const socket of held) socket.destroy();
  await server.close();
});

test("requires a private state directory and preserves unsafe socket targets", async () => {
  const { root, stateDir, socketPath } = await privateState();
  await chmod(stateDir, 0o755);
  await assert.rejects(
    startGatewayControlServer({ stateDir, socketPath, handlers: handlers() }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "INSECURE_STATE_DIR",
  );

  await chmod(stateDir, 0o700);
  await writeFile(socketPath, "keep-me", { mode: 0o600 });
  await assert.rejects(
    startGatewayControlServer({ stateDir, socketPath, handlers: handlers() }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "UNSAFE_SOCKET_TARGET",
  );
  assert.equal(await readFile(socketPath, "utf8"), "keep-me");

  await unlink(socketPath);
  const target = path.join(stateDir, "target");
  await writeFile(target, "keep-target", { mode: 0o600 });
  await symlink(target, socketPath);
  await assert.rejects(
    startGatewayControlServer({ stateDir, socketPath, handlers: handlers() }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "UNSAFE_SOCKET_TARGET",
  );
  assert.equal((await lstat(socketPath)).isSymbolicLink(), true);

  const outside = path.join(root, "outside.sock");
  await assert.rejects(
    startGatewayControlServer({ stateDir, socketPath: outside, handlers: handlers() }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "INVALID_SOCKET_PATH",
  );
});

test("does not unlink a live socket and can recover an exact stale socket", async () => {
  const { stateDir, socketPath } = await privateState();
  const live = net.createServer();
  await new Promise<void>((resolve, reject) => {
    live.once("error", reject);
    live.listen(socketPath, resolve);
  });
  await assert.rejects(
    startGatewayControlServer({ stateDir, socketPath, handlers: handlers() }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "SOCKET_IN_USE",
  );
  assert.equal((await lstat(socketPath)).isSocket(), true);
  await new Promise<void>((resolve) => live.close(() => resolve()));

  const childScript = [
    'const net = require("node:net");',
    "const server = net.createServer();",
    'server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
    "setInterval(() => {}, 1000);",
  ].join("");
  const child = spawn(process.execPath, ["-e", childScript, socketPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve());
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal((await lstat(socketPath)).isSocket(), true);

  const recovered = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers(),
  });
  const response = await sendGatewayControlRequest({
    socketPath,
    request: { protocolVersion: 1, method: "health", params: {} },
  });
  assert.equal(response.ok, true);
  await recovered.close();
});

test("close removes only the exact socket it owns", async () => {
  const { stateDir, socketPath } = await privateState();
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers(),
  });
  await unlink(socketPath);
  await writeFile(socketPath, "replacement", { mode: 0o600 });
  await server.close();
  assert.equal(await readFile(socketPath, "utf8"), "replacement");
});

test("client bounds time and output and rejects malformed responses", async () => {
  const { stateDir, socketPath } = await privateState();
  const oversized = trackedServer((socket) => {
    socket.end(`${"x".repeat(300)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    oversized.server.once("error", reject);
    oversized.server.listen(socketPath, resolve);
  });
  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: { protocolVersion: 1, method: "health", params: {} },
      maxResponseBytes: 256,
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_RESPONSE_TOO_LARGE",
  );
  await closeTrackedServer(oversized.server, oversized.connections);

  const silent = trackedServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    silent.server.once("error", reject);
    silent.server.listen(socketPath, resolve);
  });
  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: { protocolVersion: 1, method: "health", params: {} },
      timeoutMs: 50,
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_TIMEOUT",
  );
  await closeTrackedServer(silent.server, silent.connections);

  const malformed = trackedServer((socket) => {
    socket.end(
      `${JSON.stringify({
        protocolVersion: 1,
        ok: true,
        result: { status: "ok", revision: 1, threadId: THREAD_ID },
      })}\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    malformed.server.once("error", reject);
    malformed.server.listen(socketPath, resolve);
  });
  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: { protocolVersion: 1, method: "health", params: {} },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_INVALID_RESPONSE" &&
      !error.message.includes(THREAD_ID),
  );
  await closeTrackedServer(malformed.server, malformed.connections);
});

test("client marks only lost mutation responses ambiguous after write starts", async () => {
  const { stateDir, socketPath } = await privateState();
  const executedThenClosed = trackedServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    executedThenClosed.server.once("error", reject);
    executedThenClosed.server.listen(socketPath, resolve);
  });

  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method: "send_to_claude",
        params: {
          fromAlias: "codex-main@this-mac",
          threadId: THREAD_ID,
          toAlias: "claude-one@build-mac",
          text: "one bounded mutation",
        },
      },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_OUTCOME_AMBIGUOUS" &&
      error.ambiguous &&
      !error.recoverable,
  );
  await closeTrackedServer(
    executedThenClosed.server,
    executedThenClosed.connections,
  );

  const recoveryThenClosed = trackedServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    recoveryThenClosed.server.once("error", reject);
    recoveryThenClosed.server.listen(socketPath, resolve);
  });
  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method: "remove_stale_codex_registration",
        params: { alias: "codex-orphan@this-mac" },
      },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_OUTCOME_AMBIGUOUS" &&
      error.ambiguous &&
      !error.recoverable,
  );
  await closeTrackedServer(
    recoveryThenClosed.server,
    recoveryThenClosed.connections,
  );

  const statusThenClosed = trackedServer((socket) => {
    socket.once("data", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    statusThenClosed.server.once("error", reject);
    statusThenClosed.server.listen(socketPath, resolve);
  });
  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method: "delivery_status",
        params: { token: DELIVERY_TOKEN },
      },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_CONNECTION_CLOSED" &&
      !error.ambiguous &&
      error.recoverable,
  );
  await closeTrackedServer(
    statusThenClosed.server,
    statusThenClosed.connections,
  );

  await assert.rejects(
    sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: 1,
        method: "send_to_claude",
        params: {
          fromAlias: "codex-main@this-mac",
          threadId: THREAD_ID,
          toAlias: "claude-one@build-mac",
          text: "not connected",
        },
      },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_CONNECT_FAILED" &&
      !error.ambiguous &&
      error.recoverable,
  );

  assert.equal((await lstat(stateDir)).isDirectory(), true);
});
