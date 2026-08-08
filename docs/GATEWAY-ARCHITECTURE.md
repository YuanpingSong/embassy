# Embassy Gateway Architecture

Status: local bidirectional version 1 implemented and live-tested with one
advertised Codex task; remote connectors remain deferred. The published v1
package supports macOS, the only platform exercised end to end so far.

This document uses four evidence labels:

- **Official**: documented by Anthropic or OpenAI.
- **Implemented**: present in this worktree and covered by deterministic tests.
- **Observed**: established by a bounded, read-only local feasibility probe.
- **Planned**: designed but not yet integrated or live-validated.

A bounded real test completed native Claude discovery and messaging, held a
message while the selected Codex task was active, automatically started the
queued turn after idle, and delivered the exact final reply back to Claude.

## Purpose and boundary

The gateway lets already-running Claude Code sessions and explicitly
registered native Codex tasks address one another by short aliases. Outbound
Codex-to-Claude sends require an explicitly selected Claude route; inbound
native Claude messages may come from any exact live same-UID session without
making that session outbound-selected. It provides a single
private operational view across the two products without rebuilding either
agent runtime.

Its exact Claude Code 2.1.225 runtime/peer-protocol pin is fail-closed.
Still-running 2.1.224 sessions remain compatible during a patch upgrade
because their registry records use the same reviewed peer protocol 1 shape.

It is deliberately:

- personal, local, same-OS-user software;
- single-user and non-hosted;
- an alias router and bounded message broker, not an agent runtime;
- unable to create Codex sidebar task cards or Claude session UI.

Embassy uses one private same-user Unix-domain control socket for its thin clients and generates one
private static dashboard file. It does not add a TCP listener, HTTP server, or
public API.

### Why this uses the new feature, but is not skill-only

The gateway does not use Claude Channels. Claude's official cross-session
feature supplies genuine Claude-session discovery, inbound policy, and native
message delivery. It does not define a third-party session kind or make Codex
tasks appear in `ListAgents`, so it cannot by itself provide the symmetric
Claude–Codex address book the user wants.

The repo-shipped skill is the lightweight user/agent interface. A persistent
local broker is still required to own the private control socket, retain
transient reply correlation, watch endpoint generations, queue while a Codex
task is busy, and regenerate the dashboard between agent turns. The skill does
not wrap, replace, or recreate either provider.

## What is official and what is internal

### Claude Code

**Official:** Claude Code 2.1.225 documents cross-session messaging on macOS
and Linux. Real Claude sessions can use `ListAgents` to find other real Claude
sessions and `SendMessage` to contact them. A target can accept, hold, or
refuse inbound cross-session messages through `crossSessionInbound`. Messages
do not bypass the receiver's tool permissions or approval boundary.

**Version-pinned internal boundary:** the installed Claude Code 2.1.225 build
advertises live sessions through registry records and transports peer frames
over per-session Unix-domain sockets using peer protocol 1. Those registry and
wire shapes are not documented as a stable third-party integration API. The
gateway therefore pins the exact Claude Code version and protocol, validates
every record and socket immediately before use, and fails closed after an
update until the adapter is reviewed again.

For the lowest-impedance native path, the gateway publishes one process-owned
registry record whose name is visibly prefixed `codex-`. The listener remains
gateway-owned and does not claim to be a Claude model session; the explicit
name is the product boundary. The record uses the version-pinned native peer
shape so Claude's own `ListAgents` and `SendMessage` tools work unchanged.

Consequences:

- Native Claude `ListAgents` discovers real Claude sessions plus the one
  explicitly named `codex-*` gateway peer.
- The gateway discovers compatible real Claude sessions as transient
  candidates, but publishes only sanitized aliases and state. A send from a
  registered Codex task may address only an explicitly selected route by its
  current name or UUID. Per-message consent stays native: delivery lands in the
  Claude session's own `crossSessionInbound` policy and approval flow.
- Codex aliases are discovered through the gateway CLI/skill and dashboard,
  not through `ListAgents`.
