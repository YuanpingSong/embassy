---
id: emb-49
title: Codex write-attestation probe — design pass
kind: investigation
size: 2
status: draft
release: v1.6
updated: 2026-08-15
---

## Binding

**Why**: under the v1.5 evidence ladder, Codex sits monitor-only because read probes never earn turn/start authority (design law 3: evidence must cover the authority it grants). A bounded write-attestation probe — a real turn/start against a disposable thread — is the only evidence class that could legitimately raise Codex to writable.

**Deliverable**: a design report, not code. It must answer: how a disposable thread is created and provably isolated; what the bounded probe writes and how the blast radius is capped; what evidence the probe records and its shelf life (probe evidence goes stale against moving versions); how failure quarantines (provider-local, never boot-fatal); and what the ladder transition looks like in the journal and on the dashboard.

**Probe cost requirement (founder, 2026-08-15)**: the probe turn itself must pin the provider's cheapest available model at the lowest reasoning effort — today that is GPT-5.6 Luna at minimal effort — so attestation never spends user tokens beyond the minimum. The design must state how the model/effort pin works and how the probe fails safe (no attestation, no retry storm) if the pin is unavailable.

**Budgets**: size 2, investigation — read-only against the codebase; any live probing happens only against a disposable thread and only if the design pass says it's safe, otherwise it stays on paper.

**Non-goals**: no probes against real user threads; no implementation ships from this ticket itself. Founder pre-authorization (2026-08-15): if the design yields good evidence of a concrete implementation that solves the Codex version-certification gap, the implementation is priced as its own ticket and may fold into v1.6.
