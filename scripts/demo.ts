import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeConfig } from "../src/config.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { TaskController } from "../src/task-controller.js";
import { TaskStore } from "../src/task-store.js";
import type {
  AgentCallbacks,
  AgentDriver,
  AgentRunHandle,
  AgentStartRequest,
} from "../src/types.js";

class DemoDriver implements AgentDriver {
  callbacks?: AgentCallbacks;
  request?: AgentStartRequest;
  private closed = false;
  private finish!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  start(
    request: AgentStartRequest,
    callbacks: AgentCallbacks,
  ): AgentRunHandle {
    this.request = request;
    this.callbacks = callbacks;
    const driver = this;
    return {
      interrupt: async () => undefined,
      close: () => {
        if (driver.closed) return;
        driver.closed = true;
        void callbacks.onClose().finally(() => this.finish());
      },
      get done() {
        return driver.done;
      },
      get closed() {
        return driver.closed;
      },
    };
  }

  async finishTurn(): Promise<void> {
    if (!this.callbacks || !this.request) {
      throw new Error("The demo task was not started.");
    }
    const sessionId = randomUUID();
    await this.callbacks.onSession({
      sessionId,
      model: "demo-claude",
    });
    await this.callbacks.onProgress({
      kind: "tool_started",
      message: "Claude started Read.",
      status: "running",
      details: { toolName: "Read" },
    });
    await this.callbacks.onResult({
      success: true,
      sessionId,
      report: {
        outcome: "completed",
        summary: "The mock Claude task completed through the MCP lifecycle.",
        changedFiles: [],
        verification: [
          {
            name: "mock lifecycle",
            status: "passed",
            details: "start, progress, wait, and result were exercised.",
          },
        ],
        decisionsNeeded: [],
        warnings: [],
        metrics: { turns: 1 },
      },
    });
    if (!this.closed) {
      this.closed = true;
      await this.callbacks.onClose().finally(() => this.finish());
    }
  }
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "claude-bridge-demo-"),
  );
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace, { mode: 0o700 });

  const config: BridgeConfig = {
    claudeExecutable: process.execPath,
    stateDir: path.join(temporary, "state"),
    allowedWorkspaceRoots: [workspace],
    maxConcurrentTasks: 1,
    idleRuntimeMs: 60_000,
    interruptGraceMs: 50,
    defaultMaxTurns: 10,
    maximumMaxTurns: 20,
    writeEnabled: false,
    execEnabled: false,
    webEnabled: false,
  };
  const driver = new DemoDriver();
  const controller = new TaskController(
    config,
    new TaskStore(config.stateDir),
    driver,
  );
  await controller.initialize();

  const server = buildMcpServer(async () => controller);
  const client = new Client({
    name: "claude-bridge-demo",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const started = await client.callTool({
    name: "claude_task_start",
    arguments: {
      prompt: "Inspect this empty demo workspace.",
      cwd: workspace,
      permissionProfile: "read_only",
    },
  });
  const taskId = (
    started.structuredContent as { task: { taskId: string } }
  ).task.taskId;
  const initialCursor = (
    started.structuredContent as {
      task: { eventSequence: number };
    }
  ).task.eventSequence;

  await driver.finishTurn();
  const update = await client.callTool({
    name: "claude_task_wait",
    arguments: {
      taskId,
      afterSequence: initialCursor,
      timeoutMs: 2_000,
    },
  });
  const result = await client.callTool({
    name: "claude_task_result",
    arguments: { taskId },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        tools: (await client.listTools()).tools.map((tool) => tool.name),
        start: started.structuredContent,
        wait: update.structuredContent,
        result: result.structuredContent,
        note: "No Anthropic request was made; this demo uses a fake driver.",
      },
      null,
      2,
    )}\n`,
  );

  await Promise.allSettled([
    controller.shutdown(),
    client.close(),
    server.close(),
  ]);
}

void main();