- A gateway-owned anonymous callback UDS can receive a correlated reply. It
  does not need, and must not create, a Claude registry record.

### Codex

**Official:** Codex App Server is the JSON-RPC interface used by rich Codex
clients. Its Unix-socket transport is WebSocket over a standard HTTP Upgrade.
The documented protocol includes loaded-thread discovery, thread resume,
turn start, turn interrupt, and notifications. `turn/steer` also exists, but
the gateway intentionally excludes it from version 1.

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
  │ private control UDS │ transient bodies │ metadata state │ static HTML  │
  └──────────┬──────────┴──────────────────┴────────────────┴──────────────┘
             │
             ├─ local Codex App Server ─ selected native local tasks
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
| Neutral gateway types, metadata store, route fencing, bounded queues, dedupe, rate limits, and public projection | **Implemented**, deterministic tests; message bodies remain memory-only |
| Private JSONL control protocol over a controller-owned UDS | **Implemented**, deterministic synthetic tests; no provider connection required |
| Static metadata-only dashboard renderer and atomic publisher | **Implemented**, deterministic security tests; no browser or HTTP server required |
| Claude registry/peer adapter pinned to 2.1.225 / peer protocol 1 | **Implemented** and live-tested, including 2.1.224/2.1.225 patch-overlap discovery, print-session discovery, native status frames, cancellation, and accessible-workspace attestation |
| Exact Claude 2.1.225 binary/runtime attestation | **Implemented**; executes only bounded `claude --version` with a scrubbed environment and derives but does not open provider roots |
| Allowlisted Codex App Server connector with queue-only busy behavior | **Implemented** and live-tested against App Server 0.147.0, including external busy observation, registered-route reachability across settings changes, and an automatically started queued turn |
| Attach-only local Codex proxy transport and exact-owned cleanup | **Implemented**, five deterministic tests; no live App Server connection in routine tests |
| Local provider adapters | **Implemented**, focused synthetic tests cover genuine-interactive Claude discovery, exact send/callback/receipt settlement and post-dispatch refresh, plus exact opted-in Codex ownership, registered-route reachability, monitor-only fallback, and cleanup; remote adapters remain disabled |
| Gateway service composition | **Implemented**, including private control-server startup, adapter lifecycle, synthetic cross-provider selection/dispatch/reply correlation, metadata-only publication, and clean-restart abandonment tests |
| Operator/agent client CLI and package binary | **Implemented**, deterministic private-UDS tests cover the closed command family, inherited provider identity, bounded stdin-only bodies, normalized output, and ambiguous no-retry behavior |
| Repo-shipped cross-provider skill | **Implemented** as a repo-scoped workflow over the client CLI; it is not installed into either provider's global configuration |
| Foreground local broker launcher and provider assembly | **Implemented** as `embassy serve`; local-host-only with native messaging enabled |
| Live Codex-to-Claude delivery | **Tested** through selected real Claude 2.1.224 and 2.1.225 sessions |
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
while the UUID and an already selected UUID-bound route continue to identify
the same session. PID, registry path, process generation, and socket generation
are replaceable delivery coordinates, not identity, and are refreshed from the
live registry before a write. The gateway rejects duplicate current names and
duplicate live UUIDs rather than choosing between them.

The controller binds a Codex route to an exact host, App Server endpoint
generation, thread ID, and owner lease. Other provider-native IDs, PIDs,
working directories, endpoint paths, and socket paths are never public
selectors or output fields. A Claude UUID may be supplied explicitly as a
destination, but the gateway never prints or invents one for the caller.

Codex registration is explicit. A selected task registers its own alias and
authoritative `CODEX_THREAD_ID`; the gateway does not enumerate global Codex
history to invent routes. A route becomes usable only after the matching host
connector positively observes that exact task on the current endpoint
generation.

