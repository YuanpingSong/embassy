import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import {
  gatewayPublicSnapshotLimits,
  type GatewayInboundMode,
  type GatewayStoreLimits,
} from "./types.js";
import {
  PROGRESS_WATCH_DEFAULT_CAPACITY,
  PROGRESS_WATCH_HARD_CAPACITY,
} from "./progress-watch-machine.js";
import {
  compatibilityPolicies,
  type CompatibilityPolicy,
} from "./compatibility.js";

export const gatewayDeliveryNoticeModes = [
  "merged",
  "verbose",
  "quiet",
] as const;

export type GatewayDeliveryNoticeMode =
  (typeof gatewayDeliveryNoticeModes)[number];

export type GatewayConfig = {
  stateDir: string;
  controlSocketPath: string;
  allowedHosts: readonly string[];
  /** Global fail-closed switch for Claude-to-Codex `STEER:` delivery. */
  steeringEnabled: boolean;
  /** Global fail-closed switch for opt-in, owner-ended progress watches. */
  trackingEnabled?: boolean;
  /** Claude-to-Codex sender consent. Only an explicit CLI opt-out is open. */
  inboundMode: GatewayInboundMode;
  /** One sender-visible progress notice is due this long after enqueue. */
  stallNoticeMs: number;
  /** Native Claude sender notice policy; omitted injected configs mean merged. */
  deliveryNotices?: GatewayDeliveryNoticeMode;
  /** Unknown patch/minor compatibility policy; defaults to bounded observation. */
  compatibilityPolicy?: CompatibilityPolicy;
  limits: GatewayStoreLimits;
};

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const MAX_CONFIGURED_STATE_BUDGET = 7 * 1024 * 1024;
function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return parsed;
}

export function defaultGatewayStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    (env.EMBASSY_STATE_DIR !== undefined &&
      !path.isAbsolute(env.EMBASSY_STATE_DIR)) ||
    (env.XDG_STATE_HOME !== undefined &&
      !path.isAbsolute(env.XDG_STATE_HOME))
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "Inherited Embassy and XDG state roots must be absolute paths.",
    );
  }
  return (
    env.EMBASSY_STATE_DIR ??
    (env.XDG_STATE_HOME
      ? path.join(env.XDG_STATE_HOME, "agent-embassy")
      : path.join(os.homedir(), ".local", "state", "agent-embassy"))
  );
}

function parseAllowedHosts(value: string | undefined): readonly string[] {
  const hosts = (value ?? "this-mac")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    hosts.length === 0 ||
    hosts.length > 32 ||
    hosts.some((host) => !HOST_PATTERN.test(host)) ||
    new Set(hosts).size !== hosts.length
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "EMBASSY_HOSTS must contain 1 through 32 unique lowercase ASCII host aliases separated by commas.",
    );
  }
  return Object.freeze([...hosts]);
}

function enabledByDefault(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "1") return true;
  if (value === "0") return false;
  throw new BridgeError(
    "INVALID_GATEWAY_CONFIGURATION",
    `${name} must be exactly 1 or 0 when set.`,
  );
}

function deliveryNoticeMode(
  value: string | undefined,
): GatewayDeliveryNoticeMode {
  const candidate = value ?? "merged";
  if (
    gatewayDeliveryNoticeModes.includes(
      candidate as GatewayDeliveryNoticeMode,
    )
  ) {
    return candidate as GatewayDeliveryNoticeMode;
  }
  throw new BridgeError(
    "INVALID_GATEWAY_CONFIGURATION",
    "EMBASSY_DELIVERY_NOTICES must be exactly merged, verbose, or quiet.",
  );
}

