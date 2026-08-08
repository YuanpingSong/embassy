# Security Policy

## Supported versions

Security fixes are applied to the `main` branch. No released version is
currently supported independently of `main`.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's
GitHub Security Advisory interface. Do not open a public issue for a suspected
security problem.

Do not include credentials, OAuth material, raw Claude output, local bridge
state, Claude configuration, or unredacted machine paths in a report. Replace
sensitive values with minimal synthetic reproductions.

## Security boundary

This bridge is intended for one person, one local OS account, and stdio MCP
transport. It must not be exposed as a network service or used to share a
subscription between users. Read-only operation is the default. Changes that
widen tools, environment forwarding, authentication behavior, state access,
or workspace permissions require focused tests and explicit security review.

## Gateway expansion boundary

The experimental bidirectional gateway in `docs/GATEWAY-ARCHITECTURE.md` is
additive and is not part of the released six-tool MCP surface. The MCP server
remains stdio-only. Gateway components must preserve these additional
boundaries:

- Codex routes require explicit self-registration by the owning task. Claude
  routes require explicit operator selection of a genuine live peer; do not
  scan provider histories or expose raw native identifiers.
- Claude Code's cross-session feature is official, but the external registry
  and peer-wire adapter is pinned to the reviewed Claude Code 2.1.224 / peer
  protocol 1 boundary. Reject any other version or shape until it is reviewed.
  This is independent of the released MCP lifecycle driver's narrower 2.1.220
  init/authentication compatibility boundary.
- Never publish a fake Claude live-session record or impersonate a Claude
  session kind. Native Claude discovery lists genuine Claude sessions only;
  Codex aliases live in the gateway's private registry and dashboard.
- The gateway control socket uses a controller-owned mode-0700 directory and
  mode-0600 socket. Provider-owned Claude registry directories, files, and
  peer sockets are accepted according to filesystem accessibility rather than
  audited Unix owner/mode policy. Their type, bounded schema, PID/path
  correlation, liveness, and generation are still validated.
- The anonymous Claude callback is created inside that exact peer-socket
  directory. Cleanup may unlink only the gateway-owned path whose
  inode/generation still matches.
- Remote Codex access uses fixed, preapproved OpenSSH aliases and an attach-only
  App Server proxy. The gateway never starts, stops, replaces, signals, or
  unlinks a Desktop-owned remote App Server.
- The shipped foreground launcher is local-host-only and may write only to an
  explicitly registered Codex task. Remote connectors remain disabled.
- App Server methods are allowlisted. Archive, delete, shell, configuration,
  authentication, plugin, approval-response, and history methods are denied.
- For exact App Server 0.147.0 only, initialization hard-codes
  `experimentalApi: true` solely to use `thread/resume` with
  `excludeTurns: true`. It is non-configurable, adds no experimental RPC
  method or write authority, and every resume must reject missing, malformed,
  or nonempty `thread.turns` before attestation.
- Claude-initiated turns retain the selected Codex task's native permissions.
  The gateway does not supply persistent turn-level policy overrides.
- Version 1 queues messages while a Codex task is busy or awaiting approval.
  It does not expose `turn/steer`; interrupt is restricted to an exact turn
  started and observed by the owning connector.
- Endpoint-generation fencing, bounded queues, deadlines, deduplication, rate
  limits, and fail-closed disconnect behavior are required.
- Persisted state is closed and private. Exact provider-native route IDs may
  appear only in the controller-owned binding state needed for ownership and
  restart re-observation; they are forbidden from normalized events, public
  snapshots, the dashboard, CLI arguments/output, aliases, logs, and errors.
  No persisted or dashboard state may contain message bodies, prompts,
  replies, raw events, tool data, stderr, credentials, provider paths, or
  socket addresses.
- Reply addresses and message bodies remain transient and are abandoned, not
  replayed, after a gateway restart.
- Every restored route remains stale and unusable until its exact host,
  endpoint generation, and provider target are positively re-observed.
- `CLAUDE_CODE_MESSAGING_SOCKET` is a raw inherited absolute path. Only the
  CLI may convert it in memory to an internal `uds:` capability; never accept
  it as a user argument or print, persist, or ask the user to prefix it.
- Provider-authorized CLI mutations require exactly one inherited principal.
  Reject missing or dual Codex/Claude identity instead of choosing one.
- The gateway control plane is a private same-user UDS inside its
  controller-owned state directory. It must not listen on TCP or HTTP.
- The version 1 dashboard is a private, atomically refreshed HTML file rather
  than a network service. It contains no scripts, external assets, storage,
  telemetry, or mutation endpoint.

The live gateway needs no credential-store, history, transcript, or broad home
access. Its narrow provider boundary is read/enumerate access to the exact
Claude live-session registry, stat/connect access to validated peer sockets,
write access to its own controller state and callback sockets, and attach-only
access to explicitly allowlisted Codex App Server endpoints. Never grant or
request Keychain access, Claude project history, shell history, or unrelated
user files.

Controller state must be disjoint from every selected provider workspace. The
filesystem root and configured temporary roots are always rejected as
deliberately broad workspaces. The user's home may be selected only when the
controller state root is outside it; the ordinary overlap and generation
checks remain mandatory. Prefer a narrower workspace when whole-home context
is not required.

Routine validation uses only synthetic peers and transports. Starting the
private server, publishing the static dashboard, passive sanitized discovery,
and binding a gateway-owned anonymous callback socket are all no-send stages;
none authorizes a provider write. The first provider write requires a separate
explicit one-send authorization naming the exact public alias, prompt, and
bounds, with no retry or fanout. A bounded Codex multi-client fanout
observation, one Claude-to-Codex turn, and a remote production connector are
later independent gates. A live message is never a routine or CI test.
