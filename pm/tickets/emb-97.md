---
id: emb-97
title: emb-95 follow-through — pin the real sandbox errno, hedge the serve hint, honest read-branch catch
kind: normal
size: 1
status: dispatched
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: emb-95's final review (GO) priced three follow-ups; the first
is release-gating. The errno predicate that carries every denial branch
(federation-nodes.ts:38, EPERM || EACCES) is tested only on its EACCES
half — and the REAL Codex sandbox (macOS seatbelt) raises EPERM.
Reviewer-executed: deleting `EPERM ||` passes the full suite 562/562
green while fully restoring the original incident under a live seatbelt
profile. The product is correct today; the incident's own regression
guard is missing.

**Deliverable**:
1. EPERM pins: loader tests fake EPERM (not just EACCES) through each
   reachable branch; the predicate mutation (drop EPERM) must turn the
   suite red. This is the release gate.
2. Serve hint gains the client hint's hedge, both locales: if access
   should already work, verify EMBASSY_STATE_DIR names this user's own
   state directory. (The boot path is where stale/inherited env vars
   live, and serve's remedy — grant access — is wrong for a
   mispointed variable.)
3. Narrow the read-branch catch (federation-nodes.ts:160-162): only
   errno-shaped errors classify (denied/invalid as today); everything
   else rethrows as base did (INTERNAL_ERROR), so transient I/O faults
   and code defects stop presenting as operator configuration errors.
   With a test.

**Caps**: E1; src ≤20; tests ≤60; zero new concepts; base = main
1f5f42c. Gate: mech only + the EPERM predicate mutation (must be red);
no adversarial pass — three full passes and a GO stand behind the
surrounding code.

**HOLD NOTE**: dispatched for the record, but the founder hold ends the
wave after emb-93. Work order: emb-93 first, then STAND DOWN. emb-97 is
first in queue at resume and MUST land before the v2.0.0 release gate
(it is on the release checklist).
