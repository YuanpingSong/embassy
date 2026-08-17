import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  LocalPeerMailboxProvider,
  isPeerMailboxAwaitResult,
  type PeerMailboxAwaitInput,
} from "../src/gateway/peer-mailbox.js";
import { composeProvenanceEnvelope } from "../src/gateway/provenance-envelope.js";
import type { GatewayAdapterDispatchInput } from "../src/gateway/service.js";

const binding = Object.freeze({
  alias: "peer-main@this-mac",
  routeHandle: `peer:${"a".repeat(64)}`,
  registrationId: "peer_registration_1",
});
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture(receiptTimeoutMs?: number) {
  let receipt = 0;
  const adapter = new LocalPeerMailboxProvider({
    hostId: "this-mac",
    awaitTimeoutMs: 50,
    ...(receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs }),
    createReceipt: () => `prc_${String(++receipt).padStart(24, "A")}`,
  });
  adapter.observeLogicalRoute(binding);
  const events: string[] = [];
  let evidence: Parameters<GatewayAdapterDispatchInput["authorizeWrite"]>[0] | undefined;
  const input: GatewayAdapterDispatchInput = {
    attemptId: "attempt_peer_1",
    sourceAlias: "codex-main@this-mac",
    sourceProvider: "codex",
    targetAlias: binding.alias,
    conversationId: "conv_0123456789abcdef",
    binding: { provider: "peer", hostId: "this-mac", ...binding },
    authorization: "selected_route",
    messageId: "msg_00000000-0000-7000-8000-000000000001",
    text: "hello peer",
    expectsReply: true,
    deadlineAt: "2030-01-01T00:00:00.000Z",
    authorizeWrite: async (value) => { events.push("authorize"); evidence = value; return true; },
    onAccepted: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); events.push("accepted"); },
  };
  return { adapter, input, events, get evidence() { return evidence; } };
}

test("peer mailbox prepares one exact frame, authorizes before exposure, and settles only on exact receipt", async () => {
  const item = fixture();
  assert.deepEqual(item.adapter.identity, { provider: "peer", hostId: "this-mac" });
  assert.equal(item.adapter.protocol, "peer-mailbox");
  assert.equal(item.adapter.protocolVersion, "1");
  assert.deepEqual(await item.adapter.initialize(), { health: "healthy" });

  const awaiting = item.adapter.awaitMessage(binding).then((value) => {
    item.events.push("exposed");
    return value;
  });
  const dispatching = item.adapter.dispatch(item.input);
  const delivery = await awaiting;
  assert.equal(delivery.state, "message");
  if (delivery.state !== "message") return;
  assert.equal(isPeerMailboxAwaitResult(delivery), true);
  const text = composeProvenanceEnvelope({
    sourceProvider: "codex", recipientProvider: "peer",
    sourceAlias: item.input.sourceAlias, targetAlias: item.input.targetAlias,
    conversationId: item.input.conversationId, body: item.input.text,
  });
  const frame = `${JSON.stringify({ ok: true, command: "await", result: {
    fromAlias: item.input.sourceAlias, toAlias: item.input.targetAlias,
    conversationId: item.input.conversationId, text, expectsReply: true,
  } })}\n`;
  assert.equal(delivery.frame, frame);
  assert.deepEqual(item.evidence, {
    attemptId: item.input.attemptId, kind: "peer_mailbox",
    bodyBytes: Buffer.byteLength(item.input.text), bodySha256: digest(item.input.text),
    frameBytes: Buffer.byteLength(frame), sha256: digest(frame),
  });
  assert.deepEqual(item.events, ["authorize", "exposed"]);
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, alias: "peer-other@this-mac", receipt: delivery.receipt }), "rejected");
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: delivery.receipt }), "acknowledged");
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: delivery.receipt }), "duplicate");
  assert.deepEqual(await dispatching, { state: "delivered" });
  assert.deepEqual(item.events, ["authorize", "exposed", "accepted"]);

  const nextAwait = item.adapter.awaitMessage(binding);
  const nextDispatch = item.adapter.dispatch({ ...item.input, attemptId: "attempt_peer_2" });
  const next = await nextAwait;
  assert.equal(next.state, "message");
  if (next.state !== "message") return;
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: next.receipt }), "acknowledged");
  assert.deepEqual(await nextDispatch, { state: "delivered" });
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: delivery.receipt }), "rejected");
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: next.receipt }), "duplicate");
  item.adapter.forgetLogicalRoute(binding.registrationId);
  assert.equal(item.adapter.acknowledgeReceipt({ ...binding, receipt: next.receipt }), "rejected");
  await item.adapter.close();
});

