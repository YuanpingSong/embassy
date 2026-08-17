import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  convertGatewayStateV2ToV3,
  type GatewayStateV2ToV3FaultStage,
} from "../src/gateway/state-v2-to-v3.js";
import { isGatewayPersistedStateV3 } from "../src/gateway/store.js";

const STATE_FILE = "gateway-state.json";
const BACKUP_FILE = "gateway-state.v2.backup.json";
const V3_BACKUP_FILE = "gateway-state.v3.backup.json";
const MARKER_FILE = ".agent-embassy-state";
const LOCK_FILE = ".gateway-controller.lock";
const NOW = "2026-08-17T01:00:00.000Z";
const BODY = "synthetic body";
const temporaryRoots: string[] = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function counters() {
  return {
    accepted: 0, delivered: 0, unconfirmed: 0, failed: 0, ambiguous: 0,
    expired: 0, cancelled: 0, abandoned: 0, rejected: 0, bytesAccepted: 0,
  };
}

function route(
  alias: string,
  provider: "claude" | "codex" | "deepseek" | "grok",
  routeHandle: string,
  ownerLease: string,
  queueDepth: number,
) {
  return {
    alias,
    binding: {
      provider,
      hostId: "this-mac",
      endpointGeneration: `${provider}_generation`,
      routeHandle,
      ownerLease,
    },
    registrationMode: provider === "claude" ? "selected_live_peer" : "explicit_opt_in",
    enabled: true,
    state: "idle",
    busyPolicy: "queue",
    registeredAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    lastSeenAt: "2026-08-16T00:00:00.000Z",
    queueDepth,
    counters: counters(),
  };
}

function queued(
  suffix: string,
  sourceAlias: string,
  targetAlias: string,
  direction: "claude_to_codex" | "codex_to_claude",
  extra: Record<string, unknown> = {},
) {
  const body = String(extra.body ?? BODY);
  return {
    messageId: `msg_00000000-0000-4000-8000-00000000${suffix}`,
    messageIdSuffix: `0000${suffix}`,
    conversationIdSuffix: `conv${suffix}`,
    direction,
    sourceAlias,
    targetAlias,
    enqueuedAt: "2026-08-16T23:00:00.000Z",
    deadlineAt: "2026-08-17T02:00:00.000Z",
    bytes: Buffer.byteLength(body),
    body,
    pair: true,
    ...extra,
  };
}

