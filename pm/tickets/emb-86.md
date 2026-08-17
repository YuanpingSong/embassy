---
id: emb-86
title: reverse federation dial fails against mixed-provider brokers (peer-stdio initialize -32603)
kind: bug
size: 2
status: landed
release: v1.9.5
updated: 2026-08-17
---

## Binding

**Why**: Founder enabled Remote Login; reverse SSH verified end-to-end
(host key scanned, m5dev key authorized by founder hand — classifier
correctly gated authorized_keys edits; non-interactive PATH fixed on
this-mac via ~/.zshenv, same remedy as m5dev). m5dev then still shows
PEER_DIAL_FAILED(this-mac): this-mac's peer-stdio answers initialize
with `-32603 Internal error` — deterministically, locally and over SSH —
while m5dev's peer-stdio works. Health/status on the same socket work,
so the exception is inside the initialize handler's peer_catalog chain
(cli.ts:631-633), not the control transport.

**Discriminating facts**: my broker's exportable catalog spans FOUR
providers (incl. a claude selected_live_peer row whose routeHandle is a
raw unprefixed session UUID) plus local consent edges and alerts; m5dev
exports 3 fresh single-shape routes, no edges. All local routes on BOTH
machines carry lease_* registrationIds while the peer-protocol checks
(peer-protocol.ts:51,75) demand token("reg_") — yet the FORWARD direction
decoded fine, so where each check actually runs must be mapped before
blaming it. buildPeerCatalog (service.ts:596) exports raw
binding.registrationId as ref — if any validated path enforces the reg_
contract this is both the bug and a private-id leak the emb-81 design
(opaque reg_* refs) forbids.

**Deliverable**: reverse initialize succeeds against a broker with real
mixed-provider state; legitimate refusals become typed, distinguishable
errors rather than -32603; a this-mac-shaped catalog fixture (4
providers + edges + alerts) joins the suite — the recurring defect class
is real-shape-no-fixture.

**Caps**: E2, net ≤ +80 src, tests uncapped within reason, freeze with
patch SHA. First cross-machine handoff follows immediately: reverse dial
→ embassy-pm mirror on m5dev → owner-side pair → send → await.

## Landing (v1 freeze, 2026-08-17)

GO first pass. Patch SHA 8965b0cb; source +12/-7 (net +5 of +80 cap);
independent check 576/576; base contest (engineer-raised) resolved: the
records branch had been offered as lane base and was DIVERGED — product
base corrected to public main a7902e8 before any edit.

Root cause (engineer, offline repro): buildPeerCatalog exported private
lease_* registrationIds as wire refs; the strict token("reg_") contract
rejected them in the helper's own control client during initialize (the
emb-84 initialize-fetches-catalog change is why it surfaced there).
Forward direction had worked by COINCIDENCE: fresh installs mint
reg_-shaped random ids (service.ts:254-256) while v2-migrated states
carry lease_* ownerLease ids (state-v2-to-v3.ts:389) — m5dev was fresh
post-recovery, this-mac migrated. Fix: peerRouteRef(host, regId) =
reg_ + SHA-256(host\0regId) base64url at all nine wire sites, projection
and admission symmetric (adversarial reviewer proved with a live
two-broker round trip incl. handoff admission); no raw id or native
handle crosses the wire.

Release-note item (shipped in CHANGELOG + notes): upgrade rebuilds
federated mirrors; in-flight settles ROUTE_UNREGISTERED; locally-owned
cross-host edges drop — one re-pair after both sides upgrade. Nits
recorded: per-candidate re-hash in find() predicates; PeerProtocolError
vs BridgeError on host regex; randomized forged-token fixture class
(z-suffix recurrence) queued for one deterministic sweep. Released as
v1.9.5.

## Drill completion (2026-08-17 ~18:30)

FIRST CROSS-MACHINE HANDOFF COMPLETE, WITH RECEIPT, on published v1.9.5.
Reverse initialize + mixed-provider catalog round-trip clean; reverse
mirrors of all five this-mac routes on m5dev within 10s; first cross-host
consent edge paired on the owner broker; THREE handoffs delivered
(PEER_HANDOFF_CONFIRMED) and the third consumed end-to-end by `embassy
await` on m5dev — full broker-owned frame with provenance and reply hint
intact across machines. Operational finds for retro: (1) ghost-broker
kill pattern must cover BOTH command shapes ("embassy serve" nvm shim AND
"cli.js serve" pnpm) — a 1.9.4 ghost served for hours and reproduced the
pre-fix -32603, nearly misdiagnosed as a fix failure; (2) peer token
ergonomics — --emit-env quoting + fresh-shell-per-call cost three lost
tokens before a clean one-shell pattern landed (drill2/drill3 messages
remain queued until deadline expiry, harmless); (3) GitHub 503 on release
creation twice in one night — rerun-until-green is now routine.
