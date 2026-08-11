import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  constants as fsConstants,
  lstat,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";
import {
  createCodexRegistrationGeneration,
  isCodexRegistrationGeneration,
} from "./codex-registration-generation.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import { isDashboardLocale, type DashboardLocale } from "./locale.js";
import { sharesCompatibilityMajor } from "./compatibility.js";

/**
 * This adapter intentionally pins the inspected, implementation-specific
 * local peer boundary. The feature is documented in Claude Code, but its
 * registry and NDJSON formats are not a stable public integration contract.
 */
export const CLAUDE_PEER_COMPATIBILITY = Object.freeze({
  claudeCodeVersion: "2.1.227",
  peerProtocol: 1,
  messageVersion: 1,
});

/** Live peer records may outlive a same-protocol Claude Code upgrade. */
export const CLAUDE_PEER_COMPATIBLE_SESSION_VERSIONS = Object.freeze([
  "2.1.224",
  "2.1.225",
  "2.1.226",
  "2.1.227",
] as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CLAUDE_PEER_NOTICE_COPY = {
  en: {
    stall:
      "The local gateway is still waiting to deliver the preceding message. Run `embassy status` or inspect the dashboard for details.",
    diagnostic:
      "The local gateway could not deliver the preceding message. Run `embassy status` or inspect the dashboard for details.",
  },
  "zh-CN": {
    stall:
      "本地网关仍在等待投递前一条消息。运行 `embassy status` 或查看仪表盘了解详情。",
    diagnostic:
      "本地网关无法投递前一条消息。运行 `embassy status` 或查看仪表盘了解详情。",
  },
} as const satisfies Readonly<
  Record<DashboardLocale, Readonly<Record<"stall" | "diagnostic", string>>>
>;
const REGISTRY_FILE_PATTERN = /^([1-9][0-9]{0,9})\.json$/;
const SOCKET_FILE_PATTERN = /^([1-9][0-9]{0,9})\.sock$/;
const MAX_PID = 2_147_483_647;

export const claudePeerStatuses = [
  "busy",
  "shell",
  "idle",
  "waiting",
] as const;
export type ClaudePeerStatus = (typeof claudePeerStatuses)[number];

export const claudePeerKinds = [
  "interactive",
  "bg",
  "daemon",
  "daemon-worker",
] as const;
export type ClaudePeerKind = (typeof claudePeerKinds)[number];

export const claudePeerRejectionCodes = [
  "ENTRY_LIMIT_EXCEEDED",
  "INVALID_FILE_NAME",
  "REGISTRY_NOT_REGULAR",
  "REGISTRY_OWNER_MISMATCH",
  "REGISTRY_MODE_UNSAFE",
  "REGISTRY_TOO_LARGE",
  "REGISTRY_RACED",
  "REGISTRY_INVALID_JSON",
  "REGISTRY_INVALID_SCHEMA",
  "PID_MISMATCH",
  "PID_NOT_LIVE",
  "PID_OWNER_MISMATCH",
  "SOCKET_OUTSIDE_ROOT",
  "SOCKET_NOT_SOCKET",
  "SOCKET_OWNER_MISMATCH",
  "SOCKET_MODE_UNSAFE",
  "SELF_TARGET",
  "SESSION_ID_COLLISION",
] as const;
export type ClaudePeerRejectionCode =
  (typeof claudePeerRejectionCodes)[number];

export type ClaudePeerDescriptor = {
  /** Claude's stable logical session UUID. Names and sockets are not identity. */
  targetId: string;
  alias: string;
  kind: ClaudePeerKind;
  status: ClaudePeerStatus;
  compatibility: "compatible";
};

export type ClaudePeerDiscovery = {
  peers: ClaudePeerDescriptor[];
  rejected: Partial<Record<ClaudePeerRejectionCode, number>>;
  truncated: boolean;
  /** Bounded registry entries examined, including safely skipped records. */
  entriesScanned: number;
  /** Records whose closed wire schema parsed before later liveness checks. */
  parseableRecords: number;
};

export type ClaudePeerTransportStatus =
  | "connecting"
  | "write_started"
  | "transport_written"
  | "ambiguous"
  | "not_written";

export type ClaudePeerReceiptStatus =
  | "held"
  /** Native `delivered`: approval released the frame to Claude's queue. */
  | "released"
  | "denied"
  | "expired"
  | "unconfirmed"
  | "ambiguous";

export type ClaudePeerDeliveryDiagnostic = {
  /** Stable, non-sensitive gateway code rendered into Claude's context. */
  code: string;
};

export const claudePeerInboundStallReasons = [
  "ROUTE_BUSY",
  "ROUTE_UNAVAILABLE",
  "CODEX_ROUTE_STALE",
  "AWAITING_EXTERNAL_APPROVAL",
] as const;
export type ClaudePeerInboundStallReason =
  (typeof claudePeerInboundStallReasons)[number];

export type ClaudePeerInboundProgress = {
  kind: "stall";
  reason: ClaudePeerInboundStallReason;
  queuedForMs: number;
};

export type ClaudePeerAcknowledgmentResult = {
  transportStatus: "transport_written" | "suppressed";
};

export type ClaudePeerTransportEvent = {
  messageId: string;
  status: ClaudePeerTransportStatus;
};

export type ClaudePeerReceiptEvent = {
  messageId: string;
  status: ClaudePeerReceiptStatus;
  trust: "untrusted_same_uid_peer";
};

export type ClaudePeerInboundMessage = {
  inboundId: string;
  content: string;
  /** Validated connect-back capability, not proof of the connecting PID. */
  sourceTargetId?: string;
  /** Display label from that capability; never an authority. */
  sourceAlias?: string;
  /** Opaque listener-owned handle for native held/delivered status updates. */
  receiptHandle?: string;
  replySupported: boolean;
  trust: "untrusted_same_uid_peer" | "untrusted_anonymous_local_peer";
};

export type ClaudePeerProtocolNotice = {
  code:
    | "FRAME_TOO_LARGE"
    | "INVALID_UTF8"
    | "INVALID_FRAME"
    | "UNSUPPORTED_FRAME"
    | "UNREGISTERED_REPLY_ADDRESS"
    | "UNKNOWN_RECEIPT"
    | "INVALID_RECEIPT_TRANSITION"
    | "RECEIPT_LIMIT"
    | "CONNECTION_LIMIT"
    | "CONNECTION_TIMEOUT"
    | "CALLBACK_ERROR";
};

export type ClaudeProcessIdentity = {
  uid: number;
  /** Stable only for the lifetime of this process, such as ps(1) lstart. */
  generation: string;
};

export type ClaudeProcessInspector = (
  pid: number,
) => Promise<ClaudeProcessIdentity | undefined>;

export type ClaudePeerConnect = (socketPath: string) => Socket;

export type ClaudePeerAdapterOptions = {
  sessionsDir: string;
  socketDir: string;
  /** Exact version attested by the trusted launcher, never user input. */
  attestedClaudeCodeVersion: string;
  /** Locale for bounded user-visible gateway notices written to Claude. */
  locale?: DashboardLocale;
  /** Gateway-authored user-frame policy; native status frames are unaffected. */
  deliveryNotices?: GatewayDeliveryNoticeMode;
  maxRegistryEntries?: number;
  maxRegistryBytes?: number;
  maxFrameBytes?: number;
  targetLeaseMs?: number;
  connectTimeoutMs?: number;
  receiptDeadlineMs?: number;
  maxPendingReceipts?: number;
  maxConnections?: number;
  connectionIdleMs?: number;
  maxFramesPerConnection?: number;
};

/** Dependency seams for deterministic tests; never populate from config. */
export type ClaudePeerAdapterTestOverrides = {
  processInspector?: ClaudeProcessInspector;
  connect?: ClaudePeerConnect;
  now?: () => number;
  createId?: () => string;
  /** Separate from protocol/message UUID generation so lifecycle tests cannot alias it. */
  createGeneration?: () => string;
  registryRename?: (source: string, destination: string) => Promise<void>;
  registryOperationHook?: (event: {
    operation: "advertise" | "publish" | "status" | "unadvertise";
    phase: "entered" | "exited";
    generation: string;
  }) => void | Promise<void>;
  userHome?: string;
  tempRoots?: readonly string[];
  registryPublicationHook?: (
    stage: "before_rename" | "after_rename",
  ) => void | Promise<void>;
};

export type ClaudePeerRegistryPublicationOutcome =
  | "published"
  | "not_published"
  | "unknown";

export type ClaudePeerListenerOptions = {
  onMessage: (message: ClaudePeerInboundMessage) => void | Promise<void>;
  onReceipt?: (event: ClaudePeerReceiptEvent) => void | Promise<void>;
  onProtocolNotice?: (
    notice: ClaudePeerProtocolNotice,
  ) => void | Promise<void>;
};

export type ClaudePeerSendOptions = {
  listener?: ClaudePeerListener;
  /** Exact gateway message deadline as an epoch-millisecond timestamp. */
  receiptDeadlineAt?: number;
  onTransportStatus?: (
    event: ClaudePeerTransportEvent,
  ) => void | Promise<void>;
};

export type ClaudePeerSendResult = {
  messageId: string;
  transportStatus: "transport_written";
  receiptStatus: "pending" | "unavailable";
};

type FileGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type SocketGeneration = {
  dev: number;
  ino: number;
};

type DirectoryGeneration = {
  dev: number;
  ino: number;
};

type WorkspacePolicy = {
  stateRoot: string;
  stateGeneration: DirectoryGeneration;
  workspace: string;
  workspaceGeneration: DirectoryGeneration;
};

type ParsedRegistryRecord = {
  pid: number;
  sessionId: string;
  cwd: string;
  peerProtocol: 1;
  kind: ClaudePeerKind;
  messagingSocketPath: string;
  name: string;
  status: ClaudePeerStatus;
};

type TargetBinding = {
  targetId: string;
  alias: string;
  registryPath: string;
  registryGeneration: FileGeneration;
  socketGeneration: SocketGeneration;
  record: ParsedRegistryRecord;
  processGeneration: string;
  expiresAt: number;
};

type CanonicalUserFrame = {
  msgV: 1;
  msg_id: string;
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  priority: "next";
  from?: string;
};

type ParsedUserFrame = {
  type: "user";
  content: string;
  messageId?: string;
  from?: string;
};

type ParsedControlFrame = {
  type: "control";
  action: "peer_message_status";
  status: "held" | "denied" | "expired" | "delivered";
  from: string;
  originalMessageId: string;
};

type ParsedFrame = ParsedUserFrame | ParsedControlFrame;

type PendingReceipt = {
  binding: TargetBinding;
  state: "pending" | "held";
  writeEvidence: "none" | "transport_written" | "transport_uncertain";
  deadlineAt: number;
  timer: NodeJS.Timeout;
};

function pendingReceiptDeadlineStatus(
  pending: PendingReceipt,
): "unconfirmed" | "ambiguous" | "expired" {
  if (
    pending.writeEvidence === "transport_written" ||
    pending.state === "held"
  ) {
    return "unconfirmed";
  }
  return pending.writeEvidence === "transport_uncertain"
    ? "ambiguous"
    : "expired";
}

type InboundReceipt = {
  sourceSessionId: string;
  originalMessageId: string;
  stallNotification: "available" | "writing" | "settled";
};

type CapacitySettlement = {
  receipt: InboundReceipt;
  attempts: number;
  retryTimer?: NodeJS.Timeout;
};

type AdapterLimits = {
  maxRegistryEntries: number;
  maxRegistryBytes: number;
  maxFrameBytes: number;
  targetLeaseMs: number;
  connectTimeoutMs: number;
  receiptDeadlineMs: number;
  maxPendingReceipts: number;
  maxConnections: number;
  connectionIdleMs: number;
  maxFramesPerConnection: number;
};

const MAX_CLAUDE_STALL_QUEUED_MS = 3_600_000;
const CAPACITY_SETTLEMENT_MAX_ATTEMPTS = 3;
const CAPACITY_SETTLEMENT_RETRY_MS = 25;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const permitted = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => permitted.has(key))
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
): value is string {
  return typeof value === "string" && byteLength(value) <= maxBytes;
}

function validateContent(content: unknown, maxBytes: number): string {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.includes("\0") ||
    byteLength(content) > maxBytes
  ) {
    throw new BridgeError(
      "INVALID_PEER_CONTENT",
      "Claude peer content must be a non-empty bounded UTF-8 string without NUL bytes.",
    );
  }
  return content;
}

function exactMode(mode: number): number {
  return mode & 0o777;
}

