---
id: emb-91
title: v2.0 R4 — one send verb: `embassy send --from --to`
kind: normal
size: 1
status: landed
release: v2.0.0
updated: 2026-09-01
---

## Binding

**Why**: emb-87 slice 4, the last cut of the v2.0 charter. The CLI
ships two directional send verbs (`send-to-claude`, `send-to-codex`)
whose direction is fully determined by the endpoints themselves — the
gateway resolves routes by alias and provider, so the verb split is
ceremony. Single-user product, breaking window open.

**Deliverable**: one `embassy send --from <alias> --to <alias>` verb;
the gateway derives direction from the resolved endpoints.
`send-to-claude` and `send-to-codex` are REMOVED — no aliases, no
deprecation shims, no compat arm (the emb-90 precedent: delete end to
end). Reply/await/delivery-status are untouched. Help copy, SKILL.md,
README (en/zh), site quickstart, and GATEWAY-ARCHITECTURE update to the
single verb — every surface the wave just made truthful stays truthful.

**Riders folded in (release riders, priced here because this slice
owns the CLI/help surface anyway):**
1. `peer-stdio` appears in `--help` (it is a shipped verb documented in
   CONFIGURATION.md and absent from help — gauntlet finding).
2. README.md:227-region: kill the stale "federation is deliberately
   disabled in v1" claim (+ zh-CN mirror) — federation shipped in v1.9.
3. CHANGELOG v2.0.0: add the send-verb break under Removed and the
   emb-88 token/busyPolicy narrowings line (retroactive-authorization
   note from the emb-88 landing).

**Caps**: E1-2; src ≤60 changed (measured-remainder rule — contest with
a map if the coherent cut disagrees); tests ≤120; docs itemized. Zero
new concepts. Base = main AFTER emb-97 lands (emb-97 owns cli-copy
files; this slice touches help copy — sequential, no parallel lanes).

**Acceptance**: (1) `embassy send` routes both directions, verified by
execution against a real broker (claude→codex and codex→claude); (2)
the old verbs are refused as unknown commands; (3) no remaining
reference to the deleted verbs in any shipped doc, help string, site
file, or skill (grep-clean, historical CHANGELOG exempt); (4) the site
and README quickstarts still EXECUTE end-to-end with the new verb (the
emb-93 standard: quickstarts are run, not read); (5) full check + soak
green; (6) per-locale parity on every touched copy/doc surface.

**Gate**: mech + targeted adversarial on the direction-derivation only
(mis-routing = consent violation; everything else is deletion + copy).

## Contest ruling #1 (2026-09-01) — GRANTED with conditions

Engineer measured the coherent cut at 98-125 src (target ~112) against
the ≤60 cap, per-file with line ranges: the closed control-method union,
params/result/handler maps, both decoders, and descriptors all change
when two wire methods become one — the exact cost class emb-90 taught
(one legacy arm = 95 lines). The dodge (keeping send_to_claude/
send_to_codex under a new CLI verb) violates "deleted end to end" and
was correctly rejected by the engineer before proposing it.

GRANTED: src ≤130, target ≤115. Tests ≤120 and docs-itemized unchanged.
Conditions:
(a) SURFACE PURITY is the binding: the CLI exposes only `send`; the
    closed v2 control union contains only `send` (both directional
    methods gone). Internal implementation helpers (sendToClaude/
    sendToCodex as private functions) are the engineer's domain — the
    ticket binds the surface, not the internals. The control protocol
    is unreleased, so reshaping the v2 method set costs nothing;
    peer wire stays v1 untouched (state in the freeze).
(b) THE 22-METHOD ENUMERATION emb-93 just fixed in GATEWAY-ARCHITECTURE
    must update in this same slice to the new set and count — the doc
    must never claim methods the union lacks, one slice after we paid
    to make it true.
(c) DIRECTION AUTHORIZATION derives from the RESOLVED source/target
    providers, never from caller-supplied hints — this is the targeted
    adversarial's entire focus at gate (mis-routing = consent
    violation), so build it to be attacked.
Rider scope confirmed as projected: README setup section +
CALLER_IDENTITY_CONFLICT surfaces specifically; no dashboard-copy
expansion.

## Contest ruling #2 (2026-09-01) — GRANTED

Measured at the first compiling end-to-end cut: src 146 (75+/71−) vs
130; tests 250 (106+/144−) vs 120; docs 77 itemized.

Src: GRANTED ≤150, target 146. The +16 includes 12 lines fixing the
live dashboard's two now-false Desktop setup remedies. My contest-#1
scope line said "no dashboard-copy EXPANSION" — this is not expansion,
it is TRUTH-REPAIR of an existing surface rendered false by the same
upstream change the rider exists to document, raised through the
contest channel BEFORE freeze (the correct moment — contrast the
emb-93/F10 lesson where late routing crossed a coherent freeze).
Leaving a documented-false remedy in shipped copy to fit a projection
would invert the wave's entire standard.

