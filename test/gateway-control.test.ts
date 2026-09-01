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
  isGatewaySnapshot,
  sendGatewayControlRequest,
  startGatewayControlServer,
  type ValidatedRegisterCodexParams,
  type ValidatedSendParams,
} from "../src/gateway/control.js";
import {
  CONNECTOR_OBSERVATION_STALE_AFTER_MS,
  projectGatewayPublicSnapshot,
  messageDirections,
} from "../src/gateway/types.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const CONVERSATION_ID = "conv_0123456789abcdef";
const DELIVERY_TOKEN = "dlv_0123456789abcdefghijklmn";
const PEER_TOKEN = `peer_${"a".repeat(32)}`;
const PEER_RECEIPT = `prc_${"b".repeat(24)}`;
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
    schemaVersion: 2,
    generatedAt: NOW,
    inboundMode: "paired",
    health: "healthy",
    connectors: [
      {
        provider: "codex",
        host: "this-mac",
        health: "healthy",
        protocol: "codex-app-server",
        protocolVersion: "0.147.0",
        lastSeenAt: NOW,
        observationAgeMs: 0,
      },
      {
        provider: "claude",
        host: "build-mac",
        health: "healthy",
        protocol: "claude-peer",
        protocolVersion: "1",
        lastSeenAt: NOW,
        observationAgeMs: 0,
        registry: {
          entriesScanned: 3,
          parseableRecords: 2,
          parseableRecordSeenSinceBoot: true,
          rejected: [
            { safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 1 },
          ],
          rejectedCodesOmitted: 0,
        },
      },
    ],
    availablePeers: [
      {
        alias: "claude-two@this-mac",
        provider: "claude",
        host: "this-mac",
        state: "idle",
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
        busyPolicy: "queue",
        lastSeenAt: NOW,
        queueDepth: 0,
        counters: { ...counters },
      },
    ],
    consentEdges: [],
    progressWatches: [
      {
        conversationIdSuffix: "AbCd_123",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        lastActivityAt: NOW,
        nextActionAt: NOW,
        nudgeCount: 0,
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
        actor: "owner",
      },
      {
        sequence: 2,
        timestamp: NOW,
        conversationIdSuffix: "BcDe_234",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "replaced",
        actor: "unknown",
      },
      {
        sequence: 3,
        timestamp: NOW,
        conversationIdSuffix: "CdEf_345",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "settled",
        actor: "worker",
        reason: "done",
      },
      {
        sequence: 4,
        timestamp: NOW,
        conversationIdSuffix: "CdEf_345",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "settled",
        actor: "operator",
        reason: "pair_removed",
      },
      {
        sequence: 5,
        timestamp: NOW,
        conversationIdSuffix: "DeFg_456",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "settled",
        actor: "operator",
        reason: "endpoint_retired",
      },
      {
        sequence: 6,
        timestamp: NOW,
        conversationIdSuffix: "FgHi_678",
        ownerAlias: "codex-main@this-mac",
        workerAlias: "claude-one@build-mac",
        kind: "settled",
        actor: "owner",
        reason: "done",
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
      consentEdges: 0,
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
    removeCodexRegistration: () => ({ accepted: true, code: "ok" }),
    selectClaude: () => ({ accepted: true, code: "ok" }),
    unselectClaude: () => ({ accepted: true, code: "ok" }),
    pair: () => ({ accepted: true, code: "ok" }),
    unpair: () => ({ accepted: true, code: "ok" }),
    listSnapshot: () => snapshot(),
    observeSnapshot: () => ({ snapshotRevision: 3, snapshot: snapshot() }),
    deliveryStatus: () => ({
      found: true,
      state: "delivered",
      terminal: true,
      updatedAt: NOW,
      deadlineAt: DEADLINE,
    }),
    untrack: () => ({ accepted: true, code: "ok" }),
    send: () => ({
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
    registerPeer: () => ({ accepted: true, code: "ok" }),
    unregisterPeer: () => ({ accepted: true, code: "ok" }),
    awaitPeer: () => ({ state: "timeout" }),
    peerReceipt: () => ({ accepted: true, code: "ok" }),
    ...overrides,
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
  assert.equal(response.protocolVersion, GATEWAY_CONTROL_PROTOCOL_VERSION);
  assert.equal(response.ok, false);
  assert.equal(
    (response.error as { code: string }).code,
    code,
  );
}

test("serves the two directional routes and emits metadata-only responses", async () => {
  assert.equal(GATEWAY_CONTROL_PROTOCOL_VERSION, 2);
  const { stateDir, socketPath } = await privateState();
  let registered: ValidatedRegisterCodexParams | undefined;
  let toClaude: ValidatedSendParams | undefined;
  let toCodex: ValidatedSendParams | undefined;
  let paired: unknown;
  let unpaired: unknown;
  let removedCodexAlias: string | undefined;
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
      removeCodexRegistration: ({ alias }) => {
        removedCodexAlias = alias;
        return { accepted: true, code: "ok" };
      },
      send: (params) => {
        if (params.text === "TRACK: owner conflict") {
          return {
            accepted: false as const,
            code: "watch_owner_conflict" as const,
          };
        }
        if ("replyAddress" in params) toCodex = { ...params };
        else toClaude = { ...params };
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
      request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {} },
    }),
    {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      ok: true,
      result: { status: "ok", revision: 7 },
    },
  );

  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "register_codex",
      params: {
        alias: "codex-main@this-mac",
        threadId: THREAD_ID.toUpperCase(),
        hostId: "this-mac",
        busyPolicy: "queue",
      },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "select_claude",
      params: { alias: "claude-one@build-mac" },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method,
        params: {
          aliases: ["claude-one@this-mac", "codex-main@this-mac"],
        },
      },
    });
  }
  const expectedPair = {
    aliases: ["claude-one@this-mac", "codex-main@this-mac"],
  };
  assert.deepEqual(paired, expectedPair);
  assert.deepEqual(unpaired, expectedPair);
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "remove_codex_registration",
      params: { alias: "codex-orphan@this-mac" },
    },
  });
  assert.equal(removedCodexAlias, "codex-orphan@this-mac");
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "pair",
      params: {
        aliases: ["codex-misleading@this-mac", "dsh-misleading@this-mac"],
      },
    },
  });
  assert.deepEqual(paired, {
    aliases: ["codex-misleading@this-mac", "dsh-misleading@this-mac"],
  });

  const secretText = "transient body that must not appear in the response";
  const outbound = await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "send",
      params: {
        fromAlias: "codex-main@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude-one@build-mac",
        text: secretText,
        expectsReply: true,
      },
    },
  });
  assert.deepEqual(
    await sendGatewayControlRequest({
      socketPath,
      request: {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "send",
        params: {
          fromAlias: "codex-main@this-mac",
          threadId: THREAD_ID,
          toAlias: "claude-one@build-mac",
          text: "TRACK: owner conflict",
          expectsReply: false,
        },
      },
    }),
    {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      ok: true,
      result: { accepted: false, code: "watch_owner_conflict" },
    },
  );
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "delivery_status",
        params: { token: DELIVERY_TOKEN },
      },
    }),
    {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "send",
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
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
    request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "list_snapshot", params: {} },
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
    consentEdges: 0,
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
    request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "observe_snapshot", params: {} },
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
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "unregister_codex",
      params: { alias: "codex-main@this-mac", threadId: THREAD_ID },
    },
  });
  await sendGatewayControlRequest({
    socketPath,
    request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
      method: "register_codex",
      params: {
        alias,
        threadId: THREAD_ID.toUpperCase(),
        hostId: "build-mac",
        busyPolicy: "queue",
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
    "remove_codex_registration",
    "select_claude",
    "unselect_claude",
    "pair",
    "unpair",
    "list_snapshot",
    "observe_snapshot",
    "delivery_status",
    "untrack",
    "send",
    "reply",
    "refresh_dashboard",
    "peer_catalog",
    "peer_handoff",
    "register_peer",
    "unregister_peer",
    "await_peer",
    "peer_receipt",
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

test("strictly serves peer registration, long-poll, and receipt controls", async () => {
  const { stateDir, socketPath } = await privateState();
  const calls: unknown[] = [];
  const frame = `${JSON.stringify({ ok: true, command: "await", result: {
    fromAlias: "codex-main@this-mac", toAlias: "peer-shell@this-mac",
    conversationId: CONVERSATION_ID, text: "bounded frame", expectsReply: true,
  } })}\n`;
  const server = await startGatewayControlServer({ stateDir, socketPath, handlers: handlers({
    registerPeer: (params) => { calls.push(params); return params.token === undefined
      ? { accepted: true, code: "ok", token: PEER_TOKEN }
      : { accepted: true, code: "ok" }; },
    unregisterPeer: (params) => { calls.push(params); return { accepted: true, code: "ok" }; },
    awaitPeer: (params) => { calls.push(params); return { state: "message", frame, receipt: PEER_RECEIPT }; },
    peerReceipt: (params) => { calls.push(params); return { accepted: true, code: "ok" }; },
  }) });
  const alias = "peer-shell@this-mac";
  assert.deepEqual((await sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "register_peer", params: { alias },
  } })).ok, true);
  assert.deepEqual((await sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "register_peer", params: { alias, token: PEER_TOKEN },
  } })).ok, true);
  for (const [method, params] of [
    ["unregister_peer", { alias, token: PEER_TOKEN }],
    ["await_peer", { alias, token: PEER_TOKEN }],
    ["peer_receipt", { alias, token: PEER_TOKEN, receipt: PEER_RECEIPT }],
  ] as const) assert.equal((await sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method, params,
  } as never })).ok, true);
  assert.deepEqual(calls, [
    { alias }, { alias, token: PEER_TOKEN }, { alias, token: PEER_TOKEN }, { alias, token: PEER_TOKEN },
    { alias, token: PEER_TOKEN, receipt: PEER_RECEIPT },
  ]);
  for (const request of [
    { method: "send", params: { fromAlias: alias, peerToken: PEER_TOKEN,
      toAlias: "claude-main@this-mac", text: "hello" } },
    { method: "send", params: { fromAlias: alias, peerToken: PEER_TOKEN,
      toAlias: "codex-main@this-mac", text: "hello" } },
    { method: "reply", params: { conversationId: CONVERSATION_ID, text: "hello",
      caller: { kind: "peer", alias, token: PEER_TOKEN } } },
  ] as const) assert.equal((await sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ...request,
  } as never })).ok, true);
  for (const [method, params] of [
    ["register_peer", { alias: "codex-main@this-mac" }],
    ["register_peer", { alias, ownerPid: 123 }],
    ["unregister_peer", { alias, token: `${PEER_TOKEN}x` }],
    ["await_peer", { alias, token: PEER_TOKEN, extra: true }],
    ["peer_receipt", { alias, token: PEER_TOKEN, receipt: `${PEER_RECEIPT}x` }],
    ["send", { fromAlias: alias, toAlias: "claude-main@this-mac", text: "x" }],
    ["send", { fromAlias: alias, threadId: THREAD_ID, peerToken: PEER_TOKEN,
      toAlias: "claude-main@this-mac", text: "x" }],
    ["send", { fromAlias: alias, peerToken: PEER_TOKEN,
      replyAddress: "uds:/tmp/reply.sock", toAlias: "codex-main@this-mac", text: "x" }],
  ] as const) assertWireError(await rawRequest(socketPath, wireRequest(method, params)), "INVALID_REQUEST");
  await server.close();
});

