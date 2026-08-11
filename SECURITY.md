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

Embassy is personal, same-machine software for one macOS user. Run it only
under an OS account that is yours alone and where you trust every process
already running as that user. Do not expose its sockets or state directory on a
network, host it as a service, or use it to share a Claude or Codex subscription
between users.

The broker is local; the agents are not. Embassy does not call a provider API,
but a delivered body becomes model input in the receiving product and may be
sent to and retained by Anthropic or OpenAI under that product's normal terms
and settings.

## Trust model

Embassy provides same-UID containment and route attribution, not authentication
against other processes running as the same OS user.

- A Codex route is attributed to the exact inherited `CODEX_THREAD_ID` of the
  task that self-registers it.
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

## Routing and consent

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
  (registration succession) atomically settles the outgoing endpoint's
  accepted work before the replacement is exposed; a half-replaced
  intermediate state is never published.
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

- The v1 launcher is foreground, macOS-only, same-machine, and local-host-only.
- Before provider setup, the launcher acquires one host-wide macOS advisory
  lease. If its lease helper exits or the lease is otherwise lost
  unexpectedly, Embassy shuts down rather than continuing without singleton
  ownership.
- The control plane is a private Unix-domain socket in a controller-owned
  mode-0700 state directory. `embassy serve` has no TCP or HTTP listener; its
  only listeners are private Unix-domain sockets. The opt-in
  `embassy dashboard --live` companion is a separate process with its own
  loopback HTTP listener — see "Live companion boundary" below.
- Provider protocols are exact-version-pinned. Provider startup automatically
  validates the release's reviewed Claude launcher/runtime, Claude peer-version
  inventory and protocol, and Codex App Server version. Unknown versions or
  required schemas fail closed. Every replacement Codex endpoint generation
  starts monitor-only and remains write-fenced until its fresh initialize and
  exact-task listing checks pass and the controller activates it.
- Embassy publishes at most one visibly prefixed, process-owned `codex-*`
  record in Claude's registry. It creates one callback socket and removes only
  exact-owned artifacts whose generation still matches during graceful
  shutdown.
- App Server methods are allowlisted. Embassy exposes no archive, deletion,
  shell, configuration, authentication, plugin, history, approval-response, or
  generic RPC method.
- `turn/steer` is reachable only for an exact leading `STEER:` body in the
  Claude-to-Codex direction, with an exact observed active-turn ID. App Server
  admits it at the next tool-call boundary; Embassy never interrupts or injects
  mid-generation. Clean boundary refusal falls back to the normal queue, which
  retains at most three steers per route. The environment kill switch defaults
  on and can disable this classification globally. Interrupt remains limited to
  an exact turn started and positively observed by the same connector.
- Exact App Server 0.147.0 initialization enables `experimentalApi: true`
  solely for `thread/resume.excludeTurns: true`. It adds no general
  experimental method or authority. Missing, malformed, or nonempty returned
  turns fail closed and are never retained.
- Queues, frames, bodies, callbacks, deadlines, deduplication,
  rate limits, and transient conversations are bounded. Ambiguous writes are
  never retried automatically.
- Raw-body classification and accounting happen before framing. In the
  untrusted body only, Embassy case-insensitively neutralizes boundary-shaped
  opening or closing copies of its reserved framing tags before composing the
  real outer frame. Framing or size failure occurs before provider write and is
  never an ambiguous write.
- The only network listener Embassy can create belongs to the opt-in
  `embassy dashboard --live` companion, described under "Live companion
  boundary". Everything enumerated above concerns `embassy serve`.

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

- read and execute the configured Claude launcher only for bounded automatic
  exact-version validation;
- read the live Claude session registry and connect validated peer sockets;
- create and later remove its one callback socket and one registry record;
- resolve the managed Codex installation and attach to the already-running
  local App Server; and
- inspect canonical filesystem metadata needed to validate provider-advertised
  endpoints and generations.

Claude-owned registry files and peer sockets are accepted according to actual
filesystem accessibility plus bounded schema, type, PID/path correlation,
liveness, and generation checks. Embassy does not treat provider-owned Unix
owner or mode bits as an additional routing policy.

Embassy does not need or intentionally read credentials, Keychain items,
Claude project history, Codex or Claude transcripts, shell history, or provider
configuration contents. Report a bug if any normal code path attempts to do so.

