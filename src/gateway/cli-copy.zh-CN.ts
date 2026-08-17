import type { CliCopy } from "./cli-copy.js";

export const callerIdentityConflictHintZhCn =
  "同时继承了两种代理身份；Codex App Server 守护进程可能是在代理会话内启动的。请在普通终端中运行：codex app-server daemon restart";

export const cliCopyZhCn = {
  "help.usage": `Embassy — Claude Code 与 Codex 的本地消息通道

用法：
  embassy <command> [options] [--lang en|zh-CN]

命令：
  serve [--inbound open] 在前台运行仅使用套接字的代理（默认配对入站）
  health                 检查代理健康状态
  status                 读取公开状态快照
  doctor                 诊断 Codex 桌面应用连接状态
  convert-state-v2-to-v3 备份后转换已停止代理的状态
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
  select-claude          选择已发现的 Claude 会话
  unselect-claude        清除 Claude 选择
  pair [--from <别名> --to <别名>] 添加一条跨提供商同意边
  unpair [--from <别名> --to <别名>] 移除一条跨提供商同意边
  send-to-claude         将标准输入发送到所选 Claude 路由
  send-to-codex          将标准输入发送到已注册 Codex 路由
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
  "hint.controlInvalidResponse":
    "客户端与网关进程的版本可能不一致；请重新构建客户端，或将其重新指向网关进程所使用的 Embassy 安装，然后重试。",
  "hint.messageTooLarge":
    "消息超过 16 KiB 接收上限；请缩短消息或将其拆分。对于长篇内容，请通过管道从文件传入正文。",
  "hint.progressWatchOwnerConflict":
    "此配对已有由另一参与方拥有的监视；请先让该所有者运行 `embassy untrack --conversation <conversation-token>`。",
  "error.input": "请求被拒绝。",
  "error.decision": "网关拒绝了该请求。",
  "error.unavailable": "网关不可用。",
  "error.ambiguous": "结果不确定；请勿自动重试。",
  "error.failure": "命令失败。",
  "error.unsafe":
    "网关状态目录或套接字的权限或所有者异常。请先确认该路径未被其他进程控制，再运行 embassy serve。",
  "error.tokenUnknown": "无法识别该投递令牌；它可能已过期，或已超出有界保留范围。",
  "error.deliveryTimeout":
    "该投递尚未结算；网关仍在运行。请稍后使用 embassy delivery-status 再次查询。",
} as const satisfies CliCopy;
