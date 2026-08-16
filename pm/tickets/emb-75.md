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
