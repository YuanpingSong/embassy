---
id: emb-53
title: Lane economics re-baseline under corrected fleet config
kind: investigation
size: 1
status: draft
release: v1.6
updated: 2026-08-15
---

## Binding

**Why**: the agent-team vs single-agent routing guidance derives from measurements taken under a misconfigured fleet — 149/150 subagents were silently running maximum effort. Relative lane costs cannot be trusted until re-measured under the corrected configuration (standard priority, high effort).

**Deliverable**: one large ticket's cost measured in both lanes under the corrected config; an updated lane-economics note (wall-clock, tokens, quality of handoff) replacing the stale baseline.

**Budgets**: size 1, investigation. Piggybacks on a real v1.6 ticket rather than manufacturing synthetic work.
