---
id: emb-99
title: v3 charter — subtraction: Embassy shrinks to the daily path
kind: normal
size: 8
status: dispatched
release: v3.0.0
updated: 2026-09-02
---

## Binding

**Why**: post-v2.0.1 fresh-eyes assessment (2026-09-02). The product
does the one thing the founder wants — a Claude Code session and a
Codex CLI task message each other natively with receipts — but that
path is roughly a tenth of what is maintained: 29.9k src lines
(25.7k .ts + 4.2k .tsx), 29k test lines, 22 commands (9 used in
practice), two dashboards the founder has never opened, zh-CN parity
on every string, ACP providers nobody runs, a `doctor` for a Codex
Desktop mode the README says is unsupported. `embassy health` reported
`degraded` solely because DeepSeek/Grok connectors and a dead shell
peer were stale while Claude and Codex were healthy. Founder's
criterion for the project: value in daily workflows, low maintenance,
low operational friction. Founder ruling 2026-09-02: **v3-subtraction
greenlit, full scope**; dashboard replaced by terminal observability;
**consent-edge deletion signed** ("the consent edge - signed").

**Deliverable**: Embassy 3.0.0 = the daily path and nothing else.

KEEP (each earned by a moment we leaned on it this window):
- `send --from --to` both directions; native Codex push via app-server
  (CLI + managed standalone daemon): ALL THREE Codex modules stay —
  `codex-stateless-transport` (operations), `codex-local-transport`
  (observation factory + managed-daemon layout; NOT dead, it is half
  the busy signal), `codex-app-server` (ws wire).
- Claude discovery by alias incl. background sessions (`claude-peer`,
  helper, supervisor); the emb-94 alias-collision fence.
- Busy-gating (adapter `ROUTE_BUSY` deferral + service requeue),
  bounded queues/deadlines/rate limits, delivery receipts
  (`delivery-status`, `wait-delivery`), provenance envelopes.
- Steering (`STEER:` / `EMBASSY_STEERING_ENABLED`) — the deliberate
  bypass of busy-gating; ~200 lines, env-gated, "interrupt the
  engineer" is a real PM need. PM judgment call, reversible.
- Cross-machine federation when `nodes.json` exists — INCLUDING
  `peer-stdio` (it is the remote end of the ssh transport;
  `peer-client.ts:26`) and `peer-protocol`. Reverses the advisory's
  "delete peer-stdio".
- Shell-peer mailbox (`register-peer`/`unregister-peer`/`await`).
- `instance-lease` unchanged (single-broker-per-host lock; no Desktop
  logic; load-bearing for launchd).
- `observe_snapshot` control method (becomes the `watch` backend) and
  the generic activity/message rings in store/types.
- The ~30-line managed-Codex-socket-holder check from `codex-doctor`
  (`managed_layout_missing` drives real `MANAGED_CODEX_UNAVAILABLE`
  degradation) — resurfaced as a `status` alert, not a command.
