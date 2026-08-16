---
id: emb-69
title: DeepSeek and Grok Build as routable ACP providers
kind: normal
size: 3
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: v1.7's headline — DeepSeek routable — under emb-65 PM ruling B, plus
the ACP-universal proof the founder named (Grok Build, native ACP, on the
checksummed registry).

**Deliverable**: two provider definitions over the emb-67 client. (1)
DeepSeek: launch spec targeting the LOCAL harness checkout's dsh-acp (the
npm artifact is unspawnable: no bin, workspace:^ peers; emb-56's attested
harness home locates the checkout); registration under the `dsh-` prefix;
the lane's end_turn receipts settling **unconfirmed / ACP_OUTCOME_COARSE** per the emb-66 amendment (end_turn from this adapter proves nothing; claiming delivered would violate the ambiguity law; sound cancelled stays cancelled) — the adapter's
spec-violating stop-reason collapse (aborted/blocked/error → end_turn) is
adapter-side and unrecoverable client-side; an upstream issue filed for the
collapse and for settlement-on-idle. (2) Grok Build: launch spec from the
ACP registry entry (npx @xai-official/grok@<registry-pinned> agent stdio —
note the registry pins the alpha dist-tag; use the registry's exact pin);
capabilities read at connect time per R2, degrading honestly — its
stop-reason fidelity is unverified read-only and needs no advance
verification by design. Both lanes: live proof = one real send round-trip
each, token spend surfaced in the release record (first DeepSeek and first
Grok tokens).

**Budgets**: size 3. Sequenced after emb-68. No write-authority concept
exists post-de-ceremony; routing a message to a provider starts a turn on it
— that IS the product, founder-directed for both providers by name.
