import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import { LocalCodexTransportError, managedCodexControlSocketPath,
  type LocalCodexTransportFactory } from "../src/gateway/codex-local-transport.js";
import type { StatelessCodexOperationTransport } from "../src/gateway/codex-stateless-transport.js";
import { runGatewayCli, gatewayCliExitCodes } from "../src/gateway/cli.js";
import { loadGatewayConfig as loadGatewayConfigBase } from "../src/gateway/config.js";
import { sendGatewayControlRequest } from "../src/gateway/control.js";
import { renderDashboardHtml } from "../src/gateway/dashboard.js";
import type { GatewayInstanceLease } from "../src/gateway/instance-lease.js";
import type {
  LocalClaudeGatewayProvider,
  LocalCodexGatewayProvider,
} from "../src/gateway/providers.js";
import {
  runGatewayServer as runGatewayServerBase,
  type GatewayServerDependencies,
  type GatewayServerReadyResult,
} from "../src/gateway/server.js";
import type { GatewayProviderAdapter } from "../src/gateway/service.js";
import { GatewayStore } from "../src/gateway/store.js";
import { dashboardFixture } from "./dashboard-fixture.js";

const SYNTHETIC_HOME = "/synthetic/login-home";
const SYNTHETIC_SECRET = "SYNTHETIC_CREDENTIAL_MUST_NOT_BE_FORWARDED";
const SYNTHETIC_CODEX_VERSION = "0.147.0";
const loadGatewayConfig = (env: NodeJS.ProcessEnv) =>
  loadGatewayConfigBase(env, { host: "this-mac", nodes: [] });
const runGatewayServer: typeof runGatewayServerBase = (options, dependencies = {}) =>
  runGatewayServerBase(options, { loadNodeInventory: async () => ({ host: "this-mac", nodes: [] }), ...dependencies });

function runtime(): AttestedClaudePeerRuntime {
  return {
    sessionsDir: "/synthetic/login-home/.claude/sessions",
    socketDir: "/synthetic/tmp/cc-socks",
  };
}

function provider(
  onClose: () => void,
): LocalClaudeGatewayProvider & LocalCodexGatewayProvider {
  return {
    close: async () => onClose(),
  } as unknown as LocalClaudeGatewayProvider & LocalCodexGatewayProvider;
}

function liveSnapshotProvider(
  provider: "claude" | "codex",
): GatewayProviderAdapter {
  return {
    identity: { provider, hostId: "this-mac" },
    protocol: provider === "claude" ? "claude-peer" : "codex-app-server",
    protocolVersion: provider === "claude" ? "1" : SYNTHETIC_CODEX_VERSION,
    initialize: async () => ({ health: "healthy" }),
    ...(provider === "claude" ? {
      latestRegistryObservation: () => ({
        entriesScanned: 0,
        parseableRecords: 0,
        rejected: [],
      }),
      discoverClaudePeers: async () => ({
        peers: [],
        complete: true,
        registry: { entriesScanned: 0, parseableRecords: 0, rejected: [] },
      }),
    } : {}),
    dispatch: async () => ({ state: "deferred", safeErrorCode: "ROUTE_BUSY" }),
    close: async () => undefined,
  };
}

function factory(
  onClose: () => void,
  appServerVersion = SYNTHETIC_CODEX_VERSION,
  availabilityFailure?: "CODEX_CONTROL_SOCKET_UNAVAILABLE",
): LocalCodexTransportFactory {
  return {
    appServerVersion,
    ...(availabilityFailure === undefined ? {} : { availabilityFailure }),
    endpointGeneration: "synthetic_endpoint_generation",
    hostId: "this-mac",
    protocol: "codex-app-server",
    protocolVersion: appServerVersion,
    close: async () => onClose(),
  } as unknown as LocalCodexTransportFactory;
}

