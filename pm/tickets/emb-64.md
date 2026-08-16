---
id: emb-64
title: Published no-write claims must survive the write probe (docs truth sweep)
kind: docs
size: 2
status: dispatched
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: README.md (:39, :236), SECURITY.md (:185, :350), docs/CONFIGURATION.md (:90),
docs/DASHBOARD.md (:90), docs/GATEWAY-ARCHITECTURE.md (:37, :773, :1053) and their zh-CN mirrors
state that Codex's bounded pre-write reads "never invoke turn/start." Once emb-59 lands, the
compatibility path MAY invoke turn/start against a broker-created disposable thread and leave an
archived artifact. Publishing a falsified claim is a design-law-6 release blocker for v1.6.

**Promises:**
1. Every listed surface (~10 files x 2 languages) states the new truth precisely: ordinary reads
   remain read-only; the OPTIONAL write-attestation probe may create one disposable broker-owned
   thread (bounded, fenced, archived, cleanup-confirmed, zero user-thread contact), currently
   shipping in zero-spend fail-safe until the model pin resolves.
2. No surviving "never turn/start" claim anywhere (grep-proven, both languages).
3. CHANGELOG [Unreleased] records the probe and its fail-safe state.

**Budgets**: docs/copy, priced by surfaces: ~20 surfaces. Tests: none new (the suite's copy
contracts must stay green). Proofread, not code-reviewed.

**Scope contract**: README.md, README.zh-CN.md, SECURITY.md (+ zh mirror if present),
docs/CONFIGURATION.md, docs/DASHBOARD.md, docs/GATEWAY-ARCHITECTURE.md (+ zh mirrors),
CHANGELOG.md. No source files.

## Background

Found by the emb-59 taste review (item 2). The claims are true at HEAD and false after emb-59
lands — sequence this ticket to land WITH or immediately after emb-59, before the v1.6 tag.

## Scope expansion (2026-08-16, from the adversarial review F1)

Third falsified claim added: SECURITY.md:203-205 "Embassy exposes no archive, deletion, shell, ...
method" — thread/archive is now allowlisted (probe-only). State the probe-only containment
precisely. ORDERING REQUIREMENT: this ticket lands adjacent to emb-59 in one sequence, both before
the v1.6 tag.

## Window contest and ruling (2026-08-16)

**Contest**: the grep-proven promise found four published surfaces outside the declared scope still
carrying the falsified claim: CONTRIBUTING.md:75, skills/embassy-peer/SKILL.md:34 (ships in the npm
package), site/index.html:92, site/zh-CN/index.html:92.

**Ruling: expansion APPROVED** — all four files, copy-only, same truth language (ordinary reads
read-only / optional disposable write probe / zero-spend fail-safe today). The site and the shipped
skill are the MOST public surfaces; the enumeration that seeded this ticket came from the taste
review and was never itself grep-verified — the promise's grep is what caught it, which is the
promise working. Correctly preserved as-is: the test fixture's behavioral never-reach assertion and
DECLINED.md's still-true no-authority-from-read-evidence statement. The scoped no-archive language
(ordinary connectors vs probe-only exception) is the intended shape. Budget: size 2 stands.

## Second window expansion (2026-08-16)

**Ruling: APPROVED** — AGENTS.md (multiline-wrapped claim, copy-only) plus test/skill-package.test.ts
and test/public-localization.test.ts (exact contract updates to the new sentences; no new tests).
The contract tests are the promise's own enforcement arm — they must change with the copy or the
suite goes red, which is the verification clause working. Instrument note for the record: single-line
grep is insufficient for prose claims; the multiline/escaped-pattern sweep is the standard from now
on, and promise 2's "grep-proven" means THAT grep. Size 2 stands.

## Landing review — one posture-sentence correction (2026-08-16)

Everything verified as declared (sweeps zero-match, contracts 12/12, full check 773/773 printed,
165/200, mirrors-absent claim to be spot-checked at gate). ONE correction: the founder amended the
effort pin (lowest-advertised) minutes before this handoff, and main is folding it into emb-59 now
— so "the unresolved model pin holds the probe in a zero-spend fail-safe" will be stale at tag time.
Replace the posture sentence on every surface carrying it with the CONDITIONAL form, true in all
worlds: the probe resolves the pinned model's lowest advertised effort; whenever the pin cannot
resolve, it declines in a zero-spend fail-safe before any thread or turn is created. Then re-run
the sweeps + contracts and hand back.
