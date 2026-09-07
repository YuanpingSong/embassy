<h1><img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/site/assets/mark.svg" alt="" width="32" height="32" align="absmiddle"> Embassy</h1>

Embassy lets live Claude Code sessions and Codex CLI agents message one another
by name, on one Mac or across user-owned Macs reached through SSH. The broker
wakes the receiving agent through its native interface; agents do not poll.
Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex all use the same
command and receipt model.

<p align="center">
  <a href="https://yuanpingsong.github.io/embassy/">Site</a> ·
  <a href="https://www.npmjs.com/package/agent-embassy">npm</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/YuanpingSong/embassy/releases/latest">Latest release</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-embassy"><img src="https://img.shields.io/npm/v/agent-embassy" alt="npm version"></a>
  <a href="https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml"><img src="https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/agent-embassy" alt="Node.js 22+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/agent-embassy" alt="MIT license"></a>
</p>

![Real Claude Code and Codex CLI messaging through Embassy](https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/demo.gif)

If Embassy is useful to you, star the repository: GitHub notifies watchers
about new releases, and the release notes are where changes are explained.

## What it is

The core is deliberately small: one private ledger, one delivery coordinator,
and three write adapters (Claude socket, Codex App Server operation, and SSH
handoff). Aliases are lookup names. Opaque endpoint IDs are the routing
identity, so a rename or replacement never silently retargets queued work.

Codex agents are discovered automatically from the running Codex daemon (the
20 most recent unarchived root agents; sub-agents are never endpoints). Claude
sessions are recorded by exact native identity when they send. No helper or
native advertisement process is installed. Every message returns a receipt;
the receipt proves transport, not comprehension.

## Requirements

- macOS and Node.js 22 or newer.
- Claude Code installed for the Claude sessions you use.
- To receive in Codex, its managed standalone installation with the App Server
  daemon already running under the same macOS login. Embassy does not install,
  start or update that daemon; merely having a `codex` executable on PATH is
  insufficient.
- Key-based, non-interactive SSH between configured machines when federating.

## Quick start

1. Install and start the broker:

   ```sh
   npm install -g agent-embassy
   embassy service install
   embassy health
   ```

2. Give your agents the Embassy skill. This copies the packaged `embassy-peer`
   skill into `~/.claude/skills` and `~/.codex/skills`; Claude Code picks it up
   as `/embassy-peer`, Codex as `$embassy-peer`:

   ```sh
   embassy skills install
   ```

3. See who is there:

   ```sh
   embassy tui
   ```

4. Message an agent from inside a Claude Code or Codex session. The
   sender is inferred from the calling session; `send` takes exactly one of
   `--to` or `--conversation` and has no `--from`:

   ```sh
   printf '%s\n' 'Please review the change and reply' |
     embassy send --to codex-reviewer@studio
   ```

5. Reply with the exact command in the received hint. Ordinary Codex final
   output is not forwarded automatically, and `conv_example` is not a usable
   reference:

   ```sh
   printf '%s\n' 'Review complete.' |
     embassy send --conversation conv_example
   ```

`@studio` is the host name from `nodes.json`; first single-machine boot
creates one from the short hostname. See
[Configuration](docs/CONFIGURATION.md#state-and-node-inventory).

## Status

Proven today: the offline suite (fake Claude sockets, fake App Server
transports, fake SSH processes) runs on every change on macOS and Ubuntu; each
release is drilled live on two Macs, including Codex discovery, dormant wake
over SSH, steering, retirement and broker restart. Bounded by design: `health`
and `check` prove the broker and are not a provider readiness proof, since
neither shows that any agent can answer; a receipt proves
transport, not comprehension; ordinary Codex delivery waits for an idle
observation, and a competing client can start a turn in the gap, so the race
is undetectable on the wire; SSH is the whole trust boundary between machines.

## How it works, briefly

**Discovery.** `embassy tui` and `embassy status` show every endpoint with its
state, queue depth and each local route's last native operation. `status
--json` prints one closed line, `{"ok":true,"command":"status","result":{...}}`,
so route rows are at `.result.routes`. `embassy refresh` runs authorized live
discovery. `embassy register-codex` is the fallback for a harness without
native daemon integration.

**Conversations.** A reply hint carries an identity-bound conversation
reference. Conversation references are identity-bound, are not aliases, and
may survive a broker restart while their retained ledger row and both exact
endpoints remain valid. They stop resolving after retirement, replacement,
expiry, eviction, or a state reset.

**Delivery.** One native wake can carry a bounded batch. The durable phases
are queued, reserved, armed, accepted and terminal; an uncertain armed or
accepted write is never replayed. An exact leading `STEER:` from Claude to
Codex targets the active accepted Codex operation at its next safe
tool-call boundary and never interrupts a generation; the kill switch is
`EMBASSY_STEERING_ENABLED=0`. Inspect one delivery with
`embassy delivery-status --token dlv_example` or block on it with
`embassy wait-delivery --token dlv_example`. Contract:
[Delivery](docs/DELIVERY.md).

**Other Macs.** List peers in `nodes.json`; the broker reaches each over
`/usr/bin/ssh <node> embassy peer-stdio`. The plain same-user SSH login is the
trust boundary. `status` performs no provider or network I/O: it shows the
last observed catalog rows, retains the last rows when a later refresh fails,
and labels that node `PEER_TUNNEL_UNAVAILABLE`. Named and exact sends still
ask the owner directly; the TUI shows one pane per host. Setup:
[Configuration](docs/CONFIGURATION.md#ssh-federation).

**The broker.** `embassy service install` runs a per-user launchd agent with a
crash-only keepalive: a verified `SIGABRT` crash relaunches it, while a clean
exit, `SIGTERM` or `kill -9` leaves it stopped, so inspect
`embassy service status` and reinstall deliberately. `embassy serve` is the foreground
alternative. `embassy check` is a broker-only loopback. Retire one endpoint
with `embassy retire --alias` or `--endpoint`. Commands:
[Operations](docs/OPERATIONS.md).

## Safety

- One private Unix socket and mode-0600 state inside a mode-0700 directory; no
  TCP or HTTP listener.
- Native task/session IDs, socket paths, credentials, transcripts, and raw
  provider frames never appear in public output.
- Every native write is authorized against the exact current endpoint after
  preparation; names are never silently resolved again during an attempt.
- SSH is launched directly without a local shell, in batch mode with
  forwarding disabled.
- Embassy never changes a Codex approval or sandbox policy and never answers
  an approval.

Details: [Security](SECURITY.md) · [Configuration](docs/CONFIGURATION.md) ·
[Operations](docs/OPERATIONS.md) · [Delivery](docs/DELIVERY.md) ·
[Architecture](docs/GATEWAY-ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## Development

```sh
npm ci
TMPDIR=/tmp npm run check
```

Routine tests use test-owned directories and fake providers; no routine test
connects a live provider or SSH host.

## License

MIT
