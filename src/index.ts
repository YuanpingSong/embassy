#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { safeError } from "./errors.js";
import { buildMcpServer } from "./mcp-server.js";
import { ThreadController } from "./thread-controller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const controllers = new ThreadController(config);
  const server = buildMcpServer(
    async (context) => await controllers.controllerFor(context),
  );
  const transport = new StdioServerTransport();
  let controllerStopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const stopController = (): Promise<void> => {
    controllerStopPromise ??= controllers.shutdown();
    return controllerStopPromise;
  };
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      await stopController();
      await server.close();
    })();
    return stopPromise;
  };

  server.server.onclose = () => {
    void stopController();
  };
  process.stdin.once("end", () => {
    void stop();
  });
  process.stdin.once("close", () => {
    void stop();
  });
  process.stdin.once("error", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });

  await server.connect(transport);
}

main().catch((error: unknown) => {
  // Never write diagnostics to stdout: stdio reserves it for MCP JSON-RPC.
  // Raw CLI errors are intentionally not printed because they can contain
  // task data, local paths, or account details.
  console.error(
    `[claude-agent-bridge] ${safeError(error).code}: startup failed.`,
  );
  process.exitCode = 1;
});