function generationOf(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): FileGeneration {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileGeneration(
  left: FileGeneration,
  right: FileGeneration,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameSocketGeneration(
  left: SocketGeneration,
  right: SocketGeneration,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryGeneration(
  left: DirectoryGeneration,
  right: DirectoryGeneration,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameTargetGeneration(
  left: TargetBinding,
  right: TargetBinding,
): boolean {
  return (
    left.registryPath === right.registryPath &&
    left.record.pid === right.record.pid &&
    left.record.sessionId === right.record.sessionId &&
    left.record.name === right.record.name &&
    left.record.cwd === right.record.cwd &&
    left.record.kind === right.record.kind &&
    left.record.messagingSocketPath === right.record.messagingSocketPath &&
    left.processGeneration === right.processGeneration &&
    sameSocketGeneration(left.socketGeneration, right.socketGeneration)
  );
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PID) return undefined;
  return parsed;
}

function assertAbsoluteConfiguredPath(value: string, label: string): string {
  if (
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.resolve(value) !== value
  ) {
    throw new BridgeError(
      "INVALID_PEER_PATH",
      `${label} must be an absolute normalized path.`,
    );
  }
  return value;
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new BridgeError(
      "INVALID_PEER_LIMIT",
      `${label} is outside the supported bounded range.`,
    );
  }
  return resolved;
}

function boundedStallQueuedForMs(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) {
    return MAX_CLAUDE_STALL_QUEUED_MS;
  }
  return Math.min(
    MAX_CLAUDE_STALL_QUEUED_MS,
    Math.max(0, Math.trunc(value)),
  );
}

function parseRegistryRecord(
  value: unknown,
  expectedPid: number,
): ParsedRegistryRecord | undefined {
  if (!isObject(value)) return undefined;
  const required = [
    "pid",
    "sessionId",
    "cwd",
    "startedAt",
    "procStart",
    "version",
    "peerProtocol",
    "kind",
    "entrypoint",
    "messagingSocketPath",
    "name",
    "updatedAt",
  ] as const;
  const optional = ["nameSource", "status", "statusUpdatedAt"] as const;
  if (!hasExactKeys(value, required, optional)) return undefined;

  if (value.pid !== expectedPid) return undefined;
  if (
    typeof value.sessionId !== "string" ||
    !UUID_PATTERN.test(value.sessionId)
  ) {
    return undefined;
  }
  if (
    !isBoundedString(value.cwd, 4096) ||
    !path.isAbsolute(value.cwd) ||
    value.cwd.includes("\0")
  ) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0 ||
    (value.statusUpdatedAt !== undefined &&
      (!Number.isSafeInteger(value.statusUpdatedAt) ||
        (value.statusUpdatedAt as number) < 0)) ||
    !isBoundedString(value.procStart, 256) ||
    value.procStart.length === 0 ||
    value.procStart.includes("\0") ||
    typeof value.version !== "string" ||
    !sharesCompatibilityMajor(
      value.version,
      CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
    ) ||
    !isBoundedString(value.entrypoint, 64) ||
    !/^[A-Za-z0-9._-]+$/.test(value.entrypoint) ||
    (value.nameSource !== undefined &&
      value.nameSource !== null &&
      (!isBoundedString(value.nameSource, 64) ||
        !/^[A-Za-z0-9._-]+$/.test(value.nameSource)))
  ) {
    return undefined;
  }
  if (value.peerProtocol !== CLAUDE_PEER_COMPATIBILITY.peerProtocol) {
    return undefined;
  }
  if (
    typeof value.kind !== "string" ||
    !claudePeerKinds.includes(value.kind as ClaudePeerKind)
  ) {
    return undefined;
  }
  if (
    !isBoundedString(value.messagingSocketPath, 4096) ||
    !path.isAbsolute(value.messagingSocketPath) ||
    value.messagingSocketPath.includes("\0")
  ) {
    return undefined;
  }
  if (
    typeof value.name !== "string" ||
    !ALIAS_PATTERN.test(value.name)
  ) {
    return undefined;
  }
  if (
    value.status !== undefined &&
    (typeof value.status !== "string" ||
      !claudePeerStatuses.includes(value.status as ClaudePeerStatus))
  ) {
    return undefined;
  }

  return {
    pid: expectedPid,
    sessionId: value.sessionId.toLowerCase(),
    cwd: value.cwd,
    peerProtocol: 1,
    kind: value.kind as ClaudePeerKind,
    messagingSocketPath: value.messagingSocketPath,
    name: value.name,
    // Some reviewed Claude Code print/SDK session records omit status fields
    // while the model turn is active. Treat that live process conservatively
    // as busy.
    status: (value.status ?? "busy") as ClaudePeerStatus,
  };
}

function parseFrame(line: Buffer, maxFrameBytes: number): ParsedFrame {
  if (line.length === 0 || line.length > maxFrameBytes) {
    throw new BridgeError("INVALID_PEER_FRAME", "Invalid peer frame size.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw new BridgeError("INVALID_PEER_UTF8", "Invalid peer frame encoding.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new BridgeError("INVALID_PEER_FRAME", "Invalid peer frame JSON.");
  }
  if (!isObject(value) || typeof value.type !== "string") {
    throw new BridgeError("INVALID_PEER_FRAME", "Invalid peer frame shape.");
  }

  if (value.type === "user") {
    if (
      !hasExactKeys(
        value,
        ["type", "message"],
        ["msgV", "msg_id", "priority", "from"],
      ) ||
      !isObject(value.message) ||
      !hasExactKeys(value.message, ["role", "content"]) ||
      value.message.role !== "user"
    ) {
      throw new BridgeError("INVALID_PEER_FRAME", "Invalid user frame shape.");
    }
    const canonicalFields = [value.msgV, value.msg_id, value.priority];
    const canonicalCount = canonicalFields.filter(
      (field) => field !== undefined,
    ).length;
    if (
      canonicalCount !== 0 &&
      (canonicalCount !== 3 ||
        value.msgV !== 1 ||
        typeof value.msg_id !== "string" ||
        !UUID_PATTERN.test(value.msg_id) ||
        value.priority !== "next")
    ) {
      throw new BridgeError(
        "INVALID_PEER_FRAME",
        "Invalid canonical user frame fields.",
      );
    }
    if (
      value.from !== undefined &&
      (!isBoundedString(value.from, 4096) || !value.from.startsWith("uds:"))
    ) {
      throw new BridgeError("INVALID_PEER_FRAME", "Invalid reply address.");
    }
    const content = validateContent(value.message.content, maxFrameBytes);
    return {
      type: "user",
      content,
      ...(typeof value.msg_id === "string"
        ? { messageId: value.msg_id }
        : {}),
      ...(typeof value.from === "string" ? { from: value.from } : {}),
    };
  }

  if (value.type === "control") {
    if (
      !hasExactKeys(value, [
        "type",
        "action",
        "status",
        "reason",
        "from",
        "orig_msg_id",
        "msgV",
        "msg_id",
      ]) ||
      value.action !== "peer_message_status" ||
      !["held", "denied", "expired", "delivered"].includes(
        String(value.status),
      ) ||
      !isBoundedString(value.reason, 1024) ||
      !isBoundedString(value.from, 4096) ||
      !value.from.startsWith("uds:") ||
      typeof value.orig_msg_id !== "string" ||
      !UUID_PATTERN.test(value.orig_msg_id) ||
      value.msgV !== 1 ||
      typeof value.msg_id !== "string" ||
      !UUID_PATTERN.test(value.msg_id)
    ) {
      throw new BridgeError(
        "INVALID_PEER_FRAME",
        "Invalid peer status frame.",
      );
    }
    return {
      type: "control",
      action: "peer_message_status",
      status: value.status as ParsedControlFrame["status"],
      from: value.from,
      originalMessageId: value.orig_msg_id,
    };
  }

  throw new BridgeError(
    "UNSUPPORTED_PEER_FRAME",
    "Unsupported Claude peer frame type.",
  );
}

export function encodeClaudePeerUserFrame(input: {
  messageId: string;
  content: string;
  from?: string;
  maxFrameBytes?: number;
}): Buffer {
  if (!UUID_PATTERN.test(input.messageId)) {
    throw new BridgeError(
      "INVALID_PEER_MESSAGE_ID",
      "The peer message ID must be a UUID.",
    );
  }
  const maxFrameBytes = configuredLimit(
    input.maxFrameBytes,
    64 * 1024,
    256,
    1024 * 1024,
    "maxFrameBytes",
  );
  const content = validateContent(input.content, maxFrameBytes);
  if (
    input.from !== undefined &&
    (!input.from.startsWith("uds:") ||
      !path.isAbsolute(input.from.slice(4)) ||
      input.from.includes("\0"))
  ) {
    throw new BridgeError(
      "INVALID_PEER_REPLY_ADDRESS",
      "The peer reply address must be an absolute uds address.",
    );
  }
  const frame: CanonicalUserFrame = {
    msgV: 1,
    msg_id: input.messageId,
    type: "user",
    message: { role: "user", content },
    priority: "next",
    ...(input.from === undefined ? {} : { from: input.from }),
  };
  const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (encoded.length > maxFrameBytes + 1) {
    throw new BridgeError(
      "PEER_FRAME_TOO_LARGE",
      "The encoded Claude peer frame exceeds the configured limit.",
    );
  }
  return encoded;
}

async function defaultProcessInspector(
  pid: number,
): Promise<ClaudeProcessIdentity | undefined> {
  const executable = "/bin/ps";
  return await new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-o", "uid=,lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        timeout: 1_000,
        maxBuffer: 4_096,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // A missing/exited process and a bounded ps(1) failure both fail
          // closed as "not live". No stderr or command output is surfaced.
          resolve(undefined);
          return;
        }
        const match = /^\s*([0-9]+)\s+(.+?)\s*$/.exec(stdout);
        if (match === null) {
          resolve(undefined);
          return;
        }
        const uid = Number(match[1]);
        const generation = match[2];
        if (!Number.isSafeInteger(uid) || generation === undefined) {
          resolve(undefined);
          return;
        }
        resolve({ uid, generation });
      },
    );
  });
}

async function invokeHook<T>(
  hook: ((value: T) => void | Promise<void>) | undefined,
  value: T,
): Promise<void> {
  if (hook === undefined) return;
  await hook(value);
}

async function invokeObservationalHook<T>(
  hook: ((value: T) => void | Promise<void>) | undefined,
  value: T,
): Promise<void> {
  try {
    await invokeHook(hook, value);
  } catch {
    // Status observation must never change a possibly-written transport
    // outcome or invite an unsafe caller retry.
  }
}

