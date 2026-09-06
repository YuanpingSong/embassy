import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodexAppServerTransport } from "../src/gateway/codex-app-server.js";
import { CORE_VERSION } from "../src/gateway/core-version.js";
import {
  createCodexDiscoveryObserver,
  type CodexDiscoverySnapshot,
} from "../src/gateway/codex-discovery.js";
import type {
  LocalCodexOwnedTransport,
  LocalCodexTransportFactory,
} from "../src/gateway/codex-local-transport.js";

const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b2";
const C = "00000000-0000-7000-8000-0000000000c3";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Frame = Record<string, unknown>;

class FakeTransport implements CodexAppServerTransport {
  readonly frames: Frame[] = [];
  readonly #messages = new Set<(payload: string) => void>();
  readonly #closes = new Set<() => void>();
  readonly #errors = new Set<() => void>();
  cleanupConfirmed = true;
  closed = false;

  constructor(readonly respond: (frame: Frame, wire: FakeTransport) => unknown) {}

  onMessage(listener: (payload: string) => void): () => void {
    this.#messages.add(listener); return () => this.#messages.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.#closes.add(listener); return () => this.#closes.delete(listener);
  }
  onError(listener: () => void): () => void {
    this.#errors.add(listener); return () => this.#errors.delete(listener);
  }
  async send(payload: string): Promise<void> {
    const frame = JSON.parse(payload) as Frame;
    this.frames.push(frame);
    if (typeof frame.id !== "number") return;
    const result = this.respond(frame, this);
    queueMicrotask(() => this.emit({ id: frame.id, result }));
  }
  async close(): Promise<void> { this.closed = true; }
  emit(frame: unknown): void {
    const payload = JSON.stringify(frame);
    for (const listener of this.#messages) listener(payload);
  }
  lose(): void { for (const listener of this.#closes) listener(); }
}

function factory(wire: FakeTransport): LocalCodexTransportFactory {
  return {
    appServerVersion: "0.153.4", endpointGeneration: "generation", hostId: "m5dev",
    protocol: "codex-app-server", protocolVersion: "0.153.4",
    connectTransport: async () => wire as LocalCodexOwnedTransport,
    close: async () => { await wire.close(); },
  };
}

const thread = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id, source: "cli", status: { type: "idle" }, canAcceptDirectInput: true, ...extra,
});

function observer(
  wire: FakeTransport,
  snapshots: CodexDiscoverySnapshot[],
  options: { maxEndpoints?: number; onSnapshot?: (value: CodexDiscoverySnapshot) => void | Promise<void> } = {},
) {
  const maxEndpoints = options.maxEndpoints === undefined
    ? {} : { maxEndpoints: options.maxEndpoints };
  return createCodexDiscoveryObserver(
    {
      hostId: "m5dev", ...maxEndpoints,
      refreshIntervalMs: 60_000, requestTimeoutMs: 1_000,
      onSnapshot: options.onSnapshot ?? ((value) => { snapshots.push(value); }),
    },
    { createFactory: async () => factory(wire), now: () => new Date("2026-09-06T12:00:00.000Z") },
  );
}

test("discovery initializes before a bounded paged scan and projects only consumed metadata", async () => {
  const snapshots: CodexDiscoverySnapshot[] = [];
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return { userAgent: "codex/0.153.4", ignored: "content" };
    if (frame.method === "thread/list" && !(frame.params as Frame).cursor) {
      return { data: [thread(A, { name: "Root", preview: "must not survive" })], nextCursor: "page-2" };
    }
    if (frame.method === "thread/list") {
      return { data: [thread(B, {
        agentNickname: "Child", parentThreadId: A,
        status: { activeFlags: ["waitingOnApproval"], type: "active" },
      })], nextCursor: null };
    }
    if (frame.method === "thread/loaded/list") return { data: [B] };
    throw new Error(`unexpected ${String(frame.method)}`);
  });
  const discovery = observer(wire, snapshots);

  await discovery.refresh();

