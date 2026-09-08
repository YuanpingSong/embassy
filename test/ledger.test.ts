import assert from "node:assert/strict";
import test from "node:test";
import { Ledger, bodyHash, emptyLedger, ledgerDefaults, type Endpoint, type PreparedWake } from "../src/gateway/ledger.js";

const endpoint = (id: string, provider: "claude" | "codex", host = "local"): Endpoint =>
  ({ id, provider, host, alias: `${provider}-${id}@${host}`, handle: `private-${id}` });
function fixture() {
  const state = emptyLedger();
  let now = 1_000;
  let sequence = 0;
  const ledger = () => new Ledger(state, "local", ledgerDefaults, now);
  const source = endpoint("source", "claude"), target = endpoint("target", "codex");
  ledger().register(source); ledger().register(target);
  const admit = (body = `message ${++sequence}`, from = source, to = target, steer = false) => {
    const id = String(++sequence);
    return ledger().admit({ id, reply: `reply-${id}`, token: `token-${id}`, source: from, target: to,
      body, deadline: now + 10_000, steer, ...(from.host === "local" ? {} : { sourceAlias: from.alias }) }).delivery;
  };
  const prepare = (bodies: string[]): PreparedWake => ({ bytes: bodies.join("\n").length + 100, sha256: bodyHash(bodies.join("\n")), bodies: bodies.map(bodyHash) });
  return { state, ledger, source, target, admit, prepare, advance: (ms: number) => { now += ms; } };
}

// SECURITY: input ownership/correlation, honest provenance, and anti-runaway bounds.
test("ledger accepts all four provider pairs, local and exact remote endpoints", () => {
  for (const a of ["claude", "codex"] as const) for (const b of ["claude", "codex"] as const) {
    for (const sourceHost of ["local", "remote"]) for (const targetHost of ["local", "remote"]) {
      const f = fixture(), source = endpoint("a", a, sourceHost), target = endpoint("b", b, targetHost);
      if (sourceHost === "local") f.ledger().register(source);
      if (targetHost === "local") f.ledger().register(target);
      if (sourceHost !== "local" && targetHost !== "local") {
        assert.throws(() => f.admit("hello", source, target), { code: "INVALID_PEER_HANDOFF" });
        continue;
      }
      const d = f.admit("hello", source, target);
      assert.deepEqual(d.source, { id: "a", host: sourceHost, provider: a });
      assert.deepEqual(d.target, { id: "b", host: targetHost, provider: b });
      assert.equal(d.state.phase, "queued");
    }
  }
});

test("rename changes one endpoint only; queued authority and durable replies stay identity-bound", () => {
  const f = fixture(), d = f.admit();
  const before = JSON.stringify(f.state.deliveries);
  f.ledger().register({ ...f.source, alias: "renamed@local" });
  assert.equal(JSON.stringify(f.state.deliveries), before);
  assert.equal(f.ledger().resolve(f.source.alias), undefined);
  assert.equal(f.ledger().resolve("renamed@local")?.id, f.source.id);
  const restarted = new Ledger(JSON.parse(JSON.stringify(f.state)), "local", ledgerDefaults, 1_001);
  restarted.restart();
  assert.deepEqual(restarted.replyTarget(d.reply, f.target), d.source);
  assert.throws(() => restarted.replyTarget(d.reply, endpoint("stranger", "claude")), /refused/);
  restarted.retire(f.source);
  restarted.register({ ...endpoint("successor", "claude"), alias: "renamed@local", handle: f.source.handle });
  assert.throws(() => restarted.replyTarget(d.reply, f.target), { code: "ROUTE_UNREGISTERED" });
  assert.throws(() => restarted.replyTarget(d.reply, endpoint("successor", "claude")), { code: "ROUTE_BINDING_MISMATCH" });
});

test("Claude retirement fences one endpoint while Codex retirement fences its native identity", () => {
  const f = fixture();
  f.ledger().retire(f.source);
  assert.throws(() => f.ledger().register(f.source), { code: "ROUTE_UNREGISTERED" });
  const returningClaude = { ...endpoint("returning", "claude"), handle: f.source.handle };
  assert.doesNotThrow(() => f.ledger().register(returningClaude));
  assert.equal(f.ledger().endpoint(f.source), undefined);
  assert.deepEqual(f.ledger().endpoint(returningClaude), returningClaude);

  f.ledger().retire(f.target);
  const returningCodex = { ...endpoint("returning-codex", "codex"), handle: f.target.handle };
  assert.throws(() => f.ledger().register(returningCodex), { code: "ROUTE_UNREGISTERED" });
});

