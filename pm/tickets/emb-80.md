---
id: emb-80
title: v1.8.1 — live status/doctor response fails the shared strict client decoder
kind: bug
size: 3
status: dispatched
release: v1.8.1
updated: 2026-08-17
---

## Binding

**Why**: found in the v1.8.0 release drill. The published broker's
status/doctor responses fail CONTROL_INVALID_RESPONSE on BOTH fresh v3 and
converted state, from both the published client and the source-tree client
(same schema, so the response itself is malformed). health works; the live
delivery path works (a real claude→codex dispatch delivered on the
stateless transport during diagnosis). 518 tests missed it because no test
renders a REAL-BOOT snapshot through the strict client decoder — the
emb-75 lesson (live-shaped fixtures) recurring on a new surface.

**Deliverable**: reproduce with a real-boot snapshot (or add the live-shaped
fixture the suite lacks); fix the encoder/decoder mismatch; regression test
rendering a REAL boot's snapshot (real provider observations, degraded
deepseek connector, config-default ACP routes, observationAgeMs) through the
strict decoder; ships as v1.8.1 immediately, ahead of v1.9.

**Budgets**: size 3, remainder-map before cutting. Dispatched to main on
conv_ijGrzkONU1ChA9RATwwG9__Q during the drill.
