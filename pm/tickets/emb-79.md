---
id: emb-79
title: v1.8 stages 5-8 — four refactor-down lanes to the 18,850 target
kind: normal
size: 8
status: landed
release: v1.8
updated: 2026-08-17
---

## Binding

**Why**: the accepted emb-73 design's remaining stages after the emb-77
summit. Pinned start 26,421; hard target ≤18,850; required net reduction
≥7,571 (engineer's overlap-free floors total ≥7,636 → ≤18,785 with 65
contingency).

**Four lanes (floors)**: (1) state/message kernel + service/watch ≥1,650
(preserving hostile v3 decoder, poison law, attempt phases,
first-terminal-wins, restart taxonomy, FIFO/parallel/STEER, receipt
ordering, B retry snapshot); (2) Claude wire/helper ≥2,307, final ≤3,000
(preserving UUID identity, protocol 1, exact artifact proofs, immutable
prepared bytes, authorize→one-shot perform, ambiguity, crash isolation);
(3) provider facades + ACP ≥1,200, final ≤2,400 (evidence-phase sharing
only — no universal provider protocol); (4) control/CLI/config/boot/doctor
≥2,426, final ≤2,500 (one method algebra, one hostile decoder each way,
preserved wire/intents/redaction/schema-2/en-zh). Plus compatibility.ts
deletion (+53 margin).

**Cap (self-bound, granted)**: ≤3,500 added src, ≤3,500 added tests,
deletions unbounded, net reduction ≥7,571, post-slice core ≤18,850 by the
pinned command, no metric evasion.

**Bindings ruled**: R1 CONFIRMED — Claude launcher/version acquisition,
EMBASSY_CLAUDE_BIN, and the official-vs-Homebrew rule DELETED (proof follows
use: validate only consumed artifacts; missing registry =
CLAUDE_REGISTRY_UNAVAILABLE degradation, never boot-blocking; executes
doctrine edit #6; dissolves emb-78 claude-half + homebrew findings; README
prerequisites paragraph must be updated by this slice's docs pass).
R2 CONFIRMED — doctor gains managed_layout_missing (layout absent + bounded
socket-holder evidence only — the m5dev ghost); plain absence stays
MANAGED_CODEX_UNAVAILABLE; observation_stale reachable; no disclosure.

**Holds ratified**: emb-77 B retry state final; ENDPOINT_GENERATION_CHANGED
= operation-local evidence; observation stays display-only; byte-held Codex
contract + conformance; TMPDIR=/tmp gates; live drill remains PM-side at
release. Freeze each seam before shared-file integration.

## LANDED (2026-08-17) — v1.8 core complete

SLICE READY at 5248f77 on exact base eddf8d3: 54 paths, +4,015/−13,491 =
net −9,476. PINNED CORE 26,421 → 18,595 — required floor and final ceiling
both cleared by 255. Caps honored with margin (src +2,900/3,500; tests
+1,064/3,500). R1 executed (launcher/version authority deleted;
compatibility.ts gone); R2 executed (managed_layout_missing display-only).
368-line Claude wire conformance oracle added (SHA fa4863b6…). PM gate:
TMPDIR=/tmp isolated worktree, check 518/0, soak 1/0 with every accepted
message terminal exactly once; core verified by the pinned command; Codex
contract byte-identical. All four lanes delivered their floors. v1.8 code
is COMPLETE at 18,595 — under the founder 20k budget by 1,405 and under the
design target by 255. Remaining: PM live drill (state conversion,
split-brain matrix, restart taxonomy) → v1.8.0 release.