test("duplicate display names are unresolvable without hiding either exact identity", () => {
  const f = fixture(), other = { ...endpoint("other", "claude"), alias: f.source.alias };
  f.ledger().register(other);
  assert.throws(() => f.ledger().resolve(f.source.alias), { code: "PEER_ALIAS_COLLISION" });
  assert.equal(f.ledger().endpoint(f.source)?.handle, f.source.handle);
  assert.equal(f.ledger().endpoint(other)?.handle, other.handle);
  const d = f.admit("identity-bound");
  assert.deepEqual(f.ledger().replyTarget(d.reply, f.target), d.source);
  f.ledger().register({ ...other, alias: "unique@local" });
  assert.equal(f.ledger().resolve(f.source.alias)?.id, f.source.id);
});

test("one reservation captures the complete eligible backlog, not one message per idle window", () => {
  const f = fixture();
  const queued = Array.from({ length: ledgerDefaults.perEndpoint }, () => f.admit());
  const batch = f.ledger().reserve(f.target, "wake");
  assert.deepEqual(batch.map((d) => d.id), queued.map((d) => d.id));
  assert.equal(f.ledger().reserve(f.target, "second").length, 0);
  const ids = batch.map((d) => d.id);
  assert.equal(f.ledger().authorize(ids, "wake", f.prepare(batch.map((d) => d.body))), true);
  assert.equal(f.ledger().accept(ids, "wake", "unconfirmed"), true);
  assert.equal(f.ledger().settle(ids, "wake", "delivered", "TRANSPORT_WRITTEN"), true);
  assert.equal(f.state.deliveries.filter((d) => d.state.phase !== "terminal").length, 0);
  assert.equal(f.ledger().settle(ids, "wake", "failed", "LATE_CALLBACK"), false);
});

test("late arrival cannot join an already prepared wake; STEER is a separate exact-operation reservation", () => {
  const f = fixture(), first = f.admit();
  const batch = f.ledger().reserve(f.target, "ordinary");
  const later = f.admit(), steer = f.admit("STEER: update", f.source, f.target, true);
  assert.equal(batch.length, 1);
  assert.equal(f.ledger().authorize([first.id], "ordinary", f.prepare([first.body])), true);
  assert.equal(f.ledger().accept([first.id], "ordinary", "unconfirmed"), true);
  assert.deepEqual(f.ledger().reserve(f.target, "steer", true).map((d) => d.id), [steer.id]);
  assert.equal(later.state.phase, "queued");
  assert.equal(f.ledger().defer([first.id], "ordinary"), false);
});

test("restart, expiry, retirement and transport loss preserve the write-phase law", () => {
  for (const phase of ["queued", "reserved", "armed", "accepted"] as const) {
    for (const event of ["restart", "expire", "retire", "lose"] as const) {
      const f = fixture(), d = f.admit();
      if (phase !== "queued") f.ledger().reserve(f.target, "a");
      if (phase === "armed" || phase === "accepted") f.ledger().authorize([d.id], "a", f.prepare([d.body]));
      if (phase === "accepted") f.ledger().accept([d.id], "a", "unconfirmed");
      if (event === "restart") f.ledger().restart();
      if (event === "expire") { f.advance(10_001); f.ledger().expire(); }
      if (event === "retire") f.ledger().retire(f.target);
      if (event === "lose") f.ledger().lose([d.id], "a", "CONNECTION_LOST");
      const expected = phase === "armed" ? "ambiguous" : phase === "accepted" ? "unconfirmed"
        : event === "retire" ? "cancelled" : event === "expire" ? "expired" : "queued";
      assert.equal(d.state.phase === "terminal" ? d.state.outcome : d.state.phase, expected, `${phase}/${event}`);
      if (expected !== "queued") {
        const bytes = JSON.stringify(d);
        assert.equal(f.ledger().accept([d.id], "a", "unconfirmed"), false);
        assert.equal(f.ledger().defer([d.id], "a"), false);
        assert.equal(JSON.stringify(d), bytes);
      }
    }
  }
});

test("wrong attempt, wrong body evidence, removed identity and retired mirror refuse without mutation", () => {
  const f = fixture(), d = f.admit();
  f.ledger().reserve(f.target, "a");
  const before = JSON.stringify(f.state);
  assert.equal(f.ledger().authorize([d.id], "other", f.prepare([d.body])), false);
  assert.throws(() => f.ledger().authorize([d.id], "a", f.prepare(["wrong"])), { code: "INVALID_PREPARED_WRITE_EVIDENCE" });
  assert.throws(() => f.ledger().retire(endpoint("remote", "codex", "remote")), { code: "FEDERATED_ROUTE_READ_ONLY" });
  assert.throws(() => f.ledger().register({ ...f.target, handle: "different" }), { code: "ROUTE_BINDING_MISMATCH" });
  assert.equal(JSON.stringify(f.state), before);
  f.ledger().retire(f.source);
  assert.equal(f.ledger().authorize([d.id], "a", f.prepare([d.body])), false);
});

