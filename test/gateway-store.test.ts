import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename as renameFile,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import type { GatewayConfig } from "../src/gateway/config.js";
import {
  GatewayStore,
  isGatewayPersistedStateV3,
} from "../src/gateway/store.js";
import type {
  GatewayMessageRecord,
  LogicalRouteBinding,
  RegisterRouteInput,
} from "../src/gateway/types.js";
import { deadlinePressureBucketNames } from "../src/gateway/types.js";

type Clock = {
  now: () => Date;
  advance: (milliseconds: number) => void;
  randomId: () => string;
};

function clock(): Clock {
  let current = Date.parse("2026-08-16T12:00:00.000Z");
  let sequence = 1;
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    randomId: () =>
      `00000000-0000-4000-8000-${(sequence++)
        .toString(16)
        .padStart(12, "0")}`,
  };
}

function limits(): GatewayConfig["limits"] {
  return {
    maxRoutes: 12,
    maxConsentEdges: 24,
    eventCapacity: 32,
    eventTtlMs: 60_000,
    dedupeCapacity: 32,
    dedupeTtlMs: 30_000,
    maxQueueMessages: 16,
    maxQueueMessagesPerRoute: 16,
    maxInFlightMessages: 16,
    maxQueueBytes: 64 * 1024,
    maxMessageBytes: 4 * 1024,
    maxRetainedBodyBytes: 16 * 1024,
    messageDeadlineMs: 10_000,
    rateLimitPerRoute: 32,
    rateWindowMs: 1_000,
  };
}

async function fixture(
  dependencies: Readonly<{
    afterStateFileRename?: () => void | Promise<void>;
    renameStateFile?: (source: string, target: string) => Promise<void>;
    limits?: Partial<GatewayConfig["limits"]>;
    inboundMode?: GatewayConfig["inboundMode"];
  }> = {},
): Promise<{
  root: string;
  stateDir: string;
  config: GatewayConfig;
  clock: Clock;
  store: GatewayStore;
}> {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "gateway-v3-store-test-"));
  const stateDir = path.join(root, "controller", "gateway");
  await mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  const config: GatewayConfig = {
    stateDir,
    controlSocketPath: path.join(stateDir, "control.sock"),
    allowedHosts: ["this-mac"],
    stallNoticeMs: 2_500,
    steeringEnabled: true,
    inboundMode: dependencies.inboundMode ?? "paired",
    limits: { ...limits(), ...dependencies.limits },
  };
  const testClock = clock();
  const store = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
    ...(dependencies.afterStateFileRename === undefined
      ? {}
      : { afterStateFileRename: dependencies.afterStateFileRename }),
    ...(dependencies.renameStateFile === undefined
      ? {}
      : { renameStateFile: dependencies.renameStateFile }),
  });
  return { root, stateDir, config, clock: testClock, store };
}

function route(
  provider: LogicalRouteBinding["provider"],
  alias: string,
  registrationId: string,
  routeHandle = `${provider}-logical-handle`,
): RegisterRouteInput {
  return {
    alias,
    binding: {
      provider,
      hostId: "this-mac",
      routeHandle,
      registrationId,
    },
    registrationMode:
      provider === "claude" ? "selected_live_peer" : "explicit_opt_in",
  };
}

const claude = route(
  "claude",
  "advisor@this-mac",
  "reg-claude-0001",
  "claude-session-private-0001",
);
const codex = route(
  "codex",
  "codex-reviewer@this-mac",
  "reg-codex-0001",
  "codex-thread-private-0001",
);

function consentInput(
  left: RegisterRouteInput,
  right: RegisterRouteInput,
) {
  return {
    aliases: [left.alias, right.alias] as const,
    expectedRegistrationIds: [
      left.binding.registrationId,
      right.binding.registrationId,
    ] as const,
  };
}

async function paired(store: GatewayStore): Promise<void> {
  await store.registerRoute(claude);
  await store.registerRoute(codex);
  await store.addConsentEdge(consentInput(claude, codex));
}

async function enqueue(
  store: GatewayStore,
  dedupeKey: string,
  body = `body ${dedupeKey}`,
) {
  return store.enqueueMessage({
    sourceAlias: claude.alias,
    targetAlias: codex.alias,
    body,
    dedupeKey,
    conversationIdSuffix: "suffix01",
  });
}

function preparedFor(body: string) {
  const frame = `provenance:${body}`;
  return {
    kind: "codex_turn_start" as const,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    frameBytes: Buffer.byteLength(frame, "utf8"),
    sha256: createHash("sha256").update(frame).digest("hex"),
  };
}

async function reserve(
  store: GatewayStore,
  targetAlias = codex.alias,
) {
  const result = await store.reserveMessage(targetAlias);
  assert.equal(result.status, "reserved");
  if (result.status !== "reserved") throw new Error("expected reservation");
  return result.attempt;
}

async function authorize(store: GatewayStore, attempt: Awaited<ReturnType<typeof reserve>>) {
  return store.authorizeMessage({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    sourceRegistrationId: attempt.sourceRegistrationId,
    targetRegistrationId: attempt.targetRegistrationId,
    prepared: preparedFor(attempt.body),
  });
}

test("new stores are strict native v3 and public projection redacts private IDs", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  const accepted = await enqueue(store, "native-v3", "hello v3");
  assert.equal(accepted.accepted, true);
  assert.match(accepted.deliveryToken ?? "", /^dlv_[A-Za-z0-9_-]{24}$/u);
  assert.equal(accepted.deliveryToken?.length, 28);

  const body = await readFile(store.stateFilePath, "utf8");
  const state = JSON.parse(body) as Record<string, unknown>;
  assert.equal(state.schemaVersion, 3);
  assert.deepEqual(Object.keys(state), [
    "schemaVersion",
    "commit",
    "createdAt",
    "updatedAt",
    "eventSequence",
    "routes",
    "consentEdges",
    "messages",
    "dedupe",
    "rateBuckets",
    "activity",
    "accounting",
  ]);
  assert.equal(isGatewayPersistedStateV3(state), true);
  assert.equal(body.includes("endpointGeneration"), false);
  assert.equal(body.includes("ownerLease"), false);
  assert.equal(body.includes("connectors"), false);
  assert.equal(body.includes("Succession"), false);

  const snapshot = await store.publicSnapshot();
  const publicBody = JSON.stringify(snapshot);
  for (const privateValue of [
    claude.binding.routeHandle,
    claude.binding.registrationId,
    codex.binding.routeHandle,
    codex.binding.registrationId,
    accepted.messageId,
    accepted.deliveryToken,
  ]) {
    assert.equal(publicBody.includes(privateValue ?? ""), false);
  }
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.messages[0]?.body, "hello v3");
  assert.deepEqual(
    snapshot.deadlinePressure?.buckets.map(({ bucket }) => bucket),
    deadlinePressureBucketNames,
  );
  await store.close();
});

