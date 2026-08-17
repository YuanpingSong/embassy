---
id: emb-86
title: reverse federation dial fails against mixed-provider brokers (peer-stdio initialize -32603)
kind: bug
size: 2
status: dispatched
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
