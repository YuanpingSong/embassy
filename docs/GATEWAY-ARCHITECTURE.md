# Embassy Gateway Architecture

Status: local bidirectional routing is implemented for Claude, Codex, and
universal shell peers. Configured Embassy nodes federate allowlisted
named routes over a fixed attach-only SSH transport. The published package
supports macOS, the only platform exercised end to end so far.

This document uses four evidence labels:

- **Official**: documented by Anthropic or OpenAI.
- **Implemented**: present in this worktree and covered by deterministic tests.
- **Observed**: established by a bounded, read-only local feasibility probe.
- **Planned**: designed but not yet integrated or live-validated.

A bounded real test completed native Claude discovery and messaging, held a
message while the registered Codex task was active, automatically started the
queued turn after idle, and delivered the exact final reply back to Claude.

## Purpose and boundary

The gateway lets already-running Claude Code sessions and explicitly
registered native Codex tasks address one another by short aliases. The
permission to message is the boundary the broker already sits inside: the same
UID, the same host — or a host the operator listed in the private `nodes.json`
— and an exact alias. There is no separate, revocable grant between two
endpoints, because no such record could defend against software already
running as that UID; what the broker guarantees instead is attribution, and a
discovered Claude session's route installs on its first use rather than by a
separate command. It provides
a single private operational view across the two products without rebuilding
either agent runtime.

Provider versions are best-effort diagnostic metadata, never routing authority.
The OS boundary plus the exact owned route and session identity authorizes an
attempt; the current per-operation transport, strict wire, capability, and
correlated operation facts decide its result. Unsafe OS evidence
for Embassy-owned or executed artifacts and Embassy callback, control, or state
paths refuses broker startup; unsafe UID or mode evidence on Claude's external
sessions registry root quarantines only Claude. A Claude session record whose
native peer protocol is not 1 is rejected in isolation and included in bounded
rejection evidence. Missing optional providers and interface drift degrade only
their own routes while the broker and other providers remain available.

It is deliberately:

- personal, local, same-OS-user software;
- single-user and non-hosted;
- an alias router and bounded message broker, not an agent runtime;
- unable to create Codex sidebar task cards or Claude session UI.

Embassy uses one private same-user Unix-domain control socket for its thin
clients. `embassy serve` does not add a TCP listener, HTTP server, or public
API.

### Why this uses the new feature, but is not skill-only

The gateway does not use Claude Channels. Claude's official cross-session
feature supplies genuine Claude-session discovery, inbound policy, and native
message delivery. It does not define a third-party session kind or make Codex
tasks appear in `ListAgents`, so it cannot by itself provide the symmetric
Claude–Codex address book the user wants.

The repo-shipped skill is the lightweight user/agent interface. A persistent
local broker is still required to own the private control socket, retain
transient reply correlation, publish native advertisements, and queue while a
Codex task is busy. The skill does not wrap, replace, or recreate either
provider.

## What is official and what is internal

### Claude Code

**Official:** Claude Code documents cross-session messaging on macOS
and Linux. Real Claude sessions can use `ListAgents` to find other real Claude
sessions and `SendMessage` to contact them. A target can accept, hold, or
refuse inbound cross-session messages through `crossSessionInbound`. Messages
do not bypass the receiver's tool permissions or approval boundary.

**Best-effort internal boundary:** the installed Claude Code build advertises
live sessions through registry records and transports peer frames over
per-session Unix-domain sockets using peer protocol 1. Those registry and wire
shapes are not documented as a stable third-party integration API. The gateway
therefore validates every consumed field, frame, socket, generation, and
correlated result immediately before use. Unknown top-level registry fields are
tolerated because Embassy never consumes them; malformed required fields and
records whose peer protocol is not 1 remain isolated and counted. Version
metadata describes what was observed but grants no runtime authority.

For the lowest-impedance native path, the gateway publishes one process-owned
registry record whose name is visibly prefixed `codex-` and which carries the
supported explicit versioned Embassy-advertisement marker. The listener remains
gateway-owned and does not claim to be a Claude model session; the marker, not
the name prefix alone, distinguishes Embassy's advertisement. The record uses
the validated native peer shape so Claude's own `ListAgents` and
`SendMessage` tools work unchanged.

Consequences:

- Native Claude `ListAgents` discovers real Claude sessions plus the one
  explicitly marked `codex-*` gateway peer.
- The gateway discovers compatible real Claude sessions as transient
  candidates, but publishes only sanitized aliases and state. A send from a
  registered Codex task addresses a session by its current name or its UUID,
  and the broker installs that session's logical route on this first use.
  Per-message consent stays native: delivery lands in the
  Claude session's own `crossSessionInbound` policy and approval flow.
- Codex aliases are discovered through the gateway CLI/skill, not through
  `ListAgents`.
- A gateway-owned anonymous callback UDS can receive a correlated reply. It
  does not need, and must not create, a Claude registry record.

### Codex

**Official:** Codex App Server is the JSON-RPC interface used by rich Codex
clients. Its Unix-socket transport is WebSocket over a standard HTTP Upgrade.
The documented protocol includes loaded-thread discovery, thread resume,
turn start, turn steer, turn interrupt, and notifications. Embassy exposes
`turn/steer` only behind the exact Claude-to-Codex `STEER:` contract described
below; there is no generic RPC surface.

**Official:** for an SSH project, the ChatGPT desktop app starts the remote
Codex App Server through SSH using the remote user's login shell. Files,
commands, credentials, permissions, plugins, skills, and local tools come from
that execution host. App Server transports should not be exposed directly on
a shared or public network.

**Observed:** this Desktop build connects to a host-local App Server on each
execution host. Remote tasks on `build-mac` do not route through the local App
Server. Desktop reaches the remote listener through an SSH `app-server proxy`.
A second attach-only client successfully initialized against the already-owned
`build-mac` listener and called only `thread/loaded/list` without creating a turn.
The same topology is expected for `lab-mac.example`, but that host has not been
probed by this project.

## Topology

