<h1><img src="https://raw.githubusercontent.com/YuanpingSong/embassy/main/site/assets/mark.svg" alt="" width="36" height="36" align="absmiddle"> Embassy</h1>

Embassy 能让运行中的 Claude Code 会话和 Codex CLI agent 直接按名称互相发消息。无论是在单台 Mac 上，还是跨多台通过 SSH 互联的个人 Mac，都没问题。中转服务（broker）会通过接收方 agent 的原生接口直接将其唤醒，无需任何轮询。无论 Claude→Claude、Claude→Codex、Codex→Claude 还是 Codex→Codex，全都遵循同一套命令和回执（receipt）机制。

<p align="center">
  <a href="https://yuanpingsong.github.io/embassy/">官网</a> ·
  <a href="https://www.npmjs.com/package/agent-embassy">npm</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/YuanpingSong/embassy/releases/latest">最新版本</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-embassy"><img src="https://img.shields.io/npm/v/agent-embassy" alt="npm version"></a>
  <a href="https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml"><img src="https://github.com/YuanpingSong/embassy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/agent-embassy" alt="Node.js 22+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/agent-embassy" alt="MIT license"></a>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-1a1a1e" alt="English"></a>
  <a href="README_CN.md"><img src="https://img.shields.io/badge/简体中文-1a1a1e" alt="简体中文"></a>
</p>

https://github.com/user-attachments/assets/1487b1e3-4579-49cd-8cdb-04772607e71f

