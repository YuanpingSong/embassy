import { userInfo } from "node:os";
import { BridgeError } from "../errors.js";
import { createAcpGatewayProvider, type AcpGatewayProviderOptions } from "./acp-provider.js";
import type { AcpLaunchSpec } from "./acp-client.js";
import { attestClaudePeerRuntime, type AttestedClaudePeerRuntime } from "./claude-runtime.js";
import { createLocalCodexTransportFactory, resolveManagedLocalCodexInstallation,
  LocalCodexTransportError, managedCodexControlSocketPath,
  type LocalCodexTransportFactory, type LocalCodexTransportFactoryOptions,
  type ManagedLocalCodexInstallation } from "./codex-local-transport.js";
import { createStatelessCodexOperationTransport, type StatelessCodexOperationTransport,
  type StatelessCodexOperationTransportOptions } from "./codex-stateless-transport.js";
import { createSystemCodexDoctorInspector, diagnoseCodexAttachment,
  diagnoseMissingManagedCodexLayout, type CodexDoctorInspector } from "./codex-doctor.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import { DASHBOARD_FILE_NAME } from "./dashboard.js";
import { resolveDeepSeekAcpLaunch, type DeepSeekAcpLaunch, type DeepSeekDetectOptions } from "./deepseek-detect.js";
import { acquireGatewayInstanceLease, type GatewayInstanceLease } from "./instance-lease.js";
import type { DashboardLocale } from "./locale.js";
import { createLocalClaudeGatewayProvider, createLocalCodexGatewayProvider,
  type LocalClaudeGatewayProviderOptions, type LocalCodexGatewayProviderOptions } from "./providers.js";
import { GatewayService, type GatewayProviderAdapter, type GatewayServiceOptions } from "./service.js";
import { GatewayStore } from "./store.js";
import { gatewayInboundModes, type GatewayInboundMode } from "./types.js";

export const GATEWAY_LOCAL_HOST_ID = "this-mac";
const GROK_ACP_LAUNCH = Object.freeze({
  kind: "npx", package: "@xai-official/grok@1.0.5", args: ["agent", "stdio"],
} satisfies AcpLaunchSpec);
export type GatewayServerReadyResult = Readonly<{ status: "ready"; hostId: typeof GATEWAY_LOCAL_HOST_ID; codexMode: "native_messaging"; dashboardFile: typeof DASHBOARD_FILE_NAME }>;
export type GatewayServerOptions = { env?: NodeJS.ProcessEnv; inboundMode?: GatewayInboundMode;
  locale?: DashboardLocale; signal?: AbortSignal; onReady: (result: GatewayServerReadyResult) => void | Promise<void> };
type ServerService = Readonly<{ start: (signal?: AbortSignal) => Promise<void>; close: () => Promise<void> }>;
type Signal = "SIGINT" | "SIGTERM";
export type GatewayServerDependencies = {
  loadConfig?: (env: NodeJS.ProcessEnv) => GatewayConfig; loginHome?: () => string;
  attestClaudeRuntime?: () => Promise<AttestedClaudePeerRuntime>; createClaudeProvider?: (options: LocalClaudeGatewayProviderOptions) => GatewayProviderAdapter;
  acquireInstanceLease?: (home: string) => Promise<GatewayInstanceLease>; createStore?: (config: GatewayConfig) => GatewayStore;
  createCodexOperation?: (options: StatelessCodexOperationTransportOptions) => StatelessCodexOperationTransport; createCodexObservationFactory?: (options: LocalCodexTransportFactoryOptions) => Promise<LocalCodexTransportFactory>;
  resolveCodexInstallation?: (home: string) => Promise<ManagedLocalCodexInstallation>; createCodexProvider?: (options: LocalCodexGatewayProviderOptions) => GatewayProviderAdapter;
  createCodexDoctorInspector?: () => CodexDoctorInspector;
  resolveDeepSeekAcpLaunch?: (options: DeepSeekDetectOptions) => Promise<DeepSeekAcpLaunch>; createAcpProvider?: (options: AcpGatewayProviderOptions) => GatewayProviderAdapter;
  createService?: (options: GatewayServiceOptions) => ServerService; addSignalListener?: (signal: Signal, listener: () => void) => void;
  removeSignalListener?: (signal: Signal, listener: () => void) => void;
};

const serverError = (code: string, message: string, recoverable = false): BridgeError =>
  new BridgeError(code, message, recoverable);
const leaseLost = (): BridgeError => serverError("GATEWAY_INSTANCE_LEASE_LOST", "Embassy lost its host-wide gateway lease and shut down.", true);
const startCancelled = (): BridgeError => serverError("GATEWAY_START_CANCELLED", "Gateway startup was cancelled before it became ready.", true);
function cleanupError(primary: unknown, failures: readonly unknown[]): BridgeError {
  const error = serverError("GATEWAY_CLEANUP_FAILED", "The local gateway could not confirm exact resource cleanup.") as BridgeError & { cause?: unknown };
  error.cause = new AggregateError(primary === undefined ? [...failures] : [primary, ...failures], "Gateway execution and cleanup failures are preserved independently.");
  return error;
}

