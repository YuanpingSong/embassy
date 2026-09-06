import { createHash } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import { BridgeError } from "../errors.js";
import type { Destination, WakeInput, WakeResult } from "./coordinator.js";
import type { RemoteEndpointResolver } from "./endpoint-directory.js";
import type { Endpoint, EndpointRef } from "./ledger.js";

export const FEDERATION_PROTOCOL_VERSION = 3;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_ENDPOINTS = 128;
const MAX_MESSAGES = 128;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_BATCH_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SAFE_REFUSALS = new Set([
  "INVALID_PEER_HANDOFF", "ROUTE_UNREGISTERED", "ROUTE_BINDING_MISMATCH",
  "INVALID_MESSAGE_BODY", "MESSAGE_EXPIRED", "RATE_LIMITED", "QUEUE_FULL",
  "MESSAGE_TOO_LARGE", "INVALID_DEADLINE", "GATEWAY_RATE_LIMITED", "GATEWAY_QUEUE_FULL",
]);

export type PublicEndpoint = Readonly<{
  id: string;
  host: string;
  provider: "claude" | "codex";
  alias: string;
}>;

export type FederationObservation = Readonly<{
  host: string;
  observedAt?: string;
  safeErrorCode?: "PEER_TUNNEL_UNAVAILABLE";
  routes: readonly PublicEndpoint[];
}>;

export type FederationSnapshot = Readonly<{
  nodes: readonly FederationObservation[];
  truncated: boolean;
}>;

export type FederatedHandoff = Readonly<{
  target: PublicEndpoint;
  messages: readonly Readonly<{
    id: string;
    reply: string;
    source: PublicEndpoint;
    body: string;
    deadline: number;
    steer: boolean;
  }>[];
}>;

type FederationResult = Readonly<{ accepted: true } | { accepted: false; code: string }>;
type ResolveRefusal = Readonly<{ refused: true; code: "PEER_ALIAS_COLLISION" }>;
type Method = "initialize" | "resolve" | "catalog" | "handoff";
type RpcId = number | string;
type Obj = Record<string, unknown>;
type Child = Pick<ChildProcessWithoutNullStreams, "kill" | "once" | "stderr" | "stdin" | "stdout">;
export type FederationSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => Child;
type Timers = Readonly<{ setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }>;
type Pending = Readonly<{
  method: Method;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>;

class FederationTransportError extends Error {
  constructor(message = "Federation transport lost") {
    super(message);
    this.name = "FederationTransportError";
  }
}

class FederationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederationInputError";
  }
}

const object = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Obj =>
  object(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const host = (value: unknown): value is string => typeof value === "string" &&
  /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value);
const alias = (value: unknown): value is string => typeof value === "string" &&
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(value);
const token = (value: unknown, prefix: string): value is string => typeof value === "string" &&
  value.startsWith(prefix) && value.length > prefix.length && value.length <= 256 &&
  /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
const endpoint = (value: unknown): value is PublicEndpoint => exact(value, ["id", "host", "provider", "alias"]) &&
  token(value.id, "reg_") && host(value.host) && (value.provider === "claude" || value.provider === "codex") &&
  alias(value.alias) && value.alias.endsWith(`@${value.host}`);
const endpointRef = (value: unknown): value is EndpointRef => exact(value, ["id", "host", "provider"]) &&
  token(value.id, "reg_") && host(value.host) && (value.provider === "claude" || value.provider === "codex");
const messageId = (value: unknown): value is string => typeof value === "string" &&
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const conversationId = (value: unknown): value is string => typeof value === "string" &&
  /^conv_[A-Za-z0-9_-]{16,64}$/.test(value);
const sameRef = (left: EndpointRef, right: EndpointRef): boolean =>
  left.id === right.id && left.host === right.host && left.provider === right.provider;
const publicEndpoint = ({ id, host: hostId, provider, alias: name }: Endpoint): PublicEndpoint =>
  ({ id, host: hostId, provider, alias: name });
const localEndpoint = (value: PublicEndpoint): Endpoint => ({ ...value, handle: value.id });

