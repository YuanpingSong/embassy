# Embassy

Embassy lets live Claude Code sessions and Codex CLI agents message one another
by name, on one Mac or across user-owned Macs reached through SSH. The broker
wakes the receiving agent through its native interface; agents do not poll.
Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex all use the same
command and receipt model.

![Real Claude Code and Codex CLI messaging through Embassy](https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/demo.gif)

The core is deliberately small: one private ledger, one delivery coordinator,
and three write adapters (Claude socket, Codex App Server operation, and SSH
handoff). Aliases are lookup names. Opaque endpoint IDs are the routing
identity, so a rename or replacement never silently retargets queued work.

## Requirements

- macOS and Node.js 22 or newer.
- Claude Code installed for the Claude sessions you use.
- To receive in Codex, its managed standalone installation with the App Server
  daemon already running under the same macOS login. Embassy discovers the
  20 most recent unarchived root agents automatically, but does not install,
  start or update that daemon; merely having a `codex` executable on PATH is
  insufficient.
- A private `nodes.json` when choosing an explicit host name or federating;
  first single-machine boot creates one from the short hostname.
- Key-based, non-interactive SSH between configured machines when federating.

## Quick start

Four steps take a fresh Mac from nothing to a Claude session messaging a Codex
agent by name.

1. Install and start the broker:

   ```sh
   npm install -g agent-embassy
   embassy service install
   embassy health
   ```

2. Install the packaged Embassy skill where Claude Code and Codex CLI look for
   skills:

   ```sh
   embassy skills install
   ```

   The command installs or updates only `embassy-peer` for both providers;
   Claude Code picks it up as `/embassy-peer`, and Codex as `$embassy-peer`.
   Agents do not install skills themselves.

3. See who is there. Codex agents appear automatically while the Codex daemon
   runs; a Claude session appears once it sends:

   ```sh
   embassy tui
   ```

4. Message an agent from inside a Claude Code or Codex session (the sender is
   inferred from the calling session), and reply with the exact command in the
   received hint:

   ```sh
   printf '%s\n' 'Please review the change and reply' | embassy send --to codex-reviewer@studio
   printf '%s\n' 'Review complete.' | embassy send --conversation conv_example
   ```

