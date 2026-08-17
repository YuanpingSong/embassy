import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { PeerConnectionLostError, spawnPeerClient, type PeerSpawn } from "../src/gateway/peer-client.js";
import { decodePeerParams, decodePeerResult, peerEdgeRef, peerRouteRef, PEER_MAX_BODY_BYTES, PEER_METHOD_NOT_FOUND,
  type PeerCatalogResult, type PeerHandoffParams } from "../src/gateway/peer-protocol.js";
import { PeerHandlerError, runPeerStdio } from "../src/gateway/peer-stdio.js";

type Rpc = Record<string, unknown>;
const now = "2026-08-17T12:00:00.000Z";
const endpoint = (alias = "codex-main@studio", routeRef = "reg_local") => ({ alias, provider: "codex" as const, host: alias.split("@")[1] as string, routeRef });
const catalog = (): PeerCatalogResult => { const endpoints = [endpoint("codex-main@m5dev", "reg_remote"), endpoint()] as const; return ({ revision: 3, complete: true, truncated: false, generatedAt: now, health: "healthy",
  connectors: [{ provider: "codex", host: "m5dev", health: "healthy", protocol: "app-server", protocolVersion: "1", observationAgeMs: 10 }],
  routes: [{ ref: "reg_remote", alias: "codex-main@m5dev", provider: "codex", host: "m5dev", enabled: true, state: "idle", queueDepth: 0 }],
  consentEdges: [{ ref: peerEdgeRef(endpoints), ownerHost: "m5dev", endpoints }], alerts: [] }); };
const handoff = (body = "hello"): PeerHandoffParams => { const source = endpoint(), target = endpoint("codex-main@m5dev", "reg_remote"); return ({ originAttemptId: "attempt_origin", originMessageId: "msg_origin",
  source, target, edgeRef: peerEdgeRef([source, target]), edgeOwnerHost: "m5dev",
  deadlineAt: now, expectsReply: true, conversationCorrelation: "a1b2c3d4", body }); };

test("peer codecs require exact body-free catalog and bounded opaque handoff fields", () => {
  assert.deepEqual(decodePeerResult("catalog/get", catalog()), catalog());
  assert.throws(() => decodePeerResult("catalog/get", { ...catalog(), body: "secret" }), /INVALID_RESULT/);
  const leaking = catalog();
  assert.throws(() => decodePeerResult("catalog/get", { ...leaking, routes: [{ ...leaking.routes[0], nativeId: "uuid" }] }), /INVALID_RESULT/);
  assert.deepEqual(decodePeerParams("handoff", handoff()), handoff());
  assert.throws(() => decodePeerParams("handoff", handoff("x".repeat(PEER_MAX_BODY_BYTES + 1))), /INVALID_PARAMS/);
  assert.throws(() => decodePeerParams("handoff", { ...handoff(), conversationCorrelation: "conv_private_token" }), /INVALID_PARAMS/);
  assert.throws(() => decodePeerParams("handoff", { ...handoff(), target: { ...handoff().target, routeRef: "native_uuid" } }), /INVALID_PARAMS/);
  assert.throws(() => decodePeerParams("handoff", { ...handoff(), deadlineAt: "2026-02-30T12:00:00.000Z" }), /INVALID_PARAMS/);
  assert.throws(() => decodePeerResult("catalog/get", { ...catalog(), alerts: [{ code: "A".repeat(65), severity: "error", timestamp: now }] }), /INVALID_RESULT/);
  assert.throws(() => decodePeerResult("catalog/get", { ...catalog(), alerts: [{ code: "SAFE", severity: "error", timestamp: now, alias: "/private/secret@m5dev" }] }), /INVALID_RESULT/);
  const left = endpoint(), right = endpoint("codex-main@m5dev", "reg_remote");
  assert.match(peerEdgeRef([left, right]), /^edge_[A-Za-z0-9_-]{43}$/); assert.equal(peerEdgeRef([left, right]), peerEdgeRef([right, left]));
  assert.match(peerRouteRef("studio", "lease_private"), /^reg_[A-Za-z0-9_-]{43}$/);
  assert.equal(peerRouteRef("studio", "lease_private"), peerRouteRef("studio", "lease_private"));
  assert.notEqual(peerRouteRef("studio", "lease_private"), peerRouteRef("m5dev", "lease_private"));
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); killed = false;
  kill(): boolean { this.killed = true; queueMicrotask(() => this.emit("exit")); return true; }
}
class FakePeer {
  readonly child = new FakeChild(); readonly received: Rpc[] = []; private input = "";
  constructor(private handler: (message: Rpc, peer: FakePeer) => void) { this.child.stdin.on("data", (chunk: Buffer) => { this.input += chunk.toString();
    for (;;) { const newline = this.input.indexOf("\n"); if (newline < 0) return; const message = JSON.parse(this.input.slice(0, newline)) as Rpc;
      this.input = this.input.slice(newline + 1); this.received.push(message); this.handler(message, this); } }); }
  send(message: Rpc, fragmented = false): void { const frame = `${JSON.stringify(message)}\n`;
    if (fragmented) { this.child.stdout.write(frame.slice(0, 5)); this.child.stdout.write(frame.slice(5)); } else this.child.stdout.write(frame); }
  result(request: Rpc, result: unknown, fragmented = false): void { this.send({ jsonrpc: "2.0", id: request.id, result }, fragmented); }
}
const spawnFrom = (peer: FakePeer, calls: unknown[][] = []): PeerSpawn => (command, args, options) => {
  calls.push([command, args, options]); return peer.child as unknown as ReturnType<PeerSpawn>; };
