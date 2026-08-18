---
id: emb-90
title: v2.0 R3 — private control cleanup: delete legacy pair arm, bump control protocol
kind: normal
size: 2
status: landed
release: v2.0.0
updated: 2026-08-17
---

## Binding

**Why**: emb-87 slice 3. The generic pair/unpair syntax (--from/--to →
{aliases, threadAttestation?}) is current; the compatibility arm still
accepts CLI --claude/--codex (legacyArm ~9 src lines), control
LegacyPairParams + union helpers + decoder fallback (~30 src lines), and
~32 test references (~80–110 test lines).

**Deliverable**: delete the legacy arm end to end; bump the private
control protocol version so one protocol never teaches both shapes.
Breaks old CLI scripts and old control frames only — no durable state,
no reset. Public docs already use the generic form.

**Caps**: E2; src changed ≤60 (measured-remainder rule: contest with a
map if the first coherent cut disagrees — pre-estimates are projections);
tests/docs ≤140; zero new concepts (a protocol version bump is not a
concept). Base = public main 788a6f3 (emb-89 included). Freeze with SHA;
adversarial-only gate unless the diff surprises (control decoding is a
trust seam but the cut is pure deletion).

## Contest ruling (2026-08-17)

Measured cut: src +26/-63 = 89 changed, NET -37, every line inside the
named deliverable; the ≤60 cap would force protocol-1 literals/types to
survive inside the v2 implementation — do-not-golf bars it. Test
remainder is compiler-derived (17 CLI + ~32 control + 3 dashboard + 1
server typed fixtures plus version literals). GRANTED: src changed ≤90;
tests/docs ≤230, target = final numstat. RIDER confirmed from the
engineer's own note: the PEER wire protocol stays version 1 — only the
private CONTROL protocol bumps to 2; the freeze must state both numbers
explicitly so the two protocols are never conflated.

## Third contest ruling (2026-08-17, during hold)

decodeResponse still hard-coded control protocol 1 at three sites
(control.ts:1101/1103/1110) — without the fix the v2 client rejects every
valid v2 broker response (focused tests prove it). GRANTED: src ≤96
(target 95), +3/-3, net unchanged -37, zero concepts; peer wire stays v1.
This is completion-to-coherence, not scope growth — a frozen slice must
be internally consistent. HOLD REMAINS: freeze, then stand down; gate and
landing wait for the founder's resume.

## Pause state (2026-08-17, founder hold)

Lane frozen at SHA 6520e3a2, src 89 changed net -37, tests 215, protocol
split stated per rider (control v2 / peer wire v1). The pause message and
the third-contest grant CROSSED: the freeze intentionally excludes the
granted +6 decoder fix, so the focused behavioral run is knowingly red
(decodeResponse still v1 at three sites; valid v2 responses rejected).
Documented, safe, nothing running. ON RESUME: apply the granted +6,
re-freeze with new SHA, then gate. Message-crossing recurrence noted for
the retro (second occurrence class; first was the v1.9 triple-grant).

## Coherent freeze (2026-08-17, hold in force)

Engineer applied the granted +6 and re-froze coherently: SHA 946195fb,
src 95 changed net -37 (grant ≤96, target hit exactly), tests 215 (≤230),
zero concepts, protocol split stated (control v2 / peer wire v1 —
peer-stdio fixtures correctly remain literal 1). Narrow evidence only:
typecheck green, focused 82/0. No full check, no gate, no landing, no
emb-91 — hold respected. Lane parked awaiting founder resume; gate runs
then.

## Gate + adversarial verdict (2026-08-18, on m5dev)

Mechanical gate CLEAN: sha ✓ base ✓ apply ✓ accounting exact (src 95
changed net −37 / grant 96; tests 215 / grant 230) ✓ checks 555/555,
zero fail/cancelled/skipped ✓ hygiene ✓. Adversarial review (fresh-eyes,
Opus): **HOLD** — two blocking findings, both demonstrated by running
code, plus a correction bundle.