test("delivery token allocation is deterministic and retries bounded collisions", async () => {
  const { config } = await fixture();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const tokenFor = (id: string) =>
    `dlv_${createHash("sha256")
      .update(id, "utf8")
      .digest("base64url")
      .slice(0, 24)}`;
  const existingToken = tokenFor(firstId);
  let calls = 0;
  const candidateIds = [firstId, secondId];
  const allocationStore = new GatewayStore(config, {
    randomId: () => candidateIds[calls++]!,
  });
  const allocator = allocationStore as unknown as {
    allocateDeliveryToken(state: {
      messages: Array<{ deliveryToken?: string }>;
    }): string;
  };
  const allocated = allocator.allocateDeliveryToken({
    messages: [{ deliveryToken: existingToken }],
  });
  assert.equal(allocated, tokenFor(secondId));
  assert.match(allocated, /^dlv_[A-Za-z0-9_-]{24}$/u);
  assert.equal(calls, 2);

  let exhaustedCalls = 0;
  const exhaustedStore = new GatewayStore(config, {
    randomId: () => {
      exhaustedCalls += 1;
      return firstId;
    },
  }) as unknown as {
    allocateDeliveryToken(state: {
      messages: Array<{ deliveryToken?: string }>;
    }): string;
  };
  assert.throws(
    () =>
      exhaustedStore.allocateDeliveryToken({
        messages: [{ deliveryToken: existingToken }],
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "DELIVERY_TOKEN_CAPACITY_REACHED",
  );
  assert.equal(exhaustedCalls, 8);
});

test("runtime distinguishes v2 conversion requirement from corrupt v3", async () => {
  const first = await fixture();
  await first.store.initialize();
  await first.store.close();
  await writeFile(
    first.store.stateFilePath,
    `${JSON.stringify({ schemaVersion: 2, arbitrary: "not validated" })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(first.config).initialize(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "GATEWAY_STATE_CONVERSION_REQUIRED",
  );
  const unchanged = await readFile(first.store.stateFilePath, "utf8");
  assert.match(unchanged, /"schemaVersion":2/u);

  await writeFile(
    first.store.stateFilePath,
    `${JSON.stringify({ schemaVersion: 3 })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(first.config).initialize(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("consent is canonical, lease-bound, and never inferred from alias prefixes", async () => {
  const { store } = await fixture();
  await store.initialize();
  const deceptiveClaude = route(
    "claude",
    "codex-looking@this-mac",
    "reg-claude-deceptive",
    "session-deceptive",
  );
  const deceptiveCodex = route(
    "codex",
    "codex-actual@this-mac",
    "reg-codex-actual",
    "thread-actual",
  );
  await store.registerRoute(deceptiveClaude);
  await store.registerRoute(deceptiveCodex);
  await store.addConsentEdge(consentInput(deceptiveCodex, deceptiveClaude));
  assert.equal(
    await store.hasConsentEdge(consentInput(deceptiveClaude, deceptiveCodex)),
    true,
  );
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    consentEdges: Array<{
      endpoints: Array<{ provider: string; registrationId: string }>;
    }>;
  };
  assert.deepEqual(
    raw.consentEdges[0]?.endpoints.map(
      ({ provider, registrationId }) => ({ provider, registrationId }),
    ),
    [
      { provider: "claude", registrationId: "reg-claude-deceptive" },
      { provider: "codex", registrationId: "reg-codex-actual" },
    ],
  );
  await store.close();
});

test("ordinary enqueue fences both exact registrations before admission", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);

  const exact = await store.enqueueMessage({
    sourceAlias: claude.alias,
    targetAlias: codex.alias,
    expectedSourceRegistrationId: claude.binding.registrationId,
    expectedTargetRegistrationId: codex.binding.registrationId,
    body: "exact registration fence",
    dedupeKey: "exact-registration-fence",
  });
  assert.equal(exact.accepted, true);

  const beforeInvalid = await readFile(store.stateFilePath, "utf8");
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      expectedSourceRegistrationId: claude.binding.registrationId,
      body: "one-sided fence",
      dedupeKey: "one-sided-registration-fence",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_GATEWAY_MESSAGE",
  );
  assert.equal(await readFile(store.stateFilePath, "utf8"), beforeInvalid);

  const replacementSource = route(
    "claude",
    claude.alias,
    "reg-claude-fence-replacement-1",
    "claude-session-fence-replacement-1",
  );
  await store.replaceClaudeSelection(replacementSource);
  await store.addConsentEdge(consentInput(replacementSource, codex));
  const beforeSourceMismatch = await readFile(store.stateFilePath, "utf8");
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: replacementSource.alias,
      targetAlias: codex.alias,
      expectedSourceRegistrationId: claude.binding.registrationId,
      expectedTargetRegistrationId: codex.binding.registrationId,
      body: "stale source registration",
      dedupeKey: "stale-source-registration-fence",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ROUTE_UNREGISTERED",
  );
  assert.equal(await readFile(store.stateFilePath, "utf8"), beforeSourceMismatch);

  const matchingReplacement = await store.enqueueMessage({
    sourceAlias: replacementSource.alias,
    targetAlias: codex.alias,
    expectedSourceRegistrationId: replacementSource.binding.registrationId,
    expectedTargetRegistrationId: codex.binding.registrationId,
    body: "matching replacement registration",
    dedupeKey: "matching-replacement-registration-fence",
  });
  assert.equal(matchingReplacement.accepted, true);

  const replacementTarget = route(
    "claude",
    replacementSource.alias,
    "reg-claude-fence-replacement-2",
    "claude-session-fence-replacement-2",
  );
  await store.replaceClaudeSelection(replacementTarget);
  await store.addConsentEdge(consentInput(codex, replacementTarget));
  const beforeTargetMismatch = await readFile(store.stateFilePath, "utf8");
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: codex.alias,
      targetAlias: replacementTarget.alias,
      expectedSourceRegistrationId: codex.binding.registrationId,
      expectedTargetRegistrationId: replacementSource.binding.registrationId,
      body: "stale target registration",
      dedupeKey: "stale-target-registration-fence",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ROUTE_UNREGISTERED",
  );
  assert.equal(await readFile(store.stateFilePath, "utf8"), beforeTargetMismatch);
  await store.close();
});

test("same-alias replacement fences native admission, succession, pair, and unpair", async () => {
  const { store } = await fixture({ inboundMode: "open" });
  await store.initialize();
  await paired(store);
  await store.removeOwnedRouteAtomic({
    alias: codex.alias,
    binding: codex.binding,
    activity: { operatorAction: true },
  });
  const current = route(
    "codex",
    codex.alias,
    "reg-codex-race-current",
    "codex-thread-race-current",
  );
  await store.registerRoute(current);
  const native = {
    alias: "native-race@this-mac",
    binding: {
      provider: "claude" as const,
      hostId: "this-mac",
      routeHandle: "native-race-session",
      registrationId: "native-race-registration",
    },
  };
  const successor = route(
    "codex",
    "codex-race-successor@this-mac",
    "reg-codex-race-successor",
    "codex-thread-race-successor",
  );
  const staleOperations = [
    () => store.enqueueNativeIngress({
      source: native,
      targetAlias: current.alias,
      expectedTargetRegistrationId: codex.binding.registrationId,
      body: "stale ingress",
      dedupeKey: "stale-native-ingress",
    }),
    () => store.enqueueNativeReply({
      sourceAlias: current.alias,
      expectedSourceRegistrationId: codex.binding.registrationId,
      target: native,
      body: "stale reply",
      dedupeKey: "stale-native-reply",
    }),
    () => store.replaceCodexRegistrationAtomic({
      oldAlias: current.alias,
      expectedOldRegistrationId: codex.binding.registrationId,
      replacement: successor,
      activity: { operatorAction: true },
    }),
    () => store.addConsentEdge(consentInput(claude, codex)),
  ];
  for (const operation of staleOperations) {
    const before = await readFile(store.stateFilePath, "utf8");
    await assert.rejects(operation(), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ROUTE_UNREGISTERED");
    assert.equal(await readFile(store.stateFilePath, "utf8"), before);
  }
  await store.addConsentEdge(consentInput(claude, current));
  const beforeStaleUnpair = await readFile(store.stateFilePath, "utf8");
  await assert.rejects(
    store.removeConsentEdge(consentInput(claude, codex)),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ROUTE_UNREGISTERED",
  );
  assert.equal(await readFile(store.stateFilePath, "utf8"), beforeStaleUnpair);
  assert.equal(await store.hasConsentEdge(consentInput(claude, current)), true);
  await store.close();
});

test("attempt authority advances exactly and late or mismatched evidence is a no-op", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  const admitted = await enqueue(store, "attempt-exact", "exact body");
  const attempt = await reserve(store);
  assert.equal(attempt.messageId, admitted.messageId);
  assert.deepEqual(await store.authorizeMessage({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    sourceRegistrationId: "wrong-source-registration",
    targetRegistrationId: attempt.targetRegistrationId,
    prepared: preparedFor(attempt.body),
  }), { status: "stale", reason: "registration_changed" });
  assert.deepEqual(await authorize(store, attempt), { status: "authorized" });
  assert.deepEqual(await authorize(store, attempt), {
    status: "stale",
    reason: "not_reserved",
  });
  assert.deepEqual(await store.acceptMessage({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    lossOutcome: "unconfirmed",
  }), { status: "accepted" });
  assert.deepEqual(await store.settleAttempt({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    state: "delivered",
  }), {
    status: "settled",
    settlement: { messageId: admitted.messageId, state: "delivered" },
  });
  assert.deepEqual(await store.settleAttempt({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    state: "failed",
    safeErrorCode: "LATE_FAILURE",
  }), { status: "stale" });
  assert.equal(
    (await store.deliveryStatus(admitted.deliveryToken!))?.state.phase,
    "terminal",
  );
  const pressure = (await store.publicSnapshot()).deadlinePressure;
  assert.equal(pressure?.terminalEvents, 1);
  assert.deepEqual(pressure?.buckets[0], {
    bucket: "under_1m", settled: 1, expired: 0,
  });
  await store.close();
});

test("prepared evidence is bound to the exact raw body and transport kind", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  await enqueue(store, "prepared-exact", "raw body");
  const attempt = await reserve(store);
  await assert.rejects(
    store.authorizeMessage({
      messageId: attempt.messageId,
      attemptId: attempt.attemptId,
      sourceRegistrationId: attempt.sourceRegistrationId,
      targetRegistrationId: attempt.targetRegistrationId,
      prepared: { ...preparedFor(attempt.body), bodySha256: "0".repeat(64) },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_PREPARED_WRITE_EVIDENCE",
  );
  await assert.rejects(
    store.authorizeMessage({
      messageId: attempt.messageId,
      attemptId: attempt.attemptId,
      sourceRegistrationId: attempt.sourceRegistrationId,
      targetRegistrationId: attempt.targetRegistrationId,
      prepared: {
        ...preparedFor(attempt.body),
        frameBytes: Buffer.byteLength(attempt.body, "utf8") - 1,
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_PREPARED_WRITE_EVIDENCE",
  );
  await assert.rejects(
    store.authorizeMessage({
      messageId: attempt.messageId,
      attemptId: attempt.attemptId,
      sourceRegistrationId: attempt.sourceRegistrationId,
      targetRegistrationId: attempt.targetRegistrationId,
      prepared: { ...preparedFor(attempt.body), kind: "claude_mailbox" },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_PREPARED_WRITE_EVIDENCE",
  );
  assert.deepEqual(await authorize(store, attempt), { status: "authorized" });
  await assert.rejects(
    store.settleAttempt({
      messageId: attempt.messageId,
      attemptId: attempt.attemptId,
      state: "unconfirmed",
    }),
    /INVALID_ATTEMPT_SETTLEMENT_PHASE/u,
  );
  assert.deepEqual(await store.settleAttempt({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    state: "delivered",
  }), {
    status: "settled",
    settlement: { messageId: attempt.messageId, state: "delivered" },
  });
  await store.close();
});

test("armed ACP coarse terminal is the sole pre-acceptance unconfirmed arm", async () => {
  const { store } = await fixture();
  await store.initialize();
  const deepseek = route(
    "deepseek",
    "dsh-worker@this-mac",
    "reg-deepseek-worker",
    "deepseek-config-worker",
  );
  await store.registerRoute(claude);
  await store.registerRoute(deepseek);
  await store.addConsentEdge(consentInput(claude, deepseek));
  await store.enqueueMessage({
    sourceAlias: claude.alias,
    targetAlias: deepseek.alias,
    body: "coarse terminal",
    dedupeKey: "acp-coarse",
  });
  const attempt = await reserve(store, deepseek.alias);
  assert.deepEqual(await store.authorizeMessage({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    sourceRegistrationId: attempt.sourceRegistrationId,
    targetRegistrationId: attempt.targetRegistrationId,
    prepared: { ...preparedFor(attempt.body), kind: "acp_prompt" },
  }), { status: "authorized" });
  await assert.rejects(store.settleAttempt({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    state: "unconfirmed",
  }), /INVALID_ATTEMPT_SETTLEMENT_PHASE/u);
  assert.deepEqual(await store.settleAttempt({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    state: "unconfirmed",
    safeErrorCode: "ACP_OUTCOME_COARSE",
  }), {
    status: "settled",
    settlement: {
      messageId: attempt.messageId,
      state: "unconfirmed",
      safeErrorCode: "ACP_OUTCOME_COARSE",
    },
  });
  await store.close();
});

test("restart applies phase truth before an elapsed deadline", async () => {
  const { config, clock: testClock, store } = await fixture();
  await store.initialize();
  await paired(store);
  const queued = await enqueue(store, "restart-queued", "queued body");
  const reserved = await enqueue(store, "restart-reserved", "reserved body");
  const armed = await enqueue(store, "restart-armed", "armed body");
  const accepted = await enqueue(store, "restart-accepted", "accepted body");

  const reservedAttempt = await reserve(store);
  assert.equal(reservedAttempt.messageId, queued.messageId);
  const armedAttempt = await reserve(store);
  assert.equal(armedAttempt.messageId, reserved.messageId);
  assert.deepEqual(await authorize(store, armedAttempt), { status: "authorized" });
  const acceptedAttempt = await reserve(store);
  assert.equal(acceptedAttempt.messageId, armed.messageId);
  assert.deepEqual(await authorize(store, acceptedAttempt), { status: "authorized" });
  assert.deepEqual(await store.acceptMessage({
    messageId: acceptedAttempt.messageId,
    attemptId: acceptedAttempt.attemptId,
    lossOutcome: "ambiguous",
  }), { status: "accepted" });

  // The fourth message remains queued. All deadlines pass while stopped.
  await store.close();
  testClock.advance(20_000);
  const restarted = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await restarted.initialize();
  const states = await Promise.all([
    restarted.deliveryStatus(queued.deliveryToken!),
    restarted.deliveryStatus(reserved.deliveryToken!),
    restarted.deliveryStatus(armed.deliveryToken!),
    restarted.deliveryStatus(accepted.deliveryToken!),
  ]);
  assert.deepEqual(
    states.map((message) =>
      message?.state.phase === "terminal"
        ? [message.state.outcome, message.state.safeErrorCode]
        : [message?.state.phase]),
    [
      ["expired", "MESSAGE_EXPIRED"],
      ["ambiguous", "CONTROLLER_RESTARTED"],
      ["ambiguous", "CONTROLLER_RESTARTED"],
      ["expired", "MESSAGE_EXPIRED"],
    ],
  );
  await restarted.close();
});

test("restart preserves queued work, requeues reserved once, and never replays writes", async () => {
  const { config, clock: testClock, store } = await fixture();
  await store.initialize();
  await paired(store);
  const reservedMessage = await enqueue(store, "matrix-reserved", "reserved");
  const reservedAttempt = await reserve(store);
  const armedMessage = await enqueue(store, "matrix-armed", "armed");
  const armedAttempt = await reserve(store);
  await authorize(store, armedAttempt);
  const unconfirmedMessage = await enqueue(store, "matrix-unconfirmed", "unconfirmed");
  const unconfirmedAttempt = await reserve(store);
  await authorize(store, unconfirmedAttempt);
  await store.acceptMessage({
    messageId: unconfirmedAttempt.messageId,
    attemptId: unconfirmedAttempt.attemptId,
    lossOutcome: "unconfirmed",
  });
  const ambiguousMessage = await enqueue(store, "matrix-ambiguous", "ambiguous");
  const ambiguousAttempt = await reserve(store);
  await authorize(store, ambiguousAttempt);
  await store.acceptMessage({
    messageId: ambiguousAttempt.messageId,
    attemptId: ambiguousAttempt.attemptId,
    lossOutcome: "ambiguous",
  });
  const queuedMessage = await enqueue(store, "matrix-queued", "queued");
  await store.close();

  const restarted = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await restarted.initialize();
  const states = await Promise.all([
    restarted.deliveryStatus(reservedMessage.deliveryToken!),
    restarted.deliveryStatus(armedMessage.deliveryToken!),
    restarted.deliveryStatus(unconfirmedMessage.deliveryToken!),
    restarted.deliveryStatus(ambiguousMessage.deliveryToken!),
    restarted.deliveryStatus(queuedMessage.deliveryToken!),
  ]);
  assert.deepEqual(
    states.map((message) =>
      message?.state.phase === "terminal"
        ? [message.state.outcome, message.state.safeErrorCode]
        : [message?.state.phase, message?.state.attemptCount]),
    [
      ["queued", 1],
      ["ambiguous", "CONTROLLER_RESTARTED"],
      ["unconfirmed", "CONTROLLER_RESTARTED"],
      ["ambiguous", "CONTROLLER_RESTARTED"],
      ["queued", 0],
    ],
  );
  const retried = await reserve(restarted);
  assert.equal(retried.messageId, reservedAttempt.messageId);
  assert.equal(retried.attemptCount, 2);
  await restarted.close();
});

test("deadline expiration preserves accepted ambiguous truth", async () => {
  const { clock: testClock, store } = await fixture();
  await store.initialize();
  await paired(store);
  await enqueue(store, "expire-accepted", "accepted");
  const attempt = await reserve(store);
  await authorize(store, attempt);
  await store.acceptMessage({
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    lossOutcome: "ambiguous",
  });
  testClock.advance(10_001);
  assert.deepEqual(await store.expireDueMessages(), [
    {
      messageId: attempt.messageId,
      state: "ambiguous",
      safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
    },
  ]);
  await store.close();
});

test("queued native-receipt shutdown settlement is exact and first-wins", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);

  const queued = await enqueue(store, "shutdown-native-receipt", "queued");
  assert.equal(queued.accepted, true);
  assert.ok(queued.messageId);
  const queuedMessageId = queued.messageId;
  assert.deepEqual(
    await store.settleQueuedMessageForShutdown({ messageId: queuedMessageId }),
    {
      status: "settled",
      settlement: {
        messageId: queuedMessageId,
        state: "cancelled",
        safeErrorCode: "GATEWAY_SHUTDOWN",
      },
    },
  );
  assert.deepEqual(
    await store.settleQueuedMessageForShutdown({ messageId: queuedMessageId }),
    { status: "stale" },
  );
  assert.deepEqual(
    await store.settleQueuedMessageForShutdown({
      messageId: "msg_00000000-0000-4000-8000-000000000000",
    }),
    { status: "stale" },
  );

  const reservedMessage = await enqueue(
    store,
    "shutdown-native-receipt-reserved",
    "reserved",
  );
  const reserved = await reserve(store);
  assert.equal(reserved.messageId, reservedMessage.messageId);
  assert.deepEqual(
    await store.settleQueuedMessageForShutdown({
      messageId: reserved.messageId,
    }),
    { status: "stale" },
  );
  assert.deepEqual(await authorize(store, reserved), { status: "authorized" });
  assert.deepEqual(
    await store.settleAttemptForShutdown({
      messageId: reserved.messageId,
      attemptId: reserved.attemptId,
    }),
    {
      status: "settled",
      settlement: {
        messageId: reserved.messageId,
        state: "ambiguous",
        safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
      },
    },
  );
  await store.close();
});

test("terminal retention ranks late settlements by settlement sequence", async () => {
  const { store } = await fixture({ limits: { eventCapacity: 10 } });
  await store.initialize();
  await paired(store);

  const oldestQueued = await enqueue(store, "retention-oldest-queued", "oldest");
  assert.ok(oldestQueued.messageId);
  assert.ok(oldestQueued.deliveryToken);
  const later: Array<{ messageId: string; deliveryToken: string }> = [];
  for (let index = 0; index < 10; index += 1) {
    const accepted = await enqueue(
      store,
      `retention-later-${index}`,
      `later ${index}`,
    );
    assert.ok(accepted.messageId);
    assert.ok(accepted.deliveryToken);
    later.push({
      messageId: accepted.messageId,
      deliveryToken: accepted.deliveryToken,
    });
    assert.equal(
      (
        await store.settleQueuedMessageForShutdown({
          messageId: accepted.messageId,
        })
      ).status,
      "settled",
    );
  }

  assert.equal(
    (
      await store.settleQueuedMessageForShutdown({
        messageId: oldestQueued.messageId,
      })
    ).status,
    "settled",
  );
  await store.recordActivity({
    kind: "watch",
    action: "watch_ended",
    outcome: "accepted",
    aliases: [],
    operatorAction: false,
  });

  assert.equal(
    (await store.deliveryStatus(oldestQueued.deliveryToken))?.state.phase,
    "terminal",
  );
  assert.equal(await store.deliveryStatus(later[0]!.deliveryToken), undefined);
  assert.equal(
    (await store.deliveryStatus(later[1]!.deliveryToken))?.state.phase,
    "terminal",
  );
  await store.close();
});

test("shutdown reducer linearizes clean retry and first-wins write loss", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);

  await enqueue(store, "shutdown-reserved", "reserved");
  const first = await reserve(store);
  assert.deepEqual(await store.settleAttemptForShutdown({
    messageId: first.messageId,
    attemptId: first.attemptId,
  }), { status: "requeued" });
  assert.deepEqual(await authorize(store, first), {
    status: "stale",
    reason: "not_reserved",
  });
  const second = await reserve(store);
  assert.equal(second.attemptCount, 2);
  await authorize(store, second);
  assert.deepEqual(await store.settleAttemptForShutdown({
    messageId: second.messageId,
    attemptId: second.attemptId,
  }), {
    status: "settled",
    settlement: {
      messageId: second.messageId,
      state: "ambiguous",
      safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
    },
  });
  assert.deepEqual(await store.acceptMessage({
    messageId: second.messageId,
    attemptId: second.attemptId,
    lossOutcome: "unconfirmed",
  }), { status: "stale" });

  await enqueue(store, "shutdown-accepted-u", "accepted u");
  const unconfirmed = await reserve(store);
  await authorize(store, unconfirmed);
  await store.acceptMessage({
    messageId: unconfirmed.messageId,
    attemptId: unconfirmed.attemptId,
    lossOutcome: "unconfirmed",
  });
  assert.deepEqual(await store.settleAttemptForShutdown({
    messageId: unconfirmed.messageId,
    attemptId: unconfirmed.attemptId,
  }), {
    status: "settled",
    settlement: {
      messageId: unconfirmed.messageId,
      state: "unconfirmed",
      safeErrorCode: "DELIVERY_UNCONFIRMED",
    },
  });

  await enqueue(store, "shutdown-accepted-a", "accepted a");
  const ambiguous = await reserve(store);
  await authorize(store, ambiguous);
  await store.acceptMessage({
    messageId: ambiguous.messageId,
    attemptId: ambiguous.attemptId,
    lossOutcome: "ambiguous",
  });
  assert.deepEqual(await store.settleAttemptForShutdown({
    messageId: ambiguous.messageId,
    attemptId: ambiguous.attemptId,
  }), {
    status: "settled",
    settlement: {
      messageId: ambiguous.messageId,
      state: "ambiguous",
      safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
    },
  });
  assert.deepEqual(await store.settleAttemptForShutdown({
    messageId: ambiguous.messageId,
    attemptId: ambiguous.attemptId,
  }), { status: "stale" });
  await store.close();
});

test("removing consent atomically preserves armed and accepted loss truth", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  const armedMessage = await enqueue(store, "unpair-armed", "armed");
  const acceptedMessage = await enqueue(store, "unpair-accepted", "accepted");
  const queuedMessage = await enqueue(store, "unpair-queued", "queued");
  const armedAttempt = await reserve(store);
  await authorize(store, armedAttempt);
  const acceptedAttempt = await reserve(store);
  await authorize(store, acceptedAttempt);
  await store.acceptMessage({
    messageId: acceptedAttempt.messageId,
    attemptId: acceptedAttempt.attemptId,
    lossOutcome: "ambiguous",
  });
  const removed = await store.removeConsentEdge(consentInput(claude, codex));
  assert.deepEqual(
    removed.settlements.map(({ messageId, state, safeErrorCode }) => ({
      messageId,
      state,
      safeErrorCode,
    })),
    [
      {
        messageId: armedMessage.messageId,
        state: "ambiguous",
        safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
      },
      {
        messageId: acceptedMessage.messageId,
        state: "ambiguous",
        safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
      },
      {
        messageId: queuedMessage.messageId,
        state: "cancelled",
        safeErrorCode: "SENDER_NOT_PAIRED",
      },
    ],
  );
  assert.equal(await store.hasConsentEdge(consentInput(claude, codex)), false);
  await store.close();
});

test("Codex succession is one idempotent replacement with exact phase settlement", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  const armedMessage = await enqueue(store, "replace-armed", "armed");
  const acceptedMessage = await enqueue(store, "replace-accepted", "accepted");
  const queuedMessage = await enqueue(store, "replace-queued", "queued");
  const armedAttempt = await reserve(store);
  await authorize(store, armedAttempt);
  const acceptedAttempt = await reserve(store);
  await authorize(store, acceptedAttempt);
  await store.acceptMessage({
    messageId: acceptedAttempt.messageId,
    attemptId: acceptedAttempt.attemptId,
    lossOutcome: "unconfirmed",
  });
  const replacement = route(
    "codex",
    "codex-successor@this-mac",
    "reg-codex-successor",
    "codex-thread-successor",
  );
  const replaced = await store.replaceCodexRegistrationAtomic({
    oldAlias: codex.alias,
    expectedOldRegistrationId: codex.binding.registrationId,
    replacement,
    activity: { operatorAction: true },
  });
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.idempotent, false);
  assert.deepEqual(replaced.settlements, [
    {
      messageId: armedMessage.messageId,
      state: "ambiguous",
      safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS",
    },
    {
      messageId: acceptedMessage.messageId,
      state: "unconfirmed",
      safeErrorCode: "DELIVERY_UNCONFIRMED",
    },
    {
      messageId: queuedMessage.messageId,
      state: "cancelled",
      safeErrorCode: "ROUTE_UNREGISTERED",
    },
  ]);
  assert.deepEqual(await store.replaceCodexRegistrationAtomic({
    oldAlias: codex.alias,
    expectedOldRegistrationId: codex.binding.registrationId,
    replacement,
    activity: { operatorAction: true },
  }), { replaced: true, idempotent: true, settlements: [] });
  assert.deepEqual(
    (await store.publicSnapshot()).activityEvents?.map(
      ({ action, aliases }) => ({ action, aliases }),
    ),
    [{
      action: "codex_succeeded",
      aliases: [codex.alias, replacement.alias],
    }],
  );
  assert.equal((await store.publicSnapshot()).consentEdges.length, 0);
  assert.equal((await store.inspectPrivateRoute(replacement.alias))?.binding.registrationId,
    replacement.binding.registrationId);
  await store.close();
});

