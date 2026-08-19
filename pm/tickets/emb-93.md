---
id: emb-93
title: v2.0 — pair authority story: OS-boundary docs rewrite + dead attestation params cut
kind: normal
size: 2
status: landed
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

## Contest ruling #1 (2026-08-18) — GRANTED, with a premise correction

Engineer disproved part of the binding against the fresh base: the
ticket (via emb-90's review) called SelectClaudeParams.codexThreadId
"decoded and read by nobody" — true of the SERVICE, but cli.ts:378-385
still PRODUCES the field from inherited CODEX_THREAD_ID. A parser-only
cut would leave the CLI emitting a key the closed v2 decoder refuses:
every select-claude run inside a Codex task would break, shipped as a
"dead code" cut. The complete dead-authority cut is producer + parser +
consumers: cli.ts 11, control.ts 23, service.ts 4 = 38 changed, net −24.

GRANTED: src ≤40, target 38. All other caps and scope unchanged. The
binding's premise paragraph is corrected by this ruling; the deletion
REMAINS correct under founder option (a) — the field carried authority
nothing enforced — but the cut is now honest about what it removes.
Verifying-against-the-moved-base before editing is the standard; this
contest is the standard working.

## Adversarial verdict (2026-08-18): HOLD — correction #1 ordered (docs/copy only, src untouched)

SHA e095cfc9. The CORE IS SOUND, verified hard: the authority rewrite
executes true in both directions (20-cell pair/unpair/select/unselect ×
identity-env matrix — no identity field on any frame, docs promise no
more and no less); identity paths behaviorally identical to the shipped
binary in 25/25 cells; no surviving producer of the removed keys
anywhere in the repo; closed decode verified by raw frames; the
duplicate-name amendment holds clause-by-clause against emb-94's landed
fence; the README quickstart is internally executable. The src cut is
clean and DONE — correction #1 touches no source.

**F1 (blocking, scope gap was the PM's) — the published site still
teaches select-claude as the pairing step.** site/index.html:89/:144/
:170-172 + zh-CN:89: quickstart runs register → select → pair(wrong
endpoints) → send, which settles SENDER_NOT_PAIRED — executed.
addConsentEdge has exactly one caller (pair); selection never touches
the consent graph. The site was outside the dispatched window; it joins
it now. Scoping fact that makes the fix safe: `pair --from/--to` exists
and works on published 1.9.5 AND main, so pair-first site copy is
version-agnostic-correct and can land ahead of the release. CORRECTION:
site/index.html + site/zh-CN/index.html — pairing copy and quickstart
teach select (route) then pair (consent edge, the two endpoints the
send will use); no visual/design changes (founder owns the site's
design; this is copy-truth only, flagged for founder visibility).

**F2 (blocking) — the rewrite removed the only disclosure that
unselect-claude destroys consent edges.** Executed: unselect removed
BOTH incident edges and settles in-flight work (removeOwnedRoute →
removeRegistrationMetadata). The Codex-side twin (unregister-codex) is
documented; the Claude side now claims "selection creates no permission
edge" without the destructive converse. CORRECTION: one honest sentence
on each rewritten surface (README, GATEWAY-ARCHITECTURE, SKILL, + zh):
selecting creates no edge; REMOVING the selected route also removes its
consent edges and settles their in-flight work.

**F3 (fold in) — the new arch pin is vacuous**: /same-UID.*private
control socket/s is satisfied by unrelated prose spans; deleting the
ENTIRE new authority paragraph stays green (executed). Pin the
paragraph by its own words.

**F4 (fold in) — the Upgrade note omits the two mandatory operator
actions**: the schema-4 state reset (emb-88; GATEWAY_STATE_SCHEMA_
UNSUPPORTED otherwise) and mandatory nodes.json (emb-89;
GATEWAY_NODE_INVENTORY_REQUIRED). Precedent is the 1.9.5 note (concrete
actions live there). Also: the pair-arm removal files under Changed;
this file uses Removed. Fix both.

**F6 (fold in, one clause)** — the authority correction must disclose
that the prior published claim was NEVER ENFORCED on the surviving
generic arm (executed against shipped 1.9.5-lineage binary: bare-shell
pair/unpair succeed), not read as a 2.0 relaxation. The v1.x history
entry stays (history is history); the 2.0 note carries the disclosure.

**F7 (fold in)** — zh-CN asserts capability where EN asserts norm
(只能 vs "are instructed to", twice). The norm-vs-enforcement
distinction is this slice's thesis; the zh reader currently keeps the
retracted guarantee. Match the deontic framing.

**F8 (fold in, one sentence)** — SKILL's --session recovery sentence
now reads ambiguously as "pair by UUID", which the CLI refuses
(executed, INVALID_ARGUMENTS); scope it explicitly to selection.

**F5 recorded-accepted:** the installed 2.0.0-rc.1 binary is a live
producer of codexThreadId, so select/unselect from INSIDE a Codex task
fails INVALID_REQUEST against a broker carrying this slice while
succeeding from a terminal — identity-conditional and undiagnosable.
Narrow (pre-release rc, replaced at the release drill); the release
runbook already replaces every install. Noted so the drill order stays
stop-broker → install → start.

**Budgets:** src UNCHANGED (38/40 — do not touch source); tests ≤95
(the F3 regex fix + any parity additions); docs ≤200 itemized, site
files join the window. Measured-remainder rule in force. Second freeze
= new SHA; gate = mech + docs-truth spot re-execution on the corrected
sentences only.

## Replacement freeze verdicts and LANDING (2026-08-18) — WAVE CLOSED

SHA 4eceb182, src sub-hash 9d344066 byte-identical to the verified cut
(correction #1 proven docs-only cryptographically). FINAL GATE CLEAN:
accounting exact across all three itemized buckets, check 565/565, soak
1/1, hygiene clean, concepts inherited-and-reconfirmed. The F3 pin is no
longer vacuous: deleting the entire authority paragraph now reddens
public-localization (proven by mutation). Every ruled correction
re-executed true: the SITE QUICKSTART runs end-to-end against a real
broker through the real CLI and the send is ACCEPTED (register → select
→ pair the exact send endpoints → conv_/dlv_ tokens returned) in both
locale variants; the unselect disclosure is present on all four
surfaces AND demonstrated (edge paired → unselect → consentEdges []);
CHANGELOG has the pair-arm removal under Removed, both mandatory
upgrade actions, and the never-enforced disclosure verbatim; zh-CN uses
应 (norm) with EN intact; --session recovery scoped to selection.

LANDED on public main as **c022cf2** from the gate tree the checks ran
in (main had not moved from base 1f5f42c). Status: landed.

The v2.0 deletion wave stands down here per the founder hold.
