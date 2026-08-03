import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type TaskSnapshot = {
  taskId: string;
  status: string;
  eventSequence: number;
  processExitConfirmed: boolean;
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
]);

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

function childEnvironment(
  root: string,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_BRIDGE_CLAUDE_BIN",
  ];
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.CLAUDE_BRIDGE_ALLOWED_ROOTS = workspace;
  env.CLAUDE_BRIDGE_STATE_DIR = path.join(root, "state");
  return env;
}

async function main(): Promise<void> {
  if (process.env.CLAUDE_BRIDGE_RUN_REAL_VALIDATION !== "1") {
    process.stderr.write(
      "Real validation is disabled. Set CLAUDE_BRIDGE_RUN_REAL_VALIDATION=1 to authorize one local Claude Code request.\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!path.isAbsolute(process.env.CLAUDE_BRIDGE_CLAUDE_BIN ?? "")) {
    process.stderr.write(
      "Real validation requires CLAUDE_BRIDGE_CLAUDE_BIN to pin the same absolute Claude Code executable used by the MCP configuration.\n",
    );
    process.exitCode = 2;
    return;
  }

  const root = await mkdtemp(
    path.join(os.tmpdir(), "claude-bridge-local-validation-"),
  );
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/index.js")],
    cwd: process.cwd(),
    env: childEnvironment(root, workspace),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({
    name: "claude-bridge-local-validation",
    version: "1.0.0",
  });
  const requestMeta = { threadId: randomUUID() };
  const validationModel =
    process.env.CLAUDE_BRIDGE_VALIDATION_MODEL?.trim() || "haiku";

  try {
    await client.connect(transport);
    const start = await client.callTool({
      _meta: requestMeta,
      name: "claude_task_start",
      arguments: {
        prompt:
          'Do not use tools. Return outcome "completed", summary exactly "CLAUDE_BRIDGE_LOCAL_OK", and empty changed_files, verification, decisions_needed, and warnings.',
        cwd: workspace,
        model: validationModel,
        permissionProfile: "read_only",
        networkAccess: "none",
        maxTurns: 2,
      },
    });
    if (start.isError) {
      process.stdout.write(
        `${JSON.stringify({
          succeeded: false,
          message: "The bridge rejected the validation task.",
        })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    let task = (
      start.structuredContent as { task: TaskSnapshot }
    ).task;
    let cursor = task.eventSequence;
    let toolUsed = false;
    const deadline = Date.now() + 120_000;

    while (
      !TERMINAL_STATUSES.has(task.status) &&
      Date.now() < deadline
    ) {
      const waited = await client.callTool({
        _meta: requestMeta,
        name: "claude_task_wait",
        arguments: {
          taskId: task.taskId,
          afterSequence: cursor,
          timeoutMs: 20_000,
          limit: 50,
        },
      });
      if (waited.isError) {
        throw new Error("Bridge wait failed.");
      }
      const value = waited.structuredContent as {
        task: TaskSnapshot;
        events: Array<{
          type: string;
          details?: { toolName?: string };
        }>;
        nextSequence: number;
      };
      task = value.task;
      cursor = value.nextSequence;
      toolUsed ||= value.events.some(
        (event) =>
          ["tool_started", "tool_progress"].includes(event.type) &&
          event.details?.toolName !== "StructuredOutput",
      );
    }

    while (task.processExitConfirmed !== true && Date.now() < deadline) {
      await delay(25);
      const status = await client.callTool({
        _meta: requestMeta,
        name: "claude_task_status",
        arguments: { taskId: task.taskId },
      });
      if (status.isError) throw new Error("Bridge status retrieval failed.");
      task = (
        status.structuredContent as { task: TaskSnapshot }
      ).task;
    }

    if (!TERMINAL_STATUSES.has(task.status) || !task.processExitConfirmed) {
      if (!TERMINAL_STATUSES.has(task.status)) {
        await client.callTool({
          _meta: requestMeta,
          name: "claude_task_interrupt",
          arguments: { taskId: task.taskId, disposition: "cancel" },
        });
      }
      throw new Error("Validation timed out.");
    }

    const result = await client.callTool({
      _meta: requestMeta,
      name: "claude_task_result",
      arguments: { taskId: task.taskId },
    });
    if (result.isError) throw new Error("Bridge result retrieval failed.");
    const value = result.structuredContent as {
      ready: boolean;
      status: string;
      report: { summary?: string } | null;
      lastError: { code?: string } | null;
    };
    const summary = value.report?.summary ?? "";
    const succeeded =
      value.ready &&
      value.status === "completed" &&
      summary === "CLAUDE_BRIDGE_LOCAL_OK" &&
      !toolUsed &&
      task.processExitConfirmed;
    process.stdout.write(
      `${JSON.stringify({
        succeeded,
        status: value.status,
        summaryMatched: summary === "CLAUDE_BRIDGE_LOCAL_OK",
        toolFree: !toolUsed,
        processExitConfirmed: task.processExitConfirmed,
        ...(value.lastError?.code
          ? { errorCode: value.lastError.code }
          : {}),
      })}\n`,
    );
    if (!succeeded) process.exitCode = 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        succeeded: false,
        message:
          "The local bridge validation failed; raw CLI diagnostics were suppressed.",
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

void main();
