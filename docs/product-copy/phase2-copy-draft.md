# Embassy — Phase 2 Product Copy Brief

---

## Deliverable 1 — English Marketing Site Copy and IA

### Meta

- **Page title:** Embassy — Local broker for Claude Code and Codex on your Mac
- **Meta description:** Embassy routes messages between already-running Claude Code sessions and Codex desktop tasks on the same Mac, same user. No API calls, no telemetry, no orchestration. Open source.

### Navigation

| Position | Label |
|----------|-------|
| Left | Embassy |
| Nav 1 | How it works |
| Nav 2 | Quickstart |
| Nav 3 | Dashboard |
| Nav 4 | Trust model |
| Nav trailing | GitHub ↗ |

### First viewport

**Eyebrow:** Open-source local broker for macOS

**Headline:** Let your agents exchange messages. Nothing else.

**Subhead:** Embassy routes a message from a registered Codex task to a selected Claude Code session — or the other way — over a local Unix-domain socket on your Mac. It does not call a provider API, send telemetry, or run either agent.

---

**Exchange specimen**

*Marketing illustration — not dashboard data.*

```
codex-reviewer@this-mac → advisor@this-mac

  "The migration adds a nullable column but the backfill
   script assumes NOT NULL. Lines 140–147 in 0042.sql."

  ┄ accepted · queued · dispatching · delivered
    receipt mst_7f3a — delivered 820 ms
```

---

**Primary CTA:** Get started — `npm install -g agent-embassy`

**Secondary CTA:** Read the trust model

### Page sections (ordered)

#### 1. What Embassy does

Embassy is a personal, same-machine broker. It sits between Claude Code sessions and Codex desktop tasks that are already running under the same macOS user. It forwards bounded messages over local Unix-domain sockets and the Codex App Server that is already listening.

Embassy does not spawn, orchestrate, wrap, replace, or reimplement either agent. Both agents remain cloud-backed under their own provider terms. "Local" describes the broker and the route, not model inference.

**Key labels:** Registration · Discovery · Selection · Delivery

#### 2. How it works

**Claude → Codex.** A Codex task registers itself with Embassy. That advertises it to compatible, live Claude Code sessions of the same OS user. A compatible session can then initiate native delivery to the registered task, under the task's existing native approval and sandbox policy. Inbound reachability does not select that Claude session for outbound use.

**Codex → Claude.** The Codex task must already be registered. A compatible Claude Code session must be discovered *and then explicitly selected* before sending. Discovery is not selection. Sending never auto-selects.

**Registration, discovery, and selection are distinct states.** A session can be discovered without being selected. A task can be registered without any session having been discovered.

#### 3. Message lifecycle

CLI acceptance returns a conversation token. Acceptance is not delivery.

Progress states: **queued → dispatching → transport written → held → stalled.**
Terminal states: **delivered · expired · rejected · cancelled · abandoned · failed · ambiguous · duplicate.**

Messages queue in memory while Codex is busy. Embassy does not steer another turn. Bodies are bounded to 16 KiB, held in memory only, and are not replayed after restart.

#### 4. Quickstart

Get a working route in six commands.

```bash
# 1. Install
npm install -g agent-embassy

# 2. Start the broker
embassy serve

# 3. Verify
embassy health && embassy status

# 4. Inside the target Codex task — register it
embassy register-codex --alias codex-reviewer@this-mac

# 5. From your operator shell — select a Claude session
embassy select-claude --alias advisor@this-mac

# 6. Send a message (body over stdin) from the registered task
echo "Review migration 0042" | \
  embassy send-to-claude \
    --from codex-reviewer@this-mac \
    --to advisor@this-mac \
    --expects-reply
```

Acceptance is asynchronous. The CLI returns a conversation token on acceptance, but the message may still be queued, dispatching, or held. Check delivery state with `embassy status` or the dashboard.

#### 5. Dashboard

The Embassy dashboard exposes metadata only: aliases, public conversation and message tokens, states, timestamps, byte counts, queue depth and age, and safe error codes.

It never shows message bodies, raw provider frames, native UUID or thread IDs, callback or socket paths, credentials, transcripts, Keychain data, or provider history.

A new user should understand purpose, readiness, queue state, and next action in ten seconds. An expert should see the distinction between discovery, selection, and registration — and between acceptance and delivery — without ambiguity.

#### 6. Trust model

