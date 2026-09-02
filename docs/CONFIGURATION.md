# Configuration and provider contracts

Embassy is configured primarily through environment variables read when each
command starts. This document collects every variable, provider transport
contract, provider runtime rule, and the addressing model. Values are env vars
or CLI flags except for the private `nodes.json` federation inventory described
below.

---

## Common configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`, or `$HOME/.local/state/agent-embassy` when `XDG_STATE_HOME` is unset | Private state and control socket; an override must be absolute and does not relocate the fixed host-wide lease |
| `EMBASSY_STEERING_ENABLED` | `1` | Global Claude-to-Codex `STEER:` kill switch; set exactly `0` to treat every Claude-to-Codex body as an ordinary Codex-bound queued message; Claude-bound mailbox timing is unchanged |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude sender notice policy: `merged` keeps stalls and folds terminal diagnostics into native status; `verbose` emits both; `quiet` emits no gateway user-frame notices |
| `NO_COLOR` | unset | Not an Embassy setting — the [conventional one](https://no-color.org). Set it to any non-empty value and `embassy status`, `watch`, and `check` print no escape sequences. Colour is emphasis only: stripping it never removes information, and a non-terminal stdout is never coloured whatever this says |

Before any Embassy client call that talks to the broker, the CLI reads the state
directory and `nodes.json`, then connects to the control socket; grant a sandboxed
Codex task that directory as a writable root, or approve equivalent local access,
and do not relocate state or start a second broker to work around a denial.

`nodes.json` in `EMBASSY_STATE_DIR` is optional — needed only for federation
across machines. When it is absent at broker boot, Embassy writes it itself,
once: mode 0600, naming this host by its own hostname (the first label before
any dot, lower-cased; `localhost` if that name is not a valid host token),
with an empty peer list. From that point on the file — not the hostname — is
this broker's durable identity: a later hostname change (for example a
network-triggered rename) does not rename it. Federation authority comes only from
this file: it must be a current-user-owned mode-0600 regular file whose exact
object shape is
`{"version":1,"host":"<lowercase-host>","nodes":["<lowercase-ssh-alias>",...]}`.
`host` names this broker; `nodes` contains 0 through 31 unique OpenSSH aliases,
omits `host`, and keeps the federation at 32 total hosts or fewer. Each listed
node is the fixed SSH destination for `embassy peer-stdio`. To adopt
federation later, edit the existing file and add peers to `nodes` — keep
`host` exactly as it already reads; every durable record (routes and
retained bodies) is keyed by that value, so renaming `host` requires
the [private state reset](#private-state-reset) below, the same as any other
identity change.
Removing a peer does not remove its durable mirrors; reset private state before restarting with that peer absent.

Examples throughout this documentation write aliases as `name@your-host`;
substitute your own host — the `hostId` on the broker's ready line — wherever
`your-host` appears. The commands that name a route this machine owns —
`register-codex` (including `--succeeds`), `unregister-codex`, `register-peer`,
`unregister-peer` and `await` — refuse an alias naming any other host, and say
which host this machine uses and the file that came from. `send` and `reply`
are not restricted this way: their `--to`, `--from` and `--alias` may name a
federated peer on another host.

### Private state reset

Version 3 accepts only fresh schema-5 private state; it does not convert or
rewrite older state; the 2.x line's state is refused the same way. Before the reset, use the old running broker's `status`
and delivery lookups to verify that no queued, armed, or accepted work remains
and every delivery has settled. Then:

1. Stop the broker.
2. Move `gateway-state.json` aside so the old ledger remains recoverable.
3. `nodes.json`, if you use federation, is untouched.
4. Start the version-3 broker to create fresh state.
5. Re-register Codex tasks. Claude routes reinstall themselves on first use.

An old or unknown schema refuses with `GATEWAY_STATE_SCHEMA_UNSUPPORTED` and
does not mutate the state file. There is no conversion command or automatic
recovery path.

A schema-5 file that still carries a key this line removed — `consentEdges`,
retired along with the permission records it held — refuses with `CORRUPT_GATEWAY_STATE`
instead, because the loader accepts an exact key set rather than ignoring what
it does not recognize. On this upgrade that refusal is expected, not damage:
the file on disk is intact and the same five steps above are the whole
recovery. The state file is never rewritten in place to make it loadable.

A running broker holds `.gateway-controller.lock` in the state directory,
recording its pid and the machine name at the time it started. What a later
start does with a lock it finds depends only on that pid:

| Lock found | What the next start does |
| --- | --- |
| Records a **live pid** | Refuses with `GATEWAY_STATE_IN_USE`, and prints the recorded host and pid. Embassy cannot tell a running broker from an unrelated process that inherited the pid number, and that is equally true of a lock written under this machine's earlier name, so it never assumes |
| Records a **dead pid** | Recovers it automatically, whatever machine name the lock records — renaming a machine cannot wedge its own state directory |
| Is **empty**, from a crash between creating the file and writing it | Recovers it automatically; it names no owner to check |
| **Parses, but names no process** (no pid, or one that is not a positive integer) | Refuses with `GATEWAY_STATE_LOCK_UNVERIFIED` and leaves it alone — there is nothing to probe, so nothing may be claimed about it |
| Is **neither empty nor a readable record** | Refuses with `GATEWAY_STATE_LOCK_UNVERIFIED` and leaves it alone |

Both refusals print a hint naming the lock file: once you have confirmed no
broker is running anywhere, remove `.gateway-controller.lock` and start again.
A recovered lock is renamed to `.gateway-controller.lock.stale-<recovered-at>-<uuid>`
rather than deleted, so a crash stays diagnosable; the timestamp in that name
is when Embassy recovered it, and a later start removes it once that is more
than seven days ago. (The file's own timestamps are the crashed broker's and
can be arbitrarily old, so they are not used.) Never delete a lock while a
broker is running.

## Service

`embassy service install` registers the broker as a per-user macOS launchd
agent instead of a foreground process kept alive by hand:

- **Agent**: label `com.agent-embassy.broker`, written to
  `~/Library/LaunchAgents/com.agent-embassy.broker.plist` (mode 0644).
  `RunAtLoad` starts it at login. `KeepAlive` is `{ Crashed: true }`, which
  per `launchd.plist(5)` relaunches the job **only** when it died from a
  signal typically associated with a crash — `SIGSEGV`, `SIGBUS`, `SIGILL`,
  `SIGABRT` — throttled to at most once every 5 seconds. Nothing else brings
  it back: not a clean exit, not a non-zero exit, not a plain `kill`
  (`SIGTERM`), and not one of the broker's deliberate boot refusals (an
  unsupported state schema, another instance holding the lease). That is on
  purpose. A refusal exits once and stays down: run `embassy service status`
  and read the log rather than waiting for a relaunch that will not come.
