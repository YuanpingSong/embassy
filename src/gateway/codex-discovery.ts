import { CORE_VERSION } from "./core-version.js";
import type { CodexAppServerTransport } from "./codex-app-server.js";
import {
  createLocalCodexTransportFactory,
  LocalCodexTransportError,
  type LocalCodexTransportFactory,
  type LocalCodexTransportFactoryOptions,
} from "./codex-local-transport.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentThreadSpawn",
] as const;
const OPT_OUTS = [
  "item/started", "item/completed", "item/agentMessage/delta",
  "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta", "thread/tokenUsage/updated",
  "turn/diff/updated", "turn/plan/updated",
] as const;
const DEFAULT_RECONNECT_DELAYS = [250, 1_000, 5_000] as const;

type JsonObject = Record<string, unknown>;
type Timer = ReturnType<typeof setTimeout>;

export type CodexThread = Readonly<{
  id: string;
  name?: string;
  agentNickname?: string;
  parentThreadId?: string;
  status: "notLoaded" | "idle" | "active" | "waitingOnApproval" |
    "waitingOnUserInput" | "systemError" | "unknown";
  canAcceptDirectInput?: boolean;
  loaded: boolean;
}>;

export type CodexDiscoveryObservation = Readonly<{
  observedAt?: string;
  safeErrorCode?: string;
  truncated: boolean;
  complete: boolean;
}>;

export type CodexDiscoverySnapshot = Readonly<{
  threads: readonly CodexThread[];
  removedIds: readonly string[];
  observation: CodexDiscoveryObservation;
}>;

export type CodexDiscoveryObserver = Readonly<{
  start: () => void;
  refresh: () => Promise<void>;
  snapshot: () => CodexDiscoverySnapshot;
  close: () => Promise<void>;
}>;

export type CodexDiscoveryOptions = Readonly<{
  hostId: string;
  local?: Omit<LocalCodexTransportFactoryOptions, "hostId">;
  maxEndpoints?: number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  onSnapshot: (snapshot: CodexDiscoverySnapshot) => void | Promise<void>;
}>;

export type CodexDiscoveryDependencies = Readonly<{
  createFactory?: (options: LocalCodexTransportFactoryOptions) => Promise<LocalCodexTransportFactory>;
  now?: () => Date;
  setTimer?: (callback: () => void, milliseconds: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}>;

class DiscoveryError extends Error {
  constructor(readonly code: string) { super(code); }
}

const record = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function status(value: unknown): CodexThread["status"] {
  if (!record(value) || typeof value.type !== "string") return "unknown";
  if (value.type === "notLoaded" || value.type === "idle" || value.type === "systemError") {
    return value.type;
  }
  if (value.type !== "active") return "unknown";
  if (value.activeFlags === undefined) return "active";
  if (!Array.isArray(value.activeFlags) || value.activeFlags.length > 32 ||
      !value.activeFlags.every((flag) => typeof flag === "string" && flag.length <= 128)) {
    throw new DiscoveryError("PROTOCOL_ERROR");
  }
  if (value.activeFlags.includes("waitingOnApproval")) return "waitingOnApproval";
  if (value.activeFlags.includes("waitingOnUserInput")) return "waitingOnUserInput";
  return "active";
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 256 || value.includes("\0")) {
    throw new DiscoveryError("PROTOCOL_ERROR");
  }
  return value;
}

function parseThread(value: unknown): CodexThread {
  if (!record(value) || typeof value.id !== "string" || !UUID.test(value.id)) {
    throw new DiscoveryError("PROTOCOL_ERROR");
  }
  const parentThreadId = optionalText(value.parentThreadId);
  if (parentThreadId !== undefined && !UUID.test(parentThreadId)) {
    throw new DiscoveryError("PROTOCOL_ERROR");
  }
  if (value.canAcceptDirectInput !== undefined && value.canAcceptDirectInput !== null &&
      typeof value.canAcceptDirectInput !== "boolean") {
    throw new DiscoveryError("PROTOCOL_ERROR");
  }
  const thread: {
    id: string; name?: string; agentNickname?: string; parentThreadId?: string;
    status: CodexThread["status"]; canAcceptDirectInput?: boolean; loaded: boolean;
  } = { id: value.id.toLowerCase(), status: status(value.status), loaded: false };
  const name = optionalText(value.name);
  const agentNickname = optionalText(value.agentNickname);
  if (name !== undefined) thread.name = name;
  if (agentNickname !== undefined) thread.agentNickname = agentNickname;
  if (parentThreadId !== undefined) thread.parentThreadId = parentThreadId.toLowerCase();
  if (typeof value.canAcceptDirectInput === "boolean") {
    thread.canAcceptDirectInput = value.canAcceptDirectInput;
  }
  return Object.freeze(thread);
}

