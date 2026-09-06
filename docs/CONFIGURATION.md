# Configuration

Embassy requires macOS and Node.js 22 or newer.

Embassy has one broker per login user and machine. Configuration is inherited
when the broker starts; changing it requires a broker restart. Provider build
or version metadata never grants routing authority.

## State and node inventory

`EMBASSY_STATE_DIR` may set an absolute state directory. Otherwise Embassy
uses `$XDG_STATE_HOME/agent-embassy`, or
`$HOME/.local/state/agent-embassy` when `XDG_STATE_HOME` is unset.
Every client shell must use the same state-directory configuration captured
by the installed service.

The directory must be owned by the current user, mode 0700, and must not be a
symbolic link. `gateway-state.json`, `nodes.json`, and other broker-owned files
are mode 0600. The private control socket is inside this directory. A Codex or
Claude sandbox must be able to read and write the directory for commands that
contact the broker. If access was expected, also verify the configured state
directory belongs to this user; do not start a second broker to work around an
access denial.

`nodes.json` is the static host and federation inventory.
Create the private state directory before saving the example, and set directory
mode 0700 and `nodes.json` mode 0600 before installing the service.

A machine without peers uses an empty list:

```json
{"version":1,"host":"studio","nodes":[]}
```

If the file is absent on the first single-machine boot, Embassy derives a
lower-case host from the machine's short hostname (or `localhost` when that is
not a valid token) and atomically installs a version-1 file with `nodes:[]`.
This default is transient until the file is written; a present file is never
rewritten. Create it before first boot when choosing an explicit host name or
configuring federation.

`host` is the canonical local host name used in aliases. `nodes` is the list
of directly reachable Embassy hosts. Entries must be unique, must not include
the local host, and must use lower-case host tokens. There is no environment
fallback, dynamic discovery, or multi-hop routing.

Local route aliases end in the inventory's exact host. `register-codex` and
`retire` refuse a different host. Remote routes are resolved through the owner
listed in `nodes`; they can be retired only on that owner.
Read `host` from the `nodes.json` that first boot created and use it as every
local `@host` suffix; the examples use `@studio` only when you explicitly chose
`host: studio`, not as a universal alias suffix.

## Delivery settings

All integer settings are decimal integers. Invalid or inconsistent values stop
the broker with `INVALID_GATEWAY_CONFIGURATION`.

| Variable | Default | Accepted range |
|---|---:|---:|
| `EMBASSY_MAX_ROUTES` | 128 | 2–128 |
| `EMBASSY_MAX_QUEUE_MESSAGES` | 100 | 1–100 |
| `EMBASSY_MAX_QUEUE_PER_ROUTE` | 20 | 1–20 and no greater than the total queue |
| `EMBASSY_MAX_IN_FLIGHT` | 16 | 1–16 and no greater than the total queue |
| `EMBASSY_MAX_MESSAGE_BYTES` | 16384 | 1–16384 |
| `EMBASSY_MAX_QUEUE_BYTES` | 1048576 | 1024–1048576 and no smaller than one message |
| `EMBASSY_MESSAGE_DEADLINE_MS` | 14400000 | 1000–86400000 |
| `EMBASSY_RATE_LIMIT` | 30 | 1–10000 |
| `EMBASSY_RATE_WINDOW_MS` | 60000 | 1000–3600000 |
| `EMBASSY_EVENT_CAPACITY` | 500 | 10–500 |
| `EMBASSY_EVENT_TTL_MS` | 86400000 | 60000–604800000 |

The event settings bound recent terminal delivery and retirement evidence; they
do not enable a general activity journal. The state also has a fixed retained
byte budget.

`EMBASSY_STEERING_ENABLED` is `1` by default. Set exactly `0` to treat a
leading `STEER:` as an ordinary Claude-to-Codex message. No other value is
accepted.

## Provider contracts

### Claude Code

Embassy reads Claude's current-user session registry and connects to the exact
session's private Unix socket. Only interactive and background sessions using
Claude peer protocol 1 are eligible. A malformed or incompatible record is
rejected in isolation. Discovery and workspace/path evidence are checked again
for each native write.

A Claude caller is identified from its inherited absolute
`CLAUDE_CODE_MESSAGING_SOCKET`. The path is never accepted as a CLI option,
printed, or persisted. Claude sessions receive natively. They send in one CLI
step with `embassy send`; Embassy does not publish helper agents into Claude's
native agent list.