- All traffic stays on the local machine over Unix-domain sockets. Embassy makes no provider API call and sends no telemetry.
- Delivered text becomes an ordinary model turn and reaches Anthropic or OpenAI under that product's normal behavior.
- Same-UID containment bounds the broker to your OS user. This is not authentication against a malicious process already running as you.
- Claude's `crossSessionInbound` remains Claude's native inbound control. Embassy does not change or answer native approval or sandbox policies.
- Exact pinned provider versions fail closed when they are incompatible.
- Message bodies are bounded to 16 KiB, held in memory only, and gone on restart. There is no replay, no persistence, no export.

Embassy is unofficial and not affiliated with Anthropic or OpenAI.

#### 7. Compatibility

Current target: macOS, Node.js 20 or newer, Claude Code 2.1.225, Codex App Server 0.147.0. Pinned versions fail closed.

### Footer / legal

Embassy is open-source software, unofficial and not affiliated with Anthropic or OpenAI. Claude Code is a product of Anthropic. Codex is a product of OpenAI. All trademarks belong to their respective owners. Licensed under [LICENSE]. Source on GitHub.

---

## Deliverable 2 — zh-CN Marketing Site Copy and IA

### 元信息

- **页面标题：** Embassy — macOS 本机 Claude Code 与 Codex 消息中介
- **Meta description：** Embassy（AI 智能体使馆）在同一台 Mac、同一 macOS 用户下，为已运行的 Claude Code 会话和 Codex 桌面任务转发消息。不调用提供商 API，不发送遥测数据，不编排智能体。开源项目。

### 导航

| 位置 | 标签 |
|------|------|
| 左 | Embassy |
| 导航 1 | 工作原理 |
| 导航 2 | 快速开始 |
| 导航 3 | 仪表盘 |
| 导航 4 | 信任模型 |
| 导航尾 | GitHub ↗ |

### 首屏

**眉题：** macOS 开源本机中介

**标题：** 让你的智能体交换消息。仅此而已。

**副标题：** Embassy 通过本机 Unix 域套接字，在已注册的 Codex 任务和已选定的 Claude Code 会话之间转发消息。它不调用提供商 API，不发送遥测数据，也不运行任何一方的智能体。

---

**消息交换示例**

*营销示例——非仪表盘数据。*

```
codex-reviewer@this-mac → advisor@this-mac

  "迁移脚本新增了一个可空列，但回填脚本假设 NOT NULL。
   见 0042.sql 第 140–147 行。"

  ┄ accepted · queued · dispatching · delivered
    receipt mst_7f3a — delivered 820 ms
```

---

**主要行动号召：** 立即开始 — `npm install -g agent-embassy`

**次要行动号召：** 阅读信任模型

### 页面章节

#### 1. Embassy 做什么

Embassy 是一个个人本机中介。它在同一台 Mac、同一 macOS 用户下，连接已在运行的 Claude Code 会话与 Codex 桌面任务。消息经由本机 Unix 域套接字和已有的 Codex App Server 转发。

Embassy 不启动、不编排、不封装、不替代、不重新实现任何智能体。两端的智能体仍然由云端提供商驱动。"本机"描述的是中介和路由，不是模型推理。

**核心概念：** 注册 · 发现 · 选定 · 投递

#### 2. 工作原理

**Claude → Codex。** Codex 任务向 Embassy 注册自身，使其对同一 OS 用户下兼容的、正在运行的 Claude Code 会话可见。兼容会话可向已注册任务发起原生投递，受该任务现有的审批和沙箱策略约束。入站可达性不会将该 Claude 会话选定为出站目标。

**Codex → Claude。** Codex 任务必须已注册。必须先发现兼容的 Claude Code 会话，再将其明确选定，方可发送。发现不等于选定。发送操作不会自动选定。

**注册、发现和选定是三个独立状态。** 会话可被发现但未被选定；任务可已注册但尚无会话被发现。

#### 3. 消息生命周期

CLI 接受操作返回会话令牌。接受不等于投递。

进行中状态：**queued → dispatching → transport written → held → stalled。**
终态：**delivered · expired · rejected · cancelled · abandoned · failed · ambiguous · duplicate。**

Codex 忙碌时消息在内存中排队。Embassy 不干预智能体的下一轮对话。消息体上限 16 KiB，仅存于内存，重启后不重放。

#### 4. 快速开始

六条命令建立一条可用路由。

```bash
# 1. 安装
npm install -g agent-embassy

# 2. 启动中介
embassy serve

# 3. 验证
embassy health && embassy status

# 4. 在目标 Codex 任务中——注册该任务
embassy register-codex --alias codex-reviewer@this-mac

# 5. 在操作员终端——选定一个 Claude 会话
embassy select-claude --alias advisor@this-mac

# 6. 从已注册任务发送消息（消息体通过 stdin 传入）
echo "Review migration 0042" | \
  embassy send-to-claude \
    --from codex-reviewer@this-mac \
    --to advisor@this-mac \
    --expects-reply
```

