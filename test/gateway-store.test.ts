import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename as renameFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import { BridgeError } from "../src/errors.js";
import os from "node:os";
import path from "node:path";
import type { GatewayConfig } from "../src/gateway/config.js";
import { peerRouteRef, type PeerCatalogResult, type PeerHandoffParams } from "../src/gateway/peer-protocol.js";
import {
  GatewayStore,
  isGatewayPersistedStateV5,
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
    isProcessAlive?: (pid: number) => boolean;
    hostname?: () => string;
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
    hostId: "this-mac",
    peerNodes: [],
    stallNoticeMs: 2_500,
    steeringEnabled: true,
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
    ...(dependencies.isProcessAlive === undefined
      ? {}
      : { isProcessAlive: dependencies.isProcessAlive }),
    ...(dependencies.hostname === undefined ? {} : { hostname: dependencies.hostname }),
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
  "reg_claude_0001",
  "claude-session-private-0001",
);
const codex = route(
  "codex",
  "codex-reviewer@this-mac",
  "reg_codex_0001",
  "codex-thread-private-0001",
);

async function routed(store: GatewayStore): Promise<void> {
  await store.registerRoute(claude);
  await store.registerRoute(codex);
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

test("new stores are strict native v5 and public projection redacts private IDs", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  const accepted = await enqueue(store, "native-v3", "hello v3");
  assert.equal(accepted.accepted, true);
  assert.match(accepted.deliveryToken ?? "", /^dlv_[A-Za-z0-9_-]{24}$/u);
  assert.equal(accepted.deliveryToken?.length, 28);

  const body = await readFile(store.stateFilePath, "utf8");
  const state = JSON.parse(body) as Record<string, unknown>;
  assert.equal(state.schemaVersion, 5);
  assert.deepEqual(Object.keys(state), [
    "schemaVersion",
    "commit",
    "createdAt",
    "updatedAt",
    "eventSequence",
    "routes",
    "messages",
    "dedupe",
    "rateBuckets",
    "activity",
    "accounting",
  ]);
  assert.equal(isGatewayPersistedStateV5(state), true);
  assert.equal(body.includes("endpointGeneration"), false);
  assert.equal(body.includes("ownerLease"), false);
  assert.equal(body.includes("connectors"), false);
  assert.equal(body.includes("Succession"), false);
  assert.equal(body.includes("consentEdge"), false);
  // Schema 5 is exact-key: a file written before consent edges were deleted
  // still carries `consentEdges`, and the loader refuses it rather than
  // silently dropping the key. The documented recovery is a state reset.
  assert.equal(isGatewayPersistedStateV5({ ...state, consentEdges: [] }), false);

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

test("runtime refuses unsupported schemas without mutating state", async () => {
  const first = await fixture();
  await first.store.initialize();
  await first.store.close();
  assert.match(await readFile(first.store.stateFilePath, "utf8"), /"schemaVersion": 5,/u);
  // A schema-4 file from the 2.x line is refused outright: reset-only, no migration.
  await writeFile(
    first.store.stateFilePath,
    `${JSON.stringify({ schemaVersion: 4, arbitrary: "not validated" })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(first.config).initialize(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "GATEWAY_STATE_SCHEMA_UNSUPPORTED" &&
      /move gateway-state\.json aside.*nodes\.json, if you use federation, is untouched/iu.test(error.message),
  );
  const unchanged = await readFile(first.store.stateFilePath, "utf8");
  assert.match(unchanged, /"schemaVersion":4/u);

  const corruptCurrent = `${JSON.stringify({ schemaVersion: 5 })}\n`;
  await writeFile(first.store.stateFilePath, corruptCurrent, { mode: 0o600 });
  await assert.rejects(
    new GatewayStore(first.config).initialize(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CORRUPT_GATEWAY_STATE",
  );
  assert.equal(await readFile(first.store.stateFilePath, "utf8"), corruptCurrent);

  // Consent edges left schema 5 without a version bump: an older schema-5 file
  // that still carries the key is refused by the exact-key check, with the
  // same reset-only recovery and no in-place rewrite.
  const retired = await fixture();
  await retired.store.initialize();
  const current = JSON.parse(await readFile(retired.store.stateFilePath, "utf8")) as Record<string, unknown>;
  await retired.store.close();
  const withEdges = `${JSON.stringify({ ...current, consentEdges: [] })}\n`;
  await writeFile(retired.store.stateFilePath, withEdges, { mode: 0o600 });
  await assert.rejects(
    new GatewayStore(retired.config).initialize(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CORRUPT_GATEWAY_STATE",
  );
  assert.equal(await readFile(retired.store.stateFilePath, "utf8"), withEdges);
});

test("message direction is read from the binding and never inferred from alias prefixes", async () => {
  const { store } = await fixture();
  await store.initialize();
  const deceptiveClaude = route(
    "claude",
    "codex-looking@this-mac",
    "reg_claude_deceptive",
    "session-deceptive",
  );
  const deceptiveCodex = route(
    "codex",
    "codex-actual@this-mac",
    "reg_codex_actual",
    "thread-actual",
  );
  await store.registerRoute(deceptiveClaude);
  await store.registerRoute(deceptiveCodex);
  await store.enqueueMessage({
    sourceAlias: deceptiveClaude.alias,
    targetAlias: deceptiveCodex.alias,
    expectedSourceRegistrationId: deceptiveClaude.binding.registrationId,
    expectedTargetRegistrationId: deceptiveCodex.binding.registrationId,
    body: "deceptive prefix",
    dedupeKey: "deceptive-prefix",
  });
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    messages: Array<{ direction: string; sourceRegistrationId: string; targetRegistrationId: string }>;
  };
  assert.deepEqual(
    raw.messages.map(({ direction, sourceRegistrationId, targetRegistrationId }) =>
      ({ direction, sourceRegistrationId, targetRegistrationId })),
    [{ direction: "claude_to_codex", sourceRegistrationId: "reg_claude_deceptive",
      targetRegistrationId: "reg_codex_actual" }],
  );
  await store.close();
});

test("ordinary enqueue fences both exact registrations before admission", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);

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
    "reg_claude_fence_replacement_1",
    "claude-session-fence-replacement-1",
  );
  await store.installClaudeRoute(replacementSource);
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
    "reg_claude_fence_replacement_2",
    "claude-session-fence-replacement-2",
  );
  await store.installClaudeRoute(replacementTarget);
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

test("same-alias replacement fences native admission on both sides and succession", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  await store.removeOwnedRouteAtomic({
    alias: codex.alias,
    binding: codex.binding,
    activity: { operatorAction: true },
  });
  const current = route(
    "codex",
    codex.alias,
    "reg_codex_race_current",
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
    "reg_codex_race_successor",
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
    // The sender's own route is fenced by its exact binding: a session that
    // re-anchored under the same name cannot inherit the prior one's identity.
    () => store.enqueueNativeIngress({
      source: { alias: claude.alias, binding: { ...claude.binding, routeHandle: "claude-session-displaced" } },
      targetAlias: current.alias,
      expectedTargetRegistrationId: current.binding.registrationId,
      body: "stale sender",
      dedupeKey: "stale-native-sender",
    }),
    () => store.replaceCodexRegistrationAtomic({
      oldAlias: current.alias,
      expectedOldRegistrationId: codex.binding.registrationId,
      replacement: successor,
      activity: { operatorAction: true },
    }),
  ];
  for (const operation of staleOperations) {
    const before = await readFile(store.stateFilePath, "utf8");
    await assert.rejects(operation(), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ROUTE_UNREGISTERED");
    assert.equal(await readFile(store.stateFilePath, "utf8"), before);
  }
  const admitted = await store.enqueueNativeIngress({
    source: { alias: claude.alias, binding: claude.binding },
    targetAlias: current.alias,
    expectedTargetRegistrationId: current.binding.registrationId,
    body: "current sender",
    dedupeKey: "current-native-sender",
  });
  assert.equal(admitted.accepted, true);
  assert.equal(admitted.deliveryToken, undefined);
  await store.close();
});

test("attempt authority advances exactly and late or mismatched evidence is a no-op", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
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
  await routed(store);
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

test("peer targets require peer mailbox prepared evidence", async () => {
  const { store } = await fixture();
  await store.initialize();
  const peer = route("peer", "peer-shell@this-mac", "reg_peer_0001",
    `peer:${"a".repeat(64)}`);
  await assert.rejects(store.registerRoute({ ...peer, binding: {
    ...peer.binding, routeHandle: `peer_${"a".repeat(32)}`,
  } }), (error: unknown) => error instanceof Error && "code" in error &&
    error.code === "INVALID_ROUTE_BINDING");
  await store.registerRoute(codex);
  await store.registerRoute(peer);
  const hostile = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  hostile.routes.find((candidate: { alias: string }) => candidate.alias === peer.alias)
    .binding.routeHandle = `peer_${"a".repeat(32)}`;
  assert.equal(isGatewayPersistedStateV5(hostile), false);
  await store.enqueueMessage({ sourceAlias: codex.alias, targetAlias: peer.alias,
    body: "peer body", dedupeKey: "peer-prepared" });
  const attempt = await reserve(store, peer.alias);
  await assert.rejects(store.authorizeMessage({ messageId: attempt.messageId,
    attemptId: attempt.attemptId, sourceRegistrationId: attempt.sourceRegistrationId,
    targetRegistrationId: attempt.targetRegistrationId, prepared: preparedFor(attempt.body) }),
  (error: unknown) => error instanceof Error && "code" in error &&
    error.code === "INVALID_PREPARED_WRITE_EVIDENCE");
  assert.deepEqual(await store.authorizeMessage({ messageId: attempt.messageId,
    attemptId: attempt.attemptId, sourceRegistrationId: attempt.sourceRegistrationId,
    targetRegistrationId: attempt.targetRegistrationId,
    prepared: { ...preparedFor(attempt.body), kind: "peer_mailbox" } }),
  { status: "authorized" });
  await store.close();
});

test("route registration refuses legacy identifiers before persistence", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await store.registerRoute(codex);
  const before = await readFile(store.stateFilePath);
  await assert.rejects(
    store.registerRoute(route(
      "claude",
      "claude-legacy@this-mac",
      "lease_legacy",
      "claude-session-legacy",
    )),
    (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "INVALID_ROUTE_BINDING",
  );
  assert.deepEqual(await readFile(store.stateFilePath), before);
  await store.close();

  const reopened = new GatewayStore(config);
  await reopened.initialize();
  assert.equal(
    (await reopened.inspectPrivateRoutes()).some(
      (candidate) => candidate.binding.registrationId === "lease_legacy",
    ),
    false,
  );
  await reopened.close();
});

test("restart applies phase truth before an elapsed deadline", async () => {
  const { config, clock: testClock, store } = await fixture();
  await store.initialize();
  await routed(store);
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
  await routed(store);
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
  await routed(store);
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
  await routed(store);

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
  await routed(store);

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
    kind: "discovery",
    action: "discovery_refreshed",
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
  await routed(store);

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

test("displacing a Claude alias settles the retired route's work with exact phase truth", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  const armedMessage = await enqueue(store, "retire-armed", "armed");
  const acceptedMessage = await enqueue(store, "retire-accepted", "accepted");
  const queuedMessage = await enqueue(store, "retire-queued", "queued");
  const armedAttempt = await reserve(store);
  await authorize(store, armedAttempt);
  const acceptedAttempt = await reserve(store);
  await authorize(store, acceptedAttempt);
  await store.acceptMessage({
    messageId: acceptedAttempt.messageId,
    attemptId: acceptedAttempt.attemptId,
    lossOutcome: "ambiguous",
  });
  const displacing = route(
    "claude",
    claude.alias,
    "reg_claude_displacing",
    "claude-session-displacing",
  );
  const installed = await store.installClaudeRoute(displacing);
  assert.equal(installed.installed, true);
  assert.deepEqual(
    installed.settlements.map(({ messageId, state, safeErrorCode }) => ({
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
        safeErrorCode: "ENDPOINT_RETIRED",
      },
    ],
  );
  assert.equal(
    (await store.inspectPrivateRoute(claude.alias))?.binding.registrationId,
    displacing.binding.registrationId,
  );
  assert.deepEqual(
    (await store.publicSnapshot()).activityEvents?.map(({ kind, action, aliases }) =>
      ({ kind, action, aliases })),
    [
      { kind: "registration", action: "claude_route_retired", aliases: [claude.alias] },
      { kind: "registration", action: "claude_route_installed", aliases: [claude.alias] },
    ],
  );
  await store.close();
});

test("enqueue refuses a same-provider same-host pair and a Claude install refuses a foreign alias", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  const sibling = route("claude", "sibling@this-mac", "reg_claude_sibling", "claude-session-sibling");
  await store.registerRoute(sibling);
  // Direction is the whole routing decision: two routes of the same provider on
  // the same host have no direction between them, so admission refuses rather
  // than writing a message the loader would later call corrupt.
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: claude.alias,
      targetAlias: sibling.alias,
      expectedSourceRegistrationId: claude.binding.registrationId,
      expectedTargetRegistrationId: sibling.binding.registrationId,
      body: "claude to claude",
      dedupeKey: "same-provider-same-host",
    }),
    (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "ROUTE_DIRECTION_MISMATCH",
  );
  assert.deepEqual((await store.publicSnapshot()).messages, []);
  // A Claude session may legally carry any name, but installing its route can
  // never displace a route of another provider that already holds that name.
  await assert.rejects(
    store.installClaudeRoute(route("claude", codex.alias, "reg_claude_impostor", "claude-session-impostor")),
    (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "ROUTE_ALIAS_ALREADY_REGISTERED",
  );
  assert.equal((await store.inspectPrivateRoute(codex.alias))?.binding.provider, "codex");
  await store.close();
});

test("a re-anchored Claude session keeps its registration and is renamed in place", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  const inFlight = await enqueue(store, "reanchor-queued", "queued");
  const renamed = route(
    "claude",
    "renamed@this-mac",
    claude.binding.registrationId,
    claude.binding.routeHandle,
  );
  assert.deepEqual(await store.installClaudeRoute(renamed), { installed: true, settlements: [] });
  assert.equal((await store.inspectPrivateRoute(renamed.alias))?.binding.registrationId,
    claude.binding.registrationId);
  assert.equal(await store.inspectPrivateRoute(claude.alias), undefined);
  const events = (await store.publicSnapshot()).messages;
  assert.equal(events.find((event) => event.messageIdSuffix === inFlight.messageIdSuffix)?.sourceAlias,
    renamed.alias);
  assert.deepEqual(await store.installClaudeRoute(renamed), { installed: false, settlements: [] });
  // The identity is the (host, session UUID) pair: a caller that offers a
  // fresh registration for a session already bound is refused, never silently
  // re-registered, so the UUID-recovery path cannot fork one session in two.
  await assert.rejects(
    store.installClaudeRoute({ ...renamed,
      binding: { ...renamed.binding, registrationId: "reg_claude_forked" } }),
    (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "ROUTE_IDENTITY_ALREADY_REGISTERED",
  );
  await store.close();
});

test("Codex succession is one idempotent replacement with exact phase settlement", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
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
    "reg_codex_successor",
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
  assert.equal((await store.inspectPrivateRoute(replacement.alias))?.binding.registrationId,
    replacement.binding.registrationId);
  await store.close();
});

test("in-flight capacity is enforced before queue reservation", async () => {
  const { store } = await fixture({ limits: { maxInFlightMessages: 1 } });
  await store.initialize();
  await routed(store);
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
  await routed(store);
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

test("federated routes refuse exact-owned removal at the store even with a matching binding", async () => {
  const setup = await fixture();
  const store = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await store.initialize();
  await store.registerRoute({ alias: "codex-local@studio", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "studio", routeHandle: "thread-local", registrationId: "reg_local" } });
  const mirror: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
    binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote_codex", registrationId: "reg_mirror_codex" } };
  await store.registerRoute(mirror);
  const before = await readFile(store.stateFilePath, "utf8");
  for (const activity of [undefined, { operatorAction: true }] as const) {
    await assert.rejects(
      store.removeOwnedRouteAtomic({ alias: mirror.alias, binding: { ...mirror.binding },
        ...(activity === undefined ? {} : { activity }) }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "FEDERATED_ROUTE_READ_ONLY",
    );
  }
  assert.equal(await readFile(store.stateFilePath, "utf8"), before);
  assert.equal((await store.inspectPrivateRoute(mirror.alias))?.registrationMode, "federated_peer");
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
    "reg_codex_replacement",
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

test("installing a Claude route resolves one exact identity and preserves other routes", async () => {
  const { store } = await fixture();
  await store.initialize();
  const other = route(
    "claude",
    "other@this-mac",
    "reg_claude_other",
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
  await store.installClaudeRoute(renamed);
  assert.deepEqual(
    (await store.inspectPrivateRoutes()).map((entry) => entry.alias).sort(),
    [other.alias, renamed.alias].sort(),
  );
  const swapped = route(
    "claude",
    renamed.alias,
    "reg_claude_swapped",
    "claude-session-swapped",
  );
  await store.installClaudeRoute(swapped);
  assert.deepEqual(
    (await store.inspectPrivateRoutes()).map((entry) => entry.alias).sort(),
    [other.alias, swapped.alias].sort(),
  );
  await store.close();
});

test("native ingress rejects a non-Claude or cross-host sender authority", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.registerRoute(codex);
  for (const source of [
    { alias: "peer-shell@this-mac", binding: { provider: "peer" as const, hostId: "this-mac",
      routeHandle: `peer:${"a".repeat(64)}`, registrationId: "reg_peer_source" } },
    { alias: "visitor@other-host", binding: { provider: "claude" as const, hostId: "other-host",
      routeHandle: "claude-session-elsewhere", registrationId: "reg_claude_elsewhere" } },
  ]) {
    await assert.rejects(
      store.enqueueNativeIngress({
        source,
        targetAlias: codex.alias,
        expectedTargetRegistrationId: codex.binding.registrationId,
        body: "ingress",
        dedupeKey: `bad-native-source-${source.binding.provider}`,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_NATIVE_PEER",
    );
  }
  await store.close();
});

test("steer supersession, dedupe capacity, and source acceptance counters stay bounded", async () => {
  const { config, store } = await fixture({ limits: { dedupeCapacity: 3 } });
  await store.initialize();
  await routed(store);
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
  await routed(store);
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
  };
  assert.equal(raw.messages.length, 0);
  assert.deepEqual(raw.activity.map((entry) => [
    entry.type,
    entry.event.state,
    entry.event.safeErrorCode,
  ]), [["message_activity", "rejected", "INVALID_DEADLINE"]]);
  assert.equal(raw.accounting.rejected, 1);
  assert.equal(
    raw.routes.find((entry) => entry.alias === claude.alias)?.counters.rejected,
    1,
  );
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
  await routed(store);
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

test("strict v5 rejects corrupted authority and disclosure-bearing activity", async () => {
  const { store } = await fixture();
  await store.initialize();
  await routed(store);
  await enqueue(store, "strict-graph", "strict");
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  const wrongDirection = structuredClone(raw);
  wrongDirection.messages[0].direction = "shell_to_codex";
  assert.equal(isGatewayPersistedStateV5(wrongDirection), false);
  const wrongSourceRegistration = structuredClone(raw);
  wrongSourceRegistration.messages[0].sourceRegistrationId = "reg_not_installed";
  assert.equal(isGatewayPersistedStateV5(wrongSourceRegistration), false);
  const retiredConsentKey = structuredClone(raw);
  retiredConsentKey.messages[0].consentEdge = null;
  assert.equal(isGatewayPersistedStateV5(retiredConsentKey), false);
  const legacyRegistration = structuredClone(raw);
  legacyRegistration.routes[0].binding.registrationId = "lease_legacy";
  assert.equal(isGatewayPersistedStateV5(legacyRegistration), false);
  const legacyBusyPolicy = structuredClone(raw);
  legacyBusyPolicy.routes[0].busyPolicy = "refuse";
  assert.equal(isGatewayPersistedStateV5(legacyBusyPolicy), false);
  const legacyDeliveryToken = structuredClone(raw);
  legacyDeliveryToken.messages[0].deliveryToken += "x";
  assert.equal(isGatewayPersistedStateV5(legacyDeliveryToken), false);
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
  assert.equal(isGatewayPersistedStateV5(injectedActivity), false);
  await store.close();
});

test("strict v5 binds native ingress and its ordinary reply to the exact route host", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.registerRoute(codex);
  const native = {
    alias: "native@this-mac",
    registrationMode: "selected_live_peer" as const,
    binding: {
      provider: "claude" as const,
      hostId: "this-mac",
      routeHandle: "native-claude-session",
      registrationId: "reg_native_claude",
    },
  };
  // The sending session's route installs on this first send; the Codex task's
  // reply then travels the ordinary path, with no transient target.
  await store.installClaudeRoute(native);
  await store.enqueueNativeIngress({
    source: { alias: native.alias, binding: native.binding },
    targetAlias: codex.alias,
    expectedTargetRegistrationId: codex.binding.registrationId,
    body: "ingress",
    dedupeKey: "native-ingress-host",
  });
  const reply = await store.enqueueMessage({
    sourceAlias: codex.alias,
    targetAlias: native.alias,
    expectedSourceRegistrationId: codex.binding.registrationId,
    expectedTargetRegistrationId: native.binding.registrationId,
    body: "reply",
    dedupeKey: "native-reply-host",
  });
  assert.match(reply.deliveryToken ?? "", /^dlv_/u);
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  assert.equal(isGatewayPersistedStateV5(raw), true);
  const badIngress = structuredClone(raw);
  badIngress.messages.find(
    (message: { direction: string }) => message.direction === "claude_to_codex",
  ).sourceAlias = "native@other-host";
  assert.equal(isGatewayPersistedStateV5(badIngress), false);
  const badReply = structuredClone(raw);
  badReply.messages.find(
    (message: { direction: string }) => message.direction === "codex_to_claude",
  ).targetAlias = "native@other-host";
  assert.equal(isGatewayPersistedStateV5(badReply), false);
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

test("an unowned state directory admits exactly nodes.json before its ownership marker", async () => {
  const accepted = await fixture();
  await mkdir(accepted.stateDir, { mode: 0o700 });
  await writeFile(path.join(accepted.stateDir, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}', { mode: 0o600 });
  await accepted.store.initialize(); await accepted.store.close();

  const rejected = await fixture();
  await mkdir(rejected.stateDir, { mode: 0o700 });
  await writeFile(path.join(rejected.stateDir, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}', { mode: 0o600 });
  await writeFile(path.join(rejected.stateDir, "foreign"), "untouched", { mode: 0o600 });
  await assert.rejects(rejected.store.initialize(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_STATE_DIRECTORY_NOT_OWNED");
  assert.equal(await readFile(path.join(rejected.stateDir, "foreign"), "utf8"), "untouched");
});

test("boot removes stale gateway-dashboard files left by a 2.x install and never recreates them", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();
  const markerPath = path.join(setup.stateDir, ".agent-embassy-state");
  const markerBefore = await readFile(markerPath, "utf8");

  const enPath = path.join(setup.stateDir, "gateway-dashboard.html");
  const zhPath = path.join(setup.stateDir, "gateway-dashboard.zh-CN.html");
  await writeFile(enPath, "<html>stale</html>", { mode: 0o600 });
  await writeFile(zhPath, "<html>stale</html>", { mode: 0o600 });

  const reopened = new GatewayStore(setup.config);
  await reopened.initialize();
  await assert.rejects(lstat(enPath));
  await assert.rejects(lstat(zhPath));
  // The boot sweep touches only the two stale dashboard files.
  assert.equal(await readFile(markerPath, "utf8"), markerBefore);
  assert.match(await readFile(reopened.stateFilePath, "utf8"), /"schemaVersion": 5,/u);
  await reopened.close();

  // A later boot with nothing left to remove is a no-op: still gone, nothing recreated.
  const rebooted = new GatewayStore(setup.config);
  await rebooted.initialize();
  await assert.rejects(lstat(enPath));
  await assert.rejects(lstat(zhPath));
  await rebooted.close();
});

test("boot cleanup never follows a symlink planted at the dashboard filename", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();

  const target = path.join(setup.stateDir, "..", "outside-target");
  await writeFile(target, "do not touch", { mode: 0o600 });
  const linkPath = path.join(setup.stateDir, "gateway-dashboard.html");
  await symlink(target, linkPath);

  const reopened = new GatewayStore(setup.config);
  await reopened.initialize();
  await reopened.close();
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), "do not touch");
});

test("boot removes 2.x's stale dashboard publish temp files, and only those", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();

  const enTemp = path.join(setup.stateDir, ".gateway-dashboard.html.a1b2c3.tmp");
  const zhTemp = path.join(setup.stateDir, ".gateway-dashboard.zh-CN.html.d4e5f6.tmp");
  const unrelatedTemp = path.join(setup.stateDir, ".unrelated.tmp");
  await writeFile(enTemp, "<html>partial</html>", { mode: 0o600 });
  await writeFile(zhTemp, "<html>partial</html>", { mode: 0o600 });
  await writeFile(unrelatedTemp, "keep me", { mode: 0o600 });

  const reopened = new GatewayStore(setup.config);
  await reopened.initialize();
  await assert.rejects(lstat(enTemp));
  await assert.rejects(lstat(zhTemp));
  assert.equal(await readFile(unrelatedTemp, "utf8"), "keep me");
  await reopened.close();
});

test("a refused boot never sweeps the state directory: cleanup runs only after loadStateFile succeeds", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();

  await writeFile(
    setup.store.stateFilePath,
    `${JSON.stringify({ schemaVersion: 4, arbitrary: "not validated" })}\n`,
    { mode: 0o600 },
  );
  const stalePath = path.join(setup.stateDir, "gateway-dashboard.html");
  await writeFile(stalePath, "<html>stale</html>", { mode: 0o600 });

  await assert.rejects(
    new GatewayStore(setup.config).initialize(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "GATEWAY_STATE_SCHEMA_UNSUPPORTED",
  );
  // The refused boot must leave the directory exactly as found: cleanup runs
  // only after loadStateFile() succeeds, and this one never did.
  assert.equal(await readFile(stalePath, "utf8"), "<html>stale</html>");
});

test("a boot refused for out-of-bounds state leaves a planted stale file exactly as found", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.registerRoute(claude);
  await setup.store.close();
  const stalePath = path.join(setup.stateDir, "gateway-dashboard.html");
  await writeFile(stalePath, "<html>stale</html>", { mode: 0o600 });

  // Same directory, a host allowlist the persisted route cannot satisfy: this
  // refuses inside assertConfiguredBounds, past the schema check.
  const foreign = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio"] });
  await assert.rejects(
    foreign.initialize(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CORRUPT_GATEWAY_STATE",
  );
  assert.equal(await readFile(stalePath, "utf8"), "<html>stale</html>");
});

const LOCK_NAME = ".gateway-controller.lock";
const THIS_MACHINE = "fixture-machine.local";
const lockBody = (owner: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schemaVersion: 1, token: "00000000-0000-4000-8000-00000000a11e", ...owner })}\n`;

// The five states a controller lock can be found in. Liveness and this
// machine's own name are both injected, so nothing here depends on the
// runner's pid space or on a hostname the lock pattern happens to accept.
test("case 1 of 5: a live pid refuses and carries the host and pid its hint prints", async () => {
  for (const recorded of [THIS_MACHINE, "the-old-name.local"]) {
    const setup = await fixture({ isProcessAlive: () => true, hostname: () => THIS_MACHINE });
    await setup.store.initialize();
    await setup.store.close();
    const lockPath = path.join(setup.stateDir, LOCK_NAME);
    const planted = lockBody({ pid: 4242, hostname: recorded });
    await writeFile(lockPath, planted, { mode: 0o600 });

    await assert.rejects(
      new GatewayStore(setup.config, { isProcessAlive: () => true, hostname: () => THIS_MACHINE }).initialize(),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, "GATEWAY_STATE_IN_USE");
        assert.equal(error.recoverable, true);
        // Both name-branches carry the same bounded detail, this machine's
        // own included: pid numbers are reused there too.
        assert.deepEqual(error.detail, { host: recorded, pid: "4242" });
        return true;
      },
    );
    assert.equal(await readFile(lockPath, "utf8"), planted);
  }
});

test("case 1b: a recorded machine name this cannot represent reports no host at all", async () => {
  const setup = await fixture({ isProcessAlive: () => true, hostname: () => THIS_MACHINE });
  await setup.store.initialize();
  await setup.store.close();
  await writeFile(path.join(setup.stateDir, LOCK_NAME),
    lockBody({ pid: 4242, hostname: "a name with spaces" }), { mode: 0o600 });

  await assert.rejects(
    new GatewayStore(setup.config, { isProcessAlive: () => true, hostname: () => THIS_MACHINE }).initialize(),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "GATEWAY_STATE_IN_USE");
      // No host key at all, so no hint can print a placeholder for one.
      assert.deepEqual(error.detail, { pid: "4242" });
      return true;
    },
  );
});

test("case 2 of 5: an empty lock left between create and write is recovered as stale", async () => {
  const setup = await fixture({ isProcessAlive: () => true });
  await setup.store.initialize();
  await setup.store.close();
  await writeFile(path.join(setup.stateDir, LOCK_NAME), "", { mode: 0o600 });

  const reopened = new GatewayStore(setup.config, { isProcessAlive: () => true });
  await reopened.initialize();
  await reopened.close();
  assert.ok((await readdir(setup.stateDir)).some((name) => name.startsWith(`${LOCK_NAME}.stale-`)));
});

test("case 3 of 5: an unparsable lock refuses as unverified and is left exactly as found", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();
  const lockPath = path.join(setup.stateDir, LOCK_NAME);
  const planted = "{not json at all\n";
  await writeFile(lockPath, planted, { mode: 0o600 });

  await assert.rejects(
    new GatewayStore(setup.config).initialize(),
    (error: unknown) => error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_LOCK_UNVERIFIED" && !error.recoverable,
  );
  assert.equal(await readFile(lockPath, "utf8"), planted);
});

