---
id: emb-73
title: v1.8 — first-principles core rebuild to a 20k-line budget
kind: design
size: 8
status: landed
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

## Charter addendum: the stateless Codex transport is the centerpiece (2026-08-16)

Founder, after the second attach incident in one day: restarts of the App
Server or Desktop are ROUTINE user behavior; manual troubleshooting after
them is unacceptable; four releases of patching the same seam (v1.2 boot
reactivation, v1.5 generation sentinel, v1.6 re-arm, v1.7 exact-generation
activation) means the dance itself is the defect. "Think from the ground up
and think about what the user wants."

DESIGN CENTERPIECE, and the first implementation slice of v1.8: the Codex
transport rebuilt stateless in the ACP client's shape. A route is
(alias, durable thread ID) — no endpoint generation, no persisted endpoint
evidence, no stale lifecycle. Every dispatch is connection-per-operation:
attest socket path (OS boundary kept) → connect → initialize →
thread/resume --excludeTurns (idempotent; existing privacy-preserving call)
→ turn → receipt. Daemon restarts are invisible to the next dispatch;
mid-turn death settles UNKNOWN under the ambiguity law. ChatGPT Desktop is
demoted to a viewer — its attachment state affects nothing operational
(evidence: main took turns with Desktop dead this morning). One best-effort
notification subscription remains for steering/busy freshness, reconnecting
with backoff, never able to block dispatch. Expected deletions: succession
machinery (~1,037 lines), endpoint-refresh/activation choreography, the
route-staleness lifecycle — the incident CLASS, not the incident.

emb-75 remains the deliberately small v1.7.1 interim (guidance regression
fix + orphan detector) so diagnostics are truthful until this lands.

**Founder ratification (2026-08-16 evening)**: root cause confirmed — "let's
land this in v1.8 on top of the broader simplification work." The stateless
Codex transport is bound as v1.8's first implementation slice; the design
phase must produce it first and the rest of the rebuild composes around it.

## Design ACCEPTED (2026-08-16 late) — full report on conv_jyZwrs34mRmBd4R-z6fPqRBo
## and /private/tmp/emb73-design-report.md

Three primitives: durable logical routes + consent edges; ONE message/attempt
state machine (queued→reserved→armed→accepted→terminal; authorization commit
= consent linearization; reserved loss retries, armed loss ambiguous, no
auto-replay); small per-operation transports with ALL provider I/O outside
the durable commit lane (the hard rule that kills the emb-75 starvation
class architecturally). Stateless Codex = first slice and forcing function.
Budget table VERIFIED: sums 18,850 hard (1,150 under the 20k mandate) /
13,000 stretch from current 37,817. Self-policing fences: no WAL/database/
actor framework/generic transactions/capability registry. v1.9 constraint
honored (federation = address + transport on the kernel; peer ingress reuses
it; no second scheduler/mailbox). State v3 with one release-owned OFFLINE
v2→v3 converter (broker stopped), runtime accepts only v3; validation =
decode once, re-attest late. Landing: conformance-before-rewrite, golden
fixtures preclassified HOLD/INTENTIONAL/DELETE, staged R3→R4, deterministic
90s-pause headline test, separately-itemized live drill.

GATES RULED: (1) narrow doctrine amendment APPROVED — boot + fixed 15s-timer
exact-UUID Claude reobservation, observation-only connections fenced exactly
as proposed (never send/pair/approve/credentials/history; bounded; failure
projects unobserved) — grounded in the founder's explicit "your route should
not go stale" directive; flagged for founder ratification in the summary.
(2) split-brain live matrix (Desktop dead / attached / private-server) =
landing-drill item under PM standing restart authority, itemized per
operation; if the private-server case cannot resume, queue/defer with the
existing thread-not-observed code — never certification, never discovering
an untrusted socket.

Sequencing: implementation lands after emb-75/v1.7.1. Stage 1+2+3
(fixtures, test-only conformance suite, stateless Codex inactive behind the
current seam) ticketed as emb-76 → main.
