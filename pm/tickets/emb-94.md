---
id: emb-94
title: v2.0 RELEASE BLOCKER — duplicate peer aliases invalidate the whole public snapshot
kind: bug
size: 1
status: dispatched
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: Found in production on m5dev minutes after emb-92 landed, on a
2.0.0-rc.1 broker built from main 9754888. `embassy status` fails
deterministically with `CONTROL_INVALID_RESPONSE` (+ the version-skew
hint, which is MISLEADING here — client and broker are the same build).
`health` and `refresh-dashboard` still work, which is the diagnostic
asymmetry.

Root cause, confirmed against the raw `list_snapshot` frame: two live
Claude sessions share the display name `color-analysis-pm` (one
interactive, one bg — both real, both live). Discovery keys candidates
by (host, session UUID) at service.ts:2664, so both become candidates
and both project into `availablePeers` with the SAME alias. The snapshot
post-validator requires `unique(peers)` (control.ts:695 + :704), so the
ENTIRE snapshot is rejected — not just the offending row. Every snapshot
consumer dies with it: `status`, the dashboard data path, and anything
reading routes/consent/accounting.

Latent before emb-92 (two same-named interactive sessions would have
done it), but emb-92 made it reachable in normal use: with bg sessions
admitted, a founder running several named background agents collides
names routinely. Neither the fixtures nor the adversarial pass covered
two live sessions sharing a name.

**Deliverable**: an ambiguous alias must never be addressable, and must
never poison the snapshot. Precedent to follow — claude-peer.ts already
handles the analogous SESSION_ID_COLLISION by dropping BOTH bindings and
counting a rejection (claude-peer.ts:1010-1021). Apply the same
fail-closed rule to alias collisions among live candidates: when two or
more live candidates on a host resolve to the same alias, drop them all
from `availablePeers`, count a rejection so the condition is visible in
the registry diagnostics, and make the alias unresolvable for
select/pair (never pick one — sending to the wrong session is a consent
violation). Sessions with unique names are unaffected.

**Caps**: E1; src changed ≤35; tests ≤80; zero new concepts. Base = main
9754888.

**Acceptance**: (1) with two live same-named sessions, `status` returns
a valid snapshot and neither colliding alias is listed; (2) the
collision is visible as a counted rejection, not silence; (3)
select/pair against a colliding alias fails closed with a safe code;
(4) unique-named sessions (interactive and bg) still list, select, pair,
and message normally; (5) a regression test with two live candidates
sharing an alias — the fixture gap that let this ship; (6) full check +
soak green.

**Ops note for the PM**: this blocks v2.0.0. It does NOT block the live
channel — pair/send resolve aliases through the candidates map, not
through `list_snapshot`, and `embassy-pm@m5dev` is unique.

## Gate + adversarial verdict (2026-08-18): HOLD, corrections ordered

Freeze SHA 72459e09, base 9754888. MECHANICAL GATE CLEAN: sha ✓ base ✓
apply ✓ accounting exact (service.ts 31/35; tests 58/80) ✓ check
558/558 ✓ soak 1/1 ✓ hygiene ✓. Zero-concept claim VERIFIED
(PEER_ALIAS_COLLISION pre-exists at base, dashboard-model.ts:680).
Mutation caught (inverting the collision predicate reddens the new
test). Accounting honesty and concept discipline were both real.

ADVERSARIAL: HOLD — three blocking findings, each reproduced with
runnable evidence, plus a correction bundle. The slice fences the wrong
noun: it deletes CANDIDATE ROWS where the ticket asked that the ALIAS be
unresolvable.

**F1 (HIGH, blocking) — the fence disables UUID selection too.**
Deleting colliding candidates (service.ts:2669/:2692) also kills the
`routeHandle === selector` arm of resolveClaudeSelector (:2706-2711), so
neither session can be addressed by its own session UUID — an identifier
that is unambiguous by construction and carries no "pick one of the two"
risk. Reproduced: UUID select accepted at base, not_found on the slice,
for BOTH sessions. This is also the operator's only no-touch recovery
path, which is what turns F2 into a dead end. RULING: fence the alias
arm of the resolver and the availablePeers PROJECTION; keep the
candidate rows. UUID selection must keep working while a name is fenced.

