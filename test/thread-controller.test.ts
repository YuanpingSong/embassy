import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BridgeConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { TaskController } from "../src/task-controller.js";
import { TaskStore } from "../src/task-store.js";
import { ThreadController } from "../src/thread-controller.js";
import { FakeAgentDriver } from "./fake-agent-driver.js";

const THREAD_A = "00000000-0000-4000-8000-000000000101";
const THREAD_B = "00000000-0000-4000-8000-000000000202";

async function fixture(): Promise<{
  config: BridgeConfig;
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-thread-test-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return {
    root,
    workspace,
    config: {
      claudeExecutable: process.execPath,
      stateDir: path.join(root, "state"),
      allowedWorkspaceRoots: [workspace],
      maxConcurrentTasks: 2,
      idleRuntimeMs: 60_000,
      interruptGraceMs: 10,
      defaultMaxTurns: 20,
      maximumMaxTurns: 100,
      writeEnabled: false,
      execEnabled: false,
      webEnabled: false,
    },
  };
}

function context(threadId: string) {
  return {
    _meta: {
      threadId,
      "x-codex-turn-metadata": { thread_id: threadId },
    },
  };
}

test("thread controller coexists with the legacy root lock and reuses one controller", async () => {
  const { config, workspace } = await fixture();
  const legacyStore = new TaskStore(config.stateDir);
  await legacyStore.initialize([workspace]);

  const scopedConfigs: BridgeConfig[] = [];
  const controllers = new ThreadController(config, (scopedConfig) => {
    scopedConfigs.push(scopedConfig);
    return new TaskController(
      scopedConfig,
      new TaskStore(scopedConfig.stateDir),
      new FakeAgentDriver(),
    );
  });
  const first = await controllers.controllerFor(context(THREAD_A));
  const second = await controllers.controllerFor(context(THREAD_A));

  assert.equal(first, second);
  assert.equal(scopedConfigs.length, 1);
  assert.equal(
    scopedConfigs[0]?.stateDir,
    path.join(await realpath(config.stateDir), "threads", THREAD_A),
  );

  await controllers.shutdown();
  await legacyStore.releaseControllerLock();
});

test("same thread remains exclusively locked across bridge processes and can retry", async () => {
  const { config } = await fixture();
  const createController = (scopedConfig: BridgeConfig) =>
    new TaskController(
      scopedConfig,
      new TaskStore(scopedConfig.stateDir),
      new FakeAgentDriver(),
    );
  const first = new ThreadController(config, createController);
  const second = new ThreadController(config, createController);

  await first.controllerFor(context(THREAD_A));
  await assert.rejects(
    second.controllerFor(context(THREAD_A)),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "STATE_IN_USE",
  );
  await first.shutdown();
  await second.controllerFor(context(THREAD_A));
  await second.shutdown();
});

test("different Codex threads initialize concurrently and isolate task ids", async () => {
  const { config, workspace } = await fixture();
  const createController = (scopedConfig: BridgeConfig) =>
    new TaskController(
      scopedConfig,
      new TaskStore(scopedConfig.stateDir),
      new FakeAgentDriver(),
    );
  const first = new ThreadController(config, createController);
  const second = new ThreadController(config, createController);

  const [firstController, secondController] = await Promise.all([
    first.controllerFor(context(THREAD_A)),
    second.controllerFor(context(THREAD_B)),
  ]);
  const task = await firstController.startTask({
    prompt: "Keep this task in its owning Codex thread.",
    cwd: workspace,
  });
  await assert.rejects(
    secondController.getTask(task.taskId),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "TASK_NOT_FOUND",
  );

  await Promise.all([first.shutdown(), second.shutdown()]);
});

test("thread controller rejects symlinked state ancestors", async () => {
  const baseFixture = await fixture();
  const baseTarget = path.join(baseFixture.root, "base-target");
  await mkdir(baseTarget, { mode: 0o700 });
  await symlink(baseTarget, baseFixture.config.stateDir);
  const baseController = new ThreadController(baseFixture.config);
  await assert.rejects(
    baseController.controllerFor(context(THREAD_A)),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );

  const threadsFixture = await fixture();
  const baseStore = new TaskStore(threadsFixture.config.stateDir);
  await baseStore.initialize([threadsFixture.workspace]);
  await baseStore.releaseControllerLock();
  const threadsTarget = path.join(threadsFixture.root, "threads-target");
  await mkdir(threadsTarget, { mode: 0o700 });
  await symlink(
    threadsTarget,
    path.join(threadsFixture.config.stateDir, "threads"),
  );
  const threadsController = new ThreadController(threadsFixture.config);
  await assert.rejects(
    threadsController.controllerFor(context(THREAD_A)),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );
});

test("thread controller rejects public and unmarked state roots", async () => {
  const publicFixture = await fixture();
  await mkdir(publicFixture.config.stateDir, { mode: 0o755 });
  await chmod(publicFixture.config.stateDir, 0o755);
  const publicController = new ThreadController(publicFixture.config);
  await assert.rejects(
    publicController.controllerFor(context(THREAD_A)),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );

  const unmarkedFixture = await fixture();
  await mkdir(unmarkedFixture.config.stateDir, { mode: 0o700 });
  await writeFile(
    path.join(unmarkedFixture.config.stateDir, "user-file"),
    "preserve me",
  );
  const unmarkedController = new ThreadController(unmarkedFixture.config);
  await assert.rejects(
    unmarkedController.controllerFor(context(THREAD_A)),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "STATE_DIRECTORY_NOT_OWNED",
  );
});

test("thread metadata is required, internally consistent, and process-bound", async () => {
  const { config } = await fixture();
  const controllers = new ThreadController(config, (scopedConfig) =>
    new TaskController(
      scopedConfig,
      new TaskStore(scopedConfig.stateDir),
      new FakeAgentDriver(),
    ),
  );

  await assert.rejects(
    controllers.controllerFor({}),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_THREAD_ID_REQUIRED",
  );
  await assert.rejects(
    controllers.controllerFor({ _meta: { threadId: "../escape" } }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_THREAD_ID_REQUIRED",
  );
  await assert.rejects(
    controllers.controllerFor({
      _meta: {
        threadId: THREAD_A,
        "x-codex-turn-metadata": { thread_id: THREAD_B },
      },
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_THREAD_ID_MISMATCH",
  );

  await controllers.controllerFor(context(THREAD_A));
  await assert.rejects(
    controllers.controllerFor(context(THREAD_B)),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CODEX_THREAD_ID_MISMATCH",
  );
  await controllers.shutdown();
});