- The discovery-refresh half of `refresh_dashboard` (re-homed as
  `refresh_discovery`; it is the only operator-triggerable "rescan for
  Claude sessions now").
- `skills/embassy-peer/` (one directory, two entrypoints).

DELETE:
- Both dashboards: static + live HTTP/SSE/React app/stream/protocol/
  assets/command, `refresh-dashboard` (publish half), `dashboard
  --live`, `remove_codex_registration` (control method reachable only
  from the live dashboard), vendored React + `@types/react`, dashboard
  docs/threat model, `site/assets/dashboard.png`. ~11.2k src, ~8k
  test, ~1.9k asset lines.
- Localization: `--lang`, `locale.ts`, all `*-copy*.ts`, zh-CN docs
  and site, `README.zh-CN.md`; English inline. The stall/diagnostic
  notices written INTO Claude sessions (`claude-peer.ts:33–48`) are
  wire content: rewrite "inspect the dashboard" → "run `embassy
  status`" in the same slice (docs/DECLINED.md:32–34 recorded the
  dashboard as owner of remedy prose; that owner is gone).
- ACP: `acp-client`, `acp-provider`, `deepseek-detect`, `dsh-`/`grok-`
  prefixes, `config.ts:83–86` hardwired ACP aliases, envelope profiles,
  `support/provider-support-matrix.json` + its test.
- `doctor` command + Desktop classifier (`split_brain`/`orphaned`/
  `attached`), keeping only the socket-holder check above.
- Progress watches: `untrack`, `progress-watch-machine`, `TRACK:`/
  `--track`/`--idle-minutes`, `EMBASSY_TRACKING_ENABLED`,
  `EMBASSY_MAX_WATCHES`, `progressWatchActive` through the helper
  protocol, `<embassy-track-active>`, the bilingual liveness nudge
  (`service.ts:2492`). NOT the busy gate (verified: the gate is
  `providers.ts:1177` + `service.ts:1743`). `queuedAhead` stays
  (steering uses it).
- Consent edges (SIGNED): `pair`/`unpair`/`select-claude`/
  `unselect-claude`, `requireConsent` on the hot path
  (`store.ts:2007`), `consentEdges` in persisted state, `serve
  --inbound`/`gatewayInboundModes`. `send --to <discovered alias>`
  auto-installs the Claude route on first send (selection→route
  anchoring, registration reuse on same (hostId, routeHandle),
  displacement settlement, workspace-disjoint assertion) and the
  collision fence MOVES INTO SEND: refresh inside the send path, hard
  `PEER_ALIAS_COLLISION` refusal naming the alias, sticky collisions
  under incomplete discovery, `availablePeers` filtering preserved.
  Same UID + same host + alias is the permission; the provenance
  envelope names the sender.

CHANGE:
- `nodes.json` optional: ENOENT (dir or file) → attested default
  inventory `{host: os.hostname() short, validated against
  HOST_TOKEN, fallback "localhost"; nodes: []}` — MUST go through
  `attest()` (`federation-nodes.ts:25–32`) or providers refuse to
  construct. Present-but-unreadable still refuses (keep the emb-95
  ENOENT/EPERM split). Delete `GATEWAY_NODE_INVENTORY_REQUIRED` and
  its hint; fix `store.ts:2793` claimable-empty and `:2998` recovery
  copy.
- Schema: ONE bump 4→5 for the whole v3 line, reset-only upgrade (v2
  precedent), taken in the first slice that changes persisted shape
  (slice 2, when `gatewayProviders` narrows `MessageDirection`).
- `reply` folds into `send --conversation <token>` AFTER consent
  removal (its `transientTarget` path was a consent workaround);
  `reply` stays as an alias for one release because the
  `<embassy-reply-hint>` text is in flight in existing envelopes.

ADD:
- `embassy status`: human-readable when stdout is a TTY, JSON when
  piped or `--json`. Broker (pid/version/uptime); only connectors that
  matter (claude, codex, any registered shell peer); routes table
  (alias · provider · idle/busy/stale · queue · last seen); last N
  messages (time, from→to, state, latency, ~60-char preview);
  actionable alerts with the remedy sentence. Reimplements the ~150
  lines of attention/overall derivation from `dashboard-model.ts:
  1275–1495` WITHOUT `hasConsentEvidence`. `status` triggers
  `refresh_discovery`.
- `embassy watch`: terminal tail over `observe_snapshot`, primarily
  `snapshot.messages` by sequence, `activityEvents` secondary.
- `embassy check`: self-test round trip to the first Codex task found
  (or shell peer), reporting each hop; the upstream-drift tripwire.
- Broker as a launchd agent: `embassy service install|uninstall|
  status` writing `~/Library/LaunchAgents/com.agent-embassy.broker.
  plist` with KeepAlive; `send` with no broker gives one sentence
  pointing at it. Chosen over in-process auto-spawn (lease contention,
  socket window, readiness on foreground stdout, reaping — all
  sidestepped by launchd).
- Docs: README rewritten as one page you can read in five minutes;
  CHANGELOG v3.0.0 + release note; skills updated; CHANGELOG history
  and past release notes untouched. `site/` reduced to one paragraph
  + link (already stale at v1.7.0) — founder ruled no positioning
  work; a page that lies is worse than a stub.

## Slice order (each lands linear on main, `npm run check` green)

1. emb-100 dashboards (+ `refresh_discovery` re-home, package
   manifest allowlist in the same commit, `locale.ts` survives).
2. emb-101 ACP + support matrix + doctor (keep socket-holder check);
   schema 4→5.
3. emb-102 localization (+ stall-notice rewrite; relocate
   `public-localization.test.ts:308–344`).
4. emb-103 progress watches.
5. emb-104 consent removal + implicit routes + fence-into-send +
   `--inbound` removal; then emb-105 `reply` fold.
6. emb-106 `nodes.json` optional.
7. emb-107 `status`/`watch`/`check`.
8. emb-108 launchd service; emb-109 docs + release v3.0.0 + cutover
   both machines + swe3 re-test.

Projection (audit): src 60 files/29.9k → ~27/~17k; tests 40/29.2k →
~25/~18.4k; docs −1.2k, assets −1.9k.

## Process for v3 (founder-ratified light gate)

Engineers are Opus subagents in worktree `~/.claude/jobs/6ec3a843/
tmp/v3` on branch `v3/subtraction`, one slice at a time; live 2.0.1
brokers and the swe3 channel untouched until cutover (`EMBASSY_STATE_
DIR` for any side-by-side dev broker). Gate per slice: PM re-runs
`TMPDIR=/tmp npm run check` in the worktree + one Opus adversarial
read; land by fast-forward onto main; landing acceptance includes the
push's CI conclusion. Full gate (taste + adversarial + contest window)
only for emb-104 (behavior change on the send path) and emb-107
(adapter/provenance-adjacent). No per-slice contests, no zh-CN parity,
no support-matrix ceremony, no site work beyond the stub.

## Record

- 2026-09-02 Fresh-eyes advisory delivered; founder greenlit
  v3-subtraction and signed the consent-edge deletion the same day.
- 2026-09-02 Opus audit (read-only, tree b862513) produced the
  deletion map; corrections adopted: peer-stdio KEPT (federation
  transport), codex-local-transport KEPT (live observation path),
  doctor's socket-holder check KEPT as status alert, refresh_dashboard
  split (discovery kept), stall-notice rewrite scheduled, `watch`
  tails messages not activity, launchd over auto-spawn, one schema
  bump. Steering KEPT by PM judgment (flagged to founder).
- 2026-09-02 Branch `v3/subtraction` cut from main b862513 (CI green)
  and pushed. emb-100 dispatched.
- 2026-09-02 emb-100 adversarial HOLD converted to a correction
  commit (docs truth + `refresh` failure path). Scope additions from
  it: emb-106 also removes stale `gateway-dashboard*.html` from the
  state dir at boot and the cutover runbook says so; emb-109 bumps
  the control protocol version so removed methods read as skew, not
  as unknown; emb-107 considers an operator path to clear an orphaned
  Codex registration (was dashboard-only).
- 2026-09-02 Norms added after emb-101's gate: every slice appends
  to CHANGELOG `[Unreleased]`; each protocol/schema number is bumped
  ONCE for the v3 line at first need (schema 5, peer protocol 2,
  control protocol 3 — all in emb-101); no doc may promise a record
  that does not exist — emb-109's release note names the Claude
  Code / Codex CLI versions the cutover drill ran against, and only
  then may docs say so. Fable-tier engineers/reviewers while the
  Opus limit holds (resets 05:40 ET).
- 2026-09-02 emb-109 (docs + release) scope additions from the
  emb-102 gate: delete or rewrite `.claude/agents/content-writer.md`
  (or add `.claude/` to the oracle roots); scrub bare "dashboard"
  from GATEWAY-ARCHITECTURE and the dead R1 glob in AGENTS.md; a
  `site/zh-CN/index.html` redirect stub to the English page (the
  deleted page was a declared canonical URL).
- 2026-09-02 Norm (PM error): a landing record states the CI
  conclusion only after the watcher's output has been READ — never
  composed in advance. emb-103's record briefly said "success" for a
  run that failed on one leg (latent flake, fixed forward by
  4d00fc4). Fix-forward on main for test-only flakes is allowed under
  the light gate; engineers on the lane rebase onto main before
  pushing.
- 2026-09-02 Founder asked for parallelism. Plan: emb-104 (consent,
  Opus) is the critical path; emb-106 (nodes.json) and emb-108
  (launchd) are code-independent and run now on their own branches
  (Sonnet), rebased onto main after 104 lands and gated with an
  adversarial read each; emb-105 (reply fold) and emb-107
  (observability, needs the post-104 snapshot shape and a consent-
  free `check`) follow 104 sequentially; emb-109 last. Gate reviews
  for 104 (adversarial + taste) run concurrently. Shared rate limits
  are the real bottleneck, so no more than three engineers at once.
- 2026-09-02 Charter amendment (emb-106 gate): "nodes.json optional"
  now means the broker WRITES it on first boot from the hostname
  default; identity is never transient past first boot. Lesson: a
  default must be stable, not merely right — emb-89's "no default"
  was wrong about the remedy, not about the hazard.
- 2026-09-02 Tier lesson: both Sonnet-tier parallel lanes came back
  HOLD with design-level findings (emb-106 ambient identity; emb-108
  four blockers). Sonnet is fine for pure deletions and copy; anything
  touching OS-boundary semantics (identity, locks, launchd, sockets)
  goes to Opus even when the brief looks complete. The adversarial
  read remains mandatory per slice regardless of tier.
- 2026-09-02 Norm (from emb-108's red landing): a slice that adds
  tests touching OS facilities (lockf, launchctl, chmod semantics,
  process liveness) must state in its handoff which tests are
  platform-bound and how CI's ubuntu legs are satisfied (injection
  or an explicit skip with reason); the PM asks the adversarial
  reader to check it. Lane branches do not run CI, so this is the
  only guard before main.
