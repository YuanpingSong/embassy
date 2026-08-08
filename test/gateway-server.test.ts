import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import type { AttestedClaudePeerRuntime } from "../src/gateway/claude-runtime.js";
import type { LocalCodexTransportFactory } from "../src/gateway/codex-local-transport.js";
import { loadGatewayConfig } from "../src/gateway/config.js";
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
      attestClaudeRuntime: async (options) => {
        events.push("attest-claude");
        claudeOptions = options;
        return runtime();
      },
      createClaudeProvider: (options) => {
        events.push("create-claude");
        assert.deepEqual(options.runtime, runtime());
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
    "attest-claude",
    "create-claude",
    "create-store",
    "create-codex-factory",
    "create-codex",
    "start-service",
    "ready",
    "close-service",
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
  assert.deepEqual(closed, ["codex-factory", "claude", "store"]);
  assert.equal(signals.listenerCount(), 0);
});

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
