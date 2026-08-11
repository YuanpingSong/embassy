import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../src/errors.js";
import {
  loadGatewayConfig,
  type GatewayConfig,
} from "../src/gateway/config.js";
import {
  GATEWAY_MAX_STATE_FILE_BYTES,
  GatewayStore,
} from "../src/gateway/store.js";
import {
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
} from "../src/gateway/compatibility.js";
import type { ProgressWatch } from "../src/gateway/progress-watch-machine.js";
import type {
  GatewayStoreDependencies,
  PrivateRouteBinding,
  RegisterRouteInput,
} from "../src/gateway/types.js";
import {
  CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY,
  CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY,
  GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  arePublicAvailablePeerSnapshots,
  isPublicAvailablePeerSnapshot,
  projectGatewayPublicSnapshot,
  type GatewayPublicSnapshot,
} from "../src/gateway/types.js";

type Clock = {
  now: () => Date;
  advance: (milliseconds: number) => void;
  randomId: () => string;
};

function clock(): Clock {
  let current = Date.parse("2026-08-07T12:00:00.000Z");
  let sequence = 1;
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    randomId: () =>
      `00000000-0000-4000-8000-${(sequence++).toString(16).padStart(12, "0")}`,
  };
}

function limits(): GatewayConfig["limits"] {
  return {
    maxRoutes: 4,
    maxPairs: 128,
    eventCapacity: 10,
    eventTtlMs: 1_000,
    dedupeCapacity: 10,
    dedupeTtlMs: 500,
    maxQueueMessages: 4,
    maxQueueMessagesPerRoute: 2,
    maxInFlightMessages: 2,
    maxQueueBytes: 1_024,
    maxMessageBytes: 256,
    messageDeadlineMs: 5_000,
    rateLimitPerRoute: 20,
    rateWindowMs: 1_000,
  };
}

async function fixture(
  dependencies: Pick<GatewayStoreDependencies, "afterStateFileRename"> = {},
): Promise<{
  root: string;
  workspace: string;
  stateDir: string;
  config: GatewayConfig;
  clock: Clock;
  store: GatewayStore;
}> {
  const temporary = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporary, "gateway-store-test-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "controller", "gateway");
  await mkdir(workspace, { mode: 0o700 });
  const config: GatewayConfig = {
    stateDir,
    controlSocketPath: path.join(stateDir, "control.sock"),
    allowedHosts: ["this-mac", "build-mac"],
    stallNoticeMs: 2_500,
    steeringEnabled: true,
    inboundMode: "paired",
    limits: limits(),
  };
  const testClock = clock();
  const store = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
    ...dependencies,
  });
  return {
    root,
    workspace,
    stateDir,
    config,
    clock: testClock,
    store,
  };
}

const codexBinding: PrivateRouteBinding = {
  provider: "codex",
  hostId: "this-mac",
  endpointGeneration: "codex-generation-0001",
  routeHandle: "codex-thread-private-0001",
  ownerLease: "codex-owner-lease-0001",
};

const claudeBinding: PrivateRouteBinding = {
  provider: "claude",
  hostId: "this-mac",
  endpointGeneration: "claude-generation-0001",
  routeHandle: "claude-session-private-0001",
  ownerLease: "claude-owner-lease-0001",
};

const successorCodexBinding: PrivateRouteBinding = {
  ...codexBinding,
  routeHandle: "codex-thread-private-0002",
  ownerLease: "codex-owner-lease-0002",
};

const independentCodexBinding: PrivateRouteBinding = {
  ...codexBinding,
  routeHandle: "codex-thread-private-0003",
  ownerLease: "codex-owner-lease-0003",
};

const oldSuccessionIdentity = {
  alias: "codex-old@this-mac",
  threadId: codexBinding.routeHandle,
  hostId: "this-mac",
  generation: "opaque-listener-generation-old",
  binding: codexBinding,
} as const;

const newSuccessionIdentity = {
  alias: "codex-new@this-mac",
  threadId: successorCodexBinding.routeHandle,
  hostId: "this-mac",
  generation: "opaque-listener-generation-new",
  binding: successorCodexBinding,
} as const;

function endpoint(binding: PrivateRouteBinding) {
  return {
    provider: binding.provider,
    hostId: binding.hostId,
    endpointGeneration: binding.endpointGeneration,
  };
}

async function observeAndRegister(store: GatewayStore): Promise<void> {
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  const codex: RegisterRouteInput = {
    alias: "reviewer@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  };
  const claude: RegisterRouteInput = {
    alias: "advisor@this-mac",
    binding: claudeBinding,
    registrationMode: "selected_live_peer",
  };
  await store.registerRoute(codex);
  await store.registerRoute(claude);
  await store.pairRoutes({
    claudeAlias: claude.alias,
    codexAlias: codex.alias,
  });
}

let progressWatchDedupeSequence = 0;

async function armProgressWatch(
  store: GatewayStore,
  input: Readonly<{
    conversationId: string;
    ownerAlias: string;
    workerAlias: string;
    idleMs: number;
  }>,
): Promise<void> {
  progressWatchDedupeSequence += 1;
  const accepted = await store.enqueueMessage({
    sourceAlias: input.ownerAlias,
    targetAlias: input.workerAlias,
    body: "TRACK: test-owned progress watch",
    dedupeKey: `progress-watch-test-${progressWatchDedupeSequence}`,
    progressWatch: {
      conversationId: input.conversationId,
      actorAlias: input.ownerAlias,
      openIdleMs: input.idleMs,
    },
  });
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.messageId);
  assert.equal(await store.cancelQueuedMessage(accepted.messageId), true);
}

async function inspectProgressWatches(
  store: GatewayStore,
): Promise<ProgressWatch[]> {
  return (
    JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
      progressWatches: ProgressWatch[];
    }
  ).progressWatches;
}

function v14ProgressWatch(watch: ProgressWatch): Record<string, unknown> {
  return {
    ...watch,
    createdAt: watch.lastActivityAt,
    updatedAt: watch.lastActivityAt,
    phase: watch.nudgeCount === 0 ? "quiet" : "episode",
    capability: "conversation",
    degradedNoticeSent: false,
  };
}

async function observeAndRegisterCodexOnly(store: GatewayStore): Promise<void> {
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "reviewer@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
}

async function observeAndRegisterSuccessionRoutes(
  store: GatewayStore,
  includeClaude = false,
): Promise<void> {
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  if (includeClaude) {
    await store.observeConnector({
      identity: endpoint(claudeBinding),
      health: "healthy",
      compatibility: "compatible",
      protocol: "claude-peer",
      protocolVersion: "1",
    });
  }
  await store.registerRoute({
    alias: oldSuccessionIdentity.alias,
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  if (includeClaude) {
    await store.registerRoute({
      alias: "advisor@this-mac",
      binding: claudeBinding,
      registrationMode: "selected_live_peer",
    });
    await store.pairRoutes({
      claudeAlias: "advisor@this-mac",
      codexAlias: oldSuccessionIdentity.alias,
    });
  }
}

const exactSuccession = {
  oldGeneration: oldSuccessionIdentity.generation,
  newGeneration: newSuccessionIdentity.generation,
} as const;

const transientClaudePeer = {
  alias: "native-advisor@this-mac",
  binding: {
    ...claudeBinding,
    routeHandle: "00000000-0000-4000-8000-000000000187",
    ownerLease: "native-claude-call-proof-0001",
  },
} as const;

test("gateway configuration is local, bounded, and fail-closed", () => {
  const config = loadGatewayConfig({
    HOME: os.homedir(),
    EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
    EMBASSY_HOSTS: "this-mac,build-mac",
  });
  assert.deepEqual(config.allowedHosts, ["this-mac", "build-mac"]);
  assert.equal(config.controlSocketPath, "/tmp/private-gateway-test/control.sock");
  assert.equal(config.inboundMode, "paired");
  assert.equal(config.steeringEnabled, true);
  assert.equal(config.deliveryNotices, "merged");
  assert.equal(Object.hasOwn(config, "compatibilityPolicy"), false);
  assert.equal(Object.hasOwn(config, "dashboardPort"), false);
  assert.equal(config.limits.messageDeadlineMs, 14_400_000);
  assert.equal(config.stallNoticeMs, 120_000);
  assert.equal(config.limits.maxMessageBytes, 16_384);

  const configuredDeadline = loadGatewayConfig({
    EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
    EMBASSY_MESSAGE_DEADLINE_MS: "1001",
  });
  assert.equal(configuredDeadline.limits.messageDeadlineMs, 1_001);
  assert.equal(configuredDeadline.stallNoticeMs, 500);
  assert.equal(
    loadGatewayConfig({
      EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
      EMBASSY_STEERING_ENABLED: "0",
    }).steeringEnabled,
    false,
  );
  for (const mode of ["merged", "verbose", "quiet"] as const) {
    assert.equal(
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
        EMBASSY_DELIVERY_NOTICES: mode,
      }).deliveryNotices,
      mode,
    );
  }
  for (const legacyValue of ["observed", "strict", "warn"] as const) {
    assert.equal(
      Object.hasOwn(
        loadGatewayConfig({
          EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
          EMBASSY_COMPAT_POLICY: legacyValue,
        }),
        "compatibilityPolicy",
      ),
      false,
    );
  }
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
        EMBASSY_STEERING_ENABLED: "false",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/private-gateway-test",
        EMBASSY_DELIVERY_NOTICES: "silent",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );

  const xdgDefault = loadGatewayConfig({
    XDG_STATE_HOME: "/tmp/synthetic-xdg-state",
  });
  assert.equal(
    xdgDefault.stateDir,
    "/tmp/synthetic-xdg-state/agent-embassy",
  );
  assert.equal(
    xdgDefault.controlSocketPath,
    "/tmp/synthetic-xdg-state/agent-embassy/control.sock",
  );

  const noLegacyFallback = loadGatewayConfig({
    XDG_STATE_HOME: "/tmp/synthetic-xdg-state",
    CLAUDE_BRIDGE_GATEWAY_STATE_DIR: "/tmp/legacy-state-must-be-ignored",
    CLAUDE_BRIDGE_GATEWAY_HOSTS: "legacy-host",
  });
  assert.equal(
    noLegacyFallback.stateDir,
    "/tmp/synthetic-xdg-state/agent-embassy",
  );
  assert.deepEqual(noLegacyFallback.allowedHosts, ["this-mac"]);

  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "relative",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/gateway",
        EMBASSY_HOSTS: "this-mac,Build-Mac",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/gateway",
        EMBASSY_MAX_QUEUE_MESSAGES: "2",
        EMBASSY_MAX_QUEUE_PER_ROUTE: "3",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "relative-parent",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        XDG_STATE_HOME: "relative-xdg",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/gateway",
        EMBASSY_DEDUPE_CAPACITY: "100000",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/gateway",
        EMBASSY_MAX_ROUTES: "257",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadGatewayConfig({
        EMBASSY_STATE_DIR: "/tmp/gateway",
        EMBASSY_EVENT_CAPACITY: "1025",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_GATEWAY_CONFIGURATION",
  );
});

test("gateway state requires a private owned leaf without imposing a workspace gate", async () => {
  const { root, workspace, config, clock: testClock } = await fixture();
  const overlappingConfig = {
    ...config,
    stateDir: path.join(workspace, "gateway"),
    controlSocketPath: path.join(workspace, "gateway", "control.sock"),
  };
  const nestedStore = new GatewayStore(overlappingConfig, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await nestedStore.initialize();
  assert.equal((await lstat(overlappingConfig.stateDir)).mode & 0o777, 0o700);
  await nestedStore.close();

  const publicDirectory = path.join(root, "public");
  await mkdir(publicDirectory, { mode: 0o755 });
  const publicConfig = {
    ...config,
    stateDir: publicDirectory,
    controlSocketPath: path.join(publicDirectory, "control.sock"),
  };
  await assert.rejects(
    new GatewayStore(publicConfig).initialize(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_GATEWAY_STATE_DIRECTORY",
  );

  const realTarget = path.join(root, "real-target");
  const linkedTarget = path.join(root, "linked-target");
  await mkdir(realTarget, { mode: 0o700 });
  await symlink(realTarget, linkedTarget);
  const linkedConfig = {
    ...config,
    stateDir: path.join(linkedTarget, "gateway"),
    controlSocketPath: path.join(linkedTarget, "gateway", "control.sock"),
  };
  await assert.rejects(
    new GatewayStore(linkedConfig).initialize(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_GATEWAY_STATE_DIRECTORY",
  );
});

test("one live gateway exclusively owns its controller state", async () => {
  const { store, config, workspace } = await fixture();
  await store.initialize();
  const second = new GatewayStore(config);
  await assert.rejects(
    second.initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_STATE_IN_USE",
  );
  await store.close();
  await second.initialize();
  await second.close();
});

test("routes require explicit selection and immutable exact generations", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await assert.rejects(
    store.registerRoute({
      alias: "Reviewer@this-mac",
      binding: codexBinding,
      registrationMode: "explicit_opt_in",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_GATEWAY_ALIAS",
  );
  await assert.rejects(
    store.registerRoute({
      alias: "reviewer@this-mac",
      binding: codexBinding,
      registrationMode: "selected_live_peer",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_OPT_IN_REQUIRED",
  );
  await store.registerRoute({
    alias: "reviewer@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  await assert.rejects(
    store.registerRoute({
      alias: "reviewer@this-mac",
      binding: {
        ...codexBinding,
        endpointGeneration: "codex-generation-0002",
      },
      registrationMode: "explicit_opt_in",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_ENDPOINT_NOT_OBSERVED",
  );
  await assert.rejects(
    store.registerRoute({
      alias: "socket@this-mac",
      binding: {
        ...codexBinding,
        routeHandle: "/tmp/private.sock",
      },
      registrationMode: "explicit_opt_in",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PRIVATE_ROUTE_IDENTITY",
  );
  await store.close();
});

test("route registry has a configured durable capacity", async () => {
  const { store, workspace, config } = await fixture();
  config.limits.maxRoutes = 2;
  await store.initialize();
  await observeAndRegister(store);
  await assert.rejects(
    store.registerRoute({
      alias: "builder@this-mac",
      binding: {
        ...codexBinding,
        routeHandle: "codex-thread-private-0002",
        ownerLease: "codex-owner-lease-0002",
      },
      registrationMode: "explicit_opt_in",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_CAPACITY_REACHED",
  );
  await store.close();
});

test("permission graph admission and unpair teardown are exact to one edge", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const secondCodexBinding: PrivateRouteBinding = {
    ...codexBinding,
    routeHandle: "codex-thread-private-0002",
    ownerLease: "codex-owner-lease-0002",
  };
  const secondClaudeBinding: PrivateRouteBinding = {
    ...claudeBinding,
    routeHandle: "claude-session-private-0002",
    ownerLease: "claude-owner-lease-0002",
  };
  await store.registerRoute({
    alias: "writer@this-mac",
    binding: secondCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.registerRoute({
    alias: "critic@this-mac",
    binding: secondClaudeBinding,
    registrationMode: "selected_live_peer",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "writer@this-mac",
  });
  await store.pairRoutes({
    claudeAlias: "critic@this-mac",
    codexAlias: "reviewer@this-mac",
  });
  assert.deepEqual(await store.inspectPairs(), [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "reviewer@this-mac",
    },
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "writer@this-mac",
    },
    {
      claudeAlias: "critic@this-mac",
      codexAlias: "reviewer@this-mac",
    },
  ]);
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "critic@this-mac",
      targetAlias: "writer@this-mac",
      body: "must not cross an absent edge",
      dedupeKey: "absent-edge",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "SENDER_NOT_PAIRED",
  );
  const first = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "first edge in flight",
    dedupeKey: "first-edge",
  });
  const adjacent = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "writer@this-mac",
    body: "adjacent edge remains queued",
    dedupeKey: "adjacent-edge",
  });
  assert.equal(first.accepted, true);
  assert.equal(adjacent.accepted, true);
  const dispatched = await store.dequeueMessage("reviewer@this-mac");
  assert.equal(dispatched?.messageId, first.messageId);
  const result = await store.unpairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "reviewer@this-mac",
    inFlightSettlements: [
      {
        messageId: first.messageId ?? "",
        state: "cancelled",
        safeErrorCode: "PAIR_REMOVED",
      },
    ],
  });
  assert.deepEqual(result.settlements, [
    {
      messageId: first.messageId,
      state: "cancelled",
      safeErrorCode: "PAIR_REMOVED",
    },
  ]);
  assert.equal(result.claudeRouteUnreferenced, false);
  assert.equal(
    await store.hasPair({
      claudeAlias: "advisor@this-mac",
      codexAlias: "reviewer@this-mac",
    }),
    false,
  );
  const remaining = await store.dequeueMessage("writer@this-mac");
  assert.equal(remaining?.messageId, adjacent.messageId);
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.pairs.length, 2);
  assert.equal(snapshot.accounting.rejected, 1);
  assert.equal(snapshot.accounting.cancelled, 1);
  assert.equal(JSON.stringify(snapshot).includes("owner-lease"), false);
  await store.close();
});

test("permission graph capacity is configured and fail-closed", async () => {
  const { store, config } = await fixture();
  config.limits.maxPairs = 1;
  await store.initialize();
  await observeAndRegister(store);
  assert.equal((await store.inspectPairs()).length, 1);
  const secondCodexBinding: PrivateRouteBinding = {
    ...codexBinding,
    routeHandle: "codex-thread-private-capacity",
    ownerLease: "codex-owner-lease-capacity",
  };
  await store.registerRoute({
    alias: "writer@this-mac",
    binding: secondCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await assert.rejects(
    store.pairRoutes({
      claudeAlias: "advisor@this-mac",
      codexAlias: "writer@this-mac",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "PAIR_CAPACITY_REACHED",
  );
  await store.close();
});

test("unpair removes only edge-owned work and preserves open-mode ingress", async () => {
  const { store, config } = await fixture();
  config.inboundMode = "open";
  await store.initialize();
  await observeAndRegister(store);
  await store.unpairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "reviewer@this-mac",
  });

  const openIngress = await store.enqueueNativeIngress({
    source: {
      alias: "advisor@this-mac",
      binding: claudeBinding,
    },
    targetAlias: "reviewer@this-mac",
    body: "open authority survives an unrelated edge lifecycle",
    dedupeKey: "open-before-edge",
  });
  assert.equal(openIngress.accepted, true);
  assert.equal(openIngress.pair, undefined);

  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "reviewer@this-mac",
  });
  const removed = await store.unpairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "reviewer@this-mac",
  });
  assert.deepEqual(removed.settlements, []);
  assert.equal(
    (await store.dequeueMessage("reviewer@this-mac"))?.messageId,
    openIngress.messageId,
  );
  await store.close();
});

test("progress watches persist exact edge authority and advance completion-ended episodes", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_abcdefghijklmnop",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  assert.equal((await inspectProgressWatches(store))[0]?.nudgeCount, 0);
  const publicOpened = await store.publicSnapshot();
  assert.deepEqual(publicOpened.progressWatches, [
    {
      conversationIdSuffix: "ijklmnop",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      lastActivityAt: testClock.now().toISOString(),
      nextActionAt: new Date(testClock.now().getTime() + 60_000).toISOString(),
      nudgeCount: 0,
    },
  ]);
  assert.equal(JSON.stringify(publicOpened).includes("conv_abcdefghijklmnop"), false);
  assert.deepEqual(
    (
      JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
        progressWatchEvents: Array<{ kind: string }>;
      }
    ).progressWatchEvents.map((event) => event.kind),
    ["opened"],
  );

  testClock.advance(60_000);
  const due = await store.advanceDueProgressWatches();
  assert.deepEqual(due, [
    {
      conversationId: "conv_abcdefghijklmnop",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      nudgeNumber: 1,
    },
  ]);
  assert.equal((await inspectProgressWatches(store))[0]?.nudgeCount, 0);
  assert.equal(
    (
      await store.enqueueMessage({
        sourceAlias: "reviewer@this-mac",
        targetAlias: "advisor@this-mac",
        body: "[Embassy automated liveness check]",
        dedupeKey: "watch-nudge-1",
        progressWatchNudge: {
          conversationId: "conv_abcdefghijklmnop",
          nudgeNumber: 1,
        },
      })
    ).accepted,
    true,
  );
  assert.equal((await inspectProgressWatches(store))[0]?.nudgeCount, 1);
  assert.equal(
    (
      await store.enqueueMessage({
        sourceAlias: "advisor@this-mac",
        targetAlias: "reviewer@this-mac",
        body: "DONE: worker completion",
        dedupeKey: "watch-worker-complete",
        progressWatch: {
      conversationId: "conv_abcdefghijklmnop",
      actorAlias: "advisor@this-mac",
          completionSignal: true,
        },
      })
    ).accepted,
    true,
  );
  assert.deepEqual(await inspectProgressWatches(store), []);

  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    progressWatchEvents: Array<{ kind: string; conversationId: string }>;
  };
  assert.deepEqual(persisted.progressWatchEvents, [
    {
      sequence: 2,
      timestamp: "2026-08-07T12:01:00.000Z",
      conversationId: "conv_abcdefghijklmnop",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "worker",
      reason: "done",
    },
  ]);
  assert.equal(
    JSON.stringify(await store.publicSnapshot()).includes(
      "conv_abcdefghijklmnop",
    ),
    false,
  );
  assert.deepEqual(
    (await store.publicSnapshot()).progressWatchEvents?.map((event) => event.kind),
    ["settled"],
  );
  await store.close();
});

