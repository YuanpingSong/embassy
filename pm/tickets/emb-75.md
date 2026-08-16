---
id: emb-75
title: v1.7.1 — the orphaned-Desktop case goes from documented to handled
kind: bug
size: 5
status: dispatched
release: v1.7.1
updated: 2026-08-16
---

## Binding

**Why**: live incident, 2026-08-16 evening. The founder restarted the App
Server and ChatGPT Desktop; the broker↔daemon link healed unaided (v1.6
machinery, working), but Desktop did not re-attach (attach-at-launch,
upstream behavior) — and the emb-63 reconnect guidance shipped for exactly
this case DID NOT RENDER in v1.7.0: `codex_app_reconnect_required` and its
command string survive in dashboard-model.ts (:1418/:1520), but the live
dashboard shows none of it under textbook conditions (stale route on
ENDPOINT_GENERATION_CHANGED + healthy connector + minutes elapsed). The
trigger condition died somewhere in the v1.7 refresh/authority rework; no
test renders the guidance from a live-shaped snapshot, so nothing caught it.
Founder verdict: "if our reliability fix doesn't cover this case, there's
still work to be done."

**Deliverable**: (1) REGRESSION FIX — the guidance fires again, with a test
that builds the exact incident snapshot (stale codex route, generation-
changed code, healthy connector) and asserts the rendered guidance including
the relaunch command, in both languages. (2) ORPHAN DETECTION — an
`embassy doctor` surface (CLI + dashboard row) that performs the
one-socket-holder check on the managed app-server control socket and states
plainly: "the daemon is running but no Desktop client is attached; threads
cannot load; run: /usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1
-a ChatGPT, then open your Codex task." (3) EVALUATE (design note, founder
decision): opt-in auto-remedy — Embassy relaunching Desktop itself when
orphan-detected — weighing the it-kills-user-windows cost; also record the
lazy-attach observation (attach may complete when a Codex task view opens,
not at app launch) and verify it, since it changes the guidance text.

**Budgets**: size 5 (repriced from 3 — four findings became four deliverables). Remainder map before cutting per standing rule.

## Finding 2 (same evening): split-brain server state blocks registration for ALL tasks

Both engineers' register-codex attempts failed CODEX_ROUTE_SETUP_REJECTED
("the exact Codex task could not be safely observed and resumed",
providers.ts:3180-3185). Root cause: registration is a LIVE observe+resume
ceremony against the managed daemon, but Desktop — unattached after the
founder's restarts — was serving the live tasks from its PRIVATE App Server;
the managed daemon correctly refused to resume threads owned elsewhere (the
v1.0 ownership boundary). One split-brain, two rejections. The PM's stale
env-trick registration was a real but secondary collision on main's alias
(cleared by env-attested unregister; that trick is hereby demoted to
emergency reads only, never standing registrations).

SCOPE ADDITION: the doctor/orphan detector must also detect split-brain —
managed socket has one holder while ChatGPT Desktop is running ⇒ report
"Desktop is on a private App Server; its tasks are unreachable by Embassy;
relaunch: /usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT"
— and the registration rejection copy must name the split-brain state when
detected, not just "could not be observed".

v1.8 note (ratified centerpiece): under the stateless transport,
registration = attested record write; per-dispatch proof replaces the setup
ceremony; this rejection class dies at the design level. OPEN QUESTION for
the incident record: the scripted `open --env` relaunch did not produce an
attach tonight though it did this morning — possible Desktop auto-update
behavior change; founder performing a manual terminal relaunch to
discriminate.

## Finding 3 — the true root of the evening: the observation loop DIED at the
## mutex hold, and "healthy" lied for an hour (SEVERITY UPGRADE)

Broker activity forensics: the codex connector's lastSeenAt froze at
21:02:42.921 local — the exact moment of the 84-second Grok dispatch mutex
hold — and never advanced again. For the following hour the connector
reported "healthy" on frozen evidence while bound to a daemon that was later
restarted out from under it; every registration attempt (7+ across both
engineers) rejected CODEX_ROUTE_SETUP_REJECTED against the dead view. The
founder's daemon restarts, multiple Desktop relaunches with the env flag,
and engineer retries could not have ever fixed it — the wedged component was
the broker. A broker restart restored observation instantly.

CONSEQUENCES FOR THIS TICKET (v1.7.1): (1) the mutex-starvation finding is
upgraded from degraded-visibility to KILLS-OBSERVATION — find why the
observation loop never re-armed after the hold (timer death, swallowed
throw, or unresolved promise) and fix with a regression test that holds the
mutex 90s and asserts observation resumes; (2) connector-level freshness
honesty: a connector whose lastSeenAt exceeds a staleness bound must not
report "healthy" — surface observation age; (3) the doctor surface adds the
frozen-observation check (connector lastSeen vs now).

Confounders cleared along the way, for the record: Desktop attach-at-launch
env fragility (fixed permanently on this machine via launchctl setenv),
split-brain private server (real, earlier in the evening), PM's stale
env-trick registration (real, cleared, trick demoted). Each was true; none
was the root.

