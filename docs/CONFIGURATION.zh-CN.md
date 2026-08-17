# 配置与提供方契约

Embassy 通过各命令启动时读取的环境变量进行配置。本文档汇集所有变量、提供方传输契约、提供方运行时规则与寻址模型。没有配置文件；所有值均为环境变量或 CLI 标志。

---

## 常用配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EMBASSY_STATE_DIR` | `$XDG_STATE_HOME/agent-embassy`，当 `XDG_STATE_HOME` 未设置时为 `$HOME/.local/state/agent-embassy` | 私有状态、控制套接字和仪表盘；覆盖值必须为绝对路径，且不会迁移固定的主机级租约 |
| `DSH_HOME` | `$HOME/.dsh` | DeepSeek Harness checkout 根目录；当自有目录与 `package.json` 存在时，Embassy 会在首次投递时惰性运行 `pnpm --dir <home> run demo:acp` |
| `EMBASSY_STEERING_ENABLED` | `1` | 全局 Claude→Codex `STEER:` 停用开关；精确设为 `0` 后，所有 Claude→Codex 正文都按朝向 Codex 的普通排队消息处理；朝向 Claude 的邮箱写入时机不受影响 |
| `EMBASSY_DELIVERY_NOTICES` | `merged` | Claude 发送方通知策略：`merged` 保留停滞通知并把终局诊断合并到原生状态；`verbose` 同时发送两者；`quiet` 不发送任何网关用户帧通知 |
| `EMBASSY_TRACKING_ENABLED` | `1` | 全局进度监视停用开关；精确设为 `0` 后，`--track`、`--idle-minutes` 与 `TRACK:` 开启请求会被拒绝。活跃监视只存在于内存中，并随代理进程结束；重启后绝不恢复。没有活跃监视时，`DONE:` 不产生作用；`untrack` 不会因开关而被特别拒绝，而是返回 `NOT_FOUND`。取值只能是 `1` 或 `0`，其他值均为配置错误 |
| `EMBASSY_LOCALE` | `en` | CLI 输出语言，精确取值 `en` 或 `zh-CN`。`--lang` 标志会覆盖当次调用；未设置或为空表示 `en`，其他任何取值都是参数错误 |
| `EMBASSY_HOSTS` | `this-mac` | 以逗号分隔的 1 到 32 个唯一小写主机别名。**v1 启动器只接受单个精确值 `this-mac`**：任何其他列表——包括包含 `this-mac` 的更长列表——都会让 `embassy serve` 以 `GATEWAY_REMOTE_PROVIDER_DISABLED` 关闭失败。该变量是为推迟的远程领事馆功能预留的，目前没有可用的设置 |

### 离线状态升级

架构 3 是代理唯一的原生状态格式。使用本版本启动架构-2 状态之前，
请先停止代理并运行：

```bash
embassy convert-state-v2-to-v3
```

该命令使用与 `serve` 相同的配置来解析状态目录；它不接受其他状态路径
参数，也不会启动提供方、辅助进程、发现、监听器或控制套接字。它先验证
逐字节一致的 v2 备份，再原子安装并回读 v3 状态。正常输出只包含成功结果
与备份文件的基本名称。转换失败时请使用精确的规范化安全代码；提交结果
未知时不要重试，也不要手工编辑状态文件。

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

初始发送方从 CLI 结果获得完整 `conv_` 令牌，接收方则从入站消息的来源封装和回复提示中获得同一个令牌。令牌是内存中的参与方范围定位符，不是权限凭据：每次 `reply` 都会重新检查调用方身份、参与关系和实时路由。代理重启后令牌不再存在；路由失效或身份替换后，也不得重试或重构旧令牌。

公开发布的启动器仅接受主机 `this-mac`；远程连接器仍是未来功能。因此 `register-codex` 提供可选的 `--host <id>`，但代理只会接纳 `this-mac`，而且别名必须以 `@<id>` 结尾才能匹配。`--host` 与 `--succeeds` 互斥，后者始终继承被接替别名的主机。

## Claude Code 自身的设置：`crossSessionInbound`

`crossSessionInbound` 是 Claude Code 的原生跨会话消息设置：它决定一个 Claude 会话接受、挂起还是拒绝来自其他会话的消息。Embassy 需要在你选择作为 Codex→Claude 目的地的会话上启用此设置，且无法覆盖该决定。请在 Claude Code 中配置它，而不是在 Embassy 中。

