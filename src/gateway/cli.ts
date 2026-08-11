#!/usr/bin/env node

/**
 * Local gateway foreground launcher and metadata-only control client.
 *
 * Provider identities and message bodies are accepted only from inherited
 * process state and stdin respectively. They are never reflected in output or
 * error text. Only `serve` owns the long-lived provider capabilities and
 * private control server; every other command is a bounded client operation.
 */
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import {
  getCliCopy,
  type CliCopyKey,
  type CliStderrKind,
} from "./cli-copy.js";
import { callerIdentityConflictHintEn } from "./cli-copy.en.js";
import { callerIdentityConflictHintZhCn } from "./cli-copy.zh-CN.js";
import {
  GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS,
  GATEWAY_CONTROL_MAX_MESSAGE_BYTES,
  GATEWAY_CONTROL_MAX_RESPONSE_BYTES,
  GATEWAY_CONTROL_PROTOCOL_VERSION,
  GatewayControlTransportError,
  isClaudeSessionSelector,
  isGatewayAlias,
  isGatewayConversationId,
  isGatewayDeliveryToken,
  isGatewayHostId,
  isGatewayReplyAddress,
  sendGatewayControlRequest,
  type GatewayControlMethod,
  type GatewayControlRequest,
  type GatewayControlResponse,
  type SendGatewayControlRequestOptions,
} from "./control.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import {
  isDashboardLocale,
  type DashboardLocale,
} from "./locale.js";
import {
  DEFAULT_LIVE_DASHBOARD_PORT,
  runLiveDashboardCommand,
  type LiveDashboardCommandOutcome,
  type LiveDashboardCommandOptions,
} from "./live-dashboard-command.js";
import {
  runGatewayServer,
  type GatewayServerOptions,
} from "./server.js";
import { PROGRESS_WATCH_DEFAULT_IDLE_MS } from "./progress-watch-machine.js";

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_HOST_ID = "this-mac";
const CLI_MAX_OUTPUT_BYTES = GATEWAY_CONTROL_MAX_RESPONSE_BYTES;
const DELIVERY_POLL_INTERVAL_MS = 250;
const DELIVERY_POLL_MIN_REQUEST_TIMEOUT_MS = 50;
export const EMBASSY_VERSION = "1.5.0";
const DEFAULT_CLI_LOCALE: DashboardLocale = "en";

export const gatewayCliCommands = [
  "serve",
  "health",
  "status",
  "delivery-status",
  "wait-delivery",
  "untrack",
  "refresh-dashboard",
  "dashboard",
  "register-codex",
  "unregister-codex",
  "select-claude",
  "unselect-claude",
  "pair",
  "unpair",
  "send-to-claude",
  "send-to-codex",
  "reply",
] as const;

export type GatewayCliCommand = (typeof gatewayCliCommands)[number];

export const gatewayCliExitCodes = Object.freeze({
  ok: 0,
  invalidInput: 2,
  rejected: 3,
  unavailable: 4,
  ambiguous: 5,
  failure: 6,
} as const);

type Writable = {
  write(chunk: string): unknown;
};

type GatewayControlSender = <M extends GatewayControlMethod>(
  options: SendGatewayControlRequestOptions<M>,
) => Promise<GatewayControlResponse<M>>;

type GatewayServerRunner = (options: GatewayServerOptions) => Promise<void>;
type LiveDashboardRunner = (
  options: LiveDashboardCommandOptions,
) => Promise<LiveDashboardCommandOutcome | void>;

export type GatewayCliDependencies = {
  env?: NodeJS.ProcessEnv;
  stdin?: AsyncIterable<unknown>;
  stdout?: Writable;
  stderr?: Writable;
  loadConfig?: (env: NodeJS.ProcessEnv) => GatewayConfig;
  sendRequest?: GatewayControlSender;
  runServer?: GatewayServerRunner;
  runLiveDashboard?: LiveDashboardRunner;
  serverSignal?: AbortSignal;
  liveDashboardSignal?: AbortSignal;
  validateControlSocket?: (
    stateDir: string,
    socketPath: string,
  ) => Promise<void>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
};

type ParsedOptions = Readonly<Record<string, string | true>>;

type CommonCliOptions = Readonly<{
  args: readonly string[];
  locale: DashboardLocale;
}>;

