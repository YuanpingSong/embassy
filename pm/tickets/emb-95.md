---
id: emb-95
title: v2.0 — sandbox-denied control socket reports the wrong cause and the wrong fix
kind: bug
size: 1
status: landed
release: v2.0.0
updated: 2026-08-18
---

## Binding

**Why**: Proven live on m5dev, 2026-08-18. A Codex engineer task could
not reach a healthy running broker. Raw errno:

    ERR EPERM connect /Users/.../\.local/state/agent-embassy/control.sock

Same machine, same uid (the task listed a file inside a 0700 dir), same
build on both sides (2.0.0-rc.1), broker alive and serving other clients
throughout. The macOS sandbox denied the connect — connecting to a unix
socket counts as a write, and the state dir sits outside a default
Codex workspace-write profile.

The product handled this badly, and the cost was real: roughly four
round trips of founder-relayed debugging.

1. Every connect-stage failure collapses into `CONTROL_CONNECT_FAILED`
   (control.ts:1183 — the `else` bucket), so EPERM, EACCES, ENOENT, and
   ECONNREFUSED are indistinguishable to the operator. The errno the OS
   handed us — the single most diagnostic fact available — is discarded.
2. The advice printed is actively WRONG for this case: the operator is
   told the gateway is unavailable and to start it with `embassy serve`,
   while the broker is running and healthy. Following that advice leads
   to `GATEWAY_INSTANCE_IN_USE`, which we observed.
3. The version-skew hint fires on the adjacent `CONTROL_INVALID_RESPONSE`
   path even when client and broker are the same build (also observed).

This is the integration's core use case: a sandboxed agent task talking
to the gateway. The gateway being unreachable from inside a sandbox is
a supported-configuration question; being unreachable AND misdiagnosing
itself is a defect.

**Deliverable**:
1. Classify the connect stage by errno rather than collapsing it.
   Distinguish, at minimum, "denied by policy" (EPERM/EACCES) from "no
   socket at this path" (ENOENT) and "nothing listening" (ECONNREFUSED).
   Prefer distinct safe codes; if the code set must stay closed, carry
   the distinction in the hint. No raw paths or errno text beyond what
   the CLI already prints locally.
2. Copy that names the real cause and the real fix, both locales. For
   the denied case: the socket exists and something is listening, but
   this process is not permitted to connect — grant this task write
   access to the gateway state directory; do NOT start a second broker.
3. Scope the version-skew hint to genuine skew, so it stops firing when
   both sides are the same build.
4. Document the requirement in docs/CONFIGURATION.md and the
   embassy-peer skill: a sandboxed Codex task needs the gateway state
   directory reachable (writable-root grant or equivalent approval).
   State it as a prerequisite of registration, not a troubleshooting
   footnote.

**Caps**: E1; src changed ≤45; tests ≤80; zero new concepts — this is
classification and copy, not a new mechanism. Base = main after emb-94.

**Acceptance**: (1) a connect denied by sandbox policy is reported
distinguishably from a missing socket and from no listener, with a test
per branch; (2) the denied-case guidance never tells the operator to
start a broker; (3) the skew hint does not fire when versions match;
(4) the sandbox prerequisite is documented in CONFIGURATION.md and the
skill; (5) full check + soak green.

**Explicitly NOT in scope**: relocating the control socket or the state
directory. Moving it to reach a sandbox is a threat-model change, not a
copy fix, and the shipped guidance already warns against relocating
state to work around access failures. If we later decide sandboxed
reachability by default is a product goal, that is its own ticket with
its own review.

## Freeze received (2026-08-18) + release-time ops note

