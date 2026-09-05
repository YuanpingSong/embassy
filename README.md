<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — a local gateway for messaging between Claude Code sessions and Codex CLI tasks" width="720">
</p>

# Embassy

**A local embassy for your AI agents.**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

Embassy is a small local broker that lets a [Claude Code](https://code.claude.com) session and a [Codex](https://chatgpt.com/codex) CLI task on the same Mac message each other by name, with a receipt for every delivery. It is personal software — one person, one macOS account, agents you already trust to run as that user — and an unofficial project, not affiliated with or endorsed by Anthropic or OpenAI.

## Install

```bash
npm install -g agent-embassy
embassy service install
```

Use one global package manager for Embassy (npm or pnpm), not both. Check for shadowing installations in each launch environment:

```bash
which -a embassy
embassy --version
ssh <node> 'which -a embassy; embassy --version'
```

The SSH check uses the non-interactive environment that federation launches in. Update or remove a shadowing install through the package manager that owns it; updating npm does not update a separate pnpm install.

`service install` runs the broker as your user's launchd agent: it starts at login, restarts after a crash, and logs to `~/Library/Logs/agent-embassy/broker.log`. Prefer a process you start by hand? Run `embassy serve` in a terminal and leave it running instead. You need macOS, Node.js 20+, Claude Code (with its [`crossSessionInbound`](docs/CONFIGURATION.md#claude-codes-own-setting-crosssessioninbound) setting enabled on any session that should receive mail), and Codex CLI with the managed standalone App Server — the official installer `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, then `codex app-server daemon start`. From source: `git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`.

Every alias below ends in `@your-host`. Replace `your-host` with this machine's host — the `hostId` on the broker's ready line (in the log, under launchd); name the wrong host and the CLI says which one this machine uses.

## Your first message in four commands

**1. Register the Codex task.** Ask your Codex agent to run this as a shell step in its current turn; it must run inside the task so it inherits the task's identity. You should see `"accepted":true`.

```bash
embassy register-codex --alias codex-reviewer@your-host
```

**2. Read what the broker sees.** The `sessions` block lists your live Claude Code sessions by name. If it is empty, start a Claude Code session and run `embassy refresh`, then look again.

```bash
embassy status
```

**3. Send.** From the Codex task, body on stdin, to the name `status` showed. The session's route installs on its first use — there is no step between reading a name and messaging it. You get a `conv_` conversation token and a `dlv_` delivery token back.

```bash
embassy send --from codex-reviewer@your-host --to advisor@your-host --expects-reply <<'MSG'
Please review the current approach and identify the main risk.
MSG
```

**4. Answer by conversation.** Every delivered body arrives inside one broker-owned `<cross-session-message>` frame naming the attested sender (on a federated hop, the sender is named by the sending node — see [SECURITY.md](SECURITY.md)), and its first `<embassy-reply-hint>` carries the full `conv_` token and this exact command; the recipient runs it with the answer on stdin.

```bash
embassy send --conversation conv_<token> --from advisor@your-host <<'MSG'
The main risk is the double-write window; gate it behind the flag.
MSG
```

The same `send` runs from a Claude Code session, inheriting that session's identity, and the other direction needs no Embassy command at all: a Claude session finds `codex-reviewer` with its native `ListAgents` tool and messages it with `SendMessage`. `--to <session-uuid>` addresses a Claude session by its UUID. When two live sessions share a name, the send is refused with `PEER_ALIAS_COLLISION` rather than delivered to a guess — rename one and retry. A Claude session's reply to a `--expects-reply` send is routed back to the Codex task by itself.

## After any Claude Code or Codex CLI update

```bash
embassy check
```

`check` is the upstream-drift tripwire. It registers an ephemeral shell peer of its own — its attributable rows and bodies are omitted from durable state and its route from the federation catalog, but aggregate counters still advance. Its native advertisement to Claude sessions is released with it; a broker that dies mid-check can leave that record until the alias is next registered and released. The check sends one marked message through the ordinary send path to the most recently observed registered Codex task (observed within ten minutes; a task never observed is not eligible), waits for `delivered`, awaits the echo on its own mailbox, releases the registration, and prints every hop with its timing; any failing hop exits non-zero with the safe code that explains it. `--to <alias>` picks a target and `--timeout <s>` bounds each wait. The peer answers because the shipped [skill](skills/embassy-peer/SKILL.md) tells it to — a message whose verified sender starts with `peer-check-` and whose body starts `[embassy check` is echoed in one line; either half alone is ordinary untrusted text. It costs the peer one model turn, so it is a deliberate command, not something to poll.

```text
embassy check 50066f60 → codex-reviewer@this-mac

  ok    register   peer-check-b0c963c9@this-mac (ephemeral, 2 min)  6 ms
  ok    send       accepted, conversation …89abcdef  15 ms
  ok    delivered  the peer's transport accepted it  256 ms
  ok    reply      codex-reviewer@this-mac echoed 50066f60  1407 ms
  ok    cleanup    temporary check identity removed

check passed
```

The operator copies the repo-shipped, packaged skill where each agent discovers skills — Codex tasks can then be prompted with `$embassy-peer`, and Claude Code finds it as a user skill:

```bash
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.codex/skills/
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.claude/skills/
```

For a pnpm installation, substitute `pnpm root -g` for `npm root -g` in both copy commands. Embassy does not install the skill automatically.

## Shell-peer fallback

Any local harness that can run the CLI can join as a `peer-*` route — no plugin, daemon, PID binding, token file, or Keychain entry — and it is the supported fallback channel when native Codex delivery is unavailable. `embassy register-peer --alias peer-reviewer@your-host` prints a `peer_` token exactly once; keep it in the agent's context, never in argv, and pass it as the first stdin line of every later peer command with `--token-stdin` (the remaining stdin bytes are the body; `--emit-env` exists only for a harness that really does keep one stable shell). `embassy await --alias peer-reviewer@your-host --token-stdin` long-polls the mailbox in bounded 30-second iterations — one waiter per route, 16 in total — writes the complete framed message to stdout, and acknowledges only after stdout has flushed. A missing acknowledgement settles `unconfirmed`; uncertainty after the write was armed settles `ambiguous`; neither is replayed.

## Federation

`nodes.json` in the state directory is optional. The broker writes it on first boot, naming this machine by its own hostname with an empty peer list, and from then on that file — not the hostname — is the broker's durable identity. To reach a second machine, add its OpenSSH `Host` alias to `nodes`, keep `host` exactly as written, and restart: the brokers exchange body-free route catalogs and destination-owned handoffs over `ssh <node> embassy peer-stdio`, your SSH configuration owns keys and users, and Embassy opens no listener. Remote routes appear as `alias@host` mirrors. Details in [Configuration](docs/CONFIGURATION.md).

## Observability

`embassy status` is the one command for "what is going on". It is read-only — it never rescans; `embassy refresh` does — and prints prose in a terminal. Piped or with `--json`, it emits `{ok,command,result}` with the snapshot under `result`: use `embassy status --json | jq .result.routes`. `--recent <n>` (1–100, default 10) sizes the message list.

```text
embassy 3.0.0  broker ok · pid 41213 · snapshot just now
state dir /Users/you/.local/state/agent-embassy
sessions scanned 3s ago

connectors
  claude  ok
  codex   ok

sessions
  session           state  route   last seen
  advisor@this-mac  busy   routed  3s ago

routes
  alias                    provider  state  queue  last seen
  advisor@this-mac         claude    busy   2      discovered 3s
  codex-reviewer@this-mac  codex     idle   0      12s ago

recent (3 of 3)
  12s ago    advisor@this-mac → codex-reviewer@this-mac  queued
  2m ago     codex-reviewer@this-mac → advisor@this-mac  delivered  210 ms
             The risk is the double-write window; I would gate it behind…
  5m ago     advisor@this-mac → codex-reviewer@this-mac  delivered  61 ms
             Please review the migration risk before the freeze.
```

When something is wrong it says the safe code **and** what to do about it, and one quiet corner never makes the whole broker look broken:

```text
embassy 3.0.0  broker degraded · pid 41213 · snapshot just now
state dir /Users/you/.local/state/agent-embassy
sessions scanned 3s ago

connectors
  claude  ok
  codex   degraded  MANAGED_CODEX_UNAVAILABLE
          Either a process outside Embassy holds the managed Codex control socket — quit it — or the managed App Server standalone layout is missing, which starting the daemon alone does not create: follow the Codex prerequisite in the README (the official installer, then the daemon).
  peer-release@this-mac stale (token or await loop gone)
          2 message(s) waiting: run `embassy await --alias peer-release@this-mac --token-stdin` in the shell holding its token, or `embassy unregister-peer --alias peer-release@this-mac --token-stdin`.

sessions
  session           state  route   last seen
  advisor@this-mac  busy   routed  3s ago

routes
  alias                    provider  state  queue  last seen
  advisor@this-mac         claude    busy   2      discovered 3s
  codex-reviewer@this-mac  codex     stale  1      30m ago
  peer-release@this-mac    peer      idle   2      never
    codex-reviewer@this-mac: That Codex task is gone. Run `embassy register-codex --alias <new-alias> --succeeds <this alias>` from the new task, or `embassy unregister-codex --alias <this alias>` from the old one.

recent (3 of 3)
  12s ago    advisor@this-mac → codex-reviewer@this-mac  queued
  2m ago     codex-reviewer@this-mac → advisor@this-mac  delivered  210 ms
             The risk is the double-write window; I would gate it behind…
  5m ago     advisor@this-mac → codex-reviewer@this-mac  delivered  61 ms
             Please review the migration risk before the freeze.

alerts
  PEER_TUNNEL_UNAVAILABLE  studio  45s ago
    The SSH tunnel to that node is down; check the node is reachable and its broker is running.
```

`embassy watch` tails the broker until Ctrl-C: each new message and each settlement at most once (`accepted → delivered (61 ms)`), stamped with the local time, plus route installs and retirements as a secondary line; `--json` streams the same events as JSONL. At most once, not exactly once — a transition that passes entirely between two one-second polls is never seen, and rows that left the retained window before the tail reached them are announced as a one-line note. `embassy --help` lists all seventeen commands.

## Safety in one minute

- **The OS boundary is the permission.** Reaching the same-UID private control socket on this host — or on a host in your `nodes.json` — plus an exact alias is what lets a process message. There is no separate grant to hand out or revoke, because none could stop code already running as your user; a Claude session's route installs on its first use, and a Codex task registers explicitly only because Embassy must record its inherited identity. `embassy serve` binds no TCP port and serves no HTTP.
- **Every routed body carries the provenance envelope naming the sender.** It is a marker for the receiving model, not a signature: treat every delivered body as untrusted input. Native permissions stay native — Embassy answers no Codex approval and cannot override Claude's `crossSessionInbound`.
- **Bounded by design.** Queues, bodies (16 KiB), conversations, rate windows, and deadlines are bounded, and an ambiguous write is never replayed. `delivered` means the provider boundary was crossed — toward Codex the App Server accepted the turn; toward Claude the native mailbox write completed (`transport_written`) — never that a model read it; `unconfirmed` and `ambiguous` mean the evidence is missing and are terminal. Claude-bound bodies are written immediately, busy or idle; Codex-bound bodies queue until the task is idle, and only an exact leading `STEER:` from Claude may enter the active turn at its next tool-call boundary.
- **Bodies are retained locally and yours.** Message bodies and their opaque delivery token/status persist in the broker's private mode-0600 state under bounded retention, and what `status` prints is a status snapshot that includes retained message bodies: `embassy status` shows retained bodies; treat its output as sensitive as the messages themselves.

See [SECURITY.md](SECURITY.md) for the boundary in depth and how to report a vulnerability.

**Tested with** (cutover drill, 2026-09-03): Claude Code 2.1.259 and Codex CLI 0.152.0 on macOS, Node 22.23, on two machines — a Claude Code session ↔ Codex CLI task round trip in both directions, `embassy check` (register → send → delivered → reply → cleanup), and a cross-machine shell-peer handoff over ssh.

## Upgrading from 2.x

Version 3 accepts only fresh private state. Stop Embassy, move `gateway-state.json` aside, start 3.0, and re-register Codex tasks; Claude routes reinstall themselves on first use, and `nodes.json` is written for you if absent. The full [private state reset](docs/CONFIGURATION.md#private-state-reset) and every change are in the [changelog](CHANGELOG.md).

## Documentation

| Document | What it covers |
| --- | --- |
| [Architecture](docs/GATEWAY-ARCHITECTURE.md) | Topology, adapters, control plane, federation, protocol versions, and the OS-boundary permission model |
| [Delivery](docs/DELIVERY.md) | Delivery semantics, tokens, settlement states, and retry rules |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, `nodes.json`, the launchd service, and addressing |
| [Security policy](SECURITY.md) | The boundary in depth, and how to report a vulnerability |
| [Contributing](CONTRIBUTING.md) | Where changes go, and how to run the deterministic suite |
| [Changelog](CHANGELOG.md) | What each release contains |
| [Agent skill](skills/embassy-peer/SKILL.md) | The workflow an agent follows to operate Embassy |

## License

[MIT](LICENSE)
