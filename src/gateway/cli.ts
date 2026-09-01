#!/usr/bin/env node

/** Foreground broker plus bounded metadata-only control client. */
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import { getCliCopy, type CliCopyKey, type CliStderrKind } from "./cli-copy.js";
import { callerIdentityConflictHintEn } from "./cli-copy.en.js";
import { callerIdentityConflictHintZhCn } from "./cli-copy.zh-CN.js";
import { GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS, GATEWAY_CONTROL_MAX_MESSAGE_BYTES,
  GATEWAY_CONTROL_MAX_RESPONSE_BYTES, GATEWAY_CONTROL_PROTOCOL_VERSION,
  GatewayControlTransportError, isClaudeSessionSelector, isGatewayAlias,
  isGatewayConversationId, isGatewayDeliveryToken,
  isGatewayReplyAddress, sendGatewayControlRequest, type GatewayControlMethod,
  type GatewayControlRequest, type GatewayControlResponse,
  type SendGatewayControlRequestOptions } from "./control.js";
import { defaultGatewayStateDir, loadGatewayConfig, type GatewayConfig } from "./config.js";
import { loadGatewayNodeInventory, type GatewayNodeInventory } from "./federation-nodes.js";
import { isDashboardLocale, type DashboardLocale } from "./locale.js";
import { DEFAULT_LIVE_DASHBOARD_PORT, runLiveDashboardCommand,
  type LiveDashboardCommandOutcome, type LiveDashboardCommandOptions } from "./live-dashboard-command.js";
import { runGatewayServer, type GatewayServerOptions } from "./server.js";
import { PROGRESS_WATCH_DEFAULT_IDLE_MS } from "./progress-watch-machine.js";
import { PeerHandlerError, runPeerStdio, type PeerStdioSession } from "./peer-stdio.js";

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLI_MAX_OUTPUT_BYTES = GATEWAY_CONTROL_MAX_RESPONSE_BYTES;
const DELIVERY_POLL_INTERVAL_MS = 250;
const DELIVERY_POLL_MIN_REQUEST_TIMEOUT_MS = 50;
const PEER_AWAIT_REQUEST_TIMEOUT_MS = 35_000;
export const EMBASSY_VERSION = "2.0.1";
// RELEASE VERSION SWEEP — every place the version lives: package.json,
// npm-shrinkwrap.json (x2), this constant,
// test/gateway-cli.test.ts package-metadata assertion.
const DEFAULT_CLI_LOCALE: DashboardLocale = "en";

export const gatewayCliCommands = [
  "serve", "health", "status", "doctor", "delivery-status",
  "wait-delivery", "untrack", "refresh-dashboard", "dashboard", "register-codex",
  "unregister-codex", "select-claude", "unselect-claude", "pair", "unpair",
  "send", "reply",
  "register-peer", "unregister-peer", "await",
  "peer-stdio",
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

type Writable = { write(chunk: string, callback?: (error?: Error | null) => void): unknown };
type GatewayControlSender = <M extends GatewayControlMethod>(options: SendGatewayControlRequestOptions<M>) => Promise<GatewayControlResponse<M>>;
type GatewayServerRunner = (options: GatewayServerOptions) => Promise<void>;
type LiveDashboardRunner = (options: LiveDashboardCommandOptions) => Promise<LiveDashboardCommandOutcome | void>;
type PeerStdioRunner = (options: Parameters<typeof runPeerStdio>[0]) => PeerStdioSession;

export type GatewayCliDependencies = {
  env?: NodeJS.ProcessEnv;
  stdin?: AsyncIterable<unknown>;
  stdout?: Writable;
  stderr?: Writable;
  loadConfig?: (env: NodeJS.ProcessEnv, inventory: GatewayNodeInventory) => GatewayConfig;
  loadNodeInventory?: (stateDir: string) => Promise<GatewayNodeInventory>;
  sendRequest?: GatewayControlSender;
  runServer?: GatewayServerRunner;
  runLiveDashboard?: LiveDashboardRunner;
  serverSignal?: AbortSignal;
  liveDashboardSignal?: AbortSignal;
  validateControlSocket?: (stateDir: string, socketPath: string) => Promise<void>;
  runPeerStdio?: PeerStdioRunner;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
};

type ParsedOptions = Readonly<Record<string, string | true>>;
type CliFaultHint = CliCopyKey | "callerIdentityConflict";
class CliFault extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly hint?: CliFaultHint,
    readonly kind?: CliStderrKind,
  ) {
    super("The gateway client rejected the request.");
    this.name = "CliFault";
  }
}
function fault(code = "INVALID_ARGUMENTS"): never { throw new CliFault(code); }
const isCommand = (value: string | undefined): value is GatewayCliCommand =>
  value !== undefined && (gatewayCliCommands as readonly string[]).includes(value);