class CliFault extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly hint: CliFaultHint | undefined;
  readonly kind: CliStderrKind | undefined;

  constructor(
    code: string,
    retryable = false,
    hint?: CliFaultHint,
    kind?: CliStderrKind,
  ) {
    super("The gateway client rejected the request.");
    this.name = "CliFault";
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
    this.kind = kind;
  }
}

type CliFaultHint = CliCopyKey | "callerIdentityConflict";

function isCommand(value: string | undefined): value is GatewayCliCommand {
  return (
    value !== undefined &&
    (gatewayCliCommands as readonly string[]).includes(value)
  );
}

function parseOptions(
  args: readonly string[],
  valueNames: readonly string[],
  flagNames: readonly string[] = [],
): ParsedOptions {
  const values = new Set(valueNames);
  const flags = new Set(flagNames);
  const parsed: Record<string, string | true> = Object.create(null) as Record<
    string,
    string | true
  >;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--") || token.length <= 2) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    const name = token.slice(2);
    if (Object.hasOwn(parsed, name)) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    if (flags.has(name)) {
      parsed[name] = true;
      continue;
    }
    if (!values.has(name)) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    parsed[name] = value;
    index += 1;
  }

  return parsed;
}

function environmentLocale(env: NodeJS.ProcessEnv): DashboardLocale {
  const value = env.EMBASSY_LOCALE;
  if (value === undefined || value.length === 0) return DEFAULT_CLI_LOCALE;
  if (!isDashboardLocale(value)) throw new CliFault("INVALID_ARGUMENTS");
  return value;
}

function resolveCommonCliOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CommonCliOptions {
  const stripped: string[] = [];
  let locale: DashboardLocale | undefined;
  let sawLocale = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token !== "--lang") {
      if (token !== undefined) stripped.push(token);
      continue;
    }
    if (sawLocale) throw new CliFault("INVALID_ARGUMENTS");
    sawLocale = true;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    if (!isDashboardLocale(value)) {
      throw new CliFault("INVALID_ARGUMENTS");
    }
    locale = value;
    index += 1;
  }

  return {
    args: stripped,
    // Resolve the environment only when no valid explicit flag exists. This
    // lets an exact flag intentionally override even a malformed environment.
    locale: locale ?? environmentLocale(env),
  };
}

function fallbackCliLocale(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): DashboardLocale {
  const localeFlagIndices: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--lang") localeFlagIndices.push(index);
  }
  if (localeFlagIndices.length === 1) {
    const value = args[(localeFlagIndices[0] ?? -1) + 1];
    if (isDashboardLocale(value)) return value;
  }
  return isDashboardLocale(env.EMBASSY_LOCALE)
    ? env.EMBASSY_LOCALE
    : DEFAULT_CLI_LOCALE;
}

function fixedStderr(
  locale: DashboardLocale,
  kind: CliStderrKind,
): string {
  return `[embassy] ${getCliCopy(locale)[`error.${kind}`]}\n`;
}

function requireString(
  options: ParsedOptions,
  name: string,
): string {
  const value = options[name];
  if (typeof value !== "string") throw new CliFault("INVALID_ARGUMENTS");
  return value;
}

function assertExactOptionCount(
  options: ParsedOptions,
  minimum: number,
  maximum: number = minimum,
): void {
  const count = Object.keys(options).length;
  if (count < minimum || count > maximum) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
}

function requireAlias(options: ParsedOptions, name: string): string {
  const alias = requireString(options, name);
  if (!isGatewayAlias(alias)) throw new CliFault("INVALID_ARGUMENTS");
  return alias;
}

function requireCodexAlias(options: ParsedOptions, name: string): string {
  const alias = requireAlias(options, name);
  if (!alias.startsWith("codex-")) throw new CliFault("INVALID_ARGUMENTS");
  return alias;
}

function gatewayAliasHost(alias: string): string {
  return alias.slice(alias.lastIndexOf("@") + 1);
}

function requireClaudeSelector(options: ParsedOptions, name: string): string {
  const selector = requireString(options, name);
  if (!isClaudeSessionSelector(selector)) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  return selector;
}

