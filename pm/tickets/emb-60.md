---
id: emb-60
title: Write gate keys off write-covered evidence (49C) — FOUNDER EYES
kind: sensitive
size: 3
status: draft
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: today write authority is release-pinned by exact version string (CODEX_APP_SERVER_WRITABLE_VERSIONS = ["0.147.0"]) in a gate independent of the evidence ladder — so every Codex minor bump means monitor-only until an Embassy release ships. This ticket makes the gate accept write-covered same-major evidence, which is the entire point of the emb-49 track.

**Preconditions (amended by founder ruling, 2026-08-16)**: emb-58 and emb-59 landed, and emb-59's probe passing on this machine. Founder direction verbatim: "any token consumption should be immaterial, bias toward building and shipping if no other issues" — the founder-eyes precondition is satisfied in advance; the PM landing review remains the gate, and anything unexpected in the diff escalates rather than ships. Rule adopted from the design: write coverage raises authority within a tier, never across tiers, never for prerelease or unknown-version builds.

**Budgets**: size 3, sensitive (changes a fail-closed write gate); tests: coverage + adversarial fixtures + the emb-57 interaction cases.

**Non-goals**: no tier changes; no prerelease admission (emb-57 owns that decision).