test("case 4 of 5: a record that parses but names no process is unverified, never 'in use'", async () => {
  // Nothing to probe and nothing to claim: saying another broker may own the
  // directory would be an assertion this record cannot support.
  for (const owner of [{}, { pid: "4242" }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }]) {
    const setup = await fixture({ isProcessAlive: () => true });
    await setup.store.initialize();
    await setup.store.close();
    const lockPath = path.join(setup.stateDir, LOCK_NAME);
    const planted = lockBody({ hostname: THIS_MACHINE, ...owner });
    await writeFile(lockPath, planted, { mode: 0o600 });

    await assert.rejects(
      new GatewayStore(setup.config, { isProcessAlive: () => true }).initialize(),
      (error: unknown) => error instanceof BridgeError &&
        error.code === "GATEWAY_STATE_LOCK_UNVERIFIED" && error.detail === undefined,
    );
    assert.equal(await readFile(lockPath, "utf8"), planted);
  }
});

test("case 5 of 5: a lock whose recorded pid is dead is recovered, whatever machine name wrote it", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();
  await writeFile(path.join(setup.stateDir, LOCK_NAME),
    lockBody({ pid: 4242, hostname: "the-old-name.local" }), { mode: 0o600 });

  const reopened = new GatewayStore(setup.config, { isProcessAlive: () => false });
  await reopened.initialize();
  await reopened.close();
  const moved = (await readdir(setup.stateDir)).filter((name) => name.startsWith(`${LOCK_NAME}.stale-`));
  assert.equal(moved.length, 1);
});

