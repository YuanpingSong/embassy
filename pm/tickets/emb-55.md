---
id: emb-55
title: Compatibility surface set tolerates optional and absent surfaces
kind: normal
size: 3
status: draft
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