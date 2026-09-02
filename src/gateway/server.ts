import { userInfo } from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { attestClaudePeerRuntime, type AttestedClaudePeerRuntime } from "./claude-runtime.js";
import { createLocalCodexTransportFactory, resolveManagedLocalCodexInstallation,
  LocalCodexTransportError, managedCodexControlSocketPath,
  type LocalCodexTransportFactory, type LocalCodexTransportFactoryOptions,
  type ManagedLocalCodexInstallation } from "./codex-local-transport.js";
import { createStatelessCodexOperationTransport, type StatelessCodexOperationTransport,
  type StatelessCodexOperationTransportOptions } from "./codex-stateless-transport.js";
import { createSystemCodexSocketHolderInspector, managedCodexSocketHeldOutsideEmbassy,
  type CodexSocketHolderInspector } from "./codex-socket-holder.js";
import { defaultGatewayStateDir, loadGatewayConfig, type GatewayConfig } from "./config.js";
import { loadGatewayNodeInventory, type GatewayNodeInventory } from "./federation-nodes.js";
import { acquireGatewayInstanceLease, type GatewayInstanceLease } from "./instance-lease.js";
import { LocalPeerMailboxProvider } from "./peer-mailbox.js";
import { createLocalClaudeGatewayProvider, createLocalCodexGatewayProvider,
  type LocalClaudeGatewayProviderOptions, type LocalCodexGatewayProviderOptions } from "./providers.js";
import { GatewayService, type GatewayProviderAdapter, type GatewayServiceOptions } from "./service.js";
import { GatewayStore } from "./store.js";

export type GatewayServerReadyResult = Readonly<{ status: "ready"; hostId: string; codexMode: "native_messaging" }>;
export type GatewayServerOptions = { env?: NodeJS.ProcessEnv;
  signal?: AbortSignal; onReady: (result: GatewayServerReadyResult) => void | Promise<void> };
type ServerService = Readonly<{ start: (signal?: AbortSignal) => Promise<void>; close: () => Promise<void> }>;
type Signal = "SIGINT" | "SIGTERM";
export type GatewayServerDependencies = {
  loadConfig?: (env: NodeJS.ProcessEnv, inventory: GatewayNodeInventory) => GatewayConfig; loginHome?: () => string;
  loadNodeInventory?: (stateDir: string) => Promise<GatewayNodeInventory>;
  attestClaudeRuntime?: () => Promise<AttestedClaudePeerRuntime>; createClaudeProvider?: (options: LocalClaudeGatewayProviderOptions) => GatewayProviderAdapter;
  acquireInstanceLease?: (home: string) => Promise<GatewayInstanceLease>; createStore?: (config: GatewayConfig) => GatewayStore;
  createCodexOperation?: (options: StatelessCodexOperationTransportOptions) => StatelessCodexOperationTransport; createCodexObservationFactory?: (options: LocalCodexTransportFactoryOptions) => Promise<LocalCodexTransportFactory>;
  resolveCodexInstallation?: (home: string) => Promise<ManagedLocalCodexInstallation>; createCodexProvider?: (options: LocalCodexGatewayProviderOptions) => GatewayProviderAdapter;
  createCodexSocketHolderInspector?: () => CodexSocketHolderInspector;
  createPeerProvider?: (hostId: string) => GatewayProviderAdapter;
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
    loadNodeInventory: dependencies.loadNodeInventory ?? loadGatewayNodeInventory,
    loginHome: dependencies.loginHome ?? (() => userInfo().homedir),
    attestClaudeRuntime: dependencies.attestClaudeRuntime ?? attestClaudePeerRuntime,
    createClaudeProvider: dependencies.createClaudeProvider ?? createLocalClaudeGatewayProvider,
    acquireInstanceLease: dependencies.acquireInstanceLease ?? acquireGatewayInstanceLease,
    createStore: dependencies.createStore ?? ((config: GatewayConfig) => new GatewayStore(config)),
    createCodexOperation: dependencies.createCodexOperation ?? createStatelessCodexOperationTransport,
    createCodexObservationFactory: dependencies.createCodexObservationFactory ?? createLocalCodexTransportFactory,
    resolveCodexInstallation: dependencies.resolveCodexInstallation ?? resolveManagedLocalCodexInstallation,
    createCodexSocketHolderInspector: dependencies.createCodexSocketHolderInspector ?? createSystemCodexSocketHolderInspector,
    createCodexProvider: dependencies.createCodexProvider ?? createLocalCodexGatewayProvider,
    createPeerProvider: dependencies.createPeerProvider ?? ((hostId) => new LocalPeerMailboxProvider({ hostId })),
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
    const inventory = await d.loadNodeInventory(path.resolve(defaultGatewayStateDir(env)));
    const config = d.loadConfig(env, inventory);
    const localHost = config.hostId;
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
      stateRoot: config.stateDir,
      hostId: localHost,
      nodeInventory: inventory,
      nativeHelpers: { maxHelpers: config.limits.maxRoutes },
      ...(config.deliveryNotices === undefined ? {} : { deliveryNotices: config.deliveryNotices }),
    }));
    const localEnvironment = codexEnvironment(env);
    const factoryOptions = { environment: localEnvironment, hostId: localHost };
    providers.push(d.createCodexProvider({
      hostId: localHost, nodeInventory: inventory,
      operation: d.createCodexOperation({ local: { environment: localEnvironment } }),
      createObservationFactory: () => d.createCodexObservationFactory(factoryOptions),
    }));
    providers.push(d.createPeerProvider(localHost));
    service = d.createService({
      config, adapters: providers, store,
      // Missing managed files are actionable only when the fixed private
      // socket is still held outside Embassy; every other outcome is silent.
      managedCodexSocketHeld: async () => {
        try {
          await d.resolveCodexInstallation(home);
          return false;
        } catch (error) {
          return error instanceof LocalCodexTransportError && error.code === "MANAGED_CODEX_UNAVAILABLE" &&
            await managedCodexSocketHeldOutsideEmbassy({ socketPath: managedCodexControlSocketPath(home),
              embassyPid: process.pid, inspector: d.createCodexSocketHolderInspector() });
        }
      },
    });
    await guarded(Promise.resolve().then(() => service!.start(startupAbort?.signal)));
    assertLease();
    const ready = Promise.resolve().then(() => options.onReady({ status: "ready", hostId: localHost,
      codexMode: "native_messaging" })).then(
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
