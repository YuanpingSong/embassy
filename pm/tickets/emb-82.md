---
id: emb-82
title: v1.9 Pillar 2 — universal shell peer ingress (PM seat in Cursor)
kind: normal
size: 5
status: landed
release: v1.9.0
updated: 2026-08-17
---

## Binding

*(Reconstructed record — the original ticket file was lost to session
context pressure during the v1.9 push; anchor is commit 30fc46a "Add
universal shell peer ingress".)*

**Why**: Founder charter — a PM seat usable from Cursor (or any shell
agent). Founder budget: 300–500 lines.

**Premise falsified mid-flight (recorded)**: the design assumed a stable
process identity (PID-anchored principal). Empirically falsified in
Cursor: every tool call runs in a fresh shell — no env or PID stability.
Amendment ruled: principal = alias + token supplied via `--token-stdin`;
PID dropped entirely.

**Shape as ruled and landed**: provider `peer`, alias prefix `peer-`;
token hash-only persistence (raw token never persisted or logged);
`embassy await` 30s long-poll for inbound; PEER_NOT_AWAITING when no
awaiter; flush-before-receipt ordering. Landed at 30fc46a (40 files,
+1368/-131 including tests, docs, and skill packaging). Shipped in
v1.9.0.
