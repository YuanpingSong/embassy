import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import type { LocalCodexTransportFactory } from "../src/gateway/codex-local-transport.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
import type { GatewayInstanceLease } from "../src/gateway/instance-lease.js";
import type {
  LocalClaudeGatewayProvider,
  LocalCodexGatewayProvider,
} from "../src/gateway/providers.js";
import {
  resolveGatewayClaudeLauncher,
  runGatewayServer,
  type GatewayServerDependencies,
  type GatewayServerReadyResult,
} from "../src/gateway/server.js";
import { GatewayStore } from "../src/gateway/store.js";

const SYNTHETIC_HOME = "/synthetic/login-home";
const SYNTHETIC_LAUNCHER = "/synthetic/login-home/.local/bin/claude";
const SYNTHETIC_SECRET = "SYNTHETIC_CREDENTIAL_MUST_NOT_BE_FORWARDED";

function runtime(): AttestedClaudePeerRuntime {
  return {
    claudeExecutable:
      "/synthetic/login-home/.local/share/claude/versions/2.1.225",
    claudeCodeVersion: "2.1.225",
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

function factory(onClose: () => void): LocalCodexTransportFactory {
  return {
    endpointGeneration: "synthetic_endpoint_generation",
    close: async () => onClose(),
  } as unknown as LocalCodexTransportFactory;
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

test("foreground assembly stays local, enables native messaging, sanitizes, and closes on abort", async () => {
  const stateDir = "/synthetic/controller-state";
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    USER: "synthetic-user",
    LOGNAME: "synthetic-user",
    EMBASSY_STATE_DIR: stateDir,
    EMBASSY_CLAUDE_BIN: SYNTHETIC_LAUNCHER,
    ANTHROPIC_API_KEY: SYNTHETIC_SECRET,
    CLAUDE_CODE_MESSAGING_SOCKET: "/synthetic/private/provider.sock",
    CODEX_THREAD_ID: "00000000-0000-7000-8000-000000000701",
  };
  const config = loadGatewayConfig(env);
  const store = new GatewayStore(config);
  const abort = new AbortController();
  const signals = signalHarness();
  const events: string[] = [];
  const ready: GatewayServerReadyResult[] = [];
  let claudeOptions: unknown;
  let codexFactoryOptions: Record<string, unknown> | undefined;
  let codexProviderOptions: Record<string, unknown> | undefined;
  let serviceOptions: Record<string, unknown> | undefined;

  await runGatewayServer(
    {
      env,
      locale: "zh-CN",
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
      attestClaudeRuntime: async (options) => {
        events.push("attest-claude");
        claudeOptions = options;
        return runtime();
      },
      createClaudeProvider: (options) => {
        events.push("create-claude");
        assert.deepEqual(options.runtime, runtime());
        assert.equal(options.locale, "zh-CN");
        return provider(() => events.push("close-claude"));
      },
      createStore: (received) => {
        events.push("create-store");
        assert.equal(received, config);
        return store;
      },
      createCodexFactory: async (options) => {
        events.push("create-codex-factory");
        codexFactoryOptions = options as unknown as Record<string, unknown>;
        return factory(() => events.push("close-codex-factory"));
      },
      createCodexProvider: (options) => {
        events.push("create-codex");
        codexProviderOptions = options as unknown as Record<string, unknown>;
        return provider(() => events.push("close-codex"));
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

  assert.deepEqual(claudeOptions, { claudeExecutable: SYNTHETIC_LAUNCHER });
  assert.equal(codexFactoryOptions?.appServerVersion, "0.147.0");
  assert.equal(codexFactoryOptions?.hostId, "this-mac");
  assert.equal(codexFactoryOptions?.writableProtocolAttested, true);
  assert.deepEqual(codexFactoryOptions?.environment, {
    HOME: SYNTHETIC_HOME,
    USER: "synthetic-user",
    LOGNAME: "synthetic-user",
  });
  assert.equal(
    JSON.stringify(codexFactoryOptions).includes(SYNTHETIC_SECRET),
    false,
  );
  assert.deepEqual(Object.keys(codexProviderOptions ?? {}), ["factory"]);
  assert.equal(serviceOptions?.store, store);
  assert.equal(
    (serviceOptions?.adapters as readonly unknown[] | undefined)?.length,
    2,
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
    "attest-claude",
    "create-claude",
    "create-store",
    "create-codex-factory",
    "create-codex",
    "start-service",
    "ready",
    "close-service",
    "close-instance",
  ]);
  assert.equal(signals.listenerCount(), 0);
});

test("assembly failure closes every resource not yet owned by a service", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: SYNTHETIC_HOME,
    EMBASSY_STATE_DIR: "/synthetic/controller-state",
  };
  const config = loadGatewayConfig(env);
  const store = new GatewayStore(config);
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
        createCodexFactory: async () =>
          factory(() => closed.push("codex-factory")),
        createCodexProvider: () => {
          throw new BridgeError("SYNTHETIC_ASSEMBLY_FAILURE", "synthetic");
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "SYNTHETIC_ASSEMBLY_FAILURE",
  );
  assert.deepEqual(closed, ["codex-factory", "claude", "store", "instance"]);
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

test("a service cleanup failure still releases the host-wide instance lease", async () => {
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
        createStore: () => new GatewayStore(config),
        createCodexFactory: async () => factory(() => undefined),
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
  assert.deepEqual(events, ["close-service", "close-instance"]);
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
        createStore: () => new GatewayStore(config),
        createCodexFactory: async () => factory(() => undefined),
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
      createStore: () => new GatewayStore(config),
      createCodexFactory: async () => factory(() => undefined),
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
      createStore: () => new GatewayStore(config),
      createCodexFactory: async () => factory(() => undefined),
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
  "different EMBASSY_STATE_DIR values cannot start two controllers for one login home",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const temporary = await realpath(os.tmpdir());
    const home = await mkdtemp(path.join(temporary, "embassy-server-lease-"));
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
      createStore: (config) => new GatewayStore(config),
      createCodexFactory: async () => factory(() => undefined),
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

test("launcher resolution uses only an explicit path or the official local default", () => {
  assert.equal(
    resolveGatewayClaudeLauncher({}, SYNTHETIC_HOME),
    SYNTHETIC_LAUNCHER,
  );
  assert.equal(
    resolveGatewayClaudeLauncher(
      { EMBASSY_CLAUDE_BIN: "/synthetic/custom/bin/claude" },
      SYNTHETIC_HOME,
    ),
    "/synthetic/custom/bin/claude",
  );
  assert.throws(
    () =>
      resolveGatewayClaudeLauncher(
        { EMBASSY_CLAUDE_BIN: "claude" },
        SYNTHETIC_HOME,
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_CLAUDE_EXECUTABLE",
  );
  assert.throws(
    () => resolveGatewayClaudeLauncher({}, path.relative("/", SYNTHETIC_HOME)),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "INVALID_CLAUDE_EXECUTABLE",
  );
});
