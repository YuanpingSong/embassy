import assert from "node:assert/strict";
import test from "node:test";

import { createLedgerCodec } from "../src/gateway/ledger-codec.js";
import { bodyHash, emptyLedger, ledgerDefaults, type Delivery, type Endpoint, type LedgerState } from "../src/gateway/ledger.js";

const host = "local";
const codec = createLedgerCodec(host, ledgerDefaults);
const endpoint = (id: string, provider: "claude" | "codex", at = host): Endpoint => ({
  id: `reg_${id}`, provider, host: at, alias: `${provider}-${id}@${at}`, handle: `handle-${id}`,
});
const ref = ({ id, host: at, provider }: Endpoint) => ({ id, host: at, provider });
const delivery = (source: Endpoint, target: Endpoint, state: Delivery["state"] = { phase: "queued", tries: 0 }): Delivery => {
  const body = "hello";
  return {
    id: "msg_00000000-0000-4000-8000-000000000001",
    reply: "conv_abcdefghijklmnop",
    token: "dlv_abcdefghijklmnopqrstuvwx",
    source: ref(source), target: ref(target), body, admittedAt: 1_000, deadline: 2_000,
    steer: false, fingerprint: bodyHash(JSON.stringify([ref(source), ref(target), body, false])), state,
  };
};
function valid(): LedgerState {
  const source = endpoint("source", "claude"), target = endpoint("target", "codex");
  return { ...emptyLedger(), commit: { sequence: 1, id: "commit-one" }, endpoints: [source, target],
    deliveries: [delivery(source, target)], retirements: [], rates: [{ source: ref(source), since: 900, count: 1 }] };
}
const decode = (state: unknown): boolean => codec.decode(structuredClone(state)) !== undefined;

test("schema 6 round-trips exact local identities and permits a remote source without a local row", () => {
  const state = valid();
  assert.equal(decode(state), true);
  const remote = endpoint("remote", "claude", "other-host");
  state.deliveries[0] = delivery(remote, state.endpoints[1]!);
  state.rates = [{ source: ref(remote), since: 900, count: 1 }];
  assert.equal(decode(state), true);
  assert.equal(JSON.stringify(codec.decode(state)).includes("handle-remote"), false);
});

test("unknown fields, malformed ids, duplicate native identities, messages, replies and tokens refuse", () => {
  const mutations: Array<(state: LedgerState & Record<string, unknown>) => void> = [
    (state) => { state.extra = true; },
    (state) => { (state.endpoints[0] as { id: string }).id = "lease_source"; },
    (state) => { state.deliveries[0]!.id = "msg_bad"; },
    (state) => { state.deliveries[0]!.reply = "reply_bad"; },
    (state) => { state.deliveries[0]!.token = "token_bad"; },
    (state) => { state.endpoints.push({ ...state.endpoints[0]! }); },
    (state) => { state.endpoints.push({ ...state.endpoints[0]!, id: "reg_other" }); },
    (state) => { state.deliveries.push({ ...state.deliveries[0]!, id: "msg_00000000-0000-4000-8000-000000000002" }); },
    (state) => { state.deliveries.push({ ...state.deliveries[0]!, reply: "conv_abcdefghijklmnopq", id: "msg_00000000-0000-4000-8000-000000000002" }); },
  ];
  for (const mutate of mutations) {
    const state = valid() as LedgerState & Record<string, unknown>;
    mutate(state);
    assert.equal(decode(state), false);
  }
});

test("wrong-host endpoints, unsupported providers and missing live local references refuse nonterminal work", () => {
  for (const mutate of [
    (state: LedgerState) => { (state.endpoints[0] as { host: string }).host = "other-host"; },
    (state: LedgerState) => { (state.endpoints[0] as { provider: string }).provider = "peer"; },
    (state: LedgerState) => { state.deliveries[0]!.source = { ...state.deliveries[0]!.source, id: "reg_missing" }; },
    (state: LedgerState) => { state.deliveries[0]!.target = { ...state.deliveries[0]!.target, provider: "claude" }; },
  ]) {
    const state = valid(); mutate(state); assert.equal(decode(state), false);
  }
  const retired = valid(); retired.deliveries[0]!.state = {
    phase: "terminal", outcome: "cancelled", at: 1_100, code: "ROUTE_UNREGISTERED",
  };
  retired.endpoints = [];
  assert.equal(decode(retired), true);
});

