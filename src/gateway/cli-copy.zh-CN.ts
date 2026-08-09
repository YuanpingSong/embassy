import type { CliCopy } from "./cli-copy.js";

export const cliCopyZhCn = {
  "help.usage": `Embassy — Claude Code 与 Codex 的本地消息通道

用法：
  embassy <command> [options] [--lang en|zh-CN]

命令：
  serve [--inbound open] 在前台运行仅使用套接字的代理（默认配对入站）
  health                 检查代理健康状态
  status                 读取公开状态快照
  refresh-dashboard      发布两份静态仪表盘文件
  dashboard --live       打开实时状态与有限路由同意操作
  register-codex         注册或继任 Codex 任务
  unregister-codex       注销当前 Codex 任务
  select-claude          选择已发现的 Claude 会话
  unselect-claude        清除 Claude 选择
  send-to-claude         将标准输入发送到所选 Claude 路由
  send-to-codex          将标准输入发送到已注册 Codex 路由
  reply                  使用会话令牌回复
  delivery-status        读取投递令牌状态
  wait-delivery          等待终结投递状态

选项：
  --lang en|zh-CN        本地化面向用户的文本
  --version, -v          输出版本
  --help, -h             显示此帮助
`,
  "hint.dashboardLiveRequired":
    "dashboard 需要 --live；静态文件由 serve 和 refresh-dashboard 发布。",
  "error.input": "请求被拒绝。",
  "error.decision": "网关拒绝了该请求。",
  "error.unavailable": "网关不可用。",
  "error.ambiguous": "结果不确定；请勿自动重试。",
  "error.failure": "命令失败。",
  "error.unsafe":
    "网关状态目录或套接字的权限或所有者异常。请先确认该路径未被其他进程控制，再运行 embassy serve。",
  "error.tokenUnknown": "无法识别该投递令牌；它可能已过期，或属于上一次网关会话。",
  "error.deliveryTimeout":
    "该投递尚未结算；网关仍在运行。请稍后使用 embassy delivery-status 再次查询。",
  "error.versionDrift":
    "已安装的 Claude Code 版本高于此 Embassy 构建支持的版本。请更新 Embassy（npm update -g agent-embassy），然后运行 embassy health。",
} as const satisfies CliCopy;