Claude discovery is passive and limited to currently advertised genuine
Claude session records. It produces a bounded, sanitized `availablePeers`
inventory keyed for display by the latest name. The adapter validates the
exact pinned schema, session UUID, process identity and liveness,
record/socket type, PID and socket-path correlation, allowed roots, and
file/socket generations. Provider-owned Unix owner and mode bits are not
treated as gateway policy; successful filesystem access is sufficient. A
current name resolves to a UUID but never substitutes for it.

The dashboard is the single pane for the human. It shows both sanitized
available/selected Claude aliases and explicitly registered Codex aliases,
including their host, compatibility, state, last-seen age, and queue depth.
The thin skill/CLI exposes the same safe alias list to either provider.

## Message flows

### Codex to Claude

1. A selected Codex task calls the repo-shipped gateway skill/CLI with its own
   thread identity, source alias, target Claude current name or session UUID,
   and bounded text.
2. The gateway checks thread ownership, selector state, rate and size limits,
   deadline, hop count, and dedupe state.
3. It requires the selector to match an explicitly selected live UUID,
   refreshes the UUID's current process/socket coordinates, and revalidates
   the private workspace/controller-state separation before every send.
4. It opens a short-lived connection and writes one version-pinned peer frame.
   In the designed write-enabled mode, a reply request carries the gateway's
   own anonymous callback UDS as the reply address.
5. It records only normalized delivery metadata. It does not retry an
   ambiguous write automatically.
6. A reply received on the callback listener is correlated in memory and
   routed to the owning explicitly registered Codex task.

A transport write is not proof of successful model completion. The adapter
distinguishes transport state from any hold/release/denial receipt supported
by the pinned protocol. `transport_written` and `held` are progress states,
not terminal success and not permission to retry.

### Claude to Codex

This path is enabled for one explicitly registered `codex-*` task. The
gateway publishes its process-owned native registry entry, accepts Claude's
native `SendMessage`, starts an App Server turn, and returns the final reply.

1. The gateway advertises one process-owned `codex-*` record in Claude's
   native registry.
2. A real Claude session uses native `ListAgents` and `SendMessage`; the
   gateway validates that exact live registry/socket generation and treats the
   text as untrusted user-role input. This inbound observation grants only a
   transient, in-memory capability for the correlated reply. It does not add a
   Claude route, flip `selected`, or authorize a later unsolicited send.
3. The Claude process's inherited messaging-socket value may be accepted as a
   transient reply address after strict validation. Claude Code exports
   `CLAUDE_CODE_MESSAGING_SOCKET` as a raw absolute socket path; the CLI
   converts it in memory to the gateway's internal `uds:` capability. A user
   never sets, prefixes, or passes that value manually. It is never logged,
   persisted, rendered, or copied into normalized events.
4. The gateway resolves the Codex alias to its private exact-thread binding.
5. The resumed task retains its existing native permissions. The gateway does
   not supply policy overrides.
6. App Server status notifications atomically refresh the advertised native
   peer record to `idle`, `busy`, or `waiting`.
7. If the task is idle, the owning connector starts one dedicated turn. If it
   is active or awaiting approval, version 1 queues the message internally.
   It does not emit Claude's approval-specific native `held` control frame for
   ordinary queueing.
8. When the task becomes idle, the connector refreshes the exact task state and
   starts the held message. Explicit registration is sufficient authorization;
   workspace and policy metadata do not create another gateway delivery gate.
9. Successful App Server acceptance returns Claude's native `delivered`
   receipt. A route or delivery error returns native `expired`, followed by a
   static `<gateway-delivery-diagnostic>` user frame containing one safe error
   code. This is the only way to make the reason visible to Claude Code 2.1.224,
   whose native receipt parser accepts only `held`, `delivered`, `denied`, and
   `expired` and does not render the control frame's `reason` value. The
   diagnostic never contains a socket path, session UUID, raw exception, or
   message body. `denied` is reserved for an actual user or policy refusal.
   A transient clean pre-dispatch failure returns the same message to the queue
   instead of terminally failing it.
