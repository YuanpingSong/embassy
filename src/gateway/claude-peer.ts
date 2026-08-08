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

/**
 * This adapter intentionally pins the inspected, implementation-specific
 * local peer boundary. The feature is documented in Claude Code, but its
 * registry and NDJSON formats are not a stable public integration contract.
 */
export const CLAUDE_PEER_COMPATIBILITY = Object.freeze({
  claudeCodeVersion: "2.1.225",
  peerProtocol: 1,
  messageVersion: 1,
});

/** Live peer records may outlive a same-protocol Claude Code upgrade. */
export const CLAUDE_PEER_COMPATIBLE_SESSION_VERSIONS = Object.freeze([
  "2.1.224",
  "2.1.225",
] as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
};

export type ClaudePeerTransportStatus =
  | "connecting"
  | "transport_written"
  | "ambiguous"
  | "not_written";

export type ClaudePeerReceiptStatus =
  | "held"
  | "released"
  | "denied"
  | "expired"
  | "ambiguous";

export type ClaudePeerDeliveryDiagnostic = {
  /** Stable, non-sensitive gateway code rendered into Claude's context. */
  code: string;
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
  userHome?: string;
  tempRoots?: readonly string[];
};

export type ClaudePeerListenerOptions = {
  onMessage: (message: ClaudePeerInboundMessage) => void | Promise<void>;
  onReceipt?: (event: ClaudePeerReceiptEvent) => void | Promise<void>;
  onProtocolNotice?: (
    notice: ClaudePeerProtocolNotice,
  ) => void | Promise<void>;
};

export type ClaudePeerSendOptions = {
  listener?: ClaudePeerListener;
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
  timer: NodeJS.Timeout;
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
    !CLAUDE_PEER_COMPATIBLE_SESSION_VERSIONS.includes(
      value.version as (typeof CLAUDE_PEER_COMPATIBLE_SESSION_VERSIONS)[number],
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
    // Claude Code print/SDK sessions in 2.1.225 omit status fields while the
    // model turn is active. Treat that live process conservatively as busy.
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
  readonly #userHome: string;
  readonly #tempRoots: readonly string[];
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
      options.attestedClaudeCodeVersion !==
      CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion
    ) {
      throw new BridgeError(
        "CLAUDE_PEER_VERSION_UNSUPPORTED",
        `Claude peer compatibility is pinned to Claude Code ${CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion}.`,
      );
    }
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
    this.#userHome = assertAbsoluteConfiguredPath(
      testing.userHome ?? os.userInfo().homedir,
      "userHome",
    );
    this.#tempRoots = Object.freeze(
      [
        ...(testing.tempRoots ?? ["/tmp", "/private/tmp", os.tmpdir()]),
      ].map((root) => assertAbsoluteConfiguredPath(root, "tempRoot")),
    );
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
        let binding = await this.#bindingFromRegistry(registryPath, pid);
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
    return { peers, rejected, truncated };
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

  async listen(options: ClaudePeerListenerOptions): Promise<ClaudePeerListener> {
    await Promise.all([
      this.#validatePrivateDirectory(this.#sessionsDir),
      this.#validatePrivateDirectory(this.#socketDir),
    ]);
    const listener = await ClaudePeerListener.create({
      sessionsDir: this.#sessionsDir,
      socketDir: this.#socketDir,
      expectedUid: this.#expectedUid,
      limits: this.#limits,
      createId: this.#createId,
      connect: this.#connect,
      resolveReplyAddress: async (address) =>
        await this.#resolveReplyAddress(address),
      revalidateBinding: async (binding) =>
        await this.#revalidateBinding(binding),
      options,
      onClosed: () => this.#listeners.delete(listener),
    });
    this.#listeners.add(listener);
    return listener;
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
    if (listener !== undefined) listener.track(messageId, binding);

    await invokeObservationalHook(options.onTransportStatus, {
      messageId,
      status: "connecting",
    });
    let written = false;
    let writeStarted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = this.#connect(binding.record.messagingSocketPath);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(
            new BridgeError(
              writeStarted
                ? "CLAUDE_PEER_WRITE_AMBIGUOUS"
                : "CLAUDE_PEER_CONNECT_TIMEOUT",
              writeStarted
                ? "The Claude peer write began but did not finish in time; do not retry automatically."
                : "The Claude peer socket did not accept the write in time.",
              !writeStarted,
            ),
          );
        }, this.#limits.connectTimeoutMs);
        timer.unref();
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("connect", () => {
          writeStarted = true;
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
      if (!writeStarted && listener !== undefined) listener.untrack(messageId);
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
      if (listener !== undefined) listener.untrack(messageId);
      throw new BridgeError(
        "CLAUDE_PEER_WRITE_AMBIGUOUS",
        "The Claude peer write outcome is ambiguous; do not retry automatically.",
      );
    }
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
  resolveReplyAddress: (address: string) => Promise<TargetBinding>;
  revalidateBinding: (binding: TargetBinding) => Promise<TargetBinding>;
  options: ClaudePeerListenerOptions;
  onClosed: () => void;
};

