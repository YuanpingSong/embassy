import { userInfo } from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import {
  createAcpGatewayProvider,
  type AcpGatewayProviderOptions,
} from "./acp-provider.js";
import type { AcpLaunchSpec } from "./acp-client.js";
import {
  attestClaudePeerRuntime,
  type AttestedClaudePeerRuntime,
  type ClaudePeerRuntimeOptions,
} from "./claude-runtime.js";
import {
  createLocalCodexTransportFactory,
  resolveManagedLocalCodexInstallation,
  type ManagedLocalCodexInstallation,
  type LocalCodexTransportFactory,
  type LocalCodexTransportFactoryOptions,
} from "./codex-local-transport.js";
import {
  createStatelessCodexOperationTransport,
  type StatelessCodexOperationTransport,
  type StatelessCodexOperationTransportOptions,
} from "./codex-stateless-transport.js";
import {
  createSystemCodexDoctorInspector,
  diagnoseCodexAttachment,
} from "./codex-doctor.js";
import {
  loadGatewayConfig,
  type GatewayConfig,
} from "./config.js";
import { DASHBOARD_FILE_NAME } from "./dashboard.js";
import {
  resolveDeepSeekAcpLaunch,
  type DeepSeekAcpLaunch,
  type DeepSeekDetectOptions,
} from "./deepseek-detect.js";
import {
  acquireGatewayInstanceLease,
  type GatewayInstanceLease,
} from "./instance-lease.js";
import type { DashboardLocale } from "./locale.js";
import {
  createLocalClaudeGatewayProvider,
  createLocalCodexGatewayProvider,
  type LocalClaudeGatewayProviderOptions,
  type LocalCodexGatewayProviderOptions,
} from "./providers.js";
import {
  GatewayService,
  type GatewayProviderAdapter,
  type GatewayServiceOptions,
} from "./service.js";
import { GatewayStore } from "./store.js";
import {
  gatewayInboundModes,
  type GatewayInboundMode,
} from "./types.js";

export const GATEWAY_LOCAL_HOST_ID = "this-mac";
const GROK_ACP_LAUNCH = Object.freeze({
  kind: "npx",
  package: "@xai-official/grok@1.0.5",
  args: ["agent", "stdio"],
} satisfies AcpLaunchSpec);

export type GatewayServerReadyResult = Readonly<{
  status: "ready";
  hostId: typeof GATEWAY_LOCAL_HOST_ID;
  codexMode: "native_messaging";
  dashboardFile: typeof DASHBOARD_FILE_NAME;
}>;

export type GatewayServerOptions = {
  env?: NodeJS.ProcessEnv;
  /** Defaults to paired; only the explicit CLI flag may opt into open. */
  inboundMode?: GatewayInboundMode;
  /** Locale for bounded user-visible notices emitted by the broker. */
  locale?: DashboardLocale;
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
  ) => GatewayProviderAdapter;
  acquireInstanceLease?: (loginHome: string) => Promise<GatewayInstanceLease>;
  createStore?: (config: GatewayConfig) => GatewayStore;
  createCodexOperation?: (
    options: StatelessCodexOperationTransportOptions,
  ) => StatelessCodexOperationTransport;
  /** Observation is independent and never supplies routing authority. */
  createCodexObservationFactory?: (
    options: LocalCodexTransportFactoryOptions,
  ) => Promise<LocalCodexTransportFactory>;
  resolveCodexInstallation?: (
    home: string,
  ) => Promise<ManagedLocalCodexInstallation>;
  createCodexProvider?: (
    options: LocalCodexGatewayProviderOptions,
  ) => GatewayProviderAdapter;
  resolveDeepSeekAcpLaunch?: (
    options: DeepSeekDetectOptions,
  ) => Promise<DeepSeekAcpLaunch>;
  createAcpProvider?: (
    options: AcpGatewayProviderOptions,
  ) => GatewayProviderAdapter;
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

function gatewayStartCancelledError(): BridgeError {
  return new BridgeError(
    "GATEWAY_START_CANCELLED",
    "Gateway startup was cancelled before it became ready.",
    true,
  );
}