Tests: GRANTED ≤250, target as measured. The +130 is mechanical rename
fallout — two closed handler names die, so every existing ambiguity and
settlement matrix must call the sole `send` handler; 144 deletions
against 106 additions is churn, not growth (net −38). The two dodges
(legacy handler aliases; dropping R3 matrices) were correctly
self-rejected — one violates no-shims, the other weakens the gate.

Carried conditions unchanged: surface purity (CLI and closed union
contain only `send`), the method enumeration updates in-slice,
direction derives from resolved providers, peer wire v1 stated in the
freeze. GATE NOTE for the record: with rename-churn this large, the
gate must specifically verify that converted matrices preserved their
assertion strength — the loosened-surviving-assertion check gets its
own line in the brief.

## Mechanical gate verdict (2026-09-01): CLEAN — one accepted relocation

Freeze SHA 3fe73bc2, base 5ca9b4f. GATE CLEAN: accounting exact
(src 146/150, tests 250/250 at-cap recomputed, docs 81 itemized), check
565/565, soak 1/1, concepts 1-authorized (`send`, nothing else new in
any closed set), hygiene clean. Mutations: removed-verb rejection RED;
re-attestation fence RED; hardcoded direction RED in BOTH matrices (7
and 12 fails respectively — the directional coverage is real).
Assertion-strength verified by mechanical sweep (verb-token
normalization + diff across all ten files), not sampling alone:
residual = one deleted case, four added lines, three stub merges.
Executed: both directions through the real CLI land on the correct
adapters with no cross-leak; old verbs refuse as UNKNOWN_COMMAND with
zero dispatches; the 21-method enumeration matches code exactly; BOTH
published quickstarts (site + README, en/zh byte-identical command
sets) execute end-to-end.

**Finding #1, PM ruling — ACCEPTED semantic relocation.** Base refused
a single-identity wrong-direction send client-side
(CALLER_IDENTITY_CONFLICT, exit 2, body never crossed the socket); the
collapsed verb refuses broker-side (route_mismatch, exit 3, body
transits the same-UID control socket, zero dispatch). Under the
ratified OS-boundary model this is where the check BELONGS — the broker
is the authority — and the service-layer refusal is test-pinned
(mutation b + the strengthened peer-principals test). Property
knowingly traded: a doomed body now reaches the same-UID broker before
refusal; within the trust boundary, no other principal observes it.
Recorded, not corrected.

Cosmetic parked: tab-deliveries.tsx keeps constant name
SEND_TO_CODEX_CMD with the new command as its value — internal
identifier, post-release sweep.

Adversarial matrix review: first run killed mid-flight by the Opus
session limit (resets 14:00 ET). Relaunched on the flagship tier under
the subagent-tier rule's stated-reason exception: release-gating
consent-critical review, Opus pool exhausted, founder's delivery order
standing. Landing waits on it.

## Adversarial verdict and LANDING (2026-09-01) — CHARTER COMPLETE

Flagship-tier matrix review (Opus pool exhausted; tier-rule
stated-reason exception): **GO.** 17 authority cells + 15
direction-confusion cells executed against a real control server —
every forged/mismatched principal refused, no cell silently enqueued,
adapter logs contain exactly the accepted cells' frames. The
resolution→re-attestation gap was DRIVEN three ways: mid-send
re-registration refuses (assertThread); the only legal cross-provider
alias flip (peer→claude) is caught by consent edges pinning exact
registrationIds; with an operator-consented edge for the new binding it
correctly delivers. Provenance attributes resolved sources in every
frame; replies round-trip both directions on one conv token;
STEER stays claude→codex-only; dual identity fail-closed with the
env -u remedy shown exactly when both identities present.

Correction bundle (post-release pricing): F1 stale-target refusals read
route_mismatch for codex/claude principals but not_found for peer
principals — distinguishability asymmetry, all cells fail closed; F2
zero-identity send names CLAUDE_IDENTITY_REQUIRED even codex-direction
(neutral CALLER_IDENTITY_REQUIRED exists); F3 pre-existing peer-reply
INTERNAL_ERROR shape; F4 codexDoctor.attached copy implies Desktop is a
supported host. Cosmetic: SEND_TO_CODEX_CMD constant name.

LANDED on public main as **7efec97** from the gate tree (main unmoved
from base). Status: landed. The v2.0 charter (emb-87 inventory →
emb-88/89/90/91 cuts + emb-92..97 riders) is COMPLETE; the release
runbook runs next.