function v2State() {
  const claudeAlias = "pm@this-mac";
  const codexAlias = "codex-main@this-mac";
  const queue = [queued("0001", claudeAlias, codexAlias, "claude_to_codex")];
  const inFlight = [{
    ...queued("0002", codexAlias, claudeAlias, "codex_to_claude"),
    dispatchedAt: "2026-08-16T23:01:00.000Z",
  }];
  return {
    schemaVersion: 2,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T23:30:00.000Z",
    eventSequence: 2,
    routes: [
      route(claudeAlias, "claude", "claude-session", "lease-claude", 0),
      route(codexAlias, "codex", "codex-thread", "lease-codex", 1),
    ],
    consentEdges: [{
      endpoints: [
        { alias: claudeAlias, provider: "claude", ownerLease: "lease-claude" },
        { alias: codexAlias, provider: "codex", ownerLease: "lease-codex" },
      ],
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      counters: counters(),
    }],
    connectors: [
      {
        provider: "claude", hostId: "this-mac", endpointGeneration: "claude_generation",
        health: "healthy", protocol: "claude-peer", protocolVersion: "1",
        updatedAt: "2026-08-16T23:30:00.000Z",
      },
      {
        provider: "codex", hostId: "this-mac", endpointGeneration: "codex_generation",
        health: "healthy", protocol: "codex-app-server", protocolVersion: "1",
        updatedAt: "2026-08-16T23:30:00.000Z",
      },
    ],
    queue,
    inFlight,
    events: [{
      sequence: 1,
      timestamp: "2026-08-16T23:00:00.000Z",
      messageIdSuffix: "00000001",
      conversationIdSuffix: "conv0001",
      direction: "claude_to_codex",
      sourceAlias: claudeAlias,
      targetAlias: codexAlias,
      state: "queued",
      bytes: Buffer.byteLength(BODY),
      body: BODY,
    }],
    dedupe: [{
      fingerprint: "A".repeat(43),
      messageIdSuffix: "00000001",
      conversationIdSuffix: "conv0001",
      sourceAlias: claudeAlias,
      targetAlias: codexAlias,
      direction: "claude_to_codex",
      pair: true,
      firstSeenAt: "2026-08-16T23:00:00.000Z",
      expiresAt: "2026-08-17T02:00:00.000Z",
    }],
    rateBuckets: [{
      sourceAlias: claudeAlias,
      windowStartedAt: "2026-08-16T23:00:00.000Z",
      count: 1,
    }],
    accounting: {
      accepted: 2, duplicates: 0, delivered: 0, unconfirmed: 0, failed: 0,
      ambiguous: 0, expired: 0, cancelled: 0, abandoned: 0, rejected: 0,
      bytesAccepted: Buffer.byteLength(BODY) * 2,
      queuedBytes: Buffer.byteLength(BODY),
    },
    watchSequence: 1,
    progressWatches: [{
      conversationId: "conv_abcdefghijklmnop",
      ownerAlias: claudeAlias,
      workerAlias: codexAlias,
      ownerLease: "lease-claude",
      workerLease: "lease-codex",
      lastActivityAt: "2026-08-16T23:00:00.000Z",
      idleMs: 60_000,
      nudgeCount: 0,
      nextActionAt: "2026-08-16T23:01:00.000Z",
    }],
    progressWatchEvents: [{
      sequence: 1,
      timestamp: "2026-08-16T23:00:00.000Z",
      conversationId: "conv_abcdefghijklmnop",
      ownerAlias: claudeAlias,
      workerAlias: codexAlias,
      kind: "opened",
      actor: "owner",
    }],
    codexEndpointRefreshSequence: 1,
    codexEndpointRefreshEvents: [{
      sequence: 1,
      timestamp: "2026-08-16T22:00:00.000Z",
      alias: codexAlias,
      hostId: "this-mac",
      threadId: "codex-thread",
      oldEndpointGeneration: "codex_old",
      newEndpointGeneration: "codex_generation",
    }],
    codexOrphanRemovalSequence: 1,
    codexOrphanRemovalEvents: [{
      sequence: 1,
      timestamp: "2026-08-16T22:30:00.000Z",
      alias: "codex-retired@this-mac",
      hostId: "this-mac",
    }],
    codexSuccession: null,
  };
}

async function fixture(state: unknown = v2State()): Promise<{
  root: string;
  source: Buffer;
}> {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "embassy-v2-v3-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  await writeFile(path.join(root, MARKER_FILE), "agent-embassy-state-v1\n", { mode: 0o600 });
  await chmod(path.join(root, MARKER_FILE), 0o600);
  const source = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, STATE_FILE), source, { mode: 0o600 });
  await chmod(path.join(root, STATE_FILE), 0o600);
  return { root, source };
}

function code(error: unknown): string | undefined {
  return error instanceof BridgeError ? error.code : undefined;
}

function successionState() {
  const state = v2State() as any;
  state.queue = [];
  state.inFlight = [];
  state.routes[1].queueDepth = 0;
  state.accounting.queuedBytes = 0;
  const newBinding = {
    provider: "codex",
    hostId: "this-mac",
    endpointGeneration: "codex_generation_next",
    routeHandle: "codex-thread-next",
    ownerLease: "lease-codex-next",
  };
  state.connectors[1] = {
    provider: "codex", hostId: "this-mac", endpointGeneration: "codex_generation_next",
    health: "healthy", protocol: "codex-app-server", protocolVersion: "1",
    updatedAt: "2026-08-16T23:30:00.000Z",
  };
  state.codexSuccession = {
    schemaVersion: 1,
    stage: "prepared",
    old: {
      alias: "codex-main@this-mac", threadId: "codex-thread", hostId: "this-mac",
      generation: "old_generation", binding: { ...state.routes[1].binding },
    },
    new: {
      alias: "codex-next@this-mac", threadId: "codex-thread-next", hostId: "this-mac",
      generation: "new_generation", binding: newBinding,
    },
  };
  return state;
}

