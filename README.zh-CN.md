[English](README.md) · 简体中文

<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/agent-embassy/main/assets/social-preview.png" alt="Embassy — 一个本地网关，用于在 Claude Code 会话与 Codex 桌面任务之间实现双向消息传递" width="720">
</p>

# Embassy

**属于你的 AI 代理本地使馆。**

[![CI](https://github.com/YuanpingSong/agent-embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/agent-embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

Embassy 是一个单机本地网关，让运行中的 [Claude Code](https://code.claude.com) 会话与 [Codex](https://chatgpt.com/codex) 桌面任务能够按名称互相发现，并进行双向消息交换。

```bash
npm install -g agent-embassy
embassy serve
```

或从源码构建：`git clone https://github.com/YuanpingSong/agent-embassy && cd agent-embassy && npm ci && npm run build && npm link`。

Embassy 专为单人、单一 macOS 账户以及你已信任以该用户身份运行的代理而设计。本项目是非官方的社区项目，与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 目录

- [设计初衷](#设计初衷) · [核心术语](#核心术语) · [工作原理](#工作原理)
- [快速开始](#快速开始) · [面向代理](#面向代理) · [寻址方式](#寻址方式) · [命令一览](#命令一览)
- [投递语义](#投递语义) · [安全模型](#安全模型) · [Embassy 不是什么](#embassy-不是什么)
- [兼容性约定](#兼容性约定) · [配置项](#配置项) · [仪表盘](#仪表盘) · [从原型迁移](#从原型迁移) · [文档索引](#文档索引)

## 设计初衷

Claude Code 会话之间可以通过 Anthropic 的跨会话工具互发消息。Codex 任务则运行在 Codex 桌面应用中。如果没有 Embassy，让一方咨询另一方意味着你需要在窗口之间手动搬运上下文。

Embassy 就是它们之间的小型本地消息代理。它不封装、不替代、也不重新实现任何一个代理。`embassy serve` 不打开任何 TCP 或 HTTP 监听器，不发起任何提供商 API 调用，也不发送任何遥测数据；可选启用的[实时仪表盘](#实时仪表盘)组件是一个独立进程，也是 Embassy 能创建的唯一监听器。它通过本地 Unix 域套接字和已在运行的 Codex App Server 交换有界文本。

这些代理仍然是云端支撑的产品。被路由的消息会成为一次普通模型推理的输入，因此其内容会以该产品通常接收输入的相同方式到达 Anthropic 或 OpenAI。"本地"描述的是代理和路由，不是模型推理。

## 核心术语

四个 Embassy 术语对应真实功能。所有技术细节在下文各节中说明。

- **注册与选择**是非对称认证：Codex 目标通过显式注册发布，而出站 Claude 目的地通过显式选择绑定。任何以相同 OS 用户身份运行的精确兼容、在线的 Claude 会话，都可以在该任务既有的原生 Codex 审批与沙盒策略下，向已注册的 Codex 目标发起原生投递。
- **账簿**是投递记录：每条已结算消息的回执，以及一个仅包含元数据的仪表盘。
- **信袋**是传输通道：有界的消息体，在 Embassy 内部是临时的，从不被持久化。
- **领事馆**是路线图：将同一模型通过仅限 attach 的 SSH 扩展到远程主机上的 Codex 任务——已经完成设计，但在 v1 中有意禁用。

## 工作原理

```text
 Claude Code 会话                              Codex 桌面任务
 (原生 ListAgents /                            (原生 App Server，
  SendMessage 工具)                             既有任务策略)
        │                                             │
        ▼                                             ▼
  ┌──────────────────── Embassy ─────────────────────────────┐
  │ 显式路由 │ 忙碌排队 │ 回执 │ 仪表盘                       │
  └───────────────────────────────────────────────────────────┘
```

Embassy 将一个显式注册的 Codex 任务，以明确命名的 `codex-*` 对等方身份发布到 Claude Code 的实时会话注册表中。兼容的 Claude 会话通过原生的 `ListAgents` 即可发现它，并通过 `SendMessage` 与之通信——无需任何 Claude 插件、MCP 服务器或设置更改。

这里存在一种有意的非对称性：

- **Claude → Codex：** 注册操作会将一个 `codex-*` 任务通告给以相同 OS 用户身份运行的所有兼容在线 Claude 会话。精确匹配的在线发送方可以到达该任务，但不会因此被选择为反向消息的目的地。
- **Codex → Claude：** Codex 任务必须已注册，且你必须先显式选择目标 Claude 会话。发送操作绝不会静默地选择一个被发现的会话。

Embassy 在 Codex 任务忙碌时将消息排队，并在任务空闲后启动一个普通轮次。它从不暴露 `turn/steer`。它只会中断同一连接器发起并已被正向观测到的轮次，例如在受控关闭期间。

网关在运行期间创建一个回调套接字和一条 `codex-*` 注册表记录，并在优雅关闭时移除二者。崩溃后，残留的旧制品会被进程存活检查和生成号校验拒绝。固定的主机级租约确保当前登录账户只能有一个 Embassy 控制器，即使不同启动实例的 `EMBASSY_STATE_DIR` 不同。

## 快速开始

### 前置要求

- macOS 和 Node.js 20 或更高版本
- Claude Code 2.1.225，已安装并登录；在补丁升级期间，仍在运行的 2.1.224 会话保持可发现
- Codex 桌面及其托管的独立 App Server 0.147.0 正在运行

公开发布的 v1 启动器仅支持 macOS 且仅限本机。

`crossSessionInbound` 是 Claude Code 自身的跨会话消息设置：它决定一个 Claude 会话接受、挂起还是拒绝来自其他会话的消息。Embassy 需要在你选择作为 Codex→Claude 目的地的会话上启用此设置，且无法覆盖该决定。请在 Claude Code 中配置它，而不是在 Embassy 中。

### 1. 启动 Embassy

在与 Claude Code 和 Codex 相同的 OS 账户下运行前台代理：

```bash
embassy serve
```

它从不自行守护化。在另一个终端中验证其状态，并列出当前可见的、经过脱敏的 Claude 候选者：

```bash
embassy health
embassy status
```

`status` 中的 `availablePeers` 列表包含你可以选择的当前真实 Claude 名称。来自其他网关的原生 `codex-*` 通告不是 Claude 目的地，会被排除在外。

### 2. 注册 Codex 任务

在你想要公开的 Codex 任务内部运行注册命令，以便该命令继承该任务的 `CODEX_THREAD_ID`。实际操作中，让 Codex 代理在其当前轮次中以 shell 步骤运行此命令：

```bash
embassy register-codex --alias codex-reviewer@this-mac
```

`codex-` 前缀是原生 Claude 发现所必需的。注册是 Claude 发起轮次的准入边界。当你不再希望该任务被通告时，使用 `unregister-codex`。

如需在不重启代理的情况下将注册转交给另一个 Codex 任务，请从新任务内部运行注册命令并指定当前任务：

```bash
embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac
```

交接是彻底的断裂，而非迁移。Embassy 会冻结即将卸任的路由，等待其已接受的工作全部到达终态结算，然后才在新的监听器生成号上发布继任者。没有任何内容会随旧身份转移：排队的消息体、对话、回复能力或投递令牌均不保留，且未完成的交接会以关闭状态失败，不会留下两个同时存在的活跃注册。

Embassy 不会更改任务的审批或沙盒策略。入站消息以任务既有的原生策略运行。如果该策略要求审批，Embassy 不会替你完成审批。如果策略为 `approvalPolicy: never`，则在已接受的入站消息与模型轮次之间不存在人工审批环节。

### 3. 选择 Claude 目的地

从 `availablePeers` 中选择一个唯一的当前名称：

```bash
embassy select-claude --alias advisor@this-mac
```

选择是显式的，即使 Claude 的当前名称发生变化，绑定仍然关联到其稳定的会话 UUID。你也可以用已知的 UUID 进行选择：

```bash
embassy select-claude --session 123e4567-e89b-42d3-a456-426614174000
```

Embassy 从不为你打印或发现该 UUID。

Embassy 自身重启后，先前的 Claude 绑定仍被存储但处于过期状态，无法立即路由。下一次经授权的完整实时发现会自动重新激活该绑定，前提是恰好有一个兼容的交互式对等方拥有相同的会话 UUID、提供商、主机和所有者租约；此时 Embassy 会采用该对等方的最新名称。UUID 变更、发现结果不明确或不完整、或工作区/提供商重新验证失败都会使路由保持过期状态。你也可以显式运行 `select-claude`。重启后，排队的文本、待处理的回复、回调、回执句柄或对话能力均不保留。

### 4. 发送消息

从已注册的 Codex 任务中运行发送命令。消息体来自标准输入，而非命令行参数：

```bash
embassy send-to-claude \
  --from codex-reviewer@this-mac \
  --to advisor@this-mac \
  --expects-reply <<'MSG'
Please review the current approach and identify the main risk.
MSG
```

该命令返回一个公开的对话令牌和一个 dlv_ 投递令牌。由于此次发送请求了回复，Claude 的原生响应会被自动关联并路由回已注册的 Codex 任务。持有令牌的一方还可以发送后续跟进消息：

```bash
embassy reply \
  --conversation conv_<token-from-the-send> \
  --alias codex-reviewer@this-mac <<'MSG'
Please expand on the migration risk.
MSG
```

反方向上，兼容的在线 Claude 会话使用其原生的 `ListAgents` 和 `SendMessage` 工具联系 `codex-reviewer`；Embassy 将 Codex 任务的最终回复返回给该 Claude 会话。

## 面向代理

Embassy 的操作者本身往往就是代理：`register-codex` 步骤必须在 Codex 任务内部执行，而 Claude 端则完全通过 Claude 的原生工具驱动。仓库附带了一个专为此设计的技能——[`skills/embassy-peer/SKILL.md`](skills/embassy-peer/SKILL.md) 教会代理完整的工作流（检查网关健康状态、注册、发送、回复、解读队列状态），同时不暴露任何标识符或消息体。请将你的代理指向该技能，而非向它复述本 README 的内容。

## 寻址方式

Claude 会话通过其当前的 `name@host` 或用户提供的原生会话 UUID 寻址。UUID 是稳定的逻辑标识；当前名称是实时查找别名。重命名后，旧名称立即停止解析，而已选择的 UUID 绑定路由在新名称下继续有效。

名称、旧名称、PID、注册表路径、进程生成号和套接字生成号绝不会成为替代身份键。当两个在线会话共享同一当前名称时，Embassy 拒绝猜测。

Codex 路由使用显式的 `codex-*` 别名和任务继承的线程标识。私有线程 ID 从不被接受为命令行参数，也从不被打印。

## 命令一览

| 命令 | 执行者 | 用途 |
| --- | --- | --- |
| `serve` | 操作员 | 启动前台代理和仪表盘 |
| `health` / `status` | 操作员 | 检查存活状态并查看脱敏快照 |
| `refresh-dashboard` | 操作员 | 重新生成两个静态仪表盘文件 |
| `dashboard --live [--lang en\|zh-CN]` | 操作员 | 启动只读实时仪表盘组件；需要 `embassy serve` 正在运行 |
| `delivery-status` | 任一提供方 | 通过 `dlv_` 令牌读取单条投递跟踪器 |
| `wait-delivery` | 任一提供方 | 等待该跟踪器结算，直至投递截止时间 |
| `register-codex` / `unregister-codex` | Codex 任务 | 通告或注销该任务；`register-codex --succeeds <current-alias>` 将注册转交给另一个任务 |
| `select-claude` / `unselect-claude` | 操作员 | 选择或取消选择已发现的 Claude 目的地 |
| `send-to-claude` | 已注册的 Codex 任务 | 向已选择的 Claude 会话发送一条有界消息 |
| `send-to-codex` | Claude 会话 | 使用继承的原生回复标识发送一条有界消息 |
| `reply` | 任一提供方 | 通过公开令牌继续一个活跃对话 |

提供方授权的命令恰好继承一个标识：Codex 任务的 `CODEX_THREAD_ID` 或 Claude 会话的 `CLAUDE_CODE_MESSAGING_SOCKET`。标识缺失或重复会以关闭状态失败。别名只是标签，不是权限来源；提供方端点在投递时会被重新验证。

## 投递语义

- **忙碌排队。** Embassy 为活跃的 Codex 任务排队，并在任务空闲后进行分派。它不会抢占或中断他人的轮次来强制投递。
- **接受不等于完成。** CLI 初始接受返回一个对话令牌和一个投递令牌。目的地或 App Server 成功接受后结算为 `delivered`：朝向 Codex 方向，这意味着 App Server 接受了该轮次；朝向 Claude 方向，这意味着消息已释放到会话的原生队列——并非已读、也非已完成。
- **证据有三种形态。** `delivered` 表示观测到了终端提供方证据。`unconfirmed` 表示传输写入已完成，但未收到终端原生证据。`ambiguous` 表示写入结果本身未知。三者均为终态，`unconfirmed` 和 `ambiguous` 都不构成重试授权——请检查接收方，因为重发可能导致消息重复。
- **原生失败。** Claude 发起的路由或投递失败结算为原生 `expired`，后跟一个静态 `<gateway-delivery-diagnostic>` 帧，其中包含安全的错误代码。该帧不包含路径、原生标识符、异常或消息体。`denied` 保留用于真实的用户或策略拒绝，Embassy v1 不会生成该状态。`held` 和已完成传输写入是进度状态，不是成功状态。
- **保守重试。** 尚未分派的消息在其路由忙碌或暂时不可用期间保持排队。重新运行 `register-codex` 会替换已关闭或故障的 App Server 连接器，并在恢复后的路由空闲时唤醒挂起的工作。显式的干净适配器延迟可以将同一消息体退回队列。已确认的投递失败会结算；不明确的写入结果绝不会被自动重试。
- **有界设计。** 消息体、队列、速率窗口、去重表、截止时间、跳数和临时对话都有固定的上限。
- **重启不重放文本。** 排队和在途的消息体仅存在于内存中。如果 Embassy 在结算前停止，元数据变为废弃状态，消息体被丢弃，不会有任何重放。先前的 Claude 绑定仍被存储但处于过期状态；经授权的完整实时发现后，精确唯一的存储 UUID 会自动重新激活；显式运行 `select-claude` 仍是可选的后备方式。重启后，待处理的回复或对话能力均不保留。

已接受的消息在代理和提供方连接保持健康的情况下被跟踪至终态投递。仪表盘区分接受、进行中、已投递、过期、失败、不明确和废弃等状态。

### 投递令牌

每次被接受的 `send-to-claude`、`send-to-codex` 和 `reply` 都会返回一个投递令牌：`dlv_` 后跟恰好 24 个 base64url 字符。它指向一个有界的内存跟踪器，不是提供方回执句柄。

```bash
embassy delivery-status --token dlv_<token>
embassy wait-delivery --token dlv_<token>
```

`delivery-status` 读取跟踪器一次。`wait-delivery` 轮询直至跟踪器到达终态或投递截止时间到期。仅在 `delivered` 时以退出码 `0` 退出，任何其他终态（`unconfirmed`、`expired`、`failed`、`ambiguous` 或 `cancelled`）以退出码 `6` 退出，令牌未知时以 `3` 退出，本地等待超时以 `4` 退出——超时不是终态，不构成重发授权。令牌仅存于内存：重启后，先前的令牌会报告 `found: false`。

## 安全模型

Embassy 在两个强大的本地代理之间创建了一条新的输入路径。请将每条被路由的消息视为可能引导接收方行为的不可信输入。

- **本地代理，云端支撑的代理。** `embassy serve` 仅监听私有 Unix 域套接字，不发起任何提供商 API 调用；可选启用的 `embassy dashboard --live` 组件会另外添加一个独立的只读环回监听器（见[实时仪表盘](#实时仪表盘)）。已投递的内容仍然会进入 Claude 或 Codex 的模型上下文，并按照该产品的正常对话行为被保留。
- **同 UID 隔离，而非身份认证。** 调用者身份继承自本地进程环境。以你的 OS 用户身份运行的其他进程可以呈现该身份。路由所有权、精确端点生成号、边界和对话状态能减少误操作；但它们不是对你已允许以你身份运行的代码的防御。
- **显式出站同意。** Codex 任务不能向仅被发现但未被选择的 Claude 候选者发送消息。操作员必须先选择它。入站的原生 Claude 发送方会被验证为精确兼容的在线会话，但不会被自动选择为出站目的地。
- **原生权限保持原生。** Embassy 不发送任何 Codex 审批或沙盒覆盖，也不应答任何审批请求。对于 Codex→Claude 投递，`crossSessionInbound` 仍是 Claude 原生的控制机制，决定是否接受、挂起或拒绝进入所选 Claude 会话的消息；Embassy 无法覆盖它。
- **有限的文件系统和进程访问。** Embassy 仅读取和执行配置的 Claude 启动器以进行有界的版本证明，使用固定的 macOS `/usr/bin/lockf` 加 `/bin/cat` 持有其私有主机租约，读取在线的 Claude 注册表，连接经验证的对等方套接字，创建自己的回调套接字和一条注册表记录，解析托管的 Codex 安装，并附接到已在运行的本地 App Server。它可能检查提供方通告路径的规范元数据。它仅向配置的私有状态目录加上 `~/.local/state/agent-embassy` 下的固定私有主机租约记录写入持久数据，且仅移除自己精确拥有的提供方制品。
- **不访问凭据或记录。** Embassy 从不读取凭据、钥匙串条目、Claude 项目历史、Codex 或 Claude 对话记录、shell 历史或提供商配置内容。
- **私有持久化。** 消息体、提示词、回复、原始提供方帧、回调地址和套接字路径从不被持久化。已关闭的 mode-0600 路由绑定保留所有权和重启后重新观测所需的 Codex 线程 ID 和 Claude 会话 UUID。这些标识符从不进入规范化事件、仪表盘、别名、日志、错误或 CLI 输出。Claude UUID 仅在用户将其作为显式 CLI 选择器提供时才可能出现。
- **静态仪表盘。** `gateway-dashboard.html` 和 `gateway-dashboard.zh-CN.html` 是原子写入到状态目录下的自包含 mode-0600 文件。它们包含内联 CSS，但不含 JavaScript、服务器、外部资源、Cookie、存储、遥测或变更端点——也没有自动刷新。它们只显示元数据——不显示消息内容——包括别名、路由状态、时间戳、字节计数和队列深度。

请仅在属于你一人的 OS 账户下运行 Embassy，且运行环境中你信任以该账户身份运行的所有程序。不要通过网络暴露其套接字或状态目录，也不要用它在用户之间共享订阅。完整的安全边界和漏洞报告流程请参见 [SECURITY.md](SECURITY.md)。

## Embassy 不是什么

- **不是编排器。** 它不生成代理，也不管理它们的工作。它为每条路由消息启动一个轮次，并在任务空闲时排空队列。
- **不是托管服务。** 面向个人的、同机同账户软件。
- **不是权限绕过——但它是一条新路径。** 两个代理都不会获得它原本没有的工具，Embassy 也不授予、放宽或应答任何权限。然而，它确实连接了两个此前无法交换文本的产品。这条路径就是产品本身；请以对待任何新输入通道应有的审慎来看待它。
- **不是官方产品。** 与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 兼容性约定

Embassy 目前使用两个版本固定的接口，这些接口并未被记录为稳定的第三方 API：

- Claude Code 2.1.225，对等协议 1；在补丁过渡期间接受仍在运行的兼容 2.1.224 会话
- Codex App Server 0.147.0

每条记录、套接字和响应结构在使用前都会被验证。未知的提供方版本会以关闭状态失败，而非被猜测为兼容。请预期在任一提供方更改这些内部接口后，Embassy 适配器将需要更新。

托管的 Codex 安装通过精确路径和版本解析；`PATH` 上其他位置的 `codex` 不会被使用或修改。Claude 从 `EMBASSY_CLAUDE_BIN` 或官方的用户级启动器解析，从不搜索 `PATH`。

## 配置项

常用配置：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`，当 `XDG_STATE_HOME` 未设置时为 `$HOME/.local/state/agent-embassy` | 私有状态、控制套接字和仪表盘；覆盖值必须为绝对路径，且不会迁移固定的主机级租约 |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`，解析到固定版本目标 | Claude Code 启动器的绝对路径；不搜索 `PATH` |

高级边界保留保守的默认值：

| 变量 | 默认值 |
| --- | ---: |
| `EMBASSY_MAX_ROUTES` | `128` |
| `EMBASSY_EVENT_CAPACITY` / `EMBASSY_EVENT_TTL_MS` | `500` / `86400000` |
| `EMBASSY_DEDUPE_CAPACITY` / `EMBASSY_DEDUPE_TTL_MS` | `2000` / `300000` |
| `EMBASSY_MAX_QUEUE_MESSAGES` / `EMBASSY_MAX_QUEUE_PER_ROUTE` | `100` / `20` |
| `EMBASSY_MAX_IN_FLIGHT` | `16` |
| `EMBASSY_MAX_QUEUE_BYTES` / `EMBASSY_MAX_MESSAGE_BYTES` | `1048576` / `16384` |
| `EMBASSY_MESSAGE_DEADLINE_MS` | `300000` |
| `EMBASSY_MAX_HOPS` | `2` |
| `EMBASSY_RATE_LIMIT` / `EMBASSY_RATE_WINDOW_MS` | `30` / `60000` |

公开发布的启动器仅接受主机 `this-mac`；远程连接器仍是未来功能。

## 仪表盘

在配置的状态目录下打开 `gateway-dashboard.html`。它提供了一个纯元数据视图，包括连接器健康状态、可用和已选择的 Claude 对等方、已注册的 Codex 路由、近期投递状态、队列深度、延迟和安全告警。

每次发布都会在状态目录下并排写入语言对—— `gateway-dashboard.html` 和 `gateway-dashboard.zh-CN.html`，且每个页面都包含指向另一个页面的页内链接。该链接是静态版本切换语言的唯一方式；`--lang` 是实时组件的标志，而非 `refresh-dashboard` 的标志。

静态页面是时间点快照，不会自动刷新。运行 `embassy refresh-dashboard` 并重新加载页面以查看最新状态，或运行 `embassy dashboard --live` 获取流式视图。

静态仪表盘被有意设计为文件而非 Web 应用。以你的 OS 用户身份运行的任何程序都能读取它，因此如果这种区分对你有意义，请将 `EMBASSY_STATE_DIR` 放在代理工作区之外。

### 实时仪表盘

在另一个终端中 `embassy serve` 已经运行的情况下，在第三个终端中启动组件：

```bash
embassy dashboard --live
```

`embassy dashboard --live` 启动一个独立的前台组件进程，将静态仪表盘显示的相同元数据以流式方式呈现在浏览器标签页中。它通过与其他命令相同的私有控制套接字连接代理，因此在没有服务运行时会报告网关不可用。它绑定 `127.0.0.1` 上的临时端口；该组件不是 `embassy serve` 的一部分，后者仍然是纯套接字的，没有 TCP 或 HTTP 监听器。

访问引导通过一次性的 256 位 URL 片段令牌完成，该令牌会被交换为路径限定的 `HttpOnly` `SameSite=Strict` 会话 Cookie。每次请求都会检查精确的 Host 头；导航 GET 请求允许缺少 Origin 且不携带哨兵值，而非导航 POST 请求则要求精确的 Origin 加上 X-Embassy-Request 哨兵值。没有 CORS 头、没有变更或提供方路由、没有存储、没有遥测、也没有外部资源。浏览器没有任何权限来注册、选择、发送、回复、审批或中断——它仅接收只读的脱敏元数据快照，通过经过认证的 `fetch` 流式传输。一次快照观测可能会在投射状态之前结算已到期的生命周期投递。

可选的 `--lang en|zh-CN` 标志用于选择显示语言。它仅属于实时组件；静态版本始终以两种语言写入，通过页内链接切换。

**注意事项。** 以你的 OS 用户身份运行的任何进程——包括 root 和具有本地文件系统访问权限的浏览器扩展——都可以读取浏览器能读取的内容。

静态的 `gateway-dashboard.html` 和 `gateway-dashboard.zh-CN.html` 文件仍然是惰性的离线底线：mode 0600，无脚本，无网络。

## 从原型迁移

Embassy 是从一个未公开的内部原型中提取的公开网关。

- 原型的单向 MCP 任务生命周期已退役，不属于 Embassy v1 的一部分。
- 在首次运行 `embassy serve` 之前，请停止任何正在运行的前台原型网关。在一个发布周期内，Embassy 仅有界读取精确的旧版默认所有权标记和控制器锁记录，然后在运行期间持有一个新创建的旧版锁。任何预先存在的旧版锁会被保留，启动以 `GATEWAY_INSTANCE_IN_USE` 停止；在确认没有原型进程仍在运行后，手动移除该精确的过期锁并重试。旧版网关状态和消息数据不会被导入、迁移或删除。
- Embassy 在 `agent-embassy` 下以全新状态启动；它不迁移原型状态。请重新注册 Codex 任务并重新选择 Claude 目的地。状态目录覆盖不能用于运行第二个控制器。
- `claude-codex-gateway` 在一个发布周期内作为已弃用的二进制别名保留。新用法应使用 `embassy`。

## 开发

确定性测试、安全敏感变更要求以及围绕实时提供方消息的显式授权边界，请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档索引

| 文档 | 涵盖内容 |
| --- | --- |
| [架构](docs/GATEWAY-ARCHITECTURE.md) | 完整设计：拓扑、适配器、控制平面、威胁模型、分级授权阶梯 |
| [安全策略](SECURITY.md) | 如何报告漏洞，以及详细的安全边界 |
| [贡献指南](CONTRIBUTING.md) | 变更的归属位置，以及如何运行确定性测试套件 |
| [变更日志](CHANGELOG.md) | 每个版本包含的内容 |
| [代理技能](skills/embassy-peer/SKILL.md) | 代理操作 Embassy 所遵循的工作流 |

## 许可证

[MIT](LICENSE)
