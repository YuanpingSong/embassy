# Delivery semantics

Embassy gives a sender a durable broker receipt. It does not claim that a model
understood or acted on the message.

## Identity and admission

An endpoint is identified by the tuple `(opaque endpoint ID, host, provider)`.
Its `name@host` alias is a lookup index and display label. A send by name
resolves once, before admission. Every later transition and reply uses the
endpoint tuple; a rename or replacement cannot retarget old work.

Codex callers must already be registered. A Claude caller is derived from its
inherited native socket and recorded under the exact discovered session UUID.
The caller never supplies `--from`. A remote source is attested by its owning
SSH-authenticated gateway and admitted directly; the destination does not wait
for a catalog poll before accepting first contact.

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
registered task without retaining returned history, prepares the input, then
revalidates the registration and operation immediately before the write. The
accepted operation remains attached until its terminal lifetime event so an
active-turn STEER has a valid target.

An exact leading `STEER:` is special only from Claude to Codex. It is delivered
through that exact accepted operation's `turn/steer` capability at the next
safe tool-call boundary. It never invokes `turn/interrupt` or injects during a
generation. A cleanly unavailable boundary returns the message to the ordinary
bounded queue. At most three queued STEER messages target one route.

### SSH destination

The source gateway resolves the exact endpoint at its owner, prepares one
bounded handoff, and writes it once through the authenticated SSH peer. The
destination verifies the peer host and source attestation, persists its queue,
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

## Receipts and retirement

`embassy delivery-status --token <token>` is a one-shot read.
`embassy wait-delivery --token <token>` polls the private broker control socket
until that delivery becomes terminal or its bounded wait ends. Delivery tokens
are opaque capabilities and must not be put in logs or provider messages.

`embassy retire --alias <local-name>` removes the resolved local endpoint in
one transaction. Incident queued/reserved work becomes `cancelled`; armed work
becomes `ambiguous`; accepted work becomes `unconfirmed`. Recent retirement
evidence remains bounded. Remote routes are read-only and must be retired on
their owner. No pending message is moved to another identity.
