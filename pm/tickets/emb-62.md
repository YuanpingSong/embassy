---
id: emb-62
title: Connector recovery re-arms the endpoint transition — no finite retry cliff
kind: normal
size: 3
status: dispatched
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: the emb-52 live drill proved the real-world wedge: transition recovery is a finite retry
burst (3-attempt endpointActivationRetry + bounded backoff), and a daemon whose client (ChatGPT
Desktop) reattaches slower than the envelope exhausts it — after which only register-codex or a
broker restart recovers. Design law 1 states the fix: recovery must verify current reality on a
live signal, not echo a past event a bounded number of times. **Blocks the v1.6 "survives
restarts" headline claim.**

**Promises:**
1. When the codex connector transitions back to healthy (or thread availability is newly observed),
   any pending/exhausted endpoint transition re-arms and re-attempts re-anchor — unconditionally,
   like a boot.
2. The sticky selector-claim (review F5 body) releases on controller-side activation failure so the
   retained channel reopens for the generation.
3. No retry storm: re-arm is edge-triggered on connector-health transition, not timer-spun.
4. The emb-52 drill scenario (daemon restart + slow Desktop reattach + no broker restart) passes
   live, end to end, as the acceptance test.

**Budgets**: size 3; concepts: 0 user-facing. Tests: the promises + the live drill as manual check.

**Non-goals**: no Desktop-side behavior (Embassy cannot fix attach-at-launch; emb-63 renders it).

## Dispatch note (2026-08-16)

Dispatched to swe3 ahead of the v1.7 queue: v1.6 headline blocker, same subsystem as emb-52 (warm context). Scope contract: src/gateway/providers.ts, src/gateway/service.ts, test/**; the emb-52 live drill is the acceptance test and the PM runs it at landing.
