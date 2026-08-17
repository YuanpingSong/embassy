---
id: emb-87
title: v2.0 charter — inventory every migration/back-compat surface for deletion
kind: design
size: 2
status: dispatched
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
