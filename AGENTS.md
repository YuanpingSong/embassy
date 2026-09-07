# Repository guidance

Embassy is a personal, same-user gateway between live Claude Code sessions and
Codex CLI tasks, locally and across user-owned Macs over SSH. Treat identity,
process control, private state, native protocol parsing, provider writes,
federation, and delivery settlement as security-sensitive boundaries.

## Working style

- Prefer the smallest direct implementation of the signed product contract.
  Remove responsibilities the product no longer owns; do not preserve an old
  abstraction merely because tests exist for it.
- Optimize for concrete progress and maintainable code. Avoid ticket ceremony,
  per-commit accounting, freeze rituals, status reports, and extra gates that
  do not improve the release candidate.
- Implementation is engineer-led. Contact the PM only for a decision
  that changes the signed contract, a blocker only the PM/founder can clear, or
  the final release-candidate handoff. Use Embassy as the exclusive PM channel.
- Use subagents for substantial independent work or hard review, with explicit
  non-overlapping file ownership. Do not delegate minute searches.
- Preserve unrelated user changes in a dirty worktree. Never write to public
  main, force-push, move tags, install global packages, or change live service,
  provider, skill, or sandbox configuration unless explicitly instructed.

## Required verification

Run `TMPDIR=/tmp npm run check` after source or test changes and before a
release candidate. Use the soak suite for scheduling, restart, native
transport, or settlement changes. Keep CI green when practical during
development; CI must be green at a release candidate.

Routine tests use test-owned temporary directories, fake Claude sockets, fake
App Server transports, and fake SSH processes. They must not inspect the live
Claude registry, connect a live provider or SSH host, install a service, or
make a model request.

A live provider read, connection, message, SSH drill, service mutation, or
global install requires the user's explicit authorization for that exact
operation. Previous authorization does not make later live operations routine.
Never enable live provider activity in CI.

## Core architecture

- `ledger.ts` is the pure synchronous transition core. It owns endpoint,
  delivery, rate, and retirement state but no filesystem, provider, callback,
  or timer work.
- `owned-state.ts` owns the single private schema-7 atomic JSON document.
- `endpoint-directory.ts` owns current alias lookup and exact endpoint
  resolution.
- `coordinator.ts` owns batching, scheduling, authorization, and phase-derived
  loss handling.
- `native-destinations.ts` provides the Claude-socket and Codex-operation write
  adapters. `federation.ts` provides the direct SSH adapter and protocol 3.
- `broker.ts` composes application operations. `broker-control.ts`,
  `local-control.ts`, and `core-cli.ts` are the closed private control and CLI
  surfaces. `runtime.ts` owns startup and shutdown ordering.

Do not add another delivery state machine, store, provider-independent engine,
catalog authority, callback service, activity journal, migration layer, or
generic provider RPC without an explicit contract change.

## Product and safety invariants

