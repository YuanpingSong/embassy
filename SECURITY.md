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
- Any process already running as the same OS user may be able to present local
  environment or socket capabilities. Embassy is not a sandbox for untrusted
  same-user code.

## Routing and consent

- A Codex task must explicitly self-register with a `codex-*` alias before it
  can participate.
- Codex-to-Claude delivery requires explicit operator selection of a compatible
  live Claude session. Discovery alone is never permission to send.
- The one registered `codex-*` peer is visible to every compatible live Claude
  session running as the same OS user. An exact native Claude sender may reach
  it without becoming selected for the opposite direction.
- Embassy never mutates a Codex task's approval or sandbox policy and never
  answers an approval request. An inbound turn uses the task's existing native
  policy. With `approvalPolicy: never`, no human confirmation occurs on that
  path; with an approval-requiring policy, the turn may wait for the user.
- Claude's native `crossSessionInbound` setting controls messages entering a
  Claude session. Embassy cannot override an accept, hold, or refuse decision.

Every routed message is untrusted input capable of steering the receiving
agent. Registration and selection control reachability; they do not make the
message content trustworthy.

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
- Provider protocols are version-pinned. Unknown Claude Code peer or Codex App
  Server versions, schemas, and endpoint generations fail closed.
- Embassy publishes at most one visibly prefixed, process-owned `codex-*`
  record in Claude's registry. It creates one callback socket and removes only
  exact-owned artifacts whose generation still matches during graceful
  shutdown.
- App Server methods are allowlisted. Embassy exposes no archive, deletion,
  shell, configuration, authentication, plugin, history, approval-response, or
  generic RPC method.
- `turn/steer` is excluded. Queueing is the busy policy. Interrupt is limited
  to an exact turn started and positively observed by the same connector.
- Exact App Server 0.147.0 initialization enables `experimentalApi: true`
  solely for `thread/resume.excludeTurns: true`. It adds no general
  experimental method or authority. Missing, malformed, or nonempty returned
  turns fail closed and are never retained.
- Queues, frames, bodies, callbacks, deadlines, hop counts, deduplication,
  rate limits, and transient conversations are bounded. Ambiguous writes are
  never retried automatically.
- The only network listener Embassy can create belongs to the opt-in
  `embassy dashboard --live` companion, described under "Live companion
  boundary". Everything enumerated above concerns `embassy serve`.

## Filesystem boundary

Controller-owned state is a dedicated mode-0700 directory. Its files and
control socket are mode 0600 and validated against replacement, symlinks, and
unexpected ownership or permissions.

The host-wide singleton has one fixed surface under the verified login home:
the private mode-0700 `~/.local/state/agent-embassy` directory and its mode-0600
`.gateway-host.lock`. Neither `EMBASSY_STATE_DIR` nor `XDG_STATE_HOME` relocates
that lease. Embassy executes the exact `/usr/bin/lockf` and `/bin/cat` helpers,
without a shell, to hold the kernel lease for the foreground process lifetime.
The lock file is retained and reused across restarts; process exit releases the
kernel lock.

Embassy's provider-facing access is intentionally enumerable:

- read and execute the configured Claude launcher only for bounded exact-version
  attestation;
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

Message bodies, prompts, replies, raw provider frames, tool data, stderr,
callback addresses, and socket paths remain memory-only. They are discarded on
restart and never replayed.

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

`embassy dashboard --live` binds a read-only HTTP listener on `127.0.0.1` with
an ephemeral port. It is a separate foreground process from `embassy serve`.
Access requires a one-use 256-bit URL-fragment token exchanged for a
path-scoped `HttpOnly` `SameSite=Strict` session cookie. The exact Host header
is checked on every request; navigation GETs permit a missing Origin and carry
no sentinel, while non-navigation POSTs require the exact Origin plus the
`X-Embassy-Request` sentinel. There are no CORS headers, no
mutation or provider routes, no storage, no telemetry, and no external assets.
The browser receives a read-only sanitized metadata snapshot and has no
authority to register, select, send, reply, approve, or interrupt. Any process
running as your OS user — including root and browser extensions with local
filesystem access — can read what the browser can read.

The bootstrap URL, including its one-use capability, is written to a mode-0600
`bootstrap.html` inside a fresh mode-0700 run directory under the private state
root and removed when the companion exits; treat that directory with the same
care as the rest of the state root.

Reports involving the live companion are in scope if they demonstrate a path by
which a remote origin, a cross-site request, or a process running as a
different OS user can read the authenticated stream or bypass the token-to-cookie
exchange. Same-UID local reads are within the documented containment model and
are not treated as vulnerabilities unless they bypass an explicit control such
as accessing a session without presenting the cookie.


## Validation boundary

Routine tests use temporary directories, fake peers, and fake App Server
transports. They do not inspect live provider state or contact a model.

Passive live discovery, a live provider connection, a native message, and an
App Server turn are distinct authorization gates. Each requires an explicit
user request for that operation. Never infer permission for a live send from a
previous smoke test, and never enable live provider traffic in CI.
