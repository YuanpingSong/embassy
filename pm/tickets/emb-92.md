---
id: emb-92
title: v2.0 — Claude peer discovery admits background sessions
kind: normal
size: 1
status: landed
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: Founder ruling (2026-08-18): "We shouldn't have this
limitation." The PM seat now runs as a background Claude session on
m5dev, and background sessions are first-class operators in this work
model. But the local Claude provider only admits interactive sessions as
peer candidates: `providers.ts` drops `kind !== "interactive"` at the
discovery refresh (line ~736 on main) and re-checks the same predicate
at selection (line ~503), and `NATIVE_CLAUDE_NAME`
(`/^[a-z][a-z0-9_-]{0,31}$/`) rejects digit-start auto-generated names.
Net effect observed live on m5dev: `availablePeers` is permanently
empty, the PM session cannot be discovered, selected, or paired, and no
native PM↔engineer contact is possible. Consent does not live in this
filter — it lives in explicit pairing — so admitting background
sessions does not weaken the trust model.

**Deliverable**: admit kind `"bg"` alongside `"interactive"` at both
predicate sites; carry the real kind on the discovery row instead of the
hard-coded `"interactive"` literal (type ripple included); widen
`NATIVE_CLAUDE_NAME` to `/^[a-z0-9][a-z0-9_-]{0,31}$/` so digit-start
session names are addressable. `daemon` and `daemon-worker` stay
excluded — the helper fleet must never become addressable. The embassy
advertisement predicate in `claude-peer.ts` is untouched
(advertisements remain interactive-shaped). No pairing, consent,
inbound-policy, or send semantics change.

**Caps**: E1; src changed ≤40 (measured-remainder rule: contest with a
map if the coherent cut disagrees — pre-estimates are projections);
tests ≤80 changed/added; zero new concepts. Base = public main 788a6f3.
Surface is `src/gateway/providers.ts` (+ its types/tests). emb-90 is
frozen on `cli.ts`/`control.ts`/`service.ts` + 4 test files — stay off
those files; if the type ripple forces a shared file, contest before
touching it.

**Acceptance**: (1) a live, named background Claude session appears in
`availablePeers` as `name@host`; (2) select/pair and the send/reply
round-trip work against a bg session (fixture records with
`kind: "bg"`); (3) interactive-session behavior byte-for-byte unchanged;
(4) `daemon`/`daemon-worker` records are never listed nor selectable;
(5) a digit-start name (e.g. `9a04b5e9`) is a valid candidate name;
(6) full check green.

## Dispatch (2026-08-18)

Jumps the queue ahead of emb-91: this ticket unblocks the PM↔engineer
channel on m5dev, so it prices above everything except the emb-90
landing. Fresh lane off 788a6f3, parallel to frozen emb-90. Freeze with
SHA + per-bucket accounting as usual; the PM gates immediately on
freeze. After landing, the PM runs the m5dev broker from the main build
(operator step, PM-side) and the engineer completes `select-claude` to
the PM session. Until then, coordination rides the records branch and
founder relay.

## Contest ruling #1 (2026-08-18)

Engineer found the anticipated seam before editing: emitting the real
`"bg"` kind requires widening `GatewayAdapterDiscovery.kind`
(src/gateway/service.ts:102) from `"interactive"` to
`"interactive" | "bg"` — a shared file frozen under emb-90.

GRANTED: exactly that one line in service.ts joins emb-92's window.
Conditions: (a) it is the ONLY service.ts change — a second line there
is a new contest; (b) src cap unchanged (≤40; engineer projects a
comfortable fit); (c) sequencing: emb-90 is gate-clean (555/555,
accounting exact) with adversarial review in flight and is expected to
land on main imminently — before freezing, fetch, and if main has moved
past 788a6f3, rebase the lane onto the landed tip and freeze with that
base; if emb-90 is still unlanded at freeze time, freeze on 788a6f3 and
declare the service.ts line explicitly in the freeze message. Landing
order is the PM's problem, not the engineer's.

Ops note (same exchange): the earlier registration failure was
CLI-side — v1.9.5 `register-codex` defaults `--host` to `this-mac`
(cli.ts:31) and faults when the alias suffix disagrees (cli.ts:349-354).
Verified against broker-side validation (server.ts:143 derives
allowedHosts from the nodes inventory = [m5dev, this-mac];
service.ts:995 requires the alias to end with the broker hostId):
`embassy register-codex --alias codex-embassy-swe3@m5dev --host m5dev`
is the correct invocation on this host. The --host flag dies in v2.0
(emb-89 already deleted it on main).

## Contest ruling #2 (2026-08-18) — DESCOPED, window not expanded