function activateSuccession(state: any): void {
  const identity = state.codexSuccession.new;
  state.routes[1].alias = identity.alias;
  state.routes[1].binding = { ...identity.binding };
  state.consentEdges[0].endpoints[1].alias = identity.alias;
  state.consentEdges[0].endpoints[1].ownerLease = identity.binding.ownerLease;
  state.progressWatches[0].workerAlias = identity.alias;
  state.progressWatches[0].workerLease = identity.binding.ownerLease;
  state.dedupe[0].targetAlias = identity.alias;
}

async function assertCorruptBeforeBackup(state: unknown): Promise<void> {
  const { root, source } = await fixture(state);
  await assert.rejects(
    convertGatewayStateV2ToV3({ stateDir: root }),
    (error: unknown) => code(error) === "CORRUPT_GATEWAY_STATE",
  );
  assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  assert.equal(await lstat(path.join(root, BACKUP_FILE)).catch(() => undefined), undefined);
}

test("offline conversion backs up exact v2 bytes and installs strict logical v3 once", async () => {
  const { root, source } = await fixture();
  const result = await convertGatewayStateV2ToV3(
    { stateDir: root },
    { now: () => new Date(NOW), randomId: () => "00000000-0000-4000-8000-000000000099" },
  );
  assert.equal(result.backupFile, BACKUP_FILE);
  assert.deepEqual(await readFile(path.join(root, BACKUP_FILE)), source);
  assert.equal((await lstat(path.join(root, BACKUP_FILE))).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(root, STATE_FILE))).mode & 0o777, 0o600);
  assert.equal(await lstat(path.join(root, LOCK_FILE)).catch(() => undefined), undefined);

  const v3 = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
  assert.equal(v3.schemaVersion, 3);
  assert.deepEqual(v3.commit, { sequence: 0, id: result.commitId });
  assert.equal(v3.routes[0].binding.registrationId, "lease-claude");
  assert.equal("endpointGeneration" in v3.routes[0].binding, false);
  assert.equal("connectors" in v3, false);
  assert.equal("progressWatches" in v3, false);
  assert.equal("codexEndpointRefreshEvents" in v3, false);
  assert.equal("codexOrphanRemovalEvents" in v3, false);
  assert.deepEqual(v3.messages.map((item: any) => item.sequence), [3, 4]);
  assert.equal(v3.messages[0].state.phase, "queued");
  assert.deepEqual(v3.messages[1].state, {
    phase: "terminal",
    outcome: "ambiguous",
    terminalAt: NOW,
    safeErrorCode: "CONTROLLER_RESTARTED",
    latencyMs: 7_200_000,
  });
  assert.deepEqual(v3.activity[0], {
    type: "legacy_message",
    event: v2State().events[0],
  });
  assert.equal(v3.eventSequence, 4);
  assert.equal(v3.accounting.ambiguous, 1);
  assert.equal(v3.routes[0].counters.ambiguous, 1);
  assert.equal(v3.consentEdges[0].counters.ambiguous, 1);

  await assert.rejects(
    convertGatewayStateV2ToV3({ stateDir: root }),
    (error: unknown) => code(error) === "GATEWAY_STATE_CONVERSION_ALREADY_APPLIED",
  );
});

