---
id: emb-94
title: v2.0 RELEASE BLOCKER — duplicate peer aliases invalidate the whole public snapshot
kind: bug
size: 1
status: landed
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

## Replacement freeze: mechanical gate CLEAN (2026-08-18)

SHA fc57b9b9, base 9754888. GATE CLEAN: sha ✓ base ✓ apply ✓ accounting
exact (service.ts 45/60; tests 72/120) ✓ check 558/558 ✓ soak 1/1 ✓
hygiene ✓ file list ✓ zero-concept ✓ (types/control/claude-peer blob
SHAs byte-identical to base; PEER_ALIAS_COLLISION and
CLAUDE_ROUTE_NOT_FOUND both pre-exist).

Per-mechanism mutation table — every mechanism independently pinned
(baseline 49/0; each mutation alone → 48/1, file restored and SHA
re-verified between): (a) availablePeers alias fence RED; (b1) pair-loop
fence alone RED; (b2) resolver fence alone RED; (c) distinct-routeHandle
predicate RED; (d) incomplete-discovery retention RED; (e) publicRegistry
duplicate-code merge RED. The F11 mutual-coverage defect is demonstrably
absent. Executed spot checks: both colliding UUIDs select ok while the
shared alias returns not_found (F1 dead); duplicate safe codes merge and
the snapshot validates (F4 dead).

VERDICT PENDING: adversarial re-review was interrupted mid-run by a
PM-side compute session limit (resets 05:50 ET) and will be relaunched.
Landing waits for it — the first freeze's mechanical gate was also clean
and review still found three blockers; that lesson does not get unlearned
one slice later.

## Second adversarial verdict (2026-08-18): HOLD — with a PM scope ruling

Replacement slice fc57b9b9. Prior-blocker disposition from the re-review:
F1 (UUID addressability) genuinely fixed; F4 (duplicate-code merge)
genuinely fixed; folded items (distinct-routeHandle predicate,
prune-before-replace) genuinely fixed. Two new blockers and a bundle.

**Verified consent truth that bounds everything below:** misdelivery is
impossible. The reviewer explicitly tried to route a message consented
for one session to the other and could not, in BOTH reviews — dispatch
carries the exact routeHandle+registrationId bound at selection;
re-selecting the other UUID rebinds and DROPS the old edge rather than
retargeting it; the reply path cannot impersonate. Delivery-consent is
intact in every state found.

