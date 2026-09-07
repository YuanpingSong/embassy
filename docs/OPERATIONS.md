# Operating Embassy

Day-to-day commands after the broker is installed. Configuration, the launchd
service and SSH federation are in [CONFIGURATION.md](CONFIGURATION.md); the
phase and receipt contract is in [DELIVERY.md](DELIVERY.md).

## Seeing the agents

`embassy tui` is the daily view: an Ink-based terminal client (Node 22+) that
shows the local broker and each direct host in `nodes.json`, with endpoints
grouped by state, deliveries newest first, retirements, and action results.
`embassy status` prints the same snapshot once as text; `embassy status --json`
prints one closed JSON line shaped as
`{"ok":true,"command":"status","result":{...}}`, so route rows are at
`.result.routes`. No message body appears in either.

Codex agents appear automatically. Embassy observes the same-user Codex App
Server daemon and lists its 20 most recent unarchived root agents by their
current public names; dormant agents remain addressable and wake on delivery.
Only head agents are endpoints: sub-agents are never discovered or displayed.
Native task IDs, previews and history never appear in Embassy output. If no
Codex agent appears, check that the Codex daemon is running under this login;
Embassy never starts it.

Claude sessions are discovered and recorded by exact native identity when a
Claude caller sends or when a named Claude target is resolved. To find a
Claude session's current name, run `embassy refresh` (authorized live
discovery) followed by `embassy status --json`, or use the exact current name
that session supplies.

For a harness without native daemon integration, registration is the fallback.
Ask the live Codex CLI task to run this through its own shell tool; an ordinary
terminal lacks that task's inherited identity:

```sh
embassy register-codex --alias codex-reviewer@studio
```

In the TUI, on-screen keys refresh, check, look up a token or retire on the
selected host. Use 1–4 or Tab to change sections, `[` / `]` to change host,
`g`/`G` for the first or last row, and Esc to return from an action result.
Token lookup echoes only the token you type; tokens are not added to the
general delivery list. Retirement confirmation shows the full endpoint identity
and the consequences for unsettled work. Without an interactive terminal,
`tui` prints the local status text once and exits without SSH.

## Receipts and delivery status

A successful `embassy send` returns `result.deliveryToken` and a conversation
reference. The receipt proves transport, not comprehension: acceptance means
the broker owns the delivery, not that a model read or understood the body.

```sh
embassy delivery-status --token dlv_example
embassy wait-delivery --token dlv_example
```

Use `delivery-status` to inspect one delivery's phase, pending age or terminal
code; `wait-delivery` polls until it is terminal or the bounded wait ends.
`conv_example`, `dlv_example`, and `<public-id>` are substitutions, not
runnable literal values. Retain `result.deliveryToken` from the successful send
response in your current session; status shows aggregate route queues and
recent delivery metadata but cannot recover a lost delivery token or
distinguish identical sends by token.

`status` reports the broker ledger, queue depth, recent message outcomes,
retirements, each local route's last native operation, and the last bounded SSH
catalog observation. It does not claim that an idle provider is ready.

## Health and check

```sh
embassy health
embassy check
embassy service status
```

`health` means the Embassy control socket and ledger respond. `check` is a
broker-only loopback through the real ledger and coordinator: it proves local
control, persistence, routing, and receipt handling without contacting a live
Claude or Codex agent. Neither proves that a Claude session or Codex task can
receive or answer a message.

## Retiring an endpoint

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

## Other Macs

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
never automatically retried. Setup is in
[CONFIGURATION.md](CONFIGURATION.md#ssh-federation).