v1.8 note: under the stateless transport there is NO long-lived observation
loop to die — per-dispatch connection makes this entire failure class
unrepresentable. Tonight is the strongest field evidence yet for the
ratified centerpiece.

## Finding 4 + founder directive: Claude routes must not go stale across
## broker restarts

Post-broker-restart, the PM's claude route sat REOBSERVATION_REQUIRED until
the engineers' codex registrations triggered a discovery refresh, whereupon
the existing auto-rebind path (peer_identity_reobserved) healed it
instantly. The mechanism works; the TRIGGER is wrong — it waits for an
unrelated event. Founder directive: "your route should not go stale."
DELIVERABLE ADDED: run claude discovery refresh AT BOOT (and on a modest
timer), auto-rebinding previously selected sessions by exact persisted UUID
when their registry record and socket are live — no codex registration, no
operator command, no manual select-claude. The select-claude wrapper remains
for NEW selections only; recovery of an existing selection is the broker's
job.

## Contest #15 SUSTAINED — finding 3 amended; D1 + doctor rulings (2026-08-16)

Engineer's read-only evidence falsified finding 3's mechanism: there is NO
periodic codex observation loop. The proven chain: service.scheduleDispatch →
dispatchOne holds the GLOBAL service mutex across adapter.dispatch; the 84s
Grok prompt therefore queued all codex callbacks behind the mutex (the
measured CONTROL_TIMEOUTs); KeyedMutex releases in finally; and successful
heartbeats never emit route observations — lastSeenAt freezing during quiet
health is the ABSENCE of positive observation by design, not a dead loop.
The proposed dead-loop regression test would pass today and prove nothing.
Adjacent real defect found: enqueueCallbackWorkerOnly clears
callbackScheduled before acquiring and overwrites callbackWorker — waiter
buildup under long holds. Causation for the hour of registration failures is
re-attributed primarily to the split-brain (finding 2); the broker restart's
apparent cure is confounded by the near-simultaneous Desktop flag/attach fix
— both candidates recorded, honestly unresolved. Ledger: 15/15.

D1 RULED: A + B + coalescing. A = provider I/O outside the service mutex
with post-I/O revalidation (~180-320, R3, settlement-sensitive — kills the
user-facing starvation class while routine ACP turns run); B = fixed
periodic bounded Codex positive observation (~100-180 — required so the 35s
freshness bound doesn't brand quiet-healthy Codex "degraded"); + the
evidence-backed callback coalescing (~40-70) with the drain/re-arm test
folded into A's evidence.

DOCTOR RULED (six points): executable-path identity (attested daemon path;
/Applications/*.app bundles — bundle id com.openai.codex is tonight's ground
truth, names lie); distinct-PID holder semantics excluding the daemon's own
PID (its listener+accepted FDs fooled a watch tonight) and Embassy-owned
PIDs; 0-external+app-running = split-brain, 0+not-running = orphaned,
>=1 external desktop PID = attached, inspection failure = unknown; report
ALL conditions (remedy-actionable first, no masking); static AND live
dashboards; normalized JSON + localized remedy as display copy; lazy-attach
pending founder verification; auto-relaunch design-note only. Window
approved (prefer new codex-doctor module; DECLINED.md superseding record if
applicable). TICKET CAP: ≤2,000 changed lines total, E5/R3.

## Contest #16 (window, pre-gate) — GRANTED

check-npm-package.mjs in window for exactly one codex-doctor allowlist line
(new runtime module imported by server.ts; closed GATEWAY_RUNTIME_MODULES
would fail or omit it at the package gate). Third catch of the emb-56
manifest-scar class, second pre-gate. Ledger 16/16. v1.8 NOTE filed with the
grant: consider deriving the runtime allowlist from the module graph at
package time — a hand-list with three catches is a deletion-by-construction
candidate.

## Contest #17 (cap, post-R3-review) — GRANTED: ≤2,600

Honest freeze at 2,450 (+2,272/−178, 29 files) after the independent R3
review found five unpriced release-blocking consequences of
mutex-externalization: (1) invoked write settling falsely
cancelled/failed on shutdown/replacement → explicit in-flight uncertainty +
no-replay tests; (2) clean-prewrite result overwriting a newer stale
observation; (3) freshness reaching only status/live, static dashboard
permanently healthy → publish at the exact age boundary, survive one publish
failure; (4) lifecycle-timer one-throw death; (5) periodic Claude recovery
doing RPC under the global mutex → split to prepare/perform/commit with
rebind-race cleanup + finding-4's retained-queue wake. All five ENFORCE the
D1/D2/D3 rulings. Doctor-split alternative declined (delays founder
diagnostics for 600 lines). Cross-generation timer replacement confirmed
ruled on the PM side (founder veto window offered, not exercised); a red
test remains only if the engineer's own environment gates it. Projected
finish ≤2,500. Ledger 17/17. Review-findings-break-maps noted for retro:
maps price the known; R3 reviews exist to find the unknown — cap contests
after review are expected, not failures.