function parseOptions(
  args: readonly string[],
  valueNames: readonly string[],
  flagNames: readonly string[] = [],
): ParsedOptions {
  const values = new Set(valueNames), flags = new Set(flagNames);
  const parsed: Record<string, string | true> = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined || !token.startsWith("--") || token.length <= 2) fault();
    const name = token.slice(2);
    if (Object.hasOwn(parsed, name)) fault();
    if (flags.has(name)) { parsed[name] = true; continue; }
    if (!values.has(name)) fault();
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) fault();
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}
function commonOptions(args: readonly string[], env: NodeJS.ProcessEnv) {
  const stripped: string[] = [];
  let locale: DashboardLocale | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token !== "--lang") { if (token !== undefined) stripped.push(token); continue; }
    if (locale !== undefined) fault();
    const value = args[index + 1];
    if (!isDashboardLocale(value)) fault();
    locale = value;
    index += 1;
  }
  const inherited = env.EMBASSY_LOCALE;
  if (locale === undefined && inherited !== undefined && inherited.length > 0 && !isDashboardLocale(inherited)) fault();
  return {
    args: stripped,
    locale: locale ?? (isDashboardLocale(inherited) ? inherited : DEFAULT_CLI_LOCALE),
  };
}
function fallbackCliLocale(args: readonly string[], env: NodeJS.ProcessEnv): DashboardLocale {
  const indices = args.flatMap((value, index) => value === "--lang" ? [index] : []);
  const flagged = indices.length === 1 ? args[indices[0]! + 1] : undefined;
  return isDashboardLocale(flagged) ? flagged
    : isDashboardLocale(env.EMBASSY_LOCALE) ? env.EMBASSY_LOCALE : DEFAULT_CLI_LOCALE;
}
const fixedStderr = (locale: DashboardLocale, kind: CliStderrKind): string =>
  `[embassy] ${getCliCopy(locale)[`error.${kind}`]}\n`;
