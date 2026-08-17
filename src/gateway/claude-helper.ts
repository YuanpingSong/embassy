import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Serializable } from "node:child_process";
import { randomBytes } from "node:crypto";

import { BridgeError } from "../errors.js";
import {
  assertClaudeNativeHelperIpcSize,
  CLAUDE_NATIVE_HELPER_MAX_REQUESTS,
  CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS,
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
import type { GatewayAdapterDispatchResult } from "./service.js";

type PreparedNativeDispatch = Readonly<{
  messageId: string;
  frameBytes: number;
  sha256: string;
  perform: () => Promise<GatewayAdapterDispatchResult>;
  cancel: () => void;
}>;

type HelperDispatchProvider = LocalClaudeGatewayProvider & {
  prepareNativeHelperDispatch: (
    command: Extract<ClaudeNativeHelperCommand, { method: "prepare_dispatch" }>,
  ) => Promise<PreparedNativeDispatch>;
};

type HeldPreparation = {
  preparationId: string;
  prepared: PreparedNativeDispatch;
  timer: NodeJS.Timeout;
};

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
  let heldPreparation: HeldPreparation | undefined;
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
      await created.advertiseNativeSourcePeer(message.registration);
      initialized = true;
      return { generation };
    } catch (error) {
      await created.close().catch(() => undefined);
      provider = undefined;
      throw error;
    }
  };

  const discardPreparation = (): void => {
    const current = heldPreparation;
    heldPreparation = undefined;
    if (current === undefined) return;
    clearTimeout(current.timer);
    current.prepared.cancel();
  };

  const takePreparation = (preparationId: string): HeldPreparation => {
    const current = heldPreparation;
    heldPreparation = undefined;
    if (current === undefined) {
      throw new BridgeError(
        "CLAUDE_NATIVE_PREPARATION_UNKNOWN",
        "The native helper preparation is unknown or already consumed.",
      );
    }
    clearTimeout(current.timer);
    if (current.preparationId !== preparationId) {
      current.prepared.cancel();
      throw new BridgeError(
        "CLAUDE_NATIVE_PREPARATION_MISMATCH",
        "The native helper preparation capability did not match.",
      );
    }
    return current;
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
      case "prepare_dispatch": {
        if (heldPreparation !== undefined) {
          throw new BridgeError(
            "CLAUDE_NATIVE_PREPARATION_CAPACITY",
            "The native helper already owns its single bounded preparation.",
            true,
          );
        }
        const prepared = await (
          active as HelperDispatchProvider
        ).prepareNativeHelperDispatch(command);
        const preparationId = `prep_${randomBytes(18).toString("base64url")}`;
        const timer = setTimeout(
          discardPreparation,
          Math.max(
            1,
            Math.min(
              CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS,
              Date.parse(command.deadlineAt) - Date.now(),
            ),
          ),
        );
        timer.unref();
        heldPreparation = { preparationId, prepared, timer };
        return {
          preparationId,
          frameBytes: prepared.frameBytes,
          sha256: prepared.sha256,
        };
      }
      case "perform_dispatch": {
        const current = takePreparation(command.preparationId);
        // Calling perform begins the exact stored operation synchronously;
        // only its already-started completion is awaited here.
        const operation = current.prepared.perform();
        return await operation;
      }
      case "cancel_dispatch":
        takePreparation(command.preparationId).prepared.cancel();
        return okResult();
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
      case "close":
        discardPreparation();
        await active.close();
        return okResult();
    }
  };

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    discardPreparation();
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