test("client rejects disclosure-bearing peer control results", async () => {
  const { stateDir, socketPath } = await privateState();
  const wrongFrame = `${JSON.stringify({ ok: true, command: "await", result: {
    fromAlias: "codex-main@this-mac", toAlias: "peer-other@this-mac",
    conversationId: CONVERSATION_ID, text: "bounded frame", expectsReply: false,
  } })}\n`;
  const results: unknown[] = [
    { accepted: false, code: "rejected", token: PEER_TOKEN },
    { accepted: true, code: "ok" },
    { accepted: true, code: "ok", token: PEER_TOKEN },
    { state: "timeout", receipt: PEER_RECEIPT },
    { state: "message", frame: wrongFrame, receipt: PEER_RECEIPT },
  ];
  const server = await startGatewayControlServer({ stateDir, socketPath, handlers: handlers({
    registerPeer: () => results.shift() as never,
    awaitPeer: () => results.shift() as never,
  }) });
  for (const [request, code] of [[
    { method: "register_peer", params: { alias: "peer-shell@this-mac" } },
    "CONTROL_OUTCOME_AMBIGUOUS"], [
    { method: "register_peer", params: { alias: "peer-shell@this-mac" } },
    "CONTROL_OUTCOME_AMBIGUOUS"], [
    { method: "register_peer", params: { alias: "peer-shell@this-mac", token: PEER_TOKEN } },
    "CONTROL_OUTCOME_AMBIGUOUS"], [
    { method: "await_peer", params: { alias: "peer-shell@this-mac", token: PEER_TOKEN } },
    "CONTROL_INVALID_RESPONSE"], [
    { method: "await_peer", params: { alias: "peer-shell@this-mac", token: PEER_TOKEN } },
    "CONTROL_INVALID_RESPONSE"],
  ] as const) await assert.rejects(sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, ...request,
  } as never }), (error: unknown) => error instanceof GatewayControlTransportError &&
    error.code === code);
  await server.close();
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
      removeCodexRegistration: count,
      pair: count,
      unpair: count,
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
      "send",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "   ",
      },
    ],
    [
      "send",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "hello\0smuggled",
      },
    ],
    [
      "send",
      {
        fromAlias: "codex@this-mac",
        threadId: "not-a-uuid",
        toAlias: "claude@build-mac",
        text: "hello",
      },
    ],
    [
      "send",
      {
        fromAlias: "codex@this-mac",
        threadId: THREAD_ID,
        toAlias: "claude@build-mac",
        text: "x".repeat(16 * 1024 + 1),
      },
    ],
    [
      "send",
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
    ["remove_codex_registration", { alias: "claude@this-mac" }],
    ["remove_codex_registration", { alias: "codex-main" }],
    ["select_claude", { alias: "claude@this-mac", codexThreadId: THREAD_ID }],
    ["pair", { aliases: ["one@this-mac", "one@this-mac"] }],
    ["pair", { aliases: ["one@this-mac"] }],
    ["pair", { aliases: ["one@this-mac", "two@this-mac"], extra: true }],
    [
      "pair",
      {
        aliases: ["one@this-mac", "two@this-mac"],
        threadAttestation: { alias: "three@this-mac", threadId: THREAD_ID },
      },
    ],
    [
      "pair",
      {
        aliases: ["one@this-mac", "two@this-mac"],
        threadAttestation: {
          alias: "one@this-mac",
          threadId: THREAD_ID,
          provider: "codex",
        },
      },
    ],
    [
      "unpair",
      {
        claudeAlias: "claude@this-mac",
        codexAlias: "codex@this-mac",
      },
    ],
    [
      "remove_codex_registration",
      { alias: "codex-main@this-mac", threadId: THREAD_ID },
    ],
    [
      "remove_codex_registration",
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
  for (const removedMethod of [
    "compat_check",
    "compat_certify",
    "remove_stale_codex_registration",
  ]) {
    assertWireError(
      await rawRequest(socketPath, wireRequest(removedMethod, {})),
      "UNKNOWN_METHOD",
    );
  }
  assertWireError(
    await rawRequest(
      socketPath,
      `${JSON.stringify({ protocolVersion: 1, method: "health", params: {} })}\n`,
    ),
    "UNSUPPORTED_VERSION",
  );
  assertWireError(
    await rawRequest(
      socketPath,
      `${JSON.stringify({
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "health",
        params: {},
        extra: true,
      })}\n`,
    ),
    "INVALID_REQUEST",
  );
  await server.close();
});

