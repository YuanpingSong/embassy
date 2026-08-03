import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("built stdio server starts cleanly without stdout contamination", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "claude-bridge-stdio-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/src/index.js")],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? temporary,
      CLAUDE_BRIDGE_STATE_DIR: path.join(temporary, "state"),
      CLAUDE_BRIDGE_ALLOWED_ROOTS: process.cwd(),
      CLAUDE_BRIDGE_CLAUDE_BIN: process.execPath,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "stdio-smoke-client",
    version: "1.0.0",
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  assert.ok(tools.tools.every((tool) => tool.name.startsWith("claude_task_")));
  const missing = await client.callTool({
    _meta: { threadId: "00000000-0000-4000-8000-000000000123" },
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
  await client.close();
});
