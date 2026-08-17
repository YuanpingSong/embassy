import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import readline from "node:readline";

const ACP_PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;
export const ACP_MAX_REPLY_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

type AcpChild = Pick<
  ChildProcessWithoutNullStreams,
  | "exitCode"
  | "kill"
  | "off"
  | "once"
  | "signalCode"
  | "stderr"
  | "stdin"
  | "stdout"
>;

export type AcpSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => AcpChild;

type AcpLaunchCommon = Readonly<{
  args?: readonly string[];
  cwd?: string;
}>;

export type AcpLaunchSpec =
  | (AcpLaunchCommon &
      Readonly<{
        kind: "npx";
        package: string;
      }>)
  | (AcpLaunchCommon &
      Readonly<{
        kind: "binary";
        path: string;
        /** Registry metadata; artifact installation/verification is not this client's job. */
        sha256: string;
      }>)
  | (AcpLaunchCommon &
      Readonly<{
        kind: "local-checkout";
        command: string;
      }>);

export type AcpAgentCapabilities = Readonly<JsonObject>;

export type AcpConnectionInfo = Readonly<{
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: readonly unknown[];
}>;

export type AcpRpcErrorDetail = Readonly<{
  code: number;
  message: string;
  data?: unknown;
}>;

export type AcpPromptReceipt =
  | Readonly<{
      terminalState: "delivered";
      stopReason: "end_turn";
      text: string;
      textTruncated: boolean;
    }>
  | Readonly<{
      terminalState: "failed";
      stopReason: "max_tokens" | "max_turn_requests" | "refusal";
      text: string;
      textTruncated: boolean;
    }>
  | Readonly<{
      terminalState: "cancelled";
      stopReason: "cancelled";
      text: string;
      textTruncated: boolean;
    }>
  | Readonly<{
      terminalState: "failed";
      error: AcpRpcErrorDetail;
      reportOnly: boolean;
      text: string;
      textTruncated: boolean;
    }>
  | Readonly<{
      /** Process loss cannot prove whether the outstanding prompt completed. */
      terminalState: "unknown";
      text: string;
      textTruncated: boolean;
    }>;

export type AcpPreparedPrompt = Readonly<{
  bodyBytes: number;
  frameBytes: number;
  sha256: string;
  /** Release a prepared-but-unperformed prompt exactly once. */
  cancel: () => void;
  /** Enqueue the exact pre-serialized frame exactly once. */
  perform: () => Promise<AcpPromptReceipt>;
}>;

export type AcpOptionalResult<T> =
  | Readonly<{ available: true; value: T }>
  | Readonly<{
      available: false;
      reason: "not_advertised" | "method_not_found";
    }>;

export type AcpSessionOptions = Readonly<{
  sessionId: string;
  cwd: string;
  mcpServers?: readonly unknown[];
}>;

export class AcpRequestError extends Error {
  readonly detail: AcpRpcErrorDetail;

  constructor(detail: AcpRpcErrorDetail) {
    super(detail.message);
    this.name = "AcpRequestError";
    this.detail = detail;
  }
}

class AcpProcessExitedError extends Error {
  constructor() {
    super("ACP subprocess exited");
    this.name = "AcpProcessExitedError";
  }
}

