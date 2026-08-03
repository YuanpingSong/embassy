import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "../src/config.js";
import { TaskController } from "../src/task-controller.js";
import { TaskStore } from "../src/task-store.js";
import { FakeAgentDriver } from "./fake-agent-driver.js";

export type TestHarness = {
  root: string;
  workspace: string;
  stateDir: string;
  config: BridgeConfig;
  store: TaskStore;
  driver: FakeAgentDriver;
  controller: TaskController;
};

export async function createHarness(): Promise<TestHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-bridge-test-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  const config: BridgeConfig = {
    claudeExecutable: process.execPath,
    stateDir,
    allowedWorkspaceRoots: [workspace],
    maxConcurrentTasks: 2,
    idleRuntimeMs: 60_000,
    interruptGraceMs: 10,
    defaultMaxTurns: 20,
    maximumMaxTurns: 100,
    writeEnabled: true,
    execEnabled: false,
    webEnabled: false,
  };
  const store = new TaskStore(stateDir);
  const driver = new FakeAgentDriver();
  const controller = new TaskController(config, store, driver);
  await controller.initialize();
  return {
    root,
    workspace,
    stateDir,
    config,
    store,
    driver,
    controller,
  };
}