function trackIdleMinutes(options: ParsedOptions): number | undefined {
  const tracking = options.track === true;
  const raw = options["idle-minutes"];
  if (raw !== undefined && !tracking) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  if (!tracking) return undefined;
  if (raw === undefined) return PROGRESS_WATCH_DEFAULT_IDLE_MS / 60_000;
  if (
    typeof raw !== "string" ||
    !/^[1-9][0-9]{0,3}$/.test(raw)
  ) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes > 24 * 60) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  return minutes;
}

function requireDeliveryToken(options: ParsedOptions, name: string): string {
  const token = requireString(options, name);
  if (!isGatewayDeliveryToken(token)) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  return token;
}

function requireCodexThreadId(env: NodeJS.ProcessEnv): string {
  const threadId = env.CODEX_THREAD_ID;
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
    throw new CliFault("CODEX_IDENTITY_REQUIRED");
  }
  return threadId.toLowerCase();
}

function hasInheritedIdentity(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function callerIdentityConflictFault(env: NodeJS.ProcessEnv): CliFault {
  const hasBothIdentities =
    hasInheritedIdentity(env.CODEX_THREAD_ID) &&
    hasInheritedIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET);
  return new CliFault(
    "CALLER_IDENTITY_CONFLICT",
    false,
    hasBothIdentities ? "callerIdentityConflict" : undefined,
  );
}

function requireExclusiveCodexThreadId(env: NodeJS.ProcessEnv): string {
  if (hasInheritedIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) {
    throw callerIdentityConflictFault(env);
  }
  return requireCodexThreadId(env);
}

function optionalCodexThreadId(env: NodeJS.ProcessEnv): string | undefined {
  const threadId = env.CODEX_THREAD_ID;
  if (threadId === undefined || threadId.length === 0) return undefined;
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new CliFault("CODEX_IDENTITY_REQUIRED");
  }
  return threadId.toLowerCase();
}

function optionalClaudeReplyAddress(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  // Claude Code 2.1.225 exports the raw socket path. The peer protocol's
  // transient callback capability is the same path with an explicit UDS
  // scheme; form it only in memory and leave generation validation to the
  // broker's pinned Claude adapter.
  if (
    socketPath.includes("\0") ||
    !path.isAbsolute(socketPath) ||
    path.resolve(socketPath) !== socketPath
  ) {
    throw new CliFault("CLAUDE_IDENTITY_INVALID");
  }
  const replyAddress = `uds:${socketPath}`;
  if (!isGatewayReplyAddress(replyAddress)) {
    throw new CliFault("CLAUDE_IDENTITY_INVALID");
  }
  return replyAddress;
}

function requireClaudeReplyAddress(env: NodeJS.ProcessEnv): string {
  const replyAddress = optionalClaudeReplyAddress(env);
  if (replyAddress === undefined) {
    throw new CliFault("CLAUDE_IDENTITY_REQUIRED");
  }
  return replyAddress;
}

function requireExclusiveClaudeReplyAddress(env: NodeJS.ProcessEnv): string {
  if (hasInheritedIdentity(env.CODEX_THREAD_ID)) {
    throw callerIdentityConflictFault(env);
  }
  return requireClaudeReplyAddress(env);
}

async function readMessageBody(stdin: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new CliFault("INVALID_MESSAGE_INPUT");
    }
    const buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk, "utf8");
    length += buffer.length;
    if (length > GATEWAY_CONTROL_MAX_MESSAGE_BYTES) {
      throw new CliFault("MESSAGE_TOO_LARGE", false, "hint.messageTooLarge");
    }
    chunks.push(buffer);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, length),
    );
  } catch {
    throw new CliFault("INVALID_MESSAGE_INPUT");
  }
  if (text.trim().length === 0 || text.includes("\0")) {
    throw new CliFault("MESSAGE_REQUIRED");
  }
  return text;
}

function emptyParams(args: readonly string[]): Record<string, never> {
  if (args.length !== 0) throw new CliFault("INVALID_ARGUMENTS");
  return {};
}

function parseServeInboundMode(args: readonly string[]): "paired" | "open" {
  const options = parseOptions(args, ["inbound"]);
  if (Object.keys(options).length === 0) return "paired";
  assertExactOptionCount(options, 1);
  if (options.inbound !== "open") throw new CliFault("INVALID_ARGUMENTS");
  return "open";
}

