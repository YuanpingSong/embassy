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
