---
id: emb-74
title: v1.9 — Embassy is a network: SSH broker federation + universal peer ingress
kind: design
size: 8
status: draft
release: v1.9
updated: 2026-08-16
---

## Binding

**Why**: founder direction (2026-08-16). The founder's machines (workstations
+ a dev MacBook for macOS UI testing) are all SSH-reachable and should be
nodes in one agent network: agents talk regardless of machine, with a single
pane of glass to see and manage every agent. Separately: a PM seat inside
Cursor (Claude Fable via Cursor Ultra) must be able to drive engineers —
generalized, not Cursor-specific.

**Pillar 1 — SSH broker federation (no center).** One broker per machine;
each remains sole authority for its local OS boundary (attestation never
travels). Broker-to-broker transport = the ACP-client pattern exactly: a
spawn-owned subprocess over stdio, spawn line `ssh <node> embassy
peer-stdio`; SSH supplies authn/encryption/liveness — zero new auth
machinery. Remote brokers surface as near-providers: capability handshake at
connect, routes addressed by the existing `alias@host` grammar (shipped
since v1.0; allowedHosts config exists), honest stale rows on tunnel loss.
Delivery: destination-owned durable queue; origin holds the body until the
peer receipt confirms handoff; pipe death mid-handoff settles UNKNOWN, never
replayed (ambiguity law unchanged). Consent edges already carry host on both
endpoints — cross-machine pairing is the same explicit edge. Single pane of
glass = the live dashboard aggregating peered brokers' metadata-only
snapshots; read-only aggregation first, cross-host mutations a separate
later decision. Node inventory: static config (auditable), not discovery.

**Pillar 2 — universal peer ingress ("if you can run a shell, you can be a
peer").** `embassy register-peer` mints an identity bound to the OS boundary
(UID + PID + env-token reply attestation, the CODEX_THREAD_ID pattern);
outbound = existing CLI; inbound = per-peer durable mailbox drained by a
blocking `embassy await` (pull model; generalizes v1.2's native-mailbox
write). This yields the Cursor PM seat on Cursor's inference budget, and
every future shell-capable harness for free. Interim (zero code): the
`claude` CLI inside Cursor's terminal is a full peer today, but bills
Anthropic rather than Cursor Ultra.

**Sequencing**: after v1.8 (emb-73) — federating the slimmed core means
peer-stdio is another few-hundred-line client against existing conformance
suites; federating 38k would spread the bloat. Design investigation
dispatches post-v1.8 design acceptance.

**Founder questions to settle at design time (not now)**: (1) static node
config format/location; (2) whether the single pane needs cross-host
mutations in its first release (PM rec: no — read-only aggregation +
local mutations); (3) pull-based receipt acceptable for PM seats (PM rec:
yes — matches turn-based PM rhythm).

**Budgets**: size 8 (design). Implementation priced from the design's
remainder maps.
