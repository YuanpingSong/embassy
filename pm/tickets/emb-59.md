---
id: emb-59
title: Bounded Codex write probe (49B): records evidence, unlocks nothing
kind: sensitive
size: 5
status: draft
updated: 2026-08-16
---

## Binding — HELD FOR FOUNDER (see emb-49 acceptance ruling)

**Founder question this ticket waits on**: the probe thread is created in the user's own Codex and archive likely moves rather than erases (1,302 entries in ~/.codex/archived_sessions on this machine) — is one durable archived probe thread per Codex version acceptable? If no, this shape is unshippable and write authority stays release-pinned.

**Why**: a passing bounded write probe is the only evidence class that can legitimately cover turn/start authority (design law 3). This ticket produces and records that evidence — and deliberately does not unlock anything.

**Promises** (from emb-49 report §§1-6, which are the spec): thread/start against the Desktop App Server through the existing attach-only proxy; six machine-checked isolation assertions (fresh id, owned 0700 cwd, fence declared, fence observed, cwd unchanged, cleanup confirmed); model pin CODEX_PROBE_MODEL_PREFERENCE=["gpt-5.6-luna"] + effort minimal as reviewed source constants, verified via model/rerouted (pin requested is not pin honored); rate-limit courtesy check before spending; one attempt per (version, endpointGeneration); never-throw discipline (boot catch at service.ts:966 kills the whole broker); failures are safe codes + alerts, never failed probes; token cost recorded from thread/tokenUsage/updated.

**Budgets**: size 5, sensitive (first creating method in the allowlist: 6→9 — SECURITY.md-relevant); concepts: zero beyond emb-58's. Tests: coverage + adversarial fixtures (sensitive default).

**Non-goals**: no authority change (emb-60); nothing runs before founder ruling on the artifact question; resolve report unknowns #1/#2/#5/#7 (offline schema generation) before coding.
