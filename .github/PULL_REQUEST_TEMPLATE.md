## What

<!-- What does this change do? -->

## Why

<!-- Why is this change needed? -->

## Checks

- [ ] `npm run check` passes (typecheck, build, deterministic test suite)
- [ ] `npm pack --dry-run` contains only the intended Embassy package files

## Security-invariant checklist

- [ ] `embassy serve` adds no TCP, HTTP, public API, or outbound provider
      connection; Embassy creates no network listener at all
- [ ] No new credential, Keychain, OAuth, or transcript access
- [ ] No raw provider frame, callback address, socket path, or credential is
      persisted; message bodies and delivery status live only in the bounded
      mode-0600 private state
- [ ] No provider version fact becomes routing authority, and no protocol or
      schema number (state schema 5, control protocol 3, peer protocol 2,
      helper protocol 2, Claude peer protocol 1) changes without explicit
      review
- [ ] The permission model is unchanged: the OS boundary plus an exact alias
      is the permission, a Claude route installs on its first use, a colliding
      name is refused, and every routed body carries the provenance envelope
      naming its sender
- [ ] No Codex approval or sandbox policy is changed or overridden, and no
      approval request is answered by Embassy
- [ ] Docs updated (README, `docs/GATEWAY-ARCHITECTURE.md`, `SECURITY.md`, or
      `AGENTS.md` as applicable), and no shipped doc promises a record that
      does not exist

## Notes for reviewers

<!-- Anything a reviewer should pay special attention to, especially for security-sensitive changes. -->
