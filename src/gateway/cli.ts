#!/usr/bin/env node

/** Foreground broker plus bounded metadata-only control client. */
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import { GATEWAY_CONTROL_DEFAULT_TIMEOUT_MS, GATEWAY_CONTROL_MAX_MESSAGE_BYTES,
  GATEWAY_CONTROL_MAX_RESPONSE_BYTES, GATEWAY_CONTROL_PROTOCOL_VERSION,
  GatewayControlTransportError, isClaudeSessionSelector, isGatewayAlias,
  isGatewayConversationId, isGatewayDeliveryToken,
  isGatewayReplyAddress, sendGatewayControlRequest, type GatewayControlMethod,
  type GatewayControlRequest, type GatewayControlResponse,
  type SendGatewayControlRequestOptions } from "./control.js";
import { defaultGatewayStateDir, loadGatewayConfig, type GatewayConfig } from "./config.js";
import { isDefaultedGatewayNodeInventory, loadGatewayNodeInventory,
  type GatewayNodeInventory } from "./federation-nodes.js";
import { runGatewayServer, type GatewayServerOptions } from "./server.js";
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

export const gatewayCliCommands = [
  "serve", "health", "status", "delivery-status",
  "wait-delivery", "refresh", "register-codex",
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
  serverSignal?: AbortSignal;
  validateControlSocket?: (stateDir: string, socketPath: string) => Promise<void>;
  runPeerStdio?: PeerStdioRunner;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
};

const HELP_USAGE = `Embassy — local messaging for Claude Code and Codex

Usage:
  embassy <command> [options]

Commands:
  serve [--inbound open] Run the socket-only broker (paired inbound by default)
  health                 Check broker health
  status                 Read the public status snapshot
  refresh                Rescan for Claude sessions
  register-codex         Register or succeed a Codex task
  unregister-codex       Unregister the current Codex task
  register-peer --alias <peer-alias> [--token-stdin|--emit-env]
                         Register a universal shell peer
  unregister-peer --alias <peer-alias> [--token-stdin]
                         Unregister a universal shell peer
  await --alias <peer-alias> [--token-stdin]
                         Wait for one peer message and acknowledge stdout
  peer-stdio             Serve the bounded federation protocol on stdin/stdout
  select-claude          Select a discovered Claude session
  unselect-claude        Clear the Claude selection
  pair [--from <alias> --to <alias>] Add one cross-provider consent edge
  unpair [--from <alias> --to <alias>] Remove one cross-provider consent edge
  send                   Send stdin between paired provider routes
  reply                  Reply with a conversation token
  delivery-status        Read a delivery token
  wait-delivery          Wait for terminal delivery status

Options:
  --token-stdin          Read the peer token as the first LF-terminated stdin line
  --emit-env             Print the first registration token as an export command
  --version, -v          Print the version
  --help, -h             Show this help
`;
/** Fixed one-line stderr summaries; stdout carries the protocol and stderr never carries private detail. */
const CLI_STDERR = {
  input: "request rejected.",
  decision: "gateway rejected the request.",
  unavailable: "gateway unavailable.",
  ambiguous: "outcome ambiguous; do not retry automatically.",
  failure: "command failed.",
  unsafe:
    "gateway state directory or socket has unexpected permissions or ownership. Verify the exact path, owner, and modes before retrying.",
  tokenUnknown:
    "delivery token not recognized; it may have expired or left bounded retention.",
  deliveryTimeout:
    "the delivery has not settled yet; the gateway is still running. Check again later with embassy delivery-status.",
} as const;
/** Exact next-step remedies appended after the summary for the faults that have one. */
const CLI_HINT = {
  controlConnectDenied:
    "the broker may be running, but this process cannot connect; grant this task write access to the gateway state directory, then retry. Do not start a second broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.",
  controlInvalidResponse:
    "if either Embassy installation changed recently, rebuild or repoint this client to the broker's installation; otherwise restart the broker, then retry.",
  controlVersionMismatch:
    "rebuild or repoint this client to the broker's Embassy installation, then retry.",
  stateAccessDenied:
    "local policy denied access to the gateway state directory; grant this process access, then retry starting the broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.",
  messageTooLarge:
    "message exceeds the 16 KiB acceptance cap; shorten or split it. For long prose, pipe the body from a file.",
  stateResetRequired:
    "state reset required; follow docs/CONFIGURATION.md#private-state-reset. Resetting abandons unsettled work. To check for unsettled work after upgrading, temporarily use Embassy 2.0.x before resetting.",
  callerIdentityConflict:
    "both agent identities were inherited; rerun this Codex-side call with env -u CLAUDE_CODE_MESSAGING_SOCKET, or this Claude-side call with env -u CODEX_THREAD_ID",
  aliasHostMismatch:
    "aliases on this machine end with @{localHost} (from {stateDir}/nodes.json); found @{given}",
  aliasHostDefaulted:
    "no nodes.json at {stateDir} — this machine defaults to @{localHost} until a broker has started; found @{given}",
  controlSocketMissing:
    "no broker is listening at {stateDir}; start it with `embassy serve` under this same OS account, or verify EMBASSY_STATE_DIR is not scrubbed or misdirected (for example by a sandboxed task's HOME).",
} as const;
type CliStderrKind = keyof typeof CLI_STDERR;
type CliFaultHint = keyof typeof CLI_HINT;
/** Renders a CLI_HINT entry, substituting any {name} placeholders from `vars`. */
function renderHint(hint: CliFaultHint, vars?: Readonly<Record<string, string>>): string {
  let text: string = CLI_HINT[hint];
  if (vars !== undefined) for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, value);
  return text;
}

