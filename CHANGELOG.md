# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.2.0] - 2026-08-10

Deliverability over everything: a message you send arrives, or tells you loudly why it could not.

### Added

- **Broker-owned provenance envelopes and recipient replies** — every routed body now reaches Codex or Claude inside one deterministic `cross-session-message` textual frame with broker-validated sender attribution. Its first `embassy-reply-hint` carries the full conversation token, the exact recipient alias, and the stdin-based `embassy reply` command, so either participant can continue without reconstructing a token. Codex receives the full token as an outer `conversation` attribute as well; Claude retains its canonical outer shape and receives the token in the hint. Sender aliases over Claude's 64-character display bound use a deterministic hashed label while preserving the exact alias in the hint.
- **The durable queue** — message bodies persist in the broker's private mode-0600 state under bounded retention. Queued mail survives a broker restart and re-sends exactly once when its route is re-observed; in-flight-at-crash messages settle `ambiguous` — never silently lost, never double-sent. The live dashboard's delivery detail shows each retained body (bounded display), with an honest fallback for deliveries whose body was not retained. Static dashboards remain metadata-only.
- **Boot reactivation** — after a broker restart, retained Codex routes re-anchor automatically at startup through the same exactly-once `thread/loaded/list` proof, including staged handling when the App Server moved endpoint generations while the broker was down. `register-codex` becomes recovery of last resort; transient replies are never retargeted across a restart.
- **The deliverability soak** — `npm run soak` drives a seeded, randomized churn of sends through scripted dispatch faults, busy/idle flips, clock jumps, and full restarts, asserting that every accepted message settles exactly once into an explicit terminal outcome with an allowlisted reason.

### Changed

- Message deadlines default to **4 hours** (was 5 minutes; max 24 hours) — agent turns routinely outlive minutes-scale deadlines, and expiry is now rare and explicit rather than routine. Stall notices stay early, within two minutes.
- Conversation hop budgets exist to stop runaway reply loops, not conversations: the default is **16** (was 2; max 64).
- Claude-bound dispatch failures carry their exact safe codes, and the broker redispatches bounded retries when the route is observed idle instead of settling terminal on first refusal.
- Documentation across both languages now states the durable-queue truth: bodies are stored, bounded, and shown; restarts keep queued mail.

### Fixed

- The live dashboard's "Source restarted; view resynchronized" banner appears only on a true source-revision regression; clock-derived field churn no longer masquerades as a restart or triggers a frame broadcast every poll.

### Security

- The envelope is a structural provenance marker, not XML, a cryptographic signature, or authentication against same-UID code. Broker-reserved opening and closing tag shapes inside the untrusted body are neutralized before delivery; framing happens exactly once at the final provider boundary, and invalid metadata or framed-size overflow fails before any write. The full conversation token remains transient and participant-scoped: reply rechecks caller, conversation membership, route, and hop policy, and the token never enters durable state, journals, logs, receipts, public snapshots, events, or dashboards.
- Body persistence keeps the same trust boundary the product always had: the OS account. Retained bodies live in the mode-0600 state directory and appear only on the loopback live dashboard; raw provider frames stay memory-only.

## [1.1.0] - 2026-08-09

### Added

- **Automatic Codex endpoint reactivation** — when the managed App Server moves from one endpoint generation to another, Embassy freezes the old connector, runs the existing bounded compatibility probe against the replacement, and re-anchors each retained route only after `thread/loaded/list` finds its byte-identical task exactly once. The alias, owner lease, and pair edges survive; the private bounded journal records the generation refresh without projecting the task ID or either endpoint generation.
- **Bounded stale-registration recovery** — the authenticated live dashboard can request removal of one canonical `codex-*` alias after an explicit confirmation. The broker accepts the operation only for a stale registration whose owning endpoint generation is dead, revalidates and quiesces the exact route, removes its incident pair edges, and records the successful recovery in its private bounded journal. Ready, merely offline, current-generation, and ambiguous routes fail closed.

### Changed