function statelessOperation(): StatelessCodexOperationTransport {
  return {
    execute: async (input) => ({
      attemptId: input.attemptId,
      cleanupConfirmed: true,
      phase: "clean",
      safeErrorCode: "THREAD_NOT_OBSERVED",
      state: "deferred",
    }),
    observe: async () => ({ state: "unobserved", safeErrorCode: "THREAD_NOT_OBSERVED" }),
  };
}

function inertStore(
  config: ConstructorParameters<typeof GatewayStore>[0],
): GatewayStore {
  const store = new GatewayStore(config);
  Object.defineProperty(store, "initialize", {
    value: async () => undefined,
  });
  return store;
}

function instanceLease(
  onClose: () => unknown | Promise<unknown>,
  lost: Promise<void> = new Promise<void>(() => undefined),
): GatewayInstanceLease {
  let observedLoss = false;
  void lost.then(() => {
    observedLoss = true;
  });
  return {
    lost,
    isLost: () => observedLoss,
    close: async () => {
      await onClose();
    },
  };
}

function leaseLossHarness(onClose: () => unknown | Promise<unknown>): {
  lease: GatewayInstanceLease;
  lose: () => void;
} {
  let resolveLost: (() => void) | undefined;
  let lost = false;
  const loss = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  return {
    lease: {
      lost: loss,
      isLost: () => lost,
      close: async () => {
        await onClose();
      },
    },
    lose: () => {
      if (lost) return;
      lost = true;
      resolveLost?.();
    },
  };
}

