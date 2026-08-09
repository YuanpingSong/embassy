[English](README.md) · 简体中文

<p align="center">
  <img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/assets/social-preview.png" alt="Embassy — 一个本地网关，用于在 Claude Code 会话与 Codex 桌面任务之间实现双向消息传递" width="720">
</p>

# Embassy

**属于你的 AI 代理本地使馆。**

[![CI](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-43853d)](package.json)

你的 [Claude Code](https://code.claude.com) 会话和 [Codex](https://chatgpt.com/codex) 桌面任务彼此无法对话。当一方需要另一方的视角时，你只能在窗口之间手动搬运上下文。Embassy 是一个小型本地代理，让它们按名称互相发现并双向交换消息——无需插件、无需 API 密钥、无需云端中继。

```bash
npm install -g agent-embassy
embassy serve
```

或从源码构建：`git clone https://github.com/YuanpingSong/embassy && cd embassy && npm ci && npm run build && npm link`。

Embassy 专为单人、单一 macOS 账户以及你已信任以该用户身份运行的代理而设计。本项目是非官方的社区项目，与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 快速开始

**前置要求：** macOS、Node.js 20+、Claude Code 2.1.226（仍在运行的 2.1.224–2.1.225 会话保持可发现）、Codex 桌面及 App Server 0.147.0 正在运行。你选择作为目的地的 Claude 会话需要启用 [`crossSessionInbound`](docs/CONFIGURATION.zh-CN.md)——这是 Claude Code 自身的设置，在 Claude Code 中配置，而非在 Embassy 中。

### 1. 启动 Embassy

在与 Claude Code 和 Codex 相同的 OS 账户下运行前台代理：

```bash
embassy serve
```

你应看到 `"status":"ready"`。在另一个终端中：

```bash
embassy health
embassy status
```

`status` 列出 `availablePeers`——你可以选择的在线 Claude 会话。

### 2. 注册 Codex 任务

让你的 Codex 代理在其当前轮次中以 shell 步骤运行此命令——命令必须在任务内部运行，以便继承该任务的身份：

```bash
embassy register-codex --alias codex-reviewer@this-mac
```

你应看到 `"accepted":true`。`codex-` 前缀是 Claude 发现所必需的。之后若要注销该任务，运行 `unregister-codex`。

### 3. 选择 Claude 目的地

从 `availablePeers` 中选择一个名称：

```bash
embassy select-claude --alias advisor@this-mac
```

你应看到 `"accepted":true`。注册和选择共同构成配对——现在只有这个 Claude 会话和这个 Codex 任务可以通过 Embassy 交换消息。

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

### 5. 后续跟进

任一方都可以继续对话：

```bash
embassy reply \
  --conversation conv_<token> \
  --alias codex-reviewer@this-mac <<'MSG'
Please expand on the migration risk.
MSG
```

### 实时查看

`embassy dashboard --live` 在浏览器中打开一个五选项卡流式视图（总览、投递、路由、活动、诊断）。详见[仪表盘](docs/DASHBOARD.zh-CN.md)。

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

Embassy 将一个已注册的 Codex 任务以 `codex-*` 对等方身份发布到 Claude Code 的实时会话注册表中。兼容的 Claude 会话通过原生的 `ListAgents` 发现它，并通过 `SendMessage` 与之通信——无需插件、MCP 服务器或设置更改。

配对是一个 Claude 会话与一个 Codex 任务之间的单一显式权限边。注册使任务可见；选择指定可与之交换消息的 Claude 会话。没有边时，发送方以 `SENDER_NOT_PAIRED` 终局结算。`embassy serve --inbound open` 是显式的退出选项，可恢复任意会话入站。v1 目前同时保持一个已注册任务和一个配对；并发配对是下一个里程碑。

消息在 Codex 任务忙碌时排队，并在任务空闲后启动普通轮次。仅在 Claude→Codex 方向，正文以精确 `STEER:` 开头的消息可以在 App Server 的下一个工具调用边界进入当前轮次；若该边界不可用，消息会回到普通队列。

每条已结算的消息都会产生回执。`delivered` 表示观测到了终端提供方证据——朝向 Codex，意味着 App Server 接受了该轮次；朝向 Claude，意味着消息已释放到会话的原生队列。两者都不意味着模型已读取或执行。`unconfirmed` 和 `ambiguous` 表示证据缺失；它们是终态，从不自动重试。完整语义详见[投递](docs/DELIVERY.zh-CN.md)。

## 核心术语

四个 Embassy 术语对应真实功能：

- **注册与选择**是同一份权限边的两半：Codex 任务通过显式注册发布，选择一个 Claude 会话则构成配对——唯一可以交换消息的组合。没有边意味着 `SENDER_NOT_PAIRED`；一切都是显式的。
- **账簿**是投递记录：每条已结算消息的回执，以及一个仅包含元数据的仪表盘。
- **信袋**是传输通道：有界的消息体，在 Embassy 内部是临时的，从不被持久化。
- **领事馆**是路线图：将同一模型通过仅限 attach 的 SSH 扩展到远程主机上的 Codex 任务——已完成设计，但在 v1 中有意禁用。

## 面向代理

Embassy 的操作者本身往往就是代理：`register-codex` 在 Codex 任务内部运行，而 Claude 端完全通过原生工具驱动。仓库附带 [`skills/embassy-peer/SKILL.md`](skills/embassy-peer/SKILL.md)——请将你的代理指向该技能，而非向它复述本 README。

## 命令一览

| 命令 | 执行者 | 用途 |
| --- | --- | --- |
| `serve` | 操作员 | 启动前台代理和仪表盘 |
| `health` / `status` | 操作员 | 检查存活状态并查看脱敏快照 |
| `refresh-dashboard` | 操作员 | 重新生成两个静态仪表盘文件 |
| `dashboard --live [--lang en\|zh-CN]` | 操作员 | 启动带有限路由同意操作的实时仪表盘组件；需要 `embassy serve` 正在运行 |
| `delivery-status` | 任一提供方 | 通过 `dlv_` 令牌读取单条投递跟踪器 |
| `wait-delivery` | 任一提供方 | 等待该跟踪器结算，直至投递截止时间 |
| `register-codex` / `unregister-codex` | Codex 任务 | 通告或注销该任务；`register-codex --succeeds <current-alias>` 将注册转交给另一个任务 |
| `select-claude` / `unselect-claude` | 操作员 | 选择或取消选择已发现的 Claude 目的地 |
| `send-to-claude` | 已注册的 Codex 任务 | 向已选择的 Claude 会话发送一条有界消息 |
| `send-to-codex` | Claude 会话 | 使用继承的原生回复标识发送一条有界消息 |
| `reply` | 任一提供方 | 通过公开令牌继续一个活跃对话 |

## 一分钟了解安全性

- **仅限本地套接字。** `embassy serve` 仅监听私有 Unix 域套接字，不发起任何提供商 API 调用。可选启用的 `embassy dashboard --live` 组件是一个独立进程，也是 Embassy 能创建的唯一监听器，绑定到 `127.0.0.1` 上的临时端口。
- **同 UID 隔离，而非身份认证。** 调用者身份继承自本地进程环境。路由所有权和生成号检查能减少误操作，但不是对已以你的 OS 用户身份运行的代码的防御。
- **原生权限保持原生。** Embassy 不发送任何 Codex 审批或沙盒覆盖，也不应答任何审批请求。`crossSessionInbound` 仍是 Claude 自身的控制机制；Embassy 无法覆盖它。
- **消息体从不持久化。** 消息体、提示词、回复和原始提供方帧仅存在于内存中。仅含元数据的仪表盘文件为 mode 0600，不含 JavaScript。

完整的安全边界和漏洞报告流程请参见 [SECURITY.md](SECURITY.md)。

## Embassy 不是什么

- **不是编排器。** 它不生成代理，也不管理它们的工作。它为每条路由消息启动一个轮次，并在任务空闲时排空队列。
- **不是托管服务。** 面向个人的、同机同账户软件。
- **不是权限绕过——但它是一条新路径。** 两个代理都不会获得它原本没有的工具，Embassy 也不授予、放宽或应答任何权限。然而，它确实连接了两个此前无法交换文本的产品。这条路径就是产品本身；请以对待任何新输入通道应有的审慎来看待它。
- **不是官方产品。** 与 Anthropic 或 OpenAI 没有任何关联或背书关系。

## 文档索引

| 文档 | 涵盖内容 |
| --- | --- |
| [架构](docs/GATEWAY-ARCHITECTURE.md) | 完整设计：拓扑、适配器、控制平面、威胁模型、分级授权阶梯 |
| [投递](docs/DELIVERY.zh-CN.md) | 投递语义、令牌、结算状态与重试规则 |
| [配置](docs/CONFIGURATION.zh-CN.md) | 环境变量、兼容性约定与寻址规则 |
| [仪表盘](docs/DASHBOARD.zh-CN.md) | 静态与实时仪表盘设置、安全模型与变更操作 |
| [迁移](docs/MIGRATION.zh-CN.md) | 从原型网关迁移 |
| [安全策略](SECURITY.md) | 如何报告漏洞，以及详细的安全边界 |
| [贡献指南](CONTRIBUTING.md) | 变更的归属位置，以及如何运行确定性测试套件 |
| [变更日志](CHANGELOG.md) | 每个版本包含的内容 |
| [代理技能](skills/embassy-peer/SKILL.md) | 代理操作 Embassy 所遵循的工作流 |

## 许可证

[MIT](LICENSE)
