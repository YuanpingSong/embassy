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

## Gate rulings (v1 freeze, 2026-08-17)

Independent gate: SHA f0b48bea verified; src +30/-1,381 net -1,351
reproduced exactly (floor met by 51; new code 30/120); 552/552.
Taste: land-with-corrections, "strongest slice of the release" —
refusal-without-mutation traced in source (only non-throwing loadStateFile
return is ENOENT; catch releases lock and rethrows; persist unreachable);
do-not-golf honored demonstrably (npm-checker missing-file probe
re-pointed, not deleted). Adversarial: GO — refusal purity byte-identical
across 12 malformed/unsupported inputs with no lock leak; schema-4
self-compat round-trips every emittable shape incl. boundary-length reg_
ids; token/busyPolicy narrowings producer-aligned; test delta exactly the
converter suite.

**Rulings**:
1. RETROACTIVELY AUTHORIZED: two unenumerated loader-tolerance deletions —
   delivery-token width {24,128}→{24} and busyPolicy "refuse" arm. Both
   charter-covered (emb-87 "any loader tolerance for legacy shapes"),
   deliberate, negative-tested. Release note line required at v2.0.0.
2. RECORD WIDENED: "persisted local route IDs" → the reg_* invariant is
   enforced at BOTH the persisted seam (isRoute) and runtime admission
   (assertValidRouteInput), and covers mirror routes (peerMirrorRegistration
   ids are reg_peer_*, conformant). The runtime seam is what makes the
   persisted invariant enforceable — approved as in-scope, not creep.
3. CORRECTION BUNDLE REQUIRED before landing (promise-shortfall, both
   reviewers converged): the reset instruction never reaches the operator —
   writeFailure prints only {code}+generic line; no cli-copy hint entry
   exists. Required: hint lines in BOTH locales for
   GATEWAY_STATE_SCHEMA_UNSUPPORTED AND CORRUPT_GATEWAY_STATE (error-as-
   documentation standing ruling; the corrupt branch is what a truncated
   file actually hits), carrying the reset pointer + the abandon-unsettled-
   work caveat + the check-requires-1.9.x note, CLI-level test proving the
   hint prints; fix the stale v3 soak comment (line 600); add the one-line
   mirror-id reg_* regression assertion. Ceiling unchanged (30/120 used);
   re-freeze with new SHA; single adversarial re-verify of the hint seam.

Intended-behavior classifications and remaining gaps recorded by taste
(native_ invariant naming, EMBASSY_VERSION/changelog at release time,
unbucketed script -2) ride the release checklist or emb-89.
