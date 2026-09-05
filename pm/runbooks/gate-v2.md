# Gate v2 — units, pipelining, and what a gate actually checks (2026-09-05)

Founder direction (2026-09-05): "combine small slices into bigger units to speed up delivery" and
"what exactly are we doing in each gate? is CI not enough?". This runbook replaces the per-slice gate.

## What CI proves and what it does not
CI (4 OS/Node legs + package inspection) proves the suite passes at the exact head. It cannot prove:
(1) a doc sentence is true (emb-111's four cycles were all CI-green); (2) a "characterization" or
"guard" test actually reaches the behavior it claims (the guard that could not see AGENTS:144 was CI-green);
(3) scope discipline — no bug fix riding a refactor, no protocol/tag/verb drift; (4) the freeze's
accounting is honest. Those four are the whole content of the judgment half. Everything else is mechanical.

## Unit = several tickets, one lane, one freeze, one gate
- One commit per ticket id, in the unit's stated order; commit subject starts with the id.
- Characterization-first per ticket: shown green on that ticket's parent commit within the lane, then lands
  with its refactor in the same commit. Local check green at every commit; CI at the head.
- Landable prefix: a HOLD on ticket k lands commits 1..k−1 when they are independently GO; the remainder
  re-freezes. So a HOLD never blocks finished work.
- Budget = sum of the tickets' E-caps; the engineer may reallocate between tickets and sub-caps inside the
  unit total without asking. Only the total is contested. Per-ticket accounting in the freeze.
- Pipelining: the engineer starts the next unit immediately after freezing, on a lane branched from the frozen
  head. A GO makes the rebase a fast-forward; a HOLD means a follow-up commit on the earlier lane and a rebase.
  The engineer never waits for a gate.

## Gate weight by class, not by ticket
- LIGHT (deletions, behavior-preserving refactors with characterization, copy): CI green at the head (read, with
  attempt count) + mechanical script + PM diff read. No model review unless the PM read flags something.
- FULL (wire/control protocol, settlement or store semantics, new public verb, docs-truth sweeps): LIGHT + ONE
  Opus adversarial read of the whole unit; the taste questions are folded into that brief. No separate taste pass.
- Local `npm run check` is NOT re-run when CI at the exact head is green — CI runs the same command on four legs.
  Hash/base verification stays (seconds).
- Only BLOCKER/MAJOR findings re-cycle a unit. MINOR/NIT become a follow-up ticket appended to the next unit.

## Freeze evidence the engineer supplies (so the PM check does not discover it later)
base/head/patch SHA; per-ticket and per-bucket accounting; CI URL at the exact head with attempt count and any
first-attempt failures disclosed; for docs claims: a whitespace-collapsed sweep of every shipped file for the claim
class; for a guard or characterization test: a replay over the parent showing what it rejects/asserts today; the
"shared fixture" answer for any flake; platform-bound tests named.

## Units for the rest of the v3.1 pass (dependencies preserved from the addendum)
- U1 LIGHT  (base main d5be488): emb-112 → emb-113 → emb-127 → emb-123.            budget 500
- U2 FULL protocol (the line's single control-protocol bump): emb-118 → emb-119 → emb-120 → emb-121 →
  emb-126 → emb-128 → emb-117.                                                        budget 950
- U3 FULL settlement/store: emb-122 → emb-124 → emb-114 → emb-115 → emb-116.         budget 1000
- U4 FULL settlement (E9): emb-125.                                                   negotiated ≈400