test("owner and worker completion retain distinct terminal history", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  for (const [conversationId, actorAlias, sourceAlias, targetAlias] of [
    [
      "conv_worker_done_history",
      "advisor@this-mac",
      "advisor@this-mac",
      "reviewer@this-mac",
    ],
    [
      "conv_owner_done_history1",
      "reviewer@this-mac",
      "reviewer@this-mac",
      "advisor@this-mac",
    ],
  ] as const) {
    await armProgressWatch(store, {
      conversationId,
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      idleMs: 60_000,
    });
    const completion = await store.enqueueMessage({
      sourceAlias,
      targetAlias,
      body: "DONE: terminal actor history",
      dedupeKey: `completion-history-${conversationId}`,
      progressWatch: {
        conversationId,
        actorAlias,
        completionSignal: true,
      },
    });
    assert.equal(completion.accepted, true);
  }

  assert.deepEqual(
    (await store.publicSnapshot()).progressWatchEvents?.map(
      (event) => ({
        kind: event.kind,
        actor: event.actor,
        reason: event.reason,
      }),
    ),
    [
      { kind: "opened", actor: "owner", reason: undefined },
      { kind: "settled", actor: "worker", reason: "done" },
      { kind: "opened", actor: "owner", reason: undefined },
      { kind: "settled", actor: "owner", reason: "done" },
    ],
  );
  await store.close();
});

test("one exact live pair has one watch and a new conversation replaces it atomically", async () => {
  const { store, config } = await fixture();
  config.limits.maxWatches = 1;
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_watchsingular0001",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      body: "TRACK: worker cannot change the original options",
      dedupeKey: "reject-worker-watch-options",
      progressWatch: {
        conversationId: "conv_watchsingular0001",
        actorAlias: "advisor@this-mac",
        openIdleMs: 120_000,
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "PROGRESS_WATCH_OWNER_REQUIRED" &&
      error.message ===
        "Tracking options persist from the original TRACK; a repeated TRACK from the exact owner refreshes activity without changing them.",
  );
  await assert.rejects(
    store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
      body: "counterparty cannot replace the active pair watch",
      dedupeKey: "reject-counterparty-watch-replacement",
    progressWatch: {
      conversationId: "conv_watchsingular0002",
      actorAlias: "advisor@this-mac",
      openIdleMs: 120_000,
    },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "PROGRESS_WATCH_REPLACEMENT_OWNER_REQUIRED" &&
      error.message.includes("untrack"),
  );
  assert.deepEqual(
    (await inspectProgressWatches(store)).map((watch) => watch.conversationId),
    ["conv_watchsingular0001"],
  );
  assert.deepEqual(
    (
      JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
        progressWatchEvents: Array<{ kind: string }>;
      }
    ).progressWatchEvents.map((event) => event.kind),
    ["opened"],
  );

  await armProgressWatch(store, {
    conversationId: "conv_watchsingular0002",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 120_000,
  });
  assert.deepEqual(
    (await inspectProgressWatches(store)).map((watch) => ({
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      idleMs: watch.idleMs,
    })),
    [
      {
        conversationId: "conv_watchsingular0002",
        ownerAlias: "reviewer@this-mac",
        idleMs: 120_000,
      },
    ],
  );
  await armProgressWatch(store, {
    conversationId: "conv_watchsingular0002",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 120_000,
  });
  let persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    progressWatchEvents: Array<{
      conversationId: string;
      kind: string;
    }>;
  };
  assert.deepEqual(
    persisted.progressWatchEvents.map(({ conversationId, kind }) => ({
      conversationId,
      kind,
    })),
    [
      { conversationId: "conv_watchsingular0001", kind: "opened" },
      { conversationId: "conv_watchsingular0001", kind: "replaced" },
    ],
  );
  await store.registerRoute({
    alias: "other-reviewer@this-mac",
    binding: independentCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "other-reviewer@this-mac",
  });
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "advisor@this-mac",
      targetAlias: "other-reviewer@this-mac",
      body: "do not retarget an existing conversation watch",
      dedupeKey: "retarget-pair-watch",
      progressWatch: {
        conversationId: "conv_watchsingular0002",
        actorAlias: "advisor@this-mac",
        openIdleMs: 60_000,
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "PROGRESS_WATCH_OWNERSHIP_MISMATCH",
  );
  assert.deepEqual(
    (await inspectProgressWatches(store)).map(
      (watch) => watch.conversationId,
    ),
    ["conv_watchsingular0002"],
  );

  await store.unpairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "reviewer@this-mac",
  });
  assert.deepEqual(await inspectProgressWatches(store), []);
  persisted = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    progressWatchEvents: Array<{
      conversationId: string;
      kind: string;
    }>;
  };
  assert.deepEqual(persisted.progressWatchEvents.at(-1), {
    sequence: 3,
    timestamp: "2026-08-07T12:00:00.000Z",
    conversationId: "conv_watchsingular0002",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    kind: "settled",
    actor: "operator",
    reason: "pair_removed",
  });
  await store.close();
});

test("a retained Claude selection rename keeps its exact watch and immutable history", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_selection_rename1",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  const replacementBinding: PrivateRouteBinding = {
    ...claudeBinding,
    endpointGeneration: "claude-generation-0002",
  };
  await store.markConnectorOffline(
    endpoint(claudeBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  await store.observeConnector({
    identity: endpoint(replacementBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  await store.replaceClaudeSelection({
    replacement: {
      alias: "renamed-advisor@this-mac",
      binding: replacementBinding,
      registrationMode: "selected_live_peer",
    },
  });

  assert.deepEqual(
    (await inspectProgressWatches(store)).map((watch) => ({
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      workerLease: watch.workerLease,
    })),
    [
      {
        ownerAlias: "reviewer@this-mac",
        workerAlias: "renamed-advisor@this-mac",
        workerLease: claudeBinding.ownerLease,
      },
    ],
  );
  assert.deepEqual(await store.inspectPairs(), [
    {
      claudeAlias: "renamed-advisor@this-mac",
      codexAlias: "reviewer@this-mac",
    },
  ]);
  assert.deepEqual(
    (await store.publicSnapshot()).progressWatchEvents?.at(-1),
    {
      sequence: 1,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationIdSuffix: "_rename1",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "opened",
      actor: "owner",
    },
  );
  await store.close();
});

test("a progress watch cannot arm while its durable pair is unobserved", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await store.close();

  const recovered = new GatewayStore(config, { now: testClock.now });
  await recovered.initialize();
  await assert.rejects(
    armProgressWatch(recovered, {
      conversationId: "conv_unobservedwatch1",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      idleMs: 60_000,
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );
  assert.deepEqual(await inspectProgressWatches(recovered), []);
  await recovered.close();
});

test("a malformed legacy duplicate cannot be laundered by migration", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_legacywatchold01",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    progressWatches: Array<Record<string, unknown>>;
  };
  const oldWatch = legacy.progressWatches[0]!;
  legacy.progressWatches.push({
    ...oldWatch,
    conversationId: "conv_legacywatchnew01",
    createdAt: "2026-08-07T12:00:00.001Z",
    updatedAt: "2026-08-07T12:00:00.001Z",
    lastActivityAt: "2026-08-07T12:00:00.001Z",
    nextActionAt: "2026-08-07T12:01:00.001Z",
  });
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });
  testClock.advance(2);

  const durable = `${JSON.stringify(legacy)}\n`;
  await writeFile(store.stateFilePath, durable, { mode: 0o600 });
  await assert.rejects(
    new GatewayStore(config, { now: testClock.now }).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
  assert.equal(await readFile(store.stateFilePath, "utf8"), durable);
});

test("the removed pre-v1.4 worker flag remains corrupt", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_legacyworker_done",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    progressWatches: Array<Record<string, unknown>>;
  };
  legacy.progressWatches[0]!.workerReportedCompleteAt =
    "2026-08-07T12:00:00.001Z";
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });
  testClock.advance(2);

  await assert.rejects(
    new GatewayStore(config, { now: testClock.now }).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("v1.4 migration rebases an exhausted journal and settles live watches once", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_restartsequence_max",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    watchSequence: number;
    progressWatches: ProgressWatch[];
    progressWatchEvents: unknown[];
  };
  const watch = legacy.progressWatches[0]!;
  legacy.watchSequence = Number.MAX_SAFE_INTEGER;
  legacy.progressWatches = [
    v14ProgressWatch(watch) as unknown as ProgressWatch,
  ];
  legacy.progressWatchEvents = [
    ...Array.from({ length: 6 }, (_, index) => ({
      sequence: Number.MAX_SAFE_INTEGER - 10 + index,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "activity",
    })),
    {
      sequence: Number.MAX_SAFE_INTEGER - 4,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "opened",
    },
    {
      sequence: Number.MAX_SAFE_INTEGER - 3,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "activity",
    },
    {
      sequence: Number.MAX_SAFE_INTEGER - 2,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "done",
    },
    {
      sequence: Number.MAX_SAFE_INTEGER - 1,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "worker_reported_complete",
    },
    {
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: watch.lastActivityAt,
      conversationId: watch.conversationId,
      ownerAlias: watch.ownerAlias,
      workerAlias: watch.workerAlias,
      kind: "replaced",
    },
  ];
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const reducedCapacityConfig = {
    ...config,
    limits: { ...config.limits, eventCapacity: 10 },
  };
  const recovered = new GatewayStore(reducedCapacityConfig, {
    now: testClock.now,
  });
  await recovered.initialize();
  assert.deepEqual(await inspectProgressWatches(recovered), []);
  const migrated = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    watchSequence: number;
    progressWatchEvents: unknown[];
  };
  assert.equal(migrated.watchSequence, 5);
  assert.deepEqual(migrated.progressWatchEvents, [
    {
      sequence: 1,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationId: "conv_restartsequence_max",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "opened",
      actor: "owner",
    },
    {
      sequence: 2,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationId: "conv_restartsequence_max",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "unknown",
      reason: "legacy_done",
    },
    {
      sequence: 3,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationId: "conv_restartsequence_max",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "worker",
      reason: "done",
    },
    {
      sequence: 4,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationId: "conv_restartsequence_max",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "replaced",
      actor: "unknown",
    },
    {
      sequence: 5,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationId: "conv_restartsequence_max",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "gateway",
      reason: "legacy_upgrade",
    },
  ]);
  await recovered.close();

  const loadedAgain = new GatewayStore(reducedCapacityConfig, {
    now: testClock.now,
  });
  await loadedAgain.initialize();
  assert.deepEqual(
    (JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
      progressWatchEvents: unknown[];
    }).progressWatchEvents,
    migrated.progressWatchEvents,
  );
  await loadedAgain.close();
});

test("v1.4 migration keeps every live-watch settlement above a lower configured history depth", async () => {
  const { store, config, clock: testClock } = await fixture();
  config.limits.maxRoutes = 24;
  config.limits.maxWatches = 12;
  config.limits.eventCapacity = 32;
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });

  const conversations: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const suffix = index.toString().padStart(2, "0");
    const ownerAlias = `reviewer-${suffix}@this-mac`;
    const workerAlias = `advisor-${suffix}@this-mac`;
    const conversationId = `conv_capacity_watch_${suffix}`;
    conversations.push(conversationId);
    await store.registerRoute({
      alias: ownerAlias,
      binding: {
        ...codexBinding,
        routeHandle: `codex-thread-private-${suffix}`,
        ownerLease: `codex-owner-lease-${suffix}`,
      },
      registrationMode: "explicit_opt_in",
    });
    await store.registerRoute({
      alias: workerAlias,
      binding: {
        ...claudeBinding,
        routeHandle: `claude-session-private-${suffix}`,
        ownerLease: `claude-owner-lease-${suffix}`,
      },
      registrationMode: "selected_live_peer",
    });
    await store.pairRoutes({
      claudeAlias: workerAlias,
      codexAlias: ownerAlias,
    });
    await armProgressWatch(store, {
      conversationId,
      ownerAlias,
      workerAlias,
      idleMs: 60_000,
    });
  }
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    watchSequence: number;
    progressWatches: ProgressWatch[];
    progressWatchEvents: unknown[];
  };
  legacy.progressWatches = legacy.progressWatches.map(
    (watch) => v14ProgressWatch(watch) as unknown as ProgressWatch,
  );
  legacy.progressWatchEvents = legacy.progressWatches.map((watch, index) => ({
    sequence: index + 1,
    timestamp: watch.lastActivityAt,
    conversationId: watch.conversationId,
    ownerAlias: watch.ownerAlias,
    workerAlias: watch.workerAlias,
    kind: "opened",
  }));
  legacy.watchSequence = legacy.progressWatchEvents.length;
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const reducedCapacityConfig = {
    ...config,
    limits: { ...config.limits, eventCapacity: 10 },
  };
  const recovered = new GatewayStore(reducedCapacityConfig, {
    now: testClock.now,
  });
  await recovered.initialize();
  const migrated = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    watchSequence: number;
    progressWatchEvents: Array<{
      sequence: number;
      conversationId: string;
      kind: string;
      actor: string;
      reason?: string;
    }>;
  };
  assert.equal(migrated.watchSequence, 24);
  assert.deepEqual(
    migrated.progressWatchEvents.slice(0, 12).map(
      ({ sequence, conversationId, kind, actor }) => ({
        sequence,
        conversationId,
        kind,
        actor,
      }),
    ),
    conversations.map((conversationId, index) => ({
      sequence: index + 1,
      conversationId,
      kind: "opened",
      actor: "owner",
    })),
  );
  assert.deepEqual(
    migrated.progressWatchEvents.slice(12).map(
      ({ sequence, conversationId, kind, actor, reason }) => ({
        sequence,
        conversationId,
        kind,
        actor,
        reason,
      }),
    ),
    conversations.map((conversationId, index) => ({
      sequence: index + 13,
      conversationId,
      kind: "settled",
      actor: "gateway",
      reason: "legacy_upgrade",
    })),
  );
  await recovered.close();

  const loadedAgain = new GatewayStore(reducedCapacityConfig, {
    now: testClock.now,
  });
  await loadedAgain.initialize();
  assert.deepEqual(
    (
      JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
        progressWatchEvents: unknown[];
      }
    ).progressWatchEvents,
    migrated.progressWatchEvents,
  );
  await loadedAgain.close();
});

