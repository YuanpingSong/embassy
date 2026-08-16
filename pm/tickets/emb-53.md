---
id: emb-53
title: Lane economics re-baseline under corrected fleet config
kind: investigation
size: 1
status: landed
release: v1.6
updated: 2026-08-15
---

## Binding

**Why**: the agent-team vs single-agent routing guidance derives from measurements taken under a misconfigured fleet — 149/150 subagents were silently running maximum effort. Relative lane costs cannot be trusted until re-measured under the corrected configuration (standard priority, high effort).

**Deliverable**: one large ticket's cost measured in both lanes under the corrected config; an updated lane-economics note (wall-clock, tokens, quality of handoff) replacing the stale baseline.

**Budgets**: size 1, investigation. Piggybacks on a real v1.6 ticket rather than manufacturing synthetic work.

## Landed at reduced fidelity (2026-08-16, founder-approved option 3)

The controlled A/B (one ticket costed in both lanes) was dropped during v1.6
pre-flight for token thrift and never ran. The founder accepted closing this
from v1.6's observational data instead. Everything below is UNCONTROLLED:
different tickets, sizes, and kinds per lane; one day; commit-time proxies
for authoring windows; token costs for the Codex lanes were not measurable
this cycle (only the emb-59 probe itself was metered: 17,942 tokens — probe
cost, not lane cost). PM-side review cost is not separated out.

### Observed lane data (v1.6 cycle, corrected fleet config)

swe3 (single-agent GPT-5.6): 7 slices, ~20 points. Overnight: emb-52 (5 pts,
incl. an F1/F2 correction cycle for two reproduced blockers). Morning run,
from commit timestamps: dispatched 08:31; emb-62 source landed 09:12 (3 pts,
~41 min from dispatch); emb-63 at 09:21 (2 pts, +9 min); then emb-55, emb-56
(one boot-safety + one manifest-allowlist correction ruled at landing),
emb-64, emb-57 by 10:53. Net: ~15 points in ~2.4 hours ≈ 10 min/point for
well-specified slices, with small landing-time corrections throughout and
zero blocker-class rework after emb-52.

main (agent-team Codex): 3 slices, 10 points, deliberately routed the
sensitive/novel work. emb-58 (2 pts, overnight; one contest — core correct —
plus the phantom-test calibration incident, which cost a full-verification
cycle). emb-59 (5 pts): first source commit 09:37, adversarial-correction
commit 10:54, final 11:05 — ~1.5 h through a paired taste+adversarial review
and a 10-item correction bundle with two cap renegotiations. emb-60 (3 pts):
landed 11:44, ~39 min after emb-59 closed, and passed the PM landing gate
with ZERO corrections — the cleanest sensitive slice of the release.
Rough rate: ~16 min/point, but the window includes the heaviest review
artillery of the cycle.

Both lanes: every slice landed byte-identical to its frozen patch; zero
out-of-window edits across the release.

### Updated routing guidance (replaces the stale v1.5 baseline)

The v1.5 baseline (main 1h15m E5/R4 vs swe3 3m45s E2, taken while 149/150
subagents silently ran maximum effort) overstated the lane gap and produced
speed-based routing. Under the corrected config the gap narrows enough that
routing should follow TICKET SHAPE, not lane speed:

- Well-specified, bounded slices → swe3. Its ~10 min/point cadence on
  spec-clean work is unmatched, and its correction pattern (small, ruled at
  landing) is cheap to absorb.
- Sensitive, design-heavy, or ruling-dense slices → main. Its cost
  concentrates in review-cycle absorption, and it compounds: after the
  emb-59 correction bundle internalized the rulings, emb-60 landed clean on
  the first freeze.
- The phantom-test incident is a real lane cost for main: cross-engineer
  claims from it get full verification until recalibrated. Price that into
  sensitive dispatches rather than avoiding the lane.

A controlled re-baseline remains available at any time by costing one large
v1.7 slice (an emb-61 sub-ticket) in both lanes; not scheduled.
