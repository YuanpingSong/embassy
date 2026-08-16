---
id: emb-61
title: Routable DeepSeek provider — transport decision + product-type generalization (design)
kind: investigation
size: 3
status: draft
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder has ruled full DeepSeek integration into v1.7 ("the fundamental interfaces are
fairly settled... fine as long as there are protocols"). Two design questions gate implementation:

1. **Transport**: ACP (`@deepseek-ai/dsh-acp`, open standard, founder-attractive) vs the SDK's
   native JSON-RPC stdio protocol. Founder delegated this call to the PM on technical maturity;
   the open question is whether ACP exposes the full feature set Embassy needs (turn start,
   interrupt/steer-equivalent, session enumeration, event stream with correlation ids, model and
   effort control) or a subset. A feature-coverage investigation feeds this ticket.
2. **Product-type generalization**: `PairParams` (claude×codex product), `messageDirections`
   (closed 2-provider union), and `ProvenanceEnvelopeDirection` must generalize to N providers.
   **Provenance is a named pillar of the founder's trust model — this design requires founder
   eyes before any implementation dispatch, regardless of schedule.**

**Deliverable**: transport recommendation with feature matrix and maturity evidence; the
generalization design for the three closed types with downgrade-safety analysis (design law 2);
a priced implementation split. No code.

**Non-goals**: no implementation; no provenance changes ship without founder review of this design.