export class ClaudePeerAdapter {
  readonly #sessionsDir: string;
  readonly #socketDir: string;
  readonly #expectedUid: number;
  readonly #limits: AdapterLimits;
  readonly #inspectProcess: ClaudeProcessInspector;
  readonly #connect: ClaudePeerConnect;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createGeneration: () => string;
  readonly #locale: DashboardLocale;
  readonly #attestedClaudeCodeVersion: string;
  readonly #deliveryNotices: GatewayDeliveryNoticeMode;
  readonly #registryRename: (
    source: string,
    destination: string,
  ) => Promise<void>;
  readonly #registryOperationHook:
    | ClaudePeerAdapterTestOverrides["registryOperationHook"]
    | undefined;
  readonly #userHome: string;
  readonly #tempRoots: readonly string[];
  readonly #listenerOwner = Object.freeze({});
  readonly #registryMutex = new KeyedMutex();
  readonly #registryPublicationHook:
    | ((stage: "before_rename" | "after_rename") => void | Promise<void>)
    | undefined;
  readonly #targets = new Map<string, TargetBinding>();
  readonly #workspacePolicies = new Map<string, WorkspacePolicy>();
  readonly #listeners = new Set<ClaudePeerListener>();

  constructor(
    options: ClaudePeerAdapterOptions,
    testing: ClaudePeerAdapterTestOverrides = {},
  ) {
    if (process.platform === "win32" || process.getuid === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_PLATFORM_UNSUPPORTED",
        "Claude peer sockets are supported only on macOS and Linux.",
      );
    }
    if (
      !sharesCompatibilityMajor(
        options.attestedClaudeCodeVersion,
        CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      )
    ) {
      throw new BridgeError(
        "CLAUDE_PEER_VERSION_UNSUPPORTED",
        `Claude peer compatibility is pinned to Claude Code ${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion}.`,
      );
    }
    if (options.locale !== undefined && !isDashboardLocale(options.locale)) {
      throw new BridgeError(
        "DASHBOARD_LOCALE_UNSUPPORTED",
        "The Claude peer notice locale is unsupported.",
      );
    }
    this.#locale = options.locale ?? "en";
    this.#attestedClaudeCodeVersion = options.attestedClaudeCodeVersion;
    if (
      options.deliveryNotices !== undefined &&
      !["merged", "verbose", "quiet"].includes(options.deliveryNotices)
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_CONFIGURATION",
        "The Claude peer delivery notice mode is unsupported.",
      );
    }
    this.#deliveryNotices = options.deliveryNotices ?? "merged";
    this.#sessionsDir = assertAbsoluteConfiguredPath(
      options.sessionsDir,
      "sessionsDir",
    );
    this.#socketDir = assertAbsoluteConfiguredPath(
      options.socketDir,
      "socketDir",
    );
    this.#expectedUid = process.getuid();
    if (!Number.isSafeInteger(this.#expectedUid) || this.#expectedUid < 0) {
      throw new BridgeError(
        "INVALID_PEER_UID",
        "expectedUid must be a non-negative integer.",
      );
    }
    this.#limits = {
      maxRegistryEntries: configuredLimit(
        options.maxRegistryEntries,
        256,
        1,
        4_096,
        "maxRegistryEntries",
      ),
      maxRegistryBytes: configuredLimit(
        options.maxRegistryBytes,
        16 * 1024,
        512,
        1024 * 1024,
        "maxRegistryBytes",
      ),
      maxFrameBytes: configuredLimit(
        options.maxFrameBytes,
        64 * 1024,
        256,
        1024 * 1024,
        "maxFrameBytes",
      ),
      targetLeaseMs: configuredLimit(
        options.targetLeaseMs,
        30_000,
        100,
        5 * 60_000,
        "targetLeaseMs",
      ),
      connectTimeoutMs: configuredLimit(
        options.connectTimeoutMs,
        2_000,
        10,
        30_000,
        "connectTimeoutMs",
      ),
      receiptDeadlineMs: configuredLimit(
        options.receiptDeadlineMs,
        5 * 60_000,
        10,
        10 * 60_000,
        "receiptDeadlineMs",
      ),
      maxPendingReceipts: configuredLimit(
        options.maxPendingReceipts,
        256,
        1,
        4_096,
        "maxPendingReceipts",
      ),
      maxConnections: configuredLimit(
        options.maxConnections,
        32,
        1,
        1_024,
        "maxConnections",
      ),
      connectionIdleMs: configuredLimit(
        options.connectionIdleMs,
        5_000,
        10,
        60_000,
        "connectionIdleMs",
      ),
      maxFramesPerConnection: configuredLimit(
        options.maxFramesPerConnection,
        8,
        1,
        128,
        "maxFramesPerConnection",
      ),
    };
    this.#inspectProcess = testing.processInspector ?? defaultProcessInspector;
    this.#connect =
      testing.connect ??
      ((socketPath) => net.createConnection({ path: socketPath }));
    this.#now = testing.now ?? Date.now;
    this.#createId = testing.createId ?? randomUUID;
    this.#createGeneration =
      testing.createGeneration ?? createCodexRegistrationGeneration;
    this.#registryRename = testing.registryRename ?? rename;
    this.#registryOperationHook = testing.registryOperationHook;
    this.#userHome = assertAbsoluteConfiguredPath(
      testing.userHome ?? os.userInfo().homedir,
      "userHome",
    );
    this.#tempRoots = Object.freeze(
      [
        ...(testing.tempRoots ?? ["/tmp", "/private/tmp", os.tmpdir()]),
      ].map((root) => assertAbsoluteConfiguredPath(root, "tempRoot")),
    );
    this.#registryPublicationHook = testing.registryPublicationHook;
  }

  async #validatePrivateDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BridgeError(
        "UNSAFE_PEER_DIRECTORY",
        "The Claude peer directory is not an accessible real directory.",
      );
    }
  }

  async #readRegistryFile(
    registryPath: string,
  ): Promise<{ value: unknown; generation: FileGeneration }> {
    const before = await lstat(registryPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new BridgeError("REGISTRY_NOT_REGULAR", "Unsafe registry type.");
    }
    if (before.size > this.#limits.maxRegistryBytes) {
      throw new BridgeError("REGISTRY_TOO_LARGE", "Registry is too large.");
    }

    const handle = await open(
      registryPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      const beforeGeneration = generationOf(before);
      const openedGeneration = generationOf(opened);
      if (!sameFileGeneration(beforeGeneration, openedGeneration)) {
        throw new BridgeError("REGISTRY_RACED", "Registry changed while opening.");
      }
      const buffer = Buffer.alloc(this.#limits.maxRegistryBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > this.#limits.maxRegistryBytes) {
        throw new BridgeError("REGISTRY_TOO_LARGE", "Registry is too large.");
      }
      const after = await lstat(registryPath);
      const afterGeneration = generationOf(after);
      if (!sameFileGeneration(openedGeneration, afterGeneration)) {
        throw new BridgeError("REGISTRY_RACED", "Registry changed while reading.");
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, offset),
          ),
        ) as unknown;
      } catch {
        throw new BridgeError(
          "REGISTRY_INVALID_JSON",
          "Registry JSON is invalid.",
        );
      }
      return { value, generation: openedGeneration };
    } finally {
      await handle.close();
    }
  }

  async #validateSocket(
    socketPath: string,
    expectedPid: number,
  ): Promise<SocketGeneration> {
    if (
      path.dirname(socketPath) !== this.#socketDir ||
      path.basename(socketPath) !== `${expectedPid}.sock`
    ) {
      throw new BridgeError(
        "SOCKET_OUTSIDE_ROOT",
        "Peer socket is outside the exact trusted socket root.",
      );
    }
    const match = SOCKET_FILE_PATTERN.exec(path.basename(socketPath));
    if (match === null || parsePositiveInteger(match[1] ?? "") !== expectedPid) {
      throw new BridgeError(
        "SOCKET_OUTSIDE_ROOT",
        "Peer socket filename does not match its process.",
      );
    }
    const stat = await lstat(socketPath);
    if (stat.isSymbolicLink() || !stat.isSocket()) {
      throw new BridgeError("SOCKET_NOT_SOCKET", "Peer endpoint is not a socket.");
    }
    return { dev: stat.dev, ino: stat.ino };
  }

  async #bindingFromRegistry(
    registryPath: string,
    expectedPid: number,
    _existingTargetId?: string,
    onParsed?: () => void,
  ): Promise<TargetBinding> {
    const { value, generation: registryGeneration } =
      await this.#readRegistryFile(registryPath);
    if (isObject(value) && value.pid !== expectedPid) {
      throw new BridgeError(
        "PID_MISMATCH",
        "Registry filename and process identifier do not match.",
      );
    }
    const record = parseRegistryRecord(value, expectedPid);
    if (record === undefined) {
      throw new BridgeError(
        "REGISTRY_INVALID_SCHEMA",
        "Registry schema is incompatible.",
      );
    }
    onParsed?.();
    const processIdentity = await this.#inspectProcess(expectedPid);
    if (processIdentity === undefined) {
      throw new BridgeError("PID_NOT_LIVE", "Registry process is not live.");
    }
    if (processIdentity.uid !== this.#expectedUid) {
      throw new BridgeError(
        "PID_OWNER_MISMATCH",
        "Registry process owner is unsafe.",
      );
    }
    if (expectedPid === process.pid) {
      throw new BridgeError("SELF_TARGET", "The gateway cannot target itself.");
    }
    const socketGeneration = await this.#validateSocket(
      record.messagingSocketPath,
      expectedPid,
    );
    return {
      // Claude's native session UUID is the logical route identity. The
      // process, registry file, and socket below are replaceable transport
      // coordinates for that session and are revalidated before every write.
      targetId: record.sessionId,
      alias: record.name,
      registryPath,
      registryGeneration,
      socketGeneration,
      record,
      processGeneration: processIdentity.generation,
      expiresAt: this.#now() + this.#limits.targetLeaseMs,
    };
  }

  async discover(): Promise<ClaudePeerDiscovery> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    const previousTargets = [...this.#targets.values()];
    const nextTargets = new Map<string, TargetBinding>();
    const collidedSessionIds = new Set<string>();
    const rejected: Partial<Record<ClaudePeerRejectionCode, number>> = {};
    const reject = (code: ClaudePeerRejectionCode): void => {
      rejected[code] = (rejected[code] ?? 0) + 1;
    };
    const entries: import("node:fs").Dirent[] = [];
    let truncated = false;
    const directory = await opendir(this.#sessionsDir);
    for await (const entry of directory) {
      if (entries.length >= this.#limits.maxRegistryEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    if (truncated) reject("ENTRY_LIMIT_EXCEEDED");
    const bounded = entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, this.#limits.maxRegistryEntries);
    const peers: ClaudePeerDescriptor[] = [];
    let parseableRecords = 0;

    for (const entry of bounded) {
      const match = REGISTRY_FILE_PATTERN.exec(entry.name);
      if (match === null) {
        reject("INVALID_FILE_NAME");
        continue;
      }
      const pid = parsePositiveInteger(match[1] ?? "");
      if (pid === undefined) {
        reject("INVALID_FILE_NAME");
        continue;
      }
      const registryPath = path.join(this.#sessionsDir, entry.name);
      try {
        let binding = await this.#bindingFromRegistry(
          registryPath,
          pid,
          undefined,
          () => {
            parseableRecords += 1;
          },
        );
        const previous = previousTargets.find((candidate) =>
          sameTargetGeneration(candidate, binding),
        );
        if (previous !== undefined) {
          binding = {
            ...binding,
            targetId: previous.targetId,
            expiresAt: this.#now() + this.#limits.targetLeaseMs,
          };
        }
        if (
          collidedSessionIds.has(binding.targetId) ||
          nextTargets.has(binding.targetId)
        ) {
          nextTargets.delete(binding.targetId);
          collidedSessionIds.add(binding.targetId);
          const prior = peers.findIndex(
            (candidate) => candidate.targetId === binding.targetId,
          );
          if (prior >= 0) peers.splice(prior, 1);
          reject("SESSION_ID_COLLISION");
          continue;
        }
        nextTargets.set(binding.targetId, binding);
        peers.push({
          targetId: binding.targetId,
          alias: binding.alias,
          kind: binding.record.kind,
          status: binding.record.status,
          compatibility: "compatible",
        });
      } catch (error) {
        const code =
          error instanceof BridgeError
            ? (error.code as ClaudePeerRejectionCode)
            : "REGISTRY_RACED";
        if (
          (claudePeerRejectionCodes as readonly string[]).includes(code)
        ) {
          reject(code);
        } else {
          reject("REGISTRY_RACED");
        }
      }
    }
    this.#targets.clear();
    for (const [targetId, binding] of nextTargets) {
      this.#targets.set(targetId, binding);
    }
    for (const targetId of this.#workspacePolicies.keys()) {
      if (!nextTargets.has(targetId)) this.#workspacePolicies.delete(targetId);
    }
    return {
      peers,
      rejected,
      truncated,
      entriesScanned: bounded.length,
      parseableRecords,
    };
  }

  async #revalidateBinding(binding: TargetBinding): Promise<TargetBinding> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    if (binding.expiresAt < this.#now()) {
      this.#targets.delete(binding.targetId);
      this.#workspacePolicies.delete(binding.targetId);
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_STALE",
        "The Claude peer discovery lease expired; discover again.",
        true,
      );
    }
    const current = await this.#bindingFromRegistry(
      binding.registryPath,
      binding.record.pid,
      binding.targetId,
    );
    if (
      !sameTargetGeneration(binding, current)
    ) {
      this.#targets.delete(binding.targetId);
      this.#workspacePolicies.delete(binding.targetId);
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_CHANGED",
        "The Claude peer generation changed; discover again.",
        true,
      );
    }
    current.expiresAt = binding.expiresAt;
    this.#targets.set(current.targetId, current);
    return current;
  }

  async #canonicalStateRoot(stateRoot: string): Promise<{
    path: string;
    generation: DirectoryGeneration;
  }> {
    try {
      const configured = assertAbsoluteConfiguredPath(
        stateRoot,
        "controllerStateRoot",
      );
      const before = await lstat(configured);
      if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        before.uid !== this.#expectedUid ||
        exactMode(before.mode) !== 0o700
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_STATE_ROOT_UNSAFE",
          "The controller state root failed its canonical ownership policy.",
        );
      }
      const canonical = await realpath(configured);
      const after = await lstat(configured);
      if (
        canonical !== configured ||
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        after.uid !== this.#expectedUid ||
        exactMode(after.mode) !== 0o700 ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_STATE_ROOT_UNSAFE",
          "The controller state root changed or is not canonical.",
        );
      }
      return {
        path: canonical,
        generation: { dev: after.dev, ino: after.ino },
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        "CLAUDE_PEER_STATE_ROOT_UNSAFE",
        "The controller state root could not be safely attested.",
      );
    }
  }

  async #assertBindingWorkspaceDisjoint(
    binding: TargetBinding,
    _canonicalStateRoot: string,
  ): Promise<{ path: string; generation: DirectoryGeneration }> {
    try {
      const cwd = binding.record.cwd;
      const before = await lstat(cwd);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_UNSAFE",
          "The selected Claude workspace failed its directory policy.",
        );
      }
      const canonicalWorkspace = await realpath(cwd);
      const homeBefore = await lstat(this.#userHome);
      const canonicalHome = await realpath(this.#userHome);
      const homeAfter = await lstat(this.#userHome);
      if (
        canonicalWorkspace !== cwd ||
        homeBefore.isSymbolicLink() ||
        !homeBefore.isDirectory() ||
        canonicalHome !== this.#userHome ||
        homeBefore.uid !== this.#expectedUid ||
        (exactMode(homeBefore.mode) & 0o022) !== 0 ||
        homeAfter.isSymbolicLink() ||
        !homeAfter.isDirectory() ||
        homeAfter.uid !== this.#expectedUid ||
        (exactMode(homeAfter.mode) & 0o022) !== 0 ||
        homeBefore.dev !== homeAfter.dev ||
        homeBefore.ino !== homeAfter.ino
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_UNSAFE",
          "The selected Claude workspace or local home is non-canonical.",
        );
      }
      const filesystemRoot = path.parse(canonicalWorkspace).root;
      if (canonicalWorkspace === filesystemRoot) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_BROAD",
          "The selected Claude workspace is broader than the safe local boundary.",
        );
      }
      if (
        this.#tempRoots.some(
          (tempRoot) =>
            pathContains(tempRoot, canonicalWorkspace) ||
            pathContains(canonicalWorkspace, tempRoot),
        )
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_BROAD",
          "The selected Claude workspace is inside or contains a temporary root.",
        );
      }
      const after = await lstat(cwd);
      if (
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        before.uid !== this.#expectedUid ||
        after.uid !== this.#expectedUid ||
        (exactMode(before.mode) & 0o022) !== 0 ||
        (exactMode(after.mode) & 0o022) !== 0 ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_UNSAFE",
          "The selected Claude workspace changed or failed its owner and mode policy.",
        );
      }
      return {
        path: canonicalWorkspace,
        generation: { dev: after.dev, ino: after.ino },
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        "CLAUDE_PEER_WORKSPACE_UNSAFE",
        "The selected Claude workspace could not be safely attested.",
      );
    }
  }

  /**
   * Required selection gate. It reveals no workspace data and binds the
   * opaque target to one canonical controller state root for later sends.
   */
  async assertTargetWorkspaceDisjoint(
    targetId: string,
    controllerStateRoot: string,
  ): Promise<void> {
    const target = this.#targets.get(targetId);
    if (target === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_UNKNOWN",
        "The Claude peer target is unknown; discover it first.",
        true,
      );
    }
    const binding = await this.#revalidateBinding(target);
    const state = await this.#canonicalStateRoot(
      controllerStateRoot,
    );
    const workspace = await this.#assertBindingWorkspaceDisjoint(
      binding,
      state.path,
    );
    const existing = this.#workspacePolicies.get(targetId);
    if (existing !== undefined) {
      if (
        existing.stateRoot !== state.path ||
        !sameDirectoryGeneration(existing.stateGeneration, state.generation)
      ) {
        this.#workspacePolicies.delete(targetId);
        throw new BridgeError(
          "CLAUDE_PEER_STATE_ROOT_CHANGED",
          "The selected Claude target is already bound to another controller state generation.",
        );
      }
      if (
        existing.workspace !== workspace.path ||
        !sameDirectoryGeneration(
          existing.workspaceGeneration,
          workspace.generation,
        )
      ) {
        this.#workspacePolicies.delete(targetId);
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_CHANGED",
          "The selected Claude workspace generation changed; select it again.",
          true,
        );
      }
    }
    this.#workspacePolicies.set(targetId, {
      stateRoot: state.path,
      stateGeneration: state.generation,
      workspace: workspace.path,
      workspaceGeneration: workspace.generation,
    });
  }

  async #resolveReplyAddress(address: string): Promise<TargetBinding> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    if (!address.startsWith("uds:")) {
      throw new BridgeError(
        "UNREGISTERED_REPLY_ADDRESS",
        "Only local registered UDS reply addresses are accepted.",
      );
    }
    const socketPath = address.slice(4);
    if (path.dirname(socketPath) !== this.#socketDir) {
      throw new BridgeError(
        "UNREGISTERED_REPLY_ADDRESS",
        "Reply address is outside the trusted socket root.",
      );
    }
    const socketMatch = SOCKET_FILE_PATTERN.exec(path.basename(socketPath));
    const pid =
      socketMatch === null
        ? undefined
        : parsePositiveInteger(socketMatch[1] ?? "");
    if (pid === undefined) {
      throw new BridgeError(
        "UNREGISTERED_REPLY_ADDRESS",
        "Reply address is not a registered Claude peer socket.",
      );
    }
    const registryPath = path.join(this.#sessionsDir, `${pid}.json`);
    let binding = await this.#bindingFromRegistry(registryPath, pid);
    if (binding.record.messagingSocketPath !== socketPath) {
      throw new BridgeError(
        "UNREGISTERED_REPLY_ADDRESS",
        "Reply address does not match its live registry generation.",
      );
    }
    const previous = [...this.#targets.values()].find((candidate) =>
      sameTargetGeneration(candidate, binding),
    );
    if (previous !== undefined) {
      binding = {
        ...binding,
        targetId: previous.targetId,
        expiresAt: this.#now() + this.#limits.targetLeaseMs,
      };
    }
    this.#targets.set(binding.targetId, binding);
    return binding;
  }

  /**
   * Converts a transient CLAUDE_CODE_MESSAGING_SOCKET-style address into the
   * owning logical Claude session UUID. Callers discard the socket address;
   * every later delivery resolves the UUID to fresh transport coordinates.
   */
  async resolveReplyAddress(address: string): Promise<ClaudePeerDescriptor> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    const binding = await this.#resolveReplyAddress(address);
    return {
      targetId: binding.targetId,
      alias: binding.alias,
      kind: binding.record.kind,
      status: binding.record.status,
      compatibility: "compatible",
    };
  }

  async #listen(
    options: ClaudePeerListenerOptions,
    preparedGeneration?: string,
  ): Promise<ClaudePeerListener> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    const generation = preparedGeneration ?? this.#createGeneration();
    if (!isCodexRegistrationGeneration(generation)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_GENERATION",
        "A native Codex listener requires one bounded opaque generation.",
      );
    }
    if (
      [...this.#listeners].some(
        (listener) =>
          !listener.closed && listener.generation === generation,
      )
    ) {
      throw new BridgeError(
        "CODEX_PEER_GENERATION_EXISTS",
        "A live native Codex listener already owns this exact generation.",
      );
    }
    const listener = await ClaudePeerListener.create({
      sessionsDir: this.#sessionsDir,
      socketDir: this.#socketDir,
      expectedUid: this.#expectedUid,
      limits: this.#limits,
      createId: this.#createId,
      connect: this.#connect,
      now: this.#now,
      locale: this.#locale,
      deliveryNotices: this.#deliveryNotices,
      attestedClaudeCodeVersion: this.#attestedClaudeCodeVersion,
      resolveReplyAddress: async (address) =>
        await this.#resolveReplyAddress(address),
      resolveSessionBinding: async (sessionId) => {
        // Native receipt handles retain only the stable Claude session UUID.
        // Registry names, PIDs, and sockets are replaceable coordinates, so
        // refresh discovery before every receipt or progress write.
        const discovery = await this.discover();
        if (discovery.truncated) {
          throw new BridgeError(
            "CLAUDE_PEER_DISCOVERY_INCOMPLETE",
            "The Claude peer receipt target cannot be proven from an incomplete registry scan.",
            true,
          );
        }
        const target = this.#targets.get(sessionId);
        if (target === undefined) {
          throw new BridgeError(
            "CLAUDE_PEER_TARGET_UNKNOWN",
            "The Claude peer receipt target is no longer discoverable.",
            true,
          );
        }
        return await this.#revalidateBinding(target);
      },
      revalidateBinding: async (binding) =>
        await this.#revalidateBinding(binding),
      options,
      owner: this.#listenerOwner,
      generation,
      registryRename: this.#registryRename,
      ...(this.#registryOperationHook === undefined
        ? {}
        : { registryOperationHook: this.#registryOperationHook }),
      runRegistryMutation: async (operation) =>
        await this.#registryMutex.run("codex-registry", operation),
      ...(preparedGeneration === undefined ? {} : { preparedGeneration }),
      ...(this.#registryPublicationHook === undefined
        ? {}
        : { registryPublicationHook: this.#registryPublicationHook }),
      onClosed: () => this.#listeners.delete(listener),
    });
    this.#listeners.add(listener);
    return listener;
  }

  async listen(options: ClaudePeerListenerOptions): Promise<ClaudePeerListener> {
    return await this.#listen(options);
  }

  async listenPrepared(
    generation: string,
    options: ClaudePeerListenerOptions,
  ): Promise<ClaudePeerListener> {
    if (!isCodexRegistrationGeneration(generation)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_GENERATION",
        "A prepared native Codex listener requires one bounded opaque generation.",
      );
    }
    return await this.#listen(options, generation);
  }

  async send(
    targetId: string,
    content: string,
    options: ClaudePeerSendOptions = {},
  ): Promise<ClaudePeerSendResult> {
    // Session UUIDs survive registry rewrites, renames, and endpoint rotation.
    // Refresh the replaceable transport coordinates before any write begins.
    await this.discover();
    const target = this.#targets.get(targetId);
    if (target === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_UNKNOWN",
        "The Claude peer target is unknown; discover it first.",
        true,
      );
    }
    const binding = await this.#revalidateBinding(target);
    const workspacePolicy = this.#workspacePolicies.get(targetId);
    if (workspacePolicy === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_WORKSPACE_UNATTESTED",
        "The Claude peer workspace must pass selection validation before send.",
      );
    }
    try {
      const state = await this.#canonicalStateRoot(workspacePolicy.stateRoot);
      const workspace = await this.#assertBindingWorkspaceDisjoint(
        binding,
        state.path,
      );
      if (
        !sameDirectoryGeneration(
          workspacePolicy.stateGeneration,
          state.generation,
        )
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_STATE_ROOT_CHANGED",
          "The controller state root generation changed; select the target again.",
          true,
        );
      }
      if (
        workspacePolicy.workspace !== workspace.path ||
        !sameDirectoryGeneration(
          workspacePolicy.workspaceGeneration,
          workspace.generation,
        )
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_WORKSPACE_CHANGED",
          "The selected Claude workspace generation changed; select it again.",
          true,
        );
      }
    } catch (error) {
      this.#workspacePolicies.delete(targetId);
      throw error;
    }
    const messageId = this.#createId();
    if (!UUID_PATTERN.test(messageId)) {
      throw new BridgeError(
        "INVALID_PEER_MESSAGE_ID",
        "The configured ID source did not produce a UUID.",
      );
    }
    const listener = options.listener;
    if (listener !== undefined && !this.#listeners.has(listener)) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_FOREIGN",
        "The reply listener is not owned by this adapter.",
      );
    }
    const frame = encodeClaudePeerUserFrame({
      messageId,
      content,
      ...(listener === undefined ? {} : { from: listener.address }),
      maxFrameBytes: this.#limits.maxFrameBytes,
    });
    if (
      options.receiptDeadlineAt !== undefined &&
      (!Number.isSafeInteger(options.receiptDeadlineAt) ||
        options.receiptDeadlineAt < 0)
    ) {
      throw new BridgeError(
        "INVALID_PEER_RECEIPT_DEADLINE",
        "The Claude peer receipt deadline must be an epoch-millisecond timestamp.",
      );
    }
    if (
      options.receiptDeadlineAt !== undefined &&
      options.receiptDeadlineAt <= this.#now()
    ) {
      throw new BridgeError(
        "CLAUDE_PEER_MESSAGE_EXPIRED",
        "The Claude peer message deadline elapsed before any socket write.",
        true,
      );
    }
    if (listener !== undefined) {
      listener.track(messageId, binding, options.receiptDeadlineAt);
    }

    await invokeObservationalHook(options.onTransportStatus, {
      messageId,
      status: "connecting",
    });
    if (
      options.receiptDeadlineAt !== undefined &&
      options.receiptDeadlineAt <= this.#now()
    ) {
      listener?.untrack(messageId);
      await invokeObservationalHook(options.onTransportStatus, {
        messageId,
        status: "not_written",
      });
      throw new BridgeError(
        "CLAUDE_PEER_MESSAGE_EXPIRED",
        "The Claude peer message deadline elapsed before any socket write.",
        true,
      );
    }
    let written = false;
    let writeStarted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = this.#connect(binding.record.messagingSocketPath);
        const timeoutMs = Math.max(
          1,
          Math.min(
            this.#limits.connectTimeoutMs,
            options.receiptDeadlineAt === undefined
              ? this.#limits.connectTimeoutMs
              : options.receiptDeadlineAt - this.#now(),
          ),
        );
        const timer = setTimeout(() => {
          socket.destroy();
          const deadlineElapsed =
            options.receiptDeadlineAt !== undefined &&
            this.#now() >= options.receiptDeadlineAt;
          reject(
            new BridgeError(
              writeStarted
                ? "CLAUDE_PEER_WRITE_AMBIGUOUS"
                : deadlineElapsed
                  ? "CLAUDE_PEER_MESSAGE_EXPIRED"
                  : "CLAUDE_PEER_CONNECT_TIMEOUT",
              writeStarted
                ? "The Claude peer write began but did not finish in time; do not retry automatically."
                : deadlineElapsed
                  ? "The Claude peer message deadline elapsed before any socket write."
                  : "The Claude peer socket did not accept the write in time.",
              !writeStarted,
            ),
          );
        }, timeoutMs);
        timer.unref();
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("connect", () => {
          if (
            options.receiptDeadlineAt !== undefined &&
            options.receiptDeadlineAt <= this.#now()
          ) {
            clearTimeout(timer);
            socket.destroy();
            reject(
              new BridgeError(
                "CLAUDE_PEER_MESSAGE_EXPIRED",
                "The Claude peer message deadline elapsed before any socket write.",
                true,
              ),
            );
            return;
          }
          writeStarted = true;
          listener?.recordTransportOutcome(
            messageId,
            "transport_uncertain",
          );
          void invokeObservationalHook(options.onTransportStatus, {
            messageId,
            status: "write_started",
          });
          try {
            socket.end(frame, () => {
              written = true;
              clearTimeout(timer);
              socket.destroy();
              resolve();
            });
          } catch (error) {
            clearTimeout(timer);
            socket.destroy();
            reject(error);
          }
        });
      });
    } catch (error) {
      if (listener !== undefined) {
        if (writeStarted) {
          listener.recordTransportOutcome(messageId, "transport_uncertain");
        } else {
          listener.untrack(messageId);
        }
      }
      await invokeObservationalHook(
        options.onTransportStatus,
        {
          messageId,
          status: writeStarted ? "ambiguous" : "not_written",
        },
      );
      if (error instanceof BridgeError) throw error;
      if (writeStarted) {
        throw new BridgeError(
          "CLAUDE_PEER_WRITE_AMBIGUOUS",
          "The Claude peer write began but its outcome is ambiguous; do not retry automatically.",
        );
      }
      throw new BridgeError(
        "CLAUDE_PEER_WRITE_FAILED",
        "The Claude peer message was not confirmed written.",
        true,
      );
    }
    if (!written) {
      listener?.recordTransportOutcome(messageId, "transport_uncertain");
      throw new BridgeError(
        "CLAUDE_PEER_WRITE_AMBIGUOUS",
        "The Claude peer write outcome is ambiguous; do not retry automatically.",
      );
    }
    listener?.recordTransportOutcome(messageId, "transport_written");
    await invokeObservationalHook(options.onTransportStatus, {
      messageId,
      status: "transport_written",
    });
    return {
      messageId,
      transportStatus: "transport_written",
      receiptStatus: listener === undefined ? "unavailable" : "pending",
    };
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#listeners].map(async (listener) => listener.close()),
    );
    this.#targets.clear();
    this.#workspacePolicies.clear();
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
  }
}