- **Logs**: stdout and stderr are both captured to
  `~/Library/Logs/agent-embassy/broker.log` (the log directory is created
  mode 0700). **There is no rotation** — Embassy never truncates or rolls this
  file, so a long-lived agent's log is yours to prune. Uninstalling leaves it
  in place.
- **Environment**: every `EMBASSY_*` variable set in the installing shell,
  plus `XDG_STATE_HOME`, is captured into the plist at install time, and the
  install prints the captured key names. These are configuration, not
  secrets; nothing else — no API key, no token, no `PATH` — is copied.
  `EMBASSY_STATE_DIR` and `XDG_STATE_HOME` must be absolute. The agent runs
  with exactly those captured values for its whole life: changing them in
  your shell afterwards has no effect, and the only way to change what the
  agent runs with is to run `embassy service install` again.
- **Stop it**: `embassy service uninstall` boots the agent out of launchd and
  then waits — polling `launchctl print` every 250 ms for up to 10 seconds —
  until launchctl answers that the label is *not found*; only then does it
  remove the plist. launchd unloads asynchronously, so `bootout` returning 0
  is not proof. Any other answer leaves the plist in place. If launchctl
  reported an error, its stderr is quoted. If `bootout` returned 0 and the
  label is still there at the end of the wait, there is nothing of
  launchctl's to quote — `print` succeeded, and its stdout is never quoted —
  so the message says how long it waited instead.
- **Check it**: `embassy service status` reports `loaded`, `not loaded`, or
  `unknown`. `unknown` — launchctl could not run, or printed something this
  version does not recognize — is reported as such with launchctl's *stderr*
  quoted, and exits non-zero; it is never rendered as "not loaded". Status
  also reports whether the plist exists and whether the program the plist
  points at is still on disk (a Node binary under a version manager can be
  removed out from under an installed agent). `service` is the one command
  that reports local paths — its plist, its log, a missing program — because
  managing those files is what it does; launchctl's *stdout* is never quoted
  anywhere, since a `print` dump contains the agent's environment values.