  assert.deepEqual(wire.frames.map(({ method }) => method), [
    "initialize", "initialized", "thread/list", "thread/list", "thread/loaded/list",
  ]);
  assert.deepEqual(wire.frames[0], {
    id: 1,
    method: "initialize",
    params: {
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/started", "item/completed", "item/agentMessage/delta",
          "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
          "item/commandExecution/outputDelta", "thread/tokenUsage/updated",
          "turn/diff/updated", "turn/plan/updated",
        ],
      },
      clientInfo: { name: "embassy", title: "Embassy", version: CORE_VERSION },
    },
  });
  assert.deepEqual(wire.frames[2]!.params, {
    archived: false, limit: 100, sortKey: "recencyAt",
    sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentThreadSpawn"],
    useStateDbOnly: true,
  });
  assert.deepEqual(discovery.snapshot(), {
    threads: [
      { id: A, name: "Root", status: "idle", canAcceptDirectInput: true, loaded: false },
      {
        id: B, agentNickname: "Child", parentThreadId: A,
        status: "waitingOnApproval", canAcceptDirectInput: true, loaded: true,
      },
    ],
    removedIds: [],
    observation: {
      complete: true, observedAt: "2026-09-06T12:00:00.000Z", truncated: false,
    },
  });
  assert.equal(JSON.stringify(discovery.snapshot()).includes("preview"), false);
  await discovery.close();
});

test("events delivered during paging win reconciliation and newly subscribed threads are released", async () => {
  const snapshots: CodexDiscoverySnapshot[] = [];
  const wire = new FakeTransport((frame, peer) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list" && !(frame.params as Frame).cursor) {
      peer.emit({ method: "thread/name/updated", params: { threadId: A, threadName: "Renamed" } });
      peer.emit({ method: "thread/started", params: { thread: thread(C, { name: "New" }) } });
      return { data: [thread(A, { name: "Old" })], nextCursor: "next" };
    }
    if (frame.method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (frame.method === "thread/list") return { data: [], nextCursor: null };
    if (frame.method === "thread/loaded/list") return { data: [C] };
    throw new Error(`unexpected ${String(frame.method)}`);
  });
  const discovery = observer(wire, snapshots);

  await discovery.refresh();

  assert.deepEqual(discovery.snapshot().threads, [
    { id: A, name: "Renamed", status: "idle", canAcceptDirectInput: true, loaded: false },
    { id: C, name: "New", status: "idle", canAcceptDirectInput: true, loaded: true },
  ]);
  assert.ok(wire.frames.some((frame) => frame.method === "thread/unsubscribe" &&
    (frame.params as Frame).threadId === C));
  await discovery.close();
});

test("overflow is visible and never implies removal", async () => {
  const snapshots: CodexDiscoverySnapshot[] = [];
  let rows = [thread(A), thread(B)];
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") return { data: rows, nextCursor: null };
    if (frame.method === "thread/loaded/list") return { data: [] };
    throw new Error(`unexpected ${String(frame.method)}`);
  });
  const discovery = observer(wire, snapshots, { maxEndpoints: 2 });
  await discovery.refresh();
  rows = [thread(C), thread(B), thread(A)];

  await discovery.refresh();

  assert.equal(discovery.snapshot().observation.truncated, true);
  assert.equal(discovery.snapshot().observation.complete, false);
  assert.deepEqual(discovery.snapshot().removedIds, []);
  assert.deepEqual(discovery.snapshot().threads.map(({ id }) => id), [C, B]);
  await discovery.close();
});

test("malformed refresh is provider-local and retains the last good inventory", async () => {
  const snapshots: CodexDiscoverySnapshot[] = [];
  let malformed = false;
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") {
      return malformed ? { data: [{ id: "not-a-thread" }] } : { data: [thread(A)], nextCursor: null };
    }
    if (frame.method === "thread/loaded/list") return { data: [] };
    throw new Error(`unexpected ${String(frame.method)}`);
  });
  const discovery = observer(wire, snapshots);
  await discovery.refresh();
  malformed = true;

  await assert.rejects(discovery.refresh(), { message: "PROTOCOL_ERROR" });

  assert.deepEqual(discovery.snapshot().threads.map(({ id }) => id), [A]);
  assert.equal(discovery.snapshot().observation.safeErrorCode, "PROTOCOL_ERROR");
  assert.equal(discovery.snapshot().observation.complete, false);
  await discovery.close();
});

