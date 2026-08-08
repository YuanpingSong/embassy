# Contributing

## Development setup

Use Node.js 20 or newer and the npm version declared in `package.json`.

```bash
npm ci
npm run check
npm run demo
```

`npm run check` type-checks source and tests, builds the bridge, and runs the
deterministic test suite. The demo uses a fake driver and does not contact
Anthropic.

## Real local validation

Real Claude validation is deliberately opt-in and must never run in CI. It
requires an absolute `CLAUDE_BRIDGE_CLAUDE_BIN` pin and the explicit
`CLAUDE_BRIDGE_RUN_REAL_VALIDATION=1` authorization described in the README.
Never commit credentials, Claude configuration, raw model output, bridge
state, or generated validation artifacts.

## Change expectations

- Keep the MCP surface small and lifecycle-oriented.
- Preserve stdio protocol cleanliness: diagnostics go to stderr only.
- Keep read-only, no-network operation as the default.
- Preserve per-thread state ownership and fail-closed path validation.
- Add deterministic coverage for lifecycle, persistence, permission, or
  protocol changes.
- Keep pull requests focused and explain any security-boundary change.

## Gateway experiments

The experimental gateway is additive and does not change the released MCP
surface. Gateway changes require version-pinned protocol schemas, fake host
and peer adapters, and deterministic coverage for multi-host routing,
duplicate aliases, disconnects, stale generations, bounded queues,
cancellation, ownership, restart abandonment, and metadata redaction.

Preserve the separation between official product features and internal
adapters: Claude Code cross-session messaging is official, while the external
registry/UDS wire used by this project is pinned to the reviewed Claude Code
2.1.224 / peer protocol 1 boundary. Do not create fake Claude registry records
or advertise Codex routes as Claude sessions. Native Claude discovery returns
real Claude sessions; the gateway CLI/skill and dashboard expose Codex aliases.

The gateway may use one private same-user control UDS inside a controller-owned
mode-0700 directory. This does not change the stdio-only MCP invariant. Do not
add TCP, HTTP, a network dashboard, a generic provider-RPC method, or
`turn/steer`. Version 1 queues busy Codex routes.

Keep the shipped `serve` assembly local-host-only and its Codex factory
monitor-only. Enabling its write attestation or adding a remote provider is a
separate reviewed live gate, not a routine refactor.

Preserve the exact 0.147.0 privacy exception: `experimentalApi: true` is a
hard-coded, non-configurable prerequisite only for
`thread/resume.excludeTurns: true`. Do not add experimental methods or treat
the capability as write authority. Both resume paths must require an empty
`thread.turns` response and fail closed without retaining returned history.

Do not use App Server turn-level approval or sandbox overrides as temporary
message restrictions: the reviewed schema says those overrides persist into
subsequent turns. Writable inbound routing may use only a resumed Codex task
that already reports `never`, read-only, and no-network. Leave other routes
monitor-only and require the operator to reconfigure them natively.

Routine tests must not contact SSH hosts, provider sockets, or models. A live
host feasibility probe must be explicitly authorized, attach only to an
already-running App Server, use read-only protocol methods, suppress raw
identifiers and diagnostics, and clean up only the probe's own process.

Live Claude gates are similarly incremental: passive sanitized discovery,
gateway-owned callback lifecycle, one explicitly authorized delivery to a
named real Claude session, and a separate Claude-to-Codex turn. Never collapse
those gates into one test or automatically retry an ambiguous delivery.