function initializedPeer(handler: (message: Rpc, peer: FakePeer) => void = () => {}): FakePeer {
  return new FakePeer((message, peer) => { if (message.method === "initialize") peer.result(message, {
    protocolVersion: 1, host: "m5dev", capabilities: ["catalog", "handoff"], limits: { requestBytes: 32768, catalogBytes: 262144, bodyBytes: 16384 } }, true);
    else handler(message, peer); });
}

test("peer client owns the exact fixed SSH launch and correlates catalog and handoff", async () => {
  const calls: unknown[][] = [], peer = initializedPeer((message, remote) => {
    if (message.method === "catalog/get") remote.result(message, catalog());
    if (message.method === "handoff") remote.result(message, { accepted: true });
  });
  const client = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(peer, calls) });
  assert.deepEqual(calls[0]?.slice(0, 2), ["/usr/bin/ssh", ["-T", "-x", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "-o", "SendEnv=-*", "-o", "Tunnel=no", "m5dev", "embassy", "peer-stdio"]]);
  const spawnOptions = calls[0]?.[2] as { env: NodeJS.ProcessEnv; shell: boolean; stdio: string[] };
  assert.deepEqual(Object.keys(spawnOptions.env).sort(), ["HOME", "LOGNAME", "SSH_AUTH_SOCK", "USER"].filter((key) => process.env[key] !== undefined));
  assert.deepEqual(spawnOptions, { env: Object.fromEntries(["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    shell: false, stdio: ["pipe", "pipe", "pipe"] });
  assert.deepEqual(client.connectionInfo, { host: "m5dev", protocolVersion: 1 });
  assert.deepEqual(await client.catalog(), catalog());
  const prepared = client.prepareHandoff(handoff()); assert.equal(prepared.bodyBytes, 5); assert.equal(prepared.sha256.length, 64);
  assert.deepEqual(await prepared.perform(), { accepted: true }); assert.throws(() => prepared.cancel(), /already consumed/); client.close();
});

test("peer client exposes only a bounded spawn failure class", async () => {
  await assert.rejects(spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: () => {
    throw new Error("secret process detail");
  } }), (error) => error instanceof PeerConnectionLostError && error.failureClass === "spawn" &&
    !error.message.includes("secret process detail"));
});

test("peer client rejects host drift, unknown inbound requests, uncorrelated replies, and pipe death", async () => {
  const mismatch = new FakePeer((message, peer) => peer.result(message, {
    protocolVersion: 1, host: "wrong", capabilities: ["catalog", "handoff"], limits: { requestBytes: 32768, catalogBytes: 262144, bodyBytes: 16384 } }));
  await assert.rejects(spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(mismatch) }),
    (error) => error instanceof PeerConnectionLostError && error.failureClass === "initialize" && /host mismatch/.test(error.message));
  assert.equal(mismatch.child.killed, true);

  const peer = initializedPeer((message, remote) => { if (message.method === "catalog/get")
    remote.send({ jsonrpc: "2.0", id: 91, method: "invented", params: {} });
    else if (Object.hasOwn(message, "error")) remote.send({ jsonrpc: "2.0", id: 999, result: catalog() }); });
  const client = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(peer) });
  await assert.rejects(client.catalog(), /uncorrelated/); await immediate();
  assert.deepEqual(peer.received.find((row) => Object.hasOwn(row, "error")), { jsonrpc: "2.0", id: 91, error: { code: PEER_METHOD_NOT_FOUND, message: "Method not found" } });

  const dying = initializedPeer((message, remote) => { if (message.method === "handoff") remote.child.emit("exit"); });
  const dyingClient = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(dying) });
  await assert.rejects(dyingClient.prepareHandoff(handoff()).perform(), PeerConnectionLostError);

  const malformed = initializedPeer((message, remote) => { if (message.method === "catalog/get")
    remote.send({ jsonrpc: "2.0", id: message.id, error: { code: "bad", message: "not strict" } }); });
  const malformedClient = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(malformed) });
  await assert.rejects(malformedClient.catalog(), /invalid error response/); assert.equal(malformed.child.killed, true);
});