class RpcSession {
  #nextId = 1;
  #pending: { id: number; resolve: (value: unknown) => void;
    reject: (error: Error) => void; timer: Timer } | undefined;
  #lost = false;
  readonly #remove: Array<() => void>;

  constructor(
    readonly transport: CodexAppServerTransport,
    readonly requestTimeoutMs: number,
    readonly setTimer: (callback: () => void, milliseconds: number) => Timer,
    readonly clearTimer: (timer: Timer) => void,
    readonly notification: (method: string, params: unknown) => void,
    readonly lost: () => void,
  ) {
    this.#remove = [
      transport.onMessage((payload) => this.#message(payload)),
      transport.onClose(() => this.#fail("TRANSPORT_CLOSED")),
      transport.onError(() => this.#fail("TRANSPORT_CLOSED")),
    ];
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUTS },
      clientInfo: { name: "embassy", title: "Embassy", version: CORE_VERSION },
    });
    if (!record(result)) throw new DiscoveryError("PROTOCOL_ERROR");
    void this.transport.send(JSON.stringify({ method: "initialized", params: {} }))
      .catch(() => this.#fail("TRANSPORT_CLOSED"));
  }

  async request(method: string, params: JsonObject): Promise<unknown> {
    if (this.#lost) throw new DiscoveryError("TRANSPORT_CLOSED");
    if (this.#pending !== undefined) throw new DiscoveryError("PROTOCOL_ERROR");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = undefined;
        reject(new DiscoveryError("REQUEST_TIMEOUT"));
      }, this.requestTimeoutMs);
      this.#pending = { id, reject, resolve, timer };
    });
    void Promise.resolve().then(() => this.transport.send(JSON.stringify({ id, method, params })))
      .catch(() => this.#reject("TRANSPORT_CLOSED"));
    return await response;
  }

  dispose(): void {
    this.#lost = true;
    for (const remove of this.#remove.splice(0)) remove();
    this.#reject("TRANSPORT_CLOSED");
  }

  #message(payload: string): void {
    if (Buffer.byteLength(payload) > 1024 * 1024) { this.#fail("PROTOCOL_ERROR"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { this.#fail("PROTOCOL_ERROR"); return; }
    if (!record(parsed)) { this.#fail("PROTOCOL_ERROR"); return; }
    if (typeof parsed.method === "string") {
      if (parsed.id === undefined) this.notification(parsed.method, parsed.params);
      return; // Server requests and unwanted deltas are drained, never answered or retained.
    }
    if (typeof parsed.id !== "number" || parsed.id !== this.#pending?.id) {
      this.#fail("PROTOCOL_ERROR"); return;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    this.clearTimer(pending.timer);
    if (Object.hasOwn(parsed, "result") === Object.hasOwn(parsed, "error")) {
      pending.reject(new DiscoveryError("PROTOCOL_ERROR")); return;
    }
    if (Object.hasOwn(parsed, "error")) {
      pending.reject(new DiscoveryError("RPC_REJECTED")); return;
    }
    pending.resolve(parsed.result);
  }

  #reject(code: string): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    this.clearTimer(pending.timer);
    pending.reject(new DiscoveryError(code));
  }

  #fail(code: string): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#reject(code);
    this.lost();
  }
}

type Event = Readonly<{ sequence: number } & (
  { kind: "upsert"; thread: CodexThread } |
  { kind: "status"; id: string; status: CodexThread["status"] } |
  { kind: "name"; id: string; name?: string } |
  { kind: "remove"; id: string } |
  { kind: "closed"; id: string }
)>;

