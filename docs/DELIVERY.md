# Delivery semantics

Embassy gives a sender a durable broker receipt. It does not claim that a model
understood or acted on the message.

## Identity and admission

An endpoint is identified by the tuple `(opaque endpoint ID, host, provider)`.
Its `name@host` alias is a lookup index and display label. A send by name
resolves once, before admission. Every later transition and reply uses the
endpoint tuple; a rename or replacement cannot retarget old work.

Codex callers must already be known through daemon discovery or fallback
registration. Both paths identify the same endpoint kind by the exact native
task identity. A Claude caller is derived from its inherited native socket and
recorded under the exact discovered session UUID.
The caller never supplies `--from`. A remote source is supplied by the trusted
SSH peer. Its claimed host must be in `nodes.json`, and the message's source
host must match that claim. The destination does not wait for a catalog poll
before accepting first contact.

Admission validates the body, deadline, route capacity, byte capacity, rate
limit, and exact local endpoint identities in one state transaction. It returns
a private delivery token and a conversation reference. A repeated federated
message ID is idempotent only when every identity and message field matches;
two deliberate sends with equal bodies remain two messages.

## One wake, several messages

For one exact destination and delivery class, the coordinator freezes the
oldest bounded FIFO prefix into one native wake. Each enclosed message keeps a
separate provenance envelope, conversation, deadline, and terminal result. A
busy endpoint therefore catches up in one wake instead of requiring one agent
turn per queued message.

The batch is bounded by message count, raw queue bytes, framed wake bytes, and
the adapter's operation limit. A message that expires or cannot fit reports its
own result; it does not erase or silently merge another message.

## Durable phases

Each delivery has exactly one of these phases:

1. `queued` — durably admitted, no operation owns it.
2. `reserved` — a specific attempt owns a fixed batch, but no write is
   authorized.
3. `armed` — the exact prepared bytes and identities were revalidated and the
   provider may be written.
4. `accepted` — the provider accepted the operation; Embassy continues to
   track its lifetime.
5. `terminal` — `delivered`, `failed`, `cancelled`, `expired`, `ambiguous`, or
   `unconfirmed` with a safe code.

Only an adapter's positive proof that it wrote nothing may return reserved or
armed work to `queued`. Loss before authorization may retry within the deadline
and attempt budget. Loss after an armed write is `ambiguous`; loss after
provider acceptance is the adapter's recorded `ambiguous` or `unconfirmed`
outcome. Neither is replayed.

On broker restart, queued work remains eligible, reserved work returns to the
queue, armed work becomes `ambiguous`, and accepted work becomes its stored
uncertain outcome. A terminal result is first-wins, including late or duplicate
provider callbacks.

## Native adapters

### Claude destination

The broker discovers the exact compatible live session, verifies its private
socket and workspace boundary, composes the complete bounded provenance batch,
then revalidates the same endpoint immediately before the peer-protocol write.
The receiving Claude session wakes through its native socket.

### Codex destination

The broker creates a fresh bounded App Server operation, resumes the exact
known task without retaining returned history, prepares the input, then
revalidates the endpoint and operation immediately before the write. Dormant
roots therefore wake through ordinary delivery. The accepted operation remains attached
until its terminal lifetime event so an active-turn STEER has a valid target.

Ordinary messages remain queued while the immediately observed task status is
active. If another client starts a turn between Embassy's idle check and its
write, the message enters that turn as steer text; the App Server response
cannot distinguish this, so the receipt proves acceptance and lifetime only,
not that a fresh turn started. The same residual race applies to fallback-
registered tasks. Embassy does not use the App Server's native queue.

An exact leading `STEER:` is special only from Claude to Codex. It is delivered
through that exact accepted operation's `turn/steer` capability at the next
safe tool-call boundary. It never invokes `turn/interrupt` or injects during a
generation. A cleanly unavailable boundary returns the message to the ordinary
bounded queue. At most three queued STEER messages target one route.

### SSH destination

The source gateway resolves the exact endpoint at its owner, prepares one
bounded handoff, and writes it once through the authenticated SSH peer. The
destination checks the configured claimed host and source consistency, persists its queue,
then returns acceptance. A proven pre-enqueue refusal is
reported precisely; process loss, malformed response, or failure after the
commit boundary is uncertain and never retried automatically.

## Provenance and replies

Every native wake contains one `<cross-session-message>` envelope per message.
Reserved tag prefixes in user text are neutralized before framing. Public
metadata contains aliases, providers, and a conversation reference, never a
native session/task ID or socket path.

The enclosed reply hint is:

```sh
embassy send --conversation <reference>
```

The caller is inferred again. The ledger accepts the reply only from one exact
participant and targets the other exact participant. A reference can survive a
broker restart while its bounded retained row and both endpoint identities are
still valid. Retirement, replacement, retention expiry, eviction, or state
reset makes it unavailable. Conversation references are intentionally not
stable across a reset.
If an unused automatic endpoint is pruned from the discovery window, references
bound to that identity refuse for the rest of their retention window, even if
the native thread returns as a new endpoint. Re-address it by its current alias.

## Receipts and retirement

`embassy delivery-status --token <token>` is a one-shot read.
`embassy wait-delivery --token <token>` polls the private broker control socket
until that delivery becomes terminal or its bounded wait ends. Delivery tokens
are opaque capabilities and must not be put in logs or provider messages.
Both status and delivery-status report the actual nonterminal phase: queued,
reserved, armed, or accepted. A missing/evicted receipt returns `found:false`;
wait-delivery exits 3 for that lookup failure, not the terminal-delivery-failure
exit 6. Receipt retention is bounded and never promises indefinite lookup.
The default receipt bounds are 500 terminal rows and 24 hours. The 1 MiB
retained-body budget removes old bodies, not their receipt/outcome or reply
identity; a hash retains exact duplicate-message checking after body removal.
Retirement evidence has a separate 500-row bound and the same time window.

`embassy retire --alias <local-name>` removes the resolved local endpoint in
one transaction. Incident queued/reserved work becomes `cancelled`; armed work
becomes `ambiguous`; accepted work becomes `unconfirmed`. Recent retirement
evidence remains bounded. Remote routes are read-only and must be retired on
their owner. No pending message is moved to another identity.
Claude can reappear with the same session UUID as a fresh endpoint immediately;
old work and conversation replies still refuse against the retired ID. Codex
retirement continues to suppress that native task for the retention window.
For a colliding name, use `embassy retire --endpoint <public-id>` with the
opaque ID from status. It removes only that exact local row; `--alias` and
`--endpoint` are mutually exclusive. This also works after both sessions exit.