接受是异步的。CLI 在接受时返回会话令牌，但消息可能仍处于排队、分发或挂起状态。使用 `embassy status` 或仪表盘确认投递结果。

#### 5. 仪表盘

Embassy 仪表盘仅展示元数据：别名、公开的会话与消息令牌、状态、时间戳、字节数、队列深度与等待时长，以及安全错误码。

仪表盘不显示消息正文、原始提供商帧、原生 UUID/线程 ID、回调/套接字路径、凭据、对话记录、Keychain 数据或提供商历史。

#### 6. 信任模型

- 所有流量通过本机 Unix 域套接字传输。Embassy 不调用提供商 API，不发送遥测数据。
- 投递后的文本成为常规模型对话轮次，按各产品的正常行为送达 Anthropic 或 OpenAI。
- 同一 UID 限定将中介约束在你的 OS 用户范围内。这不是对已以你身份运行的恶意进程的身份验证。
- Claude 的 `crossSessionInbound` 仍为 Claude 的原生入站控制。Embassy 不更改或代理原生审批与沙箱策略。
- 精确锁定的提供商版本在不兼容时直接拒绝运行。
- 消息体上限 16 KiB，仅存于内存，重启即清除。无重放，无持久化，无导出。

Embassy 是非官方开源项目，与 Anthropic 和 OpenAI 无关联。

#### 7. 兼容性

当前目标：macOS、Node.js 20 及以上、Claude Code 2.1.225、Codex App Server 0.147.0。锁定版本不兼容时拒绝运行。

### 页脚 / 法律声明

Embassy 为开源软件，非官方项目，与 Anthropic 和 OpenAI 无关联。Claude Code 为 Anthropic 产品，Codex 为 OpenAI 产品。所有商标归其各自所有者。按 [LICENSE] 授权。源码见 GitHub。

---

## Deliverable 3 — English Dashboard String Catalog

### Panel 1: Exchange Board

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.exchange.heading` | Exchange board |
| `panel.exchange.eyebrow` | Route overview |
| `panel.exchange.summary.ready` | Route ready — registered Codex task and selected Claude session |
| `panel.exchange.summary.partial` | Route incomplete — see next action below |
| `panel.exchange.tooltip.direction` | Arrow shows message direction, not session hierarchy |

#### Actions and command labels

| Key | String |
|-----|--------|
| `panel.exchange.action.register` | Register a Codex task |
| `panel.exchange.action.select` | Select a Claude session |
| `panel.exchange.cmd.register` | `embassy register-codex --alias {alias}` |
| `panel.exchange.cmd.select` | `embassy select-claude --alias {alias}` |
| `panel.exchange.cmd.copy.label` | Copy command |

#### Next-action inline

| Key | String |
|-----|--------|
| `panel.exchange.next.no_broker` | Start the broker: `embassy serve` |
| `panel.exchange.next.no_registration` | Register a Codex task to begin |
| `panel.exchange.next.no_discovery` | No compatible Claude sessions found — is Claude Code running? |
| `panel.exchange.next.discovered_not_selected` | {count} Claude session(s) discovered but none selected — select one to enable sending |
| `panel.exchange.next.ready` | Route ready. Send a message or check status. |

#### Empty states

| Key | String |
|-----|--------|
| `empty.no_broker` | Broker not running. Start it with `embassy serve`. |
| `empty.no_codex` | No Codex task registered. Register one from inside a Codex task with `embassy register-codex`. |
| `empty.no_claude_discovered` | No compatible Claude Code sessions discovered. Ensure Claude Code is running under the same macOS user. |
| `empty.discovered_not_selected` | {count} Claude Code session(s) discovered but not selected. Discovery is not selection — explicitly select a session with `embassy select-claude`. |

#### Broker readiness

| Key | String |
|-----|--------|
| `broker.status.healthy` | Broker healthy |
| `broker.status.degraded` | Broker degraded — check `embassy health` |
| `broker.status.offline` | Broker offline |
| `broker.version.compatible` | Providers compatible |
| `broker.version.incompatible` | Provider version incompatible — broker will not route. Expected Claude Code {expected_cc}, Codex App Server {expected_cas}. |

### Panel 2: Needs Attention

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.attention.heading` | Needs attention |
| `panel.attention.eyebrow` | Actionable alerts |
| `panel.attention.summary` | {count} item(s) need attention |
| `panel.attention.empty` | Nothing needs attention. |
| `panel.attention.tooltip` | Issues ordered by urgency. This panel hides when empty. |

