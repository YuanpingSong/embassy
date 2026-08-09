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

**Requirements:** macOS, Node.js 20+, Claude Code 2.1.226 (still-running 2.1.224–2.1.225 sessions remain discoverable), Codex desktop with App Server 0.147.0 running. The Claude session you select as a destination needs [`crossSessionInbound`](docs/CONFIGURATION.md) enabled — that is Claude Code's own setting, configured in Claude Code, not in Embassy.

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

Either side can continue the conversation:

```bash
embassy reply \
  --conversation conv_<token> \
  --alias codex-reviewer@this-mac <<'MSG'
Please expand on the migration risk.
MSG
```

### See it live

`embassy dashboard --live` opens a five-tab streaming view in the browser (overview, deliveries, routes, activity, diagnostics). See [Dashboard](docs/DASHBOARD.md) for details.

The broker also publishes mode-0600 static snapshots as `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html`. Live dashboard mutations require the same-origin `X-Embassy-Request` sentinel.

## How it works

```text
 Claude Code sessions                         Codex desktop task
 (native ListAgents /                         (native App Server,
  SendMessage tools)                           existing task policy)
        │                                             │
        ▼                                             ▼
  ┌──────────────────── Embassy ─────────────────────────────┐
  │ explicit routes │ queue while busy │ receipts │ dashboard │
  └───────────────────────────────────────────────────────────┘
```

Embassy publishes each registered Codex task into Claude Code's live-session registry as its own `codex-*` peer. Compatible Claude sessions discover them through their native `ListAgents` and contact them with `SendMessage` — no plugin, MCP server, or settings change required.

A pair is one explicit permission edge between one Claude session and one Codex task — and pairs are many-to-many: one Claude session may hold edges to several Codex tasks, and one Codex task to several Claude sessions (bounded at 128 pairs by default). Every edge is created explicitly, with `pair` or the one-task `select-claude` shorthand; nothing is ever implied. Without an edge, a sender settles terminally as `SENDER_NOT_PAIRED`. `embassy serve --inbound open` is the explicit opt-out that restores any-session inbound.

Messages queue while the Codex task is busy and start an ordinary turn when it goes idle. In the Claude-to-Codex direction only, a body with an exact leading `STEER:` prefix may enter the active turn at the App Server's next tool-call boundary; if that boundary is unavailable, the message returns to the normal queue.

Every settled message produces a receipt. `delivered` means terminal provider evidence was observed — toward Codex, the App Server accepted the turn; toward Claude, the message was released into the session's native queue. Neither means the model read or acted on it. `unconfirmed` and `ambiguous` mean evidence is missing; they are terminal states and never auto-retried. See [Delivery](docs/DELIVERY.md) for the full semantics.

## The vocabulary

Four embassy terms name real features:

- **Registration and pairing** are the permission model: a Codex task is explicitly registered, and each pair is one explicit Claude↔Codex edge — only paired ends exchange messages, and many edges can coexist. No edge means `SENDER_NOT_PAIRED`; nothing is ever implicit.
- **The ledger** is the delivery record: a receipt for every settled message, and a metadata-only dashboard.
- **The pouch** is transit: bounded bodies, ephemeral inside Embassy, never persisted by it.
- **Consulates** are the roadmap: the same model extended to Codex tasks on remote hosts over attach-only SSH — designed, and deliberately disabled in v1.

## For agents

Embassy's operators are often agents themselves: `register-codex` runs inside the Codex task, and the Claude side is driven entirely through native tools. The repo ships [`skills/embassy-peer/SKILL.md`](skills/embassy-peer/SKILL.md) — point your agent at it rather than paraphrasing this README.

## Commands

| Command | Run by | Purpose |
| --- | --- | --- |
| `serve` | operator | Start the foreground broker and dashboard |
| `health` / `status` | operator | Check liveness and inspect the sanitized snapshot |
| `refresh-dashboard` | operator | Regenerate both static dashboard files |
| `dashboard --live [--lang en\|zh-CN]` | operator | Start the live dashboard companion with bounded route-consent actions; requires a running `embassy serve` |
| `delivery-status` | either provider | Read one delivery tracker with `embassy delivery-status --token dlv_<token>` |
| `wait-delivery` | either provider | Wait for that tracker to settle, up to the delivery deadline |
| `register-codex` / `unregister-codex` | Codex task | Advertise or retire that exact task; for example, `embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac` hands the registration to a different task |
| `pair` / `unpair` | operator | Add or remove one explicit Claude↔Codex edge by naming both ends: `embassy pair --claude advisor@this-mac --codex codex-reviewer@this-mac` |
| `select-claude` / `unselect-claude` | operator | One-task shorthand for `pair`/`unpair`: resolves the Codex end only when it is unambiguous (inherited or sole registered task), otherwise fails closed |
| `send-to-claude` | registered Codex task | Send one bounded message to a paired Claude session |
| `send-to-codex` | Claude session | Send one bounded message using the inherited native reply identity |
| `reply` | either provider | Continue an active conversation by its public token |

## Safety in one minute

- **Local sockets only.** `embassy serve` listens on private Unix-domain sockets and makes no provider API call. The opt-in `embassy dashboard --live` companion is a separate process and the only listener Embassy can create, bound to `127.0.0.1` on an ephemeral port.
- **Same-UID containment, not authentication.** Caller identity is inherited from the local process environment. Route ownership and generation checks reduce mistakes, but are not a defense against code already running as your OS user.
- **Native permissions stay native.** Embassy sends no Codex approval or sandbox overrides and answers no approval request. `crossSessionInbound` remains Claude's own control; Embassy cannot override it.
- **Bodies never persisted.** Message bodies, prompts, replies, and raw provider frames live only in memory. Metadata-only dashboard files are mode 0600 with no JavaScript.

See [SECURITY.md](SECURITY.md) for the full boundary and vulnerability-reporting process.

## What Embassy is not

- **Not an orchestrator.** It does not spawn agents or manage their work. It starts one turn per routed message and drains its queue when the task goes idle.
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
| [Migration](docs/MIGRATION.md) | Migrating from the prototype gateway |
| [Security policy](SECURITY.md) | How to report a vulnerability, and the boundary in depth |
| [Contributing](CONTRIBUTING.md) | Where changes go, and how to run the deterministic suite |
| [Changelog](CHANGELOG.md) | What each release contains |
| [Agent skill](skills/embassy-peer/SKILL.md) | The workflow an agent follows to operate Embassy |

## License

[MIT](LICENSE)