function shutdownLatch(
  signal: AbortSignal | undefined,
  add: (signal: Signal, listener: () => void) => void,
  remove: (signal: Signal, listener: () => void) => void,
) {
  let resolve!: () => void;
  let stopped = false;
  const wait = new Promise<void>((done) => { resolve = done; });
  const stop = (): void => { if (!stopped) { stopped = true; resolve(); } };
  try {
    add("SIGINT", stop);
    try { add("SIGTERM", stop); } catch (error) { remove("SIGINT", stop); throw error; }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  } catch (error) {
    signal?.removeEventListener("abort", stop);
    throw error;
  }
  return {
    wait,
    dispose: (): void => { remove("SIGINT", stop); remove("SIGTERM", stop); signal?.removeEventListener("abort", stop); },
  };
}

const codexEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  ["HOME", "USER", "LOGNAME"].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]),
);

async function closeUnowned(resources: readonly ({ close(): Promise<void> } | undefined)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const resource of resources) await resource?.close().catch((error) => failures.push(error));
  if (failures.length) throw new AggregateError(failures, "Unowned gateway resources did not confirm cleanup.");
}

/** Assemble and run the foreground-only local gateway without provider requests. */
export async function runGatewayServer(
  options: GatewayServerOptions,
  dependencies: GatewayServerDependencies = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const d = {
    loadConfig: dependencies.loadConfig ?? loadGatewayConfig,
    loginHome: dependencies.loginHome ?? (() => userInfo().homedir),
    attestClaudeRuntime: dependencies.attestClaudeRuntime ?? attestClaudePeerRuntime,
    createClaudeProvider: dependencies.createClaudeProvider ?? createLocalClaudeGatewayProvider,
    acquireInstanceLease: dependencies.acquireInstanceLease ?? acquireGatewayInstanceLease,
    createStore: dependencies.createStore ?? ((config: GatewayConfig) => new GatewayStore(config)),
    createCodexOperation: dependencies.createCodexOperation ?? createStatelessCodexOperationTransport,
    createCodexObservationFactory: dependencies.createCodexObservationFactory ?? createLocalCodexTransportFactory,
    resolveCodexInstallation: dependencies.resolveCodexInstallation ?? resolveManagedLocalCodexInstallation,
    createCodexDoctorInspector: dependencies.createCodexDoctorInspector ?? createSystemCodexDoctorInspector,
    createCodexProvider: dependencies.createCodexProvider ?? createLocalCodexGatewayProvider,
    resolveDeepSeek: dependencies.resolveDeepSeekAcpLaunch ?? resolveDeepSeekAcpLaunch,
    createAcpProvider: dependencies.createAcpProvider ?? createAcpGatewayProvider,
    createService: dependencies.createService ?? ((input: GatewayServiceOptions) => new GatewayService(input)),
    add: dependencies.addSignalListener ?? ((signal: Signal, listener: () => void) => process.on(signal, listener)),
    remove: dependencies.removeSignalListener ?? ((signal: Signal, listener: () => void) => process.off(signal, listener)),
  };
  const shutdown = shutdownLatch(options.signal, d.add, d.remove);
  let lease: GatewayInstanceLease | undefined;
  let service: ServerService | undefined;
  let store: GatewayStore | undefined;
  const providers: GatewayProviderAdapter[] = [];
  let startupAbort: AbortController | undefined;
  let primary: unknown;
  let stopped = false;
  const stop = shutdown.wait.then(() => {
    stopped = true; startupAbort?.abort(); return { kind: "shutdown" } as const;
  });
  try {
    const loaded = d.loadConfig(env);
    const inboundMode = options.inboundMode ?? loaded.inboundMode;
    if (!(gatewayInboundModes as readonly string[]).includes(inboundMode)) {
      throw serverError("INVALID_GATEWAY_CONFIGURATION", "The gateway inbound mode must be paired or open.");
    }
    const config = { ...loaded, inboundMode };
    if (config.allowedHosts.length !== 1 || config.allowedHosts[0] !== GATEWAY_LOCAL_HOST_ID) {
      throw serverError("GATEWAY_REMOTE_PROVIDER_DISABLED", "This launcher supports only the exact local gateway host.");
    }
    const home = d.loginHome();
    const acquiring = d.acquireInstanceLease(home).then(
      (value) => ({ kind: "lease", value }) as const,
      (error: unknown) => ({ kind: "error", error }) as const,
    );
    const acquired = await Promise.race([acquiring, stop]);
    if (acquired.kind === "shutdown") {
      void acquiring.then((late) => late.kind === "lease" ? late.value.close().catch(() => undefined) : undefined);
      throw startCancelled();
    }
    if (acquired.kind === "error") throw acquired.error;
    lease = acquired.value;
    startupAbort = new AbortController();
    const loss = lease.lost.then(() => {
      startupAbort?.abort(); return { kind: "lease_lost" } as const;
    });
    const assertLease = (): void => {
      if (stopped) throw startCancelled();
      if (lease!.isLost()) throw leaseLost();
    };
    const guarded = async <T>(operation: Promise<T>): Promise<T> => {
      assertLease();
      const result = operation.then((value) => ({ kind: "result", value }) as const,
        (error: unknown) => ({ kind: "error", error }) as const);
      const outcome = await Promise.race([result, loss, stop]);
      assertLease();
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind !== "result") throw outcome.kind === "shutdown" ? startCancelled() : leaseLost();
      return outcome.value;
    };

    store = d.createStore(config);
    await guarded(store.initialize({ deferPersistence: true }));
    const runtime = await guarded(Promise.resolve().then(() => d.attestClaudeRuntime()));
    providers.push(d.createClaudeProvider({
      runtime,
      locale: options.locale ?? "en",
      nativeHelpers: { maxHelpers: config.limits.maxRoutes },
      ...(config.deliveryNotices === undefined ? {} : { deliveryNotices: config.deliveryNotices }),
    }));
    const localEnvironment = codexEnvironment(env);
    const factoryOptions = { environment: localEnvironment, hostId: GATEWAY_LOCAL_HOST_ID };
    providers.push(d.createCodexProvider({
      hostId: GATEWAY_LOCAL_HOST_ID,
      operation: d.createCodexOperation({ local: { environment: localEnvironment } }),
      createObservationFactory: () => d.createCodexObservationFactory(factoryOptions),
    }));
    for (const definition of config.acpProviders ?? []) {
      let resolved: DeepSeekAcpLaunch = definition.launch === undefined ? {} : { launch: definition.launch };
      if (definition.launch === undefined && definition.provider === "deepseek") {
        resolved = await guarded(d.resolveDeepSeek({ env, loginHome: home }).catch(() => ({
          safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE",
        })));
      } else if (definition.provider === "grok") resolved = { launch: GROK_ACP_LAUNCH };
      providers.push(d.createAcpProvider({
        ...definition,
        hostId: GATEWAY_LOCAL_HOST_ID,
        ...(resolved.launch === undefined ? {} : { launch: resolved.launch }),
        ...(resolved.safeErrorCode === undefined ? {} : { unavailableCode: resolved.safeErrorCode }),
      }));
    }
    service = d.createService({
      config, adapters: providers, store,
      codexDoctor: async () => {
        const inspector = d.createCodexDoctorInspector();
        try {
          const installation = await d.resolveCodexInstallation(home);
          return await diagnoseCodexAttachment({
            socketPath: installation.controlSocketPath,
            daemonExecutablePath: installation.binaryPath,
            embassyPid: process.pid,
            inspector,
          });
        } catch (error) {
          return error instanceof LocalCodexTransportError && error.code === "MANAGED_CODEX_UNAVAILABLE"
            ? await diagnoseMissingManagedCodexLayout({ socketPath: managedCodexControlSocketPath(home), embassyPid: process.pid, inspector })
            : { conditions: ["unknown"] as const };
        }
      },
    });
    await guarded(Promise.resolve().then(() => service!.start(startupAbort?.signal)));
    assertLease();
    const ready = Promise.resolve().then(() => options.onReady({ status: "ready", hostId: GATEWAY_LOCAL_HOST_ID,
      codexMode: "native_messaging", dashboardFile: DASHBOARD_FILE_NAME })).then(
      () => ({ kind: "ready" }) as const, (error: unknown) => ({ kind: "error", error }) as const);
    const published = await Promise.race([ready, loss, stop]);
    if (published.kind === "error") throw published.error;
    if (published.kind === "lease_lost") throw leaseLost();
    if (published.kind === "shutdown") return;
    assertLease();
    if ((await Promise.race([stop, loss])).kind === "lease_lost") throw leaseLost();
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    startupAbort?.abort();
    shutdown.dispose();
    const failures: unknown[] = [];
    if (service !== undefined) await service.close().catch((error) => failures.push(error));
    else {
      const unowned: { close(): Promise<void> }[] = providers.reverse();
      if (store !== undefined) unowned.push(store);
      await closeUnowned(unowned).catch((error) => failures.push(error));
    }
    if (failures.length === 0) await lease?.close().catch((error) => failures.push(error));
    if (failures.length) throw cleanupError(primary, failures);
  }
}
