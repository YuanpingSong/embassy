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
import type {
  PrivateRouteBinding,
  RegisterRouteInput,
} from "../src/gateway/types.js";
import {
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
    maxHopCount: 2,
    rateLimitPerRoute: 20,
    rateWindowMs: 1_000,
  };
}

async function fixture(): Promise<{
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
    limits: limits(),
  };
  const testClock = clock();
  const store = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
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

const transientClaudePeer = {
  alias: "native-advisor@this-mac",
  binding: {
    ...claudeBinding,
    routeHandle: "79fa18fc-1486-4e2f-a549-a8d922573477",
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
  assert.equal(config.limits.maxMessageBytes, 16_384);

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

test("gateway state requires a private owned leaf disjoint from workspaces", async () => {
  const { root, workspace, config, clock: testClock } = await fixture();
  const overlappingConfig = {
    ...config,
    stateDir: path.join(workspace, "gateway"),
    controlSocketPath: path.join(workspace, "gateway", "control.sock"),
  };
  await assert.rejects(
    new GatewayStore(overlappingConfig, {
      now: testClock.now,
      randomId: testClock.randomId,
    }).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_WORKSPACE_OVERLAP",
  );

  const publicDirectory = path.join(root, "public");
  await mkdir(publicDirectory, { mode: 0o755 });
  const publicConfig = {
    ...config,
    stateDir: publicDirectory,
    controlSocketPath: path.join(publicDirectory, "control.sock"),
  };
  await assert.rejects(
    new GatewayStore(publicConfig).initialize([workspace]),
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
    new GatewayStore(linkedConfig).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_GATEWAY_STATE_DIRECTORY",
  );
});

test("one live gateway exclusively owns its controller state", async () => {
  const { store, config, workspace } = await fixture();
  await store.initialize([workspace]);
  const second = new GatewayStore(config);
  await assert.rejects(
    second.initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_STATE_IN_USE",
  );
  await store.close();
  await second.initialize([workspace]);
  await second.close();
});

test("gateway may start before discovery but dynamically attests each workspace", async () => {
  const { store, stateDir, workspace } = await fixture();
  await store.initialize([]);
  assert.equal((await lstat(stateDir)).mode & 0o777, 0o700);
  await store.assertWorkspaceDisjoint(workspace);
  await store.close();
});

test("dynamic local route workspaces are checked without persistence", async () => {
  const { store, root, workspace } = await fixture();
  await store.initialize([workspace]);
  await store.assertWorkspaceDisjoint(workspace);
  await assert.rejects(
    store.assertWorkspaceDisjoint(root),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_WORKSPACE_OVERLAP",
  );
  const linked = path.join(root, "linked-workspace");
  await symlink(workspace, linked);
  await assert.rejects(
    store.assertWorkspaceDisjoint(linked),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PROVIDER_WORKSPACE",
  );
  assert.equal(
    (await readFile(store.stateFilePath, "utf8")).includes(workspace),
    false,
  );
  await store.close();
});

test("workspace attestation rejects broad local roots", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
  const loginHome = await realpath(os.homedir());
  const temporaryRoot = await realpath(os.tmpdir());
  const broadRoots = new Set([
    path.parse(loginHome).root,
    path.dirname(loginHome),
    loginHome,
    temporaryRoot,
  ]);
  for (const sharedTemporaryRoot of ["/tmp", "/var/tmp"]) {
    const canonical = await realpath(sharedTemporaryRoot).catch(() => undefined);
    if (canonical !== undefined) broadRoots.add(canonical);
  }
  for (const broadRoot of broadRoots) {
    await assert.rejects(
      store.assertWorkspaceDisjoint(broadRoot),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "INVALID_PROVIDER_WORKSPACE",
    );
  }
  await store.close();

  const uninitialized = await fixture();
  await assert.rejects(
    uninitialized.store.initialize([loginHome]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PROVIDER_WORKSPACE",
  );
  await assert.rejects(lstat(uninitialized.stateDir));
});

test("workspace attestation requires an owned non-writable project leaf", async () => {
  const dynamic = await fixture();
  await dynamic.store.initialize([dynamic.workspace]);
  const writableWorkspace = path.join(dynamic.root, "writable-workspace");
  await mkdir(writableWorkspace, { mode: 0o700 });
  await chmod(writableWorkspace, 0o777);
  await assert.rejects(
    dynamic.store.assertWorkspaceDisjoint(writableWorkspace),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PROVIDER_WORKSPACE",
  );
  await dynamic.store.close();

  const insecureInitial = await fixture();
  await chmod(insecureInitial.workspace, 0o777);
  await assert.rejects(
    insecureInitial.store.initialize([insecureInitial.workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PROVIDER_WORKSPACE",
  );
  await assert.rejects(lstat(insecureInitial.stateDir));

  const foreign = await fixture();
  let expectedUid = (await lstat(foreign.workspace)).uid;
  const foreignAwareStore = new GatewayStore(foreign.config, {
    workspaceOwnerUid: () => expectedUid,
  });
  await foreignAwareStore.initialize([foreign.workspace]);
  expectedUid += 1;
  await assert.rejects(
    foreignAwareStore.assertWorkspaceDisjoint(foreign.workspace),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_PROVIDER_WORKSPACE",
  );
  await foreignAwareStore.close();
});

test("routes require explicit selection and immutable exact generations", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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
  await store.initialize([workspace]);
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

test("persistence contains metadata but no body, dedupe key, or public native IDs", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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
  assert.equal(persisted.includes(body), false);
  assert.equal(persisted.includes(dedupeKey), false);
  assert.equal(persisted.includes("body"), false);
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
    body,
    dedupeKey,
  ]) {
    assert.equal(publicBody.includes(secret), false);
  }
  assert.match(snapshot.messages.at(-1)?.messageIdSuffix ?? "", /^[0-9a-f]{8}$/);
  await store.close();
});

test("native Claude ingress queues for an explicit Codex route without registering the peer", async () => {
  const { store, workspace, config } = await fixture();
  config.limits.rateLimitPerRoute = 1;
  await store.initialize([workspace]);
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

test("a correlated native reply retains transient-target queue semantics and no route authority", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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
  assert.equal(
    await store.requeueInFlightMessage(
      reply.messageId,
      firstDispatch?.body ?? "",
    ),
    true,
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

test("native messages fail closed on peer scope and abandon transient authority across restart", async () => {
  const { store, workspace, config, clock: testClock } = await fixture();
  await store.initialize([workspace]);
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
  await store.dequeueMessage(transientClaudePeer.alias);
  await store.close();

  const recovered = new GatewayStore(config, {
    now: testClock.now,
    randomId: testClock.randomId,
  });
  await recovered.initialize([workspace]);
  const snapshot = await recovered.publicSnapshot();
  assert.equal(snapshot.accounting.abandoned, 1);
  assert.equal(snapshot.accounting.ambiguous, 1);
  assert.equal(snapshot.accounting.queuedBytes, 0);
  assert.equal(await recovered.dequeueMessage(), undefined);
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
      selected: index % 3 === 0,
      lastSeenAt: timestamp,
      safeErrorCode: `P${"X".repeat(59)}${index.toString().padStart(4, "0")}`,
    })),
    routes: Array.from({ length: 256 }, (_, index) => ({
      alias: alias("r", index),
      provider: index % 2 === 0 ? "codex" : "claude",
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
    messages: Array.from({ length: 1_024 }, (_, index) => ({
      sequence: index + 1,
      timestamp,
      messageIdSuffix: index.toString(16).padStart(8, "0"),
      direction: index % 2 === 0 ? "codex_to_claude" : "claude_to_codex",
      sourceAlias: alias("r", index % 256),
      targetAlias: alias("p", index % 256),
      state: "transport_written",
      bytes: maximum,
      hopCount: maximum,
      latencyMs: maximum,
      safeErrorCode: `M${"X".repeat(59)}${(index % 10_000)
        .toString()
        .padStart(4, "0")}`,
    })),
    accounting: {
      accepted: maximum,
      duplicates: maximum,
      delivered: maximum,
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
      messages: 0,
      alerts: 0,
    },
  };

  const projected = projectGatewayPublicSnapshot(snapshot);
  assert.deepEqual(projected, projectGatewayPublicSnapshot(snapshot));
  assert.equal(projected.connectors.length, snapshot.connectors.length);
  assert.equal(projected.routes.length, snapshot.routes.length);
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
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
  await observeAndRegister(store);
  const accepted = await store.enqueueMessage({
    sourceAlias: "reviewer@this-mac",
    targetAlias: "advisor@this-mac",
    body: "accounted before refresh",
    dedupeKey: "pre-refresh",
  });
  assert.ok(accepted.messageId);
  await store.cancelQueuedMessage(accepted.messageId);
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
      reason: "endpoint_reobserved",
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ROUTE_RESELECTION_REQUIRED",
  );
  await store.rebindStaleRoute({
    alias: "advisor@this-mac",
    currentOwnerLease: claudeBinding.ownerLease,
    newBinding: replacement,
    reason: "peer_explicitly_reselected",
  });
  assert.equal(
    (await store.publicSnapshot()).routes.find(
      (route) => route.alias === "advisor@this-mac",
    )?.counters.cancelled,
    1,
  );
  assert.deepEqual(await store.resolveRoute("advisor@this-mac"), replacement);
  await store.close();
});

test("queue, dedupe, delivery, and accounting stay bounded", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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

test("a transient dispatch can return to the held queue without leaking in-flight metadata", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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

  assert.equal(
    await store.requeueInFlightMessage(
      accepted.messageId,
      firstDispatch?.body ?? "",
    ),
    true,
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

test("in-flight expiry is terminal while progress remains nonterminal", async () => {
  const { store, workspace } = await fixture();
  await store.initialize([workspace]);
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
  await store.initialize([workspace]);
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

test("restart stales routes and never replays bodyless queued or ambiguous writes", async () => {
  const { store, workspace, config, clock: testClock } = await fixture();
  await store.initialize([workspace]);
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
  await recovered.initialize([workspace]);
  const snapshot = await recovered.publicSnapshot();
  assert.equal(snapshot.accounting.abandoned, 1);
  assert.equal(snapshot.accounting.ambiguous, 1);
  assert.equal(snapshot.accounting.queuedBytes, 0);
  assert.ok(snapshot.routes.every((route) => route.state === "stale"));
  assert.equal(await recovered.dequeueMessage(), undefined);
  await assert.rejects(
    recovered.resolveRoute("advisor@this-mac"),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "ROUTE_UNAVAILABLE",
  );
  await recovered.close();
});

test("strict state schema rejects unknown content-bearing fields", async () => {
  const { store, workspace, config } = await fixture();
  await store.initialize([workspace]);
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
    new GatewayStore(config).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CORRUPT_GATEWAY_STATE",
  );
});

test("oversized state and lock files are rejected before unbounded reads", async () => {
  const stateFixture = await fixture();
  await stateFixture.store.initialize([stateFixture.workspace]);
  await stateFixture.store.close();
  await writeFile(
    stateFixture.store.stateFilePath,
    Buffer.alloc(GATEWAY_MAX_STATE_FILE_BYTES + 1, 0x20),
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(stateFixture.config).initialize([stateFixture.workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_FILE_TOO_LARGE",
  );

  const lockFixture = await fixture();
  await lockFixture.store.initialize([lockFixture.workspace]);
  await lockFixture.store.close();
  await writeFile(
    path.join(lockFixture.stateDir, ".gateway-controller.lock"),
    Buffer.alloc(4 * 1024 + 1, 0x20),
    { mode: 0o600 },
  );
  await assert.rejects(
    new GatewayStore(lockFixture.config).initialize([lockFixture.workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_STATE_LOCK_UNVERIFIED",
  );
});
