import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Serializable } from "node:child_process";

import { BridgeError } from "../errors.js";
import {
  assertClaudeNativeHelperIpcSize,
  CLAUDE_NATIVE_HELPER_MAX_REQUESTS,
  CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
  isClaudeNativeHelperParentMessage,
  type ClaudeNativeHelperChildMessage,
  type ClaudeNativeHelperCommand,
  type ClaudeNativeHelperEvent,
  type ClaudeNativeHelperInitialization,
  type ClaudeNativeHelperResult,
} from "./claude-helper-protocol.js";
import {
  createLocalClaudeGatewayProvider,
  type LocalClaudeGatewayProvider,
} from "./providers.js";
import type { GatewayAdapterCallbacks } from "./service.js";

function sendChildMessage(value: ClaudeNativeHelperChildMessage): Promise<void> {
  assertClaudeNativeHelperIpcSize(value);
  if (process.send === undefined || !process.connected) {
    return Promise.reject(new Error("CLAUDE_NATIVE_HELPER_PARENT_GONE"));
  }
  return new Promise<void>((resolve, reject) => {
    process.send!(value as Serializable, undefined, {}, (error: Error | null) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function safeCode(error: unknown): { code: string; recoverable: boolean } {
  if (
    error instanceof BridgeError &&
    /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
  ) {
    return { code: error.code, recoverable: error.recoverable };
  }
  return { code: "CLAUDE_NATIVE_HELPER_OPERATION_FAILED", recoverable: false };
}

function okResult(): Readonly<{ ok: true }> {
  return { ok: true };
}

export async function runClaudeNativeHelperProcess(): Promise<void> {
  if (process.send === undefined) return;
  let provider: LocalClaudeGatewayProvider | undefined;
  let initialized = false;
  let closing = false;
  let admitted = 0;
  let operation = Promise.resolve();
  let sendOperation = Promise.resolve();

  const queueSend = (message: ClaudeNativeHelperChildMessage): Promise<void> => {
    const queued = sendOperation.then(async () => await sendChildMessage(message));
    sendOperation = queued.catch(() => undefined);
    return queued;
  };

  const event = (value: ClaudeNativeHelperEvent): void => {
    void queueSend({
      protocolVersion: CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
      type: "event",
      value,
    }).catch(() => void shutdown());
  };

  const callbacks: GatewayAdapterCallbacks = {
    onDelivery: (value) => event({ event: "delivery", value: { ...value } }),
    onRouteState: () => undefined,
    onClaudeReply: (value) =>
      event({
        event: "claude_reply",
        value: {
          routeHandle: value.endpoint.routeHandle,
          text: value.text,
        },
      }),
    onClaudeMessage: (value) =>
      event({
        event: "claude_message",
        value: {
          routeHandle: value.endpoint.routeHandle,
          sourceAlias: value.sourceAlias,
          targetAlias: value.targetAlias,
          text: value.text,
          ...(value.receiptHandle === undefined
            ? {}
            : { receiptHandle: value.receiptHandle }),
        },
      }),
    onProtocolNotice: (value) =>
      event({ event: "protocol_notice", value: { code: value.code } }),
  };

  const respond = async (
    requestId: string,
    result: ClaudeNativeHelperResult,
  ): Promise<void> => {
    await queueSend({
      protocolVersion: CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
      type: "response",
      requestId,
      ok: true,
      result,
    });
  };

  const reject = async (requestId: string, error: unknown): Promise<void> => {
    await queueSend({
      protocolVersion: CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
      type: "response",
      requestId,
      ok: false,
      error: safeCode(error),
    });
  };

  const initialize = async (
    message: ClaudeNativeHelperInitialization,
  ): Promise<ClaudeNativeHelperResult> => {
    if (initialized || provider !== undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_ALREADY_INITIALIZED",
        "The native helper accepts exactly one immutable initialization.",
      );
    }
    const created = createLocalClaudeGatewayProvider({
      runtime: message.runtime,
      hostId: message.hostId,
      locale: message.locale,
      deliveryNotices: message.deliveryNotices,
      maxPendingMessages: message.maxPendingMessages,
      nativeHelperSourceProvider: message.registration.sourceProvider,
    });
    provider = created;
    try {
      await created.initialize(callbacks);
      const generation = created.currentUnadvertisedNativeCodexPeerGeneration();
      await created.quiesceNativeCodexPeerGeneration(generation);
      await created.advertiseNativeSourcePeer(message.registration);
      initialized = true;
      return { generation };
    } catch (error) {
      await created.close().catch(() => undefined);
      provider = undefined;
      throw error;
    }
  };

  const execute = async (
    command: ClaudeNativeHelperCommand,
  ): Promise<ClaudeNativeHelperResult> => {
    const active = provider;
    if (!initialized || active === undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_HELPER_NOT_INITIALIZED",
        "The native helper has not established its immutable registration.",
      );
    }
    switch (command.method) {
      case "resume_generation":
        await active.resumeNativeCodexPeerGeneration(command.generation);
        return okResult();
      case "authorize_route": {
        const snapshot = await active.discoverClaudePeers();
        const peer = snapshot.peers.find(
          (candidate) =>
            candidate.routeHandle === command.routeHandle &&
            candidate.alias === command.alias,
        );
        if (peer === undefined) {
          throw new BridgeError(
            "CLAUDE_ROUTE_MISMATCH",
            "The helper could not prove the exact selected Claude route.",
            true,
          );
        }
        await active.assertWorkspaceDisjoint(
          command.routeHandle,
          command.stateRoot,
        );
        await active.selectRoute({
          alias: command.alias,
          routeHandle: command.routeHandle,
        });
        return okResult();
      }
      case "release_route":
        await active.releaseRoute(command.routeHandle);
        return okResult();
      case "dispatch":
        return await active.dispatch(command);
      case "update_inbound_status":
        await active.updateNativeInboundStatus(
          command.receiptHandle,
          command.status,
          command.diagnosticCode,
        );
        return okResult();
      case "notify_inbound_progress":
        await active.notifyNativeInboundProgress(
          command.receiptHandle,
          command.progress,
        );
        return okResult();
      case "release_inbound_receipt":
        return {
          released: await active.releaseNativeInboundReceipt(
            command.receiptHandle,
          ),
        };
      case "update_status":
        await active.updateNativeSourcePeerStatus(command.alias, command.status);
        return okResult();
      case "unadvertise":
        await active.unadvertiseNativeSourcePeer(command.alias);
        return okResult();
      case "quiesce_generation":
        await active.quiesceNativeCodexPeerGeneration(command.generation);
        return okResult();
      case "observe_barrier":
        return await active.observeNativeCodexSuccessionBarrier(
          command.generation,
        );
      case "prepare_generation":
        await active.prepareNativeCodexPeerGeneration({
          alias: command.alias,
          cwd: command.cwd,
          generation: command.generation,
        });
        return okResult();
      case "publish_prepared":
        return {
          publication: await active.publishPreparedNativeCodexPeer({
            currentGeneration: command.currentGeneration,
            preparedGeneration: command.preparedGeneration,
          }),
        };
      case "activate_prepared":
        await active.activatePreparedNativeCodexPeerGeneration(
          command.generation,
        );
        return okResult();
      case "cleanup_prepared":
        await active.cleanupPreparedNativeCodexPeerGeneration(command.generation);
        return okResult();
      case "rollback_prepared":
        await active.rollbackPreparedNativeCodexPeerGeneration({
          preparedGeneration: command.preparedGeneration,
          resumeGeneration: command.resumeGeneration,
        });
        return okResult();
      case "retire_generation":
        await active.retireNativeCodexPeerGeneration({
          retiredGeneration: command.retiredGeneration,
          protectedActiveGeneration: command.protectedActiveGeneration,
        });
        return okResult();
      case "purge_generation_replies":
        return {
          purged: await active.purgeNativeCodexPeerGenerationReplyCapabilities(
            command.generation,
          ),
        };
      case "close":
        await active.close();
        return okResult();
    }
  };

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const current = provider;
    provider = undefined;
    if (current !== undefined) await current.close().catch(() => undefined);
    if (process.connected) process.disconnect();
    setImmediate(() => process.exit(0));
  };

  process.on("disconnect", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("message", (value: unknown) => {
    if (closing) return;
    try {
      assertClaudeNativeHelperIpcSize(value);
      if (!isClaudeNativeHelperParentMessage(value)) {
        throw new Error("CLAUDE_NATIVE_HELPER_PROTOCOL_INVALID");
      }
    } catch {
      void shutdown();
      return;
    }
    if (admitted >= CLAUDE_NATIVE_HELPER_MAX_REQUESTS) {
      void shutdown();
      return;
    }
    admitted += 1;
    operation = operation
      .then(async () => {
        try {
          const result =
            value.type === "initialize"
              ? await initialize(value)
              : await execute(value.command);
          await respond(value.requestId, result);
          if (value.type === "request" && value.command.method === "close") {
            await shutdown();
          }
        } catch (error) {
          await reject(value.requestId, error).catch(() => undefined);
          if (value.type === "initialize") await shutdown();
        }
      })
      .finally(() => {
        admitted -= 1;
      });
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  void runClaudeNativeHelperProcess();
}
