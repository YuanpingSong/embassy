# Security policy

## Supported versions

Security fixes are applied to the latest Embassy release and the `main`
branch. Pre-release prototype versions are not supported.

## Reporting a vulnerability

Please use this repository's private GitHub Security Advisory interface. Do
not open a public issue for a suspected vulnerability.

Reports should contain the smallest synthetic reproduction possible. Do not
include credentials, OAuth material, Keychain data, message bodies, raw model
output, provider histories, local Embassy state, socket addresses, native
session or thread identifiers, or unredacted personal paths.

## Deployment boundary

Embassy is personal software for one macOS user. Each broker remains local to
one machine; an explicit private `nodes.json` may connect the user's own
SSH-reachable machines through the user's existing OpenSSH configuration.
Broker identity always comes from that owned mode-0600 `nodes.json`; when it
is absent, the broker creates it once from this machine's hostname, and that
recorded identity stays as written when the machine is later renamed. Run
every node only under an OS account that is yours alone and where you trust
every process already running as that user. Do not expose Embassy sockets or
state on a network, host it as a service, or use it to share a provider
subscription between users.

The broker is local; the agents are not. Embassy does not call a provider API,
but a delivered body becomes model input in the receiving product and may be
sent to and retained by Anthropic or OpenAI under that product's normal terms
and settings.

## Trust model

Embassy provides same-UID containment and route attribution, not authentication
against other processes running as the same OS user.

- A Codex route is attributed to the exact inherited `CODEX_THREAD_ID` of the
  task that self-registers it. App Server attachment and endpoint generations
  are current transport facts, never durable route authority.
- A Claude route is attributed to a validated live peer generation and native
  session UUID. An inherited `CLAUDE_CODE_MESSAGING_SOCKET` is a transient
  reply capability, not a credential.
- Aliases are labels. They do not grant authority and are re-resolved against
  the exact private route binding before delivery.
- Immediately before provider delivery, Embassy places the body inside one
  broker-owned `cross-session-message` textual frame. Its sender attribution
  and first-child reply hint come from validated broker metadata, not from the
  message body. This is a provenance boundary for the receiving model, not a
  cryptographic signature or authentication against same-UID code.
- Any process already running as the same OS user may be able to present local
  environment or socket capabilities. Embassy is not a sandbox for untrusted
  same-user code.

## What Embassy defends, and what it deliberately does not

Embassy's security boundary is intentionally narrower than “protect this user
from every process this user runs.” The boundary below governs implementation,
review, and audit work.

### What Embassy defends

- **The same-UID OS and artifact boundary for anything Embassy executes or
  treats as identity evidence.** Embassy validates canonical paths, ownership,
  symlink policy, modes, approved version-directory containment, its own state
  and sockets, and the generation of artifacts it owns. Before acting on an
  identity-bearing input—such as an inherited task identity, provider record,
  route, provider record, or reply request—it validates the input's bounded
  shape and its current ownership and correlation. Immediately before an
  effect, the owning transport re-attests every changing path, socket,
  process, interface, target, and generation fact it actually uses. Unsafe
  controller-wide evidence is fatal; this class comprises Embassy-owned or
  executed artifacts and Embassy callback, control, and state paths. The
  Claude-owned external sessions registry root is instead a read-side identity
  source: unsafe UID or mode evidence quarantines and write-fences only Claude,
  with a loud observation, while the broker and other provider stay available.
  A bad provider record, endpoint, or acted-on input is rejected or fenced at
  that artifact rather than accepted on a best-effort basis.
- **Honest provenance at the message boundary.** The broker creates the outer
  `cross-session-message` frame and first-child reply hint from validated route
  metadata, and neutralizes body text shaped like its reserved framing tags
  before composition. Those marks tell the receiver which transport path and
  sender alias Embassy observed. They are not a signature, and every delivered
  body remains untrusted input whose claims and requested actions require the
  receiver's normal judgment, sandbox, and approval policy.
- **Anti-runaway containment.** Queue counts and bytes, message and frame sizes,
  callbacks, conversations, retained bodies, deduplication records, rate
  windows, and deadlines are bounded. Exhaustion rejects, expires, or fences
  work with an explicit result; a bound never creates permission or justifies
  replaying an ambiguous write.

