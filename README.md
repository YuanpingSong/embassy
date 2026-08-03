# Local Claude Code MCP Bridge

A personal, local-only MCP server that lets a Codex coordinator control
Claude Code through a small neutral lifecycle:

```text
start → status / wait → follow-up → interrupt or cancel → result
```

Codex tasks remain native to the Codex app. This project does not wrap,
replace, imitate, or create Codex agents, and it cannot create native Codex
sidebar task cards. It provides operational parity for Claude through MCP.

This is an unofficial community project and is not affiliated with or
endorsed by Anthropic or OpenAI.

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

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [MCP TypeScript server guide](https://ts.sdk.modelcontextprotocol.io/server)
