# Local Claude Code MCP Bridge

A personal, local-only MCP server that lets a Codex coordinator control
Claude Code through a small neutral lifecycle:

```text
start → status / wait → follow-up → interrupt or cancel → result
```

Codex tasks remain native to the Codex app. This project does not wrap,
replace, imitate, or create Codex agents, and it cannot create native Codex
sidebar task cards. It provides a bounded asynchronous Claude task lifecycle
through MCP. It is not a drop-in implementation of Codex Multi-Agent v2 and
does not provide full feature parity.

This is an unofficial community project and is not affiliated with or
endorsed by Anthropic or OpenAI.

The experimental bidirectional Claude–Codex gateway is additive and is not
part of the released `0.1.0` MCP surface. Its architecture, multi-host Codex
topology, dashboard, privacy boundary, and staged live gates are documented in
[`docs/GATEWAY-ARCHITECTURE.md`](docs/GATEWAY-ARCHITECTURE.md).

## Experimental gateway status

The current worktree includes a live-tested local implementation of:

- a bounded metadata store with private route ownership, endpoint fencing,
  dedupe/rate limits, and memory-only message bodies;
- a closed JSONL control protocol on a private same-user Unix socket;
- a self-contained, metadata-only static HTML dashboard;
- a Claude peer adapter pinned to Claude Code 2.1.225 / peer protocol 1,
  while accepting still-running 2.1.224 same-protocol session records during a
  normal patch upgrade;
- a Codex App Server connector pinned to reviewed App Server 0.147.0 schemas,
  with queue-only busy behavior and no `turn/steer`;
- runtime attestation for the exact installed Claude Code 2.1.225 binary and a
  safe attach-only local Codex proxy factory;
- local Claude and Codex provider adapters, with remote production adapters
  disabled;
- an integrated gateway service with cross-provider
  selection/dispatch/reply correlation and restart-abandonment coverage;
- a foreground, local-host-only `serve` launcher with native bidirectional
  Claude/Codex messaging;
- the packaged `claude-codex-gateway` client for the closed private-UDS
  command family; and
- the repo-scoped [`claude-codex-peer`](skills/claude-codex-peer/SKILL.md)
  skill that defines current-name and Claude-session-UUID routing.

Claude Code cross-session messaging is an official feature. This project's
external registry/UDS adapter is an internal, version-pinned compatibility
boundary. For one explicitly registered `codex-*` task, the gateway publishes
a process-owned native peer record so Claude's native `ListAgents` and
`SendMessage` tools can address it directly. App Server route events update
that record atomically as `idle`, `busy`, or `waiting`.

The foreground broker launcher and local provider assembly are implemented.
It never daemonizes itself or enables a remote connector. A real isolated-task
test completed Claude native discovery and send, a real busy-task hold,
automatic dispatch after the task became idle, a second Codex turn, and
delivery of the exact final reply back to Claude. Claude observed the native
`busy → waiting` transition and the terminal delivery receipt. The current
native advertisement is single-task per gateway process.

Claude-originated messages receive native status control frames. Acceptance
into the gateway queue remains an internal dashboard state and deliberately
does not emit Claude's approval-specific native `held` status. App Server
acceptance emits `delivered`. Delivery failures emit native `expired`, followed
by a static machine-readable gateway diagnostic containing only a safe error
code; `denied` is reserved for a future explicit user or policy rejection. A
transient pre-dispatch failure returns the same message to the internal held
queue and retries after a fresh route observation.
Replies may be written to a busy Claude peer because Claude's native socket
owns its own inbox; this avoids a reply-wait deadlock.

The implemented commands are `serve`, `health`, `status`,
`refresh-dashboard`, `register-codex`, `unregister-codex`, `select-claude`,
`unselect-claude`, `send-to-claude`, `send-to-codex`, and `reply`. They require
the foreground broker, except that `serve` starts it in the current terminal;
all other commands communicate only through its private control UDS.
Claude destinations may be the session's latest `name@host` or its native
session UUID. The UUID is the logical identity; names are a live lookup index,
and process/socket changes are refreshed transport details. A rename makes the
old name stop resolving immediately while the UUID continues to work. Message
bodies are non-empty UTF-8 from standard input, at most 16 KiB; they are never
accepted as arguments or files. Output is one bounded normalized JSON line
with no native IDs, paths, addresses, or message bodies. See the
architecture document for the exact command contract and implementation/live
status.

Each provider-authorized mutation requires exactly one inherited principal:
Codex identity or Claude's raw messaging-socket identity, never both. Missing
or ambiguous identity fails closed. Serve, health, status, dashboard refresh,
Claude selection, and unselection are operator commands and do not infer a
provider principal.

After building, start the foreground local runtime in a trusted local
terminal:

```bash
npm run build
npm run gateway -- serve
```

It emits one normalized ready line, publishes `gateway-dashboard.html` in the
configured private state directory, and then waits for `SIGINT` or `SIGTERM`.
Startup attests exact local runtime paths and binds controller-owned sockets;
it does not discover a Claude peer, write a provider socket, start a model
turn, or contact a remote host. Use another terminal for `health`, `status`,
or a separately authorized discovery/send stage. The launcher reports
`codexMode: "native_messaging"`.

The version pins are separate. The released MCP lifecycle driver retains its
Claude Code 2.1.220 compatibility boundary described below; the experimental
peer gateway runtime requires exact Claude Code 2.1.225. Already-running
2.1.224 peer records remain discoverable only because they use the same
reviewed peer protocol 1 shape. Gateway work does not silently widen the
lifecycle driver's authentication or permission attestation.

