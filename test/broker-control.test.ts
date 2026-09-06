import assert from "node:assert/strict";
import test from "node:test";

import { isBrokerResult, parseBrokerCommand, type BrokerCommand } from "../src/gateway/broker-control.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const endpoint = { id: "reg_public", host: "local", provider: "codex", alias: "codex-main@local" } as const;
const conversationId = "conv_abcdefghijklmnop";
const deliveryToken = "dlv_abcdefghijklmnopqrstuvwx";
const now = "2026-09-05T12:00:00.000Z";
const handoff = { target: endpoint, messages: [] };

const commands: readonly unknown[] = [
  { method: "health", params: {} }, { method: "list_snapshot", params: {} },
  { method: "refresh_discovery", params: {} }, { method: "check", params: {} },
  { method: "register_codex", params: { caller: { kind: "codex", handle: uuid }, alias: endpoint.alias } },
  { method: "send", params: { caller: { kind: "codex", handle: uuid }, body: "hello", to: endpoint.alias } },
  { method: "send", params: { caller: { kind: "codex", handle: uuid }, body: "reply", conversation: conversationId } },
  { method: "retire_route", params: { alias: endpoint.alias } },
  { method: "retire_route", params: { endpoint: endpoint.id } },
  { method: "delivery_status", params: { token: deliveryToken } },
  { method: "peer_catalog", params: { node: "remote" } },
  { method: "peer_resolve", params: { node: "remote", selector: { id: endpoint.id, host: endpoint.host, provider: endpoint.provider } } },
  { method: "peer_handoff", params: { node: "remote", handoff } },
];

test("broker commands are a closed semantic union", () => {
  for (const candidate of commands) {
    assert.deepEqual(parseBrokerCommand(candidate, (value) => value === handoff), candidate);
    assert.throws(() => parseBrokerCommand({ ...(candidate as object), extra: true }, () => true), { code: "INVALID_REQUEST" });
    const command = candidate as { method: string; params: Record<string, unknown> };
    assert.throws(() => parseBrokerCommand({ ...command, params: { ...command.params, extra: true } }, () => true),
      { code: "INVALID_REQUEST" });
  }
  for (const invalid of [
    { method: "retire_route", params: { alias: endpoint.alias, endpoint: endpoint.id } },
    { method: "send", params: { caller: { kind: "codex", handle: uuid }, body: " \n ", to: endpoint.alias } },
    { method: "send", params: { caller: { kind: "codex", handle: uuid }, body: "x", to: endpoint.alias, conversation: conversationId } },
    { method: "send", params: { caller: { kind: "claude", address: "relative.sock" }, body: "x", to: endpoint.alias } },
    { method: "register_codex", params: { caller: { kind: "claude", address: "uds:/tmp/x" }, alias: endpoint.alias } },
    { method: "peer_resolve", params: { node: "remote", selector: { ...endpoint, handle: uuid } } },
  ]) assert.throws(() => parseBrokerCommand(invalid, () => true), { code: "INVALID_REQUEST" });
});

const snapshot = { health: "healthy", revision: 1, routes: [{ ...endpoint, queueDepth: 0 }],
  messages: [{ source: "codex-main@local", target: "claude-main@local", state: "delivered", ageMs: 1,
    safeErrorCode: "TRANSPORT_WRITTEN" }], retirements: [{ alias: endpoint.alias, at: now }] };
const results: ReadonlyArray<readonly [BrokerCommand["method"], unknown]> = [
  ["health", { status: "healthy" }], ["check", { status: "ok", scope: "broker-loopback" }],
  ["register_codex", endpoint], ["send", { accepted: true, conversationId, deliveryToken }],
  ["retire_route", { cancelled: 1, ambiguous: 0, unconfirmed: 0 }],
  ["refresh_discovery", { routes: [endpoint] }], ["peer_catalog", [endpoint]], ["peer_resolve", endpoint], ["peer_resolve", null],
  ["peer_handoff", { accepted: true }], ["peer_handoff", { accepted: false, code: "QUEUE_FULL" }],
  ["delivery_status", { found: false }],
  ["delivery_status", { found: true, state: "queued", terminal: false, deadlineAt: now, pendingForMs: 1 }],
  ...["reserved", "armed", "accepted"].map((state) => ["delivery_status", { found: true, state, terminal: false, deadlineAt: now, pendingForMs: 1 }] as const),
  ["delivery_status", { found: true, state: "delivered", terminal: true, deadlineAt: now,
    safeErrorCode: "TRANSPORT_WRITTEN" }], ["list_snapshot", snapshot],
];