test("archive removal survives a failed consumer and closed only marks a thread unloaded", async () => {
  const seen: CodexDiscoverySnapshot[] = [];
  let rejectRemoval = true;
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") return { data: [thread(A), thread(B)], nextCursor: null };
    if (frame.method === "thread/loaded/list") return { data: [A, B] };
    throw new Error(`unexpected ${String(frame.method)}`);
  });
  const discovery = observer(wire, seen, {
    onSnapshot: async (value) => {
      seen.push(value);
      if (value.removedIds.length > 0 && rejectRemoval) {
        rejectRemoval = false;
        throw new Error("consumer unavailable");
      }
    },
  });
  await discovery.refresh();
  wire.emit({ method: "thread/closed", params: { threadId: A } });
  wire.emit({ method: "thread/archived", params: { threadId: B } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(discovery.snapshot().threads, [
    { id: A, status: "notLoaded", canAcceptDirectInput: true, loaded: false },
  ]);
  assert.deepEqual(discovery.snapshot().removedIds, [B]);

  wire.emit({ method: "thread/status/changed", params: {
    threadId: A, status: { activeFlags: ["waitingOnUserInput"], type: "active" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(discovery.snapshot().removedIds, []);
  assert.equal(discovery.snapshot().threads[0]!.status, "waitingOnUserInput");
  await discovery.close();
});

test("start reconnects after transport loss without exposing native frames", async () => {
  const snapshots: CodexDiscoverySnapshot[] = [];
  const wires = [A, B].map((id) => new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") return { data: [thread(id)], nextCursor: null };
    if (frame.method === "thread/loaded/list") return { data: [] };
    throw new Error(`unexpected ${String(frame.method)}`);
  }));
  let factoryIndex = 0;
  const discovery = createCodexDiscoveryObserver({
    hostId: "m5dev", refreshIntervalMs: 60_000, reconnectDelaysMs: [1],
    onSnapshot: (value) => { snapshots.push(value); },
  }, {
    createFactory: async () => factory(wires[factoryIndex++]!),
  });
  discovery.start();
  while (wires[0]!.frames.length < 4) await new Promise((resolve) => setImmediate(resolve));
  wires[0]!.lose();
  while (wires[1]!.frames.length < 4) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(discovery.snapshot().threads.map(({ id }) => id), [B]);
  assert.equal(JSON.stringify(snapshots).includes("thread/list"), false);
  await discovery.close();
});

test("loaded-list paging and cold nullable capability match the pinned daemon shape", async () => {
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") return { data: [thread(A, { canAcceptDirectInput: null }), thread(B)], nextCursor: null };
    if (frame.method === "thread/loaded/list") return (frame.params as Frame).cursor
      ? { data: [B], nextCursor: null } : { data: [A], nextCursor: "loaded-2" };
    throw new Error("unexpected request");
  });
  const discovery = observer(wire, []);
  await discovery.refresh();
  assert.deepEqual(discovery.snapshot().threads.map((row) => [row.id, row.loaded, row.canAcceptDirectInput]),
    [[A, true, undefined], [B, true, true]]);
  assert.deepEqual(wire.frames.filter((r) => r.method === "thread/loaded/list").map((r) => r.params),
    [{ limit: 100 }, { limit: 100, cursor: "loaded-2" }]);
  await discovery.close();
});