test("a recovered lock is kept seven days from its recovery, not from the crash it came from", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.close();
  // The lock of a broker that had been up a long time: its file timestamps are
  // ancient, and `rename` carries them across. Only the recovery time counts.
  const lockPath = path.join(setup.stateDir, LOCK_NAME);
  await writeFile(lockPath, lockBody({ pid: 4242, hostname: "the-old-name.local" }), { mode: 0o600 });
  const ancient = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lockPath, ancient, ancient);

  const recovering = new GatewayStore(setup.config, { now: setup.clock.now, isProcessAlive: () => false });
  await recovering.initialize();
  await recovering.close();
  const [recovered] = (await readdir(setup.stateDir)).filter((name) => name.startsWith(`${LOCK_NAME}.stale-`));
  assert.ok(recovered);
  // The boot that recovered it must not also sweep it, however old the file is.
  assert.equal(await readFile(path.join(setup.stateDir, recovered), "utf8").then(() => true), true);

  // Six days later it is still evidence.
  setup.clock.advance(6 * 24 * 60 * 60 * 1000);
  const soon = new GatewayStore(setup.config, { now: setup.clock.now });
  await soon.initialize();
  await soon.close();
  assert.ok((await readdir(setup.stateDir)).includes(recovered));

  // Two days after that, it is past the retention window and goes.
  setup.clock.advance(2 * 24 * 60 * 60 * 1000);
  const later = new GatewayStore(setup.config, { now: setup.clock.now });
  await later.initialize();
  await later.close();
  assert.equal((await readdir(setup.stateDir)).includes(recovered), false);
});