test("bounded queues and explicit duplicate requests use endpoint identity rather than alias or body", () => {
  const f = fixture(), first = f.admit("same body");
  f.ledger().register({ ...f.source, alias: "renamed@local" });
  const { state: _state, admittedAt: _at, ...retry } = first;
  assert.equal(f.ledger().admit(retry).delivery.id, first.id);
  assert.notEqual(f.admit("same body").id, first.id);
  assert.equal(f.state.rates[0]?.count, 2);
  for (let i = 2; i < ledgerDefaults.perEndpoint; i++) f.admit();
  const before = JSON.stringify(f.state);
  assert.throws(() => f.admit(), { code: "QUEUE_FULL" });
  assert.equal(JSON.stringify(f.state), before);
  assert.throws(() => f.admit("STEER: wrong", f.target, f.source, true), { code: "INVALID_MESSAGE_BODY" });
});

test("expired reply relationships disappear under bounded retention; active bodies never evict", () => {
  const f = fixture(), terminal = f.admit();
  f.ledger().reserve(f.target, "a");
  f.ledger().settle([terminal.id], "a", "failed", "PREWRITE_REFUSED");
  f.advance(ledgerDefaults.retentionMs + 1);
  const pending = f.admit("new");
  assert.throws(() => f.ledger().replyTarget(terminal.reply, f.target), { code: "CONVERSATION_NOT_FOUND" });
  assert.deepEqual(f.state.deliveries.map((d) => d.id), [pending.id]);
});

test("a shared wake settles surviving sources after another source is retired", () => {
  const f = fixture(), other = endpoint("other", "claude");
  f.ledger().register(other);
  const first = f.admit(), second = f.admit("other source", other);
  const batch = f.ledger().reserve(f.target, "one-wake"), ids = batch.map((d) => d.id);
  assert.equal(f.ledger().authorize(ids, "one-wake", f.prepare(batch.map((d) => d.body))), true);
  f.ledger().retire(f.source);
  assert.equal(f.ledger().accept(ids, "one-wake", "unconfirmed"), true);
  assert.equal(f.ledger().settle(ids, "one-wake", "delivered", "TRANSPORT_WRITTEN"), true);
  assert.equal(first.state.phase === "terminal" && first.state.outcome, "ambiguous");
  assert.equal(second.state.phase === "terminal" && second.state.outcome, "delivered");
});

test("retained count and bytes never prevent settlement; queued STEER is capped at three", () => {
  const f = fixture();
  const ledger = () => new Ledger(f.state, "local", { ...ledgerDefaults, retained: 1, retainedBytes: 64 }, 1_000);
  for (let i = 0; i < 3; i++) {
    const d = f.admit(`body ${i}`);
    ledger().reserve(f.target, `wake-${i}`);
    ledger().settle([d.id], `wake-${i}`, "failed", "PREWRITE_REFUSED");
    assert.equal(f.state.deliveries.length, 1);
  }
  for (let i = 0; i < 3; i++) f.admit(`STEER: ${i}`, f.source, f.target, true);
  assert.throws(() => f.admit("STEER: four", f.source, f.target, true), { code: "QUEUE_FULL" });
});

test("receipt retention ranks late completions by settlement, not admission", () => {
  const f = fixture(), other = endpoint("other", "codex");
  f.ledger().register(other);
  const earlier = f.admit("slow"), later = f.admit("fast", f.source, other);
  const ledger = () => new Ledger(f.state, "local", { ...ledgerDefaults, retained: 1 }, 1_000);
  ledger().reserve(f.target, "slow"); ledger().reserve(other, "fast");
  ledger().settle([later.id], "fast", "failed", "PREWRITE_REFUSED");
  ledger().settle([earlier.id], "slow", "failed", "PREWRITE_REFUSED");
  assert.deepEqual(f.state.deliveries.map((d) => d.id), [earlier.id]);
});

test("an explicit delivery id cannot change its reply or authenticated remote alias", () => {
  const f = fixture(), local = f.admit("local");
  const { state: _localState, admittedAt: _localAt, ...localReplay } = local;
  let before = JSON.stringify(f.state);
  assert.throws(() => f.ledger().admit({ ...localReplay, reply: "another-reply" }), { code: "INVALID_PEER_HANDOFF" });
  assert.equal(JSON.stringify(f.state), before);

  const remote = endpoint("remote", "claude", "remote"), delivery = f.admit("remote", remote, f.target);
  const { state: _remoteState, admittedAt: _remoteAt, ...remoteReplay } = delivery;
  before = JSON.stringify(f.state);
  assert.throws(() => f.ledger().admit({ ...remoteReplay, sourceAlias: "impostor@remote" }),
    { code: "INVALID_PEER_HANDOFF" });
  assert.equal(JSON.stringify(f.state), before);
});