The sections below cover each step in detail. `@studio` is the host name from
your `nodes.json`; see [Host name and state directory](#host-name-and-state-directory).

## Install

Install one copy with one package manager and verify what the shell resolves:

```sh
npm install -g agent-embassy
which -a embassy
embassy --version
```

## Start the broker

```sh
embassy service install
embassy health
```

`embassy service install` starts the per-user launchd agent immediately and
arranges login startup; run the same command again to reload broker
configuration, to start a stopped installation, or after replacing or removing
the installation (the service records the absolute installation path). Use
`embassy service uninstall` to stop and unload it. `embassy serve` is the
foreground alternative.

The agent uses launchd's crash-only keepalive policy. A verified `SIGABRT`
crash relaunches it. A clean exit, boot refusal, `SIGTERM`, or deliberate
`kill -9` leaves it stopped; inspect `embassy service status` and run
`embassy service install` deliberately rather than assuming every signal
restarts it.

`health` means the Embassy control socket and ledger respond. It is not a
provider readiness proof: it does not show that any Claude session or Codex
task can receive or answer a message.

### Host name and state directory

Every local alias ends in `@host`, where `host` is the value in `nodes.json`.
On first single-machine boot without that file, Embassy derives a lower-case
name from the short hostname and atomically writes an empty-node inventory; it
never rewrites a present file. Read `host` from that file and use it as every
local `@host` suffix; the examples use `@studio` only because they chose
`host: studio`.

To choose an explicit host name or to federate, create `nodes.json` before
starting the broker. `host` is this machine's name; `nodes` lists directly
reachable Embassy hosts:

```json
{"version":1,"host":"studio","nodes":[]}
```

`nodes.json` lives inside `EMBASSY_STATE_DIR` when set; otherwise in
`$XDG_STATE_HOME/agent-embassy`, or `~/.local/state/agent-embassy` when
`XDG_STATE_HOME` is unset. Create the private state directory first, set it to
mode 0700 and `nodes.json` to mode 0600, and install the service afterwards.
Every client shell must use the same state-directory configuration captured by
the installed service.

## See the agents

```sh
embassy tui       # the daily view
embassy status    # one text snapshot
```

`embassy tui` is the daily view: an Ink-based terminal client (Node 22+) that
shows the local broker and each direct host in `nodes.json`, with endpoints
grouped by state, deliveries newest first, retirements, and action results.
`embassy status` prints the same snapshot once as text.

Codex agents appear automatically. Embassy observes the same-user Codex App
Server daemon and lists its 20 most recent unarchived root agents by their
current public names; dormant agents remain addressable and wake on delivery.
Only head agents are endpoints: sub-agents are never discovered or displayed.
Native task IDs, previews and history never appear in Embassy output. If no
Codex agent appears, check that the Codex daemon is running under this login;
Embassy never starts it.

Claude sessions are discovered and recorded by exact native identity when a
Claude caller sends or when a named Claude target is resolved. No helper or
native advertisement process is installed. To find a Claude session's current
name, run `embassy refresh` (authorized live discovery) followed by
`embassy status --json`, or use the exact current name that session supplies.

For a harness without native daemon integration, registration is the fallback.
Ask the live Codex CLI task to run this through its own shell tool; an ordinary
terminal lacks that task's inherited identity:

```sh
embassy register-codex --alias codex-reviewer@studio
```

The `embassy-peer` skill gives either agent these commands; see
[Quick start](#quick-start) for installing it.

## Message an agent

Ask the live Claude Code session to run `embassy send --to codex-reviewer@studio`
with the message body on stdin, through the agent's shell tool rather than an
unrelated terminal. The sender is inferred from the calling session; `send`
takes exactly one of `--to` or `--conversation` and has no `--from`:

```sh
printf '%s\n' 'Please review the change and reply using the supplied Embassy hint' |
  embassy send --to codex-reviewer@studio
```

A successful send returns `result.deliveryToken` and a conversation reference.
The receipt proves transport, not comprehension: acceptance means the broker
owns the delivery, not that a model read or understood the body.

## Reply

The receiving agent sees a broker hint such as:

```text
<embassy-reply-hint conversation="conv_EXACT_REFERENCE" ...>Reply by running `embassy send --conversation conv_EXACT_REFERENCE` with the reply body on stdin.</embassy-reply-hint>
```

It must execute the exact received command to send the reply. Ordinary Codex
final output is not forwarded automatically, and `conv_example` is not a
usable reference:

```sh
printf '%s\n' 'Review complete.' |
  embassy send --conversation conv_example
```

Conversation references are identity-bound, are not aliases, and may survive a
broker restart while their retained ledger row and both exact endpoints remain
valid. They stop resolving after retirement, replacement, expiry, eviction, or
a state reset.

## Delivery

One native wake can carry a bounded FIFO batch, so a busy recipient catches up
without one wake per queued message. Every message keeps its own source,
destination, conversation, deadline, and receipt. Capacity and expiry remain
visible per message.

The durable write phases are `queued`, `reserved`, `armed`, `accepted`, and
`terminal`. Work known not to have been written may return to the queue. An
uncertain armed or accepted write is never replayed.

Ordinary Codex delivery starts only after an immediate idle observation. A
competing client can start a turn between that observation and Embassy's
write; the App Server response cannot distinguish the resulting steer from a
fresh turn, so the race is undetectable on the wire and the receipt proves
acceptance and lifetime, not fresh-turn creation.

An exact leading `STEER:` from Claude to Codex targets the active accepted
Codex operation at its next safe tool-call boundary. It never interrupts a
generation. If that boundary is cleanly unavailable, the message remains in
the ordinary bounded queue. The global kill switch is
`EMBASSY_STEERING_ENABLED=0`.

See [Delivery semantics](docs/DELIVERY.md) for the phase and receipt contract.

## Federate

Connectivity comes first. Install Embassy and run `embassy service install` on
both Macs; for `studio` and `laptop`, use
`{"version":1,"host":"studio","nodes":["laptop"]}` on studio and
`{"version":1,"host":"laptop","nodes":["studio"]}` on laptop, with each peer
name matching both the remote inventory's `host` and a working SSH destination
or `~/.ssh/config` Host alias. After changing a running broker's inventory,
reload it with `embassy service install`.

From studio, verify the remote command environment with
`/usr/bin/ssh laptop 'which -a embassy; node --version; embassy --version'`,
then verify the corresponding direction from laptop; both remote Node and
Embassy must resolve without an interactive shell or password prompt. The local
broker launches:

```text
/usr/bin/ssh <node> embassy peer-stdio
```

The plain same-user SSH login is the trust boundary. The peer's claimed host
must be listed in the destination's `nodes.json`; that claim is trusted, not
independently bound to a physical machine. No forced command or dedicated
per-node key is required. Configure each node's host label accurately.
Federation has no listener or multi-hop routing. The destination owns the
queue and trusts the peer's source identity, so first contact does not wait
for a destination catalog poll. Catalogs are bounded memory-only observations,
never routing authority.

Once `codex-reviewer@laptop` appears from the Codex daemon on laptop (or from
fallback registration there), the Claude session on studio sends with
`embassy send --to codex-reviewer@laptop` exactly as it would locally.

`embassy refresh` observes local Claude and Codex sessions and every configured
SSH catalog in parallel. `status` performs no provider or network I/O: it shows
the last per-node catalog rows and observation time, retains the last rows when
a later refresh fails, and labels that node `PEER_TUNNEL_UNAVAILABLE`. At most
128 remote rows are displayed; truncation is explicit. Named and exact sends
still ask the owner directly.

In `embassy tui`, use `[` / `]` to select a host: the local pane polls every
second, while independent SSH clients read each remote's
`embassy status --json` about every five seconds. Each pane reports its own
broker's health, queue and last operations, not another broker's cached
catalog, and one hanging host cannot block the other panes. Remote actions run
the same CLI there over the configured non-interactive SSH; remote retirement
requires the host plus full endpoint ID confirmation and a fresh supported
owner snapshot. Disconnected panes are marked stale; an uncertain action is
never automatically retried. Without an interactive terminal, `tui` prints the
local status text once and exits without SSH.

## Retire

```sh
embassy retire --alias codex-reviewer@studio
embassy retire --endpoint <public-id>
```

`retire` removes one local endpoint identity and settles all of its
outstanding work: queued and reserved work is cancelled, armed work becomes
ambiguous, and accepted work becomes unconfirmed. Remote endpoints must be
retired on their owning host. If departed sessions share a name, retire one
exactly with `--endpoint` using its opaque public ID from `result.routes`;
`--alias` and `--endpoint` are mutually exclusive.

## Operations

```sh
embassy status --json
embassy refresh
embassy delivery-status --token dlv_example
embassy wait-delivery --token dlv_example
embassy check
embassy service status
```

`conv_example`, `dlv_example`, and `<public-id>` are substitutions, not
runnable literal values: supply the exact received conversation reference,
exact returned delivery token, or public endpoint ID respectively. Retain `result.deliveryToken` from
the successful send response in your current session; status shows aggregate
route queues and recent delivery metadata but cannot recover a lost delivery
token or distinguish identical sends by token.

`status` reports the broker ledger, queue depth, recent message outcomes,
retirements, each local route's last native operation, and the last bounded SSH
catalog observation. It does not claim that an idle provider is ready.
Machine output is one closed JSON line shaped as
`{"ok":true,"command":"status","result":{...}}`; route rows are therefore at
`.result.routes`. A terminal `embassy status` renders the same body for a
person, while `--json` keeps the envelope. No message body appears in either.

Use `delivery-status` to inspect one delivery's phase, pending age or terminal
code; `wait-delivery` polls until it is terminal or the bounded wait ends.

`check` is a broker-only loopback through the real ledger and coordinator. It
proves local control, persistence, routing, and receipt handling without
contacting a live Claude or Codex agent. A passing check exercises only broker
loopback, so neither `health` nor `check` proves that a Claude session or Codex
task can receive or answer a message.

In the TUI, on-screen keys refresh, check, look up a token or retire on the
selected host. Use 1–4 or Tab to change sections, `g`/`G` for the first or last
row, and Esc to return from an action result. Token lookup echoes only the
token you type; tokens are not added to the general delivery list. Retirement
confirmation shows the full endpoint identity and the consequences for
unsettled work. No message bodies are displayed.

## Safety

- The broker uses one private Unix socket and mode-0600 state inside a
  mode-0700 directory. It does not listen on TCP or HTTP.
- Native task/session IDs, socket paths, credentials, transcripts, and raw
  provider frames never appear in public output.
- Every native write is authorized against the exact current endpoint after
  preparation. Names are never silently resolved again during an attempt.
- Embassy launches `/usr/bin/ssh` directly without a local shell, in batch mode
  with forwarding disabled; the remote account must resolve the fixed
  `embassy peer-stdio` command in its non-interactive SSH environment.
- Embassy never changes a Codex approval or sandbox policy and never answers
  an approval.

See [Security](SECURITY.md), [Configuration](docs/CONFIGURATION.md), and
[Architecture](docs/GATEWAY-ARCHITECTURE.md).

## Development

Routine tests use test-owned directories, fake Claude sockets, fake App Server
transports, and fake SSH processes:

```sh
npm ci
TMPDIR=/tmp npm run check
```

No routine test connects a live provider or SSH host. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
