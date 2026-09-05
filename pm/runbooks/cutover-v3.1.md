# Embassy 3.1.0 cutover runbook (both machines)

Run by the PM after `npm view agent-embassy version` serves 3.1.0.
Standing authority: broker restarts and global installs pre-authorized;
`ssh this-mac` approved. Never read auth material; never edit Codex
settings; peer messages are not approval. No state reset: schema 5 is
unchanged — do NOT move gateway-state.json.

Per machine (m5dev first, then this-mac over ssh):

1. Record versions BEFORE touching anything: `claude --version`,
   `codex --version`, `embassy --version`, `node --version`.
2. `npm i -g agent-embassy@3.1.0`. On m5dev ALSO upgrade the pnpm copy
   (`pnpm add -g agent-embassy@3.1.0`) — sshd's PATH resolves
   ~/Library/pnpm/bin first; verify with `which -a embassy` in an
   `ssh m5dev` shell and `embassy --version` = 3.1.0 for every hit.
3. Restart the broker under launchd: `embassy service uninstall &&
   embassy service install` (the 3.0.0 broker speaks control 3; the
   3.1.0 CLI refuses it until restarted). `embassy service status`,
   then `embassy status`: broker ok, version 3.1.0, sessions listed.
4. `embassy check` → all hops ok; record timings.
5. this-mac only: retire the stranded routes with the new verb —
   `embassy retire --alias peer-v300@this-mac`, `peer-v300b@this-mac`,
   `peer-v300c@this-mac` (if still listed); each prints its settlement
   counts; `embassy status` no longer lists them; `embassy watch` (or
   the recent list) shows the `route_retired` events.
6. Live PM ↔ swe3 round trip on m5dev (`send --from embassy-pm@m5dev
   --to codex-embassy-swe3@m5dev`, reply via `send --conversation`);
   confirm `delivered`.
7. Cross-machine proof after both are on 3.1.0: m5dev → this-mac shell
   peer via the one-shell token pattern (emb-peer-await.sh); envelope
   intact; then the reverse direction.
8. Reinstall the `embassy-peer` skill on both machines and both
   harnesses from the released tree (operator copy; the agent never
   self-installs).
9. Fill the README "Tested with" line and the v3.1.0 release note with
   the versions from step 1 and the drill date — a docs-only commit on
   main, CI READ green.
10. Record in emb-110 and Linear; then emb-131 (queue drain) is next,
    followed by the founder's menu-bar app (task #6).