test("host reconciliation mutates installed v3, backs it up, and needs no v2 backup", async () => {
  const state = v2State() as any;
  state.routes = [
    route("dsh-main@this-mac", "deepseek", "deepseek-handle", "lease-deepseek", 0),
    route("grok-main@this-mac", "grok", "grok-handle", "lease-grok", 0),
  ];
  state.connectors = state.routes.map((item: any) => ({ provider: item.binding.provider, hostId: "this-mac",
    endpointGeneration: `${item.binding.provider}_generation`, health: "healthy", protocol: "acp",
    protocolVersion: "1", updatedAt: "2026-08-16T23:30:00.000Z" }));
  state.consentEdges = []; state.queue = []; state.inFlight = []; state.events = [];
  state.dedupe = []; state.rateBuckets = []; state.progressWatches = []; state.progressWatchEvents = [];
  state.codexEndpointRefreshSequence = 0; state.codexEndpointRefreshEvents = [];
  state.codexOrphanRemovalSequence = 0; state.codexOrphanRemovalEvents = [];
  state.eventSequence = 0; state.watchSequence = 0;
  state.accounting = { ...state.accounting, accepted: 0, bytesAccepted: 0, queuedBytes: 0 };
  const { root } = await fixture(state);
  await convertGatewayStateV2ToV3({ stateDir: root });
  await unlink(path.join(root, BACKUP_FILE));
  const accumulated = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
  accumulated.commit = { sequence: 58, id: "accumulated-v3-state" };
  const accumulatedBytes = Buffer.from(`${JSON.stringify(accumulated, null, 2)}\n`);
  await writeFile(path.join(root, STATE_FILE), accumulatedBytes, { mode: 0o600 });

  const result = await convertGatewayStateV2ToV3({ stateDir: root, hostId: "m5dev" });
  const recovered = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
  assert.deepEqual(recovered.routes, []);
  assert.equal(recovered.commit.sequence, 59);
  assert.equal(result.backupFile, V3_BACKUP_FILE);
  assert.deepEqual(await readFile(path.join(root, V3_BACKUP_FILE)), accumulatedBytes);
  assert.equal((await lstat(path.join(root, V3_BACKUP_FILE))).mode & 0o777, 0o600);
  assert.equal(await lstat(path.join(root, BACKUP_FILE)).catch(() => undefined), undefined);
});

test("host reconciliation refuses installed v3 armed references and nonzero route history", async () => {
  const state = v2State() as any;
  state.routes = [
    route("dsh-main@this-mac", "deepseek", "deepseek-handle", "lease-deepseek", 0),
    route("grok-main@this-mac", "grok", "grok-handle", "lease-grok", 0),
  ];
  state.connectors = []; state.consentEdges = []; state.queue = []; state.inFlight = []; state.events = [];
  state.dedupe = []; state.rateBuckets = []; state.progressWatches = []; state.progressWatchEvents = [];
  state.codexEndpointRefreshSequence = 0; state.codexEndpointRefreshEvents = [];
  state.codexOrphanRemovalSequence = 0; state.codexOrphanRemovalEvents = [];
  state.eventSequence = 0; state.watchSequence = 0;
  state.accounting = { ...state.accounting, accepted: 0, bytesAccepted: 0, queuedBytes: 0 };
  const { root } = await fixture(state);
  await convertGatewayStateV2ToV3({ stateDir: root });
  const installed = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
  installed.messages = [{
    sequence: 1, messageId: "msg_00000000-0000-4000-8000-000000000009", messageIdSuffix: "00000009",
    direction: "deepseek_to_grok", sourceAlias: "dsh-main@this-mac", targetAlias: "grok-main@this-mac",
    enqueuedAt: NOW, deadlineAt: "2099-01-01T00:00:00.000Z", bytes: 14, body: "synthetic body",
    sourceRegistrationId: "lease-deepseek", targetRegistrationId: "lease-grok", consentEdge: null,
    state: { phase: "armed", attemptId: "attempt_0000000000000001", attemptCount: 1,
      targetRegistrationId: "lease-grok", sourceRegistrationId: "lease-deepseek", consentEdge: null,
      armedAt: NOW, prepared: { kind: "acp_prompt", bodyBytes: 14,
        bodySha256: "7d05d9f66d59403802e2971f902654f5723c91e90eab4e5722145089dcae1bd7",
        frameBytes: 120, sha256: "c".repeat(64) } },
  }];
  installed.eventSequence = 1;
  const source = Buffer.from(`${JSON.stringify(installed, null, 2)}\n`);
  assert.equal(isGatewayPersistedStateV3(installed), true);
  await writeFile(path.join(root, STATE_FILE), source, { mode: 0o600 });

  await assert.rejects(convertGatewayStateV2ToV3({ stateDir: root, hostId: "m5dev" }),
    (error: unknown) => code(error) === "CORRUPT_GATEWAY_STATE");
  assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  assert.equal(await lstat(path.join(root, V3_BACKUP_FILE)).catch(() => undefined), undefined);

  installed.messages = []; installed.routes[0].counters.delivered = 1; installed.accounting.delivered = 1;
  const counted = Buffer.from(`${JSON.stringify(installed, null, 2)}\n`);
  await writeFile(path.join(root, STATE_FILE), counted, { mode: 0o600 });
  await assert.rejects(convertGatewayStateV2ToV3({ stateDir: root, hostId: "m5dev" }),
    (error: unknown) => code(error) === "CORRUPT_GATEWAY_STATE");
  assert.deepEqual(await readFile(path.join(root, STATE_FILE)), counted);
});

