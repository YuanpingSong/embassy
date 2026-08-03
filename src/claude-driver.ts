import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import type {
  AgentCallbacks,
  AgentDriver,
  AgentProgress,
  AgentRunHandle,
  AgentStartRequest,
  AgentTurnResult,
  FinalReport,
  JsonValue,
} from "./types.js";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_CLASSIFICATION_BYTES = 64 * 1024;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const finalOutputSchema = z.object({
  outcome: z.enum(["completed", "blocked", "failed"]),
  summary: z.string(),
  changed_files: z
    .array(
      z.object({
        path: z.string(),
        summary: z.string(),
      }),
    )
    .default([]),
  verification: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["passed", "failed", "not_run"]),
        details: z.string(),
      }),
    )
    .default([]),
  decisions_needed: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});

const finalOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: {
      type: "string",
      enum: ["completed", "blocked", "failed"],
    },
    summary: { type: "string" },
    changed_files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          summary: { type: "string" },
        },
        required: ["path", "summary"],
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: {
            type: "string",
            enum: ["passed", "failed", "not_run"],
          },
          details: { type: "string" },
        },
        required: ["name", "status", "details"],
      },
    },
    decisions_needed: {
      type: "array",
      items: { type: "string" },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "outcome",
    "summary",
    "changed_files",
    "verification",
    "decisions_needed",
    "warnings",
  ],
} as const;

const FINAL_REPORT_INSTRUCTIONS = `
You are the Claude Code backend behind a neutral local task coordinator.
Work only inside the granted workspace and capabilities. Do not attempt to
read user-level Claude configuration, credential stores, unrelated personal
files, or secrets. Never include credential values in progress or results.
Do not ask interactive questions. If a decision is required, finish the turn
with outcome "blocked" and list the decision in decisions_needed.

At the end of every turn, return the requested structured report. Keep the
summary concise. List only files actually changed and verification actually
performed. Do not claim a check passed unless you ran it.
`.trim();

type ClaudeCliSettings = {
  permissions: {
    allow: string[];
    deny: string[];
    defaultMode: "dontAsk";
    disableBypassPermissionsMode: "disable";
    disableAutoMode: "disable";
  };
  sandbox?: {
    enabled: true;
    failIfUnavailable: true;
    autoAllowBashIfSandboxed: true;
    allowUnsandboxedCommands: false;
    excludedCommands: [];
    filesystem: {
      denyRead: string[];
      allowRead: string[];
      allowWrite: string[];
      denyWrite: string[];
    };
    network: {
      allowedDomains: [];
      deniedDomains: ["*"];
      allowUnixSockets: [];
      allowAllUnixSockets: false;
      allowLocalBinding: false;
      allowMachLookup: [];
    };
  };
};

export type ClaudeCliInvocation = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  sessionId: string;
  tools: string[];
};

export type ClaudeSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    detached: boolean;
    shell: false;
    windowsHide: true;
  },
) => ChildProcessWithoutNullStreams;

function permissionRulePath(target: string): string {
  if (
    /[\0\r\n()*?[\]{}]/.test(target) ||
    (path.sep === "/" && target.includes("\\"))
  ) {
    throw new BridgeError(
      "UNSUPPORTED_POLICY_PATH",
      "The workspace, home, and controller state paths must not contain control characters or Claude permission-rule metacharacters.",
    );
  }
  let normalized = path.resolve(target);
  if (path.sep === "\\") normalized = normalized.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = `/${normalized[0]?.toLowerCase()}${normalized.slice(2)}`;
  }
  return normalized.replace(/^\/+/, "");
}

function absoluteRule(tool: "Read" | "Edit", target: string): string {
  return `${tool}(//${permissionRulePath(target)}/**)`;
}

function workspaceSecretRules(
  tool: "Read" | "Edit",
  cwd: string,
): string[] {
  const root = permissionRulePath(cwd);
  return [
    `${tool}(//${root}/**/.env)`,
    `${tool}(//${root}/**/.env.*)`,
    `${tool}(//${root}/**/.git-credentials)`,
    `${tool}(//${root}/**/.netrc)`,
    `${tool}(//${root}/**/.npmrc)`,
    `${tool}(//${root}/**/.pypirc)`,
    `${tool}(//${root}/**/id_dsa)`,
    `${tool}(//${root}/**/id_ecdsa)`,
    `${tool}(//${root}/**/id_ed25519)`,
    `${tool}(//${root}/**/id_rsa)`,
    `${tool}(//${root}/**/*.pem)`,
    `${tool}(//${root}/**/*.key)`,
    `${tool}(//${root}/**/*credentials*.json)`,
    `${tool}(//${root}/**/*service-account*.json)`,
  ];
}