export function isFederatedHandoff(value: unknown): value is FederatedHandoff {
  if (!exact(value, ["target", "messages"]) || !endpoint(value.target) ||
    !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) return false;
  let bytes = 0;
  for (const item of value.messages) {
    if (!exact(item, ["id", "reply", "source", "body", "deadline", "steer"]) ||
      !messageId(item.id) || !conversationId(item.reply) || !endpoint(item.source) ||
      typeof item.body !== "string" || item.body.length === 0 || item.body.includes("\0") ||
      Buffer.byteLength(item.body) > MAX_BODY_BYTES || !Number.isSafeInteger(item.deadline) ||
      Number(item.deadline) < 0 || typeof item.steer !== "boolean") return false;
    bytes += Buffer.byteLength(item.body);
  }
  return bytes <= MAX_BATCH_BYTES;
}

function encode(value: unknown): string {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new FederationTransportError("Federation frame too large");
  return frame;
}

function decodeResult(method: Method, value: unknown): unknown {
  if (method === "initialize") {
    if (!exact(value, ["version", "host"]) || value.version !== FEDERATION_PROTOCOL_VERSION || !host(value.host))
      throw new FederationTransportError("Federation protocol mismatch");
    return value;
  }
  if (method === "resolve") {
    if (exact(value, ["refused", "code"]) && value.refused === true &&
      value.code === "PEER_ALIAS_COLLISION") return value;
    if (value !== null && !endpoint(value)) throw new FederationTransportError("Invalid resolve result");
    return value;
  }
  if (method === "catalog") {
    if (!Array.isArray(value) || value.length > MAX_ENDPOINTS || !value.every(endpoint))
      throw new FederationTransportError("Invalid catalog result");
    return value;
  }
  if (exact(value, ["accepted"]) && value.accepted === true) return value;
  if (exact(value, ["accepted", "code"]) && value.accepted === false &&
    typeof value.code === "string" && SAFE_REFUSALS.has(value.code)) return value;
  throw new FederationTransportError("Invalid handoff result");
}