```text
  real Claude sessions (this Mac)
       │  genuine session sockets
       │
       ├──────────────┐
       │              │ callback replies
       ▼              ▼
  ┌──────────────────────── local singleton gateway ───────────────────────┐
  │ private control UDS │ retained bodies  │ metadata state │ public snapshot │
  └──────────┬──────────┴──────────────────┴────────────────┴─────────────────┘
             │
             ├─ local Codex App Server ─ registered native local tasks
             │
             ├─ planned attach-only SSH proxy ─ build-mac App Server
             │
             └─ planned attach-only SSH proxy ─ lab-mac.example App Server

  Claude-side skill/CLI ─ private control UDS ─ gateway
  Codex-side skill/CLI  ─ private control UDS ─ gateway
```

The local singleton is necessary even though user interaction can be packaged
as a skill. A skill runs during an agent turn; it cannot remain discoverable,
hold transient correlation state, accept an inbound socket connection, or
wake a different idle runtime after that turn ends.

## Component status

The status below is intentionally narrower than the target architecture.

| Component | Current evidence |
| --- | --- |
| Neutral gateway types, private-v4 metadata store, bounded attempt state machine, queues, dedupe, rate limits, and public projection | **Implemented**, deterministic tests; message bodies persist under bounded retention |
| Private JSONL control protocol over a controller-owned UDS | **Implemented**, deterministic synthetic tests; no provider connection required |
| Claude registry/peer adapter with strict peer protocol 1 and per-operation validation | **Implemented** and live-tested through Claude Code 2.1.227, including discovery, native status frames, cancellation, and accessible-workspace validation |
| Claude current-user runtime roots | **Implemented**; derives the registry and callback roots from the verified OS user without inspecting a launcher or configuration file |
| Stateless allowlisted Codex App Server transport with bounded busy behavior | **Implemented**; every operation opens and attests its own transport, and the conformance suite covers idle gating, exact `STEER:` behavior, clean retry, and ambiguous no-replay settlement |
| Attach-only local Codex proxy transport and exact-owned cleanup | **Implemented**, five deterministic tests; no live App Server connection in routine tests |
| Local provider adapters and Embassy-node federation | **Implemented**, focused synthetic tests cover Claude discovery, exact Codex ownership, plus bounded catalog reconciliation and destination-owned handoff over the fixed attach-only SSH transport |
| Universal shell peer mailbox | **Implemented**, alias-plus-token same-UID attribution, hash-only durable ownership, bounded long polling, stdout-flush receipts, and restart uncertainty tests; no PID binding, token file, Keychain entry, or daemon |
| Gateway service composition | **Implemented**, including private control-server startup, synthetic cross-provider route installation/dispatch/reply correlation, bounded public-snapshot projection, and restart attempt-phase tests |
| Delivery receipt/status lifecycle | **Implemented**, deterministic synthetic tests cover stable-UUID native receipt re-resolution, the merged/verbose/quiet Claude notice policy, one bounded stall notice with pending age where enabled, opaque private-v5 correlation handles, restart continuity, the closed status/terminal schema, and one-shot/bounded-wait CLI behavior |
| Broker-owned cross-provider provenance framing | **Implemented**, deterministic tests cover exact Codex and Claude wire shapes, bounded long-alias attribution, recipient reply hints, reserved-tag neutralization, single wrapping across clean retries, and pre-write failure |
| Operator/agent client CLI and package binary | **Implemented**, deterministic private-UDS tests cover the closed command family, inherited provider identity, bounded stdin-only bodies, normalized output, and ambiguous no-retry behavior |
| Repo-shipped cross-provider skill | **Implemented** as a repo-scoped workflow over the client CLI; it is not installed into either provider's global configuration |
| Foreground local broker launcher and provider assembly | **Implemented** as `embassy serve`; local-host-only with native messaging enabled |
| Live Codex-to-Claude delivery | **Tested** against real Claude 2.1.224–2.1.226 sessions |
| Claude-initiated Codex turn/reply into Codex | **Tested** with a real busy Codex task: native `busy → waiting`, automatic post-idle turn, terminal delivery status, and exact reply round trip |
| Remote production connector | **Planned**; only the `build-mac` read-only attach feasibility probe is complete |

Synthetic tests do not scan `~/.claude`, connect `/tmp/cc-socks`, attach to a
Desktop App Server, invoke SSH, or make a model request.

## Identity, discovery, and opt-in

Users address Codex routes by strict aliases and Claude routes by either the
session's latest alias or its native session UUID, for example:

```text
codex-reviewer@this-mac
codex-builder@build-mac
codex-release-check@lab-mac.example
claude-advisor@this-mac
123e4567-e89b-42d3-a456-426614174000
```

Claude's native `sessionId` UUID is its sole logical identity. Its current
name is a mutable lookup alias for that UUID; the gateway keeps no historical
name index. A rename therefore makes the old name stop resolving immediately,
while the UUID and an already installed UUID-bound route continue to identify
the same session. PID, registry path, process generation, and socket generation
are replaceable delivery coordinates, not identity, and are refreshed from the
live registry before a write. The gateway rejects duplicate current names and
duplicate live UUIDs rather than choosing between them.

The controller binds a Codex route to an exact host, thread ID, and owner
lease. Other provider-native IDs, PIDs,
working directories, endpoint paths, and socket paths are never public
selectors or output fields. A Claude UUID may be supplied explicitly as a
destination, but the gateway never prints or invents one for the caller.

Codex registration is explicit. A task registers its own alias and
authoritative `CODEX_THREAD_ID`; the gateway does not enumerate global Codex
history to invent routes. Registration performs no provider I/O. Each delivery
opens a fresh attested App Server transport, initializes it, resumes the exact
private task with history excluded, and authorizes one body write. Endpoint or
Desktop restart is therefore a transport fact, not a logical route transition;
an unavailable or duplicate exact task fails that operation with a safe code
without retargeting the alias or replaying an ambiguous write.

