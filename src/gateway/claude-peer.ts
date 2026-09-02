import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import type { GatewayDeliveryNoticeMode } from "./config.js";
import { isDashboardLocale, type DashboardLocale } from "./locale.js";

export const CLAUDE_PEER_COMPATIBILITY = Object.freeze({ peerProtocol: 1 });
const EMBASSY_ADVERTISEMENT_VERSION = 1;
const EMBASSY_SOURCE_NAME_PATTERN = /^codex-/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRIVATE_ARTIFACT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const CLAUDE_PEER_NOTICE_COPY = {
  en: {
    stall:
      "The local gateway is still waiting to deliver the preceding message. Run `embassy status` or inspect the dashboard for details. Queued mail reaches a busy recipient when its turn ends.",
    diagnostic:
      "The local gateway could not deliver the preceding message. Run `embassy status` or inspect the dashboard for details. Queued mail reaches a busy recipient when its turn ends.",
  },
  "zh-CN": {
    stall:
      "本地网关仍在等待投递前一条消息。运行 `embassy status` 或查看仪表盘了解详情。排队邮件会在忙碌接收方的当前轮次结束后到达。",
    diagnostic:
      "本地网关无法投递前一条消息。运行 `embassy status` 或查看仪表盘了解详情。排队邮件会在忙碌接收方的当前轮次结束后到达。",
  },
} as const satisfies Readonly<
  Record<DashboardLocale, Readonly<Record<"stall" | "diagnostic", string>>>
>;
const REGISTRY_FILE_PATTERN = /^([1-9][0-9]{0,9})\.json$/;
const SOCKET_FILE_PATTERN = /^([1-9][0-9]{0,9})\.sock$/;
const MAX_PID = 2_147_483_647;

export const claudePeerStatuses = ["busy", "shell", "idle", "waiting"] as const;
export type ClaudePeerStatus = (typeof claudePeerStatuses)[number];

export const claudePeerKinds = ["interactive", "bg", "daemon", "daemon-worker"] as const;
export type ClaudePeerKind = (typeof claudePeerKinds)[number];

export const claudePeerRejectionCodes = [
  "ENTRY_LIMIT_EXCEEDED",
  "INVALID_FILE_NAME",
  "REGISTRY_NOT_REGULAR",
  "REGISTRY_TOO_LARGE",
  "REGISTRY_RACED",
  "REGISTRY_INVALID_JSON",
  "REGISTRY_INVALID_SCHEMA",
  "PID_MISMATCH",
  "PID_NOT_LIVE",
  "PID_OWNER_MISMATCH",
  "SOCKET_OUTSIDE_ROOT",
  "SOCKET_NOT_SOCKET",
  "SELF_TARGET",
  "SESSION_ID_COLLISION",
] as const;
export type ClaudePeerRejectionCode =
  (typeof claudePeerRejectionCodes)[number];

export type ClaudePeerDescriptor = {
  targetId: string; // Stable session UUID; names and sockets are coordinates.
  alias: string; kind: ClaudePeerKind; status: ClaudePeerStatus;
  compatibility: "compatible";
};
export type ClaudePeerDiscovery = {
  peers: ClaudePeerDescriptor[];
  rejected: Partial<Record<ClaudePeerRejectionCode, number>>;
  truncated: boolean; entriesScanned: number; parseableRecords: number;
};
export type ClaudePeerDeliveryDiagnostic = { code: string };
export const claudePeerInboundStallReasons = [
  "ROUTE_BUSY",
  "ROUTE_UNAVAILABLE",
  "AWAITING_EXTERNAL_APPROVAL",
] as const;
export type ClaudePeerInboundStallReason =
  (typeof claudePeerInboundStallReasons)[number];