test("a v1.4 watch without its exact pair cannot be laundered by migration", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_orphanedwatch001",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.close();

  const corrupt = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { pairs: unknown[]; progressWatches: ProgressWatch[] };
  corrupt.progressWatches = corrupt.progressWatches.map(
    (watch) => v14ProgressWatch(watch) as unknown as ProgressWatch,
  );
  corrupt.pairs = [];
  await writeFile(store.stateFilePath, `${JSON.stringify(corrupt)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    new GatewayStore(config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("malformed v1.4 journal vocabulary cannot be laundered by migration", async () => {
  for (const corruptTransition of [
    { kind: "invented_transition" },
    { kind: "opened", nudgeNumber: 1 },
  ] as const) {
    const { store, config } = await fixture();
    await store.initialize();
    await observeAndRegister(store);
    await armProgressWatch(store, {
      conversationId: "conv_malformedjournal1",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      idleMs: 60_000,
    });
    await store.close();

    const corrupt = JSON.parse(
      await readFile(store.stateFilePath, "utf8"),
    ) as {
      progressWatches: ProgressWatch[];
      progressWatchEvents: unknown[];
    };
    const watch = corrupt.progressWatches[0]!;
    corrupt.progressWatches = [
      v14ProgressWatch(watch) as unknown as ProgressWatch,
    ];
    corrupt.progressWatchEvents = [
      {
        sequence: 1,
        timestamp: watch.lastActivityAt,
        conversationId: watch.conversationId,
        ownerAlias: watch.ownerAlias,
        workerAlias: watch.workerAlias,
        ...corruptTransition,
      },
    ];
    const durable = `${JSON.stringify(corrupt)}\n`;
    await writeFile(store.stateFilePath, durable, { mode: 0o600 });

    await assert.rejects(
      new GatewayStore(config).initialize(),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
    );
    assert.equal(await readFile(store.stateFilePath, "utf8"), durable);
  }
});

test("the single watch-journal guard rejects a whole close batch atomically", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_exhaustedwatch01",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.registerRoute({
    alias: "other-reviewer@this-mac",
    binding: independentCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "other-reviewer@this-mac",
  });
  await armProgressWatch(store, {
    conversationId: "conv_exhaustedwatch02",
    ownerAlias: "other-reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  await store.close();

  const exhausted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { watchSequence: number };
  exhausted.watchSequence = Number.MAX_SAFE_INTEGER - 1;
  await writeFile(store.stateFilePath, `${JSON.stringify(exhausted)}\n`, {
    mode: 0o600,
  });

  const recovered = new GatewayStore(config, { now: testClock.now });
  await recovered.initialize();
  await assert.rejects(
    recovered.unregisterRoute(
      "advisor@this-mac",
      claudeBinding.ownerLease,
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "PROGRESS_WATCH_SEQUENCE_EXHAUSTED",
  );
  assert.deepEqual(
    (await inspectProgressWatches(recovered)).map(
      (watch) => watch.conversationId,
    ),
    ["conv_exhaustedwatch01", "conv_exhaustedwatch02"],
  );
  assert.deepEqual(await recovered.inspectPairs(), [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "other-reviewer@this-mac",
    },
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "reviewer@this-mac",
    },
  ]);
  assert.ok(await recovered.inspectPrivateRoute("advisor@this-mac"));
  await recovered.close();
});

test("restart preserves an exact dispatch watch until tracking is disabled", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await store.registerRoute({
    alias: "other-reviewer@this-mac",
    binding: independentCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "other-reviewer@this-mac",
  });
  await armProgressWatch(store, {
    conversationId: "conv_pre_restart_watch",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  const before = await inspectProgressWatches(store);
  await store.close();

  const recovered = new GatewayStore(config, { now: testClock.now });
  await recovered.initialize();
  assert.deepEqual(await inspectProgressWatches(recovered), before);
  assert.deepEqual(
    await recovered.resolveProgressWatchDispatch({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      conversationId: "conv_pre_restart_watch",
    }),
    { conversationId: "conv_pre_restart_watch", markerActive: true },
  );
  assert.deepEqual(
    await recovered.resolveProgressWatchDispatch({
      sourceAlias: "advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      conversationId: "conv_pre_restart_watch",
    }),
    { conversationId: "conv_pre_restart_watch", markerActive: false },
  );
  assert.deepEqual(
    await recovered.resolveProgressWatchDispatch({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      recoveredConversationIdSuffix: "rt_watch",
    }),
    { conversationId: "conv_pre_restart_watch", markerActive: true },
  );
  assert.deepEqual(
    await recovered.resolveProgressWatchDispatch({
      sourceAlias: "advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      recoveredConversationIdSuffix: "rt_watch",
    }),
    { conversationId: "conv_pre_restart_watch", markerActive: false },
  );
  for (const lookup of [
    {
      sourceAlias: "other-reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      recoveredConversationIdSuffix: "rt_watch",
    },
    {
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      recoveredConversationIdSuffix: "notwatch",
    },
  ] as const) {
    assert.deepEqual(await recovered.resolveProgressWatchDispatch(lookup), {
      markerActive: false,
    });
  }

  await recovered.close();
  config.trackingEnabled = false;
  const disabled = new GatewayStore(config, { now: testClock.now });
  await disabled.initialize();
  assert.deepEqual(await inspectProgressWatches(disabled), []);
  assert.deepEqual(
    (await disabled.publicSnapshot()).progressWatchEvents?.at(-1),
    {
      sequence: 2,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationIdSuffix: "rt_watch",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "gateway",
      reason: "tracking_disabled",
    },
  );
  await disabled.close();
});

test("explicit untrack closes once with operator attribution", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_operator_untrack1",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });

  assert.equal(await store.endProgressWatch("conv_operator_untrack1"), true);
  assert.equal(await store.endProgressWatch("conv_operator_untrack1"), false);
  assert.deepEqual(await inspectProgressWatches(store), []);
  assert.deepEqual(
    (await store.publicSnapshot()).progressWatchEvents?.at(-1),
    {
      sequence: 2,
      timestamp: "2026-08-07T12:00:00.000Z",
      conversationIdSuffix: "untrack1",
      ownerAlias: "reviewer@this-mac",
      workerAlias: "advisor@this-mac",
      kind: "settled",
      actor: "operator",
      reason: "untracked",
    },
  );
  await store.close();
});

test("stale nudge work cannot shorten a freshly reset idle window", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await armProgressWatch(store, {
    conversationId: "conv_stale_nudge_work",
    ownerAlias: "reviewer@this-mac",
    workerAlias: "advisor@this-mac",
    idleMs: 60_000,
  });
  testClock.advance(60_000);
  const [staleAction] = await store.advanceDueProgressWatches();
  assert.equal(staleAction?.nudgeNumber, 1);
  assert.equal(
    await store.touchProgressWatchesForAlias("advisor@this-mac"),
    1,
  );
  const resetNextActionAt = new Date(
    testClock.now().getTime() + 60_000,
  ).toISOString();
  assert.equal(
    (await inspectProgressWatches(store))[0]?.nextActionAt,
    resetNextActionAt,
  );

  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      body: "stale controller nudge",
      dedupeKey: "stale-controller-nudge",
      progressWatchNudge: {
        conversationId: "conv_stale_nudge_work",
        nudgeNumber: 1,
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "PROGRESS_WATCH_NUDGE_NOT_DUE",
  );
  assert.equal(
    await store.deferProgressWatchNudge("conv_stale_nudge_work", 1),
    false,
  );
  assert.equal(
    (await inspectProgressWatches(store))[0]?.nextActionAt,
    resetNextActionAt,
  );
  await store.close();
});

test("Codex succession journals and atomically activates one exact new route", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegisterSuccessionRoutes(store);

  await store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  let authority = await store.inspectCodexSuccessionRecoveryAuthority();
  assert.equal(authority.authority, "old");
  assert.equal(
    authority.authority === "old" ? authority.journal.stage : undefined,
    "prepared",
  );

  await store.armCodexSuccessionPublication(exactSuccession);
  authority = await store.inspectCodexSuccessionRecoveryAuthority();
  assert.equal(authority.authority, "new");
  assert.equal(
    authority.authority === "new" ? authority.journal.stage : undefined,
    "publication_armed",
  );
  await store.markCodexSuccessionPublished(exactSuccession);
  await store.activateCodexSuccession({ ...exactSuccession, state: "idle" });

  const snapshot = await store.publicSnapshot();
  const codexRoutes = snapshot.routes.filter(
    (route) => route.provider === "codex",
  );
  assert.deepEqual(
    codexRoutes.map((route) => ({
      alias: route.alias,
      state: route.state,
      counters: route.counters,
    })),
    [
      {
        alias: newSuccessionIdentity.alias,
        state: "idle",
        counters: {
          accepted: 0,
          delivered: 0,
          unconfirmed: 0,
          failed: 0,
          ambiguous: 0,
          expired: 0,
          cancelled: 0,
          abandoned: 0,
          rejected: 0,
          bytesAccepted: 0,
        },
      },
    ],
  );
  assert.deepEqual(
    await store.resolveRoute(newSuccessionIdentity.alias),
    successorCodexBinding,
  );
  await assert.rejects(
    store.resolveRoute(oldSuccessionIdentity.alias),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );

  const publicBody = JSON.stringify(snapshot);
  for (const privateValue of [
    oldSuccessionIdentity.threadId,
    oldSuccessionIdentity.generation,
    oldSuccessionIdentity.binding.ownerLease,
    newSuccessionIdentity.threadId,
    newSuccessionIdentity.generation,
    newSuccessionIdentity.binding.ownerLease,
    "codexSuccession",
  ]) {
    assert.equal(publicBody.includes(privateValue), false);
  }

  await store.completeCodexSuccession(exactSuccession);
  assert.deepEqual(await store.inspectCodexSuccessionRecoveryAuthority(), {
    authority: "none",
  });
  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(persisted.codexSuccession, null);
  assert.equal(JSON.stringify(persisted).includes("/tmp/"), false);
  await store.close();
});

test("Codex succession preserves global accounting and history while resetting route-local state", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegisterSuccessionRoutes(store, true);
  const accepted = await store.enqueueMessage({
    sourceAlias: oldSuccessionIdentity.alias,
    targetAlias: "advisor@this-mac",
    body: "settled before succession",
    dedupeKey: "succession-settled-history",
  });
  assert.ok(accepted.messageId);
  await store.cancelQueuedMessage(accepted.messageId);
  const before = await store.publicSnapshot();
  const oldCounters = before.routes.find(
    (route) => route.alias === oldSuccessionIdentity.alias,
  )?.counters;
  assert.equal(oldCounters?.accepted, 1);
  assert.equal(before.accounting.accepted, 1);
  assert.equal(before.accounting.cancelled, 1);

  await store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  await store.armCodexSuccessionPublication(exactSuccession);
  await store.markCodexSuccessionPublished(exactSuccession);
  await store.activateCodexSuccession({ ...exactSuccession, state: "idle" });

  const after = await store.publicSnapshot();
  assert.deepEqual(after.accounting, before.accounting);
  assert.deepEqual(after.messages, before.messages);
  const newCounters = after.routes.find(
    (route) => route.alias === newSuccessionIdentity.alias,
  )?.counters;
  assert.ok(newCounters);
  assert.ok(Object.values(newCounters).every((value) => value === 0));
  assert.equal(
    after.messages.some(
      (event) => event.sourceAlias === oldSuccessionIdentity.alias,
    ),
    true,
  );
  await store.close();
});

test("Codex succession rejects a nonempty ledger and every stale owner or stage", async () => {
  const first = await fixture();
  await first.store.initialize();
  await observeAndRegisterSuccessionRoutes(first.store, true);
  await first.store.enqueueMessage({
    sourceAlias: oldSuccessionIdentity.alias,
    targetAlias: "advisor@this-mac",
    body: "blocks succession",
    dedupeKey: "succession-ledger-block",
  });
  await assert.rejects(
    first.store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: newSuccessionIdentity,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_LEDGER_NOT_EMPTY",
  );
  assert.equal(
    (await first.store.publicSnapshot()).routes.some(
      (route) => route.alias === oldSuccessionIdentity.alias,
    ),
    true,
  );
  await first.store.dequeueMessage("advisor@this-mac");
  await assert.rejects(
    first.store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: newSuccessionIdentity,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_LEDGER_NOT_EMPTY",
  );
  await first.store.close();

  const second = await fixture();
  await second.store.initialize();
  await observeAndRegisterSuccessionRoutes(second.store);
  await assert.rejects(
    second.store.prepareCodexSuccession({
      old: {
        ...oldSuccessionIdentity,
        binding: {
          ...oldSuccessionIdentity.binding,
          ownerLease: "wrong-old-owner-lease",
        },
      },
      new: newSuccessionIdentity,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_OWNER_MISMATCH",
  );
  await assert.rejects(
    second.store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: {
        ...newSuccessionIdentity,
        binding: {
          ...newSuccessionIdentity.binding,
          endpointGeneration: "unobserved-codex-endpoint-generation",
        },
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_ENDPOINT_NOT_OBSERVED",
  );
  await assert.rejects(
    second.store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: {
        ...newSuccessionIdentity,
        generation: "invalid.generation",
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_CODEX_SUCCESSION",
  );
  await assert.rejects(
    second.store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: {
        ...newSuccessionIdentity,
        binding: {
          ...newSuccessionIdentity.binding,
          ownerLease: oldSuccessionIdentity.binding.ownerLease,
        },
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_CODEX_SUCCESSION",
  );
  await second.store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  await assert.rejects(
    second.store.markCodexSuccessionPublished(exactSuccession),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_OWNER_MISMATCH",
  );
  await assert.rejects(
    second.store.armCodexSuccessionPublication({
      ...exactSuccession,
      newGeneration: "stale-new-generation",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_OWNER_MISMATCH",
  );
  await assert.rejects(
    second.store.armCodexSuccessionPublication({
      ...exactSuccession,
      newGeneration: "invalid.generation",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_CODEX_SUCCESSION",
  );
  await second.store.clearCodexSuccession(exactSuccession);
  assert.deepEqual(
    (await second.store.inspectPrivateCodexRoutes()).map((route) => route.alias),
    [oldSuccessionIdentity.alias],
  );
  await second.store.close();

  const third = await fixture();
  await third.store.initialize();
  await observeAndRegisterSuccessionRoutes(third.store);
  await third.store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  await third.store.armCodexSuccessionPublication(exactSuccession);
  await assert.rejects(
    third.store.clearCodexSuccession(exactSuccession),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_PUBLICATION_PROOF_REQUIRED",
  );
  await third.store.clearCodexSuccession({
    ...exactSuccession,
    publicationAbsenceConfirmed: true,
  });
  assert.deepEqual(
    await third.store.inspectCodexSuccessionRecoveryAuthority(),
    { authority: "none" },
  );
  assert.deepEqual(
    (await third.store.inspectPrivateCodexRoutes()).map((route) => route.alias),
    [oldSuccessionIdentity.alias],
  );
  await third.store.close();

  const fourth = await fixture();
  await fourth.store.initialize();
  await observeAndRegisterSuccessionRoutes(fourth.store);
  await fourth.store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  await fourth.store.armCodexSuccessionPublication(exactSuccession);
  await fourth.store.markCodexSuccessionPublished(exactSuccession);
  await assert.rejects(
    fourth.store.clearCodexSuccession({
      ...exactSuccession,
      publicationAbsenceConfirmed: true,
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_SUCCESSION_OWNER_MISMATCH",
  );
  await fourth.store.markConnectorOffline(
    endpoint(codexBinding),
    "SUCCESSION_ENDPOINT_OFFLINE",
  );
  await assert.rejects(
    fourth.store.activateCodexSuccession({
      ...exactSuccession,
      state: "idle",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_ENDPOINT_NOT_OBSERVED",
  );
  assert.deepEqual(
    (await fourth.store.inspectPrivateCodexRoutes()).map((route) => route.alias),
    [oldSuccessionIdentity.alias],
  );
  await fourth.store.close();
});

test("every durable succession stage has explicit restart authority", async () => {
  const stages = [
    "prepared",
    "publication_armed",
    "published",
    "activated",
    "recovery_forbidden",
  ] as const;

  for (const stage of stages) {
    const { store, config, clock: testClock } = await fixture();
    await store.initialize();
    await observeAndRegisterSuccessionRoutes(store);
    await store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: newSuccessionIdentity,
    });
    if (stage !== "prepared") {
      await store.armCodexSuccessionPublication(exactSuccession);
    }
    if (stage === "published" || stage === "activated") {
      await store.markCodexSuccessionPublished(exactSuccession);
    }
    if (stage === "activated") {
      await store.activateCodexSuccession({
        ...exactSuccession,
        state: "idle",
      });
    }
    if (stage === "recovery_forbidden") {
      await store.forbidCodexSuccessionRecovery({
        ...exactSuccession,
        safeErrorCode: "SUCCESSION_TEST_RECOVERY_FORBIDDEN",
      });
    }
    await store.close();

    const recovered = new GatewayStore(config, {
      now: testClock.now,
      randomId: testClock.randomId,
    });
    await recovered.initialize();
    const authority =
      await recovered.inspectCodexSuccessionRecoveryAuthority();
    const routes = await recovered.inspectPrivateCodexRoutes();
    if (stage === "prepared") {
      assert.equal(authority.authority, "old", stage);
      assert.equal(
        authority.authority === "old" ? authority.journal.stage : undefined,
        "prepared",
        stage,
      );
      assert.equal(routes[0]?.alias, oldSuccessionIdentity.alias, stage);
      assert.deepEqual(routes[0]?.binding, codexBinding, stage);
      await recovered.clearCodexSuccession(exactSuccession);
    } else {
      assert.equal(authority.authority, "new", stage);
      assert.equal(
        authority.authority === "new" ? authority.journal.stage : undefined,
        "recovery_forbidden",
        stage,
      );
      assert.equal(
        authority.authority === "new"
          ? authority.journal.safeErrorCode
          : undefined,
        "CODEX_SUCCESSION_RESTART_RECOVERY_REQUIRED",
        stage,
      );
      assert.equal(routes[0]?.alias, newSuccessionIdentity.alias, stage);
      assert.deepEqual(routes[0]?.binding, successorCodexBinding, stage);
      assert.equal(routes[0]?.state, "stale", stage);
      await recovered.completeCodexSuccession(exactSuccession);
    }
    assert.deepEqual(
      await recovered.inspectCodexSuccessionRecoveryAuthority(),
      { authority: "none" },
      stage,
    );
    await recovered.close();
  }
});

test("post-rename persistence failures never roll succession authority back in memory", async () => {
  const scenarios = [
    {
      name: "prepare successor",
      setup: async (_store: GatewayStore) => {},
      commit: async (store: GatewayStore) => {
        await store.prepareCodexSuccession({
          old: oldSuccessionIdentity,
          new: newSuccessionIdentity,
        });
      },
      immediateStage: "prepared",
      immediateAlias: oldSuccessionIdentity.alias,
      restartStage: "prepared",
      restartAlias: oldSuccessionIdentity.alias,
    },
    {
      name: "arm publication",
      setup: async (store: GatewayStore) => {
        await store.prepareCodexSuccession({
          old: oldSuccessionIdentity,
          new: newSuccessionIdentity,
        });
      },
      commit: async (store: GatewayStore) => {
        await store.armCodexSuccessionPublication(exactSuccession);
      },
      immediateStage: "publication_armed",
      immediateAlias: oldSuccessionIdentity.alias,
      restartStage: "recovery_forbidden",
      restartAlias: newSuccessionIdentity.alias,
    },
    {
      name: "activate successor",
      setup: async (store: GatewayStore) => {
        await store.prepareCodexSuccession({
          old: oldSuccessionIdentity,
          new: newSuccessionIdentity,
        });
        await store.armCodexSuccessionPublication(exactSuccession);
        await store.markCodexSuccessionPublished(exactSuccession);
      },
      commit: async (store: GatewayStore) => {
        await store.activateCodexSuccession({
          ...exactSuccession,
          state: "idle",
        });
      },
      immediateStage: "activated",
      immediateAlias: newSuccessionIdentity.alias,
      restartStage: "recovery_forbidden",
      restartAlias: newSuccessionIdentity.alias,
    },
    {
      name: "complete successor",
      setup: async (store: GatewayStore) => {
        await store.prepareCodexSuccession({
          old: oldSuccessionIdentity,
          new: newSuccessionIdentity,
        });
        await store.armCodexSuccessionPublication(exactSuccession);
        await store.markCodexSuccessionPublished(exactSuccession);
        await store.activateCodexSuccession({
          ...exactSuccession,
          state: "idle",
        });
      },
      commit: async (store: GatewayStore) => {
        await store.completeCodexSuccession(exactSuccession);
      },
      immediateStage: null,
      immediateAlias: newSuccessionIdentity.alias,
      restartStage: null,
      restartAlias: newSuccessionIdentity.alias,
    },
  ] as const;

  for (const scenario of scenarios) {
    let failNextRename = false;
    const { store, config, clock: testClock } = await fixture({
      afterStateFileRename: () => {
        if (!failNextRename) return;
        failNextRename = false;
        throw new Error(`synthetic post-rename failure: ${scenario.name}`);
      },
    });
    await store.initialize();
    await observeAndRegisterSuccessionRoutes(store);
    await scenario.setup(store);

    failNextRename = true;
    await assert.rejects(
      scenario.commit(store),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN" &&
        error.recoverable === false,
      scenario.name,
    );

    // These are read-only observations made before any second mutation.
    const memoryAuthority =
      await store.inspectCodexSuccessionRecoveryAuthority();
    const memoryStage =
      memoryAuthority.authority === "none"
        ? null
        : memoryAuthority.journal.stage;
    const memoryRoutes = await store.inspectPrivateCodexRoutes();
    const disk = JSON.parse(
      await readFile(store.stateFilePath, "utf8"),
    ) as {
      codexSuccession: null | { stage: string };
      routes: Array<{ alias: string; binding: { provider: string } }>;
    };
    const diskCodexAliases = disk.routes
      .filter((route) => route.binding.provider === "codex")
      .map((route) => route.alias);
    assert.equal(memoryStage, scenario.immediateStage, scenario.name);
    assert.equal(
      disk.codexSuccession?.stage ?? null,
      scenario.immediateStage,
      scenario.name,
    );
    assert.deepEqual(
      memoryRoutes.map((route) => route.alias),
      [scenario.immediateAlias],
      scenario.name,
    );
    assert.deepEqual(diskCodexAliases, [scenario.immediateAlias], scenario.name);

    await store.close();
    const recovered = new GatewayStore(config, {
      now: testClock.now,
      randomId: testClock.randomId,
    });
    await recovered.initialize();
    const recoveredAuthority =
      await recovered.inspectCodexSuccessionRecoveryAuthority();
    const recoveredStage =
      recoveredAuthority.authority === "none"
        ? null
        : recoveredAuthority.journal.stage;
    const recoveredRoutes = await recovered.inspectPrivateCodexRoutes();
    const recoveredDisk = JSON.parse(
      await readFile(recovered.stateFilePath, "utf8"),
    ) as {
      codexSuccession: null | { stage: string };
      routes: Array<{ alias: string; binding: { provider: string } }>;
    };
    assert.equal(recoveredStage, scenario.restartStage, scenario.name);
    assert.equal(
      recoveredDisk.codexSuccession?.stage ?? null,
      scenario.restartStage,
      scenario.name,
    );
    assert.deepEqual(
      recoveredRoutes.map((route) => route.alias),
      [scenario.restartAlias],
      scenario.name,
    );
    assert.deepEqual(
      recoveredDisk.routes
        .filter((route) => route.binding.provider === "codex")
        .map((route) => route.alias),
      [scenario.restartAlias],
      scenario.name,
    );
    await recovered.close();
  }
});

test("Codex succession barrier inspection is bounded and metadata-only", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegisterSuccessionRoutes(store, true);
  assert.deepEqual(await store.inspectCodexSuccessionBarrier(oldSuccessionIdentity.alias), {
    codexRouteCount: 1,
    queueCount: 0,
    inFlightCount: 0,
    transientBodyCount: 0,
    codexQueueDepth: 0,
    clean: true,
  });

  const body = "SUCCESSION_BARRIER_PRIVATE_BODY";
  const accepted = await store.enqueueMessage({
    sourceAlias: oldSuccessionIdentity.alias,
    targetAlias: "advisor@this-mac",
    body,
    dedupeKey: "succession-barrier-private-dedupe",
  });
  assert.ok(accepted.messageId);
  const blocked = await store.inspectCodexSuccessionBarrier(oldSuccessionIdentity.alias);
  assert.deepEqual(blocked, {
    codexRouteCount: 1,
    queueCount: 1,
    inFlightCount: 0,
    transientBodyCount: 1,
    codexQueueDepth: 0,
    clean: false,
  });
  const projection = JSON.stringify(blocked);
  assert.equal(projection.includes(body), false);
  assert.equal(projection.includes(accepted.messageId), false);
  assert.equal(projection.includes(oldSuccessionIdentity.threadId), false);
  assert.ok(blocked.queueCount <= limits().maxQueueMessages);
  assert.ok(blocked.inFlightCount <= limits().maxInFlightMessages);

  await store.dequeueMessage("advisor@this-mac");
  assert.deepEqual(await store.inspectCodexSuccessionBarrier(oldSuccessionIdentity.alias), {
    codexRouteCount: 1,
    queueCount: 0,
    inFlightCount: 1,
    transientBodyCount: 0,
    codexQueueDepth: 0,
    clean: false,
  });
  await store.close();
});

test("Codex succession is route-scoped and preserves unrelated queued work", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegisterSuccessionRoutes(store, true);
  await store.registerRoute({
    alias: "codex-independent@this-mac",
    binding: independentCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "codex-independent@this-mac",
  });
  const unrelated = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "codex-independent@this-mac",
    body: "unrelated queued body",
    dedupeKey: "unrelated-during-succession",
  });

  assert.equal(
    (await store.inspectCodexSuccessionBarrier(oldSuccessionIdentity.alias))
      .clean,
    true,
  );
  await store.prepareCodexSuccession({
    old: oldSuccessionIdentity,
    new: newSuccessionIdentity,
  });
  await store.armCodexSuccessionPublication(exactSuccession);
  await store.markCodexSuccessionPublished(exactSuccession);
  await store.activateCodexSuccession({ ...exactSuccession, state: "idle" });
  await store.completeCodexSuccession(exactSuccession);

  assert.equal(
    (await store.dequeueMessage("codex-independent@this-mac"))?.messageId,
    unrelated.messageId,
  );
  const aliases = (await store.publicSnapshot()).routes.map(
    (route) => route.alias,
  );
  assert.equal(aliases.includes(newSuccessionIdentity.alias), true);
  assert.equal(aliases.includes("codex-independent@this-mac"), true);
  await store.close();
});

test("persistence retains bounded bodies but not dedupe keys or public native IDs", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const body = "BODY_SENTINEL_4e6d_do_not_persist";
  const dedupeKey = "RAW_PROVIDER_MESSAGE_ID_SENTINEL_198a";
  const result = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body,
    dedupeKey,
  });
  assert.equal(result.accepted, true);
  const persisted = await readFile(store.stateFilePath, "utf8");
  assert.equal(persisted.includes(body), true);
  assert.equal(persisted.includes(dedupeKey), false);
  assert.equal(persisted.includes(codexBinding.routeHandle), true);
  assert.equal((await lstat(store.stateFilePath)).mode & 0o077, 0);

  const snapshot = await store.publicSnapshot();
  assert.deepEqual(snapshot.availablePeers, []);
  const publicBody = JSON.stringify(snapshot);
  for (const secret of [
    codexBinding.routeHandle,
    codexBinding.ownerLease,
    codexBinding.endpointGeneration,
    claudeBinding.routeHandle,
    claudeBinding.ownerLease,
    claudeBinding.endpointGeneration,
    dedupeKey,
  ]) {
    assert.equal(publicBody.includes(secret), false);
  }
  assert.equal(publicBody.includes(body), true);
  assert.equal(snapshot.messages.at(-1)?.body, body);
  assert.match(snapshot.messages.at(-1)?.messageIdSuffix ?? "", /^[0-9a-f]{8}$/);
  await store.close();
});

test("native Claude ingress queues for an explicit Codex route without registering the peer", async () => {
  const { store, workspace, config } = await fixture();
  config.inboundMode = "open";
  config.limits.rateLimitPerRoute = 1;
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  const accepted = await store.enqueueNativeIngress({
    source: transientClaudePeer,
    targetAlias: "reviewer@this-mac",
    body: "native ingress body",
    dedupeKey: "native-ingress-provider-message-1",
  });
  const duplicate = await store.enqueueNativeIngress({
    source: transientClaudePeer,
    targetAlias: "reviewer@this-mac",
    body: "duplicate body is ignored",
    dedupeKey: "native-ingress-provider-message-1",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.messageIdSuffix, accepted.messageIdSuffix);
  await assert.rejects(
    store.enqueueNativeIngress({
      source: transientClaudePeer,
      targetAlias: "reviewer@this-mac",
      body: "rate limited native ingress",
      dedupeKey: "native-ingress-provider-message-2",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_RATE_LIMITED",
  );

  const beforeDispatch = await store.publicSnapshot();
  assert.deepEqual(
    beforeDispatch.routes.map((route) => route.alias),
    ["reviewer@this-mac"],
  );
  assert.equal(beforeDispatch.routes[0]?.provider, "codex");
  assert.equal(beforeDispatch.routes[0]?.queueDepth, 1);
  assert.equal(beforeDispatch.accounting.accepted, 1);
  assert.equal(beforeDispatch.accounting.duplicates, 1);
  assert.equal(beforeDispatch.accounting.rejected, 1);
  assert.deepEqual(
    beforeDispatch.messages.slice(-2).map((event) => ({
      direction: event.direction,
      sourceAlias: event.sourceAlias,
      targetAlias: event.targetAlias,
      state: event.state,
    })),
    [
      {
        direction: "claude_to_codex",
        sourceAlias: "native-advisor@this-mac",
        targetAlias: "reviewer@this-mac",
        state: "queued",
      },
      {
        direction: "claude_to_codex",
        sourceAlias: "native-advisor@this-mac",
        targetAlias: "reviewer@this-mac",
        state: "duplicate",
      },
    ],
  );

  const persisted = await readFile(store.stateFilePath, "utf8");
  const exposed = JSON.stringify(beforeDispatch);
  for (const privateValue of [
    transientClaudePeer.binding.routeHandle,
    transientClaudePeer.binding.ownerLease,
  ]) {
    assert.equal(persisted.includes(privateValue), false);
    assert.equal(exposed.includes(privateValue), false);
  }

  const dispatch = await store.dequeueMessage("reviewer@this-mac");
  assert.equal(dispatch?.body, "native ingress body");
  assert.equal(dispatch?.direction, "claude_to_codex");
  assert.ok(accepted.messageId);
  await store.settleMessage({
    messageId: accepted.messageId,
    state: "delivered",
  });
  const settled = await store.publicSnapshot();
  assert.equal(settled.accounting.delivered, 1);
  assert.equal(settled.routes[0]?.counters.delivered, 1);
  await store.unregisterRoute(
    "reviewer@this-mac",
    codexBinding.ownerLease,
  );
  assert.deepEqual((await store.publicSnapshot()).routes, []);
  await store.close();
});

test("paired native ingress accepts only the exact selected Claude binding", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  const input = {
    source: transientClaudePeer,
    targetAlias: "reviewer@this-mac",
    body: "PAIRING_PRIVATE_BODY",
    dedupeKey: "paired-native-ingress",
  } as const;
  await assert.rejects(
    store.enqueueNativeIngress(input),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "SENDER_NOT_PAIRED",
  );

  await store.registerRoute({
    alias: transientClaudePeer.alias,
    binding: transientClaudePeer.binding,
    registrationMode: "selected_live_peer",
  });
  await store.pairRoutes({
    claudeAlias: transientClaudePeer.alias,
    codexAlias: "reviewer@this-mac",
  });
  const otherPeer = {
    alias: "other-advisor@this-mac",
    binding: {
      ...transientClaudePeer.binding,
      routeHandle: "00000000-0000-4000-8000-000000000288",
      ownerLease: "native-claude-call-proof-0002",
    },
  } as const;
  await assert.rejects(
    store.enqueueNativeIngress({
      ...input,
      source: otherPeer,
      dedupeKey: "unpaired-native-ingress",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "SENDER_NOT_PAIRED",
  );

  const accepted = await store.enqueueNativeIngress(input);
  assert.equal(accepted.accepted, true);
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.inboundMode, "paired");
  assert.equal(snapshot.accounting.accepted, 1);
  assert.equal(snapshot.accounting.rejected, 2);
  assert.equal(snapshot.routes.find((route) => route.provider === "codex")?.queueDepth, 1);
  assert.deepEqual(
    snapshot.messages
      .filter((event) => event.safeErrorCode === "SENDER_NOT_PAIRED")
      .map((event) => ({
        state: event.state,
        sourceAlias: event.sourceAlias,
        targetAlias: event.targetAlias,
        safeErrorCode: event.safeErrorCode,
      })),
    [
      {
        state: "rejected",
        sourceAlias: transientClaudePeer.alias,
        targetAlias: "reviewer@this-mac",
        safeErrorCode: "SENDER_NOT_PAIRED",
      },
      {
        state: "rejected",
        sourceAlias: otherPeer.alias,
        targetAlias: "reviewer@this-mac",
        safeErrorCode: "SENDER_NOT_PAIRED",
      },
    ],
  );
  const exposed = JSON.stringify(snapshot);
  assert.equal(exposed.includes("PAIRING_PRIVATE_BODY"), true);
  assert.equal(exposed.includes(otherPeer.binding.routeHandle), false);
  await store.close();
});

test("queued steers retain three newest per edge and expose an exact journal marker", async () => {
  const { store, config } = await fixture();
  config.inboundMode = "open";
  config.limits.maxQueueMessages = 6;
  config.limits.maxQueueMessagesPerRoute = 6;
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  await store.enqueueNativeIngress({
    source: transientClaudePeer,
    targetAlias: "reviewer@this-mac",
    body: "ordinary message stays ahead in the normal queue",
    dedupeKey: "ordinary-before-steers",
  });
  const steers = [];
  for (let index = 1; index <= 4; index += 1) {
    steers.push(
      await store.enqueueNativeIngress({
        source: transientClaudePeer,
        targetAlias: "reviewer@this-mac",
        body: `STEER: instruction ${index}`,
        dedupeKey: `steer-${index}`,
        steer: true,
      }),
    );
  }

  assert.equal(steers[0]?.supersededSettlement, undefined);
  assert.deepEqual(steers[3]?.supersededSettlement, {
    messageId: steers[0]?.messageId,
    state: "cancelled",
    safeErrorCode: "STEER_QUEUE_SUPERSEDED",
  });
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.routes[0]?.queueDepth, 4);
  assert.equal(snapshot.accounting.cancelled, 1);
  const superseded = snapshot.messages.find(
    (event) => event.safeErrorCode === "STEER_QUEUE_SUPERSEDED",
  );
  assert.equal(superseded?.steer, true);
  assert.equal(superseded?.state, "cancelled");
  assert.equal(
    snapshot.messages.filter(
      (event) => event.state === "queued" && event.steer === true,
    ).length,
    4,
  );

  const firstSteer = await store.dequeueMessage(
    "reviewer@this-mac",
    "steer_only",
  );
  assert.equal(firstSteer?.messageId, steers[1]?.messageId);
  assert.equal(firstSteer?.body, "STEER: instruction 2");
  assert.equal(firstSteer?.steer, true);
  assert.equal(firstSteer?.queuedAhead, 1);
  await store.settleMessage({
    messageId: firstSteer?.messageId ?? "",
    state: "delivered",
  });
  const ordinary = await store.dequeueMessage("reviewer@this-mac");
  assert.equal(ordinary?.body, "ordinary message stays ahead in the normal queue");
  assert.equal(ordinary?.steer, undefined);
  assert.equal(ordinary?.queuedAhead, undefined);
  await store.close();
});

test("adjacent edges have independent steer caps and attributable counters", async () => {
  const { store, config } = await fixture();
  config.limits.maxQueueMessages = 8;
  config.limits.maxQueueMessagesPerRoute = 8;
  config.limits.maxQueueBytes = 2_048;
  await store.initialize();
  await observeAndRegister(store);
  const secondClaudeBinding: PrivateRouteBinding = {
    ...claudeBinding,
    routeHandle: "claude-session-private-steer-0002",
    ownerLease: "claude-owner-lease-steer-0002",
  };
  await store.registerRoute({
    alias: "critic@this-mac",
    binding: secondClaudeBinding,
    registrationMode: "selected_live_peer",
  });
  await store.pairRoutes({
    claudeAlias: "critic@this-mac",
    codexAlias: "reviewer@this-mac",
  });

  const firstEdge = [];
  const secondEdge = [];
  for (let index = 1; index <= 3; index += 1) {
    firstEdge.push(
      await store.enqueueMessage({
        sourceAlias: "advisor@this-mac",
        targetAlias: "reviewer@this-mac",
        body: `STEER: first edge ${index}`,
        dedupeKey: `first-edge-steer-${index}`,
        steer: true,
      }),
    );
    secondEdge.push(
      await store.enqueueMessage({
        sourceAlias: "critic@this-mac",
        targetAlias: "reviewer@this-mac",
        body: `STEER: second edge ${index}`,
        dedupeKey: `second-edge-steer-${index}`,
        steer: true,
      }),
    );
  }
  const fourthFirstEdge = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "STEER: first edge 4",
    dedupeKey: "first-edge-steer-4",
    steer: true,
  });

  assert.deepEqual(fourthFirstEdge.supersededSettlement, {
    messageId: firstEdge[0]?.messageId,
    state: "cancelled",
    safeErrorCode: "STEER_QUEUE_SUPERSEDED",
  });
  assert.equal(secondEdge.every((result) => result.accepted), true);
  const snapshot = await store.publicSnapshot();
  const firstCounters = snapshot.pairs.find(
    (pair) => pair.claudeAlias === "advisor@this-mac",
  )?.counters;
  const secondCounters = snapshot.pairs.find(
    (pair) => pair.claudeAlias === "critic@this-mac",
  )?.counters;
  assert.equal(firstCounters?.accepted, 4);
  assert.equal(firstCounters?.cancelled, 1);
  assert.equal(secondCounters?.accepted, 3);
  assert.equal(secondCounters?.cancelled, 0);
  assert.equal(
    snapshot.routes.find((route) => route.alias === "reviewer@this-mac")
      ?.queueDepth,
    6,
  );
  await store.close();
});

test("a rejected fourth steer does not displace an already accepted body", async () => {
  const { store, config } = await fixture();
  config.inboundMode = "open";
  config.limits.maxQueueMessages = 6;
  config.limits.maxQueueMessagesPerRoute = 6;
  config.limits.maxQueueBytes = 100;
  config.limits.maxMessageBytes = 100;
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  const accepted = [];
  for (let index = 1; index <= 3; index += 1) {
    accepted.push(
      await store.enqueueNativeIngress({
        source: transientClaudePeer,
        targetAlias: "reviewer@this-mac",
        body: `STEER: keep ${index}`,
        dedupeKey: `keep-steer-${index}`,
        steer: true,
      }),
    );
  }
  await assert.rejects(
    store.enqueueNativeIngress({
      source: transientClaudePeer,
      targetAlias: "reviewer@this-mac",
      body: `STEER: ${"x".repeat(73)}`,
      dedupeKey: "oversized-steer-replacement",
      steer: true,
    }),
    (error) => error instanceof BridgeError && error.code === "GATEWAY_QUEUE_FULL",
  );

  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.routes[0]?.queueDepth, 3);
  assert.equal(snapshot.accounting.cancelled, 0);
  assert.equal(
    snapshot.messages.some(
      (event) => event.safeErrorCode === "STEER_QUEUE_SUPERSEDED",
    ),
    false,
  );
  const first = await store.dequeueMessage("reviewer@this-mac", "steer_only");
  assert.equal(first?.messageId, accepted[0]?.messageId);
  assert.equal(first?.body, "STEER: keep 1");
  await store.close();
});

test("a correlated native reply retains transient-target queue semantics and no route authority", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "reviewer@this-mac",
      targetAlias: transientClaudePeer.alias,
      body: "generic routing must still require a registered target",
      dedupeKey: "generic-native-target-is-not-authority",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );

  const reply = await store.enqueueNativeReply({
    sourceAlias: "reviewer@this-mac",
    target: transientClaudePeer,
    body: "correlated native reply",
    dedupeKey: "native-reply-1",
  });
  assert.ok(reply.messageId);
  const firstDispatch = await store.dequeueMessage(transientClaudePeer.alias);
  assert.equal(firstDispatch?.body, "correlated native reply");
  assert.equal(firstDispatch?.direction, "codex_to_claude");
  assert.deepEqual(
    await store.requeueInFlightMessage(
      reply.messageId,
      firstDispatch?.body ?? "",
    ),
    { status: "requeued" },
  );
  const retry = await store.dequeueMessage(transientClaudePeer.alias);
  assert.equal(retry?.messageId, reply.messageId);
  await store.settleMessage({ messageId: reply.messageId, state: "delivered" });

  const cancelled = await store.enqueueNativeReply({
    sourceAlias: "reviewer@this-mac",
    target: transientClaudePeer,
    body: "cancel this transient reply",
    dedupeKey: "native-reply-2",
  });
  assert.ok(cancelled.messageId);
  assert.equal(await store.cancelQueuedMessage(cancelled.messageId), true);

  const snapshot = await store.publicSnapshot();
  assert.deepEqual(snapshot.routes.map((route) => route.alias), [
    "reviewer@this-mac",
  ]);
  assert.equal(snapshot.accounting.accepted, 2);
  assert.equal(snapshot.accounting.delivered, 1);
  assert.equal(snapshot.accounting.cancelled, 1);
  assert.equal(snapshot.routes[0]?.counters.accepted, 2);
  assert.equal(snapshot.routes[0]?.counters.delivered, 0);
  const persisted = await readFile(store.stateFilePath, "utf8");
  assert.equal(persisted.includes(transientClaudePeer.binding.routeHandle), false);
  assert.equal(persisted.includes(transientClaudePeer.binding.ownerLease), false);
  await store.close();
});

test("native messages retain queued bodies but abandon transient authority across restart", async () => {
  const { store, workspace, config, clock: testClock } = await fixture();
  config.inboundMode = "open";
  await store.initialize();
  await observeAndRegisterCodexOnly(store);

  await assert.rejects(
    store.enqueueNativeIngress({
      source: {
        ...transientClaudePeer,
        alias: "native-advisor@build-mac",
      },
      targetAlias: "reviewer@this-mac",
      body: "cross-host ingress",
      dedupeKey: "cross-host-ingress",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "NATIVE_PEER_SCOPE_MISMATCH",
  );
  await assert.rejects(
    store.enqueueNativeIngress({
      source: {
        ...transientClaudePeer,
        binding: {
          ...transientClaudePeer.binding,
          endpointGeneration: "unobserved-claude-generation",
        },
      },
      targetAlias: "reviewer@this-mac",
      body: "unobserved generation",
      dedupeKey: "unobserved-generation",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "NATIVE_PEER_ENDPOINT_NOT_OBSERVED",
  );

  await store.enqueueNativeIngress({
    source: transientClaudePeer,
    targetAlias: "reviewer@this-mac",
    body: "queued native ingress",
    dedupeKey: "restart-native-ingress",
  });
  const reply = await store.enqueueNativeReply({
    sourceAlias: "reviewer@this-mac",
    target: transientClaudePeer,
    body: "in-flight native reply",
    dedupeKey: "restart-native-reply",
  });
  assert.ok(reply.messageId);
  const queuedReply = await store.enqueueNativeReply({
    sourceAlias: "reviewer@this-mac",
    target: {
      ...transientClaudePeer,
      alias: "rotated-native-advisor@this-mac",
      binding: {
        ...transientClaudePeer.binding,
        routeHandle: "00000000-0000-4000-8000-000000000199",
        ownerLease: "transient-owner-lease-rotated",
      },
    },
    body: "queued native reply has no restart authority",
    dedupeKey: "restart-queued-native-reply",
  });
  assert.ok(queuedReply.messageId);
  await store.registerRoute({
    alias: "rotated-native-advisor@this-mac",
    binding: {
      ...transientClaudePeer.binding,
      routeHandle: "00000000-0000-4000-8000-000000000200",
      ownerLease: "different-session-owner-lease",
    },
    registrationMode: "selected_live_peer",
  });
  await store.dequeueMessage(transientClaudePeer.alias);
  await store.close();

  const recovered = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await recovered.initialize();
  const snapshot = await recovered.publicSnapshot();
  assert.equal(snapshot.accounting.abandoned, 1);
  assert.equal(snapshot.accounting.ambiguous, 1);
  assert.equal(
    snapshot.accounting.queuedBytes,
    Buffer.byteLength("queued native ingress"),
  );
  assert.equal(
    (await recovered.dequeueMessage("reviewer@this-mac"))?.body,
    "queued native ingress",
  );
  assert.equal(
    await recovered.dequeueMessage("rotated-native-advisor@this-mac"),
    undefined,
  );
  const persisted = await readFile(recovered.stateFilePath, "utf8");
  assert.equal(persisted.includes(transientClaudePeer.binding.routeHandle), false);
  assert.equal(persisted.includes(transientClaudePeer.binding.ownerLease), false);
  await recovered.close();
});

test("transient available-peer rows use a closed metadata-only schema", () => {
  assert.equal(
    isPublicAvailablePeerSnapshot({
      alias: "advisor@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      validated: true,
      selected: false,
      lastSeenAt: "2026-08-07T12:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    isPublicAvailablePeerSnapshot({
      alias: "advisor@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      validated: true,
      selected: false,
      targetId: "PRIVATE_TARGET_MUST_NOT_ESCAPE",
    }),
    false,
  );
  assert.equal(
    isPublicAvailablePeerSnapshot({
      alias: "advisor@other-host",
      provider: "claude",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      validated: true,
      selected: false,
    }),
    false,
  );
  assert.equal(
    isPublicAvailablePeerSnapshot({
      alias: "reviewer@this-mac",
      provider: "codex",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      validated: true,
      selected: true,
    }),
    false,
  );
  const peer = {
    alias: "advisor@this-mac",
    provider: "claude",
    host: "this-mac",
    state: "idle",
    compatibility: "compatible",
    validated: true,
    selected: false,
  } as const;
  assert.equal(arePublicAvailablePeerSnapshots([peer], 1), true);
  assert.equal(arePublicAvailablePeerSnapshots([peer, peer], 2), false);
});

test("public snapshot projection is deterministic, explicit, and control-sized", () => {
  const timestamp = "2026-08-07T12:00:00.000Z";
  const maximum = Number.MAX_SAFE_INTEGER;
  const hosts = Array.from({ length: 32 }, (_, index) =>
    `h${"a".repeat(58)}${index.toString().padStart(4, "0")}`,
  );
  const alias = (prefix: string, index: number): string =>
    `${prefix}${"a".repeat(26)}${index.toString().padStart(4, "0")}@${hosts[index % hosts.length]}`;
  const counters = {
    accepted: maximum,
    delivered: maximum,
    unconfirmed: maximum,
    failed: maximum,
    ambiguous: maximum,
    expired: maximum,
    cancelled: maximum,
    abandoned: maximum,
    rejected: maximum,
    bytesAccepted: maximum,
  };
  const snapshot: GatewayPublicSnapshot = {
    schemaVersion: 1,
    generatedAt: timestamp,
    inboundMode: "paired",
    health: "degraded",
    connectors: Array.from({ length: 64 }, (_, index) => ({
      provider: index % 2 === 0 ? "codex" : "claude",
      host: hosts[Math.floor(index / 2)]!,
      health: "degraded",
      compatibility: "compatible",
      protocol: "p".repeat(32),
      protocolVersion: "v".repeat(32),
      lastSeenAt: timestamp,
      safeErrorCode: `E${"X".repeat(59)}${index.toString().padStart(4, "0")}`,
    })),
    availablePeers: Array.from({ length: 256 }, (_, index) => ({
      alias: alias("p", index),
      provider: "claude",
      host: hosts[index % hosts.length]!,
      state: index % 2 === 0 ? "busy" : "offline",
      compatibility: index % 2 === 0 ? "compatible" : "expired",
      validated: index % 2 === 0,
      selected: index % 3 === 0,
      lastSeenAt: timestamp,
      safeErrorCode: `P${"X".repeat(59)}${index.toString().padStart(4, "0")}`,
    })),
    routes: Array.from({ length: 256 }, (_, index) => ({
      alias: alias("r", index),
      provider: index < 128 ? "codex" : "claude",
      host: hosts[index % hosts.length]!,
      enabled: true,
      state: "awaiting_approval",
      compatibility: "compatible",
      busyPolicy: "queue",
      lastSeenAt: timestamp,
      queueDepth: maximum,
      counters: { ...counters },
      safeErrorCode: `R${"X".repeat(59)}${index.toString().padStart(4, "0")}`,
    })),
    pairs: Array.from({ length: 256 }, (_, index) => {
      const claudeIndex = 128 + (index % 128);
      const codexIndex =
        (index % 128 + (index < 128 ? 0 : 32)) % 128;
      return {
        claudeAlias: alias("r", claudeIndex),
        codexAlias: alias("r", codexIndex),
        host: hosts[claudeIndex % hosts.length]!,
        counters: { ...counters },
      };
    }),
    messages: Array.from({ length: 1_024 }, (_, index) => ({
      sequence: index + 1,
      timestamp,
      messageIdSuffix: index.toString(16).padStart(8, "0"),
      direction: index % 2 === 0 ? "codex_to_claude" : "claude_to_codex",
      sourceAlias: alias("r", index % 256),
      targetAlias: alias("p", index % 256),
      state: "transport_written",
      bytes: maximum,
      latencyMs: maximum,
      safeErrorCode: `M${"X".repeat(59)}${(index % 10_000)
        .toString()
        .padStart(4, "0")}`,
    })),
    accounting: {
      accepted: maximum,
      duplicates: maximum,
      delivered: maximum,
      unconfirmed: maximum,
      failed: maximum,
      ambiguous: maximum,
      expired: maximum,
      cancelled: maximum,
      abandoned: maximum,
      rejected: maximum,
      bytesAccepted: maximum,
      queuedBytes: maximum,
    },
    alerts: Array.from({ length: 256 }, (_, index) => ({
      code: `A${"X".repeat(59)}${index.toString().padStart(4, "0")}`,
      severity: index % 2 === 0 ? "error" : "warning",
      timestamp,
      provider: index % 2 === 0 ? "codex" : "claude",
      host: hosts[index % hosts.length]!,
      alias: alias("r", index),
    })),
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      pairs: 0,
      messages: 0,
      alerts: 0,
    },
  };

  const projected = projectGatewayPublicSnapshot(snapshot);
  assert.deepEqual(projected, projectGatewayPublicSnapshot(snapshot));
  assert.equal(projected.connectors.length, snapshot.connectors.length);
  assert.equal(projected.routes.length, snapshot.routes.length);
  assert.equal(
    projected.truncation.pairs,
    snapshot.pairs.length - projected.pairs.length,
  );
  assert.equal(
    projected.truncation.messages,
    snapshot.messages.length - projected.messages.length,
  );
  assert.equal(
    projected.truncation.availablePeers,
    snapshot.availablePeers.length - projected.availablePeers.length,
  );
  assert.equal(
    projected.truncation.alerts,
    snapshot.alerts.length - projected.alerts.length,
  );
  assert.ok(Object.values(projected.truncation).some((count) => count > 0));
  assert.ok(
    Buffer.byteLength(JSON.stringify(projected), "utf8") <=
      GATEWAY_PUBLIC_SNAPSHOT_BYTE_BUDGET,
  );
  assert.ok(
    Buffer.byteLength(
      `${JSON.stringify({ protocolVersion: 1, ok: true, result: projected })}\n`,
      "utf8",
    ) <
      256 * 1024,
  );
});

test("stale rebind preserves counters but cannot silently retarget an alias", async () => {
  const { store, workspace, config } = await fixture();
  config.inboundMode = "open";
  await store.initialize();
  await observeAndRegister(store);
  const accepted = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "accounted before refresh",
    dedupeKey: "pre-refresh",
  });
  assert.ok(accepted.messageId);
  await store.cancelQueuedMessage(accepted.messageId);
  const selectedSource = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "selected source rate bucket",
    dedupeKey: "selected-source-rate-bucket",
  });
  assert.ok(selectedSource.messageId);
  await store.cancelQueuedMessage(selectedSource.messageId);
  const currentNameSource = await store.enqueueNativeIngress({
    source: {
      alias: "mentor@this-mac",
      binding: {
        ...transientClaudePeer.binding,
        routeHandle: "00000000-0000-4000-8000-000000000188",
      },
    },
    targetAlias: "reviewer@this-mac",
    body: "current name rate bucket",
    dedupeKey: "current-name-rate-bucket",
  });
  assert.ok(currentNameSource.messageId);
  await store.cancelQueuedMessage(currentNameSource.messageId);
  await store.invalidateRoute(claudeBinding, "PEER_LEASE_EXPIRED");

  const replacement = {
    ...claudeBinding,
    routeHandle: "claude-session-private-0002",
    ownerLease: "claude-owner-lease-0002",
  };
  await assert.rejects(
    store.rebindStaleRoute({
      alias: "advisor@this-mac",
      currentOwnerLease: claudeBinding.ownerLease,
      newBinding: replacement,
      reason: "peer_explicitly_reselected",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_RESELECTION_REQUIRED",
  );
  await assert.rejects(
    store.rebindStaleRoute({
      alias: "advisor@this-mac",
      currentOwnerLease: claudeBinding.ownerLease,
      newBinding: {
        ...claudeBinding,
        ownerLease: "claude-owner-lease-wrong",
      },
      reason: "peer_identity_reobserved",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_RESELECTION_REQUIRED",
  );
  for (const [newBinding, newAlias] of [
    [{ ...claudeBinding, hostId: "build-mac" }, "advisor@build-mac"],
    [{ ...claudeBinding, provider: "codex" as const }, "advisor@this-mac"],
  ] as const) {
    await assert.rejects(
      store.rebindStaleRoute({
        alias: "advisor@this-mac",
        newAlias,
        currentOwnerLease: claudeBinding.ownerLease,
        newBinding: newBinding as PrivateRouteBinding,
        reason: "peer_identity_reobserved",
      }),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "ROUTE_REBIND_SCOPE_MISMATCH",
    );
  }
  await store.rebindStaleRoute({
    alias: "advisor@this-mac",
    newAlias: "mentor@this-mac",
    currentOwnerLease: claudeBinding.ownerLease,
    newBinding: claudeBinding,
    reason: "peer_identity_reobserved",
  });
  assert.equal(
    (await store.publicSnapshot()).routes.find(
      (route) => route.alias === "mentor@this-mac",
    )?.counters.cancelled,
    1,
  );
  assert.deepEqual(await store.resolveRoute("mentor@this-mac"), claudeBinding);
  await assert.rejects(
    store.resolveRoute("advisor@this-mac"),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );
  await store.close();
  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { rateBuckets: Array<{ sourceAlias: string; count: number }> };
  assert.deepEqual(
    persisted.rateBuckets.filter(
      (bucket) => bucket.sourceAlias === "mentor@this-mac",
    ).map(({ sourceAlias, count }) => ({ sourceAlias, count })),
    [{ sourceAlias: "mentor@this-mac", count: 2 }],
  );
});

test("boot reactivation journals an exact same-generation Codex route and preserves queued mail", async () => {
  const { store, config, clock } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-main@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
    state: "busy",
  });
  await store.registerRoute({
    alias: "advisor@this-mac",
    binding: claudeBinding,
    registrationMode: "selected_live_peer",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "codex-main@this-mac",
  });
  await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "codex-main@this-mac",
    body: "queued across a same-generation broker restart",
    dedupeKey: "boot-reactivation-queue",
  });
  await store.close();

  const restarted = new GatewayStore(config, {
    now: clock.now,
    randomId: clock.randomId,
  });
  await restarted.initialize();
  await restarted.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await restarted.rebindStaleRoute({
    alias: "codex-main@this-mac",
    currentOwnerLease: codexBinding.ownerLease,
    newBinding: codexBinding,
    reason: "endpoint_reobserved",
    journalReason: "boot_reactivation",
    state: "idle",
  });

  const snapshot = await restarted.publicSnapshot();
  assert.equal(
    snapshot.routes.find(({ alias }) => alias === "codex-main@this-mac")
      ?.queueDepth,
    1,
  );
  assert.equal(
    snapshot.messages.some(
      ({ body, state }) =>
        body === "queued across a same-generation broker restart" &&
        state === "queued",
    ),
    true,
  );
  const persisted = JSON.parse(
    await readFile(restarted.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshSequence: number;
    codexEndpointRefreshEvents: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.codexEndpointRefreshSequence, 1);
  assert.deepEqual(persisted.codexEndpointRefreshEvents, [
    {
      sequence: 1,
      timestamp: "2026-08-07T12:00:00.000Z",
      alias: "codex-main@this-mac",
      hostId: "this-mac",
      threadId: codexBinding.routeHandle,
      oldEndpointGeneration: codexBinding.endpointGeneration,
      newEndpointGeneration: codexBinding.endpointGeneration,
      reason: "boot_reactivation",
    },
  ]);
  await restarted.close();
});

test("route invalidation atomically applies an exact in-flight terminal plan once", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const towardClaude = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "confirmed route teardown",
    dedupeKey: "route-plan-confirmed",
  });
  const fromClaude = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "uncertain route teardown",
    dedupeKey: "route-plan-uncertain",
  });
  assert.ok(towardClaude.messageId);
  assert.ok(fromClaude.messageId);
  await store.dequeueMessage("advisor@this-mac");
  await store.dequeueMessage("reviewer@this-mac");
  const queuedDue = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "queued deadline wins route teardown",
    dedupeKey: "route-plan-queued-due",
    deadlineAt: new Date(testClock.now().getTime() + 100).toISOString(),
  });
  assert.ok(queuedDue.messageId);

  assert.deepEqual(
    (await store.inspectAffectedInFlightMessages(["advisor@this-mac"]))
      .map(({ messageId }) => messageId)
      .sort(),
    [towardClaude.messageId, fromClaude.messageId].sort(),
  );
  await assert.rejects(
    store.invalidateRoute(claudeBinding, "PEER_NOT_OBSERVED"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_TERMINATION_PLAN_MISMATCH",
  );
  assert.equal(
    (await store.inspectPrivateRoute("advisor@this-mac"))?.compatibility,
    "compatible",
  );

  testClock.advance(100);
  const settlements = await store.invalidateRoute(
    claudeBinding,
    "PEER_NOT_OBSERVED",
    [
      {
        messageId: towardClaude.messageId,
        state: "unconfirmed",
        safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
      },
      {
        messageId: fromClaude.messageId,
        state: "ambiguous",
        safeErrorCode: "TRANSPORT_OUTCOME_UNCERTAIN",
      },
    ],
  );
  assert.deepEqual(settlements, [
    {
      messageId: queuedDue.messageId,
      state: "expired",
      safeErrorCode: "MESSAGE_EXPIRED",
    },
    {
      messageId: towardClaude.messageId,
      state: "unconfirmed",
      safeErrorCode: "CLAUDE_RECEIPT_UNCONFIRMED",
    },
    {
      messageId: fromClaude.messageId,
      state: "ambiguous",
      safeErrorCode: "TRANSPORT_OUTCOME_UNCERTAIN",
    },
  ]);
  assert.deepEqual(
    await store.inspectAffectedInFlightMessages(["advisor@this-mac"]),
    [],
  );
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.unconfirmed, 1);
  assert.equal(snapshot.accounting.ambiguous, 1);
  assert.equal(snapshot.accounting.expired, 1);
  assert.equal(snapshot.accounting.failed, 0);
  assert.deepEqual(
    await store.invalidateRoute(
      claudeBinding,
      "PEER_NOT_OBSERVED",
      [],
    ),
    [],
  );
  const afterDuplicate = await store.publicSnapshot();
  assert.equal(afterDuplicate.accounting.unconfirmed, 1);
  assert.equal(afterDuplicate.accounting.ambiguous, 1);
  await store.close();
});

test("Codex endpoint refresh re-anchors only the exact present subset and journals once", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-one@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.registerRoute({
    alias: "codex-two@this-mac",
    binding: successorCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.registerRoute({
    alias: "advisor@this-mac",
    binding: claudeBinding,
    registrationMode: "selected_live_peer",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "codex-one@this-mac",
  });
  await store.pairRoutes({
    claudeAlias: "advisor@this-mac",
    codexAlias: "codex-two@this-mac",
  });
  const accounted = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "codex-one@this-mac",
    body: "counter survives endpoint refresh",
    dedupeKey: "endpoint-refresh-counter",
  });
  assert.ok(accounted.messageId);
  await store.cancelQueuedMessage(accounted.messageId);

  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  const newEndpoint = {
    ...endpoint(codexBinding),
    endpointGeneration: "codex-generation-0002",
  } as const;
  await store.observeConnector({
    identity: newEndpoint,
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "2",
  });

  await assert.rejects(
    store.reanchorCodexRoutes({
      oldEndpoint: endpoint(codexBinding),
      newEndpoint,
      routes: [
        {
          alias: "codex-one@this-mac",
          threadId: codexBinding.routeHandle,
          ownerLease: codexBinding.ownerLease,
        },
        {
          alias: "codex-two@this-mac",
          threadId: successorCodexBinding.routeHandle,
          ownerLease: "wrong-owner-lease",
        },
      ],
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ENDPOINT_REFRESH_NOT_SAFE",
  );
  assert.ok(
    (await store.inspectPrivateCodexRoutes()).every(
      (route) =>
        route.binding.endpointGeneration === codexBinding.endpointGeneration,
    ),
  );
  assert.equal(
    (
      JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
        codexEndpointRefreshEvents: unknown[];
      }
    ).codexEndpointRefreshEvents.length,
    0,
  );

  assert.deepEqual(
    await store.reanchorCodexRoutes({
      oldEndpoint: endpoint(codexBinding),
      newEndpoint,
      routes: [
        {
          alias: "codex-one@this-mac",
          threadId: codexBinding.routeHandle,
          ownerLease: codexBinding.ownerLease,
          state: "busy",
        },
      ],
    }),
    { reboundAliases: ["codex-one@this-mac"] },
  );
  const routes = await store.inspectPrivateCodexRoutes();
  assert.equal(
    routes.find((route) => route.alias === "codex-one@this-mac")?.binding
      .endpointGeneration,
    newEndpoint.endpointGeneration,
  );
  assert.equal(
    routes.find((route) => route.alias === "codex-one@this-mac")?.state,
    "busy",
  );
  assert.equal(
    routes.find((route) => route.alias === "codex-two@this-mac")?.binding
      .endpointGeneration,
    codexBinding.endpointGeneration,
  );
  assert.equal(
    routes.find((route) => route.alias === "codex-two@this-mac")?.state,
    "stale",
  );
  assert.deepEqual(await store.inspectPairs(), [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-one@this-mac",
    },
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-two@this-mac",
    },
  ]);
  const publicSnapshot = await store.publicSnapshot();
  assert.equal(
    publicSnapshot.routes.find(
      (route) => route.alias === "codex-one@this-mac",
    )?.counters.cancelled,
    1,
  );
  assert.equal(
    JSON.stringify(publicSnapshot).includes(codexBinding.routeHandle),
    false,
  );
  assert.equal(
    JSON.stringify(publicSnapshot).includes(newEndpoint.endpointGeneration),
    false,
  );

  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshSequence: number;
    codexEndpointRefreshEvents: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.codexEndpointRefreshSequence, 1);
  assert.deepEqual(persisted.codexEndpointRefreshEvents, [
    {
      sequence: 1,
      timestamp: "2026-08-07T12:00:00.000Z",
      alias: "codex-one@this-mac",
      hostId: "this-mac",
      threadId: codexBinding.routeHandle,
      oldEndpointGeneration: codexBinding.endpointGeneration,
      newEndpointGeneration: newEndpoint.endpointGeneration,
    },
  ]);
  await assert.rejects(
    store.reanchorCodexRoutes({
      oldEndpoint: endpoint(codexBinding),
      newEndpoint,
      routes: [
        {
          alias: "codex-one@this-mac",
          threadId: codexBinding.routeHandle,
          ownerLease: codexBinding.ownerLease,
        },
      ],
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ENDPOINT_REFRESH_NOT_SAFE",
  );
  const afterRejectedRetry = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { codexEndpointRefreshEvents: unknown[] };
  assert.equal(afterRejectedRetry.codexEndpointRefreshEvents.length, 1);
  assert.deepEqual(
    await store.reanchorCodexRoutes({
      oldEndpoint: endpoint(codexBinding),
      newEndpoint,
      routes: [
        {
          alias: "codex-two@this-mac",
          threadId: successorCodexBinding.routeHandle,
          ownerLease: successorCodexBinding.ownerLease,
        },
      ],
    }),
    { reboundAliases: ["codex-two@this-mac"] },
  );
  const afterSecondAlias = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshSequence: number;
    codexEndpointRefreshEvents: Array<{ alias: string }>;
  };
  assert.equal(afterSecondAlias.codexEndpointRefreshSequence, 2);
  assert.deepEqual(
    afterSecondAlias.codexEndpointRefreshEvents.map((event) => event.alias),
    ["codex-one@this-mac", "codex-two@this-mac"],
  );
  await store.close();
});

test("Codex endpoint-refresh sequence exhaustion is all-or-none", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-exhaust@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  const newEndpoint = {
    ...endpoint(codexBinding),
    endpointGeneration: "codex-generation-0002",
  } as const;
  await store.observeConnector({
    identity: newEndpoint,
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "2",
  });
  await store.close();

  const exhausted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  exhausted.codexEndpointRefreshSequence = Number.MAX_SAFE_INTEGER;
  exhausted.codexEndpointRefreshEvents = [
    {
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: "2026-08-09T12:00:00.000Z",
      alias: "codex-history@this-mac",
      hostId: "this-mac",
      threadId: "codex-thread-private-history",
      oldEndpointGeneration: "codex-generation-history-old",
      newEndpointGeneration: "codex-generation-history-new",
    },
  ];
  await writeFile(store.stateFilePath, `${JSON.stringify(exhausted)}\n`, {
    mode: 0o600,
  });

  const recovered = new GatewayStore(config);
  await recovered.initialize();
  await recovered.observeConnector({
    identity: newEndpoint,
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "2",
  });
  await assert.rejects(
    recovered.reanchorCodexRoutes({
      oldEndpoint: endpoint(codexBinding),
      newEndpoint,
      routes: [
        {
          alias: "codex-exhaust@this-mac",
          threadId: codexBinding.routeHandle,
          ownerLease: codexBinding.ownerLease,
        },
      ],
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ENDPOINT_REFRESH_SEQUENCE_EXHAUSTED",
  );
  const retained = await recovered.inspectPrivateRoute(
    "codex-exhaust@this-mac",
  );
  assert.equal(retained?.state, "stale");
  assert.equal(
    retained?.binding.endpointGeneration,
    codexBinding.endpointGeneration,
  );
  const after = JSON.parse(
    await readFile(recovered.stateFilePath, "utf8"),
  ) as {
    codexEndpointRefreshSequence: number;
    codexEndpointRefreshEvents: unknown[];
  };
  assert.equal(after.codexEndpointRefreshSequence, Number.MAX_SAFE_INTEGER);
  assert.equal(after.codexEndpointRefreshEvents.length, 1);
  await recovered.close();
});

test("Codex orphan removal requires dead-generation proof and preserves the rest of the graph", async () => {
  const { store } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.observeConnector({
    identity: endpoint(claudeBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "claude-peer",
    protocolVersion: "1",
  });
  for (const [alias, binding] of [
    ["codex-orphan@this-mac", codexBinding],
    ["codex-kept@this-mac", successorCodexBinding],
  ] as const) {
    await store.registerRoute({
      alias,
      binding,
      registrationMode: "explicit_opt_in",
    });
  }
  await store.registerRoute({
    alias: "advisor@this-mac",
    binding: claudeBinding,
    registrationMode: "selected_live_peer",
  });
  for (const codexAlias of [
    "codex-orphan@this-mac",
    "codex-kept@this-mac",
  ]) {
    await store.pairRoutes({
      claudeAlias: "advisor@this-mac",
      codexAlias,
    });
    const queued = await store.enqueueMessage({
      sourceAlias: codexAlias,
      targetAlias: "advisor@this-mac",
      body: "leave bounded rate and dedupe metadata",
      dedupeKey: `orphan-metadata-${codexAlias}`,
    });
    assert.ok(queued.messageId);
    await store.cancelQueuedMessage(queued.messageId);
  }
  await armProgressWatch(store, {
    conversationId: "conv_orphanwatch00001",
    ownerAlias: "advisor@this-mac",
    workerAlias: "codex-orphan@this-mac",
    idleMs: 60_000,
  });
  await assert.rejects(
    store.removeStaleCodexOrphan({ alias: "codex-orphan@this-mac" }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ORPHAN_RECOVERY_NOT_SAFE",
  );
  await store.invalidateRoute(codexBinding, "CODEX_ROUTE_STALE");
  await assert.rejects(
    store.removeStaleCodexOrphan({ alias: "codex-orphan@this-mac" }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ORPHAN_GENERATION_LIVE",
  );
  await assert.rejects(
    store.inspectStaleCodexOrphan("codex-orphan@this-mac"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ORPHAN_GENERATION_LIVE",
  );
  const afterRejectedRemoval = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    codexOrphanRemovalSequence: number;
    codexOrphanRemovalEvents: unknown[];
  };
  assert.equal(afterRejectedRemoval.codexOrphanRemovalSequence, 0);
  assert.deepEqual(afterRejectedRemoval.codexOrphanRemovalEvents, []);

  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  assert.deepEqual(
    await store.inspectStaleCodexOrphan("codex-orphan@this-mac"),
    codexBinding,
  );
  const removed = await store.removeStaleCodexOrphan({
    alias: "codex-orphan@this-mac",
  });
  assert.equal(removed.alias, "codex-orphan@this-mac");
  assert.deepEqual(removed.binding, codexBinding);
  assert.deepEqual(removed.removedPairs, [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-orphan@this-mac",
    },
  ]);
  assert.deepEqual(await store.inspectPairs(), [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-kept@this-mac",
    },
  ]);
  assert.equal(
    (await store.inspectPrivateRoute("codex-orphan@this-mac")) === undefined,
    true,
  );
  assert.equal(
    (await store.inspectPrivateRoute("codex-kept@this-mac"))?.state,
    "stale",
  );
  assert.deepEqual(await inspectProgressWatches(store), []);
  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    dedupe: Array<{ sourceAlias: string; targetAlias: string }>;
    rateBuckets: Array<{ sourceAlias: string }>;
    progressWatchEvents: Array<{
      kind: string;
      actor?: string;
      reason?: string;
    }>;
    codexOrphanRemovalSequence: number;
    codexOrphanRemovalEvents: Array<Record<string, unknown>>;
  };
  assert.equal(
    persisted.dedupe.some(
      (record) =>
        record.sourceAlias === "codex-orphan@this-mac" ||
        record.targetAlias === "codex-orphan@this-mac",
    ),
    false,
  );
  assert.equal(
    persisted.dedupe.some(
      (record) => record.sourceAlias === "codex-kept@this-mac",
    ),
    true,
  );
  assert.equal(
    persisted.rateBuckets.some(
      (bucket) => bucket.sourceAlias === "codex-orphan@this-mac",
    ),
    false,
  );
  assert.equal(
    persisted.rateBuckets.some(
      (bucket) => bucket.sourceAlias === "codex-kept@this-mac",
    ),
    true,
  );
  assert.deepEqual(persisted.progressWatchEvents.at(-1), {
    sequence: 2,
    timestamp: "2026-08-07T12:00:00.000Z",
    conversationId: "conv_orphanwatch00001",
    ownerAlias: "advisor@this-mac",
    workerAlias: "codex-orphan@this-mac",
    kind: "settled",
    actor: "gateway",
    reason: "endpoint_retired",
  });
  assert.equal(persisted.codexOrphanRemovalSequence, 1);
  assert.deepEqual(persisted.codexOrphanRemovalEvents, [
    {
      sequence: 1,
      timestamp: "2026-08-07T12:00:00.000Z",
      alias: "codex-orphan@this-mac",
      hostId: "this-mac",
    },
  ]);
  assert.equal(
    JSON.stringify(await store.publicSnapshot()).includes(
      "codexOrphanRemoval",
    ),
    false,
  );
  await store.observeConnector({
    identity: {
      ...endpoint(codexBinding),
      endpointGeneration: "codex-generation-0002",
    },
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "2",
  });
  assert.equal(
    (
      await store.removeStaleCodexOrphan({
        alias: "codex-kept@this-mac",
      })
    ).alias,
    "codex-kept@this-mac",
  );
  const afterSecondRemoval = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    codexOrphanRemovalSequence: number;
    codexOrphanRemovalEvents: Array<{ alias: string }>;
  };
  assert.equal(afterSecondRemoval.codexOrphanRemovalSequence, 2);
  assert.deepEqual(
    afterSecondRemoval.codexOrphanRemovalEvents.map((event) => event.alias),
    ["codex-orphan@this-mac", "codex-kept@this-mac"],
  );
  await store.close();
});

test("Codex orphan-removal sequence exhaustion preserves the route and consent edge", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await store.renameRoute(
    "reviewer@this-mac",
    "codex-orphan-exhaust@this-mac",
    codexBinding.ownerLease,
  );
  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  await store.close();

  const exhausted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  exhausted.codexOrphanRemovalSequence = Number.MAX_SAFE_INTEGER;
  exhausted.codexOrphanRemovalEvents = [
    {
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: "2026-08-09T12:00:00.000Z",
      alias: "codex-history@this-mac",
      hostId: "this-mac",
    },
  ];
  await writeFile(store.stateFilePath, `${JSON.stringify(exhausted)}\n`, {
    mode: 0o600,
  });

  const recovered = new GatewayStore(config);
  await recovered.initialize();
  await assert.rejects(
    recovered.removeStaleCodexOrphan({
      alias: "codex-orphan-exhaust@this-mac",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_ORPHAN_REMOVAL_SEQUENCE_EXHAUSTED",
  );
  assert.ok(
    await recovered.inspectPrivateRoute("codex-orphan-exhaust@this-mac"),
  );
  assert.deepEqual(await recovered.inspectPairs(), [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "codex-orphan-exhaust@this-mac",
    },
  ]);
  const after = JSON.parse(
    await readFile(recovered.stateFilePath, "utf8"),
  ) as {
    codexOrphanRemovalSequence: number;
    codexOrphanRemovalEvents: unknown[];
  };
  assert.equal(after.codexOrphanRemovalSequence, Number.MAX_SAFE_INTEGER);
  assert.equal(after.codexOrphanRemovalEvents.length, 1);
  await recovered.close();
});

test("Codex orphan removal reconciles an exact verified post-rename commit", async () => {
  let failNextRename = false;
  const { store } = await fixture({
    afterStateFileRename: () => {
      if (!failNextRename) return;
      failNextRename = false;
      throw new Error("synthetic orphan post-rename failure");
    },
  });
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-uncertain@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  const authority =
    await store.inspectStaleCodexOrphanRemovalAuthority(
      "codex-uncertain@this-mac",
    );
  assert.deepEqual(authority, {
    binding: codexBinding,
    previousSequence: 0,
  });

  failNextRename = true;
  await assert.rejects(
    store.removeStaleCodexOrphan({ alias: "codex-uncertain@this-mac" }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(
    await store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-uncertain@this-mac",
      binding: authority.binding,
      previousSequence: authority.previousSequence,
    }),
    true,
  );
  assert.equal(
    await store.inspectPrivateRoute("codex-uncertain@this-mac"),
    undefined,
  );
  await store.close();
});

test("Codex orphan commit proof fails closed for absent, unrelated, newer, and route-present state", async () => {
  const emptyFixture = await fixture();
  await emptyFixture.store.initialize();
  assert.equal(
    await emptyFixture.store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-absent@this-mac",
      binding: codexBinding,
      previousSequence: 0,
    }),
    false,
  );
  await emptyFixture.store.close();

  const { store } = await fixture();
  await store.initialize();
  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-first@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.registerRoute({
    alias: "codex-second@this-mac",
    binding: successorCodexBinding,
    registrationMode: "explicit_opt_in",
  });
  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  const firstAuthority =
    await store.inspectStaleCodexOrphanRemovalAuthority(
      "codex-first@this-mac",
    );
  await store.removeStaleCodexOrphan({ alias: "codex-first@this-mac" });
  assert.equal(
    await store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-first@this-mac",
      binding: firstAuthority.binding,
      previousSequence: firstAuthority.previousSequence,
    }),
    true,
  );
  assert.equal(
    await store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-unrelated@this-mac",
      binding: independentCodexBinding,
      previousSequence: 0,
    }),
    false,
  );

  await store.observeConnector({
    identity: endpoint(codexBinding),
    health: "healthy",
    compatibility: "compatible",
    protocol: "app-server-jsonrpc",
    protocolVersion: "1",
  });
  await store.registerRoute({
    alias: "codex-first@this-mac",
    binding: codexBinding,
    registrationMode: "explicit_opt_in",
  });
  assert.equal(
    await store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-first@this-mac",
      binding: firstAuthority.binding,
      previousSequence: firstAuthority.previousSequence,
    }),
    false,
  );
  await store.unregisterRoute(
    "codex-first@this-mac",
    codexBinding.ownerLease,
  );
  await store.markConnectorOffline(
    endpoint(codexBinding),
    "ENDPOINT_GENERATION_CHANGED",
  );
  const secondAuthority =
    await store.inspectStaleCodexOrphanRemovalAuthority(
      "codex-second@this-mac",
    );
  assert.equal(secondAuthority.previousSequence, 1);
  await store.removeStaleCodexOrphan({ alias: "codex-second@this-mac" });
  assert.equal(
    await store.wasStaleCodexOrphanRemovalCommitted({
      alias: "codex-first@this-mac",
      binding: firstAuthority.binding,
      previousSequence: firstAuthority.previousSequence,
    }),
    false,
  );
  await store.close();
});

test("queue, dedupe, delivery, and accounting stay bounded", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const first = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "first",
    dedupeKey: "provider-message-1",
  });
  const duplicate = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "first repeated",
    dedupeKey: "provider-message-1",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.messageIdSuffix, first.messageIdSuffix);
  await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "second",
    dedupeKey: "provider-message-2",
  });
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      body: "third",
      dedupeKey: "provider-message-3",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_QUEUE_FULL",
  );

  const dispatch = await store.dequeueMessage("advisor@this-mac");
  assert.equal(dispatch?.body, "first");
  assert.ok(first.messageId);
  await store.markMessageProgress(first.messageId, "transport_written");
  await store.markMessageProgress(first.messageId, "held");
  assert.equal((await store.publicSnapshot()).accounting.delivered, 0);
  await store.settleMessage({
    messageId: first.messageId,
    state: "delivered",
  });
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.accepted, 2);
  assert.equal(snapshot.accounting.duplicates, 1);
  assert.equal(snapshot.accounting.delivered, 1);
  assert.equal(snapshot.accounting.rejected, 1);
  assert.deepEqual(
    snapshot.messages.slice(-3).map((event) => event.state),
    ["transport_written", "held", "delivered"],
  );
  assert.equal(snapshot.routes.find((route) => route.alias === "advisor@this-mac")?.queueDepth, 1);
  await store.close();
});

test("public route queue age is exact while retained bodies remain bounded", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const firstReviewer = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "OLDEST_REVIEWER_BODY_MUST_NOT_ESCAPE",
    dedupeKey: "oldest-reviewer",
  });
  assert.ok(firstReviewer.messageId);
  const firstReviewerAt = testClock.now().toISOString();
  testClock.advance(100);
  const secondReviewer = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "NEWER_REVIEWER_BODY_MUST_NOT_ESCAPE",
    dedupeKey: "newer-reviewer",
  });
  assert.ok(secondReviewer.messageId);
  const secondReviewerAt = testClock.now().toISOString();
  testClock.advance(100);
  const advisor = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "ADVISOR_BODY_MUST_NOT_ESCAPE",
    dedupeKey: "advisor-queue-age",
  });
  assert.ok(advisor.messageId);
  const advisorAt = testClock.now().toISOString();

  const queued = await store.publicSnapshot();
  assert.deepEqual(
    queued.routes.map(({ alias, queueDepth, oldestQueuedAt }) => ({
      alias,
      queueDepth,
      oldestQueuedAt,
    })),
    [
      {
        alias: "advisor@this-mac",
        queueDepth: 1,
        oldestQueuedAt: advisorAt,
      },
      {
        alias: "reviewer@this-mac",
        queueDepth: 2,
        oldestQueuedAt: firstReviewerAt,
      },
    ],
  );
  const serialized = JSON.stringify(queued);
  for (const privateValue of [
    firstReviewer.messageId,
    secondReviewer.messageId,
    advisor.messageId,
    codexBinding.routeHandle,
    claudeBinding.routeHandle,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  for (const retainedBody of [
    "OLDEST_REVIEWER_BODY_MUST_NOT_ESCAPE",
    "NEWER_REVIEWER_BODY_MUST_NOT_ESCAPE",
    "ADVISOR_BODY_MUST_NOT_ESCAPE",
  ]) {
    assert.equal(serialized.includes(retainedBody), true);
  }

  assert.equal(await store.cancelQueuedMessage(firstReviewer.messageId), true);
  const afterOldestCancellation = await store.publicSnapshot();
  assert.equal(
    afterOldestCancellation.routes.find(
      (route) => route.alias === "reviewer@this-mac",
    )?.oldestQueuedAt,
    secondReviewerAt,
  );
  assert.equal(
    (await store.dequeueMessage("advisor@this-mac"))?.messageId,
    advisor.messageId,
  );
  const afterAdvisorDispatch = await store.publicSnapshot();
  const advisorRoute = afterAdvisorDispatch.routes.find(
    (route) => route.alias === "advisor@this-mac",
  );
  assert.equal(advisorRoute?.queueDepth, 0);
  assert.equal(Object.hasOwn(advisorRoute ?? {}, "oldestQueuedAt"), false);
  await store.close();
});

test("conversation correlation stays suffix-only while body and deadline evidence are retained", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const queued = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "SUFFIX_ONLY_BODY_MUST_NOT_ESCAPE",
    dedupeKey: "suffix-only-evidence",
    conversationIdSuffix: "aB_9-zY0",
  });
  assert.ok(queued.messageId);
  assert.equal(
    (await store.dequeueMessage("reviewer@this-mac"))?.conversationIdSuffix,
    "aB_9-zY0",
  );
  testClock.advance(750);
  assert.deepEqual(
    await store.settleMessage({
      messageId: queued.messageId,
      state: "delivered",
    }),
    {
      status: "settled",
      settlement: { messageId: queued.messageId, state: "delivered" },
    },
  );

  const snapshot = await store.publicSnapshot();
  assert.deepEqual(
    snapshot.messages.map((event) => event.conversationIdSuffix),
    ["aB_9-zY0", "aB_9-zY0", "aB_9-zY0"],
  );
  assert.deepEqual(snapshot.deadlinePressure, {
    configuredDeadlineMs: 5_000,
    retainedSince: snapshot.messages[0]?.timestamp,
    terminalEvents: 1,
    expiredEvents: 0,
    buckets: [
      { bucket: "under_1m", settled: 1, expired: 0 },
      { bucket: "1m_to_5m", settled: 0, expired: 0 },
      { bucket: "5m_to_15m", settled: 0, expired: 0 },
      { bucket: "15m_to_60m", settled: 0, expired: 0 },
      { bucket: "over_60m", settled: 0, expired: 0 },
    ],
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("SUFFIX_ONLY_BODY_MUST_NOT_ESCAPE"), true);
  await assert.rejects(
    store.enqueueMessage({
      sourceAlias: "advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      body: "invalid suffix",
      dedupeKey: "invalid-suffix",
      conversationIdSuffix: "too-long-token",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONVERSATION_SUFFIX",
  );
  await store.close();
});

test("requeue preserves the original enqueue time as the public queue age", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const queued = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "REQUEUED_BODY_MUST_STAY_TRANSIENT",
    dedupeKey: "requeue-preserves-age",
  });
  assert.ok(queued.messageId);
  const originalEnqueuedAt = testClock.now().toISOString();

  testClock.advance(400);
  const dispatched = await store.dequeueMessage("reviewer@this-mac");
  assert.equal(dispatched?.messageId, queued.messageId);
  const whileInFlight = (await store.publicSnapshot()).routes.find(
    (route) => route.alias === "reviewer@this-mac",
  );
  assert.equal(whileInFlight?.queueDepth, 0);
  assert.equal(Object.hasOwn(whileInFlight ?? {}, "oldestQueuedAt"), false);

  testClock.advance(600);
  assert.deepEqual(
    await store.requeueInFlightMessage(
      queued.messageId,
      dispatched?.body ?? "",
    ),
    { status: "requeued" },
  );
  const afterRequeue = (await store.publicSnapshot()).routes.find(
    (route) => route.alias === "reviewer@this-mac",
  );
  assert.equal(afterRequeue?.queueDepth, 1);
  assert.equal(afterRequeue?.oldestQueuedAt, originalEnqueuedAt);
  assert.notEqual(afterRequeue?.oldestQueuedAt, testClock.now().toISOString());
  await store.close();
});

test("due expiry is explicit, atomic, stable, and returned exactly once", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const startedAt = testClock.now().getTime();

  const inFlightDue = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "in-flight due",
    dedupeKey: "in-flight-due",
    deadlineAt: new Date(startedAt + 1_000).toISOString(),
  });
  const inFlightFuture = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "in-flight future",
    dedupeKey: "in-flight-future",
    deadlineAt: new Date(startedAt + 3_000).toISOString(),
  });
  assert.ok(inFlightDue.messageId);
  assert.ok(inFlightFuture.messageId);
  assert.equal(
    (await store.dequeueMessage("advisor@this-mac"))?.messageId,
    inFlightDue.messageId,
  );
  assert.equal(
    (await store.dequeueMessage("reviewer@this-mac"))?.messageId,
    inFlightFuture.messageId,
  );

  const queuedDue = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "queued due",
    dedupeKey: "queued-due",
    deadlineAt: new Date(startedAt + 1_500).toISOString(),
  });
  const queuedFuture = await store.enqueueMessage({
    sourceAlias: "advisor@this-mac",
    targetAlias: "reviewer@this-mac",
    body: "queued future",
    dedupeKey: "queued-future",
    deadlineAt: new Date(startedAt + 3_000).toISOString(),
  });
  assert.ok(queuedDue.messageId);
  assert.ok(queuedFuture.messageId);

  testClock.advance(1_500);
  const retainedByGenericPrune = await store.publicSnapshot();
  assert.equal(retainedByGenericPrune.accounting.expired, 0);
  assert.equal(retainedByGenericPrune.accounting.ambiguous, 0);
  assert.deepEqual(
    retainedByGenericPrune.routes.map(({ alias, queueDepth }) => ({
      alias,
      queueDepth,
    })),
    [
      { alias: "advisor@this-mac", queueDepth: 1 },
      { alias: "reviewer@this-mac", queueDepth: 1 },
    ],
  );

  const expiryTime = testClock.now();
  assert.deepEqual(await store.expireDueMessages(expiryTime), [
    {
      messageId: queuedDue.messageId,
      state: "expired",
      safeErrorCode: "MESSAGE_EXPIRED",
    },
    {
      messageId: inFlightDue.messageId,
      state: "ambiguous",
      safeErrorCode: "DELIVERY_DEADLINE_EXPIRED",
    },
  ]);
  assert.deepEqual(await store.expireDueMessages(expiryTime), []);
  assert.deepEqual(
    await store.settleMessage({
      messageId: inFlightDue.messageId,
      state: "delivered",
    }),
    { status: "not_in_flight" },
  );
  assert.deepEqual(
    await store.requeueInFlightMessage(inFlightDue.messageId, "late body"),
    { status: "not_in_flight" },
  );

  const afterExpiry = await store.publicSnapshot();
  assert.equal(afterExpiry.accounting.expired, 1);
  assert.equal(afterExpiry.accounting.ambiguous, 1);
  assert.equal(afterExpiry.accounting.delivered, 0);
  assert.deepEqual(
    afterExpiry.messages.slice(-2).map(({ state, safeErrorCode }) => ({
      state,
      safeErrorCode,
    })),
    [
      { state: "expired", safeErrorCode: "MESSAGE_EXPIRED" },
      {
        state: "ambiguous",
        safeErrorCode: "DELIVERY_DEADLINE_EXPIRED",
      },
    ],
  );
  assert.equal(
    afterExpiry.routes.find((route) => route.alias === "advisor@this-mac")
      ?.queueDepth,
    0,
  );
  assert.equal(
    afterExpiry.routes.find((route) => route.alias === "reviewer@this-mac")
      ?.queueDepth,
    1,
  );

  assert.deepEqual(
    await store.settleMessage({
      messageId: inFlightFuture.messageId,
      state: "delivered",
    }),
    {
      status: "settled",
      settlement: {
        messageId: inFlightFuture.messageId,
        state: "delivered",
      },
    },
  );
  assert.equal(await store.cancelQueuedMessage(queuedFuture.messageId), true);
  await store.close();
});

test("settlement and deadline requeue races are first-terminal-wins", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const delivered = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "settle once",
    dedupeKey: "settle-once",
  });
  assert.ok(delivered.messageId);
  await store.dequeueMessage("advisor@this-mac");
  assert.deepEqual(
    await store.settleMessage({
      messageId: delivered.messageId,
      state: "delivered",
    }),
    {
      status: "settled",
      settlement: { messageId: delivered.messageId, state: "delivered" },
    },
  );
  assert.deepEqual(
    await store.settleMessage({
      messageId: delivered.messageId,
      state: "failed",
      safeErrorCode: "LATE_FAILURE",
    }),
    { status: "not_in_flight" },
  );

  const requeueDue = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "expire during clean requeue",
    dedupeKey: "expire-during-requeue",
    deadlineAt: new Date(testClock.now().getTime() + 500).toISOString(),
  });
  assert.ok(requeueDue.messageId);
  const dispatch = await store.dequeueMessage("advisor@this-mac");
  assert.equal(dispatch?.messageId, requeueDue.messageId);
  testClock.advance(500);
  assert.deepEqual(
    await store.requeueInFlightMessage(
      requeueDue.messageId,
      dispatch?.body ?? "",
    ),
    {
      status: "settled",
      settlement: {
        messageId: requeueDue.messageId,
        state: "expired",
        safeErrorCode: "MESSAGE_EXPIRED",
      },
    },
  );
  assert.deepEqual(
    await store.requeueInFlightMessage(
      requeueDue.messageId,
      dispatch?.body ?? "",
    ),
    { status: "not_in_flight" },
  );
  assert.deepEqual(await store.expireDueMessages(), []);

  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.delivered, 1);
  assert.equal(snapshot.accounting.failed, 0);
  assert.equal(snapshot.accounting.expired, 1);
  assert.equal(
    snapshot.messages.filter(
      (event) => event.messageIdSuffix === delivered.messageIdSuffix &&
        ["delivered", "failed", "ambiguous", "expired", "cancelled"].includes(
          event.state,
        ),
    ).length,
    1,
  );
  assert.equal(
    snapshot.messages.filter(
      (event) => event.messageIdSuffix === requeueDue.messageIdSuffix &&
        ["delivered", "failed", "ambiguous", "expired", "cancelled"].includes(
          event.state,
        ),
    ).length,
    1,
  );
  await assert.rejects(
    store.expireDueMessages(new Date(Number.NaN)),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_GATEWAY_TIMESTAMP",
  );
  await store.close();
});

test("unconfirmed is an exact-once in-flight terminal outcome", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const accepted = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "transport accepted without a native direct receipt",
    dedupeKey: "unconfirmed-native-receipt",
  });
  assert.ok(accepted.messageId);
  await store.dequeueMessage("advisor@this-mac");
  await store.markMessageProgress(accepted.messageId, "transport_written");

  assert.deepEqual(
    await store.settleMessage({
      messageId: accepted.messageId,
      state: "unconfirmed",
      safeErrorCode: "CLAUDE_NATIVE_ACK_UNAVAILABLE",
    }),
    {
      status: "settled",
      settlement: {
        messageId: accepted.messageId,
        state: "unconfirmed",
        safeErrorCode: "CLAUDE_NATIVE_ACK_UNAVAILABLE",
      },
    },
  );
  assert.deepEqual(
    await store.settleMessage({
      messageId: accepted.messageId,
      state: "delivered",
    }),
    { status: "not_in_flight" },
  );

  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.unconfirmed, 1);
  assert.equal(snapshot.accounting.delivered, 0);
  assert.equal(
    snapshot.routes.find((route) => route.alias === "advisor@this-mac")
      ?.counters.unconfirmed,
    1,
  );
  assert.deepEqual(
    snapshot.messages
      .filter((event) => event.messageIdSuffix === accepted.messageIdSuffix)
      .map(({ state, safeErrorCode }) => ({ state, safeErrorCode })),
    [
      { state: "queued", safeErrorCode: undefined },
      { state: "dispatching", safeErrorCode: undefined },
      { state: "transport_written", safeErrorCode: undefined },
      {
        state: "unconfirmed",
        safeErrorCode: "CLAUDE_NATIVE_ACK_UNAVAILABLE",
      },
    ],
  );
  await store.close();
});

test("a transient dispatch can return to the held queue without leaking in-flight metadata", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const accepted = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "retry me after the target becomes available",
    dedupeKey: "transient-dispatch-retry",
  });
  assert.ok(accepted.messageId);
  const firstDispatch = await store.dequeueMessage("advisor@this-mac");
  assert.equal(firstDispatch?.body, "retry me after the target becomes available");

  assert.deepEqual(
    await store.requeueInFlightMessage(
      accepted.messageId,
      firstDispatch?.body ?? "",
    ),
    { status: "requeued" },
  );
  const held = await store.publicSnapshot();
  assert.equal(
    held.routes.find((route) => route.alias === "advisor@this-mac")?.queueDepth,
    1,
  );
  assert.equal(held.messages.at(-1)?.state, "held");

  const retry = await store.dequeueMessage("advisor@this-mac");
  assert.equal(retry?.messageId, accepted.messageId);
  assert.equal(retry?.body, "retry me after the target becomes available");
  await store.close();
});

test("queued terminal settlement is authoritative, exact-once, and fully accounted", async () => {
  const { store } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const cases = [
    { state: "failed", safeErrorCode: "QUEUE_DISPATCH_FAILED" },
    { state: "expired", safeErrorCode: "MESSAGE_EXPIRED" },
    { state: "cancelled", safeErrorCode: "MESSAGE_CANCELLED" },
    { state: "abandoned", safeErrorCode: "QUEUE_OWNERSHIP_ABANDONED" },
  ] as const;

  for (const [index, expected] of cases.entries()) {
    const accepted = await store.enqueueMessage({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      body: `canonical queued settlement ${index}`,
      dedupeKey: `canonical-queued-settlement-${index}`,
    });
    assert.ok(accepted.messageId);

    assert.deepEqual(
      await store.settleQueuedMessage({
        messageId: accepted.messageId,
        ...expected,
      }),
      {
        status: "settled",
        settlement: {
          messageId: accepted.messageId,
          ...expected,
        },
      },
    );
    assert.deepEqual(
      await store.settleQueuedMessage({
        messageId: accepted.messageId,
        state: "failed",
        safeErrorCode: "LATE_COMPETING_SETTLEMENT",
      }),
      { status: "not_queued" },
    );

    const snapshot = await store.publicSnapshot();
    assert.equal(snapshot.accounting[expected.state], 1);
    assert.equal(snapshot.accounting.queuedBytes, 0);
    const route = snapshot.routes.find(
      (candidate) => candidate.alias === "advisor@this-mac",
    );
    assert.equal(route?.queueDepth, 0);
    assert.equal(route?.counters[expected.state], 1);
    assert.deepEqual(
      snapshot.messages
        .filter(
          (event) => event.messageIdSuffix === accepted.messageIdSuffix,
        )
        .map(({ state, safeErrorCode }) => ({ state, safeErrorCode })),
      [
        { state: "queued", safeErrorCode: undefined },
        expected,
      ],
    );
    assert.equal(await store.dequeueMessage("advisor@this-mac"), undefined);
  }

  const stillQueued = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "invalid settlements must retain queue ownership",
    dedupeKey: "invalid-queued-settlement",
  });
  assert.ok(stillQueued.messageId);
  await assert.rejects(
    store.settleQueuedMessage({
      messageId: stillQueued.messageId,
      state: "failed",
      safeErrorCode: "not-normalized",
    }),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_SAFE_ERROR_CODE",
  );
  await assert.rejects(
    store.settleQueuedMessage({
      messageId: stillQueued.messageId,
      state: "delivered",
      safeErrorCode: "INVALID_QUEUE_TERMINAL",
    } as unknown as Parameters<typeof store.settleQueuedMessage>[0]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_DELIVERY_SETTLEMENT",
  );
  await assert.rejects(
    store.settleQueuedMessage({
      messageId: stillQueued.messageId,
      state: "unconfirmed",
      safeErrorCode: "INVALID_QUEUE_TERMINAL",
    } as unknown as Parameters<typeof store.settleQueuedMessage>[0]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_DELIVERY_SETTLEMENT",
  );
  assert.equal(await store.cancelQueuedMessage(stillQueued.messageId), true);
  assert.equal(await store.cancelQueuedMessage(stillQueued.messageId), false);
  await store.close();
});

test("queued settlement and due expiry are first-terminal-wins", async () => {
  const { store, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);

  const setterFirstAtCutoff = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "deadline wins even when manual settlement enters first",
    dedupeKey: "queued-manual-first-at-deadline",
    deadlineAt: new Date(testClock.now().getTime() + 500).toISOString(),
  });
  assert.ok(setterFirstAtCutoff.messageId);
  testClock.advance(500);
  const [setterWinner, expirySweepLoser] = await Promise.all([
    store.settleQueuedMessage({
      messageId: setterFirstAtCutoff.messageId,
      state: "failed",
      safeErrorCode: "DISPATCH_ABORTED_AT_DEADLINE",
    }),
    store.expireDueMessages(testClock.now()),
  ]);
  assert.deepEqual(setterWinner, {
    status: "settled",
    settlement: {
      messageId: setterFirstAtCutoff.messageId,
      state: "expired",
      safeErrorCode: "MESSAGE_EXPIRED",
    },
  });
  assert.deepEqual(expirySweepLoser, []);

  const expiryFirst = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "expiry settlement wins at the deadline",
    dedupeKey: "queued-expiry-first-at-deadline",
    deadlineAt: new Date(testClock.now().getTime() + 500).toISOString(),
  });
  assert.ok(expiryFirst.messageId);
  testClock.advance(500);
  const [expiryWinner, manualLoser] = await Promise.all([
    store.expireDueMessages(testClock.now()),
    store.settleQueuedMessage({
      messageId: expiryFirst.messageId,
      state: "cancelled",
      safeErrorCode: "LATE_MANUAL_CANCELLATION",
    }),
  ]);
  assert.deepEqual(expiryWinner, [
    {
      messageId: expiryFirst.messageId,
      state: "expired",
      safeErrorCode: "MESSAGE_EXPIRED",
    },
  ]);
  assert.deepEqual(manualLoser, { status: "not_queued" });

  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.failed, 0);
  assert.equal(snapshot.accounting.expired, 2);
  assert.equal(snapshot.accounting.cancelled, 0);
  assert.equal(snapshot.accounting.queuedBytes, 0);
  assert.equal(
    snapshot.routes.find((route) => route.alias === "advisor@this-mac")
      ?.queueDepth,
    0,
  );
  for (const message of [setterFirstAtCutoff, expiryFirst]) {
    assert.equal(
      snapshot.messages.filter(
        (event) =>
          event.messageIdSuffix === message.messageIdSuffix &&
          ["failed", "expired", "cancelled", "abandoned"].includes(
            event.state,
          ),
      ).length,
      1,
    );
  }
  await store.close();
});

test("in-flight expiry is terminal while progress remains nonterminal", async () => {
  const { store, workspace } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const accepted = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "synthetic receipt expiration",
    dedupeKey: "receipt-expired",
  });
  assert.ok(accepted.messageId);
  await store.dequeueMessage("advisor@this-mac");
  await store.markMessageProgress(accepted.messageId, "transport_written");
  await store.settleMessage({
    messageId: accepted.messageId,
    state: "expired",
    safeErrorCode: "RECEIPT_EXPIRED",
  });
  const snapshot = await store.publicSnapshot();
  assert.equal(snapshot.accounting.expired, 1);
  assert.equal(snapshot.accounting.delivered, 0);
  assert.deepEqual(
    snapshot.messages.slice(-2).map((event) => event.state),
    ["transport_written", "expired"],
  );
  await assert.rejects(
    store.markMessageProgress(accepted.messageId, "held"),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "MESSAGE_NOT_IN_FLIGHT",
  );
  await store.close();
});

test("event and dedupe TTLs prune and the event ring is capped", async () => {
  const { store, workspace, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  for (let index = 0; index < 6; index += 1) {
    const accepted = await store.enqueueMessage({
      sourceAlias: "reviewer@this-mac",
      targetAlias: "advisor@this-mac",
      body: `message ${index}`,
      dedupeKey: `unique-${index}`,
    });
    assert.ok(accepted.messageId);
    await store.cancelQueuedMessage(accepted.messageId);
  }
  assert.equal((await store.publicSnapshot()).messages.length, 10);
  testClock.advance(1_001);
  assert.equal((await store.publicSnapshot()).messages.length, 0);
  const acceptedAgain = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "dedupe expired",
    dedupeKey: "unique-0",
  });
  assert.equal(acceptedAgain.accepted, true);
  await store.close();
});

test("retained event bodies evict oldest payloads without removing lifecycle metadata", async () => {
  const { store, config } = await fixture();
  config.limits.maxRetainedBodyBytes = 10;
  await store.initialize();
  await observeAndRegister(store);

  const first = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "first-body",
    dedupeKey: "retained-body-first",
  });
  assert.ok(first.messageId);
  await store.cancelQueuedMessage(first.messageId);

  const second = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "secondbody",
    dedupeKey: "retained-body-second",
  });
  assert.ok(second.messageId);
  await store.cancelQueuedMessage(second.messageId);

  const snapshot = await store.publicSnapshot();
  assert.deepEqual(
    snapshot.messages.map(({ state, body }) => ({ state, body })),
    [
      { state: "queued", body: undefined },
      { state: "cancelled", body: undefined },
      { state: "queued", body: undefined },
      { state: "cancelled", body: "secondbody" },
    ],
  );
  const persisted = await readFile(store.stateFilePath, "utf8");
  assert.equal(persisted.includes("first-body"), false);
  assert.equal(persisted.includes("secondbody"), true);
  assert.equal((await lstat(store.stateFilePath)).mode & 0o077, 0);
  await store.close();
});

test("restart stales routes, retains queued bodies, and never replays ambiguous writes", async () => {
  const { store, workspace, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const inFlight = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "may have been written",
    dedupeKey: "restart-inflight",
  });
  assert.ok(inFlight.messageId);
  await store.dequeueMessage();
  await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "still queued",
    dedupeKey: "restart-queued",
  });
  await store.close();

  const recovered = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await recovered.initialize();
  const snapshot = await recovered.publicSnapshot();
  assert.equal(snapshot.accounting.abandoned, 0);
  assert.equal(snapshot.accounting.ambiguous, 1);
  assert.equal(snapshot.accounting.queuedBytes, Buffer.byteLength("still queued"));
  assert.ok(snapshot.routes.every((route) => route.state === "stale"));
  assert.equal((await recovered.dequeueMessage())?.body, "still queued");
  await assert.rejects(
    recovered.resolveRoute("advisor@this-mac"),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );
  await recovered.close();
});

test("legacy persisted hop counters are ignored and removed", async () => {
  const { store, config, clock: testClock } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  const dispatched = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "legacy in flight",
    dedupeKey: "legacy-hop-in-flight",
  });
  assert.ok(dispatched.messageId);
  await store.dequeueMessage();
  await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "legacy queued",
    dedupeKey: "legacy-hop-queued",
  });
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    queue: Array<Record<string, unknown>>;
    inFlight: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  };
  for (const row of [...legacy.queue, ...legacy.inFlight, ...legacy.events]) {
    row.hopCount = 16;
  }
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const recovered = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await recovered.initialize();
  const snapshot = await recovered.publicSnapshot();
  assert.ok(snapshot.messages.every((event) => !("hopCount" in event)));
  const persisted = JSON.parse(
    await readFile(recovered.stateFilePath, "utf8"),
  ) as {
    queue: Array<Record<string, unknown>>;
    inFlight: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  };
  assert.ok(
    [...persisted.queue, ...persisted.inFlight, ...persisted.events].every(
      (row) => !("hopCount" in row),
    ),
  );
  await recovered.close();
});

test("malformed legacy hop counters remain corrupt", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "legacy malformed hop",
    dedupeKey: "legacy-malformed-hop",
  });
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { queue: Array<Record<string, unknown>> };
  assert.ok(legacy.queue[0]);
  legacy.queue[0]!.hopCount = -1;
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    new GatewayStore(config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("one narrow migration adds zeroed unconfirmed counters to old dogfood state", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await observeAndRegister(store);
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    accounting: Record<string, unknown>;
    routes: Array<{ counters: Record<string, unknown> }>;
    codexSuccession?: unknown;
    pairs?: unknown;
    watchSequence?: unknown;
    progressWatches?: unknown;
    progressWatchEvents?: unknown;
    compatibilityAttestations?: unknown;
    codexEndpointRefreshSequence?: unknown;
    codexEndpointRefreshEvents?: unknown;
    codexOrphanRemovalSequence?: unknown;
    codexOrphanRemovalEvents?: unknown;
  };
  delete legacy.accounting.unconfirmed;
  for (const route of legacy.routes) delete route.counters.unconfirmed;
  delete legacy.codexSuccession;
  delete legacy.pairs;
  delete legacy.watchSequence;
  delete legacy.progressWatches;
  delete legacy.progressWatchEvents;
  delete legacy.compatibilityAttestations;
  delete legacy.codexEndpointRefreshSequence;
  delete legacy.codexEndpointRefreshEvents;
  delete legacy.codexOrphanRemovalSequence;
  delete legacy.codexOrphanRemovalEvents;
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const migrated = new GatewayStore(config);
  await migrated.initialize();
  const snapshot = await migrated.publicSnapshot();
  assert.equal(snapshot.accounting.unconfirmed, 0);
  assert.ok(
    snapshot.routes.every((route) => route.counters.unconfirmed === 0),
  );
  assert.deepEqual(snapshot.pairs, [
    {
      claudeAlias: "advisor@this-mac",
      codexAlias: "reviewer@this-mac",
      host: "this-mac",
      counters: {
        accepted: 0,
        delivered: 0,
        unconfirmed: 0,
        failed: 0,
        ambiguous: 0,
        expired: 0,
        cancelled: 0,
        abandoned: 0,
        rejected: 0,
        bytesAccepted: 0,
      },
    },
  ]);
  const persisted = JSON.parse(
    await readFile(migrated.stateFilePath, "utf8"),
  ) as {
    accounting: Record<string, unknown>;
    routes: Array<{ counters: Record<string, unknown> }>;
    codexSuccession?: unknown;
    compatibilityAttestations?: unknown;
    codexEndpointRefreshSequence?: unknown;
    codexEndpointRefreshEvents?: unknown;
    codexOrphanRemovalSequence?: unknown;
    codexOrphanRemovalEvents?: unknown;
  };
  assert.equal(persisted.accounting.unconfirmed, 0);
  assert.ok(
    persisted.routes.every((route) => route.counters.unconfirmed === 0),
  );
  assert.equal(persisted.codexSuccession, null);
  assert.deepEqual(persisted.compatibilityAttestations, []);
  assert.equal(persisted.codexEndpointRefreshSequence, 0);
  assert.deepEqual(persisted.codexEndpointRefreshEvents, []);
  assert.equal(persisted.codexOrphanRemovalSequence, 0);
  assert.deepEqual(persisted.codexOrphanRemovalEvents, []);
  await migrated.close();
});

test("startup staging defers migrations and observations until one explicit commit", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await store.close();
  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  delete legacy.compatibilityAttestations;
  delete legacy.codexEndpointRefreshSequence;
  delete legacy.codexEndpointRefreshEvents;
  delete legacy.codexOrphanRemovalSequence;
  delete legacy.codexOrphanRemovalEvents;
  const legacyBytes = `${JSON.stringify(legacy)}\n`;
  await writeFile(store.stateFilePath, legacyBytes, { mode: 0o600 });

  const staged = new GatewayStore(config);
  await staged.initialize({ deferPersistence: true });
  const attestation = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.228",
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: certifiedCompatibilityVersions.claude,
    probes: compatibilityProbeNames.claude.map((name) => ({
      name,
      outcome: "pass" as const,
    })),
  });
  await staged.recordCompatibilityAttestation(attestation);
  assert.equal(await readFile(store.stateFilePath, "utf8"), legacyBytes);

  await staged.commitInitialization();
  const committed = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as { compatibilityAttestations?: unknown };
  assert.deepEqual(committed.compatibilityAttestations, [attestation]);
  await staged.close();
});

test("automatic compatibility evidence is strict, persistent, keyed by surface and version, and bounded", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  const attestation = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.228",
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: certifiedCompatibilityVersions.claude,
    probes: compatibilityProbeNames.claude.map((name) => ({
      name,
      outcome: "pass" as const,
    })),
  });
  await store.recordCompatibilityAttestation(attestation);
  assert.deepEqual(
    await store.inspectCompatibilityAttestation("claude", "2.1.228"),
    attestation,
  );
  await store.recordCompatibilityAttestation({
    ...attestation,
    checkedAt: "2026-08-09T12:01:00.000Z",
  });
  assert.equal((await store.inspectCompatibilityAttestations()).length, 1);
  await assert.rejects(
    store.recordCompatibilityAttestation({
      ...attestation,
      probes: [],
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "COMPAT_ATTESTATION_INVALID",
  );
  await store.close();

  const recovered = new GatewayStore(config);
  await recovered.initialize();
  assert.equal(
    (
      await recovered.inspectCompatibilityAttestation("claude", "2.1.228")
    )?.checkedAt,
    "2026-08-09T12:01:00.000Z",
  );
  assert.equal(
    JSON.stringify(await recovered.publicSnapshot()).includes("2.1.228"),
    false,
  );
  await recovered.close();
});

test("persisted compatibility tiers survive release inventory changes while malformed evidence fails closed", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  const passingProbes = compatibilityProbeNames.claude.map((name) => ({
    name,
    outcome: "pass" as const,
  }));
  const decertifiedLater = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.226",
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["2.1.226"],
    probes: passingProbes,
  });
  const certifiedLater = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.227",
    checkedAt: "2026-08-09T12:01:00.000Z",
    certifiedVersions: ["2.1.226"],
    probes: passingProbes,
  });
  for (const releaseRelative of [decertifiedLater, certifiedLater]) {
    await assert.rejects(
      store.recordCompatibilityAttestation(releaseRelative),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "COMPAT_ATTESTATION_INVALID",
    );
  }
  await store.close();
  const historicalCertified = {
    ...decertifiedLater,
    probes: decertifiedLater.probes.map((probe, index) =>
      index === 0 ? { ...probe, name: "launcher_v0" } : probe,
    ),
  };
  const persisted = JSON.parse(await readFile(store.stateFilePath, "utf8")) as {
    compatibilityAttestations: Array<Record<string, unknown>>;
  };
  persisted.compatibilityAttestations = [historicalCertified, certifiedLater];
  await writeFile(store.stateFilePath, `${JSON.stringify(persisted)}\n`, {
    mode: 0o600,
  });

  const recovered = new GatewayStore(config);
  await recovered.initialize();
  assert.deepEqual(
    await recovered.inspectCompatibilityAttestations(),
    [historicalCertified, certifiedLater],
  );
  await recovered.close();
  const recoveredBytes = await readFile(store.stateFilePath, "utf8");
  const idempotent = new GatewayStore(config);
  await idempotent.initialize();
  await idempotent.close();
  assert.equal(await readFile(store.stateFilePath, "utf8"), recoveredBytes);

  for (const variant of ["failed", "unknown", "malformed"] as const) {
    const current = await fixture();
    await current.store.initialize();
    await current.store.close();
    const invalid = JSON.parse(
      await readFile(current.store.stateFilePath, "utf8"),
    ) as { compatibilityAttestations: Array<Record<string, unknown>> };
    const row = JSON.parse(JSON.stringify(decertifiedLater)) as Record<
      string,
      unknown
    >;
    invalid.compatibilityAttestations = [row];
    if (variant === "failed") {
      const probes = row.probes as Array<Record<string, unknown>>;
      probes[0] = {
        name: "launcher",
        outcome: "fail",
        safeErrorCode: "CLAUDE_LAUNCHER_INVALID",
      };
    } else if (variant === "unknown") {
      row.version = "unknown";
    } else {
      row.checkedAt = "not-a-timestamp";
    }
    await writeFile(
      current.store.stateFilePath,
      `${JSON.stringify(invalid)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      new GatewayStore(current.config).initialize(),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
      variant,
    );
  }
});

