# 配置与兼容性

Embassy 通过 `embassy serve` 启动时读取的环境变量进行配置。本文档汇集了所有变量、与 Claude Code 和 Codex App Server 的兼容性约定、托管二进制文件解析规则，以及寻址模型。没有配置文件；所有值均为环境变量或 CLI 标志。

---

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`，当 `XDG_STATE_HOME` 未设置时为 `$HOME/.local/state/agent-embassy` | 私有状态、控制套接字和仪表盘；覆盖值必须为绝对路径，且不会迁移固定的主机级租约 |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`，解析到固定版本目标 | Claude Code 启动器的绝对路径；不搜索 `PATH` |
| `EMBASSY_STEERING_ENABLED` | `1` | 全局 `STEER:` 停用开关；精确设为 `0` 后，所有正文都按普通排队消息处理 |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude 发送方通知策略：`merged` 保留停滞通知并把终局诊断合并到原生状态；`verbose` 同时发送两者；`quiet` 不发送任何网关用户帧通知 |

## 高级边界

以下变量保留保守的默认值：

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

## Claude Code 自身的设置：`crossSessionInbound`

`crossSessionInbound` 是 Claude Code 的原生跨会话消息设置：它决定一个 Claude 会话接受、挂起还是拒绝来自其他会话的消息。Embassy 需要在你选择作为 Codex→Claude 目的地的会话上启用此设置，且无法覆盖该决定。请在 Claude Code 中配置它，而不是在 Embassy 中。

## 兼容性约定

Embassy 目前使用两个版本固定的接口，这些接口并未被记录为稳定的第三方 API：

- Claude Code 2.1.226，对等协议 1；在补丁过渡期间接受仍在运行的兼容 2.1.224 和 2.1.225 会话
- Codex App Server 0.147.0

每条记录、套接字和响应结构在使用前都会被验证。未知的提供方版本会以关闭状态失败，而非被猜测为兼容。请预期在任一提供方更改这些内部接口后，Embassy 适配器将需要更新。

托管的 Codex 安装通过精确路径和版本解析；`PATH` 上其他位置的 `codex` 不会被使用或修改。Claude 从 `EMBASSY_CLAUDE_BIN` 或官方的用户级启动器解析，从不搜索 `PATH`。

## 寻址

Claude 会话通过其当前的 `name@host` 或用户提供的原生会话 UUID 寻址。UUID 是稳定的逻辑标识；当前名称是实时查找别名。重命名后，旧名称立即停止解析，而已选择的 UUID 绑定路由在新名称下继续有效。

名称、旧名称、PID、注册表路径、进程生成号和套接字生成号绝不会成为替代身份键。当两个在线会话共享同一当前名称时，Embassy 拒绝猜测。

Codex 路由使用显式的 `codex-*` 别名和任务继承的线程标识。私有线程 ID 从不被接受为命令行参数，也从不被打印。