test("in-flight capacity is enforced before queue reservation", async () => {
  const { store } = await fixture({ limits: { maxInFlightMessages: 1 } });
  await store.initialize();
  await paired(store);
  await enqueue(store, "capacity-one", "one");
  await enqueue(store, "capacity-two", "two");
  await reserve(store);
  assert.deepEqual(await store.reserveMessage(codex.alias), { status: "empty" });
  assert.equal(
    (await store.publicSnapshot()).messages.filter(({ state }) => state === "queued").length,
    1,
  );
  await store.close();
});

test("exact post-rename readback retains the committed writer state", async () => {
  let failAfterRename = false;
  const setup = await fixture({
    afterStateFileRename: () => {
      if (failAfterRename) throw new Error("injected directory-sync failure");
    },
  });
  await setup.store.initialize();
  const before = JSON.parse(await readFile(setup.store.stateFilePath, "utf8")) as {
    commit: { sequence: number; id: string };
  };
  failAfterRename = true;
  await setup.store.registerRoute(claude);
  const installed = JSON.parse(await readFile(setup.store.stateFilePath, "utf8")) as {
    commit: { sequence: number; id: string };
    routes: unknown[];
  };
  assert.equal(installed.commit.sequence, before.commit.sequence + 1);
  assert.notEqual(installed.commit.id, before.commit.id);
  assert.equal(installed.routes.length, 1);
  assert.equal((await setup.store.inspectPrivateRoutes())[0]?.alias, claude.alias);
  await setup.store.close();

  const reader = new GatewayStore(setup.config, {
    now: setup.clock.now,
    randomId: setup.clock.randomId,
  });
  await reader.initialize();
  assert.equal((await reader.inspectPrivateRoutes())[0]?.alias, claude.alias);
  await reader.close();
});