Engineer's fixture proved the finding before editing: a digit-start name
(`9a04b5e9@host`) is filtered by the full alias grammar at ten
production boundaries (providers, service, control, store, types,
peer-protocol, peer-mailbox, provenance-envelope, claude-helper-protocol,
claude-helper-supervisor) — including persisted route state and
provenance validation. The requested expansion (ten files, tests >80,
verification R4) correctly prices what that change IS. The finding is
right; the feature is not worth it.

RULING: the name-grammar widening is CUT from emb-92 entirely.
Acceptance criterion (5) (digit-start names as valid candidates) is
dropped; the alias grammar stays untouched at every boundary. Reasons,
in order: (1) the mission is the founder's bg-admission ruling, and the
PM seat runs under a deliberate letter-start name — digit-start only
serves sessions nobody named, a convenience; (2) ten boundaries
including store.ts and provenance-envelope.ts is R4 trust/persistence
blast radius, indefensible for a convenience inside an E1; (3) fleet
compatibility: peer wire is v1 and the this-mac broker (v1.9.5)
enforces the letter-start grammar — a locally widened grammar mints
aliases the other node rejects, breaking grammar uniformity mid-flight.
The uniform grammar is a validation asset; we don't trade it here.

emb-92 is now part 1 only: the two kind predicates admit "bg", the
granted one-line service.ts type widening, carrying the real kind on the
discovery row, and focused tests with letter-start bg fixtures. Caps
stand: src ≤40, tests ≤80. TMPDIR=/tmp rerun for the INVALID_SOCKET_PATH
service test acknowledged — that is the pinned check environment.
Unfreeze and proceed.

BACKLOG (declined-for-now, with reasons recorded here): digit-start
session addressability. Returns only if a real need appears for
addressing unnamed sessions, as its own ticket priced at the R4 it
actually is, riding a release that versions the peer wire. Preferred
alternative if the PM session's auto-name proves digit-start at
switch-on: name the session (named bg sessions exist in production —
`screenshot-main`); if bg sessions prove un-nameable, that fact comes
back to the founder as a decision point, not into this slice.

## Contest ruling #3 (2026-08-18) — GRANTED

Engineer's pre-freeze adversarial pass found the real blocker: the
supervised helper still rejects bg sessions at both round-trip
boundaries — claude-helper.ts:63-66 (inbound requires kind
"interactive"; a bg reply expires CLAUDE_SOURCE_ROUTE_STALE) and
claude-helper.ts:96-100 (outbound prep requires "interactive"; a
selected bg target fails CLAUDE_ROUTE_MISMATCH). Provider/service
fixtures bypassed the helper, so the green 557/557 did not prove
acceptance criterion 2 — the exact green-suite-proves-the-wrong-thing
class emb-90's F2 just taught us. Caught before freeze by the
engineer's own verification. That is the protocol at its best.

GRANTED: (a) src/gateway/claude-helper.ts joins the window for exactly
those two predicates — widened to admit "bg" alongside "interactive";
daemon/daemon-worker remain excluded at BOTH helper boundaries, same as
everywhere else; (b) the existing production-helper fixture in
test/gateway-claude-helper.test.ts flips kind "interactive" → "bg",
proving both directions through the real child — if both kinds can be
parametrized within budget, prefer that; otherwise the flip stands
(interactive safety is structural: the predicate widens, never
replaces); (c) src cap unchanged (≤40; 12 projected); tests cap raised
80 → 82 as requested — asking for 2 lines instead of golfing them away
is accounting honesty, granted on sight; (d) R stays R3. Freeze must
itemize the claude-helper.ts lines in the src bucket.

## Landed (2026-08-18)

Freeze SHA cda78d40, base 788a6f3. Gate CLEAN: sha ✓ base ✓ apply ✓
accounting exact PER FILE (helper 5 / providers 6 / service 2 = 13 /
grant 40; tests 82 / grant 82) ✓ check 557/557 ✓ soak 1/1 ✓ hygiene ✓.
Scope verified mechanically against the three contest rulings: file list
confined to the 3 granted src files + 3 test files; alias grammar
untouched at every boundary (contest #2 descope held); daemon and
daemon-worker excluded on every changed src line (widened predicates
admit exactly "interactive" || "bg"). Test bucket landed at exactly the
82 the engineer requested and reproduced exactly from numstat — the
raised cap was honest measurement.

Landing-tree re-verification (emb-90 landed first; both slices touch
service.ts): patch re-applied to 5cb2b6d, accounting reproduced
identically, full check 557/557 and soak 1/1 run IN THE LANDING TREE per
the v1.9.3 rule. Landed on public main as **9754888**. Status: landed.

Note: bg admission is live in source but NOT live on either machine's
broker — both run published 1.9.5. It becomes operational at the v2.0.0
release, when both machines install and run the reset drill.