test("delivery phases are closed and prepared batch hashes are collective evidence", () => {
  const state = valid();
  const prepared = { bytes: 100, sha256: "a".repeat(64), bodies: ["b".repeat(64), "c".repeat(64)] };
  for (const phase of [
    { phase: "reserved", attempt: "attempt_one", tries: 1 },
    { phase: "armed", attempt: "attempt_one", tries: 1, prepared },
    { phase: "accepted", attempt: "attempt_one", tries: 1, prepared, loss: "unconfirmed" },
    { phase: "terminal", outcome: "delivered", at: 1_100, code: "TRANSPORT_WRITTEN" },
  ] as Delivery["state"][]) {
    state.deliveries[0]!.state = phase;
    assert.equal(decode(state), true, phase.phase);
  }
  const second = delivery(state.endpoints[0]!, state.endpoints[1]!, {
    phase: "armed", attempt: "attempt_one", tries: 1, prepared,
  });
  second.id = "msg_00000000-0000-4000-8000-000000000002";
  second.reply = "conv_abcdefghijklmnopq";
  second.token = "dlv_bbcdefghijklmnopqrstuvwx";
  second.body = "second";
  second.fingerprint = bodyHash(JSON.stringify([second.source, second.target, second.body, false]));
  state.deliveries[0]!.state = { phase: "armed", attempt: "attempt_one", tries: 1, prepared };
  state.deliveries.push(second);
  assert.equal(decode(state), true);
  second.state = { phase: "armed", attempt: "attempt_one", tries: 1,
    prepared: { ...prepared, sha256: "d".repeat(64) } };
  assert.equal(decode(state), false);
  state.deliveries.pop();
  state.deliveries[0]!.state = { phase: "armed", attempt: "bad", tries: 1, prepared };
  assert.equal(decode(state), false);
  state.deliveries[0]!.state = { phase: "accepted", attempt: "attempt_one", tries: 1, prepared,
    loss: "failed" as "unconfirmed" };
  assert.equal(decode(state), false);
});

test("configured collection, queue-byte, per-target, in-flight, rate and retention bounds refuse loudly", () => {
  const tiny = { ...ledgerDefaults, endpoints: 2, queued: 1, perEndpoint: 1, queueBytes: 5,
    inFlight: 1, retained: 1, retainedBytes: 5, rate: 1 };
  const bounded = createLedgerCodec(host, tiny);
  const state = valid();
  const assertCorrupt = (current: LedgerState) => assert.throws(() => bounded.assertBounds?.(current),
    { code: "CORRUPT_GATEWAY_STATE" });
  state.deliveries.push({ ...state.deliveries[0]!, id: "msg_00000000-0000-4000-8000-000000000002",
    reply: "conv_abcdefghijklmnopq", token: "dlv_bbcdefghijklmnopqrstuvwx" });
  assertCorrupt(state);
  state.deliveries = [state.deliveries[0]!]; state.deliveries[0]!.body = "123456";
  assertCorrupt(state);
  state.deliveries[0]!.state = { phase: "terminal", outcome: "delivered", at: 1_100, code: "TRANSPORT_WRITTEN" };
  assertCorrupt(state);
  state.deliveries[0]!.body = "hello";
  state.retirements = [
    { endpoint: ref(state.endpoints[0]!), alias: state.endpoints[0]!.alias, at: 1_000 },
    { endpoint: ref(state.endpoints[1]!), alias: state.endpoints[1]!.alias, at: 1_000 },
  ];
  assertCorrupt(state);
  state.retirements = []; state.rates[0]!.count = 2;
  assert.equal(bounded.decode(state), undefined);
});

test("body bounds count UTF-8 bytes rather than JavaScript characters", () => {
  const state = valid();
  const narrow = createLedgerCodec(host, { ...ledgerDefaults, bodyBytes: 5 });
  state.deliveries[0]!.body = "€€";
  state.deliveries[0]!.fingerprint = bodyHash(JSON.stringify([
    state.deliveries[0]!.source, state.deliveries[0]!.target, state.deliveries[0]!.body, false,
  ]));
  assert.equal(narrow.decode(state), undefined);
});

test("decoding never normalizes or repairs the supplied document", () => {
  const state = valid();
  const before = JSON.stringify(state);
  assert.equal(codec.decode(state), state);
  assert.equal(JSON.stringify(state), before);
  state.deliveries[0]!.body += "\0";
  const corrupt = JSON.stringify(state);
  assert.equal(codec.decode(state), undefined);
  assert.equal(JSON.stringify(state), corrupt);
});