test("host reconciliation refuses owned route identity instead of laundering it", async () => {
  const { root, source } = await fixture();
  await assert.rejects(convertGatewayStateV2ToV3({ stateDir: root, hostId: "m5dev" }),
    (error: unknown) => code(error) === "CORRUPT_GATEWAY_STATE");
  assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  assert.equal(await lstat(path.join(root, BACKUP_FILE)).catch(() => undefined), undefined);
});

test("transient, absent-target, bodyless, and expired queued rows become exact terminal rows", async () => {
  const state = v2State() as any;
  state.queue = [
    queued("0001", "pm@this-mac", "codex-main@this-mac", "claude_to_codex", {
      body: undefined,
    }),
    queued("0003", "codex-main@this-mac", "gone@this-mac", "codex_to_claude", {
      transientTarget: true,
    }),
    queued("0004", "pm@this-mac", "codex-main@this-mac", "claude_to_codex", {
      deadlineAt: "2026-08-16T23:59:00.000Z",
    }),
  ];
  delete state.queue[0].body;
  delete state.queue[1].pair;
  state.routes[1].queueDepth = 2;
  state.accounting.queuedBytes = state.queue.reduce((sum: number, item: any) => sum + item.bytes, 0);
  const { root } = await fixture(state);
  await convertGatewayStateV2ToV3({ stateDir: root }, {
    now: () => new Date(NOW),
  });
  const v3 = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
  assert.deepEqual(v3.messages.map((item: any) => [
    item.targetRegistrationId,
    item.state.phase,
    item.state.outcome,
    item.state.safeErrorCode,
  ]), [
    ["lease-codex", "terminal", "abandoned", "CONTROLLER_RESTARTED"],
    [null, "terminal", "abandoned", "CONTROLLER_RESTARTED"],
    ["lease-codex", "terminal", "expired", "MESSAGE_EXPIRED"],
    ["lease-claude", "terminal", "ambiguous", "CONTROLLER_RESTARTED"],
  ]);
  assert.equal(v3.accounting.queuedBytes, 0);
});

test("active succession and non-strict v2 refuse before backup or target mutation", async () => {
  for (const stage of [
    "prepared", "publication_armed", "published", "activated", "recovery_forbidden",
  ] as const) {
    const active = successionState();
    active.codexSuccession.stage = stage;
    if (stage === "activated") activateSuccession(active);
    if (stage === "recovery_forbidden") {
      active.codexSuccession.safeErrorCode = "SUCCESSION_RECOVERY_FORBIDDEN";
    }
    const { root, source } = await fixture(active);
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }),
      (error: unknown) => code(error) === "GATEWAY_STATE_CONVERSION_SUCCESSION_ACTIVE",
    );
    assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
    assert.equal(await lstat(path.join(root, BACKUP_FILE)).catch(() => undefined), undefined);
  }

  const nonStrict = v2State() as any;
  nonStrict.unexpected = true;
  await assertCorruptBeforeBackup(nonStrict);
  await assertCorruptBeforeBackup({ schemaVersion: 3 });
});

