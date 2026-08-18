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
