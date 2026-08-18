---
id: emb-94
title: v2.0 RELEASE BLOCKER — duplicate peer aliases invalidate the whole public snapshot
kind: bug
size: 1
status: dispatched
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: Found in production on m5dev minutes after emb-92 landed, on a
2.0.0-rc.1 broker built from main 9754888. `embassy status` fails
deterministically with `CONTROL_INVALID_RESPONSE` (+ the version-skew
hint, which is MISLEADING here — client and broker are the same build).
`health` and `refresh-dashboard` still work, which is the diagnostic
asymmetry.

Root cause, confirmed against the raw `list_snapshot` frame: two live
Claude sessions share the display name `color-analysis-pm` (one
interactive, one bg — both real, both live). Discovery keys candidates
by (host, session UUID) at service.ts:2664, so both become candidates
and both project into `availablePeers` with the SAME alias. The snapshot
post-validator requires `unique(peers)` (control.ts:695 + :704), so the
ENTIRE snapshot is rejected — not just the offending row. Every snapshot
consumer dies with it: `status`, the dashboard data path, and anything
reading routes/consent/accounting.

Latent before emb-92 (two same-named interactive sessions would have
done it), but emb-92 made it reachable in normal use: with bg sessions
admitted, a founder running several named background agents collides
names routinely. Neither the fixtures nor the adversarial pass covered
two live sessions sharing a name.

**Deliverable**: an ambiguous alias must never be addressable, and must
never poison the snapshot. Precedent to follow — claude-peer.ts already
handles the analogous SESSION_ID_COLLISION by dropping BOTH bindings and
counting a rejection (claude-peer.ts:1010-1021). Apply the same
fail-closed rule to alias collisions among live candidates: when two or
more live candidates on a host resolve to the same alias, drop them all
from `availablePeers`, count a rejection so the condition is visible in
the registry diagnostics, and make the alias unresolvable for
select/pair (never pick one — sending to the wrong session is a consent
violation). Sessions with unique names are unaffected.

**Caps**: E1; src changed ≤35; tests ≤80; zero new concepts. Base = main
9754888.

**Acceptance**: (1) with two live same-named sessions, `status` returns
a valid snapshot and neither colliding alias is listed; (2) the
collision is visible as a counted rejection, not silence; (3)
select/pair against a colliding alias fails closed with a safe code;
(4) unique-named sessions (interactive and bg) still list, select, pair,
and message normally; (5) a regression test with two live candidates
sharing an alias — the fixture gap that let this ship; (6) full check +
soak green.

**Ops note for the PM**: this blocks v2.0.0. It does NOT block the live
channel — pair/send resolve aliases through the candidates map, not
through `list_snapshot`, and `embassy-pm@m5dev` is unique.
