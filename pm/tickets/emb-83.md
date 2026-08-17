---
id: emb-83
title: v1.9.1 — broker peer dial never authenticates; retain SSH_AUTH_SOCK per design
kind: bug
size: 2
status: landed
release: v1.9.2
updated: 2026-08-17
---

## Binding

**Why**: v1.9.0 two-machine drill. Manual dial works perfectly
(`/usr/bin/ssh -T -o BatchMode=yes -o ClearAllForwardings=yes m5dev embassy
peer-stdio` answered initialize with protocolVersion 1/host m5dev/full
capabilities), but the broker NEVER produces mirrors: peer connector sits
degraded CONNECTOR_OBSERVATION_STALE from boot, no ssh child ever observed,
across multiple clean boots with SSH_AUTH_SOCK in the broker env. The
design said the spawn retains SSH_AUTH_SOCK; the implemented fixed scrubbed
spawn env appears to drop it → BatchMode auth fails silently every cycle
(body-free discipline hides stderr).

**Deliverable**: (1) the peer ssh spawn env retains SSH_AUTH_SOCK (and only
it beyond the fixed set), with a test asserting the spawn env contract;
(2) a bounded dial-failure diagnostic — connector safe code distinguishing
auth/spawn failure from stale observation (e.g. PEER_DIAL_FAILED with
bounded reason class), because tonight's silence cost an hour of
elimination; (3) verify the refresh actually re-dials on its lifecycle
timer after failures (no dial was EVER observed — if the lifecycle only
dials once pre-fix, prove and fix the re-arm). Drill environment notes for
the record: m5dev needs pnpm bin on non-interactive PATH via ~/.zshenv
(done, docs candidate); reverse federation (m5dev→this-mac) awaits founder
enabling Remote Login on this-mac (System Settings → Sharing).

**Budgets**: size 2, remainder-map before cutting. TMPDIR=/tmp gates.

## Landing

v2 landed in v1.9.2 (v1.9.1 tag is dead: the forged-token test flipped the
last character to a constant `x`, identical to the real token 1/64 of the
time — product behavior was CORRECT; fix `endsWith("x") ? "y" : "x"`).
Contest sustained: SSH_AUTH_SOCK was already retained
(test/peer-transport.test.ts:68-70) and re-dial existed; the real defect
was zero-mirror first-dial invisibility → PEER_DIAL_FAILED (spawn/
initialize stage) vs PEER_TUNNEL_UNAVAILABLE (post-initialize) now
distinguishable. Proven immediately in production: the diagnostic
localized the emb-84/85 failure to the catalog stage on first use.
