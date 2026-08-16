---
id: emb-60
title: Write gate keys off write-covered evidence (49C) — FOUNDER EYES
kind: sensitive
size: 3
status: draft
updated: 2026-08-16
---

## Binding — HELD FOR FOUNDER

**Why**: today write authority is release-pinned by exact version string (CODEX_APP_SERVER_WRITABLE_VERSIONS = ["0.147.0"]) in a gate independent of the evidence ladder — so every Codex minor bump means monitor-only until an Embassy release ships. This ticket makes the gate accept write-covered same-major evidence, which is the entire point of the emb-49 track.

**Preconditions**: emb-58 and emb-59 landed; emb-59 has produced real-machine evidence including measured token cost; founder has reviewed that evidence and this ticket's diff. Rule adopted from the design: write coverage raises authority within a tier, never across tiers, never for prerelease or unknown-version builds.

**Budgets**: size 3, sensitive (changes a fail-closed write gate); tests: coverage + adversarial fixtures + the emb-57 interaction cases.

**Non-goals**: no tier changes; no prerelease admission (emb-57 owns that decision).