type PendingRequest = Readonly<{
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>;

type ActivePrompt = { bytes: number; text: string; truncated: boolean };

export class AcpClient {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly disabledMethods = new Map<string, AcpRpcErrorDetail>();
  private readonly activePrompts = new Map<string, ActivePrompt>();
  private readonly lines: readline.Interface;
  private nextRequestId = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private exited = false;
  private infoValue!: AcpConnectionInfo;

  private constructor(private readonly child: AcpChild) {
    child.stderr.resume();
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.once("error", () => this.handleProcessExit());
    child.once("exit", () => this.handleProcessExit());
  }

  static async spawn(
    launch: AcpLaunchSpec,
    options: Readonly<{ spawn?: AcpSpawn }> = {},
  ): Promise<AcpClient> {
    const { command, args } = resolveLaunch(launch);
    let child: AcpChild;
    try {
      child = (options.spawn ?? nodeSpawn)(command, args, {
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new AcpProcessExitedError();
    }
    const client = new AcpClient(child);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get connectionInfo(): AcpConnectionInfo {
    return this.infoValue;
  }

  async newSession(
    cwd: string,
    mcpServers: readonly unknown[] = [],
  ): Promise<Readonly<{ sessionId: string }>> {
    const result = asObject(
      await this.request("session/new", { cwd, mcpServers: [...mcpServers] }),
      "session/new",
    );
    if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
      throw new Error("ACP session/new returned an invalid sessionId");
    }
    return { sessionId: result.sessionId };
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptReceipt> {
    try {
      return await this.preparePrompt(sessionId, text).perform();
    } catch (error) {
      if (error instanceof AcpRequestError) {
        return {
          terminalState: "failed",
          error: error.detail,
          reportOnly: error.detail.code === -32000,
          text: "",
          textTruncated: false,
        };
      }
      throw error;
    }
  }

  preparePrompt(sessionId: string, text: string): AcpPreparedPrompt {
    const disabled = this.disabledMethods.get("session/prompt");
    if (disabled !== undefined) throw new AcpRequestError(disabled);
    if (this.activePrompts.has(sessionId)) {
      throw new Error("ACP session already has an outstanding prompt");
    }
    if (
      this.exited ||
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof text !== "string" ||
      text.length === 0
    ) {
      throw new Error("ACP prompt preparation is unavailable");
    }
    const active: ActivePrompt = { bytes: 0, text: "", truncated: false };
    this.activePrompts.set(sessionId, active);
    const id = this.nextRequestId++;
    const serialized = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    })}\n`;
    let disposition: "prepared" | "performed" | "cancelled" = "prepared";
    const rejectReuse = (): never => {
      throw new Error("ACP prepared prompt was already consumed");
    };
    return Object.freeze({
      bodyBytes: Buffer.byteLength(text, "utf8"),
      frameBytes: Buffer.byteLength(serialized, "utf8"),
      sha256: createHash("sha256").update(serialized).digest("hex"),
      cancel: () => {
        if (disposition !== "prepared") return rejectReuse();
        disposition = "cancelled";
        this.activePrompts.delete(sessionId);
      },
      perform: () => {
        if (disposition !== "prepared") {
          return Promise.reject(
            new Error("ACP prepared prompt was already consumed"),
          );
        }
        disposition = "performed";
        return this.performPreparedPrompt(id, sessionId, active, serialized);
      },
    });
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.request("authenticate", { methodId });
  }

  listSessions(
    params: Readonly<{ cwd?: string; cursor?: string }> = {},
  ): Promise<AcpOptionalResult<unknown>> {
    return this.optionalRequest(
      "session/list",
      hasObjectCapability(this.infoValue.agentCapabilities, [
        "sessionCapabilities",
        "list",
      ]),
      params,
    );
  }

  resumeSession(options: AcpSessionOptions): Promise<AcpOptionalResult<unknown>> {
    return this.optionalRequest(
      "session/resume",
      hasObjectCapability(this.infoValue.agentCapabilities, [
        "sessionCapabilities",
        "resume",
      ]),
      sessionLifecycleParams(options),
    );
  }

  loadSession(options: AcpSessionOptions): Promise<AcpOptionalResult<unknown>> {
    return this.optionalRequest(
      "session/load",
      this.infoValue.agentCapabilities.loadSession === true,
      sessionLifecycleParams(options),
    );
  }

  close(): void {
    if (this.exited) return;
    this.handleProcessExit();
    this.child.kill();
  }

  private async performPreparedPrompt(
    id: JsonRpcId,
    sessionId: string,
    active: ActivePrompt,
    serialized: string,
  ): Promise<AcpPromptReceipt> {
    try {
      const result = asObject(
        await this.requestSerialized(
          id,
          "session/prompt",
          serialized,
        ),
        "session/prompt",
      );
      return mapPromptResult(result.stopReason, active);
    } catch (error) {
      if (error instanceof AcpProcessExitedError) {
        return {
          terminalState: "unknown",
          text: active.text,
          textTruncated: active.truncated,
        };
      }
      if (error instanceof AcpRequestError) {
        return {
          terminalState: "failed",
          error: error.detail,
          reportOnly: error.detail.code === -32000,
          text: active.text,
          textTruncated: active.truncated,
        };
      }
      throw error;
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }

  private async initialize(): Promise<void> {
    const result = asObject(
      await this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
      "initialize",
    );
    if (!Number.isInteger(result.protocolVersion)) {
      throw new Error("ACP initialize returned an invalid protocolVersion");
    }
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `ACP protocol version mismatch: client supports ${ACP_PROTOCOL_VERSION}, agent selected ${String(result.protocolVersion)}`,
      );
    }
    const agentCapabilities =
      result.agentCapabilities === undefined
        ? {}
        : asObject(result.agentCapabilities, "initialize.agentCapabilities");
    const authMethods = Array.isArray(result.authMethods)
      ? [...result.authMethods]
      : [];
    this.infoValue = Object.freeze({
      protocolVersion: result.protocolVersion as number,
      agentCapabilities: Object.freeze({ ...agentCapabilities }),
      authMethods: Object.freeze(authMethods),
    });
  }

  private async optionalRequest(
    method: string,
    advertised: boolean,
    params: unknown,
  ): Promise<AcpOptionalResult<unknown>> {
    if (!advertised) return { available: false, reason: "not_advertised" };
    if (this.disabledMethods.has(method)) {
      return { available: false, reason: "method_not_found" };
    }
    try {
      return { available: true, value: await this.request(method, params) };
    } catch (error) {
      if (
        error instanceof AcpRequestError &&
        error.detail.code === METHOD_NOT_FOUND
      ) {
        return { available: false, reason: "method_not_found" };
      }
      throw error;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const disabled = this.disabledMethods.get(method);
    if (disabled) return Promise.reject(new AcpRequestError(disabled));
    if (this.exited) return Promise.reject(new AcpProcessExitedError());
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private requestSerialized(
    id: JsonRpcId,
    method: string,
    serialized: string,
  ): Promise<unknown> {
    if (this.exited) return Promise.reject(new AcpProcessExitedError());
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      void this.writeSerialized(serialized).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): Promise<void> {
    return this.writeSerialized(`${JSON.stringify(message)}\n`);
  }

  private writeSerialized(serialized: string): Promise<void> {
    if (this.exited) return Promise.reject(new AcpProcessExitedError());
    const operation = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.exited) {
            reject(new AcpProcessExitedError());
            return;
          }
          this.child.stdin.write(serialized, (error) => {
            if (error) {
              this.handleProcessExit();
              reject(new AcpProcessExitedError());
            }
            else resolve();
          });
        }),
    );
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    if (typeof message.method === "string") {
      this.handleInbound(message);
      return;
    }
    if ((typeof message.id !== "string" && typeof message.id !== "number") ||
        (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      const detail = rpcErrorDetail(message.error);
      if (detail.code === METHOD_NOT_FOUND) {
        this.disabledMethods.set(pending.method, detail);
      }
      pending.reject(new AcpRequestError(detail));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleInbound(message: JsonObject): void {
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (message.method === "session/update" && !hasId) {
      this.consumeSessionUpdate(message.params);
      return;
    }
    if (message.method === "session/request_permission" && hasId) {
      void this.write({
        jsonrpc: "2.0",
        id: message.id as JsonRpcId,
        result: { outcome: { outcome: "cancelled" } },
      }).catch(() => undefined);
      return;
    }
    if (hasId) {
      void this.write({
        jsonrpc: "2.0",
        id: message.id as JsonRpcId,
        error: { code: METHOD_NOT_FOUND, message: "Method not found" },
      }).catch(() => undefined);
    }
  }

  private consumeSessionUpdate(params: unknown): void {
    if (!isObject(params) || typeof params.sessionId !== "string") return;
    const update = params.update;
    if (
      !isObject(update) ||
      update.sessionUpdate !== "agent_message_chunk" ||
      !isObject(update.content) ||
      update.content.type !== "text" ||
      typeof update.content.text !== "string"
    ) {
      return;
    }
    const active = this.activePrompts.get(params.sessionId);
    if (active) appendPromptText(active, update.content.text);
  }

  private handleProcessExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.lines.close();
    const error = new AcpProcessExitedError();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.activePrompts.clear();
  }
}

function resolveLaunch(launch: AcpLaunchSpec): {
  command: string;
  args: readonly string[];
} {
  const args = launch.args ?? [];
  if (launch.kind === "npx") {
    return { command: "npx", args: ["--yes", launch.package, ...args] };
  }
  if (launch.kind === "binary") {
    return { command: launch.path, args };
  }
  return { command: launch.command, args };
}

function sessionLifecycleParams(options: AcpSessionOptions): JsonObject {
  return {
    sessionId: options.sessionId,
    cwd: options.cwd,
    mcpServers: [...(options.mcpServers ?? [])],
  };
}

function mapPromptResult(
  stopReason: unknown,
  active: ActivePrompt,
): AcpPromptReceipt {
  const textResult = {
    text: active.text,
    textTruncated: active.truncated,
  };
  if (stopReason === "end_turn") {
    return { terminalState: "delivered", stopReason, ...textResult };
  }
  if (
    stopReason === "max_tokens" ||
    stopReason === "max_turn_requests" ||
    stopReason === "refusal"
  ) {
    return { terminalState: "failed", stopReason, ...textResult };
  }
  if (stopReason === "cancelled") {
    return { terminalState: "cancelled", stopReason, ...textResult };
  }
  throw new AcpRequestError({
    code: -32603,
    message: "ACP session/prompt returned an invalid stopReason",
  });
}

function appendPromptText(active: ActivePrompt, text: string): void {
  if (active.truncated) return;
  const bytes = Buffer.from(text, "utf8");
  const remaining = ACP_MAX_REPLY_BYTES - active.bytes;
  if (bytes.length <= remaining) {
    active.text += text;
    active.bytes += bytes.length;
    return;
  }
  let end = remaining;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  active.text += bytes.subarray(0, end).toString("utf8");
  active.bytes += end;
  active.truncated = true;
}

function hasObjectCapability(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (!isObject(current)) return false;
    current = current[segment];
  }
  return isObject(current);
}

function rpcErrorDetail(value: unknown): AcpRpcErrorDetail {
  if (!isObject(value) || typeof value.code !== "number" ||
      typeof value.message !== "string") {
    return { code: -32603, message: "Invalid JSON-RPC error response" };
  }
  return {
    code: value.code,
    message: value.message,
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
  };
}

function asObject(value: unknown, method: string): JsonObject {
  if (!isObject(value)) {
    throw new AcpRequestError({
      code: -32603,
      message: `ACP ${method} returned an invalid response`,
    });
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function spawnAcpClient(
  launch: AcpLaunchSpec,
  options: Readonly<{ spawn?: AcpSpawn }> = {},
): Promise<AcpClient> {
  return AcpClient.spawn(launch, options);
}
