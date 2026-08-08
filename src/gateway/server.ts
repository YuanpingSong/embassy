import { userInfo } from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  attestClaudePeerRuntime,
  type AttestedClaudePeerRuntime,
  type ClaudePeerRuntimeOptions,
} from "./claude-runtime.js";
import {
  createLocalCodexTransportFactory,
  type LocalCodexTransportFactory,
  type LocalCodexTransportFactoryOptions,
} from "./codex-local-transport.js";
import {
  loadGatewayConfig,
  type GatewayConfig,
} from "./config.js";
import { DASHBOARD_FILE_NAME } from "./dashboard.js";
import {
  acquireGatewayInstanceLease,
  type GatewayInstanceLease,
} from "./instance-lease.js";
import {
  createLocalClaudeGatewayProvider,
  createLocalCodexGatewayProvider,
  type LocalClaudeGatewayProvider,
  type LocalClaudeGatewayProviderOptions,
  type LocalCodexGatewayProvider,
  type LocalCodexGatewayProviderOptions,
} from "./providers.js";
import {
  GatewayService,
  type GatewayProviderAdapter,
  type GatewayServiceOptions,
} from "./service.js";
import { GatewayStore } from "./store.js";

export const GATEWAY_CODEX_APP_SERVER_VERSION = "0.147.0";
export const GATEWAY_LOCAL_HOST_ID = "this-mac";

export type GatewayServerReadyResult = Readonly<{
  status: "ready";
  hostId: typeof GATEWAY_LOCAL_HOST_ID;
  codexMode: "native_messaging";
  dashboardFile: typeof DASHBOARD_FILE_NAME;
}>;

export type GatewayServerOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onReady: (
    result: GatewayServerReadyResult,
  ) => void | Promise<void>;
};

type GatewayServerService = Readonly<{
  /** Close must cancel partial startup and prevent later activation. */
  start: (signal?: AbortSignal) => Promise<void>;
  close: () => Promise<void>;
}>;
type GatewaySignal = "SIGINT" | "SIGTERM";

export type GatewayServerDependencies = {
  loadConfig?: (env: NodeJS.ProcessEnv) => GatewayConfig;
  loginHome?: () => string;
  attestClaudeRuntime?: (
    options: ClaudePeerRuntimeOptions,
  ) => Promise<AttestedClaudePeerRuntime>;
  createClaudeProvider?: (
    options: LocalClaudeGatewayProviderOptions,
  ) => LocalClaudeGatewayProvider;
  acquireInstanceLease?: (loginHome: string) => Promise<GatewayInstanceLease>;
  createStore?: (config: GatewayConfig) => GatewayStore;
  createCodexFactory?: (
    options: LocalCodexTransportFactoryOptions,
  ) => Promise<LocalCodexTransportFactory>;
  createCodexProvider?: (
    options: LocalCodexGatewayProviderOptions,
  ) => LocalCodexGatewayProvider;
  createService?: (options: GatewayServiceOptions) => GatewayServerService;
  addSignalListener?: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void;
  removeSignalListener?: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void;
};

type ShutdownLatch = {
  wait: Promise<void>;
  dispose: () => void;
};

function instanceLeaseLostError(): BridgeError {
  return new BridgeError(
    "GATEWAY_INSTANCE_LEASE_LOST",
    "Embassy lost its host-wide gateway lease and shut down.",
    true,
  );
}

/**
 * Resolve only the explicit launcher or the official per-user launcher. The
 * gateway intentionally never searches PATH or an interactive shell profile.
 */
export function resolveGatewayClaudeLauncher(
  env: NodeJS.ProcessEnv,
  loginHome: string,
): string {
  const configured = env.EMBASSY_CLAUDE_BIN;
  const launcher =
    configured ?? path.join(loginHome, ".local", "bin", "claude");
  if (
    !path.isAbsolute(loginHome) ||
    path.resolve(loginHome) !== loginHome ||
    loginHome.includes("\0") ||
    !path.isAbsolute(launcher) ||
    path.resolve(launcher) !== launcher ||
    launcher.includes("\0") ||
    path.basename(launcher) !== "claude"
  ) {
    throw new BridgeError(
      "INVALID_CLAUDE_EXECUTABLE",
      "The gateway requires the explicit or official absolute Claude launcher path.",
    );
  }
  return launcher;
}

function localCodexProviderEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function createShutdownLatch(
  signal: AbortSignal | undefined,
  addSignalListener: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void,
  removeSignalListener: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void,
): ShutdownLatch {
  let resolveWait: (() => void) | undefined;
  let settled = false;
  let disposed = false;
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const stop = (): void => {
    if (settled) return;
    settled = true;
    resolveWait?.();
  };
  const onSigint = (): void => stop();
  const onSigterm = (): void => stop();

  try {
    addSignalListener("SIGINT", onSigint);
    try {
      addSignalListener("SIGTERM", onSigterm);
    } catch (error) {
      removeSignalListener("SIGINT", onSigint);
      throw error;
    }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted === true) stop();
  } catch (error) {
    signal?.removeEventListener("abort", stop);
    throw error;
  }

  return {
    wait,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      removeSignalListener("SIGINT", onSigint);
      removeSignalListener("SIGTERM", onSigterm);
      signal?.removeEventListener("abort", stop);
    },
  };
}

async function closeUnownedAssembly(input: {
  claudeProvider?: GatewayProviderAdapter;
  codexFactory?: LocalCodexTransportFactory;
  codexProvider?: GatewayProviderAdapter;
  store?: GatewayStore;
}): Promise<void> {
  const failures: unknown[] = [];
  if (input.codexProvider !== undefined) {
    await input.codexProvider.close().catch((error: unknown) => {
      failures.push(error);
    });
  } else if (input.codexFactory !== undefined) {
    await input.codexFactory.close().catch((error: unknown) => {
      failures.push(error);
    });
  }
  await input.claudeProvider?.close().catch((error: unknown) => {
    failures.push(error);
  });
  await input.store?.close().catch((error: unknown) => {
    failures.push(error);
  });
  if (failures.length > 0) {
    throw new BridgeError(
      "GATEWAY_CLEANUP_FAILED",
      "The local gateway could not confirm exact resource cleanup.",
    );
  }
}

/**
 * Assemble and run the foreground local gateway. This function never starts a
 * daemon, remote connector, provider request, or writable Codex route.
 */