test("the client alone decodes closed delivery and receipt results", async () => {
  const { stateDir, socketPath } = await privateState();
  const base = { found: true, updatedAt: NOW, deadlineAt: DEADLINE } as const;
  const candidates: unknown[] = [
    { found: false },
    { ...base, state: "queued", terminal: false, pendingForMs: 125 },
    { ...base, state: "cancelled", terminal: true },
    { ...base, state: "queued", terminal: true },
    { ...base, state: "unconfirmed", terminal: false },
    { ...base, state: "delivered", terminal: true, updatedAt: "not-a-timestamp" },
    { ...base, state: "failed", terminal: true, pendingForMs: -1 },
    { found: false, safeErrorCode: "MUST_NOT_BE_PRESENT" },
  ];
  const server = await startGatewayControlServer({
    stateDir, socketPath,
    handlers: handlers({ deliveryStatus: () => candidates.shift() as never }),
  });
  const request = {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "delivery_status", params: { token: DELIVERY_TOKEN },
  } as const;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await sendGatewayControlRequest({ socketPath, request })).ok, true);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      sendGatewayControlRequest({ socketPath, request }),
      (error: unknown) => error instanceof GatewayControlTransportError &&
        error.code === "CONTROL_INVALID_RESPONSE",
    );
  }
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

