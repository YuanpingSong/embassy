---
id: emb-58
title: Write-evidence ladder plumbing (49A): optional probes + derived writesCovered
kind: normal
size: 2
status: dispatched
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: the evidence ladder cannot record which authority its probes covered, so GATEWAY-ARCHITECTURE's own "writable only where the probes cover writes" clause has been dead text since v1.5. This is the plumbing that makes write evidence recordable — with zero writes performed and zero authority granted.

**Promises:**
1. The attestation probe set supports optional, present-only-on-pass probes (required ordered prefix + known optional names); `write_attestation` is registered as an optional Codex probe name. A v1.5 binary loads a v1.6 five-probe record unmodified (downgrade-safety test required — design law 2).
2. `compatibilityCoversWrites()` derives write coverage from probes; `writesCovered` appears on the public compatibility snapshot only (never persisted as a field — the persisted key-set is closed).
3. Dashboard: the schema_attested tier pill gains a writes-covered label variant (en + zh-CN); no new columns. `guidance.providerIncompatible` gains the writes-covered guard.
4. Absent the optional probe, behavior is byte-identical to v1.5.

**Budgets**: size 2; concepts: one user-facing ("write evidence" on the compat table). Tests: the promises, incl. the v1.5-loads-v1.6-state downgrade test.

**Non-goals**: no probe implementation (emb-59); no authority change (emb-60); no allowlist changes.

## Background

Derived from emb-49's completion report §3/§9 (49A) — the probe-name design exists precisely because adding any persisted field or fourth tier is downgrade-fatal via the exact key-set validator (compatibility.ts:258+) and the closed tier union. Re-verify cited line numbers against HEAD.
## Dispatch note (2026-08-16, to codex-embassy-main)

Re-routed from swe3-when-free to codex-embassy-main: emb-59 (sensitive, size 5) now enters v1.6 on
founder ruling and needs this ticket's plumbing first — main runs emb-58 then emb-59 sequentially,
separate handoffs. Scope contract (emb-58): src/gateway/compatibility.ts, src/gateway/types.ts,
src/gateway/dashboard-model.ts, dashboard copy files (en/zh-CN), live-dashboard-app/app-types.d.ts,
test/**. Outside: contest before writing.

## Contest and ruling (2026-08-16)

**Contest (main, before any edit)**: promise 3 (writes-covered tier-pill variant) cannot be
satisfied inside the declared window — both renderers resolve `compatibilityTier.${tier}` directly
(static: dashboard.ts:633; live: live-dashboard-app/tab-diagnostics.tsx:240), so model/copy changes
alone cannot select a sibling label without falsifying the closed tier union or changing all
schema_attested copy globally. Proposed: derived `writesCovered` on the model row; renderers choose
the sibling key.

**Ruling: option (a) ACCEPTED — window expanded** to add `src/gateway/dashboard.ts`,
`src/gateway/live-dashboard-app/tab-diagnostics.tsx`, and their focused tests. Both render sites
verified by PM. The proposed seam (derived flag on the model row, renderer selects the key) is the
right shape — it matches promise 2's derived-only rule. **One correction**: option (b)'s premise is
wrong — swe3's concurrent emb-52 window contains no dashboard files (its scope is runtime/route
modules only), so there is no live-app collision and no sequencing needed. Budget unchanged: the
design's 49A estimate already priced "dashboard model + render." Contest record: 7/7 engineer-correct
on the core claim; the collision half was checked and cleared rather than inherited.