function cleanupFailure(
  primary: unknown,
  failures: readonly unknown[],
): BridgeError {
  const error = new BridgeError(
    "GATEWAY_CLEANUP_FAILED",
    "The local gateway could not confirm exact resource cleanup.",
  ) as BridgeError & { cause?: unknown };
  error.cause = new AggregateError(
    primary === undefined ? [...failures] : [primary, ...failures],
    "Gateway execution and cleanup failures are preserved independently.",
  );
  return error;
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
  codexProvider?: GatewayProviderAdapter;
  acpProviders?: readonly GatewayProviderAdapter[];
  store?: GatewayStore;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const provider of input.acpProviders ?? []) {
    await provider.close().catch((error: unknown) => failures.push(error));
  }
  if (input.codexProvider !== undefined) {
    await input.codexProvider.close().catch((error: unknown) => {
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
    throw new AggregateError(
      failures,
      "One or more unowned gateway resources did not confirm cleanup.",
    );
  }
}

/**
 * Assemble and run the foreground local gateway. This function never starts a
 * daemon, remote connector, or provider request.
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
  const createCodexOperation =
    dependencies.createCodexOperation ?? createStatelessCodexOperationTransport;
  const createCodexObservationFactory =
    dependencies.createCodexObservationFactory ??
    createLocalCodexTransportFactory;
  const resolveCodexInstallation =
    dependencies.resolveCodexInstallation ??
    resolveManagedLocalCodexInstallation;
  const createCodexProvider =
    dependencies.createCodexProvider ?? createLocalCodexGatewayProvider;
  const resolveDeepSeek =
    dependencies.resolveDeepSeekAcpLaunch ?? resolveDeepSeekAcpLaunch;
  const createAcpProvider =
    dependencies.createAcpProvider ?? createAcpGatewayProvider;
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
  let claudeProvider: GatewayProviderAdapter | undefined;
  let codexProvider: GatewayProviderAdapter | undefined;
  const acpProviders: GatewayProviderAdapter[] = [];
  let store: GatewayStore | undefined;
  let service: GatewayServerService | undefined;
  let instanceLease: GatewayInstanceLease | undefined;
  let startupAbort: AbortController | undefined;
  let primaryFailure: unknown;
  let shutdownSeen = false;
  const shutdownRequested = shutdown.wait.then(() => {
    shutdownSeen = true;
    startupAbort?.abort();
    return { kind: "shutdown" } as const;
  });

  try {
    const loadedConfig = loadConfig(env);
    const inboundMode = options.inboundMode ?? loadedConfig.inboundMode;
    if (!(gatewayInboundModes as readonly string[]).includes(inboundMode)) {
      throw new BridgeError(
        "INVALID_GATEWAY_CONFIGURATION",
        "The gateway inbound mode must be paired or open.",
      );
    }
    const config: GatewayConfig = {
      ...loadedConfig,
      inboundMode,
    };
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
    const leaseAcquisition = acquireInstanceLease(resolvedLoginHome).then(
      (lease) => ({ kind: "lease" as const, lease }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const acquired = await Promise.race([leaseAcquisition, shutdownRequested]);
    if (acquired.kind === "shutdown") {
      void leaseAcquisition.then(async (late) => {
        if (late.kind === "lease") await late.lease.close().catch(() => undefined);
      });
      throw gatewayStartCancelledError();
    }
    if (acquired.kind === "error") throw acquired.error;
    const acquiredLease = acquired.lease;
    instanceLease = acquiredLease;
    startupAbort = new AbortController();
    const leaseLoss = acquiredLease.lost.then(() => {
      startupAbort?.abort();
      return { kind: "lease_lost" } as const;
    });
    const assertLeaseHeld = (): void => {
      if (shutdownSeen) throw gatewayStartCancelledError();
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
      const outcome = await Promise.race([
        observed,
        leaseLoss,
        shutdownRequested,
      ]);
      if (outcome.kind === "shutdown") {
        if (cleanLateResult !== undefined) {
          void observed.then(async (late) => {
            if (late.kind === "result") {
              await cleanLateResult(late.result).catch(() => undefined);
            }
          });
        }
        throw gatewayStartCancelledError();
      }
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
    const createdStore = createStore(config);
    store = createdStore;
    await awaitWhileLeaseHeld(
      createdStore.initialize({ deferPersistence: true }),
    );
    assertLeaseHeld();
    const runtime = await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        attestClaudeRuntime({
          claudeExecutable,
        }),
      ),
    );
    const createdClaudeProvider = createClaudeProvider({
      runtime,
      locale: options.locale ?? "en",
      nativeHelpers: { maxHelpers: config.limits.maxRoutes },
      ...(config.deliveryNotices === undefined
        ? {}
        : { deliveryNotices: config.deliveryNotices }),
    });
    claudeProvider = createdClaudeProvider;
    const codexEnvironment = localCodexProviderEnvironment(env);
    const codexFactoryOptions: LocalCodexTransportFactoryOptions = {
      environment: codexEnvironment,
      hostId: GATEWAY_LOCAL_HOST_ID,
    };
    const codexOperation = createCodexOperation({
      local: {
        environment: codexEnvironment,
      },
    });
    const createdCodexProvider = createCodexProvider({
      hostId: GATEWAY_LOCAL_HOST_ID,
      operation: codexOperation,
      createObservationFactory: async () =>
        await createCodexObservationFactory(codexFactoryOptions),
    });
    codexProvider = createdCodexProvider;
    for (const definition of config.acpProviders ?? []) {
      let resolved: DeepSeekAcpLaunch = {};
      if (definition.launch !== undefined) {
        resolved = { launch: definition.launch };
      } else if (definition.provider === "deepseek") {
        resolved = await awaitWhileLeaseHeld(
          resolveDeepSeek({ env, loginHome: resolvedLoginHome }).catch(() => ({
            safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE",
          })),
        );
      } else {
        resolved = { launch: GROK_ACP_LAUNCH };
      }
      acpProviders.push(createAcpProvider({
        provider: definition.provider,
        alias: definition.alias,
        hostId: GATEWAY_LOCAL_HOST_ID,
        ...(resolved.launch === undefined ? {} : { launch: resolved.launch }),
        ...(resolved.safeErrorCode === undefined
          ? {}
          : { unavailableCode: resolved.safeErrorCode }),
      }));
    }
    const createdService = createService({
      config,
      adapters: [createdClaudeProvider, createdCodexProvider, ...acpProviders],
      store: createdStore,
      codexDoctor: async () => {
        try {
          const installation = await resolveCodexInstallation(
            resolvedLoginHome,
          );
          return await diagnoseCodexAttachment({
            socketPath: installation.controlSocketPath,
            daemonExecutablePath: installation.binaryPath,
            embassyPid: process.pid,
            inspector: createSystemCodexDoctorInspector(),
          });
        } catch {
          return { conditions: ["unknown"] as const };
        }
      },
    });
    service = createdService;
    await awaitWhileLeaseHeld(
      Promise.resolve().then(() =>
        createdService.start(startupAbort?.signal),
      ),
    );
    assertLeaseHeld();
    const readyPublication = Promise.resolve().then(() =>
      options.onReady({
        status: "ready",
        hostId: GATEWAY_LOCAL_HOST_ID,
        codexMode: "native_messaging",
        dashboardFile: DASHBOARD_FILE_NAME,
      }),
    );
    const readyOutcome = await Promise.race([
      readyPublication.then(
        () => ({ kind: "ready" }) as const,
        (error: unknown) => ({ kind: "error", error }) as const,
      ),
      leaseLoss,
      shutdownRequested,
    ]);
    if (readyOutcome.kind === "error") throw readyOutcome.error;
    if (readyOutcome.kind === "lease_lost") throw instanceLeaseLostError();
    if (readyOutcome.kind === "shutdown") return;
    assertLeaseHeld();
    const lifetime = await Promise.race([shutdownRequested, leaseLoss]);
    if (lifetime.kind === "lease_lost") throw instanceLeaseLostError();
  } catch (error) {
    primaryFailure = error;
    throw error;
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
        ...(codexProvider === undefined ? {} : { codexProvider }),
        acpProviders,
        ...(store === undefined ? {} : { store }),
      }).catch((error: unknown) => {
        cleanupFailures.push(error);
      });
    }
    // Keep the host-wide lease held until process exit when provider/store
    // cleanup is unconfirmed. A replacement controller must not overlap
    // possibly-live exact-owned resources.
    if (cleanupFailures.length === 0) {
      await instanceLease?.close().catch((error: unknown) => {
        cleanupFailures.push(error);
      });
    }
    if (cleanupFailures.length > 0) {
      throw cleanupFailure(primaryFailure, cleanupFailures);
    }
  }
}
