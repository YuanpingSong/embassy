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
- Claude Code and/or Codex CLI installed for the agents you use.
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

## Quickstart

For an explicit host name or federation, create `nodes.json` before starting
the broker. `host` is this machine's name; `nodes` lists directly reachable
Embassy hosts.

```json
{"version":1,"host":"studio","nodes":[]}
```

The file lives at
`$XDG_STATE_HOME/agent-embassy/nodes.json`, or
`~/.local/state/agent-embassy/nodes.json` when `XDG_STATE_HOME` is unset. It
must be owned by the current user, mode 0600, inside the private mode-0700 state
directory. If it is absent on first single-machine boot, Embassy derives a
lower-case name from the short hostname and atomically writes the equivalent
empty-node file. It never rewrites a present inventory.

Install the supervised broker:

```sh
embassy service install
embassy health
```

A Codex task registers itself from that task's inherited identity. Embassy
never accepts or prints the task ID:

```sh
embassy register-codex --alias codex-reviewer@studio
```

Claude sessions are discovered and recorded by exact native identity when a
Claude caller sends or when a named Claude target is resolved. No helper or
native advertisement process is installed.

From either a Claude session or a registered Codex task, send the body on
stdin. The sender is inferred from the calling session:

```sh
printf '%s\n' 'Please review the change.' |
  embassy send --to claude-reviewer@studio
```

The recipient gets a provenance envelope and a conversation-bound reply
command:

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

An exact leading `STEER:` from Claude to Codex targets the active accepted
Codex operation at its next safe tool-call boundary. It never interrupts a
generation. If that boundary is cleanly unavailable, the message remains in
the ordinary bounded queue. The global kill switch is
`EMBASSY_STEERING_ENABLED=0`.

See [Delivery semantics](docs/DELIVERY.md) for the phase and receipt contract.

## Multiple machines

List direct peers in each machine's `nodes.json`. The local broker launches:

```text
/usr/bin/ssh <node> embassy peer-stdio
```

SSH authenticates the machine connection. Federation has no listener and no
multi-hop routing. The destination owns the queue. The source gateway attests
the sender on handoff, so first contact does not wait for a destination catalog
poll. Remote catalog replies and caches are bounded and memory-only; they are
never routing authority.

`embassy refresh` observes local Claude sessions and every configured SSH
catalog in parallel. `status` performs no provider or network I/O: it shows the
last per-node catalog rows and observation time, retains the last rows when a
later refresh fails, and labels that node `PEER_TUNNEL_UNAVAILABLE`. At most 128
remote rows are displayed; truncation is explicit. Named and exact sends still
ask the owner directly.

## Operations

```sh
embassy status
embassy status --json
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

Machine output is one closed JSON line shaped as
`{"ok":true,"command":"status","result":{...}}`; route rows are therefore at
`.result.routes`. A terminal `embassy status` renders the same body for a
person, while `--json` keeps the envelope.

`check` is a broker-only loopback through the real ledger and coordinator. It
proves local control, persistence, routing, and receipt handling without
contacting a live Claude or Codex agent. It is not a provider-readiness test.

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
- SSH uses the fixed system binary, batch mode, no forwarding, and no shell.
- `health` and `check` describe broker infrastructure, not model readiness or
  comprehension.

See [Security](SECURITY.md), [Configuration](docs/CONFIGURATION.md), and
[Architecture](docs/GATEWAY-ARCHITECTURE.md).

## Upgrading to 4.x

Version 4 accepts only fresh private state schema 6 and private control
protocol 5. It does not migrate or read v3 state. Before upgrading, use the old
binary to inspect and settle work, stop the broker, preserve a backup of the
old state, then reset `gateway-state.json`. Keep `nodes.json`.

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