export class ClaudePeerListener {
  readonly address: string;
  readonly #sessionsDir: string;
  readonly #socketPath: string;
  readonly #socketGeneration: SocketGeneration;
  readonly #server: Server;
  readonly #limits: AdapterLimits;
  readonly #createId: () => string;
  readonly #connect: ClaudePeerConnect;
  readonly #resolveReplyAddress: (address: string) => Promise<TargetBinding>;
  readonly #revalidateBinding: (binding: TargetBinding) => Promise<TargetBinding>;
  readonly #options: ClaudePeerListenerOptions;
  readonly #onClosed: () => void;
  readonly #connections = new Set<Socket>();
  readonly #pending = new Map<string, PendingReceipt>();
  readonly #inboundReceipts = new Map<
    string,
    { binding: TargetBinding; originalMessageId: string }
  >();
  #queuedFrames = 0;
  #advertisedRecord: Record<string, unknown> | undefined;
  #closed = false;

  private constructor(
    options: ListenerCreateOptions,
    server: Server,
    socketPath: string,
    generation: SocketGeneration,
  ) {
    this.address = `uds:${socketPath}`;
    this.#sessionsDir = options.sessionsDir;
    this.#socketPath = socketPath;
    this.#socketGeneration = generation;
    this.#server = server;
    this.#limits = options.limits;
    this.#createId = options.createId;
    this.#connect = options.connect;
    this.#resolveReplyAddress = options.resolveReplyAddress;
    this.#revalidateBinding = options.revalidateBinding;
    this.#options = options.options;
    this.#onClosed = options.onClosed;
  }