function requireString(options: ParsedOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string") fault();
  return value;
}
function count(options: ParsedOptions, minimum: number, maximum = minimum): void {
  const count = Object.keys(options).length;
  if (count < minimum || count > maximum) fault();
}
function requireAlias(options: ParsedOptions, name: string): string {
  const alias = requireString(options, name);
  if (!isGatewayAlias(alias)) fault();
  return alias;
}
function requireCodexAlias(options: ParsedOptions, name: string): string {
  const alias = requireAlias(options, name);
  if (!alias.startsWith("codex-")) fault();
  return alias;
}
const gatewayAliasHost = (alias: string): string => alias.slice(alias.lastIndexOf("@") + 1);
function requirePairAliases(options: ParsedOptions): readonly [string, string] {
  const from = requireAlias(options, "from");
  const to = requireAlias(options, "to");
  if (from === to) fault();
  return [from, to];
}
function requireClaudeSelector(options: ParsedOptions, name: string): string {
  const selector = requireString(options, name);
  if (!isClaudeSessionSelector(selector)) fault();
  return selector;
}
function trackIdleMinutes(options: ParsedOptions): number | undefined {
  const tracking = options.track === true;
  const raw = options["idle-minutes"];
  if (raw !== undefined && !tracking) fault();
  if (!tracking) return undefined;
  if (raw === undefined) return PROGRESS_WATCH_DEFAULT_IDLE_MS / 60_000;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,3}$/.test(raw)) fault();
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes > 24 * 60) fault();
  return minutes;
}
function requireDeliveryToken(options: ParsedOptions, name: string): string {
  const token = requireString(options, name);
  if (!isGatewayDeliveryToken(token)) fault();
  return token;
}
function requireCodexThreadId(env: NodeJS.ProcessEnv): string {
  const threadId = env.CODEX_THREAD_ID;
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) fault("CODEX_IDENTITY_REQUIRED");
  return threadId.toLowerCase();
}
const hasIdentity = (value: string | undefined): boolean => typeof value === "string" && value.length > 0;
const PEER_TOKEN_PATTERN = /^peer_[A-Za-z0-9_-]{32}$/;
function peerTokenSource(options: ParsedOptions, env: NodeJS.ProcessEnv): string | "stdin" | undefined {
  const inherited = env.EMBASSY_PEER_TOKEN;
  if ((options["token-stdin"] === true || hasIdentity(inherited)) &&
      (hasIdentity(env.CODEX_THREAD_ID) || hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET))) throw callerIdentityConflictFault(env);
  if (options["token-stdin"] === true && hasIdentity(inherited)) throw callerIdentityConflictFault(env);
  if (hasIdentity(inherited) && !PEER_TOKEN_PATTERN.test(inherited!)) fault("CALLER_IDENTITY_REQUIRED");
  return options["token-stdin"] === true ? "stdin" : hasIdentity(inherited) ? inherited : undefined;
}
function requirePeerAlias(options: ParsedOptions): string {
  const alias = requireAlias(options, "alias");
  if (!alias.startsWith("peer-")) fault();
  return alias;
}
function callerIdentityConflictFault(env: NodeJS.ProcessEnv): CliFault {
  const both = hasIdentity(env.CODEX_THREAD_ID) && hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET);
  return new CliFault("CALLER_IDENTITY_CONFLICT", false, both ? "callerIdentityConflict" : undefined);
}
function requireExclusiveCodexThreadId(env: NodeJS.ProcessEnv): string {
  if (hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) throw callerIdentityConflictFault(env);
  return requireCodexThreadId(env);
}
function optionalClaudeReplyAddress(env: NodeJS.ProcessEnv): string | undefined {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  if (socketPath.includes("\0") || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath) fault("CLAUDE_IDENTITY_INVALID");
  const replyAddress = `uds:${socketPath}`;
  if (!isGatewayReplyAddress(replyAddress)) fault("CLAUDE_IDENTITY_INVALID");
  return replyAddress;
}
function requireClaudeReplyAddress(env: NodeJS.ProcessEnv): string {
  const replyAddress = optionalClaudeReplyAddress(env);
  if (replyAddress === undefined) fault("CLAUDE_IDENTITY_REQUIRED");
  return replyAddress;
}
function requireExclusiveClaudeReplyAddress(env: NodeJS.ProcessEnv): string {
  if (hasIdentity(env.CODEX_THREAD_ID)) throw callerIdentityConflictFault(env);
  return requireClaudeReplyAddress(env);
}
async function readMessageBody(stdin: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) fault("INVALID_MESSAGE_INPUT");
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > GATEWAY_CONTROL_MAX_MESSAGE_BYTES) throw new CliFault("MESSAGE_TOO_LARGE", false, "hint.messageTooLarge");
    chunks.push(buffer);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)); }
  catch { fault("INVALID_MESSAGE_INPUT"); }
  if (text.trim().length === 0 || text.includes("\0")) fault("MESSAGE_REQUIRED");
  return text;
}
async function readPeerInput(stdin: AsyncIterable<unknown>, source: string | "stdin", body: boolean) {
  if (source !== "stdin") return { token: source, ...(body ? { text: await readMessageBody(stdin) } : {}) };
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of stdin) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) fault("INVALID_MESSAGE_INPUT");
    const buffer = Buffer.from(chunk); length += buffer.length;
    if (length > GATEWAY_CONTROL_MAX_MESSAGE_BYTES + 38) throw new CliFault("MESSAGE_TOO_LARGE", false, "hint.messageTooLarge");
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks, length), newline = value.indexOf(0x0a);
  if (newline !== 37 || !PEER_TOKEN_PATTERN.test(value.subarray(0, newline).toString("utf8")) || (!body && newline !== value.length - 1)) fault("INVALID_MESSAGE_INPUT");
  const token = value.subarray(0, newline).toString("utf8");
  if (!body) return { token };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(newline + 1)); }
  catch { fault("INVALID_MESSAGE_INPUT"); }
  if (text.trim().length === 0 || text.includes("\0")) fault("MESSAGE_REQUIRED");
  return { token, text };
}
const emptyParams = (args: readonly string[]): Record<string, never> => args.length === 0 ? {} : fault();
function parseServeInboundMode(args: readonly string[]): "paired" | "open" {
  const options = parseOptions(args, ["inbound"]);
  if (Object.keys(options).length === 0) return "paired";
  count(options, 1);
  if (options.inbound !== "open") fault();
  return "open";
}
function parseLiveDashboardPort(value: string | true | undefined): number {
  if (value === undefined) return DEFAULT_LIVE_DASHBOARD_PORT;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) fault();
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) fault();
  return port;
}
function parseLiveDashboardArgs(args: readonly string[]): number {
  if (args.length === 0) throw new CliFault("INVALID_ARGUMENTS", false, "hint.dashboardLiveRequired");
  const options = parseOptions(args, ["port"], ["live"]);
  count(options, 1, 2);
  if (options.live !== true) fault();
  return parseLiveDashboardPort(options.port);
}
const envelope = (method: GatewayControlMethod, params: unknown): GatewayControlRequest =>
  ({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method, params }) as GatewayControlRequest;
