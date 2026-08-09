# 配置与兼容性

Embassy 通过 `embassy serve` 启动时读取的环境变量进行配置。本文档汇集了所有变量、与 Claude Code 和 Codex App Server 的兼容性约定、托管二进制文件解析规则，以及寻址模型。没有配置文件；所有值均为环境变量或 CLI 标志。

---

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`，当 `XDG_STATE_HOME` 未设置时为 `$HOME/.local/state/agent-embassy` | 私有状态、控制套接字和仪表盘；覆盖值必须为绝对路径，且不会迁移固定的主机级租约 |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`，解析到固定版本目标 | Claude Code 启动器的绝对路径；不搜索 `PATH` |
| `EMBASSY_COMPAT_POLICY` | `observed` | `observed` 仅在有界结构探测通过后接纳未知的同主版本提供方；`strict` 只接纳本版本的已认证版本清单 |
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

Embassy 使用两个未被记录为稳定第三方 API 的提供方接口。本版本的已认证清单为 Claude Code 2.1.224–2.1.226（对等协议 1）以及 Codex App Server 0.147.0。

兼容性分为三个明确层级：

- **已认证（certified）**：精确版本位于本版本的确定性测试清单中；
- **结构已验证（schema-attested）**：在默认 `observed` 策略下，未知的同主版本通过了有界启动探测；
- **不兼容（incompatible）**：必需探测失败、主版本变化，或 `strict` 策略拒绝了认证清单外的版本。

探测会验证启动器或托管安装、注册表/控制套接字结构、初始化与列表响应结构，以及协议常量；它不会发送消息或启动回合。结果按提供方版本缓存一次。运行时仍会严格验证每条记录、帧和响应。结构已验证的版本仍可能在结构不变的情况下改变语义；上游更新后若这一剩余风险很重要，请执行在线认证。

运行 `embassy compat-check` 执行不产生流量的有界探测。运行 `embassy compat-certify [--codex <alias>]` 增加本机线缆级证据：Embassy 创建一个短寿命、无标准输入的 Claude 打印会话，确认一条带标记的诊断帧已写入该精确且唯一发现的临时会话，随后关闭会话。直接的 `crossSessionInbound: accept` 写入不会产生 Claude 专用于审批流程的原生回执，因此线缆认证不声称获得了释放回执，也不声称模型已读取。所选空闲 Codex 任务只执行恢复与刷新，不启动回合。注册多个 Codex 路由时必须提供 `--codex`。仅当你明确希望用一个最小 Codex 模型回合（`reply OK`）取得更深证据时，才添加 `--with-turn`。认证失败会保留每个表面的安全代码并打印两个表面的结果：退出码 `7` 表示 Claude 失败，`8` 表示 Codex 失败，`9` 表示两者均失败；退出码 `5` 仅保留给真正不明确的控制传输结果。认证证据与提供方版本一同保留并显示在“诊断”中；它不会放宽运行时验证。

托管的 Codex 安装通过精确路径和版本解析；`PATH` 上其他位置的 `codex` 不会被使用或修改。Claude 从 `EMBASSY_CLAUDE_BIN` 或官方的用户级启动器解析，从不搜索 `PATH`。

### 跟进提供方更新

仓库不会安装后台任务。如果你选择自动检查，请单独监管 `embassy serve`，并使用两个由当前用户拥有的 LaunchAgent：

1. 更新触发任务：`ProgramArguments` 依次为 Embassy 二进制文件绝对路径、`compat-certify`、`--codex` 和一个精确的已注册别名；`WatchPaths` 包含 Claude 启动器与 Codex 应用包的绝对路径；
2. 每日兜底任务：`ProgramArguments` 为 Embassy 二进制文件绝对路径与 `compat-check`，并按需设置 `StartCalendarInterval`。

受监视任务的最小核心如下；加载前请把所有占位符替换为本机绝对路径或别名：

```xml
<key>ProgramArguments</key>
<array>
  <string>/ABSOLUTE/PATH/TO/embassy</string>
  <string>compat-certify</string>
  <string>--codex</string>
  <string>codex-main@this-mac</string>
</array>
<key>WatchPaths</key>
<array>
  <string>/ABSOLUTE/HOME/.local/bin/claude</string>
  <string>/Applications/Codex.app</string>
</array>
```

每日任务将 `WatchPaths` 替换为：

```xml
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
```

并在 `ProgramArguments` 中只使用 `compat-check`。这些命令会联系已经运行的本地代理，而不会启动它。因此，如果所选路由不存在或正忙，受监视认证会安全失败。该方案刻意省略 `--with-turn`，不会选择进入 Codex 模型调用深度。

## 寻址

Claude 会话通过其当前的 `name@host` 或用户提供的原生会话 UUID 寻址。UUID 是稳定的逻辑标识；当前名称是实时查找别名。重命名后，旧名称立即停止解析，而已选择的 UUID 绑定路由在新名称下继续有效。

名称、旧名称、PID、注册表路径、进程生成号和套接字生成号绝不会成为替代身份键。当两个在线会话共享同一当前名称时，Embassy 拒绝猜测。

Codex 路由使用显式的 `codex-*` 别名和任务继承的线程标识。私有线程 ID 从不被接受为命令行参数，也从不被打印。