Frozen at SHA 5305351c on base 9754888 (pre-emb-94; files disjoint from
emb-94's service.ts, so landing order is free). In gate: mechanical pass
plus an independent adversarial pass focused on ambiguity preservation
for mutating verbs — a failure after a write that reports as a clean
pre-write connect error would invite retrying a mutation that already
applied, which is the worst outcome this slice could buy.

Per-mechanism mutation is required on this gate (norm earned on emb-94's
F11): each new branch — denied, missing socket, no listener, narrowed
skew — is defeated independently, and any branch that can be removed
with the suite still green is unpinned behavior.

F10 from emb-94's review was routed here but arrived after this coherent
freeze; it is filed as emb-96 (QUEUED) rather than reopening this slice.

**RELEASE-TIME OPS NOTE (belongs in the v2.0.0 runbook, applies to
emb-93 as well):** this slice edits `skills/embassy-peer/SKILL.md` in
the repo, but the INSTALLED copies are separate files at
`~/.claude/skills/embassy-peer/` and `~/.codex/skills/embassy-peer/` on
BOTH machines. Publishing does not update them. Every machine must
reinstall the skill after v2.0.0, or agents keep operating from copy
that this release makes false — the same class of failure emb-93 exists
to fix.

## Gate interruption note (2026-08-18)

Both emb-95 verification passes (mechanical + adversarial) were
interrupted mid-run by a PM-side compute session limit (resets 05:50 ET).
The freeze at SHA 5305351c is untouched and remains the gated artifact;
passes relaunch after reset. No results from the interrupted runs are
used.

## Gate + adversarial verdict (2026-08-18): HOLD, corrections ordered

MECHANICAL GATE CLEAN at SHA 5305351c: accounting exact per-file, check
559/559, soak 1/1, locale key symmetry exact, all four branches
independently mutation-pinned (the ENOENT mutation reddens the
ambiguity-preservation test — the safety property is actively watched).
Concepts ruling: the four new transport codes are the DELIVERABLE, not a
concept violation — the ticket said "prefer distinct safe codes," its
zero-concepts clause meant no new mechanism, and the closed WIRE code
set is untouched. Engineer scored it correctly.

ADVERSARIAL: HOLD. The safety core held completely — across 99 driven
cases on all 11 mutating verbs, no post-write failure can ever be
reported as a clean retryable pre-write error; the incident's exact
shape is fixed end-to-end; no information leaks; retryability honest;
zh-CN hint facts match en. The blockers are at the edges the fixtures
stubbed:

**F1 (blocking) — the historically-real skew class lost its remedy.**
The skew hint moved onto CONTROL_VERSION_MISMATCH only, but the protocol
integer has been bumped exactly once in project history (this very
release); every REAL skew v1.0.0→v1.9.5 was result-shape drift at the
SAME integer → CONTROL_INVALID_RESPONSE, which now prints a bare
"gateway unavailable" with no advice — a side-by-side regression vs
base, live today in our own six-worktree dogfooding. CORRECTION: restore
a remedy on CONTROL_INVALID_RESPONSE naming both possibilities (same-
version shape drift → rebuild/repoint; otherwise broker restart),
without re-widening the false "skew" claim the narrowing removed.

**F3 (blocking) — a denied socket can still be told to run serve.**
A wrong-mode socket (incl. mode-000 = denied) routes to pre-flight
CONTROL_SOCKET_UNSAFE whose copy ends "…before running `embassy serve`"
— the incident verbatim, contradicting the "do not start a second
broker" copy shipped in this same diff. And SKILL.md:37, eleven lines
below the slice's own new paragraph, still instructs agents to start
`embassy serve` on the exact phrase ("gateway unavailable") the denied
path prints. CORRECTION: fix the UNSAFE copy (drop/condition the serve
clause) and condition the SKILL.md serve instruction on the denied case.

**F2 (fold in) — pre-flight collapses a permission-denied STATE DIR
into "socket unavailable"** (identical bytes to no-broker), and
CONTROL_SOCKET_MISSING is dead at the CLI surface (pre-flight always
beats it; TOCTOU-only). The incident's own path (readable dir, denied
connect) works — acceptance (1)'s three-way split IS distinguishable at
the CLI (SOCKET_UNAVAILABLE / CONNECT_DENIED / LISTENER_UNAVAILABLE) —
but a dir-unreadable sandbox misdiagnoses as absence: the inverse error
the ticket named. CORRECTION: classify pre-flight lstat EPERM/EACCES as
denied (REUSE the existing code; zero new concepts), and add at least
one end-to-end test driving the REAL pre-flight + REAL transport chain
with no stubs — the fixture seam that hid all of this.

**F5 (fold in)** — docs/CONFIGURATION.zh-CN.md lacks the prerequisite
paragraph; zh-CN parity is standing discipline. **F6 wording (fold in)**
— the prerequisite applies to EVERY Embassy call, not "before
registration"; say so.

**Deferred with reasons (not in this slice):** F4 — skew is unnameable
on all 11 mutating verbs because the ambiguity override wins;
conservative and SAFE (a v1 broker rejects before dispatch, so nothing
applied), but maximally uninformative; improving it means touching the
ambiguity machinery — the safety core — and does not reopen under this
E1. Backlog with the reviewer's reasoning. The v2.0.0 runbook's
stop-install-start order avoids the live case. F6's await-receipt-leg
local catch (misses the denied hint after the message already printed):
narrow, backlog. Cosmetic: hint.controlInvalidResponse key name drifted
from its trigger — fold into whichever correction touches that copy.