test("never reflects handler exceptions", async () => {
  const { stateDir, socketPath } = await privateState();
  const secretText = "do-not-reflect-this-body";
  const server = await startGatewayControlServer({
    stateDir,
    socketPath,
    handlers: handlers({
      send: () => {
        throw new Error(`${THREAD_ID} ${secretText}`);
      },
    }),
  });

  const failed = await rawRequest(
    socketPath,
    wireRequest("send", {
      fromAlias: "codex-main@this-mac",
      threadId: THREAD_ID,
      toAlias: "claude-one@build-mac",
      text: secretText,
    }),
  );
  assertWireError(failed, "HANDLER_FAILURE");
  assert.equal(JSON.stringify(failed).includes(THREAD_ID), false);
  assert.equal(JSON.stringify(failed).includes(secretText), false);
  await server.close();
});

test("list_snapshot requires bounded projection and explicit omission counts", async () => {
  for (const [condition, accepted] of [
    ["managed_layout_missing", true], ["MANAGED_LAYOUT_MISSING", false],
  ] as const) {
    const candidate = snapshot();
    candidate.connectors[0]!.codexDoctor = { conditions: [condition as never] };
    assert.equal(isGatewaySnapshot(candidate), accepted);
  }
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
  const invalidWatchActor = snapshot();
  const openedWatchEvent = invalidWatchActor.progressWatchEvents?.[0];
  assert.ok(openedWatchEvent);
  openedWatchEvent.actor = "worker";
  const invalidWatchSettlement = snapshot();
  const settledWatchEvent = invalidWatchSettlement.progressWatchEvents?.find(
    (event) => event.kind === "settled",
  );
  assert.ok(settledWatchEvent);
  delete settledWatchEvent.reason;
  const invalidWatchSettlementActor = snapshot();
  const pairRemovedWatchEvent =
    invalidWatchSettlementActor.progressWatchEvents?.find(
      (event) => event.reason === "pair_removed",
    );
  assert.ok(pairRemovedWatchEvent);
  pairRemovedWatchEvent.actor = "gateway";
  const invalidActivity = snapshot();
  const activity = invalidActivity.activityEvents?.[0];
  assert.ok(activity);
  activity.aliases = ["PRIVATE_TASK_ID"];
  const invalidActivityKindAction = snapshot();
  const kindAction = invalidActivityKindAction.activityEvents?.[0];
  assert.ok(kindAction);
  kindAction.kind = "registration";
  kindAction.action = "routes_paired";
  kindAction.operatorAction = true;
  const invalidAutomaticAuthority = snapshot();
  const automaticAuthority = invalidAutomaticAuthority.activityEvents?.[0];
  assert.ok(automaticAuthority);
  automaticAuthority.kind = "registration";
  automaticAuthority.action = "codex_unregistered";
  automaticAuthority.operatorAction = false;
  const invalidDeadline = snapshot();
  assert.ok(invalidDeadline.deadlinePressure);
  invalidDeadline.deadlinePressure.expiredEvents = 2;
  const invalidRegistry = snapshot();
  const registry = invalidRegistry.connectors.find(
    (connector) => connector.provider === "claude",
  )?.registry;
  assert.ok(registry);
  registry.parseableRecords = 4;
  const invalidObservationAge = snapshot();
  invalidObservationAge.connectors[0]!.observationAgeMs = -1;
  const dishonestHealthyAge = snapshot();
  dishonestHealthyAge.connectors[0]!.lastSeenAt = new Date(
    Date.parse(NOW) - CONNECTOR_OBSERVATION_STALE_AFTER_MS - 1,
  ).toISOString();
  dishonestHealthyAge.connectors[0]!.observationAgeMs =
    CONNECTOR_OBSERVATION_STALE_AFTER_MS + 1;
  const missingHealthyObservation = snapshot();
  delete missingHealthyObservation.connectors[0]!.lastSeenAt;
  delete missingHealthyObservation.connectors[0]!.observationAgeMs;
  const duplicateRegistryCodes = snapshot();
  const duplicateRegistry = duplicateRegistryCodes.connectors.find(
    (connector) => connector.provider === "claude",
  )?.registry;
  assert.ok(duplicateRegistry);
  duplicateRegistry.rejected.push({
    safeErrorCode: "REGISTRY_INVALID_SCHEMA",
    count: 2,
  });
  const registryOnCodex = snapshot();
  const codexConnector = registryOnCodex.connectors.find(
    (connector) => connector.provider === "codex",
  );
  assert.ok(codexConnector);
  const sourceRegistry = registryOnCodex.connectors.find(
    (connector) => connector.provider === "claude",
  )?.registry;
  assert.ok(sourceRegistry);
  codexConnector.registry = structuredClone(sourceRegistry);
  const nonClaudeAvailablePeer = snapshot();
  (nonClaudeAvailablePeer.availablePeers[0] as unknown as { provider: string }).provider = "grok";
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
    invalidWatchActor,
    invalidWatchSettlement,
    invalidWatchSettlementActor,
    invalidActivity,
    invalidActivityKindAction,
    invalidAutomaticAuthority,
    invalidDeadline,
    invalidRegistry,
    invalidObservationAge,
    dishonestHealthyAge,
    missingHealthyObservation,
    duplicateRegistryCodes,
    registryOnCodex,
    nonClaudeAvailablePeer,
    unprojected,
  ];
  assert.ok(candidates.every((candidate) => !isGatewaySnapshot(candidate)));
});