function signalHarness(): {
  dependencies: Pick<
    GatewayServerDependencies,
    "addSignalListener" | "removeSignalListener"
  >;
  listenerCount: () => number;
  emit: (signal: "SIGINT" | "SIGTERM") => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    dependencies: {
      addSignalListener: (signal, listener) => {
        const selected = listeners.get(signal) ?? new Set<() => void>();
        selected.add(listener);
        listeners.set(signal, selected);
      },
      removeSignalListener: (signal, listener) => {
        listeners.get(signal)?.delete(listener);
      },
    },
    listenerCount: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0),
    emit: (signal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

test("foreground assembly keeps an unavailable optional ACP provider local", async () => {
  const stateDir = "/synthetic/controller-state";
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    USER: "synthetic-user",
    LOGNAME: "synthetic-user",
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_DELIVERY_NOTICES: "quiet",
    ANTHROPIC_API_KEY: SYNTHETIC_SECRET,
    CLAUDE_CODE_MESSAGING_SOCKET: "/synthetic/private/provider.sock",
    CODEX_THREAD_ID: "00000000-0000-7000-8000-000000000701",
  };
  const config = loadGatewayConfig(env);
  const effectiveConfig = { ...config, inboundMode: "open" as const };
  const store = inertStore(effectiveConfig);
  const abort = new AbortController();
  const signals = signalHarness();
  const events: string[] = [];
  const ready: GatewayServerReadyResult[] = [];
  let claudeAttestations = 0;
  let codexOperationOptions: Record<string, unknown> | undefined;
  let codexProviderOptions: Record<string, unknown> | undefined;
  let codexObservationAttempts = 0;
  const acpProviderOptions: Record<string, unknown>[] = [];
  let serviceOptions: Record<string, unknown> | undefined;
  let doctorResolutionError: unknown = new LocalCodexTransportError("MANAGED_CODEX_UNAVAILABLE");
  let doctorInspections = 0;

  await runGatewayServer(
    {
      env,
      locale: "zh-CN",
      inboundMode: "open",
      signal: abort.signal,
      onReady: (result) => {
        events.push("ready");
        ready.push(result);
        signals.emit("SIGTERM");
        abort.abort();
      },
    },
    {
      ...signals.dependencies,
      loadConfig: (received) => {
        assert.equal(received, env);
        events.push("config");
        return config;
      },
      loginHome: () => SYNTHETIC_HOME,
      acquireInstanceLease: async (home) => {
        assert.equal(home, SYNTHETIC_HOME);
        events.push("acquire-instance");
        return instanceLease(() => events.push("close-instance"));
      },
      attestClaudeRuntime: async () => {
        events.push("attest-claude");
        claudeAttestations += 1;
        return runtime();
      },
      createClaudeProvider: (options) => {
        events.push("create-claude");
        assert.deepEqual(options.runtime, runtime());
        assert.equal(options.locale, "zh-CN");
        assert.equal(options.deliveryNotices, "quiet");
        return provider(() => events.push("close-claude"));
      },
      createStore: (received) => {
        events.push("create-store");
        assert.deepEqual(received, effectiveConfig);
        return store;
      },
      createCodexOperation: (options) => {
        events.push("create-codex-operation");
        codexOperationOptions = options as unknown as Record<string, unknown>;
        return statelessOperation();
      },
      createCodexObservationFactory: async () => {
        codexObservationAttempts += 1;
        return factory(() => undefined);
      },
      createCodexProvider: (options) => {
        events.push("create-codex");
        codexProviderOptions = options as unknown as Record<string, unknown>;
        return provider(() => events.push("close-codex"));
      },
      createPeerProvider: (hostId) => {
        assert.equal(hostId, "this-mac");
        events.push("create-peer");
        return provider(() => events.push("close-peer"));
      },
      resolveCodexInstallation: async () => { throw doctorResolutionError; },
      createCodexDoctorInspector: () => ({ inspect: async (request) => {
        doctorInspections += 1;
        assert.equal(request.socketPath, managedCodexControlSocketPath(SYNTHETIC_HOME));
        const holder = process.pid + 1;
        return { processes: [{ pid: holder, parentPid: 1, executablePath: "/synthetic/stale-codex" }], socketHolderPids: [holder] };
      } }),
      resolveDeepSeekAcpLaunch: async (options) => {
        assert.equal(options.loginHome, SYNTHETIC_HOME);
        assert.equal(options.env, env);
        events.push("resolve-deepseek");
        throw Object.assign(new Error("hostile PATH entry"), { code: "EACCES" });
      },
      createAcpProvider: (options) => {
        events.push(`create-${options.provider}`);
        acpProviderOptions.push(options as unknown as Record<string, unknown>);
        return provider(() => undefined);
      },
      createService: (options) => {
        serviceOptions = options as unknown as Record<string, unknown>;
        return {
          start: async () => {
            events.push("start-service");
          },
          close: async () => {
            events.push("close-service");
          },
        };
      },
    },
  );

  assert.equal(claudeAttestations, 1);
  const localOperation = codexOperationOptions?.local as
    | Record<string, unknown>
    | undefined;
  assert.deepEqual(localOperation?.environment, {
    HOME: SYNTHETIC_HOME,
    USER: "synthetic-user",
    LOGNAME: "synthetic-user",
  });
  assert.equal(
    JSON.stringify(codexOperationOptions).includes(SYNTHETIC_SECRET),
    false,
  );
  assert.deepEqual(Object.keys(codexProviderOptions ?? {}), [
    "hostId",
    "nodeInventory",
    "operation",
    "createObservationFactory",
  ]);
  assert.equal(codexProviderOptions?.hostId, "this-mac");
  assert.equal(typeof codexProviderOptions?.createObservationFactory, "function");
  assert.equal(codexObservationAttempts, 0);
  assert.equal(serviceOptions?.store, store);
  assert.deepEqual(serviceOptions?.config, effectiveConfig);
  assert.equal(
    (serviceOptions?.adapters as readonly unknown[] | undefined)?.length,
    5,
  );
  assert.deepEqual(
    acpProviderOptions.map(({ provider, alias, launch, unavailableCode }) => ({
      provider, alias, launch, unavailableCode,
    })),
    [
      {
        provider: "deepseek",
        alias: "dsh-main@this-mac",
        launch: undefined,
        unavailableCode: "DEEPSEEK_HARNESS_HOME_UNSAFE",
      },
      {
        provider: "grok",
        alias: "grok-main@this-mac",
        launch: {
          kind: "npx",
          package: "@xai-official/grok@1.0.5",
          args: ["agent", "stdio"],
        },
        unavailableCode: undefined,
      },
    ],
  );
  assert.doesNotMatch(
    renderDashboardHtml(dashboardFixture(), { locale: "en" }),
    /Not detected|Compatibility checks/u,
  );
  assert.deepEqual(ready, [
    {
      status: "ready",
      hostId: "this-mac",
      codexMode: "native_messaging",
      dashboardFile: "gateway-dashboard.html",
    },
  ]);
  assert.deepEqual(events, [
    "config",
    "acquire-instance",
    "create-store",
    "attest-claude",
    "create-claude",
    "create-codex-operation",
    "create-codex",
    "create-peer",
    "resolve-deepseek",
    "create-deepseek",
    "create-grok",
    "start-service",
    "ready",
    "close-service",
    "close-instance",
  ]);
  assert.deepEqual(await (serviceOptions?.codexDoctor as (() => Promise<unknown>))(), { conditions: ["managed_layout_missing"] });
  doctorResolutionError = new LocalCodexTransportError("MANAGED_CODEX_INVALID");
  assert.deepEqual(await (serviceOptions?.codexDoctor as (() => Promise<unknown>))(), { conditions: ["unknown"] });
  assert.equal(doctorInspections, 1);
  assert.equal(signals.listenerCount(), 0);
});

