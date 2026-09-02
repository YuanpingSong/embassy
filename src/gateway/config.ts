import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import type { GatewayNodeInventory } from "./federation-nodes.js";
import { PROGRESS_WATCH_DEFAULT_CAPACITY, PROGRESS_WATCH_HARD_CAPACITY } from "./progress-watch-machine.js";
import { gatewayPublicSnapshotLimits, type GatewayInboundMode, type GatewayStoreLimits } from "./types.js";

export const gatewayDeliveryNoticeModes = ["merged", "verbose", "quiet"] as const;
export type GatewayDeliveryNoticeMode = (typeof gatewayDeliveryNoticeModes)[number];
export type GatewayConfig = { stateDir: string; controlSocketPath: string; allowedHosts: readonly string[];
  hostId: string; peerNodes: readonly string[];
  steeringEnabled: boolean; trackingEnabled?: boolean; inboundMode: GatewayInboundMode; stallNoticeMs: number;
  deliveryNotices?: GatewayDeliveryNoticeMode; limits: GatewayStoreLimits };

const MAX_STATE_BUDGET = 7 * 1024 * 1024;
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

function notices(value: string | undefined): GatewayDeliveryNoticeMode {
  const candidate = value ?? "merged";
  return gatewayDeliveryNoticeModes.includes(candidate as GatewayDeliveryNoticeMode) ? candidate as GatewayDeliveryNoticeMode
    : invalid("EMBASSY_DELIVERY_NOTICES must be exactly merged, verbose, or quiet.");
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv,
  inventory: Pick<GatewayNodeInventory, "host" | "nodes">,
): GatewayConfig {
  const stateDir = path.resolve(defaultGatewayStateDir(env));
  const controlSocketPath = path.join(stateDir, "control.sock");
  if (Buffer.byteLength(controlSocketPath) > 100) invalid("The gateway state path is too long for a portable private Unix-domain control socket.");
  const messageDeadlineMs = integer(env, "EMBASSY_MESSAGE_DEADLINE_MS", 14_400_000, 1_000, 86_400_000);
  const limits: GatewayStoreLimits = {
    maxRoutes: integer(env, "EMBASSY_MAX_ROUTES", 128, 2, gatewayPublicSnapshotLimits.routes), maxConsentEdges: integer(env, "EMBASSY_MAX_PAIRS", 128, 1, gatewayPublicSnapshotLimits.consentEdges),
    maxWatches: integer(env, "EMBASSY_MAX_WATCHES", PROGRESS_WATCH_DEFAULT_CAPACITY, 1, PROGRESS_WATCH_HARD_CAPACITY), eventCapacity: integer(env, "EMBASSY_EVENT_CAPACITY", 500, 10, gatewayPublicSnapshotLimits.messages),
    eventTtlMs: integer(env, "EMBASSY_EVENT_TTL_MS", 86_400_000, 60_000, 604_800_000),
    dedupeCapacity: integer(env, "EMBASSY_DEDUPE_CAPACITY", 2_000, 10, 100_000),
    dedupeTtlMs: integer(env, "EMBASSY_DEDUPE_TTL_MS", 300_000, 1_000, 86_400_000),
    maxQueueMessages: integer(env, "EMBASSY_MAX_QUEUE_MESSAGES", 100, 1, 10_000), maxQueueMessagesPerRoute: integer(env, "EMBASSY_MAX_QUEUE_PER_ROUTE", 20, 1, 1_000),
    maxInFlightMessages: integer(env, "EMBASSY_MAX_IN_FLIGHT", 16, 1, 1_000), maxQueueBytes: integer(env, "EMBASSY_MAX_QUEUE_BYTES", 1_048_576, 1_024, 67_108_864),
    maxMessageBytes: integer(env, "EMBASSY_MAX_MESSAGE_BYTES", 16_384, 1, 1_048_576),
    messageDeadlineMs,
    rateLimitPerRoute: integer(env, "EMBASSY_RATE_LIMIT", 30, 1, 10_000), rateWindowMs: integer(env, "EMBASSY_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000),
  };
  if (limits.maxMessageBytes > limits.maxQueueBytes) invalid("EMBASSY_MAX_MESSAGE_BYTES cannot exceed EMBASSY_MAX_QUEUE_BYTES.");
  if (limits.maxQueueMessagesPerRoute > limits.maxQueueMessages) invalid("EMBASSY_MAX_QUEUE_PER_ROUTE cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.");
  if (limits.maxInFlightMessages > limits.maxQueueMessages) invalid("EMBASSY_MAX_IN_FLIGHT cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.");
  const stateBudget = limits.eventCapacity * 512 + limits.dedupeCapacity * 384 +
    limits.maxRoutes * 1_280 + limits.maxConsentEdges * 512 +
    (limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY) * 768 + limits.maxQueueMessages * 512;
  if (stateBudget > MAX_STATE_BUDGET) invalid("The combined gateway route, event, dedupe, and queue capacities exceed the durable state byte budget.");
  return {
    stateDir, controlSocketPath, allowedHosts: Object.freeze([inventory.host, ...inventory.nodes]),
    hostId: inventory.host, peerNodes: inventory.nodes,
    steeringEnabled: toggle(env, "EMBASSY_STEERING_ENABLED"), trackingEnabled: toggle(env, "EMBASSY_TRACKING_ENABLED"), inboundMode: "paired",
    stallNoticeMs: Math.min(Math.floor(messageDeadlineMs / 2), 120_000),
    deliveryNotices: notices(env.EMBASSY_DELIVERY_NOTICES), limits,
  };
}
