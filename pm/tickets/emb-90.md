---
id: emb-90
title: v2.0 R3 — private control cleanup: delete legacy pair arm, bump control protocol
kind: normal
size: 2
status: dispatched
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