- `CALLER_IDENTITY_CONFLICT` now gives a targeted bilingual recovery hint only when both Codex and Claude identities were inherited: restart the Codex App Server daemon from a normal terminal with `codex app-server daemon restart`. Wrong-principal failures keep the generic fail-closed advice.

### Security

- Endpoint replacement never restores or replays a body, callback, receipt handle, reply capability, conversation capability, or delivery token. An incompatible replacement, a missing or duplicate exact task, or an unclean transition leaves the retained route stale and surfaces bounded compatibility evidence for diagnosis rather than retargeting it.

## [1.0.0] - 2026-08-09

### Added

- **Multi-pair consent graph** — a pair is one explicit permission edge between one Claude session and one Codex task, and pairs are many-to-many: one Claude session may hold edges to several Codex tasks and one Codex task to several Claude sessions (128 pairs by default, 256 hard cap). `embassy pair` / `embassy unpair` name both ends explicitly and carry the inherited `CODEX_THREAD_ID` as attestation; `select-claude` / `unselect-claude` remain as one-task shorthands that fail closed when the Codex end is ambiguous. Without an edge, a sender settles terminally as `SENDER_NOT_PAIRED`; `embassy serve --inbound open` stays the only directional no-edge exception and grants only a bounded correlated reply capability. Each registered task's native advertisement is owned by a supervised real-PID helper process; the broker remains the sole owner of state, queues, and dispatch. The snapshot carries first-class `pairs[]` with per-edge counters, and the live dashboard renders the consent topology with exact two-endpoint pair/unpair actions.
- **Progress watches** — opt-in, owner-held conversation supervision for long-running work: open with a leading `TRACK:` body or `--track [--idle-minutes n]` on a send. Any activity — including the worker's thread-status transitions, as proof-of-life — resets the idle clock; a genuinely quiet conversation receives at most two gateway-authored bilingual nudges with backoff before settling `unresponsive`. Only the owner ends tracking, with a correlated `DONE:` message or `embassy untrack --conversation <token>`. Watches persist broker restarts (conversation capability degrades to route-level and is journaled) and surface in a body-free Progress Supervision dashboard card in both locales.
- **Compatibility tiers and on-machine certification** — `EMBASSY_COMPAT_POLICY=observed` (default) admits an unknown same-major provider build only after its bounded schema probe passes; `strict` admits only the release's certified inventory. Three explicit tiers: certified, schema-attested, incompatible, with durable per-surface attestations. `embassy compat-check` runs bounded no-traffic probes; `embassy compat-certify [--codex <alias>] [--with-turn]` adds on-machine wire evidence via a short-lived scratch Claude print session and idle Codex thread operations, reporting per-surface outcomes with distinct exit codes (7 Claude, 8 Codex, 9 both). Certification evidence, including retained failures, renders in the Diagnostics tab; user-owned LaunchAgent recipes (update-triggered certify plus daily check) are documented. Registry probing shares runtime per-record isolation — one malformed live record can never poison boot — and startup state migration commits durably only after provider admission, so a failed upgrade leaves the prior state file byte-exact.
- **Attempt-then-ack delivery** — native Claude ingress gets an immediate exact dispatch attempt; fast terminal evidence suppresses the `held` frame entirely, true queue or provider deferral sends `held` immediately, and unresolved dispatch acknowledges at a bounded prompt boundary. Clean prewrite retries are bounded; ambiguous writes are never replayed; terminal truth remains first-wins. `delivered` still means released, never read.
- **Bounded snapshot observability** — suffix-only conversation correlation, body-free operator activity kinds, retained-evidence deadline buckets, and explicit peer-validation state across the static and live bilingual dashboards.

