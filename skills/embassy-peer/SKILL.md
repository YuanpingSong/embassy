---
name: embassy-peer
description: Operate Embassy through current name@host or Claude session-UUID selectors. Use when a Codex task needs to register for monitoring, list available peers, open the local dashboard, select and message a Claude session, or unregister without exposing provider credentials, socket paths, or message bodies.
---

# Embassy Peer Gateway

Use only the installed `embassy` CLI. Treat it as the sole facade over the private, local Embassy control socket. Keep this skill repo-scoped; do not install, copy, or modify provider configuration.

Provider-authorized mutations require exactly one inherited principal. Stop on missing or dual Codex/Claude identity; never choose one on the caller's behalf. Operator-only `serve`, health, status, refresh, select, and unselect commands do not infer a provider principal.

## Select a peer

Address a Claude session by its latest `name@host` or by a user-supplied native session UUID. The UUID is the stable identity; the name is only the current live index. The gateway stores no historical names, so an old name stops resolving immediately after a rename. The shipped launcher accepts only `this-mac`; remote connectors are deferred. Ask the user to choose a selector when it is ambiguous.

Run `embassy status` to read the current snapshot. Run `embassy refresh-dashboard` when passive live discovery is authorized. Claude Code's native `ListAgents` includes genuine Claude sessions plus the one explicitly advertised `codex-*` Embassy peer.

Read the status snapshot's `availablePeers` as sanitized current-name candidates. A send never selects a Claude session automatically. Run `select-claude` for the exact user-chosen current name or UUID before sending; an unselected destination is not routable.

Accept a Claude session UUID only when the user supplies it or it is already part of the current task context. Never discover one by scanning history or configuration, and never infer a peer from a thread ID, process ID, working directory, socket path, or title.

## Check the gateway

Run this before a state-changing operation:

```sh
embassy health
```

If Embassy is unavailable, stop and report that it must be started in a trusted local terminal with `embassy serve`. Do not launch a background copy, retry in a loop, discover sockets, or fall back to a provider CLI.

List the public snapshot:

```sh
embassy status
```

Regenerate the metadata-only dashboard:

```sh
embassy refresh-dashboard
```

Run that refresh only at the passive-discovery authorization stage. Treat the response as a normalized refresh result; it does not reveal the path. The operator-facing page is `gateway-dashboard.html` in the configured state directory, by default `~/.local/state/agent-embassy/`. Use the operator's configured location when it differs. Do not search for the file or scan controller-owned paths.

## Select a Claude session

Select only a user-chosen, unique candidate from `availablePeers`:

```sh
embassy select-claude --alias advisor@this-mac
```

Or select the same logical session directly by UUID:

```sh
embassy select-claude --session 123e4567-e89b-42d3-a456-426614174000
```

Let the gateway resolve either selector against the current genuine Claude discovery snapshot. It refreshes process and socket coordinates by UUID; those transport details are never caller inputs. If discovery is ambiguous, incompatible, or unavailable, stop on the result.

Remove the selected route without touching the Claude session:

```sh
embassy unselect-claude --alias advisor@this-mac
```

Selection and removal manage only the gateway route. They do not start, interrupt, configure, or terminate Claude Code.

## Register a Codex task

Register only from the Codex task being named:

```sh
embassy register-codex --alias codex-reviewer@this-mac
```

Let the CLI read that task's inherited `CODEX_THREAD_ID`. Never supply the thread ID as an argument, print it, persist it, or register another task by guessing its identity. The alias must start with `codex-`; a successful registration advertises that task for native inbound turns.

Unregister from the same Codex task:

```sh
embassy unregister-codex --alias codex-reviewer@this-mac
```

If the task identity or selector does not match, stop on the fail-closed result.

## Send a message

Pass a non-empty UTF-8 body through standard input. Never place message text in a gateway argument or a temporary file.

From a registered Codex task to a discovered Claude session:

```sh
embassy send-to-claude \
  --from codex-reviewer@this-mac \
  --to advisor@this-mac <<'GATEWAY_MESSAGE'
Please review the current approach and note the main risk in your own session.
GATEWAY_MESSAGE
```

The `--to` value may instead be the session UUID. The current name and UUID
address the same logical route; a former name is not retained as an alias.

Let the CLI read the current `CODEX_THREAD_ID`; do not inspect or forward it.

The foreground launcher supports native bidirectional messaging for one explicitly registered `codex-*` task. Claude discovers it with native `ListAgents` and sends with native `SendMessage`; Claude Code controls this feature with `crossSessionInbound`. Every exact live same-UID Claude session may reach the registered `codex-*` task after Claude's own native registry and generation checks. This inbound reachability does not select that Claude session for Embassy's outbound Codex-to-Claude route. Embassy starts the Codex turn and returns its final reply to the originating Claude session.

Use exactly one send for one user-authorized message. Do not automatically retry, fan out, poll, or fall back to Claude Code's native `SendMessage`.

## Reply to a conversation

Use the exact public conversation token returned by the gateway; do not construct one:

```sh
embassy reply \
  --conversation conv_REPLACE_WITH_RETURNED_TOKEN \
  --alias codex-reviewer@this-mac <<'GATEWAY_MESSAGE'
Here is the requested adjustment.
GATEWAY_MESSAGE
```

The CLI infers the caller from the inherited environment. In a Codex task it uses `CODEX_THREAD_ID`; in Claude Code it uses `CLAUDE_CODE_MESSAGING_SOCKET` transiently. Never echo it or pass it as an argument. If both identities or neither identity are present, stop on the fail-closed result instead of selecting one.

## Interpret queue state

Treat `accepted` as gateway ownership, not proof that the peer read or answered the message. Use `status` or the dashboard once when the user asks for progress. The v1 busy policy is queue-only: an active or temporarily unavailable selected task may remain queued until its exact route is ready.

Do not steer an active turn, approve permissions, widen tools, or alter inbound-message policy. Report held, refused, incompatible, full, expired, or unavailable states without retrying. Ordinary process/socket rotation for the same Claude UUID is refreshed automatically and is not a reason to ask for reselection. Message bodies exist only in gateway memory; after a gateway restart, queued or in-flight bodies are discarded and routes must be re-observed before a new send.

## Preserve the boundary

- Keep the gateway local, single-user, and non-hosted.
- Keep the shipped launcher local-host-only.
- Never read provider credentials, authentication state, history, settings, registries, raw sockets, or Keychain entries.
- Publish only the gateway process's selected `codex-*` peer record and remove it on shutdown.
- Never print or copy discovered provider-native identifiers, callback addresses, raw message bodies, tool data, or stderr into skill output or an agent-created file. A user-supplied Claude session UUID may be passed unchanged as an explicit selector, but do not echo it in the normalized result. The gateway may retain the UUID in its closed, mode-0600 private route-binding state.
- Never modify Claude or Codex permissions, hooks, plugins, agents, MCP configuration, or settings.
- Return only the CLI's concise public outcome: selectors, normalized state, and public conversation token when present.
