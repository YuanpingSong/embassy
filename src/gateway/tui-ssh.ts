import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

import { isBrokerResult, type BrokerCommand } from "./broker-control.js";

const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 64 * 1024;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const ENDPOINT = /^reg_[A-Za-z0-9_-]{1,252}$/;
const DELIVERY = /^dlv_[A-Za-z0-9_-]{24}$/;
const UNCERTAIN = new Set(["HANDLER_FAILURE", "INVALID_HANDLER_RESPONSE", "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN"]);

type Child = {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "error" | "close", listener: (...args: any[]) => void) => unknown;
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
};
type SshOptions = { env: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"] };
export type TuiSshSpawn = (command: string, args: readonly string[], options: SshOptions) => Child;
type Invocation = Readonly<{ cli: string; args: readonly string[]; timeout: number; mutating: boolean }>;
type Timer = ReturnType<typeof setTimeout>;
type Timers = Readonly<{ setTimeout: (callback: () => void, milliseconds: number) => Timer; clearTimeout: (timer: Timer) => void }>;
type Active = { child: Child; stopping?: boolean; killTimer?: Timer };
type Obj = Record<string, unknown>;

const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Obj => object(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const cleanEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]),
);

export class TuiSshError extends Error {
  readonly detail: Readonly<{ detail: string }> | undefined;
  constructor(readonly code: string, detail?: string) {
    super(code); this.name = "TuiSshError";
    this.detail = detail === undefined ? undefined : { detail };
  }
}

function invocation(command: BrokerCommand): Invocation {
  const empty = (value: unknown): boolean => exact(value, []);
  switch (command.method) {
    case "list_snapshot": if (empty(command.params)) return { cli: "status", args: ["--json"], timeout: 8_000, mutating: false }; break;
    case "refresh_discovery": if (empty(command.params)) return { cli: "refresh", args: [], timeout: 15_000, mutating: true }; break;
    case "check": if (empty(command.params)) return { cli: "check", args: [], timeout: 30_000, mutating: true }; break;
    case "delivery_status": if (exact(command.params, ["token"]) && DELIVERY.test(command.params.token))
      return { cli: "delivery-status", args: ["--token", command.params.token], timeout: 8_000, mutating: false }; break;
    case "retire_route": if ("endpoint" in command.params && exact(command.params, ["endpoint"]) && ENDPOINT.test(command.params.endpoint))
      return { cli: "retire", args: ["--endpoint", command.params.endpoint], timeout: 15_000, mutating: true }; break;
  }
  throw new TuiSshError("INVALID_REQUEST");
}