type ParsedOptions = Readonly<Record<string, string | true>>;
class CliFault extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly hint?: CliFaultHint,
    readonly kind?: CliStderrKind,
    readonly hintVars?: Readonly<Record<string, string>>,
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
const fixedStderr = (kind: CliStderrKind): string => `[embassy] ${CLI_STDERR[kind]}\n`;
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
/** This machine's alias host, and whether it is durable or still a default. */
type LocalHostIdentity = Readonly<{ host: string; defaulted: boolean; stateDir: string }>;
/**
 * An alias naming another host is rejected before any broker call. The hint
 * says where this machine's own host came from, because the two cases have
 * different remedies: a durable nodes.json is the answer, while a defaulted
 * identity is still provisional until the first `embassy serve` records it.
 */
function aliasHostFault(local: LocalHostIdentity, given: string): CliFault {
  return new CliFault("INVALID_ARGUMENTS", false,
    local.defaulted ? "aliasHostDefaulted" : "aliasHostMismatch", undefined,
    { localHost: local.host, given, stateDir: local.stateDir });
}
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
    if (length > GATEWAY_CONTROL_MAX_MESSAGE_BYTES) throw new CliFault("MESSAGE_TOO_LARGE", false, "messageTooLarge");
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
    if (length > GATEWAY_CONTROL_MAX_MESSAGE_BYTES + 38) throw new CliFault("MESSAGE_TOO_LARGE", false, "messageTooLarge");
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
const envelope = (method: GatewayControlMethod, params: unknown): GatewayControlRequest =>
  ({ protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION, method, params }) as GatewayControlRequest;