function parseLiveDashboardPort(value: string | true | undefined): number {
  if (value === undefined) return DEFAULT_LIVE_DASHBOARD_PORT;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new CliFault("INVALID_ARGUMENTS");
  }
  return port;
}

function parseLiveDashboardArgs(args: readonly string[]): number {
  if (args.length === 0) {
    throw new CliFault(
      "INVALID_ARGUMENTS",
      false,
      "hint.dashboardLiveRequired",
    );
  }
  const options = parseOptions(args, ["port"], ["live"]);
  assertExactOptionCount(options, 1, 2);
  if (options.live !== true) throw new CliFault("INVALID_ARGUMENTS");
  return parseLiveDashboardPort(options.port);
}

async function buildRequest(
  command: GatewayCliCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: AsyncIterable<unknown>,
): Promise<GatewayControlRequest> {
  switch (command) {
    case "serve":
    case "dashboard":
      throw new CliFault("INVALID_ARGUMENTS");
    case "health":
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "health",
        params: emptyParams(args),
      };
    case "status":
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "list_snapshot",
        params: emptyParams(args),
      };
    case "delivery-status":
    case "wait-delivery": {
      const options = parseOptions(args, ["token"]);
      assertExactOptionCount(options, 1);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "delivery_status",
        params: { token: requireDeliveryToken(options, "token") },
      };
    }
    case "untrack": {
      const options = parseOptions(args, ["conversation"]);
      assertExactOptionCount(options, 1);
      const conversationId = requireString(options, "conversation");
      if (!isGatewayConversationId(conversationId)) {
        throw new CliFault("INVALID_ARGUMENTS");
      }
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "untrack",
        params: { conversationId },
      };
    }
    case "refresh-dashboard":
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "refresh_dashboard",
        params: emptyParams(args),
      };
    case "register-codex": {
      const options = parseOptions(args, ["alias", "host", "succeeds"]);
      const alias = requireCodexAlias(options, "alias");
      const succeedsAlias =
        options.succeeds === undefined
          ? undefined
          : requireCodexAlias(options, "succeeds");
      if (succeedsAlias === undefined) {
        assertExactOptionCount(options, 1, 2);
      } else {
        assertExactOptionCount(options, 2);
        if (options.host !== undefined) {
          throw new CliFault("INVALID_ARGUMENTS");
        }
      }
      const host =
        succeedsAlias === undefined
          ? (options.host ?? DEFAULT_HOST_ID)
          : gatewayAliasHost(alias);
      if (
        typeof host !== "string" ||
        !isGatewayHostId(host) ||
        !alias.endsWith(`@${host}`) ||
        (succeedsAlias !== undefined &&
          (succeedsAlias === alias ||
            gatewayAliasHost(succeedsAlias) !== host))
      ) {
        throw new CliFault("INVALID_ARGUMENTS");
      }
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "register_codex",
        params: {
          alias,
          threadId: requireExclusiveCodexThreadId(env),
          hostId: host,
          busyPolicy: "queue",
          ...(succeedsAlias === undefined ? {} : { succeedsAlias }),
        },
      };
    }
    case "unregister-codex": {
      const options = parseOptions(args, ["alias"]);
      assertExactOptionCount(options, 1);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "unregister_codex",
        params: {
          alias: requireCodexAlias(options, "alias"),
          threadId: requireExclusiveCodexThreadId(env),
        },
      };
    }
    case "select-claude":
    case "unselect-claude": {
      const options = parseOptions(args, ["alias", "session"]);
      assertExactOptionCount(options, 1);
      const selector =
        options.alias === undefined
          ? requireClaudeSelector(options, "session")
          : requireClaudeSelector(options, "alias");
      const codexThreadId = optionalCodexThreadId(env);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method:
          command === "select-claude" ? "select_claude" : "unselect_claude",
        params: {
          alias: selector,
          ...(codexThreadId === undefined ? {} : { codexThreadId }),
        },
      };
    }
    case "pair":
    case "unpair": {
      const options = parseOptions(args, ["claude", "codex"]);
      assertExactOptionCount(options, 2);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: command,
        params: {
          claudeAlias: requireClaudeSelector(options, "claude"),
          codexAlias: requireCodexAlias(options, "codex"),
          codexThreadId: requireExclusiveCodexThreadId(env),
        },
      };
    }
    case "send-to-claude": {
      const options = parseOptions(
        args,
        ["from", "to", "idle-minutes"],
        ["expects-reply", "track"],
      );
      assertExactOptionCount(options, 2, 5);
      const threadId = requireExclusiveCodexThreadId(env);
      const idleMinutes = trackIdleMinutes(options);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "send_to_claude",
        params: {
          fromAlias: requireAlias(options, "from"),
          threadId,
          toAlias: requireClaudeSelector(options, "to"),
          text: await readMessageBody(stdin),
          expectsReply: options["expects-reply"] === true,
          ...(idleMinutes === undefined
            ? {}
            : { trackIdleMinutes: idleMinutes }),
        },
      };
    }
    case "send-to-codex": {
      const options = parseOptions(
        args,
        ["from", "to", "idle-minutes"],
        ["expects-reply", "track"],
      );
      assertExactOptionCount(options, 2, 5);
      const replyAddress = requireExclusiveClaudeReplyAddress(env);
      const idleMinutes = trackIdleMinutes(options);
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "send_to_codex",
        params: {
          fromAlias: requireAlias(options, "from"),
          toAlias: requireAlias(options, "to"),
          text: await readMessageBody(stdin),
          replyAddress,
          expectsReply: options["expects-reply"] === true,
          ...(idleMinutes === undefined
            ? {}
            : { trackIdleMinutes: idleMinutes }),
        },
      };
    }
    case "reply": {
      const options = parseOptions(
        args,
        ["conversation", "alias", "idle-minutes"],
        ["track"],
      );
      assertExactOptionCount(options, 2, 4);
      const conversationId = requireString(options, "conversation");
      if (!isGatewayConversationId(conversationId)) {
        throw new CliFault("INVALID_ARGUMENTS");
      }
      const alias = requireAlias(options, "alias");
      const idleMinutes = trackIdleMinutes(options);
      const threadId = env.CODEX_THREAD_ID;
      if (
        hasInheritedIdentity(threadId) &&
        hasInheritedIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)
      ) {
        throw callerIdentityConflictFault(env);
      }
      const replyAddress = optionalClaudeReplyAddress(env);
      const hasCodexIdentity = hasInheritedIdentity(threadId);
      const hasClaudeIdentity = replyAddress !== undefined;
      if (!hasCodexIdentity && !hasClaudeIdentity) {
        throw new CliFault("CALLER_IDENTITY_REQUIRED");
      }
      return {
        protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
        method: "reply",
        params: {
          conversationId,
          text: await readMessageBody(stdin),
          ...(idleMinutes === undefined
            ? {}
            : { trackIdleMinutes: idleMinutes }),
          caller: hasCodexIdentity
            ? {
                kind: "codex",
                alias,
                threadId: requireCodexThreadId(env),
              }
            : {
                kind: "claude",
                alias,
                replyAddress: requireClaudeReplyAddress(env),
              },
        },
      };
    }
  }
}

