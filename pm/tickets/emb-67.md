---
id: emb-67
title: ACP client transport — minimal, ceremony-free, spawn-owned
kind: normal
size: 5
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder ruling emb-61 R1 (ACP is the transport for new providers)
plus the emb-65 gate verdict (ACP sufficient; spec mandates the receipt
contract). Per emb-65 PM ruling A, this client serves NEW providers whose
agent sessions Embassy owns — it does not touch the existing Codex
app-server or Claude native-peer transports.

**Deliverable**: one ACP client implementing exactly the emb-65 §V5 minimal
surface. Outbound: `initialize` (protocolVersion 1; clientCapabilities all
false for fs/terminal; store the returned protocolVersion +
agentCapabilities per connection as the sole capability truth),
`session/new`, `session/prompt` (the delivery receipt — all five StopReasons
mapped uncollapsed onto Embassy terminal states), `session/cancel`;
`authenticate` only on demand, never touching credential material.
Capability-gated: `session/list` / `session/resume` / `session/load`.
Inbound handlers: `session/update` (consume `agent_message_chunk`, ignore
all other variants silently) and `session/request_permission` — mandatory,
ungated, the #1 hang risk: always answer with cancelled/deny, never
auto-allow. Reply -32601 to undeclared inbound requests. Error surfacing per
emb-65 §V5 table; subprocess death with a prompt outstanding settles as the
new UNKNOWN terminal state (not delivered, not failed). Subprocess
lifecycle: spawn from a per-provider launch spec (npx line, binary+sha256,
or local-checkout command), own the child, kill on close.

**Explicitly out of scope**: probes, attestation, certification, version
gates of any kind (emb-61 R2); any change to existing Codex/Claude
transports; per-turn model/effort control (inherent ACP limit — session-level
config only).

**Budgets**: size 5. New files preferred; the seam into routing lands with
emb-68.