function sensitiveToolRules(
  tool: "Read" | "Edit",
  request: AgentStartRequest,
): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".claude"),
    path.join(home, ".docker"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".config", "gcloud"),
    request.stateDir,
  ].map((target) => absoluteRule(tool, target));
}

function toolsFor(request: AgentStartRequest): string[] {
  const tools = ["Read", "Glob", "Grep"];
  if (request.permissionProfile !== "read_only") {
    tools.push("Edit", "Write");
  }
  if (request.permissionProfile === "workspace_exec") {
    if (!request.execEnabled) {
      throw new BridgeError(
        "EXECUTION_DISABLED",
        "workspace_exec is disabled by the bridge operator. Enable it only when the local Claude Code sandbox is available.",
      );
    }
    tools.push("Bash");
  }
  if (request.networkAccess === "web") {
    if (!request.webEnabled) {
      throw new BridgeError(
        "WEB_ACCESS_DISABLED",
        "Web access is disabled by the bridge operator.",
      );
    }
    tools.push("WebSearch", "WebFetch");
  }
  return tools;
}

export function buildClaudeCliSettings(
  request: AgentStartRequest,
): ClaudeCliSettings {
  const allow = [absoluteRule("Read", request.cwd)];
  if (request.permissionProfile !== "read_only") {
    allow.push(absoluteRule("Edit", request.cwd));
  }
  if (request.permissionProfile === "workspace_exec") allow.push("Bash");
  if (request.networkAccess === "web") {
    allow.push("WebSearch", "WebFetch");
  }

  const deny = [
    ...sensitiveToolRules("Read", request),
    ...workspaceSecretRules("Read", request.cwd),
    ...(request.permissionProfile === "read_only"
      ? []
      : [
          ...sensitiveToolRules("Edit", request),
          ...workspaceSecretRules("Edit", request.cwd),
        ]),
  ];
  const settings: ClaudeCliSettings = {
    permissions: {
      allow,
      deny,
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
  };

  if (request.permissionProfile === "workspace_exec") {
    const home = os.homedir();
    settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        denyRead: [home, request.stateDir],
        allowRead: [request.cwd, request.tempDir],
        allowWrite: [request.cwd, request.tempDir],
        denyWrite: [
          path.join(home, ".ssh"),
          path.join(home, ".aws"),
          path.join(home, ".azure"),
          path.join(home, ".claude"),
          path.join(home, ".docker"),
          path.join(home, ".gnupg"),
          path.join(home, ".kube"),
          path.join(home, ".config", "gcloud"),
          path.join(request.stateDir, "tasks"),
        ],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowMachLookup: [],
      },
    };
  }
  return settings;
}

export function buildClaudeCliEnvironment(
  request: AgentStartRequest,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const exactNames = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]);
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && exactNames.has(name)) {
      env[name] = value;
    }
  }
  env.TMPDIR = request.tempDir;
  env.TEMP = request.tempDir;
  env.TMP = request.tempDir;
  env.CLAUDE_CONFIG_DIR = request.profileDir;
  if (process.platform === "darwin") {
    // Claude Code 2.1.220 otherwise derives a separate Keychain service name
    // from each task-private config directory. An explicitly empty secure
    // storage directory selects the same-user default Keychain namespace
    // while leaving settings, transcripts, and plugins in the private profile.
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
  }
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    DISABLE_INSTALL_GITHUB_APP_COMMAND: "1",
    DISABLE_LOGIN_COMMAND: "1",
    DISABLE_LOGOUT_COMMAND: "1",
    DISABLE_UPDATES: "1",
    DISABLE_UPGRADE_COMMAND: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  });
  return env;
}