- Actionable failure copy for the paths a new operator meets first: state-directory or socket safety violations, unknown delivery tokens, and `wait-delivery` timeouts each explain themselves and name the next command instead of a generic rejection line, in both locales.
- Auto-update drift is fail-closed but self-explanatory: when the installed Claude Code moves past this build's pin, `serve` refuses with `CLAUDE_VERSION_DRIFT`, names the found and pinned versions, and points at `npm update -g agent-embassy` — tampering-shaped launcher states keep the strict refusal with nothing reflected.
- **Embassy**, a local, single-user, bidirectional message gateway between running Claude Code sessions and Codex desktop tasks, packaged as `agent-embassy` with CLI binary `embassy`.
- `embassy serve` — foreground broker that publishes one process-owned `codex-*` peer into Claude Code's live-session registry and opens its own callback socket; never daemonizes; removes both on shutdown.
- `register-codex` / `unregister-codex` — register or retire a `codex-*` route, run from inside the Codex task itself so it inherits `CODEX_THREAD_ID`.
- `select-claude` / `unselect-claude` — explicitly select or unselect a discovered Claude destination; Codex-to-Claude sends never select a candidate implicitly.
- `send-to-claude` / `send-to-codex` / `reply` — bounded, stdin-only message sends (16 KiB max) and conversation-token continuation, in both directions.
- `health` / `status` / `refresh-dashboard` — liveness check, sanitized snapshot (including `availablePeers`), and dashboard regeneration.
- `delivery-status` / `wait-delivery` — read one delivery tracker by its opaque `dlv_` token, or wait for it to settle; `wait-delivery` exits `0` only for `delivered`, `6` for any other terminal state, `3` for an unknown token, and `4` for a local wait timeout.
- Metadata-only, self-contained static dashboards — `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html`, both mode 0600, both atomically rewritten on every publish, cross-linked in the page, with no JavaScript, no server, no external assets, no self-refresh, and no message content shown.
- Delivery semantics: ordinary queue-while-busy plus exact Claude→Codex `STEER:` admission at App Server's next tool-call boundary, never mid-generation and never by forced interruption. Cleanly unavailable steering falls back to the normal queue; each route retains at most three queued steers and settles the displaced oldest message with an explicit journal event and normal receipt. Normalized terminal receipts remain `delivered`, `unconfirmed` (transport write completed, terminal native evidence unavailable), `ambiguous` (write outcome unknown), `expired`, `failed`, and `cancelled`. Native failure acknowledgements always retain one safe reason code; `EMBASSY_DELIVERY_NOTICES=merged` avoids a duplicate terminal diagnostic user frame by default, while `verbose` restores it and `quiet` suppresses all gateway-authored user-frame notices. Neither `unconfirmed` nor `ambiguous` authorizes a retry.
- Repo-shipped agent skill (`skills/embassy-peer/SKILL.md`) teaching the full operator/agent workflow — health, registration, sending, replying, queue-state interpretation — without exposing identifiers or message bodies.
- One host-wide crash-reclaimable owner lease, acquired before provider setup and independent of `EMBASSY_STATE_DIR`, so only one foreground Embassy controller can advertise routes for a login account.

- **Live dashboard companion** — `embassy dashboard --live [--lang en|zh-CN]` starts a separate foreground process that streams sanitized metadata to a browser tab on `127.0.0.1`; `embassy serve` remains TCP-free and HTTP-free.
- **One-use token authentication** — live companion access bootstraps via a 256-bit URL-fragment token exchanged for a path-scoped `HttpOnly` `SameSite=Strict` session cookie with Host, Origin, and sentinel validation.
- **Bounded browser actions** — the live companion exposes no CORS headers, generic control/provider routes, storage, telemetry, or external assets. Its sole mutation route accepts only confirmed exact two-endpoint pair, unpair, and refresh-discovery actions, with a 1 KiB body cap and six-action-per-minute token bucket; each mutation touches only the edge it names, and it cannot register tasks, send, reply, approve, interrupt, or change settings.
- **Bilingual dashboards** — the static pair renders in English and Simplified Chinese from one catalog and is switched by an in-page link; `--lang en|zh-CN` is a live-companion flag and is not accepted by `refresh-dashboard`.

### Changed

