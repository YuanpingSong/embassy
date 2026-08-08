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

## Product invariants

- Keep the shipped v1 launcher macOS-only, foreground, same-machine, and
  local-host-only. It must not daemonize or listen on TCP or HTTP.
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
- Publish at most one process-owned `codex-*` registry record. Remove only the
  exact-owned record and callback socket during graceful shutdown; never modify
  another process's artifacts.
- Keep bodies, prompts, replies, raw provider frames, callback addresses, and
  socket paths memory-only. Never replay a body after restart.
- Closed private route state may retain the Codex thread ID and Claude session
  UUID needed for ownership and re-observation. Native IDs are forbidden from
  public snapshots, normalized events, the dashboard, aliases, logs, errors,
  and CLI output.
- Restored routes are stale until their exact current endpoint generation and
  provider target are positively re-observed.
- Treat inherited `CLAUDE_CODE_MESSAGING_SOCKET` as a raw absolute path. It may
  become an in-memory `uds:` capability only; never accept it from an argument,
  print it, persist it, or instruct the user to prefix it.
- Queue while Codex is busy. Do not expose `turn/steer`, a generic provider RPC
  escape hatch, or an approval-response method. Interrupt only an exact turn
  started and positively observed by the same connector.
- Embassy never mutates a Codex task's persistent approval or sandbox policy
  and never answers approvals. Registration—not a read-only-policy classifier—
  is the gateway reachability boundary.
- Keep App Server 0.147.0 `experimentalApi: true` hard-coded solely for
  `thread/resume.excludeTurns: true`. Require an empty `thread.turns` response
  and never retain returned history.
- Keep Claude Code and Codex App Server adapters exactly version-pinned and
  fail closed on unknown schema, protocol, endpoint generation, or version.
- Preserve bounded queues, messages, callbacks, deadlines, deduplication, rate
  limits, hop counts, and conversation tables. Never retry an ambiguous write.
- The dashboard remains an atomically replaced, metadata-only static HTML file
  with no JavaScript, external assets, storage, telemetry, mutation endpoint,
  or network listener.
- Never read, print, copy, accept, persist, or forward credentials, OAuth
  material, Keychain data, transcripts, provider histories, tool data, or raw
  diagnostics. Never write protocol diagnostics to stdout.

## Repository hygiene

Do not commit `node_modules`, `dist`, package archives, local state, logs,
environment files, Claude configuration, credentials, or live-validation
artifacts. Keep public documentation free of personal absolute paths.
