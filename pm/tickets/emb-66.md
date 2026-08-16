---
id: emb-66
title: De-ceremony inventory — best-effort delivery replaces online certification
kind: design
size: 3
status: landed
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder ruling emb-61 R2, with explicit authority to "undo that
theatre": certifying a build's compatibility must not be an online process.
Online = best-effort delivery, graceful error handling, clear error surfacing.
Compatibility with harness interfaces is built and tested OFFLINE and shipped
by release. The blurred responsibility between the two introduced most of the
product's ceremony complexity.

**Deliverable**: a design that (1) inventories every online-certification
mechanism in the shipped code — evidence tiers (certified / schema_attested /
monitor-only quarantine), boot compatibility probes, version pins gating
routing or boot, the write-attestation probe and its capacity ledger, and the
emb-60 two-factor write gate — and sorts each into: DELETE (ceremony), KEEP
(trust model: pairing consent, provenance marking, OS boundary, anti-runaway
bounds), or CONVERT (becomes an offline release-time compatibility test or an
honest runtime error surface); (2) defines the best-effort runtime contract —
attempt the operation, degrade gracefully, settle receipts with honest
terminal codes, never refuse to boot over version drift; (3) defines the
offline compatibility process — what CI/release must exercise per supported
harness so "supported" is a tested claim, not a runtime gate; (4) prices the
removal. Per the founder's migration addendum on emb-61: the unified route
table is v1.7's NATIVE state format — no in-binary forward migration, no
reverse/prune command; our own state database is migrated once by hand at
upgrade; unparseable state gets the normal strict-parse honest error.

**Explicit consequence, ruled and ratified**: this unwinds machinery shipped
in v1.6.0 and v1.6.1 (emb-58 plumbing, emb-59 probe, emb-60 gate). The
founder, on seeing the consequence stated: unfortunate to unship recent work,
but "even as recently as v1.6, the certification issue keeps coming back to
us. It's nowhere near settled, so just doing away with it is the long-term
fix" — the best time to take the step was at the start; with the experience
we now know it is correct. SCALE EXPECTATION: removal on the order of
hundreds of lines, possibly over 1,000; the design should be priced and
judged against significant net simplification of the codebase (easier to
develop, maintain, build on) and reduced DeepSeek integration work — not
against minimal diff size.

**Budgets**: size 3, design only — no code moves until the design is reviewed
and the split is priced. Sequenced after emb-65 so the ACP client is designed
ceremony-free from day one rather than de-ceremonied later.

## Design report delivered + PM ACCEPTANCE (2026-08-16)

Main's read-only design report (evidence base: exact ebb65b9) delivered on
conv_f6-LhV-PXdY-zIqCCmyni83R. Core principle adopted verbatim: delete online
AUTHORITY CERTIFICATION, not runtime validation — "a version/build fact may
support an offline release claim, but never grants or withholds routing
authority. Runtime authority is consent plus exact owned route/session
identity; runtime success is what the current connection and correlated
operation prove."

Scale (planning arithmetic): source net −1,725…−2,995; tests/docs/workflow
net −1,950…−3,350 after adding offline coverage; TOTAL NET −3,675…−6,345 —
several times the founder's 1,000+ expectation.

Inventory: 11 DELETE classes (certified inventories/tiers/probes; boot probe
machinery; adapter certification APIs; version-derived quarantine providers;
the ENTIRE emb-59 write-probe apparatus; the probe ledger; the emb-60
two-factor gate with no one-factor remnant; durable compatibilityAttestations
state; authority UI incl. writesCovered; DeepSeek version observer; probe/
version alerts). 8 CONVERT classes (registry version → unverified metadata;
claude --version → prefer delete pending offline interop proof; Codex pin →
exact current-generation attestation, never PATH fallback; initialize/list →
negotiation and recovery only; CompatibilityState → deleted by emb-68, route
staleness + connector health carry truth, NO replacement enum; version-derived
incompatible provider → provider-local unavailable/degraded; support claims →
release-only matrix never imported at runtime). 9 KEEP classes = the trust
model (consent, provenance, leases/attested boundaries, generation identity,
strict wire facts, Codex recovery privacy, anti-runaway bounds, ambiguity
law, data minimization/no approval authority).

Best-effort runtime contract (9 rules) and offline compatibility process
(release-owned matrix, 5 CI layers, failures qualify the support claim never
a runtime blocklist) accepted as written.

PM AMENDMENT ADOPTED (supersedes emb-65 PM ruling B's receipt wording): dsh
end_turn settles **unconfirmed / ACP_OUTCOME_COARSE**, not delivered — the
adapter's collapse means end_turn proves nothing, and claiming delivered
would violate the KEEP-list ambiguity law. Sound cancelled stays cancelled.
emb-69 amended to match.

Posture clarification recorded: post-removal, writes are gated by consent +
exact owned identity + the ambiguity law — no version authority anywhere.

Priced split adopted: 66A → emb-70 (runtime authority cutover, ONE seam
owner, E5/R3, caps ≤2,500 src + ≤3,200 tests); 66B → emb-71 (Claude
boundary-safe version decision + offline core, E5/R4, ≤1,000); 66C+66D →
emb-72 (presentation + docs sweeps, E3, ≤1,000 combined); emb-68 absorbs all
state/public excision (NO intermediate format ships); emb-69 absorbs the
DeepSeek observer conversion. Highest-risk review list carried into each
ticket's landing gate.
