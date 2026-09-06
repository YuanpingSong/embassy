# Gateway architecture

## Product contract

Embassy connects live Claude Code sessions and registered Codex CLI tasks by
name, locally or across directly configured SSH gateways. All four provider
pairs are supported. Sending is one `embassy send` command; receiving wakes the
target through its native interface. A receipt proves delivery machinery, not
model comprehension.

The design optimizes for this steady state and deliberately excludes native
Claude `SendMessage` advertisement helpers, shell-peer mailboxes, automatic
Codex output forwarding, persistent remote mirrors, general activity streams,
and migration compatibility.

## Topology

```text
Claude/Codex CLI
       |
       | private control UDS
       v
+---------------- local broker ----------------+
| endpoint directory -> ledger -> coordinator  |
|                              /      |      \  |
|                   Claude socket  Codex op  SSH|
+------------------------------------------------+
                                               |
                           ssh node embassy peer-stdio
                                               |
                                      remote broker ledger
```

There is one broker per login user and host. The broker owns one schema-6 JSON
document and one private control socket. It does not listen on a network port.
launchd may supervise the same foreground `serve` entry point.

## Endpoint directory

The directory translates a current selector into an endpoint:

```text
{ id: opaque reg_ value, host, provider, alias, private native handle }
```

The `(id, host, provider)` tuple is identity. `alias` is mutable lookup and
display data. `handle` stays private and is required only for the owning
provider's final attestation.

The ID is minted randomly for a new registration, then retained across rename
and restart. Retirement retains a bounded private hash of the native binding
to fence immediate re-enrollment. After that evidence is evicted, a later
registration gets a new ID; old replies and remote references cannot revive.

Codex endpoints are explicitly registered by the task that inherits the exact
task UUID. Claude endpoints are discovered by exact session UUID and recorded
when a Claude caller or target is resolved. A same-UUID rename updates one
endpoint; a different identity never inherits work. Two live Claude sessions
may share a display name, but name resolution then refuses with
`PEER_ALIAS_COLLISION`. An exact user-supplied Claude UUID can disambiguate
selection without making UUIDs public output.
Partial discovery cannot clear an observed collision. The bounded collision
proof sets fail closed on overflow until a complete scan; exact UUID lookup
remains available. Operator retirement can use `--endpoint <public-id>` when
departed sessions share a name and can no longer rename themselves.

Remote name and identity resolution calls the endpoint's owner. Catalog replies
and any local cache are bounded and memory-only; neither grants lookup or write
authority. Remote endpoint rows contain opaque IDs and aliases, not native
handles.

`refresh` runs local Claude discovery and all configured catalog observations
in parallel. Each successful node observation replaces its rows and timestamp.
A failure retains the last timestamped rows with `PEER_TUNNEL_UNAVAILABLE`.
The status projection reads this cache without network I/O and caps the combined
remote display at 128 rows, reporting truncation. Routing still uses the owner
RPC even when the cache is fresh.

## Ledger

`ledger.ts` is the pure transition core. It has no provider I/O, filesystem
operations, callbacks, timers, or alias re-resolution. A state transaction
supplies a draft and a timestamp; the ledger validates and mutates that draft.

The document holds:

- endpoint bindings;
- deliveries and their exact source/target identities;
- recent bounded retirement evidence;
- bounded per-source rate windows;
- a commit sequence and random commit identity.

Each delivery contains its body, opaque message/conversation/delivery IDs,
deadline, STEER classification, and one phase:

```text
queued -> reserved -> armed -> accepted -> terminal
              \          \          \
          proven no-write  ambiguous  unconfirmed/ambiguous
```

`queued` is durable admission. `reserved` freezes a FIFO prefix under one
attempt. `armed` records the exact framed byte evidence after identity
revalidation. `accepted` records provider acceptance and the correct loss
outcome. `terminal` is first-wins.

Only positive no-write evidence may return work to the queue. Restart returns
reserved work, never armed or accepted work. This is the no-replay boundary.

One ledger row is one deliberate message. Equal bodies do not deduplicate.
Federated retry idempotence uses the owner-minted message ID and accepts a
duplicate only when every identity and message field agrees.

## Owned state

`OwnedStateFile` provides one typed atomic document rather than provider- or
feature-specific stores. The schema codec validates every consumed field and
global bound before the state is exposed.

Transactions are synchronous functions over detached clones. Provider I/O
cannot run under a transaction. A changed draft is encoded, written to an
exclusive mode-0600 temporary file, synced, renamed, and followed by a
directory sync. The installed commit is reconciled against the prior/current
commit identities; an unknown write result poisons the process rather than
guessing. The live host lease is checked before a transaction, before
persistence, and immediately before rename.

No-op transactions write nothing. Unsupported or corrupt state refuses before
mutation. Schema 6 is reset-only; no older loader or converter is linked into
the v4 binary.

## Coordinator

The coordinator is the only delivery scheduler. It keys one active operation
by exact destination and normal-versus-STEER class. It reserves the oldest
bounded prefix, resolves exact private endpoint facts, builds one provenance
envelope per message, and asks one destination adapter to deliver the batch.

Provider work happens outside the state transaction. The adapter first prepares
immutable wire evidence. Its authorization callback opens a new transaction,
checks the live lease, revalidates all local endpoint IDs, aliases, handles, and
body hashes, and advances the exact batch to `armed`. Its acceptance callback
persists `accepted` before the provider operation is treated as admitted.

