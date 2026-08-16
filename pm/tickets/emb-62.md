---
id: emb-62
title: Connector recovery re-arms the endpoint transition — no finite retry cliff
kind: normal
size: 3
status: landed
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

## Concurrent-seam partition (2026-08-16, PM-brokered)

main (emb-59) reserves: codex-app-server.ts entirely; in providers.ts only imports/constants for
the write-probe result, LocalCodexGatewayProvider compatibility-probe state,
runCompatibilityProbes/runCompatibilityProbesFor, and an owned-cwd helper adjacent; in service.ts
only the GatewayProviderAdapter compatibility-probe interface/context and
runAutomaticCompatibilityProbesLocked. swe3 (emb-62) owns: route recovery, endpoint-transition,
dispatch, and delivery-settlement neighborhoods. Neither enters the other's symbols; any collision
stops and contests through the PM. Landing order decided by the PM at handoff time.

## Landing state (2026-08-16)

Slice accepted: PM full-diff read (36 src lines, all guards verified), authoritative gate 761/761
(verdict read as value), budget 120/500. Code committed locally on dev; PUBLIC PUSH AND status:
landed WAIT on promise 4 — the live drill — which is deliberately queued to release time, behind
emb-59's handoff, so the daemon/Desktop restart it requires never again interrupts a working
engineer. One drill validates the whole v1.6 fix stack.

## Shipped in v1.6.0 (2026-08-16)

Tagged on public main d22ddf0; pipeline-verified tarball published as agent-embassy@1.6.0 (npm trusted publishing, provenance). Drill proof: after a daemon restart the codex route re-anchored WITHOUT a broker restart, before ChatGPT Desktop reattached; the published-broker boot then re-anchored both codex routes unaided.
