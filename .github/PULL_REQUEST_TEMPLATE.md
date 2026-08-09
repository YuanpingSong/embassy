## What

<!-- What does this change do? -->

## Why

<!-- Why is this change needed? -->

## Checks

- [ ] `npm run check` passes (typecheck, build, deterministic test suite)
- [ ] `npm pack --dry-run` contains only the intended Embassy package files

## Security-invariant checklist

- [ ] `embassy serve` adds no TCP, HTTP, public API, or outbound provider
      connection; any live-dashboard change preserves its sole documented
      authenticated `127.0.0.1:0`, read-only, foreground exception
- [ ] No new credential, Keychain, OAuth, or transcript access
- [ ] No message body, prompt, reply, raw provider frame, or socket path is
      persisted (bodies stay memory-only; only closed route-binding metadata
      may persist)
- [ ] No version pin widened or made configurable (Claude Code 2.1.225 / peer
      protocol 1, Codex App Server 0.147.0) without explicit security review
- [ ] Codex-to-Claude sends still require explicit Claude selection; inbound
      Claude reachability never creates an outbound selection
- [ ] No Codex approval or sandbox policy is changed or overridden, and no
      approval request is answered by Embassy
- [ ] Docs updated (README, `docs/GATEWAY-ARCHITECTURE.md`, `SECURITY.md`, or
      `AGENTS.md` as applicable)

## Notes for reviewers

<!-- Anything a reviewer should pay special attention to, especially for security-sensitive changes. -->
