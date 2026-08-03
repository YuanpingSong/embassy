import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { ClaudeCliDriver } from "./claude-driver.js";
import { BridgeError } from "./errors.js";
import { TaskController } from "./task-controller.js";
import {
  prepareOwnedStateDirectory,
  TaskStore,
} from "./task-store.js";

const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_METADATA_KEY = "x-codex-turn-metadata";

export type ControllerRequestContext = {
  _meta?: Readonly<Record<string, unknown>>;
};

export type TaskControllerFactory = (
  config: BridgeConfig,
) => TaskController;

function defaultControllerFactory(config: BridgeConfig): TaskController {
  return new TaskController(
    config,
    new TaskStore(config.stateDir),
    new ClaudeCliDriver(config.claudeExecutable),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestThreadId(context: ControllerRequestContext): string {
  const threadId = context._meta?.threadId;
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
    throw new BridgeError(
      "CODEX_THREAD_ID_REQUIRED",
      "This bridge requires the authoritative Codex threadId metadata on every task call.",
    );
  }

  const turnMetadata = context._meta?.[TURN_METADATA_KEY];
  if (isRecord(turnMetadata)) {
    const nestedThreadId = turnMetadata.thread_id;
    if (
      nestedThreadId !== undefined &&
      (typeof nestedThreadId !== "string" || nestedThreadId !== threadId)
    ) {
      throw new BridgeError(
        "CODEX_THREAD_ID_MISMATCH",
        "Codex supplied inconsistent thread metadata, so the bridge refused the task call.",
      );
    }
  }
  return threadId.toLowerCase();
}

/**
 * Lazily binds one stdio MCP process to one Codex thread and its private
 * controller state. Codex launches a separate MCP runtime for every thread,
 * so this avoids global lock contention without weakening task-store locks.
 */
export class ThreadController {
  private readonly config: BridgeConfig;
  private readonly createController: TaskControllerFactory;
  private boundThreadId: string | undefined;
  private controllerPromise: Promise<TaskController> | undefined;
  private shuttingDown = false;

  constructor(
    config: BridgeConfig,
    createController: TaskControllerFactory = defaultControllerFactory,
  ) {
    this.config = config;
    this.createController = createController;
  }

  async controllerFor(
    context: ControllerRequestContext,
  ): Promise<TaskController> {
    if (this.shuttingDown) {
      throw new BridgeError(
        "CONTROLLER_SHUTTING_DOWN",
        "The Claude bridge is shutting down and cannot accept another task call.",
        true,
      );
    }

    const threadId = requestThreadId(context);
    if (this.boundThreadId && this.boundThreadId !== threadId) {
      throw new BridgeError(
        "CODEX_THREAD_ID_MISMATCH",
        "This bridge process is already bound to a different Codex thread.",
      );
    }
    this.boundThreadId ??= threadId;

    if (!this.controllerPromise) {
      const initialization = (async () => {
        const stateRoot = await prepareOwnedStateDirectory(
          this.config.stateDir,
          this.config.allowedWorkspaceRoots,
        );
        const threadsRoot = await prepareOwnedStateDirectory(
          path.join(stateRoot, "threads"),
          this.config.allowedWorkspaceRoots,
        );
        const scopedConfig: BridgeConfig = {
          ...this.config,
          stateDir: path.join(threadsRoot, threadId),
        };
        const controller = this.createController(scopedConfig);
        await controller.initialize();
        return controller;
      })();
      this.controllerPromise = initialization;
      void initialization.catch(() => {
        if (this.controllerPromise === initialization) {
          this.controllerPromise = undefined;
        }
      });
    }

    return await this.controllerPromise;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const controllerPromise = this.controllerPromise;
    if (!controllerPromise) return;
    const controller = await controllerPromise.catch(() => undefined);
    await controller?.shutdown();
  }
}
