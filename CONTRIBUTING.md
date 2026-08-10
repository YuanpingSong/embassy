# Contributing to Embassy

Embassy connects two powerful local agent runtimes across version-pinned native
interfaces. Small changes can alter permission, privacy, or delivery behavior,
so contributions should be narrow, testable, and explicit about boundaries.

## Development setup

Use macOS, Node.js 20 or newer, and the npm version declared in `package.json`.

```bash
npm ci
npm run check
```

`npm run check` type-checks and runs the deterministic test suite. Routine tests
use fake Claude peers, fake App Server transports, and temporary directories;
they must not contact Anthropic, OpenAI, SSH hosts, live provider sockets, or
models.

## Before opening a pull request

- Run `npm run check`.
- Add deterministic regression coverage for routing, protocol, persistence,
  permission, process-lifecycle, or redaction changes.
- Keep the pull request focused and explain every security-boundary change.
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
- Exact compatible live same-UID Claude sessions may reach the registered
  native Codex peer without becoming outbound-selected.
- Claude's session UUID is its stable logical identity. Current names are a
  live index; do not add historical-name routing or PID/socket identity.
- Preserve current-name collision refusal and endpoint-generation fencing.

### Provider adapters

Claude Code's cross-session feature is official. Embassy's use of its external
registry and peer socket shape is an internal, version-pinned adapter. Codex App
Server is likewise version-pinned. Do not widen either compatibility range
without a documented review and deterministic fixtures for the new version.

The gateway may publish one process-owned `codex-*` peer so Claude's native
`ListAgents` and `SendMessage` tools can reach Codex. It must never overwrite a
foreign registry record, claim to be a Claude model session, or unlink a socket
whose exact generation it no longer owns.

App Server calls use a closed allowlist. Do not add a generic RPC method,
`turn/steer`, approval responses, history retrieval, shell execution, settings
mutation, or provider authentication. Keep `experimentalApi: true`
non-configurable and limited to `thread/resume.excludeTurns: true`; every resume
must require an empty `thread.turns` response.

### Permissions

Embassy does not set or override a Codex task's persistent approval or sandbox
policy. Registration is the gateway reachability boundary. The connector may
observe native route and approval-waiting status, but must not classify policy
or turn workspace/settings metadata into a second authorization gate.

For Codex-to-Claude delivery, Claude's `crossSessionInbound` behavior remains
native. Do not route around a hold or refusal or fabricate a successful receipt.

### Delivery and state

- Bodies and reply addresses are transient and bounded.
- Queue while a Codex task is busy; do not interrupt an unrelated turn.
- Distinguish gateway acceptance, transport progress, destination acceptance,
  terminal failure, ambiguity, expiry, and restart abandonment.
- Never retry an ambiguous provider write. Requeue only a confirmed clean
  deferral that has not crossed an ambiguous mutation boundary.
- Restarts discard bodies and leave restored routes stale until exact
  re-observation.
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
unpair, refresh-discovery, and stale-registration-removal mutations—never a
provider or generic control method. Do not add a wildcard/remote listener,
external assets, service workers, telemetry, or additional mutation endpoints.
Keep the public v1 launcher foreground, macOS-only, and local-host-only.

## Live validation

Do not run a live probe merely because a test would be convenient. Live Claude
registry discovery, peer connection, provider messaging, App Server turns, and
SSH attachment are separate external actions.

A live action requires an explicit user request that identifies its scope. For
a message, confirm the exact destination and body, send only once, avoid fanout,
and do not retry an ambiguous result. Never put real provider traffic in CI.

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
