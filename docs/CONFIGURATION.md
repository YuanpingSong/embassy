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

The live dashboard is available directly at `http://127.0.0.1:41961/` while
its foreground companion runs. Its port is a per-invocation CLI choice, not an
environment setting: pass `--port <n>` with an integer from 1024 through 65535
to `embassy dashboard --live` when another stable port is needed. Several
windows or browsers may use that URL. A port collision fails with
`LIVE_DASHBOARD_PORT_IN_USE`, points to `--port`, and never falls back to an
ephemeral or alternate port.

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

A CLI initiator receives the full `conv_` token in its result, and every routed recipient receives the same token in the inbound provenance envelope and reply hint. The token is a memory-only participant-scoped locator, not an authority credential: every `reply` rechecks caller identity, conversation membership, and the live route. The token no longer exists after a broker restart; it must likewise never be retried or reconstructed after route retirement or identity succession.

The public launcher accepts only host `this-mac`; remote connectors remain a future capability.

## Claude Code's own setting: `crossSessionInbound`

`crossSessionInbound` is Claude Code's native setting for cross-session
messaging: it decides whether a Claude session accepts, holds, or refuses
messages arriving from another session. Embassy needs it enabled on the
session you select as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

## Compatibility contract

Embassy speaks two provider surfaces that are not documented as stable third-party APIs. Compatibility is automatic and exact-pinned, not an operator workflow. This release accepts only:

- the Claude Code 2.1.226 launcher/runtime and peer protocol 1;
- already-running Claude peer sessions whose explicit reviewed version is 2.1.224, 2.1.225, or 2.1.226 and whose peer protocol is 1; and
- Codex App Server 0.147.0.

An unknown provider version or peer protocol, a required-schema failure, or an endpoint generation that fails fresh validation closes the affected surface. The broker owns bounded read-only compatibility validation as part of provider startup: it checks the configured launcher or managed installation, exact version, registry/control-socket shape, initialization and listing schemas, and protocol constants. These checks do not route a user message or start a model turn. Runtime parsing remains strict on every record, frame, and response.

Every replacement Codex App Server endpoint generation starts monitor-only. Embassy performs a fresh initialize and `thread/loaded/list` check on that generation, then re-anchors a retained route only when its exact private task identity is found once. Writes remain fenced until the controller activates that exact generation. A version or schema mismatch, missing task, duplicate task, or unclean transition leaves the route stale and write-disabled rather than retargeting it.

The managed Codex installation is resolved by exact path and version; a `codex` elsewhere on `PATH` is neither used nor modified. Claude is resolved from `EMBASSY_CLAUDE_BIN` or the official per-user launcher, never by searching `PATH`. Provider updates require an Embassy release that explicitly reviews and pins the new version.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while a selected UUID-bound route continues to work under the new name. A rename becomes visible at the session's next status transition — typically its next turn boundary — because Claude Code rewrites the session's registry record on those transitions, not at the moment of the rename; Embassy reflects the record, never the rename itself.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed. Compatible managed App Server generation changes and broker restarts can both re-anchor the exact loaded task automatically; a normal restart needs no manual registration. If boot reactivation cannot find that task exactly once, the route remains stale with `REOBSERVATION_REQUIRED`. Once the task is observable, recover it by rerunning `embassy register-codex --alias <same-alias>` from that exact Codex task without unregistering first. Never supply or reconstruct its thread ID. If the task no longer exists, the live dashboard can remove the retained registration only after the broker proves it stale on a dead endpoint generation.