### Codex CLI

To receive in Codex, use its managed standalone installation with its App Server
daemon already running under the same macOS login; merely having a `codex`
executable on PATH is insufficient, and Embassy does not install, start or
update that daemon.

Embassy observes the daemon's recency-sorted top 20 unarchived root threads and keeps them
current from lifecycle and name events. Native names become public lookup
aliases; native task IDs remain only in the closed private endpoint binding,
while previews, turns and item content are neither retained nor printed.
Sub-agents are not discovered or displayed. Busy roots queue ordinary messages;
waiting means approval/user input, idle means ready, and dormant means unloaded.
Delivery resumes the exact dormant root without retaining history.
Embassy derives a safe alias from the native name: normalized
lower-case ASCII tokens, a `codex-` prefix, at most 32 characters before
`@host`. A missing, `Untitled task`, or native-ID-revealing name gets a stable alias from
the opaque Embassy endpoint ID, never from the native task ID.

Absence from the daemon's loaded list alone never marks an agent unreachable;
dormant wake is ordinary use. Embassy labels a session unsupported only from
positive native evidence.

`embassy register-codex --alias ...` remains a fallback for harnesses without
native daemon integration. It uses the caller's inherited `CODEX_THREAD_ID`;
the ID is not a command argument or public output. A fallback registration is
the same endpoint kind as discovery, and a matching native identity cannot
create a duplicate. Each delivery independently attests the current App Server
interface and exact task before authorization.
Explicit registration sets a private retention marker, so older roots remain
listed after restart even outside the discovery window. Window aging preserves
automatic rows referenced by pending work, but drops unused automatic rows to
release capacity. No retirement, suppression or settlement occurs. A returning
root keeps its ID while retained/pending; after pruning it receives a fresh ID,
and old receipts never retarget. An unnamed root gets a new generated alias
after pruning. The existing 128-endpoint bound remains.
No discovered/registered badge is exposed.
Explicitly registered rows keep their registered aliases through native scans;
native names drive automatic rows only. A later explicit registration can rename
the retained row without moving its identity or admitted work.
The ellipsis in `--alias ...` is a substitution: use the task's chosen
`codex-` name with this machine's exact `@host` suffix.

`register-codex --succeeds <old-alias>` atomically retires a predecessor and
installs the caller. It never reanchors pending work to a new identity.

Explicit retirement suppresses re-discovery of that native identity while its
bounded retirement evidence remains. Embassy never answers approvals or
changes a task's sandbox or approval policy. It consumes only the App Server
metadata and operation methods needed for discovery, unsubscribe, resume,
delivery and exact-turn STEER; it exposes no generic provider RPC.

## SSH federation

Install Embassy and run `embassy service install` on both Macs; for `studio`
and `laptop`, use `{"version":1,"host":"studio","nodes":["laptop"]}` on
studio and `{"version":1,"host":"laptop","nodes":["studio"]}` on laptop,
with each peer name matching both the remote inventory's `host` and a working
SSH destination or `~/.ssh/config` Host alias.

After changing a running broker's inventory, reload it with
`embassy service install`; wait for `codex-reviewer@laptop` to appear from the
Codex daemon on laptop (or use fallback registration), then ask the Claude
session on studio to run
`embassy send --to codex-reviewer@laptop` with the message on stdin.

For each configured remote node Embassy runs the fixed system SSH client in
batch mode with forwarding and local commands disabled. Authentication is the
user's SSH configuration. The remote command is `embassy peer-stdio`; the two
installations must speak federation peer protocol 3.

Any plain same-user SSH login that can run that command is sufficient; Embassy
does not require a forced command, per-node key, or special SSH environment.
The peer claims its logical host in `initialize`, and the receiving broker
requires that host to be in its `nodes.json` peer list. The SSH login is
trusted, so the claim is trusted too. Keep the local `host` correct when
copying configuration: a wrong allowed host label can misattribute origin.

From studio, verify the remote command environment with
`/usr/bin/ssh laptop 'which -a embassy; node --version; embassy --version'`,
then verify the corresponding direction from laptop; both remote Node and
Embassy must resolve without an interactive shell or password prompt.
Federation does not accept a password, private key, host override, or arbitrary
SSH argument from Embassy configuration.