class FederationConnection {
  private readonly pending = new Map<RpcId, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly child: Child,
    private readonly timers: Timers,
  ) {
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.once("error", () => this.fail(new FederationTransportError()));
    child.once("exit", () => this.fail(new FederationTransportError()));
  }

  static async spawn(options: Readonly<{
    node: string;
    localHost: string;
    spawn?: FederationSpawn;
    timers?: Timers;
  }>): Promise<FederationConnection> {
    let child: Child;
    try {
      child = (options.spawn ?? nodeSpawn)("/usr/bin/ssh", [
        "-T", "-x", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
        "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "-o", "SendEnv=-*",
        "-o", "Tunnel=no", options.node, "embassy", "peer-stdio",
      ], { env: cleanEnvironment(process.env), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      throw new FederationTransportError("Federation process could not be spawned");
    }
    const connection = new FederationConnection(child, options.timers ?? { setTimeout, clearTimeout });
    try {
      const initialized = await connection.request("initialize", {
        version: FEDERATION_PROTOCOL_VERSION,
        host: options.localHost,
      }) as { version: number; host: string };
      if (initialized.host !== options.node) throw new FederationTransportError("Federation host mismatch");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  request(method: Method, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return this.requestFrame(method, id, encode({ jsonrpc: "2.0", id, method, params }));
  }

  prepareHandoff(input: FederatedHandoff): Readonly<{
    bytes: number;
    sha256: string;
    cancel: () => void;
    perform: () => Promise<FederationResult>;
  }> {
    if (!isFederatedHandoff(input)) throw new FederationInputError("Invalid federation handoff");
    if (this.closed) throw new FederationTransportError();
    const id = this.nextId++;
    let frame: string;
    try {
      frame = encode({ jsonrpc: "2.0", id, method: "handoff", params: input });
    } catch {
      throw new FederationInputError("Federation handoff frame too large");
    }
    let state: "prepared" | "performed" | "cancelled" = "prepared";
    return {
      bytes: Buffer.byteLength(frame),
      sha256: createHash("sha256").update(frame).digest("hex"),
      cancel: () => { if (state === "prepared") state = "cancelled"; },
      perform: async () => {
        if (state !== "prepared") throw new FederationTransportError("Federation handoff already consumed");
        state = "performed";
        return await this.requestFrame("handoff", id, frame) as FederationResult;
      },
    };
  }

  close(): void {
    this.fail(new FederationTransportError());
  }

  private requestFrame(method: Method, id: RpcId, frame: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new FederationTransportError());
    if (this.pending.size >= 32) return Promise.reject(new FederationTransportError("Federation request capacity reached"));
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        const error = new FederationTransportError("Federation request timed out");
        this.fail(error);
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { method, timer, resolve, reject });
      void this.write(frame).catch((error) => {
        const pending = this.pending.get(id);
        if (pending) this.timers.clearTimeout(pending.timer);
        this.pending.delete(id);
        this.fail(error);
        reject(error);
      });
    });
  }

  private write(frame: string): Promise<void> {
    const operation = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.closed) return reject(new FederationTransportError());
      this.child.stdin.write(frame, (error) =>
        error ? reject(new FederationTransportError()) : resolve());
    }));
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME_BYTES) this.fail(new FederationTransportError("Federation response too large"));
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_FRAME_BYTES) return this.fail(new FederationTransportError("Federation response too large"));
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        return this.fail(new FederationTransportError("Federation returned malformed JSON"));
      }
      if (!object(message) || message.jsonrpc !== "2.0")
        return this.fail(new FederationTransportError("Invalid federation response"));
      if (typeof message.method === "string") {
        if (!exact(message, ["jsonrpc", "id", "method", "params"]) ||
          (typeof message.id !== "number" && typeof message.id !== "string"))
          return this.fail(new FederationTransportError("Invalid federation request"));
        void this.write(encode({ jsonrpc: "2.0", id: message.id,
          error: { code: METHOD_NOT_FOUND, message: "Method not found" } })).catch((error) => this.fail(error));
        continue;
      }
      if ((typeof message.id !== "number" && typeof message.id !== "string") ||
        (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) || Object.keys(message).length !== 3)
        return this.fail(new FederationTransportError("Invalid federation response"));
      const pending = this.pending.get(message.id);
      if (!pending) return this.fail(new FederationTransportError("Uncorrelated federation response"));
      this.pending.delete(message.id);
      this.timers.clearTimeout(pending.timer);
      if (Object.hasOwn(message, "error")) {
        if (!exact(message.error, ["code", "message"]) ||
          !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string" ||
          message.error.message.length > 256) {
          const error = new FederationTransportError("Invalid federation error response");
          pending.reject(error);
          this.fail(error);
          continue;
        }
        pending.reject(new FederationTransportError("Federation request refused"));
        continue;
      }
      try {
        pending.resolve(decodeResult(pending.method, message.result));
      } catch (error) {
        pending.reject(error as Error);
        this.fail(error as Error);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }
}

const cleanEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"].flatMap((key) =>
    env[key] === undefined ? [] : [[key, env[key]!]]),
);

export class Federation implements Destination, RemoteEndpointResolver {
  private readonly nodes: ReadonlySet<string>;
  private readonly connections = new Map<string, Promise<FederationConnection>>();
  private readonly catalogs = new Map<string, readonly PublicEndpoint[]>();
  private readonly catalogCounts = new Map<string, number>();
  private readonly observedAt = new Map<string, string>();
  private readonly failed = new Set<string>();
  private readonly now: () => number;
  private catalogTruncated = false;
  private closing = false;

  constructor(private readonly options: Readonly<{
    host: string;
    nodes: readonly string[];
    spawn?: FederationSpawn;
    now?: () => number;
  }>) {
    if (!host(options.host) || options.nodes.length > 32 ||
      options.nodes.some((node) => !host(node) || node === options.host) ||
      new Set(options.nodes).size !== options.nodes.length) throw new TypeError("Invalid federation nodes");
    this.nodes = new Set(options.nodes);
    this.now = options.now ?? Date.now;
  }

  async named(name: string): Promise<readonly Endpoint[]> {
    if (!alias(name)) return [];
    const hostId = name.slice(name.lastIndexOf("@") + 1);
    if (!this.nodes.has(hostId)) return [];
    const resolved = await this.resolveAt(hostId, name);
    return resolved === undefined ? [] : [resolved];
  }