export function buildClaudeCliInvocation(
  executable: string,
  request: AgentStartRequest,
): ClaudeCliInvocation {
  if (request.model && !MODEL_PATTERN.test(request.model)) {
    throw new BridgeError(
      "INVALID_MODEL",
      "Claude model names must use only letters, digits, dots, underscores, colons, and hyphens, and must not begin with a hyphen.",
    );
  }
  if (
    request.resumeSessionId &&
    !SESSION_ID_PATTERN.test(request.resumeSessionId)
  ) {
    throw new BridgeError(
      "INVALID_SESSION_ID",
      "The controller refused an invalid local Claude Code session id.",
    );
  }
  const sessionId = request.resumeSessionId ?? randomUUID();
  const tools = toolsFor(request);
  const settings = buildClaudeCliSettings(request);
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--settings",
    JSON.stringify(settings),
    "--max-turns",
    String(request.maxTurns),
    "--json-schema",
    JSON.stringify(finalOutputJsonSchema),
    "--append-system-prompt",
    FINAL_REPORT_INSTRUCTIONS,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.resumeSessionId
      ? ["--resume", request.resumeSessionId]
      : ["--session-id", sessionId]),
  ];
  const input = {
    type: "user",
    message: {
      role: "user",
      content: request.initialPrompt,
    },
    parent_tool_use_id: null,
  };
  return {
    executable,
    args,
    env: buildClaudeCliEnvironment(request),
    stdin: `${JSON.stringify(input)}\n`,
    sessionId,
    tools,
  };
}

function compactText(value: string, limit = 600): string {
  const compact = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}…`;
}

function safeReportText(value: string, limit = 600): string {
  const compact = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = compact
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_SECRET]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
      "Bearer [REDACTED_SECRET]",
    )
    .replace(
      /(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\1(\s*[:=]\s*)["']?[^\s,"'}]{4,}["']?/gi,
      "$1$2$1$3[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
      "[REDACTED_PRIVATE_KEY]",
    );
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 1)}…`;
}

function looksLikeWorkspaceSecret(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  const base = path.posix.basename(normalized);
  const segments = normalized.split("/").filter(Boolean);
  return (
    segments.some((segment) =>
      [
        ".aws",
        ".azure",
        ".docker",
        ".gnupg",
        ".kube",
        ".ssh",
      ].includes(segment),
    ) ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".git-credentials" ||
    base === ".netrc" ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === "id_dsa" ||
    base === "id_ecdsa" ||
    base === "id_ed25519" ||
    base === "id_rsa" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    (base.endsWith(".json") &&
      (base.includes("credentials") ||
        base.includes("service-account")))
  );
}

function optionalMetric<T extends string | number>(
  object: Record<string, string | number>,
  key: string,
  value: T | null | undefined,
): void {
  if (value !== undefined && value !== null) object[key] = value;
}