test("list_snapshot accepts all derived directions and rejects legacy authority schema", async () => {
  const { stateDir, socketPath } = await privateState();
  const canonical = snapshot();
  const baseMessage = canonical.messages[0];
  assert.ok(baseMessage);
  canonical.messages = messageDirections.map((direction, index) => ({
    ...baseMessage,
    sequence: index + 1,
    messageIdSuffix: index.toString(16).padStart(8, "0"),
    direction,
  }));
  const oldSchema = { ...snapshot(), schemaVersion: 1 };
  const compatibilityField = { ...snapshot(), compatibilityChecks: [] };
  const oldPairs = { ...snapshot(), pairs: [] };
  const invalidDirection = structuredClone(canonical);
  invalidDirection.messages[0]!.direction = "codex_to_unknown" as never;
  assert.equal(isGatewaySnapshot(canonical), true);
  assert.deepEqual(canonical.messages.map(({ direction }) => direction), messageDirections);
  assert.ok([oldSchema, compatibilityField, oldPairs, invalidDirection].every(
    (candidate) => !isGatewaySnapshot(candidate),
  ));
});

test("list_snapshot validates canonical consent endpoints against route bindings", async () => {
  const { stateDir, socketPath } = await privateState();
  const canonical = snapshot();
  const claudeRoute = structuredClone(canonical.routes[1]!);
  claudeRoute.alias = "claude-one@this-mac";
  claudeRoute.host = "this-mac";
  canonical.routes.push(claudeRoute);
  canonical.consentEdges = [
    {
      endpoints: [
        { alias: claudeRoute.alias, provider: "claude" },
        { alias: "codex-main@this-mac", provider: "codex" },
      ],
      host: "this-mac",
      counters: { ...canonical.routes[0]!.counters },
    },
  ];
  const reversed = structuredClone(canonical);
  (reversed.consentEdges[0]!.endpoints as unknown as unknown[]).reverse();
  const providerMismatch = structuredClone(canonical);
  (providerMismatch.consentEdges[0]!.endpoints[0] as unknown as { provider: string }).provider = "grok";
  const widenedEndpoint = structuredClone(canonical);
  (widenedEndpoint.consentEdges[0]!.endpoints[0] as unknown as Record<string, unknown>).lease = "private";
  assert.equal(isGatewaySnapshot(canonical), true);
  assert.ok([reversed, providerMismatch, widenedEndpoint].every(
    (candidate) => !isGatewaySnapshot(candidate),
  ));
});