  async exact(identity: EndpointRef): Promise<Endpoint | undefined> {
    if (!endpointRef(identity) || !this.nodes.has(identity.host)) return undefined;
    return await this.resolveAt(identity.host, identity);
  }

  async catalog(): Promise<PublicEndpoint[]> {
    await Promise.all(this.options.nodes.map(async (node) => {
      try {
        const value = await (await this.connection(node)).request("catalog", {});
        const rows = value as PublicEndpoint[];
        if (rows.some((row) => row.host !== node) || new Set(rows.map((row) => row.id)).size !== rows.length)
          throw new FederationTransportError("Non-local federation catalog");
        this.catalogs.set(node, rows.map((row) => ({ ...row })).sort((left, right) => {
          const a = `${left.alias}\0${left.provider}\0${left.id}`;
          const b = `${right.alias}\0${right.provider}\0${right.id}`;
          return a < b ? -1 : a > b ? 1 : 0;
        }));
        this.catalogCounts.set(node, rows.length);
        this.observedAt.set(node, new Date(this.now()).toISOString());
        this.failed.delete(node);
      } catch {
        this.drop(node);
        this.failed.add(node);
      }
    }));
    this.compactCatalogs();
    return this.options.nodes.flatMap((node) =>
      (this.catalogs.get(node) ?? []).map((row) => ({ ...row })));
  }

  /** Last bounded display observation only. Reading it performs no network I/O;
   * exact and named routing continue to use the authenticated owner RPC. */
  snapshot(): FederationSnapshot {
    return {
      nodes: this.options.nodes.map((node) => ({
        host: node,
        ...(this.observedAt.has(node) ? { observedAt: this.observedAt.get(node)! } : {}),
        ...(this.failed.has(node) ? { safeErrorCode: "PEER_TUNNEL_UNAVAILABLE" as const } : {}),
        routes: (this.catalogs.get(node) ?? []).map((row) => ({ ...row })),
      })),
      truncated: this.catalogTruncated,
    };
  }