test("a real boot snapshot passes the strict status and doctor clients", async (t) => {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-live-snapshot-"));
  await chmod(home, 0o700);
  t.after(async () => rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, "state");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: "synthetic-user",
    LOGNAME: "synthetic-user",
    EMBASSY_STATE_DIR: stateDir,
  };
  const config = loadGatewayConfig(env);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(config.stateDir, "nodes.json"), '{"version":1,"host":"this-mac","nodes":[]}', { mode: 0o600 });
  const abort = new AbortController();
  const signals = signalHarness();

  await runGatewayServer(
    {
      env,
      signal: abort.signal,
      onReady: async () => {
        const response = await sendGatewayControlRequest({
          socketPath: config.controlSocketPath,
          request: {
            protocolVersion: 1,
            method: "list_snapshot",
            params: {},
          },
        });
        assert.equal(response.ok, true);
        if (!response.ok) assert.fail("status snapshot must be successful");
        assert.deepEqual(
          response.result.routes.map(({ alias }) => alias),
          ["dsh-main@this-mac", "grok-main@this-mac"],
        );
        const deepseek = response.result.connectors.find(
          ({ provider }) => provider === "deepseek",
        );
        assert.equal(deepseek?.health, "degraded");
        assert.equal(
          deepseek?.safeErrorCode,
          "DEEPSEEK_HARNESS_HOME_UNSAFE",
        );
        assert.equal(
          response.result.connectors.every(
            ({ observationAgeMs }) => observationAgeMs !== undefined,
          ),
          true,
        );

        const stdout: string[] = [];
        const stderr: string[] = [];
        assert.equal(await runGatewayCli(["doctor"], {
          env,
          stdout: { write: (chunk) => stdout.push(String(chunk)) },
          stderr: { write: (chunk) => stderr.push(String(chunk)) },
        }), gatewayCliExitCodes.ok);
        assert.deepEqual(JSON.parse(stdout.join("")), {
          ok: true,
          command: "doctor",
          result: { conditions: ["unknown"] },
        });
        assert.deepEqual(stderr, []);
        abort.abort();
      },
    },
    {
      ...signals.dependencies,
      loginHome: () => home,
      acquireInstanceLease: async () => instanceLease(() => undefined),
      attestClaudeRuntime: async () => runtime(),
      createClaudeProvider: () => liveSnapshotProvider("claude"),
      createCodexOperation: () => statelessOperation(),
      createCodexObservationFactory: async () =>
        assert.fail("startup must not attach to a live App Server"),
      createCodexProvider: () => liveSnapshotProvider("codex"),
      resolveCodexInstallation: async () => {
        throw new LocalCodexTransportError("MANAGED_CODEX_UNAVAILABLE");
      },
      createCodexDoctorInspector: () => ({
        inspect: async () => ({ processes: [], socketHolderPids: [] }),
      }),
      resolveDeepSeekAcpLaunch: async () => ({
        safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE",
      }),
    },
  );
  assert.equal(signals.listenerCount(), 0);
});