## Persistence and disclosure

Raw provider frames, tool data, stderr, callback addresses, and socket paths
remain memory-only and are discarded on restart. Message bodies are the
exception: queued and recently delivered bodies are retained under bounded caps
in the mode-0600 state file, so queued mail survives a broker restart and
re-sends exactly once when its route is re-observed. A message in flight at the
moment of a crash settles `ambiguous` and is never replayed.

The full `conv_` token exposed to a CLI initiator or routed recipient travels
only inside the accepted CLI result or transient provider payload. It is never
persisted, journaled, logged, placed in a receipt, projected through public
events or snapshots, or rendered on either dashboard; public metadata may
retain only an existing non-reconstructable suffix. Broker-owned marker fields
introduce no socket paths, Codex thread IDs, Claude session UUIDs, endpoint
generations, or private route handles. The untrusted body remains opaque text
and may itself contain sender-provided strings.

The closed private binding store may retain the exact Codex thread ID and Claude
session UUID required for ownership and endpoint re-observation. Native IDs are
forbidden from public snapshots, normalized events, the dashboard, aliases,
logs, errors, and CLI output. A Claude UUID may enter only as a user-supplied
explicit CLI selector; Embassy never discovers or prints it publicly.

The static dashboard is two atomically rewritten mode-0600 files, not a web
application: `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html`, both
written on every publish and cross-linked in the page. They contain allowlisted
metadata only and have no JavaScript, external assets, storage, telemetry,
mutation endpoint, or self-refresh. Any process already running as the same OS
user can read them.

### Live companion boundary

`embassy dashboard --live` binds exact `127.0.0.1` on one stable port: `41961`
by default, or the integer from the per-invocation `--port <n>` option (1024
through 65535). It is a separate foreground process from `embassy serve` and
serves the direct root URL `http://127.0.0.1:<port>/`. Multiple windows and
browsers may use that URL while the companion runs. If the port is occupied,
startup fails with `LIVE_DASHBOARD_PORT_IN_USE`, points to `--port`, and never
falls back to another port.

The live companion has no login, capability token, URL fragment, cookie,
browser session, random instance path, or bootstrap file. Its intended posture
is one operator and software already trusted under that operator's macOS UID.
The HTTP listener deliberately does not authenticate processes or OS users,
so this is a trusted single-user-machine assumption, not a same-UID
enforcement mechanism: any local software that can reach or spoof loopback can
read retained message bodies from the live view and invoke its bounded actions.

The exact Host header is checked on every request. Navigation GETs may omit
Origin; every POST requires the exact Origin plus
`X-Embassy-Request: 1`. `OPTIONS` is rejected and no CORS headers are sent.
Those checks block ambient cross-origin browser requests but do not authenticate
local software. There are no generic control or provider routes, telemetry, or
external assets. The sole mutation route accepts only exact pair, unpair,
refresh-discovery, and broker-guarded stale-Codex-registration-removal JSON
bodies, capped at 1 KiB and six confirmed actions per minute. The browser
cannot create a registration, live-unregister a task, send, reply, approve,
interrupt, change settings, or invoke arbitrary broker/provider methods.

Reports involving the live companion are in scope if they demonstrate a
non-loopback bind, a bypass of the documented Host/Origin/sentinel action
guards from a browser origin, or authority beyond the four allowlisted
actions. Access by local software or another local UID is within the documented
trusted-machine model and is not itself treated as an authentication bypass,
because this surface intentionally has no such authentication boundary.


## Validation boundary

Routine tests use temporary directories, fake peers, and fake App Server
transports. They do not inspect live provider state or contact a model.

Compatibility admission is automatic and exact-pinned. Broker/provider startup
owns the bounded read-only validation of the configured installations, exact
versions, protocol constants, and required schemas; an unknown same-major build
is not admitted. These checks do not route a user message or start a model
turn. A replacement Codex endpoint generation receives its own fresh
monitor-only initialize and exact-task listing check, while the write gate
stays closed until controller activation. Runtime record, frame, response,
identity, generation, and deadline checks remain mandatory after admission.

Passive live discovery, a live provider connection, a native message, and an
App Server turn are distinct authorization gates. Each requires an explicit
user request for that operation. Never infer permission for a live send from a
previous smoke test, and never enable live provider traffic in CI.
