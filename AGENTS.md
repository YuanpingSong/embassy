# Repository guidance

This project is a local-only MCP bridge around the installed Claude Code CLI.
Treat authentication, process control, state ownership, permission policy, and
stdio protocol correctness as security-sensitive boundaries.

## Required checks

Run `npm run check` after source or test changes. Run `npm run demo` when the
MCP lifecycle or tool schemas change. Routine tests must use the fake driver
and must not invoke Claude or make model requests.

The real validator is opt-in only. Never enable it in CI or run it without an
explicit user request authorizing one local Claude request.

## Invariants

- Never read, print, copy, accept, or persist credentials or OAuth material.
- Never forward credential-bearing environment variables.
- Keep the MCP server on stdio; never expose it as a network service.
- Keep raw prompts, model output, tool inputs, tool outputs, and stderr out of
  normalized persisted task state.
- Keep read-only, no-network operation as the default.
- Preserve authoritative Codex thread ownership and task isolation.
- Preserve exact-session resume behavior and confirmed process termination.
- Preserve fail-closed validation for workspaces and controller-owned state.
- Do not widen tools, settings sources, hooks, plugins, agents, or MCP access
  without explicit security review and deterministic regression tests.
- Never write protocol diagnostics to stdout.

Do not commit `node_modules`, `dist`, package archives, local state, logs,
environment files, Claude configuration, or validation artifacts.
