# Contributing to Embassy

Embassy sits on identity, process, filesystem, protocol, persistence, and
delivery-settlement boundaries. Prefer a smaller responsibility set and a
direct implementation over a reusable abstraction the product does not need.

## Development setup

```sh
npm ci
TMPDIR=/tmp npm run check
```

Tests must use test-owned state directories, fake Claude sockets, fake App
Server transports, and fake SSH processes. Routine validation must not inspect
the live Claude registry, contact a live agent or App Server, connect an SSH
host, install a service, change global packages, or make a model request.

A live operation requires explicit user authorization for that exact operation
and must never run in CI.

## Core shape

Keep changes inside the shipped architecture:

- `ledger.ts` owns pure synchronous state transitions;
- `owned-state.ts` owns private atomic persistence;
- `endpoint-directory.ts` owns alias lookup and exact endpoint resolution;
- `coordinator.ts` owns batching, phase transitions, and scheduling;
- Claude, Codex, and SSH each have one explicit destination adapter;
- `broker.ts` composes application operations;
- `local-control.ts` and `broker-control.ts` expose one closed private control
  surface;
- `core-cli.ts` is the public command entry point.

Do not add another delivery machine, provider-independent engine, state store,
catalog authority, event journal, callback service, or migration layer unless
the product contract explicitly changes.

## Required invariants

- Endpoint IDs are identity; aliases are current lookup indexes. Resolve a name
  once and never silently retarget an admitted message.
- Validate the exact current endpoint and prepared bytes immediately before a
  native write.
- Keep `queued`, `reserved`, `armed`, `accepted`, and `terminal` distinct.
  Never retry an ambiguous write.
- Provider I/O never runs inside an owned-state transaction.
- A destination owns its queue; remote first contact is admitted only from an
  SSH-authenticated owner assertion.
- Keep every queue, body, batch, deadline, rate, retained row, protocol frame,
  and concurrent operation bounded.
- Keep native identifiers, addresses, message bodies, secrets, and raw
  provider data out of public projections and errors.
- Registration, replacement, retirement, restart, expiry, and late callbacks
  must settle work explicitly without moving it to another identity.
- Native receive/wake is the core behavior. CLI sending is intentional.
- STEER uses the exact accepted Codex operation at a safe boundary and never
  calls `turn/interrupt`.

The governing doctrine is
[What Embassy defends, and what it deliberately does not](SECURITY.md#what-embassy-defends-and-what-it-deliberately-does-not).
A new check must cite a current doctrine sentence. If none applies, propose a
contract change instead of silently widening the boundary.

## Testing changes

Characterize the behavior that matters at the real boundary before changing
it. Avoid a test that stubs the very loader, decoder, transport, or transaction
it claims to prove.

For delivery and persistence work, cover the failure phase, not merely the
success response: before reservation, before authorization, after arming,
after provider acceptance, after durable destination enqueue, restart, and a
late or duplicate completion. Mutation or ablation checks are useful when two
guards could mask one another.

For protocol and CLI work, pin the exact closed JSON shape, protocol number,
exit status, and stdout/stderr separation. For documentation, pin stable
commands and version facts directly rather than broad regular expressions that
unrelated prose can satisfy.

Run the full check after source or test changes. Use the soak suite when a
change affects scheduling, native transport, restart, or settlement.

## Repository hygiene

Do not commit `node_modules`, `dist`, package archives, state, logs,
environment files, provider configuration, credentials, or live-validation
artifacts. Keep public documentation free of personal absolute paths.

Never move tags, force-push shared branches, or edit public main directly.
Release actions, live drills, service installation, and global package changes
belong to the release operator.

## Security reports

Use the private security-reporting path. Public issues may include safe codes,
versions, and sanitized command names; they must not include message bodies,
native IDs, socket paths, credentials, histories, or raw provider output.
