---
id: emb-52
title: Runtime re-anchor must outlive the endpoint transition
kind: normal
size: 5
status: draft
updated: 2026-08-15
---

## Binding

**Why**: an App Server restart currently wedges the broker — routes go stale, `register-codex` is rejected, sends become unavailable — until the broker itself is restarted. Real users hit this every time the daemon restarts; the v1.5.0 endpoint-sentinel fixed route churn on upgrade, but the re-anchor still dies inside the transition itself.

**Promises (what must be true when done):**
1. After a same-path App Server restart (new endpoint generation, same identity), existing routes re-anchor without a broker restart.
2. `register-codex` is accepted immediately after the transition completes.
3. Sends (new and queued) flow after re-anchor, with delivery receipts.
4. The re-anchor leaves journaled evidence (an `endpoint_refreshed`-class event), and degraded state during the transition renders as degraded-with-a-reason, never as absence.

**Budgets**: size 5 (subsystem scope — routes/runtime re-anchor path); concepts: no new user-facing concepts, at most one new journal event kind. Tests: the promises, plus one manual live drill — kill and restart the daemon under a live pair, verify all four promises against the running broker.

**Scope contract**: to be fixed at dispatch; expected neighborhood is the gateway runtime/route modules. No dashboard or CLI surface changes beyond truthful status copy.

**Non-goals**: in-process broker succession (separate track); Codex write authority (emb-49).

## Background (hypotheses — re-verify against current code; stop and report if stale)

Root-cause trace from the v1.5 retro: the transition freezes the route set at T+250ms; a same-generation CHURN wall then rejects the re-anchor; fresh evidence is discarded at `service.ts:8364` (line number from 2026-08 trace — re-locate before relying on it). Ranked fix shape from the retro: let runtime re-anchor evidence survive the transition window rather than widening the wall.
