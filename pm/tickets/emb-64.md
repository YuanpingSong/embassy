---
id: emb-64
title: Published no-write claims must survive the write probe (docs truth sweep)
kind: docs
size: 2
status: dispatched
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: README.md (:39, :236), SECURITY.md (:185, :350), docs/CONFIGURATION.md (:90),
docs/DASHBOARD.md (:90), docs/GATEWAY-ARCHITECTURE.md (:37, :773, :1053) and their zh-CN mirrors
state that Codex's bounded pre-write reads "never invoke turn/start." Once emb-59 lands, the
compatibility path MAY invoke turn/start against a broker-created disposable thread and leave an
archived artifact. Publishing a falsified claim is a design-law-6 release blocker for v1.6.

**Promises:**
1. Every listed surface (~10 files x 2 languages) states the new truth precisely: ordinary reads
   remain read-only; the OPTIONAL write-attestation probe may create one disposable broker-owned
   thread (bounded, fenced, archived, cleanup-confirmed, zero user-thread contact), currently
   shipping in zero-spend fail-safe until the model pin resolves.
2. No surviving "never turn/start" claim anywhere (grep-proven, both languages).
3. CHANGELOG [Unreleased] records the probe and its fail-safe state.

**Budgets**: docs/copy, priced by surfaces: ~20 surfaces. Tests: none new (the suite's copy
contracts must stay green). Proofread, not code-reviewed.

**Scope contract**: README.md, README.zh-CN.md, SECURITY.md (+ zh mirror if present),
docs/CONFIGURATION.md, docs/DASHBOARD.md, docs/GATEWAY-ARCHITECTURE.md (+ zh mirrors),
CHANGELOG.md. No source files.

## Background

Found by the emb-59 taste review (item 2). The claims are true at HEAD and false after emb-59
lands — sequence this ticket to land WITH or immediately after emb-59, before the v1.6 tag.

## Scope expansion (2026-08-16, from the adversarial review F1)

Third falsified claim added: SECURITY.md:203-205 "Embassy exposes no archive, deletion, shell, ...
method" — thread/archive is now allowlisted (probe-only). State the probe-only containment
precisely. ORDERING REQUIREMENT: this ticket lands adjacent to emb-59 in one sequence, both before
the v1.6 tag.
