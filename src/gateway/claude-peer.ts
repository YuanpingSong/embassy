import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { BridgeError } from "../errors.js";

export const CLAUDE_PEER_COMPATIBILITY = Object.freeze({ peerProtocol: 1 });

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
  "CLAUDE_SESSION_DUPLICATE",
] as const;
export type ClaudePeerRejectionCode =
  (typeof claudePeerRejectionCodes)[number];

export type ClaudePeerDescriptor = {
  targetId: string; // Stable session UUID; names and sockets are coordinates.
  alias: string; kind: ClaudePeerKind; status: ClaudePeerStatus;
  compatibility: "compatible";
  duplicate?: Readonly<{ selectedPid: number; stalePids: readonly number[] }>;
};
export type ClaudePeerDiscovery = {
  peers: ClaudePeerDescriptor[];
  rejected: Partial<Record<ClaudePeerRejectionCode, number>>;
  truncated: boolean; entriesScanned: number; parseableRecords: number;
};
export type ClaudeProcessIdentity = {
  uid: number; generation: string;
};
export type ClaudeProcessInspector = (
  pid: number,
) => Promise<ClaudeProcessIdentity | undefined>;
export type ClaudePeerConnect = (socketPath: string) => Socket;
export type ClaudePeerAdapterOptions = {
  sessionsDir: string; socketDir: string;
  maxRegistryEntries?: number; maxRegistryBytes?: number;
  maxFrameBytes?: number; connectTimeoutMs?: number;
};
export type ClaudePeerAdapterTestOverrides = {
  expectedUid?: number; processInspector?: ClaudeProcessInspector;
  connect?: ClaudePeerConnect; now?: () => number; createId?: () => string;
  userHome?: string; tempRoots?: readonly string[];
};
export type ClaudePeerPreparedSendResult = {
  messageId: string; transportStatus: "transport_written";
};
export type ClaudePeerPreparedSend = Readonly<{
  messageId: string; frameBytes: number; sha256: string;
  perform: (authorize: () => Promise<boolean>) => Promise<ClaudePeerPreparedSendResult>;
  cancel: () => void;
}>;
type FileGeneration = { dev: number; ino: number; size: number; mtimeMs: number };
type SocketGeneration = { dev: bigint; ino: bigint; ctimeNs: bigint };

type ParsedRegistryRecord = {
  pid: number; sessionId: string; cwd: string; kind: ClaudePeerKind; startedAt: number;
  messagingSocketPath: string; name: string; status: ClaudePeerStatus;
};
type TargetBinding = Readonly<{
  targetId: string; alias: string; record: ParsedRegistryRecord;
  registryPath: string;
  processGeneration: string;
  socketGeneration: SocketGeneration;
}>;
type CanonicalUserFrame = {
  msgV: 1; msg_id: string; type: "user";
  message: { role: "user"; content: string };
  priority: "next";
};
type AdapterLimits = {
  maxRegistryEntries: number; maxRegistryBytes: number; maxFrameBytes: number;
  connectTimeoutMs: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
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
  const required = ["pid", "sessionId", "cwd", "startedAt", "procStart",
    "peerProtocol", "kind", "entrypoint", "messagingSocketPath", "name",
    "updatedAt"] as const;
  if (!required.every((key) => Object.hasOwn(value, key))) return undefined;
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
    startedAt: value.startedAt as number,
    sessionId: value.sessionId.toLowerCase(),
    cwd: value.cwd,
    kind: value.kind as ClaudePeerKind,
    messagingSocketPath: value.messagingSocketPath,
    name: value.name,
    status: (value.status ?? "busy") as ClaudePeerStatus,
  };
}