10. Completion is summarized into bounded normalized state and the correlated
    reply is returned only to the exact originating Claude session generation.

Claude's native peer socket is itself an inbox, so Codex replies may be
written while the Claude route is busy. The gateway still serializes its own
writes, but it does not wait for Claude to become idle and thereby deadlock a
Claude turn that is waiting for the reply.

The gateway does not expose `turn/steer`. Queueing is the only version 1 busy
policy. `turn/interrupt` is permitted only for a turn that the same connector
started and positively observed; there is no generic App Server RPC escape
hatch.

### Replies and process restarts

Conversation IDs correlate replies, but callback addresses and message bodies
exist only in memory. After a gateway restart, previously queued or in-flight
metadata is marked abandoned; bodies are not recoverable and are never
replayed. Routes are stale until their exact provider endpoint/session is
observed again.

## Gateway control plane

The control plane is newline-delimited JSON on one Unix-domain socket inside a
controller-owned mode-0700 state directory. The socket and state files are
mode 0600. Frames are size-bounded and closed against unknown keys, methods,
versions, and enum values.

The small version 1 method family covers:

- health and a safe public snapshot;
- explicit Codex registration and unregister;
- explicit Claude selection and unselection from the current sanitized
  available-peer inventory;
- provider-specific send operations;
- a correlated reply operation; and
- dashboard refresh.

The installed binary is `embassy` (`claude-codex-gateway` is a one-release
deprecated alias). Its implemented commands are
`serve`, `health`, `status`, `refresh-dashboard`, `register-codex`,
`unregister-codex`, `select-claude`, `unselect-claude`, `send-to-claude`,
`send-to-codex`, and `reply`. Message bodies are non-empty UTF-8 from standard
input only, with a 16 KiB ceiling; they are never accepted in an argument or
file. The client emits one bounded normalized JSON line and never returns a
thread ID, provider-native ID, path, address, or message body. These commands
require the foreground broker, except that `serve` starts it in the current
terminal. It never daemonizes itself.

`select-claude --alias <current-name@host>` and
`select-claude --session <uuid>` select the same logical session.
`send-to-claude --to` accepts either form only after explicit selection. UUID
input is normalized to lowercase. No command returns the
UUID, and no historical name remains routable after a rename.

Provider-authorized mutations require one exclusive inherited principal.
Codex registration, unregister, and Codex-to-Claude send require only a valid
`CODEX_THREAD_ID`; they fail if a non-empty Claude messaging socket is also
inherited. Claude-to-Codex send requires only the raw inherited Claude socket
path and fails if a non-empty Codex thread ID is also present. `reply` likewise
fails with both identities or neither. The operator-only health, status,
dashboard refresh, select, unselect, and serve commands ignore provider
identities.

The foreground command is:

```text
embassy serve
```

It emits one normalized ready line, publishes the private dashboard, and
holds the process until `SIGINT` or `SIGTERM`, when exact-owned resources are
closed. Startup attests the pinned local Claude and Codex runtimes and binds
controller-owned UDS listeners, but does not discover a Claude peer, write a
provider socket, start a model turn, or contact a remote host. Its ready result
reports local host `this-mac`, dashboard filename `gateway-dashboard.html`, and
`codexMode: "native_messaging"` without exposing paths.

There is no arbitrary filesystem operation, shell command, SSH command, App
Server method, Claude registry mutation, credential argument, approval reply,
or raw diagnostic method.

Same-UID socket access is a local containment boundary, not proof of a trusted
agent process. Every mutation additionally checks route ownership, exact
thread/session generation, source alias, bounds, and conversation state.

## Codex connectors and remote hosts

In the target multi-host design, each allowlisted execution host has a separate
connector because each host has its own App Server and native state:

- `this-mac`: the managed local App Server shared with Desktop;
- `build-mac`: a host-local remote App Server reached through an attach-only SSH
  proxy; and
- `lab-mac.example`: the same design, still unprobed and disabled by default.

