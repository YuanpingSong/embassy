import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import {
  gatewayPublicSnapshotLimits,
  type GatewayStoreLimits,
} from "./types.js";

export type GatewayConfig = {
  stateDir: string;
  controlSocketPath: string;
  allowedHosts: readonly string[];
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
    (env.CLAUDE_BRIDGE_STATE_DIR !== undefined &&
      !path.isAbsolute(env.CLAUDE_BRIDGE_STATE_DIR)) ||
    (env.XDG_STATE_HOME !== undefined &&
      !path.isAbsolute(env.XDG_STATE_HOME))
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "Inherited bridge and XDG state roots must be absolute paths.",
    );
  }
  const parent =
    env.CLAUDE_BRIDGE_STATE_DIR ??
    (env.XDG_STATE_HOME
      ? path.join(env.XDG_STATE_HOME, "claude-agent-bridge")
      : path.join(os.homedir(), ".local", "state", "claude-agent-bridge"));
  return path.join(parent, "gateway");
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
      "CLAUDE_BRIDGE_GATEWAY_HOSTS must contain 1 through 32 unique lowercase ASCII host aliases separated by commas.",
    );
  }
  return Object.freeze([...hosts]);
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const configuredStateDir = env.CLAUDE_BRIDGE_GATEWAY_STATE_DIR;
  if (configuredStateDir !== undefined && !path.isAbsolute(configuredStateDir)) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "CLAUDE_BRIDGE_GATEWAY_STATE_DIR must be an absolute path.",
    );
  }
  const stateDir = path.resolve(
    configuredStateDir ?? defaultGatewayStateDir(env),
  );
  const controlSocketPath = path.join(stateDir, "control.sock");
  if (Buffer.byteLength(controlSocketPath) > 100) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "The gateway state path is too long for a portable private Unix-domain control socket.",
    );
  }

  const limits: GatewayStoreLimits = {
    maxRoutes: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_ROUTES",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_ROUTES,
      128,
      2,
      gatewayPublicSnapshotLimits.routes,
    ),
    eventCapacity: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_EVENT_CAPACITY",
      env.CLAUDE_BRIDGE_GATEWAY_EVENT_CAPACITY,
      500,
      10,
      gatewayPublicSnapshotLimits.messages,
    ),
    eventTtlMs: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_EVENT_TTL_MS",
      env.CLAUDE_BRIDGE_GATEWAY_EVENT_TTL_MS,
      86_400_000,
      60_000,
      604_800_000,
    ),
    dedupeCapacity: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_DEDUPE_CAPACITY",
      env.CLAUDE_BRIDGE_GATEWAY_DEDUPE_CAPACITY,
      2_000,
      10,
      100_000,
    ),
    dedupeTtlMs: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_DEDUPE_TTL_MS",
      env.CLAUDE_BRIDGE_GATEWAY_DEDUPE_TTL_MS,
      300_000,
      1_000,
      86_400_000,
    ),
    maxQueueMessages: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_MESSAGES",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_MESSAGES,
      100,
      1,
      10_000,
    ),
    maxQueueMessagesPerRoute: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_PER_ROUTE",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_PER_ROUTE,
      20,
      1,
      1_000,
    ),
    maxInFlightMessages: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_IN_FLIGHT",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_IN_FLIGHT,
      16,
      1,
      1_000,
    ),
    maxQueueBytes: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_BYTES",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_BYTES,
      1_048_576,
      1_024,
      67_108_864,
    ),
    maxMessageBytes: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_MESSAGE_BYTES",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_MESSAGE_BYTES,
      16_384,
      1,
      1_048_576,
    ),
    messageDeadlineMs: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MESSAGE_DEADLINE_MS",
      env.CLAUDE_BRIDGE_GATEWAY_MESSAGE_DEADLINE_MS,
      300_000,
      1_000,
      3_600_000,
    ),
    maxHopCount: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_MAX_HOPS",
      env.CLAUDE_BRIDGE_GATEWAY_MAX_HOPS,
      2,
      0,
      16,
    ),
    rateLimitPerRoute: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_RATE_LIMIT",
      env.CLAUDE_BRIDGE_GATEWAY_RATE_LIMIT,
      30,
      1,
      10_000,
    ),
    rateWindowMs: boundedInteger(
      "CLAUDE_BRIDGE_GATEWAY_RATE_WINDOW_MS",
      env.CLAUDE_BRIDGE_GATEWAY_RATE_WINDOW_MS,
      60_000,
      1_000,
      3_600_000,
    ),
  };
  if (limits.maxMessageBytes > limits.maxQueueBytes) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "CLAUDE_BRIDGE_GATEWAY_MAX_MESSAGE_BYTES cannot exceed CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_BYTES.",
    );
  }
  if (limits.maxQueueMessagesPerRoute > limits.maxQueueMessages) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_PER_ROUTE cannot exceed CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_MESSAGES.",
    );
  }
  if (limits.maxInFlightMessages > limits.maxQueueMessages) {
    throw new BridgeError(
      "INVALID_GATEWAY_CONFIGURATION",
      "CLAUDE_BRIDGE_GATEWAY_MAX_IN_FLIGHT cannot exceed CLAUDE_BRIDGE_GATEWAY_MAX_QUEUE_MESSAGES.",
    );
  }
  const conservativeStateBudget =
    limits.eventCapacity * 512 +
    limits.dedupeCapacity * 384 +
    limits.maxRoutes * 1_024 +
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
    allowedHosts: parseAllowedHosts(env.CLAUDE_BRIDGE_GATEWAY_HOSTS),
    limits,
  };
}
