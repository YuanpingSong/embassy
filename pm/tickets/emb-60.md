---
id: emb-60
title: Write gate keys off write-covered evidence (49C) — FOUNDER EYES
kind: sensitive
size: 3
status: landed
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: today write authority is release-pinned by exact version string (CODEX_APP_SERVER_WRITABLE_VERSIONS = ["0.147.0"]) in a gate independent of the evidence ladder — so every Codex minor bump means monitor-only until an Embassy release ships. This ticket makes the gate accept write-covered same-major evidence, which is the entire point of the emb-49 track.

**Preconditions (amended by founder ruling, 2026-08-16)**: emb-58 and emb-59 landed, and emb-59's probe passing on this machine. Founder direction verbatim: "any token consumption should be immaterial, bias toward building and shipping if no other issues" — the founder-eyes precondition is satisfied in advance; the PM landing review remains the gate, and anything unexpected in the diff escalates rather than ships. Rule adopted from the design: write coverage raises authority within a tier, never across tiers, never for prerelease or unknown-version builds.

**Budgets**: size 3, sensitive (changes a fail-closed write gate); tests: coverage + adversarial fixtures + the emb-57 interaction cases.

**Non-goals**: no tier changes; no prerelease admission (emb-57 owns that decision).

## Two concept rulings (2026-08-16)

**1. F10 AUTHORIZED — code and shape.** New safe code CODEX_WRITE_PROBE_CAPACITY_EXHAUSTED
(pattern-valid; an alert stream that misstates its cause is a law-6 wart, and this ticket is where
F10 was explicitly deferred). Decline-slot reshape authorized: the 16 never-evict slots count
CHARGED attempts only (threads created / tokens spent — the artifacts the founder's ratified bound
governs); zero-spend declines (rate-limit, pin-unavailable) occupy one bounded most-recent-decline
slot and may re-attempt on a later occasion, since nothing was spent and nothing was created. This
also fixes the latent class where a cached zero-spend decline blocked a founder pin fix from taking
effect until generation change.

**2. NO new journal/activity action in emb-60 — confirmed.** gatewayActivityActions is a closed
PERSISTED union; widening it is the downgrade-fatal class emb-58 was specifically designed around,
and the activity validator's tolerance was never verified (design unknown #5). The authority
transition is not silent without it: the attestation is durable evidence, the writes-covered pill
renders live, and route behavior changes observably. If a timeline row is ever wanted it is its own
ticket, validator-verified first. emb-49's mention is superseded by this ruling.

## Landed as v1.6.1 (2026-08-16)

PM landing gate: lane byte-identical to frozen a45127a on declared base 6e41b9a
(patch cmp exact). Diff review at the authority seam — CLEAN against both
rulings: two-factor gate (durable write-covered attestation AND
current-generation process-local pass) enforced at all three seams
(attestation acceptance, route creation/replacement, endpoint-refresh
reanchor), each with its own regression test; charged-only 16-slot never-evict
bound with one retryable zero-spend decline slot (model-pin, rate-limit — both
pre-turn); honest CODEX_WRITE_PROBE_CAPACITY_EXHAUSTED; zero new persisted
concepts (durable factor rides the already-persisted attestation probes list);
prerelease fenced (0.147.1-rc.1 regression test). Isolated worktree gate:
check 835 pass / 0 fail, soak 1 pass / 0 fail (counts from output).

Noted tightening (accepted, recorded): monitor-only providers now reject
selectRoute outright (CODEX_PROVIDER_UNAVAILABLE, zero transports) instead of
accepting routes whose every dispatch fails — more honest than the prior
select-then-fail; consistent with the shipped observation-only posture.

Cherry-picked to dev as 625e45c; shipped in v1.6.1.
