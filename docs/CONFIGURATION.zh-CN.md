# 配置与兼容性

Embassy 通过各命令启动时读取的环境变量进行配置。本文档汇集了所有变量、与 Claude Code 和 Codex App Server 的兼容性约定、托管二进制文件解析规则，以及寻址模型。没有配置文件；所有值均为环境变量或 CLI 标志。

---

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`，当 `XDG_STATE_HOME` 未设置时为 `$HOME/.local/state/agent-embassy` | 私有状态、控制套接字和仪表盘；覆盖值必须为绝对路径，且不会迁移固定的主机级租约 |
| `EMBASSY_CLAUDE_BIN` | `$HOME/.local/bin/claude`，解析到固定版本目标 | Claude Code 启动器的绝对路径；不搜索 `PATH` |
| `EMBASSY_STEERING_ENABLED` | `1` | 全局 Claude→Codex `STEER:` 停用开关；精确设为 `0` 后，所有 Claude→Codex 正文都按朝向 Codex 的普通排队消息处理；朝向 Claude 的邮箱写入时机不受影响 |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude 发送方通知策略：`merged` 保留停滞通知并把终局诊断合并到原生状态；`verbose` 同时发送两者；`quiet` 不发送任何网关用户帧通知 |
| `EMBASSY_TRACKING_ENABLED` | `1` | 全局进度监视停用开关；精确设为 `0` 后，`--track`、`--idle-minutes`、`untrack` 以及 `TRACK:`/`DONE:` 正文前缀都会被拒绝。取值只能是 `1` 或 `0`，其他值均为配置错误 |
| `EMBASSY_LOCALE` | `en` | CLI 输出语言，精确取值 `en` 或 `zh-CN`。`--lang` 标志会覆盖当次调用；未设置或为空表示 `en`，其他任何取值都是参数错误 |
| `EMBASSY_HOSTS` | `this-mac` | 以逗号分隔的 1 到 32 个唯一小写主机别名。**v1 启动器只接受单个精确值 `this-mac`**：任何其他列表——包括包含 `this-mac` 的更长列表——都会让 `embassy serve` 以 `GATEWAY_REMOTE_PROVIDER_DISABLED` 关闭失败。该变量是为推迟的远程领事馆功能预留的，目前没有可用的设置 |

当前台实时仪表盘组件运行时，可直接通过 `http://127.0.0.1:41961/` 访问。端口是单次命令的 CLI 选择，而不是环境设置；如需另一个稳定端口，请向 `embassy dashboard --live` 传入 `--port <n>`，其中整数范围为 1024 到 65535。当前台进程运行时，该 URL 最多支持四个并发实时视图（可分布在窗口、标签页或浏览器中）；在其中一个关闭前，第五条流会被拒绝。端口冲突会以 `LIVE_DASHBOARD_PORT_IN_USE` 失败并提示使用 `--port`；Embassy 绝不会回退到临时或其他端口。

## 高级边界

以下变量保留保守的默认值：

| 变量 | 默认值 |
| --- | ---: |
| `EMBASSY_MAX_ROUTES` | `128` |
| `EMBASSY_MAX_PAIRS` | `128` |
| `EMBASSY_MAX_WATCHES` | `32` |
| `EMBASSY_EVENT_CAPACITY` / `EMBASSY_EVENT_TTL_MS` | `500` / `86400000` |
| `EMBASSY_DEDUPE_CAPACITY` / `EMBASSY_DEDUPE_TTL_MS` | `2000` / `300000` |
| `EMBASSY_MAX_QUEUE_MESSAGES` / `EMBASSY_MAX_QUEUE_PER_ROUTE` | `100` / `20` |
| `EMBASSY_MAX_IN_FLIGHT` | `16` |
| `EMBASSY_MAX_QUEUE_BYTES` / `EMBASSY_MAX_MESSAGE_BYTES` | `1048576` / `16384` |
| `EMBASSY_MESSAGE_DEADLINE_MS` | `14400000` |
| `EMBASSY_RATE_LIMIT` / `EMBASSY_RATE_WINDOW_MS` | `30` / `60000` |

`EMBASSY_MAX_PAIRS` 就是 README 中"默认上限 128 个配对"背后的那个变量，取值范围为 1 到 256。`EMBASSY_MAX_WATCHES` 限制并发进度监视数量，硬上限为 256。`EMBASSY_MAX_ROUTES` 接受 2 到 256。本表中的每个值都在启动时校验；超出范围或非整数的设置会以 `INVALID_GATEWAY_CONFIGURATION` 关闭失败，而不是被截断到边界。

停滞通知本身不可单独配置。它在 `min(floor(EMBASSY_MESSAGE_DEADLINE_MS / 2), 120000)` 毫秒时触发，因此在默认的四小时截止时间下，待投递消息会在两分钟时被报告，而不是两小时。