test("broker results are bounded, disclosure-free and reject duplicate endpoint rows", () => {
  for (const [method, result] of results) {
    assert.equal(isBrokerResult(method, result), true, method);
    if (!Array.isArray(result) && result !== null && typeof result === "object") {
      assert.equal(isBrokerResult(method, { ...result, privateHandle: uuid }), false, `${method}/extra`);
    }
  }
  for (const [method, leaked] of [
    ["register_codex", { ...endpoint, handle: uuid }],
    ["refresh_discovery", { routes: [{ ...endpoint, handle: uuid }] }],
    ["peer_catalog", [{ ...endpoint, handle: uuid }]], ["peer_resolve", { ...endpoint, handle: uuid }],
    ["list_snapshot", { ...snapshot, messages: [{ ...snapshot.messages[0], body: "secret", deliveryToken }] }],
  ] as const) assert.equal(isBrokerResult(method, leaked), false, `${method}/leak`);
  for (const [method, invalid] of [
    ["health", { status: "offline" }], ["check", { status: "ok", scope: "provider" }],
    ["send", { accepted: false, code: "QUEUE_FULL" }],
    ["retire_route", { cancelled: -1, ambiguous: 0, unconfirmed: 0 }],
    ["peer_handoff", { accepted: false, code: "lowercase" }],
    ["delivery_status", { found: true, state: "queued", terminal: true, deadlineAt: now }],
    ["list_snapshot", { ...snapshot, revision: -1 }],
  ] as const) assert.equal(isBrokerResult(method, invalid), false, `${method}/semantics`);
  for (const collision of [{ ...endpoint }, { ...endpoint, alias: "codex-other@local" }]) {
    assert.equal(isBrokerResult("peer_catalog", [endpoint, collision]), false);
    assert.equal(isBrokerResult("refresh_discovery", { routes: [endpoint, collision] }), false);
    assert.equal(isBrokerResult("list_snapshot", { ...snapshot,
      routes: [snapshot.routes[0], { ...collision, queueDepth: 0 }] }), false);
  }
  const aliasTwin = { ...endpoint, id: "reg_other" };
  assert.equal(isBrokerResult("peer_catalog", [endpoint, aliasTwin]), true);
  assert.equal(isBrokerResult("refresh_discovery", { routes: [endpoint, aliasTwin] }), true);
  assert.equal(isBrokerResult("list_snapshot", { ...snapshot,
    routes: [snapshot.routes[0], { ...aliasTwin, queueDepth: 0 }] }), true);
});

test("Codex metadata is closed, bounded and cannot expose native identities through status or federation", () => {
  const codex = { state: "waiting" };
  const observed = { complete: true, truncated: false, observedAt: now };
  const project = (metadata: unknown, observation: unknown = observed) => ({ ...snapshot, codex: observation,
    routes: [{ ...snapshot.routes[0], codex: metadata }] });
  assert.equal(isBrokerResult("list_snapshot", project(codex)), true);
  for (const invalid of [{ ...codex, threadId: uuid }, { ...codex, parentEndpoint: uuid },
    { ...codex, state: "ready" }, { ...codex, canAcceptDirectInput: "yes" }, { ...codex, preview: "private" }])
    assert.equal(isBrokerResult("list_snapshot", project(invalid)), false);
  for (const observation of [{ ...observed, threads: [] }, { ...observed, observedAt: "yesterday" },
    { ...observed, safeErrorCode: "native error text" }, { ...observed, truncated: 1 }])
    assert.equal(isBrokerResult("list_snapshot", project(codex, observation)), false);
  assert.equal(isBrokerResult("peer_catalog", [{ ...endpoint, codex }]), false);
  assert.equal(isBrokerResult("list_snapshot", { ...project(codex), routes: [
    { ...snapshot.routes[0], provider: "claude", codex } ] }), false);
});