Claude discovery is passive and limited to currently advertised genuine
Claude session records. Only a validated native record bearing the supported
explicit versioned Embassy-advertisement marker is classified as a gateway
advertisement and excluded as a Claude destination. A genuine unmarked Claude
session remains selectable even when its current name begins `codex-`.
Discovery produces a bounded, sanitized `availablePeers` inventory keyed for
display by the latest name. The adapter
strictly validates every required and consumed registry field, session UUID,
process identity and liveness, record/socket type, PID and socket-path
correlation, allowed roots, and file/socket generations while tolerating
unknown top-level fields. The existing public Claude connector row may carry
bounded `registry` evidence: `entriesScanned`, `parseableRecords`, monotonic
`parseableRecordSeenSinceBoot`, bounded per-safe-code `rejected`, and
`rejectedCodesOmitted`. A registry directory that has yielded no record with
parseable required fields since broker start is therefore a loud bounded
observation rather than a healthy-looking empty list; if Claude is running,
its registry layout may have changed.
Before that enumeration, the Claude-owned external sessions registry root must
belong to the current UID with exact mode 0700; failure quarantines and
write-fences only Claude. Within an admitted root, individual registry records
and peer sockets retain the schema, file/socket type, PID/path and allowed-root
correlation, accessibility, liveness, and generation checks above without an
invented additional owner or mode rule. A current name resolves to a UUID but
never substitutes for it.

