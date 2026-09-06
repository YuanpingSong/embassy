import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { BridgeError } from "../src/errors.js";
import type { ClaudePeerAdapter, ClaudePeerDescriptor } from "../src/gateway/claude-peer.js";
import type { StatelessCodexOperationTransport } from "../src/gateway/codex-stateless-transport.js";
import {
  Federation,
  runFederationStdio,
  type FederatedHandoff,
  type FederationSpawn,
  type PublicEndpoint,
} from "../src/gateway/federation.js";
import type { GatewayInstanceLease } from "../src/gateway/instance-lease.js";
import { requestLocalControl } from "../src/gateway/local-control.js";
import { runCoreRuntime, type CoreRuntimeDependencies } from "../src/gateway/runtime.js";

type AppResult = Readonly<{ ok: true; result: unknown } | { ok: false; code: string }>;
type Write = Readonly<{ host: string; provider: "claude" | "codex"; text: string }>;
type Running = Readonly<{ stop: () => Promise<void> }>;

const ids = {
  aClaude: "00000000-0000-4000-8000-000000000001",
  aCodex: "00000000-0000-4000-8000-000000000002",
  bClaude: "00000000-0000-4000-8000-000000000003",
  bCodex: "00000000-0000-4000-8000-000000000004",
  bRefused: "00000000-0000-4000-8000-000000000005",
  bUnknown: "00000000-0000-4000-8000-000000000006",
} as const;

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-v4-two-broker-"));
  const hosts = ["alpha", "bravo"] as const;
  const stateDirs = Object.fromEntries(hosts.map((host) => [host, path.join(root, host)])) as Record<(typeof hosts)[number], string>;
  for (const host of hosts) {
    await mkdir(stateDirs[host], { mode: 0o700 });
    await writeFile(path.join(stateDirs[host], "nodes.json"),
      `${JSON.stringify({ version: 1, host, nodes: hosts.filter((candidate) => candidate !== host) })}\n`, { mode: 0o600 });
    await chmod(path.join(stateDirs[host], "nodes.json"), 0o600);
  }

  const writes: Write[] = [];
  const handoffs = new Map<string, number>();
  const beforeHandoff = new Map<string, () => Promise<void>>();
  const loseAfterCommit = new Set<string>();
  const sessions = new Set<ReturnType<typeof runFederationStdio>>();

  const rpc = async (host: "alpha" | "bravo", request: unknown, mutating: boolean): Promise<unknown> => {
    const response = await requestLocalControl({
      stateDir: stateDirs[host], socketPath: path.join(stateDirs[host], "control.sock"), request, mutating,
    }) as AppResult;
    if (!response.ok) throw new BridgeError(response.code, "Remote broker refused the bounded request.");
    return response.result;
  };

  const spawnFor = (localHost: "alpha" | "bravo"): FederationSpawn => (_command, args) => {
    const remoteHost = args.at(-3);
    if (remoteHost !== "alpha" && remoteHost !== "bravo") throw new Error("unexpected fake SSH destination");
    const toRemote = new PassThrough();
    const fromRemote = new PassThrough();
    const stderr = new PassThrough();
    const events = new EventEmitter();
    let killed = false;
    const runner = runFederationStdio({ host: remoteHost, nodes: [localHost], input: toRemote, output: fromRemote,
      handlers: {
        resolve: async (peerHost, selector) => await rpc(remoteHost,
          { method: "peer_resolve", params: { node: peerHost, selector } }, false) as PublicEndpoint | null,
        catalog: async (peerHost) => await rpc(remoteHost,
          { method: "peer_catalog", params: { node: peerHost } }, false) as readonly PublicEndpoint[],
        handoff: async (peerHost, input) => {
          const marker = input.messages[0]!.body;
          handoffs.set(marker, (handoffs.get(marker) ?? 0) + 1);
          const before = beforeHandoff.get(marker);
          if (before) { beforeHandoff.delete(marker); await before(); }
          const result = await rpc(remoteHost,
            { method: "peer_handoff", params: { node: peerHost, handoff: input } }, true) as { accepted: true } | { accepted: false; code: string };
          if (loseAfterCommit.delete(marker)) throw new Error("simulated SSH reply loss after durable destination admission");
          return result;
        },
      } });
    sessions.add(runner);
    return {
      stdin: toRemote, stdout: fromRemote, stderr,
      once: events.once.bind(events),
      kill: () => {
        if (killed) return true;
        killed = true;
        sessions.delete(runner);
        runner.close();
        toRemote.end(); fromRemote.end(); stderr.end();
        events.emit("exit", 0, null);
        return true;
      },
    } as unknown as ReturnType<FederationSpawn>;
  };

  const peers: Record<"alpha" | "bravo", ClaudePeerDescriptor> = {
    alpha: { targetId: ids.aClaude, alias: "claude-a", kind: "interactive", status: "idle", compatibility: "compatible" },
    bravo: { targetId: ids.bClaude, alias: "claude-b", kind: "bg", status: "idle", compatibility: "compatible" },
  };
  const addresses = { alpha: "uds:/test-owned/alpha.sock", bravo: "uds:/test-owned/bravo.sock" } as const;

  const dependencies = (host: "alpha" | "bravo"): CoreRuntimeDependencies => {
    const peer = {
      discover: async () => ({ peers: [peers[host]], rejected: {}, truncated: false, entriesScanned: 1, parseableRecords: 1 }),
      resolveReplyAddress: async (address: string) => {
        if (address !== addresses[host]) throw new BridgeError("CLAUDE_REPLY_ROUTE_MISMATCH", "Unknown test address.");
        return peers[host];
      },
      assertTargetWorkspaceDisjoint: async () => {},
      prepareSend: async (target: string, text: string) => {
        assert.equal(target, peers[host].targetId);
        const frame = JSON.stringify({ target, text });
        return {
          messageId: "00000000-0000-4000-8000-000000000099",
          frameBytes: Buffer.byteLength(frame), sha256: createHash("sha256").update(frame).digest("hex"), cancel: () => {},
          perform: async (authorize: () => Promise<boolean>) => {
            if (!await authorize()) {
              throw new BridgeError("WRITE_AUTHORIZATION_DENIED", "The fake native write was not authorized.", true);
            }
            writes.push({ host, provider: "claude", text });
            return { messageId: "00000000-0000-4000-8000-000000000099", transportStatus: "transport_written" as const };
          },
        };
      },
      close: async () => {},
    } as unknown as ClaudePeerAdapter;
    const operation: StatelessCodexOperationTransport = {
      observe: async () => ({ state: "idle" }),
      execute: async (input) => {
        const frame = JSON.stringify({ route: input.route, text: input.text });
        assert.equal(await input.authorizeWrite({ attemptId: input.attemptId, kind: "codex_turn_start",
          bodyBytes: Buffer.byteLength(input.text), frameBytes: Buffer.byteLength(frame),
          sha256: createHash("sha256").update(frame).digest("hex") }), true);
        writes.push({ host, provider: "codex", text: input.text });
        await input.onAccepted({ attemptId: input.attemptId, turnId: `turn-${host}`, steer: async () => {
          throw new Error("STEER is outside this federation fixture");
        } });
        return { attemptId: input.attemptId, cleanupConfirmed: true, phase: "terminal", state: "terminal", outcome: "completed" };
      },
    };
    const lease: GatewayInstanceLease = { lost: new Promise<void>(() => {}), isLost: () => false, close: async () => {} };
    return {
      loginHome: () => root,
      acquireLease: async () => lease,
      attestClaudeRuntime: async () => ({ sessionsDir: path.join(root, `sessions-${host}`), socketDir: path.join(root, `sockets-${host}`) }),
      createClaudePeer: () => peer,
      createCodexOperation: () => operation,
      createFederation: (local, nodes) => new Federation({ host: local, nodes, spawn: spawnFor(host) }),
    };
  };

  const start = async (host: "alpha" | "bravo"): Promise<Running> => {
    const ready = deferred();
    const controller = new AbortController();
    const running = runCoreRuntime({ env: { EMBASSY_STATE_DIR: stateDirs[host] }, signal: controller.signal,
      onReady: () => ready.resolve() }, dependencies(host));
    await ready.promise;
    return { stop: async () => { controller.abort(); await running; } };
  };

  const command = async (host: "alpha" | "bravo", method: string, params: Record<string, unknown>, mutating = true) =>
    await rpc(host, { method, params }, mutating);
  const response = async (host: "alpha" | "bravo", method: string, params: Record<string, unknown>, mutating = true): Promise<AppResult> =>
    await requestLocalControl({ stateDir: stateDirs[host], socketPath: path.join(stateDirs[host], "control.sock"),
      request: { method, params }, mutating }) as AppResult;
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    for (let index = 0; index < 400; index += 1) {
      if (await predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const waitDelivery = async (host: "alpha" | "bravo", token: string, state: string) => {
    let seen: unknown;
    await waitFor(async () => {
      seen = await command(host, "delivery_status", { token }, false);
      return (seen as { state?: string }).state === state;
    }, `${host} delivery ${state}`);
    return seen as { state: string; safeErrorCode?: string };
  };
  t.after(async () => {
    for (const session of sessions) session.close();
    await rm(root, { recursive: true, force: true });
  });
  return { stateDirs, writes, handoffs, beforeHandoff, loseAfterCommit, start, command, response, waitFor, waitDelivery, addresses };
}

test("two schema-6 brokers deliver every provider pair, admit first contact, retain replies, and never replay uncertainty", async (t) => {
  const f = await fixture(t);
  let alpha = await f.start("alpha"), bravo = await f.start("bravo");
  t.after(async () => { await Promise.allSettled([alpha.stop(), bravo.stop()]); });

  const register = async (host: "alpha" | "bravo", handle: string, alias: string) =>
    await f.command(host, "register_codex", { caller: { kind: "codex", handle }, alias });
  await register("alpha", ids.aCodex, "codex-a@alpha");
  await register("bravo", ids.bCodex, "codex-b@bravo");

  const stateBefore = JSON.parse(await readFile(path.join(f.stateDirs.bravo, "gateway-state.json"), "utf8")) as {
    endpoints: Array<{ host: string }>;
  };
  assert.equal(stateBefore.endpoints.some((endpoint) => endpoint.host === "alpha"), false,
    "the destination starts without a catalog or persisted source route");

  const callers = {
    claude: { kind: "claude", address: f.addresses.alpha },
    codex: { kind: "codex", handle: ids.aCodex },
  } as const;
  let retainedConversation = "";
  for (const source of ["claude", "codex"] as const) {
    for (const target of ["claude", "codex"] as const) {
      const body = `pair:${source}->${target}`;
      const sent = await f.command("alpha", "send", { caller: callers[source], body,
        to: target === "claude" ? "claude-b@bravo" : "codex-b@bravo" }) as {
        conversationId: string; deliveryToken: string;
      };
      if (source === "claude" && target === "claude") retainedConversation = sent.conversationId;
      assert.equal((await f.waitDelivery("alpha", sent.deliveryToken, "delivered")).safeErrorCode,
        "PEER_HANDOFF_CONFIRMED");
    }
  }
  await f.waitFor(() => f.writes.filter((entry) => entry.host === "bravo").length === 4, "all remote native wakes");
  assert.deepEqual(f.writes.filter((entry) => entry.host === "bravo").map((entry) => entry.provider).sort(),
    ["claude", "claude", "codex", "codex"]);
  assert.equal([...f.handoffs.values()].reduce((sum, count) => sum + count, 0), 4);

  await Promise.all([alpha.stop(), bravo.stop()]);
  alpha = await f.start("alpha"); bravo = await f.start("bravo");
  const reply = await f.command("bravo", "send", {
    caller: { kind: "claude", address: f.addresses.bravo }, conversation: retainedConversation,
    body: "reply after both owning brokers restarted",
  }) as { deliveryToken: string };
  await f.waitDelivery("bravo", reply.deliveryToken, "delivered");
  await f.waitFor(() => f.writes.some((entry) => entry.host === "alpha" &&
    entry.text.includes("reply after both owning brokers restarted")), "identity-bound reply after restart");

  await register("bravo", ids.bRefused, "codex-refused@bravo");
  const refusedBody = "prove:pre-enqueue-refusal";
  f.beforeHandoff.set(refusedBody, async () => {
    await f.command("bravo", "retire_route", { alias: "codex-refused@bravo" });
  });
  const refused = await f.command("alpha", "send", {
    caller: callers.codex, to: "codex-refused@bravo", body: refusedBody,
  }) as { deliveryToken: string };
  const refusedReceipt = await f.waitDelivery("alpha", refused.deliveryToken, "failed");
  assert.equal(refusedReceipt.safeErrorCode, "ROUTE_UNREGISTERED");
  assert.equal(f.handoffs.get(refusedBody), 1);
  const refusedState = await readFile(path.join(f.stateDirs.bravo, "gateway-state.json"), "utf8");
  assert.equal(refusedState.includes(refusedBody), false, "a proven pre-enqueue refusal leaves no destination body");

  await register("bravo", ids.bUnknown, "codex-unknown@bravo");
  const unknownBody = "prove:post-commit-reply-loss";
  f.loseAfterCommit.add(unknownBody);
  const unknown = await f.command("alpha", "send", {
    caller: callers.codex, to: "codex-unknown@bravo", body: unknownBody,
  }) as { deliveryToken: string };
  const unknownReceipt = await f.waitDelivery("alpha", unknown.deliveryToken, "ambiguous");
  assert.equal(unknownReceipt.safeErrorCode, "PEER_HANDOFF_OUTCOME_UNKNOWN");
  await f.waitFor(() => f.writes.filter((entry) => entry.host === "bravo" && entry.text.includes(unknownBody)).length === 1,
    "the destination-owned admitted message to wake exactly once");
  await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
  assert.equal(f.handoffs.get(unknownBody), 1, "an uncertain handoff must never replay");
  assert.equal(f.writes.filter((entry) => entry.host === "bravo" && entry.text.includes(unknownBody)).length, 1);
  const installed = JSON.parse(await readFile(path.join(f.stateDirs.bravo, "gateway-state.json"), "utf8")) as {
    deliveries: Array<{ body: string }>;
  };
  assert.equal(installed.deliveries.filter((delivery) => delivery.body === unknownBody).length, 1,
    "the destination ledger owns exactly one durable handoff admission");
});
