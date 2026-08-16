---
id: emb-57
title: Version semantics: prerelease identifiers and 0.x majors
kind: normal
size: 2
status: draft
updated: 2026-08-16
---

## Binding

**Why**: `VERSION_PATTERN` (compatibility.ts:62) rejects prerelease versions outright, so a provider shipping only `-rc` builds (DeepSeek: six versions in four days, all prerelease) can never rise above `incompatible` — and `versionMajor` treats all 0.x as one major, though 0.x minors are breaking under semver (Codex at 0.147.0 already sits in this trap).

**Promises:**
1. A written design decision first, in the ticket: what tier can a prerelease build ever reach? (PM lean: never above monitor-only — the evidence honestly says "unstable build"; but the decision must be explicit, not emergent from a regex.)
2. `VERSION_PATTERN` handling extended per that decision, with the tier rules updated and tested.
3. 0.x major semantics defined: minor bumps within 0.x are treated as major-equivalent for ladder purposes, with existing certified sets unaffected.
4. Existing Claude/Codex attestations behave byte-identically.

**Budgets**: size 2; concepts: zero new user-facing. Tests: the promises.

**Non-goals**: no new surfaces; no changes to probe sets.

## Background

From the emb-54 report §3: certified-set entries are themselves pattern-checked (compatibility.ts:208) and the inventory must be nonempty (:207) — both interact with any prerelease decision.