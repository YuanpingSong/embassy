import {
  fork,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { BridgeError } from "../errors.js";
import type { AttestedClaudePeerRuntime } from "./claude-runtime.js";
import type { GatewayDeliveryNoticeMode } from "./config.js";
import {
  assertClaudeNativeHelperIpcSize,
  CLAUDE_NATIVE_HELPER_MAX_REQUESTS,
  CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
  isClaudeNativeHelperChildMessage,
  type ClaudeNativeHelperChildMessage,
  type ClaudeNativeHelperCommand,
  type ClaudeNativeHelperEvent,
  type ClaudeNativeHelperInitialization,
  type ClaudeNativeHelperRegistration,
  type ClaudeNativeHelperResult,
} from "./claude-helper-protocol.js";
import type { DashboardLocale } from "./locale.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;

type PendingRequest = {
  resolve: (result: ClaudeNativeHelperResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

export type ClaudeNativeHelperClientCallbacks = Readonly<{
  onEvent: (event: ClaudeNativeHelperEvent) => void;
  onExit: (event: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
}>;

export type ClaudeNativeHelperClientStartOptions = Readonly<{
  entryPath?: string;
  runtime: AttestedClaudePeerRuntime;
  hostId: "this-mac";
  locale: DashboardLocale;
  deliveryNotices: GatewayDeliveryNoticeMode;
  maxPendingMessages: number;
  registration: ClaudeNativeHelperRegistration;
  callbacks: ClaudeNativeHelperClientCallbacks;
}>;

export interface ClaudeNativeHelperClientLike {
  readonly pid: number;
  readonly registration: ClaudeNativeHelperRegistration;
  generation: string;
  request(
    command: ClaudeNativeHelperCommand,
    timeoutMs?: number,
  ): Promise<ClaudeNativeHelperResult>;
  close(): Promise<void>;
  forceClose(): Promise<void>;
}

export type ClaudeNativeHelperFactory = (
  options: ClaudeNativeHelperClientStartOptions,
) => Promise<ClaudeNativeHelperClientLike>;

export function defaultClaudeNativeHelperEntryPath(): string {
  return fileURLToPath(new URL("./claude-helper.js", import.meta.url));
}

function requestId(): string {
  return randomBytes(18).toString("base64url");
}

function helperFault(
  code: string,
  recoverable = false,
): BridgeError {
  return new BridgeError(
    code,
    "The supervised native Claude helper could not complete its bounded operation.",
    recoverable,
  );
}

function sendIpc(child: ChildProcess, value: unknown): Promise<void> {
  assertClaudeNativeHelperIpcSize(value);
  if (!child.connected || child.killed) {
    return Promise.reject(helperFault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true));
  }
  return new Promise<void>((resolve, reject) => {
    child.send(value as Serializable, (error) => {
      if (error === null) resolve();
      else reject(helperFault("CLAUDE_NATIVE_HELPER_IPC_FAILED", true));
    });
  });
}

export class ClaudeNativeHelperClient implements ClaudeNativeHelperClientLike {
  readonly pid: number;
  readonly registration: ClaudeNativeHelperRegistration;
  generation: string;

  readonly #child: ChildProcess;
  readonly #callbacks: ClaudeNativeHelperClientCallbacks;
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;
  #exitSettled = false;
  #exitPromise: Promise<void>;
  #resolveExit!: () => void;

  private constructor(
    child: ChildProcess,
    registration: ClaudeNativeHelperRegistration,
    callbacks: ClaudeNativeHelperClientCallbacks,
  ) {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      throw helperFault("CLAUDE_NATIVE_HELPER_PID_INVALID");
    }
    this.pid = child.pid!;
    this.registration = registration;
    this.generation = "";
    this.#child = child;
    this.#callbacks = callbacks;
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    child.on("message", (value) => this.#onMessage(value));
    child.once("error", () => this.#fail(helperFault("CLAUDE_NATIVE_HELPER_SPAWN_FAILED")));
    child.once("disconnect", () => {
      if (!this.#exitSettled) {
        this.#fail(helperFault("CLAUDE_NATIVE_HELPER_DISCONNECTED"));
      }
    });
    child.once("exit", (code, signal) => this.#onExit(code, signal));
  }

  static async start(
    options: ClaudeNativeHelperClientStartOptions,
  ): Promise<ClaudeNativeHelperClient> {
    const entryPath = options.entryPath ?? defaultClaudeNativeHelperEntryPath();
    const child = fork(entryPath, [], {
      cwd: "/",
      env: {
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
      execPath: process.execPath,
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const client = new ClaudeNativeHelperClient(
      child,
      options.registration,
      options.callbacks,
    );
    const init: ClaudeNativeHelperInitialization = {
      protocolVersion: CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
      type: "initialize",
      requestId: requestId(),
      runtime: { ...options.runtime },
      hostId: options.hostId,
      locale: options.locale,
      deliveryNotices: options.deliveryNotices,
      maxPendingMessages: options.maxPendingMessages,
      registration: { ...options.registration },
    };
    try {
      const result = await client.#requestEnvelope(init, DEFAULT_REQUEST_TIMEOUT_MS);
      if (
        !("generation" in result) ||
        typeof result.generation !== "string" ||
        result.generation.length === 0
      ) {
        throw helperFault("CLAUDE_NATIVE_HELPER_INVALID_RESPONSE");
      }
      client.generation = result.generation;
      return client;
    } catch (error) {
      await client.forceClose();
      throw error;
    }
  }

  async request(
    command: ClaudeNativeHelperCommand,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ClaudeNativeHelperResult> {
    return await this.#requestEnvelope(
      {
        protocolVersion: CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
        type: "request",
        requestId: requestId(),
        command,
      },
      timeoutMs,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return await this.#exitPromise;
    try {
      await this.request({ method: "close" }, CLOSE_TIMEOUT_MS);
    } catch {
      this.#child.kill("SIGTERM");
    }
    this.#closed = true;
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
    timer.unref();
    await this.#exitPromise;
    clearTimeout(timer);
  }

  async forceClose(): Promise<void> {
    if (!this.#closed) this.#closed = true;
    if (!this.#exitSettled) this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
    timer.unref();
    await this.#exitPromise;
    clearTimeout(timer);
  }

  async #requestEnvelope(
    envelope: ClaudeNativeHelperInitialization | Readonly<{
      protocolVersion: 1;
      type: "request";
      requestId: string;
      command: ClaudeNativeHelperCommand;
    }>,
    timeoutMs: number,
  ): Promise<ClaudeNativeHelperResult> {
    if (this.#closed || this.#exitSettled) {
      throw helperFault("CLAUDE_NATIVE_HELPER_UNAVAILABLE", true);
    }
    if (this.#pending.size >= CLAUDE_NATIVE_HELPER_MAX_REQUESTS) {
      throw helperFault("CLAUDE_NATIVE_HELPER_REQUEST_CAPACITY", true);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw helperFault("CLAUDE_NATIVE_HELPER_TIMEOUT_INVALID");
    }
    const promise = new Promise<ClaudeNativeHelperResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(envelope.requestId);
        reject(helperFault("CLAUDE_NATIVE_HELPER_REQUEST_TIMEOUT"));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(envelope.requestId, { resolve, reject, timer });
    });
    try {
      await sendIpc(this.#child, envelope);
    } catch (error) {
      const pending = this.#pending.get(envelope.requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(envelope.requestId);
        pending.reject(error);
      }
    }
    return await promise;
  }

  #onMessage(value: unknown): void {
    try {
      assertClaudeNativeHelperIpcSize(value);
      if (!isClaudeNativeHelperChildMessage(value)) {
        throw helperFault("CLAUDE_NATIVE_HELPER_PROTOCOL_INVALID");
      }
    } catch (error) {
      this.#fail(error);
      this.#child.kill("SIGTERM");
      return;
    }
    const message: ClaudeNativeHelperChildMessage = value;
    if (message.type === "event") {
      this.#callbacks.onEvent(message.value);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(helperFault(message.error.code, message.error.recoverable));
  }

  #fail(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitSettled) return;
    this.#exitSettled = true;
    this.#fail(helperFault("CLAUDE_NATIVE_HELPER_EXITED"));
    this.#resolveExit();
    this.#callbacks.onExit({ code, signal });
  }
}

export const createClaudeNativeHelper: ClaudeNativeHelperFactory = async (
  options,
) => await ClaudeNativeHelperClient.start(options);