test("assembly constructs inert operations and keeps observation attestation lazy", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const abort = new AbortController();
  const signals = signalHarness();
  const observer = factory(() => undefined);
  let operationCalls = 0;
  let observationCalls = 0;
  let providerOptions:
    | {
        createObservationFactory?: () => Promise<LocalCodexTransportFactory>;
      }
    | undefined;

  await runGatewayServer(
    {
      env,
      signal: abort.signal,
      onReady: () => abort.abort(),
    },
    {
      ...signals.dependencies,
      loadConfig: () => config,
      loginHome: () => SYNTHETIC_HOME,
      acquireInstanceLease: async () => instanceLease(() => undefined),
      attestClaudeRuntime: async () => runtime(),
      createClaudeProvider: () => provider(() => undefined),
      createStore: () => inertStore(config),
      createCodexOperation: () => {
        operationCalls += 1;
        return statelessOperation();
      },
      createCodexObservationFactory: async (options) => {
        observationCalls += 1;
        assert.equal(options.hostId, "this-mac");
        return observer;
      },
      createCodexProvider: (options) => {
        providerOptions = options;
        return provider(() => undefined);
      },
      createService: () => ({
        start: async () => {
          assert.equal(operationCalls, 1);
          assert.equal(observationCalls, 0);
          const observe = providerOptions?.createObservationFactory;
          assert.notEqual(observe, undefined);
          assert.strictEqual(await observe!(), observer);
        },
        close: async () => undefined,
      }),
    },
  );

  assert.equal(operationCalls, 1);
  assert.equal(observationCalls, 1);
  assert.equal(signals.listenerCount(), 0);
});

test("Codex startup performs no installation resolution or App Server I/O", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const abort = new AbortController();
  const signals = signalHarness();
  let installationResolutions = 0;
  let observationFactories = 0;

  await runGatewayServer(
    {
      env,
      signal: abort.signal,
      onReady: () => abort.abort(),
    },
    {
      ...signals.dependencies,
      loadConfig: () => config,
      loginHome: () => SYNTHETIC_HOME,
      acquireInstanceLease: async () => instanceLease(() => undefined),
      attestClaudeRuntime: async () => runtime(),
      createClaudeProvider: () => provider(() => undefined),
      createStore: () => inertStore(config),
      createCodexOperation: () => statelessOperation(),
      createCodexObservationFactory: async () => {
        observationFactories += 1;
        return factory(() => undefined);
      },
      resolveCodexInstallation: async () => {
        installationResolutions += 1;
        throw new Error("diagnostic resolver must remain lazy");
      },
      createCodexProvider: () => provider(() => undefined),
      createService: () => ({
        start: async () => undefined,
        close: async () => undefined,
      }),
    },
  );

  assert.equal(installationResolutions, 0);
  assert.equal(observationFactories, 0);
  assert.equal(signals.listenerCount(), 0);
});