test("a throwing rename reconciles exact installed, exact prior, and unknown state", async () => {
  let mode: "normal" | "installed" | "prior" | "unknown" = "normal";
  const setup = await fixture({
    renameStateFile: async (source, target) => {
      if (mode === "prior") throw new Error("rename refused before install");
      if (mode === "unknown") {
        await writeFile(target, "{}\n", { mode: 0o600 });
        throw new Error("rename outcome corrupted");
      }
      await renameFile(source, target);
      if (mode === "installed") throw new Error("rename installed then errored");
    },
  });
  await setup.store.initialize();
  mode = "installed";
  await setup.store.registerRoute(claude);
  assert.equal((await setup.store.inspectPrivateRoutes()).length, 1);

  mode = "prior";
  await assert.rejects(
    setup.store.registerRoute(codex),
    /rename refused before install/u,
  );
  assert.equal((await setup.store.inspectPrivateRoutes()).length, 1);

  mode = "unknown";
  await assert.rejects(
    setup.store.registerRoute(codex),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
  );
  await assert.rejects(setup.store.inspectPrivateRoutes(), /must hold its controller lock/u);
  await setup.store.close();
});

test("authorization uses the store clock for the final deadline fence", async () => {
  const { clock: testClock, store } = await fixture();
  await store.initialize();
  await paired(store);
  await enqueue(store, "late-authorize", "late body");
  const attempt = await reserve(store);
  testClock.advance(10_001);
  const result = await authorize(store, attempt);
  assert.equal(result.status, "terminal");
  if (result.status === "terminal") {
    assert.deepEqual(result.settlement, {
      messageId: attempt.messageId,
      state: "expired",
      safeErrorCode: "MESSAGE_EXPIRED",
    });
  }
  await store.close();
});