#### Alert states

| Key | String |
|-----|--------|
| `alert.stalled` | Message {token} stalled — transport written but no delivery receipt after {duration} |
| `alert.held` | Message {token} held — Codex task is busy, message queued |
| `alert.expired` | Message {token} expired — delivery window closed |
| `alert.ambiguous` | Message {token} ambiguous — terminal state could not be determined |
| `alert.failed` | Message {token} failed — {safe_code} |
| `alert.incompatible` | Provider version incompatible — routing disabled |
| `alert.claude_offline` | Selected Claude session is no longer reachable |
| `alert.codex_offline` | Registered Codex task is no longer reachable |

### Panel 3: In Transit

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.transit.heading` | In transit |
| `panel.transit.eyebrow` | Queue status |
| `panel.transit.summary` | {count} message(s) in queue — oldest waiting {duration} |
| `panel.transit.empty` | Queue empty. No messages in transit. |
| `panel.transit.tooltip.age` | Time since the oldest queued message was accepted |
| `panel.transit.stalled` | {count} message(s) stalled — no progress for {duration} |

#### State labels

| Key | String |
|-----|--------|
| `state.queued` | Queued |
| `state.dispatching` | Dispatching |
| `state.transport_written` | Transport written |
| `state.held` | Held — Codex busy |
| `state.stalled` | Stalled |
| `state.delivered` | Delivered |
| `state.expired` | Expired |
| `state.rejected` | Rejected |
| `state.cancelled` | Cancelled |
| `state.abandoned` | Abandoned |
| `state.failed` | Failed |
| `state.ambiguous` | Ambiguous |
| `state.duplicate` | Duplicate |

### Panel 4: Activity Ledger

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.ledger.heading` | Activity ledger |
| `panel.ledger.eyebrow` | Receipt lifecycle |
| `panel.ledger.summary` | {count} receipt(s) — most recent {relative_time} |
| `panel.ledger.empty` | No deliveries yet. Send a message to see its receipt here. |
| `panel.ledger.tooltip` | Each row is a receipt. Expand for lifecycle detail. |
| `panel.ledger.detail.label` | Receipt detail |

#### Acceptance vs. delivery explanation

| Key | String |
|-----|--------|
| `ledger.explain.acceptance` | Accepted means the broker queued the message. It does not mean the recipient received it. |
| `ledger.explain.delivery` | Delivered means the recipient's agent confirmed receipt. Check terminal state for the final outcome. |
| `ledger.explain.progress` | Progress states (queued, dispatching, held) are not failures. They indicate the message is still in transit. |