**F1 (HIGH, → founder ruling, not engineer scope).** The slice deletes
the only arm that ever produced `threadAttestation`; post-slice, pair/
unpair have NO code path that attests caller identity, while three
published surfaces still promise fail-closed behavior
(GATEWAY-ARCHITECTURE.md:616-619, skills/embassy-peer/SKILL.md:10+86,
README.md:121+256 — all in the npm `files` list). Demonstrated: bare-env
`pair` exits 0 and mints the edge; CODEX_THREAD_ID is silently dropped.
Honest framing (reviewer's own): the surviving generic arm never carried
identity at base — operator-shell pairing already worked — so the slice
did not create the capability; it removed the last path where the docs
were true. Adjacent: `SelectClaudeParams.codexThreadId` is decoded and
read by nobody, so the whole authority paragraph is stale as a unit.
Resolution fork (founder's call, trust-model): (a) rewrite docs/SKILL to
the OS-boundary truth — same-UID socket is the auth, consent semantics
live in paired-mode delivery, agents constrained by skill norms; or
(b) restore attestation on the surviving arm — adds permissioning back
against the standing trust-model directive. PM recommends (a), executed
as a docs/authority ticket (emb-93) before v2.0.0 ships, with an
explicit release-note correction of the published claim.

**F2 (MEDIUM, blocking, engineer correction inside this ticket).** The
literal→symbol substitution made the suite invariant under the version
value: reviewer set the constant to 7 and all protocol-bearing tests
passed; no test asserts the control protocol is 2. This is the exact
class of the v1.9.3 dead-tag postmortem ("the embedded version constant
and its pinned test were not bumped"). CORRECTION ORDERED: one literal
assertion pinning GATEWAY_CONTROL_PROTOCOL_VERSION === 2 (plus, at
engineer's discretion, one frame-level literal-2 assertion).

**F4 (LOW, ordered with F2, test-only).** Drop the now-meaningless
`CODEX_THREAD_ID` env from the pair/unpair CLI matrix fixtures and
restore a mixed-arm (`--claude` + `--to`) rejection case.

**F3 (control-plane doc says "version 1", also 6 undocumented federation
methods since v1.9.0) and F6 (no CHANGELOG v2.0.0 section for either
accepted break)** → fold into emb-93 with F1's rewrite; CHANGELOG is
also independently guarded by the release runbook.

**F5 (LOW, narrow)** — peer-stdio flattens CONTROL_INVALID_RESPONSE skew
into generic −32603 during a cross-install rollout window — DECLINED for
now: dialer still stage-classifies PEER_DIAL_FAILED; revisit only if the
v2.0 rollout drill actually hits it.

**Verified sound (kept for the record):** all 22 control verbs refuse
versions {1,3,"2",null} before param decode with protocolVersion:2 on
every error frame; zero control-path literals remain (the third-contest
class is dead); peer wire and helper IPC stay literally 1 — no
conflation; version skew yields CONTROL_INVALID_RESPONSE ambiguous=false
with the rebuild hint; socket takeover impossible (SOCKET_IN_USE);
decodePair behaviorally identical and rejection fixtures got stronger;
deletion complete across src/test/scripts/docs/workflows/help copy; soak
passes (1/1, 61.2s — gate brief omitted soak; reviewer covered it;
gate-runner calibration note: R3 gates must name soak explicitly).

**State**: HOLD. Engineer applies F2+F4 (test bucket has headroom:
215/230), re-freezes with new SHA; delta re-gate then landing. F1 fork
awaits founder; emb-93 opens after that ruling.

## F1 resolution (2026-08-18): founder ratified option (a)

OS-boundary model is the truth we document: same-UID control socket is
the authority for edge minting; consent semantics are enforced at
delivery (paired-mode membership); agents remain norm-constrained via
the skill. No attestation restoration. Executed as emb-93 (docs +
dead-param cut + CHANGELOG), landing before the v2.0.0 release gate.
emb-90 itself remains HOLD only for the F2+F4 test corrections.

## Landed (2026-08-18)

Replacement freeze SHA 2d2781f9, base 788a6f3. Gate CLEAN: sha ✓ base ✓
apply ✓ accounting exact (src 95 net −37 / grant 96; tests 216 / grant
230) ✓ check 555/555 ✓ soak 1/1 ✓ hygiene ✓. F2 verified by MUTATION,
not by inspection: with GATEWAY_CONTROL_PROTOCOL_VERSION forced to 7 the
protocol-bearing files now fail (69 tests, 1 fail) where the previous
freeze passed silently; pin is `assert.equal(GATEWAY_CONTROL_PROTOCOL_
VERSION, 2)` at test/gateway-control.test.ts:447. Constant restored and
tree re-verified by SHA before landing. F4 corrections present.
Landed on public main as **5cb2b6d** from the gate tree the check ran in.
Status: landed.