export async function validatePrivateGatewayControlSocket(
  stateDir: string,
  socketPath: string,
): Promise<void> {
  if (process.platform === "win32") {
    throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true);
  }
  let state;
  let socket;
  try {
    [state, socket] = await Promise.all([lstat(stateDir), lstat(socketPath)]);
  } catch {
    throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true);
  }
  const getuid = process.getuid;
  const expectedUid = getuid?.call(process);
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    (state.mode & 0o700) !== 0o700 ||
    (state.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && state.uid !== expectedUid)
  ) {
    throw new CliFault("CONTROL_STATE_UNSAFE", false, undefined, "unsafe");
  }
  if (
    socket.isSymbolicLink() ||
    !socket.isSocket() ||
    (socket.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && socket.uid !== expectedUid)
  ) {
    throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe");
  }

  let stateReal: string;
  let socketParentReal: string;
  try {
    [stateReal, socketParentReal] = await Promise.all([
      realpath(stateDir),
      realpath(path.dirname(socketPath)),
    ]);
  } catch {
    throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe");
  }
  if (
    path.dirname(socketPath) !== stateDir ||
    stateReal !== socketParentReal
  ) {
    throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe");
  }
}

function safeCommandLabel(command: GatewayCliCommand | undefined): string {
  return command ?? "unknown";
}

