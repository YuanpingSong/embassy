import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";
import {
  networkAccessModes,
  permissionProfiles,
  taskStatuses,
  type FinalReport,
  type JsonValue,
  type TaskEvent,
  type TaskRecord,
} from "./types.js";

const TASK_ID_PATTERN =
  /^claude_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_MARKER = ".claude-agent-bridge-state";
const STATE_MARKER_CONTENT = "claude-agent-mcp-bridge-state-v1\n";
const CONTROLLER_LOCK = ".controller.lock";
const TASK_STATUS_SET = new Set<string>(taskStatuses);
const PERMISSION_PROFILE_SET = new Set<string>(permissionProfiles);
const NETWORK_ACCESS_SET = new Set<string>(networkAccessModes);
const TASK_EVENT_TYPE_SET = new Set<string>([
  "task_created",
  "runtime_started",
  "session_started",
  "followup_queued",
  "progress",
  "tool_started",
  "tool_progress",
  "permission_denied",
  "retrying",
  "turn_completed",
  "turn_failed",
  "interrupt_requested",
  "task_interrupted",
  "task_cancelled",
  "runtime_stopped",
  "controller_recovered",
]);
const REPORT_OUTCOME_SET = new Set<string>([
  "completed",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
]);
const VERIFICATION_STATUS_SET = new Set<string>([
  "passed",
  "failed",
  "not_run",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isObject(value) &&
    Object.values(value).every((item) => isJsonValue(item))
  );
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!isObject(value)) return false;
  return (
    isNonNegativeInteger(value.sequence) &&
    typeof value.timestamp === "string" &&
    typeof value.type === "string" &&
    TASK_EVENT_TYPE_SET.has(value.type) &&
    typeof value.status === "string" &&
    TASK_STATUS_SET.has(value.status) &&
    typeof value.message === "string" &&
    (value.details === undefined ||
      (isObject(value.details) &&
        Object.values(value.details).every((item) => isJsonValue(item))))
  );
}