async function buildRequest(
  command: GatewayCliCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: AsyncIterable<unknown>,
  loadLocalHost: () => Promise<LocalHostIdentity>,
): Promise<GatewayControlRequest> {
  const simple: Partial<Record<GatewayCliCommand, GatewayControlMethod>> = {
    health: "health", status: "list_snapshot",
    refresh: "refresh_discovery",
  };
  const simpleMethod = simple[command];
  if (simpleMethod !== undefined) return envelope(simpleMethod, emptyParams(args));
  switch (command) {
    case "serve":
    case "peer-stdio":
      return fault();
    case "health": case "status": case "refresh": return fault();
    case "delivery-status":
    case "wait-delivery": {
      const options = parseOptions(args, ["token"]);
      count(options, 1);
      return envelope("delivery_status", { token: requireDeliveryToken(options, "token") });
    }
    case "register-codex": {
      const options = parseOptions(args, ["alias", "succeeds"]);
      const alias = requireCodexAlias(options, "alias");
      const succeedsAlias = options.succeeds === undefined ? undefined : requireCodexAlias(options, "succeeds");
      count(options, succeedsAlias === undefined ? 1 : 2, 2);
      const threadId = requireExclusiveCodexThreadId(env);
      if (succeedsAlias === alias) fault();
      const local = await loadLocalHost();
      if (gatewayAliasHost(alias) !== local.host) throw aliasHostFault(local, gatewayAliasHost(alias));
      if (succeedsAlias !== undefined && gatewayAliasHost(succeedsAlias) !== local.host) {
        throw aliasHostFault(local, gatewayAliasHost(succeedsAlias));
      }
      return envelope("register_codex", {
        alias, threadId, hostId: local.host, busyPolicy: "queue",
        ...(succeedsAlias === undefined ? {} : { succeedsAlias }),
      });
    }
    case "unregister-codex": {
      const options = parseOptions(args, ["alias"]);
      count(options, 1);
      const alias = requireCodexAlias(options, "alias");
      const threadId = requireExclusiveCodexThreadId(env);
      const local = await loadLocalHost();
      if (gatewayAliasHost(alias) !== local.host) throw aliasHostFault(local, gatewayAliasHost(alias));
      return envelope("unregister_codex", { alias, threadId });
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
      const requireLocalAlias = async (): Promise<void> => {
        const local = await loadLocalHost();
        if (gatewayAliasHost(alias) !== local.host) throw aliasHostFault(local, gatewayAliasHost(alias));
      };
      if (source === undefined) {
        if (command !== "register-peer") fault("CALLER_IDENTITY_REQUIRED");
        await requireLocalAlias();
        return envelope("register_peer", { alias });
      }
      const { token } = await readPeerInput(stdin, source, false);
      await requireLocalAlias();
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
      const options = parseOptions(args, ["from", "to"], ["expects-reply", "token-stdin"]);
      count(options, 2, 4);
      const source = peerTokenSource(options, env);
      const principals = Number(hasIdentity(env.CODEX_THREAD_ID)) + Number(hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) + Number(source !== undefined);
      if (principals > 1) throw callerIdentityConflictFault(env);
      const fromAlias = requireAlias(options, "from");
      const toAlias = requireClaudeSelector(options, "to");
      const peer = source === undefined ? undefined : await readPeerInput(stdin, source, true);
      const authority = peer === undefined ? hasIdentity(env.CODEX_THREAD_ID)
        ? { threadId: requireExclusiveCodexThreadId(env) }
        : { replyAddress: requireExclusiveClaudeReplyAddress(env) }
        : { peerToken: peer.token };
      const common = {
        fromAlias, toAlias, text: peer?.text ?? await readMessageBody(stdin),
        expectsReply: options["expects-reply"] === true,
      };
      return envelope("send", { ...common, ...authority });
    }
    case "reply": {
      const options = parseOptions(args, ["conversation", "alias"], ["token-stdin"]);
      count(options, 2, 3);
      const conversationId = requireString(options, "conversation");
      if (!isGatewayConversationId(conversationId)) fault();
      const alias = requireAlias(options, "alias");
      const threadId = env.CODEX_THREAD_ID, source = peerTokenSource(options, env);
      const principals = Number(hasIdentity(threadId)) + Number(hasIdentity(env.CLAUDE_CODE_MESSAGING_SOCKET)) + Number(source !== undefined);
      if (principals > 1) throw callerIdentityConflictFault(env);
      const replyAddress = optionalClaudeReplyAddress(env);
      const codex = hasIdentity(threadId);
      if (!codex && replyAddress === undefined && source === undefined) fault("CALLER_IDENTITY_REQUIRED");
      const peer = source === undefined ? undefined : await readPeerInput(stdin, source, true);
      return envelope("reply", {
        conversationId, text: peer?.text ?? await readMessageBody(stdin),
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
  // No hint here: on win32 there is no private control socket to be missing,
  // and nothing about EMBASSY_STATE_DIR would change that.
  if (process.platform === "win32") throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true);
  let state, socket;
  try {
    [state, socket] = await Promise.all([lstat(stateDir), lstat(socketPath)]);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code : undefined;
    if (code === "EPERM" || code === "EACCES")
      throw new CliFault("CONTROL_CONNECT_DENIED", true, "controlConnectDenied");
    throw new CliFault("CONTROL_SOCKET_UNAVAILABLE", true, "controlSocketMissing", undefined, { stateDir });
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
  command: GatewayCliCommand | undefined,
  code: string,
  options: { ambiguous?: boolean; retryable?: boolean; kind: CliStderrKind },
): void {
  stdout.write(serializedOutput({ ok: false, command: command ?? "unknown", error: {
    code, ambiguous: options.ambiguous ?? false, retryable: options.retryable ?? false,
  } }));
  stderr.write(fixedStderr(options.kind));
}
function writeStateResetHint(stderr: Writable, code: string): void {
  if (code === "GATEWAY_STATE_SCHEMA_UNSUPPORTED" || code === "CORRUPT_GATEWAY_STATE") {
    stderr.write(`[embassy] ${CLI_HINT.stateResetRequired}\n`);
  }
}
function isRejectedResult(result: unknown): boolean {
  return result !== null && typeof result === "object" && (result as { accepted?: unknown }).accepted === false;
}
function responseExitCode(response: GatewayControlResponse): number {
  return !response.ok ? gatewayCliExitCodes.failure
    : isRejectedResult(response.result) ? gatewayCliExitCodes.rejected : gatewayCliExitCodes.ok;
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
  const args = argv.slice(1);
  let serverReady = false;
  let identity: Promise<{ inventory: GatewayNodeInventory; config: GatewayConfig; defaulted: boolean }> | undefined;
  const loadIdentity = () => identity ??= (async () => {
    const inventory = await (dependencies.loadNodeInventory ?? loadGatewayNodeInventory)(path.resolve(defaultGatewayStateDir(env)));
    return { inventory, config: loadConfig(env, inventory), defaulted: isDefaultedGatewayNodeInventory(inventory) };
  })();
  const success = (result: unknown): void => {
    stdout.write(serializedOutput({ ok: true, command: command!, result }));
  };
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      emptyParams(args);
      stdout.write(HELP_USAGE);
      return gatewayCliExitCodes.ok;
    }
    if (command === undefined) fault("UNKNOWN_COMMAND");
    if (command === "peer-stdio") {
      emptyParams(args);
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
        env, inboundMode: parseServeInboundMode(args),
        ...(dependencies.serverSignal === undefined ? {} : { signal: dependencies.serverSignal }),
        onReady: async (result) => {
          if (serverReady) fault("SERVER_READY_ALREADY_EMITTED");
          success(result); serverReady = true;
        },
      });
      if (!serverReady) fault("SERVER_NOT_READY");
      return gatewayCliExitCodes.ok;
    }
    const request = await buildRequest(command, args, env, stdin, async () => {
      const { config, defaulted } = await loadIdentity();
      return { host: config.hostId, defaulted, stateDir: config.stateDir };
    });
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
        catch { stderr.write(fixedStderr("failure")); return gatewayCliExitCodes.failure; }
        try {
          const receipt = await sendRequest({ socketPath: config.controlSocketPath,
            request: envelope("peer_receipt", { alias: request.params.alias, token: request.params.token, receipt: current.result.receipt }) as Extract<GatewayControlRequest, { method: "peer_receipt" }> });
          if (!receipt.ok) { stderr.write(fixedStderr("failure")); return gatewayCliExitCodes.failure; }
          if (isRejectedResult(receipt.result)) { stderr.write(fixedStderr("decision")); return gatewayCliExitCodes.rejected; }
          return gatewayCliExitCodes.ok;
        } catch (error) {
          const transport = error instanceof GatewayControlTransportError;
          stderr.write(fixedStderr(transport ? error.ambiguous ? "ambiguous" : "unavailable" : "failure"));
          return transport ? error.ambiguous ? gatewayCliExitCodes.ambiguous : gatewayCliExitCodes.unavailable : gatewayCliExitCodes.failure;
        }
      }
    } else if (command === "wait-delivery") {
      if (request.method !== "delivery_status") fault();
      const outcome = await waitForDelivery(config.controlSocketPath, request, sendRequest,
        dependencies.now ?? Date.now, dependencies.delay ?? defaultDelay);
      if (outcome.kind === "unknown") {
        writeFailure(stdout, stderr, command, "DELIVERY_TOKEN_UNKNOWN", { kind: "tokenUnknown" });
        return gatewayCliExitCodes.rejected;
      }
      if (outcome.kind === "timeout") {
        writeFailure(stdout, stderr, command, "DELIVERY_WAIT_TIMEOUT", { retryable: true, kind: "deliveryTimeout" });
        return gatewayCliExitCodes.unavailable;
      }
      waited = outcome.response; response = waited;
    } else {
      response = await sendRequest({ socketPath: config.controlSocketPath, request });
    }
    if (!response.ok) {
      writeFailure(stdout, stderr, command, response.error.code, { kind: "failure" });
      return gatewayCliExitCodes.failure;
    }
    if (command === "register-peer" && args.includes("--emit-env") && "token" in response.result) {
      stdout.write(`export EMBASSY_PEER_TOKEN='${response.result.token}'\n`);
      return gatewayCliExitCodes.ok;
    }
    success(response.result);
    const exitCode = waited === undefined ? responseExitCode(response) : waitDeliveryExitCode(waited);
    if (exitCode === gatewayCliExitCodes.rejected) {
      stderr.write(fixedStderr("decision"));
    } else if (command === "wait-delivery" && exitCode === gatewayCliExitCodes.failure) stderr.write(fixedStderr("failure"));
    return exitCode;
  } catch (error) {
    if (command === "serve" && serverReady) {
      stderr.write(fixedStderr("failure"));
      return gatewayCliExitCodes.failure;
    }
    if (error instanceof GatewayControlTransportError) {
      const ambiguous = error.ambiguous;
      writeFailure(stdout, stderr, command, error.code, {
        ambiguous, retryable: ambiguous ? false : error.recoverable,
        kind: ambiguous ? "ambiguous" : "unavailable",
      });
      if (error.code === "CONTROL_VERSION_MISMATCH") {
        stderr.write(`[embassy] ${CLI_HINT.controlVersionMismatch}\n`);
      } else if (error.code === "CONTROL_INVALID_RESPONSE") {
        stderr.write(`[embassy] ${CLI_HINT.controlInvalidResponse}\n`);
      } else if (error.code === "CONTROL_SOCKET_MISSING" && identity !== undefined) {
        const { config } = await identity;
        stderr.write(`[embassy] ${renderHint("controlSocketMissing", { stateDir: config.stateDir })}\n`);
      }
      if (error.code === "CONTROL_CONNECT_DENIED")
        stderr.write(`[embassy] ${CLI_HINT.controlConnectDenied}\n`);
      return ambiguous ? gatewayCliExitCodes.ambiguous : gatewayCliExitCodes.unavailable;
    }
    if (error instanceof CliFault) {
      writeFailure(stdout, stderr, command, error.code, {
        retryable: error.retryable, kind: error.kind ?? (error.retryable ? "unavailable" : "input"),
      });
      if (error.hint !== undefined) stderr.write(`[embassy] ${renderHint(error.hint, error.hintVars)}\n`);
      return error.retryable ? gatewayCliExitCodes.unavailable : gatewayCliExitCodes.invalidInput;
    }
    if (error instanceof BridgeError) {
      if (error.code === "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN") {
        writeFailure(stdout, stderr, command, error.code, { ambiguous: true, kind: "ambiguous" });
        return gatewayCliExitCodes.ambiguous;
      }
      writeFailure(stdout, stderr, command, error.code, {
        retryable: error.recoverable, kind: error.recoverable ? "unavailable" : "input",
      });
      writeStateResetHint(stderr, error.code);
      if (error.code === "CONTROL_CONNECT_DENIED") stderr.write(`[embassy] ${
        CLI_HINT[command === "serve" ? "stateAccessDenied" : "controlConnectDenied"]}\n`);
      return error.recoverable ? gatewayCliExitCodes.unavailable : gatewayCliExitCodes.invalidInput;
    }
    writeFailure(stdout, stderr, command, "INTERNAL_ERROR", { kind: "failure" });
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
      process.stderr.write(fixedStderr("failure"));
      process.exitCode = gatewayCliExitCodes.failure;
    },
  );
}
