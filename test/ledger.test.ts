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
      body, deadline: now + 10_000, steer }).delivery;
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
  restarted.register({ ...endpoint("successor", "claude"), alias: "renamed@local" });
  assert.throws(() => restarted.replyTarget(d.reply, f.target), { code: "ROUTE_UNREGISTERED" });
  assert.throws(() => restarted.replyTarget(d.reply, endpoint("successor", "claude")), { code: "ROUTE_BINDING_MISMATCH" });
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

test("bounded queues, duplicate admission and rates use endpoint identity rather than alias", () => {
  const f = fixture(), first = f.admit("same body");
  f.ledger().register({ ...f.source, alias: "renamed@local" });
  assert.equal(f.admit("same body").id, first.id);
  assert.equal(f.state.rates[0]?.count, 1);
  for (let i = 1; i < ledgerDefaults.perEndpoint; i++) f.admit();
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
