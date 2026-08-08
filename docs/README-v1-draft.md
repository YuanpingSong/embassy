# Embassy

**A local embassy for your AI agents.**

Embassy is a personal, local-only gateway that lets your running [Claude Code](https://code.claude.com) sessions and [Codex](https://chatgpt.com/codex) desktop tasks find each other by name and exchange messages — in both directions, on one machine, under your explicit control.

```bash
npm install -g agent-embassy
embassy serve
```

Personal, single-user, same-machine software: run it only under an OS account that is yours alone, on a machine where you trust everything already running as you.

Embassy is an unofficial community project. It is not affiliated with or endorsed by Anthropic or OpenAI.

## Why

If you work with more than one AI coding agent, they live in separate worlds. Claude Code sessions can already message each other through Anthropic's official cross-session messaging; Codex tasks are native to the Codex app. There is no sanctioned way for one to consult the other — short of you copy-pasting between windows.

Embassy is a small, single-user message broker that routes bounded text between sessions of the two products. It does not wrap, replace, or re-implement either agent, and it never touches their credentials. The broker itself opens no network connection — no listener, no outbound calls, no telemetry. Your agents, though, remain what they are: a routed message becomes input to a model turn, so its content reaches Anthropic or OpenAI exactly as if you had typed it into that session yourself.

A Claude session can ask the Codex task reviewing your PR what it found. A Codex task can ask a long-running Claude session for a second opinion — and get the reply routed back, even if it arrived while Codex was busy.

## The vocabulary

Four embassy terms name real features. Everything technical about them lives in the sections below.

- **Registration and selection** are the accreditation step: routes exist only for parties you have explicitly enrolled.
- **The ledger** is the delivery record: a receipt for every settled message, and a metadata-only dashboard.
- **The pouch** is transit: bounded bodies, ephemeral inside Embassy, never persisted by it.
- **Consulates** are the roadmap: the same model extended to Codex tasks on remote hosts over attach-only SSH — designed, and deliberately disabled in v1.

## How it works

```text
 Claude Code sessions                        Codex desktop task
 (native ListAgents /                        (native App Server,
  SendMessage tools)                          its own native policy)
        │                                            │
        ▼                                            ▼
  ┌─────────────────── embassy (local broker) ───────────────────┐
  │  alias routing │ queue-while-busy │ receipts │ dashboard     │
  └───────────────────────────────────────────────────────────────┘
```

Embassy publishes one explicitly registered Codex task into Claude Code's live-session registry as a clearly named `codex-*` peer. Claude sessions address it with their native `ListAgents` and `SendMessage` tools — no plugin, no MCP server, no changes to your Claude settings. Embassy does create two things while running, and removes both on shutdown: that one registry record, and its own callback socket alongside Claude's peer sockets. Both live on internal, version-pinned Claude Code surfaces — see [Compatibility](#compatibility-contract).

Know the asymmetry: v1 advertises exactly **one** registered Codex task per gateway process, and once registered, that `codex-*` peer is visible to **every** live Claude session under your account. Inbound reach on the Claude→Codex direction is gated by registration, not by per-session selection — so register a Codex task only while you are comfortable with every Claude session you have running, and `unregister-codex` when you are done. The opposite direction is gated twice: a Codex task must be registered to send, and a Claude session must be selected by you to be a target.

On the Codex side, Embassy attaches to the already-running Codex App Server and starts ordinary turns on the registered task. Messages to a busy task queue and dispatch automatically when it goes idle. Replies are correlated in memory and routed back to the originating session. `turn/steer` is not exposed at all; the only turn Embassy may interrupt is one it started itself and positively observed.

## Quickstart

Requirements:

- macOS (the only platform exercised so far) and Node.js ≥ 20
- Claude Code 2.1.225, installed and signed in (still-running 2.1.224 sessions stay discoverable — see [Compatibility](#compatibility-contract))
- Codex desktop app with its managed standalone App Server 0.147.0, resolved by exact path — a `codex` on your `PATH` is not used and is not affected

One precondition before anything else: **Claude-initiated turns require the Codex task's own policy to already be `approvalPolicy: never`, sandbox `readOnly`, network access off.** Set that with native Codex controls first. A task with any other policy registers monitor-only — visible on the dashboard, but Claude cannot start turns on it — and changing the policy afterwards means re-registering. Embassy never sets, relaxes, or overrides that policy.

Start the broker in an interactive terminal under the same OS account that runs both agents. It stays in the foreground and never daemonizes:

```bash
embassy serve
```

From another terminal, check it and list the Claude sessions Embassy currently sees:

```bash
embassy health
embassy status    # the availablePeers list holds the names you can select below
```

Register the Codex task. The command must run inside that task's own process so it inherits the task's `CODEX_THREAD_ID` — in practice, ask the Codex agent to run it as a shell step in its current turn:

```bash
embassy register-codex --alias reviewer@this-mac
```

Select the Claude session you want reachable, using a name from `availablePeers`:

```bash
embassy select-claude --alias advisor@this-mac
```

Send from the Codex task to the Claude session. Bodies come from standard input, never arguments:

```bash
embassy send-to-claude --from reviewer@this-mac --to advisor@this-mac <<'MSG'
Please review the current approach and note the main risk.
MSG
```

The send prints a conversation token; either side continues the thread with it:

```bash
embassy reply --conversation conv_<token-from-the-send> --alias reviewer@this-mac <<'MSG'
Here is the follow-up.
MSG
```

In the other direction there is nothing new to learn: the Claude session messages the registered `codex-*` peer with its native `ListAgents` and `SendMessage`, and Embassy returns Codex's reply.

## Addressing

Claude sessions are addressed by their current `name@host`, or directly by their native session UUID. The UUID is the stable identity; the name is a live lookup alias. Rename a session and the old name stops resolving immediately, while a UUID-bound route keeps working. Embassy never prints or invents a UUID, and it refuses to guess when two live sessions share a name.

## Commands

| Command | Who runs it | Purpose |
| --- | --- | --- |
| `serve` | operator | Start the foreground broker and write the dashboard |
| `health` / `status` | operator | Liveness; the sanitized snapshot, including `availablePeers` |
| `refresh-dashboard` | operator | Regenerate the dashboard file |
| `register-codex` / `unregister-codex` | the Codex task itself | Register / retire a Codex route by alias |
| `select-claude` / `unselect-claude` | operator | Select / unselect a discovered Claude session by alias |
| `send-to-claude` | a registered Codex task | One bounded message to a selected Claude session |
| `send-to-codex` | a Claude session | One bounded message to the registered Codex task |
| `reply` | either provider | Continue a conversation by its returned token |

Provider commands are attributed to exactly one inherited identity — a Codex task's `CODEX_THREAD_ID` or a Claude session's messaging socket, never both — and fail closed when identity is missing or doubled. That is attribution and blast-radius limiting, not authentication; see the security model. Aliases are labels, not authority: every send re-validates the exact live endpoint behind the route.

## Delivery semantics

- **Queue-while-busy is the only busy policy.** Embassy never interrupts or steers an active turn to force a delivery.
- **Receipts.** Acceptance returns `delivered`. Route failures, delivery failures, and deadline expiry return `expired` — followed, on the Claude side, by a single static `<gateway-delivery-diagnostic>` frame carrying one safe error code, never a path, identifier, exception, or body. That frame is the only content Embassy ever authors. `denied` exists in the protocol but is reserved for a real user or policy refusal and is not emitted by v1. Progress states (`held`, transport-written) are never reported as success.
- **Retries.** A clean failure *before* dispatch returns the message to the queue and retries after the route is re-observed. An *ambiguous* write — one that may or may not have landed — is never retried automatically; Embassy reports it and stops. Retrying is a human decision.
- **Bounded by design.** Queues have fixed depth, sends are rate-limited and deduplicated, and every message carries a deadline and hop count. Queue-full, expiry, and stale-route conditions surface as normalized states, never as raw diagnostics.
- **Restart.** While the broker runs, every message settles into a receipt the sender can read. If the broker exits first, queued and in-flight messages are marked abandoned, their bodies are discarded, and nothing is replayed. Every route is stale after a restart until its endpoint is positively re-observed.

## Security model

- **A local broker, not a network service.** No TCP listener, no HTTP server, no outbound connections, no telemetry. The control plane is a private Unix-domain socket inside Embassy's mode-0700 state directory; state files are mode 0600.
- **Single-user by construction, so single-user in deployment.** The provider surfaces Embassy must touch — Claude's live-session registry and the shared peer-socket directory under `/tmp` — belong to Claude Code, not to Embassy, and are validated by schema, PID correlation, liveness, and generation checks rather than by owner and mode bits. Run Embassy only on a machine where you are the sole account. Never host it, share it, or expose it on a network.
- **Same-UID containment, not authentication.** Provider identity is inherited from the process environment, and any process running as your OS account can present it. Every mutation is additionally checked against route ownership, exact thread/session generation, source alias, and bounds — but Embassy is not a defense against code you have already let run as you.
- **Narrow, enumerable access.** Embassy reads only Claude's live-session registry directory, connects only to validated peer sockets in Claude's socket directory, creates and removes only its own callback socket there, attaches only to the local Codex App Server endpoint, and writes only inside its own state directory. It never reads credentials, Keychain items, transcripts, session history, or either product's configuration.
- **What persists, and where.** Bodies, prompts, replies, raw provider frames, and socket paths are never persisted at all. Provider-native identifiers — the Codex thread ID, the Claude session UUID — are kept only inside the closed, mode-0600 private route binding that lets a route be re-observed after a restart. They never appear in the dashboard, the public snapshot, events, logs, aliases, CLI arguments or output, or error text.
- **Ephemeral in transit, not in the conversation.** Bodies are memory-only inside Embassy (16 KiB max, stdin only). Once delivered, the receiving agent stores the message the way it stores anything you send it: in its transcript or thread history. Embassy makes the transit ephemeral, not the conversation.
- **Version attestation, not integrity attestation.** Embassy confirms the pinned Claude build by running a bounded `claude --version` in a scrubbed environment. That proves compatibility, not authenticity: the executable is whatever `EMBASSY_CLAUDE_BIN` — or the path derived from your verified home — points at. Point `EMBASSY_CLAUDE_BIN` at your real Claude install if in doubt.
- **The dashboard is a file.** `gateway-dashboard.html`: self-contained, mode 0600, atomically rewritten, auto-refreshing via a meta tag. No server, no JavaScript, no external assets, no cookies, no telemetry. It never shows message content, but it does show route metadata — aliases, hosts, states, timestamps, sizes, queue depth. Anything running as your account, agents included, can read it; keep `EMBASSY_STATE_DIR` outside your agents' workspaces if that matters to you.
- **Permissions stay native — read the fine print on the gated path.** Embassy never relaxes a Codex task's policy and never answers approvals. But note what the write-gate requirement means: a task eligible for Claude-initiated turns runs with `approvalPolicy: never`, so no human confirmation stands between an inbound message and a real model turn. Treat every routed message as untrusted input that can steer the receiving agent. On the Claude side, `crossSessionInbound` is your native control — a session can accept, hold, or refuse inbound messages, and Embassy cannot override it. If your machine runs admin-managed Claude Code policy, check it before installing; managed policy outranks anything you or Embassy configure.

## What Embassy is not

- **Not an orchestrator.** It does not spawn agents or manage their work. It starts one turn per routed message and drains its queue when the task goes idle.
- **Not a hosted service.** Personal, same-machine, same-OS-account software.
- **Not a permission bypass — but it is a new path.** Neither agent gains a tool it did not already have, and Embassy grants, relaxes, and answers nothing. It does, however, connect two products that previously could not exchange text at all. That path is the product; treat it with the respect you would give any new input channel.
- **Not official.** Not affiliated with or endorsed by Anthropic or OpenAI.

## Compatibility contract

Embassy speaks two surfaces that are not documented as stable third-party APIs: Claude Code's live-session peer transport (pinned: Claude Code **2.1.225**, peer protocol 1, with 2.1.224 same-protocol overlap during a patch upgrade) and the Codex App Server schema (pinned: **0.147.0**). Every record, socket, and response shape is validated before use, and an unknown version fails closed — Embassy stops rather than guesses.

When a provider updates, expect Embassy to refuse the new version until its adapter is reviewed and re-pinned. That refusal is the contract: no silent compatibility, no drifting behavior on surfaces you cannot see.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `~/.local/state/agent-embassy` (an explicit absolute path replaces it) | Private controller state, control socket, and dashboard |
| `EMBASSY_CLAUDE_BIN` | derived from your verified home (`~/.local/bin/claude` → the pinned version directory); `PATH` is not searched | Pinned Claude Code executable |

(Final variable names land with the v1 rename PR; this table tracks the proposal.)

## Migrating from claude-agent-bridge

Embassy is the public v1 of what was prototyped as `claude-agent-bridge`. Three things changed:

1. **The one-way MCP task lifecycle is retired.** The gateway fully replaces it. The final lifecycle code is preserved at the `mcp-lifecycle-final` tag, created in the retirement PR.
2. **Clean state reset.** v1 starts fresh under `~/.local/state/agent-embassy`; old state under `~/.local/state/claude-agent-bridge` is not migrated. Re-register your Codex task and re-select your Claude session — routes were stale on every restart anyway.
3. **`claude-codex-gateway` is now `embassy`.** The old binary name ships as a deprecated alias for one release.

## License

MIT
