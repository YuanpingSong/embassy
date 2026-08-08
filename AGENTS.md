# Repository guidance

This project is a local-only MCP bridge around the installed Claude Code CLI,
plus an experimental same-user Claude–Codex message gateway. Treat
authentication, process control, state ownership, permission policy, stdio
protocol correctness, provider adapters, and gateway routing as
security-sensitive boundaries.

## Required checks

Run `npm run check` after source or test changes. Run `npm run demo` when the
MCP lifecycle or tool schemas change. Routine tests must use the fake driver
and must not invoke Claude or make model requests.

The real validator is opt-in only. Never enable it in CI or run it without an
explicit user request authorizing one local Claude request.

Gateway tests must use test-owned temporary directories, fake peer sockets,
and fake App Server transports. Never enumerate the live Claude registry,
connect a live Claude session socket, attach to a live App Server or SSH host,
or send a provider message without the corresponding explicit user
authorization gate.

## Invariants

- Never read, print, copy, accept, or persist credentials or OAuth material.
- Never forward credential-bearing environment variables.
- Keep the MCP server on stdio; never expose it as a network service. The
  gateway may use only its documented private same-user control UDS inside a
  controller-owned mode-0700 directory; it must not listen on TCP or HTTP.
- Keep raw prompts, model output, tool inputs, tool outputs, and stderr out of
  normalized persisted task state.
- Keep read-only, no-network operation as the default.
- Preserve authoritative Codex thread ownership and task isolation.
- Preserve exact-session resume behavior and confirmed process termination.
- Preserve controller-owned state validation. Provider workspaces follow the
  permissions of their already-selected local sessions.
- Do not widen tools, settings sources, hooks, plugins, agents, or MCP access
  without explicit security review and deterministic regression tests.
- The gateway may publish exactly one process-owned `codex-*` peer in Claude's
  native session registry and must remove it on shutdown. Never modify records
  owned by another process.
- Keep message bodies and callback/socket addresses memory-only. Claude's
  native session UUID is the logical route identity: it may persist in the
  controller-owned closed route-binding state and may be accepted as an
  explicit user-supplied CLI selector. Never emit it in normalized events,
  public snapshots, the dashboard, CLI output, aliases, logs, or error text.
  Other provider-native IDs remain private; never persist provider paths,
  histories, registry payloads, raw frames, prompts, replies, or diagnostics.
- Restored routes are stale and unusable until the exact host, endpoint
  generation, and target are positively re-observed; never replay a queued
  body after restart.
- Treat inherited `CLAUDE_CODE_MESSAGING_SOCKET` as a raw absolute path. It may
  be converted to an internal `uds:` reply capability only in memory; never
  accept, print, persist, or instruct the user to prefix it.
- Keep version-pinned Claude peer and Codex App Server methods fail-closed.
  Version 1 queues busy Codex routes and must not expose `turn/steer` or a
  generic provider-RPC escape hatch.
- Keep App Server 0.147.0 `experimentalApi: true` hard-coded solely for
  `thread/resume.excludeTurns: true`; it must not be configurable, authorize
  experimental methods, or widen writes. Require empty `thread.turns` on every
  resume before attestation and never retain returned history.
- Keep the shipped foreground launcher local-host-only. It may write only to
  explicitly registered Codex tasks and never mutates their persistent approval
  or sandbox policy.
- The dashboard is a private, atomically replaced static file only. It must
  contain allowlisted normalized metadata and no scripts, external assets,
  storage, telemetry, mutation endpoint, or network listener.
- Never write protocol diagnostics to stdout.

Do not commit `node_modules`, `dist`, package archives, local state, logs,
environment files, Claude configuration, or validation artifacts.