Remote endpoint catalogs are bounded memory-only caches. The owner is queried
again for exact identity resolution. A handoff is one correlated write, the
destination persists its queue before acceptance, and an uncertain result is
never replayed.

`embassy refresh` observes configured catalogs in parallel with local Claude
and Codex discovery. A successful observation replaces that node's bounded display rows
and timestamp. A failed observation retains its last rows and records
`PEER_TUNNEL_UNAVAILABLE`. `embassy status` reads that snapshot without SSH or
provider I/O. Display is capped at 128 remote rows across all nodes; exact and
named routing always queries the owner and is unaffected by display truncation.

## Multi-host terminal

`embassy tui` uses this inventory for its host overview. Opening it in a terminal
starts bounded status reads over the same non-interactive SSH configuration as
federation; it does not modify SSH keys, configuration, or broker protocols.
Use `[` / `]` for host selection. Explicit actions execute the existing CLI on
that host, and remote retirement confirms the HOST and full endpoint ID.
Read timeout is eight seconds; refresh/retire allow fifteen seconds and loopback
check thirty. A timed-out SSH process is terminated, escalated after one second,
and never overlapped by a replacement before it closes. Its pane stays stale;
local operation and other hosts continue. Version diagnostics are lazy remote
CLI observations only, never broker-version evidence. Unsupported shapes refuse
display as current data and disable retirement until a supported fresh read.

## launchd service

```sh
embassy service install
embassy service status
embassy service uninstall
```

`embassy service install` starts the per-user launchd agent immediately and
arranges login startup; use the same command to reload broker configuration or
start a stopped installation, and use `embassy service uninstall` to stop and
unload it.

The service is a per-user launchd agent. Installation captures the absolute
Node executable and Embassy CLI file, plus every nonempty `EMBASSY_*` value and
`XDG_STATE_HOME` from the installing shell. It captures no other environment
entry and no arbitrary `PATH`; do not put secrets in an `EMBASSY_*` variable.
Re-run installation after moving or replacing the package.
`service status` reports when a recorded program path no longer exists.

The plist uses `RunAtLoad` and `KeepAlive` with only `Crashed: true`. A verified
`SIGABRT` crash relaunches it. A clean exit, nonzero boot refusal, ordinary
`SIGTERM`, or a deliberate
`kill -9` leaves the service not running. Use `embassy service status` to
observe that state and run `embassy service install` deliberately.

The foreground alternative is `embassy serve`. It does not daemonize or open
a network listener. Both forms acquire the same fixed host-wide advisory lease
before provider setup, so only one broker can run.

## Private state reset

This release reads valid schema-6 `gateway-state.json` forward, treating every
existing row as retained; new writes use schema 7. The retention marker is the
only added field. Back up state before upgrading 4.2.0; no reset is required,
but 4.2.0 refuses schema 7 and rollback requires the pre-upgrade backup.
There is no 3.x converter. Schema ≤5 or unknown schemas refuse with
`GATEWAY_STATE_SCHEMA_UNSUPPORTED`; malformed accepted schemas refuse with
`CORRUPT_GATEWAY_STATE`. Refusal does not mutate the installed file.

Reset procedure:

1. Before replacing a 3.x installation, use its matching CLI to inspect and
   settle or explicitly abandon pending work.
2. Stop a launchd broker with `embassy service uninstall` (or stop the foreground
   serve process) and confirm it is stopped with `embassy service status`.
3. Back up and move aside only `gateway-state.json` in that broker's state
   directory. Keep the valid `nodes.json`.
4. Install the current discovery-enabled 4.x release, then run
   `embassy service install`.
5. The broker creates fresh schema-7 state.
6. Let current Codex agents be discovered. Use fallback registration only for
   non-native harnesses. Claude endpoints are recorded on discovery/use.

All state produced by Embassy 3.x is unsupported by 4.x; preserve the matching
old binary as well as its old state if rollback may be needed, and never run
the old and new brokers together.

A reset abandons unsettled work and invalidates delivery tokens and
conversation references. Rollback means stopping v4 and restoring both the old
binary and its untouched old state. Never hand-edit either schema.
After v4 has accepted work, the old backup does not contain that work. Before
rolling back, inspect and drain or explicitly abandon v4 deliveries, and keep
a separate backup of the v4 state. Restoring v3 is not a rollback of those
delivery effects and must never silently discard unsettled v4 work.
