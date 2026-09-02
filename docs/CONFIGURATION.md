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
| `EMBASSY_TRACKING_ENABLED` | `1` | Global progress-watch kill switch; set exactly `0` to reject `--track`, `--idle-minutes`, and `TRACK:` open attempts. Active watches are memory-only and end with the broker process; they are never restored after restart. With no active watch, `DONE:` is inert and `untrack` is not specially rejected—it returns `NOT_FOUND`. Any value other than `1` or `0` is a configuration error |
| `EMBASSY_LOCALE` | `en` | CLI output language, exactly `en` or `zh-CN`. The `--lang` flag overrides it for the invocation that carries it; an unset or empty value means `en`, and any other value is an argument error |

Before any Embassy client call that talks to the broker, the CLI reads the state
directory and `nodes.json`, then connects to the control socket; grant a sandboxed
Codex task that directory as a writable root, or approve equivalent local access,
and do not relocate state or start a second broker to work around a denial.

Federation authority comes only from `nodes.json` in `EMBASSY_STATE_DIR`. It
must be a current-user-owned mode-0600 regular file whose exact object shape is
`{"version":1,"host":"<lowercase-host>","nodes":["<lowercase-ssh-alias>",...]}`.
`host` names this broker; `nodes` contains 0 through 31 unique OpenSSH aliases,
omits `host`, and keeps the federation at 32 total hosts or fewer. Each listed
node is the fixed SSH destination for `embassy peer-stdio`. The file is mandatory;
when it is absent, Embassy prints the exact `nodes:[]` local-only fix and refuses startup.
Removing a peer does not remove its durable mirrors; reset private state before restarting with that peer absent.

### Private state reset

Version 3 accepts only fresh schema-5 private state; it does not convert or
rewrite older state, including the schema-4 state written by the 2.x line. Before the reset, use the old running broker's `status`
and delivery lookups to verify that no queued, armed, or accepted work remains
and every delivery has settled. Then:

1. Stop the broker.
2. Move `gateway-state.json` aside so the old ledger remains recoverable.
3. Keep `nodes.json` in place.
4. Start the version-3 broker to create fresh state.
5. Re-register routes, select the Claude route, and pair the intended edges.

An old or unknown schema refuses with `GATEWAY_STATE_SCHEMA_UNSUPPORTED` and
does not mutate the state file. There is no conversion command or automatic
recovery path.

## Advanced bounds

These variables retain conservative defaults:

| Variable | Default |
| --- | ---: |
| `EMBASSY_MAX_ROUTES` | `128` |
| `EMBASSY_MAX_PAIRS` | `128` |
| `EMBASSY_MAX_WATCHES` | `32` |
| `EMBASSY_EVENT_CAPACITY` / `EMBASSY_EVENT_TTL_MS` | `500` / `86400000` |
| `EMBASSY_DEDUPE_CAPACITY` / `EMBASSY_DEDUPE_TTL_MS` | `2000` / `300000` |
| `EMBASSY_MAX_QUEUE_MESSAGES` / `EMBASSY_MAX_QUEUE_PER_ROUTE` | `100` / `20` |
| `EMBASSY_MAX_IN_FLIGHT` | `16` |
| `EMBASSY_MAX_QUEUE_BYTES` / `EMBASSY_MAX_MESSAGE_BYTES` | `1048576` / `16384` |
| `EMBASSY_MESSAGE_DEADLINE_MS` | `14400000` |
| `EMBASSY_RATE_LIMIT` / `EMBASSY_RATE_WINDOW_MS` | `30` / `60000` |

`EMBASSY_MAX_PAIRS` is the bound behind the README's "128 pairs by default"; its
range is 1 through 256. `EMBASSY_MAX_WATCHES` bounds concurrent progress watches
and is capped at 256. `EMBASSY_MAX_ROUTES` accepts 2 through 256. Every value in
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
messages arriving from another session. Embassy needs it enabled on the
session you select as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

This is the one prerequisite you must actively toggle, and it is the most
common first-run failure — because it fails *late*. Quickstart step 3
(`select-claude`) prints `"accepted":true` whether or not the setting is
enabled: selection creates no permission edge and never consults Claude's
native inbound policy. Create an explicit edge with `pair`; the refusal appears
when the send reaches the Claude end. If registration, selection, and pairing succeeded
but your first `send` does not arrive, check `crossSessionInbound` on
the destination session before suspecting the route.

## Provider and runtime contract

Embassy routes three providers: Claude over peer protocol 1, Codex over the managed App Server, and universal shell peers over the private control socket. The provider versions each release was tested with are listed in the [CHANGELOG](../CHANGELOG.md). Runtime never reads that record. A build or version fact can qualify the release's “tested with” claim, but it never grants or withholds routing authority.

Runtime is best effort: an explicit consent edge plus the exact owned route/session identity authorizes an attempt. The current per-operation transport, strict consumed wire fields, and correlated operation determine the result. Interface drift or a missing optional provider becomes provider-local degraded/offline health and an exact safe code; it does not create a compatibility tier or block unrelated providers.

Only unsafe OS evidence for Embassy-owned or executed artifacts and Embassy callback, control, or state paths—such as an unsafe lease or state, swapped binary, ownership/path/symlink mismatch, or invalid generation—refuses broker startup. The Claude-owned external sessions registry root is read-side identity evidence: an unsafe UID or mode degrades only Claude with a loud observation while the broker and other providers remain available. Claude still requires native `peerProtocol: 1` per session record: a record that declares any other value is rejected in isolation and included in bounded rejection evidence without stopping the broker or hiding other usable sessions.

Runtime parsing remains strict on every known registry field, frame, and response; unknown top-level Claude registry fields are ignored because Embassy never consumes them. The Claude connector row in public status carries optional bounded `registry` observations: `entriesScanned`, `parseableRecords`, monotonic `parseableRecordSeenSinceBoot`, bounded per-safe-code `rejected`, and `rejectedCodesOmitted`. `embassy status` reports the same evidence: if Claude is running but no record with parseable required fields has been observed since broker start, its registry layout may have changed.

The managed Codex installation is resolved by exact verified path; a `codex` elsewhere on `PATH` is neither used nor modified. Claude registry and callback roots are derived from the verified current OS user; no Claude launcher or configuration file is read. Version strings, when present, are bounded diagnostic metadata only.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while a selected UUID-bound route continues to work under the new name. A rename becomes visible at the session's next status transition — typically its next turn boundary — because Claude Code rewrites the session's registry record on those transitions, not at the moment of the rename; Embassy reflects the record, never the rename itself.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed. Registration performs no App Server operation. Every delivery opens and attests a fresh managed transport, initializes it, resumes the exact task with history excluded, and authorizes the body write once. App Server, Desktop, and broker restarts do not change logical route authority or require re-registration. A current unavailable or unobservable task reports an operation-local safe code while the registration and consent edge remain.

Shell routes use `peer-*` aliases and a `peer_` token minted at registration.
The broker persists only its UID/alias/token hash route handle, never the raw
token. Authenticated calls accept the token on the first stdin line with
`--token-stdin`; body-bearing calls use the remaining bytes as the body.
`--emit-env` remains optional for stable-shell harnesses. There is no PID
binding, token file, Keychain entry, daemon, or alternate persistence path.