function numericField(
  message: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = message[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringField(
  message: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = message[name];
  return typeof value === "string" ? value : undefined;
}

function reportFromResult(message: Record<string, unknown>): FinalReport {
  const metrics: Record<string, string | number> = {};
  optionalMetric(metrics, "durationMs", numericField(message, "duration_ms"));
  optionalMetric(metrics, "turns", numericField(message, "num_turns"));
  const stopReason = stringField(message, "stop_reason");
  optionalMetric(
    metrics,
    "stopReason",
    stopReason === undefined ? undefined : safeReportText(stopReason, 80),
  );
  const permissionDenials = message.permission_denials;
  if (Array.isArray(permissionDenials)) {
    metrics.permissionDenials = permissionDenials.length;
  }

  const success =
    message.subtype === "success" && message.is_error !== true;
  if (success) {
    const structured = finalOutputSchema.safeParse(
      message.structured_output,
    );
    if (structured.success) {
      return {
        outcome: structured.data.outcome,
        summary: safeReportText(structured.data.summary, 4_000),
        changedFiles: structured.data.changed_files.map((file) => ({
          path: looksLikeWorkspaceSecret(file.path)
            ? "[sensitive path omitted]"
            : safeReportText(file.path, 1_000),
          summary: safeReportText(file.summary, 2_000),
        })),
        verification: structured.data.verification.map((item) => ({
          ...item,
          name: safeReportText(item.name, 500),
          details: safeReportText(item.details, 2_000),
        })),
        decisionsNeeded: structured.data.decisions_needed.map((item) =>
          safeReportText(item, 2_000),
        ),
        warnings: structured.data.warnings.map((item) =>
          safeReportText(item, 2_000),
        ),
        metrics,
      };
    }
    throw new BridgeError(
      "CLAUDE_CLI_STRUCTURED_RESULT_INVALID",
      "The local Claude Code CLI did not return the required structured final report.",
      true,
    );
  }

  return {
    outcome: "failed",
    summary: "Claude Code ended the turn without completing it.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: [],
    warnings: [
      "Raw Claude Code diagnostics were withheld from MCP output.",
    ],
    metrics,
  };
}

function resultErrorCode(message: Record<string, unknown>): string | undefined {
  if (message.subtype === "success" && message.is_error !== true) {
    return undefined;
  }
  if (message.subtype === "error_max_turns") return "MAX_TURNS_REACHED";
  return "CLAUDE_TURN_FAILED";
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "a tool";
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,80}$/.test(value)
    ? value
    : "a tool";
}

function progressFromMessage(
  message: Record<string, unknown>,
): AgentProgress[] {
  if (message.type === "assistant") {
    const envelope =
      message.message &&
      typeof message.message === "object" &&
      !Array.isArray(message.message)
        ? (message.message as Record<string, unknown>)
        : {};
    const content = Array.isArray(envelope.content) ? envelope.content : [];
    const events: AgentProgress[] = [];
    let hasText = false;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      const typed = block as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") {
        hasText ||= typed.text.trim().length > 0;
      } else if (typed.type === "tool_use") {
        const toolName = safeToolName(typed.name);
        if (toolName === "StructuredOutput") continue;
        events.push({
          kind: "tool_started",
          message: `Claude Code started ${toolName}.`,
          status: "running",
          details: { toolName },
        });
      }
    }
    if (hasText) {
      events.unshift({
        kind: "assistant",
        message: "Claude Code produced an assistant progress update.",
        status: "running",
      });
    }
    return events;
  }

  if (message.type === "tool_progress") {
    const toolName = safeToolName(message.tool_name);
    const details: Record<string, JsonValue> = { toolName };
    const elapsed = numericField(message, "elapsed_time_seconds");
    if (elapsed !== undefined) details.elapsedSeconds = elapsed;
    return [
      {
        kind: "tool_progress",
        message: `${toolName} is still running.`,
        status: "running",
        details,
      },
    ];
  }

  if (message.type === "system" && message.subtype === "status") {
    return [
      {
        kind: "status",
        message: "Claude Code reported a runtime status update.",
        status: "running",
      },
    ];
  }

  if (
    message.type === "system" &&
    message.subtype === "session_state_changed"
  ) {
    const state = stringField(message, "state") ?? "working";
    const safeState = /^[a-z_]{1,40}$/i.test(state) ? state : "working";
    return [
      {
        kind: "session_state",
        message: `Claude Code session state: ${safeState}.`,
        status: safeState === "requires_action" ? "waiting" : "running",
        details: { state: safeState },
      },
    ];
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    const toolName = safeToolName(message.tool_name);
    return [
      {
        kind: "permission_denied",
        message: `Claude Code was denied use of ${toolName}.`,
        status: "running",
        details: { toolName },
      },
    ];
  }

  if (message.type === "system" && message.subtype === "api_retry") {
    const attempt = numericField(message, "attempt");
    const maximumAttempts = numericField(message, "max_retries");
    const details: Record<string, JsonValue> = {};
    if (attempt !== undefined) details.attempt = attempt;
    if (maximumAttempts !== undefined) {
      details.maximumAttempts = maximumAttempts;
    }
    return [
      {
        kind: "retrying",
        message: "Claude Code is retrying a request.",
        status: "running",
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    ];
  }
  return [];
}

function runtimeFailure(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
} {
  if (error instanceof BridgeError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  ) {
    return {
      code: "CLAUDE_CLI_NOT_AVAILABLE",
      message:
        "The configured local Claude Code executable could not be started.",
      recoverable: true,
    };
  }
  return {
    code: "LOCAL_CLAUDE_CODE_FAILED",
    message:
      "The local Claude Code CLI could not complete. Run `claude` interactively under the same OS account to confirm it is signed in and can reach Claude, then retry.",
    recoverable: true,
  };
}