**SCOPE RULING (PM):** "the ambiguous alias must never be addressable"
is henceforth scoped to the INTERACTION surfaces — listing, selection,
pair creation — plus snapshot integrity. The residue the review found
(the ambiguous NAME persisting in a durable route the operator bound via
sanctioned UUID recovery; that name accepted by send and exported in the
federation catalog) is an OPERATOR-MODEL gap, not a consent violation,
because binding is identity-pinned and misdelivery is proven impossible.
Closing that residue means re-keying durable routes by session identity
instead of display name — architectural, deliberately NOT bought inside
this E1. Filed as a post-v2.0.0 backlog candidate ("routes keyed by
identity, not display name") with this review as its evidence. The
false doc sentence this leaves standing (GATEWAY-ARCHITECTURE.md:270-272
"duplicate name … fails that operation closed" — never true for writes)
routes to emb-93 (+1 sentence: fence at selection/pairing; pre-bound
routes retain their identity-pinned binding; UUID recovery).

**CORRECTION #3 ORDERED (all small, all inside the ruling):**
1. **F2 — overflow fails CLOSED.** The bound currently sheds FENCES
   while keeping candidate rows: at 257+ colliding aliases the evicted
   alias re-kills the snapshot and select silently picks one of two —
   both original symptoms, resurrected by the fix. Unreachable today
   only because gatewayPublicSnapshotLimits.availablePeers (256) ≥ 2×
   maxRegistryEntries... actually because the registry cap (256) bounds
   colliding aliases to ≤128 — an UNDOCUMENTED coincidence between two
   independently-owned constants. Correction: collisions beyond the
   fence bound drop their candidate rows entirely (never listed, never
   resolvable — UUID recovery is knowingly sacrificed in this
   pathological state only); the diagnostic count keeps reporting ALL
   detected collisions; the constant dependency gets a code comment.
2. **F3 (wire half only) — collision refuses as `conflict`, not
   `not_found`.** The engineer already wrote the right message and
   attached it to CLAUDE_ROUTE_NOT_FOUND → not_found, indistinguishable
   from a dead session. Use the collision code that maps to the distinct
   `conflict` decision. Two operator situations requiring opposite
   actions become distinguishable at the wire. The dashboard-surface
   half (attention copy falsely claiming registry scan rejection;
   counter-semantics overload; the rename/UUID recovery being
   documented nowhere) stays emb-96 — its body is updated with the
   review's specifics.
3. **F4 — the pair fence must evaluate FRESH state**: on the
   public-alias pair path the fence currently reads state up to 30s
   stale (fence check `continue`s before the resolver's refresh).
   Reorder: refresh, then fence.
4. **F7 — finish the line the diff edited**: publicRegistry sorts by
   localeCompare while the validator compares code points; latent
   (all 240 current pairs agree) but armed for the next code added.
   Sort by code point.
**Deferred with reasons:** F5 (sanctioned UUID recovery silently drops
the existing consent edge and the next send reports catch-all
`rejected`) — pre-existing atomic-swap semantics from v1.1, not this
slice's defect; backlog with the review's transcript. F6 (fence not
crash-atomic with the candidate table under a second claude adapter) —
production wires exactly one adapter; backlog note addressed to whoever
adds the second, cross-referenced in the identity-keying candidate.

**Budgets for correction #3:** src ≤75 (was 60; measured-remainder rule
in force), tests ≤150 (was 120) — must include: overflow fail-closed
(bound+1 aliases → snapshot valid, overflow unresolvable, count
complete), conflict-code distinction, pair-freshness, and a
fence→clear→re-fence transition (the re-review found the lane's tests
never exercise re-fence). Zero new concepts binding. Base unchanged
9754888. Third freeze = replacement SHA; mech re-gate + TARGETED
adversarial delta (overflow, conflict code, pair freshness) — the
negative space is now mapped twice and does not need a third full pass.

## Third freeze: verdicts and LANDING (2026-08-18)

SHA bded0016 (supersedes fc57b9b9). MECHANICAL GATE CLEAN: accounting
exact (service.ts 60/75, tests 99/150), check 559/559, soak 1/1,
hygiene clean, 8 of 9 mechanisms independently mutation-pinned. Row (i)
(code-point sort) is present and correct but GREEN-BUT-LATENT — the
comparators provably disagree over the legal code alphabet yet no test
in the repo discriminates them (every fixture carries ≤1 distinct
code); PM ruling: pinning test delegated to emb-96 (two-code straddle
across a `_` boundary) rather than a fourth freeze for a latent-only
hazard. Spot checks all as ordered: 257 colliding aliases → snapshot
valid, zero selectable, full count reported; fenced alias → conflict
while both UUIDs select; pair fences fresh state without a prior
discovery tick.

ADVERSARIAL DELTA: four of five correction claims HOLD outright
(overflow fail-closed incl. boundary-oscillation over six adversarial
refresh cycles and deterministic retention; sort fix genuine;
fence→clear→re-fence byte-identical diagnostics; incomplete/complete
evidence exact). Reviewer verdict was HOLD on F1: the fenced alias
VANISHES from availablePeers rather than being MARKED, so the shipped
alias_collision dashboard affordance stays dead and the operator cannot
learn which alias to rename. PM OVERRULE, recorded transparently: the
finding is CORRECT and is verbatim emb-96's deliverable, routed there
BEFORE this review ran; the vanish behavior is unchanged across all
three freezes (not a correction regression); the release blocker —
snapshot death — is dead. The review's design direction (ONE marked
representative row per colliding alias: satisfies unique(peers), lights
the shipped affordance, names the alias) is adopted into emb-96 as the
preferred implementation. PM RECOMMENDATION to founder: promote emb-96
into the v2.0.0 release set — with the fence landed, collision is now a
state the gateway deliberately creates, and shipping it invisible is
the weakest part of the story.

Folded into emb-96 from this review: the A7 zero-diagnostic variant
(adapter supplying no registry → collision with no evidence anywhere);
F2 non-atomic fence apply (any throw between candidate insert and fence
apply restores the original bug — unreachable today with the single
pinned adapter, but the diff's own comment understates the invariant;
apply per-adapter or unconditionally, and correct the comment); F4
(collision diagnostic has no priority pinning against the 32-code cap);
the code-point-sort pinning test. Recorded-accepted (not emb-96): F5
(+1 discovery scan per pair, incl. pairs with no Claude alias — consent
events are rare; measured, accepted); F6 (UUID selector bypasses the
pair fence and plants the ambiguous name on the edge — inside the
standing scope ruling, operator-model residue); overflow aliases report
not_found rather than conflict (rows discarded — legible only via the
count; pathological state only).

LANDED on public main as **da29280** from the gate tree the checks ran
in (main had not moved from base 9754888, so gate tree = landing tree).
Status: landed. emb-93's base is main AFTER emb-95 also lands — emb-93
and emb-95 collide on control.ts and SKILL.md, so the green light waits
for both.
