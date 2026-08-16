---
id: emb-73
title: v1.8 — first-principles core rebuild to a 20k-line budget
kind: design
size: 8
status: draft
release: v1.8
updated: 2026-08-16
---

## Binding

**Why**: founder mandate (2026-08-16, verbatim intent): core logic carries a
**hard budget of 20,000 lines** (excluding tests, dashboard/UI, and copy —
measured baseline 38,124 at the v1.7 mid-point, ~36k projected at v1.7.0).
Authority covers not just the two god modules (service.ts 8,364 + store.ts
7,230 = 41% of core) but **anything over-engineered or ceremonial**. "Think
from the ground up, think from first principles. Do not accept the current
state as given." Cut at least half the bloat; if two-thirds is manageable,
"definitely do that" — i.e., budget 20k, stretch toward ~13k. The 562-line
ACP client is the style benchmark: post-de-ceremony design cost per concept.

**Deliverable (design phase first — no code in this ticket)**: a
first-principles architecture of the same product written today: (1) the
concept inventory — which of the current concepts (routes, edges, queue,
receipts, provenance, leases, generations, helpers, succession, watches,
journal, control surface) survive as primitives, which merge, which die;
(2) per-subsystem verdict: rewrite-clean vs refactor-down vs keep, each with
a line budget that sums under 20k; (3) the validation architecture — one
strict boundary instead of every-layer re-validation (a named driver of the
current mass); (4) the risk plan: golden wire fixtures, the ACP conformance
pattern generalized to all three transports, behavior-parity proof
obligations, staged landing order, and the drill; (5) what the public
surface (CLI, control, state schema v3?) is allowed to change vs must hold.

**Honest risk statement (for the founder, answering "mechanical or
high-risk?")**: this is NOT mechanical. v1.7's −7,378 deleted dead authority;
v1.8 rebuilds live semantics — queue, settlement, consent, recovery. The
protection that makes it sane is the same discipline that just worked:
design → adversarial review → remainder-mapped caps → isolated gates →
golden-fixture parity → live drill. Rewrite-clean subsystems get conformance
suites BEFORE the rewrite (write the tests against the old, pass them with
the new).

**Sequencing**: after v1.7.0 ships and its retro lands. Design phase runs
first as this ticket; implementation splits priced from the design's
remainder maps (standing rule).

**Budgets**: size 8 (design). Implementation sized after design acceptance.
