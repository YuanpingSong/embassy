[English](README.md) · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — a local gateway for bidirectional messaging between Claude Code sessions and Codex desktop tasks" width="720">
</p>

# Embassy

**A local embassy for your AI agents.**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

Your [Claude Code](https://code.claude.com) sessions and [Codex](https://chatgpt.com/codex) desktop tasks can't talk to each other. When one needs the other's perspective, you carry context between windows yourself. Embassy is a small local broker that lets them find each other by name and exchange messages in both directions — no plugins, no API keys, no cloud relay.

```bash
npm install -g agent-embassy
embassy serve
```

Or from source: `git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`.

Embassy is built for one person, one macOS account, and agents you already trust to run as that user. It is an unofficial community project and is not affiliated with or endorsed by Anthropic or OpenAI.

## Quickstart

**Requirements:** macOS, Node.js 20+, Claude Code 2.1.226 (still-running 2.1.224–2.1.225 sessions remain discoverable), and Codex desktop configured to use the managed standalone App Server 0.147.0:

```bash
~/.codex/packages/standalone/current/codex app-server daemon start
/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT
```

The first command starts the managed daemon if it is not already running (`restart` and `stop` also exist); the second launches the ChatGPT desktop app pointed at it. `CODEX_APP_SERVER_USE_LOCAL_DAEMON` is not documented by OpenAI; it is observed to work with this Desktop build and may change. Run the daemon command from a normal terminal, never from inside an agent session: Codex tasks inherit the daemon's environment, so a daemon started inside a Claude Code session leaks that session's identity into every task and registration fails closed with `CALLER_IDENTITY_CONFLICT` — fix it from a normal terminal with `codex app-server daemon restart`. The Claude session you select as a destination needs [`crossSessionInbound`](docs/CONFIGURATION.md) enabled — that is Claude Code's own setting, configured in Claude Code, not in Embassy.

Provider compatibility needs no separate operator step. `embassy serve` automatically validates the release's exact Claude and Codex version pins and fails closed on unknown versions or required protocol shapes.

> **Known limitation:** Embassy can reach Codex tasks only while Desktop uses the managed standalone App Server. In that mode, tasks currently cannot connect to Desktop's built-in in-app browser (`@Browser` loads but does not attach). Switching Desktop back to its default private App Server restores the built-in browser immediately — but makes those tasks unreachable by Embassy. No other capability regressions have been identified, though this was not an exhaustive parity test.

### 1. Start Embassy

Run the foreground broker under the same OS account as Claude Code and Codex:

```bash
embassy serve
```

You should see `"status":"ready"`. In another terminal:

```bash
embassy health
embassy status
```

`status` lists `availablePeers` — the live Claude sessions you can select.

### 2. Register the Codex task

Ask your Codex agent to run this as a shell step in its current turn — the command must run inside the task so it inherits the task's identity:

```bash
embassy register-codex --alias codex-reviewer@this-mac
```

You should see `"accepted":true`. The `codex-` prefix is required for Claude discovery. To retire the task later, run `unregister-codex`.

Managed App Server generation changes and `embassy serve` restarts both use exact-task reactivation. Each replacement starts monitor-only; only a fresh initialize plus `thread/loaded/list` result that finds the byte-identical task exactly once may re-anchor the alias, and writes stay fenced until that exact generation is activated. A normal broker restart therefore needs no manual registration. An incompatible endpoint or a missing or duplicate exact task leaves the route stale with `REOBSERVATION_REQUIRED`; once that task is observable, rerun `embassy register-codex --alias codex-reviewer@this-mac` from the exact task without unregistering first. Embassy never retargets by alias or replays an ambiguously written body.

### 3. Select a Claude destination

Pick one name from `availablePeers`:

```bash
embassy select-claude --alias advisor@this-mac
```

You should see `"accepted":true`. Registration and selection together form a pair — this Claude session and this Codex task can now exchange messages through Embassy. (`select-claude` is the one-task shorthand; `embassy pair --claude <name@host> --codex <codex-alias>` names both ends explicitly, and many pairs can coexist.)

### 4. Send a message

From the registered Codex task, send via stdin:

```bash
embassy send-to-claude \
  --from codex-reviewer@this-mac \
  --to advisor@this-mac \
  --expects-reply <<'MSG'
Please review the current approach and identify the main risk.
MSG
```

You should see a `conv_` conversation token and a `dlv_` delivery token. Because this send requested a reply, Claude's response is automatically routed back to the Codex task. In the other direction, a compatible Claude session uses its native `ListAgents` and `SendMessage` tools to contact `codex-reviewer` — no Embassy command needed.

### 5. Follow up

Either participant can continue the conversation with `reply`. The initiating
CLI receives the full `conv_` token in its accepted result; the recipient gets
the same token and an exact reply command in the broker-owned message marker:

```bash
embassy reply \
  --conversation conv_<token> \
  --alias codex-reviewer@this-mac <<'MSG'
Please expand on the migration risk.
MSG
```

Every routed body reaches either product inside one broker-owned
`<cross-session-message>` textual frame. It identifies the verified sender
alias and begins with an `<embassy-reply-hint>` containing the full conversation
token, the recipient's exact alias, and the corresponding `embassy reply`
command. Use only that delivered full token and alias; never guess one from a
suffix or substitute the sender's alias. The CLI still rechecks the caller,
conversation membership, and current route policy, so the hint is
not a permission bypass.

The frame is a clear provenance marker, not a cryptographic signature or a
claim that the body is trustworthy. Embassy neutralizes nested occurrences of
its two reserved framing tags in the untrusted body before provider delivery;
arbitrary same-user code and all message text remain untrusted input.

### See it live

`embassy dashboard --live` opens a five-tab streaming view in the browser
(overview, deliveries, routes, activity, diagnostics) at
`http://127.0.0.1:41961/` by default. To choose another stable port for that
invocation, run `embassy dashboard --live --port <n>` with an integer from 1024
through 65535. Multiple windows and browsers can use the same URL while the
foreground companion runs. If the port is occupied, startup fails explicitly,
points to `--port`, and never falls back to another port. See
[Dashboard](docs/DASHBOARD.md) for details.

The live dashboard can also remove an orphaned Codex registration after an explicit confirmation, but only when the broker proves that the registration is stale and its owning endpoint generation is dead. A current, merely offline, or ambiguous generation is never removable through this recovery action.

The broker also publishes mode-0600 static snapshots as `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html`. The live dashboard has no login, token, cookie, or per-browser session: it assumes a trusted single-user machine, and local software that can reach or spoof loopback can read it and invoke its bounded actions. The server still requires the exact Host header on every request and the exact Origin plus `X-Embassy-Request` on every POST; it sends no CORS headers and does not accept `OPTIONS`.

## How it works

```text
 Claude Code sessions                         Codex desktop task
 (native ListAgents /                         (native App Server,
  SendMessage tools)                           existing task policy)
        │                                             │
        ▼                                             ▼
  ┌──────────────────── Embassy ─────────────────────────────┐
  │ explicit routes │ Codex busy queue │ receipts │ dashboard │
  └───────────────────────────────────────────────────────────┘
```

Embassy publishes each registered Codex task into Claude Code's live-session registry as its own `codex-*` peer. Compatible Claude sessions discover them through their native `ListAgents` and contact them with `SendMessage` — no plugin, MCP server, or settings change required.

A pair is one explicit permission edge between one Claude session and one Codex task — and pairs are many-to-many: one Claude session may hold edges to several Codex tasks, and one Codex task to several Claude sessions (bounded at 128 pairs by default). Every edge is created explicitly, with `pair` or the one-task `select-claude` shorthand; nothing is ever implied. Without an edge, a sender settles terminally as `SENDER_NOT_PAIRED`. `embassy serve --inbound open` is the explicit opt-out that restores any-session inbound.

Delivery timing is directional. Once routing and pre-write checks pass, every Claude-bound body is written immediately to Claude's native mailbox regardless of its observed busy or idle state. `transport_written` records that mailbox write and is the Claude-bound terminal `delivered` boundary; it does not mean Claude read or consumed the body. Codex-bound ordinary bodies instead queue while the task is busy and start a turn when it goes idle. In the Claude-to-Codex direction only, a body with an exact leading `STEER:` prefix may enter the active turn at the App Server's next tool-call boundary; if that boundary is unavailable, the message returns to the normal queue.

Immediately before the provider write, Embassy gives every routed body one
broker-owned cross-session marker containing the verified sender alias and a
recipient reply hint. The full conversation token travels only in the
initiator's accepted result and the recipient's transient message payload; it
never enters the dashboard, public snapshot, journal, receipt, or log.

Every settled message produces a receipt. `delivered` means the direction's terminal provider boundary was observed — toward Codex, the App Server accepted the turn; toward Claude, the native mailbox write completed. Neither means the model read or acted on it. `unconfirmed` and `ambiguous` mean the required evidence is missing; they are terminal states and never auto-retried. See [Delivery](docs/DELIVERY.md) for the full semantics.

## The vocabulary

Four embassy terms name real features:

- **Registration and pairing** are the permission model: a Codex task is explicitly registered, and each pair is one explicit Claude↔Codex edge — only paired ends exchange messages, and many edges can coexist. No edge means `SENDER_NOT_PAIRED`; nothing is ever implicit.
- **The ledger** is the delivery record: a receipt for every settled message, and a metadata-only dashboard.
- **The pouch** is transit and the archive: bounded bodies, retained under bounded limits, private to your OS account — sealed against other users, not against you.
- **Consulates** are the roadmap: the same model extended to Codex tasks on remote hosts over attach-only SSH — designed, and deliberately disabled in v1.

## For agents

Embassy's operators are often agents themselves: `register-codex` runs inside the Codex task, and the Claude side is driven entirely through native tools. The repo ships [`skills/embassy-peer/SKILL.md`](skills/embassy-peer/SKILL.md) — point your agent at it rather than paraphrasing this README.

The skill ships in the npm package; install it where each agent discovers skills:

```bash
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.codex/skills/
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.claude/skills/
```

Codex tasks can then be prompted with `$embassy-peer`; Claude Code discovers it as a user skill.

## Commands

| Command | Run by | Purpose |
| --- | --- | --- |
| `serve` | operator | Start the foreground broker and dashboard |
| `health` / `status` | operator | Check liveness and inspect the sanitized snapshot |
| `refresh-dashboard` | operator | Regenerate both static dashboard files |
| `dashboard --live [--lang en\|zh-CN] [--port <n>]` | operator | Start the live dashboard companion with bounded route-consent actions; requires a running `embassy serve` |
| `delivery-status` | either provider | Read one delivery tracker with `embassy delivery-status --token dlv_<token>` |
| `wait-delivery` | either provider | Wait for that tracker to settle, up to the delivery deadline |
| `register-codex` / `unregister-codex` | Codex task | Advertise or retire that exact task; for example, `embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac` hands the registration to a different task |
| `pair` / `unpair` | operator | Add or remove one explicit Claude↔Codex edge by naming both ends: `embassy pair --claude advisor@this-mac --codex codex-reviewer@this-mac` |
| `select-claude` / `unselect-claude` | operator | One-task shorthand for `pair`/`unpair`: resolves the Codex end only when it is unambiguous (inherited or sole registered task), otherwise fails closed |
| `send-to-claude` | registered Codex task | Send one bounded message to a paired Claude session |
| `send-to-codex` | Claude session | Send one bounded message using the inherited native reply identity |
| `reply` | conversation-token holder | Continue an active conversation with the full token returned to the initiator or delivered in the recipient's broker-owned reply hint |

## Safety in one minute

- **Local broker, stable loopback dashboard.** `embassy serve` listens on private Unix-domain sockets and makes no provider API call. The opt-in `embassy dashboard --live` companion is a separate process and the only listener Embassy can create, bound to exact `127.0.0.1` on stable port `41961` by default (or the per-invocation `--port <n>`). It is deliberately unauthenticated local HTTP for a trusted single-user machine; Host, Origin, and sentinel checks constrain browser-origin requests but do not authenticate local processes or OS users.
- **Same-UID containment, not authentication.** Caller identity is inherited from the local process environment. Route ownership and generation checks reduce mistakes, but are not a defense against code already running as your OS user.
- **Compatibility is automatic and exact-pinned.** Broker/provider startup validates only the release's reviewed versions and protocol shapes. Every replacement App Server endpoint generation gets a fresh monitor-only check before route re-anchoring; unknown versions and malformed generations stay write-disabled.
- **Native permissions stay native.** Embassy sends no Codex approval or sandbox overrides and answers no approval request. `crossSessionInbound` remains Claude's own control; Embassy cannot override it.
- **Provenance is marked, not authenticated.** Routed bodies carry one broker-owned cross-session marker with the verified sender alias; it distinguishes the transport path for the receiving model but cannot make untrusted text safe or authenticate against code already running as your OS user.
- **Bodies stored, bounded, and yours.** Message bodies persist in the broker's private mode-0600 state under bounded retention so the ledger can show you the mail itself; queued mail survives a broker restart and re-sends exactly once. Raw provider frames stay memory-only. The static dashboard files remain metadata-only; the live dashboard shows retained bodies.

See [SECURITY.md](SECURITY.md) for the full boundary and vulnerability-reporting process.

## What Embassy is not

- **Not an orchestrator.** It does not spawn agents or manage their work. Codex-bound ordinary messages start one turn apiece as the task becomes idle; Claude-bound messages enter Claude's mailbox without waiting for idle.
- **Not a hosted service.** Personal, same-machine, same-OS-account software.
- **Not a permission bypass — but it is a new path.** Neither agent gains a tool it did not already have, and Embassy grants, relaxes, and answers nothing. It does, however, connect two products that previously could not exchange text at all. That path is the product; treat it with the respect you would give any new input channel.
- **Not official.** Not affiliated with or endorsed by Anthropic or OpenAI.

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](docs/GATEWAY-ARCHITECTURE.md) | The full design: topology, adapters, control plane, threat model, staged authorization ladder |
| [Delivery](docs/DELIVERY.md) | Delivery semantics, tokens, settlement states, and retry rules |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, compatibility contract, and addressing rules |
| [Dashboard](docs/DASHBOARD.md) | Static and live dashboard setup, security model, and mutation actions |
| [Security policy](SECURITY.md) | How to report a vulnerability, and the boundary in depth |
| [Contributing](CONTRIBUTING.md) | Where changes go, and how to run the deterministic suite |
| [Changelog](CHANGELOG.md) | What each release contains |
| [Agent skill](skills/embassy-peer/SKILL.md) | The workflow an agent follows to operate Embassy |

## License

[MIT](LICENSE)