Install replaces its own loaded agent: it boots the existing
`com.agent-embassy.broker` out, waits for launchctl to confirm the label is
gone, and only then probes the host-wide instance lease. So re-running
`embassy service install` over a running launchd agent is the supported way to
change its configuration.

If the lease still cannot be taken after that, install refuses and quotes the
lease's own message verbatim (bounded, like every quoted string on this
path, at 512 bytes). That message is worth reading: `instance-lease`
reports the same condition for about ten situations, most of which are not
another broker at all — a symlinked path component under `~/.local/state`, a
non-empty lease root with no ownership marker, a lock file whose mode or owner
drifted. A holder's pid is named only when the recorded pid is verifiably
alive, because the lock record keeps the *last* holder and is routinely stale.
Nothing has been written to disk at this point.

**Rollback.** A failure after `launchctl bootstrap` — a non-zero `bootstrap`,
a `print` that cannot confirm the agent, a failing `kickstart` — is rolled
back, and the error says exactly what the rollback achieved:

- the new agent is booted out and confirmed gone; then
- if a readable plist was already there, its previous bytes are written back,
  and it is re-bootstrapped **only if that agent was loaded when install
  started** — the restart is then confirmed by `launchctl print`, not by an
  exit code. A plist that was merely sitting on disk, unloaded, is restored
  and left unloaded: a failed install must not start a broker you did not
  have running, which would take the host lease behind your back;
- if there was no previous plist, the one this install wrote is removed;
- if the previous plist could not be read (it was oversized, or unreadable),
  it is **left in place rather than deleted** — deleting it would be a silent
  uninstall — and the error says the plist on disk is the one this install
  wrote;
- if the new agent cannot be confirmed unloaded, the plist is **left alone**
  and the error says so — a half-installed agent is reported, never hidden.

The post-install health check is *not* one of those failures. By then the
agent is installed and loaded, and it stays that way: a broker that does not
answer is reported, and the command exits non-zero, but nothing is undone.

Install waits up to 10 seconds of wall clock for that health check, capping
each attempt at 1 second. If the broker never answers, the command exits
non-zero, names the log file, and reports the last code it observed. If that
last code is a decisive refusal rather than silence — `CONTROL_STATE_UNSAFE`,
`CONTROL_SOCKET_UNSAFE`, `CONTROL_CONNECT_DENIED`, `CONTROL_VERSION_MISMATCH`
— it exits with that code's own class and points at `embassy health`, which
explains it.

## Advanced bounds

These variables retain conservative defaults:

| Variable | Default |
| --- | ---: |
| `EMBASSY_MAX_ROUTES` | `128` |
| `EMBASSY_EVENT_CAPACITY` / `EMBASSY_EVENT_TTL_MS` | `500` / `86400000` |
| `EMBASSY_DEDUPE_CAPACITY` / `EMBASSY_DEDUPE_TTL_MS` | `2000` / `300000` |
| `EMBASSY_MAX_QUEUE_MESSAGES` / `EMBASSY_MAX_QUEUE_PER_ROUTE` | `100` / `20` |
| `EMBASSY_MAX_IN_FLIGHT` | `16` |
| `EMBASSY_MAX_QUEUE_BYTES` / `EMBASSY_MAX_MESSAGE_BYTES` | `1048576` / `16384` |
| `EMBASSY_MESSAGE_DEADLINE_MS` | `14400000` |
| `EMBASSY_RATE_LIMIT` / `EMBASSY_RATE_WINDOW_MS` | `30` / `60000` |

`EMBASSY_MAX_ROUTES` accepts 2 through 256. Every value in
this table is validated at startup, and an out-of-range or non-integer setting
fails closed with `INVALID_GATEWAY_CONFIGURATION` rather than being clamped.

The stall notice is not separately configurable. It fires at
`min(floor(EMBASSY_MESSAGE_DEADLINE_MS / 2), 120000)` milliseconds, so under the
default four-hour deadline a pending delivery is reported at two minutes, not
two hours.

