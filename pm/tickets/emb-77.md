---
id: emb-77
title: v1.8 stage 4 — activate the stateless transport, state v3, delete the lifecycle
kind: normal
size: 8
status: dispatched
release: v1.8
updated: 2026-08-16
---

## Binding

**Why**: stage 4 of the accepted emb-73 design — the R4 vertical activation.

**Deliverable**: activate the landed stateless transport as THE Codex path;
native state v3 (commit ID/sequence, logical routes, consent edges, one
messages table with queued|reserved|armed|accepted|terminal, dedupe/rate,
bounded activity) via the release-owned OFFLINE v2→v3 converter (broker
stopped; backup first; v2 in-flight → terminal ambiguous; runtime accepts
only v3); DELETE the old provider/service/store/helper lifecycle per the
design's inventory (persisted endpoint evidence/generations, activation/
re-arm/reanchor/refresh, stale lifecycle, endpoint/orphan/succession
journals, connector persistence) with `--succeeds` reduced to one atomic
replacement. Conformance suite + golden fixtures are the parity oracle:
HOLD items byte-hold, INTENTIONAL/DELETE items match the preclassification.

**Budgets**: E8/R4. Caps from YOUR remainder map before cutting (design
figures are estimates, per standing rule). The deterministic 90s-pause
headline test lands here. Live drill (state conversion, split-brain matrix,
restart taxonomy) is PM-side at landing under itemized standing authority.

## Pre-cut remainder map + cap + six bindings RULED (2026-08-16 night)

Engineer's read-only map at exact base d5d983a pinned the accepted-core
metric to a reproducible command (39,883 physical lines; the command is the
metric of record for this slice). CAP GRANTED as requested: ≤10,000 added
source (src/**+scripts/**), ≤7,000 added tests, deletions unbounded,
REQUIRED net core reduction ≥10,000, REQUIRED post-slice core ≤29,000;
projections +7.2–9.85k/−20.4–23.3k source, post-slice 25.5–27k (stages 6–8
own the remaining path to 18,850). Self-binding cap shape (net-reduction
floor + ceiling) noted for the work model as the new standard.

SIX BINDINGS CONFIRMED: R1 steer on the exact active operation connector
(cap 3, thread+turn+registration+attempt; observation connector = candidates
never authority); R2 turn/steer correlated rejection = AMBIGUOUS no-replay
unless the landing gate proves atomic no-effect; R3 closed clean-prewrite
retry enumeration (additions require a ruling); R4 suffix-only v2 terminal
history, no fabricated IDs, v2 inFlight → terminal ambiguous; R5 packaged
offline `embassy convert-state-v2-to-v3` (fsynced 0600 backup, one strict
pass, never starts providers; runtime = v3-only +
GATEWAY_STATE_CONVERSION_REQUIRED pre-provider — structurally fixes the
cleanup-masking scar; FLAGGED to founder: deliberate divergence from the
v1→v2 re-pair precedent, justified by v3 preserving in-flight mail/consent);
R6 atomic --succeeds (queued/reserved→cancelled ROUTE_UNREGISTERED,
armed→ambiguous, accepted→unconfirmed, idempotent retry, no journal).
Mechanical must-have confirmed: attempt-bound correlated acceptance before
terminal. Four R4 review rounds + 90s headline + byte-held emb-76 goldens +
HOLD-proven-before-deletion accepted as the verification price.

## R4 seam ruling: Claude final-authorization analogue (RULED A)

ClaudePeerAdapter.send() was the only provider path without the
prepare/authorize/perform split (it allocated ID + encoded + wrote in one
call), so the kernel could not persist exact claude_mailbox prepared
evidence before arming. RULED A: add the narrow analogue — exact validated
frame prepared post-revalidation, bounded evidence exposed, authorize, one
synchronous one-shot perform; wire bytes unchanged; denial=zero-write,
route/peer drift fence, post-perform ambiguity frozen in focused tests.
B (Claude-exempt preauthorization) rejected: provider-dependent armed
semantics would gut the design'''s uniform authorization promise on the
highest-traffic direction. Delta +80–150 src / +100–180 tests within caps.