**Correction budgets:** src ≤55 (was 45), tests ≤110 (was 80), docs
itemized; measured-remainder rule in force; zero new concepts binding
(reuse existing codes). Base unchanged 9754888. Replacement freeze with
new SHA; delta re-gate then landing.

## Second-freeze verdict (2026-08-18): HOLD — correction #2 ordered

SHA c465a872. Mech gate: sha/base/apply/accounting/check 560-560 all
clean before a concepts halt that was PM-brief error, resolved by
carrying the first gate's ruling forward (gate norm: superseding-freeze
briefs must carry prior rulings). Adversarial delta: HOLD.

**What held, emphatically:** the ambiguity core survived 192 additional
driven cases (168 library-level across 14 mutating shapes × 12 post-
write behaviors + 24 real-CLI) with zero violations, and no remedy hint
ever leaks onto an ambiguous mutation. The ACTUAL sandbox shape
(metadata readable, connect denied on the socket) classifies correctly
end-to-end with the right hint in both locales and no serve advice. The
inverse error does not exist: an absent broker is never reported as a
permission problem, and the SKILL conditioning preserved the correct
start-the-broker path for the genuinely-absent case. zh-CN asserts the
same facts. No information leakage.

**F1 (blocking) — the state-dir denial fix does not fire.** cli.ts:678
calls loadIdentity() BEFORE validateSocket(); federation-nodes.ts:98-101
converts every non-ENOENT lstat error into
INVALID_GATEWAY_CONFIGURATION → exit 2, retryable:false, "request
rejected", no guidance — and CONFIGURATION.md:84 documents that code as
an env-value problem, steering the operator toward relocating
EMBASSY_STATE_DIR, the action this diff's own new paragraphs forbid.
The new branch at cli.ts:449-455 is reachable only by a synthetic
socket-only-metadata ACL no sandbox produces. The supporting test
inherits the harness's loadNodeInventory stub — a green proof of
behavior the binary does not have, in a test named "the real CLI
preflight". CORRECTION: classify the denial where the FIRST state-dir
syscall happens — the loader's errno path (EPERM/EACCES on
lstat/open/read of the state dir or nodes.json) must surface as the
denied classification (REUSE CONTROL_CONNECT_DENIED; identical remedy),
while genuine env-value/parse failures keep
INVALID_GATEWAY_CONFIGURATION. The proving test must run the UNWRAPPED
CLI: no loadNodeInventory stub, no validateControlSocket stub, no
sendRequest stub — all three seams named because each has now hollowed
a test in this wave.

**F2 (fold in) — the narrowing regressed at the copy layer.** cli.ts:746
prints ONE hedged remedy for both CONTROL_VERSION_MISMATCH and
CONTROL_INVALID_RESPONSE; a genuine integer mismatch now gets a
fallback branch (restart) that cannot fix it and burns memory-only
watches and settles in-flight work. CORRECTION: distinct copy key for
VERSION_MISMATCH (rebuild/repoint only, no restart branch); the
two-cause remedy stays only on INVALID_RESPONSE. Copy keys are not
concepts.

