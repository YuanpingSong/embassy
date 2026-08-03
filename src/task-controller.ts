import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { BridgeError, safeError } from "./errors.js";
import { KeyedMutex } from "./mutex.js";
import { TaskStore } from "./task-store.js";
import {
  isTerminalStatus,
  type AgentDriver,
  type AgentProgress,
  type AgentRunHandle,
  type FinalReport,
  type FollowupInput,
  type JsonValue,
  type StartTaskInput,
  type TaskEvent,
  type TaskEventType,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
  type WaitInput,
  type WaitResult,
} from "./types.js";

const EVENT_RETENTION = 256;
const ACTIVE_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "waiting",
  "cancelling",
]);

type ActiveRuntime = {
  generation: symbol;
  handle?: AgentRunHandle;
  cancelRequested: boolean;
  usageReported: boolean;
  idleTimer?: NodeJS.Timeout;
};

type ChangeListener = () => void;

export type InterruptDisposition = "interrupt" | "cancel";

export type InterruptResult = {
  task: TaskSnapshot;
  requested: boolean;
  disposition: InterruptDisposition;
};

function now(): string {
  return new Date().toISOString();
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

function cancelledReport(outcome: "cancelled" | "interrupted"): FinalReport {
  return {
    outcome,
    summary:
      outcome === "cancelled"
        ? "The Claude task was cancelled by the coordinator."
        : "The active Claude turn was interrupted by the coordinator. Prior side effects were not rolled back.",
    changedFiles: [],
    verification: [],
    decisionsNeeded: [],
    warnings: [
      "Interrupting a task does not undo file edits, commands, or external effects that already occurred.",
    ],
    metrics: {},
  };
}

function progressEventType(progress: AgentProgress): TaskEventType {
  switch (progress.kind) {
    case "tool_started":
      return "tool_started";
    case "tool_progress":
      return "tool_progress";
    case "permission_denied":
      return "permission_denied";
    case "retrying":
      return "retrying";
    default:
      return "progress";
  }
}

export class TaskController {
  private readonly store: TaskStore;
  private readonly driver: AgentDriver;
  private readonly config: BridgeConfig;
  private readonly locks = new KeyedMutex();
  private readonly lifecycleLocks = new KeyedMutex();
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private readonly listeners = new Map<string, Set<ChangeListener>>();
  private allowedRoots: string[] = [];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private activeWorkOperations = 0;
  private readonly workDrainedWaiters = new Set<() => void>();

  constructor(config: BridgeConfig, store: TaskStore, driver: AgentDriver) {
    this.config = config;
    this.store = store;
    this.driver = driver;
  }

  async initialize(): Promise<void> {
    this.allowedRoots = [];
    const home = await realpath(os.homedir()).catch(() =>
      path.resolve(os.homedir()),
    );
    const sharedTemporaryRoot = await realpath(os.tmpdir()).catch(() =>
      path.resolve(os.tmpdir()),
    );
    for (const root of this.config.allowedWorkspaceRoots) {
      try {
        const canonical = await realpath(root);
        const info = await stat(canonical);
        if (!info.isDirectory()) continue;
        const parsed = path.parse(canonical);
        if (
          canonical === parsed.root ||
          canonical === sharedTemporaryRoot ||
          inside(canonical, home)
        ) {
          throw new BridgeError(
            "WORKSPACE_ROOT_TOO_BROAD",
            `Configured Claude workspace root is too broad: ${canonical}`,
          );
        }
        this.allowedRoots.push(canonical);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        // Invalid configured roots remain unavailable instead of widening scope.
      }
    }
    if (this.allowedRoots.length === 0) {
      throw new BridgeError(
        "NO_ALLOWED_WORKSPACE",
        "No configured Claude workspace root exists. Set CLAUDE_BRIDGE_ALLOWED_ROOTS to one or more explicit directories.",
      );
    }
    await this.store.initialize(this.allowedRoots);

    try {
      const records = await this.store.loadAll();
      for (const record of records) {
        record.turnsAbandoned ??= 0;
        if (!ACTIVE_STATUSES.has(record.status)) continue;
        await this.mutate(record.taskId, (draft) => {
          this.abandonOutstandingTurns(draft);
          draft.usageAccountingComplete = false;
          draft.status = "interrupted";
          draft.completedAt = now();
          draft.lastError = {
            code: "CONTROLLER_RESTART",
            message:
              "The bridge restarted while this turn was active. It was not replayed because prior side effects are unknown.",
            recoverable: false,
          };
          draft.finalReport = {
            outcome: "interrupted",
            summary:
              "The active turn was interrupted by a controller restart and was not replayed.",
            changedFiles: [],
            verification: [],
            decisionsNeeded: [],
            warnings: [
              "Some side effects may have occurred before the controller restart.",
              "The interrupted runtime's final usage metrics are unavailable; cumulative accounting is incomplete.",
            ],
            metrics: {},
          };
          this.addEvent(
            draft,
            "controller_recovered",
            "interrupted",
            "Recovered an active task after controller restart without replaying it.",
          );
        });
      }
    } catch (error) {
      await this.store.releaseControllerLock();
      throw error;
    }
  }

  async startTask(input: StartTaskInput): Promise<TaskSnapshot> {
    return await this.trackWorkOperation(
      async () => await this.startTaskTracked(input),
    );
  }

  private async startTaskTracked(
    input: StartTaskInput,
  ): Promise<TaskSnapshot> {
    this.ensureAcceptingWork();
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new BridgeError(
        "EMPTY_PROMPT",
        "A Claude task prompt must not be empty.",
      );
    }
    const cwd = await this.validateWorkspace(input.cwd);
    const permissionProfile = input.permissionProfile ?? "read_only";
    const networkAccess = input.networkAccess ?? "none";
    const maxTurns = input.maxTurns ?? this.config.defaultMaxTurns;
    const requestedModel = (input.model ?? this.config.defaultModel)?.trim();

    if (
      requestedModel &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(requestedModel)
    ) {
      throw new BridgeError(
        "INVALID_MODEL",
        "Claude model names must use only letters, digits, dots, underscores, colons, and hyphens, and must not begin with a hyphen.",
      );
    }

    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new BridgeError(
        "INVALID_TASK_LIMIT",
        "maxTurns must be a positive integer.",
      );
    }
    if (maxTurns > this.config.maximumMaxTurns) {
      throw new BridgeError(
        "MAX_TURNS_EXCEEDS_POLICY",
        `maxTurns exceeds the bridge ceiling of ${this.config.maximumMaxTurns}.`,
      );
    }
    this.ensureCapabilitiesEnabled(permissionProfile, networkAccess);

    await this.assertCapacity(cwd, permissionProfile !== "read_only");
    const timestamp = now();
    const taskId = this.store.newTaskId();
    const record: TaskRecord = {
      schemaVersion: 2,
      backend: "local_claude_code",
      taskId,
      title: input.title?.trim() || "Claude task",
      cwd,
      ...(requestedModel ? { requestedModel } : {}),
      permissionProfile,
      networkAccess,
      maxTurns,
      turnsUsed: 0,
      usageAccountingComplete: true,
      processExitConfirmed: true,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      turnsQueued: 1,
      turnsCompleted: 0,
      turnsAbandoned: 0,
      eventSequence: 0,
      events: [],
    };
    this.addEvent(
      record,
      "task_created",
      "queued",
      "Claude task created in controller-owned state.",
    );
    await this.store.create(record);
    await this.beginRuntime(record, prompt);
    return await this.getTask(taskId);
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    return this.snapshot(await this.store.load(taskId));
  }

  async followup(input: FollowupInput): Promise<TaskSnapshot> {
    return await this.trackWorkOperation(
      async () => await this.followupTracked(input),
    );
  }

  private async followupTracked(
    input: FollowupInput,
  ): Promise<TaskSnapshot> {
    this.ensureAcceptingWork();
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new BridgeError(
        "EMPTY_FOLLOWUP",
        "A follow-up message must not be empty.",
      );
    }
    return await this.lifecycleLocks.run(input.taskId, async () => {
      return await this.followupLocked(input.taskId, prompt);
    });
  }

  private async followupLocked(
    taskId: string,
    prompt: string,
  ): Promise<TaskSnapshot> {
    let priorRuntime: ActiveRuntime | undefined;
    await this.locks.run(taskId, async () => {
      const record = await this.store.load(taskId);
      if (record.status === "cancelled") {
        throw new BridgeError(
          "TASK_CANCELLED",
          "This task was permanently cancelled and cannot accept follow-ups.",
        );
      }
      if (record.status === "cancelling") {
        throw new BridgeError(
          "TASK_CANCELLING",
          "This task is currently being interrupted.",
          true,
        );
      }
      if (ACTIVE_STATUSES.has(record.status)) {
        throw new BridgeError(
          "TASK_BUSY",
          "Wait for the current Claude instruction to finish or interrupt it before sending a follow-up.",
          true,
        );
      }
      this.ensureCapabilitiesEnabled(
        record.permissionProfile,
        record.networkAccess,
      );
      if (!record.sessionId) {
        throw new BridgeError(
          "SESSION_UNAVAILABLE",
          "Claude did not establish a resumable session for this task.",
          false,
        );
      }
      if (!record.processExitConfirmed) {
        throw new BridgeError(
          "RUNTIME_EXIT_UNCONFIRMED",
          "The prior Claude Code process did not confirm exit, so this session remains fenced.",
        );
      }
      priorRuntime = this.runtimes.get(record.taskId);
      if (priorRuntime?.idleTimer) clearTimeout(priorRuntime.idleTimer);
    });

    if (priorRuntime?.handle && !priorRuntime.handle.closed) {
      priorRuntime.handle.close();
      const stopped = await Promise.race([
        priorRuntime.handle.done.then(() => true),
        this.delay(this.config.interruptGraceMs).then(() => false),
      ]);
      if (!stopped) {
        throw new BridgeError(
          "RUNTIME_STOP_TIMEOUT",
          "The previous Claude runtime did not stop in time, so the bridge refused to resume the session concurrently.",
          true,
        );
      }
      if (this.runtimes.get(taskId) === priorRuntime) {
        this.runtimes.delete(taskId);
      }
    }

    let launchRecord!: TaskRecord;
    await this.locks.run(taskId, async () => {
      const record = await this.store.load(taskId);
      if (ACTIVE_STATUSES.has(record.status) || record.status === "cancelled") {
        throw new BridgeError(
          "TASK_STATE_CHANGED",
          "The task changed state before its follow-up could start.",
          true,
        );
      }
      if (!record.sessionId) {
        throw new BridgeError(
          "SESSION_UNAVAILABLE",
          "Claude did not establish a resumable session for this task.",
        );
      }
      await this.validatePersistedWorkspace(record);
      this.remainingAllowance(record);
      await this.assertCapacity(
        record.cwd,
        record.permissionProfile !== "read_only",
        record.taskId,
      );
      record.turnsQueued += 1;
      record.status = "queued";
      delete record.completedAt;
      delete record.lastError;
      delete record.finalReport;
      this.addEvent(
        record,
        "followup_queued",
        "queued",
        "A follow-up will resume the same Claude session.",
      );
      await this.store.save(record);
      this.notify(record.taskId);
      launchRecord = record;
    });

    await this.beginRuntime(launchRecord, prompt, false);
    return await this.getTask(taskId);
  }

  async wait(input: WaitInput): Promise<WaitResult> {
    const first = await this.waitSnapshot(
      input.taskId,
      input.afterSequence,
      input.limit,
    );
    if (first.events.length > 0 || first.terminal || input.timeoutMs === 0) {
      return first;
    }

    const changed = await this.waitForChange(
      input.taskId,
      input.afterSequence,
      input.timeoutMs,
      input.signal,
    );
    const result = await this.waitSnapshot(
      input.taskId,
      input.afterSequence,
      input.limit,
    );
    return { ...result, timedOut: !changed && result.events.length === 0 };
  }

  async interrupt(
    taskId: string,
    disposition: InterruptDisposition = "interrupt",
  ): Promise<InterruptResult> {
    return await this.lifecycleLocks.run(taskId, async () => {
      return await this.interruptLocked(taskId, disposition);
    });
  }

  private async interruptLocked(
    taskId: string,
    disposition: InterruptDisposition,
  ): Promise<InterruptResult> {
    let runtime: ActiveRuntime | undefined;
    let terminalRuntime: ActiveRuntime | undefined;
    let requested = false;

    await this.locks.run(taskId, async () => {
      const record = await this.store.load(taskId);
      runtime = this.runtimes.get(taskId);

      if (disposition === "interrupt" && !ACTIVE_STATUSES.has(record.status)) {
        if (runtime?.handle) {
          if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
          terminalRuntime = runtime;
        }
        return;
      }
      if (disposition === "cancel" && record.status === "cancelled") return;

      requested = true;
      if (runtime) {
        runtime.cancelRequested = true;
        if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      }
      record.status = "cancelling";
      this.addEvent(
        record,
        "interrupt_requested",
        "cancelling",
        disposition === "cancel"
          ? "Permanent task cancellation requested."
          : "Active Claude turn interruption requested.",
        { disposition },
      );
      await this.store.save(record);
      this.notify(taskId);
    });

    if (terminalRuntime?.handle) {
      terminalRuntime.handle.close();
      const stopped = await Promise.race([
        terminalRuntime.handle.done.then(() => true),
        this.delay(this.config.interruptGraceMs).then(() => false),
      ]);
      if (!stopped) {
        terminalRuntime.cancelRequested = true;
        throw new BridgeError(
          "RUNTIME_STOP_TIMEOUT",
          "The completed Claude runtime did not confirm shutdown; session resumption remains disabled.",
          true,
        );
      }
      if (this.runtimes.get(taskId) === terminalRuntime) {
        this.runtimes.delete(taskId);
      }
    }

    if (!requested) {
      return {
        task: await this.getTask(taskId),
        requested: false,
        disposition,
      };
    }

    let runtimeStopped = true;
    if (runtime?.handle) {
      await Promise.race([
        runtime.handle.interrupt(),
        this.delay(this.config.interruptGraceMs),
      ]);
      runtimeStopped = await Promise.race([
        runtime.handle.done.then(() => true),
        this.delay(this.config.interruptGraceMs).then(() => false),
      ]);
      if (!runtimeStopped) {
        runtime.handle.close();
        runtimeStopped = await Promise.race([
          runtime.handle.done.then(() => true),
          this.delay(this.config.interruptGraceMs).then(() => false),
        ]);
      }
      if (runtimeStopped && this.runtimes.get(taskId) === runtime) {
        this.runtimes.delete(taskId);
      }
    }

    await this.mutate(taskId, (record) => {
      const status = disposition === "cancel" ? "cancelled" : "interrupted";
      this.abandonOutstandingTurns(record);
      if (runtime && !runtime.usageReported) {
        record.usageAccountingComplete = false;
      }
      record.status = status;
      record.completedAt = now();
      record.finalReport = cancelledReport(status);
      record.lastError = {
        code: status === "cancelled" ? "TASK_CANCELLED" : "TURN_INTERRUPTED",
        message: record.finalReport.summary,
        recoverable:
          status === "interrupted" &&
          runtimeStopped &&
          record.usageAccountingComplete &&
          Boolean(record.sessionId),
      };
      if (!runtimeStopped) {
        record.finalReport.warnings.push(
          "The Claude Code process did not confirm termination; session resumption remains disabled to prevent concurrent transcript access.",
        );
      }
      if (runtime && !runtime.usageReported) {
        record.finalReport.warnings.push(
          "This interrupted Claude Code process did not return final turn metrics; cumulative turn accounting is incomplete.",
        );
      }
      this.addEvent(
        record,
        status === "cancelled" ? "task_cancelled" : "task_interrupted",
        status,
        record.finalReport.summary,
      );
    });

    return {
      task: await this.getTask(taskId),
      requested: true,
      disposition,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    await this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    await this.waitForWorkOperations();
    const taskIds = await this.locks.run(
      "__runtime_capacity__",
      async () => [...this.runtimes.keys()],
    );
    try {
      await Promise.allSettled(
        taskIds.map((taskId) => this.interrupt(taskId, "interrupt")),
      );
    } finally {
      if (this.runtimes.size === 0) {
        await this.store.releaseControllerLock();
      }
    }
  }

  private async trackWorkOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.ensureAcceptingWork();
    this.activeWorkOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeWorkOperations -= 1;
      if (this.activeWorkOperations === 0) {
        for (const resolve of this.workDrainedWaiters) resolve();
        this.workDrainedWaiters.clear();
      }
    }
  }

  private async waitForWorkOperations(): Promise<void> {
    if (this.activeWorkOperations === 0) return;
    await new Promise<void>((resolve) => {
      this.workDrainedWaiters.add(resolve);
    });
  }

  private async beginRuntime(
    record: TaskRecord,
    prompt: string,
    addRuntimeEvent = true,
  ): Promise<void> {
    await this.locks.run("__runtime_capacity__", async () => {
      await this.beginRuntimeLocked(record, prompt, addRuntimeEvent);
    });
  }

  private async beginRuntimeLocked(
    record: TaskRecord,
    prompt: string,
    addRuntimeEvent: boolean,
  ): Promise<void> {
    const runtime: ActiveRuntime = {
      generation: Symbol(record.taskId),
      cancelRequested: false,
      usageReported: false,
    };
    try {
      const latest = await this.store.load(record.taskId);
      this.ensureAcceptingWork();
      if (
        latest.status === "cancelled" ||
        latest.status === "cancelling" ||
        latest.status === "interrupted"
      ) {
        throw new BridgeError(
          "TASK_NOT_RUNNABLE",
          "The task changed state before its Claude runtime could start.",
          true,
        );
      }
      const existing = this.runtimes.get(record.taskId);
      if (existing?.handle && !existing.handle.closed) {
        throw new BridgeError(
          "TASK_BUSY",
          "A Claude runtime is already active for this task.",
          true,
        );
      }
      const remainingTurns = this.remainingAllowance(latest);
      await this.validatePersistedWorkspace(latest);
      await this.assertCapacity(
        latest.cwd,
        latest.permissionProfile !== "read_only",
        latest.taskId,
      );
      await this.mutate(latest.taskId, (draft) => {
        draft.processExitConfirmed = false;
      });
      this.runtimes.set(latest.taskId, runtime);
      const handle = this.driver.start(
        {
          taskId: latest.taskId,
          title: latest.title,
          initialPrompt: prompt,
          cwd: latest.cwd,
          ...(latest.sessionId ? { resumeSessionId: latest.sessionId } : {}),
          ...(latest.requestedModel
            ? { model: latest.requestedModel }
            : {}),
          permissionProfile: latest.permissionProfile,
          networkAccess: latest.networkAccess,
          maxTurns: remainingTurns,
          stateDir: this.store.rootDir,
          tempDir: this.store.taskTemporaryDirectory(latest.taskId),
          profileDir: this.store.taskProfileDirectory(latest.taskId),
          execEnabled: this.config.execEnabled,
          webEnabled: this.config.webEnabled,
        },
        {
          onSession: async (session) => {
            await this.mutate(latest.taskId, (draft) => {
              if (
                this.runtimes.get(latest.taskId) !== runtime ||
                runtime.cancelRequested ||
                draft.status === "cancelling" ||
                draft.status === "cancelled" ||
                draft.status === "interrupted"
              ) {
                return;
              }
              if (draft.sessionId && draft.sessionId !== session.sessionId) {
                throw new BridgeError(
                  "SESSION_RESUME_MISMATCH",
                  "Claude resumed with a different session id than the task owns.",
                );
              }
              draft.sessionId = session.sessionId;
              draft.activeModel = session.model;
              draft.status = "running";
              draft.startedAt ??= now();
              this.addEvent(
                draft,
                "session_started",
                "running",
                "The local Claude Code session initialized.",
                {
                  model: session.model,
                },
              );
            });
          },
          onProgress: async (progress) => {
            await this.mutate(latest.taskId, (draft) => {
              if (
                this.runtimes.get(latest.taskId) !== runtime ||
                runtime.cancelRequested ||
                draft.status === "cancelling" ||
                draft.status === "cancelled" ||
                draft.status === "interrupted"
              ) {
                return;
              }
              if (!isTerminalStatus(draft.status)) {
                draft.status =
                  progress.status === "waiting" ? "waiting" : "running";
              }
              this.addEvent(
                draft,
                progressEventType(progress),
                draft.status,
                progress.message,
                progress.details,
              );
            });
          },
          onResult: async (result) => {
            await this.mutate(latest.taskId, (draft) => {
              if (this.runtimes.get(latest.taskId) !== runtime) return;
              runtime.usageReported = true;
              this.accumulateUsage(draft, result.report);
              if (
                runtime.cancelRequested ||
                draft.status === "cancelling" ||
                draft.status === "cancelled" ||
                draft.status === "interrupted"
              ) {
                return;
              }
              draft.sessionId = result.sessionId;
              draft.turnsCompleted += 1;
              draft.finalReport = result.report;
              if (
                result.success &&
                result.report.outcome !== "failed"
              ) {
                const caughtUp =
                  draft.turnsCompleted + draft.turnsAbandoned >=
                  draft.turnsQueued;
                draft.status = caughtUp
                  ? result.report.outcome === "blocked"
                    ? "blocked"
                    : "completed"
                  : "running";
                if (caughtUp) draft.completedAt = now();
                this.addEvent(
                  draft,
                  "turn_completed",
                  draft.status,
                  result.report.summary,
                  {
                    outcome: result.report.outcome,
                    turnsCompleted: draft.turnsCompleted,
                    turnsQueued: draft.turnsQueued,
                  },
                );
              } else {
                this.abandonOutstandingTurns(draft);
                draft.status = "failed";
                draft.completedAt = now();
                draft.lastError = {
                  code: result.errorCode ?? "CLAUDE_TURN_FAILED",
                  message:
                    result.errorMessage ?? "The Claude turn failed.",
                  recoverable: true,
                };
                this.addEvent(
                  draft,
                  "turn_failed",
                  "failed",
                  draft.lastError.message,
                  {
                    code: draft.lastError.code,
                  },
                );
              }
            });

            const current = await this.store.load(latest.taskId);
            if (isTerminalStatus(current.status)) {
              this.scheduleIdleDetach(latest.taskId, runtime);
            }
          },
          onError: async (error) => {
            await this.mutate(latest.taskId, (draft) => {
              if (
                this.runtimes.get(latest.taskId) !== runtime ||
                runtime.cancelRequested ||
                draft.status === "cancelling" ||
                draft.status === "cancelled" ||
                draft.status === "interrupted"
              ) {
                return;
              }
              this.abandonOutstandingTurns(draft);
              draft.usageAccountingComplete = false;
              draft.status = "failed";
              draft.completedAt = now();
              draft.lastError = { ...error, recoverable: false };
              draft.finalReport = {
                outcome: "failed",
                summary: error.message,
                changedFiles: [],
                verification: [],
                decisionsNeeded: [],
                warnings: [],
                metrics: {},
              };
              this.addEvent(
                draft,
                "turn_failed",
                "failed",
                error.message,
                { code: error.code },
              );
            });
          },
          onClose: async () => {
            if (this.runtimes.get(latest.taskId) !== runtime) return;
            this.runtimes.delete(latest.taskId);
            await this.mutate(latest.taskId, (draft) => {
              draft.processExitConfirmed = true;
              if (
                ACTIVE_STATUSES.has(draft.status) &&
                draft.status !== "cancelling"
              ) {
                this.abandonOutstandingTurns(draft);
                draft.usageAccountingComplete = false;
                draft.status = "failed";
                draft.completedAt = now();
                draft.lastError = {
                  code: "MISSING_RESULT",
                  message:
                    "The Claude runtime ended without a final turn result.",
                  recoverable: false,
                };
                draft.finalReport = {
                  outcome: "failed",
                  summary: draft.lastError.message,
                  changedFiles: [],
                  verification: [],
                  decisionsNeeded: [],
                  warnings: [],
                  metrics: {},
                };
                this.addEvent(
                  draft,
                  "turn_failed",
                  "failed",
                  draft.lastError.message,
                );
              } else {
                this.addEvent(
                  draft,
                  "runtime_stopped",
                  draft.status,
                  draft.usageAccountingComplete
                    ? "Detached the live Claude runtime; the session remains resumable."
                    : "Detached the live Claude runtime; resumption is disabled because usage accounting is incomplete.",
                );
              }
            });
          },
        },
      );
      runtime.handle = handle;
      if (addRuntimeEvent) {
        await this.mutate(latest.taskId, (draft) => {
          if (
            this.runtimes.get(latest.taskId) !== runtime ||
            runtime.cancelRequested
          ) {
            return;
          }
          draft.status = "running";
          this.addEvent(
            draft,
            "runtime_started",
            "running",
            draft.sessionId
              ? "Started a Claude runtime to resume the task session."
              : "Started the local Claude Code runtime.",
          );
        });
      }
    } catch (error) {
      let runtimeStopped = true;
      if (runtime.handle && !runtime.handle.closed) {
        runtime.cancelRequested = true;
        runtime.handle.close();
        runtimeStopped = await Promise.race([
          runtime.handle.done.then(
            () => true,
            () => true,
          ),
          this.delay(this.config.interruptGraceMs).then(() => false),
        ]);
      }
      if (
        runtimeStopped &&
        this.runtimes.get(record.taskId) === runtime
      ) {
        this.runtimes.delete(record.taskId);
      }
      const failure = runtimeStopped
        ? safeError(error)
        : {
            code: "RUNTIME_STOP_TIMEOUT",
            message:
              "The failed Claude runtime did not confirm shutdown; its workspace and session remain fenced.",
            recoverable: true,
          };
      await this.mutate(record.taskId, (draft) => {
        draft.processExitConfirmed = runtimeStopped;
        if (runtime.handle && !runtime.usageReported) {
          draft.usageAccountingComplete = false;
        }
        if (
          draft.status === "cancelled" ||
          draft.status === "cancelling" ||
          draft.status === "interrupted"
        ) {
          return;
        }
        this.abandonOutstandingTurns(draft);
        draft.status = "failed";
        draft.completedAt = now();
        draft.lastError = failure;
        draft.finalReport = {
          outcome: "failed",
          summary: failure.message,
          changedFiles: [],
          verification: [],
          decisionsNeeded: [],
          warnings: [],
          metrics: {},
        };
        if (runtime.handle && !runtime.usageReported) {
          draft.finalReport.warnings.push(
            "The failed Claude Code process did not return final turn metrics; cumulative accounting is incomplete.",
          );
        }
        this.addEvent(
          draft,
          "turn_failed",
          "failed",
          failure.message,
          { code: failure.code },
        );
      });
    }
  }

  private scheduleIdleDetach(
    taskId: string,
    runtime: ActiveRuntime,
  ): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = setTimeout(() => {
      if (this.runtimes.get(taskId) !== runtime) return;
      runtime.handle?.close();
    }, this.config.idleRuntimeMs);
    runtime.idleTimer.unref();
  }

  private abandonOutstandingTurns(record: TaskRecord): void {
    const unsettled =
      record.turnsQueued -
      record.turnsCompleted -
      (record.turnsAbandoned ?? 0);
    if (unsettled > 0) {
      record.turnsAbandoned = (record.turnsAbandoned ?? 0) + unsettled;
    }
  }

  private accumulateUsage(
    record: TaskRecord,
    report: FinalReport,
  ): void {
    const turns = report.metrics.turns;
    if (typeof turns === "number" && Number.isFinite(turns) && turns >= 0) {
      record.turnsUsed += turns;
    } else {
      record.usageAccountingComplete = false;
    }
  }

  private remainingAllowance(record: TaskRecord): number {
    if (!record.usageAccountingComplete) {
      throw new BridgeError(
        "USAGE_ACCOUNTING_INCOMPLETE",
        "The previous Claude Code process did not return final turn metrics, so the bridge refuses to grant another turn allowance for this task.",
      );
    }
    const remainingTurns = Math.floor(record.maxTurns - record.turnsUsed);
    if (remainingTurns < 1) {
      throw new BridgeError(
        "TASK_LIMIT_EXHAUSTED",
        "The task has exhausted its cumulative Claude Code turn allowance.",
      );
    }
    return remainingTurns;
  }

  private ensureCapabilitiesEnabled(
    permissionProfile: TaskRecord["permissionProfile"],
    networkAccess: TaskRecord["networkAccess"],
  ): void {
    if (this.capabilitiesEnabled(permissionProfile, networkAccess)) {
      return;
    }
    if (
      permissionProfile === "workspace_write" &&
      !this.config.writeEnabled
    ) {
      throw new BridgeError(
        "WORKSPACE_WRITE_DISABLED",
        "workspace_write is disabled. Cross-thread mutation requires an explicit operator opt-in and external coordination.",
      );
    }
    if (
      permissionProfile === "workspace_exec" &&
      !this.config.execEnabled
    ) {
      throw new BridgeError(
        "EXECUTION_DISABLED",
        "workspace_exec is disabled. The bridge operator must opt in only inside a suitable sandbox.",
      );
    }
    if (networkAccess === "web" && !this.config.webEnabled) {
      throw new BridgeError(
        "WEB_ACCESS_DISABLED",
        "Web access is disabled by bridge policy.",
      );
    }
  }

  private capabilitiesEnabled(
    permissionProfile: TaskRecord["permissionProfile"],
    networkAccess: TaskRecord["networkAccess"],
  ): boolean {
    return (
      (permissionProfile !== "workspace_write" || this.config.writeEnabled) &&
      (permissionProfile !== "workspace_exec" || this.config.execEnabled) &&
      (networkAccess !== "web" || this.config.webEnabled)
    );
  }

  private async validateWorkspace(requested: string): Promise<string> {
    if (!path.isAbsolute(requested)) {
      throw new BridgeError(
        "WORKSPACE_MUST_BE_ABSOLUTE",
        "cwd must be an absolute path beneath an allowed workspace root.",
      );
    }
    let canonical: string;
    try {
      canonical = await realpath(requested);
      if (!(await stat(canonical)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new BridgeError(
        "WORKSPACE_UNAVAILABLE",
        `The requested workspace is not an accessible directory: ${requested}`,
      );
    }

    const parsed = path.parse(canonical);
    if (canonical === parsed.root || canonical === os.homedir()) {
      throw new BridgeError(
        "WORKSPACE_TOO_BROAD",
        "The filesystem root and home directory cannot be used as Claude workspaces.",
      );
    }
    if (!this.allowedRoots.some((root) => inside(root, canonical))) {
      throw new BridgeError(
        "WORKSPACE_NOT_ALLOWED",
        `The requested workspace is outside CLAUDE_BRIDGE_ALLOWED_ROOTS: ${canonical}`,
      );
    }
    return canonical;
  }

  private async validatePersistedWorkspace(record: TaskRecord): Promise<void> {
    const canonical = await this.validateWorkspace(record.cwd);
    if (canonical !== record.cwd) {
      throw new BridgeError(
        "WORKSPACE_IDENTITY_CHANGED",
        "The persisted task workspace now resolves to a different directory. Start a new task under the current workspace grant.",
      );
    }
  }

  private async assertCapacity(
    cwd: string,
    mutating: boolean,
    ignoreTaskId?: string,
  ): Promise<void> {
    const activeCount =
      this.runtimes.size -
      (ignoreTaskId && this.runtimes.has(ignoreTaskId) ? 1 : 0);
    if (activeCount >= this.config.maxConcurrentTasks) {
      throw new BridgeError(
        "CONCURRENCY_LIMIT",
        "The bridge has reached its active Claude task limit.",
        true,
      );
    }

    for (const [taskId] of this.runtimes) {
      if (taskId === ignoreTaskId) continue;
      const other = await this.store.load(taskId);
      if (
        (inside(other.cwd, cwd) || inside(cwd, other.cwd)) &&
        (mutating || other.permissionProfile !== "read_only")
      ) {
        throw new BridgeError(
          "WORKSPACE_BUSY",
          "Another active Claude task holds an incompatible lease on this workspace.",
          true,
        );
      }
    }
    const persisted = await this.store.loadAll();
    for (const other of persisted) {
      if (other.taskId === ignoreTaskId || other.processExitConfirmed) {
        continue;
      }
      if (
        (inside(other.cwd, cwd) || inside(cwd, other.cwd)) &&
        (mutating || other.permissionProfile !== "read_only")
      ) {
        throw new BridgeError(
          "RUNTIME_EXIT_UNCONFIRMED",
          "A prior Claude Code process did not confirm exit, so this workspace remains fenced.",
        );
      }
    }
  }

  private ensureAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new BridgeError(
        "CONTROLLER_SHUTTING_DOWN",
        "The Claude task controller is shutting down.",
        true,
      );
    }
  }

  private snapshot(record: TaskRecord): TaskSnapshot {
    const latestEvents = record.events.slice(-10);
    const hasRemainingAllowance =
      Math.floor(record.maxTurns - record.turnsUsed) >= 1;
    const {
      events: _events,
      sessionId: _sessionId,
      ...rest
    } = record;
    return {
      ...rest,
      sessionEstablished: Boolean(record.sessionId),
      canFollowUp:
        isTerminalStatus(record.status) &&
        record.status !== "cancelled" &&
        record.usageAccountingComplete &&
        record.processExitConfirmed &&
        hasRemainingAllowance &&
        this.capabilitiesEnabled(
          record.permissionProfile,
          record.networkAccess,
        ) &&
        !this.runtimes.get(record.taskId)?.cancelRequested &&
        Boolean(record.sessionId),
      isActive: ACTIVE_STATUSES.has(record.status),
      latestEvents,
    };
  }

  private addEvent(
    record: TaskRecord,
    type: TaskEventType,
    status: TaskStatus,
    message: string,
    details?: Record<string, JsonValue>,
  ): void {
    record.eventSequence += 1;
    record.updatedAt = now();
    const event: TaskEvent = {
      sequence: record.eventSequence,
      timestamp: record.updatedAt,
      type,
      status,
      message,
      ...(details ? { details } : {}),
    };
    record.events.push(event);
    if (record.events.length > EVENT_RETENTION) {
      record.events.splice(0, record.events.length - EVENT_RETENTION);
    }
  }

  private async mutate(
    taskId: string,
    operation: (record: TaskRecord) => void | Promise<void>,
  ): Promise<void> {
    await this.locks.run(taskId, async () => {
      const record = await this.store.load(taskId);
      await operation(record);
      await this.store.save(record);
      this.notify(taskId);
    });
  }

  private notify(taskId: string): void {
    for (const listener of this.listeners.get(taskId) ?? []) listener();
  }

  private async waitSnapshot(
    taskId: string,
    afterSequence: number,
    limit: number,
  ): Promise<WaitResult> {
    const record = await this.store.load(taskId);
    if (afterSequence > record.eventSequence) {
      throw new BridgeError(
        "CURSOR_AHEAD",
        `afterSequence ${afterSequence} is ahead of the task cursor ${record.eventSequence}.`,
      );
    }
    const oldest = record.events.at(0)?.sequence ?? record.eventSequence;
    const historyTruncated =
      record.events.length > 0 && afterSequence < oldest - 1;
    const events = record.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
    const nextSequence =
      events.at(-1)?.sequence ?? Math.min(afterSequence, record.eventSequence);
    return {
      task: this.snapshot(record),
      events,
      nextSequence,
      timedOut: false,
      terminal: isTerminalStatus(record.status),
      historyTruncated,
    };
  }

  private async waitForChange(
    taskId: string,
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (changed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const taskListeners = this.listeners.get(taskId);
        taskListeners?.delete(onChange);
        if (taskListeners?.size === 0) this.listeners.delete(taskId);
        resolve(changed);
      };
      const onChange = (): void => finish(true);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const taskListeners = this.listeners.get(taskId);
        taskListeners?.delete(onChange);
        reject(
          new BridgeError(
            "WAIT_CANCELLED",
            "The wait request was cancelled; the Claude task continues running.",
            true,
          ),
        );
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const taskListeners =
        this.listeners.get(taskId) ?? new Set<ChangeListener>();
      taskListeners.add(onChange);
      this.listeners.set(taskId, taskListeners);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      void this.store
        .load(taskId)
        .then((record) => {
          if (
            record.eventSequence > afterSequence ||
            isTerminalStatus(record.status)
          ) {
            finish(true);
          }
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const listeners = this.listeners.get(taskId);
          listeners?.delete(onChange);
          reject(error);
        });
    });
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
