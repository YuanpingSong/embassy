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

**Budgets**: size 2, investigation — read-only against the codebase; any live probing happens only against a disposable thread and only if the design pass says it's safe, otherwise it stays on paper.

**Non-goals**: no implementation; no probes against real user threads; no ladder changes shipped from this ticket.
