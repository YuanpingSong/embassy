---
id: emb-75
title: v1.7.1 — the orphaned-Desktop case goes from documented to handled
kind: bug
size: 3
status: draft
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

**Budgets**: size 3. Remainder map before cutting per standing rule.

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