async function buildRequest(
  command: GatewayCliCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: AsyncIterable<unknown>,
  loadLocalHost: () => Promise<string>,
): Promise<GatewayControlRequest> {
  const simple: Partial<Record<GatewayCliCommand, GatewayControlMethod>> = {
    health: "health", status: "list_snapshot", doctor: "list_snapshot",
    "refresh-dashboard": "refresh_dashboard",
  };
  const simpleMethod = simple[command];
  if (simpleMethod !== undefined) return envelope(simpleMethod, emptyParams(args));
  switch (command) {
    case "serve":
    case "dashboard":
    case "peer-stdio":
      return fault();
    case "health": case "status": case "doctor": case "refresh-dashboard": return fault();
    case "delivery-status":
    case "wait-delivery": {
      const options = parseOptions(args, ["token"]);
      count(options, 1);
      return envelope("delivery_status", { token: requireDeliveryToken(options, "token") });
    }
    case "untrack": {
      const options = parseOptions(args, ["conversation"]);
      count(options, 1);
      const conversationId = requireString(options, "conversation");
      if (!isGatewayConversationId(conversationId)) fault();
      return envelope("untrack", { conversationId });
    }
    case "register-codex": {
      const options = parseOptions(args, ["alias", "succeeds"]);
      const alias = requireCodexAlias(options, "alias");
      const succeedsAlias = options.succeeds === undefined ? undefined : requireCodexAlias(options, "succeeds");
      count(options, succeedsAlias === undefined ? 1 : 2, 2);
      const threadId = requireExclusiveCodexThreadId(env);
      if (succeedsAlias === alias) fault();
      const localHost = await loadLocalHost();
      if (
        !alias.endsWith(`@${localHost}`) ||
        (succeedsAlias !== undefined && gatewayAliasHost(succeedsAlias) !== localHost)
      ) fault();
      return envelope("register_codex", {
        alias, threadId, hostId: localHost, busyPolicy: "queue",
        ...(succeedsAlias === undefined ? {} : { succeedsAlias }),
      });
    }
    case "unregister-codex": {
      const options = parseOptions(args, ["alias"]);
      count(options, 1);
      return envelope("unregister_codex", { alias: requireCodexAlias(options, "alias"), threadId: requireExclusiveCodexThreadId(env) });
    }
    case "register-peer":
    case "unregister-peer":
    case "await": {
      const options = parseOptions(args, ["alias"], ["token-stdin", "emit-env"]);
      count(options, 1, 3);
      const alias = requirePeerAlias(options), source = peerTokenSource(options, env);
      if (hasIdentity(env.CODEX_THREAD_ID) || hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) throw callerIdentityConflictFault(env);
      if (command !== "register-peer" && options["emit-env"] === true) fault();
      if (options["emit-env"] === true && source !== undefined) fault();
      if (source === undefined) {
        if (command !== "register-peer") fault("CALLER_IDENTITY_REQUIRED");
        return envelope("register_peer", { alias });
      }
      const { token } = await readPeerInput(stdin, source, false);
      return envelope(command === "register-peer" ? "register_peer" : command === "unregister-peer" ? "unregister_peer" : "await_peer", { alias, token });
    }
    case "select-claude":
    case "unselect-claude": {
      const options = parseOptions(args, ["alias", "session"]);
      count(options, 1);
      const selector = requireClaudeSelector(options, options.alias === undefined ? "session" : "alias");
      return envelope(command === "select-claude" ? "select_claude" : "unselect_claude", { alias: selector });
    }
    case "pair":
    case "unpair": {
      const options = parseOptions(args, ["from", "to"]);
      count(options, 2);
      return envelope(command, { aliases: requirePairAliases(options) });
    }
    case "send": {
      const options = parseOptions(
        args, ["from", "to", "idle-minutes"], ["expects-reply", "track", "token-stdin"],
      );
      count(options, 2, 6);
      const source = peerTokenSource(options, env);
      const principals = Number(hasIdentity(env.CODEX_THREAD_ID)) + Number(hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) + Number(source !== undefined);
      if (principals > 1) throw callerIdentityConflictFault(env);
      const fromAlias = requireAlias(options, "from");
      const toAlias = requireClaudeSelector(options, "to");
      const idleMinutes = trackIdleMinutes(options);
      const peer = source === undefined ? undefined : await readPeerInput(stdin, source, true);
      const authority = peer === undefined ? hasIdentity(env.CODEX_THREAD_ID)
        ? { threadId: requireExclusiveCodexThreadId(env) }
        : { replyAddress: requireExclusiveClaudeReplyAddress(env) }
        : { peerToken: peer.token };
      const common = {
        fromAlias, toAlias, text: peer?.text ?? await readMessageBody(stdin),
        expectsReply: options["expects-reply"] === true,
        ...(idleMinutes === undefined ? {} : { trackIdleMinutes: idleMinutes }),
      };
      return envelope("send", { ...common, ...authority });
    }
    case "reply": {
      const options = parseOptions(args, ["conversation", "alias", "idle-minutes"], ["track", "token-stdin"]);
      count(options, 2, 5);
      const conversationId = requireString(options, "conversation");
      if (!isGatewayConversationId(conversationId)) fault();
      const alias = requireAlias(options, "alias");
      const idleMinutes = trackIdleMinutes(options);
      const threadId = env.CODEX_THREAD_ID, source = peerTokenSource(options, env);
      const principals = Number(hasIdentity(threadId)) + Number(hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) + Number(source !== undefined);
      if (principals > 1) throw callerIdentityConflictFault(env);
      const replyAddress = optionalClaudeReplyAddress(env);
      const codex = hasIdentity(threadId);
      if (!codex && replyAddress === undefined && source === undefined) fault("CALLER_IDENTITY_REQUIRED");
      const peer = source === undefined ? undefined : await readPeerInput(stdin, source, true);
      return envelope("reply", {
        conversationId, text: peer?.text ?? await readMessageBody(stdin),
        ...(idleMinutes === undefined ? {} : { trackIdleMinutes: idleMinutes }),
        caller: peer !== undefined ? { kind: "peer", alias, token: peer.token } : codex
          ? { kind: "codex", alias, threadId: requireCodexThreadId(env) }
          : { kind: "claude", alias, replyAddress: requireClaudeReplyAddress(env) },
      });
    }
  }
}