type ListenerCreateOptions = {
  sessionsDir: string;
  socketDir: string;
  expectedUid: number;
  limits: AdapterLimits;
  createId: () => string;
  connect: ClaudePeerConnect;
  now: () => number;
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  attestedClaudeCodeVersion: string;
  resolveReplyAddress: (address: string) => Promise<TargetBinding>;
  resolveSessionBinding: (sessionId: string) => Promise<TargetBinding>;
  revalidateBinding: (binding: TargetBinding) => Promise<TargetBinding>;
  options: ClaudePeerListenerOptions;
  owner: object;
  generation: string;
  registryRename: (source: string, destination: string) => Promise<void>;
  registryOperationHook?: ClaudePeerAdapterTestOverrides["registryOperationHook"];
  runRegistryMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  preparedGeneration?: string;
  registryPublicationHook?: (
    stage: "before_rename" | "after_rename",
  ) => void | Promise<void>;
  onClosed: () => void;
};

type AdvertisedCodexRegistryRecord = {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart: string;
  version: string;
  peerProtocol: 1;
  kind: "interactive";
  entrypoint: "cli";
  messagingSocketPath: string;
  name: string;
  status: ClaudePeerStatus;
  updatedAt: number;
  statusUpdatedAt: number;
};

export class ClaudePeerListener {
  readonly address: string;
  readonly generation: string;
  readonly #sessionsDir: string;
  readonly #sessionsGeneration: DirectoryGeneration;
  readonly #expectedUid: number;
  readonly #socketPath: string;
  readonly #socketGeneration: SocketGeneration;
  readonly #server: Server;
  readonly #limits: AdapterLimits;
  readonly #createId: () => string;
  readonly #connect: ClaudePeerConnect;
  readonly #now: () => number;
  readonly #locale: DashboardLocale;
  readonly #deliveryNotices: GatewayDeliveryNoticeMode;
  readonly #attestedClaudeCodeVersion: string;
  readonly #resolveReplyAddress: (address: string) => Promise<TargetBinding>;
  readonly #resolveSessionBinding: (
    sessionId: string,
  ) => Promise<TargetBinding>;
  readonly #revalidateBinding: (binding: TargetBinding) => Promise<TargetBinding>;
  readonly #options: ClaudePeerListenerOptions;
  readonly #owner: object;
  readonly #registryRename: (
    source: string,
    destination: string,
  ) => Promise<void>;
  readonly #registryOperationHook:
    | ClaudePeerAdapterTestOverrides["registryOperationHook"]
    | undefined;
  readonly #runRegistryMutation: <T>(
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly #preparedGeneration: string | undefined;
  readonly #registryPublicationHook:
    | ((stage: "before_rename" | "after_rename") => void | Promise<void>)
    | undefined;
  readonly #onClosed: () => void;
  readonly #connections = new Set<Socket>();
  readonly #pending = new Map<string, PendingReceipt>();
  readonly #inboundReceipts = new Map<string, InboundReceipt>();
  // One bounded exception slot owns an overflow message only long enough to
  // return its terminal capacity rejection. It never forwards content to the
  // service, retries only proven pre-write failures, and is released after a
  // successful, ambiguous, non-retryable, or exhausted write.
  #capacitySettlement: CapacitySettlement | undefined;
  #queuedFrames = 0;
  #inboundQuiesced = false;
  readonly #inboundQuiesceWaiters = new Set<() => void>();
  #advertisedRecord: AdvertisedCodexRegistryRecord | undefined;
  #advertisedGeneration: FileGeneration | undefined;
  #preparedRecord: AdvertisedCodexRegistryRecord | undefined;
  #publicationAttempted = false;
  #publicationSourceGeneration: FileGeneration | undefined;
  #publicationConfirmed = false;
  #activationGranted = false;
  #closing = false;
  #closed = false;
  #closeOperation: Promise<void> | undefined;

  private constructor(
    options: ListenerCreateOptions,
    server: Server,
    socketPath: string,
    generation: SocketGeneration,
    sessionsGeneration: DirectoryGeneration,
  ) {
    this.address = `uds:${socketPath}`;
    this.generation = options.generation;
    this.#sessionsDir = options.sessionsDir;
    this.#sessionsGeneration = sessionsGeneration;
    this.#expectedUid = options.expectedUid;
    this.#socketPath = socketPath;
    this.#socketGeneration = generation;
    this.#server = server;
    this.#limits = options.limits;
    this.#createId = options.createId;
    this.#connect = options.connect;
    this.#now = options.now;
    this.#locale = options.locale;
    this.#deliveryNotices = options.deliveryNotices;
    this.#attestedClaudeCodeVersion = options.attestedClaudeCodeVersion;
    this.#resolveReplyAddress = options.resolveReplyAddress;
    this.#resolveSessionBinding = options.resolveSessionBinding;
    this.#revalidateBinding = options.revalidateBinding;
    this.#options = options.options;
    this.#owner = options.owner;
    this.#registryRename = options.registryRename;
    this.#registryOperationHook = options.registryOperationHook;
    this.#runRegistryMutation = options.runRegistryMutation;
    this.#preparedGeneration = options.preparedGeneration;
    this.#registryPublicationHook = options.registryPublicationHook;
    this.#onClosed = options.onClosed;
    this.#inboundQuiesced = options.preparedGeneration !== undefined;
    this.#activationGranted = options.preparedGeneration === undefined;
  }

  static async create(
    options: ListenerCreateOptions,
  ): Promise<ClaudePeerListener> {
    // One gateway process owns one native peer socket. It may advertise one
    // registered Codex task through Claude's native session registry.
    const socketPath = path.join(
      options.socketDir,
      options.preparedGeneration === undefined
        ? `${process.pid}.sock`
        : `${process.pid}.${options.preparedGeneration}.sock`,
    );
    try {
      await lstat(socketPath);
      throw new BridgeError(
        "CLAUDE_PEER_CALLBACK_EXISTS",
        "The gateway callback path already exists; it will not be unlinked.",
      );
    } catch (error) {
      if (
        error instanceof BridgeError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }

    let listener: ClaudePeerListener | undefined;
    const server = net.createServer((socket) => {
      if (listener === undefined) {
        socket.destroy();
        return;
      }
      listener.#accept(socket);
    });
    server.on("error", () => {
      if (listener !== undefined) void listener.#notice("CALLBACK_ERROR");
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    let createdGeneration: SocketGeneration | undefined;
    try {
      const created = await lstat(socketPath);
      if (
        !created.isSocket() ||
        created.isSymbolicLink()
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_UNSAFE",
          "The newly bound callback path did not satisfy its type and ownership policy.",
        );
      }
      createdGeneration = { dev: created.dev, ino: created.ino };
      if (created.uid !== options.expectedUid) {
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_UNSAFE",
          "The newly bound callback path did not satisfy its type and ownership policy.",
        );
      }
      await chmod(socketPath, 0o600);
      const attested = await lstat(socketPath);
      if (
        !attested.isSocket() ||
        attested.isSymbolicLink() ||
        attested.uid !== options.expectedUid ||
        exactMode(attested.mode) !== 0o600 ||
        !sameSocketGeneration(
          { dev: attested.dev, ino: attested.ino },
          createdGeneration,
        )
      ) {
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_UNSAFE",
          "The gateway callback socket did not satisfy its ownership policy.",
        );
      }
      const sessions = await lstat(options.sessionsDir);
      if (
        sessions.isSymbolicLink() ||
        !sessions.isDirectory() ||
        sessions.uid !== options.expectedUid ||
        exactMode(sessions.mode) !== 0o700
      ) {
        throw new BridgeError(
          "UNSAFE_PEER_DIRECTORY",
          "The native peer registry directory failed its ownership policy.",
        );
      }
      listener = new ClaudePeerListener(
        options,
        server,
        socketPath,
        createdGeneration,
        { dev: sessions.dev, ino: sessions.ino },
      );
      return listener;
    } catch (error) {
      let stillOwned = false;
      if (createdGeneration !== undefined) {
        try {
          const current = await lstat(socketPath);
          stillOwned =
            current.isSocket() &&
            sameSocketGeneration(
              { dev: current.dev, ino: current.ino },
              createdGeneration,
            );
        } catch {
          // A missing or unreadable path cannot be safely unlinked by
          // net.Server.close(), which deletes by pathname.
        }
      }
      if (stillOwned) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } else {
        server.unref();
      }
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closing || this.#closed;
  }

  #isClosingOrClosed(): boolean {
    return this.#closing || this.#closed;
  }

  #registryPath(): string {
    return path.join(this.#sessionsDir, `${process.pid}.json`);
  }

  #registryTemporaryPath(): string {
    return path.join(
      this.#sessionsDir,
      `.${process.pid}.${this.generation}.registry.tmp`,
    );
  }

  #serializeRecord(record: AdvertisedCodexRegistryRecord): string {
    return `${JSON.stringify(record)}\n`;
  }

  #recordBelongsToThisListener(
    record: AdvertisedCodexRegistryRecord,
  ): boolean {
    return (
      record.pid === process.pid &&
      UUID_PATTERN.test(record.sessionId) &&
      record.messagingSocketPath === this.#socketPath &&
      record.version === this.#attestedClaudeCodeVersion &&
      record.peerProtocol === CLAUDE_PEER_COMPATIBILITY.peerProtocol &&
      record.kind === "interactive" &&
      record.entrypoint === "cli" &&
      record.name.startsWith("codex-") &&
      ALIAS_PATTERN.test(record.name)
    );
  }

  async #assertRegistryDirectory(): Promise<void> {
    const current = await lstat(this.#sessionsDir);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.uid !== this.#expectedUid ||
      exactMode(current.mode) !== 0o700 ||
      !sameDirectoryGeneration(
        { dev: current.dev, ino: current.ino },
        this.#sessionsGeneration,
      )
    ) {
      throw new BridgeError(
        "UNSAFE_PEER_DIRECTORY",
        "The native peer registry directory changed or failed its ownership policy.",
      );
    }
  }

  async #readRegistryExact(): Promise<
    | Readonly<{ serialized: string; generation: FileGeneration }>
    | undefined
  > {
    await this.#assertRegistryDirectory();
    const registryPath = this.#registryPath();
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(registryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.uid !== this.#expectedUid ||
      exactMode(before.mode) !== 0o600 ||
      before.size > this.#limits.maxRegistryBytes
    ) {
      throw new BridgeError(
        "REGISTRY_RACED",
        "The native Codex registry record failed its exact ownership policy.",
      );
    }
    const beforeGeneration = generationOf(before);
    const handle = await open(
      registryPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      const openedGeneration = generationOf(opened);
      if (
        !opened.isFile() ||
        opened.uid !== this.#expectedUid ||
        exactMode(opened.mode) !== 0o600 ||
        !sameFileGeneration(beforeGeneration, openedGeneration)
      ) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The native Codex registry record changed while opening.",
        );
      }
      const serialized = await handle.readFile({ encoding: "utf8" });
      if (byteLength(serialized) > this.#limits.maxRegistryBytes) {
        throw new BridgeError(
          "REGISTRY_TOO_LARGE",
          "The native Codex registry record exceeded its bound.",
        );
      }
      const after = await lstat(registryPath);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.uid !== this.#expectedUid ||
        exactMode(after.mode) !== 0o600 ||
        !sameFileGeneration(openedGeneration, generationOf(after))
      ) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The native Codex registry record changed while reading.",
        );
      }
      return { serialized, generation: openedGeneration };
    } finally {
      await handle.close();
    }
  }

  async #recordMatches(
    record: AdvertisedCodexRegistryRecord,
    generation?: FileGeneration,
  ): Promise<
    | Readonly<{ matches: true; generation: FileGeneration }>
    | Readonly<{ matches: false }>
  > {
    try {
      const current = await this.#readRegistryExact();
      if (
        current === undefined ||
        current.serialized !== this.#serializeRecord(record) ||
        (generation !== undefined &&
          !sameFileGeneration(current.generation, generation))
      ) {
        return { matches: false };
      }
      return { matches: true, generation: current.generation };
    } catch {
      return { matches: false };
    }
  }

  async #createRegistryTemporary(
    record: AdvertisedCodexRegistryRecord,
  ): Promise<Readonly<{ path: string; generation: FileGeneration }>> {
    await this.#assertRegistryDirectory();
    const temporaryPath = this.#registryTemporaryPath();
    await writeFile(temporaryPath, this.#serializeRecord(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    let generation: FileGeneration | undefined;
    try {
      const created = await lstat(temporaryPath);
      if (
        created.isSymbolicLink() ||
        !created.isFile() ||
        created.uid !== this.#expectedUid ||
        exactMode(created.mode) !== 0o600
      ) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The native Codex temporary registry record is unsafe.",
        );
      }
      generation = generationOf(created);
      const handle = await open(
        temporaryPath,
        fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      );
      try {
        const openedStat = await handle.stat();
        const opened = generationOf(openedStat);
        if (
          !openedStat.isFile() ||
          openedStat.uid !== this.#expectedUid ||
          exactMode(openedStat.mode) !== 0o600 ||
          !sameFileGeneration(generation, opened)
        ) {
          throw new BridgeError(
            "REGISTRY_RACED",
            "The native Codex temporary registry record changed while opening.",
          );
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path: temporaryPath, generation };
    } catch (error) {
      if (generation !== undefined) {
        await this.#cleanupOwnedFile(temporaryPath, generation).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async #cleanupOwnedFile(
    candidate: string,
    generation: FileGeneration,
  ): Promise<void> {
    try {
      const current = await lstat(candidate);
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.uid === this.#expectedUid &&
        exactMode(current.mode) === 0o600 &&
        sameFileGeneration(generationOf(current), generation)
      ) {
        await unlink(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #syncRegistryDirectory(): Promise<void> {
    await this.#assertRegistryDirectory();
    const handle = await open(this.#sessionsDir, fsConstants.O_RDONLY);
    try {
      const opened = await handle.stat();
      if (
        !opened.isDirectory() ||
        opened.uid !== this.#expectedUid ||
        exactMode(opened.mode) !== 0o700 ||
        !sameDirectoryGeneration(
          { dev: opened.dev, ino: opened.ino },
          this.#sessionsGeneration,
        )
      ) {
        throw new BridgeError(
          "UNSAFE_PEER_DIRECTORY",
          "The native peer registry directory changed while syncing.",
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #newAdvertisedRecord(
    name: string,
    cwd: string,
  ): AdvertisedCodexRegistryRecord {
    if (!name.startsWith("codex-") || !ALIAS_PATTERN.test(name)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_NAME",
        "A native Codex peer name must start with codex-.",
      );
    }
    if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_CWD",
        "A native Codex peer requires an absolute working directory.",
      );
    }
    const sessionId = this.#createId();
    if (!UUID_PATTERN.test(sessionId)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_SESSION_ID",
        "The configured ID source did not produce a native peer session UUID.",
      );
    }
    const now = Date.now();
    return {
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: now,
      procStart: new Date(now - process.uptime() * 1_000).toString(),
      version: this.#attestedClaudeCodeVersion,
      peerProtocol: CLAUDE_PEER_COMPATIBILITY.peerProtocol,
      kind: "interactive",
      entrypoint: "cli",
      messagingSocketPath: this.#socketPath,
      name,
      status: "idle",
      updatedAt: now,
      statusUpdatedAt: now,
    };
  }

  async #mutateRegistry<T>(
    operation: "advertise" | "publish" | "status" | "unadvertise",
    mutation: () => Promise<T>,
  ): Promise<T> {
    return await this.#runRegistryMutation(async () => {
      await this.#registryOperationHook?.({
        operation,
        phase: "entered",
        generation: this.generation,
      });
      try {
        return await mutation();
      } finally {
        await this.#registryOperationHook?.({
          operation,
          phase: "exited",
          generation: this.generation,
        });
      }
    });
  }

  async advertise(name: string, cwd: string): Promise<void> {
    await this.#mutateRegistry("advertise", async () => {
      if (this.#isClosingOrClosed()) {
        throw new BridgeError(
          "CLAUDE_PEER_LISTENER_CLOSED",
          "The Claude peer callback listener is closed.",
        );
      }
      if (this.#preparedGeneration !== undefined) {
        throw new BridgeError(
          "CODEX_PEER_PREPARED_NOT_ACTIVE",
          "A prepared native Codex listener must use atomic succession publication.",
        );
      }
      if (
        this.#advertisedRecord !== undefined &&
        this.#advertisedRecord.name !== name
      ) {
        throw new BridgeError(
          "CODEX_PEER_ALREADY_ADVERTISED",
          "This gateway process already advertises another Codex peer.",
        );
      }
      if (this.#advertisedRecord?.name === name) return;
      const record = this.#newAdvertisedRecord(name, cwd);
      await this.#assertRegistryDirectory();
      await writeFile(this.#registryPath(), this.#serializeRecord(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const exact = await this.#recordMatches(record);
      if (!exact.matches) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The native Codex registry record could not be exactly confirmed.",
        );
      }
      this.#advertisedRecord = record;
      this.#advertisedGeneration = exact.generation;
    });
  }

  async #classifyPublication(
    current: ClaudePeerListener,
    record: AdvertisedCodexRegistryRecord,
  ): Promise<ClaudePeerRegistryPublicationOutcome> {
    const sourceGeneration = this.#publicationSourceGeneration;
    if (sourceGeneration !== undefined) {
      const published = await this.#recordMatches(record, sourceGeneration);
      if (published.matches) {
        this.#advertisedRecord = record;
        this.#advertisedGeneration = published.generation;
        this.#publicationConfirmed = true;
        return "published";
      }
    }
    return (await this.#oldPublicationStillPresent(current))
      ? "not_published"
      : "unknown";
  }

  async #oldPublicationStillPresent(
    current: ClaudePeerListener,
  ): Promise<boolean> {
    const oldRecord = current.#advertisedRecord;
    const oldGeneration = current.#advertisedGeneration;
    if (oldRecord === undefined || oldGeneration === undefined) return false;
    return (
      await current.#recordMatches(oldRecord, oldGeneration)
    ).matches;
  }

  async publishReplacing(
    current: ClaudePeerListener,
    name: string,
    cwd: string,
  ): Promise<ClaudePeerRegistryPublicationOutcome> {
    return await this.#mutateRegistry(
      "publish",
      async () => await this.#publishReplacingLocked(current, name, cwd),
    );
  }

  async #publishReplacingLocked(
    current: ClaudePeerListener,
    name: string,
    cwd: string,
  ): Promise<ClaudePeerRegistryPublicationOutcome> {
    if (
      this.#isClosingOrClosed() ||
      current.#isClosingOrClosed() ||
      this === current ||
      this.#preparedGeneration === undefined ||
      this.generation === current.generation ||
      !current.#activationGranted ||
      this.#owner !== current.#owner ||
      this.#sessionsDir !== current.#sessionsDir ||
      this.#expectedUid !== current.#expectedUid ||
      !sameDirectoryGeneration(
        this.#sessionsGeneration,
        current.#sessionsGeneration,
      )
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_INVALID",
        "Native Codex listener succession requires two live generations from one adapter owner.",
      );
    }
    if (!this.#inboundQuiesced || !current.#inboundQuiesced) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_NOT_QUIESCED",
        "Both native Codex listener generations must be inbound-quiesced before publication.",
      );
    }
    if (
      current.#advertisedRecord === undefined ||
      current.#advertisedGeneration === undefined ||
      !current.#recordBelongsToThisListener(current.#advertisedRecord)
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_CURRENT_UNOWNED",
        "The current native Codex listener does not own an exact advertised record.",
      );
    }
    if (name === current.#advertisedRecord.name) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_ALIAS_UNCHANGED",
        "Native Codex succession requires a distinct alias.",
      );
    }
    if (this.#preparedRecord === undefined) {
      this.#preparedRecord = this.#newAdvertisedRecord(name, cwd);
    } else if (
      this.#preparedRecord.name !== name ||
      this.#preparedRecord.cwd !== cwd
    ) {
      throw new BridgeError(
        "CODEX_PEER_SUCCESSION_CHANGED",
        "A prepared native Codex publication cannot change identity after preparation.",
      );
    }
    const record = this.#preparedRecord;
    if (this.#publicationAttempted) {
      return await this.#classifyPublication(current, record);
    }

    let temporary:
      | Readonly<{ path: string; generation: FileGeneration }>
      | undefined;
    let renameInvoked = false;
    try {
      temporary = await this.#createRegistryTemporary(record);
      this.#publicationSourceGeneration = temporary.generation;
      await this.#registryPublicationHook?.("before_rename");
      if (
        this.#isClosingOrClosed() ||
        current.#isClosingOrClosed() ||
        !this.#inboundQuiesced ||
        !current.#inboundQuiesced
      ) {
        return (await this.#oldPublicationStillPresent(current))
          ? "not_published"
          : "unknown";
      }
      const currentExact = await current.#recordMatches(
        current.#advertisedRecord,
        current.#advertisedGeneration,
      );
      if (!currentExact.matches) return "unknown";
      renameInvoked = true;
      this.#publicationAttempted = true;
      await this.#registryRename(temporary.path, this.#registryPath());
      temporary = undefined;
      await this.#registryPublicationHook?.("after_rename");
      await this.#syncRegistryDirectory();
      return await this.#classifyPublication(current, record);
    } catch {
      if (!renameInvoked) {
        return (await this.#oldPublicationStillPresent(current))
          ? "not_published"
          : "unknown";
      }
      return await this.#classifyPublication(current, record);
    } finally {
      if (temporary !== undefined) {
        await this.#cleanupOwnedFile(
          temporary.path,
          temporary.generation,
        ).catch(() => undefined);
      }
    }
  }

  async updateAdvertisedStatus(status: ClaudePeerStatus): Promise<void> {
    await this.#mutateRegistry(
      "status",
      async () => await this.#updateAdvertisedStatusLocked(status),
    );
  }

  async #updateAdvertisedStatusLocked(
    status: ClaudePeerStatus,
  ): Promise<void> {
    if (
      this.#isClosingOrClosed() ||
      this.#advertisedRecord === undefined ||
      this.#advertisedRecord.status === status
    ) {
      return;
    }
    const currentExact = await this.#recordMatches(
      this.#advertisedRecord,
      this.#advertisedGeneration,
    );
    if (!currentExact.matches) {
      this.#advertisedRecord = undefined;
      this.#advertisedGeneration = undefined;
      return;
    }
    const now = Date.now();
    const record: AdvertisedCodexRegistryRecord = {
      ...this.#advertisedRecord,
      status,
      updatedAt: now,
      statusUpdatedAt: now,
    };
    const temporary = await this.#createRegistryTemporary(record);
    try {
      const stillCurrent = await this.#recordMatches(
        this.#advertisedRecord,
        this.#advertisedGeneration,
      );
      if (!stillCurrent.matches) return;
      await this.#registryRename(temporary.path, this.#registryPath());
      await this.#syncRegistryDirectory();
      const exact = await this.#recordMatches(record, temporary.generation);
      if (!exact.matches) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The updated native Codex registry record could not be exactly confirmed.",
        );
      }
      this.#advertisedRecord = record;
      this.#advertisedGeneration = exact.generation;
    } finally {
      await this.#cleanupOwnedFile(
        temporary.path,
        temporary.generation,
      ).catch(() => undefined);
    }
  }

  async unadvertise(name?: string): Promise<void> {
    await this.#mutateRegistry(
      "unadvertise",
      async () => await this.#unadvertiseLocked(name),
    );
  }

  async #unadvertiseLocked(name?: string): Promise<void> {
    if (
      this.#advertisedRecord === undefined ||
      (name !== undefined && name !== this.#advertisedRecord.name)
    ) {
      return;
    }
    const record = this.#advertisedRecord;
    const generation = this.#advertisedGeneration;
    this.#advertisedRecord = undefined;
    this.#advertisedGeneration = undefined;
    if (generation === undefined) return;
    const exact = await this.#recordMatches(record, generation);
    if (!exact.matches) return;
    await unlink(this.#registryPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  grantSuccessionActivation(): void {
    if (this.#isClosingOrClosed()) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
    if (
      this.#preparedGeneration === undefined ||
      !this.#publicationAttempted ||
      !this.#publicationConfirmed ||
      this.#publicationSourceGeneration === undefined ||
      this.#advertisedRecord === undefined ||
      this.#advertisedGeneration === undefined ||
      !sameFileGeneration(
        this.#publicationSourceGeneration,
        this.#advertisedGeneration,
      )
    ) {
      throw new BridgeError(
        "CODEX_PEER_PREPARED_NOT_ACTIVE",
        "A prepared native Codex listener requires exact confirmed publication before activation can be granted.",
      );
    }
    this.#activationGranted = true;
  }

  resumeInbound(): void {
    if (this.#isClosingOrClosed()) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
    if (!this.#activationGranted) {
      throw new BridgeError(
        "CODEX_PEER_PREPARED_NOT_ACTIVE",
        "A prepared native Codex listener cannot resume before durable succession activation.",
      );
    }
    this.#inboundQuiesced = false;
  }

  async acknowledge(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnostic?: ClaudePeerDeliveryDiagnostic,
  ): Promise<ClaudePeerAcknowledgmentResult> {
    if (this.#isClosingOrClosed()) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
    const receipt = this.#inboundReceipts.get(receiptHandle);
    if (receipt === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_RECEIPT_UNKNOWN",
        "The native Claude peer receipt is unknown or already settled.",
      );
    }
    if (
      diagnostic !== undefined &&
      (status !== "expired" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(diagnostic.code))
    ) {
      throw new BridgeError(
        "INVALID_PEER_DELIVERY_DIAGNOSTIC",
        "A peer delivery diagnostic requires an expired receipt and a safe code.",
      );
    }

    try {
      const result = await this.#writeInboundStatus(
        receipt,
        status,
        diagnostic,
      );
      if (status !== "held") this.#inboundReceipts.delete(receiptHandle);
      return result;
    } catch (error) {
      // A terminal write that may have started must never be replayed. A
      // proven pre-write failure retains the handle for a bounded caller retry.
      if (
        status !== "held" &&
        error instanceof BridgeError &&
        !error.recoverable
      ) {
        this.#inboundReceipts.delete(receiptHandle);
      }
      throw error;
    }
  }

  /**
   * Writes one nonterminal gateway progress frame without synthesizing a
   * native peer_message_status transition. The receipt remains available for
   * its later exact terminal acknowledgement or explicit release.
   */
  async notifyInboundProgress(
    receiptHandle: string,
    progress: ClaudePeerInboundProgress,
  ): Promise<ClaudePeerAcknowledgmentResult> {
    if (this.#isClosingOrClosed()) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
    const receipt = this.#inboundReceipts.get(receiptHandle);
    if (receipt === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_RECEIPT_UNKNOWN",
        "The native Claude peer receipt is unknown or already settled.",
      );
    }
    if (
      !isObject(progress) ||
      !hasExactKeys(progress, ["kind", "reason", "queuedForMs"]) ||
      progress.kind !== "stall" ||
      !claudePeerInboundStallReasons.includes(
        progress.reason as ClaudePeerInboundStallReason,
      ) ||
      typeof progress.queuedForMs !== "number"
    ) {
      throw new BridgeError(
        "INVALID_PEER_PROGRESS",
        "Claude peer progress must be one bounded gateway stall notice.",
      );
    }
    if (receipt.stallNotification !== "available") {
      throw new BridgeError(
        "CLAUDE_PEER_PROGRESS_ALREADY_NOTIFIED",
        "The native Claude peer receipt already has a stall notification.",
      );
    }
    if (this.#deliveryNotices === "quiet") {
      receipt.stallNotification = "settled";
      return { transportStatus: "suppressed" };
    }

    const queuedForMs = boundedStallQueuedForMs(progress.queuedForMs);
    const openingTag =
      `<gateway-delivery-stall terminal="false" reason="${progress.reason}" ` +
      `queued-for-ms="${queuedForMs}">`;
    const detailedContent = [
      openingTag,
      CLAUDE_PEER_NOTICE_COPY[this.#locale].stall,
      "</gateway-delivery-stall>",
    ].join("\n");
    const messageId = this.#createId();
    let progressFrame: Buffer;
    try {
      progressFrame = encodeClaudePeerUserFrame({
        messageId,
        content: detailedContent,
        maxFrameBytes: this.#limits.maxFrameBytes,
      });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "PEER_FRAME_TOO_LARGE") {
        throw error;
      }
      progressFrame = encodeClaudePeerUserFrame({
        messageId,
        content: `${openingTag.slice(0, -1)}/>`,
        maxFrameBytes: this.#limits.maxFrameBytes,
      });
    }

    receipt.stallNotification = "writing";
    try {
      const result = await this.#writeInboundPayload(receipt, progressFrame);
      receipt.stallNotification = "settled";
      return result;
    } catch (error) {
      // A proven pre-write failure can be retried; an ambiguous write counts
      // as the one allowed notice so the peer is never spammed by a replay.
      receipt.stallNotification =
        error instanceof BridgeError && error.recoverable
          ? "available"
          : "settled";
      throw error;
    }
  }

  /**
   * Releases a listener-owned native receipt capability without writing to the
   * peer. The service uses this after a terminal notification becomes
   * definitively undeliverable so bounded receipt capacity cannot leak.
   */
  releaseInboundReceipt(receiptHandle: string): boolean {
    return this.#inboundReceipts.delete(receiptHandle);
  }

  /**
   * Stop admitting new user-message frames while keeping the listener alive
   * for terminal receipt writes. The promise joins every frame already
   * admitted, so controller shutdown can drain service receipt work before
   * closing the provider socket.
   */
  async quiesceInbound(): Promise<void> {
    this.#inboundQuiesced = true;
    if (this.#queuedFrames === 0) return;
    await new Promise<void>((resolve) => {
      this.#inboundQuiesceWaiters.add(resolve);
      if (this.#queuedFrames === 0) {
        this.#inboundQuiesceWaiters.delete(resolve);
        resolve();
      }
    });
  }

  async #writeInboundStatus(
    receipt: { sourceSessionId: string; originalMessageId: string },
    status: "held" | "delivered" | "denied" | "expired",
    diagnostic?: ClaudePeerDeliveryDiagnostic,
  ): Promise<ClaudePeerAcknowledgmentResult> {
    const statusFrame = Buffer.from(
      `${JSON.stringify({
        type: "control",
        action: "peer_message_status",
        status,
        reason: diagnostic?.code ?? status,
        from: this.address,
        orig_msg_id: receipt.originalMessageId,
        msgV: 1,
        msg_id: this.#createId(),
      })}\n`,
      "utf8",
    );
    const diagnosticFrame =
      diagnostic === undefined || this.#deliveryNotices !== "verbose"
        ? undefined
        : encodeClaudePeerUserFrame({
            messageId: this.#createId(),
            content: [
              `<gateway-delivery-diagnostic status="expired" code="${diagnostic.code}">`,
              CLAUDE_PEER_NOTICE_COPY[this.#locale].diagnostic,
              "</gateway-delivery-diagnostic>",
            ].join("\n"),
            maxFrameBytes: this.#limits.maxFrameBytes,
          });
    const payload =
      diagnosticFrame === undefined
        ? statusFrame
        : Buffer.concat([statusFrame, diagnosticFrame]);
    return await this.#writeInboundPayload(receipt, payload);
  }

  async #writeInboundPayload(
    receipt: { sourceSessionId: string },
    payload: Buffer,
  ): Promise<ClaudePeerAcknowledgmentResult> {
    let writeStarted = false;
    try {
      const binding = await this.#resolveSessionBinding(
        receipt.sourceSessionId,
      );
      await new Promise<void>((resolve, reject) => {
        const socket = this.#connect(binding.record.messagingSocketPath);
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error === undefined) resolve();
          else reject(error);
        };
        socket.setTimeout(this.#limits.connectTimeoutMs, () =>
          finish(new Error("peer status timeout")),
        );
        socket.once("error", finish);
        socket.once("connect", () => {
          writeStarted = true;
          try {
            socket.end(payload, () => finish());
          } catch (error) {
            finish(error as Error);
          }
        });
      });
    } catch (error) {
      if (writeStarted) {
        throw new BridgeError(
          "CLAUDE_PEER_RECEIPT_WRITE_AMBIGUOUS",
          "The Claude peer receipt write began but its outcome is ambiguous; do not retry automatically.",
        );
      }
      if (error instanceof BridgeError && !error.recoverable) throw error;
      throw new BridgeError(
        "CLAUDE_PEER_RECEIPT_NOT_WRITTEN",
        "The Claude peer receipt was not confirmed written.",
        true,
      );
    }
    return { transportStatus: "transport_written" };
  }

  track(
    messageId: string,
    binding: TargetBinding,
    receiptDeadlineAt?: number,
  ): void {
    if (this.#isClosingOrClosed()) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
    if (this.#pending.size >= this.#limits.maxPendingReceipts) {
      throw new BridgeError(
        "CLAUDE_PEER_RECEIPT_LIMIT",
        "The bounded Claude peer receipt table is full.",
        true,
      );
    }
    if (this.#pending.has(messageId)) {
      throw new BridgeError(
        "CLAUDE_PEER_MESSAGE_ID_COLLISION",
        "The peer message ID collided with an outstanding receipt.",
      );
    }
    const now = this.#now();
    const deadlineAt =
      receiptDeadlineAt ?? now + this.#limits.receiptDeadlineMs;
    const timer = setTimeout(() => {
      const pending = this.#pending.get(messageId);
      if (pending === undefined) return;
      this.#pending.delete(messageId);
      void this.#emitReceipt({
        messageId,
        status: pendingReceiptDeadlineStatus(pending),
        trust: "untrusted_same_uid_peer",
      });
    }, Math.max(1, deadlineAt - now));
    timer.unref();
    this.#pending.set(messageId, {
      binding,
      state: "pending",
      writeEvidence: "none",
      deadlineAt,
      timer,
    });
  }

  recordTransportOutcome(
    messageId: string,
    outcome: "transport_written" | "transport_uncertain",
  ): void {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) return;
    if (
      pending.writeEvidence !== "transport_written" ||
      outcome === "transport_written"
    ) {
      pending.writeEvidence = outcome;
    }
  }

  untrack(messageId: string): void {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(messageId);
  }

  #accept(socket: Socket): void {
    if (
      this.#isClosingOrClosed() ||
      this.#connections.size >= this.#limits.maxConnections
    ) {
      socket.destroy();
      void this.#notice("CONNECTION_LIMIT");
      return;
    }
    this.#connections.add(socket);
    socket.setTimeout(this.#limits.connectionIdleMs);
    let buffered = Buffer.alloc(0);
    let frames = 0;
    let chain = Promise.resolve();
    let rejected = false;

    const reject = (code: ClaudePeerProtocolNotice["code"]): void => {
      if (rejected) return;
      rejected = true;
      socket.destroy();
      void this.#notice(code);
    };
    socket.on("timeout", () => reject("CONNECTION_TIMEOUT"));
    socket.on("error", () => undefined);
    socket.on("close", () => this.#connections.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (rejected) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > this.#limits.maxFrameBytes + 1) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0 || newline > this.#limits.maxFrameBytes) {
          reject("FRAME_TOO_LARGE");
          return;
        }
      }
      while (!rejected) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        if (newline > this.#limits.maxFrameBytes) {
          reject("FRAME_TOO_LARGE");
          break;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        frames += 1;
        if (frames > this.#limits.maxFramesPerConnection) {
          reject("INVALID_FRAME");
          break;
        }
        let frame: ParsedFrame;
        try {
          frame = parseFrame(line, this.#limits.maxFrameBytes);
        } catch (error) {
          if (
            error instanceof BridgeError &&
            error.code === "INVALID_PEER_UTF8"
          ) {
            reject("INVALID_UTF8");
          } else if (
            error instanceof BridgeError &&
            error.code === "UNSUPPORTED_PEER_FRAME"
          ) {
            reject("UNSUPPORTED_FRAME");
          } else {
            reject("INVALID_FRAME");
          }
          break;
        }
        if (
          this.#queuedFrames >=
          this.#limits.maxConnections * this.#limits.maxFramesPerConnection
        ) {
          reject("CONNECTION_LIMIT");
          break;
        }
        this.#queuedFrames += 1;
        chain = chain
          .then(async () => {
            if (rejected) return;
            await this.#handleFrame(frame, () => {
              if (rejected) return;
              rejected = true;
              socket.destroy();
            });
          })
          .catch(async () => this.#notice("CALLBACK_ERROR"))
          .finally(() => {
            this.#queuedFrames -= 1;
            if (this.#queuedFrames === 0) {
              for (const resolve of this.#inboundQuiesceWaiters) resolve();
              this.#inboundQuiesceWaiters.clear();
            }
          });
      }
      if (!rejected && buffered.length > this.#limits.maxFrameBytes) {
        reject("FRAME_TOO_LARGE");
      }
    });
    socket.on("end", () => {
      if (!rejected && buffered.length !== 0) reject("INVALID_FRAME");
    });
  }

  async #handleFrame(
    frame: ParsedFrame,
    rejectTransport: () => void,
  ): Promise<void> {
    if (this.#isClosingOrClosed()) return;
    if (frame.type === "control") {
      await this.#handleControl(frame);
      return;
    }
    if (this.#inboundQuiesced) {
      rejectTransport();
      return;
    }
    let binding: TargetBinding | undefined;
    if (frame.from !== undefined) {
      try {
        binding = await this.#resolveReplyAddress(frame.from);
      } catch {
        await this.#notice("UNREGISTERED_REPLY_ADDRESS");
        return;
      }
    }
    const inboundId = this.#createId();
    if (binding !== undefined && frame.messageId !== undefined) {
      if (
        this.#inboundReceipts.size >= this.#limits.maxPendingReceipts
      ) {
        await this.#notice("RECEIPT_LIMIT");
        if (this.#capacitySettlement !== undefined) {
          // Both the configured receipt table and its single terminal-only
          // overflow slot are occupied. Close this transport rather than
          // making another native send appear accepted without settlement.
          rejectTransport();
          return;
        }
        const settlement: CapacitySettlement = {
          receipt: {
            sourceSessionId: binding.targetId,
            originalMessageId: frame.messageId,
            stallNotification: "settled",
          },
          attempts: 0,
        };
        this.#capacitySettlement = settlement;
        await this.#attemptCapacitySettlement(settlement);
        return;
      }
      this.#inboundReceipts.set(inboundId, {
        sourceSessionId: binding.targetId,
        originalMessageId: frame.messageId,
        stallNotification: "available",
      });
    }
    await invokeHook(this.#options.onMessage, {
      inboundId,
      content: frame.content,
      ...(binding === undefined
        ? {}
        : {
            sourceTargetId: binding.targetId,
            sourceAlias: binding.alias,
            ...(frame.messageId === undefined
              ? {}
              : { receiptHandle: inboundId }),
          }),
      replySupported: binding !== undefined,
      trust:
        binding === undefined
          ? "untrusted_anonymous_local_peer"
          : "untrusted_same_uid_peer",
    });
  }

  async #attemptCapacitySettlement(
    settlement: CapacitySettlement,
  ): Promise<void> {
    if (this.#isClosingOrClosed() || this.#capacitySettlement !== settlement) {
      return;
    }
    settlement.attempts += 1;
    try {
      await this.#writeInboundStatus(
        settlement.receipt,
        "expired",
        { code: "GATEWAY_RECEIPT_CAPACITY" },
      );
      if (this.#capacitySettlement === settlement) {
        this.#capacitySettlement = undefined;
      }
    } catch (error) {
      if (this.#capacitySettlement !== settlement) return;
      const retryable =
        error instanceof BridgeError &&
        error.recoverable &&
        !this.#isClosingOrClosed();
      if (
        !retryable ||
        settlement.attempts >= CAPACITY_SETTLEMENT_MAX_ATTEMPTS
      ) {
        // An ambiguous write must never be replayed. Exhausted clean
        // pre-write failures are released with a local protocol notice rather
        // than leaking the bounded overflow slot or an unhandled rejection.
        this.#capacitySettlement = undefined;
        await this.#notice("CALLBACK_ERROR");
        return;
      }
      settlement.retryTimer = setTimeout(() => {
        delete settlement.retryTimer;
        void this.#attemptCapacitySettlement(settlement);
      }, CAPACITY_SETTLEMENT_RETRY_MS);
      settlement.retryTimer.unref();
    }
  }

  async #handleControl(frame: ParsedControlFrame): Promise<void> {
    const pending = this.#pending.get(frame.originalMessageId);
    if (pending === undefined) {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    let currentBinding: TargetBinding;
    try {
      // Receipt authority is the stable Claude session UUID, not the
      // short-lived send-time registry/socket lease. Re-discover the exact
      // session on every receipt so legitimate held/terminal frames remain
      // valid for the full message deadline and across socket rotation.
      currentBinding = await this.#resolveSessionBinding(
        pending.binding.targetId,
      );
    } catch {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    if (frame.from !== `uds:${currentBinding.record.messagingSocketPath}`) {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    pending.binding = currentBinding;
    if (this.#now() >= pending.deadlineAt) {
      clearTimeout(pending.timer);
      this.#pending.delete(frame.originalMessageId);
      await this.#emitReceipt({
        messageId: frame.originalMessageId,
        status: pendingReceiptDeadlineStatus(pending),
        trust: "untrusted_same_uid_peer",
      });
      return;
    }
    if (frame.status === "held") {
      if (pending.state !== "pending") {
        await this.#notice("INVALID_RECEIPT_TRANSITION");
        return;
      }
      pending.state = "held";
      pending.writeEvidence = "transport_written";
      await this.#emitReceipt({
        messageId: frame.originalMessageId,
        status: "held",
        trust: "untrusted_same_uid_peer",
      });
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(frame.originalMessageId);
    await this.#emitReceipt({
      messageId: frame.originalMessageId,
      status:
        frame.status === "delivered"
          ? "released"
          : frame.status,
      trust: "untrusted_same_uid_peer",
    });
  }

  async #emitReceipt(event: ClaudePeerReceiptEvent): Promise<void> {
    try {
      await invokeHook(this.#options.onReceipt, event);
    } catch {
      await this.#notice("CALLBACK_ERROR");
    }
  }

  async #notice(code: ClaudePeerProtocolNotice["code"]): Promise<void> {
    try {
      await invokeHook(this.#options.onProtocolNotice, { code });
    } catch {
      // Protocol callbacks are observational. Never feed callback failures
      // back into the socket or expose raw frame data.
    }
  }

  close(): Promise<void> {
    if (this.#closeOperation !== undefined) return this.#closeOperation;
    if (this.#closed) return Promise.resolve();
    this.#closing = true;
    this.#inboundQuiesced = true;
    const operation = this.#performClose();
    this.#closeOperation = operation;
    return operation;
  }

  async #performClose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.unadvertise();
    } catch (error) {
      errors.push(error);
    }
    const unsettledReceipts = [...this.#pending.entries()];
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#inboundReceipts.clear();
    if (this.#capacitySettlement?.retryTimer !== undefined) {
      clearTimeout(this.#capacitySettlement.retryTimer);
    }
    this.#capacitySettlement = undefined;
    const receiptResults = await Promise.allSettled(
      unsettledReceipts.map(async ([messageId, pending]) =>
        this.#emitReceipt({
          messageId,
          status:
            pendingReceiptDeadlineStatus(pending) === "unconfirmed"
              ? "unconfirmed"
              : "ambiguous",
          trust: "untrusted_same_uid_peer",
        }),
      ),
    );
    for (const result of receiptResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    let callbackPathOwned = false;
    try {
      const beforeClose = await lstat(this.#socketPath);
      if (
        !beforeClose.isSocket() ||
        !sameSocketGeneration(
          { dev: beforeClose.dev, ino: beforeClose.ino },
          this.#socketGeneration,
        )
      ) {
        // Node's net.Server.close() unlinks its original pathname even when
        // another same-user object replaced it. Do not call it after an
        // observed generation change. The now-unreachable descriptor is
        // unref'd and left for process exit rather than deleting foreign data.
        this.#server.unref();
        errors.push(
          new BridgeError(
            "CLAUDE_PEER_CALLBACK_CHANGED",
            "The callback path changed; foreign replacement was preserved.",
          ),
        );
      } else {
        callbackPathOwned = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#server.unref();
        errors.push(
          new BridgeError(
            "CLAUDE_PEER_CALLBACK_CHANGED",
            "The callback path disappeared; cleanup failed closed.",
          ),
        );
      } else {
        this.#server.unref();
        errors.push(error);
      }
    }

    if (callbackPathOwned) {
      try {
        await new Promise<void>((resolve, reject) =>
          this.#server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        const stat = await lstat(this.#socketPath);
        if (
          stat.isSocket() &&
          sameSocketGeneration(
            { dev: stat.dev, ino: stat.ino },
            this.#socketGeneration,
          )
        ) {
          await unlink(this.#socketPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(error);
        }
      }
    }

    this.#closing = false;
    this.#closed = true;
    try {
      this.#onClosed();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "The Claude peer listener closed with multiple cleanup failures.",
      );
    }
  }
}