test("strict v2 decoder rejects ingress, protocol, event, and watch drift before backup", async () => {
  const cases: Array<() => any> = [
    ...(["codex", "deepseek", "grok"] as const).map((provider, index) => () => {
      const state = v2State() as any;
      state.routes.push(route(
        `wrong-${provider}@this-mac`, provider, `${provider}-handle`, `lease-${provider}-${index}`, 0,
      ));
      return state;
    }),
    () => { const state = v2State() as any; state.connectors[0].protocol = "Claude-peer"; return state; },
    () => { const state = v2State() as any; state.connectors[0].protocol = "a".repeat(65); return state; },
    () => { const state = v2State() as any; state.connectors[0].protocolVersion = "1/slash"; return state; },
    () => { const state = v2State() as any; state.connectors[0].protocolVersion = "a".repeat(65); return state; },
    () => {
      const state = v2State() as any;
      state.events[0].body = `${BODY}\0`;
      state.events[0].bytes = Buffer.byteLength(state.events[0].body);
      return state;
    },
    () => {
      const state = v2State() as any;
      state.progressWatches[0] = {
        ...state.progressWatches[0],
        createdAt: "2026-08-16T22:00:00.000Z", updatedAt: "2026-08-16T23:00:00.000Z",
        phase: "quiet", nudgeCount: 1, capability: "route", degradedNoticeSent: false,
      };
      return state;
    },
    () => {
      const state = v2State() as any;
      state.progressWatches.push({ ...state.progressWatches[0] });
      return state;
    },
    () => {
      const state = v2State() as any;
      state.progressWatches.push({ ...state.progressWatches[0], conversationId: "conv_qrstuvwxyzabcdef" });
      return state;
    },
    () => {
      const state = v2State() as any;
      state.progressWatches[0].workerLease = "lease-wrong";
      return state;
    },
  ];
  for (const makeState of cases) await assertCorruptBeforeBackup(makeState());
});

test("strict v2 decoder validates the complete active succession graph before its safe refusal", async () => {
  const cases: Array<(state: any) => void> = [
    (state) => { state.connectors.pop(); },
    (state) => {
      state.queue.push(queued("0003", "pm@this-mac", "codex-main@this-mac", "claude_to_codex"));
      state.routes[1].queueDepth = 1;
      state.accounting.queuedBytes = Buffer.byteLength(BODY);
    },
    (state) => { state.codexSuccession.stage = "activated"; },
    (state) => { state.codexSuccession.new.binding.routeHandle = "not-the-thread"; },
  ];
  for (const mutate of cases) {
    const state = successionState();
    mutate(state);
    await assertCorruptBeforeBackup(state);
  }
});

test("an existing controller lock or backup fails closed without target mutation", async () => {
  for (const occupied of [LOCK_FILE, BACKUP_FILE]) {
    const { root, source } = await fixture();
    await writeFile(path.join(root, occupied), "occupied\n", { mode: 0o600 });
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }),
      (error: unknown) => code(error) ===
        (occupied === LOCK_FILE
          ? "GATEWAY_STATE_IN_USE"
          : "GATEWAY_STATE_BACKUP_EXISTS"),
    );
    assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  }
});

const precommitFaults: readonly GatewayStateV2ToV3FaultStage[] = [
  "before_backup_write",
  "before_backup_file_sync",
  "before_backup_directory_sync",
  "before_backup_readback",
  "before_target_write",
  "before_target_file_sync",
  "before_target_rename",
];

for (const stage of precommitFaults) {
  test(`fault at ${stage} preserves the exact v2 target`, async () => {
    const { root, source } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        fault: (candidate) => {
          if (candidate === stage) throw new Error(`fault:${stage}`);
        },
      }),
      new RegExp(`fault:${stage}`),
    );
    assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  });
}