test("federated routes admit same-provider cross-host mail through peer_handoff only", async () => {
  const setup = await fixture();
  const config = { ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] };
  const store = new GatewayStore(config, { now: setup.clock.now, randomId: setup.clock.randomId });
  await store.initialize();
  const local: RegisterRouteInput = { alias: "codex-local@studio", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "studio", routeHandle: "thread-local", registrationId: "reg_local" } };
  const remote: RegisterRouteInput = { alias: "codex-remote@m5dev", registrationMode: "federated_peer",
    binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote", registrationId: "reg_mirror" } };
  const peerMirror: RegisterRouteInput = { alias: "peer-shell@m5dev", registrationMode: "federated_peer",
    binding: { provider: "peer", hostId: "m5dev", routeHandle: "reg_peer_remote", registrationId: "reg_peer_mirror" } };
  await store.registerRoute(local); await store.registerRoute(remote); await store.registerRoute(peerMirror);
  const admitted = await store.enqueueMessage({ sourceAlias: local.alias, targetAlias: remote.alias,
    expectedSourceRegistrationId: local.binding.registrationId, expectedTargetRegistrationId: remote.binding.registrationId,
    body: "cross-host", dedupeKey: "federated-cross-host" });
  const reserved = await store.reserveMessage(remote.alias);
  assert.equal(reserved.status, "reserved");
  if (reserved.status !== "reserved") return;
  const bodySha256 = createHash("sha256").update("cross-host").digest("hex");
  assert.deepEqual(await store.authorizeMessage({ messageId: reserved.attempt.messageId,
    attemptId: reserved.attempt.attemptId, sourceRegistrationId: local.binding.registrationId,
    targetRegistrationId: remote.binding.registrationId,
    prepared: { kind: "peer_handoff", bodyBytes: 10, bodySha256, frameBytes: 20, sha256: bodySha256 } }), { status: "authorized" });
  assert.deepEqual(await store.acceptMessage({ messageId: reserved.attempt.messageId,
    attemptId: reserved.attempt.attemptId, lossOutcome: "unconfirmed" }), { status: "accepted" });
  assert.equal((await store.settleAttempt({ messageId: reserved.attempt.messageId,
    attemptId: reserved.attempt.attemptId, state: "delivered", safeErrorCode: "PEER_HANDOFF_CONFIRMED" })).status, "settled");
  const state = JSON.parse(await readFile(store.stateFilePath, "utf8"));
  assert.equal(Object.hasOwn(state.messages[0], "body"), false);
  await store.enqueueMessage({ sourceAlias: local.alias, targetAlias: remote.alias,
    expectedSourceRegistrationId: local.binding.registrationId, expectedTargetRegistrationId: remote.binding.registrationId,
    body: "acceptance observed", dedupeKey: "federated-acceptance-loss" });
  const uncertain = await store.reserveMessage(remote.alias);
  assert.equal(uncertain.status, "reserved");
  if (uncertain.status === "reserved") {
    const uncertainSha = createHash("sha256").update("acceptance observed").digest("hex");
    await store.authorizeMessage({ messageId: uncertain.attempt.messageId, attemptId: uncertain.attempt.attemptId,
      sourceRegistrationId: local.binding.registrationId, targetRegistrationId: remote.binding.registrationId,
      prepared: { kind: "peer_handoff", bodyBytes: 19, bodySha256: uncertainSha, frameBytes: 30, sha256: uncertainSha } });
    assert.equal((await store.settleAttempt({ messageId: uncertain.attempt.messageId,
      attemptId: uncertain.attempt.attemptId, state: "unconfirmed",
      safeErrorCode: "PEER_HANDOFF_ACCEPTANCE_UNCONFIRMED" })).status, "settled");
  }
  assert.equal(admitted.accepted, true);

  const remoteSource: RegisterRouteInput = { alias: "claude-remote@m5dev", registrationMode: "federated_peer",
    binding: { provider: "claude", hostId: "m5dev", routeHandle: "reg_remote_source", registrationId: "reg_mirror_source" } };
  const localTarget: RegisterRouteInput = { alias: "codex-target@studio", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "studio", routeHandle: "thread-target", registrationId: "reg_local_target" } };
  await store.registerRoute(remoteSource); await store.registerRoute(localTarget);
  await store.enqueueMessage({ sourceAlias: remoteSource.alias, targetAlias: localTarget.alias,
    expectedSourceRegistrationId: remoteSource.binding.registrationId, expectedTargetRegistrationId: localTarget.binding.registrationId,
    body: "destination-owned", dedupeKey: "destination-owned-local-write" });
  const localAttempt = await store.reserveMessage(localTarget.alias);
  assert.equal(localAttempt.status, "reserved");
  if (localAttempt.status === "reserved") {
    const localSha = createHash("sha256").update("destination-owned").digest("hex");
    assert.equal((await store.authorizeMessage({ messageId: localAttempt.attempt.messageId, attemptId: localAttempt.attempt.attemptId,
      sourceRegistrationId: remoteSource.binding.registrationId, targetRegistrationId: localTarget.binding.registrationId,
      prepared: { kind: "codex_turn_start", bodyBytes: 17, bodySha256: localSha, frameBytes: 22, sha256: localSha } })).status, "authorized");
  }
  await store.close();
  const reopened = new GatewayStore(config, { now: setup.clock.now, randomId: setup.clock.randomId });
  await reopened.initialize();
  assert.deepEqual((await reopened.inspectPrivateRoute(peerMirror.alias))?.binding, peerMirror.binding);
  await reopened.close();
});