### What Embassy deliberately does not defend

- **Other local software already running as the same user.** Embassy provides
  no local-process authentication and no capability or local-user consent
  boundary against software already operating under that UID. Pair edges encode
  routing consent between agent endpoints; aliases, conversation tokens,
  inherited environment values, private sockets, and same-user file modes do
  not authenticate one same-user process from another.
- **Predictions based on version strings.** A version string is diagnostic
  metadata, never routing authority, security evidence, or attack detection.
  Current path, ownership, protocol, interface, used-artifact generation, and
  correlated operation facts decide what Embassy can safely do. Codex
  registration performs no provider I/O; every delivery proves the current
  boundary independently. Boot refusal is reserved
  for an unsafe or lost singleton lease, corrupt controller state, or an unsafe
  OS boundary. Interface drift or one unavailable optional provider degrades
  that surface; it does not take down the broker or the other providers.

### Audit rule

Every new audit check must cite the sentence in this doctrine that it enforces.
If the proposed check has no supporting sentence here, raise it explicitly as
a doctrine-change proposal, including the product and threat-model consequence,
before adding the check. A test, review finding, or “hardening” patch must not
silently expand Embassy's claimed boundary.

## Routing and consent

- A universal shell peer explicitly registers one `peer-*` alias. Its principal
  is that alias plus a `peer_` token minted and printed exactly once. The token
  is supplied on stdin (or inherited only by a harness with a stable shell),
  compared in constant time, and rechecked immediately before effects. This is
  same-UID attribution, not authentication against other same-user software;
  there is deliberately no PID binding, token file, Keychain entry, or daemon.
- A Codex task must explicitly self-register with a `codex-*` alias before it
  can participate.
- Codex-to-Claude delivery requires an explicit operator-created pair with a
  compatible live Claude session. Discovery alone is never permission to send.
- Every registered `codex-*` peer is visible to every compatible live Claude
  session running as the same OS user, but paired mode accepts only sessions
  holding an explicit pair edge with that exact task. Other senders settle
  terminally with `SENDER_NOT_PAIRED`. `embassy serve --inbound open` is the
  explicit opt-out from pairing.
- Pairs are additive, bounded, and per-edge: adding an edge never retires
  another, and removing one invalidates its active conversation capabilities
  before the change is published. Explicitly requested endpoint replacement
  (`register-codex --succeeds`) is one atomic logical-route transaction: it
  settles the outgoing route's work by recorded write phase, removes its edges
  and capabilities, and publishes only the replacement. There is no prepared,
  activated, re-anchored, or recovery generation and no half-replaced state.
- Embassy never mutates a Codex task's approval or sandbox policy and never
  answers an approval request. An inbound turn uses the task's existing native
  policy. With `approvalPolicy: never`, no human confirmation occurs on that
  path; with an approval-requiring policy, the turn may wait for the user.
- Claude's native `crossSessionInbound` setting controls messages entering a
  Claude session. Embassy cannot override an accept, hold, or refuse decision.
- Delivery scheduling is asymmetric. After routing and pre-write validation,
  Claude-bound bodies are written immediately to Claude's native mailbox
  regardless of an observed busy or idle state; `transport_written` proves the
  mailbox write and settles that direction as `delivered`, not read or
  consumed. Codex-bound ordinary bodies remain idle-gated, and only the exact
  `STEER:` path below can use the active turn's next tool-call boundary.
- A CLI initiator receives the full conversation token in the accepted control
  result, and every routed recipient receives it in the broker-owned first
  `embassy-reply-hint`. The token is a transient participant-scoped locator,
  not sufficient authority: `reply` rechecks inherited caller identity,
  conversation membership, and current routing policy.

Every routed message is untrusted input capable of steering the receiving
agent. Registration and routing control reachability; the provenance marker
does not make the message content or asserted intent trustworthy.

The literal leading `STEER:` prefix is a protocol instruction, not proof of a
trusted author or safe intent. Any exact same-UID Claude sender already allowed
to reach the registered Codex task can use it. The receiver's existing Codex
policy still governs tools and approvals, and an operator who does not want
this timing behavior must set `EMBASSY_STEERING_ENABLED=0` before starting the
broker.

