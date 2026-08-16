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