test("a thread created during initialize is unsubscribed after the handshake, not a parallel RPC", async () => {
  const wire = new FakeTransport((frame, peer) => {
    if (frame.method === "initialize") {
      peer.emit({ method: "thread/started", params: { thread: thread(A) } }); return {};
    }
    if (frame.method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (frame.method === "thread/list") return { data: [thread(A)], nextCursor: null };
    return { data: [A], nextCursor: null };
  });
  const discovery = observer(wire, []);
  await discovery.refresh();
  const methods = wire.frames.map((frame) => frame.method);
  assert.ok(methods.indexOf("thread/unsubscribe") > methods.indexOf("initialized"));
  assert.equal(discovery.snapshot().observation.safeErrorCode, undefined);
  assert.equal(discovery.snapshot().threads.length, 1);
  await discovery.close();
});

test("internal threads are drained and unsubscribed without entering the directory", async () => {
  const wire = new FakeTransport((frame) => frame.method === "thread/unsubscribe" ? { status: "unsubscribed" }
    : frame.method === "initialize" ? {} : { data: [], nextCursor: null });
  const discovery = observer(wire, []); await discovery.refresh();
  wire.emit({ method: "thread/started", params: { thread: thread(A, { source: { internal: "guardian" } }) } });
  await tick();
  assert.equal(discovery.snapshot().threads.length, 0);
  assert.ok(wire.frames.some((frame) => frame.method === "thread/unsubscribe" && (frame.params as Frame).threadId === A));
  await discovery.close();
});

test("empty pages with ever-new cursors cannot make the scan unbounded", async () => {
  let pages = 0;
  const wire = new FakeTransport((frame) => {
    if (frame.method === "initialize") return {};
    if (frame.method === "thread/list") return { data: [], nextCursor: `empty-${++pages}` };
    if (frame.method === "thread/loaded/list") return { data: [], nextCursor: null };
    throw new Error("unexpected request");
  });
  const discovery = observer(wire, [], { maxEndpoints: 2 });
  await discovery.refresh();
  assert.equal(pages, 3); assert.equal(discovery.snapshot().observation.truncated, true);
  assert.equal(discovery.snapshot().observation.complete, false);
  await discovery.close();
});

test("a blocked consumer coalesces a metadata burst and drains ignored content", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let block = false, calls = 0;
  const seen: CodexDiscoverySnapshot[] = [];
  const wire = new FakeTransport((frame) => frame.method === "initialize" ? {} : frame.method === "thread/list"
    ? { data: [thread(A)], nextCursor: null } : { data: [], nextCursor: null });
  const discovery = observer(wire, seen, { onSnapshot: async (snapshot) => {
    calls++; seen.push(snapshot); if (block) await held;
  } });
  await discovery.refresh(); block = true;
  wire.emit({ method: "thread/name/updated", params: { threadId: A, threadName: "first" } });
  await tick();
  for (let n = 0; n < 2_000; n++) {
    wire.emit({ method: "thread/name/updated", params: { threadId: A, threadName: `name-${n}` } });
    wire.emit({ method: "thread/tokenUsage/updated", params: { secret: "unconsumed" } });
  }
  assert.equal(calls, 2); release(); await tick();
  assert.equal(calls, 3); assert.equal(seen.at(-1)!.threads[0]!.name, "name-1999");
  assert.equal(JSON.stringify(seen).includes("unconsumed"), false);
  assert.equal(discovery.snapshot().observation.complete, true);
  await discovery.close();
});

test("close cancels a pending initialized connection without waiting for its RPC timer", async () => {
  let sent!: () => void;
  const initialized = new Promise<void>((resolve) => { sent = resolve; });
  const wire = new FakeTransport(() => ({}));
  wire.send = async () => { sent(); };
  const discovery = observer(wire, []);
  const refreshing = discovery.refresh();
  void refreshing.catch(() => undefined);
  await initialized; await discovery.close();
  await assert.rejects(refreshing, { message: "TRANSPORT_CLOSED" });
  assert.equal(wire.closed, true);
});

test("failed owned cleanup prevents another observer from attaching", async () => {
  let connections = 0;
  const wire = new FakeTransport((frame) => frame.method === "initialize" ? {} : { data: [] });
  const discovery = createCodexDiscoveryObserver({ hostId: "m5dev", onSnapshot: () => {} }, {
    createFactory: async () => { connections++; return { ...factory(wire), close: async () => { throw new Error("cleanup failed"); } }; },
  });
  await discovery.refresh(); wire.lose(); await tick();
  await assert.rejects(discovery.refresh(), /cleanup failed/);
  assert.equal(connections, 1); await assert.rejects(discovery.close(), /cleanup failed/);
});