A CLI initiator receives the full `conv_` token in its result, and every routed recipient receives the same token in the inbound provenance envelope and reply hint. The token is a memory-only participant-scoped locator, not an authority credential: every `reply` rechecks caller identity, conversation membership, and the live route. The token no longer exists after a broker restart; it must likewise never be retried or reconstructed after route retirement or identity replacement.

The public launcher remains host-local. Under allowlisted SSH federation, each broker serves the exact host identity attested by `nodes.json`. `register-codex` infers that host; the alias (and any `--succeeds` alias) must use the same suffix.

## Claude Code's own setting: `crossSessionInbound`

`crossSessionInbound` is Claude Code's native setting for cross-session
messaging: it decides whether a Claude session accepts, holds, or refuses
messages arriving from another session. Embassy needs it enabled on any
session used as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

This is the one prerequisite you must actively toggle, and it is the most
common first-run failure — because it fails *late*. A send to a discovered
session is accepted and installs its route without consulting Claude's native
inbound policy; the refusal appears only when the delivery reaches the Claude
end. If the session appears in `embassy status` and the send was accepted but
nothing arrives, check `crossSessionInbound` on the destination session before
suspecting the route.

## Provider and runtime contract

Embassy routes three providers: Claude over peer protocol 1, Codex over the managed App Server, and universal shell peers over the private control socket. A build or version fact never grants or withholds routing authority.

Runtime is best effort: the OS boundary plus the exact owned route/session identity authorizes an attempt. The current per-operation transport, strict consumed wire fields, and correlated operation determine the result. Interface drift or a missing optional provider becomes provider-local degraded/offline health and an exact safe code; it does not create a compatibility tier or block unrelated providers.

Only unsafe OS evidence for Embassy-owned or executed artifacts and Embassy callback, control, or state paths—such as an unsafe lease or state, swapped binary, ownership/path/symlink mismatch, or invalid generation—refuses broker startup. The Claude-owned external sessions registry root is read-side identity evidence: an unsafe UID or mode degrades only Claude with a loud observation while the broker and other providers remain available. Claude still requires native `peerProtocol: 1` per session record: a record that declares any other value is rejected in isolation and included in bounded rejection evidence without stopping the broker or hiding other usable sessions.

Runtime parsing remains strict on every known registry field, frame, and response; unknown top-level Claude registry fields are ignored because Embassy never consumes them. The Claude connector row in public status carries optional bounded `registry` observations: `entriesScanned`, `parseableRecords`, monotonic `parseableRecordSeenSinceBoot`, bounded per-safe-code `rejected`, and `rejectedCodesOmitted`. `embassy status` reports the same evidence: if Claude is running but no record with parseable required fields has been observed since broker start, its registry layout may have changed.

The managed Codex installation is resolved by exact verified path; a `codex` elsewhere on `PATH` is neither used nor modified. Claude registry and callback roots are derived from the verified current OS user; no Claude launcher or configuration file is read. Version strings, when present, are bounded diagnostic metadata only.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while an installed UUID-bound route continues to work under the new name. A rename becomes visible at the session's next status transition — typically its next turn boundary — because Claude Code rewrites the session's registry record on those transitions, not at the moment of the rename; Embassy reflects the record, never the rename itself.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name: the shared *name* is refused with `PEER_ALIAS_COLLISION`, while each session stays reachable by its own UUID.

Across a federated link, reachability is narrower than it is locally. A peer node addresses only the routes its neighbour published in its catalog, and a Claude session appears there only once it has a local route — that is, once it has sent a message or been sent one on its own host. The destination never installs a route on a handoff: an unmirrored sender or an unrouted target is refused, not created. To make a Claude session addressable from a peer node, use it locally once first.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed. Registration performs no App Server operation. Every delivery opens and attests a fresh managed transport, initializes it, resumes the exact task with history excluded, and authorizes the body write once. App Server, Desktop, and broker restarts do not change logical route authority or require re-registration. A current unavailable or unobservable task reports an operation-local safe code while the registration remains.

Shell routes use `peer-*` aliases and a `peer_` token minted at registration.
The broker persists only its UID/alias/token hash route handle, never the raw
token. Authenticated calls accept the token on the first stdin line with
`--token-stdin`; body-bearing calls use the remaining bytes as the body.
`--emit-env` remains optional for stable-shell harnesses. There is no PID
binding, token file, Keychain entry, daemon, or alternate persistence path.