**F4 (fold in, wording)** — "for every Embassy call" is false for
--version/--help/serve and understates the mechanism (the state-dir and
nodes.json READS fail first, which is exactly F1's signature). One
sentence each in CONFIGURATION.md, zh-CN, SKILL.md: every call that
talks to the broker; reads of the state dir come first.

**Recorded-accepted, NOT in the correction:** F3 — the two-cause remedy
also prints on non-Embassy garbage and on await_peer correlation
failures where "retry" is wrong; the error CODE stays precise and the
hint is advisory; revisit if it bites (the correlation sub-case rides
the terminal-message-semantics backlog line). F5 —
CONTROL_SOCKET_MISSING is unreachable from the one-shot CLI (pre-flight
always pre-empts) but genuinely reachable from the long-lived
dashboard --live session; kept, reachability noted.

**Budgets:** src ≤70, tests ≤130, docs itemized; measured-remainder
rule; no new safe codes (copy keys excepted). Base unchanged 9754888 —
emb-94 landed at da29280 but touches only service.ts + its test,
disjoint from this slice; landing-tree re-verify covers the stack.
Third freeze = new SHA; mech re-gate + targeted delta on the F1 path
only.

## Contest ruling #1 on correction #2 (2026-08-18) — GRANTED

Engineer measured the first coherent cut at 79 src (cap 70): cli-copy.en
8, cli-copy.ts 2, cli-copy.zh-CN 8, cli.ts 16, control.ts 23,
federation-nodes.ts 22. The +9 is the ruling's own thoroughness — the
full first-failure boundary in the loader (root lstat, canonical
resolution, nodes.json lstat/open/read) plus the distinct
VERSION_MISMATCH copy key in both locales. The named compression
alternatives each violate the order. GRANTED: src ≤80, target 79.
federation-nodes.ts formally joins the window (implicit in correction
#2's "classify where the first syscall happens"; made explicit here).
All other caps and scope unchanged: tests ≤130 (measured 122), docs 16,
no new safe codes. Freeze itemizes per file as measured.

## Resumed mech-gate report for c465a872 (2026-08-18, post-HOLD)

The resumed mechanical gate completed after the adversarial HOLD was
already ruled: GATE CLEAN for the c465a872 artifact — accounting exact,
560/560, soak 1/1, concepts PASS by carried ruling, all seven mutations
RED, locale symmetry 17=17=17, all five spot checks correct (incl.
mode-000 socket printing no serve advice, and state-dir denial
classifying as denied WITH the loader stubbed — see below).

Two items of record value despite the artifact being superseded:
1. **Independent convergence on the F1 seam.** Row (h) confirmed the
   named end-to-end test drives real pre-flight + real transport, but
   flagged unprompted that the suite's file-local wrapper stubs
   loadNodeInventory on every invocation — the exact seam the
   adversarial pass proved hollow (the loader pre-empts the denied
   classification in the unwrapped binary). Mechanical and adversarial
   verification converged on the same defect from opposite directions;
   correction #2's unwrapped-CLI requirement (all three seams named) is
   confirmed as the right cure.
2. **Lane "drift" during the gate — resolved as legitimate, no
   violation.** The gate observed the lane change mid-run (12 files,
   new hash, federation-nodes.ts appearing). Timeline: the c465a872
   freeze was VACATED by the adversarial HOLD and correction #2 was
   ordered and contest-granted before the resumed gate finished; the
   observed writes are the engineer executing correction #2 exactly as
   instructed. The gate agent was right to flag rather than assume —
   a frozen lane changing mid-gate is normally a stop-everything event
   — and the verdict correctly binds to the archived patch
   (emb95c.patch), not the lane. Process note for the gate norm: when a
   HOLD vacates a freeze while a gate is still running, the PM should
   notify the running gate agent; this flag cost nothing but could have
   cost a halt.

## Third-freeze verdict (2026-08-18): HOLD — correction #3 ordered (narrow)

SHA a771cf3e. MECH GATE CLEAN: accounting exact per-file (79/80, 126/130,
docs 16), check 561/561, soak 1/1, concepts exact (the four
pre-authorized codes, nothing beyond, no new mechanism), all EIGHT
mutations pinned, and the unwrapped test verified genuinely unwrapped —
it bypasses the stub wrapper by direct import alias, and mutating the
REAL loader turns it red (impossible if stubbed). The remedy split, the
denial discriminator (same dir: readable+no-broker → SOCKET_UNAVAILABLE
vs denied → CONNECT_DENIED), and 18-key locale symmetry all verified.

ADVERSARIAL DELTA: the denial matrix held five ways unwrapped (parent
000, three ACL shapes, socket-only), boundaries held for eight
prior-classification cases, no ownership masquerade (assertOwned
precedes realpath/open — a hostile-planted path cannot present as
denial), broker-down stays distinguishable, ambiguity sentinel intact
after the cli.ts edit (incl. version-skewed and malformed replies to
started writes staying AMBIGUOUS), --version/--help unaffected, no
leakage. But: HOLD.

**F1 (blocking, INTRODUCED by correction #2) — `embassy serve` on a
denied state dir now claims "the broker may be running… Do not start a
second broker."** serve calls the same loader (server.ts:132) before the
instance lease, so the unscoped reclassification routes the boot path
into the client-shaped denial hint — three false statements (no broker
exists; nothing connected; the one correct action is prohibited), both
locales, where base merely misclassified without asserting anything
false. Compounds with SKILL.md:37 which tells the agent to run serve.
CORRECTION: scope the denied classification to CLIENT calls; serve's
loader failure gets a serve-appropriate honest message (cannot access
the state directory due to local policy — grant access) with NO
broker-may-be-running claim and NO second-broker prohibition.

**F2 (fold in, one sentence)** — EMBASSY_STATE_DIR pointing at a
genuinely inaccessible foreign path (root-owned target, typo) is
byte-identical to the sandbox denial; the two need opposite actions and
the errno cannot distinguish them. CORRECTION: hedge the denied hint in
both locales: if access was expected to work, also verify
EMBASSY_STATE_DIR points at this user's own state directory.

**F4 (fold in) — three of four loader branches unpinned**; reverting the
nodes.json open branch to the old convert-to-config behavior passes the
ENTIRE suite, and that branch is real (ACL deny read on nodes.json
alone, executed). CORRECTION: pin each REACHABLE branch (nodes.json
lstat/open/read) with a mutation-red test. The realpath branch is
unexercisable on macOS (root lstat always fails first): engineer's
choice — delete the defensive branch or keep it with an honest
unreachability comment; record which.

**Recorded-accepted:** F3 — the unsafe-dir (0755) copy is unreachable
because the loader's identical predicate refuses first with
INVALID_GATEWAY_CONFIGURATION; PRE-EXISTING shape (base behaved the
same), copy is live on the socket arm; noted, not corrected here. F5 —
peer-stdio reports no access condition (pre-existing catch-all;
docs name it as a broker call): joins the peer-stdio backlog family
(--help absence, writeFailure message discard) for post-v2.0.0 pricing.
Note: mode-000 state dir yields a third indistinguishable "request
rejected" (mode check precedes errno) — defensible, recorded.

**Budgets:** src ≤90 (was 80; target = measured), tests ≤160, docs
itemized if touched; measured-remainder rule; no new safe codes.
Fourth freeze = new SHA; gate = mech + micro-delta on serve behavior,
the hedged hint, and the branch pins ONLY.

Ledger note: three HOLDs on this slice, each correction fixing exactly
what it aimed at while relocating the misdiagnosis one surface over —
loader pre-empted CLI, then serve inherited the loader. The classifier
is now right at every surface except the one that starts the broker;
the ambiguity core never wobbled once across ~400 driven cases. This is
what an honest-copy slice on a trust seam costs.

## Fourth-freeze verdicts and LANDING (2026-08-18)

SHA 7c28641e. MECH GATE CLEAN: accounting exact (78/90, 158/160, docs
16), check 562/562 RUN TWICE (flake chase: did not reproduce; third
green run in the reviewer's worktree — treated as environmental with
three data points), soak 1/1, concepts exact, realpath deletion clean
with no orphans, ALL mutation rows red including the three nodes.json
branch pins individually (k2 — last round's silent-revert regression —
now red) and the serve-routing pin. Spot checks: serve honest in both
locales with base-comparison byte-identical on its three other failure
modes; client hedge live; 19-key locale symmetry (compile-enforced —
deleting a zh key fails tsc).

MICRO ADVERSARIAL: GO. Serve prose honest, routing cannot cross (all
three other CONTROL_CONNECT_DENIED producers have no serve caller;
probed seven commands under denial — every one takes the client
presentation), realpath deletion unreachable under every real denial
mechanism incl. live seatbelt profiles, ambiguity core untouched.

Correction bundle priced at landing:
- **F1 → emb-97 (MUST land before v2.0.0 release):** the EPERM half of
  the errno predicate is unpinned — deleting it passes the whole suite
  green while fully restoring the original incident under the REAL
  sandbox mechanism (seatbelt raises EPERM; every test fakes EACCES).
  Product correct today, verified under seatbelt; the missing piece is
  the incident's own regression test. Also folded into emb-97: F2 (the
  serve hint lacks the verify-EMBASSY_STATE_DIR hedge the client hint
  got — the boot path is where stale env vars live) and F4 (the
  read-branch catch converts EIO/TypeError into "nodes.json invalid,"
  non-retryable — narrow to errno-shaped errors, rethrow the rest).
- **F3 → backlog with reasons:** serve's stdout envelope carries
  CONTROL_CONNECT_DENIED though serve never opens a control connection —
  machine-readable semantics debt; a fix needs either a new code
  (concept) or overload; rides the transport-code cleanup family.
- **F5 recorded (pre-existing):** peer-stdio swallows everything —
  joins its backlog family. **F6 recorded:** hedge/do-not-relocate
  never co-appear in one output; docs+skill carry the counter-rule.

LANDED on public main as **1f5f42c**, stacked on emb-94: patch applied
cleanly to da29280, full check 564/564 and soak 1/1 IN THE LANDING TREE
(564 = 562 + emb-94's 2), pushed. Status: landed.

Ledger: four freezes, three HOLDs, one GO. Each HOLD fixed its target
while the misdiagnosis relocated (transport → pre-flight → loader →
serve); the ambiguity core survived ~400 driven cases without one
violation. The gate norms earned here: superseding-freeze briefs carry
prior rulings; every classification branch pins the errno THAT THE REAL
MECHANISM RAISES, not a convenient sibling.