test("no waiter and denied authorization are provably zero-write", async () => {
  const item = fixture();
  let authorizations = 0;
  assert.deepEqual(await item.adapter.dispatch({
    ...item.input, authorizeWrite: async () => { authorizations += 1; return true; },
  }), { state: "deferred", safeErrorCode: "PEER_NOT_AWAITING" });
  assert.equal(authorizations, 0);

  const awaiting = item.adapter.awaitMessage(binding);
  assert.deepEqual(await item.adapter.dispatch({
    ...item.input, authorizeWrite: async () => false,
  }), { state: "failed", safeErrorCode: "WRITE_AUTHORIZATION_DENIED" });
  await item.adapter.close();
  assert.deepEqual(await awaiting, { state: "timeout" });
});

test("accepted mail without a receipt is unconfirmed; pre-accepted uncertainty is ambiguous", async () => {
  const missing = fixture();
  const awaiting = missing.adapter.awaitMessage(binding);
  const dispatching = missing.adapter.dispatch({ ...missing.input, deadlineAt: new Date(Date.now() + 2).toISOString() });
  assert.equal((await awaiting).state, "message");
  assert.deepEqual(await dispatching, { state: "unconfirmed", safeErrorCode: "DELIVERY_UNCONFIRMED" });
  await missing.adapter.close();

  const uncertain = fixture();
  const uncertainAwait = uncertain.adapter.awaitMessage(binding);
  const uncertainDispatch = uncertain.adapter.dispatch({
    ...uncertain.input, onAccepted: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); throw new Error("synthetic commit uncertainty"); },
  });
  const exposed = await uncertainAwait;
  assert.equal(exposed.state, "message");
  if (exposed.state === "message") assert.equal(uncertain.adapter.acknowledgeReceipt({ ...binding, receipt: exposed.receipt }), "acknowledged");
  assert.deepEqual(await uncertainDispatch, { state: "ambiguous", safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" });
  if (exposed.state === "message") assert.equal(uncertain.adapter.acknowledgeReceipt({ ...binding, receipt: exposed.receipt }), "rejected");
  await uncertain.adapter.close();
});

test("route drift after arming is fenced and forget cancels the waiter", async () => {
  const item = fixture();
  const awaiting = item.adapter.awaitMessage(binding);
  assert.deepEqual(await item.adapter.dispatch({
    ...item.input,
    authorizeWrite: async () => { item.adapter.forgetLogicalRoute(binding.registrationId); return true; },
  }), { state: "ambiguous", safeErrorCode: "DISPATCH_OUTCOME_AMBIGUOUS" });
  assert.deepEqual(await awaiting, { state: "timeout" });
  await item.adapter.close();
});

test("await enforces exact binding, one waiter per registration, and sixteen globally", async () => {
  const item = fixture();
  await assert.rejects(item.adapter.awaitMessage({ ...binding, routeHandle: "peer:foreign" }), (error: any) => error.code === "ROUTE_UNREGISTERED");
  const waits: Promise<unknown>[] = [item.adapter.awaitMessage(binding)];
  await assert.rejects(item.adapter.awaitMessage(binding), (error: any) => error.code === "ROUTE_BUSY");
  for (let index = 2; index <= 17; index += 1) {
    const route: PeerMailboxAwaitInput = {
      alias: `peer-${index}@this-mac`, routeHandle: `peer:${String(index).padStart(64, "b")}`,
      registrationId: `peer_registration_${index}`,
    };
    item.adapter.observeLogicalRoute(route);
    if (index <= 16) waits.push(item.adapter.awaitMessage(route));
    else await assert.rejects(item.adapter.awaitMessage(route), (error: any) => error.code === "ROUTE_CAPACITY_REACHED");
  }
  await item.adapter.close();
  assert.deepEqual(await Promise.all(waits), Array.from({ length: 16 }, () => ({ state: "timeout" })));
});

test("strict await-result decoder rejects malformed, noncanonical, and leaked receipt shapes", () => {
  assert.equal(isPeerMailboxAwaitResult({ state: "timeout", extra: true }), false);
  assert.equal(isPeerMailboxAwaitResult({ state: "message", frame: "{}\n", receipt: `prc_${"A".repeat(24)}` }), false);
  const result = { fromAlias: "codex-main@this-mac", toAlias: "peer-main@this-mac", conversationId: "conv_0123456789abcdef", text: "d", expectsReply: false };
  const candidate = (current: unknown) => ({ state: "message", frame: `${JSON.stringify({ ok: true, command: "await", result: current })}\n`, receipt: `prc_${"A".repeat(24)}` });
  assert.equal(isPeerMailboxAwaitResult(candidate(result)), true);
  assert.equal(isPeerMailboxAwaitResult(candidate({ ...result, fromAlias: "invalid" })), false);
  assert.equal(isPeerMailboxAwaitResult(candidate({ ...result, toAlias: "codex-peer@this-mac" })), false);
  assert.equal(isPeerMailboxAwaitResult(candidate({ ...result, conversationId: "conv_short" })), false);
  assert.equal(isPeerMailboxAwaitResult(candidate({ ...result, text: "x".repeat(64 * 1024 + 1) })), false);
  assert.equal(isPeerMailboxAwaitResult({ ...candidate(result), frame: `${candidate(result).frame}\n` }), false);
});