test("late exact-owner cleanup cannot remove an alias replacement", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.registerRoute(codex);
  const oldBinding = { ...codex.binding };
  assert.equal((await store.removeOwnedRouteAtomic({
    alias: codex.alias,
    binding: oldBinding,
    activity: { operatorAction: true },
  })).removed, true);
  assert.deepEqual(await store.removeOwnedRouteAtomic({
    alias: codex.alias,
    binding: oldBinding,
    activity: { operatorAction: true },
  }), { removed: false, settlements: [] });
  assert.deepEqual(
    (await store.publicSnapshot()).activityEvents?.map(({ action }) => action),
    ["codex_unregistered"],
  );
  const replacement = route(
    "codex",
    codex.alias,
    "reg-codex-replacement",
    "codex-thread-replacement",
  );
  await store.registerRoute(replacement);
  assert.deepEqual(await store.removeOwnedRouteAtomic({
    alias: codex.alias,
    binding: oldBinding,
  }), { removed: false, settlements: [] });
  assert.equal(
    (await store.inspectPrivateRoute(codex.alias))?.binding.registrationId,
    replacement.binding.registrationId,
  );
  assert.equal((await store.removeOwnedRouteAtomic({
    alias: replacement.alias,
    binding: replacement.binding,
    activity: { operatorAction: true },
  })).removed, true);
  assert.deepEqual(
    (await store.publicSnapshot()).activityEvents?.map(({ action }) => action),
    ["codex_unregistered", "codex_unregistered"],
  );
  await store.close();
});

