---
id: emb-71
title: De-ceremony 66B — Claude boundary-safe version decision + offline compatibility core
kind: normal
size: 3
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: batch 66B of the accepted emb-66 design — the riskiest correctness
seam (E5/R4 in the design's rating): what happens to the bounded
`claude --version` read and the Claude registry version field, plus the
first layer of the offline compatibility process.

**Deliverable**: (1) the CONVERT decision for Claude version reads, resolved
by offline interop evidence: prefer DELETING the bounded subprocess and using
the attested launcher leaf/`unknown` if interop proves Claude accepts the
required registry field; retain the bounded subprocess (exact executable,
scrubbed env, timeout/output cap, before/after generation) only if proven
necessary. Failure/disagreement yields unknown metadata, never boot/routing
refusal. Registry `version` becomes syntax-bounded unverified metadata;
`peerProtocol: 1` stays strict wire grammar; EMBASSY_ADVERTISEMENT_VERSION
stays exact-owned provenance. (2) The offline fake-protocol-core test layer
from the design's process (framing, correlation, every terminal/error,
unknown requests, permission denial, cancel races, wrong-generation
responses, subprocess death at every write phase, no replay after
uncertainty). (3) The release-owned support matrix file — never imported at
runtime.

**Budgets**: E5/R4 effort rating, size 3 (bounded ≤300 source + ≤700
test/workflow). Sequenced after emb-70 lands.

## Phase split (PM, 2026-08-16)

Phase 1 (DISPATCHED to swe3 immediately after emb-67 landed): deliverable (2)
only — the offline ACP protocol-core conformance suite as NEW test files
against the landed acp-client, zero overlap with emb-70's authority seam
(main cutting it concurrently). E3, new-files-only window.
Phase 2 (HELD until emb-70 lands): deliverables (1) and (3) — the Claude
version-read decision needs the post-cutover seam to exist.