The shipped foreground launcher accepts only `this-mac`; it rejects any remote
host configuration. The two SSH connectors above remain planned rather than
runnable v1 routes.

The local connector resolves the managed standalone Codex release by exact
path and version; it does not use `PATH`. That installation is separate from
any NVM-managed `codex` on the user's `PATH` (for example
`~/.nvm/versions/node/*/bin/codex`), does not replace
it, and does not edit a shell profile. The two installations therefore do not
conflict.

The connector has a fixed App Server method allowlist. It may initialize,
observe loaded tasks, resume/unsubscribe the exact selected task, start a
dedicated turn, and interrupt only its own confirmed turn. Archive, delete,
history, shell, configuration, authentication, plugin, approval-response, and
generic RPC methods are excluded.

Exact App Server 0.147.0 gates the privacy-preserving
`thread/resume.excludeTurns` field behind initialization capability
`experimentalApi: true`. The connector therefore hard-codes that one
non-configurable capability solely to suppress history retrieval. Both initial
resume and the immediate pre-start refresh send exactly `threadId` plus
`excludeTurns: true`, then require an exact empty `thread.turns` array.
Missing, malformed, or nonempty turns fail closed and are never emitted or
persisted. The capability does not add an experimental client method or change
the closed RPC allowlist.

Monitor compatibility and write compatibility are distinct gates. A connector
may initialize, list, resume, and expose normalized monitor state after its
schema compatibility is attested while still reporting its write gate as
unavailable. No Claude-initiated turn can start until exact write compatibility
and explicit route ownership are established.

Registration resumes the exact task and establishes reachability. No reported
working directory or policy value is copied into controller state or an event.
Before `turn/start`, including a queued drain, the connector refreshes that
exact task on the same live connection, requires it to be idle, and starts the
turn with no policy overrides. Workspace and policy notifications remain
observational; they cannot make an explicitly registered live route
unreachable.

Version 1 never changes or independently classifies a Codex task's approval or
sandbox policy. Offline 0.147.0 `TurnStartParams` schema evidence shows that
policy overrides persist for the current and subsequent turns, so using them
as per-message restrictions would silently mutate the native task. Embassy
therefore starts the turn without overrides and leaves approval, sandbox, and
tool enforcement to the registered task's native Codex configuration. Explicit
`codex-*` registration plus exact live thread/generation validation is the
gateway reachability boundary; workspace and policy metadata are observational
only.

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

The one Desktop restart needed for the local shared-App-Server feasibility
test has already been completed. Building, running synthetic tests, starting
the gateway, rendering the dashboard, and a future Claude peer-socket test do
not themselves require another Desktop restart. A provider or Desktop upgrade
may require a new compatibility probe and, if its attachment mode changes, a
separately announced controlled restart.

## Dashboard

Version 1 generates a self-contained HTML file under the controller-owned
state directory. It is atomically replaced, mode 0600, and uses a short meta
refresh. It has inline CSS and a restrictive Content Security Policy, with no
JavaScript, external assets, CDN, cookies, local storage, service worker,
telemetry, mutation endpoint, or network listener.

It shows only:

- aggregate gateway and per-host connector health;
- available/selected Claude aliases, registered Codex aliases, provider, host,
  compatibility, state, and queue depth;
- normalized message direction and delivery state, timestamp, latency, byte
  count, hop count, and a short opaque message-ID suffix; and
- allowlisted alerts such as stale route, protocol mismatch, queue full, or
  ambiguous delivery.

It never shows message content, prompts, replies, transcripts, titles, working
directories, native IDs, PIDs, socket paths, endpoint paths, tool data, raw
events, stderr, credentials, or configuration contents. This is a
controller-owned UI artifact, not a shared task file. The public snapshot has
a 240 KiB projection budget and reports explicit omission counters if bounded
connector, peer, route, message, or alert rows are truncated.

## Persistence and privacy

The private store may retain:

- aliases, enabled state, ownership leases, and exact provider-native route
  handles inside the closed controller-private binding schema;