export function encodeClaudePeerUserFrame(input: {
  messageId: string;
  content: string;
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
  const frame: CanonicalUserFrame = {
    msgV: 1,
    msg_id: input.messageId,
    type: "user",
    message: { role: "user", content },
    priority: "next",
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
  return await new Promise((resolve) => {
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

function writeSocketPayload(
  connect: ClaudePeerConnect,
  socketPath: string,
  payload: Buffer,
  timeoutMs: number,
  beforeWrite: () => Promise<void>,
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
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error === undefined ? resolve() : reject(error);
    };
    socket.once("error", finish);
    socket.once("connect", () => void (async () => {
      try {
        await beforeWrite();
        if (settled) return;
        onWriteStart();
        socket.end(payload, () => finish());
      } catch (error) {
        finish(error);
      }
    })());
  });
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
  readonly #selectedStateRoots = new Map<string, string>();
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
  ): Promise<unknown> {
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
      return value;
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
    const stat = await lstat(socketPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isSocket()) {
      throw new BridgeError("SOCKET_NOT_SOCKET", "Peer endpoint is not a socket.");
    }
    return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs };
  }

  async #bindingFromRegistry(
    registryPath: string,
    expectedPid: number,
    onParsed?: () => void,
  ): Promise<TargetBinding> {
    const value = await this.#readRegistryFile(registryPath);
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
    if (expectedPid === process.pid) {
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
      record,
      registryPath,
      processGeneration: processIdentity.generation,
      socketGeneration,
    };
  }

  async #revalidatePreparedBinding(
    expected: TargetBinding,
    stateRoot: string,
  ): Promise<void> {
    try {
      const { targets, discovery } = await this.#scan();
      if (discovery.truncated) throw new Error("incomplete newest-process evidence");
      const selected = targets.get(expected.targetId);
      if (!selected || selected.registryPath !== expected.registryPath) throw new Error("selected Claude process changed");
      const current = await this.#bindingFromRegistry(selected.registryPath, selected.record.pid);
      if (
        current.targetId !== expected.targetId ||
        current.record.cwd !== expected.record.cwd ||
        current.record.messagingSocketPath !== expected.record.messagingSocketPath ||
        current.processGeneration !== expected.processGeneration ||
        !sameSocketGeneration(current.socketGeneration, expected.socketGeneration)
      ) {
        throw new Error("prepared Claude peer generation changed");
      }
      await this.#attestOwnedDirectory(
        stateRoot,
        true,
        "CLAUDE_PEER_STATE_ROOT_UNSAFE",
      );
      await this.#assertBindingWorkspaceDisjoint(current);
    } catch {
      throw new BridgeError(
        "CLAUDE_PEER_TARGET_CHANGED",
        "The prepared Claude peer generation changed before the write.",
        true,
      );
    }
  }

  // A duplicate is the only discovery case that needs a connection probe.
  // It sends zero bytes, has the ordinary connect deadline, and always closes.
  async #socketLive(binding: TargetBinding): Promise<boolean> {
    return new Promise((resolve) => {
      let socket: Socket;
      try { socket = this.#connect(binding.record.messagingSocketPath); }
      catch { resolve(false); return; }
      let settled = false;
      const finish = (live: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(live);
      };
      const timer = setTimeout(() => finish(false), this.#limits.connectTimeoutMs);
      timer.unref();
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("close", () => finish(false));
    });
  }

  async #scan(): Promise<{ discovery: ClaudePeerDiscovery; targets: Map<string, TargetBinding> }> {
    await this.#validateRoots();
    const nextTargets = new Map<string, TargetBinding>();
    const candidates = new Map<string, TargetBinding[]>();
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
          () => {
            parseableRecords += 1;
          },
        );
        const group = candidates.get(binding.targetId) ?? [];
        group.push(binding);
        candidates.set(binding.targetId, group);
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
    for (const observed of candidates.values()) {
      // A daemon record cannot hide a routable interactive/background session.
      const routable = observed.filter((row) => row.record.kind === "interactive" || row.record.kind === "bg");
      const group = routable.length ? routable : observed;
      // OS start time is primary; the same-user registry resolves sub-second
      // ties. PID is only a deterministic final tie-break, never a start clock.
      const start = (binding: TargetBinding) => Date.parse(binding.processGeneration) || binding.record.startedAt;
      group.sort((a, b) => start(b) - start(a) || b.record.startedAt - a.record.startedAt || b.record.pid - a.record.pid);
      const live = group.length === 1 ? [true] : await Promise.all(group.map((binding) => this.#socketLive(binding)));
      const binding = group.find((_, index) => live[index]);
      if (!binding) { reject("PID_NOT_LIVE"); continue; }
      nextTargets.set(binding.targetId, binding);
      if (group.length > 1) reject("CLAUDE_SESSION_DUPLICATE");
      peers.push({ targetId: binding.targetId, alias: binding.alias, kind: binding.record.kind,
        status: binding.record.status, compatibility: "compatible",
        ...(group.length > 1 ? { duplicate: { selectedPid: binding.record.pid,
          stalePids: group.filter((row) => row !== binding).map((row) => row.record.pid) } } : {}),
      });
    }
    return { targets: nextTargets, discovery: { peers, rejected, truncated,
      entriesScanned: bounded.length, parseableRecords } };
  }

  async discover(): Promise<ClaudePeerDiscovery> {
    const { targets: nextTargets, discovery } = await this.#scan();
    this.#targets.clear();
    for (const [targetId, binding] of nextTargets) {
      this.#targets.set(targetId, binding);
    }
    return discovery;
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
    if (binding.record.kind !== "interactive" && binding.record.kind !== "bg")
      throw new BridgeError("CLAUDE_REPLY_ROUTE_MISMATCH", "Only interactive/background Claude sessions may send.");
    const peer = (await this.discover()).peers.find((row) => row.targetId === binding.targetId);
    if (!peer) throw new BridgeError("CLAUDE_PEER_TARGET_UNKNOWN", "The Claude session has no live binding.", true);
    return peer;
  }

  async prepareSend(
    targetId: string,
    content: string,
    options: Readonly<{
      deadlineAt: number;
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
    // bytes and the already-validated socket path. Duplicate liveness probes
    // send no bytes; the only message write is the one-shot perform function.
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
    const frame = encodeClaudePeerUserFrame({
      messageId,
      content,
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

    const perform = async (
      authorize: () => Promise<boolean>,
    ): Promise<ClaudePeerPreparedSendResult> => {
      if (state !== "prepared") {
        throw new BridgeError(
          "CLAUDE_PEER_PREPARATION_CONSUMED",
          "The prepared Claude peer write was already performed or cancelled.",
        );
      }
      state = "performed";
      this.#preparedSends.delete(cancel);
      if (options.deadlineAt <= this.#now()) {
        throw new BridgeError(
          "CLAUDE_PEER_MESSAGE_EXPIRED",
          "The Claude peer message deadline elapsed before any socket write.",
          true,
        );
      }

      let writeStarted = false;
      let authorizationStarted = false;
      await this.#revalidatePreparedBinding(target, stateRoot);
      const write = writeSocketPayload(
        this.#connect,
        socketPath,
        frame,
        Math.max(
          1,
          Math.min(this.#limits.connectTimeoutMs, options.deadlineAt - this.#now()),
        ),
        async () => {
          await this.#revalidatePreparedBinding(target, stateRoot);
          authorizationStarted = true;
          let authorized: boolean;
          try {
            authorized = await authorize();
          } catch {
            throw new BridgeError(
              "WRITE_AUTHORIZATION_UNCERTAIN",
              "The final write authorization outcome is uncertain; do not retry automatically.",
            );
          }
          if (!authorized) {
            throw new BridgeError(
              "WRITE_AUTHORIZATION_DENIED",
              "The final write authorization was denied before any socket write.",
              true,
            );
          }
        },
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
      return await write.then(
        () => ({ messageId, transportStatus: "transport_written" as const }),
        (error: unknown) => {
          if (error instanceof BridgeError) throw error;
          const expired = this.#now() >= options.deadlineAt;
          throw new BridgeError(
            writeStarted || authorizationStarted
              ? "CLAUDE_PEER_WRITE_AMBIGUOUS"
              : expired
                ? "CLAUDE_PEER_MESSAGE_EXPIRED"
                : error instanceof Error && error.message === "peer write timeout"
                  ? "CLAUDE_PEER_CONNECT_TIMEOUT"
                  : "CLAUDE_PEER_WRITE_FAILED",
            writeStarted || authorizationStarted
              ? "The Claude write or final authorization began but its outcome is ambiguous; do not retry automatically."
              : expired
                ? "The Claude peer message deadline elapsed before any socket write."
                : "The Claude peer message was not confirmed written.",
            !writeStarted && !authorizationStarted,
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
    this.#targets.clear();
    this.#selectedStateRoots.clear();
  }
}