The peer gateway does not authenticate to Anthropic or launch a model request
through the CLI. Already-running genuine Claude sessions retain their own
authentication and permissions. Gateway runtime attestation runs only bounded
`claude --version`; the peer adapter needs the exact live-session registry and
peer-socket roots, not Keychain, Claude project history, or the user's general
Claude configuration. See the architecture document for the exact minimal
paths and staged authorization ladder.

A no-model check also confirmed that this Codex task's tool process inherits a
UUID-shaped `CODEX_THREAD_ID` without printing its value. The skill/CLI can
therefore self-register the calling task; it never needs a private thread ID in
an argument.

On the Claude side, Claude Code supplies `CLAUDE_CODE_MESSAGING_SOCKET` as a
raw absolute socket path. The CLI converts it transiently in memory to the
gateway's internal `uds:` reply capability. Do not set, prefix, echo, or pass
that value manually.

Controller state may sit inside a selected provider workspace; route state
remains private and provider-native paths and message bodies are not exposed.
The gateway still rejects the filesystem root and temporary roots as
deliberately broad workspaces. The user's home is selectable with the default
state location beneath it. A narrower project directory remains preferable
when broad file context is unnecessary.

The exact App Server 0.147.0 connector hard-codes initialization capability
`experimentalApi: true` solely because that version gates the
privacy-preserving `thread/resume` option `excludeTurns: true` behind it. Every
resume sends only the exact task ID plus `excludeTurns: true` and rejects a
missing, malformed, or nonempty returned `thread.turns`. For gateway routes,
explicit registration is the reachability authorization; reported workspace
and policy metadata are observational and do not add another delivery gate.
The flag is not configurable, does not add an experimental RPC method, and
does not widen the closed method allowlist.

Claude-to-Codex routing retains the resumed task's existing native policy.
The gateway does not supply persistent turn-level policy overrides or answer
approval prompts.

## Local-only boundary

This bridge is deliberately for one person using Claude Code on the same
computer and under the same OS account:

- It launches the installed `claude` executable directly with `shell: false`.
- Claude Code uses its existing interactive subscription login.
- The bridge never reads, prints, copies, accepts, or persists credential
  material.
- The bridge never calls Keychain or another credential store directly.
  Claude Code itself performs its normal local authentication.
- The bridge does not accept authentication in MCP arguments or configuration.
- It must not be remotely hosted, exposed as a network service, shared between
  users, or used to forward one person's subscription to another person.
- The MCP transport is stdio only.

Version 1 targets macOS, where Claude Code can reuse the current OS account's
subscription OAuth identity through Keychain. Run `claude` interactively once
under that account and complete normal subscription sign-in. The bridge never
calls Keychain itself. It checks the non-secret init discriminator and accepts
`oauth`. On macOS only, it also recognizes the exact Claude Code 2.1.220
compatibility value `apiKeySource: "none"` inside the scrubbed invocation.
That value is compatibility evidence, not proof of authentication; only a
completed request and the controlled experiment below demonstrate reuse of
the local subscription identity. No other authentication mode is part of this
bridge's runtime design.

Each task gets a private controller-owned `CLAUDE_CONFIG_DIR`. This keeps
bridge transcripts and CLI metadata separate from the user's normal Claude
history, settings, plugins, and project state. The bridge never opens files in
that profile. Claude Code 2.1.220 derives its macOS Keychain namespace from
`CLAUDE_CONFIG_DIR`, so an otherwise-correct private profile cannot see the
ordinary same-user subscription login. On macOS the bridge therefore sets
`CLAUDE_SECURESTORAGE_CONFIG_DIR` to the explicit empty value: in this pinned
CLI behavior, that selects Claude Code's normal same-user secure-storage
namespace while settings, transcripts, plugins, and project state remain in
the task-private profile. The bridge does not discover a service name or open
the Keychain; the installed Claude Code process performs its normal lookup.
The bridge also does not forward a parent override for either configuration
variable.

On Linux and Windows, Claude Code normally keeps OAuth credentials in
`.credentials.json` under its config directory, so a fresh isolated profile
cannot reuse the default interactive login. Version 1 does not fall back to
the user's normal config tree or copy that file.

If Claude Code cannot initialize, the bridge returns a controlled
`LOCAL_CLAUDE_LOGIN_REQUIRED`, `LOCAL_CLAUDE_SUBSCRIPTION_REQUIRED`, or
`LOCAL_CLAUDE_CODE_FAILED` error without returning raw CLI diagnostics.

Claude Code 2.1.220 rejects `--safe-mode` when combined with the bridge's
required inline permission settings in this non-interactive path. The bridge
therefore uses the compatible explicit controls: no user/project/local setting
sources, an isolated empty profile, one bridge-owned settings object, strict
empty MCP, disabled commands and customization flags, and init attestation.
The child environment is rebuilt from a small allowlist. Credential-bearing,
agent-socket, and unrelated secret variables are not forwarded. `HOME` remains
only for same-account OS integration; `TMPDIR`, `TEMP`, and `TMP` point at a
private per-task directory. On macOS, the one secure-storage override described
above is controller-set and cannot be replaced by the parent environment.

The bridge still passes `--permission-mode dontAsk` and sets
`permissions.defaultMode` to `dontAsk`. Claude Code 2.1.220 on macOS reports
`default` in its init event on the observed local-subscription path. The
bridge accepts that permission value only for the exact pinned platform and
version; every other `default` init is rejected. Authentication and permission
compatibility are checked independently. In `--print` mode there is no
interactive approval channel, so unmatched writes and commands cannot be
approved, while the explicit workspace rules govern pre-approved operations.
For an untrusted repository, treat the CLI permission layer as defense in
depth and require the outer whole-process sandbox described below.