  static async create(
    options: ListenerCreateOptions,
  ): Promise<ClaudePeerListener> {
    // One gateway process owns one native peer socket. It may advertise one
    // selected Codex task through Claude's native session registry.
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
      listener = new ClaudePeerListener(
        options,
        server,
        socketPath,
        createdGeneration,
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
    return this.#closed;
  }

  async advertise(name: string, cwd: string): Promise<void> {
    if (this.#closed) {
      throw new BridgeError(
        "CLAUDE_PEER_LISTENER_CLOSED",
        "The Claude peer callback listener is closed.",
      );
    }
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
    const now = Date.now();
    const registryPath = path.join(this.#sessionsDir, `${process.pid}.json`);
    const record: Record<string, unknown> = {
      pid: process.pid,
      sessionId: this.#createId(),
      cwd,
      startedAt: now,
      procStart: new Date(now - process.uptime() * 1_000).toString(),
      version: CLAUDE_PEER_COMPATIBILITY.claudeCodeVersion,
      peerProtocol: CLAUDE_PEER_COMPATIBILITY.peerProtocol,
      kind: "interactive",
      entrypoint: "cli",
      messagingSocketPath: this.#socketPath,
      name,
      status: "idle",
      updatedAt: now,
      statusUpdatedAt: now,
    };
    await writeFile(
      registryPath,
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    this.#advertisedRecord = record;
  }

  async updateAdvertisedStatus(status: ClaudePeerStatus): Promise<void> {
    if (
      this.#closed ||
      this.#advertisedRecord === undefined ||
      this.#advertisedRecord.status === status
    ) {
      return;
    }
    const now = Date.now();
    const record = {
      ...this.#advertisedRecord,
      status,
      updatedAt: now,
      statusUpdatedAt: now,
    };
    const registryPath = path.join(this.#sessionsDir, `${process.pid}.json`);
    const temporaryPath = `${registryPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
    await rename(temporaryPath, registryPath);
    this.#advertisedRecord = record;
  }

  async unadvertise(name?: string): Promise<void> {
    if (
      this.#advertisedRecord === undefined ||
      (name !== undefined && name !== this.#advertisedRecord.name)
    ) {
      return;
    }
    const registryPath = path.join(this.#sessionsDir, `${process.pid}.json`);
    await Promise.all(
      [registryPath, `${registryPath}.tmp`].map(async (candidate) =>
        unlink(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }),
      ),
    );
    this.#advertisedRecord = undefined;
  }

  async acknowledge(
    receiptHandle: string,
    status: "held" | "delivered" | "denied" | "expired",
    diagnostic?: ClaudePeerDeliveryDiagnostic,
  ): Promise<void> {
    const receipt = this.#inboundReceipts.get(receiptHandle);
    if (this.#closed || receipt === undefined) return;
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
    const binding = await this.#revalidateBinding(receipt.binding);
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
      diagnostic === undefined
        ? undefined
        : encodeClaudePeerUserFrame({
            messageId: this.#createId(),
            content: [
              `<gateway-delivery-diagnostic status="expired" code="${diagnostic.code}">`,
              "The local gateway could not deliver the preceding message. Inspect its dashboard for details.",
              "</gateway-delivery-diagnostic>",
            ].join("\n"),
            maxFrameBytes: this.#limits.maxFrameBytes,
          });
    const payload =
      diagnosticFrame === undefined
        ? statusFrame
        : Buffer.concat([statusFrame, diagnosticFrame]);
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
        socket.end(payload, () => finish());
      });
    });
    if (status !== "held") this.#inboundReceipts.delete(receiptHandle);
  }

  track(messageId: string, binding: TargetBinding): void {
    if (this.#closed) {
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
    const timer = setTimeout(() => {
      const pending = this.#pending.get(messageId);
      if (pending === undefined) return;
      this.#pending.delete(messageId);
      void this.#emitReceipt({
        messageId,
        status: "ambiguous",
        trust: "untrusted_same_uid_peer",
      });
    }, this.#limits.receiptDeadlineMs);
    timer.unref();
    this.#pending.set(messageId, { binding, state: "pending", timer });
  }

  untrack(messageId: string): void {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(messageId);
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#connections.size >= this.#limits.maxConnections) {
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
          .then(async () => this.#handleFrame(frame))
          .catch(async () => this.#notice("CALLBACK_ERROR"))
          .finally(() => {
            this.#queuedFrames -= 1;
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

  async #handleFrame(frame: ParsedFrame): Promise<void> {
    if (this.#closed) return;
    if (frame.type === "control") {
      await this.#handleControl(frame);
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
    if (
      binding !== undefined &&
      frame.messageId !== undefined &&
      this.#inboundReceipts.size < this.#limits.maxPendingReceipts
    ) {
      this.#inboundReceipts.set(inboundId, {
        binding,
        originalMessageId: frame.messageId,
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

  async #handleControl(frame: ParsedControlFrame): Promise<void> {
    const pending = this.#pending.get(frame.originalMessageId);
    if (pending === undefined) {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    if (frame.from !== `uds:${pending.binding.record.messagingSocketPath}`) {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    try {
      await this.#revalidateBinding(pending.binding);
    } catch {
      await this.#notice("UNKNOWN_RECEIPT");
      return;
    }
    if (frame.status === "held") {
      if (pending.state !== "pending") {
        await this.#notice("INVALID_RECEIPT_TRANSITION");
        return;
      }
      pending.state = "held";
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.unadvertise();
    const unsettledMessageIds = [...this.#pending.keys()];
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#inboundReceipts.clear();
    await Promise.allSettled(
      unsettledMessageIds.map(async (messageId) =>
        this.#emitReceipt({
          messageId,
          status: "ambiguous",
          trust: "untrusted_same_uid_peer",
        }),
      ),
    );
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
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
        this.#onClosed();
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_CHANGED",
          "The callback path changed; foreign replacement was preserved.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#server.unref();
        this.#onClosed();
        throw new BridgeError(
          "CLAUDE_PEER_CALLBACK_CHANGED",
          "The callback path disappeared; cleanup failed closed.",
        );
      }
      if (error instanceof BridgeError) throw error;
      this.#server.unref();
      this.#onClosed();
      throw error;
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.#onClosed();
    }
  }
}
