# Configuration

Embassy has one broker per login user and machine. Configuration is inherited
when the broker starts; changing it requires a broker restart. Provider build
or version metadata never grants routing authority.

## State and node inventory

`EMBASSY_STATE_DIR` may set an absolute state directory. Otherwise Embassy
uses `$XDG_STATE_HOME/agent-embassy`, or
`$HOME/.local/state/agent-embassy` when `XDG_STATE_HOME` is unset.

The directory must be owned by the current user, mode 0700, and must not be a
symbolic link. `gateway-state.json`, `nodes.json`, and other broker-owned files
are mode 0600. The private control socket is inside this directory. A Codex or
Claude sandbox must be able to read and write the directory for commands that
contact the broker. If access was expected, also verify the configured state
directory belongs to this user; do not start a second broker to work around an
access denial.

`nodes.json` is the static host and federation inventory. A machine without
peers uses an empty list:

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

A Codex task registers itself with `embassy register-codex --alias ...` using
its inherited `CODEX_THREAD_ID`. The ID is not a command argument or public
output. Registration is a logical state change and performs no App Server I/O.
Each delivery independently attests the current App Server interface and exact
task before authorization, resumes that task without retaining history, and
writes through a fresh operation.

`register-codex --succeeds <old-alias>` atomically retires a predecessor and
installs the caller. It never reanchors pending work to a new identity.

## SSH federation

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

The non-interactive SSH environment must resolve the intended `embassy`
installation. Verify that environment with `which -a embassy`. Federation
does not accept a password, private key, host override, or arbitrary SSH
argument from Embassy configuration.

Remote endpoint catalogs are bounded memory-only caches. The owner is queried
again for exact identity resolution. A handoff is one correlated write, the
destination persists its queue before acceptance, and an uncertain result is
never replayed.

`embassy refresh` observes configured catalogs in parallel with local Claude
discovery. A successful observation replaces that node's bounded display rows
and timestamp. A failed observation retains its last rows and records
`PEER_TUNNEL_UNAVAILABLE`. `embassy status` reads that snapshot without SSH or
provider I/O. Display is capped at 128 remote rows across all nodes; exact and
named routing always queries the owner and is unaffected by display truncation.

## launchd service

```sh
embassy service install
embassy service status
embassy service uninstall
```

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
observe that state and start or reinstall it deliberately.

The foreground alternative is `embassy serve`. It does not daemonize or open
a network listener. Both forms acquire the same fixed host-wide advisory lease
before provider setup, so only one broker can run.

## Private state reset

Version 4 accepts only schema-6 `gateway-state.json`. It deliberately contains
no v3 converter or compatibility reader. An older or unknown schema refuses
with `GATEWAY_STATE_SCHEMA_UNSUPPORTED`; invalid schema-6 bytes refuse with
`CORRUPT_GATEWAY_STATE`. Refusal does not mutate the installed file.

Reset procedure:

1. With the old matching binary, inspect delivery state and settle or abandon
   work deliberately.
2. Stop the broker and confirm the service is not running.
3. Copy the old `gateway-state.json` to an operator-owned backup.
4. Move the installed state file aside. Keep the valid `nodes.json`.
5. Start the v4 broker; it creates fresh schema-6 state.
6. Re-register Codex tasks. Claude endpoints are recorded on discovery/use.

A reset abandons unsettled work and invalidates delivery tokens and
conversation references. Rollback means stopping v4 and restoring both the old
binary and its untouched old state. Never hand-edit either schema.
After v4 has accepted work, the old backup does not contain that work. Before
rolling back, inspect and drain or explicitly abandon v4 deliveries, and keep
a separate backup of the v4 state. Restoring v3 is not a rollback of those
delivery effects and must never silently discard unsettled v4 work.