## Process and protocol boundary

- The launcher is foreground and macOS-only. Provider attestation and the
  control plane remain machine-local. Configured federation owns only a fixed
  outbound `ssh ... embassy peer-stdio` subprocess; SSH supplies transport
  authentication, encryption, and liveness, and Embassy opens no federation
  listener.
- Before provider setup, the launcher acquires one host-wide macOS advisory
  lease. If its lease helper exits or the lease is otherwise lost
  unexpectedly, Embassy shuts down rather than continuing without singleton
  ownership.
- The control plane is a private Unix-domain socket in a controller-owned
  mode-0700 state directory. `embassy serve` has no TCP or HTTP listener; its
  only listeners are private Unix-domain sockets.
- Provider startup validates exact OS ownership, path, symlink, lease, state,
  and generation evidence. Unsafe evidence for Embassy-owned or executed
  artifacts and Embassy callback, control, or state paths refuses broker
  startup; unsafe UID or mode evidence for Claude's external sessions registry
  root quarantines only Claude. A provider version is best-effort diagnostic
  metadata and carries no routing authority. Runtime authority comes from an
  explicit pair, exact owned route and session identity, current
  per-operation transport facts, strict protocol handling, and correlated
  operation results.
  A Claude record whose peer protocol is not 1 is rejected in isolation and
  included in bounded rejection evidence. Every Codex endpoint used by a
  delivery must negotiate its current interface and resume the exact task
  before that operation receives final write authorization.
- Embassy publishes at most one process-owned `codex-*` record in Claude's
  registry with the supported explicit versioned Embassy-advertisement marker.
  The prefix is a visible alias convention, not the discriminator: an unmarked
  genuine Claude session named `codex-*` remains discoverable. Embassy creates
  one callback socket and removes only exact-owned artifacts whose generation
  still matches during graceful shutdown.
- App Server methods are allowlisted. Connectors expose no archive, deletion,
  shell, configuration, authentication, plugin, history, approval-response, or
  generic RPC method.
- `turn/steer` is reachable only for an exact leading `STEER:` body in the
  Claude-to-Codex direction, with an exact observed active-turn ID. App Server
  admits it at the next tool-call boundary; Embassy never interrupts or injects
  mid-generation. Clean boundary refusal falls back to the normal queue, which
  retains at most three steers per route. The environment kill switch defaults
  on and can disable this classification globally. Embassy never issues
  `turn/interrupt`.
- The tested App Server 0.147.0 initialization enables `experimentalApi: true`
  solely for `thread/resume.excludeTurns: true`. It adds no general
  experimental method or authority. Missing, malformed, or nonempty returned
  turns fail closed and are never retained.
- Queues, frames, bodies, callbacks, deadlines, deduplication,
  rate limits, and transient conversations are bounded. Ambiguous writes are
  never retried automatically.
- A peer catalog contains only bounded, body-free local metadata. It never
  exports imported rows, message or conversation tokens, native identifiers,
  provider frames, sockets, paths, credentials, or raw diagnostics. Each
  destination broker owns its durable queue; loss after a federated write is
  UNKNOWN and is never replayed.
- Raw-body classification and accounting happen before framing. In the
  untrusted body only, Embassy case-insensitively neutralizes boundary-shaped
  opening or closing copies of its reserved framing tags before composing the
  real outer frame. Framing or size failure occurs before provider write and is
  never an ambiguous write.
- Embassy creates no network listener at all. Everything enumerated above
  concerns `embassy serve`.

## Filesystem boundary

Controller-owned state is a dedicated mode-0700 directory. Its files and
control socket are mode 0600 and validated against replacement, symlinks, and
unexpected ownership or permissions. Those files include message content:
the durable queue and the bounded recent-delivery ledger both retain message
bodies, so the state file holds mail at rest and not metadata alone. Anything
already running as the same OS user can read it.