test("assembly failure closes every resource not yet owned by a service", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const store = inertStore(config);
  const closed: string[] = [];
  Object.defineProperty(store, "close", {
    value: async () => {
      closed.push("store");
    },
  });
  const signals = signalHarness();

  await assert.rejects(
    runGatewayServer(
      { env, onReady: () => assert.fail("server must not become ready") },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        acquireInstanceLease: async () =>
          instanceLease(() => closed.push("instance")),
        attestClaudeRuntime: async () => runtime(),
        createClaudeProvider: () => provider(() => closed.push("claude")),
        createStore: () => store,
        createCodexOperation: () => statelessOperation(),
        createCodexProvider: () => {
          throw new BridgeError("SYNTHETIC_ASSEMBLY_FAILURE", "synthetic");
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "SYNTHETIC_ASSEMBLY_FAILURE",
  );
  assert.deepEqual(closed, ["claude", "store", "instance"]);
  assert.equal(signals.listenerCount(), 0);
});

test("state preflight preserves both unsupported-schema and cleanup failures", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const signals = signalHarness();
  const events: string[] = [];
  const store = {
    initialize: async (options: { deferPersistence?: boolean }) => {
      events.push("initialize-store");
      assert.deepEqual(options, { deferPersistence: true });
      throw new BridgeError(
        "GATEWAY_STATE_SCHEMA_UNSUPPORTED",
        "synthetic old state requires reset",
      );
    },
    close: async () => {
      events.push("close-store");
      throw new Error("synthetic cleanup failure");
    },
  } as unknown as GatewayStore;

  await assert.rejects(
    runGatewayServer(
      { env, onReady: () => assert.fail("server must not become ready") },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        acquireInstanceLease: async () =>
          instanceLease(() => events.push("close-instance")),
        createStore: () => {
          events.push("create-store");
          return store;
        },
        attestClaudeRuntime: async () => {
          events.push("attest-claude");
          return runtime();
        },
        createClaudeProvider: () => {
          events.push("create-claude");
          return provider(() => undefined);
        },
      },
    ),
    (error: unknown) => {
      if (
        !(error instanceof BridgeError) ||
        error.code !== "GATEWAY_CLEANUP_FAILED"
      ) {
        return false;
      }
      const cause = (error as BridgeError & { cause?: unknown }).cause;
      assert.ok(cause instanceof AggregateError);
      assert.equal(cause.errors.length, 2);
      assert.ok(cause.errors[0] instanceof BridgeError);
      assert.equal(
        (cause.errors[0] as BridgeError).code,
        "GATEWAY_STATE_SCHEMA_UNSUPPORTED",
      );
      assert.ok(cause.errors[1] instanceof AggregateError);
      assert.equal((cause.errors[1] as AggregateError).errors.length, 1);
      assert.match(
        String((cause.errors[1] as AggregateError).errors[0]),
        /synthetic cleanup failure/u,
      );
      return true;
    },
  );
  assert.deepEqual(events, [
    "create-store",
    "initialize-store",
    "close-store",
  ]);
  assert.equal(signals.listenerCount(), 0);
});

test("instance ownership is acquired before provider setup and released after setup failure", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/alternate-controller-state",
  };
  const config = loadGatewayConfig(env);
  const signals = signalHarness();
  const events: string[] = [];

  await assert.rejects(
    runGatewayServer(
      { env, onReady: () => assert.fail("server must not become ready") },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        createStore: inertStore,
        acquireInstanceLease: async () => {
          events.push("acquire-instance");
          return instanceLease(() => events.push("close-instance"));
        },
        attestClaudeRuntime: async () => {
          events.push("attest-claude");
          throw new BridgeError("SYNTHETIC_ATTEST_FAILURE", "synthetic");
        },
        createClaudeProvider: () => {
          events.push("create-claude");
          return provider(() => undefined);
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "SYNTHETIC_ATTEST_FAILURE",
  );
  assert.deepEqual(events, [
    "acquire-instance",
    "attest-claude",
    "close-instance",
  ]);
  assert.equal(signals.listenerCount(), 0);
});

test("a service cleanup failure keeps the host-wide instance lease held", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const abort = new AbortController();
  const signals = signalHarness();
  const events: string[] = [];

  await assert.rejects(
    runGatewayServer(
      {
        env,
        signal: abort.signal,
        onReady: () => abort.abort(),
      },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        acquireInstanceLease: async () =>
          instanceLease(() => events.push("close-instance")),
        attestClaudeRuntime: async () => runtime(),
        createClaudeProvider: () => provider(() => undefined),
        createStore: () => inertStore(config),
        createCodexOperation: () => statelessOperation(),
        createCodexProvider: () => provider(() => undefined),
        createService: () => ({
          start: async () => undefined,
          close: async () => {
            events.push("close-service");
            throw new Error("synthetic service cleanup failure");
          },
        }),
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_CLEANUP_FAILED",
  );
  assert.deepEqual(events, ["close-service"]);
  assert.equal(signals.listenerCount(), 0);
});