test("activity validation binds each kind to its exact action and authority", async () => {
  const { stateDir, socketPath } = await privateState();
  const registration = snapshot();
  registration.activityEvents = [
    {
      sequence: 1,
      timestamp: NOW,
      kind: "registration",
      action: "codex_unregistered",
      outcome: "accepted",
      aliases: ["codex-main@this-mac"],
      operatorAction: true,
    },
  ];
  const selection = snapshot();
  selection.activityEvents = [
    {
      sequence: 2,
      timestamp: NOW,
      kind: "selection",
      action: "claude_selected",
      outcome: "accepted",
      aliases: ["claude-main@this-mac"],
      operatorAction: true,
    },
  ];
  const candidates = [registration, selection];
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
    await assert.rejects(
      sendGatewayControlRequest({
        socketPath,
        request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "observe_snapshot", params: {} },
      }),
      (error: unknown) => error instanceof GatewayControlTransportError &&
        error.code === "CONTROL_INVALID_RESPONSE",
    );
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
    request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {} },
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
      request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {} },
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
      request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {} },
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
      request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {} },
    }),
    (error: unknown) =>
      error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_INVALID_RESPONSE" &&
      error.message ===
        "The gateway returned an invalid control response. Restart the broker, then retry." &&
      !error.message.includes(THREAD_ID),
  );
  await closeTrackedServer(malformed.server, malformed.connections);

  const skewed = trackedServer((socket) => socket.end(`${JSON.stringify({
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION + 1,
    ok: true, result: { status: "ok", revision: 1 },
  })}\n`));
  await new Promise<void>((resolve, reject) => {
    skewed.server.once("error", reject); skewed.server.listen(socketPath, resolve);
  });
  await assert.rejects(sendGatewayControlRequest({ socketPath, request: {
    protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {},
  } }), (error: unknown) => error instanceof GatewayControlTransportError &&
    error.code === "CONTROL_VERSION_MISMATCH");
  await closeTrackedServer(skewed.server, skewed.connections);
  for (const protocolVersion of [undefined, "2"] as const) {
    const invalidVersion = trackedServer((socket) => socket.end(`${JSON.stringify({
      protocolVersion, ok: true, result: { status: "ok", revision: 1 },
    })}\n`));
    await new Promise<void>((resolve, reject) => {
      invalidVersion.server.once("error", reject); invalidVersion.server.listen(socketPath, resolve);
    });
    await assert.rejects(sendGatewayControlRequest({ socketPath, request: {
      protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method: "health", params: {},
    } }), (error: unknown) => error instanceof GatewayControlTransportError &&
      error.code === "CONTROL_INVALID_RESPONSE");
    await closeTrackedServer(invalidVersion.server, invalidVersion.connections);
  }
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "send",
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "remove_codex_registration",
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
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
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "send",
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
      error.code === "CONTROL_SOCKET_MISSING" &&
      !error.ambiguous &&
      error.recoverable,
  );

  assert.equal((await lstat(stateDir)).isDirectory(), true);
});

