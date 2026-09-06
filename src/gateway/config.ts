import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import type { GatewayNodeInventory } from "./federation-nodes.js";
import { ledgerDefaults, type LedgerLimits } from "./ledger.js";

export type GatewayConfig = { stateDir: string; controlSocketPath: string; allowedHosts: readonly string[];
  hostId: string; peerNodes: readonly string[];
  steeringEnabled: boolean; limits: LedgerLimits };

const invalid = (message: string): never => { throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", message); };
const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer from ${minimum} through ${maximum}.`);
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : invalid(`${name} must be an integer from ${minimum} through ${maximum}.`);
};
const toggle = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const value = env[name];
  if (value === undefined || value === "1") return true;
  if (value === "0") return false;
  return invalid(`${name} must be exactly 1 or 0 when set.`);
};

export function defaultGatewayStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.EMBASSY_STATE_DIR !== undefined && !path.isAbsolute(env.EMBASSY_STATE_DIR)) ||
    (env.XDG_STATE_HOME !== undefined && !path.isAbsolute(env.XDG_STATE_HOME))) invalid("Inherited Embassy and XDG state roots must be absolute paths.");
  return env.EMBASSY_STATE_DIR ?? (env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "agent-embassy")
    : path.join(os.homedir(), ".local", "state", "agent-embassy"));
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv,
  inventory: Pick<GatewayNodeInventory, "host" | "nodes">,
): GatewayConfig {
  const stateDir = path.resolve(defaultGatewayStateDir(env));
  const controlSocketPath = path.join(stateDir, "control.sock");
  if (Buffer.byteLength(controlSocketPath) > 100) invalid("The gateway state path is too long for a portable private Unix-domain control socket.");
  const messageDeadlineMs = integer(env, "EMBASSY_MESSAGE_DEADLINE_MS", 14_400_000, 1_000, 86_400_000);
  const limits: LedgerLimits = {
    ...ledgerDefaults,
    endpoints: integer(env, "EMBASSY_MAX_ROUTES", 128, 2, ledgerDefaults.endpoints),
    retained: integer(env, "EMBASSY_EVENT_CAPACITY", 500, 10, ledgerDefaults.retained),
    retentionMs: integer(env, "EMBASSY_EVENT_TTL_MS", 86_400_000, 60_000, 604_800_000),
    queued: integer(env, "EMBASSY_MAX_QUEUE_MESSAGES", 100, 1, ledgerDefaults.queued),
    perEndpoint: integer(env, "EMBASSY_MAX_QUEUE_PER_ROUTE", 20, 1, ledgerDefaults.perEndpoint),
    inFlight: integer(env, "EMBASSY_MAX_IN_FLIGHT", 16, 1, ledgerDefaults.inFlight),
    queueBytes: integer(env, "EMBASSY_MAX_QUEUE_BYTES", 1_048_576, 1_024, ledgerDefaults.queueBytes),
    bodyBytes: integer(env, "EMBASSY_MAX_MESSAGE_BYTES", 16_384, 1, ledgerDefaults.bodyBytes),
    deadlineMs: messageDeadlineMs,
    rate: integer(env, "EMBASSY_RATE_LIMIT", 30, 1, 10_000),
    rateWindowMs: integer(env, "EMBASSY_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000),
  };
  if (limits.bodyBytes > limits.queueBytes) invalid("EMBASSY_MAX_MESSAGE_BYTES cannot exceed EMBASSY_MAX_QUEUE_BYTES.");
  if (limits.perEndpoint > limits.queued) invalid("EMBASSY_MAX_QUEUE_PER_ROUTE cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.");
  if (limits.inFlight > limits.queued) invalid("EMBASSY_MAX_IN_FLIGHT cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.");
  return {
    stateDir, controlSocketPath, allowedHosts: Object.freeze([inventory.host, ...inventory.nodes]),
    hostId: inventory.host, peerNodes: inventory.nodes,
    steeringEnabled: toggle(env, "EMBASSY_STEERING_ENABLED"),
    limits,
  };
}
