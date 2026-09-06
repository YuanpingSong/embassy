import { userInfo } from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { LoopbackDestination } from "./broker-check.js";
import { handleBrokerCommand } from "./broker-control.js";
import { MessagingBroker } from "./broker.js";
import { ClaudePeerAdapter } from "./claude-peer.js";
import { attestClaudePeerRuntime, type AttestedClaudePeerRuntime } from "./claude-runtime.js";
import { createStatelessCodexOperationTransport, type StatelessCodexOperationTransport } from "./codex-stateless-transport.js";
import { loadGatewayConfig, defaultGatewayStateDir, type GatewayConfig } from "./config.js";
import { Coordinator, type Destination } from "./coordinator.js";
import { EndpointDirectory, type ClaudeDirectoryAdapter, type RemoteEndpointResolver } from "./endpoint-directory.js";
import { ensureGatewayNodeInventoryFile, loadGatewayNodeInventory, type GatewayNodeInventory } from "./federation-nodes.js";
import { Federation, isFederatedHandoff } from "./federation.js";
import { acquireGatewayInstanceLease, type GatewayInstanceLease } from "./instance-lease.js";
import { createLedgerCodec } from "./ledger-codec.js";
import { type LedgerState } from "./ledger.js";
import { serveLocalControl } from "./local-control.js";
import { ClaudeDestination, CodexDestination } from "./native-destinations.js";
import { OwnedStateFile } from "./owned-state.js";

export type CoreRuntimeReady = Readonly<{ status: "ready"; hostId: string; codexMode: "native_messaging" }>;
export type CoreRuntimeOptions = Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onReady: (result: CoreRuntimeReady) => void | Promise<void> }>;
type RuntimeClaudePeer = ClaudeDirectoryAdapter & Pick<ClaudePeerAdapter, "prepareSend" | "close">;
type RuntimeFederation = Destination & RemoteEndpointResolver & Pick<Federation, "catalog" | "snapshot">;
type ControlServer = Readonly<{ close(): Promise<void> }>;
type SignalName = "SIGINT" | "SIGTERM";
export type CoreRuntimeDependencies = Readonly<{
  loginHome?: () => string;
  loadInventory?: (stateDir: string) => Promise<GatewayNodeInventory>;
  ensureInventory?: (stateDir: string, host: string) => Promise<GatewayNodeInventory>;
  loadConfig?: (env: NodeJS.ProcessEnv, inventory: GatewayNodeInventory) => GatewayConfig;
  acquireLease?: (home: string) => Promise<GatewayInstanceLease>;
  attestClaudeRuntime?: () => Promise<AttestedClaudePeerRuntime>;
  createClaudePeer?: (runtime: AttestedClaudePeerRuntime, config: GatewayConfig) => RuntimeClaudePeer;
  createCodexOperation?: (env: NodeJS.ProcessEnv) => StatelessCodexOperationTransport;
  createFederation?: (host: string, nodes: readonly string[]) => RuntimeFederation;
  serveControl?: typeof serveLocalControl;
  addSignalListener?: (signal: SignalName, listener: () => void) => void;
  removeSignalListener?: (signal: SignalName, listener: () => void) => void;
}>;

const leaseLost = () => new BridgeError("GATEWAY_INSTANCE_LEASE_LOST",
  "Embassy lost its host-wide gateway lease and shut down.", true);
const cancelled = () => new BridgeError("GATEWAY_START_CANCELLED",
  "Gateway startup was cancelled before it became ready.", true);

const codexEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  ["HOME", "USER", "LOGNAME"].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));

/** Assemble the schema-6 broker. Construction is inert: provider and SSH I/O starts
 * only when an addressed operation reaches its destination. */