export function createTuiSshClient(options: Readonly<{
  nodes: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawn?: TuiSshSpawn;
  timers?: Timers;
}>): Readonly<{ call: (host: string, command: BrokerCommand) => Promise<unknown>; close: () => void }> {
  if (options.nodes.length > 32 || new Set(options.nodes).size !== options.nodes.length || options.nodes.some((node) => !HOST.test(node)))
    throw new TypeError("Invalid TUI SSH nodes");
  const nodes = new Set(options.nodes), active = new Map<string, Active>();
  const env = cleanEnvironment(options.env ?? process.env);
  const spawn: TuiSshSpawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  const timers = options.timers ?? { setTimeout, clearTimeout };
  let closing = false;

  const stop = (entry: Active) => {
    if (entry.stopping) return;
    entry.stopping = true;
    entry.child.kill("SIGTERM");
    entry.killTimer = timers.setTimeout(() => entry.child.kill("SIGKILL"), 1_000);
    entry.killTimer.unref?.();
  };

  const run = (host: string, args: readonly string[], timeout: number, mutating: boolean): Promise<string> => {
    if (closing) return Promise.reject(new TuiSshError("CONTROL_UNAVAILABLE"));
    if (!nodes.has(host)) return Promise.reject(new TuiSshError("PEER_NOT_CONFIGURED"));
    if (active.has(host)) return Promise.reject(new TuiSshError("ROUTE_BUSY"));
    let child: Child;
    try {
      child = spawn("/usr/bin/ssh", ["-T", "-x", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
        "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "-o", "SendEnv=-*", "-o", "Tunnel=no",
        host, "embassy", ...args], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch { return Promise.reject(new TuiSshError("PEER_TUNNEL_UNAVAILABLE")); }
    const entry: Active = { child }; active.set(host, entry);
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, settled = false, invalidOutput = false;
      const finish = (error?: TuiSshError, value?: string) => {
        if (settled) return; settled = true; timers.clearTimeout(wall);
        error ? reject(error) : resolve(value!);
      };
      const failed = () => new TuiSshError(mutating ? "CONTROL_WRITE_OUTCOME_AMBIGUOUS" : "PEER_TUNNEL_UNAVAILABLE");
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_LIMIT) { invalidOutput = true; stop(entry); }
        else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_LIMIT) { finish(failed()); stop(entry); }
      });
      child.once("error", () => finish(failed()));
      child.once("close", (code) => {
        if (entry.killTimer) timers.clearTimeout(entry.killTimer);
        if (active.get(host) === entry) active.delete(host);
        if (settled) return;
        if (stdoutBytes === 0 || code === null) return finish(failed());
        if (invalidOutput) return finish(new TuiSshError(mutating ? "CONTROL_WRITE_OUTCOME_AMBIGUOUS" : "CONTROL_INVALID_RESPONSE"));
        try { finish(undefined, new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout))); }
        catch { finish(new TuiSshError(mutating ? "CONTROL_WRITE_OUTCOME_AMBIGUOUS" : "CONTROL_INVALID_RESPONSE")); }
      });
      const wall = timers.setTimeout(() => { finish(failed()); stop(entry); }, timeout);
      wall.unref?.();
    });
  };

  const version = async (host: string): Promise<string> => {
    try {
      const output = await run(host, ["--version"], 8_000, false);
      if (Buffer.byteLength(output) > 128) return "unknown";
      const match = /^embassy ([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)\n?$/.exec(output);
      return match?.[1] ?? "unknown";
    } catch { return "unknown"; }
  };

  const call = async (host: string, command: BrokerCommand): Promise<unknown> => {
    const request = invocation(command);
    let output: string;
    try { output = await run(host, [request.cli, ...request.args], request.timeout, request.mutating); }
    catch (error) {
      if (!request.mutating && error instanceof TuiSshError && error.code === "CONTROL_INVALID_RESPONSE") {
        const observed = await version(host);
        throw new TuiSshError("CONTROL_INVALID_RESPONSE", `unsupported response — remote CLI version ${observed}`);
      }
      throw error;
    }
    const unsupported = async (): Promise<never> => {
      if (request.mutating) throw new TuiSshError("CONTROL_WRITE_OUTCOME_AMBIGUOUS");
      const observed = await version(host);
      throw new TuiSshError("CONTROL_INVALID_RESPONSE", `unsupported response — remote CLI version ${observed}`);
    };
    let envelope: unknown;
    if (output.indexOf("\n") !== output.length - 1) return await unsupported();
    try { envelope = JSON.parse(output.slice(0, -1)); }
    catch { return await unsupported(); }
    if (!object(envelope) || envelope.command !== request.cli || typeof envelope.ok !== "boolean") return await unsupported();
    if (envelope.ok === false) {
      if (!exact(envelope, ["ok", "command", "error"]) || !exact(envelope.error, ["code"]) || !safeCode(envelope.error.code))
        return await unsupported();
      if (request.mutating && UNCERTAIN.has(envelope.error.code)) throw new TuiSshError("CONTROL_WRITE_OUTCOME_AMBIGUOUS");
      throw new TuiSshError(envelope.error.code);
    }
    if (!exact(envelope, ["ok", "command", "result"]) || !isBrokerResult(command.method, envelope.result)) return await unsupported();
    if ((command.method === "list_snapshot" || command.method === "refresh_discovery") &&
      (envelope.result as { routes: Array<{ host: string }> }).routes.some((row) => row.host !== host))
      throw new TuiSshError("CONTROL_INVALID_RESPONSE", "host mismatch");
    return envelope.result;
  };

  return { call, close: () => {
    if (closing) return; closing = true;
    for (const entry of active.values()) stop(entry);
  } };
}
