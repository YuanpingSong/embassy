import type { CliCopy } from "./cli-copy.js";

export const callerIdentityConflictHintEn =
  "both agent identities were inherited; the Codex App Server daemon may have been started inside an agent session. From a normal terminal, run: codex app-server daemon restart";

export const cliCopyEn = {
  "help.usage": `Embassy — local messaging for Claude Code and Codex

Usage:
  embassy <command> [options] [--lang en|zh-CN]

Commands:
  serve [--inbound open] Run the socket-only broker (paired inbound by default)
  health                 Check broker health
  status                 Read the public status snapshot
  doctor                 Diagnose Codex Desktop attachment
  refresh-dashboard      Publish both static dashboard files
  dashboard --live [--port <n>]
                         Open live status and bounded route consent
  register-codex         Register or succeed a Codex task
  unregister-codex       Unregister the current Codex task
  select-claude          Select a discovered Claude session
  unselect-claude        Clear the Claude selection
  pair [--from <alias> --to <alias>] Add one cross-provider consent edge
  unpair [--from <alias> --to <alias>] Remove one cross-provider consent edge
  send-to-claude         Send stdin to the selected Claude route
  send-to-codex          Send stdin to a registered Codex route
  reply                  Reply with a conversation token
  delivery-status        Read a delivery token
  wait-delivery          Wait for terminal delivery status
  untrack                Close one active progress watch

Options:
  --lang en|zh-CN        Localize user-facing text
  --port <n>             Live dashboard port, 1024–65535 (default 41961)
  --version, -v          Print the version
  --help, -h             Show this help
`,
  "hint.dashboardLiveRequired":
    "dashboard requires --live; static files are published by serve and refresh-dashboard.",
  "hint.dashboardPortInUse":
    "live dashboard port {port} is already in use; close the holding process or choose another with --port <n>.",
  "hint.controlInvalidResponse":
    "client/broker version skew is likely; rebuild or repoint this client to the broker's Embassy installation, then retry.",
  "hint.messageTooLarge":
    "message exceeds the 16 KiB acceptance cap; shorten or split it. For long prose, pipe the body from a file.",
  "hint.progressWatchOwnerConflict":
    "this pair already has a watch owned by the other participant; ask that owner to run `embassy untrack --conversation <conversation-token>` first.",
  "hint.codexSplitBrain":
    "Desktop is on a private App Server; its tasks are unreachable by Embassy. Relaunch: /usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT",
  "hint.codexOrphaned":
    "the daemon is running but no Desktop client is attached; threads cannot load. Run: /usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT, then open your Codex task.",
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
} as const satisfies CliCopy;
