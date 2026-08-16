---
id: emb-57
title: Version semantics: prerelease identifiers and 0.x majors
kind: normal
size: 2
status: landed
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: `VERSION_PATTERN` (compatibility.ts:62) rejects prerelease versions outright, so a provider shipping only `-rc` builds (DeepSeek: six versions in four days, all prerelease) can never rise above `incompatible` — and `versionMajor` treats all 0.x as one major, though 0.x minors are breaking under semver (Codex at 0.147.0 already sits in this trap).

**Promises:**
1. A written design decision first, in the ticket: what tier can a prerelease build ever reach? (PM lean: never above monitor-only — the evidence honestly says "unstable build"; but the decision must be explicit, not emergent from a regex.)
2. `VERSION_PATTERN` handling extended per that decision, with the tier rules updated and tested.
3. 0.x major semantics defined: minor bumps within 0.x are treated as major-equivalent for ladder purposes, with existing certified sets unaffected.
4. Existing Claude/Codex attestations behave byte-identically.

**Budgets**: size 2; concepts: zero new user-facing. Tests: the promises.

**Non-goals**: no new surfaces; no changes to probe sets.

## Background

From the emb-54 report §3: certified-set entries are themselves pattern-checked (compatibility.ts:208) and the inventory must be nonempty (:207) — both interact with any prerelease decision.
## Sequencing note (2026-08-16, from emb-49 design report §8)

Rule 3 (0.x minors are major-equivalent) is correct on safety and for DeepSeek — but it deletes
exactly the population (Codex same-major untested builds) that write attestation serves. Landing
emb-57 without emb-60 converts a soft fence into a hard one: every Codex minor bump would mean
monitor-only until an Embassy release. Decide rule 3 first, knowing emb-60 is the release valve.

## Founder direction (2026-08-16, verbatim intent)

"Our long-term goal is to move toward a capability-based test rather than a version pinning."
This is the ticket's north star: the prerelease/0.x decision is a waypoint toward attestation
that asks "what can this build do, proven by probes" rather than "what is this build's number."
Design promise 1 accordingly: the written decision should state how prerelease handling converges
with the write-attestation track (emb-49/58/59/60) rather than adding version machinery.

## Window + design ruling (2026-08-16)

**Window APPROVED, exactly three files**: pm/tickets/emb-57.md (the engineer writes the decision
section — promise 1 — reviewed at landing like any diff), src/gateway/compatibility.ts,
test/gateway-compatibility.test.ts.

**Design APPROVED as proposed**: (1) bounded SemVer prerelease grammar; certified inventories stay
stable-only. (2) Prerelease on a supported series may reach schema_attested but is PERMANENTLY
monitor-only — compatibilityCoversWrites requires stable evidence; even a passing write attestation
cannot cover prerelease. (3) Series = major for >=1, 0.minor for 0.x; cross-series drift stays
incompatible until an Embassy release certifies it. (4) Explicitly a waypoint to the founder's
capability-over-version north star, not new pin machinery.

**Cost accepted and recorded for the retro/release notes**: strict rule 3 means every Codex minor
bump (0.147→0.148) is monitor-only until a certification release — the hard fence the emb-49 design
report warned about, priced acceptable because release cadence is fast and emb-60 valves
same-series stable builds. The north star's capability probes are the eventual dissolution of this
fence, not tonight's.

Budget: size 2 / <=200 confirmed; concepts 0.

## Test-window expansion (2026-08-16)

**APPROVED**: fixture/expectation-only edits in exactly test/codex-local-transport.test.ts,
test/gateway-dashboard.test.ts, test/gateway-providers.test.ts, test/gateway-service.test.ts —
the eight failures are old-contract fixtures (0.148.0-as-same-series; prerelease-normalizes-to-
unknown) contradicting the approved semantics; a suite must not assert both sides. Same-series
fixtures move to 0.147.1; explicit unsupported-0.148 and incompatible-next-minor cases stay
unchanged as the new contract's own assertions. No source expansion. Size 2 holds unless honest
accounting says otherwise — re-contest at the number, as always.
## Implemented design decision (written before code)

1. Compatibility version evidence accepts a bounded SemVer-style prerelease
   suffix such as `-rc.1`; build metadata remains outside this ticket.
   Certified inventories remain stable-version-only, so prerelease evidence can
   never be `certified`.
2. A prerelease on a supported compatibility series may reach
   `schema_attested` after all required probes pass, but it remains monitor-only.
   Even a passing optional write attestation cannot cover prerelease writes.
   Failed probes and unsupported series remain `incompatible` under the existing
   surface safe codes; no tier or error code is added.
3. A compatibility series is the major number for versions at 1.x or later and
   the `0.minor` pair for 0.x. Thus 2.1 and 2.2 share a series, as before;
   0.147.0 and 0.147.1 share one; 0.147.x and 0.148.x do not. Exact certified
   stable versions remain byte-identically `certified`.
4. This is a waypoint toward capability-over-version, not new pin machinery.
   emb-60 may raise stable same-tier authority when write capability is proven,
   but it cannot launder prerelease, unknown-version, or cross-series evidence.
   The accepted present cost is explicit: every Codex minor bump is monitor-only
   until an Embassy release certifies that new 0.x series.

## Landing state (2026-08-16)

Accepted: decision record written-before-code per promise 1 (verbatim the approved design incl.
the stated strict-series cost); core diff read (bounded prerelease grammar with SemVer leading-zero
rejection, series function as ruled, stable-only certified validator); gate 774/775 with the sole
red being the known 1s timing flake (green 77/77 on proper focused rerun; its fix rides emb-59);
194/200, concepts 0. Committed locally. This closes swe3's dispatched queue for both releases.

## Shipped in v1.6.0 (2026-08-16)

Tagged on public main d22ddf0; pipeline-verified tarball published as agent-embassy@1.6.0 (npm trusted publishing, provenance). Prerelease version grammar shipped; 0.x series treated per-minor, prerelease never writes-covered.
