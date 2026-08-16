---
id: emb-70
title: De-ceremony 66A — runtime authority cutover, one seam owner
kind: normal
size: 5
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: batch 66A of the accepted emb-66 design (founder ruling R2). The
authority seam — boot probe, connector switch, provider admission, refresh,
activation — is ONE seam and lands under one owner; splitting it by file was
explicitly rejected in the design.

**Deliverable**: the DELETE list's runtime authority classes cut out of the
live code paths per the emb-66 inventory (items 1–7 and 9–11 where they bind
at runtime): certified inventories/tiers/probe machinery, boot probes,
adapter certification APIs, version-derived quarantine/monitor-only
admission, the entire write-probe apparatus and probe ledger, the two-factor
gate with no one-factor remnant, authority UI bindings, version/probe alerts
— replaced by the design's best-effort runtime contract (9 rules, in the
ticket record on emb-66). CONVERT items 3–5 land here (Codex exact
current-generation attestation — never a version allowlist, never PATH
fallback; initialize as negotiation only; refresh as exact generation
transition). Persisted/public schema deletion is OUT (emb-68 owns all state/
public excision; no intermediate format ships) — where runtime code reads
soon-to-die state fields, stub through the narrowest seam and mark for
emb-68.

**Highest-risk review points (from the design, binding at landing gate)**:
preserve Claude OS/peer-protocol evidence; Codex pin replacement is exact
attestation, not loose lookup; preserve pre/post-write uncertainty; keep
refresh freeze/settlement/CAS; no migration/prune/support-manifest runtime
concept appears.

**Budgets**: E5/R3. Caps REVISED by contest #11 as amended: ≤3,200 source +
≤6,000 tests touched (≤9,200 total). Expected net unchanged: strongly
negative.

## Contest #11 (budget, 2026-08-16) — GRANTED

Engineer froze all edits at ~2,800 source / ~4,050 tests touched with bound
work remaining (providers refresh/recovery latch conversion;
gateway-providers.test.ts probe/two-factor test deletion; 10 stale service
event fixtures; app-server probe deletion +9/−804 src, −1,274 tests) and
contested rather than overrun silently. PM verification: the accepted
design's own GROSS inventory (tests 3,800–4,900) already exceeded the
original 3,200 test cap — the per-batch table and the gross numbers were in
tension, ground truth wins. Old caps (≤2,500 src + ≤3,200 tests) were
PM-set; retaining dead authority tests to fit them would fail the ticket.
Ledger: 11/11 engineer-correct. Added SLICE READY requirement: touched-line
accounting split into deleted-dead-authority / added-best-effort /
added-rewritten-tests / emb-68 shim lines.

## Contest #11 amendment (same day)

Engineer's post-freeze remainder map corrected its own test estimate:
gateway-providers.test.ts alone needs ~1,500–1,850 touched lines (the file
absorbed the entire probe/two-factor/fake-refresh apparatus across
emb-58/59/60); 4,113 current + that surgery projects 5,600–5,950. Test cap
amended 5,200 → 6,000; source cap unchanged. Engineer re-froze on the stale
grant rather than riding it — correct. Messages crossed once (delayed-echo
class, retro item stands). RETRO RULE from this contest: de-ceremony batch
caps are set from a frozen-lane remainder map, not from design-stage tables.

## Adversarial hold + scope ruling A (2026-08-16)

Main's challenger found residual live version authority the seam map had
parked with emb-71 phase 2: LocalClaudeGatewayProvider passes
runtime.claudeCodeVersion into ClaudePeerAdapter; claude-peer.ts rejects a
different major at construction and filters registry records via
sharesCompatibilityMajor — version-derived admission surviving in a ticket
that promises none. Engineer held the freeze and asked for a ruling
(cut at 3,041/3,200 source, 5,867/6,000 tests, 323 focused pass).

RULED (A): narrow window expansion — claude-peer.ts (+ adapter call site if
signature demands) + focused tests; delete EXACTLY the two version-trust
checks; preserve peerProtocol:1 exact wire grammar (the real admission gate,
KEEP-list), all identity/OS/socket/ownership checks, record schema
validation. claudeCodeVersion keeps flowing as inert unverified metadata —
sourcing/retention stays emb-71 phase 2's decision. SEAM RE-DRAW recorded:
admission authority = emb-70; version-metadata sourcing = emb-71 phase 2.
Expansion budget by remainder-map rule: ≤+300 src / ≤+500 tests without
another round-trip (≤3,500 / ≤6,500 hard); over that, map first. The
Codex-side user authorization explicitly covers these version-gate removals.
