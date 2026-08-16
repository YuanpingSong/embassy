---
id: emb-76
title: v1.8 stage 1-3 — conformance fixtures + stateless Codex behind the seam
kind: normal
size: 5
status: dispatched
release: v1.8
updated: 2026-08-16
---

## Binding

**Why**: stages 1-3 of the accepted emb-73 design's landing plan — all
test-only or inactive-behind-seam, so they run in parallel with swe3's
emb-75 (v1.7.1) without touching its window.

**Deliverable**: (1) frozen normalized old-behavior golden fixtures,
preclassified HOLD / INTENTIONAL CHANGE / DELETE per the design's public
contract section; (2) the test-only Codex conformance suite (initialize,
experimental flag, resume/excludeTurns/empty history, busy/approval,
start/steer, bounds, fast terminals, pre/post-write failure phases, no
replay after uncertainty); (3) the stateless Codex transport built INACTIVE
behind the current seam — per-operation opener retaining every trust
attestation (install/socket/path/UID/mode/symlink/architecture, proxy env,
process-group, before/after), record-only registration shape, exact
correlation, bounded reply, ambiguous-on-armed-loss semantics.

**Budgets**: size 5, R3 (design's own figure: ≤1,100 source + ≤650 tests for
stage 3; stages 1-2 are test-only). Window: NEW files + the minimal inert
seam hook; zero overlap with emb-75's window; remainder-map contest early if
the design's figures prove wrong. Activation (stage 4, R4, state v3) is a
separate ticket after v1.7.1 ships.
