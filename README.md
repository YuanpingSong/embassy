[English](README.md) · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — a local gateway for bidirectional messaging between Claude Code sessions and Codex desktop tasks" width="720">
</p>

# Embassy

**A local embassy for your AI agents.**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

Your [Claude Code](https://code.claude.com) sessions, [Codex](https://chatgpt.com/codex) desktop tasks, local DeepSeek Harness, and Grok Build agent do not share one routing surface. Embassy is a small local broker that gives all four providers named routes and explicit consent edges — no plugins, no API keys handled by Embassy, and no cloud relay.

```bash
npm install -g agent-embassy
```

Prerequisites, stated honestly: v1.7.x requires **Claude Code installed via
the official installer** (`curl -fsSL https://claude.ai/install.sh | bash` —
Embassy attests the in-home launcher layout; Homebrew installs live outside
your home directory and fail `CLAUDE_EXECUTABLE_OUTSIDE_HOME` by design) and
**a managed Codex App Server standalone install** (created by the ChatGPT
desktop app, or by the official installer `curl -fsSL
https://chatgpt.com/codex/install.sh | sh` followed by `codex app-server
daemon start` — the daemon alone does not provision the layout). Without
either, `embassy
serve` currently refuses to boot — v1.8 relaxes both to per-provider
degradation. pnpm users: pin the version (`pnpm install -g
agent-embassy@latest` can resolve stale metadata; prefer an explicit
version) and ensure `PNPM_HOME/bin` is on PATH in non-interactive shells.

```bash
embassy serve
```

Or from source: `git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`.

Embassy is built for one person, one macOS account, and agents you already trust to run as that user. It is an unofficial community project and is not affiliated with or endorsed by Anthropic or OpenAI.

## Quickstart

**Requirements:** macOS and Node.js 20+. Claude routes require peer protocol 1; Codex routes require Desktop configured to use its managed standalone App Server. DeepSeek is optional and launches from `DSH_HOME` (default `~/.dsh`) through the checkout's `demo:acp` script; Grok Build is optional and launches the release-pinned ACP package. The release-owned [support matrix](support/provider-support-matrix.json) records the exact artifacts and capabilities tested for all four providers; it is release evidence, never a runtime allowlist:

```bash
~/.codex/packages/standalone/current/codex app-server daemon start
/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT
```

The first command starts the managed daemon if it is not already running (`restart` and `stop` also exist); the second launches the ChatGPT desktop app pointed at it. `CODEX_APP_SERVER_USE_LOCAL_DAEMON` is not documented by OpenAI; it is observed to work with this Desktop build and may change. Run the daemon command from a normal terminal, never from inside an agent session: Codex tasks inherit the daemon's environment, so a daemon started inside a Claude Code session leaks that session's identity into every task and registration fails closed with `CALLER_IDENTITY_CONFLICT` — fix it from a normal terminal with `codex app-server daemon restart`. The Claude session you select as a destination needs [`crossSessionInbound`](docs/CONFIGURATION.md) enabled — that is Claude Code's own setting, configured in Claude Code, not in Embassy.

Desktop attaches to the managed standalone App Server when it launches. If the daemon restarts while Desktop is already open, waiting alone does not reconnect that app process: fully quit Desktop, rerun `/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT`, and reopen the exact task.

Runtime delivery is best effort. Version and build strings are unverified metadata and never grant or withhold routing authority. Consent plus exact owned route/session identity authorizes an attempt; the current connector, route state, and correlated operation determine its honest result. Unsupported or changed interfaces therefore fail with provider-local safe codes instead of an online compatibility tier. Embassy still validates the trust boundary: exact owned executable and state paths, endpoint generations, strict consumed protocol fields, Claude peer protocol 1, bounded queues, and no replay after an ambiguous write.

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

`status` lists `availablePeers` — the live Claude sessions you can select. If
that list is empty, start a Claude Code session and run
`embassy refresh-dashboard`, which re-runs Claude discovery; the next `status`
should show it.

### 2. Register the Codex task

Ask your Codex agent to run this as a shell step in its current turn — the command must run inside the task so it inherits the task's identity:

```bash
embassy register-codex --alias codex-reviewer@this-mac
```

You should see `"accepted":true`. The `codex-` prefix is required for Claude discovery. To retire the task later, run `embassy unregister-codex --alias codex-reviewer@this-mac` from inside that same task.

Managed App Server generation changes and `embassy serve` restarts both use exact-task reactivation. A fresh initialize negotiates the connection; `thread/loaded/list` must find the byte-identical task exactly once before Embassy re-anchors the alias on that exact generation. A normal broker restart therefore needs no manual registration. A missing or duplicate exact task, changed generation, or failed negotiation leaves the route stale with a safe code; once that task is observable, rerun `embassy register-codex --alias codex-reviewer@this-mac` from the exact task without unregistering first. Embassy never retargets by alias or replays an ambiguously written body.

### 3. Select a Claude destination

Pick one name from `availablePeers`:

```bash
embassy select-claude --alias advisor@this-mac
```

Run this from the operator terminal, or from inside the Codex task — either works, because `select-claude` uses an inherited Codex identity when one is present and resolves the sole registered task when one is not. `embassy select-claude --session <uuid>` selects the same session by its native UUID.

You should see `"accepted":true`. Registration and selection together form a pair — this Claude session and this Codex task can now exchange messages through Embassy.

To connect any two routes from different providers, name both ends explicitly with `embassy pair --from <alias> --to <alias>`; many edges can coexist. The command must run under an inherited endpoint identity that belongs to the requested edge. The live dashboard offers the same bounded, confirmed operation to the local operator.

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

`send-to-codex` is the CLI form of that same direction, for a Claude session that prefers an explicit command. It takes the same flags and reads the body from stdin, and it must run inside the Claude session so it inherits that session's reply identity:

```bash
embassy send-to-codex \
  --from advisor@this-mac \
  --to codex-reviewer@this-mac \
  --expects-reply <<'MSG'
Summarize the migration risks you found.
MSG
```

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
its reserved framing tags in the untrusted body before provider delivery;
arbitrary same-user code and all message text remain untrusted input.

### See it live

`embassy dashboard --live` opens a five-tab streaming view in the browser
(overview, deliveries, routes, activity, diagnostics) at
`http://127.0.0.1:41961/` by default. To choose another stable port for that
invocation, run `embassy dashboard --live --port <n>` with an integer from 1024
through 65535. Up to four concurrent live views — across windows, tabs, or
browsers — can use that URL while the foreground companion runs; a fifth stream
is refused until one closes. If the port is occupied, startup fails explicitly,
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

Embassy publishes each registered Codex task into Claude Code's live-session registry as its own `codex-*` peer. Claude sessions discover those tasks through `ListAgents`; Codex uses its managed App Server. DeepSeek and Grok Build are boot-registered ACP routes whose owned subprocess and one route-local session start lazily on first dispatch.

A pair is one explicit permission edge between two named routes from different providers, bounded at 128 edges by default. Every edge is created explicitly with generic `pair --from/--to`; `select-claude` remains the one-Codex-task shorthand for a Claude↔Codex edge. Nothing is implied. Without an edge, a sender settles terminally as `SENDER_NOT_PAIRED`. `embassy serve --inbound open` is the explicit opt-out for supported native inbound senders.

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
| `refresh-dashboard` | operator | Re-run Claude session discovery and regenerate both static dashboard files |
| `dashboard --live [--lang en\|zh-CN] [--port <n>]` | operator | Start the live dashboard companion with bounded route-consent actions; requires a running `embassy serve` |
| `delivery-status` | either provider | Read one delivery tracker with `embassy delivery-status --token dlv_<token>` |
| `wait-delivery` | either provider | Wait for that tracker to settle, up to the delivery deadline |
| `untrack` | either provider | Close one active progress watch: `embassy untrack --conversation conv_<token>` |
| `register-codex` / `unregister-codex` | Codex task | Advertise or retire that exact task; both take `--alias <codex-alias>`, and `embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac` hands the registration to a different task |
| `pair` / `unpair` | endpoint participant | Add or remove one cross-provider edge by naming both ends: `embassy pair --from advisor@this-mac --to grok-main@this-mac`; the inherited caller must belong to the edge |
| `select-claude` / `unselect-claude` | operator or Codex task | One-task shorthand for `pair`/`unpair`, taking `--alias <name@host>` or `--session <uuid>`: resolves the Codex end only when it is unambiguous (inherited or sole registered task), otherwise fails closed |
| `send-to-claude` | registered Codex task | Send one bounded message to a paired Claude session: `--from <codex-alias> --to <claude-alias>`, body on stdin, optional `--expects-reply` and `--track [--idle-minutes <n>]` |
| `send-to-codex` | Claude session | Same flags and stdin body, using the inherited native reply identity |
| `reply` | conversation-token holder | Continue an active conversation with the full token returned to the initiator or delivered in the recipient's broker-owned reply hint: `--conversation conv_<token> --alias <your-alias>`, body on stdin, optional `--track [--idle-minutes <n>]` |

`--track` opens a progress watch over the conversation; `--idle-minutes <n>`
sets the idle interval for bounded liveness nudges (1–1440, default 5, rejected
without `--track`). If the watch ultimately times out, Embassy records it only
in watch history and emits no runtime stall alert. Close a watch with `untrack`,
or by replying with a leading `DONE:`. See [Delivery](docs/DELIVERY.md).

## Safety in one minute

- **Local broker, stable loopback dashboard.** `embassy serve` listens on private Unix-domain sockets and makes no provider API call. The opt-in `embassy dashboard --live` companion is a separate process and the only listener Embassy can create, bound to exact `127.0.0.1` on stable port `41961` by default (or the per-invocation `--port <n>`). It is deliberately unauthenticated local HTTP for a trusted single-user machine; Host, Origin, and sentinel checks constrain browser-origin requests but do not authenticate local processes or OS users.
- **Same-UID containment, not authentication.** Caller identity is inherited from the local process environment. Route ownership and generation checks reduce mistakes, but are not a defense against code already running as your OS user.
- **Compatibility is tested offline; runtime is best effort.** The release-owned support matrix records exact tested artifacts, protocols, capabilities, stop fidelity, limitations, and test dates. Runtime never imports that matrix and never turns a version fact into authority. It validates exact owned boundaries and protocol facts, attempts the current operation, and reports provider-local health, route staleness, and safe codes without replaying uncertainty.
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
| [Architecture](docs/GATEWAY-ARCHITECTURE.md) | The full design: topology, adapters, control plane, threat model, and the paired-consent inbound model |
| [Delivery](docs/DELIVERY.md) | Delivery semantics, tokens, settlement states, and retry rules |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, compatibility contract, and addressing rules |
| [Dashboard](docs/DASHBOARD.md) | Static and live dashboard setup, security model, and mutation actions |
| [Security policy](SECURITY.md) | How to report a vulnerability, and the boundary in depth |
| [Contributing](CONTRIBUTING.md) | Where changes go, and how to run the deterministic suite |
| [Changelog](CHANGELOG.md) | What each release contains |
| [Agent skill](skills/embassy-peer/SKILL.md) | The workflow an agent follows to operate Embassy |

## License

[MIT](LICENSE)
