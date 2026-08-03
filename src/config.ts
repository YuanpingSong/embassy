import { accessSync, constants, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

export type BridgeConfig = {
  claudeExecutable: string;
  stateDir: string;
  allowedWorkspaceRoots: string[];
  defaultModel?: string;
  maxConcurrentTasks: number;
  idleRuntimeMs: number;
  interruptGraceMs: number;
  defaultMaxTurns: number;
  maximumMaxTurns: number;
  writeEnabled: boolean;
  execEnabled: boolean;
  webEnabled: boolean;
};

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new BridgeError(
      "INVALID_CONFIGURATION",
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return parsed;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function executableCandidates(
  name: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) =>
      extensions.map((extension) => path.join(directory, `${name}${extension}`)),
    );
}

function usableExecutable(candidate: string): string | undefined {
  try {
    const canonical = realpathSync(candidate);
    const info = statSync(canonical);
    if (!info.isFile()) return undefined;
    if (
      process.platform === "win32" &&
      /\.(?:bat|cmd)$/i.test(canonical)
    ) {
      return undefined;
    }
    accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CLAUDE_BRIDGE_CLAUDE_BIN;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) {
      throw new BridgeError(
        "INVALID_CONFIGURATION",
        "CLAUDE_BRIDGE_CLAUDE_BIN must be an absolute path to the local Claude Code executable.",
      );
    }
    const resolved = usableExecutable(configured);
    if (resolved) return resolved;
    throw new BridgeError(
      "CLAUDE_CLI_NOT_AVAILABLE",
      "CLAUDE_BRIDGE_CLAUDE_BIN does not identify an executable local Claude Code installation.",
    );
  }

  for (const candidate of executableCandidates("claude", env)) {
    const resolved = usableExecutable(candidate);
    if (resolved) return resolved;
  }
  throw new BridgeError(
    "CLAUDE_CLI_NOT_AVAILABLE",
    "The local Claude Code executable was not found on an absolute PATH entry. Install Claude Code or set CLAUDE_BRIDGE_CLAUDE_BIN to its absolute path.",
  );
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState) return path.join(xdgState, "claude-agent-bridge");
  return path.join(os.homedir(), ".local", "state", "claude-agent-bridge");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const configuredRoots = (env.CLAUDE_BRIDGE_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configuredRoots.some((entry) => !path.isAbsolute(entry))) {
    throw new BridgeError(
      "INVALID_CONFIGURATION",
      "Every CLAUDE_BRIDGE_ALLOWED_ROOTS entry must be an absolute path.",
    );
  }
  if (
    env.CLAUDE_BRIDGE_STATE_DIR !== undefined &&
    !path.isAbsolute(env.CLAUDE_BRIDGE_STATE_DIR)
  ) {
    throw new BridgeError(
      "INVALID_CONFIGURATION",
      "CLAUDE_BRIDGE_STATE_DIR must be an absolute path.",
    );
  }
  const allowedWorkspaceRoots = configuredRoots.map((entry) =>
    path.resolve(entry),
  );
  const configuredDefaultModel = env.CLAUDE_BRIDGE_DEFAULT_MODEL;
  const defaultModel = configuredDefaultModel?.trim();
  if (
    configuredDefaultModel !== undefined &&
    (!defaultModel || !MODEL_PATTERN.test(defaultModel))
  ) {
    throw new BridgeError(
      "INVALID_CONFIGURATION",
      "CLAUDE_BRIDGE_DEFAULT_MODEL must be a valid Claude model name.",
    );
  }

  const config: BridgeConfig = {
    claudeExecutable: resolveClaudeExecutable(env),
    stateDir: path.resolve(
      env.CLAUDE_BRIDGE_STATE_DIR ?? defaultStateDir(env),
    ),
    allowedWorkspaceRoots,
    maxConcurrentTasks: positiveInteger(
      "CLAUDE_BRIDGE_MAX_CONCURRENT_TASKS",
      env.CLAUDE_BRIDGE_MAX_CONCURRENT_TASKS,
      2,
      1,
      32,
    ),
    idleRuntimeMs: positiveInteger(
      "CLAUDE_BRIDGE_IDLE_RUNTIME_MS",
      env.CLAUDE_BRIDGE_IDLE_RUNTIME_MS,
      60_000,
      1_000,
      3_600_000,
    ),
    interruptGraceMs: positiveInteger(
      "CLAUDE_BRIDGE_INTERRUPT_GRACE_MS",
      env.CLAUDE_BRIDGE_INTERRUPT_GRACE_MS,
      2_000,
      100,
      30_000,
    ),
    defaultMaxTurns: positiveInteger(
      "CLAUDE_BRIDGE_DEFAULT_MAX_TURNS",
      env.CLAUDE_BRIDGE_DEFAULT_MAX_TURNS,
      40,
      1,
      500,
    ),
    maximumMaxTurns: positiveInteger(
      "CLAUDE_BRIDGE_MAX_TURNS",
      env.CLAUDE_BRIDGE_MAX_TURNS,
      100,
      1,
      1_000,
    ),
    ...(defaultModel ? { defaultModel } : {}),
    writeEnabled: enabled(env.CLAUDE_BRIDGE_ENABLE_WRITE),
    execEnabled: enabled(env.CLAUDE_BRIDGE_ENABLE_EXEC),
    webEnabled: enabled(env.CLAUDE_BRIDGE_ENABLE_WEB),
  };

  if (config.allowedWorkspaceRoots.length === 0) {
    throw new BridgeError(
      "ALLOWED_WORKSPACE_ROOTS_REQUIRED",
      "CLAUDE_BRIDGE_ALLOWED_ROOTS must explicitly name at least one workspace directory.",
    );
  }
  if (config.defaultMaxTurns > config.maximumMaxTurns) {
    throw new BridgeError(
      "INVALID_CONFIGURATION",
      "CLAUDE_BRIDGE_DEFAULT_MAX_TURNS cannot exceed CLAUDE_BRIDGE_MAX_TURNS.",
    );
  }
  return config;
}
