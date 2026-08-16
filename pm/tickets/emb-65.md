---
id: emb-65
title: ACP ground truth — registry, spec versioning, and delivery-signal fidelity across dsh and grock
kind: investigation
size: 2
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: the founder ruled v1.7 transport = ACP the open standard (emb-61 R1),
superseding the native JSON-RPC ruling that was driven by defects in the
dsh-acp adapter. Before the new sub-ticket split is priced, every defect that
drove the old ruling must be re-classified: inherent to ACP the standard
(design must absorb it), specific to the dsh adapter (route around it), or
stale (fixed upstream / version-specific to the rc build).

**Deliverable**: a report answering, with cited sources (registry JSON, spec
text, adapter source/releases):
1. ACP registry ground truth — is the agents list real and current; are Codex
   CLI and Claude Agent actually on it (the flagged ACP-UNIVERSAL reach);
   what does one-client-many-agents actually buy Embassy?
2. Spec/version story — how is the ACP handshake versioned; what does a
   client do across agents pinned to different spec versions; is the dsh-acp
   hardcoded-handshake-version defect an adapter bug or a spec gap?
3. Delivery-signal fidelity — can an ACP client obtain reliable
   turn-completion / turn-outcome and session-list signals from (a) the dsh
   build and (b) the grock build? This is deliverability, not certification:
   Embassy's receipts need honest terminal states. Reclassify the emb-61 §2
   turn-outcome-evidence finding.
4. Spawnability/packaging — current dist-tag state of dsh-acp; whether the
   standard client connects to an already-running harness without adapter
   packaging at all.
5. The minimal ACP client surface Embassy needs (methods, notifications) for
   best-effort send → deliver → reply with graceful, clearly-surfaced errors —
   ceremony-free per emb-61 R2.

**Budgets**: size 2, investigation. Read-only: registries, specs, source,
releases. No harness is launched; no write authority exists or is implied.

## Standing mandate (founder, 2026-08-16)

This ticket is the sole gate on v1.7: if the investigation shows ACP is NOT
sufficient for Embassy's usage (reliable turn-completion/receipt signals for
best-effort delivery), the founder revisits the transport ruling. Otherwise
the PM drives the full v1.7 release to ship without further founder inputs.
