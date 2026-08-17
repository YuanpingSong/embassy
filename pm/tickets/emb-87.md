---
id: emb-87
title: v2.0 charter — inventory every migration/back-compat surface for deletion
kind: design
size: 2
status: landed
release: v2.0.0
updated: 2026-08-17
---

## Binding

**Why**: Founder retro ruling — both our machines are migrated, nobody
else runs Embassy yet, breaking changes are acceptable. The v2→v3
migration machinery and every other backward-compatibility surface must
not live in the binary forever. Known headline: state-v2-to-v3.ts is
1,299 lines (6.6% of the 19,822-line core) + 602 test lines + cli/store/
cli-copy touchpoints — including the recovery machinery built in
v1.9.3–v1.9.5, which served its one purpose (migrating us) and dies
without regret.

**Deliverable — inventory only, no edits**: a remainder map of every
surface that exists to serve migration or backward compatibility:
converter + its CLI verb + conversion-required/backup/recovery codes and
copy strings; any loader tolerance for legacy shapes; legacy id-format
accommodations (lease_* handling anywhere the reg_ contract now rules —
note peerRouteRef hashing STAYS, it is privacy not compat); DEFAULT_HOST_ID
"this-mac" legacy semantics (the parked naming footgun — a breaking
release can finally fix it, price the rename); deprecated verb naming
(send-to-codex accepting codex|peer — candidate rename to `embassy send`);
anything else that exists only because an older version existed. For each:
lines held, what deleting breaks, and whether deletion needs a
state-reset instruction in docs. Close with a proposed slice plan and
projected core size after the cut.

**Caps**: inventory size 2; the deletion slices get priced from your map.

## Landing — inventory delivered (2026-08-17)

Basis correction accepted: PM figures came from the stale records branch;
authoritative basis is published v1.9.5 (00daa9b) — core 19,872, converter
1,341 src + 689 test. Full remainder map in the emb-87 conversation.
Highlights: converter stack + schema-2 branch + converter codes = DELETE
(the emb-84/85 recovery machinery dies with it, purpose served, three
open nits disappear rather than being fixed); EMBASSY_HOSTS + every
this-mac default/fallback = DELETE with explicit identity required;
legacy pair arm + old control frames = DELETE with protocol bump;
send verbs → one `embassy send`. NOT compat (keep): peerRouteRef
(privacy), trust boundaries (state-root marker, lease schema, protocol
versions), support matrix, tombstone tests (zero binary cost),
legacy_message (currently live for rejection activity — RENAME to
message_activity, no savings claimed). Projected core after cut:
~18,455 (-7.1%).

**PM rulings**: all four slices approved, ALL ride ONE breaking release
v2.0.0 with ONE operator reset runbook (no compatibility aliases, no
deprecation windows). nodes.json becomes mandatory with `nodes: []`
allowed — the refusal error must carry the exact one-line fix
(error-as-documentation), no wizard, no auto-generation (no new magic
default). register-codex --host escape hatch deleted; host inferred from
attested inventory. legacy_message renamed. Route IDs tightened to reg_*.
Do-not-golf clause honored: trust checks may cost lines. Slices: emb-88
(R4 state guillotine, E5), emb-89 (R3 host identity, E3), emb-90 (R3
control cleanup, E2/E3), emb-91 (R2 send verb, E2).
