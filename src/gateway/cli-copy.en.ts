import type { CliCopy } from "./cli-copy.js";

export const cliCopyEn = {
  "help.usage": `Embassy — local messaging for Claude Code and Codex

Usage:
  embassy <command> [options] [--lang en|zh-CN]

Commands:
  serve [--inbound open] Run the socket-only broker (paired inbound by default)
  health                 Check broker health
  status                 Read the public status snapshot
  compat-check           Run bounded no-traffic compatibility probes
  refresh-dashboard      Publish both static dashboard files
  dashboard --live       Open live status and bounded route consent
  register-codex         Register or succeed a Codex task
  unregister-codex       Unregister the current Codex task
  select-claude          Select a discovered Claude session
  unselect-claude        Clear the Claude selection
  pair                   Add one Claude↔Codex consent edge
  unpair                 Remove one Claude↔Codex consent edge
  send-to-claude         Send stdin to the selected Claude route
  send-to-codex          Send stdin to a registered Codex route
  reply                  Reply with a conversation token
  delivery-status        Read a delivery token
  wait-delivery          Wait for terminal delivery status

Options:
  --lang en|zh-CN        Localize user-facing text
  --version, -v          Print the version
  --help, -h             Show this help
`,
  "hint.dashboardLiveRequired":
    "dashboard requires --live; static files are published by serve and refresh-dashboard.",
  "error.input": "request rejected.",
  "error.decision": "gateway rejected the request.",
  "error.unavailable": "gateway unavailable.",
  "error.ambiguous": "outcome ambiguous; do not retry automatically.",
  "error.failure": "command failed.",
  "error.unsafe":
    "gateway state directory or socket has unexpected permissions or ownership. Verify nothing else controls that path before running embassy serve.",
  "error.tokenUnknown":
    "delivery token not recognized; it may have expired or belong to a previous gateway session.",
  "error.deliveryTimeout":
    "the delivery has not settled yet; the gateway is still running. Check again later with embassy delivery-status.",
  "error.versionDrift":
    "installed Claude Code is newer than this Embassy build supports. Update Embassy (npm update -g agent-embassy), then run embassy health.",
} as const satisfies CliCopy;
