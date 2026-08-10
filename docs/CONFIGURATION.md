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
| `EMBASSY_COMPAT_POLICY` | `observed` | `observed` admits an unknown same-major provider build only after its bounded schema probe passes; `strict` admits only the release's certified version inventory |
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

`EMBASSY_MAX_HOPS` accepts `0` through `16` and applies per conversation. The initial send has hop count 0; each routed reply adds one. The default `2` therefore admits the initial send and replies at hops 1 and 2. An attempt above the configured value is rejected and recorded with safe code `HOP_LIMIT_EXCEEDED`; the current CLI may collapse that pre-acceptance rejection code to the generic result `rejected`. Do not retry the exhausted token. Start a new conversation with a new send. Changes to this environment variable take effect when `embassy serve` starts.

A CLI initiator receives the full `conv_` token in its result, and every routed recipient receives the same token in the inbound provenance envelope and reply hint. The token is a memory-only participant-scoped locator, not an authority credential: every `reply` rechecks caller identity, conversation membership, the live route, and the current hop count. The token no longer exists after a broker restart; it must likewise never be retried or reconstructed after hop exhaustion, route retirement, or identity succession.

The public launcher accepts only host `this-mac`; remote connectors remain a future capability.

## Claude Code's own setting: `crossSessionInbound`

`crossSessionInbound` is Claude Code's native setting for cross-session
messaging: it decides whether a Claude session accepts, holds, or refuses
messages arriving from another session. Embassy needs it enabled on the
session you select as a Codex-to-Claude destination, and it cannot override
that decision. Configure it in Claude Code, not in Embassy.

## Compatibility contract

Embassy speaks two provider surfaces that are not documented as stable third-party APIs. This release's certified inventory is Claude Code 2.1.224–2.1.226 with peer protocol 1, and Codex App Server 0.147.0.

Compatibility has three explicit tiers:

- **certified** — the exact version is in this release's deterministic test inventory;
- **schema-attested** — under the default `observed` policy, an unknown same-major version passed the bounded startup probe; and
- **incompatible** — a required probe failed, the major version changed, or `strict` policy rejected a version outside the certified inventory.

The probe validates the launcher or managed installation, registry/control-socket shape, initialization and listing schemas, and protocol constants without sending a message or starting a turn. Its result is cached once per provider version. Runtime validation remains strict on every record, frame, and response. A schema-attested build can still change behavior without changing shape; use live certification after an upstream update when that residual risk matters.

Run `embassy compat-check` for the bounded non-traffic probe. Run `embassy compat-certify [--codex <alias>]` to add on-machine wire evidence: Embassy creates a short-lived, no-stdin Claude print session, confirms one marked diagnostic frame was written to that exact uniquely discovered scratch session, and then closes it. Direct `crossSessionInbound: accept` writes do not emit Claude's approval-specific native receipt, so wire certification does not claim a release receipt or model read. The chosen idle Codex task is resumed and refreshed without starting a turn. When more than one Codex route is registered, `--codex` is required. Add `--with-turn` only when you explicitly want one minimal Codex model turn (`reply OK`) as deeper evidence. Certification failures retain each surface's safe code and print both surface outcomes: exit `7` means Claude failed, `8` means Codex failed, and `9` means both failed; exit `5` remains reserved for a genuinely ambiguous control transport outcome. Certification evidence is retained with the provider version and shown in Diagnostics; it does not weaken runtime validation.

The managed Codex installation is resolved by exact path and version; a `codex` elsewhere on `PATH` is neither used nor modified. Claude is resolved from `EMBASSY_CLAUDE_BIN` or the official per-user launcher, never by searching `PATH`.

### Keeping up with provider updates

The repository does not install a background job. If you choose to automate checks, keep `embassy serve` separately supervised and use two user-owned LaunchAgents:

1. an update-triggered job whose `ProgramArguments` are the absolute Embassy binary path, `compat-certify`, `--codex`, and one exact registered alias, with `WatchPaths` containing the absolute Claude launcher and Codex app-bundle paths; and
2. a daily fallback whose `ProgramArguments` are the absolute Embassy binary path and `compat-check`, with a `StartCalendarInterval` of your choosing.

A minimal watched-job core looks like this; replace every placeholder with an absolute local path or alias before loading it:

```xml
<key>ProgramArguments</key>
<array>
  <string>/ABSOLUTE/PATH/TO/embassy</string>
  <string>compat-certify</string>
  <string>--codex</string>
  <string>codex-main@this-mac</string>
</array>
<key>WatchPaths</key>
<array>
  <string>/ABSOLUTE/HOME/.local/bin/claude</string>
  <string>/Applications/Codex.app</string>
</array>
```

For the daily job, replace `WatchPaths` with:

```xml
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
```

and use only `compat-check` in `ProgramArguments`. These commands contact the already-running local broker; they do not start it. The watched certification therefore fails safely if the selected route is missing or busy. The recipe intentionally omits `--with-turn`, so it never opts into the Codex model-call depth.

## Addressing

Claude sessions are addressed by their current `name@host` or by a user-supplied native session UUID. The UUID is the stable logical identity; the current name is a live lookup alias. After a rename, the old name stops resolving immediately while a selected UUID-bound route continues to work under the new name. A rename becomes visible at the session's next status transition — typically its next turn boundary — because Claude Code rewrites the session's registry record on those transitions, not at the moment of the rename; Embassy reflects the record, never the rename itself.

Names, old names, PIDs, registry paths, process generations, and socket generations never become alternate identity keys. Embassy refuses to guess when two live sessions share a current name.

Codex routes use an explicit `codex-*` alias and the task's inherited thread identity. The private thread ID is never accepted as a command-line argument or printed. While one broker process remains running, a compatible managed App Server endpoint-generation change can re-anchor the exact loaded task automatically. After `embassy serve` itself restarts, a retained Codex route currently remains stale with `REOBSERVATION_REQUIRED`; recover it by rerunning `embassy register-codex --alias <same-alias>` from that exact Codex task without unregistering first. Never supply or reconstruct its thread ID. If the task no longer exists, the live dashboard can remove the retained registration only after the broker proves it stale on a dead endpoint generation.