这是你唯一必须主动开启的前置条件，也是最常见的首次运行故障——因为它**失败得很晚**。快速开始的第 3 步（`select-claude`）无论该设置是否启用都会打印 `"accepted":true`：选择只创建 Embassy 自己的权限边，从不查询 Claude 的原生入站策略。拒绝要到第 4 步、消息抵达 Claude 端时才出现。如果注册与选择都成功，但你的第一条 `send-to-claude` 没有送达，请先检查目的地会话上的 `crossSessionInbound`，再去怀疑路由。

## 提供方与运行时契约

Embassy 路由四种提供方：Claude 使用对等协议 1，Codex 使用托管 App Server，DeepSeek 与 Grok Build 使用 ACP v1。发布版自有的[支持矩阵](../support/provider-support-matrix.json)记录离线测试的精确构件、协议、能力、停止保真度、限制与测试日期；运行时从不导入它。构建或版本事实可以限定发布版“已测试”的说法，但绝不授予或撤销路由权限。

运行时采用尽力而为模式：显式同意边加上精确自有路由/会话身份会授权一次尝试。当前逐操作传输、被消费协议字段的严格结构与相关操作决定结果。接口变化或可选提供方缺失会显示为提供方局部的降级/离线健康度与精确安全代码；它不会产生兼容性等级，也不会阻止其他提供方。

只有 Embassy 自有或执行的构件及其回调、控制或状态路径出现不安全 OS 证据——例如不安全的租约或状态、被替换的二进制、所有权/路径/符号链接不匹配，或无效的代际——才会拒绝代理启动。Claude 自有的外部会话注册表根目录属于读取侧身份依据：UID 或模式不安全时，只会让 Claude 降级并醒目显示，代理与其他提供方继续运行。Claude 每条会话记录仍必须使用原生 `peerProtocol: 1`；声明其他值的记录会单独被拒绝并纳入有界拒绝证据，不会阻止代理启动或隐藏其他可用会话。

运行时仍会严格解析每个已知注册表字段、帧和响应；未知的 Claude 注册表顶层字段会被忽略，因为 Embassy 从不使用它们。公开状态中的 Claude 连接器行会携带可选的有界 `registry` 观测：`entriesScanned`、`parseableRecords`、单调的 `parseableRecordSeenSinceBoot`、按安全代码分组且有界的 `rejected`，以及 `rejectedCodesOmitted`。两种仪表盘会醒目呈现同一事实：如果 Claude 正在运行，但自代理启动以来从未观测到带可解析必需字段的记录，它的注册表布局可能已更改。

托管 Codex 安装通过精确已验证路径解析；`PATH` 上其他位置的 `codex` 不会被使用或修改。Claude 注册表与回调根目录从已验证的当前 OS 用户派生；不会读取 Claude 启动器或配置文件。DeepSeek 只使用上方已验证的 checkout 根目录。Grok Build 使用发布版固定的 ACP 启动。版本字符串如存在，也只是有界诊断元数据。

## 寻址

Claude 会话通过其当前的 `name@host` 或用户提供的原生会话 UUID 寻址。UUID 是稳定的逻辑标识；当前名称是实时查找别名。重命名后，旧名称立即停止解析，而已选择的 UUID 绑定路由在新名称下继续有效。重命名会在该会话的下一次状态切换（通常是下一个轮次边界）时才对外可见——因为 Claude Code 在状态切换时整体重写会话注册表记录，而非在重命名的瞬间；Embassy 反映的是注册表记录，而非重命名操作本身。

名称、旧名称、PID、注册表路径、进程生成号和套接字生成号绝不会成为替代身份键。当两个在线会话共享同一当前名称时，Embassy 拒绝猜测。

Codex 路由使用显式的 `codex-*` 别名和任务继承的线程标识。私有线程 ID 从不作为命令行参数接受，也从不打印。注册时不执行 App Server 操作。每次投递都会打开并验证新的托管传输，初始化后在不读取历史的前提下恢复精确任务，并仅授权一次正文写入。App Server、桌面应用或代理重启不会改变逻辑路由权限，也无需重新注册。当前任务不可用或不可观察时，尝试会报告操作级安全代码，而注册和同意边仍会保留。