class Observer implements CodexDiscoveryObserver {
  readonly #max: number;
  readonly #refreshMs: number;
  readonly #requestMs: number;
  readonly #delays: readonly number[];
  readonly #now: () => Date;
  readonly #setTimer: (callback: () => void, milliseconds: number) => Timer;
  readonly #clearTimer: (timer: Timer) => void;
  readonly #createFactory: NonNullable<CodexDiscoveryDependencies["createFactory"]>;
  #threads = new Map<string, CodexThread>();
  #removals = new Set<string>();
  #events: Event[] = [];
  #sequence = 0;
  #snapshot: CodexDiscoverySnapshot = Object.freeze({
    threads: [], removedIds: [], observation: { truncated: false, complete: false },
  });
  #factory: LocalCodexTransportFactory | undefined;
  #session: RpcSession | undefined;
  #timer: Timer | undefined;
  #running: Promise<void> | undefined;
  #publishPending: CodexDiscoverySnapshot | undefined;
  #publishRunning: Promise<void> | undefined;
  #unsubscribe = new Set<string>();
  #unsubscribeRunning: Promise<void> | undefined;
  #cleanup: Promise<void> | undefined;
  #cleanupFailed = false;
  #epoch = 0;
  #started = false;
  #closed = false;
  #retry = 0;

  constructor(readonly options: CodexDiscoveryOptions, dependencies: CodexDiscoveryDependencies) {
    this.#max = integer(options.maxEndpoints, 128);
    if (this.#max > 128) throw new DiscoveryError("INVALID_CONFIGURATION");
    this.#refreshMs = integer(options.refreshIntervalMs, 5_000);
    this.#requestMs = integer(options.requestTimeoutMs, 15_000);
    this.#delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    if (this.#delays.length === 0 || this.#delays.some((delay) =>
      !Number.isSafeInteger(delay) || delay < 0)) throw new DiscoveryError("INVALID_CONFIGURATION");
    this.#now = dependencies.now ?? (() => new Date());
    this.#setTimer = dependencies.setTimer ?? setTimeout;
    this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.#createFactory = dependencies.createFactory ?? ((factoryOptions) =>
      createLocalCodexTransportFactory(factoryOptions));
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    void this.refresh().catch(() => undefined);
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.reject(new DiscoveryError("TRANSPORT_CLOSED"));
    this.#cancelTimer();
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#run().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  snapshot(): CodexDiscoverySnapshot { return this.#snapshot; }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch += 1;
    this.#cancelTimer();
    const running = this.#running;
    await this.#disconnect();
    await running?.catch(() => undefined);
    await this.#publishRunning?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    try {
      if (this.#session === undefined) await this.#connect();
      await this.#scan(this.#session!);
      this.#retry = 0;
      this.#schedule(this.#refreshMs);
    } catch (error) {
      await this.#disconnect();
      await this.#observeError(error);
      this.#schedule(this.#delays[Math.min(this.#retry++, this.#delays.length - 1)]!);
      throw error;
    }
  }

  async #connect(): Promise<void> {
    await this.#cleanup;
    if (this.#cleanupFailed) throw new DiscoveryError("CLEANUP_FAILED");
    const epoch = this.#epoch;
    const factory = await this.#createFactory({ ...this.options.local, hostId: this.options.hostId });
    if (this.#closed || epoch !== this.#epoch) {
      await factory.close();
      throw new DiscoveryError("TRANSPORT_CLOSED");
    }
    let session: RpcSession | undefined;
    this.#factory = factory;
    try {
      const transport = await factory.connectTransport();
      if (this.#closed || epoch !== this.#epoch) {
        await transport.close();
        throw new DiscoveryError("TRANSPORT_CLOSED");
      }
      session = new RpcSession(
        transport, this.#requestMs, this.#setTimer, this.#clearTimer,
        (method, params) => this.#event(method, params),
        () => this.#connectionLost(session!),
      );
      this.#session = session;
      this.#serial = session.initialize();
      await this.#serial;
    } catch (error) {
      await this.#disconnect();
      throw error;
    }
  }

  async #scan(session: RpcSession): Promise<void> {
    const startSequence = this.#sequence;
    const scanned = new Map<string, CodexThread>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let truncated = false;
    let pages = 0;
    do {
      if (++pages > this.#max + 1) { truncated = true; break; }
      const params: JsonObject = {
        archived: false, limit: Math.min(this.#max + 1, 100),
        sortKey: "recencyAt", sourceKinds: SOURCE_KINDS, useStateDbOnly: true,
      };
      if (cursor !== null) params.cursor = cursor;
      const page = await this.#serialRequest(session, "thread/list", params);
      if (!record(page) || !Array.isArray(page.data)) throw new DiscoveryError("PROTOCOL_ERROR");
      for (const value of page.data) {
        const thread = parseThread(value);
        if (scanned.has(thread.id)) scanned.delete(thread.id);
        scanned.set(thread.id, thread);
        if (scanned.size > this.#max) { truncated = true; break; }
      }
      if (truncated) break;
      const next = page.nextCursor;
      if (next === null || next === undefined) cursor = null;
      else if (typeof next !== "string" || next.length === 0 || next.length > 256 || cursors.has(next)) {
        throw new DiscoveryError("PROTOCOL_ERROR");
      } else { cursors.add(next); cursor = next; }
    } while (cursor !== null);

    const loaded = new Set<string>();
    const loadedCursors = new Set<string>();
    let loadedCursor: string | null = null;
    let loadedCount = 0;
    let loadedComplete = true;
    let loadedPages = 0;
    do {
      if (++loadedPages > this.#max + 1) { loadedComplete = false; break; }
      const params: JsonObject = { limit: Math.min(this.#max + 1, 100) };
      if (loadedCursor !== null) params.cursor = loadedCursor;
      const page = await this.#serialRequest(session, "thread/loaded/list", params);
      if (!record(page) || !Array.isArray(page.data) ||
          !page.data.every((id) => typeof id === "string" && UUID.test(id))) {
        throw new DiscoveryError("PROTOCOL_ERROR");
      }
      loadedCount += page.data.length;
      for (const id of page.data) {
        const normalized = id.toLowerCase();
        if (scanned.has(normalized)) loaded.add(normalized);
      }
      if (loadedCount > this.#max * 8) {
        loadedComplete = false;
        break;
      }
      const next = page.nextCursor;
      if (next === null || next === undefined) loadedCursor = null;
      else if (typeof next !== "string" || next.length === 0 || next.length > 256 ||
          loadedCursors.has(next)) throw new DiscoveryError("PROTOCOL_ERROR");
      else { loadedCursors.add(next); loadedCursor = next; }
    } while (loadedCursor !== null);
    const firstEvent = this.#events[0]?.sequence ?? this.#sequence + 1;
    const eventOverflow = firstEvent > startSequence + 1;
    if (!eventOverflow) {
      const merged = new Map<string, CodexThread>();
      for (const thread of scanned.values()) {
        if (merged.size === this.#max) break;
        merged.set(thread.id, Object.freeze({
          ...thread,
          loaded: loaded.has(thread.id) || !loadedComplete && thread.loaded,
        }));
      }
      if (truncated) for (const thread of this.#threads.values()) {
        if (!merged.has(thread.id) && merged.size < this.#max)
          merged.set(thread.id, { ...thread, status: "unknown", loaded: false });
      }
      for (const event of this.#events) {
        if (event.sequence > startSequence) truncated = this.#apply(event, merged) || truncated;
      }
      this.#threads = merged;
    }
    await this.#setSnapshot({
      observedAt: this.#now().toISOString(),
      truncated: truncated || eventOverflow || !loadedComplete,
      complete: !truncated && !eventOverflow && loadedComplete,
    });
  }

  #event(method: string, params: unknown): void {
    // Initialization subscribes us to every new thread, including internal
    // sources outside thread/list's six filters. Release those subscriptions too.
    if (method === "thread/started" && record(params) && record(params.thread) &&
      typeof params.thread.id === "string" && UUID.test(params.thread.id)) {
      const id = params.thread.id.toLowerCase();
      if (!this.#unsubscribe.has(id) && this.#unsubscribe.size >= this.#max) {
        this.#connectionLost(this.#session, new DiscoveryError("PROTOCOL_ERROR")); return;
      }
      this.#unsubscribe.add(id); this.#drainUnsubscribe();
    }
    let event: Event | undefined;
    try { event = this.#parseEvent(method, params); } catch (error) {
      this.#session?.dispose();
      this.#connectionLost(this.#session, error);
      return;
    }
    if (event === undefined) return;
    this.#events.push(event);
    if (this.#events.length > 512) this.#events.shift();
    let overflow: boolean;
    try { overflow = this.#apply(event, this.#threads); }
    catch (error) { this.#connectionLost(this.#session, error); return; }
    void this.#setSnapshot({
      ...this.#snapshot.observation,
      complete: this.#snapshot.observation.complete && !overflow,
      truncated: this.#snapshot.observation.truncated || overflow,
    }).catch(() => undefined);
  }

  #parseEvent(method: string, params: unknown): Event | undefined {
    if (method === "thread/started") {
      if (!record(params)) throw new DiscoveryError("PROTOCOL_ERROR");
      const thread = parseThread(params.thread);
      const source = (params.thread as JsonObject).source;
      if (!["cli", "vscode", "exec", "mcp"].includes(String(source)) &&
        !(record(source) && Object.hasOwn(source, "subagent"))) return undefined;
      return Object.freeze({
        kind: "upsert", sequence: ++this.#sequence,
        thread: Object.freeze({ ...thread, loaded: true }),
      });
    }
    if (!["thread/status/changed", "thread/name/updated", "thread/archived",
      "thread/deleted", "thread/closed"].includes(method)) return undefined;
    const sequence = ++this.#sequence;
    if (!record(params) || typeof params.threadId !== "string" || !UUID.test(params.threadId)) {
      throw new DiscoveryError("PROTOCOL_ERROR");
    }
    const id = params.threadId.toLowerCase();
    if (method === "thread/archived" || method === "thread/deleted") {
      return Object.freeze({ kind: "remove", sequence, id });
    }
    if (method === "thread/closed") return Object.freeze({ kind: "closed", sequence, id });
    if (method === "thread/status/changed") {
      return Object.freeze({ kind: "status", sequence, id, status: status(params.status) });
    }
    const name = optionalText(params.threadName);
    return name === undefined
      ? Object.freeze({ kind: "name", sequence, id })
      : Object.freeze({ kind: "name", sequence, id, name });
  }

  #apply(event: Event, target: Map<string, CodexThread>): boolean {
    if (event.kind === "upsert") {
      return this.#upsert(target, event.thread);
    }
    if (event.kind === "remove") {
      if (!this.#removals.has(event.id) && this.#removals.size >= this.#max * 4)
        throw new DiscoveryError("PROTOCOL_ERROR");
      target.delete(event.id); this.#removals.add(event.id);
      return false;
    }
    const existing = target.get(event.id);
    if (existing === undefined) return false;
    if (event.kind === "closed") {
      target.set(event.id, Object.freeze({ ...existing, status: "notLoaded", loaded: false }));
    } else if (event.kind === "status") {
      target.set(event.id, Object.freeze({ ...existing, status: event.status, loaded: true }));
    } else {
      const next = { ...existing };
      if (event.name === undefined) delete next.name; else next.name = event.name;
      target.set(event.id, Object.freeze(next));
    }
    return false;
  }

  #upsert(target: Map<string, CodexThread>, thread: CodexThread): boolean {
    const overflow = !target.has(thread.id) && target.size >= this.#max;
    if (overflow) target.delete(target.keys().next().value!);
    target.delete(thread.id);
    target.set(thread.id, Object.freeze(thread));
    return overflow;
  }

  #serial = Promise.resolve<unknown>(undefined);
  #serialRequest(session: RpcSession | undefined, method: string, params: JsonObject): Promise<unknown> {
    if (session === undefined) return Promise.reject(new DiscoveryError("TRANSPORT_CLOSED"));
    const request = this.#serial.then(() => session.request(method, params));
    this.#serial = request.catch(() => undefined);
    return request;
  }

  #drainUnsubscribe(): void {
    if (this.#unsubscribeRunning !== undefined || this.#closed) return;
    const session = this.#session;
    if (session === undefined) return;
    this.#unsubscribeRunning = (async () => {
      while (this.#session === session) {
        const id = this.#unsubscribe.values().next().value;
        if (id === undefined) break;
        this.#unsubscribe.delete(id);
        await this.#serialRequest(session, "thread/unsubscribe", { threadId: id });
      }
    })().catch((error) => {
      this.#connectionLost(session, error);
    }).finally(() => {
      this.#unsubscribeRunning = undefined;
      if (this.#unsubscribe.size > 0) this.#drainUnsubscribe();
    });
  }

  #connectionLost(session: RpcSession | undefined, error: unknown = new DiscoveryError("TRANSPORT_CLOSED")): void {
    if (session === undefined || session !== this.#session || this.#closed) return;
    this.#cancelTimer();
    void this.#observeError(error).catch(() => undefined);
    void this.#disconnect().then(
      () => this.#schedule(this.#delays[Math.min(this.#retry++, this.#delays.length - 1)]!),
      () => { void this.#observeError(new DiscoveryError("CLEANUP_FAILED")).catch(() => undefined); },
    );
  }

  async #disconnect(): Promise<void> {
    const session = this.#session;
    const factory = this.#factory;
    this.#session = undefined;
    this.#factory = undefined;
    session?.dispose();
    this.#unsubscribe.clear();
    if (factory !== undefined) {
      this.#cleanup = (async () => {
        let failure: unknown;
        try { await session?.transport.close(); } catch (error) { failure = error; }
        try { await factory.close(); } catch (error) { failure ??= error; }
        if (failure !== undefined) { this.#cleanupFailed = true; throw failure; }
      })();
    }
    await this.#cleanup;
  }

  #observeError(error: unknown): Promise<void> {
    const safeErrorCode = error instanceof LocalCodexTransportError || error instanceof DiscoveryError
      ? error.code : "PROTOCOL_ERROR";
    return this.#setSnapshot({ ...this.#snapshot.observation, safeErrorCode, complete: false });
  }

  #setSnapshot(observation: CodexDiscoveryObservation): Promise<void> {
    const normalized = { ...observation };
    if (normalized.safeErrorCode === undefined) delete normalized.safeErrorCode;
    this.#snapshot = Object.freeze({
      threads: Object.freeze([...this.#threads.values()]),
      removedIds: Object.freeze([...this.#removals]),
      observation: Object.freeze(normalized),
    });
    this.#publishPending = this.#snapshot;
    if (this.#publishRunning === undefined) {
      this.#publishRunning = Promise.resolve().then(() => this.#publish()).finally(() => {
        this.#publishRunning = undefined;
        if (this.#publishPending !== undefined)
          void this.#setSnapshot(this.#snapshot.observation).catch(() => undefined);
      });
      return this.#publishRunning;
    }
    return this.#publishRunning;
  }

  async #publish(): Promise<void> {
    let failure: unknown;
    while (this.#publishPending !== undefined) {
      const delivered = this.#publishPending;
      this.#publishPending = undefined;
      try {
        await this.options.onSnapshot(delivered);
        for (const id of delivered.removedIds) {
          if (!this.#threads.has(id)) this.#removals.delete(id);
        }
      } catch (error) { failure ??= error; }
      if (this.#snapshot === delivered &&
          this.#removals.size !== delivered.removedIds.length) {
        this.#snapshot = Object.freeze({
          ...delivered, removedIds: Object.freeze([...this.#removals]),
        });
      }
    }
    if (failure !== undefined) throw failure;
  }

  #schedule(milliseconds: number): void {
    if (!this.#started || this.#closed || this.#timer !== undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.refresh().catch(() => undefined);
    }, milliseconds);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}

function integer(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new DiscoveryError("INVALID_CONFIGURATION");
  }
  return candidate;
}

export function createCodexDiscoveryObserver(
  options: CodexDiscoveryOptions,
  dependencies: CodexDiscoveryDependencies = {},
): CodexDiscoveryObserver {
  return new Observer(options, dependencies);
}
