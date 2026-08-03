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
