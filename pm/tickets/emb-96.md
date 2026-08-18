---
id: emb-96
title: Alias-collision is invisible to the operator — dead copy and an undifferentiated refusal
kind: normal
size: 1
status: queued
release: unassigned
updated: 2026-08-18
---

## Binding

**Status is QUEUED, not dispatched.** Founder hold stops the wave after
emb-93. Do not start this without a fresh dispatch.

**Why**: from emb-94's adversarial review (F10), deliberately kept out
of that slice to protect its budget, and out of emb-95 because emb-95
had already frozen coherently on transport classification.

Two halves of one gap:
1. `decisionFor` (service.ts:269-287) maps `CLAUDE_ROUTE_NOT_FOUND` to
   `{accepted:false, code:"not_found"}`, so three states that require
   three DIFFERENT operator actions are byte-identical over the wire:
   the session exited, the name is wrong, and two live sessions share
   the name (emb-94's fence). The peer row is absent from
   `availablePeers` in all three. The only differentiator is an
   aliasless integer in the Claude connector's registry block.
2. The product already ships a translated, tested answer for exactly
   this state — `peer.reason.aliasCollision` ("Alias collision: rename
   one Claude session, then refresh discovery", dashboard-copy.en.ts:371
   + zh-CN), consumed at dashboard-model.ts:680 and dashboard.ts:611,
   with a fixture — and it is UNREACHABLE, because `availablePeers` rows
   carry no `safeErrorCode` (service.ts:707-717). Its v1 producer was
   deleted in 3ac6eed, which is precisely why the production incident
   read as a total mystery.

emb-94 makes this sharper, not softer: after it lands, a fenced alias is
a state the gateway deliberately creates, and the operator's only signal
is a count they will never look at.

**Deliverable**: make the collision state legible where the operator
already looks. Restore a `safeErrorCode` on the availablePeers row (or
an equivalent already-validated field) so the shipped aliasCollision
copy becomes reachable, and differentiate the refusal enough that a
collision is distinguishable from an absent session — without widening
what crosses the boundary beyond safe codes. Any remedy text must be
true in BOTH discovery states (see emb-94's F2 ruling: under truncated
discovery the rename remedy does not clear the fence).

**Caps**: to be priced at dispatch. Expect E1. Zero new concepts —
the copy, the fixture, and the consuming code all already exist.

**Depends on**: emb-94 landed (this describes its state), and emb-95
landed (owns the adjacent copy — the two must not both edit it).

## Scope addition from emb-94's second review (2026-08-18)

The review reproduced the full operator surface during a live collision
and found three falsifications this ticket now owns (wire-side
`conflict` decision was pulled forward into emb-94 correction #3; the
rest is here): (1) the dashboard attention item shows
CLAUDE_REGISTRY_RECORDS_REJECTED with copy claiming records were
unreadable/rejected while the same object reports every record parsed —
the collision count is overloaded into a counter whose documented
semantics are scan rejections (GATEWAY-ARCHITECTURE.md:251-253,
CONFIGURATION.md:115, DASHBOARD.md:86 — none updated); (2) both
colliding sessions vanish from the dashboard with no distinguishable
signal; (3) the recovery the fence design depends on (rename a session,
or select by UUID) is documented nowhere an operator looks. Any fix must
keep remedy text true in BOTH discovery states (truncated discovery does
not clear the fence) and must reconcile or re-home the counter
semantics.
