# Embassy

Embassy lets live Claude Code sessions and Codex CLI tasks message one another
by name, on one Mac or across user-owned Macs reached through SSH. The broker
wakes the receiving agent through its native interface; agents do not poll.
Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex all use the same
command and receipt model.

The core is deliberately small: one private ledger, one delivery coordinator,
and three write adapters (Claude socket, Codex App Server operation, and SSH
handoff). Aliases are lookup names. Opaque endpoint IDs are the routing
identity, so a rename or replacement never silently retargets queued work.

## Requirements

- macOS and Node.js 20 or newer.
- Claude Code installed for the Claude sessions you use.
- To receive in Codex, use its managed standalone installation with its App
  Server daemon already running under the same macOS login; merely having a
  `codex` executable on PATH is insufficient, and Embassy does not install or
  start that daemon.
- A private `nodes.json` when choosing an explicit host name or federating;
  first single-machine boot creates one from the short hostname.
- Key-based, non-interactive SSH between configured machines when federating.

Install one copy with one package manager and verify what the shell resolves:

```sh
npm install -g agent-embassy
which -a embassy
embassy --version
```

The launchd service records the absolute installation path used by
`embassy service install`. After replacing or removing that installation, run
the install command again.

`embassy service install` starts the per-user launchd agent immediately and
arranges login startup; use the same command to reload broker configuration or
start a stopped installation, and use `embassy service uninstall` to stop and
unload it.

The agent uses launchd's crash-only keepalive policy. A
verified `SIGABRT` crash relaunches it. A clean exit, boot refusal, `SIGTERM`,
or deliberate `kill -9` leaves it stopped; inspect `embassy service status`
and run `embassy service install` deliberately rather than assuming every
signal restarts it.

## Quickstart

For an explicit host name or federation, create `nodes.json` before starting
the broker. `host` is this machine's name; `nodes` lists directly reachable
Embassy hosts.

```json
{"version":1,"host":"studio","nodes":[]}
```

`nodes.json` lives inside `EMBASSY_STATE_DIR` when set; otherwise it lives in
`$XDG_STATE_HOME/agent-embassy`, or `~/.local/state/agent-embassy` when
`XDG_STATE_HOME` is unset; every client shell must use the same state-directory
configuration captured by the installed service. Create the private state
directory before saving the example, and set directory mode 0700 and
`nodes.json` mode 0600 before installing the service.

The file must be owned by the current user, mode 0600, inside the private
mode-0700 state directory. If it is absent on first single-machine boot, Embassy derives a
lower-case name from the short hostname and atomically writes the equivalent
empty-node file. It never rewrites a present inventory.

Install the supervised broker:

```sh
embassy service install
embassy health
```

Global npm installation includes `skills/embassy-peer` under the
`agent-embassy` package in `npm root -g`; the operator can copy that entire
folder into `~/.codex/skills/` and `~/.claude/skills/`, then ask each agent to
use it, or provide the shown commands directly to the agent's shell tool.

Read `host` from the `nodes.json` that first boot created and use it as every
local `@host` suffix; the examples use `@studio` only when you explicitly chose
`host: studio`, not as a universal alias suffix.

Ask the live Codex CLI task to execute the following registration through its
shell tool; an ordinary terminal lacks that task's inherited identity. Embassy
never accepts or prints the task ID:

```sh
embassy register-codex --alias codex-reviewer@studio
```

Claude sessions are discovered and recorded by exact native identity when a
Claude caller sends or when a named Claude target is resolved. No helper or
native advertisement process is installed.

After Codex registers `codex-reviewer@studio`, ask the live Claude Code session
to run `embassy send --to codex-reviewer@studio` with 'Please review the change
and reply using the supplied Embassy hint' on stdin; execute this through the
agent's shell tool, not an unrelated terminal. The sender is inferred from the calling session:

```sh
printf '%s\n' 'Please review the change and reply using the supplied Embassy hint' |
  embassy send --to codex-reviewer@studio
```

The receiving Codex task sees a broker hint such as:

```text
<embassy-reply-hint conversation="conv_EXACT_REFERENCE" ...>Reply by running `embassy send --conversation conv_EXACT_REFERENCE` with the reply body on stdin.</embassy-reply-hint>
```

It must execute the exact received command to send the reply, because ordinary
Codex final output is not forwarded automatically and `conv_example` is not a
usable reference:

```sh
printf '%s\n' 'Review complete.' |
  embassy send --conversation conv_example
```

For a Claude target, find the current Claude target name with an authorized
`embassy refresh` followed by `embassy status --json`, or use the exact current
name supplied by that session.

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

An exact leading `STEER:` from Claude to Codex targets the active accepted
Codex operation at its next safe tool-call boundary. It never interrupts a
generation. If that boundary is cleanly unavailable, the message remains in
the ordinary bounded queue. The global kill switch is
`EMBASSY_STEERING_ENABLED=0`.

See [Delivery semantics](docs/DELIVERY.md) for the phase and receipt contract.

## Multiple machines

Install Embassy and run `embassy service install` on both Macs; for `studio`
and `laptop`, use `{"version":1,"host":"studio","nodes":["laptop"]}` on
studio and `{"version":1,"host":"laptop","nodes":["studio"]}` on laptop,
with each peer name matching both the remote inventory's `host` and a working
SSH destination or `~/.ssh/config` Host alias.

