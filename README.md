<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — a local gateway for bidirectional messaging between Claude Code sessions and Codex desktop tasks" width="720">
</p>

# Embassy

**A local embassy for your AI agents.**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

Your [Claude Code](https://code.claude.com) sessions, [Codex](https://chatgpt.com/codex) desktop tasks, and shell harnesses do not share one routing surface. Embassy is a small local broker that gives all three providers named routes and a provenance envelope on every message — no plugins, no API keys handled by Embassy, and no cloud relay.

```bash
npm install -g agent-embassy
```

Prerequisites, stated honestly: Claude routes require a live same-user Claude
Code session with peer protocol 1. Embassy derives the external registry and
peer-socket roots from the current OS user; it does not inspect Claude's
launcher or configuration. Codex routes require **a managed Codex App Server
standalone install** (created by the ChatGPT desktop app, or by the official
installer `curl -fsSL
https://chatgpt.com/codex/install.sh | sh` followed by `codex app-server
daemon start` — the daemon alone does not provision the layout). A missing
Claude registry degrades only Claude while the broker and other providers stay
available. pnpm users: pin the version (`pnpm install -g
agent-embassy@latest` can resolve stale metadata; prefer an explicit
version) and ensure `PNPM_HOME/bin` is on PATH in non-interactive shells.

```bash
embassy serve
```

Or from source: `git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`.

Embassy is built for one person, one macOS account, and agents you already trust to run as that user. It is an unofficial community project and is not affiliated with or endorsed by Anthropic or OpenAI.

## Quickstart

**Requirements:** macOS and Node.js 20+. Claude routes require peer protocol 1; Codex routes use Codex CLI tasks with the managed standalone App Server. A shell peer needs only the local CLI and its one-time token:

```bash
codex app-server daemon start
```

Run the managed daemon from a normal terminal and use Codex CLI as the supported task host. Desktop's `CODEX_APP_SERVER_USE_LOCAL_DAEMON` attachment is broken in Desktop 26.820 and later ([openai/codex#41112](https://github.com/openai/codex/issues/41112)), so it is not a supported setup. If `CALLER_IDENTITY_CONFLICT` reports both identities, strip only the unwanted inherited identity at the call site: use `env -u CLAUDE_CODE_MESSAGING_SOCKET embassy …` for a Codex-side call, or `env -u CODEX_THREAD_ID embassy …` for a Claude-side call. The Claude destination needs [`crossSessionInbound`](docs/CONFIGURATION.md) enabled.

Runtime delivery is best effort. Version and build strings are unverified metadata and never grant or withhold routing authority. The OS boundary plus exact logical route/session identity authorizes an attempt; the current per-operation transport and correlated evidence determine its honest result. Unsupported or changed interfaces therefore fail with provider-local safe codes instead of an online compatibility tier. Embassy still validates the trust boundary: exact owned or executed artifacts and state paths, generations of artifacts it actually uses, strict consumed protocol fields, Claude peer protocol 1, bounded queues, and no replay after an ambiguous write.

> **Known limitation:** Embassy can reach Codex tasks only while Desktop uses the managed standalone App Server. In that mode, tasks currently cannot connect to Desktop's built-in in-app browser (`@Browser` loads but does not attach). Switching Desktop back to its default private App Server restores the built-in browser immediately — but makes those tasks unreachable by Embassy. No other capability regressions have been identified, though this was not an exhaustive parity test.

### 1. Start Embassy

Install the broker as a launchd agent under the same OS account as Claude Code and Codex, so it starts at login and restarts after a crash:

```bash
embassy service install
```

The install waits up to 10 seconds for the agent to answer a health check and exits non-zero if it never does. A Mac with no logged-in user — an SSH-only federation peer, say — has no `gui` domain and cannot run a launchd agent at all: run `embassy serve` under your own supervisor there. Prefer a foreground process you start and stop by hand? Run `embassy serve` in its own terminal and leave it running — skip `service install` in that case.

In another terminal:

```bash
embassy health
embassy status
```

`status` lists `availablePeers` — the live Claude sessions you can address by name. If
that list is empty, start a Claude Code session and run
`embassy refresh`, which rescans for Claude sessions; the next `status`
should show it.

Every alias below ends in `@your-host`: replace `your-host` with this machine's host. The broker prints it as `hostId` on its ready line — in your terminal under `embassy serve`, or in `~/Library/Logs/agent-embassy/broker.log` under the launchd agent — and name an alias for the wrong host and the CLI tells you which one this machine uses. Federation across machines needs a `nodes.json`; without one Embassy writes that file itself on first start, naming this machine by its own hostname (see [Configuration](docs/CONFIGURATION.md)).

### 2. Register the Codex task

Ask your Codex agent to run this as a shell step in its current turn — the command must run inside the task so it inherits the task's identity:

```bash
embassy register-codex --alias codex-reviewer@your-host
```

You should see `"accepted":true`. The `codex-` prefix is required for Claude discovery. To retire the task later, run `embassy unregister-codex --alias codex-reviewer@your-host` from inside that same task.

Registration records the exact inherited task identity and performs no App Server I/O. Every delivery opens a fresh attested local transport, initializes it, resumes that exact task with history excluded, and authorizes the body write once. App Server and Desktop restarts therefore do not require re-registration or re-anchoring; a current unavailable or unobservable task keeps the logical route while the attempt reports an exact safe code. Embassy never retargets by alias or replays an ambiguously written body.

### Optional: register a universal shell peer

A local shell harness can join as a `peer-*` route without a plugin, stable shell, daemon, PID binding, token file, or Keychain entry:

When native Codex inbound dispatch is unavailable, this shell-peer mailbox is the supported fallback channel: register once, keep its token only in agent memory, and receive with bounded `await` calls.

```bash
embassy register-peer --alias peer-reviewer@your-host
```

Registration prints the `peer_` token exactly once. Keep it in the agent's context and provide it on the first stdin line of every authenticated peer command; when a command also carries a message body, the remaining stdin bytes are the body. Never put the token in argv. For example, wait for inbound mail:

```bash
embassy await --alias peer-reviewer@your-host --token-stdin <<'TOKEN'
peer_<32-character-token>
TOKEN
```

`await` performs bounded 30-second long polls until mail arrives or the caller stops it. Each registration may have one waiter and the broker permits 16 in total. Embassy writes the complete framed message to stdout, waits for stdout to flush, and only then acknowledges its private receipt. A missing receipt is `unconfirmed`; uncertainty after write authorization is `ambiguous`, and neither is replayed after restart. `register-peer --emit-env` is an optional convenience for harnesses that really do retain one stable shell; stdin is the universal path.

### 3. Send a message

From the registered Codex task, send via stdin. Name the Claude session by the
name `status` shows for it — there is no step between discovering a session and
messaging it, because a session's route installs on its first use:

```bash
embassy send \
  --from codex-reviewer@your-host \
  --to advisor@your-host \
  --expects-reply <<'MSG'
Please review the current approach and identify the main risk.
MSG
```

You should see a `conv_` conversation token and a `dlv_` delivery token. If the
name is not recognized, run `embassy refresh` and read the current name from
`embassy status`; `embassy send --to <uuid>` addresses the same session by its
native UUID. If two live sessions currently share one name, Embassy refuses the
send with `PEER_ALIAS_COLLISION` rather than guessing — rename one and retry. Because this send requested a reply, Claude's response is automatically routed back to the Codex task. In the other direction, a compatible Claude session uses its native `ListAgents` and `SendMessage` tools to contact `codex-reviewer` — no Embassy command needed.

The same command runs in the other direction from a Claude session and inherits that session's reply identity:

```bash
embassy send \
  --from advisor@your-host \
  --to codex-reviewer@your-host \
  --expects-reply <<'MSG'
Summarize the migration risks you found.
MSG
```

### 4. Follow up

Either participant can continue the conversation by addressing the token
instead of a name. The initiating CLI receives the full `conv_` token in its
accepted result; the recipient gets the same token and an exact command in the
broker-owned message marker:

```bash
embassy send \
  --conversation conv_<token> \
  --from codex-reviewer@your-host <<'MSG'
Please expand on the migration risk.
MSG
```

`--to` and `--conversation` are alternatives: the first addresses a route by
name, the second an open conversation you already belong to. `embassy reply
--conversation <token> --alias <your-alias>` is a deprecated spelling of the
same request, kept for one release because older delivered envelopes still
show it.

Every routed body reaches either product inside one broker-owned
`<cross-session-message>` textual frame. It identifies the verified sender
alias and begins with an `<embassy-reply-hint>` containing the full conversation
token, the recipient's exact alias, and the corresponding
`embassy send --conversation` command. Use only that delivered full token and alias; never guess one from a
suffix or substitute the sender's alias. The CLI still rechecks the caller,
conversation membership, and current route policy, so the hint is
not a permission bypass.

The frame is a clear provenance marker, not a cryptographic signature or a
claim that the body is trustworthy. Embassy neutralizes nested occurrences of
its reserved framing tags in the untrusted body before provider delivery;
arbitrary same-user code and all message text remain untrusted input.

## How it works

```text
 Claude Code sessions                         Codex desktop task
 (native ListAgents /                         (native App Server,
  SendMessage tools)                           existing task policy)
        │                                             │
        ▼                                             ▼
  ┌──────────────────── Embassy ─────────────────────────────┐
  │ explicit routes │ Codex busy queue │ receipts │ status    │
  └───────────────────────────────────────────────────────────┘
```

Embassy publishes each registered Codex task into Claude Code's live-session registry as its own `codex-*` peer. Claude sessions discover those tasks through `ListAgents`; Codex uses its managed App Server. Universal shell peers use `peer-*` aliases and a pull mailbox authenticated by an alias plus one-time-minted token.

The permission to message is the OS boundary: the same UID, the same host — or a host you configured in `nodes.json` — and an exact alias. There is no separate grant to create or revoke. A discovered Claude session's route installs on its first use, so the first message to a session is also what registers it; a Codex task is still registered explicitly because Embassy must record its inherited task identity. When a name currently belongs to more than one live session, the send is refused with `PEER_ALIAS_COLLISION` naming that alias rather than delivered to a guess.

Delivery timing is directional. Once routing and pre-write checks pass, every Claude-bound body is written immediately to Claude's native mailbox regardless of its observed busy or idle state. `transport_written` records that mailbox write and is the Claude-bound terminal `delivered` boundary; it does not mean Claude read or consumed the body. Codex-bound ordinary bodies instead queue while the task is busy and start a turn when it goes idle. In the Claude-to-Codex direction only, a body with an exact leading `STEER:` prefix may enter the active turn at the App Server's next tool-call boundary; if that boundary is unavailable, the message returns to the normal queue.

Immediately before the provider write, Embassy gives every routed body one
broker-owned cross-session marker containing the verified sender alias and a
recipient reply hint. The full conversation token travels only in the
initiator's accepted result and the recipient's transient message payload; it
never enters the public snapshot, journal, receipt, or log.

Every settled message produces a receipt. `delivered` means the direction's terminal provider boundary was observed — toward Codex, the App Server accepted the turn; toward Claude, the native mailbox write completed. Neither means the model read or acted on it. `unconfirmed` and `ambiguous` mean the required evidence is missing; they are terminal states and never auto-retried. See [Delivery](docs/DELIVERY.md) for the full semantics.

## The vocabulary

Four embassy terms name real features:

- **Registration and provenance** are the permission model: registration is explicit for Codex tasks, because Embassy must record the inherited task identity; every routed body carries the broker-composed envelope naming its verified sender, and the OS boundary — same UID, same host or a configured node — is the permission itself.
- **The ledger** is the delivery record: a receipt for every settled message, and a status snapshot that includes retained message bodies from the bounded ledger.
- **The pouch** is transit and the archive: bounded bodies, retained under bounded limits, private to your OS account — sealed against other users, not against you.
- **Consulates** are configured Embassy nodes: brokers federate over attach-only SSH and keep destination-owned delivery authority. A peer node can address only what its neighbour published — a Claude session becomes reachable across the link once it has a local route, which its first local send or receipt installs.

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
| `serve` | operator | Start the foreground broker |
| `service install` / `service uninstall` / `service status` | operator | Register the broker as this user's macOS launchd agent, remove it, or report what launchd knows about it |
| `health` / `status` | operator | Check liveness and inspect the sanitized snapshot |
| `refresh` | operator | Rescan for Claude sessions |
| `delivery-status` | either provider | Read one delivery tracker with `embassy delivery-status --token dlv_<token>` |
| `wait-delivery` | either provider | Wait for that tracker to settle, up to the delivery deadline |
| `register-codex` / `unregister-codex` | Codex task | Advertise or retire that exact task; both take `--alias <codex-alias>`, and `embassy register-codex --alias codex-successor@your-host --succeeds codex-reviewer@your-host` hands the registration to a different task |
| `register-peer` / `unregister-peer` | shell harness | Register or retire a `peer-*` route; registration emits its raw token once, while authenticated calls use `--token-stdin` (or the optional stable-shell env form) |
| `await` | registered shell peer | Long-poll the peer mailbox in bounded 30-second iterations; one waiter per route, 16 globally, with acknowledgement only after stdout flush |
| `send` | registered Codex task, Claude session, or shell peer | Send one bounded stdin message: `--from <alias>` with either `--to <alias>` (optionally `--expects-reply`) or `--conversation conv_<token>` to continue a conversation you belong to; direction follows the inherited principal — who is sending — not the route table, and a discovered Claude session's route installs on its first use |
| `reply` | conversation-token holder | Deprecated alias for `send --conversation <token> --from <your-alias>`, spelled `--conversation conv_<token> --alias <your-alias>`; it builds the identical request and is kept for one release because delivered reply hints still name it |

Version 2.0 accepts only fresh private state. Follow the
[reset-only state runbook](docs/CONFIGURATION.md#private-state-reset) before
starting it over an older installation.

## Safety in one minute

- **Local broker, no listener.** `embassy serve` listens on private Unix-domain sockets and makes no provider API call. Embassy binds no TCP port and serves no HTTP.
- **Same-UID containment, not authentication.** Caller identity is inherited from the local process environment, and the same-UID private control socket is what a client must reach to talk to the broker at all — that boundary is the permission to message, not a separate grant Embassy hands out. Route ownership and per-operation artifact checks reduce mistakes, but are not a defense against code already running as your OS user.
- **Runtime is best effort.** It never turns a version fact into authority. It validates exact owned boundaries and protocol facts, attempts the current operation, and reports provider-local health and safe codes without replaying uncertainty.
- **Native permissions stay native.** Embassy sends no Codex approval or sandbox overrides and answers no approval request. `crossSessionInbound` remains Claude's own control; Embassy cannot override it.
- **Provenance is marked, not authenticated.** Routed bodies carry one broker-owned cross-session marker with the verified sender alias; it distinguishes the transport path for the receiving model but cannot make untrusted text safe or authenticate against code already running as your OS user.
- **Bodies and delivery status stored, bounded, and yours.** Message bodies and their opaque delivery token/status persist in the broker's private mode-0600 v5 state under bounded retention; queued or reserved work may resume once after restart, while armed or provider-accepted work is never replayed. A delivery token never enters a public snapshot, normal log, or provider receipt. Raw provider frames stay memory-only. `embassy status` shows retained bodies; treat its output as sensitive as the messages themselves.

See [SECURITY.md](SECURITY.md) for the full boundary and vulnerability-reporting process.

## What Embassy is not

- **Not an orchestrator.** It does not spawn agents or manage their work. Codex-bound ordinary messages start one turn apiece as the task becomes idle; Claude-bound messages enter Claude's mailbox without waiting for idle.
- **Not a hosted service.** Personal, same-machine, same-OS-account software.
- **Not a permission bypass — but it is a new path.** Neither agent gains a tool it did not already have, and Embassy grants, relaxes, and answers nothing. It does, however, connect two products that previously could not exchange text at all. That path is the product; treat it with the respect you would give any new input channel.
- **Not official.** Not affiliated with or endorsed by Anthropic or OpenAI.

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](docs/GATEWAY-ARCHITECTURE.md) | The full design: topology, adapters, control plane, threat model, and the OS-boundary permission model |
| [Delivery](docs/DELIVERY.md) | Delivery semantics, tokens, settlement states, and retry rules |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, provider contracts, and addressing rules |
| [Security policy](SECURITY.md) | How to report a vulnerability, and the boundary in depth |
| [Contributing](CONTRIBUTING.md) | Where changes go, and how to run the deterministic suite |
| [Changelog](CHANGELOG.md) | What each release contains |
| [Agent skill](skills/embassy-peer/SKILL.md) | The workflow an agent follows to operate Embassy |

## License

[MIT](LICENSE)
