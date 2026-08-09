# Configuration and compatibility

Embassy is configured through environment variables read at `embassy serve`
start. This document collects every variable, the compatibility contract with
Claude Code and the Codex App Server, managed-binary resolution rules, and
the addressing model. There is no configuration file; all values are env vars
or CLI flags.

---

## Common configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`, or `$HOME/.local/state/agent-embassy` when `XDG_STATE_HOME` is unset | Private state, control socket, and dashboard; an override must be absolute and does not relocate the fixed host-wide lease |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`, resolved to the pinned version target | Absolute Claude Code launcher path; `PATH` is not searched |
| `EMBASSY_STEERING_ENABLED` | `1` | Global `STEER:` kill switch; set exactly `0` to treat every body as an ordinary queued message |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude sender notice policy: `merged` keeps stalls and folds terminal diagnostics into native status; `verbose` emits both; `quiet` emits no gateway user-frame notices |

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
| `EMBASSY_MESSAGE_DEADLINE_MS` | `300000` |
| `EMBASSY_MAX_HOPS` | `2` |
| `EMBASSY_RATE_LIMIT` / `EMBASSY_RATE_WINDOW_MS` | `30` / `60000` |

The public launcher accepts only host `this-mac`; remote connectors remain a future capability.

## Claude Code's own setting: `crossSessionInbound`

`crossSessionInbound` is Claude Code's native setting for cross-session
messaging: it decides whether a Claude session accepts, holds, or refuses
messages arriving from another session. Embassy needs it enabled on the
session you select as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

## Compatibility contract

Embassy currently speaks two version-pinned surfaces that are not documented as stable third-party APIs:

- Claude Code 2.1.226, peer protocol 1; compatible still-running 2.1.224 and 2.1.225 sessions are accepted during a patch transition
- Codex App Server 0.147.0

Every record, socket, and response shape is validated before use. An unknown provider version fails closed instead of being guessed compatible. Expect an Embassy adapter update after either provider changes these internal surfaces.

The managed Codex installation is resolved by exact path and version; a `codex` elsewhere on `PATH` is neither used nor modified. Claude is resolved from `EMBASSY_CLAUDE_BIN` or the official per-user launcher, never by searching `PATH`.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while a selected UUID-bound route continues to work under the new name.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed.
