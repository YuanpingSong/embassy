---
id: emb-88
title: v2.0 R4 — state guillotine: delete the v2 converter stack, fresh strict schema, reset-only runbook
kind: normal
size: 5
status: dispatched
release: v2.0.0
updated: 2026-08-17
---

## Binding

**Why**: emb-87 inventory + founder v2.0 charter — migration machinery
must not live in the binary forever; we are the only users; breaking is
acceptable and a clean architecture is the product.

**Deliverable** (from the accepted emb-87 slice plan): delete
state-v2-to-v3.ts (1,341), its test file (689), the CLI verb/dependency
seam/copy rows, package allowlist entries, runtime schema-2 discriminator
and GATEWAY_STATE_CONVERSION_REQUIRED branch, and every conversion/backup
error code. Bump private persisted schema to a fresh strict version;
unknown/old state refuses with GATEWAY_STATE_SCHEMA_UNSUPPORTED and a
reset instruction — deliberately NO recovery path, refusal must not
mutate. Rename legacy_message → message_activity (truthful vocabulary,
no savings claimed). Tighten persisted local route IDs to reg_*.
Reset runbook ships in docs (verify no queued/armed/accepted work; stop
broker; move gateway-state.json aside; keep nodes.json; re-register/
select/pair). peerRouteRef and all trust boundaries STAY.

**Caps**: net floor ≤ -1,300 core lines; NEW code ceiling +120 src
(schema bump + refusal + rename); tests uncapped within reason;
do-not-golf clause — trust checks may cost lines against the floor.
Freeze with SHA; multi-round gate (taste + adversarial) — settlement-
sensitive: old state refused without mutation, fresh state preserves
settlement invariants.
