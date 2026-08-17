---
id: emb-84
title: peer-stdio collapses broker rejections into "Local broker unavailable"
kind: bug
size: 2
status: landed
release: v1.9.4
updated: 2026-08-17
---

## Binding

**Why**: First live catalog attempt against m5dev on published v1.9.2.
Broker alert showed PEER_TUNNEL_UNAVAILABLE (the emb-83 diagnostic working
as designed — stage localized to post-initialize). Hand-driven protocol:
initialize succeeds, catalog/get returns `-32000 "Local broker
unavailable"` — while `embassy health` over the same non-interactive SSH
succeeds.

**Engineer contest (SUSTAINED)**: PM premise was "peer-stdio cannot reach
the local broker's control socket." Falsified from source: `-32000 Local
broker unavailable` is emitted only when `sendGatewayControlRequest`
successfully round-trips the control socket and the broker answers
`ok:false`. Connect/validation/timeout failures become `-32603`. The
helper is therefore REACHING the broker; the broker is REJECTING
peer_catalog, and the helper collapses every rejection into one lossy,
misleading message. Contest ledger: engineer correct again.

**Root trigger (operational, confirmed from timestamps)**: m5dev's broker
had been running since Aug 16 23:42 — the **1.7.1 binary** (survived
upgrade because `pkill -f "embassy serve"` does not match the actual
command line `node .../cli.js serve`) — started 11 hours before nodes.json
was written (Aug 17 10:48). Its inventory knew no peers; initialize
succeeded anyway because the helper reads nodes.json fresh per spawn while
peer_catalog authorizes against broker state.

**Deliverable**: Replace the helper's lossy collapse with a bounded
explicit refusal sourced from broker authority — the caller must be able
to distinguish "broker unreachable" from "broker refused" and see the
broker's actual failure stage. No dynamic inventory reload (previously
declined concept; stays declined — restart is the sanctioned way to adopt
nodes.json changes).

**Caps**: E2 as granted; two discriminating tests already staged on lane
`eng/emb-84-v2` (+39 test lines, base e854d00). One live catalog
verification round from this-mac authorized at freeze. Ships with emb-85
as v1.9.3.

## Gate rulings (v1 freeze, 2026-08-17)

Independent gate: patch SHA verified, 573/573, accounting reproduced to
the line. Taste: land-with-corrections (record-only). Rulings:

1. **"See the broker's actual failure stage" is narrowed, accepted.**
   control.ts:755 collapses every handler exception to HANDLER_FAILURE —
   the peer channel cannot carry stage without touching the control
   protocol. Ruled: for v1.9.3 the peer channel must distinguish exactly
   three states (unreachable −32603 / not-configured −32001 / broker
   refused −32000); the failure STAGE stays on the operator channel
   (broker alerts), which is where the emb-83 diagnostic already proved
   its worth. Stage propagation through the control protocol is declined
   for now; revisit only if a live operator is actually confused.
2. **The one-shot catalog cache** (initialize obtains catalog, first
   catalog/get serves it, cleared thereafter) was unasked-for. Authorized
   retroactively CONTINGENT on a test asserting the cached-then-cleared
   sequence; otherwise remove it. Engineer's choice.

## Landing (v2 freeze, 2026-08-17)

Landed in v1.9.4 (a7902e8; v1.9.3 tag dead, PM checklist miss) with emb-85; see emb-85 landing record for the
combined gate. emb-84 specifics: initialize sources broker authority;
three distinguishable peer errors (-32603 unreachable / -32001
not-configured / -32000 refused); one-shot catalog cache retained with
cached-then-cleared test evidence (one control request after initialize,
cache consumed on first catalog/get, fresh request on second).
