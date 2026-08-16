---
id: emb-71
title: De-ceremony 66B — Claude boundary-safe version decision + offline compatibility core
kind: normal
size: 3
status: landed
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

## Phase 1 LANDED (2026-08-16)

swe3 SLICE READY: base bf56bee verified, patch frozen (SHA-256 e16b5491…),
+400/-0, exactly one new file (test/acp-protocol-core.test.ts), window
honored (no source, no existing tests, no emb-70 seam). Smell-check clean
(fake child + in-memory streams only, no timers/network/env). 11 focused
tests with explicit non-duplication ownership vs the emb-67 unit suite;
notable coverage: closed-child late same-ID frames cannot settle a new
connection; delivered receipts cannot be downgraded by later process death;
no replay after uncertainty (exactly one wire write per prompt); cross-
session contamination of the 64 KiB bound ruled out. PM gate: isolated
worktree, check 858 pass / 0 fail (counts from output). Phase 2 remains
HELD on emb-70.

## Phase 2 LANDED — ticket CLOSED (2026-08-16)

Decision rule fired on evidence, DELETE branch: swe3 first proved the landed
reader accepts a syntactically valid but unverified version record (and an
absent field) through parse → discovery → registration → one transport
write, THEN deleted the entire bounded `claude --version` subprocess
(runner, scrubbed env, timeout/caps, banner parser, conflict state, and the
before/after generation comparison whose only purpose was the subprocess's
time window). Executable/launcher attestation remains fail-closed; version
= attested official-launcher target leaf, else "unknown"; no metadata case
refuses boot (executable-evidence test). Support matrix landed at
support/provider-support-matrix.json (four providers, Grok artifact
refreshed from the ACP registry: @xai-official/grok@1.0.5 agent stdio);
CI parses it; a recursive grep test proves runtime never references it.
Accounting: source +11/−205 (≤300), tests+data 671 (≤700), net −343, patch
SHA cc68c04a…. PM gate: isolated worktree ON CURRENT TIP 8bf3d03 (clean
apply = trivial rebase), check 752 pass / 0 fail (761→752 = −9 net tests).
