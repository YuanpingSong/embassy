---
id: emb-63
title: Stale-route guidance names the actual blocker (waiting for Codex app)
kind: normal
size: 2
status: review
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: during the emb-52 drill, routes correctly rendered stale with ENDPOINT_GENERATION_CHANGED —
but the honest next step for a user ("your Codex app hasn't reconnected to the daemon; open it /
relaunch it") is nowhere on any surface. Law 6: every remedy shown must be performable from where
the user stands; today the surface names a generation code and implies waiting will help when it
may not.

**Promises:**
1. When codex routes are stale and the daemon has no attached client (detectable? investigate —
   otherwise: when stale persists past the recovery envelope), guidance distinguishes "waiting for
   the Codex app to reconnect" from transient transition copy, en + zh-CN.
2. The release notes / README document the Desktop attach-at-launch precondition and the relaunch
   command.

**Budgets**: size 2; concepts: at most one new guidance kind. Tests: happy path + rendered-state check.

## Dispatch note (2026-08-16)

Dispatched to swe3, queued behind emb-62. Scope contract: src/gateway/dashboard-model.ts, dashboard copy files (en/zh-CN), docs/README release-notes touchpoints, test/**.

## Landing state (2026-08-16)

Accepted: PM diff read (honest-conjunction detector: stale + CODEX_ROUTE_STALE + aged >=2s past the
1.75s burst + same-host healthy/compatible connector; weaker evidence keeps generic copy), gate
762/762, budget 135/200, one declared guidance concept. Committed locally behind emb-62; both go
public together after the release drill — which will render this exact guidance live during the
slow-reattach window, making the drill the experiential check too.
