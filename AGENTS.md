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

### Tickets and budgets

Every task arrives from the PM pre-priced on two independent axes. The rating
is part of the spec: it tells you what level of implementation to build, which
is a product decision, not an engineering one.

**Effort (E)** is the size budget:

| Rating | Line budget | What it buys |
|---|---|---|
| E1 | ≤50 changed lines | Happy path only. No new concepts, no recovery machinery. A documented limitation beats an engineered edge. |
| E2 | ≤200 | Happy path + failure modes users have actually hit. A loud error with an exact safe code IS the handling. At most one new concept. |
| E3 | ≤500 | Every stated promise tested. Known failures get honest errors; everything beyond gets an assertion, not machinery. |
| E5 | negotiated in the ticket | Subsystem or redesign scope. |
| E8 | negotiated | Go all out. Rare, and says so explicitly. |

**Blast radius (R)** is the verification depth, and it is a property of the
code region, not the diff size—one wrong line in settlement outweighs five
hundred wrong lines of copy:

| Rating | Meaning | Verification |
|---|---|---|
| R1 | Cosmetic: copy, docs, site. Wrong = someone reads a bad sentence. | Proofread + en/zh parity; gate compiles. |
| R2 | Misleading but harmless: view derivations, CLI hints. Wrong = user misinformed until next release; nothing lost. | Targeted tests + gate. |
| R3 | Recoverable behavior: dispatch scheduling, discovery, fencing, transports, boot, control plane. Wrong = delay or misroute; settlement stays honest; a restart recovers. | Full gate + soak + one adversarial review. |
| R4 | Trust and data: store settlement/persistence/migrations, provenance envelope, instance lease, runtime attestation, release pipeline. Wrong = silent loss or false green. | Multi-round adversarial review + live proof. |

**Region defaults** (apply mechanically; the ticket may override):

- R4: `store.ts` settlement/persistence/migration paths,
  `provenance-envelope.ts`, `instance-lease.ts`, runtime attestation in
  `claude-runtime.ts`, `.github/workflows/release.yml`, package manifest.
- R3: `service.ts` dispatch/scheduling, `claude-peer.ts`,
  `codex-app-server.ts`, `codex-local-transport.ts`, `server.ts` boot,
  `control.ts`, `config.ts`.
- R2: `dashboard-model.ts`, `dashboard.ts`, `live-dashboard-app/*`, CLI
  argument surfaces.
- R1: `*copy*.ts`, `docs/`, README, site, help text.

### Hard rules (no judgment required)

1. Never guard a case that requires corruption, hand-edited state, or an
   astronomical event count to reach. Validation rejects it; an assertion
   documents it.
2. A failure that settles loudly with an exact safe code is handled. Recovery
   machinery costs budget the ticket must grant explicitly.
3. New concepts—a state, an error code, a journal kind, an env var, a config
   knob—exist only if the ticket's budget names them.
4. Verify at the ticket's R depth, no deeper. An audit finding that proposes a
   NEW check must cite the boundary doctrine in SECURITY.md or go to the PM as
   a queue item—never into the slice.
5. When the budget and thoroughness conflict, the budget wins. Escalate; don't
   gold-plate.
6. **Contest channel:** if a budget is wrong—the E is unachievable for the
   promises, or the R understates a real consequence—say so with reasons
   BEFORE building. The channel is expected to be used. What is never
   acceptable is silently exceeding the budget.
7. SLICE READY reports: exact file list, src-vs-test diffstat, actual lines vs
   budget, and any concept added under the budget's allowance.

### Send-failure policy

A send or reply whose command result is an error, truncation, or ambiguity is
not a delivery—it is a failed attempt to create one. Verify with read-only
`status`/`delivery-status`; if no acceptance is confirmed, resend without
asking, up to three attempts. Escalate to the PM only when a recipient
explicitly denied the message or three resends have failed. A duplicated
coordination message is a nuisance; a lost one deadlocks the pipeline, so
deliverability beats ceremony. Never auto-retry a delivery the recipient's
user denied: that is consent, not transport.

For long messages, write the body to a file and pipe it
(`embassy reply ... < body.md`); never inline `printf` for prose.

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