**F2 (HIGH, blocking as shipped) — permanent fence under truncated
discovery, with a remedy string that lies.** Fences clear only on
`snapshot.complete`, which is false whenever the sessions dir exceeds
the 256-dirent cap (stale records included). Reproduced: after the
operator performs the shipped remedy (rename one session), the alias is
STILL not_found, while base recovers — a behavioral regression. The
translated string `peer.reason.aliasCollision` ("rename one Claude
session, then refresh discovery") is false in that state.
RULING, honoring AGENTS.md:65 (R3 prices "a restart recovers"):
conservative retention under incomplete discovery is CORRECT and stays —
partial discovery cannot prove uniqueness, and clearing on unproven
uniqueness is the consent risk this ticket exists to prevent. What is
not acceptable is a false remedy and an unbounded set. Required: (a) the
copy must state the real condition and the real escape; (b) the fence
set gets a bound. With F1 fixed, the operator also retains the UUID
path, so this stops being a dead end.

**F4 (HIGH, blocking) — the original blocker relocated one field over.**
The unconditional `{PEER_ALIAS_COLLISION, n}` append can produce two
equal codes in `registry.rejected`; types.ts:320-321 requires strictly
ascending, so the connector row fails, `isGatewaySnapshot` is false, and
status dies exactly as before. Not reachable through today's provider
(the code is absent from claudePeerRejectionCodes) — but the diff spends
a code name into an adapter-controlled namespace with a hard-fail
validator and no merge, two lines from SESSION_ID_COLLISION. Shipping a
"status dies" fix that leaves a one-enum-entry path back to "status
dies" is not worth the saved line. RULING: merge by code in
publicRegistry.

**Folded into the correction (cheap, and they make the slice smaller):**
F8 — count ≥2 DISTINCT routeHandles per alias, not records (the safe
predicate the candidates map already keys on). F11 — the candidate-skip
and prune clauses are mutually redundant (deleting either leaves the
test green) and the prune clause appears unreachable; the F1 rework
should delete the dead mechanism rather than preserve it, and the test
must distinguish the mechanisms that remain. F5 — publish the fence
after pruning, not before (ordering only; unreachable today because
server.ts:174 assembles exactly one Claude provider, but the invariant
should live in this code).

**Routed elsewhere, NOT into this slice:** F10 (three distinct operator
situations answer byte-identically, and the shipped translated
aliasCollision copy is unreachable because availablePeers rows carry no
safeErrorCode) → emb-95, which already owns error classification and
honest copy; the two tickets must not both edit that copy. F6 (fence
guards binding but not addressing — an operator-model gap; the route
stays UUID-pinned so no message reaches an unchosen session) and F7
(clearing ignores the persisted route; mitigated by
CLAUDE_PEER_NOT_OBSERVED, and the new test never exercises the
surviving-route branch) → backlog candidates, priced post-v2.0.0. F9
(pair fence matches a raw string with no provider check, so a Claude
collision could quarantine a codex alias — crosses AGENTS.md:196-197)
→ fix only if it falls out of the F1 rework for free; otherwise backlog.

**Budget for the correction**: src ≤60 (was 35), tests ≤120 (was 80),
measured-remainder rule in force — contest with a map if the coherent
cut disagrees. Zero new concepts still binding. Base unchanged (9754888).

**Verified sound, kept for the record** (the reviewer attacked and could
not break): unique(peers) holds in every collision state except the
constructed F4; the "same bug one field over" hypothesis on ROUTE
aliases is refuted (the store is alias-keyed); no cross-host
over-blocking (prefix/substring names unaffected, remote peers stay
listed); no wrong-session delivery through dispatch (expectedTargetBinding
pins routeHandle + registrationId); no boot-ordering window; concurrent
refreshes cannot reorder a stale clear over a fresh fence; unpair and
unselect stay open so an operator can always dismantle state; registry
code ordering and row caps are safe.

**PM note on method**: my gate's mutation test passed while F11 shows
two mechanisms are mutually redundant and one is dead. Mutating a single
predicate proves that predicate, not the design. Where mechanisms can
cover for each other, mutate EACH independently — added to the gate
norm earned on emb-90.