  async deliver(input: WakeInput): Promise<WakeResult> {
    if (this.closing || !this.nodes.has(input.target.host) || input.messages.length < 1)
      return { outcome: "failed", code: "INVALID_PEER_HANDOFF" };
    const target = publicEndpoint(input.target);
    const value: FederatedHandoff = {
      target,
      messages: input.messages.map(({ delivery, source }) => ({
        id: delivery.id,
        reply: delivery.reply,
        source: publicEndpoint(source),
        body: delivery.body,
        deadline: delivery.deadline,
        steer: delivery.steer,
      })),
    };
    if (!isFederatedHandoff(value) || value.target.host !== input.target.host ||
      value.messages.some((message, index) => message.source.host !== this.options.host ||
        !sameRef(input.messages[index]!.delivery.target, input.target) ||
        !sameRef(input.messages[index]!.delivery.source, message.source)))
      return { outcome: "failed", code: "INVALID_PEER_HANDOFF" };
    let connection: FederationConnection;
    let prepared: ReturnType<FederationConnection["prepareHandoff"]>;
    try {
      connection = await this.connection(input.target.host);
      prepared = connection.prepareHandoff(value);
    } catch (error) {
      if (error instanceof FederationInputError)
        return { outcome: "failed", code: "INVALID_PEER_HANDOFF" };
      this.drop(input.target.host);
      return { outcome: "deferred", code: "PEER_TUNNEL_UNAVAILABLE" };
    }
    let authorized: boolean;
    try {
      authorized = await input.authorize({ bytes: prepared.bytes, sha256: prepared.sha256 });
    } catch {
      prepared.cancel();
      return { outcome: "ambiguous", code: "WRITE_AUTHORIZATION_UNCERTAIN" };
    }
    if (!authorized) {
      prepared.cancel();
      return { outcome: "deferred", code: "WRITE_AUTHORIZATION_DENIED" };
    }
    let result: FederationResult;
    try {
      result = await prepared.perform();
    } catch {
      this.drop(input.target.host);
      return { outcome: "ambiguous", code: "PEER_HANDOFF_OUTCOME_UNKNOWN" };
    }
    if (!result.accepted) return { outcome: "failed", code: result.code };
    try {
      await input.accepted("unconfirmed");
    } catch {
      return { outcome: "unconfirmed", code: "ACCEPTANCE_UNCONFIRMED" };
    }
    return { outcome: "delivered", code: "PEER_HANDOFF_CONFIRMED" };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const connection of this.connections.values())
      void connection.then((client) => client.close()).catch(() => undefined);
    await Promise.allSettled(this.connections.values());
    this.connections.clear();
    this.catalogs.clear();
    this.catalogCounts.clear();
    this.observedAt.clear();
    this.failed.clear();
    this.catalogTruncated = false;
  }

  private async resolveAt(node: string, selector: string | EndpointRef): Promise<Endpoint | undefined> {
    try {
      const value = await (await this.connection(node)).request("resolve", { selector });
      if (value === null) return undefined;
      if (exact(value, ["refused", "code"]) && value.refused === true &&
        value.code === "PEER_ALIAS_COLLISION") {
        throw new BridgeError("PEER_ALIAS_COLLISION", "The endpoint name is ambiguous.");
      }
      const resolved = value as PublicEndpoint;
      if (resolved.host !== node || (typeof selector === "string" ? resolved.alias !== selector : !sameRef(resolved, selector)))
        throw new FederationTransportError("Federation resolved another endpoint");
      return localEndpoint(resolved);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "PEER_ALIAS_COLLISION") throw error;
      this.drop(node);
      throw new BridgeError("PEER_TUNNEL_UNAVAILABLE", "The owning gateway could not resolve the endpoint.", true);
    }
  }

  private connection(node: string): Promise<FederationConnection> {
    if (this.closing || !this.nodes.has(node)) return Promise.reject(new FederationTransportError());
    const existing = this.connections.get(node);
    if (existing) return existing;
    const pending = FederationConnection.spawn({ node, localHost: this.options.host,
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }) });
    this.connections.set(node, pending);
    void pending.catch(() => { if (this.connections.get(node) === pending) this.connections.delete(node); });
    return pending;
  }

  private drop(node: string): void {
    const pending = this.connections.get(node);
    this.connections.delete(node);
    void pending?.then((connection) => connection.close()).catch(() => undefined);
  }

  private compactCatalogs(): void {
    let remaining = MAX_ENDPOINTS;
    this.catalogTruncated = false;
    for (const node of this.options.nodes) {
      const rows = this.catalogs.get(node) ?? [];
      const retained = rows.slice(0, remaining);
      if ((this.catalogCounts.get(node) ?? rows.length) > retained.length) this.catalogTruncated = true;
      if (retained.length || this.catalogs.has(node)) this.catalogs.set(node, retained);
      remaining -= retained.length;
    }
  }
}

export type FederationHandlers = Readonly<{
  resolve: (peerHost: string, selector: string | EndpointRef) => PublicEndpoint | null | Promise<PublicEndpoint | null>;
  catalog: (peerHost: string) => readonly PublicEndpoint[] | Promise<readonly PublicEndpoint[]>;
  handoff: (peerHost: string, input: FederatedHandoff) => FederationResult | Promise<FederationResult>;
}>;

export type FederationStdioSession = Readonly<{ done: Promise<void>; close: () => void }>;

