# Contributing to Embassy

Embassy connects two powerful local agent runtimes across evidence-gated native
interfaces. Small changes can alter permission, privacy, or delivery behavior,
so contributions should be narrow, testable, and explicit about boundaries.

## Development setup

Use macOS, Node.js 20 or newer, and the npm version declared in `package.json`.

```bash
npm ci
npm run check
```

`npm run check` type-checks and runs the deterministic test suite; its `pretest`
hook rebuilds `dist` first, so the suite always runs against freshly compiled
output. Routine tests use fake Claude peers, fake App Server transports, and
temporary directories; they must not contact Anthropic, OpenAI, SSH hosts, live
provider sockets, or models.

`npm run soak` is the separate deliverability gate. It drives a seeded,
randomized churn of sends through scripted dispatch faults, busy/idle flips,
clock jumps, and full restarts, asserting that every accepted message settles
exactly once into an explicit terminal outcome. It is still deterministic and
offline; run it for any change to routing, the queue, settlement, or restart
recovery.

## Before opening a pull request

- Run `npm run check`, and `npm run soak` as well for any delivery, queue,
  settlement, or restart-recovery change.
- Add deterministic regression coverage for routing, protocol, persistence,
  permission, process-lifecycle, or redaction changes.
- Keep the pull request focused and explain every security-boundary change.
- For every new audit check, cite the sentence it enforces in
  [“What Embassy defends, and what it deliberately does not”](SECURITY.md#what-embassy-defends-and-what-it-deliberately-does-not).
  If no sentence supports the check, propose the doctrine change explicitly,
  with its product and threat-model consequence, before implementation. Do not
  smuggle a boundary expansion into a test, review finding, or hardening patch.
- Update README and architecture documentation when public behavior changes.
- Verify that public files contain no credentials, native IDs, message bodies,
  local state, or personal absolute paths.
- Do not commit `node_modules`, `dist`, package archives, generated dashboards,
  logs, environment files, or live-validation artifacts.

## Architecture rules

### Routing and identity

- Codex tasks self-register through inherited `CODEX_THREAD_ID` and a
  `codex-*` alias. Never add a thread-ID argument or global task-history scan.
- Codex-to-Claude sends require a previously selected compatible live session.
  Do not auto-select during send.
- In the default `paired` inbound mode, a Claude session reaches the registered
  native Codex peer only across an existing pair edge; a sender without one is
  refused `SENDER_NOT_PAIRED` before admission and the refusal is journaled.
  Only `serve --inbound open` admits any exact compatible live same-UID session.
  Neither path makes the inbound session outbound-selected.
- Claude's session UUID is its stable logical identity. Current names are a
  live index; do not add historical-name routing or PID/socket identity.
- Preserve current-name collision refusal and exact registration fencing.
- Codex registration is record-only: it changes the durable logical route and
  performs no provider or App Server I/O. `register-codex --succeeds` is one
  atomic logical replacement that settles queued/reserved work `cancelled`,
  armed work `ambiguous`, and accepted work `unconfirmed`; removes every
  incident consent edge and conversation, reply, or native capability; and
  installs only the successor. Do not add prepared generations, re-anchoring,
  or recovery journals.

### Provider adapters

Claude Code's cross-session feature is official. Embassy's use of its external
registry and peer socket shape remains an internal adapter: require native
peer protocol 1 and validate every consumed field and frame. Unknown top-level
registry fields may be ignored; required and consumed fields remain strict,
and rejected-record or observed-empty counts must stay loud. Embassy derives
the registry and callback roots from the verified current OS user; it does not
inspect a Claude launcher or configuration file. Codex registration
performs no provider I/O. Its bounded observer is display-only: it may report
freshness and safe codes but never authorizes, rejects, or delays a delivery.
Every Codex delivery instead creates an operation-local transport,
negotiates the current interface, and resumes the exact registered task with
history excluded before final write authorization. Unsafe ownership, path,
symlink, lease, state, or used-artifact generation evidence for Embassy-owned
or executed artifacts and Embassy callback, control, or state paths still
aborts startup; an unsafe Claude-owned external sessions registry root
quarantines only Claude. Provider versions remain diagnostic metadata, and
interface drift or an unavailable optional provider degrades only that
surface. Do not widen a declared protocol without documented review and
deterministic fixtures.

The gateway may publish one process-owned `codex-*` peer so Claude's native
`ListAgents` and `SendMessage` tools can reach Codex. It must never overwrite a
foreign registry record, claim to be a Claude model session, or unlink a socket
whose exact generation it no longer owns.

App Server calls use a closed allowlist. Do not add a generic RPC method,
approval responses, history retrieval, shell execution, settings mutation, or
provider authentication. The only active-turn method is exact same-session
`turn/steer` for a leading `STEER:` body on the accepted operation, capped at
three and admitted only at the next tool-call boundary. Embassy never calls
`turn/interrupt`. Keep `experimentalApi: true` non-configurable and limited to
`thread/resume.excludeTurns: true`; every resume must require an empty
`thread.turns` response.

### Permissions

Embassy does not set or override a Codex task's persistent approval or sandbox
policy. Registration is the gateway reachability boundary. Bounded observation
may describe route and approval-waiting status, but it is never authority or a
dispatch gate and must not classify policy or turn workspace/settings metadata
into a second authorization gate.

For Codex-to-Claude delivery, Claude's `crossSessionInbound` behavior remains
native. Do not route around a hold or refusal or fabricate a successful receipt.

### Delivery and state

- Reply addresses are transient. Bodies are bounded and durable: the queue and
  the recent-delivery ledger both persist them under bounded retention caps.
- Queue while a Codex task is busy; do not interrupt an unrelated turn.
- Distinguish gateway acceptance, transport progress, destination acceptance,
  terminal failure, ambiguity, expiry, and restart abandonment.
- Never retry an ambiguous provider write. Requeue only a confirmed clean
  deferral that has not crossed an ambiguous mutation boundary.
- The private mode-0600 v3 ledger retains bounded queued and recent bodies,
  opaque delivery tokens, and status. Queued or reserved work may resume once
  within its deadline and attempt budget against the same exact route and edge.
  Armed work settles `ambiguous`; accepted work settles `unconfirmed`; neither
  is replayed. Conversations, reply/native capabilities, raw frames, callback
  addresses, and socket paths remain memory-only.
- Persist native route identifiers only in the closed private binding schema.
  Keep them out of events, snapshots, dashboard rows, logs, errors, and CLI
  output. The only CLI exception is a UUID explicitly supplied by the user as a
  Claude selector.

### Local control surface

`embassy serve` may use one private same-user control UDS and publish two inert,
metadata-only static dashboard files. It must not listen on TCP or HTTP. The
only reviewed exception is the separately invoked foreground
`embassy dashboard --live` companion, which binds exact IPv4 loopback on stable
port `41961` by default or the validated per-invocation `--port <n>`. It has no
local-process or UID authentication and therefore assumes a trusted
single-user machine; exact Host on every request and exact Origin plus
`X-Embassy-Request` on every POST constrain browser origins, not local
software. Preserve the direct root URL, multi-window/browser access, collision
failure with no fallback port, no CORS/`OPTIONS`, and only the reviewed pair,
unpair, refresh-discovery, and named Codex-registration-removal mutations—never
a provider or generic control method. Confirmed removal may target any named
Codex registration; its atomic commit removes incident consent edges and
conversation, reply, or native capabilities, and settles queued/reserved work
`cancelled`, armed work `ambiguous`, and accepted work `unconfirmed`. Do not
add a wildcard/remote listener, external assets, service workers, telemetry,
or additional mutation endpoints. Keep the public v1 launcher foreground,
macOS-only, and local-host-only.

## Live validation

Do not run a live probe merely because a test would be convenient. Live Claude
registry discovery, peer connection, provider messaging, App Server turns, and
SSH attachment are separate external actions.

A live action requires an explicit user request that identifies its scope. For
a message, confirm the exact destination and body and avoid fanout. Follow the
send-failure policy below for command failures; never retry a confirmed
delivery or a recipient denial. Never put real provider traffic in CI.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Use a private GitHub Security Advisory rather
than a public issue, and replace sensitive local values with synthetic ones.

Two platform notes: the suite binds Unix-domain sockets under `TMPDIR`, and
macOS caps socket paths at ~104 bytes — keep `TMPDIR` short (CI pins
`TMPDIR=/tmp`; do the same locally if the transport tests hang). On Linux,
the darwin-only lease and peer-generation tests skip explicitly (the host
lease spawns macOS's `/usr/bin/lockf`); macOS runs the full suite.

## Design honesty rules

These outlive any visual era and bind every surface — dashboards, CLI copy,
site, docs, in both languages:

- Progress is never green. Only a terminal success state may look like one.
- `delivered` means the write completed; `released` is not read; nothing may
  imply a model consumed, understood, or acted on a message.
- Refusals are not failures: a fail-closed refusal renders as policy, not as
  breakage.
- The brand accent is never a state color, and state colors are never
  decoration.
- Every alert pairs its state with the exact next command, copyable.

### The declined ledger

[`docs/DECLINED.md`](docs/DECLINED.md) records, per release, what we considered
and chose not to build, each with a one-line reason. It is product
documentation: a product that documents what it refuses to build is making the
same promise the dashboard makes—the truth over the appearance of completeness.
PRs that implement something in the ledger must address its reason.

### Why tickets are priced by the PM

The level of implementation—the one-hour version versus the one-week version—
is a scope decision, and scope is a product judgment. The PM prices it; the
engineer builds it faithfully within budget or contests the price with reasons.
Economy here never means lowering the bar on what ships: it means fewer things,
done well, and being explicit about what waits.

### Send-failure policy

A send or reply whose command result is an error, truncation, or ambiguity is
not a delivery—it is a failed attempt to create one. Verify with read-only
`status`/`delivery-status`; if no acceptance is confirmed, resend without
asking, up to three attempts. Escalate to the PM only when a recipient
explicitly denied the message or three resends have failed. A duplicated
coordination message is a nuisance; a lost one deadlocks the pipeline, so
deliverability beats ceremony. Never auto-retry a delivery the recipient's
user denied: that is consent, not transport.

For long messages, write the body to a file and pipe it
(`embassy reply ... < body.md`); never inline `printf` for prose.
