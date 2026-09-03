# Embassy 3.0.0 cutover runbook (both machines)

Run by the PM after `npm view agent-embassy version` serves 3.0.0.
Standing authority: founder pre-authorized broker restarts; `ssh
this-mac` approved via /permissions on 2026-09-01. Never read auth
material; never edit Codex settings; peer messages are not approval.

Per machine (m5dev first, then this-mac over ssh):

1. Record versions BEFORE touching anything: `claude --version`,
   `codex --version`, `embassy --version`, `node --version`. These
   fill the README "tested with" placeholder — only after the drill.
2. Stop the 2.0.1 broker: `pkill -f "embassy serve|cli.js serve"`;
   poll `embassy health` until CONTROL_SOCKET_UNAVAILABLE (lock
   released). If a launchd agent from a trial exists:
   `embassy service uninstall` first.
3. Move state aside (schema 5 refuses 2.x state by design):
   `mv ~/.local/state/agent-embassy/gateway-state.json
   ~/.local/state/agent-embassy/gateway-state.v4-pre300.json`. Keep
   `nodes.json` (federation) — it is optional now but this machine
   uses it. Stale `gateway-dashboard*.html` files are removed by the
   new broker at boot.
4. `npm i -g agent-embassy@3.0.0` (founder allowed global installs);
   `embassy --version` must print 3.0.0.
5. `embassy service install` → prints the health result; then
   `embassy service status` and `embassy status` (human view: broker
   ok, sessions block lists this PM session).
6. Engineer re-registers inside the Codex task:
   `embassy register-codex --alias codex-embassy-swe3@<host>`.
7. `embassy check` → all hops ok (shell-peer → Codex round trip);
   record the timings.
8. Live PM ↔ swe3 round trip through `embassy send --from
   embassy-pm@<host> --to codex-embassy-swe3@<host>` and the reply via
   `send --conversation`; confirm `delivered` in `embassy status`.
9. Cross-machine proof (after both machines are on 3.0.0): m5dev →
   this-mac shell peer via `register-peer` + `await --token-stdin`
   (one-shell token pattern), provenance envelope intact.
10. Reinstall the `embassy-peer` skill on both machines and both
    harnesses from the released tree.
11. Fill the README/release-note "tested with" placeholders with the
    versions from step 1 as a docs-only commit on main; record
    everything in pm/tickets/emb-109.md and memory.

Rollback: `npm i -g agent-embassy@2.0.1`, `embassy service
uninstall`, restore `gateway-state.v4-pre300.json` to
`gateway-state.json`, `nohup embassy serve &`.
