import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { BridgeError, safeError } from "./errors.js";
import type { TaskController } from "./task-controller.js";
import type { ControllerRequestContext } from "./thread-controller.js";
import {
  networkAccessModes,
  permissionProfiles,
} from "./types.js";

const taskIdSchema = z
  .string()
  .regex(
    /^claude_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

const objectOutputSchema = z.object({}).catchall(z.unknown());

function plainObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function successful(value: Record<string, unknown>, text: string) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text }],
  };
}

function failure(error: unknown) {
  const safe = safeError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${safe.code}: ${safe.message}`,
      },
    ],
  };
}

async function handle<T>(
  operation: () => Promise<T>,
  present: (value: T) => { value: Record<string, unknown>; text: string },
) {
  try {
    const result = await operation();
    const rendered = present(result);
    return successful(rendered.value, rendered.text);
  } catch (error) {
    if (!(error instanceof BridgeError)) {
      // stderr is the only legal diagnostic channel for a stdio MCP server.
      // Do not print raw CLI errors because they can contain local paths,
      // account details, or task data.
      console.error("[claude-agent-bridge] Internal tool handler failure.");
    }
    return failure(error);
  }
}

export type ControllerResolver = (
  context: ControllerRequestContext,
) => Promise<TaskController>;

export function buildMcpServer(
  controllerFor: ControllerResolver,
): McpServer {
  const server = new McpServer({
    name: "claude-agent-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "claude_task_start",
    {
      title: "Start Claude task",
      description:
        "Start a Claude-only task and return immediately. Codex tasks must continue to use Codex-native task controls.",
      inputSchema: {
        prompt: z.string().min(1).max(100_000),
        cwd: z.string().min(1),
        title: z.string().min(1).max(120).optional(),
        model: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/)
          .optional(),
        permissionProfile: z.enum(permissionProfiles).default("read_only"),
        networkAccess: z.enum(networkAccessModes).default("none"),
        maxTurns: z.number().int().min(1).max(1_000).optional(),
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      await handle(
        async () => {
          const controller = await controllerFor(extra);
          return await controller.startTask({
            prompt: input.prompt,
            cwd: input.cwd,
            permissionProfile: input.permissionProfile,
            networkAccess: input.networkAccess,
            ...(input.title ? { title: input.title } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.maxTurns !== undefined
              ? { maxTurns: input.maxTurns }
              : {}),
          });
        },
        (task) => ({
          value: plainObject({ task }),
          text: `${task.taskId}: ${task.status} (cursor ${task.eventSequence})`,
        }),
      ),
  );

  server.registerTool(
    "claude_task_status",
    {
      title: "Get Claude task status",
      description:
        "Read the current normalized status of one Claude bridge task without waiting.",
      inputSchema: {
        taskId: taskIdSchema,
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }, extra) =>
      await handle(
        async () => await (await controllerFor(extra)).getTask(taskId),
        (task) => ({
          value: plainObject({ task }),
          text: `${task.taskId}: ${task.status} (cursor ${task.eventSequence})`,
        }),
      ),
  );

  server.registerTool(
    "claude_task_followup",
    {
      title: "Send Claude task follow-up",
      description:
        "Send one new instruction after the current turn finishes, resuming the same persisted Claude session. Active tasks reject follow-ups to prevent prompt coalescing.",
      inputSchema: {
        taskId: taskIdSchema,
        prompt: z.string().min(1).max(100_000),
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      await handle(
        async () => await (await controllerFor(extra)).followup(input),
        (task) => ({
          value: plainObject({ task }),
          text: `${task.taskId}: follow-up accepted; status ${task.status}.`,
        }),
      ),
  );

  server.registerTool(
    "claude_task_wait",
    {
      title: "Wait for Claude task update",
      description:
        "Long-poll normalized Claude task events after a cursor. Cancelling this MCP request never cancels the Claude task.",
      inputSchema: {
        taskId: taskIdSchema,
        afterSequence: z.number().int().min(0).default(0),
        timeoutMs: z.number().int().min(0).max(25_000).default(20_000),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) =>
      await handle(
        async () =>
          await (await controllerFor(extra)).wait({
            ...input,
            signal: extra.signal,
          }),
        (result) => ({
          value: plainObject(result),
          text: result.events.length
            ? `${result.task.taskId}: ${result.events.length} update(s), status ${result.task.status}, cursor ${result.nextSequence}.`
            : `${result.task.taskId}: no new update; status ${result.task.status}, cursor ${result.nextSequence}.`,
        }),
      ),
  );

  server.registerTool(
    "claude_task_interrupt",
    {
      title: "Interrupt or cancel Claude task",
      description:
        "Interrupt the active Claude turn, or permanently cancel the bridge task. Resumption is offered only after confirmed shutdown and complete usage accounting; prior side effects are not rolled back.",
      inputSchema: {
        taskId: taskIdSchema,
        disposition: z
          .enum(["interrupt", "cancel"])
          .default("interrupt"),
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId, disposition }, extra) =>
      await handle(
        async () =>
          await (await controllerFor(extra)).interrupt(taskId, disposition),
        (result) => ({
          value: plainObject(result),
          text: result.requested
            ? `${taskId}: ${disposition} completed; status ${result.task.status}.`
            : `${taskId}: no active turn to interrupt; status ${result.task.status}.`,
        }),
      ),
  );

  server.registerTool(
    "claude_task_result",
    {
      title: "Get Claude task result",
      description:
        "Retrieve the latest concise structured final report for a Claude bridge task.",
      inputSchema: {
        taskId: taskIdSchema,
      },
      outputSchema: objectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }, extra) =>
      await handle(
        async () => await (await controllerFor(extra)).getTask(taskId),
        (task) => {
          const ready = task.finalReport !== undefined;
          return {
            value: plainObject({
              taskId,
              ready,
              status: task.status,
              report: task.finalReport ?? null,
              lastError: task.lastError ?? null,
              sessionResumable: task.canFollowUp,
              cursor: task.eventSequence,
              cumulativeUsage: {
                turnsUsed: task.turnsUsed,
                accountingComplete: task.usageAccountingComplete,
                maxTurns: task.maxTurns,
              },
            }),
            text: ready
              ? `${taskId}: ${task.finalReport?.outcome} — ${task.finalReport?.summary}`
              : `${taskId}: result not ready; status ${task.status}.`,
          };
        },
      ),
  );

  return server;
}
