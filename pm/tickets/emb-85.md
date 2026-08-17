---
id: emb-85
title: v2→v3 converter emits state the same-version loader rejects (host identity never reconciled)
kind: bug
size: 2
status: landed
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

## Gate rulings (v1 freeze, 2026-08-17) — HOLD

Adversarial review reproduced a blocking defect; taste passed the diff
but demanded record corrections. Both incorporated:

**H1 (BLOCKING, reproduced end-to-end)**: the recovery path's guards
(zero counters, no references) are evaluated against the v2 BACKUP while
the document actually overwritten is the INSTALLED v3 — which is never
inspected. Ordinary sequence: migrate v2→v3 before federation (attested
host = legacy default), broker accumulates real state, user adopts
nodes.json with a real host name, bounds check rejects, user re-runs the
converter as documented → live v3 silently reverted to the pre-migration
snapshot; a reproduced ARMED message vanished; CLI printed ok:true
indistinguishable from normal success. Violates the standing invariant:
armed/ambiguous state is never silently dropped. Root cause: sourcing
from the backup bypasses GATEWAY_STATE_CONVERSION_ALREADY_APPLIED
(state-v2-to-v3.ts:492-497) with nothing replacing it. Binding correction
invariant: **guards must evaluate the document being mutated, and
accumulated state must survive recovery or conversion must refuse** —
mechanism is the engineer's (in-place reconciliation of the installed v3
is consistent with the no-laundering stance); backup-first applies to the
v3 before any recovery mutation.

**N1**: host-incompatible v3 with NO v2 backup (fresh 1.9.x install that
later adopts a real host name — arguably the more common case) surfaces a
raw ENOENT mapped to INTERNAL_ERROR. Must become a typed conversionError.

**Record corrections (taste)**: the rejecter is assertConfiguredBounds
(store.ts:2653-2661); routeModeMatchesHost is defined at store.ts:205 —
the original cite was loose. The recovery trigger fires on state that
PASSES strict v3 schema validation and is rejected only by the bounds
check — the engineer deliberately inverted this ticket's literal wording
("fails strict v3 validation") and the code is right; implementing the
ticket verbatim would have produced a recovery that never fires. Honest
scope of the hard requirement: recovery covers states whose foreign
routes are exactly the zero-history unreferenced config-declared lazy
routes; anything else refuses with a clear error rather than recovering —
accepted. CORRUPT_GATEWAY_STATE now carries two operator meanings
(malformed vs reconciliation-refused) — accepted under zero-new-concepts;
attach to the parked naming ruling. The "this-mac" literal gained a
fourth copy (state-v2-to-v3.ts:219) — attach as evidence to the parked
naming footgun.

**Correction-bundle caps**: additional net ≤ +60 src over the current
+17 (total ≤ +77, under the original +120); tests uncapped within
reason; re-freeze with new SHA; combined E2 changed-lines ceiling lifted
to 320 to accommodate H1+N1+cache-test.

## Landing (v2 freeze, 2026-08-17)

v2 correction bundle: GO. Patch SHA 76e9e379; source net +45 (+77 cap),
combined 263 changed (320 ceiling); independent gate 575/575. Adversarial
re-verify: H1/N1 closed — recovery reads and mutates the INSTALLED v3;
byte-verified mode-0600 gateway-state.v3.backup.json written before any
mutation; whole-JSON-value reference scan (stronger than the enumerated
version reviewed); armed/history ablations refuse with installed bytes
unchanged; no-v2-backup case recovers in place; original repro correctly
inverted; 10 seam attacks clean (stale-backup mismatch refusal, resume,
idempotence, complete-backup-on-refusal). Catalog cache kept with
cached-then-cleared test. Zero new public concepts confirmed
(GATEWAY_STATE_BACKUP_MISMATCH pre-existing at base). Released as v1.9.3
(commit e0d8f3b). Deferred nits recorded in gate rulings thread: v3
backup filename is single-use (safe-direction block, ergonomics ruling
later); ENOENT guard coupling; converter lock lacks stale-pid reaping
(pre-existing).