test("configured canonical host rejects retained local routes from the legacy host", async () => {
  const setup = await fixture();
  await setup.store.initialize();
  await setup.store.registerRoute(route("codex", "codex-main@this-mac", "reg_legacy"));
  await setup.store.close();
  const renamed = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio", "this-mac"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await assert.rejects(renamed.initialize(), /configured bounds or host allowlist/iu);
});

test("federated native ingress needs an installed sender route and no edge at all", async () => {
  const setup = await fixture();
  const store = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await store.initialize();
  const local: RegisterRouteInput = { alias: "codex-local@studio", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "studio", routeHandle: "thread-local", registrationId: "reg_local" } };
  const remote: RegisterRouteInput = { alias: "codex-main@m5dev", registrationMode: "federated_peer",
    binding: { provider: "codex", hostId: "m5dev", routeHandle: "reg_remote", registrationId: "reg_mirror" } };
  const visitor: RegisterRouteInput = { alias: "visitor@studio", registrationMode: "selected_live_peer",
    binding: { provider: "claude", hostId: "studio", routeHandle: "native-session", registrationId: "reg_native_visitor" } };
  await store.registerRoute(local); await store.registerRoute(remote);
  await assert.rejects(store.enqueueNativeIngress({ source: { alias: visitor.alias, binding: visitor.binding },
    targetAlias: remote.alias, expectedTargetRegistrationId: remote.binding.registrationId, body: "unrouted",
    dedupeKey: "federated-unrouted", conversationIdSuffix: "a1b2c3d4" }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "ROUTE_UNREGISTERED");
  assert.equal((await store.publicSnapshot()).messages.length, 0);
  await store.installClaudeRoute(visitor);
  const admitted = await store.enqueueNativeIngress({ source: { alias: visitor.alias, binding: visitor.binding },
    targetAlias: remote.alias, expectedTargetRegistrationId: remote.binding.registrationId, body: "cross-host native",
    dedupeKey: "federated-native", conversationIdSuffix: "a1b2c3d4" });
  assert.equal(admitted.accepted, true);
  await store.close();
});