export async function validatePrivateGatewayControlSocket(
  stateDir: string,
  socketPath: string,
): Promise<void> {
  if (process.platform === "win32") throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true);
  let state, socket;
  try {
    [state, socket] = await Promise.all([lstat(stateDir), lstat(socketPath)]);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code : undefined;
    if (code === "EPERM" || code === "EACCES")
      throw new CliFault("CONTROL_CONNECT_DENIED", true, "hint.controlConnectDenied");
    throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true);
  }
  const uid = process.getuid?.();
  if (state.isSymbolicLink() || !state.isDirectory() || (state.mode & 0o777) !== 0o700 || (uid !== undefined && state.uid !== uid)) {
    throw new CliFault("CONTROL_STATE_UNSAFE", false, undefined, "unsafe");
  }
  if (socket.isSymbolicLink() || !socket.isSocket() || (socket.mode & 0o777) !== 0o600 || (uid !== undefined && socket.uid !== uid)) {
    throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe");
  }
  let stateReal: string, parentReal: string;
  try {
    [stateReal, parentReal] = await Promise.all([realpath(stateDir), realpath(path.dirname(socketPath))]);
  } catch { throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe"); }
  if (path.dirname(socketPath) !== stateDir || stateReal !== parentReal) {
    throw new CliFault("CONTROL_SOCKET_UNSAFE", false, undefined, "unsafe");
  }
}
function serializedOutput(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > CLI_MAX_OUTPUT_BYTES) fault("OUTPUT_TOO_LARGE");
  return line;
}
async function writeComplete(output: Writable, frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error | null) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
    try { if (typeof output.write(frame, done) !== "boolean") done(); }
    catch (error) { done(error instanceof Error ? error : new Error("stdout write failed")); }
  });
}

function writeFailure(
  stdout: Writable,
  stderr: Writable,
  locale: DashboardLocale,
  command: GatewayCliCommand | undefined,
  code: string,
  options: { ambiguous?: boolean; retryable?: boolean; kind: CliStderrKind },
): void {
  stdout.write(serializedOutput({ ok: false, command: command ?? "unknown", error: {
    code, ambiguous: options.ambiguous ?? false, retryable: options.retryable ?? false,
  } }));
  stderr.write(fixedStderr(locale, options.kind));
}
function writeStateResetHint(stderr: Writable, locale: DashboardLocale, code: string): void {
  if (code === "GATEWAY_STATE_SCHEMA_UNSUPPORTED" || code === "CORRUPT_GATEWAY_STATE") {
    stderr.write(`[embassy] ${getCliCopy(locale)["hint.stateResetRequired"]}\n`);
  }
}
function isRejectedResult(result: unknown): boolean {
  return result !== null && typeof result === "object" && (result as { accepted?: unknown }).accepted === false;
}
function isProgressWatchOwnerConflict(result: unknown): boolean {
  return isRejectedResult(result) && (result as { code?: unknown }).code === "watch_owner_conflict";
}
function responseExitCode(response: GatewayControlResponse): number {
  return !response.ok ? gatewayCliExitCodes.failure
    : isRejectedResult(response.result) ? gatewayCliExitCodes.rejected : gatewayCliExitCodes.ok;
}
function codexDoctorConditions(result: unknown): readonly string[] {
  const connectors = result !== null && typeof result === "object"
    ? (result as { connectors?: unknown }).connectors : undefined;
  const connector = Array.isArray(connectors) ? connectors.find((row) =>
    row !== null && typeof row === "object" && (row as { provider?: unknown }).provider === "codex") : undefined;
  const doctor = connector !== null && typeof connector === "object"
    ? (connector as { codexDoctor?: unknown }).codexDoctor : undefined;
  const conditions = doctor !== null && typeof doctor === "object"
    ? (doctor as { conditions?: unknown }).conditions : undefined;
  return Array.isArray(conditions)
    ? conditions.filter((value): value is string => typeof value === "string") : ["unknown"];
}