function serializedOutput(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > CLI_MAX_OUTPUT_BYTES) {
    throw new CliFault("OUTPUT_TOO_LARGE");
  }
  return line;
}

function writeFailure(
  stdout: Writable,
  stderr: Writable,
  locale: DashboardLocale,
  command: GatewayCliCommand | undefined,
  code: string,
  options: { ambiguous?: boolean; retryable?: boolean; kind: CliStderrKind },
): void {
  const ambiguous = options.ambiguous ?? false;
  const retryable = options.retryable ?? false;
  stdout.write(
    serializedOutput({
      ok: false,
      command: safeCommandLabel(command),
      error: { code, ambiguous, retryable },
    }),
  );
  stderr.write(fixedStderr(locale, options.kind));
}

function isRejectedResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    Object.hasOwn(result, "accepted") &&
    (result as { accepted?: unknown }).accepted === false
  );
}

function isProgressWatchOwnerConflict(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    Object.hasOwn(result, "accepted") &&
    Object.hasOwn(result, "code") &&
    (result as { accepted?: unknown }).accepted === false &&
    (result as { code?: unknown }).code === "watch_owner_conflict"
  );
}

function responseExitCode(response: GatewayControlResponse): number {
  if (!response.ok) return gatewayCliExitCodes.failure;
  if (isRejectedResult(response.result)) return gatewayCliExitCodes.rejected;
  return gatewayCliExitCodes.ok;
}

function waitDeliveryExitCode(
  response: GatewayControlResponse<"delivery_status">,
): number {
  if (
    !response.ok ||
    !response.result.found ||
    !response.result.terminal
  ) {
    return gatewayCliExitCodes.failure;
  }
  return response.result.state === "delivered"
    ? gatewayCliExitCodes.ok
    : gatewayCliExitCodes.failure;
}

type DeliveryStatusRequest = Extract<
  GatewayControlRequest,
  { method: "delivery_status" }
>;

type WaitDeliveryOutcome =
  | {
      kind: "response";
      response: GatewayControlResponse<"delivery_status">;
    }
  | { kind: "unknown" }
  | { kind: "timeout" };