test("an instance-lease cleanup failure is normalized", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const abort = new AbortController();
  const signals = signalHarness();
  const events: string[] = [];

  await assert.rejects(
    runGatewayServer(
      {
        env,
        signal: abort.signal,
        onReady: () => abort.abort(),
      },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        acquireInstanceLease: async () =>
          instanceLease(() => {
            events.push("close-instance");
            throw new Error("synthetic instance cleanup failure");
          }),
        attestClaudeRuntime: async () => runtime(),
        createClaudeProvider: () => provider(() => undefined),
        createStore: () => inertStore(config),
        createCodexOperation: () => statelessOperation(),
        createCodexProvider: () => provider(() => undefined),
        createService: () => ({
          start: async () => undefined,
          close: async () => {
            events.push("close-service");
          },
        }),
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "GATEWAY_CLEANUP_FAILED",
  );
  assert.deepEqual(events, ["close-service", "close-instance"]);
  assert.equal(signals.listenerCount(), 0);
});

test("unexpected host lease loss stops the service before releasing instance ownership", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const signals = signalHarness();
  const events: string[] = [];
  let serviceClosed = false;
  const lease = leaseLossHarness(() => {
    assert.equal(serviceClosed, true);
    events.push("close-instance");
  });
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const running = runGatewayServer(
    {
      env,
      onReady: () => {
        events.push("ready");
        markReady?.();
      },
    },
    {
      ...signals.dependencies,
      loadConfig: () => config,
      loginHome: () => SYNTHETIC_HOME,
      acquireInstanceLease: async () => lease.lease,
      attestClaudeRuntime: async () => runtime(),
      createClaudeProvider: () => provider(() => undefined),
      createStore: () => inertStore(config),
      createCodexOperation: () => statelessOperation(),
      createCodexProvider: () => provider(() => undefined),
      createService: () => ({
        start: async () => {
          events.push("start-service");
        },
        close: async () => {
          serviceClosed = true;
          events.push("close-service");
        },
      }),
    },
  );
  await ready;
  lease.lose();

  await assert.rejects(
    running,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_INSTANCE_LEASE_LOST" &&
      error.recoverable === true &&
      !error.message.includes(SYNTHETIC_HOME),
  );
  assert.deepEqual(events, [
    "start-service",
    "ready",
    "close-service",
    "close-instance",
  ]);
  assert.equal(signals.listenerCount(), 0);
});

test("lease loss during service start prevents readiness and cleans up", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const signals = signalHarness();
  const events: string[] = [];
  const lease = leaseLossHarness(() => events.push("close-instance"));
  let markStartEntered: (() => void) | undefined;
  const startEntered = new Promise<void>((resolve) => {
    markStartEntered = resolve;
  });
  const startNeverFinishes = new Promise<void>(() => undefined);

  const running = runGatewayServer(
    {
      env,
      onReady: () => assert.fail("a lease-less server must not become ready"),
    },
    {
      ...signals.dependencies,
      loadConfig: () => config,
      loginHome: () => SYNTHETIC_HOME,
      acquireInstanceLease: async () => lease.lease,
      attestClaudeRuntime: async () => runtime(),
      createClaudeProvider: () => provider(() => undefined),
      createStore: () => inertStore(config),
      createCodexOperation: () => statelessOperation(),
      createCodexProvider: () => provider(() => undefined),
      createService: () => ({
        start: async () => {
          events.push("start-service");
          markStartEntered?.();
          await startNeverFinishes;
        },
        close: async () => {
          events.push("close-service");
        },
      }),
    },
  );
  await startEntered;
  lease.lose();

  await assert.rejects(
    running,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GATEWAY_INSTANCE_LEASE_LOST",
  );
  assert.deepEqual(events, [
    "start-service",
    "close-service",
    "close-instance",
  ]);
  assert.equal(signals.listenerCount(), 0);
});