*40 秒实录演示：Claude Code 会话向 Codex agent 请求代码 review，并以原生方式收到回复。如果视频无法直接播放，请[下载视频文件](https://github.com/YuanpingSong/embassy/releases/latest/download/embassy-demo.mp4)。*


如果 Embassy 对你有帮助，不妨点个 Star 支持一下：GitHub 会在发布新版本时通知关注者，所有功能改动也会在 release notes 中详细说明。

## 它是什么

Embassy 的核心设计非常克制精简：包含一个私有账本（ledger）、一个投递协调器，以及三个写入适配器（Claude socket、Codex App Server 操作和 SSH 转发）。别名（alias）仅用作查找名称，底层由不透明的端点（endpoint）ID 作为真正的路由标识，因此改名或替换端点绝不会在暗中把排队的消息错投到别处。

Codex agent 会直接从正在运行的 Codex daemon 中自动发现（抓取最近 20 个未归档的顶层 agent；子 agent 永远不会被当作端点）。Claude 会话则会在发送消息时记录其确切的原生身份。系统不会安装任何常驻 helper 或广播进程。每条消息都会返回回执；回执能证明消息已投递，但不能作为对方理解了内容的凭证。

## 环境要求

- macOS 以及 Node.js 22 或更高版本。
- 已为你需要用到的 Claude 会话安装好 Claude Code。
- 若要通过 Codex 接收消息，需要安装其官方受管独立版本，并且其 App Server daemon 已在当前 macOS 登录用户下运行。Embassy 不会帮你安装、启动或更新该 daemon；仅在 PATH 里放一个 `codex` 可执行文件是无法正常工作的。
- 启用跨机器联邦（federation）时，各机器间需配置好基于密钥的非交互式（key-based, non-interactive）SSH 互通。

## 快速开始

1. 安装并启动中转服务：

   ```sh
   npm install -g agent-embassy
   embassy service install
   embassy health
   ```

2. 为你的 agent 安装 Embassy skill。执行 `embassy skills install` 会为两个 provider 在 `~/.claude/skills` 和 `~/.codex/skills` 下安装或更新 `embassy-peer`（仅此一个 skill）；Claude Code 中显示为 `/embassy-peer`，Codex 中显示为 `$embassy-peer`：

   ```sh
   embassy skills install
   ```

3. 查看当前在线的 agent：

   ```sh
   embassy tui
   ```

4. 在 Claude Code 或 Codex 会话中给其它 agent 发消息。发送方身份会从当前调用会话中自动推导；`send` 必须指定 `--to` 或 `--conversation` 其中的一个参数，无需传 `--from`：

   ```sh
   printf '%s\n' 'Please review the change and reply' |
     embassy send --to codex-reviewer@studio
   ```

5. 按照收到消息提示里的完整命令进行回复。普通的 Codex 最终输出不会自动转发，另外 `conv_example` 只是示例，不是可用的引用：

   ```sh
   printf '%s\n' 'Review complete.' |
     embassy send --conversation conv_example
   ```

`@studio` 是 `nodes.json` 中配置的主机名；首次单机启动时，Embassy 会根据短主机名自动生成这个文件。详见[配置文档](docs/CONFIGURATION.md#state-and-node-inventory)。

## 现状

今天已经能用、并且每次改动都会测试的：

- 在一台 Mac 上，Claude→Codex、Codex→Claude 以及同一 provider 之间按名称互发消息。
- Codex agent 自动发现；Claude 会话在发送消息时被记录。
- 跨你自己的多台 Mac、通过 SSH 互发消息。
- 每个版本都会在两台真实 Mac 上实机演练：自动发现、通过 SSH 唤醒休眠 agent、转向、退役、中转服务重启。自动化测试套件在 macOS 和 Ubuntu 上运行。

Embassy 刻意不承诺的：

- `health` 和 `check` 只说明中转服务本身正常。它们不是 provider 就绪的证明：并不能表明任何一个 agent 能够作答。
- 回执证明消息已经送达，不证明 agent 读过或理解了它。
- 发给忙碌中的 Codex agent 的消息会等它空闲再投递。如果恰好在那一瞬间有别的东西开启了新一轮对话，Embassy 无法察觉；回执仍然表示消息已被接受。
- 机器之间，你的 SSH 登录就是全部的信任边界。

## 工作原理简介

**发现机制。** `embassy tui` 和 `embassy status` 可以查看所有端点及其运行状态、队列深度以及各本地路由最近一次原生操作。`status --json` 会输出单行闭合 JSON：`{"ok":true,"command":"status","result":{...}}`，路由数据位于 `.result.routes`。`embassy refresh` 会执行经授权的实时发现流程。对于没有原生 daemon 集成的 agent 运行环境（harness），可以用 `embassy register-codex` 作为兜底注册方式。

**会话管理。** 接收提示（reply hint）中包含一个绑定身份的会话引用（conversation reference）。会话引用与身份严格绑定，并非别名；只要账本保留行与两侧确切端点依然有效，会话引用就能在中转服务重启后继续可用。一旦发生端点退役、替换、过期、淘汰或状态重置，会话引用便会失效。

**消息投递。** 一次原生唤醒可以携带一批有大小上限的消息。持久化状态流转包括：queued、reserved、armed、accepted 和 terminal；对于状态不确定的 armed 或 accepted 写入，绝不会盲目重试。从 Claude 发往 Codex 且以 `STEER:` 精确开头的消息，会在 Codex 当前处于 accepted 状态的操作遇到下一个安全的 tool-call 边界时触发转向（steer），绝不会打断正在进行的生成；该特性的紧急停用开关为 `EMBASSY_STEERING_ENABLED=0`。你可以通过 `embassy delivery-status --token dlv_example` 查看单次投递状态，或用 `embassy wait-delivery --token dlv_example` 阻塞等待其完成。详细规范见 [Delivery](docs/DELIVERY.md)。

**跨 Mac 互联。** 在 `nodes.json` 中配置对端节点列表；中转服务会通过 `/usr/bin/ssh <node> embassy peer-stdio` 连接每个节点。同一用户下的普通 SSH 登录即为信任边界。`status` 本身不产生任何 provider 或网络 I/O：它只展示最近一次观测到的目录数据，如果后续刷新失败则保留原记录并将该节点标记为 `PEER_TUNNEL_UNAVAILABLE`。按名称或确切 ID 发送消息时，依然会直接向拥有该端点的那台机器确认；TUI 中每个主机各占一个独立面板。配置方法见[配置文档](docs/CONFIGURATION.md#ssh-federation)。

**中转服务管理。** `embassy service install` 会注册一个单用户 launchd agent，并采用仅崩溃时保活（crash-only keepalive）策略：只有检测到 `SIGABRT` 崩溃时才会重新拉起，正常退出、`SIGTERM` 或 `kill -9` 则保持停止状态。因此建议通过 `embassy service status` 检查状态，并在必要时显式重新安装。你也可以使用 `embassy serve` 在前台运行。`embassy check` 仅用于验证中转服务自身回环。可以通过 `embassy retire --alias` 或 `--endpoint` 退役某个端点。命令参考：[运维操作](docs/OPERATIONS.md)。

## 安全机制

- 仅使用单个私有 Unix socket，并在权限为 mode-0700 的目录下以 mode-0600 存放状态文件；不开启任何 TCP 或 HTTP 监听端口。
- 原生 task/session ID、socket 路径、凭据、对话记录及 provider 原始帧绝不会出现在公开输出中。
- 准备工作完成后，每一次原生写入都会针对当前确切端点进行鉴权；在执行写入尝试期间，绝不会暗中重新解析名称。
- SSH 均直接调用执行，不经过本地 shell，以 batch mode 运行并禁用所有转发。
- Embassy 绝不会修改 Codex 的 approval 或 sandbox 策略，也绝不会代为响应审批请求。

详情参考：[Security](SECURITY.md) · [Configuration](docs/CONFIGURATION.md) · [Operations](docs/OPERATIONS.md) · [Delivery](docs/DELIVERY.md) · [Architecture](docs/GATEWAY-ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## 开发指南

```sh
npm ci
TMPDIR=/tmp npm run check
```

日常测试均在测试专属目录中使用模拟 provider 运行；任何常规测试都不会连接真实 provider 或 SSH 主机。

## 开源协议

MIT
