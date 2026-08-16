---
id: emb-55
title: Compatibility surface set tolerates optional and absent surfaces
kind: normal
size: 3
status: landed
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: boot fails closed on exact surface arity (`service.ts:1274`: "requires one Claude and one Codex surface") — adding ANY third compatibility surface today makes its adapter mandatory at boot on every install. This must relax before any new provider, DeepSeek or otherwise, can be declared. Standalone value: it is the gate for every future provider.

**Promises:**
1. A surface may be declared optional; when absent, boot proceeds and the surface renders as "not detected" (never as an error, never blocking).
2. Claude and Codex remain required, byte-identical behavior when only they are present.
3. The two surface ternaries in `compatibility.ts` (`legacyVersionDriftCode` :67, `unsupportedVersionCode` :89) become exhaustive switches — a new surface must fail compilation, not silently receive Codex error codes.
4. Regression tests: absent-optional, present-optional, failed-probe-optional, and the current two-surface baseline.

**Budgets**: size 3; concepts: one ("optional surface"). Tests: the promises.

**Non-goals**: no new surface is declared by this ticket; no dashboard changes beyond the "not detected" state.

## Background (hypotheses — re-verify)

From the emb-54 investigation (report in that ticket): `compatibilitySurfaces` (compatibility.ts:3) is already separate from `gatewayProviders` (types.ts:12) — that separation is the seam. ~150 provider-discriminating branches exist; most fall through safely for non-routing surfaces but are not compiler-checked (see report's hidden-cost warning: hand-written literal annotations at service.ts:2068/2076/2083).
## Window contest and ruling (2026-08-16)

**Contest**: no explicit scope contract in the ticket (correct — a drafting gap from the v1.7
re-queue; the engineer rightly refused to infer authority). Plus one discovered seam: the public
snapshot caps compatibilityChecks at 2, so a third surface would be silently omitted — truncation
rendering as absence.

**Ruling 1 — window APPROVED as requested** (13 files): compatibility.ts, service.ts, types.ts
(compatibilityChecks capacity only), dashboard-model.ts, dashboard.ts, dashboard-copy.ts/.en/.zh-CN,
live-dashboard-app/tab-diagnostics.tsx, and the four named test files. The internal/test surface
override stays test-scoped — no production optional surface is declared until emb-56.

**Ruling 2 — the capacity fix belongs in emb-55**, not emb-56: this ticket's Why is "the gate for
every future provider," and a snapshot that silently drops the third surface is the same closed-
arity bug as the boot check. Bound it honestly: capacity derives from the declared surface set
(required + optional), never a new magic number; the existing truncation counter keeps telling the
truth. Public-snapshot only — nothing persisted changes (downgrade-safe per the emb-49 analysis).

Budget unchanged: size 3, <=500. Promises unchanged plus the capacity clause above.

## Landing state (2026-08-16)

Accepted: PM core-diff read (definitions registry, optional-absent continue, exhaustive switches
with never floors, capacity derives from surface set — the ruling's constraint verbatim), gate
766/766, budget 413/500, concepts 1/1. Committed locally on the drill-gated stack. Watch-item
carried to emb-56: an adapter exposing an UNDECLARED surface boots without attesting — unreachable
in production today; emb-56's surface registration must keep it so.

## Shipped in v1.6.0 (2026-08-16)

Tagged on public main d22ddf0; pipeline-verified tarball published as agent-embassy@1.6.0 (npm trusted publishing, provenance). Optional compatibility surfaces shipped; the published broker boots with both providers rendered from the observed surface set.
