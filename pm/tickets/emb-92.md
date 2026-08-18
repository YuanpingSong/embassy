---
id: emb-92
title: v2.0 — Claude peer discovery admits background sessions
kind: normal
size: 1
status: dispatched
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: Founder ruling (2026-08-18): "We shouldn't have this
limitation." The PM seat now runs as a background Claude session on
m5dev, and background sessions are first-class operators in this work
model. But the local Claude provider only admits interactive sessions as
peer candidates: `providers.ts` drops `kind !== "interactive"` at the
discovery refresh (line ~736 on main) and re-checks the same predicate
at selection (line ~503), and `NATIVE_CLAUDE_NAME`
(`/^[a-z][a-z0-9_-]{0,31}$/`) rejects digit-start auto-generated names.
Net effect observed live on m5dev: `availablePeers` is permanently
empty, the PM session cannot be discovered, selected, or paired, and no
native PM↔engineer contact is possible. Consent does not live in this
filter — it lives in explicit pairing — so admitting background
sessions does not weaken the trust model.

**Deliverable**: admit kind `"bg"` alongside `"interactive"` at both
predicate sites; carry the real kind on the discovery row instead of the
hard-coded `"interactive"` literal (type ripple included); widen
`NATIVE_CLAUDE_NAME` to `/^[a-z0-9][a-z0-9_-]{0,31}$/` so digit-start
session names are addressable. `daemon` and `daemon-worker` stay
excluded — the helper fleet must never become addressable. The embassy
advertisement predicate in `claude-peer.ts` is untouched
(advertisements remain interactive-shaped). No pairing, consent,
inbound-policy, or send semantics change.

**Caps**: E1; src changed ≤40 (measured-remainder rule: contest with a
map if the coherent cut disagrees — pre-estimates are projections);
tests ≤80 changed/added; zero new concepts. Base = public main 788a6f3.
Surface is `src/gateway/providers.ts` (+ its types/tests). emb-90 is
frozen on `cli.ts`/`control.ts`/`service.ts` + 4 test files — stay off
those files; if the type ripple forces a shared file, contest before
touching it.

**Acceptance**: (1) a live, named background Claude session appears in
`availablePeers` as `name@host`; (2) select/pair and the send/reply
round-trip work against a bg session (fixture records with
`kind: "bg"`); (3) interactive-session behavior byte-for-byte unchanged;
(4) `daemon`/`daemon-worker` records are never listed nor selectable;
(5) a digit-start name (e.g. `9a04b5e9`) is a valid candidate name;
(6) full check green.

## Dispatch (2026-08-18)

Jumps the queue ahead of emb-91: this ticket unblocks the PM↔engineer
channel on m5dev, so it prices above everything except the emb-90
landing. Fresh lane off 788a6f3, parallel to frozen emb-90. Freeze with
SHA + per-bucket accounting as usual; the PM gates immediately on
freeze. After landing, the PM runs the m5dev broker from the main build
(operator step, PM-side) and the engineer completes `select-claude` to
the PM session. Until then, coordination rides the records branch and
founder relay.

## Contest ruling #1 (2026-08-18)

Engineer found the anticipated seam before editing: emitting the real
`"bg"` kind requires widening `GatewayAdapterDiscovery.kind`
(src/gateway/service.ts:102) from `"interactive"` to
`"interactive" | "bg"` — a shared file frozen under emb-90.

GRANTED: exactly that one line in service.ts joins emb-92's window.
Conditions: (a) it is the ONLY service.ts change — a second line there
is a new contest; (b) src cap unchanged (≤40; engineer projects a
comfortable fit); (c) sequencing: emb-90 is gate-clean (555/555,
accounting exact) with adversarial review in flight and is expected to
land on main imminently — before freezing, fetch, and if main has moved
past 788a6f3, rebase the lane onto the landed tip and freeze with that
base; if emb-90 is still unlanded at freeze time, freeze on 788a6f3 and
declare the service.ts line explicitly in the freeze message. Landing
order is the PM's problem, not the engineer's.

Ops note (same exchange): the earlier registration failure was
CLI-side — v1.9.5 `register-codex` defaults `--host` to `this-mac`
(cli.ts:31) and faults when the alias suffix disagrees (cli.ts:349-354).
Verified against broker-side validation (server.ts:143 derives
allowedHosts from the nodes inventory = [m5dev, this-mac];
service.ts:995 requires the alias to end with the broker hostId):
`embassy register-codex --alias codex-embassy-swe3@m5dev --host m5dev`
is the correct invocation on this host. The --host flag dies in v2.0
(emb-89 already deleted it on main).
