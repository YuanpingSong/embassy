#!/usr/bin/env node
import { userInfo } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "../errors.js";
import { commandMutates, isBrokerResult, type BrokerCommand } from "./broker-control.js";
import type { EndpointCaller } from "./endpoint-directory.js";
import { defaultGatewayStateDir, loadGatewayConfig } from "./config.js";
import { loadGatewayNodeInventory } from "./federation-nodes.js";
import { runFederationStdio, type PublicEndpoint } from "./federation.js";
import { LocalControlError, requestLocalControl } from "./local-control.js";
import { runCoreRuntime } from "./runtime.js";
import { defaultRunLaunchctl } from "./service-agent.js";
import { runCoreServiceCommand } from "./core-service-command.js";
import { groupCodexEndpoints, runTui } from "./tui.js";
import { createTuiSshClient } from "./tui-ssh.js";

import { CORE_VERSION } from "./core-version.js";
export { CORE_VERSION } from "./core-version.js";
const HELP = `Embassy — named Claude/Codex messaging over local gateways and SSH

  embassy register-codex --alias <codex-name@host> [--succeeds <old-alias>]
  embassy send --to <name@host>                    # body on stdin
  embassy send --conversation <reference>          # identity-bound reply
  embassy status [--json]
  embassy tui                                    # live operator terminal
  embassy refresh
  embassy delivery-status --token <delivery-token>
  embassy wait-delivery --token <delivery-token>
  embassy retire --alias <local-alias>
  embassy retire --endpoint <public-endpoint-id>   # exact local retirement
  embassy check                                  # broker-only loopback, no live agent
  embassy health
  embassy serve
  embassy service install|uninstall|status
  embassy peer-stdio                             # SSH broker transport
  embassy --version | --help

The sender is resolved from the calling Claude/Codex session; do not supply an identity.
Use exactly one of --to or --conversation. A receipt proves transport, not comprehension.
`;
type Output = Pick<Writable, "write"> & { isTTY?: boolean };
export type CoreCliDependencies = Readonly<{
  env?: NodeJS.ProcessEnv; stdin?: Readable; stdout?: Output; stderr?: Output;
  signal?: AbortSignal;
}>;
const invalid = (code = "INVALID_ARGUMENTS"): never => { throw new BridgeError(code, "The command arguments are invalid."); };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function argumentsFor(args: readonly string[], allowed: readonly string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.includes(flag) || options.has(flag)) return invalid();
    if (flag === "--json") options.set(flag, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) return invalid();
      options.set(flag, value);
    }
  }
  return options;
}
const required = (options: Map<string, string | true>, flag: string): string => {
  const value = options.get(flag);
  return typeof value === "string" ? value : invalid();
};

function caller(env: NodeJS.ProcessEnv): EndpointCaller {
  const codex = env.CODEX_THREAD_ID, claude = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (codex !== undefined && claude !== undefined) return invalid("CALLER_IDENTITY_CONFLICT");
  if (codex !== undefined) return { kind: "codex", handle: codex };
  if (claude !== undefined && path.isAbsolute(claude)) return { kind: "claude", address: `uds:${claude}` };
  return invalid("CALLER_IDENTITY_REQUIRED");
}

async function body(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 16_384) return invalid("MESSAGE_TOO_LARGE");
    chunks.push(bytes);
  }
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return invalid("INVALID_MESSAGE_BODY"); }
  if (!value.trim() || value.includes("\0")) return invalid("INVALID_MESSAGE_BODY");
  return value;
}