function compatibilityPolicy(value: string | undefined): CompatibilityPolicy {
  const candidate = value ?? "observed";
  if (compatibilityPolicies.includes(candidate as CompatibilityPolicy)) {
    return candidate as CompatibilityPolicy;
  }
  throw new BridgeError(
    "INVALID_GATEWAY_CONFIGURATION",
    "EMBASSY_COMPAT_POLICY must be exactly observed or strict.",
  );
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const stateDir = path.resolve(defaultGatewayStateDir(env));
  const controlSocketPath = path.join(stateDir, "control.sock");
  if (Buffer.byteLength(controlSocketPath) > 100) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "The gateway state path is too long for a portable private Unix-domain control socket.",
    );
  }

  const messageDeadlineMs = boundedInteger(
    "EMBASSY_MESSAGE_DEADLINE_MS",
    env.EMBASSY_MESSAGE_DEADLINE_MS,
    14_400_000,
    1_000,
    86_400_000,
  );
  // Stall visibility must not scale with the (now hours-long) deadline: an
  // operator still wants to know within two minutes that a message is waiting.
  const stallNoticeMs = Math.min(Math.floor(messageDeadlineMs / 2), 120_000);

  const limits: GatewayStoreLimits = {
    maxRoutes: boundedInteger(
      "EMBASSY_MAX_ROUTES",
      env.EMBASSY_MAX_ROUTES,
      128,
      2,
      gatewayPublicSnapshotLimits.routes,
    ),
    maxPairs: boundedInteger(
      "EMBASSY_MAX_PAIRS",
      env.EMBASSY_MAX_PAIRS,
      128,
      1,
      gatewayPublicSnapshotLimits.pairs,
    ),
    maxWatches: boundedInteger(
      "EMBASSY_MAX_WATCHES",
      env.EMBASSY_MAX_WATCHES,
      PROGRESS_WATCH_DEFAULT_CAPACITY,
      1,
      PROGRESS_WATCH_HARD_CAPACITY,
    ),
    eventCapacity: boundedInteger(
      "EMBASSY_EVENT_CAPACITY",
      env.EMBASSY_EVENT_CAPACITY,
      500,
      10,
      gatewayPublicSnapshotLimits.messages,
    ),
    eventTtlMs: boundedInteger(
      "EMBASSY_EVENT_TTL_MS",
      env.EMBASSY_EVENT_TTL_MS,
      86_400_000,
      60_000,
      604_800_000,
    ),
    dedupeCapacity: boundedInteger(
      "EMBASSY_DEDUPE_CAPACITY",
      env.EMBASSY_DEDUPE_CAPACITY,
      2_000,
      10,
      100_000,
    ),
    dedupeTtlMs: boundedInteger(
      "EMBASSY_DEDUPE_TTL_MS",
      env.EMBASSY_DEDUPE_TTL_MS,
      300_000,
      1_000,
      86_400_000,
    ),
    maxQueueMessages: boundedInteger(
      "EMBASSY_MAX_QUEUE_MESSAGES",
      env.EMBASSY_MAX_QUEUE_MESSAGES,
      100,
      1,
      10_000,
    ),
    maxQueueMessagesPerRoute: boundedInteger(
      "EMBASSY_MAX_QUEUE_PER_ROUTE",
      env.EMBASSY_MAX_QUEUE_PER_ROUTE,
      20,
      1,
      1_000,
    ),
    maxInFlightMessages: boundedInteger(
      "EMBASSY_MAX_IN_FLIGHT",
      env.EMBASSY_MAX_IN_FLIGHT,
      16,
      1,
      1_000,
    ),
    maxQueueBytes: boundedInteger(
      "EMBASSY_MAX_QUEUE_BYTES",
      env.EMBASSY_MAX_QUEUE_BYTES,
      1_048_576,
      1_024,
      67_108_864,
    ),
    maxMessageBytes: boundedInteger(
      "EMBASSY_MAX_MESSAGE_BYTES",
      env.EMBASSY_MAX_MESSAGE_BYTES,
      16_384,
      1,
      1_048_576,
    ),
    messageDeadlineMs,
    rateLimitPerRoute: boundedInteger(
      "EMBASSY_RATE_LIMIT",
      env.EMBASSY_RATE_LIMIT,
      30,
      1,
      10_000,
    ),
    rateWindowMs: boundedInteger(
      "EMBASSY_RATE_WINDOW_MS",
      env.EMBASSY_RATE_WINDOW_MS,
      60_000,
      1_000,
      3_600_000,
    ),
  };
  if (limits.maxMessageBytes > limits.maxQueueBytes) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "EMBASSY_MAX_MESSAGE_BYTES cannot exceed EMBASSY_MAX_QUEUE_BYTES.",
    );
  }
  if (limits.maxQueueMessagesPerRoute > limits.maxQueueMessages) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "EMBASSY_MAX_QUEUE_PER_ROUTE cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.",
    );
  }
  if (limits.maxInFlightMessages > limits.maxQueueMessages) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "EMBASSY_MAX_IN_FLIGHT cannot exceed EMBASSY_MAX_QUEUE_MESSAGES.",
    );
  }
  const conservativeStateBudget =
    limits.eventCapacity * 512 +
    limits.dedupeCapacity * 384 +
    limits.maxRoutes * 1_024 +
    limits.maxPairs * 512 +
    (limits.maxWatches ?? PROGRESS_WATCH_DEFAULT_CAPACITY) * 768 +
    limits.maxQueueMessages * 512 +
    limits.maxRoutes * 256;
  if (conservativeStateBudget > MAX_CONFIGURED_STATE_BUDGET) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "The combined gateway route, event, dedupe, and queue capacities exceed the durable state byte budget.",
    );
  }

  return {
    stateDir,
    controlSocketPath,
    allowedHosts: parseAllowedHosts(env.EMBASSY_HOSTS),
    steeringEnabled: enabledByDefault(
      "EMBASSY_STEERING_ENABLED",
      env.EMBASSY_STEERING_ENABLED,
    ),
    trackingEnabled: enabledByDefault(
      "EMBASSY_TRACKING_ENABLED",
      env.EMBASSY_TRACKING_ENABLED,
    ),
    inboundMode: "paired",
    stallNoticeMs,
    deliveryNotices: deliveryNoticeMode(env.EMBASSY_DELIVERY_NOTICES),
    compatibilityPolicy: compatibilityPolicy(env.EMBASSY_COMPAT_POLICY),
    limits,
  };
}