test("Claude replacement resolves one exact selection and preserves additive peers", async () => {
  const { store } = await fixture();
  await store.initialize();
  const other = route(
    "claude",
    "other@this-mac",
    "reg-claude-other",
    "claude-session-other",
  );
  await store.registerRoute(claude);
  await store.registerRoute(other);
  const renamed = route(
    "claude",
    "renamed@this-mac",
    claude.binding.registrationId,
    claude.binding.routeHandle,
  );
  await store.replaceClaudeSelection(renamed);
  assert.deepEqual(
    (await store.inspectPrivateRoutes()).map((entry) => entry.alias).sort(),
    [other.alias, renamed.alias].sort(),
  );
  const swapped = route(
    "claude",
    renamed.alias,
    "reg-claude-swapped",
    "claude-session-swapped",
  );
  await store.replaceClaudeSelection(swapped);
  assert.deepEqual(
    (await store.inspectPrivateRoutes()).map((entry) => entry.alias).sort(),
    [other.alias, swapped.alias].sort(),
  );
  await store.close();
});

test("native replies reject a non-Claude or cross-host transient authority", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.registerRoute(codex);
  await assert.rejects(
    store.enqueueNativeReply({
      sourceAlias: codex.alias,
      expectedSourceRegistrationId: codex.binding.registrationId,
      target: {
        alias: "dsh-target@this-mac",
        binding: {
          provider: "deepseek",
          hostId: "this-mac",
          routeHandle: "deepseek-target",
          registrationId: "reg-deepseek-target",
        },
      },
      body: "reply",
      dedupeKey: "bad-native-target",
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_NATIVE_PEER",
  );
  await store.close();
});

test("steer supersession, dedupe capacity, and source acceptance counters stay bounded", async () => {
  const { config, store } = await fixture({ limits: { dedupeCapacity: 3 } });
  await store.initialize();
  await paired(store);
  const results = [];
  for (let index = 0; index < 4; index += 1) {
    results.push(await store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      body: `STEER: ${index}`,
      dedupeKey: `steer-${index}`,
      steer: true,
    }));
  }
  assert.deepEqual(results[3]?.supersededSettlement, {
    messageId: results[0]?.messageId,
    state: "cancelled",
    safeErrorCode: "STEER_QUEUE_SUPERSEDED",
  });
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    routes: Array<{ alias: string; counters: { accepted: number; bytesAccepted: number } }>;
    dedupe: unknown[];
  };
  assert.equal(raw.dedupe.length, 3);
  const sourceCounters = raw.routes.find(
    (entry) => entry.alias === claude.alias,
  )?.counters;
  assert.equal(sourceCounters?.accepted, 4);
  assert.equal(sourceCounters?.bytesAccepted, 32);
  await store.close();
  const restarted = new GatewayStore(config);
  await restarted.initialize();
  await restarted.close();
});

