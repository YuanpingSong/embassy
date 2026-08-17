---
id: emb-81
title: v1.9 Pillar 1 — SSH federation (workstations as nodes)
kind: normal
size: 8
status: landed
release: v1.9.0
updated: 2026-08-17
---

## Binding

*(Reconstructed record — the original ticket file was lost to session
context pressure during the v1.9 push; anchors are commits d83bb76
(partial) and 6cb4308 (full), dispatch commit dd6e043.)*

**Why**: Founder charter — SSH-reachable machines become Embassy nodes;
single pane of glass. Founder budget ruling, verbatim intent: "I know it's
fully possible to make a 5,000-line version... We don't want that" —
~500 lines core.

**Shape as ruled and landed**: `<stateDir>/nodes.json`
`{"version":1,"host":...,"nodes":[...]}`; peer transport spawns
`/usr/bin/ssh -T -o BatchMode=yes -o ClearAllForwardings=yes <node>
embassy peer-stdio`; exactly 3 methods (initialize / catalog-get /
handoff) with 32KiB request and 256KiB catalog caps; remote routes mirror
locally as registrationMode `federated_peer` with opaque `reg_*` refs;
mixed-edge owner = lexicographically smaller endpoint host;
destination-durable-accept = delivered (PEER_HANDOFF_CONFIRMED); loss
after arm = ambiguous PEER_HANDOFF_OUTCOME_UNKNOWN, never replayed;
one-hop mesh only (no transitive routing).

**Landing**: partial (all seams except the operator-gated durable
boundary) at d83bb76, completion (catalog export, atomic reconciliation,
destination-owned handoff) at 6cb4308, +470/-31 over the partial; gate
546/0 + soak on full patch SHA f5065aec…. Shipped in v1.9.0.
