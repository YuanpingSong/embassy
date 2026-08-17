---
id: emb-85
title: v2→v3 converter emits state the same-version loader rejects (host identity never reconciled)
kind: bug
size: 2
status: dispatched
release: v1.9.3
updated: 2026-08-17
---

## Binding

**Why**: Discovered live on m5dev during emb-84 triage — the first real
machine to walk the designed v2→v3 upgrade path. Sequence: 1.9.2 `serve`
correctly refused with GATEWAY_STATE_CONVERSION_REQUIRED; `embassy
convert-state-v2-to-v3` reported success (backup written); the very next
`serve` failed CORRUPT_GATEWAY_STATE. The designed upgrade path bricks the
gateway with no recovery command.

**Root cause (verified from the artifact + source)**: m5dev's v2 state was
written by 1.7.1 under `DEFAULT_HOST_ID = "this-mac"` (cli.ts:31). v1.9's
nodes.json gave the machine host identity `m5dev`. The converter carries
routes verbatim — `dsh-main@this-mac` / `grok-main@this-mac` with
`binding.hostId: "this-mac"` — and never reconciles host identity, so
`routeModeMatchesHost` (store.ts:2660 bounds check) rejects the converter's
own output. Evidence preserved on m5dev:
`/tmp/gateway-state.v3-corrupt-emb85.json` (rejected output) and
`/tmp/gateway-state.v2-input-emb85.json` (input); the in-place
`gateway-state.v2.backup.json` also stands.

**Deliverable**: Converter reconciles route host identity with the
effective (nodes.json-era) hostId. Note dsh-main/grok-main are
config-declared lazy boot routes — dropping them at conversion (boot
re-registers from config) may be the simplest correct mechanism; engineer
owns the choice. HARD REQUIREMENT: a machine already holding rejected
converter output must be recoverable with product commands only (e.g. the
converter re-runs from its own `.v2.backup` when the current state file
fails strict v3 validation; backup-first as always). PM cannot hand-edit
remote state — the product must dig itself out.

**Recorded, not in scope**: the founder's real node name `this-mac`
collides with DEFAULT_HOST_ID — naming footgun flagged for a future
ruling.

**Caps**: size 2, net cap +120 src lines, tests uncapped within reason,
same lane as emb-84, ships as v1.9.3.