test("normalized rejections commit suffix-only activity without fabricating message authority", async () => {
  const { config, clock: testClock, store } = await fixture();
  await store.initialize();
  await paired(store);
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: codex.alias,
      body: "late",
      dedupeKey: "invalid-deadline",
      deadlineAt: new Date(testClock.now().getTime() + 20_000).toISOString(),
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_DEADLINE",
  );
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    messages: unknown[];
    activity: Array<{ type: string; event: { state?: string; safeErrorCode?: string } }>;
    accounting: { rejected: number };
    routes: Array<{ alias: string; counters: { rejected: number } }>;
    consentEdges: Array<{ counters: { rejected: number } }>;
  };
  assert.equal(raw.messages.length, 0);
  assert.deepEqual(raw.activity.map((entry) => [
    entry.type,
    entry.event.state,
    entry.event.safeErrorCode,
  ]), [["legacy_message", "rejected", "INVALID_DEADLINE"]]);
  assert.equal(raw.accounting.rejected, 1);
  assert.equal(
    raw.routes.find((entry) => entry.alias === claude.alias)?.counters.rejected,
    1,
  );
  assert.equal(raw.consentEdges[0]?.counters.rejected, 1);
  await store.close();
  const restarted = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await restarted.initialize();
  assert.equal((await restarted.publicSnapshot()).messages[0]?.state, "rejected");
  await restarted.close();
});