test("admission refuses a raw-small body whose escaped provenance frame cannot fit one wake", () => {
  assert.doesNotThrow(() => fixture().admit("x".repeat(ledgerDefaults.bodyBytes)));
  const f = fixture();
  const before = JSON.stringify(f.state);
  assert.throws(() => f.admit("\u0001".repeat(12_000)), { code: "INVALID_MESSAGE_BODY" });
  assert.equal(JSON.stringify(f.state), before);
});

test("body pruning keeps the bounded receipt, reply identity, and exact duplicate evidence", () => {
  const f = fixture(), delivery = f.admit("receipt body");
  const { state: _state, admittedAt: _admittedAt, ...replay } = structuredClone(delivery);
  const ledger = () => new Ledger(f.state, "local", { ...ledgerDefaults, retainedBytes: 1 }, 1_000);
  ledger().reserve(f.target, "receipt");
  ledger().authorize([delivery.id], "receipt", f.prepare([delivery.body]));
  ledger().settle([delivery.id], "receipt", "delivered", "TRANSPORT_WRITTEN");
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(f.state.deliveries[0]?.body, "");
  assert.equal(f.state.deliveries[0]?.bodyHash, bodyHash("receipt body"));
  assert.deepEqual(ledger().replyTarget(delivery.reply, f.target), delivery.source);
  assert.equal(ledger().admit(replay).duplicate, true);
  assert.throws(() => ledger().admit({ ...replay, body: "different" }), { code: "INVALID_PEER_HANDOFF" });
});

test("retirement evidence is bounded independently from receipt count", () => {
  const f = fixture(), ledger = () => new Ledger(f.state, "local", { ...ledgerDefaults, retained: 1 }, 1_000);
  ledger().retire(f.source);
  ledger().retire(f.target);
  assert.equal(f.state.retirements.length, 2);
});

test("rate capacity is partitioned per source host and a peer cannot exhaust local admission", () => {
  const f = fixture();
  const limits = { ...ledgerDefaults, endpoints: 2, queued: 100, perEndpoint: 100, retained: 2, rate: 100 };
  const ledger = () => new Ledger(f.state, "local", limits, 1_000);
  for (let i = 0; i < 2; i++) ledger().admit({ id: `remote-${i}`, reply: `reply-${i}`, token: `token-${i}`,
    source: endpoint(`remote-${i}`, "claude", "peer"), target: f.target,
    sourceAlias: `remote-${i}@peer`, body: `remote ${i}`, deadline: 2_000, steer: false });
  const before = JSON.stringify(f.state);
  assert.throws(() => ledger().admit({ id: "remote-over", reply: "reply-over", token: "token-over",
    source: endpoint("remote-over", "claude", "peer"), target: f.target, sourceAlias: "remote-over@peer",
    body: "remote over", deadline: 2_000, steer: false }), { code: "RATE_LIMITED" });
  assert.equal(JSON.stringify(f.state), before);
  assert.doesNotThrow(() => ledger().admit({ id: "local-after-peer", reply: "reply-local", token: "token-local",
    source: f.source, target: f.target, body: "local", deadline: 2_000, steer: false }));
});

test("rate partitions admit at most the local host plus 32 peer hosts", () => {
  const f = fixture();
  const limits = { ...ledgerDefaults, queued: 100, perEndpoint: 100, retained: 100, rate: 100 };
  const ledger = () => new Ledger(f.state, "local", limits, 1_000);
  ledger().admit({ id: "local", reply: "reply-local", token: "token-local", source: f.source,
    target: f.target, body: "local", deadline: 2_000, steer: false });
  for (let i = 0; i < 32; i++) ledger().admit({ id: `remote-${i}`, reply: `reply-${i}`, token: `token-${i}`,
    source: endpoint(`remote-${i}`, "claude", `peer-${i}`), target: f.target, sourceAlias: `remote-${i}@peer-${i}`,
    body: `remote ${i}`, deadline: 2_000, steer: false });
  const before = JSON.stringify(f.state);
  assert.throws(() => ledger().admit({ id: "remote-over", reply: "reply-over", token: "token-over",
    source: endpoint("remote-over", "claude", "peer-over"), target: f.target, sourceAlias: "remote-over@peer-over",
    body: "remote over", deadline: 2_000, steer: false }), { code: "RATE_LIMITED" });
  assert.equal(JSON.stringify(f.state), before);
});