function waitDeliveryExitCode(
  response: GatewayControlResponse<"delivery_status">,
): number {
  return response.ok && response.result.found && response.result.terminal && response.result.state === "delivered"
    ? gatewayCliExitCodes.ok : gatewayCliExitCodes.failure;
}
type DeliveryStatusRequest = Extract<GatewayControlRequest, { method: "delivery_status" }>;
type WaitDeliveryOutcome =
  | { kind: "response"; response: GatewayControlResponse<"delivery_status"> }
  | { kind: "unknown" }
  | { kind: "timeout" };
const defaultDelay = async (milliseconds: number): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForDelivery(
  socketPath: string,
  request: DeliveryStatusRequest,
  sendRequest: GatewayControlSender,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<WaitDeliveryOutcome> {
  let deadline: number | undefined;
  while (true) {
    const remaining = deadline === undefined ? undefined : deadline - now();
    if (remaining !== undefined && remaining <= 0) return { kind: "timeout" };
    if (remaining !== undefined && remaining < DELIVERY_POLL_MIN_REQUEST_TIMEOUT_MS) {
      await delay(remaining); return { kind: "timeout" };
    }
    let response: GatewayControlResponse<"delivery_status">;
    try {
      response = await sendRequest({
        socketPath, request,
        timeoutMs: remaining === undefined ? GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS
          : Math.min(GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS, Math.floor(remaining)),
      });
    } catch (error) {
      if (deadline !== undefined && now() >= deadline && error instanceof GatewayControlTransportError && error.recoverable) return { kind: "timeout" };
      throw error;
    }
    if (!response.ok) {
      if (response.error.code === "REQUEST_TIMEOUT" && deadline !== undefined && now() >= deadline) return { kind: "timeout" };
      return { kind: "response", response };
    }
    if (!response.result.found) return { kind: "unknown" };
    if (response.result.terminal) return { kind: "response", response };
    const observed = Date.parse(response.result.deadlineAt) + GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(observed)) throw new Error("invalid validated delivery deadline");
    deadline = deadline === undefined ? observed : Math.min(deadline, observed);
    const after = deadline - now();
    if (after <= 0) return { kind: "timeout" };
    await delay(Math.min(DELIVERY_POLL_INTERVAL_MS, after));
  }
}