test("client distinguishes denied, missing, and unserved control sockets", async () => {
  const { socketPath } = await privateState();
  const request = { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
    method: "health" as const, params: {} };
  const createConnection = net.createConnection;
  try {
    for (const [systemCode, expected] of [["EPERM", "CONTROL_CONNECT_DENIED"],
      ["ENOENT", "CONTROL_SOCKET_MISSING"], ["ECONNREFUSED", "CONTROL_LISTENER_UNAVAILABLE"]] as const) {
      net.createConnection = (() => { const socket = new net.Socket(); queueMicrotask(() =>
        socket.emit("error", Object.assign(new Error("connect failed"), { code: systemCode }))); return socket;
      }) as typeof net.createConnection;
      await assert.rejects(sendGatewayControlRequest({ socketPath, request }),
        (error: unknown) => error instanceof GatewayControlTransportError && error.code === expected);
    }
    net.createConnection = (() => { const socket = new net.Socket();
      socket.write = (() => true) as typeof socket.write;
      queueMicrotask(() => { socket.emit("connect"); socket.emit("error",
        Object.assign(new Error("post-connect denied"), { code: "EPERM" })); }); return socket;
    }) as typeof net.createConnection;
    await assert.rejects(sendGatewayControlRequest({ socketPath, request }),
      (error: unknown) => error instanceof GatewayControlTransportError && error.code === "CONTROL_CONNECT_FAILED");
  } finally { net.createConnection = createConnection; }
});