Messages that arrive while a successful operation is running are drained by
the same coordinator loop in the next bounded batch. A clean busy response
stops the loop until a fixed retry cadence; it never spins at caller speed.
The number of native operations remains bounded even if an endpoint is retired
while one is still running.

The coordinator records only each endpoint's last bounded operation outcome
and safe code for status. It does not maintain an analytics stream.

## Destination adapters

### Claude socket

The Claude adapter rediscovers the exact compatible session, validates its
registry record, same-user socket and workspace/state-root separation, prepares
the complete peer-protocol-1 frame, and performs one native write after the
coordinator authorizes it. The native socket wakes Claude immediately.

There is no forked helper, callback socket, advertisement record, or native
Claude sending shim. A Claude session sends by invoking `embassy send`; its
native socket is still used for receive and reply wake-up.

### Codex operation

The Codex adapter creates a fresh App Server connection per operation, checks
the current interface, resumes the exact registered thread with history
excluded, and starts one turn carrying the bounded batch. Returned history and
model output are not retained or forwarded.

An accepted operation remains tracked until its terminal lifetime notification.
An exact leading Claude-to-Codex `STEER:` may use that same accepted
operation's `turn/steer` method at the next safe tool-call boundary. It never
uses `turn/interrupt` and does not detach an operation early merely because
input acceptance occurred.

### SSH handoff

Federation starts `/usr/bin/ssh` directly with fixed safe options and the
remote `embassy peer-stdio` command. Protocol 3 has four correlated methods:

- `initialize` — exact version and host agreement;
- `catalog` — bounded public endpoint rows;
- `resolve` — owner-authoritative name or identity lookup;
- `handoff` — one bounded batch admitted to the destination ledger.

The source owner attests every message's source endpoint, enabling first
contact without waiting for reverse catalog propagation. The destination
validates the authenticated peer host and owns admission, storage, scheduling,
and receipts. A definite refusal is exposed only when proved before enqueue;
all transport or post-commit uncertainty remains ambiguous and is not replayed.

## Provenance and replies

Each message in a native wake has a structural
`<cross-session-message>` envelope with bounded aliases, provider identity, and
a reply hint. User text that begins a reserved gateway tag is neutralized. The
envelope is not a cryptographic signature; provider content stays untrusted.

Replies use `embassy send --conversation <reference>`. The calling endpoint is
inferred again. The ledger verifies that it is one exact participant and sends
to the other exact participant. References may survive process restart while
the bounded delivery row and exact endpoint bindings remain. They do not
survive endpoint retirement/replacement, retention expiry, eviction, or state
reset.

## Local control and CLI

The private control protocol is version 5. Each connection carries one bounded
JSON request and one closed JSON response over the expected private Unix
socket. A mutating request whose reply is lost after write reports
`CONTROL_WRITE_OUTCOME_AMBIGUOUS`; the CLI does not retry it.

The public CLI is:

```text
register-codex   send              status
refresh          delivery-status   wait-delivery
retire           check             health
serve            service           peer-stdio
--version        --help
```

`send` accepts exactly one of `--to` and `--conversation`; it has no `--from`.
Human `status` is a rendering of the same closed body-free JSON shape. Its
health word describes control/ledger health, local route rows expose their last
native operation, and the federation section exposes only the last bounded
catalog observation. `health` is a control-path probe. `check` creates temporary
private loopback endpoints and uses the real ledger/coordinator/receipt path,
then retires them; no provider or model is contacted. It is not a
provider-readiness test.

Machine-facing CLI success is one `{ok, command, result}` JSON line. The
snapshot is at `.result` and its endpoint rows at `.result.routes`; native
handles and message bodies cannot hitchhike through the closed result decoder.

## Startup and shutdown

Startup order is ownership-sensitive:

1. load the private node inventory, or derive a transient first-boot default,
   and load configuration;
2. acquire the fixed host-wide kernel lease;
3. open and validate schema-6 state without changing the inventory;
4. atomically install and reload the default inventory when first boot needs
   one;
5. construct native and SSH adapters;
6. bind and validate the private control socket;
7. clean any exact temporary loopback residue;
8. apply restart settlement and begin scheduling;
9. accept semantic control requests.

This order prevents recovered messages reaching a provider before control and
ownership are established. Cancellation or lease loss fences new writes.

Shutdown first rejects new semantic work, closes control, applies phase-derived
restart settlement, waits for active coordinator operations, closes every
destination, then releases state and the host lease. Closing never invokes a
model interrupt.

## Protocol and schema versions

| Surface | Version | Compatibility policy |
|---|---:|---|
| Private state (`gateway-state.json`) | 6 | Reset only; older and unknown schemas refuse without mutation |
| Private control (CLI ↔ broker) | 5 | CLI and broker must come from one installation |
| Federation (`peer-stdio`) | 3 | Exact version and host handshake; no compatibility mode |
| Consumed Claude peer protocol | 1 | Incompatible records are rejected in isolation |

Native provider protocols remain owned by their providers and are validated at
each use boundary. Version or build metadata is never routing authority.

## Responsibility exclusions

The v4 core intentionally has no shell-peer registration/token/mailbox/await
system, no native Claude advertisement helper, no automatic provider-output
reply capture, no persisted remote route mirror, no pair/selection graph, no
dashboard/watch event system, no notice-mode machinery, and no v3 migration
reader. The responsibilities that remain are endpoint identity, bounded
delivery, native wake, exact replies, direct federation, status, retirement,
service supervision, and loopback verification.