function isFinalReport(value: unknown): value is FinalReport {
  if (!isObject(value) || !isObject(value.metrics)) return false;
  const durationMs = value.metrics.durationMs;
  const turns = value.metrics.turns;
  const stopReason = value.metrics.stopReason;
  const permissionDenials = value.metrics.permissionDenials;
  return (
    typeof value.outcome === "string" &&
    REPORT_OUTCOME_SET.has(value.outcome) &&
    typeof value.summary === "string" &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(
      (item) =>
        isObject(item) &&
        typeof item.path === "string" &&
        typeof item.summary === "string",
    ) &&
    Array.isArray(value.verification) &&
    value.verification.every(
      (item) =>
        isObject(item) &&
        typeof item.name === "string" &&
        typeof item.status === "string" &&
        VERIFICATION_STATUS_SET.has(item.status) &&
        typeof item.details === "string",
    ) &&
    isStringArray(value.decisionsNeeded) &&
    isStringArray(value.warnings) &&
    (durationMs === undefined ||
      (typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs >= 0)) &&
    (turns === undefined ||
      (typeof turns === "number" &&
        Number.isFinite(turns) &&
        turns >= 0)) &&
    isOptionalString(stopReason) &&
    (permissionDenials === undefined ||
      isNonNegativeInteger(permissionDenials))
  );
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

async function canonicalFuturePath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      const ancestor = await realpath(cursor);
      return path.join(ancestor, ...suffix);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function hasValidStateMarker(marker: string): Promise<boolean> {
  let markerInfo;
  try {
    markerInfo = await lstat(marker);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
    throw new BridgeError(
      "STATE_DIRECTORY_NOT_OWNED",
      "The Claude bridge state marker is not a regular file.",
    );
  }
  const markerBody = await readFile(marker, "utf8");
  if (markerBody !== STATE_MARKER_CONTENT) {
    throw new BridgeError(
      "STATE_DIRECTORY_NOT_OWNED",
      "The existing directory is not owned by this Claude bridge version.",
    );
  }
  return true;
}

export async function prepareOwnedStateDirectory(
  requestedRoot: string,
  forbiddenRoots: string[] = [],
): Promise<string> {
  const resolvedRoot = path.resolve(requestedRoot);
  try {
    const requestedInfo = await lstat(resolvedRoot);
    if (requestedInfo.isSymbolicLink()) {
      throw new BridgeError(
        "UNSAFE_STATE_DIRECTORY",
        "The controller state path must not be a symlink.",
      );
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const canonical = await canonicalFuturePath(resolvedRoot);
  const parsed = path.parse(canonical);
  const home = await realpath(os.homedir()).catch(() =>
    path.resolve(os.homedir()),
  );
  const temporaryRoot = await realpath(os.tmpdir()).catch(() =>
    path.resolve(os.tmpdir()),
  );
  if (
    canonical === parsed.root ||
    canonical === home ||
    canonical === temporaryRoot
  ) {
    throw new BridgeError(
      "UNSAFE_STATE_DIRECTORY",
      "The controller state directory must be a dedicated leaf, not the filesystem root, home directory, or shared temporary root.",
    );
  }
  const canonicalForbiddenRoots = await Promise.all(
    forbiddenRoots.map(canonicalFuturePath),
  );
  if (canonicalForbiddenRoots.some((root) => overlaps(root, canonical))) {
    throw new BridgeError(
      "STATE_WORKSPACE_OVERLAP",
      "The controller state directory and allowed Claude workspaces must be disjoint.",
    );
  }

  let existed = true;
  try {
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new BridgeError(
        "UNSAFE_STATE_DIRECTORY",
        "The controller state path must be a real directory, not a symlink or another file type.",
      );
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new BridgeError(
        "UNSAFE_STATE_DIRECTORY",
        "The existing controller state directory is not owned by this process user.",
      );
    }
    if ((info.mode & 0o077) !== 0) {
      throw new BridgeError(
        "UNSAFE_STATE_DIRECTORY",
        "The existing controller state directory must already be private (mode 0700 or stricter).",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      existed = false;
    } else {
      throw error;
    }
  }

  if (!existed) {
    await mkdir(canonical, { recursive: true, mode: 0o700 });
    await chmod(canonical, 0o700);
  }
  const rootDir = await realpath(canonical);

  const marker = path.join(rootDir, STATE_MARKER);
  if (existed) {
    const hasMarker = await hasValidStateMarker(marker);
    if (!hasMarker) {
      const entries = await readdir(rootDir);
      if (
        entries.length !== 0 &&
        !(await hasValidStateMarker(marker))
      ) {
        throw new BridgeError(
          "STATE_DIRECTORY_NOT_OWNED",
          "The existing state directory is non-empty and has no Claude bridge ownership marker.",
        );
      }
    }
  }
  try {
    await writeFile(marker, STATE_MARKER_CONTENT, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  await chmod(marker, 0o600);
  return rootDir;
}

export class TaskStore {
  rootDir: string;
  private lockHandle: FileHandle | undefined;
  private lockToken: string | undefined;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  get tasksDir(): string {
    return path.join(this.rootDir, "tasks");
  }

  get temporaryDir(): string {
    return path.join(this.rootDir, "tmp");
  }

  get profilesDir(): string {
    return path.join(this.rootDir, "profiles");
  }

  async initialize(forbiddenRoots: string[] = []): Promise<void> {
    this.rootDir = await prepareOwnedStateDirectory(
      this.rootDir,
      forbiddenRoots,
    );

    await this.acquireControllerLock();
    try {
      await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
      await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
      await mkdir(this.profilesDir, { recursive: true, mode: 0o700 });
      await Promise.all([
        chmod(this.tasksDir, 0o700),
        chmod(this.temporaryDir, 0o700),
        chmod(this.profilesDir, 0o700),
      ]);
    } catch (error) {
      await this.releaseControllerLock();
      throw error;
    }
  }

  async releaseControllerLock(): Promise<void> {
    const handle = this.lockHandle;
    const token = this.lockToken;
    this.lockHandle = undefined;
    this.lockToken = undefined;
    if (!handle || !token) return;
    await handle.close().catch(() => undefined);
    const lockPath = path.join(this.rootDir, CONTROLLER_LOCK);
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
        token?: unknown;
      };
      if (parsed.token === token) await unlink(lockPath);
    } catch {
      // Never remove a lock that cannot be proven to belong to this instance.
    }
  }

  private async acquireControllerLock(): Promise<void> {
    if (this.lockHandle) return;
    const lockPath = path.join(this.rootDir, CONTROLLER_LOCK);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify({
              schemaVersion: 1,
              pid: process.pid,
              hostname: os.hostname(),
              token,
              startedAt: new Date().toISOString(),
            })}\n`,
            "utf8",
          );
          await handle.sync();
          await chmod(lockPath, 0o600);
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        this.lockHandle = handle;
        this.lockToken = token;
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }

      let owner: { pid?: unknown; hostname?: unknown };
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
          hostname?: unknown;
        };
      } catch {
        throw new BridgeError(
          "STATE_LOCK_UNVERIFIED",
          "The controller state lock exists but cannot be verified. Inspect it without printing task data before removing it.",
        );
      }
      if (
        owner.hostname !== os.hostname() ||
        typeof owner.pid !== "number" ||
        !Number.isInteger(owner.pid) ||
        owner.pid < 1
      ) {
        throw new BridgeError(
          "STATE_IN_USE",
          "The controller state directory is locked by another or unverifiable host process.",
          true,
        );
      }
      let ownerAlive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          ownerAlive = false;
        }
      }
      if (ownerAlive) {
        throw new BridgeError(
          "STATE_IN_USE",
          "Another live Claude bridge process owns this controller state directory.",
          true,
        );
      }
      try {
        await rename(
          lockPath,
          path.join(
            this.rootDir,
            `.controller.lock.stale-${randomUUID()}`,
          ),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    throw new BridgeError(
      "STATE_IN_USE",
      "Could not acquire exclusive ownership of the controller state directory.",
      true,
    );
  }

  newTaskId(): string {
    return `claude_${randomUUID()}`;
  }

  async create(record: TaskRecord): Promise<void> {
    this.validateTaskId(record.taskId);
    const directory = this.taskDirectory(record.taskId);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await mkdir(this.taskTemporaryDirectory(record.taskId), {
      recursive: false,
      mode: 0o700,
    });
    await mkdir(this.taskProfileDirectory(record.taskId), {
      recursive: false,
      mode: 0o700,
    });
    await chmod(directory, 0o700);
    await this.save(record);
  }

  async save(record: TaskRecord): Promise<void> {
    this.validateTaskId(record.taskId);
    const directory = this.taskDirectory(record.taskId);
    const target = path.join(directory, "task.json");
    const temporary = path.join(directory, `.task-${randomUUID()}.tmp`);
    const body = `${JSON.stringify(record, null, 2)}\n`;

    await writeFile(temporary, body, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async load(taskId: string): Promise<TaskRecord> {
    this.validateTaskId(taskId);
    try {
      const body = await readFile(
        path.join(this.taskDirectory(taskId), "task.json"),
        "utf8",
      );
      const parsed = JSON.parse(body) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 1
      ) {
        throw new BridgeError(
          "LEGACY_TASK_BACKEND",
          "This task belongs to an earlier bridge backend and cannot be resumed by the local Claude Code CLI. Start a new task.",
        );
      }
      if (!this.isTaskRecord(parsed) || parsed.taskId !== taskId) {
        throw new BridgeError(
          "CORRUPT_TASK_STATE",
          `Controller state for task ${taskId} is invalid.`,
        );
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new BridgeError(
          "TASK_NOT_FOUND",
          `No Claude task exists with id ${taskId}.`,
        );
      }
      throw error;
    }
  }

  async loadAll(): Promise<TaskRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.tasksDir);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const records: TaskRecord[] = [];
    for (const entry of entries) {
      if (!TASK_ID_PATTERN.test(entry)) continue;
      try {
        records.push(await this.load(entry));
      } catch {
        // A corrupt task is isolated to its own controller-owned directory.
        // The server remains available so other task state can be recovered.
      }
    }
    return records;
  }

  private taskDirectory(taskId: string): string {
    return path.join(this.tasksDir, taskId);
  }

  taskTemporaryDirectory(taskId: string): string {
    this.validateTaskId(taskId);
    return path.join(this.temporaryDir, taskId);
  }

  taskProfileDirectory(taskId: string): string {
    this.validateTaskId(taskId);
    return path.join(this.profilesDir, taskId);
  }

  private validateTaskId(taskId: string): void {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new BridgeError(
        "INVALID_TASK_ID",
        "Task ids must be ids previously returned by task_start.",
      );
    }
  }

  private isTaskRecord(value: unknown): value is TaskRecord {
    if (!isObject(value)) return false;
    const record = value;
    return (
      record.schemaVersion === 2 &&
      record.backend === "local_claude_code" &&
      typeof record.taskId === "string" &&
      TASK_ID_PATTERN.test(record.taskId) &&
      typeof record.title === "string" &&
      typeof record.cwd === "string" &&
      path.isAbsolute(record.cwd) &&
      isOptionalString(record.requestedModel) &&
      isOptionalString(record.activeModel) &&
      typeof record.permissionProfile === "string" &&
      PERMISSION_PROFILE_SET.has(record.permissionProfile) &&
      typeof record.networkAccess === "string" &&
      NETWORK_ACCESS_SET.has(record.networkAccess) &&
      Number.isInteger(record.maxTurns) &&
      (record.maxTurns as number) >= 1 &&
      isNonNegativeInteger(record.turnsUsed) &&
      typeof record.usageAccountingComplete === "boolean" &&
      typeof record.processExitConfirmed === "boolean" &&
      typeof record.status === "string" &&
      TASK_STATUS_SET.has(record.status) &&
      isOptionalString(record.sessionId) &&
      typeof record.createdAt === "string" &&
      typeof record.updatedAt === "string" &&
      isOptionalString(record.startedAt) &&
      isOptionalString(record.completedAt) &&
      isNonNegativeInteger(record.turnsQueued) &&
      isNonNegativeInteger(record.turnsCompleted) &&
      isNonNegativeInteger(record.turnsAbandoned) &&
      isNonNegativeInteger(record.eventSequence) &&
      Array.isArray(record.events) &&
      record.events.every((event) => isTaskEvent(event)) &&
      (record.finalReport === undefined ||
        isFinalReport(record.finalReport)) &&
      (record.lastError === undefined ||
        (isObject(record.lastError) &&
          typeof record.lastError.code === "string" &&
          typeof record.lastError.message === "string" &&
          typeof record.lastError.recoverable === "boolean"))
    );
  }
}
