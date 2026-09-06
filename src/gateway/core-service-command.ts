import { BridgeError } from "../errors.js";
import { isBrokerResult } from "./broker-control.js";
import { defaultGatewayStateDir, loadGatewayConfig } from "./config.js";
import { loadGatewayNodeInventory } from "./federation-nodes.js";
import { LocalControlError, requestLocalControl } from "./local-control.js";
import {
  boundedServiceDetail,
  installServiceAgent,
  serviceAgentStatus,
  uninstallServiceAgent,
  type ServiceAgentDependencies,
  type ServiceAgentInstallResult,
  type ServiceAgentStatus,
  type ServiceAgentUninstallResult,
} from "./service-agent.js";

const HEALTH_WAIT_MS = 10_000;
const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_MS = 1_000;
const HEALTH_ATTEMPTS = HEALTH_WAIT_MS / HEALTH_POLL_MS;

export type CoreServiceCommandDependencies = Omit<ServiceAgentDependencies, "env">;
export type CoreServiceCommandResult =
  | ({ subcommand: "install"; health: { status: "healthy" | "degraded"; elapsedMs: number } } & ServiceAgentInstallResult)
  | ({ subcommand: "uninstall" } & ServiceAgentUninstallResult)
  | ({ subcommand: "status" } & ServiceAgentStatus);

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function waitForHealth(
  stateDir: string,
  socketPath: string,
  delay: (milliseconds: number) => Promise<void>,
  now: () => number,
): Promise<{ status: "healthy" | "degraded"; elapsedMs: number }> {
  const started = now();
  let lastObserved = "SERVICE_HEALTH_NO_RESPONSE";
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    const elapsed = Math.max(0, now() - started);
    const remaining = HEALTH_WAIT_MS - elapsed;
    if (remaining < 50) break;
    try {
      const response = await requestLocalControl({ stateDir, socketPath,
        request: { method: "health", params: {} }, mutating: false,
        timeoutMs: Math.min(remaining, HEALTH_REQUEST_MS) });
      if (object(response) && response.ok === true && Object.keys(response).length === 2 &&
        isBrokerResult("health", response.result)) {
        return { status: (response.result as { status: "healthy" | "degraded" }).status,
          elapsedMs: Math.max(0, now() - started) };
      }
      lastObserved = object(response) && response.ok === false &&
        typeof response.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(response.code)
        ? response.code : "CONTROL_INVALID_RESPONSE";
    } catch (error) {
      lastObserved = error instanceof LocalControlError || error instanceof BridgeError
        ? error.code : "SERVICE_HEALTH_NO_RESPONSE";
    }
    const left = HEALTH_WAIT_MS - Math.max(0, now() - started);
    if (left < 50) break;
    await delay(Math.min(HEALTH_POLL_MS, left));
  }
  throw new BridgeError("SERVICE_HEALTH_UNAVAILABLE",
    `Installed, but the broker did not answer within 10.0 s; last observed ${lastObserved}.`, true);
}

/** Retained launchd lifecycle wrapper. Only install inspects broker inventory;
 * status and uninstall remain usable when gateway state cannot be loaded. */
export async function runCoreServiceCommand(
  subcommand: "install" | "uninstall" | "status",
  env: NodeJS.ProcessEnv,
  dependencies: CoreServiceCommandDependencies,
): Promise<CoreServiceCommandResult> {
  const service: ServiceAgentDependencies = { ...dependencies, env };
  try {
    if (subcommand === "status") return { subcommand, ...await serviceAgentStatus(service) };
    if (subcommand === "uninstall") return { subcommand, ...await uninstallServiceAgent(service) };
    const stateDir = defaultGatewayStateDir(env);
    const inventory = await loadGatewayNodeInventory(stateDir);
    const config = loadGatewayConfig(env, inventory);
    const installed = await installServiceAgent(service);
    const now = dependencies.now ?? (() => performance.now());
    const delay = dependencies.delay ?? (async (milliseconds: number) =>
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const health = await waitForHealth(config.stateDir, config.controlSocketPath, delay, now);
    return { subcommand, ...installed, health };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    const errno = object(error) && (typeof error.errno === "number" || typeof error.syscall === "string");
    throw new BridgeError(errno ? "SERVICE_AGENT_FILESYSTEM_FAILED" : "SERVICE_AGENT_COMMAND_FAILED",
      errno && error instanceof Error
        ? `The service command could not complete: ${boundedServiceDetail(error.message)}`
        : "The service command could not complete.", true);
  }
}
