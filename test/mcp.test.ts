import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { createHarness } from "./test-harness.js";

test("MCP exposes the minimal Claude lifecycle and structured results", async () => {
  const harness = await createHarness();
  const server = buildMcpServer(async () => harness.controller);
  const client = new Client({
    name: "bridge-test-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "claude_task_followup",
      "claude_task_interrupt",
      "claude_task_result",
      "claude_task_start",
      "claude_task_status",
      "claude_task_wait",
    ],
  );

  const start = await client.callTool({
    name: "claude_task_start",
    arguments: {
      prompt: "Inspect safely.",
      cwd: harness.workspace,
    },
  });
  assert.notEqual(start.isError, true);
  const task = (
    start.structuredContent as {
      task: { taskId: string; eventSequence: number; sessionId?: string };
    }
  ).task;
  assert.match(task.taskId, /^claude_/);
  assert.equal(task.sessionId, undefined);

  const pendingResult = await client.callTool({
    name: "claude_task_result",
    arguments: { taskId: task.taskId },
  });
  assert.equal(
    (pendingResult.structuredContent as { ready: boolean }).ready,
    false,
  );

  await harness.driver.latest().initialize();
  await harness.driver.latest().progress({
    kind: "tool_started",
    message: "Claude started Read.",
    status: "running",
    details: { toolName: "Read" },
  });
  const waited = await client.callTool({
    name: "claude_task_wait",
    arguments: {
      taskId: task.taskId,
      afterSequence: task.eventSequence,
      timeoutMs: 100,
    },
  });
  assert.notEqual(waited.isError, true);
  assert.ok(
    (
      waited.structuredContent as {
        events: Array<{ type: string }>;
      }
    ).events.some((event) => event.type === "tool_started"),
  );

  await harness.driver.latest().complete();
  const result = await client.callTool({
    name: "claude_task_result",
    arguments: { taskId: task.taskId },
  });
  assert.notEqual(result.isError, true);
  assert.equal(
    (result.structuredContent as { ready: boolean }).ready,
    true,
  );

  const status = await client.callTool({
    name: "claude_task_status",
    arguments: { taskId: task.taskId },
  });
  assert.equal(
    (
      status.structuredContent as {
        task: { status: string; sessionId?: string };
      }
    ).task.status,
    "completed",
  );
  assert.equal(
    (
      status.structuredContent as {
        task: { sessionId?: string };
      }
    ).task.sessionId,
    undefined,
  );

  const followup = await client.callTool({
    name: "claude_task_followup",
    arguments: {
      taskId: task.taskId,
      prompt: "Perform one more check.",
    },
  });
  assert.notEqual(followup.isError, true);
  assert.equal(
    (
      followup.structuredContent as {
        task: { status: string; finalReport?: unknown };
      }
    ).task.status,
    "queued",
  );
  assert.equal(
    (
      followup.structuredContent as {
        task: { finalReport?: unknown };
      }
    ).task.finalReport,
    undefined,
  );
  await harness.driver.latest().initialize();

  const interrupted = await client.callTool({
    name: "claude_task_interrupt",
    arguments: {
      taskId: task.taskId,
      disposition: "interrupt",
    },
  });
  assert.notEqual(interrupted.isError, true);
  assert.equal(
    (
      interrupted.structuredContent as {
        task: { status: string };
      }
    ).task.status,
    "interrupted",
  );

  const missing = await client.callTool({
    name: "claude_task_status",
    arguments: {
      taskId: "claude_00000000-0000-0000-0000-000000000000",
    },
  });
  assert.equal(missing.isError, true);
  const missingContent = missing.content;
  assert.ok(Array.isArray(missingContent));
  const [missingMessage] = missingContent;
  assert.ok(
    missingMessage &&
      typeof missingMessage === "object" &&
      "text" in missingMessage &&
      typeof missingMessage.text === "string",
  );
  assert.match(missingMessage.text, /^TASK_NOT_FOUND:/);

  await Promise.allSettled([
    harness.controller.shutdown(),
    client.close(),
    server.close(),
  ]);
});
