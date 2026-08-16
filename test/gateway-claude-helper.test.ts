import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLAUDE_PEER_COMPATIBILITY } from "../src/gateway/claude-peer.js";
import { ClaudeNativeHelperClient } from "../src/gateway/claude-helper-client.js";
import type {
  ClaudeNativeHelperClientLike,
  ClaudeNativeHelperClientStartOptions,
} from "../src/gateway/claude-helper-client.js";
import { ClaudeNativeHelperSupervisor } from "../src/gateway/claude-helper-supervisor.js";
import type {
  ClaudeNativeHelperCommand,
  ClaudeNativeHelperResult,
} from "../src/gateway/claude-helper-protocol.js";
import {
  assertClaudeNativeHelperIpcSize,
  isClaudeNativeHelperParentMessage,
} from "../src/gateway/claude-helper-protocol.js";
import type {
  GatewayAdapterCallbacks,
  GatewayAdapterDelivery,
} from "../src/gateway/service.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function missing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

test("real-PID helpers own independent native records and exact cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-helper-process-"));
  const sessionsDir = path.join(root, "sessions");
  const socketDir = path.join(root, "sockets");
  await mkdir(sessionsDir, { mode: 0o700 });
  await mkdir(socketDir, { mode: 0o700 });
  await chmod(sessionsDir, 0o700);
  await chmod(socketDir, 0o700);
  const entryPath = path.join(
    repoRoot,
    "dist",
    "src",
    "gateway",
    "claude-helper.js",
  );
  const runtime = {
    claudeExecutable: "/usr/bin/false",
    claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
    sessionsDir,
    socketDir,
  } as const;
  const exits: number[] = [];
  const start = async (alias: string, sourceProvider: "codex" | "deepseek" = "codex") =>
    await ClaudeNativeHelperClient.start({
      entryPath,
      runtime,
      hostId: "this-mac",
      locale: "en",
      deliveryNotices: "merged",
      maxPendingMessages: 8,
      registration: { alias, sourceProvider, cwd: root },
      callbacks: {
        onEvent: () => undefined,
        onExit: () => exits.push(1),
      },
    });
  let first: ClaudeNativeHelperClient | undefined;
  let second: ClaudeNativeHelperClient | undefined;
  try {
    first = await start("codex-first@this-mac");
    second = await start("dsh-second@this-mac", "deepseek");
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.pid, process.pid);
    assert.notEqual(first.generation, second.generation);

    const firstRecordPath = path.join(sessionsDir, `${first.pid}.json`);
    const secondRecordPath = path.join(sessionsDir, `${second.pid}.json`);
    const firstSocketPath = path.join(socketDir, `${first.pid}.sock`);
    const secondSocketPath = path.join(socketDir, `${second.pid}.sock`);
    const [firstRecord, secondRecord] = await Promise.all([
      readFile(firstRecordPath, "utf8").then(JSON.parse),
      readFile(secondRecordPath, "utf8").then(JSON.parse),
    ]);
    assert.equal(firstRecord.pid, first.pid);
    assert.equal(firstRecord.name, "codex-first");
    assert.equal(firstRecord.messagingSocketPath, firstSocketPath);
    assert.equal(secondRecord.pid, second.pid);
    assert.equal(secondRecord.name, "dsh-second");
    assert.equal(secondRecord.messagingSocketPath, secondSocketPath);

    await first.request({
      method: "resume_generation",
      generation: first.generation,
    });
    await second.request({
      method: "resume_generation",
      generation: second.generation,
    });

    await first.close();
    assert.equal(await missing(firstRecordPath), true);
    assert.equal(await missing(firstSocketPath), true);
    assert.equal(await missing(secondRecordPath), false);
    assert.equal(await missing(secondSocketPath), false);
    first = undefined;

    await second.close();
    assert.equal(await missing(secondRecordPath), true);
    assert.equal(await missing(secondSocketPath), true);
    second = undefined;
    assert.equal(exits.length, 2);
  } finally {
    await first?.forceClose().catch(() => undefined);
    await second?.forceClose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

class FakeHelperClient implements ClaudeNativeHelperClientLike {
  readonly commands: ClaudeNativeHelperCommand[] = [];
  readonly pid: number;
  readonly registration: ClaudeNativeHelperClientLike["registration"];
  generation: string;
  closed = false;

  constructor(
    readonly options: ClaudeNativeHelperClientStartOptions,
    index: number,
  ) {
    this.pid = 50_000 + index;
    this.registration = options.registration;
    this.generation = `helper_generation_${index}`;
  }

  async request(
    command: ClaudeNativeHelperCommand,
  ): Promise<ClaudeNativeHelperResult> {
    this.commands.push(command);
    if (command.method === "dispatch") {
      this.options.callbacks.onEvent({
        event: "delivery",
        value: {
          messageId: command.messageId,
          state: "transport_written",
        },
      });
      return { state: "pending" };
    }
    if (command.method === "release_inbound_receipt") {
      return { released: true };
    }
    if (command.method === "observe_barrier") {
      return {
        generation: command.generation,
        activeGenerationMatched: true,
        ingressQuiesced: true,
        monitorFrozen: true,
        discoveryInFlight: false,
        pendingOutboundReceipts: 0,
        pendingInboundReceipts: 0,
        rejectedInboundSettlements: 0,
        clean: true,
      };
    }
    if (command.method === "publish_prepared") {
      return { publication: "published" };
    }
    if (command.method === "purge_generation_replies") {
      return { purged: 0 };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.callbacks.onExit({ code: 0, signal: null });
  }

  async forceClose(): Promise<void> {
    await this.close();
  }

  crash(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.callbacks.onExit({ code: 1, signal: null });
  }
}

test("supervisor namespaces receipts and isolates one helper crash", async () => {
  const deliveries: GatewayAdapterDelivery[] = [];
  const messages: Parameters<
    NonNullable<GatewayAdapterCallbacks["onClaudeMessage"]>
  >[0][] = [];
  const notices: string[] = [];
  const callbacks: GatewayAdapterCallbacks = {
    onDelivery: (event) => deliveries.push({ ...event }),
    onRouteState: () => undefined,
    onClaudeReply: () => undefined,
    onClaudeMessage: (event) => messages.push(event),
    onProtocolNotice: (event) => notices.push(event.code),
  };
  const clients: FakeHelperClient[] = [];
  const supervisor = new ClaudeNativeHelperSupervisor({
    identity: {
      provider: "claude",
      hostId: "this-mac",
      endpointGeneration: "claude_generation",
    },
    runtime: {
      claudeExecutable: "/usr/bin/false",
      claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      sessionsDir: "/tmp/sessions",
      socketDir: "/tmp/sockets",
    },
    locale: "en",
    deliveryNotices: "merged",
    maxPendingMessages: 8,
    maxHelpers: 2,
    callbacks: () => callbacks,
    factory: async (options) => {
      const client = new FakeHelperClient(options, clients.length + 1);
      clients.push(client);
      return client;
    },
  });
  try {
    await supervisor.advertise({
      alias: "codex-first@this-mac",
      sourceProvider: "codex",
      cwd: "/workspace/first",
    });
    await supervisor.advertise({
      alias: "codex-second@this-mac",
      sourceProvider: "codex",
      cwd: "/workspace/second",
    });
    assert.equal(supervisor.size, 2);

    clients[0]!.options.callbacks.onEvent({
      event: "claude_message",
      value: {
        routeHandle: "00000000-0000-7000-8000-000000000111",
        sourceAlias: "claude-first@this-mac",
        targetAlias: "codex-first@this-mac",
        text: "first body",
        receiptHandle: "child-receipt",
      },
    });
    clients[1]!.options.callbacks.onEvent({
      event: "claude_message",
      value: {
        routeHandle: "00000000-0000-7000-8000-000000000222",
        sourceAlias: "claude-second@this-mac",
        targetAlias: "codex-second@this-mac",
        text: "second body",
        receiptHandle: "child-receipt",
      },
    });
    assert.equal(messages.length, 2);
    assert.match(messages[0]!.receiptHandle!, /^nrc_[A-Za-z0-9_-]{24}$/);
    assert.match(messages[1]!.receiptHandle!, /^nrc_[A-Za-z0-9_-]{24}$/);
    assert.notEqual(messages[0]!.receiptHandle, messages[1]!.receiptHandle);
    await supervisor.updateInboundStatus(
      messages[0]!.receiptHandle!,
      "delivered",
      "PAIR_ACCEPTED",
    );
    assert.deepEqual(clients[0]!.commands.at(-1), {
      method: "update_inbound_status",
      receiptHandle: "child-receipt",
      status: "delivered",
      diagnosticCode: "PAIR_ACCEPTED",
    });

    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    const dispatched = await supervisor.dispatch({
      sourceAlias: "codex-first@this-mac",
      sourceProvider: "codex",
      targetAlias: "claude-first@this-mac",
      conversationId: "conv_0123456789abcdef",
      selectedAlias: "claude-first@this-mac",
      stateRoot: "/state",
      binding: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: "00000000-0000-7000-8000-000000000111",
        ownerLease: "lease-first",
        endpointGeneration: "claude_generation",
      },
      authorization: "selected_route",
      messageId: "gateway-message-first",
      text: "outbound body",
      expectsReply: false,
      deadlineAt,
      progressWatchActive: true,
    });
    assert.deepEqual(dispatched, { state: "pending" });
    assert.equal(deliveries.at(-1)?.state, "transport_written");
    assert.deepEqual(clients[0]!.commands.at(-1), {
      method: "dispatch",
      binding: {
        provider: "claude",
        hostId: "this-mac",
        routeHandle: "00000000-0000-7000-8000-000000000111",
        ownerLease: "lease-first",
        endpointGeneration: "claude_generation",
      },
      authorization: "selected_route",
      messageId: "gateway-message-first",
      sourceAlias: "codex-first@this-mac",
      sourceProvider: "codex",
      targetAlias: "claude-first@this-mac",
      conversationId: "conv_0123456789abcdef",
      text: "outbound body",
      expectsReply: false,
      deadlineAt,
      progressWatchActive: true,
    });

    clients[0]!.crash();
    assert.equal(supervisor.size, 1);
    assert.deepEqual(deliveries.at(-1), {
      messageId: "gateway-message-first",
      state: "unconfirmed",
      safeErrorCode: "CLAUDE_NATIVE_HELPER_EXITED",
    });
    assert.equal(notices.at(-1), "CLAUDE_NATIVE_HELPER_EXITED");
    await supervisor.updateStatus("codex-second@this-mac", "busy");
    assert.deepEqual(clients[1]!.commands.at(-1), {
      method: "update_status",
      alias: "codex-second@this-mac",
      status: "busy",
    });
  } finally {
    await supervisor.close();
  }
});

test("helper dispatch IPC is exact, bounded, and provenance-closed", () => {
  const initialization = {
    protocolVersion: 1,
    type: "initialize",
    requestId: "request_0123456789",
    runtime: {
      claudeExecutable: "/usr/bin/false",
      claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      sessionsDir: "/tmp/sessions",
      socketDir: "/tmp/sockets",
    },
    hostId: "this-mac",
    locale: "en",
    deliveryNotices: "merged",
    maxPendingMessages: 8,
    registration: {
      alias: "dsh-builder@this-mac",
      sourceProvider: "deepseek",
      cwd: "/workspace/deepseek",
    },
  } as const;
  assert.equal(isClaudeNativeHelperParentMessage(initialization), true);
  assert.equal(
    isClaudeNativeHelperParentMessage({
      ...initialization,
      registration: {
        ...initialization.registration,
        sourceProvider: "unknown",
      },
    }),
    false,
  );
  const {
    sourceProvider: _omittedRegistrationProvider,
    ...registrationWithoutProvider
  } = initialization.registration;
  assert.equal(_omittedRegistrationProvider, "deepseek");
  assert.equal(
    isClaudeNativeHelperParentMessage({
      ...initialization,
      registration: registrationWithoutProvider,
    }),
    false,
  );

  const command = {
    method: "dispatch",
    binding: {
      provider: "claude",
      hostId: "this-mac",
      routeHandle: "00000000-0000-7000-8000-000000000111",
      ownerLease: "lease-first",
      endpointGeneration: "claude_generation",
    },
    authorization: "selected_route",
    messageId: "gateway-message-first",
    sourceAlias: "codex-first@this-mac",
    sourceProvider: "codex",
    targetAlias: "claude-first@this-mac",
    conversationId: "conv_0123456789abcdef",
    text: "x".repeat(16 * 1024),
    expectsReply: false,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    progressWatchActive: true,
  } as const;
  const parent = {
    protocolVersion: 1,
    type: "request",
    requestId: "request_0123456789",
    command,
  } as const;
  assert.equal(isClaudeNativeHelperParentMessage(parent), true);
  const escapedMaximum = {
    ...parent,
    command: { ...command, text: "\u0001".repeat(16 * 1024) },
  };
  assert.equal(isClaudeNativeHelperParentMessage(escapedMaximum), true);
  assert.doesNotThrow(() => assertClaudeNativeHelperIpcSize(escapedMaximum));

  for (const invalid of [
    { ...command, sourceProvider: "unknown" },
    { ...command, targetAlias: "not an alias" },
    { ...command, conversationId: "conv_short" },
    { ...command, text: "x".repeat(16 * 1024 + 1) },
    { ...command, progressWatchActive: false },
    { ...command, unexpected: true },
  ]) {
    assert.equal(
      isClaudeNativeHelperParentMessage({ ...parent, command: invalid }),
      false,
    );
  }
  const { conversationId: _omitted, ...missingConversation } = command;
  assert.equal(
    isClaudeNativeHelperParentMessage({
      ...parent,
      command: missingConversation,
    }),
    false,
  );
  const { sourceProvider: _omittedProvider, ...missingProvider } = command;
  assert.equal(_omittedProvider, "codex");
  assert.equal(
    isClaudeNativeHelperParentMessage({
      ...parent,
      command: missingProvider,
    }),
    false,
  );
});

test("supervisor binds every helper write to its exact alias and provider", async () => {
  const clients: FakeHelperClient[] = [];
  const supervisor = new ClaudeNativeHelperSupervisor({
    identity: {
      provider: "claude",
      hostId: "this-mac",
      endpointGeneration: "claude_generation",
    },
    runtime: {
      claudeExecutable: "/usr/bin/false",
      claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      sessionsDir: "/tmp/sessions",
      socketDir: "/tmp/sockets",
    },
    locale: "en",
    deliveryNotices: "merged",
    maxPendingMessages: 8,
    maxHelpers: 4,
    callbacks: () => undefined,
    factory: async (options) => {
      const client = new FakeHelperClient(options, clients.length + 1);
      clients.push(client);
      return client;
    },
  });
  const binding = {
    provider: "claude",
    hostId: "this-mac",
    routeHandle: "00000000-0000-7000-8000-000000000111",
    ownerLease: "lease-first",
    endpointGeneration: "claude_generation",
  } as const;
  const sources = [
    { alias: "dsh-builder@this-mac", provider: "deepseek" },
    { alias: "grok-builder@this-mac", provider: "grok" },
    { alias: "codex-shaped@this-mac", provider: "claude" },
    { alias: "dsh-shaped@this-mac", provider: "claude" },
  ] as const;
  try {
    for (const source of sources) {
      await supervisor.advertise({
        alias: source.alias,
        sourceProvider: source.provider,
        cwd: `/workspace/${source.alias.slice(0, source.alias.indexOf("@"))}`,
      });
    }

    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    for (const [index, source] of sources.entries()) {
      assert.deepEqual(
        await supervisor.dispatch({
          sourceAlias: source.alias,
          sourceProvider: source.provider,
          targetAlias: "claude-first@this-mac",
          conversationId: "conv_0123456789abcdef",
          selectedAlias: "claude-first@this-mac",
          stateRoot: "/state",
          binding,
          authorization: "selected_route",
          messageId: `gateway-provider-bound-${index}`,
          text: "outbound body",
          expectsReply: false,
          deadlineAt,
        }),
        { state: "pending" },
      );
      const sent = clients[index]!.commands.at(-1);
      assert.equal(sent?.method, "dispatch");
      if (sent?.method !== "dispatch") assert.fail("expected dispatch command");
      assert.equal(sent.sourceAlias, source.alias);
      assert.equal(sent.sourceProvider, source.provider);
    }

    const deepseekCommands = clients[0]!.commands.length;
    assert.deepEqual(
      await supervisor.dispatch({
        sourceAlias: "dsh-builder@this-mac",
        sourceProvider: "grok",
        targetAlias: "claude-first@this-mac",
        conversationId: "conv_0123456789abcdef",
        selectedAlias: "claude-first@this-mac",
        stateRoot: "/state",
        binding,
        authorization: "selected_route",
        messageId: "gateway-provider-mismatch",
        text: "must not be written",
        expectsReply: false,
        deadlineAt,
      }),
      { state: "failed", safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" },
    );
    assert.equal(clients[0]!.commands.length, deepseekCommands);
  } finally {
    await supervisor.close();
  }
});

test("supervisor carries only the activated source alias and exact selected target", async () => {
  const clients: FakeHelperClient[] = [];
  const supervisor = new ClaudeNativeHelperSupervisor({
    identity: {
      provider: "claude",
      hostId: "this-mac",
      endpointGeneration: "claude_generation",
    },
    runtime: {
      claudeExecutable: "/usr/bin/false",
      claudeCodeVersion: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      sessionsDir: "/tmp/sessions",
      socketDir: "/tmp/sockets",
    },
    locale: "en",
    deliveryNotices: "merged",
    maxPendingMessages: 8,
    maxHelpers: 1,
    callbacks: () => undefined,
    factory: async (options) => {
      const client = new FakeHelperClient(options, 1);
      clients.push(client);
      return client;
    },
  });
  const binding = {
    provider: "claude",
    hostId: "this-mac",
    routeHandle: "00000000-0000-7000-8000-000000000111",
    ownerLease: "lease-first",
    endpointGeneration: "claude_generation",
  } as const;
  try {
    await supervisor.advertise({
      alias: "codex-old@this-mac",
      sourceProvider: "codex",
      cwd: "/workspace/old",
    });
    await supervisor.prepareGeneration({
      alias: "codex-new@this-mac",
      cwd: "/workspace/new",
      generation: "helper_generation_next",
      currentGeneration: "helper_generation_1",
    });
    assert.equal(
      await supervisor.publishPrepared({
        currentGeneration: "helper_generation_1",
        preparedGeneration: "helper_generation_next",
      }),
      "published",
    );
    await supervisor.activatePrepared("helper_generation_next");

    const dispatch = {
      sourceAlias: "codex-new@this-mac",
      sourceProvider: "codex",
      targetAlias: "claude-first@this-mac",
      conversationId: "conv_0123456789abcdef",
      selectedAlias: "claude-first@this-mac",
      stateRoot: "/state",
      binding,
      authorization: "selected_route",
      messageId: "gateway-message-next",
      text: "outbound body",
      expectsReply: false,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      progressWatchActive: true,
    } as const;
    assert.deepEqual(
      await supervisor.dispatch({
        ...dispatch,
        sourceAlias: "codex-old@this-mac",
      }),
      {
        state: "failed",
        safeErrorCode: "CLAUDE_NATIVE_HELPER_UNAVAILABLE",
      },
    );
    const { stateRoot: omittedStateRoot, ...withoutStateRoot } = dispatch;
    assert.equal(omittedStateRoot, "/state");
    assert.deepEqual(
      await supervisor.dispatch(withoutStateRoot),
      { state: "failed", safeErrorCode: "CLAUDE_ROUTE_UNAVAILABLE" },
    );
    const commandsBeforeInvalid = clients[0]!.commands.length;
    assert.deepEqual(
      await supervisor.dispatch({
        ...dispatch,
        conversationId: "conv_short",
      }),
      { state: "failed", safeErrorCode: "PROVENANCE_ENVELOPE_INVALID" },
    );
    assert.deepEqual(
      await supervisor.dispatch({
        ...dispatch,
        text: "x".repeat(16 * 1024 + 1),
      }),
      {
        state: "failed",
        safeErrorCode: "PROVENANCE_ENVELOPE_TOO_LARGE",
      },
    );
    assert.equal(clients[0]!.commands.length, commandsBeforeInvalid);
    assert.deepEqual(await supervisor.dispatch(dispatch), { state: "pending" });
    const sent = clients[0]!.commands.at(-1);
    assert.equal(sent?.method, "dispatch");
    if (sent?.method !== "dispatch") assert.fail("expected dispatch command");
    assert.equal(sent.sourceAlias, "codex-new@this-mac");
    assert.equal(sent.targetAlias, "claude-first@this-mac");
    assert.equal(sent.conversationId, "conv_0123456789abcdef");
    assert.equal(sent.text, "outbound body");
    assert.equal(sent.progressWatchActive, true);

    assert.deepEqual(
      await supervisor.dispatch({
        ...dispatch,
        selectedAlias: "claude-renamed@this-mac",
        messageId: "gateway-message-renamed-observation",
      }),
      { state: "pending" },
    );
    const renamed = clients[0]!.commands.at(-1);
    assert.equal(renamed?.method, "dispatch");
    if (renamed?.method !== "dispatch") assert.fail("expected dispatch command");
    assert.equal(renamed.targetAlias, "claude-first@this-mac");

    assert.deepEqual(
      await supervisor.dispatch({
        sourceAlias: dispatch.sourceAlias,
        sourceProvider: dispatch.sourceProvider,
        targetAlias: dispatch.targetAlias,
        conversationId: dispatch.conversationId,
        binding,
        authorization: "native_reply",
        messageId: "gateway-native-reply-next",
        text: "native reply body",
        expectsReply: false,
        deadlineAt: dispatch.deadlineAt,
      }),
      { state: "pending" },
    );
    const nativeReply = clients[0]!.commands.at(-1);
    assert.equal(nativeReply?.method, "dispatch");
    if (nativeReply?.method !== "dispatch") {
      assert.fail("expected native reply dispatch command");
    }
    assert.equal(nativeReply.authorization, "native_reply");
    assert.equal(nativeReply.sourceAlias, "codex-new@this-mac");
    assert.equal(nativeReply.targetAlias, "claude-first@this-mac");
    assert.equal(nativeReply.conversationId, "conv_0123456789abcdef");
    assert.equal(nativeReply.text, "native reply body");
  } finally {
    await supervisor.close();
  }
});
