import type { CliCopy } from "./cli-copy.js";

export const callerIdentityConflictHintZhCn =
  "同时继承了两种代理身份；Codex 侧调用请使用 env -u CLAUDE_CODE_MESSAGING_SOCKET 重试，Claude 侧调用请使用 env -u CODEX_THREAD_ID 重试";

export const cliCopyZhCn = {
  "help.usage": `Embassy — Claude Code 与 Codex 的本地消息通道

用法：
  embassy <command> [options] [--lang en|zh-CN]

命令：
  serve [--inbound open] 在前台运行仅使用套接字的代理（默认配对入站）
  health                 检查代理健康状态
  status                 读取公开状态快照
  doctor                 诊断 Codex 桌面应用连接状态
  refresh-dashboard      刷新发现结果并发布两份静态仪表盘
  dashboard --live [--port <n>]
                         打开实时状态与有限路由同意操作
  register-codex         注册或继任 Codex 任务
  unregister-codex       注销当前 Codex 任务
  register-peer --alias <对等别名> [--token-stdin|--emit-env]
                         注册通用 shell 对等方
  unregister-peer --alias <对等别名> [--token-stdin]
                         注销通用 shell 对等方
  await --alias <对等别名> [--token-stdin]
                         等待一条对等消息并在标准输出后确认
  peer-stdio             在标准输入／输出上提供有界联邦协议
  select-claude          选择已发现的 Claude 会话
  unselect-claude        清除 Claude 选择
  pair [--from <别名> --to <别名>] 添加一条跨提供商同意边
  unpair [--from <别名> --to <别名>] 移除一条跨提供商同意边
  send                   在已配对的提供方路由之间发送标准输入
  reply                  使用会话令牌回复
  delivery-status        读取投递令牌状态
  wait-delivery          等待终结投递状态
  untrack                关闭一个活跃的进度监视

选项：
  --lang en|zh-CN        本地化面向用户的文本
  --token-stdin          从标准输入首个 LF 结尾行读取对等令牌
  --emit-env             将首次注册令牌输出为 export 命令
  --port <n>             实时仪表盘端口，1024–65535（默认 41961）
  --version, -v          输出版本
  --help, -h             显示此帮助
`,
  "hint.dashboardLiveRequired":
    "dashboard 需要 --live；静态文件由 serve 和 refresh-dashboard 发布。",
  "hint.dashboardPortInUse":
    "实时仪表盘端口 {port} 已被占用；请关闭占用进程，或使用 --port <n> 选择其他端口。",
  "hint.controlConnectDenied":
    "网关进程可能仍在运行，但当前进程无权连接；请授予此任务对网关状态目录的写入权限，然后重试。请勿启动第二个网关进程。如果本应已有访问权限，请确认 EMBASSY_STATE_DIR 指向此用户自己的状态目录。",
  "hint.controlInvalidResponse":
    "如果任一 Embassy 安装近期发生变化，请重新构建客户端或将其重新指向网关进程所用的安装；否则请重启网关进程，然后重试。",
  "hint.controlVersionMismatch":
    "请重新构建客户端，或将其重新指向网关进程所使用的 Embassy 安装，然后重试。",
  "hint.stateAccessDenied":
    "本地策略拒绝访问网关状态目录；请授予此进程访问权限，然后重新尝试启动网关。如果本应已有访问权限，请确认 EMBASSY_STATE_DIR 指向此用户自己的状态目录。",
  "hint.messageTooLarge":
    "消息超过 16 KiB 接收上限；请缩短消息或将其拆分。对于长篇内容，请通过管道从文件传入正文。",
  "hint.nodeInventoryRequired":
    "请在 {stateDir} 将该目录创建为 mode-0700，把 {\"version\":1,\"host\":\"<host>\",\"nodes\":[]} 中的 <host> 替换为所选的小写主机名，并在该目录中保存为 mode-0600 的 nodes.json，然后再次运行 embassy serve。",
  "hint.progressWatchOwnerConflict":
    "此配对已有由另一参与方拥有的监视；请先让该所有者运行 `embassy untrack --conversation <conversation-token>`。",
  "hint.stateResetRequired":
    "必须重置状态；请按照 docs/CONFIGURATION.zh-CN.md#私有状态重置 操作。重置会放弃所有未结算工作。升级后如需检查未结算工作，请在重置前暂时使用 Embassy 1.9.x。",
  "error.input": "请求被拒绝。",
  "error.decision": "网关拒绝了该请求。",
  "error.unavailable": "网关不可用。",
  "error.ambiguous": "结果不确定；请勿自动重试。",
  "error.failure": "命令失败。",
  "error.unsafe":
    "网关状态目录或套接字的权限或所有者异常。请核对精确路径、所有者和模式后再重试。",
  "error.tokenUnknown": "无法识别该投递令牌；它可能已过期，或已超出有界保留范围。",
  "error.deliveryTimeout":
    "该投递尚未结算；网关仍在运行。请稍后使用 embassy delivery-status 再次查询。",
} as const satisfies CliCopy;
