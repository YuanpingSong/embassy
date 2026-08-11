# Configuration and compatibility

Embassy is configured through environment variables read when each command
starts. This document collects every variable, the compatibility contract with
Claude Code and the Codex App Server, managed-binary resolution rules, and
the addressing model. There is no configuration file; all values are env vars
or CLI flags.

---

## Common configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`, or `$HOME/.local/state/agent-embassy` when `XDG_STATE_HOME` is unset | Private state, control socket, and dashboard; an override must be absolute and does not relocate the fixed host-wide lease |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`, resolved to the pinned version target | Absolute Claude Code launcher path; `PATH` is not searched |
| `EMBASSY_STEERING_ENABLED` | `1` | Global Claude-to-Codex `STEER:` kill switch; set exactly `0` to treat every Claude-to-Codex body as an ordinary Codex-bound queued message; Claude-bound mailbox timing is unchanged |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude sender notice policy: `merged` keeps stalls and folds terminal diagnostics into native status; `verbose` emits both; `quiet` emits no gateway user-frame notices |
| `EMBASSY_TRACKING_ENABLED` | `1` | Global progress-watch kill switch; set exactly `0` to reject `--track`, `--idle-minutes`, `untrack`, and the `TRACK:`/`DONE:` body prefixes. Any value other than `1` or `0` is a configuration error |
| `EMBASSY_LOCALE` | `en` | CLI output language, exactly `en` or `zh-CN`. The `--lang` flag overrides it for the invocation that carries it; an unset or empty value means `en`, and any other value is an argument error |
| `EMBASSY_HOSTS` | `this-mac` | Comma-separated list of 1 through 32 unique lowercase host aliases. **The v1 launcher accepts only the single exact value `this-mac`**: any other list — including a longer one that contains `this-mac` — fails `embassy serve` closed with `GATEWAY_REMOTE_PROVIDER_DISABLED`. The variable exists for the deferred remote-consulate work and has no useful setting today |

The live dashboard is available directly at `http://127.0.0.1:41961/` while
its foreground companion runs. Its port is a per-invocation CLI choice, not an
environment setting: pass `--port <n>` with an integer from 1024 through 65535
to `embassy dashboard --live` when another stable port is needed. Up to four
concurrent live views — across windows, tabs, or browsers — can use that URL
while the foreground process runs; a fifth stream is refused until one closes.
A port collision fails with
`LIVE_DASHBOARD_PORT_IN_USE`, points to `--port`, and never falls back to an
ephemeral or alternate port.

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

A CLI initiator receives the full `conv_` token in its result, and every routed recipient receives the same token in the inbound provenance envelope and reply hint. The token is a memory-only participant-scoped locator, not an authority credential: every `reply` rechecks caller identity, conversation membership, and the live route. The token no longer exists after a broker restart; it must likewise never be retried or reconstructed after route retirement or identity succession.

The public launcher accepts only host `this-mac`; remote connectors remain a future capability. `register-codex` therefore takes an optional `--host <id>`, but `this-mac` is the only value the broker will admit, and the alias must end in `@<id>` to match. `--host` is also mutually exclusive with `--succeeds`, which always inherits the succeeded alias's host.

## Claude Code's own setting: `crossSessionInbound`

`crossSessionInbound` is Claude Code's native setting for cross-session
messaging: it decides whether a Claude session accepts, holds, or refuses
messages arriving from another session. Embassy needs it enabled on the
session you select as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

This is the one prerequisite you must actively toggle, and it is the most
common first-run failure — because it fails *late*. Quickstart step 3
(`select-claude`) prints `"accepted":true` whether or not the setting is
enabled: selection only creates Embassy's own permission edge and never
consults Claude's native inbound policy. The refusal appears at step 4, when
the send reaches the Claude end. If registration and selection both succeeded
but your first `send-to-claude` does not arrive, check `crossSessionInbound` on
the destination session before suspecting the route.

## Compatibility contract

Embassy speaks two provider surfaces that are not documented as stable third-party APIs. Compatibility is automatic and exact-pinned, not an operator workflow. This release accepts only:

- the Claude Code 2.1.227 launcher/runtime and peer protocol 1;
- already-running Claude peer sessions whose explicit reviewed version is 2.1.224, 2.1.225, 2.1.226, or 2.1.227 and whose peer protocol is 1; and
- Codex App Server 0.147.0.

An unknown provider version or peer protocol, a required-schema failure, or an endpoint generation that fails fresh validation closes the affected surface. The broker owns bounded read-only compatibility validation as part of provider startup: it checks the configured launcher or managed installation, exact version, registry/control-socket shape, initialization and listing schemas, and protocol constants. These checks do not route a user message or start a model turn. Runtime parsing remains strict on every record, frame, and response.

Every replacement Codex App Server endpoint generation starts monitor-only. Embassy performs a fresh initialize and `thread/loaded/list` check on that generation, then re-anchors a retained route only when its exact private task identity is found once. Writes remain fenced until the controller activates that exact generation. A version or schema mismatch, missing task, duplicate task, or unclean transition leaves the route stale and write-disabled rather than retargeting it.

The managed Codex installation is resolved by exact path and version; a `codex` elsewhere on `PATH` is neither used nor modified. Claude is resolved from `EMBASSY_CLAUDE_BIN` or the official per-user launcher, never by searching `PATH`. Provider updates require an Embassy release that explicitly reviews and pins the new version.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while a selected UUID-bound route continues to work under the new name. A rename becomes visible at the session's next status transition — typically its next turn boundary — because Claude Code rewrites the session's registry record on those transitions, not at the moment of the rename; Embassy reflects the record, never the rename itself.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed. Compatible managed App Server generation changes and broker restarts can both re-anchor the exact loaded task automatically; a normal restart needs no manual registration. If boot reactivation cannot find that task exactly once, the route remains stale with `REOBSERVATION_REQUIRED`. Once the task is observable, recover it by rerunning `embassy register-codex --alias <same-alias>` from that exact Codex task without unregistering first. Never supply or reconstruct its thread ID. If the task no longer exists, the live dashboard can remove the retained registration only after the broker proves it stale on a dead endpoint generation.
