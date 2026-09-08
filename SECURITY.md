# Security policy

## Supported versions

Security fixes are provided for the current release line. The CLI and broker
must come from one installation, and federated peers must run the same
federation protocol.

## Reporting a vulnerability

Open a private security report with the repository owner. Do not put message
bodies, credentials, native identifiers, socket paths, provider histories, or
raw diagnostic output in a public issue.

## Deployment boundary

Embassy is a personal, same-user gateway for user-owned Macs. The broker is a
foreground process or a per-user launchd agent. It has one private Unix-domain
control socket and no TCP or HTTP listener. Cross-machine delivery is an
outbound `/usr/bin/ssh` process to another explicitly configured Embassy
gateway.

The design assumes the login account and machines are trusted. It does not turn
one Unix user into multiple security principals, sandbox an untrusted agent, or
provide hostile multi-user isolation.

## What Embassy defends, and what it deliberately does not

### What Embassy defends

Embassy defends the boundary between model-authored content and authority to
address or write to a live session. A body, alias, provider response, catalog
row, or persisted field cannot grant that authority by itself. Authority comes
from the current same-user process boundary, an exact endpoint identity,
owned private state, and fresh per-operation transport attestation.

Specifically, Embassy defends:

- exact Claude session and Codex task identity across alias changes;
- refusal rather than guessed routing when a name is absent or ambiguous;
- one bounded, private state document with atomic replacement and strict schema
  validation;
- per-operation ownership, path, protocol, and artifact checks before every
  native write;
- bounded bodies, queues, batches, deadlines, rates, in-flight operations, and
  retained evidence;
- a durable `queued` → `reserved` → `armed` → `accepted` → `terminal` phase law
  that never replays an uncertain write;
- structural provenance framing and identity-bound replies;
- authenticated, direct SSH handoff with a destination-owned queue and no
  post-commit retry;
- redaction of native IDs, addresses, credentials, histories, raw frames, and
  bodies from public status and errors;
- retirement and replacement that settle incident work without moving it to a
  different endpoint.

Every proposed audit check or hardening rule must enforce one of these stated
boundaries. A new boundary requires an explicit product decision; it must not
arrive disguised as a regression test.

### What Embassy deliberately does not defend

Embassy does not defend against the login user, root, a compromised user-owned
machine, the user's SSH configuration, or the provider applications
themselves. It does not cryptographically authenticate text inside a provider
conversation, prove a model read or understood a message, or make aliases
permanent identifiers.

Configured gateways belong to one same-user trust domain. A plain SSH login
is sufficient for federation; Embassy does not require a forced command or
dedicated per-node key and does not independently authenticate a logical host
label. A copied `nodes.json` with the wrong allowed `host` can therefore
misattribute a message's machine of origin. Correct host labels are trusted
operator configuration, not a separately attested property.

Provider availability and version metadata are observations, not authority.
`embassy health` proves the local broker control path. `embassy check` proves
the broker's ledger/coordinator/receipt loop without a live agent. Neither is a
provider readiness, model comprehension, or cross-machine proof.

The textual provenance envelope is a structural marker, not a signature. A
recipient must treat user-supplied text inside it as untrusted content. Embassy
neutralizes reserved envelope tags but does not sanitize general prompts.

## Identity and routing

An endpoint's opaque `(ID, host, provider)` tuple is routing authority. Its
`name@host` alias is a current lookup index. A name is resolved once before
admission; writes, replies, restart recovery, and settlement use the tuple.
Historical names never resolve, and queued work is never silently rebound.

Codex agents are discovered from bounded same-user App Server metadata. Their
immutable native thread IDs remain private identity and are never accepted as
arguments, printed or guessed. Native names are mutable aliases; only the
recency top 20 roots are automatically listed. A task may
self-register from inherited `CODEX_THREAD_ID` as a fallback; discovery and
registration reconcile the same identity. Each operation resumes and attests
that exact task immediately before write.

Claude callers are resolved from inherited `CLAUDE_CODE_MESSAGING_SOCKET`,
which must be an absolute path. The path may become an in-memory `uds:`
capability only; it is never a CLI argument, public output, or persisted field.
Claude native session UUIDs are stored only in closed private route state.
Discovery accepts only compatible interactive/background same-user records and
checks the exact record and socket again before use. If a restart leaves multiple
live records for one session UUID, zero-byte socket probes select the newest
reachable process (OS start time, then registry start time and PID for ties).
Every write rechecks that choice and the prepared process/socket generation;
a changed choice refuses before writing. Duplicate PIDs are operator diagnostics,
not additional session identities.
An incomplete bounded registry scan cannot prove the newest process; prepared
writes defer until a complete scan can revalidate the choice.

Aliases may collide in discovered Claude state. In that case name lookup
refuses; user-supplied exact UUID selection can identify a Claude target, but
Embassy never publishes a UUID. A retired or replaced endpoint remains fenced
while its bounded retirement evidence is retained. A live Claude session may
re-enroll immediately with a fresh opaque ID, even with the same native UUID;
old deliveries and reply references remain fenced to the retired ID. Codex's
native-identity retirement fence is unchanged. Public
endpoint IDs can select exact local operator retirement without exposing a
native ID or authorizing remote mutation.

A remote peer's claimed host must be named in `nodes.json`; the claim and its
source tuple and alias are trusted within the SSH login boundary. The message's
source host must match the claim, so first contact does not rely on a
previously polled catalog. Catalogs are bounded memory-only
caches and are never write authority. `refresh` may replace a successful
node's rows or retain its last timestamped rows with
`PEER_TUNNEL_UNAVAILABLE`; `status` reads that observation without network I/O.
Named and exact routing still queries the owner.