export type ClaudePeerInboundProgress = {
  kind: "stall"; reason: ClaudePeerInboundStallReason; queuedForMs: number;
};
export type ClaudePeerAcknowledgmentResult = { transportStatus: "transport_written" | "suppressed" };
export type ClaudePeerInboundMessage = {
  inboundId: string; content: string;
  sourceTargetId?: string; sourceAlias?: string;
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
    | "RECEIPT_LIMIT"
    | "CONNECTION_LIMIT"
    | "CONNECTION_TIMEOUT"
    | "CALLBACK_ERROR";
};
export type ClaudeProcessIdentity = {
  uid: number; generation: string;
};
export type ClaudeProcessInspector = (
  pid: number,
) => Promise<ClaudeProcessIdentity | undefined>;
export type ClaudePeerConnect = (socketPath: string) => Socket;
export type ClaudePeerAdapterOptions = {
  sessionsDir: string; socketDir: string; locale?: DashboardLocale;
  deliveryNotices?: GatewayDeliveryNoticeMode;
  maxRegistryEntries?: number; maxRegistryBytes?: number;
  maxFrameBytes?: number; connectTimeoutMs?: number;
  maxPendingReceipts?: number; maxConnections?: number; connectionIdleMs?: number;
  maxFramesPerConnection?: number;
};
export type ClaudePeerAdapterTestOverrides = {
  expectedUid?: number; processInspector?: ClaudeProcessInspector;
  connect?: ClaudePeerConnect; now?: () => number; createId?: () => string;
  createArtifactToken?: () => string;
  registryRename?: (source: string, destination: string) => Promise<void>;
  registryOperationHook?: (event: {
    operation: "advertise" | "status" | "unadvertise";
    phase: "entered" | "exited";
    generation: string;
  }) => void | Promise<void>;
  userHome?: string; tempRoots?: readonly string[];
  postBindHook?: (socketPath: string) => void | Promise<void>;
};
export type ClaudePeerListenerOptions = {
  onMessage: (message: ClaudePeerInboundMessage) => void | Promise<void>;
  onProtocolNotice?: (notice: ClaudePeerProtocolNotice) => void | Promise<void>;
};
export type ClaudePeerPreparedSendResult = {
  messageId: string; transportStatus: "transport_written";
};
export type ClaudePeerPreparedSend = Readonly<{
  messageId: string; frameBytes: number; sha256: string;
  perform: () => Promise<ClaudePeerPreparedSendResult>;
  cancel: () => void;
}>;
type FileGeneration = { dev: number; ino: number; size: number; mtimeMs: number };
type SocketGeneration = { dev: number; ino: number };
type DirectoryGeneration = { dev: number; ino: number };

type ParsedRegistryRecord = {
  pid: number; sessionId: string; cwd: string; kind: ClaudePeerKind;
  messagingSocketPath: string; name: string; status: ClaudePeerStatus;
  embassyAdvertisement: boolean;
};
type TargetBinding = Readonly<{
  targetId: string; alias: string; record: ParsedRegistryRecord;
}>;
type CanonicalUserFrame = {
  msgV: 1; msg_id: string; type: "user";
  message: { role: "user"; content: string };
  priority: "next"; from?: string;
};
type ParsedUserFrame = {
  type: "user"; content: string; messageId?: string; from?: string;
};

type ParsedControlFrame = {
  type: "control"; action: "peer_message_status";
  status: "held" | "denied" | "expired" | "delivered";
  from: string; originalMessageId: string;
};

type ParsedFrame = ParsedUserFrame | ParsedControlFrame;
type InboundReceipt = {
  sourceSessionId: string; originalMessageId: string;
  stallNotification: "available" | "writing" | "settled";
};