初始发送方从 CLI 结果获得完整 `conv_` 令牌，接收方则从入站消息的来源封装和回复提示中获得同一个令牌。令牌是内存中的参与方范围定位符，不是权限凭据：每次 `reply` 都会重新检查调用方身份、参与关系和实时路由。代理重启后令牌不再存在；路由失效或身份转交后，也不得重试或重构旧令牌。

公开发布的启动器仅接受主机 `this-mac`；远程连接器仍是未来功能。因此 `register-codex` 提供可选的 `--host <id>`，但代理只会接纳 `this-mac`，而且别名必须以 `@<id>` 结尾才能匹配。`--host` 与 `--succeeds` 互斥，后者始终继承被接替别名的主机。

## Claude Code 自身的设置：`crossSessionInbound`

`crossSessionInbound` 是 Claude Code 的原生跨会话消息设置：它决定一个 Claude 会话接受、挂起还是拒绝来自其他会话的消息。Embassy 需要在你选择作为 Codex→Claude 目的地的会话上启用此设置，且无法覆盖该决定。请在 Claude Code 中配置它，而不是在 Embassy 中。

这是你唯一必须主动开启的前置条件，也是最常见的首次运行故障——因为它**失败得很晚**。快速开始的第 3 步（`select-claude`）无论该设置是否启用都会打印 `"accepted":true`：选择只创建 Embassy 自己的权限边，从不查询 Claude 的原生入站策略。拒绝要到第 4 步、消息抵达 Claude 端时才出现。如果注册与选择都成功，但你的第一条 `send-to-claude` 没有送达，请先检查目的地会话上的 `crossSessionInbound`，再去怀疑路由。

## 兼容性约定

Embassy 使用两个未被记录为稳定第三方 API 的提供方接口。兼容性检查是自动且精确固定版本的机制，不是操作员工作流。本版本只接纳：

- Claude Code 2.1.227 启动器/运行时与对等协议 1；
- 已经运行、明确版本为 2.1.224、2.1.225、2.1.226 或 2.1.227，且使用对等协议 1 的已审查 Claude 对等会话；以及
- Codex App Server 0.147.0。

未知的提供方版本或对等协议、必需结构验证失败，或未通过新一轮验证的端点代际，都会使受影响的表面关闭。代理在提供方启动过程中自行执行有界的只读兼容性验证：检查配置的启动器或托管安装、精确版本、注册表/控制套接字结构、初始化与列表响应结构，以及协议常量。这些检查不会路由用户消息，也不会启动模型回合。运行时仍会严格解析每条记录、帧和响应。

每个替代 Codex App Server 端点代际都从仅监控状态开始。Embassy 会在该代际上重新执行初始化和 `thread/loaded/list` 检查，只有精确的私有任务身份恰好出现一次时才重新锚定保留路由。在控制器激活这个精确代际之前，写入始终保持封锁。版本或结构不匹配、任务缺失、任务重复或转换不干净，都会让路由保持陈旧且禁止写入，而不是改投其他任务。

托管的 Codex 安装通过精确路径和版本解析；`PATH` 上其他位置的 `codex` 不会被使用或修改。Claude 从 `EMBASSY_CLAUDE_BIN` 或官方的用户级启动器解析，从不搜索 `PATH`。提供方升级后，必须等待明确审查并固定新版本的 Embassy 发布版。

## 寻址

Claude 会话通过其当前的 `name@host` 或用户提供的原生会话 UUID 寻址。UUID 是稳定的逻辑标识；当前名称是实时查找别名。重命名后，旧名称立即停止解析，而已选择的 UUID 绑定路由在新名称下继续有效。重命名会在该会话的下一次状态切换（通常是下一个轮次边界）时才对外可见——因为 Claude Code 在状态切换时整体重写会话注册表记录，而非在重命名的瞬间；Embassy 反映的是注册表记录，而非重命名操作本身。

名称、旧名称、PID、注册表路径、进程生成号和套接字生成号绝不会成为替代身份键。当两个在线会话共享同一当前名称时，Embassy 拒绝猜测。

Codex 路由使用显式的 `codex-*` 别名和任务继承的线程标识。私有线程 ID 从不被接受为命令行参数，也从不被打印。兼容的托管 App Server 端点代际变更与代理重启都能自动重新锚定精确的已加载任务；正常重启不需要手动重新注册。如果启动时重新激活无法恰好一次找到该任务，路由会以 `REOBSERVATION_REQUIRED` 保持陈旧。该任务恢复可观察后，请从精确 Codex 任务内使用同一别名再次运行 `embassy register-codex --alias <同一别名>`，且不要先注销。切勿提供或重构线程 ID。如果该任务已不存在，实时仪表盘只有在代理证明该注册陈旧且所属端点代际已失效后，才能移除该保留注册。