test("interleaved message and runtime activity share one strict sequence", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  await enqueue(store, "sequence-message", "message");
  const event = await store.recordActivity({
    kind: "registration",
    action: "codex_registered",
    outcome: "accepted",
    aliases: [codex.alias],
    operatorAction: true,
  });
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    eventSequence: number;
    messages: Array<{ sequence: number }>;
    activity: Array<{ event: { sequence: number } }>;
  };
  assert.equal(event.sequence, raw.eventSequence);
  assert.equal(
    new Set([
      ...raw.messages.map((entry) => entry.sequence),
      ...raw.activity.map((entry) => entry.event.sequence),
    ]).size,
    raw.messages.length + raw.activity.length,
  );
  await store.close();
});

test("strict v3 rejects corrupted authority and disclosure-bearing activity", async () => {
  const { store } = await fixture();
  await store.initialize();
  await paired(store);
  await enqueue(store, "strict-graph", "strict");
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  const wrongDirection = structuredClone(raw);
  wrongDirection.messages[0].direction = "deepseek_to_codex";
  assert.equal(isGatewayPersistedStateV3(wrongDirection), false);
  const wrongConsent = structuredClone(raw);
  wrongConsent.messages[0].consentEdge[0].registrationId = "wrong-registration";
  assert.equal(isGatewayPersistedStateV3(wrongConsent), false);
  const injectedActivity = structuredClone(raw);
  injectedActivity.activity.push({
    type: "activity",
    event: {
      sequence: raw.eventSequence + 1,
      timestamp: "2026-08-16T12:00:00.000Z",
      kind: "registration",
      action: "codex_registered",
      outcome: "accepted",
      aliases: [],
      operatorAction: true,
      threadId: "must-not-load",
    },
  });
  injectedActivity.eventSequence += 1;
  assert.equal(isGatewayPersistedStateV3(injectedActivity), false);
  await store.close();
});

test("strict v3 binds open and transient native aliases to the exact route host", async () => {
  const { store } = await fixture({ inboundMode: "open" });
  await store.initialize();
  await store.registerRoute(codex);
  const native = {
    alias: "native@this-mac",
    binding: {
      provider: "claude" as const,
      hostId: "this-mac",
      routeHandle: "native-claude-session",
      registrationId: "native-claude-registration",
    },
  };
  await store.enqueueNativeIngress({
    source: native,
    targetAlias: codex.alias,
    expectedTargetRegistrationId: codex.binding.registrationId,
    body: "ingress",
    dedupeKey: "native-ingress-host",
  });
  const hiddenReply = await store.enqueueNativeReply({
    sourceAlias: codex.alias,
    expectedSourceRegistrationId: codex.binding.registrationId,
    target: native,
    body: "reply",
    dedupeKey: "native-reply-host",
  });
  assert.equal(hiddenReply.deliveryToken, undefined);
  const explicitReply = await store.enqueueNativeReply({
    sourceAlias: codex.alias,
    expectedSourceRegistrationId: codex.binding.registrationId,
    target: native,
    body: "explicit reply",
    dedupeKey: "native-explicit-reply-host",
    exposeDeliveryToken: true,
  });
  assert.match(explicitReply.deliveryToken ?? "", /^dlv_/u);
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  assert.equal(isGatewayPersistedStateV3(raw), true);
  const badIngress = structuredClone(raw);
  badIngress.messages.find(
    (message: { direction: string }) => message.direction === "claude_to_codex",
  ).sourceAlias = "native@other-host";
  assert.equal(isGatewayPersistedStateV3(badIngress), false);
  const badReply = structuredClone(raw);
  badReply.messages.find(
    (message: { direction: string }) => message.direction === "codex_to_claude",
  ).targetAlias = "native@other-host";
  assert.equal(isGatewayPersistedStateV3(badReply), false);
  await store.close();
});

test("runtime requires exact private modes for state directories and files", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();
  await chmod(setup.stateDir, 0o500);
  await assert.rejects(new GatewayStore(setup.config).initialize(), /exact mode 700/u);
  await chmod(setup.stateDir, 0o700);
  await chmod(setup.store.stateFilePath, 0o400);
  await assert.rejects(new GatewayStore(setup.config).initialize(), /exact mode 600/u);
  await chmod(setup.store.stateFilePath, 0o600);
});
