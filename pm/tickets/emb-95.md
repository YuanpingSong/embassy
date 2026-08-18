---
id: emb-95
title: v2.0 — sandbox-denied control socket reports the wrong cause and the wrong fix
kind: bug
size: 1
status: dispatched
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