An installed Claude route keeps its UUID as durable identity until a
different session claims its alias and displaces it; there is no operator
command that retires one (deliberate retirement is emb-107's subject).
Discovery publishes only bounded sanitized candidates and current
lookup aliases; it never changes the installed UUID. Immediately before a
Claude-bound write, Embassy performs a fresh bounded registry scan, resolves
that byte-identical UUID exactly once, and revalidates its current workspace,
process, socket, and used-artifact generation. An incomplete scan, duplicate
UUID, changed UUID, or unsafe current coordinate fails that operation closed.
A duplicate display name is fenced from listing and from every send that
addresses it BY NAME, and the fence is re-evaluated inside the
send path, never only on the discovery timer. The fence is a fence on names:
a session UUID is unambiguous, so an operator-supplied UUID remains the
recovery selector and reaches the session even while its name collides, and a
sender whose own display name collides is never silenced, because its identity
was attested rather than typed. A pre-bound route retains its identity-pinned
binding, and a name alone never restores or retargets a durable route.

`embassy status` is the single pane for the human. It shows both sanitized
available and routed Claude aliases and explicitly registered Codex aliases,
including their host, current state, last-seen age, and queue depth. The same
pane also carries the bounded ledger's retained message bodies, so its output is
as sensitive as the messages themselves.
The thin skill/CLI exposes the same safe alias list to either provider.

## Message flows

### Codex to Claude

1. A registered Codex task calls the repo-shipped gateway skill/CLI with its own
   thread identity, source alias, target Claude current name or session UUID,
   and bounded text.
2. The gateway checks thread ownership, selector state, rate and size limits,
   deadline, and dedupe state.
3. It resolves the selector against a discovery scan run inside this send,
   installing the session's route if this is its first use, then refreshes the
   UUID's current process/socket coordinates and revalidates that Claude
   peer's canonical workspace access and exact generation before every send.
4. Immediately before the native write, it composes one broker-owned canonical
   `cross-session-message` textual frame with bounded sender attribution and a
   first-child reply hint containing the full conversation token, exact aliases,
   and reply command. It then opens a short-lived connection and writes one
   peer-protocol-1 frame immediately, regardless of whether the current
   Claude registry observation says `idle`, `busy`, or `waiting`. A reply
   request carries the gateway's own
   anonymous callback UDS as the transport reply address; that path is never
   exposed in the content frame.
5. It records only normalized delivery metadata. It does not retry an
   ambiguous write automatically.
6. A reply received on the callback listener is correlated in memory and
   routed to the owning explicitly registered Codex task.

A Claude-bound peer socket is a native mailbox, not an idle gate. Once the
pre-write route checks pass, Embassy attempts that mailbox write immediately;
an observed busy state never queues the body. `transport_written` proves the
mailbox write and is reduced to terminal `delivered` for this direction. That
still does not prove Claude read, consumed, or acted on the body. The adapter
distinguishes this transport boundary from Claude-to-Codex native `held`, which
is a progress signal only. Neither boundary permits a retry.

### Claude to Codex

This path is enabled for each explicitly registered `codex-*` task. The
gateway publishes a process-owned native registry entry per task, accepts
Claude's native `SendMessage`, starts an App Server turn, and returns the
final reply.

1. The gateway advertises one process-owned `codex-*` record per registered
   task in Claude's native registry. The broker owns the advertisement,
   callback socket, state, queue, and dispatch; provider process lifecycle is
   not persisted as route authority.
2. A real Claude session uses native `ListAgents` and `SendMessage`; the
   gateway validates that exact live registry/socket generation and treats the
   text as untrusted user-role input. This inbound observation grants only a
   transient, in-memory capability for the correlated reply. The sending
   session's own route is installed here, from the exact identity the adapter
   attested, so the Codex task's reply travels the ordinary path; the alias the
   adapter reports must be the one discovery shows for that UUID, and a
   mismatch is refused rather than silently renamed. Installing the route
   authorizes nothing beyond what addressing already implied.
3. The Claude process's inherited messaging-socket value may be accepted as a
   transient reply address after strict validation. Claude Code exports
   `CLAUDE_CODE_MESSAGING_SOCKET` as a raw absolute socket path; the CLI
   converts it in memory to the gateway's internal `uds:` capability. A user
   never sets, prefixes, or passes that value manually. It is never logged,
   persisted, rendered, or copied into normalized events.
4. The gateway resolves the Codex alias to its private exact-thread binding.
5. The resumed task retains its existing native permissions. The gateway does
   not supply policy overrides.
6. Immediately before `turn/start` or `turn/steer`, the delivery attempt wraps
   the raw body once in Embassy's authoritative Codex-bound
   `cross-session-message` frame. It opens and attests a fresh App Server
   transport, resumes the exact task with history excluded, and starts one
   dedicated turn only if the task is idle. Ordinary messages received while
   it is active or awaiting approval remain queued. An exact leading `STEER:`
   body in this direction is marked as a
   steering message. If the connector has a positively observed active turn
   and no RPC already in flight, it sends the closed `turn/steer` request with
   that exact ID as `expectedTurnId`; App Server admits the input at the next
   tool-call boundary. Embassy never calls `turn/interrupt` for this path and
   never injects text mid-generation. A clean non-steerable or unavailable
   boundary silently returns the same body to the normal queue. It does not
   emit Claude's approval-specific native `held` control frame for ordinary
   queueing.
7. In `merged` and `verbose` notice modes, if the delivery remains pending for
   exactly `min(floor(messageDeadlineMs / 2), 120_000)` milliseconds, the
   gateway may send the originating Claude session at most one nonterminal
   `<gateway-delivery-stall>` user frame for that receipt. It contains only an
   allowlisted reason and a bounded `queued-for-ms` age; it is not a native
   `held` receipt and does not settle the delivery. The two-minute ceiling is
   deliberate: stall visibility must not scale with the deadline, so under the
   default four-hour deadline the notice fires at two minutes, not two hours.
   `quiet` suppresses this gateway-authored frame without changing native status
   or public snapshot state.
8. A later bounded attempt opens a new transport and starts the held message
   after it observes the exact task idle. A route retains at most three queued steering
   messages; accepting a fourth atomically cancels the oldest with safe code
   `STEER_QUEUE_SUPERSEDED`, a normal terminal receipt, and a `STEER`-marked
   journal event. Explicit registration is sufficient authorization; Embassy
   does not run an additional workspace or policy classifier.
9. Successful App Server acceptance returns Claude's native `delivered`
   receipt. A route or delivery error returns native `expired` with one safe
   error code retained in its `reason` field. The default `merged` mode omits
   the duplicate terminal user frame; `verbose` additionally sends a static
   `<gateway-delivery-diagnostic>` user frame so the reason is readable in
   Claude Code versions that do not render the native control reason. `quiet`
   also omits gateway-authored stall frames. The diagnostic never contains a
   socket path, session UUID, raw exception, or message body. `denied` is
   reserved for an actual user or policy refusal.
   A transient clean pre-dispatch failure returns the same message to the queue
   instead of terminally failing it.
10. Completion is summarized into bounded normalized state and the correlated
    reply is returned only to the same originating Claude session UUID after
    its current coordinates are uniquely re-resolved and revalidated.

The native receipt retains the originating Claude session's stable UUID, not
its mutable name, PID, registry record, or socket. Before every stall or
terminal receipt write, the adapter performs bounded discovery and revalidates
the UUID's current exact coordinates. This permits a receipt to follow ordinary
process/socket rotation without writing to a stale generation. If the UUID is
not uniquely re-observed with peer protocol 1, the write fails closed. A terminal
write whose outcome is ambiguous is never replayed; only a proven pre-write
failure may be retried while the bounded in-memory receipt remains live. The
receipt correlation does not add the UUID or receipt handle to public output
or durable state; a separately installed route may already persist that same
Claude UUID as its private native route handle.

Delivery callback arrival is timestamped at the service boundary. A terminal
callback observed strictly before its message deadline is applied before the
deadline sweep even when event-loop scheduling delays its worker; a callback
observed at or after the exact deadline cannot reopen the expired attempt.
Shutdown is likewise two-phase: provider ingress is first quiesced so no new
user-message callback can enter and every already admitted callback completes,
while receipt writes remain available. The service then drains callbacks,
terminally settles accepted work, joins its bounded receipt writes, and only
then closes provider adapters. This orders `GATEWAY_SHUTDOWN` receipts ahead of
listener teardown instead of silently dropping late admitted work.

Claude's native peer socket is itself a mailbox, so every Claude-bound body,
including a correlated Codex reply, is written regardless of Claude's observed
busy or idle state. The gateway still serializes its own writes, but it never
waits for Claude to become idle and thereby deadlocks a Claude turn that is
waiting for the reply. This does not change the opposite direction: ordinary
Codex-bound bodies remain idle-gated, and exact leading `STEER:` bodies keep the
next-tool-call-boundary rules above.

### Provenance framing and conversation continuation

The broker classifies `STEER:`, enforces raw-byte body limits, deduplicates,
and queues before presentation framing.
The store therefore retains only the raw unframed body, never the composed
envelope. A pure composer runs at the final semantic provider-write boundary so
a clean retry produces the same bytes with exactly one authoritative outer
wrapper. Provider connection setup and per-operation artifact validation,
receipt frames, and diagnostics do
not use this path.

Both provider directions use Claude-compatible textual framing with a
broker-owned `cross-session-message` outer element and an
`embassy-reply-hint` as the first body element:

- Codex-bound content uses the exact validated source alias as `from-name` and
  the full conversation token as the outer `conversation` attribute.
- Claude-bound content uses only Claude Code's canonical bounded `from-name`
  attribute. For a source alias over 64 characters, the display label is a
  deterministic 47-character prefix, `~`, and 16 hexadecimal SHA-256
  characters. The hint carries the exact source as `from-alias`. The outer
  Claude wrapper intentionally omits `conversation`, which its pinned parser
  does not accept.
- In either direction, the first hint carries the full token in `conversation`
  and the exact recipient alias in `reply-as`, followed by an exact stdin-based
  `embassy send --conversation ... --from ...` instruction and the statement
  that caller, conversation, and route policy are rechecked.

Embassy does not synthesize `from`, `from-session`, or `from-mode` attributes:
those names have provider-native meanings the broker cannot truthfully claim.
Native socket addresses, Codex thread IDs, Claude session UUIDs, endpoint
generations, and route handles never enter the content frame.

The outer structure and hint come only from validated broker metadata. Before
composition, the untrusted body case-insensitively neutralizes boundary-shaped
opening or closing occurrences of Embassy's reserved framing tags by inserting
`\` immediately after the leading `<`.
Everything else remains raw text. This is not general XML, cryptographic
authentication, or proof that the message content is trustworthy; it is a
consistent structural provenance marker at the model input boundary. A native
Claude wrapper already present in an inbound body is untrusted nested text
beneath the Embassy wrapper.

The full token delivered in the hint lets the recipient answer with
`send --conversation`, but it is only a participant-scoped conversation
locator. The service still validates
the inherited caller, current conversation membership, and current route
policy. The full token remains confined to the accepted control result
and transient provider payload, and is memory-only: it is never persisted,
journaled, logged, snapshotted, rendered on a dashboard, placed in a receipt,
or returned from suffix-only public correlation. Formatter,
provenance-metadata, and framed-size failures are clean pre-write terminal
failures; they can never become ambiguous writes or replay authorizations.

The gateway exposes `turn/steer` only through an exact leading `STEER:` body in
the Claude-to-Codex direction. The global `EMBASSY_STEERING_ENABLED` switch is
on by default and exact `0` disables classification. The tested 0.147.0 schema
requires `expectedTurnId`, rejects a nonmatching active turn, reports a clean
`activeTurnNotSteerable` condition, and returns the accepted turn ID. Embassy
validates all of those temporal correlations before settlement. `turn/interrupt`
is never called or exposed, and there is no generic App Server RPC escape
hatch.

### Delivery status and bounded waits

Every accepted control-plane `send`
result contains both its conversation ID and a fresh opaque delivery
correlation handle called a delivery token.
The token has the closed form `dlv_` followed by exactly 24 base64url
characters (`A-Z`, `a-z`, `0-9`, `_`, or `-`). It addresses one bounded
private-v4 message/status row and is not a provider receipt handle or a
provider native identifier. It is stored only in the mode-0600 broker state
and never appears in a public snapshot, normal log, provider receipt, or
dashboard.

The read-only `delivery_status` method accepts only that token and returns one
of these closed results:

- `{ found: false }`; or
- `{ found: true, state, terminal, updatedAt, deadlineAt, ... }`, where `state`
  is one of `queued`, `stalled`, `delivered`, `unconfirmed`, `expired`,
  `failed`, `ambiguous`, or `cancelled`. `terminal` is false exactly for
  `queued` and `stalled`, and true for every other state. `pendingForMs` may
  report the nonnegative age since gateway acceptance, including time spent in
  flight, and `safeErrorCode` may report one shape-constrained broker code.

`updatedAt` and `deadlineAt` are ISO timestamps. A terminal result guarantees
only that this gateway delivery attempt will not transition again. It does not
guarantee a model reply or make an ambiguous outcome safe to retry. A stalled
result is progress only, even after the one sender-visible stall notice when
the configured notice policy permits it.

The CLI exposes `delivery-status --token <token>` for one read and
`wait-delivery --token <token>` for a bounded wait. The waiter uses the same
read-only method every 250 ms, emits only the terminal result, and stops no
later than the delivery deadline plus the control client's 3-second allowance.
An unknown token fails immediately. A wait timeout is not a terminal delivery
state and does not authorize a resend.

`unconfirmed` and `ambiguous` are distinct terminal outcomes. `unconfirmed`
means the transport write itself was confirmed but terminal provider evidence
was never observed; `ambiguous` means the write outcome is unknown. Both are
terminal, neither is a retry authorization, and both exit `6`.

`wait-delivery` exits `0` only for `delivered`. It exits `6` for every other
terminal state (`unconfirmed`, `expired`, `failed`, `ambiguous`, or
`cancelled`) while preserving the exact terminal result in its JSON output. An
unknown token exits `3`; a local bounded-wait timeout exits `4` and is not a
terminal state.

The status table is bounded. Under capacity pressure Embassy evicts only the
oldest terminal correlation handle; active `queued` or `stalled` handles are
never displaced to admit a new send. A pressure-evicted handle returns
`{ found: false }`, just like a handle whose retention window elapsed.

### Replies and process restarts

Conversation IDs correlate replies, and callback addresses exist only in
memory, but message bodies and their bounded attempt phase are durable. After a
gateway restart, queued or reserved work may resume once against the same
logical route. Work that crossed the armed boundary settles
`ambiguous`; provider-accepted work without terminal evidence settles
`unconfirmed`. Neither is replayed. Work already past its deadline settles
`expired`.

The delivery token and status of each retained message survive the restart: a
queued or reserved attempt remains inspectable while it resumes, and armed or
accepted work remains inspectable after it settles ambiguous or unconfirmed.
Pending replies, callbacks, native receipt handles, and conversation
capabilities do not survive. Logical registrations and installed Claude routes
remain, while each subsequent provider operation must attest its
own current transport facts.

## Gateway control plane

The control plane is newline-delimited JSON on one Unix-domain socket inside a
controller-owned mode-0700 state directory. The socket and state files are
mode 0600. Frames are size-bounded and closed against unknown keys, methods,
versions, and enum values.

The closed version 3 method family is exactly these fourteen methods:

- `health` and `list_snapshot`, a safe public snapshot;
- `observe_snapshot`, a read-only projection that may settle already-due
  delivery deadlines before projecting;
- `register_codex` and `unregister_codex` — explicit Codex registration with
  atomic `--succeeds` replacement, and owner unregister;
- `delivery_status`, a lookup by an opaque correlation handle retained only in
  bounded private v5 state;
- `send`, whose direction follows the inherited principal — who is sending —
  rather than the route table, and which installs a discovered Claude
  session's route on its first use. It addresses either a route by name
  (`toAlias`) or an open conversation by its token (`conversationId`), never
  both: the conversation form is the correlated reply operation, and the
  caller must already own one end of that conversation;
- `refresh_discovery`, which rescans for Claude sessions;
- `peer_catalog` and `peer_handoff`, the private federation catalog and
  destination-owned handoff operations; and
- `register_peer`, `unregister_peer`, `await_peer`, and `peer_receipt`, the
  shell-peer registration, mailbox, and flush-before-receipt operations.

The installed binary is `embassy`, and it is the only installed binary. Its
fifteen implemented commands are
`serve`, `service`, `health`, `status`, `delivery-status`, `wait-delivery`,
`refresh`, `register-codex`, `unregister-codex`, `send`,
`reply`, `register-peer`, `unregister-peer`, `await`, and
`peer-stdio`. `reply --conversation <token> --alias <own-alias>` is a
deprecated alias for `send --conversation <token> --from <own-alias>`: it
builds the same `send` request and is kept only until the reply hints already
delivered in older envelopes have aged out. Message bodies are non-empty
UTF-8 from standard input only, with a 16 KiB ceiling; they are never accepted
in an argument or file. The client emits one bounded normalized JSON line, and
for every broker-protocol command it never returns a thread ID,
provider-native ID, path, address, or message body. `service` is the
deliberate exception: managing local files is what it does, so it reports its
own plist path, its log path, and any program path in the plist that is no
longer on disk. Every command but `serve` and `service` requires a running
broker: `serve`
starts one in the current terminal, and `service install|uninstall|status`
manages the macOS launchd agent that runs one, contacting no broker itself
apart from the bounded health check `install` reports at the end. The launcher
never daemonizes itself.

`register-codex --alias <new> --succeeds <current>` is one atomic logical-route
transaction. It verifies the inherited identity of the replacement task,
settles the outgoing route's work according to recorded write phase, removes
its transient capabilities, and publishes only the
new registration. There is no prepared, activated, endpoint-generation, or
manual-recovery state.

`send --to <current-name@host>` and `send --to <uuid>` address the same logical
session, and either form installs its route on first use. UUID
input is normalized to lowercase. No command returns the
UUID, and no historical name remains routable after a rename.

Provider-authorized registration and send operations require one exclusive inherited principal.
Codex registration, unregister, and Codex-to-Claude send require only a valid
`CODEX_THREAD_ID`; they fail if a non-empty Claude messaging socket is also
inherited. Claude-to-Codex send requires only the raw inherited Claude socket
path and fails if a non-empty Codex thread ID is also present. A
conversation-addressed send likewise fails with both identities or neither.

Installing a Claude route is a side effect of a send, not a command: the
sending principal is already attested, the addressed session is resolved
against a discovery scan performed inside that send, and the store binds the
route under the live-peer registration mode. A session already bound under the
same (host, session UUID) keeps its registration — and therefore its in-flight
conversations — and is renamed in place if its display name changed; a route
whose alias now names a different session is displaced, its work settled
`cancelled` with `ENDPOINT_RETIRED`, and both outcomes are journaled so
`embassy status` shows them. Agents are instructed to send only where the user
pointed them; that is an operating norm, not an additional gateway identity
check.

The foreground command is:

```text
embassy serve
```

`serve` takes no options. There is no inbound mode to choose: the broker has
one posture, and it is the OS boundary.

Before provider validation, listener creation, or App Server attachment, the
launcher acquires one fixed host-wide crash-reclaimable owner lease under the
verified login home. The lease is independent of `EMBASSY_STATE_DIR`, so two foreground
controllers cannot be started for the same login account by choosing different
state roots. It is the only instance lock Embassy takes: the pre-rename
prototype state root is no longer read, locked, or mutated.

It emits one normalized ready line and holds the process until `SIGINT` or
`SIGTERM`, when exact-owned resources are
closed. Startup validates exact owned provider paths and binds controller-owned
UDS listeners. Missing optional providers or a provider-local interface failure
degrades only that surface. Unsafe ownership, path, symlink, lease, state,
or generation evidence for Embassy-owned or executed artifacts and Embassy
callback, control, or state paths aborts startup; unsafe UID or mode evidence
on Claude's external sessions registry root quarantines only Claude. The bounded read-only Claude registry
scan records only connector-level schema, rejection, and empty evidence; it
does not publish candidates, select or connect to a peer, write a provider
socket, request provider history, start a model turn, or contact a remote host.
Validated target bindings may retain private native and socket-derived evidence
memory-only until rescan or close, but none enters public state or persistence.
Its ready result reports the exact local host — from `nodes.json`, or this
host's own hostname when that file is absent — and `codexMode: "native_messaging"`
without exposing paths.

There is no arbitrary filesystem operation, shell command, SSH command, App
Server method, Claude registry mutation, credential argument, approval reply,
or raw diagnostic method.

Reaching the same-UID private control socket is the permission to message —
and it is a local containment boundary, not proof of a trusted agent process.
Every mutation additionally checks route ownership, exact
thread/session generation, source alias, bounds, and conversation state. A name
currently shared by more than one live Claude session is refused with
`PEER_ALIAS_COLLISION` inside the send that addressed it BY NAME; the broker
never resolves an ambiguous name by picking first. The fence is a fence on
names only: a session UUID is unambiguous, so a UUID selector still reaches its
session, and a sender is never fenced by its own display name because its
identity was attested rather than typed.

## Codex connectors and remote hosts

Each broker's local connector has an explicit host identity, from `nodes.json` when federating or from this host's own hostname otherwise; `this-mac` has no reserved meaning. Configured peers exchange only body-free local catalogs and destination-owned handoffs over fixed SSH.

The local connector resolves the managed standalone Codex release by exact
owned path; it does not use `PATH`. That installation is separate from
any NVM-managed `codex` on the user's `PATH` (for example
`~/.nvm/versions/node/*/bin/codex`), does not replace
it, and does not edit a shell profile. The two installations therefore do not
conflict.

The stateless transport has a fixed App Server method allowlist. One attempt
may initialize, resume the exact registered task, start a dedicated turn, or
steer the exact positively observed active turn. Loaded-task enumeration,
unsubscribe, interrupt, archive,
delete, history, shell, configuration, authentication, plugin,
approval-response, and generic RPC methods remain excluded everywhere.

The App Server capability first tested with 0.147.0 gates the privacy-preserving
`thread/resume.excludeTurns` field behind initialization capability
`experimentalApi: true`. The transport therefore hard-codes that one
non-configurable capability solely to suppress history retrieval. The attempt's
resume sends exactly `threadId` plus `excludeTurns: true`, then requires an
exact empty `thread.turns` array.
Missing, malformed, or nonempty turns fail closed and are never emitted or
persisted. The capability does not add an experimental client method or change
the closed RPC allowlist.

Registration records the exact inherited task identity and establishes logical
reachability without provider I/O. For each `turn/start`, including a queued
drain, Embassy opens and attests a fresh transport, initializes the closed
interface, resumes that exact task with history excluded, requires it to be
idle, and authorizes one body write with no policy overrides. Version metadata
does not participate. Embassy does not read or retain reported
working-directory or policy fields, and a transport failure cannot discard the
registration or its accepted queue.

Version 1 never changes or independently classifies a Codex task's approval or
sandbox policy. Offline `TurnStartParams` schema evidence from tested App
Server 0.147.0 shows that
policy overrides persist for the current and subsequent turns, so using them
as per-message restrictions would silently mutate the native task. Embassy
therefore starts the turn without overrides and leaves approval, sandbox, and
tool enforcement to the registered task's native Codex configuration. Explicit
`codex-*` registration plus exact per-operation task and transport validation is the
gateway reachability boundary; native task policy remains Codex's concern.

A remote connector never starts, stops, replaces, signals, or unlinks a
Desktop-owned App Server or its socket. If attach fails, the host is offline;
Desktop remains responsible for lifecycle recovery. SSH aliases are fixed
operator configuration, never model-provided strings. Normal OpenSSH host-key
validation applies.

### Completed no-model feasibility evidence

On 2026-08-07:

- A no-model environment check in the current Codex task confirmed that the
  task tool process inherits `CODEX_THREAD_ID` and that its value matches the
  required UUID grammar. The check emitted booleans only and never printed or
  retained the identifier. This validates the repo skill/CLI premise that a
  Codex task can self-register without accepting its private thread ID as a
  command-line argument.
- A local attach-only probe connected through a second proxy to managed Codex
  App Server 0.147.0, initialized, called only `thread/loaded/list`, and
  confirmed the current task was already loaded. It emitted normalized
  booleans and an aggregate count, then confirmed cleanup of only its own
  proxy process.
- An authorized remote probe attached through a second SSH proxy to the
  already-running `build-mac` App Server (remote Codex CLI 0.145.0), initialized,
  and validated a schema-correct `thread/loaded/list`. It printed no task IDs,
  payloads, remote diagnostics, history, or credentials and left Desktop's
  original proxy alive.

Both proxy processes required their exact-owned forced-cleanup fallback after
the bounded graceful-close window; final cleanup was confirmed. These probes
prove attach and loaded-task discovery on the tested versions. They do not
prove notification fanout, approval routing, or writable task control.

The connector requires turn notifications to carry the exact `threadId` and
correlates the exact `turn.id`; `item/completed` must carry the exact
top-level `threadId` and `turnId`. Public protocol examples do not establish
every live notification field. Isolated no-model schema generation from
managed Codex App Server 0.147.0 now confirms that its v2 `TurnStarted` and
`TurnCompleted` notifications require `threadId` plus `turn`, and
`ItemCompleted` requires `threadId`, `turnId`, and `item`; an
`agentMessage` item includes `id`, `text`, and `type`. This clears the
correlation-shape question for exact version 0.147.0 without connecting to App
Server or a provider. Live multi-client notification fanout and writable
behavior remain untested, and any runtime mismatch still fails closed.

The same offline 0.147.0 schema generation confirms that
`TurnStartParams.approvalPolicy` and `sandboxPolicy` are persisted for the
current and subsequent turns. That no-model evidence is why version 1 sends no
seemingly temporary policy override.

Offline 0.147.0 schema generation also confirms that `TurnSteerParams` requires
exact `threadId`, `input`, and `expectedTurnId`; the precondition fails
when that ID is not the current active turn. `TurnSteerResponse` returns the
accepted `turnId`, and the closed App Server error shape includes
`activeTurnNotSteerable`. Embassy validates this schema at its use boundary, delegates the
next-tool-call timing boundary to App Server, treats a clean refusal as normal
queue fallback, and treats malformed or write-ambiguous results as terminally
uncertain without replay.

The one Desktop restart needed for the local shared-App-Server feasibility
test has already been completed. Building, running synthetic tests, starting
the gateway, and a future Claude peer-socket test do
not themselves require another Desktop restart. A provider or Desktop major
upgrade may change an internal interface; strict per-operation checks keep the
responsible route closed if that interface no longer matches. Other providers
remain available. If the attachment mode changes, a supporting release may
require a separately announced controlled restart.

## Persistence and privacy

The private store may retain:

- schema-5 logical registrations with aliases, registration IDs, and exact
  provider-native route handles inside the closed private binding schema;
- bounded messages with explicit `queued`, `reserved`, `armed`, `accepted`, or
  `terminal` attempt phase and normalized activity used for accounting and
  public projection;
- timestamps, counters, dedupe/rate-limit records, and safe error codes.

It also retains message bodies under bounded caps — the queued body of every
undelivered message and the recent delivery ledger's retained bodies, evicted
oldest-first against a 1 MiB budget by default. It must never retain provider
output, tool input/output, raw App Server or Claude frames, stderr, histories,
credentials, Claude registry payloads, or callback/socket paths. The public
snapshot is a
strict projection that removes private route handles, registration IDs, and
operation-local endpoint evidence. The state directory is mode 0700 and state is mode 0600;
provider-native identifiers never enter normalized events, public snapshots,
the dashboard, CLI arguments/output, aliases, logs, or error text. On restart,
logical routes remain unchanged. Queued and reserved bodies
may resume once only after their exact registration authority is
rechecked; armed and accepted work settles without replay. Callback, native
receipt, conversation, and reply capabilities are not reconstructed.

Private schema 5 is the binary's only native store format; the bounded public
snapshot deliberately remains schema version 2. The runtime performs no
migration or best-effort rewrite. An old or unknown private schema refuses with
`GATEWAY_STATE_SCHEMA_UNSUPPORTED` without mutating the state file; the operator
must follow the reset-only runbook in `docs/CONFIGURATION.md`. A malformed
schema-5 document produces the ordinary strict corrupt-state error.

## Minimum filesystem and process access

The production gateway does not need broad home-directory access or the
user's interactive Claude history. The narrow live boundary is:

- read/enumerate only the exact Claude live-session registry directory;
- stat/connect only validated peer sockets inside the exact Claude socket
  directory;
- create and later remove only its exact-owned callback socket inside the
  accessible Claude peer-socket directory, with inode/generation checks;
- create its control socket plus metadata files only inside its
  separate controller-owned mode-0700 state directory;
- attach to explicitly allowlisted Codex App Server endpoints; and
- optionally execute fixed `ssh`/Codex proxy argv for allowlisted hosts, with
  no shell and no model-supplied command or hostname.

It does not read Claude transcripts, settings, project state, credentials,
Keychain, shell history, or unrelated user files. It does not copy, print,
persist, or manipulate authentication material. Routine tests replace all of
the boundaries above with test-owned temporary directories, fake UDS peers,
and fake App Server transports.

### Exact default roots on macOS

Provider setup derives these paths from the current OS user's verified home; it
does not scan the home directory. These are the reviewed
boundaries exercised by the live gateway; routine tests substitute synthetic
paths, peers, and transports:

| Path/capability | Minimum purpose |
| --- | --- |
| `~/.claude/sessions` | Derive from the verified current OS user's normalized home; read/enumerate only live registry JSON during the separately authorized passive-discovery gate, and validate exact records, PIDs, workspaces, and peer sockets used by the current operation. An absent or unsafe root degrades only Claude |
| `/tmp/cc-socks` | At foreground startup, validate the private directory and create/remove only `/tmp/cc-socks/<gateway-pid>.sock` after inode/generation checks; search/stat genuine peers at passive discovery and connect one validated target only at the separately authorized send gate |
| `~/.local/state/agent-embassy/.agent-embassy-state` | Validate or establish the exact ownership marker before creating the fixed host lease; an existing non-empty unmarked root is rejected without mutation |
| `/usr/bin/lockf` and `/bin/cat` | Hold one fixed, non-waiting macOS advisory lease for the foreground controller; the helper receives no shell text, provider data, or model-supplied argument |
| `~/.local/state/agent-embassy/.gateway-host.lock` | Fixed per-login kernel-held lease acquired before provider setup; it remains here even when `EMBASSY_STATE_DIR` is overridden. Its bounded PID/token record is exact-cleanup metadata, not a path-only stale-lock authority; a crash releases the kernel lock and the next foreground process may acquire the existing file |
| `~/.local/state/agent-embassy` (or explicit `EMBASSY_STATE_DIR`) | Default controller-owned store, control UDS, and state lock; an explicit absolute configuration may replace only these state surfaces |
| `~/.codex/packages/standalone` and `~/.codex/app-server-control/app-server-control.sock` | Resolve the exact owned managed Codex binary and attach to the already-running private local App Server; never bootstrap or unlink it |

No grant to `~/.claude/projects`, the rest of
`~/.claude`, Keychain APIs, the full home directory, or
unrelated temporary files is required. Remote-host access is a later,
separately reviewed fixed-SSH-alias capability.

A routed Claude session's workspace may contain the private controller-state
directory. The filesystem root and configured temporary roots are still
rejected as deliberately broad Claude workspaces, and that refusal happens
before any route is installed. The user's home is addressable with the
default controller-state root beneath it. A narrower project directory remains
the preferred least-context setup, but it is not mandatory.

## Failure and upgrade policy

- Provider versions are best-effort metadata and never grant or remove routing
  authority. A session record whose peer
  protocol is not 1 is rejected per record and counted without stopping the
  broker; interface drift degrades only its responsible provider.
- Unsafe ownership, path, symlink, lease, state, or generation evidence for
  Embassy-owned or executed artifacts and Embassy callback, control, or state
  paths refuses broker startup. Unsafe UID or mode evidence on Claude's
  external sessions registry root quarantines only Claude. A malformed message version, required App Server response
  shape, or used-artifact generation fails closed on its current operation.
- Alias collisions, stale ownership leases, PID/socket races, unsafe
  gateway-owned state, unexpected paths, queue overflow, deadline expiry, and ambiguous writes are
  normalized failures, never raw diagnostics.
- A provider disconnect fails or defers only the current operation. The next
  eligible attempt opens and attests a new transport; logical registration
  does not depend on a connector lifecycle.
- The first successful Codex registration locks its exact alias, task, and host
  until that registration is explicitly replaced or unregistered. Exact
  re-registration remains idempotent.
- `register-codex --alias <new> --succeeds <current>`, issued from inside the
  successor task on the same host with its own inherited `CODEX_THREAD_ID`, is
  the one atomic transaction that changes the registered Codex identity. A
  replacement must name the exact current registration on the same host, with
  a different alias and thread. Embassy settles the outgoing registration's
  work from its durable attempt phase, removes its transient
  capabilities, and publishes only the replacement. No conversation, reply
  capability, or queued body transfers to the new identity, and no
  intermediate generation or manual-recovery state exists.
- No ambiguous mutation is retried automatically.
- A queued or reserved body survives process loss under bounded retention and
  may resume once after exact logical authority is rechecked. Armed or accepted
  work settles `ambiguous` or `unconfirmed` and is never replayed.
- A provider or Desktop update that changes an internal interface degrades its
  responsible route while the broker and other providers remain available. A
  Claude record outside peer protocol 1 is rejected per record, and every
  current provider artifact used for an operation is re-attested before effect.

## Validation boundary

Routine validation is deterministic and synthetic: it does not inspect live
provider state, connect a provider socket, attach to App Server, invoke SSH, or
make a model request. The separately authorized local live tests recorded
above established discovery and both message directions. Remote production
connectors remain a separately reviewed future capability.

Only the synthetic layer is routine validation. Server startup,
discovery, and callback binding remain no-send operations; step 4 is the first
provider write. A real provider message is never enabled in CI.

## References

- [Anthropic: Message your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging)
- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Remote connections and SSH hosts](https://learn.chatgpt.com/docs/remote-connections)
