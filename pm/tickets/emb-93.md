---
id: emb-93
title: v2.0 — pair authority story: OS-boundary docs rewrite + dead attestation params cut
kind: normal
size: 2
status: dispatched
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: emb-90's adversarial review (F1) proved the published authority
story false on every remaining path: pair/unpair have no code path that
attests caller identity (the deleted legacy arm was the last), yet
GATEWAY-ARCHITECTURE.md:616-619, skills/embassy-peer/SKILL.md:10+86,
and README.md:121+256 — all npm-published — still promise fail-closed
`CODEX_IDENTITY_REQUIRED` / `CALLER_IDENTITY_CONFLICT`. Adjacent rot:
`SelectClaudeParams.codexThreadId` is decoded and read by nobody;
pair's optional `threadAttestation` is decoded with no producer (its
service consumers can never fire). Founder ratified option (a),
2026-08-18: document the OS-boundary truth; do not restore attestation.

**Deliverable**:
1. **Docs rewrite** — the authority paragraph
   (GATEWAY-ARCHITECTURE.md:612-628), SKILL.md §Pair (+lines 10, 86),
   README.md:121+256: same-UID control socket is the authority for edge
   minting; consent semantics are enforced at delivery via paired-mode
   membership; the dashboard is an operator surface, not the sole
   unattested path; agents remain norm-bound to create only
   user-chosen edges (that instruction stays, as a norm, not a claimed
   gateway enforcement).
2. **Dead-param cut** (v2.0 breaking window, same class as emb-87..91):
   remove pair/unpair `threadAttestation` (param, decoder
   control.ts:435-448, service branches service.ts:1134/1147 incl. the
   unreachable pair-path CODEX_THREAD_MISMATCH at :1188-1193) and
   `SelectClaudeParams.codexThreadId` (decoder control.ts:429-433).
   Registration/reply identity paths are UNTOUCHED — register-codex's
   threadId is real and stays.
3. **F3**: control-plane doc says "version 1" (GATEWAY-ARCHITECTURE.md:562)
   → rewrite for control protocol 2 and document all 22 methods,
   including the six federation/peer methods undocumented since v1.9.0.
4. **F6**: draft the CHANGELOG v2.0.0 section skeleton: both accepted
   breaks (v1 control frames refused; pair --claude/--codex removed)
   plus an explicit "authority model correction" upgrade note, repo
   precedent v1.9.5 style. Release runbook completes it at release.

**Caps**: E2; src changed ≤35 (pure deletion + decoder tightening;
measured-remainder rule applies); tests ≤80 (existing threadAttestation
fixtures adjust; rejection coverage must not weaken — unknown-key
refusal of the removed fields becomes the new assertion); docs
uncapped-but-itemized in the freeze. Zero new concepts. R3.

**Base**: main AFTER emb-90 lands (control.ts/service.ts collision
otherwise). Sequencing: emb-92 → emb-90 re-freeze/land → emb-93 →
emb-91 → v2.0.0.

**Acceptance**: (1) no text in the published set claims pair/unpair
attestation or fail-closed identity for edge minting; (2) sending
`threadAttestation` or `codexThreadId` in a v2 frame is refused as an
unknown key (closed decode), with tests; (3) register-codex/reply
identity behavior byte-for-byte unchanged; (4) control-plane doc names
version 2 and all 22 methods; (5) CHANGELOG section drafted; (6) full
check + soak green.

**Ops note**: after landing, reinstall skills/embassy-peer to
~/.claude/skills on both machines (local copies carry the old
fail-closed claim).

## FOUNDER HOLD — wave stops here (2026-08-18)

Founder ruling: hold after emb-93. The wave runs emb-94 → emb-95 →
emb-93 and then stands down. emb-91 is NOT dispatched. No release step
of any kind tonight: no version bump, tag, publish, CHANGELOG
finalization, reset drill, or live ops. emb-93 may draft the CHANGELOG
v2.0.0 skeleton per its own binding — drafting is not releasing.

Hold delivered to the engineer over the live channel (conv_hrVMeVbG…),
not by relay. Instruction included the emb-90 crossing-messages
precedent: if the hold arrives mid-slice, finish to a COHERENT freeze,
then stop — never abandon mid-edit to comply faster, and never proceed
past a freeze on assumption if the PM is unavailable to gate.

RESUME STATE for the next session: gate whatever is frozen, then
emb-91, then v2.0.0 via pm/runbooks/release-npm.md with the three
riding doc fixes (README federation line at README.md:227, peer-stdio
missing from --help, release-note line for emb-88's token/busyPolicy
narrowings), then both machines install and run the reset drill, then
the cross-machine message proof with this-mac.