- Binary renamed from `claude-codex-gateway` to `embassy`; the old name ships for one release as a deprecated alias.
- State root moved from `~/.local/state/claude-agent-bridge/gateway` to `~/.local/state/agent-embassy`. This is a clean reset, not a migration — old gateway state is not carried forward. For one release, Embassy bounded-reads only the exact legacy default ownership marker and controller-lock record, then creates and holds that lock so a prototype cannot run alongside v1. A pre-existing legacy lock is preserved and blocks startup; after confirming no prototype process remains, remove that exact stale lock manually, then register and select again.
- Compatibility pins re-established for this release: Claude Code **2.1.226** / peer protocol 1 (with still-running 2.1.224–2.1.225 sessions remaining discoverable during a patch-upgrade overlap window), and Codex App Server **0.147.0**, resolved by exact path. Under the default `observed` policy an unknown same-major version is admitted only after its bounded schema probe passes; everything else fails closed.
- The public v1 launcher is macOS-only and local-host-only.
- Validated native records named `codex-*` are excluded from Claude destination discovery; they are gateway advertisements, not selectable Claude sessions.
- After Embassy restarts, a persisted Claude binding starts stale. The next authorized, complete discovery may reactivate only the exact same Claude session UUID under the same provider, host, and owner lease, adopting its latest name after workspace/provider revalidation. Changed, missing, incomplete, or ambiguous identity stays stale. Queued text, callbacks, receipt handles, pending replies, and conversation capability are never restored.
- Re-running `register-codex` replaces a closed or faulted App Server connector; an idle recovered route wakes held work without retrying any ambiguous write.
- The first successful Codex registration fixes its exact alias, task, and host until it is explicitly succeeded. Exact re-registration remains available for connector recovery. `register-codex --alias <new> --succeeds <current>`, run from inside the successor task on the same host, is the only way to change the registered Codex identity without restarting the broker: Embassy freezes the outgoing route, drains its accepted work to terminal settlement, then publishes the successor on a fresh listener generation. Nothing transfers — no queued body, conversation, reply capability, or delivery token — and a succession that cannot be completed pins the identity fail-closed until manual recovery rather than leaving two live registrations.
- Failed reactivation of a retained Codex route, or a fresh registration whose cleanup cannot be fully confirmed, pins that exact identity fail-closed until exact retry or confirmed unregister followed by restart.
- Pairs are additive, bounded, and per-edge: adding an edge never retires another, and removing one invalidates its active conversation capabilities before the change is published. Explicitly requested endpoint replacement (registration succession) atomically settles the outgoing endpoint's accepted work before the replacement is exposed; a half-replaced intermediate state is never published.

### Removed

- The one-way MCP task lifecycle (the six `claude_task_*` tools) existed only in the unpublished prototype. It was never released publicly and is not present in Embassy v1.

### Security

- No network surface in the broker: `embassy serve` opens no TCP listener and no HTTP server, makes no provider API call, and sends no telemetry; its control and callback surfaces are private Unix-domain sockets. The opt-in `embassy dashboard --live` companion is the only network listener Embassy can create — a separate foreground process bound to `127.0.0.1` on an ephemeral port, token-authenticated, and limited to the three route-consent actions described above. Delivered content still enters the receiving cloud-backed product as an ordinary model turn.
- Same-UID containment, not authentication: provider identity is inherited from the process environment (a Codex task's `CODEX_THREAD_ID` or a Claude session's messaging socket, never both), and every mutation is additionally checked against route ownership, exact thread/session generation, source alias, and bounds.
- Nothing persisted beyond route rebinding: bodies, prompts, replies, raw provider frames, and socket paths are never persisted. Provider-native identifiers (Codex thread ID, Claude session UUID) are kept only inside the closed, mode-0600 private route binding used to re-observe a route after restart.
- Every registered Codex task is visible to every compatible live Claude session running as the same OS user, but paired mode accepts only sessions holding an explicit pair edge with that exact task — register only when comfortable with every currently running compatible Claude session, and `unregister-codex` when done.
- Embassy never sets, relaxes, or overrides a Codex task's approval or sandbox policy and never answers an approval request. Claude-initiated turns use the task's existing native policy.
- Claude-to-Codex reachability does not select that session for outbound Codex-to-Claude delivery. In the opposite direction, Claude's native `crossSessionInbound` control governs messages entering the selected Claude session.
- Version attestation (a bounded `claude --version` in a scrubbed environment) proves compatibility, not authenticity.
