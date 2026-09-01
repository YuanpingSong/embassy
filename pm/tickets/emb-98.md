---
id: emb-98
title: v2.0.1 — hermetic dashboard-command tests; CI has been red since emb-89
kind: bug
size: 1
status: landed
release: v2.0.1
updated: 2026-09-01
---

## Binding

**Why**: the v2.0.0 release pipeline (run 33532736216) failed its test
job on ALL FOUR CI legs: test/gateway-live-dashboard-command.test.ts,
3 fail (exit 2 where 0 expected) + 7 cancelledByParent collateral. CI
history shows every main push since emb-89 (788a6f3) red — emb-88 was
the last green. Root cause CONFIRMED by local reproduction: with a
scrubbed HOME (`TMPDIR=/tmp HOME=<empty dir> npx tsx --test
test/gateway-live-dashboard-command.test.ts`) the identical 3+7 appears.
The failing tests reach the default state-dir fallback
(~/.local/state/agent-embassy) somewhere in their integrated-CLI
spawns; on dev machines a REAL nodes.json exists there and masks it,
in CI none does → GATEWAY_NODE_INVENTORY_REQUIRED-class exit 2. A
hermeticity defect introduced by emb-89's mandatory nodes.json; every
local gate since was blind to it by construction.

**Deliverable**: make the file hermetic — every spawned CLI/broker in
those tests gets an explicit test-owned state dir with a provisioned
nodes.json (or whatever the test intends), never the user fallback.
Fix the leak class, not just the 3 symptoms: audit the file's spawn
helpers so NO test in it can reach the default state dir. If other
test files share the leaking helper, fix them in the same slice and
declare.

**Caps**: E1; test-only (src 0 — if a src change seems needed, CONTEST
before touching); tests ≤80. Base = main 6afbbb4 ("Release v2.0.0" —
the version-pinned tip; the release commit itself is sound).

**Acceptance**: (1) the file passes with scrubbed HOME locally (the
repro command above); (2) full check 565/565 with normal env; (3) the
PUSH to main comes back GREEN on CI — this is the first slice whose
acceptance includes the remote pipeline, and landing is not complete
until the CI conclusion is success; (4) no test asserts against the
user's real state dir anywhere in the file.

**Release context**: v2.0.0 is the project's second dead tag (v1.9.3
precedent — tag pushed, pipeline failed, never move a tag). Fix-forward
ships as v2.0.1 immediately after this lands with CI green. npm never
served 2.0.0, so users see nothing broken.

**Process lesson (recorded here, runbook amendment follows)**: the
landing protocol verified everything locally and never watched CI on
the push; two weeks red went unnoticed. Every future landing includes
a CI-conclusion check, and the release runbook gains a pre-flight
"CI green on the release base" gate before step 2.

## Gate, landing, and RELEASE (2026-09-01)

Direct PM gate (44-line test-only slice): SHA db5a0470 exact, base
6afbbb4, accounting exact (33+/11− one file), hygiene clean,
scrubbed-HOME repro now 14/14 (was 3 fail + 7 cancelled), full check
565/565. LANDED as d934bb3. CI on the push: **SUCCESS — first green
since emb-88, two weeks.** Acceptance criterion (3) satisfied.

**v2.0.1 RELEASED**: Release commit b862513, tag v2.0.1, pipeline run
33534126964 green end-to-end, GitHub release live (not draft), npm
serves agent-embassy@2.0.1 (verified outside-in). v2.0.0 stands as the
project's second dead tag per the never-move rule.

**DRILL COMPLETE, both machines**: m5dev — stop → install 2.0.1 →
state guillotine (v3 ledger preserved as gateway-state.v3-pre201-drill)
→ fresh schema-4 → PM re-select, engineer re-register, pair, and a
LIVE ROUND TRIP through the new unified `embassy send` verb (engineer
reply: "ROUND TRIP COMPLETE: Embassy 2.0.1 send/reply is live on fresh
schema-4 state"). this-mac (over SSH) — install 2.0.1 → guillotine →
fresh broker → shell-peer mailbox registered with the one-shell token
pattern → CROSS-MACHINE PROOF: m5dev→this-mac over peer wire v1,
delivered + PEER_HANDOFF_CONFIRMED, full provenance envelope consumed
by `embassy await` on the target. Skills reinstalled from the released
tree on both machines, both harnesses.

Drill notes for the record: (1) the dual-authority fail-closed fired
live when the PM eval'd the peer token into env AND piped it to
--token-stdin — the exact A14-class cell the emb-91 matrix verified,
now observed in production; recovery per protocol (fresh alias,
one-shell pattern). One drill artifact message queued on
peer-v201@this-mac expires harmlessly at deadline. (2) register-peer
recovery re-registration of a live-tokened alias refuses route_mismatch
— matches the pinned-identity design; noted for the skill's recovery
section. Status: landed.