test("legacy manual certification evidence is stripped while automatic probes survive", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  const attestation = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.226",
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["2.1.227"],
    probes: compatibilityProbeNames.claude.map((name) => ({
      name,
      outcome: "pass" as const,
    })),
  });
  await store.recordCompatibilityAttestation(attestation);
  await store.close();

  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    compatibilityAttestations: Array<Record<string, unknown>>;
  };
  assert.ok(legacy.compatibilityAttestations[0]);
  legacy.compatibilityAttestations[0]!.tier = "certified";
  legacy.compatibilityAttestations[0]!.certification = {
    depth: "wire",
    outcome: "pass",
    certifiedAt: "2026-08-09T12:01:00.000Z",
  };
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const migrated = new GatewayStore(config);
  await migrated.initialize();
  assert.deepEqual(await migrated.inspectCompatibilityAttestations(), [
    attestation,
  ]);
  const persisted = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as {
    compatibilityAttestations: Array<Record<string, unknown>>;
  };
  assert.equal(
    Object.hasOwn(persisted.compatibilityAttestations[0] ?? {}, "certification"),
    false,
  );
  await migrated.close();

  assert.ok(persisted.compatibilityAttestations[0]);
  persisted.compatibilityAttestations[0]!.certification = {
    depth: "wire",
    outcome: "pass",
    certifiedAt: "2026-08-09T12:02:00.000Z",
    safeErrorCode: "LEGACY_CERTIFICATION_INVALID",
  };
  await writeFile(store.stateFilePath, `${JSON.stringify(persisted)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    new GatewayStore(config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("one additive migration adds the orphan-removal journal without changing endpoint-refresh evidence", async () => {
  const { store, config } = await fixture();
  await store.initialize();
  await store.close();
  const legacy = JSON.parse(
    await readFile(store.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  legacy.codexEndpointRefreshSequence = 1;
  legacy.codexEndpointRefreshEvents = [
    {
      sequence: 1,
      timestamp: "2026-08-09T12:00:00.000Z",
      alias: "codex-journal@this-mac",
      hostId: "this-mac",
      threadId: "codex-thread-private-journal",
      oldEndpointGeneration: "codex-generation-old",
      newEndpointGeneration: "codex-generation-new",
    },
  ];
  delete legacy.codexOrphanRemovalSequence;
  delete legacy.codexOrphanRemovalEvents;
  await writeFile(store.stateFilePath, `${JSON.stringify(legacy)}\n`, {
    mode: 0o600,
  });

  const migrated = new GatewayStore(config);
  await migrated.initialize();
  const persisted = JSON.parse(
    await readFile(migrated.stateFilePath, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(persisted.codexEndpointRefreshSequence, 1);
  assert.deepEqual(persisted.codexEndpointRefreshEvents, [
    {
      sequence: 1,
      timestamp: "2026-08-09T12:00:00.000Z",
      alias: "codex-journal@this-mac",
      hostId: "this-mac",
      threadId: "codex-thread-private-journal",
      oldEndpointGeneration: "codex-generation-old",
      newEndpointGeneration: "codex-generation-new",
    },
  ]);
  assert.equal(persisted.codexOrphanRemovalSequence, 0);
  assert.deepEqual(persisted.codexOrphanRemovalEvents, []);
  await migrated.close();
});

test("private Codex endpoint-refresh journal rejects malformed, out-of-sequence, and oversized state", async () => {
  const event = (sequence: number): Record<string, unknown> => ({
    sequence,
    timestamp: "2026-08-09T12:00:00.000Z",
    alias: "codex-journal@this-mac",
    hostId: "this-mac",
    threadId: "codex-thread-private-journal",
    oldEndpointGeneration: `codex-generation-${sequence}`,
    newEndpointGeneration: `codex-generation-${sequence + 1}`,
  });
  const corruptions: Array<
    readonly [string, (state: Record<string, unknown>) => void]
  > = [
    [
      "unknown content-bearing field",
      (state) => {
        const row = event(1);
        row.body = "MUST_NOT_BE_ACCEPTED";
        state.codexEndpointRefreshSequence = 1;
        state.codexEndpointRefreshEvents = [row];
      },
    ],
    [
      "non-increasing sequence",
      (state) => {
        state.codexEndpointRefreshSequence = 2;
        state.codexEndpointRefreshEvents = [event(2), event(1)];
      },
    ],
    [
      "sequence above counter",
      (state) => {
        state.codexEndpointRefreshSequence = 0;
        state.codexEndpointRefreshEvents = [event(1)];
      },
    ],
    [
      "nonzero counter with empty journal",
      (state) => {
        state.codexEndpointRefreshSequence = 1;
        state.codexEndpointRefreshEvents = [];
      },
    ],
    [
      "gap in retained sequence",
      (state) => {
        state.codexEndpointRefreshSequence = 3;
        state.codexEndpointRefreshEvents = [event(1), event(3)];
      },
    ],
    [
      "counter above last retained event",
      (state) => {
        state.codexEndpointRefreshSequence = 2;
        state.codexEndpointRefreshEvents = [event(1)];
      },
    ],
    [
      "oversized bounded journal",
      (state) => {
        state.codexEndpointRefreshSequence =
          CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY + 1;
        state.codexEndpointRefreshEvents = Array.from(
          { length: CODEX_ENDPOINT_REFRESH_JOURNAL_CAPACITY + 1 },
          (_, index) => event(index + 1),
        );
      },
    ],
  ];

  for (const [label, corrupt] of corruptions) {
    const { store, config } = await fixture();
    await store.initialize();
    await store.close();
    const persisted = JSON.parse(
      await readFile(store.stateFilePath, "utf8"),
    ) as Record<string, unknown>;
    corrupt(persisted);
    await writeFile(store.stateFilePath, `${JSON.stringify(persisted)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      new GatewayStore(config).initialize(),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
      label,
    );
  }
});