export function runFederationStdio(options: Readonly<{
  host: string;
  nodes: readonly string[];
  handlers: FederationHandlers;
  input?: Readable;
  output?: Writable;
}>): FederationStdioSession {
  if (!host(options.host) || options.nodes.length > 32 ||
    options.nodes.some((node) => !host(node) || node === options.host) ||
    new Set(options.nodes).size !== options.nodes.length) throw new TypeError("Invalid federation nodes");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const allowed = new Set(options.nodes);
  let buffer = Buffer.alloc(0);
  let peerHost: string | undefined;
  let closed = false;
  let operations = Promise.resolve();
  let queued = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const close = (): void => {
    if (closed) return;
    closed = true;
    input.off("data", read);
    input.off("end", end);
    finish();
  };
  const write = (id: RpcId | null, result?: unknown, error?: Readonly<{ code: number; message: string }>): Promise<void> => {
    if (closed) return Promise.resolve();
    let frame: string;
    try {
      frame = encode({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) });
    } catch {
      frame = encode({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: "Internal error" } });
    }
    return new Promise((resolve, reject) => output.write(frame, (fault) => fault ? reject(fault) : resolve()));
  };
  const dispatch = async (message: Obj): Promise<void> => {
    if (closed) return;
    const id = message.id as RpcId;
    const method = message.method;
    if (typeof method !== "string" || !["initialize", "resolve", "catalog", "handoff"].includes(method)) {
      await write(id, undefined, { code: METHOD_NOT_FOUND, message: "Method not found" });
      return;
    }
    try {
      if (method === "initialize") {
        if (peerHost !== undefined || !exact(message.params, ["version", "host"]) ||
          message.params.version !== FEDERATION_PROTOCOL_VERSION || !host(message.params.host) ||
          !allowed.has(message.params.host)) throw new TypeError("invalid params");
        peerHost = message.params.host;
        await write(id, { version: FEDERATION_PROTOCOL_VERSION, host: options.host });
        return;
      }
      if (peerHost === undefined) throw new TypeError("invalid params");
      if (method === "resolve") {
        if (!exact(message.params, ["selector"])) throw new TypeError("invalid params");
        const selector = message.params.selector;
        if (typeof selector !== "string" && !endpointRef(selector)) throw new TypeError("invalid params");
        if (typeof selector === "string" ? !alias(selector) || !selector.endsWith(`@${options.host}`) : selector.host !== options.host)
          throw new TypeError("invalid params");
        let result: PublicEndpoint | null;
        try {
          result = await options.handlers.resolve(peerHost, selector);
        } catch (error) {
          if (error instanceof BridgeError && error.code === "PEER_ALIAS_COLLISION") {
            await write(id, { refused: true, code: "PEER_ALIAS_COLLISION" } satisfies ResolveRefusal);
            return;
          }
          throw error;
        }
        if (result !== null && (!endpoint(result) || result.host !== options.host ||
          (typeof selector === "string" ? result.alias !== selector : !sameRef(result, selector))))
          throw new TypeError("invalid result");
        await write(id, result);
        return;
      }
      if (method === "catalog") {
        if (!exact(message.params, [])) throw new TypeError("invalid params");
        const result = await options.handlers.catalog(peerHost);
        if (result.length > MAX_ENDPOINTS || result.some((row) => !endpoint(row) || row.host !== options.host))
          throw new TypeError("invalid result");
        await write(id, result);
        return;
      }
      if (!isFederatedHandoff(message.params) || message.params.target.host !== options.host ||
        message.params.messages.some((item) => item.source.host !== peerHost))
        throw new TypeError("invalid params");
      const result = await options.handlers.handoff(peerHost, message.params);
      if (!(exact(result, ["accepted"]) && result.accepted === true) &&
        !(exact(result, ["accepted", "code"]) && result.accepted === false &&
          typeof result.code === "string" && SAFE_REFUSALS.has(result.code)))
        throw new TypeError("invalid result");
      await write(id, result);
    } catch (error) {
      await write(id, undefined, {
        code: error instanceof TypeError ? INVALID_PARAMS : INTERNAL_ERROR,
        message: error instanceof TypeError ? "Invalid params" : "Internal error",
      });
    }
  };
  const read = (chunk: Buffer): void => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES) close();
        return;
      }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_FRAME_BYTES) return close();
      if (++queued > 32) return close();
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        operations = operations.then(() => write(null, undefined, { code: -32700, message: "Parse error" })).catch(close).finally(() => { queued--; });
        continue;
      }
      if (!exact(value, ["jsonrpc", "id", "method", "params"]) || value.jsonrpc !== "2.0" ||
        (typeof value.id !== "number" && typeof value.id !== "string") || typeof value.method !== "string") {
        operations = operations.then(() => write(null, undefined, { code: -32600, message: "Invalid Request" })).catch(close).finally(() => { queued--; });
        continue;
      }
      operations = operations.then(() => dispatch(value)).catch(close).finally(() => { queued--; });
    }
  };
  const end = (): void => { void operations.then(close); };
  input.on("data", read);
  input.once("end", end);
  input.once("error", close);
  return { done, close };
}