The governing doctrine is
[What Embassy defends, and what it deliberately does not](SECURITY.md#what-embassy-defends-and-what-it-deliberately-does-not).
A new audit check must cite a current doctrine sentence. If none applies,
propose a contract change rather than expanding the boundary through a test.

- Support Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex locally
  and across directly configured SSH gateways. Sending is one CLI command;
  receiving wakes the agent natively and never requires polling.
- Endpoint `(opaque ID, host, provider)` is identity. An alias is current lookup
  and display data. Resolve a name once; never silently retarget admitted work
  after rename, replacement, retirement, or catalog change.
- Discover Codex agents from bounded same-user App Server metadata. Keep the
  immutable native ID private, list only the recency top 20 roots, and treat
  native names as mutable aliases. `register-codex` remains a fallback using
  inherited `CODEX_THREAD_ID`; discovery and registration must reconcile one
  endpoint identity. Never accept, print, or guess the native ID. A Claude
  caller is derived from its inherited absolute
  `CLAUDE_CODE_MESSAGING_SOCKET`; never accept, print, or persist that path.
  Native IDs may exist only in closed private route state.
- Every provider write revalidates the exact current local endpoint and exact
  prepared bytes after preparation. Provider I/O never runs inside an
  owned-state transaction.
- Keep delivery phases `queued`, `reserved`, `armed`, `accepted`, and
  `terminal` distinct. Only positive no-write evidence may requeue work.
  Reserved work may recover after restart; armed and accepted uncertainty is
  terminal and is never replayed. Late callbacks cannot downgrade a terminal
  result.
- Keep bodies, queues, batches, deadlines, rates, retained rows, protocol
  frames, and concurrent operations bounded. One wake may carry a bounded FIFO
  batch, but every message retains its own identity, provenance, receipt, and
  result.
- Classify only an exact leading Claude-to-Codex `STEER:`. Use the exact
  accepted operation's `turn/steer` capability at a safe tool-call boundary;
  never inject mid-generation or call `turn/interrupt`. A cleanly unavailable
  boundary returns to the normal bounded queue.
- Ordinary Codex messages queue while an immediate status observation is
  active. Start only after observing idle. The residual other-client race is
  undetectable on the App Server wire: a receipt proves acceptance/lifetime,
  not fresh-turn creation. Do not add a native provider queue or replay the
  write.
- Embassy never changes a Codex approval or sandbox policy and never answers
  an approval. Keep `experimentalApi: true` limited to the explicit metadata,
  unsubscribe, resume and delivery methods used by this integration; require
  empty returned turns on resume and never retain provider history or model
  output.
- Direct SSH is authenticated by the user's configured `/usr/bin/ssh` process.
  The destination owns the queue. The peer's claimed host must be in nodes.json
  and its handoff source hosts must match; the SSH login and host claim are
  trusted, without a separate key/address-to-label attestation. Only
  a protocol-proven pre-enqueue refusal is definite; transport or post-commit
  uncertainty is never automatically retried.
- Remote catalogs are bounded memory-only observations. `refresh` may update
  them; `status` reads them without provider I/O. Exact and named routing always
  asks the owner. A stale or failed catalog is never routing authority.
- Public output is a closed projection. Never expose message bodies, native
  IDs/handles, socket paths, credentials, provider histories, exceptions, or
  raw frames. Never write protocol diagnostics to stdout.
- `health` describes local control. `check` proves only the broker's loopback
  ledger/coordinator/receipt path. Neither proves provider readiness, model
  comprehension, or cross-machine delivery.
- Private state is schema 7; a valid schema-6 document reads forward with
  existing rows retained. Schemas ≤5 and unknown state refuse without
  mutation. Private control protocol 6 needs a matching CLI and broker. A
  reset invalidates routes, receipts, and conversations; rollback requires the
  untouched old state and matching old binary.
- Preserve exact current-user ownership, modes, symlink, inode, lease, and
  used-artifact generation checks for every owned/executed path. Unsafe Claude
  registry evidence may quarantine Claude; unsafe broker-owned authority may
  refuse startup.

## Out of scope

Embassy has no native Claude sending advertisement or helper process, no
shell-peer registration, token, mailbox or await command, no automatic
Codex-output forwarding, no synthetic reply callbacks, no persisted remote
mirrors, no pair/selection graphs, no dashboard or watch streams, no
delivery-notice modes, no general counters or journals, and no old-state
conversion. Do not add any of them without a contract change. The broker-only
loopback check is not a user endpoint.

## PM communication failures

For a failed Embassy coordination send, inspect read-only status and the exact
delivery token when one exists. If acceptance is not confirmed, resend the
same coordination body up to three times. Never retry an ambiguous or
unconfirmed write, and never retry a send the recipient's user denied. Report
the exact safe code to the user if the channel still cannot accept the reply.

Pipe long prose from a temporary file into `embassy send --conversation`; do
not inline it in a shell argument. Never persist credentials or provider data
in a coordination artifact.

## Repository hygiene

Do not commit `node_modules`, `dist`, package archives, local state, logs,
environment files, provider/Claude configuration, credentials, or live-drill
artifacts. Keep public documentation free of personal absolute paths.