## MCP surface

The stdio server exposes exactly six tools:

| Tool | Purpose |
| --- | --- |
| `claude_task_start` | Start one Claude task and return a bridge task id |
| `claude_task_status` | Read its normalized snapshot |
| `claude_task_followup` | Continue the same Claude Code session |
| `claude_task_wait` | Long-poll normalized events after a cursor |
| `claude_task_interrupt` | Interrupt a turn or permanently cancel the task |
| `claude_task_result` | Retrieve the latest concise structured report |

Start and follow-up are intentionally not idempotent. Do not automatically
retry an ambiguous mutation.

Codex supplies an authoritative `threadId` with every model-initiated MCP
tool call. The bridge binds each stdio process to that first thread ID and
stores its tasks in a matching private state leaf. A task ID is therefore
owned by the Codex thread that started it; a child agent should finish or
interrupt its Claude task and report the result to its parent.

## Feature parity with Codex Multi-Agent v2

**Bottom line: no, the bridge does not have full feature parity.** It is best
understood as a specialized external Claude/Fable leaf worker that a native
Codex agent can consult. Codex Multi-Agent v2 remains the orchestration layer.

This is a comprehensive capability-level comparison of the user-visible
orchestration surface:
launch and configuration, topology and context, communication, lifecycle and
results, concurrency, tools and permissions, persistence, and client
integration. It does not compare model intelligence, price, latency, or
unrelated product features. The baseline is Codex source commit
[`8922a78`](https://github.com/openai/codex/commit/8922a784fe6aa80683fe97c2dcdfdc361478aa7f)
and the Claude Code 2.1.220 contract pinned by this bridge.

The bridge column describes capabilities implemented by the project, not one
operator's effective environment. An opt-in capability is unavailable unless
its corresponding server flag is enabled; write, execution, and web are all
off by default.

The parity labels mean:

- **Yes**: materially equivalent for the capability as stated.
- **Partial**: a useful analogue exists, but its semantics or scope differ.
- **No**: the native V2 capability is absent.
- **Different**: the bridge deliberately solves the problem another way.
- **Bridge-only**: an additional bridge feature, not V2 parity.

| Area | Capability | Codex Multi-Agent v2 | Claude agent bridge | Parity |
| --- | --- | --- | --- | --- |
| Architecture | Execution unit | Creates a first-class Codex thread with its own rollout, history, metadata, events, and status. | Runs an external local Claude Code process/session represented by an MCP task record. | **No** |
| Architecture | Agent topology | Maintains a root-owned hierarchy with parent, child, sibling, and descendant relationships. | Maintains a flat task collection private to one invoking Codex thread. | **No** |
| Architecture | Recursive delegation | Child agents receive collaboration tools and can spawn descendants. | Claude's `Agent` tool, MCP servers, plugins, skills, commands, and custom agents are disabled. | **No** |
| Architecture | Stable identity and addressing | Required task names produce canonical paths such as `/root/research/reviewer`; relative and absolute addressing work across the tree. | An optional title accompanies an opaque `claude_<uuid>` task ID; there are no paths or relationships. | **No** |
| Architecture | Native client presence | Codex app, CLI, and IDE surfaces can show agent status, activity, transcripts, and thread switching. | Appears as ordinary MCP calls and results; there are no native agent cards or thread views. | **No** |
| Architecture | Local Claude Code/Fable subscription worker | Native children use Codex's configured model and provider stack; this row does not claim Codex cannot use other configured providers. | Reaches the locally authenticated Claude/Fable model through the installed Claude CLI. | **Bridge-only** |
| Launch | Asynchronous start | `spawn_agent` starts a child turn in the background and immediately returns its canonical task path. | `claude_task_start` starts a Claude task in the background and returns its task ID. | **Yes**, for launch only |
| Launch | Initial task input | Accepts a text task plus optional inherited conversation context. | Accepts an explicit text prompt only. | **Partial** |
| Context | Context forking | Spawn can inherit all parent history, no history, or the last N turns. | Receives no Codex conversation fork; the caller must put all needed context in the prompt or workspace. | **No** |
| Context | Full-history fork compatibility | A full-history fork cannot also select a named role; current guidance also keeps the inherited model and reasoning effort. | Has no full-history Codex fork mode. | **No** |
| Configuration | Named agent roles | Built-in and custom roles can layer instructions, model, reasoning, sandbox, `mcp_servers`, `skills.config`, and nickname candidates. | No role registry; callers can only describe a persona in the prompt. | **No** |
| Configuration | Per-task model | Spawn can inherit or select a supported Codex model. | Start can use the configured Claude default, such as Fable, or a supplied Claude model string. | **Partial** |
| Configuration | Reasoning effort | First-class per-agent spawn setting. | No corresponding setting. | **No** |
| Configuration | Service tier | First-class per-agent spawn setting. | No corresponding setting. | **No** |
| Configuration | Developer instructions | Children inherit parent instructions and can receive role or V2 overrides. | The task prompt is combined with bridge-owned structured-report instructions. | **Partial** |
| Configuration | Working directory | Inherits the parent's live runtime working directory and environment. | Caller selects a canonical `cwd` under an explicit allowlist; environment forwarding is deliberately minimal. | **Different** |
| Configuration | Parent configuration and tool inheritance | Child starts from the parent's effective session configuration and available native, MCP, and app tools unless a role changes it. | Claude receives a separate fixed profile and an explicitly restricted built-in tool set. | **No** |
| Configuration | Feature and mode gating | V2 can be enabled or disabled and can restrict collaboration tools to non-code modes. | Availability depends on Codex loading and enabling the MCP server; the bridge has no Codex-mode awareness. | **Different** |
| Configuration | Tool namespace | The collaboration namespace is configurable. | The six tool names are fixed; the MCP server name is selected in Codex configuration. | **Partial** |
| Configuration | Wait exposure and bounds | `wait_agent` can be hidden, and its minimum, maximum, and default timeout are configurable within hard bounds. | `claude_task_wait` is always registered and each call is capped at 25 seconds and 50 events. | **Partial** |
| Configuration | Spawn metadata exposure | V2 can hide spawn metadata and can expose or hide model and reasoning override fields. | The start schema consistently exposes its optional title and model fields; normalized result metadata is fixed by the bridge. | **Different** |
| Configuration | Usage-hint customization | Root, child, shared, and multi-agent-mode guidance can be overridden in V2 configuration. | MCP tool descriptions are fixed at build time; callers can add external Codex/project instructions. | **Partial** |
| Orchestration | Delegation policy and team awareness | Bounded instructions describe proactive or explicit-only delegation, topology, tool semantics, and current slot limits. | The Codex caller may choose to invoke the MCP tool, but the bridge has no native scheduler or team world state. | **No** |
| Communication | Queue a message without starting a turn | `send_message` adds context to another agent without waking it. | No corresponding tool. | **No** |
| Communication | Continue a completed worker | `followup_task` wakes an idle agent while preserving its Codex history. | `claude_task_followup` resumes only an eligible terminal Claude session and rechecks ownership, process exit, usage accounting, turn allowance, session ID, workspace, and enabled capabilities. | **Partial** |
| Communication | Follow up while the worker is active | Delivers at tool or message boundaries while the child is running. | Active tasks reject follow-ups with `TASK_BUSY`. | **No** |
| Communication | Child, parent, peer, and cross-branch messaging | Known agents can address one another by canonical or relative path. | Only the owning Codex thread can operate its bridge task; bridge tasks cannot message one another. | **No** |
| Communication | Ask the human | Non-root Codex agents must message the root, which mediates `request_user_input`. | `AskUserQuestion` is disabled; the structured result can report blockers or decisions needed to the caller. | **Partial** |
| Monitoring | Status of a known worker | Native status is available through the agent tree and client events. | `claude_task_status` returns a detailed normalized snapshot for a retained task ID. | **Partial** |
| Monitoring | List workers | `list_agents` reports the live root tree and supports path-prefix filtering. | There is no task-list tool; the caller must retain task IDs. | **No** |
| Monitoring | Wait for activity | `wait_agent` waits on the caller's mailbox for a queued message or direct-child completion, and also wakes when the user steers the caller. | `claude_task_wait` long-polls one task after an event cursor, with bounded events and wait duration. | **Partial** |
| Monitoring | Progress | Native events and client views expose thread activity and status. | Exposes bounded, normalized, task-specific cursor events; raw Claude events are discarded. | **Partial** |
| Monitoring | Event retention | Native rollout and client state retain the agent thread. | Retains the latest 256 normalized events per task, includes 10 in snapshots, and returns at most 50 in one wait response. | **Partial** |
| Results | Automatic completion delivery | A completed, errored, or shut-down child automatically sends a completion envelope containing its last message to the direct parent; interruption alone is non-final. | Completion is not pushed; the caller must explicitly call status, wait, or result, each of which can expose the final report. | **No** |
| Results | Final result representation | Parent receives the child's final message and can inspect the native thread. | Returns a schema-validated, redacted report with outcome, summary, changed files, verification, decisions needed, warnings, and coarse metrics. | **Different** |
| Results | Transcript inspection | Native clients can inspect the child's transcript. | Claude's private transcript exists only for `--resume`; the bridge never opens or exposes it. | **No**, intentionally |
| Results | Token usage and tree-wide rollout budget | Codex records per-thread token usage and shares its configured rollout budget across the native tree. | Reports coarse turns, duration, and process state, not Codex tokens, cost, or quota. | **No** |
| Results | Hard output bounds | Native output remains part of the Codex thread; there is no equivalent bridge protocol cap. | Fails closed above 8 MiB total stdout or 1 MiB for one JSON event; captures at most 64 KiB of stderr for controlled classification. | **Bridge-only** |
| Control | Interrupt an active turn | `interrupt_agent` stops the current turn while keeping the child available for later work. | Interrupt terminates the CLI process; reuse is allowed only after exit and accounting are confirmed. | **Partial** |
| Control | Permanent cancellation | The pinned V2 surface has no permanent close or cancel operation. | `claude_task_interrupt` can permanently cancel a bridge task. | **Bridge-only** |
| Control | Terminal runtime detach delay | Native residency management can unload eligible idle children, but it does not manage Claude processes. | A terminal Claude runtime is detached after the configured cleanup delay. | **Bridge-only** |
| Persistence | Continue the same session | Reuses the native child thread and its accumulated history. | Uses exact Claude `--resume <session-id>` after a terminal turn. | **Partial** |
| Persistence | Recovery after coordinator restart | Rollout-backed agent metadata and descendants can be reconstructed when the root resumes. | Terminal state and Claude session IDs persist; active work becomes interrupted after a bridge restart, and IDs are not rediscoverable through a list tool. | **Partial** |
| Persistence | Lazy residency | Idle native children can be unloaded to free a slot and later reloaded from persisted history. | No corresponding integration with Codex residency. | **No** |
| Capacity | Concurrency scope | One root-tree residency and active-turn budget coordinates the whole native team. | The active-process limit is per invoking Codex thread and is not coordinated across bridge processes or native agents. | **Partial** |
| Capacity | Slot accounting | A direct V2 concurrency value counts the root as one slot; the legacy `[agents]` spawned-thread value is converted to that total. | Counts only active Claude CLI task processes inside one Codex thread; the invoking Codex agent is outside the bridge limit. | **Different** |
| Capacity | Global concurrency ceiling | Native descendants share one tree-wide limit. | There is no global ceiling across Codex threads or bridge processes. | **No** |
| Capacity | Nested depth | V2 supports nested agents; total concurrency is the practical bound, and legacy `max_depth` is ignored. | Tasks cannot recursively delegate. | **No** |
| Capacity | Per-task turn ceiling | No equivalent V2 spawn option. | Each task has a requested maximum and a server-enforced cumulative maximum. | **Bridge-only** |
| Workspace | Shared files | Native agents share the parent's workspace and immediately see filesystem changes. | A task can target the same repository when it lies under an allowed root. | **Partial** |
| Workspace | Mutation coordination | Native V2 does not generally create worktrees or automatically prevent write conflicts. | Adds per-Codex-thread workspace leases and process-exit fences, but no cross-process global lease. | **Bridge-only**, limited |
| Ownership | Cross-thread access | Agents in the native tree can address known paths across branches. | A task ID is usable only by the Codex thread that created it. | **No**, intentional isolation |
| Tools | File exploration | Child inherits the parent's available tools and permission boundary. | `read_only` exposes only `Read`, `Glob`, and `Grep` under allowed roots. | **Partial** |
| Tools | File editing | Available according to inherited sandbox and approval policy. | Opt-in `workspace_write`; globally disabled unless `CLAUDE_BRIDGE_ENABLE_WRITE=1`. | **Partial**, off by default |
| Tools | Shell execution | Available according to inherited sandbox and approval policy. | Opt-in `workspace_exec` with a mandatory Claude sandbox; globally disabled unless `CLAUDE_BRIDGE_ENABLE_EXEC=1`. | **Partial**, off by default |
| Tools | Web access | Uses the parent's available web tools and policy. | All-or-none opt-in web tools; globally disabled unless `CLAUDE_BRIDGE_ENABLE_WEB=1`. | **Partial**, off by default |
| Extensions | MCP servers and skills | Children inherit effective tools; role configuration can override `mcp_servers` and `skills.config`. | MCP servers and skills are forced empty or disabled. | **No** |
| Isolation | Provider customizations | Native agents continue to use their effective Codex project and tool configuration. | Ordinary Claude plugins, hooks, commands, custom agents, browser integration, and auto-memory are suppressed; admin-managed Claude policy remains an external caveat. | **Different** |
| Security | Sandbox and approval inheritance | Reapplies the parent's live sandbox, permission profile, and approval reviewer after role configuration. | Uses independent fail-closed `dontAsk` profiles, explicit roots, and predeclared tool modes. | **Different** |
| Security | Interactive approvals | Pending approvals remain associated with the originating child and can surface in native clients. | There is no interactive approval channel; an unapproved action fails. | **No** |
| Security | Isolated provider state and data minimization | Native agent history is retained as part of Codex's rollout and UI. | Uses a task-private Claude profile and persists only normalized state; raw prose, tool I/O, stderr, and account details are discarded. | **Bridge-only** |
| Integration | Hooks | Native `SubagentStart` and `SubagentStop` events can integrate with Codex hooks. | No Codex-native subagent hook events. | **No** |
| Integration | Protocol and telemetry | Dedicated Codex/app-server items represent paths, activity, sender/receiver, model, effort, and status. | Emits standard MCP responses and bridge-specific normalized events. | **No** |
| Operations | Platform support | Native local subagent UI is documented for the Codex app, CLI, and IDE; availability follows the client and release. | Version 1 same-user subscription reuse is practically macOS-only and pinned to Claude Code 2.1.220 behavior. | **No** |
| Operations | Authentication boundary | Uses Codex authentication and model backends. | Reuses the installed Claude CLI's same-user local subscription identity without reading credentials. | **Different** |
| Reliability | Ambiguous mutation retries | V2 provides no documented idempotency guarantee for spawn or follow-up. | Start and follow-up are explicitly marked non-idempotent and must not be automatically retried after an ambiguous outcome. | **Different** |

The pinned V2 default exposes six tools because `wait_agent` is enabled; it
can expose five when that tool is disabled. The bridge always exposes six.
Their equal default count is coincidental, and they are not a one-for-one API:

| Multi-Agent v2 tool | Nearest bridge operation | Important gap |
| --- | --- | --- |
| `spawn_agent` | `claude_task_start` | Starts an external task, not a native child thread; no context fork or canonical path. |
| `send_message` | None | The bridge has no passive inbox or agent-to-agent messaging. |
| `followup_task` | `claude_task_followup` | Bridge follow-up works only for an eligible terminal task. |
| `wait_agent` | `claude_task_wait` | Bridge wait targets one task and cannot wake for any agent or user steering. |
| `interrupt_agent` | `claude_task_interrupt` | Similar lifecycle intent, but implemented by terminating a local process; the bridge also adds permanent cancel. |
| `list_agents` | None | `claude_task_status` and `claude_task_result` require a retained task ID and do not list a tree. |

The practical architecture is therefore:

```text
Codex root
  └─ native Multi-Agent v2 child
       └─ optional Claude/Fable bridge task (leaf worker)
```

That composition is useful: native agents provide scheduling, hierarchy,
parallel synthesis, context management, UI, and Codex permissions, while the
bridge adds a deliberately isolated second-model opinion and a structured
handoff. Describing the bridge itself as “Multi-Agent v2 parity” would overstate
what it implements.

## Runtime design

Each coordinator instruction launches one non-interactive local CLI process:

- `claude --print`
- stream-JSON input and output
- the user prompt on stdin, never in the process argument list
- a controller-generated UUID through `--session-id` for the first turn
- exact `--resume <uuid>` for later turns; never directory-wide `--continue`
- no user/project/local setting sources, one explicit bridge settings object,
  a strict empty MCP config, an explicit tool allowlist, disabled slash
  commands, and disabled browser integration
- `dontAsk` permission mode with bridge-owned allow and deny rules
- a JSON schema for the final structured report

The bridge parses bounded JSON lines and persists only normalized progress,
tool names, status, usage counters, and the final report. Raw assistant prose,
tool inputs, tool outputs, stderr, account details, and credential material
are discarded. It validates init metadata before accepting a session:
the local-login discriminator, exact canonical cwd, a noninteractive
permission mode, the expected built-in tool set, and empty
MCP/plugin/skill/command lists. Claude Code may report its built-in agent
names, but the `Agent` tool is not exposed.

Claude Code persists its own transcript inside the task's isolated profile so
`--resume` works. The bridge stores only the opaque session UUID in normalized
task state and never opens the transcript.

Only one CLI process can write a task's session at a time. The controller
closes and confirms the prior process before resuming. It verifies that init
and result events use the expected session UUID.

## Permission policy

The first version is fail-closed:

- `cwd` must be an existing absolute directory under an explicitly configured
  `CLAUDE_BRIDGE_ALLOWED_ROOTS`.
- Filesystem root, home, shared temporary root, and roots broad enough to
  contain the user's home are rejected.
- `read_only` is the default and exposes `Read`, `Glob`, and `Grep`. A
  canonical `Read(//workspace/**)` rule scopes all built-in file reads,
  including Grep and Glob on supported Claude Code versions.
- `workspace_write` adds `Edit` and `Write` under a canonical
  `Edit(//workspace/**)` rule only when the operator sets
  `CLAUDE_BRIDGE_ENABLE_WRITE=1`.
- Common credential paths and workspace secret-file patterns are denied for
  reads and, when edit tools are enabled, edits.
- The explicit tool set excludes `AskUserQuestion`, subagents, and arbitrary
  MCP tools. Because their absence is attested at init, the bridge does not
  load redundant deny rules for those unavailable tools. The empty
  profile/setting sources plus disabling flags suppress
  ordinary Claude instruction files, skills, plugins, hooks, commands, custom
  agents, MCP servers, Chrome, auto-memory, and background customizations.
- Admin-managed policy remains higher precedence. Current Claude Code can
  still run policy-configured managed hooks, status-line commands, and
  file-suggestion commands despite the bridge's isolation controls; the
  bridge cannot disable or attest their absence.
- WebSearch and WebFetch are absent unless the task requests
  `networkAccess: "web"` and the operator sets
  `CLAUDE_BRIDGE_ENABLE_WEB=1`.
- `workspace_exec` is absent unless the operator sets
  `CLAUDE_BRIDGE_ENABLE_EXEC=1`.

When execution is enabled, the invocation supplies mandatory Claude Code
sandbox settings:

- `sandbox.enabled=true`
- `failIfUnavailable=true`
- `allowUnsandboxedCommands=false`
- the workspace and task temp directory are the only additional read/write
  grants inside denied home/controller regions
- all Bash network destinations are denied
- Unix sockets, local port binding, and extra Mach services are denied

The built-in sandbox applies to Bash and its descendants. Claude Code
permissions govern file and web tools. For untrusted repositories, or on a
machine with managed Claude policy, run the whole bridge in a container, VM,
dedicated OS account, or host sandbox. Grant only the chosen workspace,
bridge state, Claude executable and required libraries, outbound Claude
service access, and—only after the experiment below demonstrates it—the
narrow OS credential-store lookup capability.

## Cancellation

`interrupt` sends `SIGTERM` to the whole CLI process group on POSIX systems.
If it does not stop within the configured grace period, controller close
escalates to `SIGKILL`. `cancel` is permanent.

The bridge never resumes while a previous process might still own the
transcript. If an interrupted process does not emit final turn accounting,
`usageAccountingComplete` becomes false and that task is not resumable.
`processExitConfirmed` becomes true only after Node receives the child
process's `close` event. An unconfirmed mutating runtime keeps overlapping
workspace scopes fenced across controller restarts.
Interrupting never rolls back edits, commands, or external effects that
already occurred.

## Controller-owned state

No task file is written into the target project. The default state root is:

```text
$XDG_STATE_HOME/claude-agent-bridge
```

or, when `XDG_STATE_HOME` is unset:

```text
~/.local/state/claude-agent-bridge
```

Set `CLAUDE_BRIDGE_STATE_DIR` to choose a dedicated private location outside
every allowed workspace. The layout is:

```text
state/
  .claude-agent-bridge-state   # validated base ownership marker
  threads/
    .claude-agent-bridge-state # validated container ownership marker
    <codex-thread-id>/
      .claude-agent-bridge-state # thread ownership marker
      .controller.lock           # one live controller for this thread
      tasks/<task-id>/task.json  # normalized state and last 256 events
      tmp/<task-id>/             # private CLI temporary directory
      profiles/<task-id>/        # isolated Claude transcript/config profile
```

Directories are mode `0700`; controller records are mode `0600`. Prompts are
not duplicated into `task.json`. The controller refuses arbitrary existing,
public, symlinked, overlapping, or concurrently locked state roots.

Upgrading from version 0.1.0 does not move or delete legacy tasks stored
directly under `state/tasks`. Confirm those tasks are terminal before
restarting. They remain preserved for manual archival, but new bridge calls
are intentionally routed only to thread-owned state and cannot resume a
legacy task because its originating Codex thread was not recorded.

On restart, active work is marked `interrupted` and is not replayed because
prior side effects and final turn accounting are unknown. If the old process
never confirmed exit, the controller rejects overlapping work whenever either
task can write. After independently verifying that no old Claude process
survives, the operator can archive the affected private state directory before
starting a fresh task; the bridge never guesses by killing an unverified PID.

## Install and configure

Requirements:

- macOS for same-user subscription reuse with task-private profiles in this
  version
- Node.js 20 or newer
- a current local Claude Code CLI that supports stream JSON, explicit setting
  sources, structured output, explicit session IDs, and resume
- an existing interactive Claude subscription login under the same OS account

Build and test:

```bash
npm ci
npm run check
```

Configure at least one narrow workspace root:

```bash
export CLAUDE_BRIDGE_ALLOWED_ROOTS="/absolute/path/to/project"
export CLAUDE_BRIDGE_STATE_DIR="/absolute/path/to/private-controller-state"
```

The bridge resolves `claude` only from absolute entries in `PATH`. For the
strongest executable boundary, pin the installed executable explicitly:

```bash
export CLAUDE_BRIDGE_CLAUDE_BIN="/absolute/path/to/claude"
```

For multiple workspace roots, use the platform path delimiter (`:` on
macOS/Linux, `;` on Windows):

```bash
export CLAUDE_BRIDGE_ALLOWED_ROOTS="/work/project-a:/work/project-b"
```

Representative Codex MCP configuration (multiline inline tables are not valid
TOML, so the environment uses its own subtable):

```toml
[mcp_servers.claude_agent_bridge]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/claude-agent-bridge/dist/src/index.js"]
enabled_tools = ["claude_task_start", "claude_task_status", "claude_task_followup", "claude_task_wait", "claude_task_interrupt", "claude_task_result"]
startup_timeout_sec = 20
tool_timeout_sec = 600

[mcp_servers.claude_agent_bridge.env]
CLAUDE_BRIDGE_CLAUDE_BIN = "/absolute/path/to/claude"
CLAUDE_BRIDGE_ALLOWED_ROOTS = "/absolute/path/to/project"
CLAUDE_BRIDGE_STATE_DIR = "/absolute/path/to/private-controller-state"
CLAUDE_BRIDGE_DEFAULT_MODEL = "fable"
```

Do not place credential values in this configuration.

## Runtime configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BRIDGE_CLAUDE_BIN` | resolved `claude` on absolute `PATH` entries | Local CLI executable |
| `CLAUDE_BRIDGE_ALLOWED_ROOTS` | required | Path-delimited workspace allowlist |
| `CLAUDE_BRIDGE_STATE_DIR` | XDG/local state path | Private controller state |
| `CLAUDE_BRIDGE_DEFAULT_MODEL` | unset | Model used when `claude_task_start.model` is omitted |
| `CLAUDE_BRIDGE_MAX_CONCURRENT_TASKS` | `2` | Active local CLI process limit per Codex thread |
| `CLAUDE_BRIDGE_IDLE_RUNTIME_MS` | `60000` | Terminal runtime cleanup ceiling |
| `CLAUDE_BRIDGE_INTERRUPT_GRACE_MS` | `2000` | Grace before forced termination |
| `CLAUDE_BRIDGE_DEFAULT_MAX_TURNS` | `40` | Default cumulative CLI turns per task |
| `CLAUDE_BRIDGE_MAX_TURNS` | `100` | Server-enforced cumulative ceiling |
| `CLAUDE_BRIDGE_ENABLE_WRITE` | unset | Allow tasks to request `workspace_write` |
| `CLAUDE_BRIDGE_ENABLE_EXEC` | unset | Enable mandatory-sandbox `workspace_exec` |
| `CLAUDE_BRIDGE_ENABLE_WEB` | unset | Allow tasks to request web tools |

## Coordinator flow

1. Call `claude_task_start`.
2. Retain `task.taskId` and `task.eventSequence`.
3. Call `claude_task_wait` with that sequence as `afterSequence`.
4. Repeat using `nextSequence`, or inspect with `claude_task_status`.
5. After a terminal turn, call `claude_task_followup` to resume its exact
   Claude Code session.
6. Use `claude_task_interrupt` with `interrupt` or `cancel`.
7. Retrieve the concise handoff through `claude_task_result`.

Cancelling an MCP wait stops only the wait; it never cancels the Claude task.
Active tasks reject follow-ups with `TASK_BUSY`.

## Local verification

The deterministic suite makes no Claude request:

```bash
npm run check
npm run demo
```

It covers CLI argument and environment isolation, prompt-on-stdin behavior,
bounded JSONL parsing, structured report redaction, start/follow-up session
continuity, waits, races, interruption/cancellation, turn ceilings, restart
recovery, state ownership, all six MCP tools, and clean stdio startup.

For one real smoke test, use a temporary empty workspace and private state
directory, request `read_only`, `networkAccess: "none"`, `maxTurns: 2`, and a
prompt that explicitly says not to use workspace tools and asks only for a
fixed structured summary. Claude Code uses the second agentic turn to submit
the schema-backed report:

```bash
CLAUDE_BRIDGE_CLAUDE_BIN=/absolute/path/to/claude \
  CLAUDE_BRIDGE_RUN_REAL_VALIDATION=1 \
  CLAUDE_BRIDGE_VALIDATION_MODEL=fable \
  npm run validate:local
```

The opt-in command makes exactly one request through the built MCP bridge,
prints only coarse booleans/status including confirmed CLI process exit,
suppressing raw CLI stderr,
and removes its temporary workspace, isolated Claude profile, and controller
state. This built-bridge validator is the supported proof because it exercises
environment scrubbing, explicit isolation controls, init-policy attestation,
and structured results. A direct `claude -p` command does not prove those
boundaries.

The validator must not inspect auth files, Keychain contents, account identity,
or normal Claude history. Its cleanup removes only the validator's temporary
workspace, task-private profile, and controller state.

## Controlled authentication-isolation experiment

Do not grant the bridge the user's existing Claude config/history directory
just because login works interactively. The following controlled, read-only
experiment was run with the official CLI's text auth-status command, all CLI
stdout/stderr suppressed, and only a coarse authenticated boolean retained:

1. The ordinary user context reported authenticated.
2. A fresh `CLAUDE_CONFIG_DIR` reported unauthenticated.
3. The same fresh profile plus explicit empty
   `CLAUDE_SECURESTORAGE_CONFIG_DIR` reported authenticated.

No model request was made, and no account data, credential value, Keychain
content, config file, or history was read or printed by the experiment. This
distinguishes the ordinary same-user secure-storage namespace from the
configuration/profile files and explains the original bridge failure.

The narrowest demonstrated host capability is lookup of Claude Code's existing
same-user macOS Keychain item by the installed Claude Code process. Keep the
normal Claude settings, sessions, history, and plugins denied. Do not grant the
entire `~/.claude` tree preemptively: current CLI secure-storage coordination
may request a lock beneath its default config root, but an outer sandbox should
add only the exact path shown by its own denial, if any. The bridge never
discovers the Keychain service name, manipulates Keychain, or asks the user to
copy credentials.

For a reproducible sandbox check, use a fresh task profile and empty workspace,
grant only the installed CLI and required libraries, bridge-owned workspace
and state, outbound HTTPS to Claude, and the same-user Keychain lookup
capability. Run the opt-in built-bridge validator once and retain only its
coarse result. Stop on an unexpected file request, sandbox expansion, raw
diagnostic output, or any attempt to show account or credential data.

## Known limits

- Claude tasks do not appear as native Codex sidebar cards.
- The event log retains the latest 256 normalized events per task.
- There is no task-list tool; the coordinator retains returned task ids.
- Task ownership, task concurrency, and workspace leases are scoped to one
  Codex thread. Keep write and execution disabled when multiple Codex threads
  can target overlapping workspaces unless an external cross-process lease is
  in place.
- Version 1 reuses an existing same-user subscription identity on macOS while
  keeping task settings and sessions isolated. Linux/Windows config-file OAuth
  is intentionally not copied or reused.
- The explicit-empty secure-storage override and the `none`/`default` init
  compatibility values are pinned to the observed Claude Code 2.1.220 macOS
  behavior. Those ambiguous values fail closed on other versions; review and
  retest the boundary after a CLI upgrade.
- CLI-owned settings cannot disable admin-managed policy hooks, status-line
  commands, or file-suggestion commands. Use an outer sandbox or dedicated
  account when those policies are not fully trusted.
- The built-in sandbox governs Bash, not the entire CLI process.
- For `workspace_write` or `workspace_exec`, the outer supervisor must kill
  descendants if the bridge itself is force-killed. The persistent
  `processExitConfirmed` fence prevents automatic overlap after a detected
  unclean runtime, but it cannot terminate an unobserved orphan by PID safely.
- Windows process-tree termination is best-effort; use an outer job or
  container boundary for strict descendant cancellation.
- Web tools are all-or-none. Use an outer egress policy for stronger
  destination control.
- Report redaction is defense in depth, not a general data-loss-prevention
  system. Keep secrets out of the presented workspace.

## References

- [Anthropic cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI remote connections and SSH hosts](https://learn.chatgpt.com/docs/remote-connections)
- [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Pinned Multi-Agent v2 tool schemas](https://github.com/openai/codex/blob/8922a784fe6aa80683fe97c2dcdfdc361478aa7f/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [Pinned Multi-Agent v2 spawn and context implementation](https://github.com/openai/codex/blob/8922a784fe6aa80683fe97c2dcdfdc361478aa7f/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- [Pinned Codex agent configuration](https://github.com/openai/codex/blob/8922a784fe6aa80683fe97c2dcdfdc361478aa7f/codex-rs/core/src/config/mod.rs)
- [Pinned Multi-Agent v2 feature configuration](https://github.com/openai/codex/blob/8922a784fe6aa80683fe97c2dcdfdc361478aa7f/codex-rs/features/src/feature_configs.rs)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [MCP TypeScript server guide](https://ts.sdk.modelcontextprotocol.io/server)
