[English](README.md) · 简体中文

<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — 一个本地网关，用于在 Claude Code 会话与 Codex 桌面任务之间实现双向消息传递" width="720">
</p>

# Embassy

**属于你的 AI 代理本地使馆。**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

你的 [Claude Code](https://code.claude.com) 会话、[Codex](https://chatgpt.com/codex) 桌面任务、本地 DeepSeek Harness、Grok Build 代理与 shell harness 没有共同路由面。Embassy 是一个小型本地代理，为五种提供方提供具名路由与显式同意边——无需插件，Embassy 不处理 API 密钥，也无需云端中继。

```bash
npm install -g agent-embassy
```

如实说明前置要求：Claude 路由需要一个使用对等协议 1 的同用户在线 Claude
Code 会话。Embassy 从当前 OS 用户派生外部注册表与对等套接字根目录；它不会
检查 Claude 启动器或配置。Codex 路由需要托管独立 App Server 安装（可由
ChatGPT 桌面应用创建，或运行官方安装器 `curl -fsSL
https://chatgpt.com/codex/install.sh | sh`，再运行 `codex app-server daemon
start`；单独启动守护进程不会配置该布局）。Claude 注册表缺失时，Embassy
会将 Claude 报告为降级，同时保持代理与其他提供方可用。pnpm 用户应固定
版本；非交互式 shell 中还需确保 `PNPM_HOME/bin` 位于 `PATH`。

```bash
embassy serve
```

或从源码构建：`git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`。

Embassy 专为单人、单一 macOS 账户以及你已信任以该用户身份运行的代理而设计。本项目是非官方的社区项目，与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 快速开始

**前置要求：** macOS 与 Node.js 20+。Claude 路由要求对等协议 1；Codex 路由要求 Desktop 使用托管独立 App Server。DeepSeek 是可选提供方，通过 `DSH_HOME`（默认 `~/.dsh`）指向的本地 checkout 中 `demo:acp` 脚本启动；Grok Build 也是可选提供方，通过发布版固定的 ACP 包启动。Shell 对等方只需要本地 CLI 与其仅铸造一次的令牌。发布版自有的[支持矩阵](support/provider-support-matrix.json)记录精确已测的提供方构件与能力；它只是发布证据，绝不是运行时允许列表：

```bash
~/.codex/packages/standalone/current/codex app-server daemon start
/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT
```

第一条命令在托管守护进程未运行时启动它（也提供 `restart` 与 `stop` 子命令）；第二条以指向该守护进程的方式启动 ChatGPT 桌面应用。`CODEX_APP_SERVER_USE_LOCAL_DAEMON` 未见于 OpenAI 文档；它经验证适用于当前 Desktop 构建，未来可能变化。请在普通终端中运行守护进程命令，切勿在代理会话内运行：Codex 任务会继承守护进程的环境，因此在 Claude Code 会话内启动的守护进程会把该会话的身份泄漏到每个任务中，注册将以 `CALLER_IDENTITY_CONFLICT` 关闭失败——请在普通终端执行 `codex app-server daemon restart` 修复。你选择作为目的地的 Claude 会话需要启用 [`crossSessionInbound`](docs/CONFIGURATION.zh-CN.md)——这是 Claude Code 自身的设置，在 Claude Code 中配置，而非在 Embassy 中。

Desktop 仅在启动时附着到托管独立 App Server。如果 Desktop 已打开时守护进程重启，单纯等待不会让该应用进程重新连接：请完全退出 Desktop，重新运行 `/usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT`，再打开该确切任务。

运行时投递采用尽力而为模式。版本与构建字符串只是未经验证的元数据，绝不授予或撤销路由权限。同意加上精确的逻辑路由/会话身份会授权一次尝试；当前逐操作传输与相关证据决定诚实结果。接口不受支持或发生变化时，Embassy 会返回提供方局部的安全代码，而不是在线兼容性等级。Embassy 仍会验证信任边界：精确自有或执行的构件与状态路径、实际使用构件的代际、被消费协议字段的严格结构、Claude 对等协议 1、有界队列，以及结果不确定的写入绝不重放。

> **已知限制：** 仅当 Desktop 使用托管独立 App Server 时，Embassy 才能访问 Codex 任务。在该模式下，任务目前无法连接 Desktop 内置的应用内浏览器（`@Browser` 可加载但无法附着）。将 Desktop 切换回其默认的私有 App Server 会立即恢复内置浏览器——但会使这些任务对 Embassy 不可达。目前未发现其他能力回退，但这并非穷尽的能力对比测试。

### 1. 启动 Embassy

创建[配置文档](docs/CONFIGURATION.zh-CN.md)所述的必需私有 `nodes.json` 后，在与 Claude Code 和 Codex 相同的 OS 账户下运行前台代理：

```bash
embassy serve
```

你应看到 `"status":"ready"`。在另一个终端中：

```bash
embassy health
embassy status
```

`status` 列出 `availablePeers`——你可以选择的在线 Claude 会话。如果该列表为空，请先启动一个 Claude Code 会话，然后运行 `embassy refresh-dashboard` 刷新发现；下一次 `status` 应该就能看到该会话。

### 2. 注册 Codex 任务

让你的 Codex 代理在其当前轮次中以 shell 步骤运行此命令——命令必须在任务内部运行，以便继承该任务的身份：

```bash
embassy register-codex --alias codex-reviewer@this-mac
```

你应看到 `"accepted":true`。`codex-` 前缀是 Claude 发现所必需的。之后若要注销该任务，请在同一个任务内运行 `embassy unregister-codex --alias codex-reviewer@this-mac`。

注册会记录精确的继承任务身份，并且不执行 App Server I/O。每次投递都会打开并验证新的本地传输，初始化后在排除历史的前提下恢复精确任务，并仅授权一次正文写入。因此 App Server、Desktop 与 `embassy serve` 重启都不需要重新注册或重新锚定；当前任务不可用或无法观测时，尝试会返回精确安全代码，而逻辑路由与同意边保持不变。Embassy 绝不会按别名改投其他任务，也不会重放写入结果不明确的正文。

### 可选：注册通用 shell 对等方

本地 shell harness 可以作为 `peer-*` 路由加入，无需插件、稳定 shell、守护进程、PID 绑定、令牌文件或 Keychain 条目：

```bash
embassy register-peer --alias peer-reviewer@this-mac
```

注册只打印一次 `peer_` 令牌。将它保留在代理上下文中，并在每个需要认证的 peer 命令的标准输入第一行提供；若命令还携带消息正文，则其余标准输入字节就是正文。绝不要把令牌放进 argv。例如，等待入站邮件：

```bash
embassy await --alias peer-reviewer@this-mac --token-stdin <<'TOKEN'
peer_<32-character-token>
TOKEN
```

`await` 会进行有界的 30 秒长轮询，直到收到邮件或调用方停止。每条注册路由只能有一个等待者，broker 全局最多允许 16 个。Embassy 将完整带框消息写入 stdout，等待 stdout 刷新完成，之后才确认其私有回执。缺失回执会结算为 `unconfirmed`；写入授权后的不确定性会结算为 `ambiguous`，两者在重启后都不会重放。`register-peer --emit-env` 只是为确实保留稳定 shell 的 harness 提供的可选便利；标准输入是通用路径。

### 3. 选择 Claude 目的地

从 `availablePeers` 中选择一个名称：

```bash
embassy select-claude --alias advisor@this-mac
```

任何能访问私有控制套接字的同 UID 进程都可以运行这条命令。`embassy select-claude --session <uuid>` 通过原生 UUID 选择同一个会话。

你应看到 `"accepted":true`。选择不会创建权限边。请显式创建用户选择的边：

```bash
embassy pair --from codex-reviewer@this-mac --to advisor@this-mac
```

反之，`unselect-claude` 会移除已选择的路由及其关联的同意边，并根据持久化尝试阶段结算这些边的在途工作。

要连接来自不同提供方的任意两条路由，请用 `embassy pair --from <alias> --to <alias>` 显式指定两端；多条边可以并存。同 UID 对私有控制套接字的访问授权该命令，代理仍应只创建用户选择的边。实时仪表盘提供同样的有界确认操作。

### 4. 发送消息

从已注册的 Codex 任务中，通过标准输入发送：

```bash
embassy send-to-claude \
  --from codex-reviewer@this-mac \
  --to advisor@this-mac \
  --expects-reply <<'MSG'
Please review the current approach and identify the main risk.
MSG
```

你应看到一个 `conv_` 对话令牌和一个 `dlv_` 投递令牌。因为此次发送请求了回复，Claude 的响应会被自动路由回 Codex 任务。反方向上，兼容的 Claude 会话使用其原生的 `ListAgents` 和 `SendMessage` 工具联系 `codex-reviewer`——无需 Embassy 命令。

`send-to-codex` 是同一方向的 CLI 形式，供偏好显式命令的 Claude 会话使用。它接受相同的标志并从标准输入读取正文，并且必须在该 Claude 会话内运行，才能继承该会话的回复标识：

```bash
embassy send-to-codex \
  --from advisor@this-mac \
  --to codex-reviewer@this-mac \
  --expects-reply <<'MSG'
Summarize the migration risks you found.
MSG
```

### 5. 后续跟进

任何持有完整 `conv_` 令牌的对话参与方都可以用 `reply` 继续仍然有效的对话。初始发送方从 Embassy 命令结果中获得令牌；接收方则从入站消息的来源封装中获得同一个完整令牌和回复提示：

```bash
embassy reply \
  --conversation conv_<token> \
  --alias codex-reviewer@this-mac <<'MSG'
Please expand on the migration risk.
MSG
```

Embassy 会在实际写入提供方之前，为双向路由消息添加一个由代理控制的 `<cross-session-message>` 来源封装。封装标出已经验证的发送方别名，其首个 `<embassy-reply-hint>` 元素包含完整对话令牌、接收方自己的精确别名和可直接使用的 `embassy reply` 命令。朝向 Codex 时，外层标记本身还带有 `conversation="conv_..."`；朝向 Claude 时，为符合 Claude Code 的规范解析格式，完整令牌和回复提示位于封装正文中，而不作为外层属性。请使用收到的完整令牌，切勿猜测或重构它。令牌本身不授予路由权限：每次回复仍会重新检查调用方身份、对话参与关系和实时路由。

该封装是清晰的来源标记，既不是密码学签名，也不表示正文可信。在写入提供方之前，Embassy 会中和不可信正文中嵌套出现的自有保留封装标签；以你的 OS 用户身份运行的任意代码和所有消息文本，始终都是不可信输入。

### 实时查看

`embassy dashboard --live` 在浏览器中打开一个五选项卡流式视图（总览、投递、路由、活动、诊断），默认地址为 `http://127.0.0.1:41961/`。如需为本次启动选择另一个稳定端口，请运行 `embassy dashboard --live --port <n>`，其中整数范围为 1024 到 65535。当前台组件运行时，该 URL 最多支持四个并发实时视图（可分布在窗口、标签页或浏览器中）；在其中一个关闭前，第五条流会被拒绝。若端口已被占用，启动会明确失败并提示使用 `--port`，不会回退到其他端口。详见[仪表盘](docs/DASHBOARD.zh-CN.md)。

实时仪表盘可在明确确认后移除任意具名 Codex 注册。确认步骤会说明后果：代理会删除该注册的同意边、取消已排队或已保留的工作、把已武装的工作结算为结果不确定、把已接受的工作结算为未确认，并且绝不重放后两类不确定工作。

代理还会以 mode 0600 发布静态快照 `gateway-dashboard.html` 与 `gateway-dashboard.zh-CN.html`。实时仪表盘没有登录、令牌、Cookie 或逐浏览器会话：它假定这是一台可信的单用户机器；能够访问或伪造 loopback 的本地软件可以读取仪表盘并调用其有限操作。服务器仍会对每个请求要求精确的 Host 头，并对每个 POST 要求精确的 Origin 与 `X-Embassy-Request`；它不发送 CORS 头，也不接受 `OPTIONS`。

## 工作原理

```text
 Claude Code 会话                              Codex 桌面任务
 (原生 ListAgents /                            (原生 App Server，
  SendMessage 工具)                             既有任务策略)
        │                                             │
        ▼                                             ▼
  ┌──────────────────── Embassy ─────────────────────────────┐
  │ 显式路由 │ Codex 忙碌排队 │ 回执 │ 仪表盘                 │
  └───────────────────────────────────────────────────────────┘
```

Embassy 将每个已注册的 Codex 任务以各自的 `codex-*` 对等方身份发布到 Claude Code 的实时会话注册表中。Claude 会话通过 `ListAgents` 发现这些任务；Codex 使用托管 App Server。DeepSeek 与 Grok Build 是启动时登记的 ACP 路由，其自有子进程与单个路由本地会话会在首次投递时惰性启动。通用 shell 对等方使用 `peer-*` 别名与一个由别名加仅铸造一次的令牌认证的拉取邮箱。

配对是来自不同提供方的两条具名路由之间的单一显式权限边，默认上限 128 条。每条边都通过通用的 `pair --from/--to` 显式创建；同 UID 私有控制套接字是命令权限，代理仍应只创建用户选择的边。选择与同意相互独立。没有边时，发送方以 `SENDER_NOT_PAIRED` 终局结算。`embassy serve --inbound open` 是针对受支持原生入站发送方的显式退出选项。

投递时机因方向而异。通过路由与写前检查后，所有朝向 Claude 的正文都会立即写入 Claude 的原生邮箱，无论观测到 Claude 正繁忙还是空闲。`transport_written` 记录这次邮箱写入，并且就是朝向 Claude 的终局 `delivered` 边界；它不表示 Claude 已读取或消费正文。朝向 Codex 的普通正文则在任务忙碌时排队，并在任务空闲后启动轮次。仅在 Claude→Codex 方向，正文以精确 `STEER:` 开头的消息可以在 App Server 的下一个工具调用边界进入当前轮次；若该边界不可用，消息会回到普通队列。

每条被路由的消息在接收方看到时都位于 Embassy 生成的跨会话来源封装中，其中包含已验证的发送方别名、完整 `conv_` 令牌和面向该接收方的回复提示。来源封装是模型可见的结构性提示，并非密码学身份认证；消息正文始终应被视为不可信输入。

完整对话令牌只出现在初始发送方收到的命令结果，以及接收方那次临时的消息载荷中；它绝不会进入仪表盘、公开快照、账簿、回执或日志。

每条已结算的消息都会产生回执。`delivered` 表示观测到了该方向的终端提供方边界——朝向 Codex，意味着 App Server 接受了该轮次；朝向 Claude，意味着原生邮箱写入完成。两者都不意味着模型已读取或执行。`unconfirmed` 和 `ambiguous` 表示所需证据缺失；它们是终态，从不自动重试。完整语义详见[投递](docs/DELIVERY.zh-CN.md)。

## 核心术语

四个 Embassy 术语对应真实功能：

- **注册与配对**构成权限模型：Codex 任务通过显式注册发布，每个配对是一条显式的 Claude↔Codex 边——只有配对的两端可以交换消息，且多条边可以并存。没有边意味着 `SENDER_NOT_PAIRED`；一切都是显式的。
- **账簿**是投递记录：每条已结算消息的回执，以及一个仅包含元数据的仪表盘。
- **信袋**既是传输通道也是档案：有界的消息体，按有界策略保留，只属于你的操作系统账户 — 对其他用户封缄，对你敞开。
- **领事馆**是路线图：将同一模型通过仅限 attach 的 SSH 扩展到远程主机上的 Codex 任务——已完成设计，但在 v1 中有意禁用。

## 面向代理

Embassy 的操作者本身往往就是代理：`register-codex` 在 Codex 任务内部运行，而 Claude 端完全通过原生工具驱动。仓库附带 [`skills/embassy-peer/SKILL.md`](skills/embassy-peer/SKILL.md)——请将你的代理指向该技能，而非向它复述本 README。

该技能随 npm 包一同发布；将它安装到各代理发现技能的目录：

```bash
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.codex/skills/
cp -R "$(npm root -g)/agent-embassy/skills/embassy-peer" ~/.claude/skills/
```

之后即可在 Codex 任务中通过 `$embassy-peer` 调用；Claude Code 会将其作为用户技能自动发现。

## 命令一览

| 命令 | 执行者 | 用途 |
| --- | --- | --- |
| `serve` | 操作员 | 启动前台代理和仪表盘 |
| `health` / `status` | 操作员 | 检查存活状态并查看脱敏快照 |
| `refresh-dashboard` | 操作员 | 刷新提供方发现，并重新生成两个静态仪表盘文件 |
| `dashboard --live [--lang en\|zh-CN] [--port <n>]` | 操作员 | 启动带有限路由同意操作的实时仪表盘组件；需要 `embassy serve` 正在运行 |
| `delivery-status` | 任一提供方 | 使用 `embassy delivery-status --token dlv_<token>` 读取单条投递跟踪器 |
| `wait-delivery` | 任一提供方 | 等待该跟踪器结算，直至投递截止时间 |
| `untrack` | 任一提供方 | 关闭一个活跃的进度监视：`embassy untrack --conversation conv_<token>` |
| `register-codex` / `unregister-codex` | Codex 任务 | 通告或注销该任务；两者都需要 `--alias <codex-alias>`，而 `embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac` 会将注册转交给另一个任务 |
| `register-peer` / `unregister-peer` | shell harness | 注册或注销一条 `peer-*` 路由；注册只输出一次原始令牌，已认证调用使用 `--token-stdin`（也可选用稳定 shell 环境形式） |
| `await` | 已注册 shell 对等方 | 以有界 30 秒迭代长轮询 peer 邮箱；每条路由一个等待者、全局 16 个，且只在 stdout 刷新后确认回执 |
| `pair` / `unpair` | 同 UID 控制客户端 | 显式指定两端来添加或移除一条用户选择的跨提供方边：`embassy pair --from advisor@this-mac --to grok-main@this-mac` |
| `select-claude` / `unselect-claude` | 同 UID 控制客户端 | 使用 `--alias <name@host>` 或 `--session <uuid>` 选择或移除一条 Claude 路由；选择不会创建权限边 |
| `send-to-claude` | 已注册的 Codex 任务 | 向已配对的 Claude 会话发送一条有界消息：`--from <codex-alias> --to <claude-alias>`，正文从标准输入读取，可选 `--expects-reply` 与 `--track [--idle-minutes <n>]` |
| `send-to-codex` | Claude 会话 | 标志与正文输入方式相同，使用继承的原生回复标识 |
| `reply` | 对话令牌持有方 | 使用初始发送时返回或随入站来源提示收到的完整令牌继续一个活跃对话：`--conversation conv_<token> --alias <你的别名>`，正文从标准输入读取，可选 `--track [--idle-minutes <n>]`；调用方、对话参与关系和路由会重新检查 |

版本 2.0 只接受全新的私有状态。用旧安装启动前，请遵循
[仅重置状态操作手册](docs/CONFIGURATION.zh-CN.md#私有状态重置)。

`--track` 会为该对话开启一个进度监视；`--idle-minutes <n>` 设置有界活跃提醒的空闲间隔（1–1440，默认 5，未加 `--track` 时会被拒绝）。如果监视最终超时，Embassy 只在监视历史中记录该结算，不会发出运行时停滞告警。用 `untrack` 关闭监视，或在回复正文开头使用 `DONE:` 关闭。详见[投递](docs/DELIVERY.zh-CN.md)。

## 一分钟了解安全性

- **本地代理，稳定的 loopback 仪表盘。** `embassy serve` 仅监听私有 Unix 域套接字，不发起任何提供商 API 调用。可选启用的 `embassy dashboard --live` 组件是一个独立进程，也是 Embassy 能创建的唯一监听器；它精确绑定 `127.0.0.1`，默认使用稳定端口 `41961`（也可为本次启动传入 `--port <n>`）。它是在可信单用户机器上有意不设身份认证的本地 HTTP；Host、Origin 与哨兵检查约束浏览器来源的请求，但不认证本地进程或 OS 用户。
- **同 UID 隔离，而非身份认证。** 调用者身份继承自本地进程环境。路由所有权和逐操作构件检查能减少误操作，但不是对已以你的 OS 用户身份运行的代码的防御。
- **兼容性在离线阶段测试；运行时尽力而为。** 发布版自有支持矩阵记录精确已测构件、协议、能力、停止保真度、限制与测试日期。运行时从不导入该矩阵，也绝不会把版本事实变成权限。它验证精确自有边界与协议事实，尝试当前操作，并以提供方局部健康度和安全代码报告结果，且绝不重放不确定写入。
- **来源标记是提示，不是签名。** Embassy 在提供方写入边界生成跨会话来源封装，让接收模型能够区分代理路由消息及其已验证发送方别名；这不是密码学证明，也不会把不可信正文变成可信指令。
- **原生权限保持原生。** Embassy 不发送任何 Codex 审批或沙盒覆盖，也不应答任何审批请求。`crossSessionInbound` 仍是 Claude 自身的控制机制；Embassy 无法覆盖它。
- **消息体和投递状态有界保存，属于你。** 消息体及其不透明投递令牌／状态以有界保留策略持久化在 broker 的私有 mode-0600 v4 状态中；排队或已保留但尚未武装的邮件可在 broker 重启后恢复一次，已武装或已被提供方接受的工作绝不重放。投递令牌绝不会进入公开快照、普通日志、提供方回执或任何仪表盘。原始提供方帧仍仅存于内存。静态仪表盘文件保持仅元数据；实时仪表盘展示保留的正文。

完整的安全边界和漏洞报告流程请参见 [SECURITY.md](SECURITY.md)。

## Embassy 不是什么

- **不是编排器。** 它不生成代理，也不管理它们的工作。朝向 Codex 的普通消息会在任务空闲时逐条启动轮次；朝向 Claude 的消息无需等待空闲，直接进入 Claude 的邮箱。
- **不是托管服务。** 面向个人的、同机同账户软件。
- **不是权限绕过——但它是一条新路径。** 两个代理都不会获得它原本没有的工具，Embassy 也不授予、放宽或应答任何权限。然而，它确实连接了两个此前无法交换文本的产品。这条路径就是产品本身；请以对待任何新输入通道应有的审慎来看待它。
- **不是官方产品。** 与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 文档索引

| 文档 | 涵盖内容 |
| --- | --- |
| [架构](docs/GATEWAY-ARCHITECTURE.md) | 完整设计：拓扑、适配器、控制平面、威胁模型，以及基于配对同意的入站模型 |
| [投递](docs/DELIVERY.zh-CN.md) | 投递语义、令牌、结算状态与重试规则 |
| [配置](docs/CONFIGURATION.zh-CN.md) | 环境变量、提供方契约与寻址规则 |
| [仪表盘](docs/DASHBOARD.zh-CN.md) | 静态与实时仪表盘设置、安全模型与变更操作 |
| [安全策略](SECURITY.md) | 如何报告漏洞，以及详细的安全边界 |
| [贡献指南](CONTRIBUTING.md) | 变更的归属位置，以及如何运行确定性测试套件 |
| [变更日志](CHANGELOG.md) | 每个版本包含的内容 |
| [代理技能](skills/embassy-peer/SKILL.md) | 代理操作 Embassy 所遵循的工作流 |

## 许可证

[MIT](LICENSE)