### Panel 5: Sessions and Routes

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.sessions.heading` | Sessions and routes |
| `panel.sessions.eyebrow` | Connected agents |
| `panel.sessions.empty` | No active sessions. Start the broker and register a task. |
| `panel.sessions.tooltip.registration` | Registered: the Codex task has announced itself to Embassy |
| `panel.sessions.tooltip.discovery` | Discovered: Embassy found a compatible Claude Code session, but it has not been selected |
| `panel.sessions.tooltip.selection` | Selected: this Claude session has been explicitly chosen for outbound messaging |

#### Labels

| Key | String |
|-----|--------|
| `session.label.registered` | Registered |
| `session.label.discovered` | Discovered |
| `session.label.selected` | Selected |
| `session.label.reachable` | Reachable |
| `session.label.unreachable` | Unreachable |
| `session.label.alias` | Alias |
| `session.label.conversation_token` | Conversation token |

### Panel 6: Compatibility and Diagnostics

#### Headings and summaries

| Key | String |
|-----|--------|
| `panel.compat.heading` | Compatibility and diagnostics |
| `panel.compat.eyebrow` | Version and health |
| `panel.compat.collapsed` | Expand for version pins, health checks, and diagnostics |
| `panel.compat.empty` | Broker not running — no diagnostics available. |

#### Labels

| Key | String |
|-----|--------|
| `compat.label.node` | Node.js version |
| `compat.label.claude_code` | Claude Code version |
| `compat.label.codex_app_server` | Codex App Server version |
| `compat.label.pinned` | Pinned |
| `compat.label.detected` | Detected |
| `compat.label.compatible` | Compatible |
| `compat.label.incompatible` | Incompatible — broker will not route |
| `compat.label.health_ok` | Health check passed |
| `compat.label.health_fail` | Health check failed — {safe_code} |

### Cross-panel states

| Key | String |
|-----|--------|
| `global.loading` | Loading… |
| `global.stale` | Snapshot may be stale — last refreshed {relative_time} |
| `global.refresh_paused` | Auto-refresh paused |
| `global.refresh_resume` | Resume auto-refresh |
| `global.static_snapshot` | This dashboard shows a point-in-time snapshot. It does not update automatically. |
| `global.live_opt_in` | Enable live updates (read-only) |
| `global.live_active` | Live — read-only, updates every {interval}s |
| `global.live_disclaimer` | Live mode reads state only. No actions are performed. |

### Accessibility labels

| Key | String |
|-----|--------|
| `a11y.direction.to_codex` | Message direction: Claude to Codex |
| `a11y.direction.to_claude` | Message direction: Codex to Claude |
| `a11y.status` | Message status: {state} |
| `a11y.queue_age` | Queue age: {duration} |
| `a11y.receipt` | Receipt {token}: {state}, {relative_time} |
| `a11y.session_state` | {alias}: {registration_state} |
| `a11y.broker_health` | Broker health: {state} |

---

## Deliverable 4 — zh-CN Dashboard String Catalog

### 面板 1：交换面板

#### 标题与摘要

| 键 | 字符串 |
|----|--------|
| `panel.exchange.heading` | 交换面板 |
| `panel.exchange.eyebrow` | 路由概览 |
| `panel.exchange.summary.ready` | 路由就绪——已注册 Codex 任务，已选定 Claude 会话 |
| `panel.exchange.summary.partial` | 路由未完成——请参阅下方操作指引 |
| `panel.exchange.tooltip.direction` | 箭头表示消息方向，非会话层级 |

#### 操作与命令标签

| 键 | 字符串 |
|----|--------|
| `panel.exchange.action.register` | 注册 Codex 任务 |
| `panel.exchange.action.select` | 选定 Claude 会话 |
| `panel.exchange.cmd.register` | `embassy register-codex --alias {alias}` |
| `panel.exchange.cmd.select` | `embassy select-claude --alias {alias}` |
| `panel.exchange.cmd.copy.label` | 复制命令 |

#### 下一步操作

| 键 | 字符串 |
|----|--------|
| `panel.exchange.next.no_broker` | 启动中介：`embassy serve` |
| `panel.exchange.next.no_registration` | 请先注册一个 Codex 任务 |
| `panel.exchange.next.no_discovery` | 未发现兼容的 Claude 会话——Claude Code 是否正在运行？ |
| `panel.exchange.next.discovered_not_selected` | 已发现 {count} 个 Claude 会话，但尚未选定——请选定一个以启用发送 |
| `panel.exchange.next.ready` | 路由就绪。可发送消息或检查状态。 |

#### 空状态

| 键 | 字符串 |
|----|--------|
| `empty.no_broker` | 中介未运行。请执行 `embassy serve` 启动。 |
| `empty.no_codex` | 未注册 Codex 任务。请在 Codex 任务中执行 `embassy register-codex`。 |
| `empty.no_claude_discovered` | 未发现兼容的 Claude Code 会话。请确认 Claude Code 在同一 macOS 用户下运行。 |
| `empty.discovered_not_selected` | 已发现 {count} 个 Claude Code 会话，但未选定。发现不等于选定——请执行 `embassy select-claude` 明确选定。 |

#### 中介状态

| 键 | 字符串 |
|----|--------|
| `broker.status.healthy` | 中介正常 |
| `broker.status.degraded` | 中介异常——请执行 `embassy health` 检查 |
| `broker.status.offline` | 中介离线 |
| `broker.version.compatible` | 提供商版本兼容 |
| `broker.version.incompatible` | 提供商版本不兼容——中介将停止路由。需要 Claude Code {expected_cc}、Codex App Server {expected_cas}。 |

### 面板 2：待处理事项

| 键 | 字符串 |
|----|--------|
| `panel.attention.heading` | 待处理事项 |
| `panel.attention.eyebrow` | 可操作警报 |
| `panel.attention.summary` | {count} 项待处理 |
| `panel.attention.empty` | 无待处理事项。 |
| `panel.attention.tooltip` | 按紧急程度排序。无事项时此面板隐藏。 |

#### 警报状态

| 键 | 字符串 |
|----|--------|
| `alert.stalled` | 消息 {token} 停滞——已写入传输层但 {duration} 内未收到投递回执 |
| `alert.held` | 消息 {token} 挂起——Codex 任务繁忙，消息已排队 |
| `alert.expired` | 消息 {token} 已过期——投递窗口已关闭 |
| `alert.ambiguous` | 消息 {token} 状态不明——无法确定终态 |
| `alert.failed` | 消息 {token} 失败——{safe_code} |
| `alert.incompatible` | 提供商版本不兼容——路由已禁用 |
| `alert.claude_offline` | 已选定的 Claude 会话不再可达 |
| `alert.codex_offline` | 已注册的 Codex 任务不再可达 |

### 面板 3：传输中

| 键 | 字符串 |
|----|--------|
| `panel.transit.heading` | 传输中 |
| `panel.transit.eyebrow` | 队列状态 |
| `panel.transit.summary` | 队列中 {count} 条消息——最早已等待 {duration} |
| `panel.transit.empty` | 队列为空。无消息传输中。 |
| `panel.transit.tooltip.age` | 最早排队消息自接受以来的等待时长 |
| `panel.transit.stalled` | {count} 条消息停滞——{duration} 内无进展 |

#### 状态标签

| 键 | 字符串 |
|----|--------|
| `state.queued` | 已排队 (queued) |
| `state.dispatching` | 分发中 (dispatching) |
| `state.transport_written` | 已写入传输层 (transport written) |
| `state.held` | 挂起——Codex 繁忙 (held) |
| `state.stalled` | 停滞 (stalled) |
| `state.delivered` | 已投递 (delivered) |
| `state.expired` | 已过期 (expired) |
| `state.rejected` | 已拒绝 (rejected) |
| `state.cancelled` | 已取消 (cancelled) |
| `state.abandoned` | 已放弃 (abandoned) |
| `state.failed` | 失败 (failed) |
| `state.ambiguous` | 状态不明 (ambiguous) |
| `state.duplicate` | 重复 (duplicate) |

### 面板 4：活动台账

| 键 | 字符串 |
|----|--------|
| `panel.ledger.heading` | 活动台账 |
| `panel.ledger.eyebrow` | 回执生命周期 |
| `panel.ledger.summary` | {count} 条回执——最近 {relative_time} |
| `panel.ledger.empty` | 尚无投递记录。发送一条消息后，回执将在此显示。 |
| `panel.ledger.tooltip` | 每行为一条回执。展开查看生命周期详情。 |
| `panel.ledger.detail.label` | 回执详情 |

#### 接受与投递说明

| 键 | 字符串 |
|----|--------|
| `ledger.explain.acceptance` | "已接受"表示中介已将消息排入队列，不代表接收方已收到。 |
| `ledger.explain.delivery` | "已投递"表示接收方的智能体已确认收到。请查看终态以了解最终结果。 |
| `ledger.explain.progress` | 进行中状态（queued、dispatching、held）不是失败。它们表示消息仍在传输中。 |

### 面板 5：会话与路由

| 键 | 字符串 |
|----|--------|
| `panel.sessions.heading` | 会话与路由 |
| `panel.sessions.eyebrow` | 已连接智能体 |
| `panel.sessions.empty` | 无活跃会话。请启动中介并注册一个任务。 |
| `panel.sessions.tooltip.registration` | 已注册：该 Codex 任务已向 Embassy 通告自身 |
| `panel.sessions.tooltip.discovery` | 已发现：Embassy 找到一个兼容的 Claude Code 会话，但尚未选定 |
| `panel.sessions.tooltip.selection` | 已选定：该 Claude 会话已被明确选择用于出站消息 |

#### 标签

| 键 | 字符串 |
|----|--------|
| `session.label.registered` | 已注册 |
| `session.label.discovered` | 已发现 |
| `session.label.selected` | 已选定 |
| `session.label.reachable` | 可达 |
| `session.label.unreachable` | 不可达 |
| `session.label.alias` | 别名 |
| `session.label.conversation_token` | 会话令牌 |

### 面板 6：兼容性与诊断

| 键 | 字符串 |
|----|--------|
| `panel.compat.heading` | 兼容性与诊断 |
| `panel.compat.eyebrow` | 版本与健康状态 |
| `panel.compat.collapsed` | 展开查看版本锁定、健康检查与诊断信息 |
| `panel.compat.empty` | 中介未运行——无可用诊断信息。 |
| `compat.label.node` | Node.js 版本 |
| `compat.label.claude_code` | Claude Code 版本 |
| `compat.label.codex_app_server` | Codex App Server 版本 |
| `compat.label.pinned` | 锁定版本 |
| `compat.label.detected` | 检测到 |
| `compat.label.compatible` | 兼容 |
| `compat.label.incompatible` | 不兼容——中介将停止路由 |
| `compat.label.health_ok` | 健康检查通过 |
| `compat.label.health_fail` | 健康检查失败——{safe_code} |

### 跨面板状态

| 键 | 字符串 |
|----|--------|
| `global.loading` | 加载中… |
| `global.stale` | 快照可能过时——上次刷新于 {relative_time} |
| `global.refresh_paused` | 自动刷新已暂停 |
| `global.refresh_resume` | 恢复自动刷新 |
| `global.static_snapshot` | 仪表盘显示的是时间点快照，不会自动更新。 |
| `global.live_opt_in` | 启用实时更新（只读） |
| `global.live_active` | 实时模式——只读，每 {interval} 秒更新 |
| `global.live_disclaimer` | 实时模式仅读取状态，不执行任何操作。 |

### 无障碍标签

| 键 | 字符串 |
|----|--------|
| `a11y.direction.to_codex` | 消息方向：Claude 到 Codex |
| `a11y.direction.to_claude` | 消息方向：Codex 到 Claude |
| `a11y.status` | 消息状态：{state} |
| `a11y.queue_age` | 队列等待时长：{duration} |
| `a11y.receipt` | 回执 {token}：{state}，{relative_time} |
| `a11y.session_state` | {alias}：{registration_state} |
| `a11y.broker_health` | 中介健康状态：{state} |

---

## Deliverable 5 — README zh-CN Intro and Quickstart Translation Plan

### zh-CN README 开头

# Embassy

**macOS 本机智能体消息中介。**

Embassy（AI 智能体使馆）在同一台 Mac、同一 macOS 用户下，为已运行的 Claude Code 会话和 Codex 桌面任务转发消息。它通过本机 Unix 域套接字和已有的 Codex App Server 路由，不调用提供商 API，不发送遥测数据，不启动或编排智能体。投递后的文本作为常规模型对话轮次，按各产品的正常行为送达 Anthropic 或 OpenAI。"本机"描述的是中介和路由，不是模型推理。

```bash
npm install -g agent-embassy
```

> **非官方项目。** Embassy 与 Anthropic 和 OpenAI 无关联。Claude Code 为 Anthropic 产品，Codex 为 OpenAI 产品。

### zh-CN 快速开始

## 快速开始

六条命令建立一条可用路由。

```bash
# 1. 安装
npm install -g agent-embassy

