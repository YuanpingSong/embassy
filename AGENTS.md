# Repository guidance

This repository contains Embassy, a personal, same-user gateway between live
Claude Code sessions and Codex desktop tasks. Treat process control, state
ownership, permission behavior, native protocol parsing, provider adapters,
routing, and delivery settlement as security-sensitive boundaries.

## Required checks

Run `npm run check` after source or test changes. Routine validation must use
test-owned temporary directories, fake peer sockets, and fake App Server
transports. It must not enumerate the live Claude registry, connect a real
Claude peer, attach to a live App Server or SSH host, or make a model request.

A live provider read, connection, or message requires the user's explicit
authorization for that exact operation. A previous authorization does not make
live sends routine. Never enable a real provider message in CI.

## Working style

- Prefer the smallest implementation that solves the approved product problem.
  Avoid speculative abstractions, process ceremony, and extra gates that do not
  improve the shipped result.
- Optimize for concrete progress while preserving the security boundaries and
  required verification in this file. Stop expanding scope once the requested
  outcome is complete.
- Use subagents as leverage for substantial independent work or genuinely hard
  review, not for minute searches or edits. Give each one a clear, non-overlapping
  result and coordinate shared files explicitly.
- Keep progress updates concise and outcome-oriented. Spend effort on working
  code, focused evidence, and user-visible value rather than elaborate planning
  artifacts.
- Use Embassy as the exclusive PM coordination channel. Close every
  PM-initiated task with one reply on its originating conversation when it is
  ready, blocked, or complete. Do not add new coordination entries to legacy
  dead-drop files or create another out-of-band channel; treat existing files
  as read-only archives. If Embassy cannot accept a reply, report the exact
  failure to the user in the current task and stop unless the sender explicitly
  authorizes a bounded retry.

## Product invariants