function startupFailure(stderr: string): BridgeError {
  const normalized = stderr.toLowerCase();
  if (/settings? (?:file )?(?:is )?invalid|invalid settings?/.test(normalized)) {
    return new BridgeError(
      "CLAUDE_CLI_SETTINGS_REJECTED",
      "The installed Claude Code CLI rejected the bridge-owned safety settings.",
      true,
    );
  }
  if (/not a valid json schema|invalid json schema/.test(normalized)) {
    return new BridgeError(
      "CLAUDE_CLI_SCHEMA_REJECTED",
      "The installed Claude Code CLI rejected the bridge's structured-report schema.",
      true,
    );
  }
  if (
    /unknown (?:option|argument)|invalid (?:option|argument)/.test(
      normalized,
    )
  ) {
    return new BridgeError(
      "CLAUDE_CLI_INCOMPATIBLE",
      "The installed Claude Code CLI rejected the bridge's required non-interactive safety flags. Update Claude Code and retry.",
      true,
    );
  }
  if (
    /not logged in|not authenticated|please (?:run )?\/?login|sign in|authentication failed/.test(
      normalized,
    )
  ) {
    return new BridgeError(
      "LOCAL_CLAUDE_LOGIN_REQUIRED",
      "The local Claude Code CLI is not signed in. Run `claude` interactively under the same OS account, complete sign-in, and retry.",
      true,
    );
  }
  if (
    /stream-json|input-format|invalid json|stdin|unexpected end of json/.test(
      normalized,
    )
  ) {
    return new BridgeError(
      "CLAUDE_CLI_INPUT_FAILED",
      "The installed Claude Code CLI rejected the bridge's stream-JSON input protocol.",
      true,
    );
  }
  return new BridgeError(
    "LOCAL_CLAUDE_CODE_FAILED",
    "The local Claude Code CLI exited before starting a session. Run `claude` interactively under the same OS account to confirm it is signed in and can reach Claude, then retry.",
    true,
  );
}

function safetyConfigurationFailure(stderr: string): BridgeError | undefined {
  const normalized = stderr.toLowerCase();
  if (
    /settings validation failed:|failed to (?:load|parse) settings|invalid permission rule|permission (?:allow|ask|deny) rule .*(?:invalid|not matched)/.test(
      normalized,
    )
  ) {
    return new BridgeError(
      "CLAUDE_CLI_SAFETY_CONFIGURATION_FAILED",
      "Claude Code did not accept all bridge-owned permission or sandbox settings, so the task was rejected.",
    );
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return value;
}

function validateInitializationPolicy(
  message: Record<string, unknown>,
  request: AgentStartRequest,
  invocation: ClaudeCliInvocation,
): void {
  const nativeMacCompatibility =
    process.platform === "darwin" &&
    message.claude_code_version === "2.1.220";
  const localAuthMatches =
    message.apiKeySource === "oauth" ||
    (nativeMacCompatibility && message.apiKeySource === "none");
  if (!localAuthMatches) {
    throw new BridgeError(
      "LOCAL_CLAUDE_SUBSCRIPTION_REQUIRED",
      "The bridge only accepts the existing local Claude Code subscription login under this OS account. Complete interactive Claude Code sign-in and retry.",
    );
  }

  const actualTools = stringArray(message.tools);
  const slashCommands = stringArray(message.slash_commands);
  const skills = stringArray(message.skills);
  const agents =
    message.agents === undefined ? [] : stringArray(message.agents);
  const allowedTools = new Set([
    ...invocation.tools,
    "EndConversation",
    "StructuredOutput",
  ]);
  const toolPolicyMatches =
    actualTools !== undefined &&
    invocation.tools.every((tool) => actualTools.includes(tool)) &&
    actualTools.every((tool) => allowedTools.has(tool));
  const metadataMatches =
    message.cwd === request.cwd &&
    (message.permissionMode === "dontAsk" ||
      (nativeMacCompatibility &&
        message.permissionMode === "default")) &&
    toolPolicyMatches &&
    Array.isArray(message.mcp_servers) &&
    message.mcp_servers.length === 0 &&
    slashCommands !== undefined &&
    slashCommands.length === 0 &&
    skills !== undefined &&
    skills.length === 0 &&
    Array.isArray(message.plugins) &&
    message.plugins.length === 0 &&
    agents !== undefined;

  if (!metadataMatches) {
    throw new BridgeError(
      "CLAUDE_CLI_SAFETY_CONFIGURATION_FAILED",
      "Claude Code did not confirm the bridge-owned workspace, tool, permission, and customization restrictions, so the task was rejected.",
    );
  }
}

function signalProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (
    process.platform !== "win32" &&
    typeof child.pid === "number" &&
    child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child if the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and signal.
  }
}