test("peer client rejects recursive, noncanonical, and duplicate catalog authority", async () => {
  const peer = initializedPeer((message, remote) => { if (message.method === "catalog/get") {
    const bad = catalog(), endpoints = [bad.consentEdges[0]!.endpoints[0], endpoint("codex-main@third", "reg_third")] as const;
    remote.result(message, { ...bad, consentEdges: [{ ref: peerEdgeRef(endpoints), ownerHost: "m5dev", endpoints }] });
  } });
  const client = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(peer) });
  await assert.rejects(client.catalog(), /canonical projection/); assert.equal(peer.child.killed, true);
});

class FakeTimers {
  readonly callbacks = new Map<NodeJS.Timeout, () => void>(); cleared = 0; unrefed = 0;
  readonly setTimeout = ((callback: () => void) => { const timer = { unref: () => { this.unrefed++; } } as unknown as NodeJS.Timeout;
    this.callbacks.set(timer, callback); return timer; }) as typeof setTimeout;
  readonly clearTimeout = ((timer: NodeJS.Timeout) => { if (this.callbacks.delete(timer)) this.cleared++; }) as typeof clearTimeout;
  fire(): void { const entry = this.callbacks.entries().next().value as [NodeJS.Timeout, () => void] | undefined;
    assert.ok(entry); entry[1](); }
}
test("peer request timers are unrefed and cleared on success and timeout", async () => {
  const timers = new FakeTimers(), peer = initializedPeer();
  const client = await spawnPeerClient({ node: "m5dev", localHost: "studio", spawn: spawnFrom(peer), timers });
  assert.equal(timers.unrefed, 1); assert.equal(timers.cleared, 1); assert.equal(timers.callbacks.size, 0);
  const pending = client.catalog(); assert.equal(timers.unrefed, 2); assert.equal(timers.callbacks.size, 1); timers.fire();
  await assert.rejects(pending, /timed out/); assert.equal(timers.cleared, 2); assert.equal(timers.callbacks.size, 0); assert.equal(peer.child.killed, true);
});

test("peer-stdio admits only initialized exact methods and keeps handoff refusal explicit", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = ""; output.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  let catalogCalls = 0; const calls: string[] = []; const session = runPeerStdio({ localHost: "m5dev", input, output, handlers: {
    initialize: ({ host }) => { calls.push(`init:${host}`); }, catalog: () => { catalogCalls++; if (catalogCalls === 2) throw new Error("unexpected"); return catalog(); },
    handoff: () => { throw new PeerHandlerError({ code: -32041, message: "Target unavailable" }); },
  } });
  const send = (message: Rpc): void => { input.write(`${JSON.stringify(message)}\n`); };
  send({ jsonrpc: "2.0", id: 1, method: "catalog/get", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "invented", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: 1, host: "studio" } });
  send({ jsonrpc: "2.0", id: 4, method: "catalog/get", params: {} });
  send({ jsonrpc: "2.0", id: 5, method: "handoff", params: handoff() });
  send({ jsonrpc: "2.0", id: 6, method: "catalog/get", params: {} }); send({ jsonrpc: "2.0", id: 7, method: "catalog/get", params: {} }); input.end(); await session.done; await immediate();
  const frames = text.trim().split("\n").map((line) => JSON.parse(line) as Rpc);
  assert.equal((frames[0]?.error as Rpc).code, -32000); assert.equal((frames[1]?.error as Rpc).code, PEER_METHOD_NOT_FOUND);
  assert.equal((frames[2]?.result as Rpc).host, "m5dev"); assert.deepEqual(frames[3]?.result, catalog());
  assert.deepEqual(frames[4]?.error, { code: -32041, message: "Target unavailable" }); assert.equal((frames[5]?.error as Rpc).code, -32603);
  assert.deepEqual(frames[6]?.result, catalog()); assert.deepEqual(calls, ["init:studio"]);
});

test("peer-stdio closes after an unexpected output failure without writing another response", async () => {
  const input = new PassThrough(), frames: string[] = [], callbacks: ((error?: Error) => void)[] = [];
  const output = { write: (frame: string, callback: (error?: Error) => void) => { frames.push(frame); callbacks.push(callback); return false; } } as unknown as Writable;
  const session = runPeerStdio({ localHost: "m5dev", input, output, handlers: { initialize: () => undefined, catalog, handoff: () => ({ accepted: true }) } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, host: "studio" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "catalog/get", params: {} })}\n`); input.end(); await immediate();
  assert.equal(frames.length, 1); callbacks.shift()?.(new Error("backpressure write failed")); await immediate();
  await session.done; assert.equal(frames.length, 1);
});
