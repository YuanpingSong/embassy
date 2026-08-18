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