export async function runCoreRuntime(options: CoreRuntimeOptions, dependencies: CoreRuntimeDependencies = {}): Promise<void> {
  const env = options.env ?? process.env;
  const d = {
    loginHome: dependencies.loginHome ?? (() => userInfo().homedir),
    loadInventory: dependencies.loadInventory ?? loadGatewayNodeInventory,
    ensureInventory: dependencies.ensureInventory ?? ensureGatewayNodeInventoryFile,
    loadConfig: dependencies.loadConfig ?? loadGatewayConfig,
    acquireLease: dependencies.acquireLease ?? acquireGatewayInstanceLease,
    attestClaudeRuntime: dependencies.attestClaudeRuntime ?? attestClaudePeerRuntime,
    createClaudePeer: dependencies.createClaudePeer ?? ((runtime: AttestedClaudePeerRuntime, config: GatewayConfig) =>
      new ClaudePeerAdapter({ ...runtime })),
    createCodexOperation: dependencies.createCodexOperation ?? ((source: NodeJS.ProcessEnv) =>
      createStatelessCodexOperationTransport({ local: { environment: codexEnvironment(source) } })),
    createFederation: dependencies.createFederation ?? ((host: string, nodes: readonly string[]) => new Federation({ host, nodes })),
    serveControl: dependencies.serveControl ?? serveLocalControl,
    add: dependencies.addSignalListener ?? ((signal: SignalName, listener: () => void) => process.on(signal, listener)),
    remove: dependencies.removeSignalListener ?? ((signal: SignalName, listener: () => void) => process.off(signal, listener)),
  };
  const controller = new AbortController();
  let ready = false;
  const stop = (): void => { ready = false; controller.abort(); };
  const stopped = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  d.add("SIGINT", stop);
  try { d.add("SIGTERM", stop); }
  catch (error) { d.remove("SIGINT", stop); throw error; }
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  let lease: GatewayInstanceLease | undefined, store: OwnedStateFile<LedgerState> | undefined;
  let control: ControlServer | undefined, broker: MessagingBroker | undefined;
  let claude: ClaudeDestination | undefined, loopback: LoopbackDestination | undefined;
  let federation: RuntimeFederation | undefined;
  let primary: unknown;
  try {
    if (controller.signal.aborted) throw cancelled();
    let inventory = await d.loadInventory(path.resolve(defaultGatewayStateDir(env)));
    if (controller.signal.aborted) throw cancelled();
    const config = d.loadConfig(env, inventory), ledgerLimits = config.limits;
    const acquiring = d.acquireLease(d.loginHome()).then((value) => ({ kind: "lease" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }));
    const acquired = await Promise.race([acquiring, stopped.then(() => ({ kind: "stopped" as const }))]);
    if (acquired.kind === "stopped") {
      void acquiring.then((late) => late.kind === "lease" ? late.value.close().catch(() => undefined) : undefined);
      throw cancelled();
    }
    if (acquired.kind === "error") throw acquired.error;
    lease = acquired.value;
    const assertLease = (): void => { if (lease!.isLost()) throw leaseLost(); };
    const assertStarting = (): void => { assertLease(); if (controller.signal.aborted) throw cancelled(); };
    const assertWrite = (): void => {
      assertLease();
      if (controller.signal.aborted) throw new BridgeError("GATEWAY_SHUTDOWN", "The gateway is stopping.");
    };
    const awaitInertStartup = async <T>(operation: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([
        operation.then((value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error })),
        stopped.then(() => ({ kind: "stopped" as const })),
        lease!.lost.then(() => ({ kind: "lost" as const })),
      ]);
      if (outcome.kind === "result") return outcome.value;
      if (outcome.kind === "error") throw outcome.error;
      throw outcome.kind === "lost" ? leaseLost() : cancelled();
    };
    assertStarting();
    // Validate the installed ledger before any first-boot inventory write. An
    // unsupported or corrupt state refusal must leave every directory byte intact.
    store = new OwnedStateFile(config.stateDir, createLedgerCodec(config.hostId, ledgerLimits), { assertWritable: assertLease });
    await store.initialize();
    assertStarting();
    inventory = await d.ensureInventory(config.stateDir, inventory.host);
    assertStarting();
    if (inventory.host !== config.hostId || inventory.nodes.length !== config.peerNodes.length ||
      inventory.nodes.some((node, index) => node !== config.peerNodes[index])) {
      throw new BridgeError("GATEWAY_NODE_INVENTORY_CHANGED", "nodes.json changed while the broker was starting.");
    }
    assertStarting();
    // Attestation owns no resource and performs no writes, so shutdown may stop
    // waiting for a stuck filesystem read without leaving a late cleanup burden.
    const runtime = await awaitInertStartup(Promise.resolve().then(() => d.attestClaudeRuntime()));
    assertStarting();
    const peer = d.createClaudePeer(runtime, config);
    claude = new ClaudeDestination({ host: config.hostId, stateRoot: config.stateDir, peer });
    const codex = new CodexDestination({ host: config.hostId, operation: d.createCodexOperation(env) });
    loopback = new LoopbackDestination(codex);
    federation = d.createFederation(config.hostId, config.peerNodes);
    const directory = new EndpointDirectory({ host: config.hostId, limits: ledgerLimits, store, claude: peer, remote: federation });
    const coordinator = new Coordinator({ host: config.hostId, limits: ledgerLimits, store, claude,
      codex: loopback, ssh: federation, resolve: (identity) => directory.exact(identity), assertWritable: assertWrite });
    broker = new MessagingBroker({ host: config.hostId, limits: ledgerLimits, store, directory, coordinator,
      nodes: config.peerNodes, steeringEnabled: config.steeringEnabled, federation });
    control = await d.serveControl({ stateDir: config.stateDir, socketPath: config.controlSocketPath,
      handle: (input) => {
        if (!ready || controller.signal.aborted) throw new Error("CONTROL_NOT_READY");
        assertLease();
        return handleBrokerCommand(input, { broker: broker!, validateHandoff: isFederatedHandoff,
          check: () => loopback!.check({ host: config.hostId, limits: ledgerLimits, store: store!, coordinator }) });
      } });
    assertStarting();
    await loopback.cleanup({ host: config.hostId, limits: ledgerLimits, store });
    assertStarting();
    await broker.start();
    assertStarting();
    ready = true;
    const announced = Promise.resolve(options.onReady({ status: "ready", hostId: config.hostId,
      codexMode: "native_messaging" })).then(() => ({ kind: "ready" as const }),
      (error: unknown) => ({ kind: "error" as const, error }));
    const publication = await Promise.race([announced, stopped.then(() => ({ kind: "stopped" as const })),
      lease.lost.then(() => ({ kind: "lost" as const }))]);
    if (publication.kind === "error") throw publication.error;
    if (publication.kind === "lost" || lease.isLost()) throw leaseLost();
    if (publication.kind === "ready" && !controller.signal.aborted) await Promise.race([stopped, lease.lost]);
    if (lease.isLost()) throw leaseLost();
  } catch (error) {
    primary = error;
  }
  options.signal?.removeEventListener("abort", stop);
  d.remove("SIGINT", stop); d.remove("SIGTERM", stop);
  const failures: unknown[] = [];
  for (const resource of [control, broker, ...(broker === undefined ? [loopback, claude, federation] : []), store]) {
    if (resource !== undefined) await resource.close().catch((error) => failures.push(error));
  }
  // If any owned resource did not confirm cleanup, retain a still-held host-wide lease.
  // Releasing it could admit a second broker while the first still owns a socket,
  // provider operation, or state handle. A lease already lost cannot fence anything;
  // close its helper so that failure does not leak another process.
  if (lease !== undefined && (failures.length === 0 || lease.isLost())) {
    await lease.close().catch((error) => failures.push(error));
  }
  if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures],
    "Gateway execution and cleanup failures are preserved independently.");
  if (primary !== undefined) throw primary;
}