## Delivery and uncertainty

One transaction admits a message. One coordinator reserves a bounded FIFO
batch for one exact destination and delivery class. Provider I/O occurs outside
the state transaction; authorization then revalidates the exact prepared bytes
and every locally owned endpoint ID, alias, and native handle under the
transaction immediately before the write.

Only a positive no-write result may return work to the queue. Reserved work may
recover after a process restart. Armed work becomes `ambiguous`; accepted work
becomes its recorded `ambiguous` or `unconfirmed` loss result. Neither is
replayed. A late callback cannot overwrite a terminal result.

The broker persists message bodies and opaque delivery/conversation values only
inside the bounded private ledger. It does not persist provider histories,
provider output, raw frames, tool data, callback sockets, or credentials.
Recent terminal delivery and retirement evidence is bounded by count, bytes,
and time; it is not a general analytics journal.

`STEER:` is recognized only as an exact leading prefix from Claude to Codex.
It targets the exact already-accepted operation at a safe tool-call boundary,
never interrupts a generation, and falls back to the ordinary bounded queue
when cleanly unavailable. Embassy never calls `turn/interrupt`, answers an
approval, or changes a task's approval or sandbox policy.

Ordinary Codex work is started only after an immediate idle-status observation;
active work remains queued in Embassy. A competing client can start a turn
between that observation and Embassy's write, and the provider response cannot
distinguish the resulting steer from a fresh turn. The receipt therefore proves
acceptance and lifetime, not fresh-turn creation. This residual race is the same
for discovered and fallback-registered tasks and never authorizes replay.

## Filesystem and process boundary

The state directory is a current-user-owned mode-0700 real directory. State and
configuration files are mode-0600 regular files. Reads and writes reject
symbolic links, ownership changes, mode changes, inode swaps, oversized data,
and unsupported schema. Atomic persistence uses an exclusive private temporary
file, file sync, rename, and directory sync. An unknown commit outcome poisons
the running store rather than guessing.

One fixed host-wide kernel lease is acquired before provider setup. Changing
`EMBASSY_STATE_DIR` does not create permission to run a second broker. The
control socket is accepted only at the expected private path with current-user
ownership and exact socket type. Mutating control requests that lose a reply
after write report an ambiguous outcome and are not retried.

The launchd agent records absolute executable paths, nonempty `EMBASSY_*`
values, and `XDG_STATE_HOME`. It copies no other shell state or arbitrary
`PATH`; operators must not place secrets in an `EMBASSY_*` variable.
`embassy serve` stays foreground and does not daemonize.

`embassy skills install` is the one command that writes outside the state
directory. It writes only `~/.claude/skills/embassy-peer` and
`~/.codex/skills/embassy-peer`, after checking that `HOME`, each parent
directory and each destination is a real, current-user-owned path rather than
a symbolic link; files are opened without following links, written to a
private temporary file and renamed into place with mode 0600, and unrelated
files in those directories are left alone. It does not contact the broker or
read any provider configuration.

Claude registry failures quarantine Claude operations rather than authorizing a
guess. Embassy validates each consumed peer-protocol-1 field while tolerating
unknown top-level registry fields. Unsafe controller-owned state may refuse the
whole broker because its ownership is the broker's authority boundary.

## SSH boundary

Federation is direct and configured statically. Embassy runs the exact system
SSH client with batch mode, no TTY, no forwarding, no agent forwarding, no
local command, no tunnel, and no shell interpolation. Only the current user's
`HOME`, `USER`, `LOGNAME`, and `SSH_AUTH_SOCK` are forwarded to the process.
SSH establishes the trusted login using the user's configuration. Embassy's
correlated protocol checks protocol version, configured membership of the
peer's claimed host, and matching source hosts in handoffs. It does not inspect
how SSH authentication was performed or prove that the host label identifies
the physical machine that opened the connection.

The destination validates and durably enqueues a handoff before returning
acceptance. Only a protocol-proven pre-enqueue refusal is definite. Process
death, malformed data, wrong correlation, transport loss, and failure after the
commit boundary remain uncertain and are never replayed automatically.

## Public disclosure boundary

Public JSON is a closed projection. It may contain opaque Embassy endpoint IDs,
aliases, providers, hosts, queue depths, safe codes, phases/outcomes, ages,
recent retirement times, and bounded remote catalog rows and observation times.
Codex rows may additionally contain the observed busy, waiting, idle, dormant,
systemError or unknown state. The explicit-registration retention marker
remains private.
Duplicate Claude session warnings may expose the selected and stale process PIDs
with the public alias, bounded to 128 warnings and 4096 PIDs. They disclose no
native session UUID or socket path; partial scans retain prior warning evidence.
It must never contain native IDs or handles, socket paths, message bodies,
delivery/conversation secrets, credentials, exceptions, raw diagnostics, or
provider histories. Human output is derived from the same validated shape.

Never write protocol diagnostics to stdout: stdout may itself be a framed
protocol channel. Operational hints use bounded safe codes and stderr.

## State reset and rollback

Private state is schema 7; a valid schema-6 document from an earlier 4.x
release is read forward with its rows retained. Schemas ≤5 and unknown state
refuse before mutation; there is no converter for older schemas and no
removed-command alias. Back up state before upgrading, because an earlier 4.x
binary refuses schema 7 and rollback requires that pre-upgrade backup.

Reset invalidates all old routes, receipts, and conversation references. The
only rollback is the preserved old binary with its untouched old state. Embassy
does not merge schemas or promise conversation continuity across reset.