- endpoint-generation and compatibility markers;
- bounded queue and delivery metadata;
- timestamps, counters, dedupe/rate-limit records, and safe error codes.

It must never retain message bodies, provider output, prompts, replies, tool
input/output, raw App Server or Claude frames, stderr, histories, credentials,
Claude registry payloads, or callback/socket paths. The public snapshot is a
strict projection that also removes private route handles and endpoint
generations. The state directory is mode 0700 and binding state is mode 0600;
provider-native identifiers never enter normalized events, public snapshots,
the dashboard, CLI arguments/output, aliases, logs, or error text. On restart,
every restored route is stale and unusable until its exact host, endpoint
generation, and target are positively re-observed. Claude selection fails
closed and requires explicit reselection if that proof cannot be restored.

## Minimum filesystem and process access

The production gateway does not need broad home-directory access or the
user's interactive Claude history. The narrow live boundary is:

- read/enumerate only the exact Claude live-session registry directory;
- stat/connect only validated peer sockets inside the exact Claude socket
  directory;
- create and later remove only its exact-owned callback socket inside the
  accessible Claude peer-socket directory, with inode/generation checks;
- create its control socket plus metadata/dashboard files only inside its
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

The runtime attestation code derives these paths from the current OS user's
verified home; it does not scan the home directory. They have not yet been
opened by a live gateway run:

| Path/capability | Minimum purpose |
| --- | --- |
| `~/.local/bin/claude` and derived expected target `~/.local/share/claude/versions/2.1.225` | Stat the owned launcher/path components and read/execute only the resolved pinned target for bounded `--version`; live launcher attestation succeeded |
| `~/.claude/sessions` | Read/enumerate only live registry JSON during the separately authorized passive-discovery gate |
| `/tmp/cc-socks` | At foreground startup, validate the private directory and create/remove only `/tmp/cc-socks/<gateway-pid>.sock` after inode/generation checks; search/stat genuine peers at passive discovery and connect one validated target only at the separately authorized send gate |
| `~/.local/state/agent-embassy` | Default controller-owned store, control UDS, lock, and static dashboard; an explicit absolute configuration may replace this root |
| `~/.codex/packages/standalone` and `~/.codex/app-server-control/app-server-control.sock` | Resolve the pinned managed Codex binary and attach to the already-running private local App Server; never bootstrap or unlink it |

No grant to `~/.claude/projects`, the rest of
`~/.claude`, Keychain APIs, the full home directory, or
unrelated temporary files is required. Remote-host access is a later,
separately reviewed fixed-SSH-alias capability.

Provider workspaces may contain the private controller-state directory. The
filesystem root and configured temporary roots are still rejected as
deliberately broad provider workspaces. The user's home is selectable with the
default controller-state root beneath it. A narrower project directory remains
the preferred least-context setup, but it is not mandatory.

## Failure and upgrade policy

- Unknown Claude Code version, peer protocol, message version, App Server
  response shape, or endpoint generation fails closed.
- Alias collisions, stale ownership leases, PID/socket races, unsafe
  gateway-owned state, unexpected paths, queue overflow, deadline expiry, and ambiguous writes are
  normalized failures, never raw diagnostics.
- Provider disconnect invalidates every route on that endpoint generation.
- No ambiguous mutation is retried automatically.
- No queued body survives process loss.
- Version-specific compatibility evidence expires on a provider or Desktop
  update.

## Validation boundary

Routine validation is deterministic and synthetic: it does not inspect live
provider state, connect a provider socket, attach to App Server, invoke SSH, or
make a model request. The separately authorized local live tests recorded
above established discovery and both message directions. Remote production
connectors remain a separately reviewed future capability.

Only the synthetic layer is routine validation. Server/dashboard startup,
discovery, and callback binding remain no-send operations; step 4 is the first
provider write. A real provider message is never enabled in CI.

## References

- [Anthropic: Message your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging)
- [OpenAI: Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Remote connections and SSH hosts](https://learn.chatgpt.com/docs/remote-connections)