The host-wide singleton has one fixed surface under the verified login home:
the private mode-0700 `~/.local/state/agent-embassy` directory and its mode-0600
`.gateway-host.lock`. Neither `EMBASSY_STATE_DIR` nor `XDG_STATE_HOME` relocates
that lease. Embassy executes the exact `/usr/bin/lockf` and `/bin/cat` helpers,
without a shell, to hold the kernel lease for the foreground process lifetime.
The lock file is retained and reused across restarts; process exit releases the
kernel lock.

Embassy's provider-facing access is intentionally enumerable:

- derive the fixed Claude registry and callback roots from the verified current
  OS user, without reading a Claude launcher or configuration file;
- read the live Claude session registry and validate only the registry record,
  peer socket, PID, workspace, state-root, and generation evidence used by the
  current operation;
- create and later remove its one callback socket and one registry record;
- resolve the managed Codex installation and open one attested local App Server
  connection per operation; and
- inspect canonical filesystem metadata needed to validate provider-advertised
  endpoints and generations.

The Claude-owned external sessions registry root must be owned by the current
UID with exact mode 0700 before Embassy enumerates it; failure quarantines and
write-fences only Claude, including when that registry root is absent. Within
an admitted root, individual registry records
and peer sockets retain their bounded schema, file/socket type, PID/path and
allowed-root correlation, accessibility, liveness, and generation checks.
Embassy invents no additional owner or mode rule for those individual
provider-owned artifacts.

Embassy does not need or intentionally read credentials, Keychain items,
Claude project history, Codex or Claude transcripts, shell history, or provider
configuration contents. Report a bug if any normal code path attempts to do so.

## Persistence and disclosure

Raw provider frames, tool data, stderr, callback addresses, and socket paths
remain memory-only and are discarded on restart. Message bodies are the
exception: queued and recently delivered bodies are retained under bounded caps
in the mode-0600 state file. A queued or reserved message may resume once after
a broker restart against its still-exact logical route and consent edge. An
armed or accepted message at crash settles ambiguous or unconfirmed and is
never replayed.

For a shell peer, durable route ownership stores only
`peer:<sha256(uid NUL alias NUL token)>`; the raw peer token and private mailbox
receipts never enter state, logs, snapshots, or routed frames.
Pending waiters, acknowledgements, and the bounded exact-duplicate receipt
tombstone are memory-only. A restart therefore cannot falsely confirm a
stdout write whose acknowledgement was not observed.

The full `conv_` token exposed to a CLI initiator or routed recipient travels
only inside the accepted CLI result or transient provider payload. It is never
persisted, journaled, logged, placed in a receipt, or projected through public
events or snapshots; public metadata may retain only an existing
non-reconstructable suffix. Broker-owned marker fields
introduce no socket paths, Codex thread IDs, Claude session UUIDs, endpoint
generations, or private route handles. The untrusted body remains opaque text
and may itself contain sender-provided strings.

The closed private binding store may retain the exact Codex thread ID and Claude
session UUID required for logical ownership. Native IDs are
forbidden from public snapshots, normalized events, aliases,
logs, errors, and CLI output. A Claude UUID may enter only as a user-supplied
explicit CLI selector; Embassy never discovers or prints it publicly.

## Validation boundary

Routine tests use temporary directories, fake peers, and fake App Server
transports. They do not inspect live provider state or contact a model.

Broker/provider startup owns bounded validation of configured installations and
exact OS boundaries. Unsafe Embassy-owned or executed artifacts, callback,
control, or state paths remain startup-fatal; unsafe UID or mode evidence on
Claude's external sessions registry root quarantines only that provider.
Runtime derives no authority from version metadata. It reports best-effort connector health, observation
freshness, and last safe codes while strict record, frame, response, identity,
current used-artifact generation, correlation, and deadline checks decide each
operation. Claude registry parsing remains strict for every required and
consumed field while ignoring unknown top-level fields; bounded rejected-record
counts and an observed-empty registry are surfaced instead of hidden. Each
Codex delivery independently attests, connects, initializes, and resumes the
exact registered task before its final write authorization. No observation
traffic routes a user message or starts a model turn.

Passive live discovery, a live provider connection, a native message, and an
App Server turn are distinct authorization gates. Each requires an explicit
user request for that operation. Never infer permission for a live send from a
previous smoke test, and never enable live provider traffic in CI.