/** Run one command; foreground runners own and release their signal handlers. */
export async function runGatewayCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: GatewayCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdin = dependencies.stdin ?? process.stdin, stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr, loadConfig = dependencies.loadConfig ?? loadGatewayConfig;
  const sendRequest = dependencies.sendRequest ?? sendGatewayControlRequest;
  const validateSocket = dependencies.validateControlSocket ?? validatePrivateGatewayControlSocket;
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    stdout.write(`embassy ${EMBASSY_VERSION}\n`);
    return gatewayCliExitCodes.ok;
  }
  const command = isCommand(argv[0]) ? argv[0] : undefined;
  let locale = fallbackCliLocale(argv.slice(1), env);
  let serverReady = false, dashboardReady = false;
  let liveDashboardPort: number | undefined;
  let identity: Promise<{ inventory: GatewayNodeInventory; config: GatewayConfig }> | undefined;
  const loadIdentity = () => identity ??= (async () => {
    const inventory = await (dependencies.loadNodeInventory ?? loadGatewayNodeInventory)(path.resolve(defaultGatewayStateDir(env)));
    return { inventory, config: loadConfig(env, inventory) };
  })();
  const success = (result: unknown): void => {
    stdout.write(serializedOutput({ ok: true, command: command!, result }));
  };
  try {
    const common = commonOptions(argv.slice(1), env);
    locale = common.locale;
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      emptyParams(common.args);
      stdout.write(getCliCopy(locale)["help.usage"]);
      return gatewayCliExitCodes.ok;
    }
    if (command === undefined) fault("UNKNOWN_COMMAND");
    if (command === "peer-stdio") {
      emptyParams(common.args);
      try {
        const { config, inventory } = await loadIdentity();
        await validateSocket(config.stateDir, config.controlSocketPath);
        let peerHost: string | undefined, firstCatalog: import("./peer-protocol.js").PeerCatalogResult | undefined;
        const request = async <M extends "peer_catalog" | "peer_handoff">(
          method: M,
          params: M extends "peer_catalog" ? { peerHost: string } : { peerHost: string; handoff: import("./peer-protocol.js").PeerHandoffParams },
        ) => {
          const response = await sendRequest({ socketPath: config.controlSocketPath,
            request: { protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method, params } as Extract<GatewayControlRequest, { method: M }> });
          if (!response.ok) throw new PeerHandlerError({ code: -32000, message: "Local broker refused peer authority" });
          return response.result;
        };
        const session = (dependencies.runPeerStdio ?? runPeerStdio)({
          localHost: inventory.host, input: stdin as never, output: stdout as never,
          handlers: {
            initialize: async ({ host }) => {
              if (!inventory.nodes.includes(host)) throw new PeerHandlerError({ code: -32001, message: "Peer host not configured" });
              peerHost = host; firstCatalog = await request("peer_catalog", { peerHost: host });
            },
            catalog: async () => { const cached = firstCatalog; firstCatalog = undefined;
              return cached ?? await request("peer_catalog", { peerHost: peerHost! }); },
            handoff: async (handoff) => { firstCatalog = undefined;
              return await request("peer_handoff", { peerHost: peerHost!, handoff }); },
          },
        });
        await session.done;
        return gatewayCliExitCodes.ok;
      } catch {
        stderr.write("Embassy peer transport failed.\n");
        return gatewayCliExitCodes.unavailable;
      }
    }
    if (command === "serve") {
      await (dependencies.runServer ?? runGatewayServer)({
        env, locale, inboundMode: parseServeInboundMode(common.args),
        ...(dependencies.serverSignal === undefined ? {} : { signal: dependencies.serverSignal }),
        onReady: async (result) => {
          if (serverReady) fault("SERVER_READY_ALREADY_EMITTED");
          success(result); serverReady = true;
        },
      });
      if (!serverReady) fault("SERVER_NOT_READY");
      return gatewayCliExitCodes.ok;
    }
    if (command === "dashboard") {
      liveDashboardPort = parseLiveDashboardArgs(common.args);
      const { inventory } = await loadIdentity();
      const outcome = await (dependencies.runLiveDashboard ?? runLiveDashboardCommand)({
        env, locale, port: liveDashboardPort, inventory, loadConfig, sendRequest, validateControlSocket: validateSocket,
        ...(dependencies.liveDashboardSignal === undefined ? {} : { signal: dependencies.liveDashboardSignal }),
        onReady: async (result) => {
          if (dashboardReady) fault("LIVE_DASHBOARD_READY_ALREADY_EMITTED");
          success(result); dashboardReady = true;
        },
      });
      if (!dashboardReady && outcome?.status === "cancelled") return gatewayCliExitCodes.ok;
      if (!dashboardReady) throw new Error("LIVE_DASHBOARD_NOT_READY");
      return gatewayCliExitCodes.ok;
    }
    const request = await buildRequest(command, common.args, env, stdin, async () => (await loadIdentity()).config.hostId);
    const { config } = await loadIdentity();
    await validateSocket(config.stateDir, config.controlSocketPath);
    let response: GatewayControlResponse;
    let waited: GatewayControlResponse<"delivery_status"> | undefined;
    if (command === "await") {
      if (request.method !== "await_peer") fault();
      while (true) {
        const current = await sendRequest({ socketPath: config.controlSocketPath, request, timeoutMs: PEER_AWAIT_REQUEST_TIMEOUT_MS });
        if (!current.ok) { response = current; break; }
        if (current.result.state === "timeout") continue;
        try { await writeComplete(stdout, current.result.frame); }
        catch { stderr.write(fixedStderr(locale, "failure")); return gatewayCliExitCodes.failure; }
        try {
          const receipt = await sendRequest({ socketPath: config.controlSocketPath,
            request: envelope("peer_receipt", { alias: request.params.alias, token: request.params.token, receipt: current.result.receipt }) as Extract<GatewayControlRequest, { method: "peer_receipt" }> });
          if (!receipt.ok) { stderr.write(fixedStderr(locale, "failure")); return gatewayCliExitCodes.failure; }
          if (isRejectedResult(receipt.result)) { stderr.write(fixedStderr(locale, "decision")); return gatewayCliExitCodes.rejected; }
          return gatewayCliExitCodes.ok;
        } catch (error) {
          const transport = error instanceof GatewayControlTransportError;
          stderr.write(fixedStderr(locale, transport ? error.ambiguous ? "ambiguous" : "unavailable" : "failure"));
          return transport ? error.ambiguous ? gatewayCliExitCodes.ambiguous : gatewayCliExitCodes.unavailable : gatewayCliExitCodes.failure;
        }
      }
    } else if (command === "wait-delivery") {
      if (request.method !== "delivery_status") fault();
      const outcome = await waitForDelivery(config.controlSocketPath, request, sendRequest,
        dependencies.now ?? Date.now, dependencies.delay ?? defaultDelay);
      if (outcome.kind === "unknown") {
        writeFailure(stdout, stderr, locale, command, "DELIVERY_TOKEN_UNKNOWN", { kind: "tokenUnknown" });
        return gatewayCliExitCodes.rejected;
      }
      if (outcome.kind === "timeout") {
        writeFailure(stdout, stderr, locale, command, "DELIVERY_WAIT_TIMEOUT", { retryable: true, kind: "deliveryTimeout" });
        return gatewayCliExitCodes.unavailable;
      }
      waited = outcome.response; response = waited;
    } else {
      response = await sendRequest({ socketPath: config.controlSocketPath, request });
    }
    if (!response.ok) {
      writeFailure(stdout, stderr, locale, command, response.error.code, { kind: "failure" });
      return gatewayCliExitCodes.failure;
    }
    if (command === "register-peer" && common.args.includes("--emit-env") && "token" in response.result) {
      stdout.write(`export EMBASSY_PEER_TOKEN='${response.result.token}'\n`);
      return gatewayCliExitCodes.ok;
    }
    success(command === "doctor" ? { conditions: codexDoctorConditions(response.result) } : response.result);
    const exitCode = waited === undefined ? responseExitCode(response) : waitDeliveryExitCode(waited);
    if (exitCode === gatewayCliExitCodes.rejected) {
      stderr.write(fixedStderr(locale, "decision"));
      if (isProgressWatchOwnerConflict(response.result)) {
        stderr.write(`[embassy] ${getCliCopy(locale)["hint.progressWatchOwnerConflict"]}\n`);
      }
    } else if (command === "wait-delivery" && exitCode === gatewayCliExitCodes.failure) stderr.write(fixedStderr(locale, "failure"));
    return exitCode;
  } catch (error) {
    if ((command === "serve" && serverReady) || (command === "dashboard" && dashboardReady)) {
      stderr.write(fixedStderr(locale, "failure"));
      return gatewayCliExitCodes.failure;
    }
    if (error instanceof GatewayControlTransportError) {
      const ambiguous = error.ambiguous;
      writeFailure(stdout, stderr, locale, command, error.code, {
        ambiguous, retryable: ambiguous ? false : error.recoverable,
        kind: ambiguous ? "ambiguous" : "unavailable",
      });
      if (error.code === "CONTROL_VERSION_MISMATCH") {
        stderr.write(`[embassy] ${getCliCopy(locale)["hint.controlVersionMismatch"]}\n`);
      } else if (error.code === "CONTROL_INVALID_RESPONSE") {
        stderr.write(`[embassy] ${getCliCopy(locale)["hint.controlInvalidResponse"]}\n`);
      }
      if (error.code === "CONTROL_CONNECT_DENIED")
        stderr.write(`[embassy] ${getCliCopy(locale)["hint.controlConnectDenied"]}\n`);
      return ambiguous ? gatewayCliExitCodes.ambiguous : gatewayCliExitCodes.unavailable;
    }
    if (error instanceof CliFault) {
      writeFailure(stdout, stderr, locale, command, error.code, {
        retryable: error.retryable, kind: error.kind ?? (error.retryable ? "unavailable" : "input"),
      });
      if (error.hint !== undefined) {
        const hint = error.hint === "callerIdentityConflict"
          ? locale === "zh-CN" ? callerIdentityConflictHintZhCn : callerIdentityConflictHintEn
          : getCliCopy(locale)[error.hint];
        stderr.write(`[embassy] ${hint}\n`);
      }
      return error.retryable ? gatewayCliExitCodes.unavailable : gatewayCliExitCodes.invalidInput;
    }
    if (error instanceof BridgeError) {
      if (error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN") {
        writeFailure(stdout, stderr, locale, command, error.code, { ambiguous: true, kind: "ambiguous" });
        return gatewayCliExitCodes.ambiguous;
      }
      writeFailure(stdout, stderr, locale, command, error.code, {
        retryable: error.recoverable, kind: error.recoverable ? "unavailable" : "input",
      });
      writeStateResetHint(stderr, locale, error.code);
      if (error.code === "CONTROL_CONNECT_DENIED") stderr.write(`[embassy] ${getCliCopy(locale)[
        command === "serve" ? "hint.stateAccessDenied" : "hint.controlConnectDenied"]}\n`);
      if (error.code === "GATEWAY_NODE_INVENTORY_REQUIRED") {
        const stateDir = env.EMBASSY_STATE_DIR ?? (env.XDG_STATE_HOME ? path.join(env.XDG_STATE_HOME, "agent-embassy") : "~/.local/state/agent-embassy");
        stderr.write(`[embassy] ${getCliCopy(locale)["hint.nodeInventoryRequired"].replace("{stateDir}", stateDir)}\n`);
      }
      if (error.code === "LIVE_DASHBOARD_PORT_IN_USE" && liveDashboardPort !== undefined) {
        const hint = getCliCopy(locale)["hint.dashboardPortInUse"].replace("{port}", String(liveDashboardPort));
        stderr.write(`[embassy] ${hint}\n`);
      }
      return error.recoverable ? gatewayCliExitCodes.unavailable : gatewayCliExitCodes.invalidInput;
    }
    writeFailure(stdout, stderr, locale, command, "INTERNAL_ERROR", { kind: "failure" });
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