export async function runGatewayServer(
  options: GatewayServerOptions,
  dependencies: GatewayServerDependencies = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const loadConfig = dependencies.loadConfig ?? loadGatewayConfig;
  const loginHome = dependencies.loginHome ?? (() => userInfo().homedir);
  const attestClaudeRuntime =
    dependencies.attestClaudeRuntime ?? attestClaudePeerRuntime;
  const createClaudeProvider =
    dependencies.createClaudeProvider ?? createLocalClaudeGatewayProvider;
  const acquireInstanceLease =
    dependencies.acquireInstanceLease ?? acquireGatewayInstanceLease;
  const createStore =
    dependencies.createStore ?? ((config) => new GatewayStore(config));
  const createCodexFactory =
    dependencies.createCodexFactory ?? createLocalCodexTransportFactory;
  const createCodexProvider =
    dependencies.createCodexProvider ?? createLocalCodexGatewayProvider;
  const createService =
    dependencies.createService ??
    ((serviceOptions) => new GatewayService(serviceOptions));
  const addSignalListener =
    dependencies.addSignalListener ??
    ((signal, listener) => process.on(signal, listener));
  const removeSignalListener =
    dependencies.removeSignalListener ??
    ((signal, listener) => process.off(signal, listener));

  const shutdown = createShutdownLatch(
    options.signal,
    addSignalListener,
    removeSignalListener,
  );
  let claudeProvider: LocalClaudeGatewayProvider | undefined;
  let codexFactory: LocalCodexTransportFactory | undefined;
  let codexProvider: LocalCodexGatewayProvider | undefined;
  let store: GatewayStore | undefined;
  let service: GatewayServerService | undefined;
  let instanceLease: GatewayInstanceLease | undefined;
  let startupAbort: AbortController | undefined;

  try {
    const config = loadConfig(env);
    if (
      config.allowedHosts.length !== 1 ||
      config.allowedHosts[0] !== GATEWAY_LOCAL_HOST_ID
    ) {
      throw new BridgeError(
        "GATEWAY_REMOTE_PROVIDER_DISABLED",
        "This launcher supports only the exact local gateway host.",
      );
    }
    const resolvedLoginHome = loginHome();
    const claudeExecutable = resolveGatewayClaudeLauncher(
      env,
      resolvedLoginHome,
    );
    const acquiredLease = await acquireInstanceLease(resolvedLoginHome);
    instanceLease = acquiredLease;
    startupAbort = new AbortController();
    const leaseLoss = acquiredLease.lost.then(() => {
      startupAbort?.abort();
      return { kind: "lease_lost" } as const;
    });
    const assertLeaseHeld = (): void => {
      if (acquiredLease.isLost()) throw instanceLeaseLostError();
    };
    const awaitWhileLeaseHeld = async <T>(
      operation: Promise<T>,
      cleanLateResult?: (result: T) => Promise<void>,
    ): Promise<T> => {
      assertLeaseHeld();
      const observed = operation.then(
        (result) => ({ kind: "result", result }) as const,
        (error: unknown) => ({ kind: "error", error }) as const,
      );
      const outcome = await Promise.race([observed, leaseLoss]);
      if (outcome.kind === "lease_lost") {
        if (cleanLateResult !== undefined) {
          void observed.then(async (late) => {
            if (late.kind === "result") {
              try {
                await cleanLateResult(late.result);
              } catch {
                // The foreground server has already failed closed. The late
                // factory owns no route yet; this best-effort callback only
                // prevents a delayed constructor from retaining resources.
              }
            }
          });
        }
        throw instanceLeaseLostError();
      }
      assertLeaseHeld();
      if (outcome.kind === "error") throw outcome.error;
      return outcome.result;
    };
    assertLeaseHeld();
    const runtime = await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        attestClaudeRuntime({ claudeExecutable }),
      ),
    );
    claudeProvider = createClaudeProvider({ runtime });
    store = createStore(config);
    const createdCodexFactory = await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        createCodexFactory({
          appServerVersion: GATEWAY_CODEX_APP_SERVER_VERSION,
          environment: localCodexProviderEnvironment(env),
          hostId: GATEWAY_LOCAL_HOST_ID,
          writableProtocolAttested: true,
        }),
      ),
      async (lateFactory) => lateFactory.close(),
    );
    codexFactory = createdCodexFactory;
    codexProvider = createCodexProvider({
      factory: createdCodexFactory,
    });
    const createdService = createService({
      config,
      adapters: [claudeProvider, codexProvider],
      store,
    });
    service = createdService;
    await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        createdService.start(startupAbort?.signal),
      ),
    );
    await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        options.onReady({
          status: "ready",
          hostId: GATEWAY_LOCAL_HOST_ID,
          codexMode: "native_messaging",
          dashboardFile: DASHBOARD_FILE_NAME,
        }),
      ),
    );
    const lifetime = await Promise.race([
      shutdown.wait.then(() => ({ kind: "shutdown" }) as const),
      leaseLoss,
    ]);
    if (lifetime.kind === "lease_lost") throw instanceLeaseLostError();
  } finally {
    startupAbort?.abort();
    shutdown.dispose();
    const cleanupFailures: unknown[] = [];
    if (service !== undefined) {
      await service.close().catch((error: unknown) => {
        cleanupFailures.push(error);
      });
    } else {
      await closeUnownedAssembly({
        ...(claudeProvider === undefined ? {} : { claudeProvider }),
        ...(codexFactory === undefined ? {} : { codexFactory }),
        ...(codexProvider === undefined ? {} : { codexProvider }),
        ...(store === undefined ? {} : { store }),
      }).catch((error: unknown) => {
        cleanupFailures.push(error);
      });
    }
    await instanceLease?.close().catch((error: unknown) => {
      cleanupFailures.push(error);
    });
    if (cleanupFailures.length > 0) {
      throw new BridgeError(
        "GATEWAY_CLEANUP_FAILED",
        "The local gateway could not confirm exact resource cleanup.",
      );
    }
  }
}
