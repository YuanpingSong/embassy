---
id: emb-54
title: DeepSeek harness as a third Embassy provider — integration shape
kind: investigation
size: 2
status: draft
release: v1.6
updated: 2026-08-15
---

## Binding

**Why**: DeepSeek released their agent harness (github.com/deepseek-ai/deepseek-harness) and the founder wants to know whether Embassy can integrate it as a third provider, and in what form. Embassy's architecture is provider-shaped (Claude sessions, Codex app-server), and the v1.5 evidence ladder was designed precisely for onboarding unknown providers: read probes earn monitor-only, write attestation earns more.

**Deliverable** — a report, not code:
1. What the harness actually is: process model (daemon / CLI / server), session-and-thread model, control surface (API, socket, files), auth, versioning cadence.
2. Which Embassy provider seams it maps onto (discovery, route establishment, turn start/steer, delivery receipts, journal events) — and where it doesn't fit.
3. The monitor-only-first onboarding path under the evidence ladder: what read probes are possible today, and what a write-attestation probe would look like (ties directly to emb-49's design).
4. Ranked integration shapes with size estimates, and the smallest shippable slice (expected: monitor-only visibility first; write authority later, never without founder eyes).
5. Open risks: license, API stability, local-vs-cloud split, token/cost model.

**Budgets**: size 2, investigation — read-only against the public repo and Embassy source. A local install is permitted only if cheap and safe; nothing it does may touch the running broker.

**Non-goals**: no integration code; no provider-registry changes; no commitment that integration lands in v1.6 — the report prices that decision.

## Background (hypotheses — re-verify against current code)

The v1.5 compat rearchitecture ("detect, don't predict") should make a third provider mostly additive: providers enter quarantine/monitor-only by default and only earn authority through evidence. If the harness exposes a controllable local surface, the Codex app-server integration is likely the closest template.