export class ClaudeCliDriver implements AgentDriver {
  private readonly executable: string;
  private readonly spawnProcess: ClaudeSpawn;

  constructor(
    executable: string,
    spawnProcess: ClaudeSpawn = spawn as ClaudeSpawn,
  ) {
    this.executable = executable;
    this.spawnProcess = spawnProcess;
  }

  start(
    request: AgentStartRequest,
    callbacks: AgentCallbacks,
  ): AgentRunHandle {
    const invocation = buildClaudeCliInvocation(this.executable, request);
    const child = this.spawnProcess(invocation.executable, invocation.args, {
      cwd: request.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdin.on("error", () => undefined);

    let closed = false;
    let stopRequested = false;
    let initialized = false;
    let resultSeen = false;
    let pendingResult: AgentTurnResult | undefined;
    let processExited = false;
    let totalBytes = 0;
    let buffered = "";
    let stderrForClassification = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const remaining =
        MAX_STDERR_CLASSIFICATION_BYTES -
        Buffer.byteLength(stderrForClassification, "utf8");
      if (remaining <= 0) return;
      const text =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrForClassification += Buffer.from(text, "utf8")
        .subarray(0, remaining)
        .toString("utf8");
    });

    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let processError: Error | undefined;
      child.once("error", (error) => {
        processError ??= error;
      });
      child.once("close", (code, signal) => {
        processExited = true;
        resolve({
          code,
          signal,
          ...(processError ? { error: processError } : {}),
        });
      });
    });
    const terminateUnexpectedProcess = async (): Promise<void> => {
      if (!processExited) {
        signalProcess(child, "SIGTERM");
        const terminated = await Promise.race([
          exit.then(() => true),
          new Promise<false>((resolve) => {
            setTimeout(() => resolve(false), 500);
          }),
        ]);
        if (!terminated) signalProcess(child, "SIGKILL");
      }
      // Never release the controller's workspace/session fence until Node has
      // confirmed that the child process and its stdio are closed.
      await exit;
    };

    const handleMessage = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BridgeError(
          "CLAUDE_CLI_PROTOCOL_ERROR",
          "The local Claude Code CLI emitted an invalid JSON event.",
          true,
        );
      }
      const message = value as Record<string, unknown>;
      if (message.type === "system" && message.subtype === "init") {
        if (initialized) {
          throw new BridgeError(
            "CLAUDE_CLI_PROTOCOL_ERROR",
            "The local Claude Code CLI emitted more than one initialization event.",
            true,
          );
        }
        const emittedSessionId = stringField(message, "session_id");
        if (emittedSessionId !== invocation.sessionId) {
          throw new BridgeError(
            request.resumeSessionId
              ? "SESSION_RESUME_MISMATCH"
              : "SESSION_ID_MISMATCH",
            "The local Claude Code CLI did not initialize the controller-owned session id.",
          );
        }
        validateInitializationPolicy(message, request, invocation);
        initialized = true;
        await callbacks.onSession({
          sessionId: emittedSessionId,
          model: compactText(stringField(message, "model") ?? "unknown", 120),
        });
        return;
      }

      if (message.type === "result") {
        if (!initialized) {
          throw new BridgeError(
            "CLAUDE_CLI_PROTOCOL_ERROR",
            "The local Claude Code CLI returned a result before session initialization.",
            true,
          );
        }
        if (resultSeen) {
          throw new BridgeError(
            "CLAUDE_CLI_PROTOCOL_ERROR",
            "The local Claude Code CLI emitted more than one final result.",
            true,
          );
        }
        const resultSessionId = stringField(message, "session_id");
        if (resultSessionId !== invocation.sessionId) {
          throw new BridgeError(
            "SESSION_RESULT_MISMATCH",
            "The local Claude Code CLI returned a result for a different session.",
          );
        }
        resultSeen = true;
        const report = reportFromResult(message);
        const errorCode = resultErrorCode(message);
        pendingResult = {
          success: errorCode === undefined,
          sessionId: invocation.sessionId,
          report,
          ...(errorCode ? { errorCode } : {}),
          ...(errorCode
            ? {
                errorMessage:
                  "The local Claude Code turn did not complete successfully.",
              }
            : {}),
        };
        return;
      }

      for (const progress of progressFromMessage(message)) {
        await callbacks.onProgress(progress);
      }
    };

    const parseLine = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
        throw new BridgeError(
          "CLAUDE_CLI_OUTPUT_LIMIT",
          "The local Claude Code CLI exceeded the bridge JSON event limit.",
          true,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new BridgeError(
          "CLAUDE_CLI_PROTOCOL_ERROR",
          "The local Claude Code CLI emitted malformed JSON.",
          true,
        );
      }
      await handleMessage(parsed);
    };

    const done = (async () => {
      try {
        child.stdin.end(invocation.stdin);
        for await (const chunk of child.stdout) {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          totalBytes += Buffer.byteLength(text, "utf8");
          if (totalBytes > MAX_STDOUT_BYTES) {
            throw new BridgeError(
              "CLAUDE_CLI_OUTPUT_LIMIT",
              "The local Claude Code CLI exceeded the bridge output limit.",
              true,
            );
          }
          buffered += text;
          while (true) {
            const newline = buffered.indexOf("\n");
            if (newline === -1) break;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            await parseLine(line);
          }
          if (Buffer.byteLength(buffered, "utf8") > MAX_JSON_LINE_BYTES) {
            throw new BridgeError(
              "CLAUDE_CLI_OUTPUT_LIMIT",
              "The local Claude Code CLI exceeded the bridge JSON event limit.",
              true,
            );
          }
        }
        if (buffered.trim()) await parseLine(buffered);

        const outcome = await exit;
        if (outcome.error) throw outcome.error;
        const safetyFailure = safetyConfigurationFailure(
          stderrForClassification,
        );
        if (safetyFailure) throw safetyFailure;
        if (stopRequested) {
          if (pendingResult) await callbacks.onResult(pendingResult);
          return;
        }
        if (!initialized) {
          throw startupFailure(stderrForClassification);
        }
        if (outcome.code !== 0 || outcome.signal !== null) {
          if (
            outcome.signal === null &&
            pendingResult &&
            !pendingResult.success
          ) {
            await callbacks.onResult(pendingResult);
            return;
          }
          throw new BridgeError(
            "CLAUDE_CLI_UNCLEAN_EXIT",
            "The local Claude Code CLI did not exit cleanly after its turn.",
            true,
          );
        }
        if (!resultSeen) {
          throw new BridgeError(
            "CLAUDE_CLI_MISSING_RESULT",
            "The local Claude Code CLI exited without a final structured result.",
            true,
          );
        }
        if (!pendingResult) {
          throw new BridgeError(
            "CLAUDE_CLI_MISSING_RESULT",
            "The local Claude Code CLI did not produce a validated final result.",
            true,
          );
        }
        await callbacks.onResult(pendingResult);
      } catch (error) {
        const requested = stopRequested;
        await terminateUnexpectedProcess();
        if (!requested) {
          await callbacks.onError(runtimeFailure(error));
        }
      } finally {
        closed = true;
        await callbacks.onClose();
      }
    })();

    return {
      async interrupt(): Promise<void> {
        if (closed || processExited || stopRequested) return;
        stopRequested = true;
        signalProcess(child, "SIGTERM");
      },
      close(): void {
        if (closed || processExited) return;
        const escalate = stopRequested;
        stopRequested = true;
        signalProcess(child, escalate ? "SIGKILL" : "SIGTERM");
        if (!escalate) {
          const escalation = setTimeout(() => {
            if (!processExited) signalProcess(child, "SIGKILL");
          }, 500);
          escalation.unref();
        }
      },
      get done(): Promise<void> {
        return done;
      },
      get closed(): boolean {
        return closed;
      },
    };
  }
}

export const internalFinalOutputSchema = finalOutputSchema;
