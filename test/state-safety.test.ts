import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { TaskController } from "../src/task-controller.js";
import { TaskStore } from "../src/task-store.js";
import type { TaskRecord } from "../src/types.js";
import { FakeAgentDriver } from "./fake-agent-driver.js";

async function rootFixture(): Promise<{
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-state-test-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return { root, workspace };
}

function config(stateDir: string, workspace: string): BridgeConfig {
  return {
    claudeExecutable: process.execPath,
    stateDir,
    allowedWorkspaceRoots: [workspace],
    maxConcurrentTasks: 1,
    idleRuntimeMs: 60_000,
    interruptGraceMs: 10,
    defaultMaxTurns: 10,
    maximumMaxTurns: 20,
    writeEnabled: false,
    execEnabled: false,
    webEnabled: false,
  };
}

test("state initialization rejects broad paths before mutation", async () => {
  const { workspace } = await rootFixture();
  const before = (await stat(path.parse(workspace).root)).mode;
  await assert.rejects(
    new TaskStore(path.parse(workspace).root).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );
  const after = (await stat(path.parse(workspace).root)).mode;
  assert.equal(after, before);

  await assert.rejects(
    new TaskStore(os.tmpdir()).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );
});

test("state and workspace roots must be disjoint", async () => {
  const { workspace } = await rootFixture();
  const stateDir = path.join(workspace, "controller-state");
  const controller = new TaskController(
    config(stateDir, workspace),
    new TaskStore(stateDir),
    new FakeAgentDriver(),
  );
  await assert.rejects(
    controller.initialize(),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "STATE_WORKSPACE_OVERLAP",
  );
  await assert.rejects(access(stateDir));
});

test("existing state roots require private mode and bridge ownership", async () => {
  const { root, workspace } = await rootFixture();
  const occupied = path.join(root, "occupied");
  await mkdir(occupied, { mode: 0o700 });
  await writeFile(path.join(occupied, "user-file"), "preserve me");
  await assert.rejects(
    new TaskStore(occupied).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "STATE_DIRECTORY_NOT_OWNED",
  );
  assert.equal(
    await (await import("node:fs/promises")).readFile(
      path.join(occupied, "user-file"),
      "utf8",
    ),
    "preserve me",
  );

  const publicDirectory = path.join(root, "public-state");
  await mkdir(publicDirectory, { mode: 0o755 });
  await assert.rejects(
    new TaskStore(publicDirectory).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );

  const target = path.join(root, "target");
  const linked = path.join(root, "linked-state");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked);
  await assert.rejects(
    new TaskStore(linked).initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "UNSAFE_STATE_DIRECTORY",
  );
});

test("one live controller exclusively owns a state directory", async () => {
  const { root, workspace } = await rootFixture();
  const stateDir = path.join(root, "exclusive-state");
  const first = new TaskStore(stateDir);
  await first.initialize([workspace]);
  const second = new TaskStore(stateDir);
  await assert.rejects(
    second.initialize([workspace]),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "STATE_IN_USE",
  );
  await first.releaseControllerLock();
  await second.initialize([workspace]);
  await second.releaseControllerLock();
});

test("legacy backend state is never resumed by the local CLI", async () => {
  const { root, workspace } = await rootFixture();
  const stateDir = path.join(root, "legacy-state");
  const store = new TaskStore(stateDir);
  await store.initialize([workspace]);
  const taskId =
    "claude_00000000-0000-4000-8000-000000000321";
  const taskDirectory = path.join(store.tasksDir, taskId);
  await mkdir(taskDirectory, { mode: 0o700 });
  await writeFile(
    path.join(taskDirectory, "task.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      taskId,
      cwd: workspace,
      status: "completed",
      eventSequence: 0,
      turnsQueued: 1,
      turnsCompleted: 1,
      events: [],
      sessionId: "00000000-0000-4000-8000-000000000999",
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    store.load(taskId),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "LEGACY_TASK_BACKEND",
  );
  await store.releaseControllerLock();
});

test("persisted safety and allowance fields are required fail-closed", async () => {
  const { root, workspace } = await rootFixture();
  const stateDir = path.join(root, "strict-state");
  const store = new TaskStore(stateDir);
  await store.initialize([workspace]);
  const taskId =
    "claude_00000000-0000-4000-8000-000000000654";
  const timestamp = new Date().toISOString();
  const record: TaskRecord = {
    schemaVersion: 2,
    backend: "local_claude_code",
    taskId,
    title: "strict state",
    cwd: workspace,
    permissionProfile: "read_only",
    networkAccess: "none",
    maxTurns: 10,
    turnsUsed: 1,
    usageAccountingComplete: true,
    processExitConfirmed: true,
    status: "completed",
    sessionId: "00000000-0000-4000-8000-000000000999",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    turnsQueued: 1,
    turnsCompleted: 1,
    turnsAbandoned: 0,
    eventSequence: 0,
    events: [],
  };
  await store.create(record);
  const stateFile = path.join(store.tasksDir, taskId, "task.json");
  const original = JSON.parse(await readFile(stateFile, "utf8")) as Record<
    string,
    unknown
  >;

  for (const field of ["permissionProfile", "turnsUsed"]) {
    const corrupted = { ...original };
    delete corrupted[field];
    await writeFile(stateFile, `${JSON.stringify(corrupted)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      store.load(taskId),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "CORRUPT_TASK_STATE",
    );
  }

  await writeFile(stateFile, `${JSON.stringify(original)}\n`, {
    mode: 0o600,
  });
  await store.releaseControllerLock();
});

test("configuration requires explicit roots and validates numeric relationships", () => {
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "ALLOWED_WORKSPACE_ROOTS_REQUIRED",
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
        CLAUDE_BRIDGE_ALLOWED_ROOTS: "/tmp/example-workspace",
        CLAUDE_BRIDGE_MAX_CONCURRENT_TASKS: "not-a-number",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
        CLAUDE_BRIDGE_ALLOWED_ROOTS: "/tmp/example-workspace",
        CLAUDE_BRIDGE_DEFAULT_MAX_TURNS: "40",
        CLAUDE_BRIDGE_MAX_TURNS: "10",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
        CLAUDE_BRIDGE_ALLOWED_ROOTS: "relative-workspace",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
        CLAUDE_BRIDGE_ALLOWED_ROOTS: "/tmp/example-workspace",
        CLAUDE_BRIDGE_STATE_DIR: "relative-state",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      loadConfig({
        HOME: os.homedir(),
        CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
        CLAUDE_BRIDGE_ALLOWED_ROOTS: "/tmp/example-workspace",
        CLAUDE_BRIDGE_DEFAULT_MODEL: "--invalid-model",
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "INVALID_CONFIGURATION",
  );

  const configured = loadConfig({
    HOME: os.homedir(),
    CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
    CLAUDE_BRIDGE_ALLOWED_ROOTS: "/tmp/example-workspace",
    CLAUDE_BRIDGE_DEFAULT_MODEL: "fable",
    CLAUDE_BRIDGE_ENABLE_WRITE: "1",
  });
  assert.equal(configured.defaultModel, "fable");
  assert.equal(configured.writeEnabled, true);
});