The governing boundary doctrine is
[“What Embassy defends, and what it deliberately does not”](SECURITY.md#what-embassy-defends-and-what-it-deliberately-does-not).
Every new audit check must cite the doctrine sentence it enforces. If no current
sentence supports it, escalate an explicit doctrine-change proposal rather than
silently expanding the boundary through a test or hardening patch.

- Keep the shipped v1 launcher macOS-only, foreground, same-machine, and
  local-host-only. `embassy serve` must not daemonize or listen on TCP or HTTP.
  The only network listener is the separately invoked, foreground
  `embassy dashboard --live` companion: exact IPv4 loopback, one configured
  stable port, and closed with its command. Its plain loopback URL assumes a
  trusted single-user machine; preserve exact Host checks on every request and
  exact Origin plus the sentinel header on every POST.
- Keep the control plane on one private Unix-domain socket inside the
  controller-owned mode-0700 state directory. Controller files are mode 0600.
- A Codex task self-registers using its inherited `CODEX_THREAD_ID` and a
  `codex-*` alias. Never accept, print, or guess its thread ID.
- Codex-to-Claude delivery requires an already-selected compatible Claude
  session. A send must never select a merely discovered candidate.
- Any exact compatible live same-UID Claude session may reach the one
  registered `codex-*` peer. Inbound reachability must not select that Claude
  session for outbound delivery.
- Claude's native session UUID is the logical route identity. Current names are
  mutable lookup aliases; historical names do not resolve. A user-supplied UUID
  may be accepted as a CLI selector, but Embassy must never print or discover
  one through public output.
- Publish at most one process-owned `codex-*` registry record per supervised
  advertisement process. Remove only the exact-owned record and callback socket
  during graceful shutdown; never modify another process's artifacts.
- Persist message bodies only in the bounded mode-0600 broker state needed for
  the private ledger, live dashboard, and queued-delivery recovery. A queued,
  undispatched body may resume exactly once after restart; never retry an
  ambiguous write. Keep raw provider frames, callback addresses, socket paths,
  credentials, provider histories, and tool data memory-only.
- Closed private route state may retain the Codex thread ID and Claude session
  UUID needed for ownership and re-observation. Native IDs are forbidden from
  public snapshots, normalized events, the dashboard, aliases, logs, errors,
  and CLI output.
- Restored routes are stale until their exact current endpoint generation and
  provider target are positively re-observed.
- Treat inherited `CLAUDE_CODE_MESSAGING_SOCKET` as a raw absolute path. It may
  become an in-memory `uds:` capability only; never accept it from an argument,
  print it, persist it, or instruct the user to prefix it.
- Classify only an exact leading `STEER:` body in the Claude-to-Codex direction.
  Deliver it through the validated closed `turn/steer` schema at the next
  tool-call boundary; never interrupt or inject mid-generation. A cleanly unavailable
  boundary falls back to the normal bounded queue. Keep the global kill switch,
  three-steer per-route cap, normal receipts, and journal marker. Expose no
  generic provider RPC escape hatch or approval-response method. Interrupt only
  an exact turn started and positively observed by the same connector.
- Embassy never mutates a Codex task's persistent approval or sandbox policy
  and never answers approvals. Registration—not a read-only-policy classifier—
  is the gateway reachability boundary.
- Keep `experimentalApi: true` hard-coded solely for
  `thread/resume.excludeTurns: true`. Require an empty `thread.turns` response
  and never retain returned history.
- Keep provider compatibility evidence-gated. Attest exact owned paths before
  applying this ladder: a certified same-major build is writable; a same-major
  build whose bounded probes all pass is `schema_attested` and writable only
  when those probes cover the write path. Claude's probes cover its native
  write path. Codex's bounded pre-write reads may include `initialize`,
  `thread/loaded/list`, and registration-time `thread/resume`, but never
  `turn/start`; untested Codex 0.x therefore remains monitor-only pending a
  certified write schema. Failed probes leave only that provider degraded,
  monitor-only, and write-fenced; a
  different major or version evidence that cannot establish a safe major is
  also provider-local
  monitor-only, and probes must never promote either. Keep the broker,
  control/dashboard surfaces, and other provider running for these degraded
  cases. Only unsafe ownership, path, symlink, lease, state, or generation
  evidence for Embassy-owned or executed artifacts and Embassy callback,
  control, or state paths refuses broker startup. The Claude-owned external
  sessions registry root is a read-side identity source: an unsafe UID or mode
  quarantines and write-fences only Claude, with loud evidence, while the
  broker and other provider stay available. Require Claude peer protocol 1 per
  session record; reject any other
  value in isolation and count that rejection loudly. Fail an unvalidated endpoint
  generation closed on its responsible route.
  Different-major guidance must safely name the observed and tested versions
  plus the supported major and say that an Embassy release supporting the
  observed major is required; never prescribe `embassy health` as recovery.
  Ignore unknown top-level Claude registry fields while keeping every required
  and consumed field strict, and expose bounded rejection/empty observations.
- Preserve bounded queues, messages, callbacks, deadlines, deduplication, rate
  limits, and conversation tables. Never retry an ambiguous write.
- The dashboard remains an atomically replaced, metadata-only static HTML file
  with no JavaScript, external assets, storage, telemetry, mutation endpoint,
  or network listener.
- The opt-in live companion may render that same bounded public model with
  local JavaScript and the reviewed pair, unpair, stale-registration removal,
  and refresh-discovery actions. It must have no provider or generic control
  method, additional mutation, external asset, storage, service worker,
  telemetry, or non-loopback listener.
- Never read, print, copy, accept, persist, or forward credentials, OAuth
  material, Keychain data, transcripts, provider histories, tool data, or raw
  diagnostics. Never write protocol diagnostics to stdout.

## Repository hygiene

Do not commit `node_modules`, `dist`, package archives, local state, logs,
environment files, Claude configuration, credentials, or live-validation
artifacts. Keep public documentation free of personal absolute paths.
