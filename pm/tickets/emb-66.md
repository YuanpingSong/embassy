---
id: emb-66
title: De-ceremony inventory — best-effort delivery replaces online certification
kind: design
size: 3
status: draft
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