function hint(command: string, code: string, stateDir: string): string {
  if (code === "CALLER_IDENTITY_CONFLICT") return "Use env -u CLAUDE_CODE_MESSAGING_SOCKET for a Codex call, or env -u CODEX_THREAD_ID for a Claude call; do not restart the broker.";
  if (code === "CONTROL_CONNECT_DENIED") return command === "serve"
    ? `Grant local-policy access to ${stateDir}; verify EMBASSY_STATE_DIR names this user's own directory.`
    : `Grant this task read/write access to ${stateDir}. Verify EMBASSY_STATE_DIR names this user's own directory. The broker may already be running; do not start a second broker.`;
  if (code === "GATEWAY_STATE_SCHEMA_UNSUPPORTED" || code === "CORRUPT_GATEWAY_STATE") return "Follow docs/CONFIGURATION.md#private-state-reset. Inspect unsettled work with the old version before resetting; a reset abandons it. Preserve the old state backup.";
  if (code === "CONTROL_VERSION_MISMATCH") return "Rebuild or repoint the CLI and broker to the same installation; restarting an unchanged binary cannot fix version skew.";
  if (code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS") return "The operation may have applied. Inspect status; do not resend an uncertain write.";
  if (code === "CONTROL_INVALID_RESPONSE") return "If installations changed, rebuild or repoint the CLI and broker; otherwise inspect the broker and restart it if necessary.";
  if (code === "CODEX_DIRECT_INPUT_UNAVAILABLE") return "This Codex agent does not accept direct input; choose its parent or another endpoint.";
  if (code === "CONTROL_SOCKET_UNSAFE" || code === "INSECURE_STATE_DIR") return `Check ownership and private modes for ${stateDir}, and local sandbox access. Do not move state or start a second broker.`;
  if (code === "CONTROL_SOCKET_MISSING" || code === "CONTROL_LISTENER_UNAVAILABLE") return `No broker is reachable at ${stateDir}. Run embassy service install, or embassy serve in a trusted terminal.`;
  return "";
}

function renderStatus(value: unknown): string {
  if (!object(value) || !Array.isArray(value.routes)) return invalid("CONTROL_INVALID_RESPONSE");
  const lines = [`Broker: ${String(value.health)}${value.safeErrorCode ? ` / ${value.safeErrorCode}` : ""} (control/ledger; not a provider readiness proof)`];
  if (object(value.codex)) { const observed = typeof value.codex.observedAt === "string" ? Date.parse(value.codex.observedAt) : Number.NaN;
    lines.push(`Codex discovery: ${value.codex.complete ? "complete" : "partial"}${value.codex.truncated ? " / truncated" : ""}${value.codex.safeErrorCode ? ` / ${value.codex.safeErrorCode}` : ""} (${Number.isFinite(observed) ? `${Math.max(0, Date.now() - observed)} ms ago` : "not yet observed"})`); }
  for (const { row, depth } of groupCodexEndpoints(value.routes.filter(object))) {
    const last = object(row.lastOperation) ? `  last ${String(row.lastOperation.outcome)} / ${String(row.lastOperation.code)}` : "  not yet observed";
    const collision = value.routes.filter((candidate) => object(candidate) && candidate.alias === row.alias).length > 1;
    const codex = object(row.codex) ? `  ${String(row.codex.state)} / direct input ${row.codex.canAcceptDirectInput === false ? "refused" : row.codex.canAcceptDirectInput === true ? "yes" : "unknown"}` : "";
    lines.push(`${depth ? "  ↳ " : ""}${String(row.alias)}${collision ? ` [ambiguous name; endpoint ${row.id}]` : ""}  ${String(row.provider)}${codex}  queued ${String(row.queueDepth)}${last}`);
  }
  if (value.routes.length === 0) lines.push("No registered endpoints.");
  if (object(value.federation) && Array.isArray(value.federation.nodes)) {
    for (const node of value.federation.nodes as Record<string, unknown>[]) {
      lines.push(`SSH ${node.host}: ${node.safeErrorCode ?? "catalog observation"}  ${node.observedAt ?? "not yet refreshed"}`);
      for (const row of node.routes as Record<string, unknown>[]) lines.push(`  ${row.alias}  ${row.provider}  owner ${row.host}`);
    }
    if (value.federation.truncated) lines.push("Remote display limited to 128 rows; named lookup still asks the owner.");
  }
  const messages = value.messages as Record<string, unknown>[];
  if (messages.length) lines.push("Recent deliveries:", ...messages.slice(-10).map((row) =>
    `  ${row.source ?? "retired sender"} -> ${row.target ?? "remote/retired recipient"}: ${row.state}${row.safeErrorCode ? ` / ${row.safeErrorCode}` : ""} (${row.ageMs} ms)`));
  const retirements = value.retirements as Record<string, unknown>[];
  if (retirements.length) lines.push("Recent retirements:", ...retirements.slice(-10).map((row) => `  ${row.alias}  ${row.at}`));
  return `${lines.join("\n")}\n`;
}

export async function runCoreCli(args: readonly string[], dependencies: CoreCliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env, stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout, stderr = dependencies.stderr ?? process.stderr;
  const write = (command: string, result: unknown): void => { stdout.write(`${JSON.stringify({ ok: true, command, result })}\n`); };
  const verbs = ["--help", "--version", "serve", "service", "send", "register-codex", "retire", "status", "tui", "refresh", "health", "check", "delivery-status", "wait-delivery", "peer-stdio"];
  const command = args[0] === undefined ? "--help" : verbs.includes(args[0]) ? args[0] : "unknown";
  let stateDir = "the configured state directory";
  try {
    if (command === "--help" && args.length <= 1) { stdout.write(HELP); return 0; }
    if (command === "--version" && args.length === 1) { stdout.write(`embassy ${CORE_VERSION}\n`); return 0; }
    stateDir = path.resolve(defaultGatewayStateDir(env));
    if (command === "serve") {
      if (args.length !== 1) return invalid();
      await runCoreRuntime({ env, ...(dependencies.signal ? { signal: dependencies.signal } : {}), onReady: (ready) => { write(command, ready); } });
      return 0;
    }
    if (command === "service") {
      const subcommand = args[1];
      if (args.length !== 2 || (subcommand !== "install" && subcommand !== "uninstall" && subcommand !== "status")) return invalid();
      write(command, await runCoreServiceCommand(subcommand, env, {
        homeDir: userInfo().homedir, runLaunchctl: defaultRunLaunchctl,
        execPath: process.execPath, cliPath: fileURLToPath(import.meta.url), uid: process.getuid!(),
      }));
      return 0;
    }
    const inventory = await loadGatewayNodeInventory(stateDir);
    const config = loadGatewayConfig(env, inventory);
    const call = async (request: BrokerCommand): Promise<unknown> => {
      const mutating = commandMutates(request.method);
      const malformed = (): never => invalid(mutating ? "CONTROL_WRITE_OUTCOME_AMBIGUOUS" : "CONTROL_INVALID_RESPONSE");
      const response = await requestLocalControl({ stateDir, socketPath: config.controlSocketPath,
        request, mutating, timeoutMs: request.method === "check" ? 30_000 : 15_000 });
      if (!object(response) || typeof response.ok !== "boolean") return malformed();
      if (!response.ok) {
        if (Object.keys(response).length !== 2 || typeof response.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(response.code)) return malformed();
        if (mutating && ["HANDLER_FAILURE", "INVALID_HANDLER_RESPONSE", "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN"].includes(response.code)) return malformed();
        throw new BridgeError(response.code, "The gateway refused the command.");
      }
      if (Object.keys(response).length !== 2 || !isBrokerResult(request.method, response.result)) return malformed();
      return response.result;
    };
    if (command === "tui") {
      if (args.length !== 1) return invalid();
      const ssh = createTuiSshClient({ nodes: inventory.nodes, env });
      await runTui({ input: stdin, output: stdout, call, renderStatus, host: inventory.host,
        remote: { hosts: inventory.nodes, call: ssh.call, close: ssh.close },
        hint: (code, host) => host && host !== inventory.host
          ? `On ${host}: ${hint("tui", code, "the configured state directory on that host")}`
          : hint("tui", code, stateDir),
        ...(dependencies.signal ? { signal: dependencies.signal } : {}) });
      return 0;
    }
    if (command === "peer-stdio") {
      if (args.length !== 1) return invalid();
      const session = runFederationStdio({ host: inventory.host, nodes: inventory.nodes, input: stdin,
        output: stdout as Writable, handlers: {
          resolve: async (node, selector) => await call({ method: "peer_resolve", params: { node, selector } }) as PublicEndpoint | null,
          catalog: async (node) => await call({ method: "peer_catalog", params: { node } }) as PublicEndpoint[],
          handoff: async (peerHost, handoff) => await call({ method: "peer_handoff", params: { node: peerHost, handoff } }) as { accepted: true } | { accepted: false; code: string },
        } });
      await session.done;
      return 0;
    }
    let request: BrokerCommand;
    let json = false;
    if (command === "send") {
      const options = argumentsFor(args.slice(1), ["--to", "--conversation"]);
      if (options.size !== 1) return invalid();
      request = { method: "send", params: { caller: caller(env), body: await body(stdin),
        ...(options.has("--to") ? { to: required(options, "--to") } : { conversation: required(options, "--conversation") }) } };
    } else if (command === "register-codex") {
      const options = argumentsFor(args.slice(1), ["--alias", "--succeeds"]);
      request = { method: "register_codex", params: { caller: caller(env), alias: required(options, "--alias"),
        ...(options.has("--succeeds") ? { succeeds: required(options, "--succeeds") } : {}) } };
    } else if (command === "retire") {
      const options = argumentsFor(args.slice(1), ["--alias", "--endpoint"]);
      if (options.size !== 1) return invalid();
      request = { method: "retire_route", params: options.has("--alias")
        ? { alias: required(options, "--alias") } : { endpoint: required(options, "--endpoint") } };
    } else if (command === "delivery-status" || command === "wait-delivery") {
      request = { method: "delivery_status", params: { token: required(argumentsFor(args.slice(1), ["--token"]), "--token") } };
    } else if (command === "status") {
      json = argumentsFor(args.slice(1), ["--json"]).has("--json");
      request = { method: "list_snapshot", params: {} };
    } else {
      if (args.length !== 1) return invalid();
      const method = command === "health" ? "health" : command === "refresh" ? "refresh_discovery" : command === "check" ? "check" : undefined;
      if (!method) return invalid();
      request = { method, params: {} };
    }
    let result = await call(request);
    if (command === "wait-delivery") {
      const wallLimit = Date.now() + 86_403_000;
      for (let attempts = 0; attempts < 345_612; attempts++) {
        if (!object(result) || result.found !== true || result.terminal === true) break;
        if (dependencies.signal?.aborted || Date.now() >= Math.min(wallLimit, Date.parse(String(result.deadlineAt)) + 3_000)) return invalid("CONTROL_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await call(request);
      }
    }
    if (command === "status" && !json && stdout.isTTY) stdout.write(renderStatus(result));
    else write(command, result);
    if (command === "wait-delivery") return object(result) && result.found === true ? result.state === "delivered" ? 0 : 6 : 3;
    return 0;
  } catch (error) {
    const code = error instanceof BridgeError || error instanceof LocalControlError ? error.code : "INTERNAL_ERROR";
    stdout.write(`${JSON.stringify({ ok: false, command, error: { code } })}\n`);
    stderr.write(`[embassy] ${code}\n`);
    const guidance = hint(command, code, stateDir);
    if (guidance) stderr.write(`[embassy] ${guidance}\n`);
    return code === "INVALID_ARGUMENTS" || code === "INVALID_REQUEST" ? 2 : 3;
  }
}

let entrypoint = false;
try { entrypoint = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Imported module, not a CLI entry. */ }
if (entrypoint) {
  runCoreCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