After changing a running broker's inventory, reload it with
`embassy service install`; register `codex-reviewer@laptop` from the live
Codex task on laptop, then ask the Claude session on studio to run
`embassy send --to codex-reviewer@laptop` with the message on stdin.

From studio, verify the remote command environment with
`/usr/bin/ssh laptop 'which -a embassy; node --version; embassy --version'`,
then verify the corresponding direction from laptop; both remote Node and
Embassy must resolve without an interactive shell or password prompt.

The local broker launches:

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

`embassy refresh` observes local Claude sessions and every configured SSH
catalog in parallel. `status` performs no provider or network I/O: it shows the
last per-node catalog rows and observation time, retains the last rows when a
later refresh fails, and labels that node `PEER_TUNNEL_UNAVAILABLE`. At most 128
remote rows are displayed; truncation is explicit. Named and exact sends still
ask the owner directly.

## Operations

Retain `result.deliveryToken` from the successful send response in your current
session and substitute that exact value for the example; status shows aggregate
route queues and recent delivery metadata but cannot recover a lost delivery
token or distinguish identical sends by token.

The ellipses (`...` or `…`), `conv_example`, `dlv_example`, and `<public-id>`
are substitutions, not runnable literal values: supply the indicated command
arguments, exact received conversation reference, exact returned delivery
token, or public endpoint ID respectively.

```sh
embassy status
embassy status --json
embassy tui                                # interactive operator client
embassy refresh
embassy delivery-status --token dlv_example
embassy wait-delivery --token dlv_example
embassy retire --alias codex-reviewer@studio
embassy check
embassy service status
embassy serve                              # foreground alternative
```

`status` reports the broker ledger, queue depth, recent message outcomes,
retirements, each local route's last native operation, and the last bounded SSH
catalog observation. It does not claim that an idle provider is ready.

Use `delivery-status` to inspect that delivery's phase, pending age or terminal
code; use `status --json` to identify a stranded local route, and retire it with
`retire --alias` using its alias or `retire --endpoint` using its public id from `result.routes`,
understanding that this settles all outstanding work for that endpoint.

`embassy tui` shows the local broker and each direct host in `nodes.json` in one
terminal. Use `[` / `]` to select a host: local status polls every second, while
independent SSH clients read each remote's `embassy status --json` about every
five seconds. Each pane reports its own broker's health, queue and last
operations—not another broker's cached catalog. One hanging host cannot block
the other panes. No message bodies are displayed.
On-screen keys refresh, check, look up a token or retire on the selected host.
Remote actions run the same CLI there over configured non-interactive SSH;
retirement requires HOST + full endpoint ID confirmation and a fresh supported
owner snapshot. An uncertain action is never automatically retried.
Disconnected views are marked stale; actions are never automatically retried.
Without an interactive terminal, `tui` prints local status text once and exits
without SSH. Unsupported remote response shapes are not guessed; a lazy
`embassy --version` read identifies only that remote CLI, not its broker version.
Deliveries are newest-admitted first, with faults distinguished from successful
delivery. Use 1–4 or Tab to change sections, g/G for first/last row, and Esc to
return from an action result. Token lookup echoes only the token you type;
tokens are not added to the general delivery list. Retirement confirmation
shows the full endpoint identity and the consequences for unsettled work.

Machine output is one closed JSON line shaped as
`{"ok":true,"command":"status","result":{...}}`; route rows are therefore at
`.result.routes`. A terminal `embassy status` renders the same body for a
person, while `--json` keeps the envelope.

`check` is a broker-only loopback through the real ledger and coordinator. It
proves local control, persistence, routing, and receipt handling without
contacting a live Claude or Codex agent. Healthy means the Embassy control
socket and ledger respond; a passing check exercises only broker loopback, so
neither proves that a Claude session or Codex task can receive or answer a message.

`retire` removes one local endpoint identity. Queued and reserved work is
cancelled, armed work becomes ambiguous, and accepted work becomes unconfirmed.
Remote endpoints must be retired on their owning host.
If departed sessions share a name, retire one exactly with
`embassy retire --endpoint <public-id>` using its opaque ID from status.

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
- Healthy means the Embassy control socket and ledger respond; a passing check
  exercises only broker loopback, so neither proves that a Claude session or
  Codex task can receive or answer a message.

See [Security](SECURITY.md), [Configuration](docs/CONFIGURATION.md), and
[Architecture](docs/GATEWAY-ARCHITECTURE.md).

## Upgrading to 4.x

Version 4 accepts only fresh private state schema 6 and private control
protocol 5. It does not migrate or read 3.x state.

Before replacing a 3.x installation, use its matching CLI to inspect and
settle or explicitly abandon pending work; stop a launchd broker with
`embassy service uninstall` (or stop the foreground serve process) and confirm
it is stopped with `embassy service status`, back up and move aside only
`gateway-state.json` in that broker's state directory while retaining
`nodes.json`, then install 4.0.0, run `embassy service install`, and re-register
the Codex tasks.

All state produced by Embassy 3.x is unsupported by 4.x; preserve the matching
old binary as well as its old state if rollback may be needed, and never run
the old and new brokers together. See the [reset procedure](docs/CONFIGURATION.md#private-state-reset).

The rollback boundary is the preserved old state plus its matching old binary.
Do not point an old binary at schema-6 state or a v4 binary at old state.

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