test("backup readback hash mismatch and a changed source both stop before rename", async () => {
  {
    const { root, source } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        fault: async (stage) => {
          if (stage === "before_backup_readback") {
            await writeFile(path.join(root, BACKUP_FILE), "tampered\n", { mode: 0o600 });
          }
        },
      }),
      (error: unknown) => code(error) === "GATEWAY_STATE_BACKUP_MISMATCH",
    );
    assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  }
  {
    const { root } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        fault: async (stage) => {
          if (stage === "before_target_rename") {
            await writeFile(path.join(root, STATE_FILE), "changed\n", { mode: 0o600 });
          }
        },
      }),
      (error: unknown) => code(error) === "GATEWAY_STATE_SOURCE_CHANGED",
    );
    assert.equal(await readFile(path.join(root, STATE_FILE), "utf8"), "changed\n");
  }
});

test("a rename-returned error is reconciled against the exact source and installed commit", async () => {
  {
    const { root } = await fixture();
    const result = await convertGatewayStateV2ToV3({ stateDir: root }, {
      renameState: async (source, target) => {
        await rename(source, target);
        throw new Error("rename-returned-after-install");
      },
    });
    const installed = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
    assert.equal(installed.schemaVersion, 3);
    assert.deepEqual(installed.commit, {
      sequence: result.commitSequence,
      id: result.commitId,
    });
  }
  {
    const { root, source } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        renameState: async () => { throw new Error("rename-preinstall"); },
      }),
      /rename-preinstall/,
    );
    assert.deepEqual(await readFile(path.join(root, STATE_FILE)), source);
  }
  {
    const { root } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        renameState: async (_source, target) => {
          await writeFile(target, "neither source nor installed\n", { mode: 0o600 });
          throw new Error("rename-unknown");
        },
      }),
      (error: unknown) => error instanceof BridgeError &&
        error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN" &&
        error.recoverable === false,
    );
    assert.equal(await readFile(path.join(root, STATE_FILE), "utf8"), "neither source nor installed\n");
  }
});

const postcommitFaults: readonly GatewayStateV2ToV3FaultStage[] = [
  "after_target_rename",
  "before_target_directory_sync",
  "before_target_readback",
];

for (const stage of postcommitFaults) {
  test(`fault at ${stage} retains installed v3 and forbids automatic rollback`, async () => {
    const { root } = await fixture();
    await assert.rejects(
      convertGatewayStateV2ToV3({ stateDir: root }, {
        fault: (candidate) => {
          if (candidate === stage) throw new Error(`fault:${stage}`);
        },
      }),
      (error: unknown) => error instanceof BridgeError &&
        error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN" &&
        error.recoverable === false,
    );
    const installed = JSON.parse(await readFile(path.join(root, STATE_FILE), "utf8")) as any;
    assert.equal(installed.schemaVersion, 3);
    assert.equal((await readFile(path.join(root, BACKUP_FILE), "utf8")).includes('"schemaVersion": 2'), true);
  });
}

test("no-follow and exact ownership modes reject unsafe state evidence", async () => {
  const { root, source } = await fixture();
  const statePath = path.join(root, STATE_FILE);
  await chmod(statePath, 0o640);
  await assert.rejects(
    convertGatewayStateV2ToV3({ stateDir: root }),
    (error: unknown) => code(error) === "UNSAFE_GATEWAY_STATE_DIRECTORY",
  );
  await chmod(statePath, 0o600);
  const realState = path.join(root, "real-state.json");
  await writeFile(realState, source, { mode: 0o600 });
  await writeFile(statePath, source, { mode: 0o600 });
  await unlink(statePath);
  await symlink(realState, statePath);
  await assert.rejects(
    convertGatewayStateV2ToV3({ stateDir: root }),
    (error: unknown) => code(error) === "UNSAFE_GATEWAY_STATE_FILE",
  );
});