type CapacitySettlement = { receipt: InboundReceipt; attempts: number; retryTimer?: NodeJS.Timeout };
type AdapterLimits = {
  maxRegistryEntries: number; maxRegistryBytes: number; maxFrameBytes: number;
  connectTimeoutMs: number; maxPendingReceipts: number; maxConnections: number;
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

function isDiagnosticVersion(value: unknown): value is string {
  return isBoundedString(value, 64) && value.length > 0 && !value.includes("\0");
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

function exactMode(mode: number): number { return mode & 0o777; }

function generationOf(
  stat: { dev: number; ino: number; size: number; mtimeMs: number },
): FileGeneration {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameSocketGeneration(left: SocketGeneration, right: SocketGeneration): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryGeneration(left: DirectoryGeneration, right: DirectoryGeneration): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  if (value === Number.POSITIVE_INFINITY) return MAX_CLAUDE_STALL_QUEUED_MS;
  return Math.min(MAX_CLAUDE_STALL_QUEUED_MS, Math.max(0, Math.trunc(value)));
}

function parseRegistryRecord(
  value: unknown,
  expectedPid: number,
): ParsedRegistryRecord | undefined {
  if (!isObject(value)) return undefined;
  const required = ["pid", "sessionId", "cwd", "startedAt", "procStart",
    "peerProtocol", "kind", "entrypoint", "messagingSocketPath", "name",
    "updatedAt"] as const;
  if (!required.every((key) => Object.hasOwn(value, key))) return undefined;
  const embassyAdvertisement =
    value.embassyAdvertisementVersion === EMBASSY_ADVERTISEMENT_VERSION &&
    isDiagnosticVersion(value.version) &&
    typeof value.name === "string" &&
    EMBASSY_SOURCE_NAME_PATTERN.test(value.name) &&
    ALIAS_PATTERN.test(value.name) &&
    value.kind === "interactive" &&
    value.entrypoint === "cli" &&
    value.peerProtocol === CLAUDE_PEER_COMPATIBILITY.peerProtocol &&
    value.status !== undefined &&
    value.statusUpdatedAt !== undefined;
  if (value.embassyAdvertisementVersion !== undefined && !embassyAdvertisement) return undefined;
  const versionObserved =
    value.version === undefined || isDiagnosticVersion(value.version);

  if (value.pid !== expectedPid) return undefined;
  if (typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId)) return undefined;
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
    !versionObserved ||
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
    kind: value.kind as ClaudePeerKind,
    messagingSocketPath: value.messagingSocketPath,
    name: value.name,
    status: (value.status ?? "busy") as ClaudePeerStatus,
    embassyAdvertisement,
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

function writeSocketPayload(
  connect: ClaudePeerConnect,
  socketPath: string,
  payload: Buffer,
  timeoutMs: number,
  onWriteStart: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("peer write timeout")),
      timeoutMs,
    );
    timer.unref();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error === undefined ? resolve() : reject(error);
    };
    socket.once("error", finish);
    socket.once("connect", () => {
      try {
        onWriteStart();
        socket.end(payload, () => finish());
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

async function socketOwnership(
  socketPath: string,
  generation: SocketGeneration,
): Promise<"owned" | "changed" | "missing"> {
  try {
    const stat = await lstat(socketPath);
    return stat.isSocket() &&
      sameSocketGeneration({ dev: stat.dev, ino: stat.ino }, generation)
      ? "owned"
      : "changed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
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
  readonly #createArtifactToken: () => string;
  readonly #locale: DashboardLocale;
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
  readonly #registryMutex = new KeyedMutex();
  readonly #postBindHook: ClaudePeerAdapterTestOverrides["postBindHook"];
  readonly #targets = new Map<string, TargetBinding>();
  readonly #selectedStateRoots = new Map<string, string>();
  readonly #listeners = new Set<ClaudePeerListener>();
  readonly #preparedSends = new Set<() => void>();

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
    if (options.locale !== undefined && !isDashboardLocale(options.locale)) {
      throw new BridgeError(
        "DASHBOARD_LOCALE_UNSUPPORTED",
        "The Claude peer notice locale is unsupported.",
      );
    }
    this.#locale = options.locale ?? "en";
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
    this.#expectedUid = testing.expectedUid ?? process.getuid();
    if (!Number.isSafeInteger(this.#expectedUid) || this.#expectedUid < 0) {
      throw new BridgeError(
        "INVALID_PEER_UID",
        "expectedUid must be a non-negative integer.",
      );
    }
    const limit = (
      name: keyof AdapterLimits,
      fallback: number,
      minimum: number,
      maximum: number,
    ): number => configuredLimit(options[name], fallback, minimum, maximum, name);
    this.#limits = {
      maxRegistryEntries: limit("maxRegistryEntries", 256, 1, 4_096),
      maxRegistryBytes: limit("maxRegistryBytes", 16 * 1024, 512, 1024 * 1024),
      maxFrameBytes: limit("maxFrameBytes", 64 * 1024, 256, 1024 * 1024),
      connectTimeoutMs: limit("connectTimeoutMs", 2_000, 10, 30_000),
      maxPendingReceipts: limit("maxPendingReceipts", 256, 1, 4_096),
      maxConnections: limit("maxConnections", 32, 1, 1_024),
      connectionIdleMs: limit("connectionIdleMs", 5_000, 10, 60_000),
      maxFramesPerConnection: limit("maxFramesPerConnection", 8, 1, 128),
    };
    this.#inspectProcess = testing.processInspector ?? defaultProcessInspector;
    this.#connect =
      testing.connect ??
      ((socketPath) => net.createConnection({ path: socketPath }));
    this.#now = testing.now ?? Date.now;
    this.#createId = testing.createId ?? randomUUID;
    this.#createArtifactToken = testing.createArtifactToken ?? randomUUID;
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
    this.#postBindHook = testing.postBindHook;
  }

  async #validateRoots(): Promise<void> {
    const [stat, sockets] = await Promise.all([
      lstat(this.#sessionsDir),
      lstat(this.#socketDir),
    ]);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== this.#expectedUid ||
      exactMode(stat.mode) !== 0o700
    ) {
      throw new BridgeError(
        "UNSAFE_PEER_DIRECTORY",
        "The Claude sessions directory failed its exact owner and mode policy.",
      );
    }
    if (sockets.isSymbolicLink() || !sockets.isDirectory()) {
      throw new BridgeError(
        "UNSAFE_PEER_DIRECTORY",
        "The Claude peer socket directory is not an accessible real directory.",
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
    const { value } = await this.#readRegistryFile(registryPath);
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
    // Embassy advertisements are addressable by Claude, never Claude delivery
    // targets or evidence that a Claude record parsed.
    if (record.embassyAdvertisement || expectedPid === process.pid) {
      throw new BridgeError("SELF_TARGET", "The gateway cannot target itself.");
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
    await this.#validateSocket(
      record.messagingSocketPath,
      expectedPid,
    );
    return {
      // Claude's native session UUID is the logical route identity. The
      // process, registry file, and socket below are replaceable transport
      // coordinates for that session and are revalidated before every write.
      targetId: record.sessionId,
      alias: record.name,
      record,
    };
  }

  async discover(): Promise<ClaudePeerDiscovery> {
    await this.#validateRoots();
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
        const binding = await this.#bindingFromRegistry(
          registryPath,
          pid,
          undefined,
          () => {
            parseableRecords += 1;
          },
        );
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
        if (code === "SELF_TARGET") continue;
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
    return {
      peers,
      rejected,
      truncated,
      entriesScanned: bounded.length,
      parseableRecords,
    };
  }

  async #attestOwnedDirectory(
    candidate: string,
    exactPrivate: boolean,
    code: "CLAUDE_PEER_STATE_ROOT_UNSAFE" | "CLAUDE_PEER_WORKSPACE_UNSAFE",
  ): Promise<string> {
    try {
      const configured = assertAbsoluteConfiguredPath(candidate, "peerDirectory");
      const before = await lstat(configured);
      const canonical = await realpath(configured);
      const after = await lstat(configured);
      const safeMode = (mode: number): boolean =>
        exactPrivate ? exactMode(mode) === 0o700 : (exactMode(mode) & 0o022) === 0;
      if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        before.uid !== this.#expectedUid ||
        !safeMode(before.mode) ||
        canonical !== configured ||
        after.isSymbolicLink() ||
        !after.isDirectory() ||
        after.uid !== this.#expectedUid ||
        !safeMode(after.mode) ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new BridgeError(code, "The peer directory failed its exact ownership policy.");
      }
      return canonical;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(code, "The peer directory could not be safely attested.");
    }
  }

  async #assertBindingWorkspaceDisjoint(binding: TargetBinding): Promise<void> {
    const code = "CLAUDE_PEER_WORKSPACE_UNSAFE" as const;
    const configured = assertAbsoluteConfiguredPath(binding.record.cwd, "peerDirectory");
    if (
      configured === path.parse(configured).root ||
      this.#tempRoots.some(
        (root) => pathContains(root, configured) || pathContains(configured, root),
      )
    ) {
      throw new BridgeError(
        "CLAUDE_PEER_WORKSPACE_BROAD",
        "The selected Claude workspace is broader than the safe local boundary.",
      );
    }
    const [workspace] = await Promise.all([
      this.#attestOwnedDirectory(configured, false, code),
      this.#attestOwnedDirectory(this.#userHome, false, code),
    ]);
    if (workspace !== configured) {
      throw new BridgeError(
        code,
        "The peer workspace changed during attestation.",
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
    const stateRoot = await this.#attestOwnedDirectory(
      controllerStateRoot,
      true,
      "CLAUDE_PEER_STATE_ROOT_UNSAFE",
    );
    await this.#assertBindingWorkspaceDisjoint(target);
    this.#selectedStateRoots.set(targetId, stateRoot);
  }

  async #resolveReplyAddress(address: string): Promise<TargetBinding> {
    await this.#validateRoots();
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
    const binding = await this.#bindingFromRegistry(registryPath, pid);
    if (binding.record.messagingSocketPath !== socketPath) {
      throw new BridgeError(
        "UNREGISTERED_REPLY_ADDRESS",
        "Reply address does not match its live registry generation.",
      );
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
    const binding = await this.#resolveReplyAddress(address);
    return {
      targetId: binding.targetId,
      alias: binding.alias,
      kind: binding.record.kind,
      status: binding.record.status,
      compatibility: "compatible",
    };
  }

  async listen(
    options: ClaudePeerListenerOptions,
  ): Promise<ClaudePeerListener> {
    await this.#validateRoots();
    const generation = this.#createArtifactToken();
    if (!PRIVATE_ARTIFACT_TOKEN_PATTERN.test(generation)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_GENERATION",
        "A native source listener requires one bounded private artifact token.",
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
      locale: this.#locale,
      deliveryNotices: this.#deliveryNotices,
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
        return target;
      },
      options,
      generation,
      registryRename: this.#registryRename,
      ...(this.#registryOperationHook === undefined
        ? {}
        : { registryOperationHook: this.#registryOperationHook }),
      runRegistryMutation: async (operation) =>
        await this.#registryMutex.run("codex-registry", operation),
      postBindHook: this.#postBindHook,
      onClosed: () => this.#listeners.delete(listener),
    });
    this.#listeners.add(listener);
    return listener;
  }

  async prepareSend(
    targetId: string,
    content: string,
    options: Readonly<{
      deadlineAt: number;
      /** Owned reply address only; no outbound receipt is tracked. */
      replyListener?: ClaudePeerListener;
    }>,
  ): Promise<ClaudePeerPreparedSend> {
    if (
      !Number.isSafeInteger(options.deadlineAt) ||
      options.deadlineAt < 0
    ) {
      throw new BridgeError(
        "INVALID_PEER_MESSAGE_DEADLINE",
        "The Claude peer message deadline must be an epoch-millisecond timestamp.",
      );
    }
    if (options.deadlineAt <= this.#now()) {
      throw new BridgeError(
        "CLAUDE_PEER_MESSAGE_EXPIRED",
        "The Claude peer message deadline elapsed before preparation.",
        true,
      );
    }

    // Preparation positively resolves every replaceable coordinate and exact
    // workspace generation. The resulting operation owns only immutable wire
    // bytes and the already-validated socket path; it performs no connection
    // or write until its one-shot perform function is invoked.
    await this.discover();
    const target = this.#targets.get(targetId);
    if (target === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_UNKNOWN",
        "The Claude peer target is unknown; discover it first.",
        true,
      );
    }
    const stateRoot = this.#selectedStateRoots.get(targetId);
    if (stateRoot === undefined) {
      throw new BridgeError(
        "CLAUDE_PEER_WORKSPACE_UNATTESTED",
        "The Claude peer workspace must pass selection validation before send.",
      );
    }
    try {
      await this.#attestOwnedDirectory(
        stateRoot,
        true,
        "CLAUDE_PEER_STATE_ROOT_UNSAFE",
      );
      await this.#assertBindingWorkspaceDisjoint(target);
    } catch (error) {
      this.#selectedStateRoots.delete(targetId);
      throw error;
    }

    const messageId = this.#createId();
    if (!UUID_PATTERN.test(messageId)) {
      throw new BridgeError(
        "INVALID_PEER_MESSAGE_ID",
        "The configured ID source did not produce a UUID.",
      );
    }
    if (
      options.replyListener !== undefined &&
      !this.#listeners.has(options.replyListener)
    ) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_FOREIGN",
        "The reply listener is not owned by this adapter.",
      );
    }
    const frame = encodeClaudePeerUserFrame({
      messageId,
      content,
      ...(options.replyListener === undefined
        ? {}
        : { from: options.replyListener.address }),
      maxFrameBytes: this.#limits.maxFrameBytes,
    });
    const socketPath = target.record.messagingSocketPath;
    let state: "prepared" | "performed" | "cancelled" = "prepared";
    const cancel = (): void => {
      if (state !== "prepared") return;
      state = "cancelled";
      this.#preparedSends.delete(cancel);
    };
    this.#preparedSends.add(cancel);

    const perform = (): Promise<ClaudePeerPreparedSendResult> => {
      if (state !== "prepared") {
        return Promise.reject(
          new BridgeError(
            "CLAUDE_PEER_PREPARATION_CONSUMED",
            "The prepared Claude peer write was already performed or cancelled.",
          ),
        );
      }
      state = "performed";
      this.#preparedSends.delete(cancel);
      if (options.deadlineAt <= this.#now()) {
        return Promise.reject(
          new BridgeError(
            "CLAUDE_PEER_MESSAGE_EXPIRED",
            "The Claude peer message deadline elapsed before any socket write.",
            true,
          ),
        );
      }

      let writeStarted = false;
      const write = writeSocketPayload(
        this.#connect,
        socketPath,
        frame,
        Math.max(
          1,
          Math.min(this.#limits.connectTimeoutMs, options.deadlineAt - this.#now()),
        ),
        () => {
          if (options.deadlineAt <= this.#now()) {
            throw new BridgeError(
              "CLAUDE_PEER_MESSAGE_EXPIRED",
              "The Claude peer message deadline elapsed before any socket write.",
              true,
            );
          }
          writeStarted = true;
        },
      );
      return write.then(
        () => ({ messageId, transportStatus: "transport_written" as const }),
        (error: unknown) => {
          if (error instanceof BridgeError) throw error;
          const expired = this.#now() >= options.deadlineAt;
          throw new BridgeError(
            writeStarted
              ? "CLAUDE_PEER_WRITE_AMBIGUOUS"
              : expired
                ? "CLAUDE_PEER_MESSAGE_EXPIRED"
                : error instanceof Error && error.message === "peer write timeout"
                  ? "CLAUDE_PEER_CONNECT_TIMEOUT"
                  : "CLAUDE_PEER_WRITE_FAILED",
            writeStarted
              ? "The Claude peer write began but its outcome is ambiguous; do not retry automatically."
              : expired
                ? "The Claude peer message deadline elapsed before any socket write."
                : "The Claude peer message was not confirmed written.",
            !writeStarted,
          );
        },
      );
    };

    return Object.freeze({
      messageId,
      frameBytes: frame.length,
      sha256: createHash("sha256").update(frame).digest("hex"),
      perform,
      cancel,
    });
  }

  async close(): Promise<void> {
    for (const cancel of [...this.#preparedSends]) cancel();
    const results = await Promise.allSettled(
      [...this.#listeners].map(async (listener) => listener.close()),
    );
    this.#targets.clear();
    this.#selectedStateRoots.clear();
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
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  resolveReplyAddress: (address: string) => Promise<TargetBinding>;
  resolveSessionBinding: (sessionId: string) => Promise<TargetBinding>;
  options: ClaudePeerListenerOptions;
  generation: string;
  registryRename: (source: string, destination: string) => Promise<void>;
  registryOperationHook?: ClaudePeerAdapterTestOverrides["registryOperationHook"];
  runRegistryMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  postBindHook: ClaudePeerAdapterTestOverrides["postBindHook"];
  onClosed: () => void;
};

type AdvertisedCodexRegistryRecord = {
  embassyAdvertisementVersion: 1;
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
type OwnedAdvertisement = Readonly<{
  record: AdvertisedCodexRegistryRecord;
  generation: FileGeneration;
}>;

export class ClaudePeerListener {
  readonly address: string;
  readonly generation: string;
  readonly #sessionsGeneration: DirectoryGeneration;
  readonly #socketPath: string;
  readonly #socketGeneration: SocketGeneration;
  readonly #server: Server;
  readonly #context: ListenerCreateOptions;
  readonly #connections = new Set<Socket>();
  readonly #inboundReceipts = new Map<string, InboundReceipt>();
  // One bounded exception slot owns an overflow message only long enough to
  // return its terminal capacity rejection. It never forwards content to the
  // service, retries only proven pre-write failures, and is released after a
  // successful, ambiguous, non-retryable, or exhausted write.
  #capacitySettlement: CapacitySettlement | undefined;
  #queuedFrames = 0;
  #inboundQuiesced = false;
  readonly #inboundQuiesceWaiters = new Set<() => void>();
  #advertisement: OwnedAdvertisement | undefined;
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
    this.#sessionsGeneration = sessionsGeneration;
    this.#socketPath = socketPath;
    this.#socketGeneration = generation;
    this.#server = server;
    this.#context = options;
  }

  static async create(
    options: ListenerCreateOptions,
  ): Promise<ClaudePeerListener> {
    // One gateway process owns one native peer socket. It may advertise one
    // registered Codex task through Claude's native session registry.
    const socketPath = path.join(options.socketDir, `${process.pid}.sock`);
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
      await options.postBindHook?.(socketPath);
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
      try {
        if (
          createdGeneration === undefined ||
          await socketOwnership(socketPath, createdGeneration) !== "owned"
        ) {
          throw new Error("callback ownership changed");
        }
        await closeServer(server);
        if (await socketOwnership(socketPath, createdGeneration) !== "missing") {
          throw new Error("callback close unconfirmed");
        }
      } catch {
        server.unref();
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_UNSAFE",
          "The newly bound callback socket could not be safely closed.",
        );
      }
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closing || this.#closed;
  }

  #registryPath(): string {
    return path.join(this.#context.sessionsDir, `${process.pid}.json`);
  }

  #registryTemporaryPath(): string {
    return path.join(
      this.#context.sessionsDir,
      `.${process.pid}.${this.generation}.registry.tmp`,
    );
  }

  #serializeRecord(record: AdvertisedCodexRegistryRecord): string {
    return `${JSON.stringify(record)}\n`;
  }

  async #assertRegistryDirectory(): Promise<void> {
    const current = await lstat(this.#context.sessionsDir);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.uid !== this.#context.expectedUid ||
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
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        registryPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const opened = await handle.stat();
      const openedGeneration = generationOf(opened);
      if (
        !opened.isFile() ||
        opened.uid !== this.#context.expectedUid ||
        exactMode(opened.mode) !== 0o600 ||
        opened.size > this.#context.limits.maxRegistryBytes
      ) {
        throw new BridgeError(
          "REGISTRY_RACED",
          "The native Codex registry record failed its exact ownership policy.",
        );
      }
      const serialized = await handle.readFile({ encoding: "utf8" });
      if (byteLength(serialized) > this.#context.limits.maxRegistryBytes) {
        throw new BridgeError(
          "REGISTRY_TOO_LARGE",
          "The native Codex registry record exceeded its bound.",
        );
      }
      const [afterOpen, afterPath] = await Promise.all([
        handle.stat(),
        lstat(registryPath),
      ]);
      if (
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        !sameFileGeneration(openedGeneration, generationOf(afterOpen)) ||
        !sameFileGeneration(openedGeneration, generationOf(afterPath))
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
    const created = await lstat(temporaryPath);
    if (
      created.isSymbolicLink() ||
      !created.isFile() ||
      created.uid !== this.#context.expectedUid ||
      exactMode(created.mode) !== 0o600
    ) {
      throw new BridgeError(
        "REGISTRY_RACED",
        "The native Codex temporary registry record is unsafe.",
      );
    }
    return { path: temporaryPath, generation: generationOf(created) };
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
        current.uid === this.#context.expectedUid &&
        exactMode(current.mode) === 0o600 &&
        sameFileGeneration(generationOf(current), generation)
      ) {
        await unlink(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #newAdvertisedRecord(
    name: string,
    cwd: string,
  ): AdvertisedCodexRegistryRecord {
    if (!EMBASSY_SOURCE_NAME_PATTERN.test(name) || !ALIAS_PATTERN.test(name)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_NAME",
        "A native source peer name must use its provider prefix.",
      );
    }
    if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_CWD",
        "A native Codex peer requires an absolute working directory.",
      );
    }
    const sessionId = this.#context.createId();
    if (!UUID_PATTERN.test(sessionId)) {
      throw new BridgeError(
        "INVALID_CODEX_PEER_SESSION_ID",
        "The configured ID source did not produce a native peer session UUID.",
      );
    }
    const now = Date.now();
    return {
      embassyAdvertisementVersion: EMBASSY_ADVERTISEMENT_VERSION,
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: now,
      procStart: new Date(now - process.uptime() * 1_000).toString(),
      version: "unknown",
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
    operation: "advertise" | "status" | "unadvertise",
    mutation: () => Promise<T>,
  ): Promise<T> {
    return await this.#context.runRegistryMutation(async () => {
      await this.#context.registryOperationHook?.({
        operation,
        phase: "entered",
        generation: this.generation,
      });
      try {
        return await mutation();
      } finally {
        await this.#context.registryOperationHook?.({
          operation,
          phase: "exited",
          generation: this.generation,
        });
      }
    });
  }

  async advertise(name: string, cwd: string): Promise<void> {
    await this.#mutateRegistry("advertise", async () => {
      if (this.closed) {
        throw new BridgeError(
          "CLAUDE_PEER_LISTENER_CLOSED",
          "The Claude peer callback listener is closed.",
        );
      }
      if (this.#advertisement !== undefined && this.#advertisement.record.name !== name) {
        throw new BridgeError(
          "CODEX_PEER_ALREADY_ADVERTISED",
          "This gateway process already advertises another Codex peer.",
        );
      }
      if (this.#advertisement?.record.name === name) return;
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
      this.#advertisement = { record, generation: exact.generation };
    });
  }

  async updateAdvertisedStatus(status: ClaudePeerStatus): Promise<void> {
    await this.#mutateRegistry("status", async () => {
      const owned = this.#advertisement;
      if (this.closed || owned === undefined || owned.record.status === status) return;
      if (!(await this.#recordMatches(owned.record, owned.generation)).matches) {
        this.#advertisement = undefined;
        return;
      }
      const now = Date.now();
      const record = { ...owned.record, status, updatedAt: now, statusUpdatedAt: now };
      const temporary = await this.#createRegistryTemporary(record);
      try {
        if (!(await this.#recordMatches(owned.record, owned.generation)).matches) return;
        await this.#context.registryRename(temporary.path, this.#registryPath());
        const exact = await this.#recordMatches(record, temporary.generation);
        if (!exact.matches) {
          throw new BridgeError(
            "REGISTRY_RACED",
            "The updated native Codex registry record could not be exactly confirmed.",
          );
        }
        this.#advertisement = { record, generation: exact.generation };
      } finally {
        await this.#cleanupOwnedFile(temporary.path, temporary.generation).catch(
          () => undefined,
        );
      }
    });
  }

  async unadvertise(name?: string): Promise<void> {
    await this.#mutateRegistry("unadvertise", async () => {
      const owned = this.#advertisement;
      if (owned === undefined || (name !== undefined && name !== owned.record.name)) return;
      this.#advertisement = undefined;
      if (!(await this.#recordMatches(owned.record, owned.generation)).matches) return;
      await unlink(this.#registryPath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  async acknowledge(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnostic?: ClaudePeerDeliveryDiagnostic,
  ): Promise<ClaudePeerAcknowledgmentResult> {
    if (this.closed) {
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
    if (this.closed) {
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
    if (this.#context.deliveryNotices === "quiet") {
      receipt.stallNotification = "settled";
      return { transportStatus: "suppressed" };
    }

    const queuedForMs = boundedStallQueuedForMs(progress.queuedForMs);
    const openingTag =
      `<gateway-delivery-stall terminal="false" reason="${progress.reason}" ` +
      `queued-for-ms="${queuedForMs}">`;
    const detailedContent = [
      openingTag,
      CLAUDE_PEER_NOTICE_COPY[this.#context.locale].stall,
      "</gateway-delivery-stall>",
    ].join("\n");
    const messageId = this.#context.createId();
    let progressFrame: Buffer;
    try {
      progressFrame = encodeClaudePeerUserFrame({
        messageId,
        content: detailedContent,
        maxFrameBytes: this.#context.limits.maxFrameBytes,
      });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "PEER_FRAME_TOO_LARGE") {
        throw error;
      }
      progressFrame = encodeClaudePeerUserFrame({
        messageId,
        content: `${openingTag.slice(0, -1)}/>`,
        maxFrameBytes: this.#context.limits.maxFrameBytes,
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
        msg_id: this.#context.createId(),
      })}\n`,
      "utf8",
    );
    const diagnosticFrame =
      diagnostic === undefined || this.#context.deliveryNotices !== "verbose"
        ? undefined
        : encodeClaudePeerUserFrame({
            messageId: this.#context.createId(),
            content: [
              `<gateway-delivery-diagnostic status="expired" code="${diagnostic.code}">`,
              CLAUDE_PEER_NOTICE_COPY[this.#context.locale].diagnostic,
              "</gateway-delivery-diagnostic>",
            ].join("\n"),
            maxFrameBytes: this.#context.limits.maxFrameBytes,
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
      const binding = await this.#context.resolveSessionBinding(
        receipt.sourceSessionId,
      );
      await writeSocketPayload(
        this.#context.connect,
        binding.record.messagingSocketPath,
        payload,
        this.#context.limits.connectTimeoutMs,
        () => {
          writeStarted = true;
        },
      );
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

  #accept(socket: Socket): void {
    if (
      this.closed ||
      this.#connections.size >= this.#context.limits.maxConnections
    ) {
      socket.destroy();
      void this.#notice("CONNECTION_LIMIT");
      return;
    }
    this.#connections.add(socket);
    socket.setTimeout(this.#context.limits.connectionIdleMs);
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
      if (buffered.length > this.#context.limits.maxFrameBytes + 1) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0 || newline > this.#context.limits.maxFrameBytes) {
          reject("FRAME_TOO_LARGE");
          return;
        }
      }
      while (!rejected) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        if (newline > this.#context.limits.maxFrameBytes) {
          reject("FRAME_TOO_LARGE");
          break;
        }
        const line = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        frames += 1;
        if (frames > this.#context.limits.maxFramesPerConnection) {
          reject("INVALID_FRAME");
          break;
        }
        let frame: ParsedFrame;
        try {
          frame = parseFrame(line, this.#context.limits.maxFrameBytes);
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
          this.#context.limits.maxConnections * this.#context.limits.maxFramesPerConnection
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
      if (!rejected && buffered.length > this.#context.limits.maxFrameBytes) {
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
    if (this.closed) return;
    if (frame.type === "control") {
      // Native outbound status is accepted for wire compatibility but is not
      // settlement authority. A confirmed mailbox write is terminal.
      return;
    }
    if (this.#inboundQuiesced) {
      rejectTransport();
      return;
    }
    let binding: TargetBinding | undefined;
    if (frame.from !== undefined) {
      try {
        binding = await this.#context.resolveReplyAddress(frame.from);
      } catch {
        await this.#notice("UNREGISTERED_REPLY_ADDRESS");
        return;
      }
    }
    const inboundId = this.#context.createId();
    if (binding !== undefined && frame.messageId !== undefined) {
      if (
        this.#inboundReceipts.size >= this.#context.limits.maxPendingReceipts
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
    await invokeHook(this.#context.options.onMessage, {
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
    if (this.closed || this.#capacitySettlement !== settlement) {
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
        !this.closed;
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

  async #notice(code: ClaudePeerProtocolNotice["code"]): Promise<void> {
    try {
      await invokeHook(this.#context.options.onProtocolNotice, { code });
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
    this.#inboundReceipts.clear();
    if (this.#capacitySettlement?.retryTimer !== undefined) {
      clearTimeout(this.#capacitySettlement.retryTimer);
    }
    this.#capacitySettlement = undefined;
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    try {
      if (
        await socketOwnership(this.#socketPath, this.#socketGeneration) !==
        "owned"
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
        await closeServer(this.#server);
        if (
          await socketOwnership(this.#socketPath, this.#socketGeneration) ===
          "owned"
        ) {
          await unlink(this.#socketPath);
        }
      }
    } catch (error) {
      this.#server.unref();
      errors.push(error);
    }

    this.#closing = false;
    this.#closed = true;
    try {
      this.#context.onClosed();
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