test("private Codex orphan-removal journal rejects malformed, impossible, and oversized state", async () => {
  const event = (sequence: number): Record<string, unknown> => ({
    sequence,
    timestamp: "2026-08-09T12:00:00.000Z",
    alias: "codex-orphan-journal@this-mac",
    hostId: "this-mac",
  });
  const corruptions: Array<
    readonly [string, (state: Record<string, unknown>) => void]
  > = [
    [
      "unknown content-bearing field",
      (state) => {
        const row = event(1);
        row.body = "MUST_NOT_BE_ACCEPTED";
        state.codexOrphanRemovalSequence = 1;
        state.codexOrphanRemovalEvents = [row];
      },
    ],
    [
      "nonzero counter with empty journal",
      (state) => {
        state.codexOrphanRemovalSequence = 1;
        state.codexOrphanRemovalEvents = [];
      },
    ],
    [
      "event above zero counter",
      (state) => {
        state.codexOrphanRemovalSequence = 0;
        state.codexOrphanRemovalEvents = [event(1)];
      },
    ],
    [
      "gap in retained sequence",
      (state) => {
        state.codexOrphanRemovalSequence = 3;
        state.codexOrphanRemovalEvents = [event(1), event(3)];
      },
    ],
    [
      "counter above last retained event",
      (state) => {
        state.codexOrphanRemovalSequence = 2;
        state.codexOrphanRemovalEvents = [event(1)];
      },
    ],
    [
      "oversized bounded journal",
      (state) => {
        state.codexOrphanRemovalSequence =
          CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY + 1;
        state.codexOrphanRemovalEvents = Array.from(
          { length: CODEX_ORPHAN_REMOVAL_JOURNAL_CAPACITY + 1 },
          (_, index) => event(index + 1),
        );
      },
    ],
  ];

  for (const [label, corrupt] of corruptions) {
    const { store, config } = await fixture();
    await store.initialize();
    await store.close();
    const persisted = JSON.parse(
      await readFile(store.stateFilePath, "utf8"),
    ) as Record<string, unknown>;
    corrupt(persisted);
    await writeFile(store.stateFilePath, `${JSON.stringify(persisted)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      new GatewayStore(config).initialize(),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
      label,
    );
  }
});

test("strict succession journal rejects malformed oversized and unknown fields", async () => {
  const corruptions: Array<
    readonly [string, (journal: Record<string, unknown>) => void]
  > = [
    [
      "unknown body field",
      (journal) => {
        journal.body = "MUST_NOT_BE_ACCEPTED";
      },
    ],
    [
      "oversized generation",
      (journal) => {
        const next = journal.new as Record<string, unknown>;
        next.generation = "x".repeat(33);
      },
    ],
    [
      "generation outside the closed grammar",
      (journal) => {
        const next = journal.new as Record<string, unknown>;
        next.generation = "invalid.generation";
      },
    ],
    [
      "unknown nested socket field",
      (journal) => {
        const next = journal.new as Record<string, unknown>;
        const binding = next.binding as Record<string, unknown>;
        binding.socketPath = "/tmp/must-not-be-persisted.sock";
      },
    ],
    [
      "unobserved successor connector generation",
      (journal) => {
        const next = journal.new as Record<string, unknown>;
        const binding = next.binding as Record<string, unknown>;
        binding.endpointGeneration = "unobserved-successor-generation";
      },
    ],
    [
      "reused predecessor owner lease",
      (journal) => {
        const prior = journal.old as Record<string, unknown>;
        const next = journal.new as Record<string, unknown>;
        const priorBinding = prior.binding as Record<string, unknown>;
        const nextBinding = next.binding as Record<string, unknown>;
        nextBinding.ownerLease = priorBinding.ownerLease;
      },
    ],
    [
      "unknown stage",
      (journal) => {
        journal.stage = "publishing_maybe";
      },
    ],
  ];

  for (const [label, corrupt] of corruptions) {
    const { store, config } = await fixture();
    await store.initialize();
    await observeAndRegisterSuccessionRoutes(store);
    await store.prepareCodexSuccession({
      old: oldSuccessionIdentity,
      new: newSuccessionIdentity,
    });
    await store.close();
    const persisted = JSON.parse(
      await readFile(store.stateFilePath, "utf8"),
    ) as Record<string, unknown>;
    const journal = persisted.codexSuccession as Record<string, unknown>;
    corrupt(journal);
    await writeFile(store.stateFilePath, `${JSON.stringify(persisted)}\n`, {
      mode: 0o600,
    });
    await chmod(store.stateFilePath, 0o600);
    await assert.rejects(
      new GatewayStore(config).initialize(),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
      label,
    );
  }
});

test("strict state schema rejects unknown content-bearing fields", async () => {
  const { store, workspace, config } = await fixture();
  await store.initialize();
  await store.close();
  const body = JSON.parse(await readFile(store.stateFilePath, "utf8")) as Record<
    string,
    unknown
  >;
  body.prompt = "SHOULD_NEVER_BE_ACCEPTED";
  await writeFile(store.stateFilePath, `${JSON.stringify(body)}\n`, {
    mode: 0o600,
  });
  await chmod(store.stateFilePath, 0o600);
  await assert.rejects(
    new GatewayStore(config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("oversized state and lock files are rejected before unbounded reads", async () => {
  const stateFixture = await fixture();
  await stateFixture.store.initialize();
  await stateFixture.store.close();
  await writeFile(
    stateFixture.store.stateFilePath,
    Buffer.alloc(GATEWAY_MAX_STATE_FILE_BYTES + 1, 0x20),
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(stateFixture.config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_FILE_TOO_LARGE",
  );

  const lockFixture = await fixture();
  await lockFixture.store.initialize();
  await lockFixture.store.close();
  await writeFile(
    path.join(lockFixture.stateDir, ".gateway-controller.lock"),
    Buffer.alloc(4 * 1024 + 1, 0x20),
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(lockFixture.config).initialize(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_LOCK_UNVERIFIED",
  );
});
