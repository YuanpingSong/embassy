import type { CliCopy } from "./cli-copy.js";

export const callerIdentityConflictHintEn =
  "both agent identities were inherited; rerun this Codex-side call with env -u CLAUDE_CODE_MESSAGING_SOCKET, or this Claude-side call with env -u CODEX_THREAD_ID";

export const cliCopyEn = {
  "help.usage": `Embassy — local messaging for Claude Code and Codex

Usage:
  embassy <command> [options] [--lang en|zh-CN]

Commands:
  serve [--inbound open] Run the socket-only broker (paired inbound by default)
  health                 Check broker health
  status                 Read the public status snapshot
  refresh                Rescan for Claude sessions
  register-codex         Register or succeed a Codex task
  unregister-codex       Unregister the current Codex task
  register-peer --alias <peer-alias> [--token-stdin|--emit-env]
                         Register a universal shell peer
  unregister-peer --alias <peer-alias> [--token-stdin]
                         Unregister a universal shell peer
  await --alias <peer-alias> [--token-stdin]
                         Wait for one peer message and acknowledge stdout
  peer-stdio             Serve the bounded federation protocol on stdin/stdout
  select-claude          Select a discovered Claude session
  unselect-claude        Clear the Claude selection
  pair [--from <alias> --to <alias>] Add one cross-provider consent edge
  unpair [--from <alias> --to <alias>] Remove one cross-provider consent edge
  send                   Send stdin between paired provider routes
  reply                  Reply with a conversation token
  delivery-status        Read a delivery token
  wait-delivery          Wait for terminal delivery status
  untrack                Close one active progress watch

Options:
  --lang en|zh-CN        Localize user-facing text
  --token-stdin          Read the peer token as the first LF-terminated stdin line
  --emit-env             Print the first registration token as an export command
  --version, -v          Print the version
  --help, -h             Show this help
`,
  "hint.controlConnectDenied":
    "the broker may be running, but this process cannot connect; grant this task write access to the gateway state directory, then retry. Do not start a second broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.",
  "hint.controlInvalidResponse":
    "if either Embassy installation changed recently, rebuild or repoint this client to the broker's installation; otherwise restart the broker, then retry.",
  "hint.controlVersionMismatch":
    "rebuild or repoint this client to the broker's Embassy installation, then retry.",
  "hint.stateAccessDenied":
    "local policy denied access to the gateway state directory; grant this process access, then retry starting the broker. If access should already work, verify EMBASSY_STATE_DIR names this user's own state directory.",
  "hint.messageTooLarge":
    "message exceeds the 16 KiB acceptance cap; shorten or split it. For long prose, pipe the body from a file.",
  "hint.nodeInventoryRequired":
    "at {stateDir}, create the directory as mode-0700, replace <host> with your chosen lowercase host in exactly {\"version\":1,\"host\":\"<host>\",\"nodes\":[]}, save it there as mode-0600 nodes.json, then run embassy serve again.",
  "hint.progressWatchOwnerConflict":
    "this pair already has a watch owned by the other participant; ask that owner to run `embassy untrack --conversation <conversation-token>` first.",
  "hint.stateResetRequired":
    "state reset required; follow docs/CONFIGURATION.md#private-state-reset. Resetting abandons unsettled work. To check for unsettled work after upgrading, temporarily use Embassy 1.9.x before resetting.",
  "error.input": "request rejected.",
  "error.decision": "gateway rejected the request.",
  "error.unavailable": "gateway unavailable.",
  "error.ambiguous": "outcome ambiguous; do not retry automatically.",
  "error.failure": "command failed.",
  "error.unsafe":
    "gateway state directory or socket has unexpected permissions or ownership. Verify the exact path, owner, and modes before retrying.",
  "error.tokenUnknown":
    "delivery token not recognized; it may have expired or left bounded retention.",
  "error.deliveryTimeout":
    "the delivery has not settled yet; the gateway is still running. Check again later with embassy delivery-status.",
} as const satisfies CliCopy;