# 2. 启动中介
embassy serve

# 3. 验证健康状态
embassy health && embassy status

# 4. 在目标 Codex 任务中——注册该任务
embassy register-codex --alias codex-reviewer@this-mac

# 5. 在操作员终端——选定一个 Claude 会话
embassy select-claude --alias advisor@this-mac

# 6. 从已注册任务发送消息（消息体通过 stdin 传入）
echo "Review migration 0042" | \
  embassy send-to-claude \
    --from codex-reviewer@this-mac \
    --to advisor@this-mac \
    --expects-reply
```

接受是异步的。CLI 在接受时返回会话令牌，但消息可能仍处于排队、分发或挂起状态。请使用 `embassy status` 或仪表盘确认投递结果。

### Translation maintenance plan

#### Canonical language

English is canonical for all security-meaningful text. The zh-CN translation must preserve protocol distinctions but is not authoritative when ambiguity arises.

#### Stable anchors

All commands, CLI names (`embassy`, `agent-embassy`), subcommands (`serve`, `health`, `status`, `register-codex`, `select-claude`, `send-to-claude`), flags (`--alias`, `--from`, `--to`, `--expects-reply`), JSON keys, enum values, safe error codes, and alias formats remain untranslated.

#### What remains untranslated

- Product names: Embassy, Claude Code, Codex, Codex App Server
- Technical identifiers: `crossSessionInbound`, `mst_*` tokens, all CLI output
- State enum values: `queued`, `dispatching`, `transport written`, `held`, `stalled`, `delivered`, `expired`, `rejected`, `cancelled`, `abandoned`, `failed`, `ambiguous`, `duplicate`
- Safe error codes: displayed verbatim

#### Glossary

| English | zh-CN | Notes |
|---------|-------|-------|
| discovery | 发现 | Finding a compatible session; does not imply selection |
| selection | 选定 | Explicit operator choice; distinct from discovery |
| registration | 注册 | A task announcing itself to Embassy |
| acceptance | 接受 | Broker queued the message; not delivery |
| delivery | 投递 | Recipient agent confirmed receipt |
| receipt | 回执 | Lifecycle record of a message |
| held | 挂起 | Codex busy, message waiting |
| stalled | 停滞 | No progress for an extended period |
| expired | 已过期 | Delivery window closed |
| ambiguous | 状态不明 | Terminal state indeterminate |
| broker | 中介 | Not 代理 (which implies agent) |
| agent | 智能体 | Not 代理 (which implies proxy/broker) |
| local | 本机 | Describes broker/route, never implies offline inference |
| same OS user | 同一 macOS 用户 | Specific to macOS UID containment |

#### Protocol review checklist

Before merging any zh-CN translation update:

1. Verify all three-state distinctions (registered / discovered / selected) remain explicit and unmerged.
2. Verify acceptance vs. delivery distinction is maintained in every relevant string.
3. Verify progress states are not described as errors or failures.
4. Verify "本机" is never used in a way that implies offline inference.
5. Verify all commands, enums, and safe codes are untranslated.
6. Verify the unofficial-project disclaimer is present.
7. Verify the glossary terms match the translations used in the document.
8. Cross-check against the English canonical version for any new strings added since the last sync.

#### Update workflow

1. English copy is updated and reviewed first.
2. Diff English changes against the last synced version.
3. Update zh-CN to match, using the glossary for consistent terminology.
4. Run the protocol review checklist above.
5. Tag the zh-CN commit with the English commit hash it was synced to (e.g., `i18n-sync: abc1234`).
6. If a protocol-sensitive term changes in English, update the glossary first, then propagate.

---

## Copy Risks and Decisions

### 1. Live dashboard wording

The dashboard copy includes both a static-snapshot mode and a proposed opt-in live read-only mode. **Risk:** If live mode is not yet implemented, the `global.live_opt_in`, `global.live_active`, and `global.live_disclaimer` strings should be withheld from the UI. **Conservative fallback:** Ship only `global.static_snapshot` and add live strings when the feature lands.

### 2. Stall notices and thresholds

`alert.stalled` and `panel.transit.stalled` reference `{duration}` but do not define the threshold. **Risk:** If the stall threshold is configurable or differs from what users expect, the copy could mislead. **Conservative fallback:** Add "Check `embassy status` for details" to stall alerts rather than implying a fixed threshold.

### 3. Route reselection after restart

The copy states "no replay after restart" and messages are memory-only. **Risk:** It does not explicitly say whether selection state persists across broker restarts. If selection is also memory-only, users may expect their route to survive `embassy serve` restarts. **Conservative fallback:** Add a string: "Registration and selection do not persist across broker restarts. Re-register and re-select after restarting `embassy serve`." Hold this string until implementation confirms the behavior.

### 4. Dashboard actions

The dashboard is described as read-only and showing metadata only. The exchange board panel includes "Register a Codex task" and "Select a Claude session" as actions, but these copy commands to the clipboard rather than performing mutations. **Risk:** If the dashboard later gains write actions, the "no actions are performed" disclaimer in live mode becomes inaccurate. **Conservative fallback:** Label clipboard actions as "Copy command" explicitly, and audit the disclaimer if write actions are added.

### 5. Queue age display

`panel.transit.summary` shows "oldest waiting {duration}". **Risk:** If the broker does not expose a queue-entry timestamp, this string cannot be populated. **Conservative fallback:** Fall back to "Queue depth: {count}" without age if timestamps are unavailable.

### 6. Terminal receipt detail

The activity ledger promises "details on demand" for receipt lifecycle. **Risk:** If the broker only exposes current state (not historical transitions), the expand-for-detail interaction has nothing to show. **Conservative fallback:** Show only current state and timestamp. Add lifecycle timeline when the broker emits transition events.

### 7. "Ambiguous" terminal state

`ambiguous` is listed as a terminal state. **Risk:** Users may not understand what makes a delivery ambiguous. **Conservative fallback:** Include a tooltip or helper: "The broker could not determine whether the message was delivered or lost. Check both agents for the message content."

### 8. Duplicate state

`duplicate` appears in the state enum but is noted as "where appropriate." **Risk:** If deduplication logic is not yet implemented, exposing this state in the UI creates confusion. **Conservative fallback:** Suppress `state.duplicate` from the UI until deduplication ships.

### 9. Codex busy / held semantics

`alert.held` says "Codex task is busy, message queued." **Risk:** "Busy" is informal. Implementation should confirm what "busy" means — is Codex mid-turn, at capacity, or unresponsive? **Conservative fallback:** "Message held — waiting for the Codex task to accept new input."

### 10. zh-CN first-mention parenthetical

The brief allows "Embassy（AI 智能体使馆）" on first mention "if natural." **Decision:** Used in the meta description and README opener. Subsequent mentions use "Embassy" alone. If user research shows the parenthetical confuses more than it clarifies, drop it.
