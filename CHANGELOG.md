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
- `delivery-status` / `wait-delivery` — read one delivery tracker by its opaque `dlv_` token, or wait for it to settle; `wait-delivery` exits `0` only for `delivered`, `6` for any other terminal state, `3` for an unknown token, and `4` for a local wait timeout.
- Metadata-only, self-contained static dashboards — `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html`, both mode 0600, both atomically rewritten on every publish, cross-linked in the page, with no JavaScript, no server, no external assets, no self-refresh, and no message content shown.
- Delivery semantics: ordinary queue-while-busy plus exact Claude→Codex `STEER:` admission at App Server's next tool-call boundary, never mid-generation and never by forced interruption. Cleanly unavailable steering falls back to the normal queue; each route retains at most three queued steers and settles the displaced oldest message with an explicit journal event and normal receipt. Normalized terminal receipts remain `delivered`, `unconfirmed` (transport write completed, terminal native evidence unavailable), `ambiguous` (write outcome unknown), `expired`, `failed`, and `cancelled`, with a single static `<gateway-delivery-diagnostic>` frame carrying one safe error code on failure. Neither `unconfirmed` nor `ambiguous` authorizes a retry.
- Repo-shipped agent skill (`skills/embassy-peer/SKILL.md`) teaching the full operator/agent workflow — health, registration, sending, replying, queue-state interpretation — without exposing identifiers or message bodies.
- One host-wide crash-reclaimable owner lease, acquired before provider setup and independent of `EMBASSY_STATE_DIR`, so only one foreground Embassy controller can advertise routes for a login account.

- **Live dashboard companion** — `embassy dashboard --live [--lang en|zh-CN]` starts a separate foreground process that streams sanitized metadata to a browser tab on `127.0.0.1`; `embassy serve` remains TCP-free and HTTP-free.
- **One-use token authentication** — live companion access bootstraps via a 256-bit URL-fragment token exchanged for a path-scoped `HttpOnly` `SameSite=Strict` session cookie with Host, Origin, and sentinel validation.
- **Bounded browser actions** — the live companion exposes no CORS headers, generic control/provider routes, storage, telemetry, or external assets. Its sole mutation route accepts only confirmed select-Claude, unselect-Claude, and refresh-discovery actions, with a 1 KiB body cap and six-action-per-minute token bucket; it cannot register tasks, send, reply, approve, interrupt, or change settings.
- **Bilingual dashboards** — the static pair renders in English and Simplified Chinese from one catalog and is switched by an in-page link; `--lang en|zh-CN` is a live-companion flag and is not accepted by `refresh-dashboard`.

### Changed

- Binary renamed from `claude-codex-gateway` to `embassy`; the old name ships for one release as a deprecated alias.
- State root moved from `~/.local/state/claude-agent-bridge/gateway` to `~/.local/state/agent-embassy`. This is a clean reset, not a migration — old gateway state is not carried forward. For one release, Embassy bounded-reads only the exact legacy default ownership marker and controller-lock record, then creates and holds that lock so a prototype cannot run alongside v1. A pre-existing legacy lock is preserved and blocks startup; after confirming no prototype process remains, remove that exact stale lock manually, then register and select again.
- Compatibility pins re-established for this release: Claude Code **2.1.225** / peer protocol 1 (with still-running 2.1.224 sessions remaining discoverable during a patch-upgrade overlap window), and Codex App Server **0.147.0**, resolved by exact path. An unknown version on either surface fails closed.
- The public v1 launcher is macOS-only and local-host-only.
- Validated native records named `codex-*` are excluded from Claude destination discovery; they are gateway advertisements, not selectable Claude sessions.
- After Embassy restarts, a persisted Claude binding starts stale. The next authorized, complete discovery may reactivate only the exact same Claude session UUID under the same provider, host, and owner lease, adopting its latest name after workspace/provider revalidation. Changed, missing, incomplete, or ambiguous identity stays stale. Queued text, callbacks, receipt handles, pending replies, and conversation capability are never restored.
- Re-running `register-codex` replaces a closed or faulted App Server connector; an idle recovered route wakes held work without retrying any ambiguous write.
- The first successful Codex registration fixes its exact alias, task, and host until it is explicitly succeeded. Exact re-registration remains available for connector recovery. `register-codex --alias <new> --succeeds <current>`, run from inside the successor task on the same host, is the only way to change the registered Codex identity without restarting the broker: Embassy freezes the outgoing route, drains its accepted work to terminal settlement, then publishes the successor on a fresh listener generation. Nothing transfers — no queued body, conversation, reply capability, or delivery token — and a succession that cannot be completed pins the identity fail-closed until manual recovery rather than leaving two live registrations.
- Failed reactivation of a retained Codex route, or a fresh registration whose cleanup cannot be fully confirmed, pins that exact identity fail-closed until exact retry or confirmed unregister followed by restart.

### Removed

- The one-way MCP task lifecycle (the six `claude_task_*` tools) existed only in the unpublished prototype. It was never released publicly and is not present in Embassy v1.

### Security

- No network surface in the broker: `embassy serve` opens no TCP listener and no HTTP server, makes no provider API call, and sends no telemetry; its control and callback surfaces are private Unix-domain sockets. The opt-in `embassy dashboard --live` companion is the only network listener Embassy can create — a separate foreground process bound to `127.0.0.1` on an ephemeral port, token-authenticated, and limited to the three route-consent actions described above. Delivered content still enters the receiving cloud-backed product as an ordinary model turn.
- Same-UID containment, not authentication: provider identity is inherited from the process environment (a Codex task's `CODEX_THREAD_ID` or a Claude session's messaging socket, never both), and every mutation is additionally checked against route ownership, exact thread/session generation, source alias, and bounds.
- Nothing persisted beyond route rebinding: bodies, prompts, replies, raw provider frames, and socket paths are never persisted. Provider-native identifiers (Codex thread ID, Claude session UUID) are kept only inside the closed, mode-0600 private route binding used to re-observe a route after restart.
- v1 advertises exactly **one** registered Codex task per gateway process, and once registered it is visible to every compatible live Claude session running as the same OS user — register only when comfortable with every currently running compatible Claude session, and `unregister-codex` when done.
- Embassy never sets, relaxes, or overrides a Codex task's approval or sandbox policy and never answers an approval request. Claude-initiated turns use the task's existing native policy.
- Claude-to-Codex reachability does not select that session for outbound Codex-to-Claude delivery. In the opposite direction, Claude's native `crossSessionInbound` control governs messages entering the selected Claude session.
- Version attestation (a bounded `claude --version` in a scrubbed environment) proves compatibility, not authenticity.
