---
id: emb-68
title: N-provider generalization — all-to-all routing, unified native state, from/to-provider surfaces
kind: normal
size: 5
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder rulings on emb-61 — all-to-all provider routing (Q7: no
artificial pairing restrictions; per-edge consent stays), ONE unified route
table as the binary's NATIVE state format (Q4 + migration addendum: no
in-binary migration or prune; our own state migrated once by hand;
unparseable state gets the ordinary strict-parse honest error),
from-provider/to-provider on deliveries UI and the reply-hint attribute
(Q1/Q5), `dsh-` registration prefix (Q6), and no naming-based rules —
provider truth comes from the lease-proven route record (Q3).

**Deliverable**: the three closed 2-provider product types generalized to N
providers per the emb-61 part-2 design MINUS everything migration-related:
derived ordered provider pairs (no hand-written unions), the unified route
table as native persisted state, provenance recipient-profile with the
from-provider hint attribute, deliveries UI with from/to provider selectors,
registration prefix enforcement for `dsh-`, and the routing layer accepting
any provider pair that holds a consent edge. Two-provider behavior unchanged
— carried by the emb-61 part-2 proof obligations (exact-wire tests), not
asserted.

**Budgets**: size 5. Sequenced after emb-67 lands its transport seam.