test(
  "SIGTERM cancels a never-resolving service start without publishing ready",
  { timeout: 1_000 },
  async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: SYNTHETIC_HOME,
      EMBASSY_STATE_DIR: "/synthetic/controller-state",
    };
    const config = loadGatewayConfig(env);
    const signals = signalHarness();
    const events: string[] = [];
    let startSignal: AbortSignal | undefined;
    let markStartEntered: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const startNeverFinishes = new Promise<void>(() => undefined);

    const running = runGatewayServer(
      {
        env,
        onReady: () => assert.fail("a cancelled startup must not become ready"),
      },
      {
        ...signals.dependencies,
        loadConfig: () => config,
        loginHome: () => SYNTHETIC_HOME,
        acquireInstanceLease: async () =>
          instanceLease(() => events.push("close-instance")),
        attestClaudeRuntime: async () => runtime(),
        createClaudeProvider: () => provider(() => undefined),
        createStore: () => inertStore(config),
        createCodexOperation: () => statelessOperation(),
        createCodexProvider: () => provider(() => undefined),
        createService: () => ({
          start: async (signal) => {
            events.push("start-service");
            startSignal = signal;
            markStartEntered?.();
            await startNeverFinishes;
          },
          close: async () => {
            events.push("close-service");
          },
        }),
      },
    );
    await startEntered;
    assert.notEqual(startSignal, undefined);
    assert.equal(startSignal?.aborted, false);
    signals.emit("SIGTERM");

    await assert.rejects(
      running,
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "GATEWAY_START_CANCELLED" &&
        error.recoverable === true,
    );
    assert.equal(startSignal?.aborted, true);
    assert.deepEqual(events, [
      "start-service",
      "close-service",
      "close-instance",
    ]);
    assert.equal(signals.listenerCount(), 0);
  },
);

test(
  "different EMBASSY_STATE_DIR values cannot start two controllers for one login home",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await mkdtemp(path.join("/private/tmp", "esl-"));
    await chmod(home, 0o700);
    t.after(async () => rm(home, { recursive: true, force: true }));
    const firstAbort = new AbortController();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    let attestCalls = 0;
    const common: GatewayServerDependencies = {
      loginHome: () => home,
      addSignalListener: () => undefined,
      removeSignalListener: () => undefined,
      attestClaudeRuntime: async () => {
        attestCalls += 1;
        return runtime();
      },
      createClaudeProvider: () => provider(() => undefined),
      createStore: (config) => inertStore(config),
      createCodexOperation: () => statelessOperation(),
      createCodexProvider: () => provider(() => undefined),
      createService: () => ({
        start: async () => undefined,
        close: async () => undefined,
      }),
    };
    const firstConfig = loadGatewayConfig({
      EMBASSY_STATE_DIR: path.join(home, "state-one"),
    });
    const first = runGatewayServer(
      {
        env: {},
        signal: firstAbort.signal,
        onReady: () => markReady?.(),
      },
      { ...common, loadConfig: () => firstConfig },
    );
    await ready;

    const secondConfig = loadGatewayConfig({
      EMBASSY_STATE_DIR: path.join(home, "state-two"),
    });
    await assert.rejects(
      runGatewayServer(
        {
          env: {},
          onReady: () => assert.fail("second server must not start"),
        },
        { ...common, loadConfig: () => secondConfig },
      ),
      (error: unknown) =>
        error instanceof BridgeError && error.code === "GATEWAY_INSTANCE_IN_USE",
    );
    assert.equal(attestCalls, 1);
    firstAbort.abort();
    await first;
  },
);