test("a federation node whose only routes are mirrors can persist and reload its own state", async () => {
  // The broker's configured host identity is authority. Deriving it from the
  // routes alone wedges a fresh federation node: its first peer refresh writes
  // a mirrors-only file that its own validator would then refuse, leaving the
  // live broker unable to persist and the documented reset reproducing it.
  const setup = await fixture();
  const config = { ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] };
  const store = new GatewayStore(config, { now: setup.clock.now, randomId: setup.clock.randomId });
  await store.initialize();
  const remote = { alias: "codex-worker@m5dev", provider: "codex" as const, host: "m5dev", routeRef: "reg_remote_only" };
  const catalog = (revision: number): PeerCatalogResult => ({
    revision, complete: true, truncated: false, generatedAt: setup.clock.now().toISOString(),
    health: "healthy", connectors: [], routes: [{ ref: remote.routeRef, alias: remote.alias,
      provider: remote.provider, host: remote.host, enabled: true, state: "idle", queueDepth: 0 }],
    alerts: [] });
  // First peer refresh on a node with no local route of its own.
  await store.reconcilePeerCatalog("m5dev", catalog(1));
  assert.equal((await store.inspectPrivateRoute(remote.alias))?.registrationMode, "federated_peer");
  // A second mutation re-reads the file it just wrote: this is where the
  // derived-host bug turned a live broker into a write-wedged one.
  await store.reconcilePeerCatalog("m5dev", catalog(2));
  const raw = JSON.parse(await readFile(store.stateFilePath, "utf8")) as Record<string, unknown>;
  assert.equal(isGatewayPersistedStateV5(raw, "studio"), true);
  assert.equal((raw.routes as Array<{ registrationMode: string }>).every(
    (route) => route.registrationMode === "federated_peer"), true);
  await store.close();

  const reopened = new GatewayStore(config, { now: setup.clock.now, randomId: setup.clock.randomId });
  await reopened.initialize();
  assert.equal((await reopened.inspectPrivateRoute(remote.alias))?.registrationMode, "federated_peer");
  await reopened.close();

  // The host identity is still checked, not merely borrowed: the same file
  // under a broker that claims to be the mirror's own host is refused, and a
  // local route from a foreign host keeps its specific remedy.
  assert.equal(isGatewayPersistedStateV5(raw, "m5dev"), false);
  const foreignLocal = new GatewayStore({ ...config, hostId: "lab", allowedHosts: ["lab", "m5dev"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await foreignLocal.initialize();
  await foreignLocal.registerRoute({ alias: "codex-local@lab", registrationMode: "explicit_opt_in",
    binding: { provider: "codex", hostId: "lab", routeHandle: "thread-lab", registrationId: "reg_lab" } });
  await foreignLocal.close();
  await assert.rejects(
    new GatewayStore({ ...config, hostId: "studio", allowedHosts: ["studio", "lab", "m5dev"] },
      { now: setup.clock.now, randomId: setup.clock.randomId }).initialize(),
    /configured bounds or host allowlist/iu,
  );
});

test("peer catalog reconciliation and destination enqueue commit one destination-owned copy", async () => {
  const setup = await fixture();
  const store = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await store.initialize();
  const local = { alias: "codex-local@studio", registrationMode: "explicit_opt_in" as const,
    binding: { provider: "codex" as const, hostId: "studio", routeHandle: "thread-local", registrationId: "reg_local" } };
  await store.registerRoute(local);
  const remoteEndpoint = { alias: "codex-worker@m5dev", provider: "codex" as const, host: "m5dev", routeRef: "reg_remote_codex" };
  const localEndpoint = { alias: local.alias, provider: local.binding.provider, host: "studio",
    routeRef: peerRouteRef("studio", local.binding.registrationId) };
  const catalog = (revision: number, alias = remoteEndpoint.alias): PeerCatalogResult => { const remote = { ...remoteEndpoint, alias }; return {
    revision, complete: true, truncated: false, generatedAt: setup.clock.now().toISOString(), health: "healthy", connectors: [],
    routes: [{ ref: remote.routeRef, alias: remote.alias, provider: remote.provider, host: remote.host,
      enabled: true, state: "idle", queueDepth: 0 }], alerts: [] }; };
  const first = await store.reconcilePeerCatalog("m5dev", catalog(1));
  assert.equal(first.routes[0]?.alias, remoteEndpoint.alias); assert.equal(first.settlements.length, 0);
  const handoff: PeerHandoffParams = { originAttemptId: "attempt_origin", originMessageId: "msg_origin",
    source: remoteEndpoint, target: localEndpoint,
    deadlineAt: new Date(setup.clock.now().getTime() + 5_000).toISOString(), expectsReply: false, body: "destination copy" };
  // A federated handoff carries no permission record: the configured link plus
  // exact alias addressing to a mirrored source and a live local target is the
  // whole admission decision.
  const admitted = await store.enqueuePeerHandoff("m5dev", handoff);
  assert.equal(admitted.accepted, true); assert.equal(admitted.duplicate, false);
  assert.deepEqual(await store.enqueuePeerHandoff("m5dev", handoff), { accepted: false, duplicate: true,
    messageIdSuffix: admitted.messageIdSuffix });
  assert.equal((JSON.parse(await readFile(store.stateFilePath, "utf8")) as { messages: { body?: string }[] }).messages[0]?.body, "destination copy");
  const renamed = "codex-renamed@m5dev"; await store.reconcilePeerCatalog("m5dev", catalog(2, renamed));
  assert.equal((await store.inspectPrivateRoutes()).find((route) => route.registrationMode === "federated_peer")?.alias, renamed);
  const mirror = (await store.inspectPrivateRoute(renamed))!;
  assert.match(mirror.binding.registrationId, /^reg_[A-Za-z0-9_-]+$/u);
  const authorize = async (body: string, phase: "armed" | "accepted") => {
    const reserved = await store.reserveMessage(local.alias); assert.equal(reserved.status, "reserved");
    if (reserved.status !== "reserved") return;
    const sha256 = createHash("sha256").update(body).digest("hex");
    await store.authorizeMessage({ messageId: reserved.attempt.messageId, attemptId: reserved.attempt.attemptId,
      sourceRegistrationId: mirror.binding.registrationId, targetRegistrationId: local.binding.registrationId,
      prepared: { kind: "codex_turn_start", bodyBytes: Buffer.byteLength(body), bodySha256: sha256,
        frameBytes: Buffer.byteLength(body) + 1, sha256 } });
    if (phase === "accepted") await store.acceptMessage({ messageId: reserved.attempt.messageId,
      attemptId: reserved.attempt.attemptId, lossOutcome: "unconfirmed" });
  };
  await authorize("destination copy", "accepted");
  const renamedEndpoint = { ...remoteEndpoint, alias: renamed };
  const admit = async (id: string, body: string) => store.enqueuePeerHandoff("m5dev", { ...handoff,
    originAttemptId: `attempt_${id}`, originMessageId: `msg_${id}`, source: renamedEndpoint, body });
  await admit("armed", "armed copy"); await authorize("armed copy", "armed");
  await admit("reserved", "reserved copy"); assert.equal((await store.reserveMessage(local.alias)).status, "reserved");
  await admit("queued", "queued copy");
  const removed = await store.reconcilePeerCatalog("m5dev", { ...catalog(4, renamed), routes: [] });
  assert.deepEqual(removed.settlements.map((row) => row.state).sort(),
    ["ambiguous", "cancelled", "cancelled", "unconfirmed"]);
  assert.equal(removed.routes.length, 0);
  await store.close();
  const reopened = new GatewayStore({ ...setup.config, hostId: "studio", allowedHosts: ["studio", "m5dev"] },
    { now: setup.clock.now, randomId: setup.clock.randomId });
  await reopened.initialize(); await reopened.close();

  const ownerSetup = await fixture();
  const ownerStore = new GatewayStore({ ...ownerSetup.config, hostId: "lab", allowedHosts: ["lab", "zdev"] },
    { now: ownerSetup.clock.now, randomId: ownerSetup.clock.randomId });
  await ownerStore.initialize();
  const ownerLocal = { alias: "codex-local@lab", registrationMode: "explicit_opt_in" as const,
    binding: { provider: "codex" as const, hostId: "lab", routeHandle: "thread-owner", registrationId: "reg_owner_local" } };
  const ownerRemote = { alias: "codex-worker@zdev", provider: "codex" as const, host: "zdev", routeRef: "reg_owner_remote" };
  const ownerTarget = { alias: ownerLocal.alias, provider: ownerLocal.binding.provider, host: "lab",
    routeRef: peerRouteRef("lab", ownerLocal.binding.registrationId) };
  await ownerStore.registerRoute(ownerLocal);
  // Alias addressing is the whole permission, so an unmirrored sender is the
  // one thing a configured link cannot supply: the handoff is refused and
  // nothing is journaled.
  await assert.rejects(ownerStore.enqueuePeerHandoff("zdev", { ...handoff, originMessageId: "msg_owner_missing",
    source: ownerRemote, target: ownerTarget }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "ROUTE_UNREGISTERED");
  assert.equal((await ownerStore.publicSnapshot()).messages.length, 0);
  await ownerStore.reconcilePeerCatalog("zdev", { revision: 1, complete: true, truncated: false,
    generatedAt: ownerSetup.clock.now().toISOString(), health: "healthy", connectors: [], routes: [{ ref: ownerRemote.routeRef,
      alias: ownerRemote.alias, provider: ownerRemote.provider, host: ownerRemote.host, enabled: true, state: "idle", queueDepth: 0 }],
    alerts: [] });
  const federated = await ownerStore.enqueuePeerHandoff("zdev", { ...handoff, originMessageId: "msg_owner_admitted",
    source: ownerRemote, target: ownerTarget });
  assert.equal(federated.accepted, true);
  await ownerStore.close();
});
