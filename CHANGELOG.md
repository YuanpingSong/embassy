# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2026-08-08

### Added

- **Embassy**, a local, single-user, bidirectional message gateway between running Claude Code sessions and Codex desktop tasks, packaged as `agent-embassy` with CLI binary `embassy`.
- `embassy serve` — foreground broker that publishes one process-owned `codex-*` peer into Claude Code's live-session registry and opens its own callback socket; never daemonizes; removes both on shutdown.
- `register-codex` / `unregister-codex` — register or retire a `codex-*` route, run from inside the Codex task itself so it inherits `CODEX_THREAD_ID`.
- `select-claude` / `unselect-claude` — explicitly select or unselect a discovered Claude destination; Codex-to-Claude sends never select a candidate implicitly.
- `send-to-claude` / `send-to-codex` / `reply` — bounded, stdin-only message sends (16 KiB max) and conversation-token continuation, in both directions.
- `health` / `status` / `refresh-dashboard` — liveness check, sanitized snapshot (including `availablePeers`), and dashboard regeneration.
- A metadata-only, self-contained `gateway-dashboard.html`: mode 0600, atomically rewritten, auto-refreshing, no JavaScript, no server, no external assets, no message content shown.
- Delivery semantics: queue-while-busy as the only busy policy (no steering, no forced interruption); normalized `delivered`/`expired` receipts, with a single static `<gateway-delivery-diagnostic>` frame carrying one safe error code on failure; bounded queues, rate limiting, dedupe, deadlines, and hop counts.
- Repo-shipped agent skill (`skills/embassy-peer/SKILL.md`) teaching the full operator/agent workflow — health, registration, sending, replying, queue-state interpretation — without exposing identifiers or message bodies.

### Changed

- Binary renamed from `claude-codex-gateway` to `embassy`; the old name ships for one release as a deprecated alias.
- State root moved from `~/.local/state/claude-agent-bridge` to `~/.local/state/agent-embassy`. This is a clean reset, not a migration — old state is not read or carried forward.
- Compatibility pins re-established for this release: Claude Code **2.1.225** / peer protocol 1 (with still-running 2.1.224 sessions remaining discoverable during a patch-upgrade overlap window), and Codex App Server **0.147.0**, resolved by exact path. An unknown version on either surface fails closed.
- The public v1 launcher is macOS-only and local-host-only.

### Removed

- The one-way MCP task lifecycle (the six `claude_task_*` tools) existed only in the unpublished prototype. It was never released publicly and is not present in Embassy v1.

### Security

- No network surface: no TCP listener, no HTTP server, no provider API calls, no telemetry. The documented control and callback surfaces use private Unix-domain sockets. Delivered content still enters the receiving cloud-backed product as an ordinary model turn.
- Same-UID containment, not authentication: provider identity is inherited from the process environment (a Codex task's `CODEX_THREAD_ID` or a Claude session's messaging socket, never both), and every mutation is additionally checked against route ownership, exact thread/session generation, source alias, and bounds.
- Nothing persisted beyond route rebinding: bodies, prompts, replies, raw provider frames, and socket paths are never persisted. Provider-native identifiers (Codex thread ID, Claude session UUID) are kept only inside the closed, mode-0600 private route binding used to re-observe a route after restart.
- v1 advertises exactly **one** registered Codex task per gateway process, and once registered it is visible to every compatible live Claude session running as the same OS user — register only when comfortable with every currently running compatible Claude session, and `unregister-codex` when done.
- Embassy never sets, relaxes, or overrides a Codex task's approval or sandbox policy and never answers an approval request. Claude-initiated turns use the task's existing native policy.
- Claude-to-Codex reachability does not select that session for outbound Codex-to-Claude delivery. In the opposite direction, Claude's native `crossSessionInbound` control governs messages entering the selected Claude session.
- Version attestation (a bounded `claude --version` in a scrubbed environment) proves compatibility, not authenticity.