async function defaultDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDelivery(
  socketPath: string,
  request: DeliveryStatusRequest,
  sendRequest: GatewayControlSender,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<WaitDeliveryOutcome> {
  let clientDeadlineMs: number | undefined;

  while (true) {
    const beforeRequest = now();
    let requestTimeoutMs = GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
    if (clientDeadlineMs !== undefined) {
      const remainingMs = clientDeadlineMs - beforeRequest;
      if (remainingMs <= 0) return { kind: "timeout" };
      if (remainingMs < DELIVERY_POLL_MIN_REQUEST_TIMEOUT_MS) {
        await delay(remainingMs);
        return { kind: "timeout" };
      }
      requestTimeoutMs = Math.min(
        GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS,
        Math.floor(remainingMs),
      );
    }

    let response: GatewayControlResponse<"delivery_status">;
    try {
      response = await sendRequest({
        socketPath,
        request,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      if (
        clientDeadlineMs !== undefined &&
        now() >= clientDeadlineMs &&
        error instanceof GatewayControlTransportError &&
        error.recoverable
      ) {
        return { kind: "timeout" };
      }
      throw error;
    }

    if (!response.ok) {
      if (
        response.error.code === "REQUEST_TIMEOUT" &&
        clientDeadlineMs !== undefined &&
        now() >= clientDeadlineMs
      ) {
        return { kind: "timeout" };
      }
      return { kind: "response", response };
    }
    if (!response.result.found) return { kind: "unknown" };
    // A retained terminal decision is authoritative even when the command is
    // invoked after the original delivery deadline and client grace window.
    if (response.result.terminal) {
      return { kind: "response", response };
    }

    const parsedDeadlineMs = Date.parse(response.result.deadlineAt);
    if (!Number.isFinite(parsedDeadlineMs)) {
      throw new Error("invalid validated delivery deadline");
    }
    const observedClientDeadlineMs =
      parsedDeadlineMs + GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
    clientDeadlineMs =
      clientDeadlineMs === undefined
        ? observedClientDeadlineMs
        : Math.min(clientDeadlineMs, observedClientDeadlineMs);
    const afterRequest = now();
    const remainingMs = clientDeadlineMs - afterRequest;
    if (remainingMs <= 0) return { kind: "timeout" };
    await delay(Math.min(DELIVERY_POLL_INTERVAL_MS, remainingMs));
  }
}

/** Run one command; foreground runners own and release their signal handlers. */
export async function runGatewayCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: GatewayCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const loadConfig = dependencies.loadConfig ?? loadGatewayConfig;
  const sendRequest = dependencies.sendRequest ?? sendGatewayControlRequest;
  const validateControlSocket =
    dependencies.validateControlSocket ?? validatePrivateGatewayControlSocket;
  const runServer = dependencies.runServer ?? runGatewayServer;
  const runLiveDashboard =
    dependencies.runLiveDashboard ?? runLiveDashboardCommand;
  const now = dependencies.now ?? Date.now;
  const delay = dependencies.delay ?? defaultDelay;
  if (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-v")
  ) {
    stdout.write(`embassy ${EMBASSY_VERSION}\n`);
    return gatewayCliExitCodes.ok;
  }
  const command = isCommand(argv[0]) ? argv[0] : undefined;
  let locale = fallbackCliLocale(argv.slice(1), env);
  let serverReadyEmitted = false;
  let liveDashboardReadyEmitted = false;
  let liveDashboardPort: number | undefined;

  try {
    const common = resolveCommonCliOptions(argv.slice(1), env);
    locale = common.locale;
    if (
      argv.length === 0 ||
      argv[0] === "--help" ||
      argv[0] === "-h"
    ) {
      emptyParams(common.args);
      stdout.write(getCliCopy(locale)["help.usage"]);
      return gatewayCliExitCodes.ok;
    }
    if (command === undefined) throw new CliFault("UNKNOWN_COMMAND");
    if (command === "serve") {
      const inboundMode = parseServeInboundMode(common.args);
      await runServer({
        env,
        locale,
        inboundMode,
        ...(dependencies.serverSignal === undefined
          ? {}
          : { signal: dependencies.serverSignal }),
        onReady: async (result) => {
          if (serverReadyEmitted) {
            throw new CliFault("SERVER_READY_ALREADY_EMITTED");
          }
          stdout.write(
            serializedOutput({
              ok: true,
              command,
              result,
            }),
          );
          serverReadyEmitted = true;
        },
      });
      if (!serverReadyEmitted) {
        throw new CliFault("SERVER_NOT_READY");
      }
      return gatewayCliExitCodes.ok;
    }
    if (command === "dashboard") {
      const port = parseLiveDashboardArgs(common.args);
      liveDashboardPort = port;
      const outcome = await runLiveDashboard({
        env,
        locale,
        port,
        ...(dependencies.liveDashboardSignal === undefined
          ? {}
          : { signal: dependencies.liveDashboardSignal }),
        loadConfig,
        validateControlSocket,
        sendRequest,
        onReady: async (result) => {
          if (liveDashboardReadyEmitted) {
            throw new CliFault("LIVE_DASHBOARD_READY_ALREADY_EMITTED");
          }
          stdout.write(
            serializedOutput({
              ok: true,
              command,
              result,
            }),
          );
          liveDashboardReadyEmitted = true;
        },
      });
      if (!liveDashboardReadyEmitted) {
        if (outcome?.status === "cancelled") {
          return gatewayCliExitCodes.ok;
        }
        throw new Error("LIVE_DASHBOARD_NOT_READY");
      }
      return gatewayCliExitCodes.ok;
    }
    const request = await buildRequest(command, common.args, env, stdin);
    const config = loadConfig(env);
    await validateControlSocket(config.stateDir, config.controlSocketPath);
    let response: GatewayControlResponse;
    let waitedDeliveryResponse:
      | GatewayControlResponse<"delivery_status">
      | undefined;
    if (command === "wait-delivery") {
      if (request.method !== "delivery_status") {
        throw new CliFault("INVALID_ARGUMENTS");
      }
      const outcome = await waitForDelivery(
        config.controlSocketPath,
        request,
        sendRequest,
        now,
        delay,
      );
      if (outcome.kind === "unknown") {
        writeFailure(stdout, stderr, locale, command, "DELIVERY_TOKEN_UNKNOWN", {
          kind: "tokenUnknown",
        });
        return gatewayCliExitCodes.rejected;
      }
      if (outcome.kind === "timeout") {
        writeFailure(stdout, stderr, locale, command, "DELIVERY_WAIT_TIMEOUT", {
          retryable: true,
          kind: "deliveryTimeout",
        });
        return gatewayCliExitCodes.unavailable;
      }
      waitedDeliveryResponse = outcome.response;
      response = waitedDeliveryResponse;
    } else {
      response = await sendRequest({
        socketPath: config.controlSocketPath,
        request,
      });
    }
    if (!response.ok) {
      writeFailure(stdout, stderr, locale, command, response.error.code, {
        kind: "failure",
      });
      return gatewayCliExitCodes.failure;
    }

    stdout.write(
      serializedOutput({
        ok: true,
        command,
        result: response.result,
      }),
    );
    const exitCode =
      waitedDeliveryResponse === undefined
        ? responseExitCode(response)
        : waitDeliveryExitCode(waitedDeliveryResponse);
    if (exitCode === gatewayCliExitCodes.rejected) {
      stderr.write(fixedStderr(locale, "decision"));
      if (isProgressWatchOwnerConflict(response.result)) {
        stderr.write(
          `[embassy] ${getCliCopy(locale)["hint.progressWatchOwnerConflict"]}\n`,
        );
      }
    } else if (
      command === "wait-delivery" &&
      exitCode === gatewayCliExitCodes.failure
    ) {
      stderr.write(fixedStderr(locale, "failure"));
    }
    return exitCode;
  } catch (error) {
    if (
      (command === "serve" && serverReadyEmitted) ||
      (command === "dashboard" && liveDashboardReadyEmitted)
    ) {
      stderr.write(fixedStderr(locale, "failure"));
      return gatewayCliExitCodes.failure;
    }
    if (error instanceof GatewayControlTransportError) {
      const ambiguous = error.ambiguous;
      writeFailure(stdout, stderr, locale, command, error.code, {
        ambiguous,
        retryable: ambiguous ? false : error.recoverable,
        kind: ambiguous ? "ambiguous" : "unavailable",
      });
      if (error.code === "CONTROL_INVALID_RESPONSE") {
        stderr.write(
          `[embassy] ${getCliCopy(locale)["hint.controlInvalidResponse"]}\n`,
        );
      }
      return ambiguous
        ? gatewayCliExitCodes.ambiguous
        : gatewayCliExitCodes.unavailable;
    }
    if (error instanceof CliFault) {
      writeFailure(stdout, stderr, locale, command, error.code, {
        retryable: error.retryable,
        kind: error.kind ?? (error.retryable ? "unavailable" : "input"),
      });
      if (error.hint !== undefined) {
        const hint =
          error.hint === "callerIdentityConflict"
            ? locale === "zh-CN"
              ? callerIdentityConflictHintZhCn
              : callerIdentityConflictHintEn
            : getCliCopy(locale)[error.hint];
        stderr.write(`[embassy] ${hint}\n`);
      }
      return error.retryable
        ? gatewayCliExitCodes.unavailable
        : gatewayCliExitCodes.invalidInput;
    }
    if (error instanceof BridgeError) {
      writeFailure(stdout, stderr, locale, command, error.code, {
        retryable: error.recoverable,
        kind: error.recoverable ? "unavailable" : "input",
      });
      if (
        error.code === "LIVE_DASHBOARD_PORT_IN_USE" &&
        liveDashboardPort !== undefined
      ) {
        const hint = getCliCopy(locale)["hint.dashboardPortInUse"].replace(
          "{port}",
          String(liveDashboardPort),
        );
        stderr.write(
          `[embassy] ${hint}\n`,
        );
      }
      return error.recoverable
        ? gatewayCliExitCodes.unavailable
        : gatewayCliExitCodes.invalidInput;
    }
    writeFailure(stdout, stderr, locale, command, "INTERNAL_ERROR", {
      kind: "failure",
    });
    return gatewayCliExitCodes.failure;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // npm exposes package binaries through symlinks. Compare canonical paths
    // so an installed `embassy` executable is recognized as the entry point,
    // while importing this module in tests remains side-effect free.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void runGatewayCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write(
        fixedStderr(
          fallbackCliLocale(process.argv.slice(3), process.env),
          "failure",
        ),
      );
      process.exitCode = gatewayCliExitCodes.failure;
    },
  );
}
