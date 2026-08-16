import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { CodexAppServerTransport } from "./codex-app-server.js";
import {
  createLocalCodexTransportFactory,
  LocalCodexTransportError,
  type LocalCodexOwnedTransport,
  type LocalCodexTransportDependencies,
  type LocalCodexTransportErrorCode,
  type LocalCodexTransportFactory,
  type LocalCodexTransportFactoryOptions,
} from "./codex-local-transport.js";

const DEFAULT_MAX_DEADLINE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_REPLY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 2 * 60_000;
const MAX_FAST_TERMINAL_CANDIDATES = 4;
const OUTPUT_NOTIFICATION_OPT_OUTS = [
  "item/started", "item/agentMessage/delta", "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta",
  "turn/diff/updated", "turn/plan/updated",
] as const;

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

type JsonObject = Record<string, unknown>;
type OperationPhase = "clean" | "armed" | "accepted" | "terminal";
type TurnOutcome = "completed" | "failed" | "interrupted";
type ReplyCode = "REPLY_TOO_LARGE" | "REPLY_UNAVAILABLE" | null;
export type StatelessCodexRoute = Readonly<{
  alias: string; hostId: string; threadId: string;
}>;

export type StatelessCodexWriteEvidence = Readonly<{
  attemptId: string; kind: "codex_turn_start" | "codex_turn_steer";
  bodyBytes: number; frameBytes: number; sha256: string;
}>;

type StatelessCodexOperationCommon = Readonly<{
  attemptId: string; deadlineAt: string; route: StatelessCodexRoute;
  authorizeWrite: (evidence: StatelessCodexWriteEvidence) => Promise<boolean>;
  /** Already provenance-framed by the broker; never emitted as evidence. */
  text: string;
}>;

export type StatelessCodexOperationInput =
  | (StatelessCodexOperationCommon & Readonly<{ kind: "start" }>)
  | (StatelessCodexOperationCommon &
      Readonly<{ expectedTurnId: string; kind: "steer" }>);

export type StatelessCodexSafeErrorCode =
  | LocalCodexTransportErrorCode
  | "APPROVAL_REQUIRED"
  | "INPUT_INVALID"
  | "MESSAGE_EXPIRED"
  | "PROTOCOL_ERROR"
  | "REQUEST_TIMEOUT"
  | "RESULT_SCHEMA_MISMATCH"
  | "ROUTE_BUSY"
  | "RPC_REJECTED"
  | "RPC_REJECTED_NO_EFFECT"
  | "THREAD_NOT_OBSERVED"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_WRITE_FAILED"
  | "WRITE_AUTHORIZATION_DENIED"
  | "WRITE_AUTHORIZATION_UNCERTAIN";

type ResultCommon = Readonly<{ attemptId: string; cleanupConfirmed: boolean }>;

export type StatelessCodexOperationResult =
  | (ResultCommon &
      Readonly<{
        phase: "clean"; state: "deferred" | "failed";
        safeErrorCode: StatelessCodexSafeErrorCode;
      }>)
  | (ResultCommon &
      Readonly<{
        phase: "armed"; state: "ambiguous";
        safeErrorCode: StatelessCodexSafeErrorCode;
      }>)
  | (ResultCommon &
      Readonly<{
        phase: "armed"; state: "deferred";
        safeErrorCode: "RPC_REJECTED_NO_EFFECT";
      }>)
  | (ResultCommon &
      Readonly<{
        phase: "accepted"; state: "unconfirmed";
        safeErrorCode: StatelessCodexSafeErrorCode;
      }>)
  | (ResultCommon &
      Readonly<{
        phase: "terminal"; state: "terminal";
        outcome: "delivered" | TurnOutcome; replyCode: ReplyCode;
        replyText: string | null;
      }>);

export type StatelessCodexOperationTransport = Readonly<{
  execute: (input: StatelessCodexOperationInput) => Promise<StatelessCodexOperationResult>;
}>;

export type StatelessCodexOperationTransportOptions = Readonly<{
  local?: Omit<LocalCodexTransportFactoryOptions, "hostId">;
  maxDeadlineMs?: number;
  maxFrameBytes?: number;
  maxInputBytes?: number;
  maxReplyBytes?: number;
  now?: () => Date;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}>;

export type StatelessCodexOperationTransportDependencies = Readonly<{
  createFactory?: (options: LocalCodexTransportFactoryOptions) => Promise<LocalCodexTransportFactory>;
  localDependencies?: LocalCodexTransportDependencies;
}>;

type NormalizedOptions = Readonly<{
  local: Omit<LocalCodexTransportFactoryOptions, "hostId">;
  maxDeadlineMs: number;
  maxFrameBytes: number;
  maxInputBytes: number;
  maxReplyBytes: number;
  now: () => Date;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
}>;

type PendingRequest = {
  id: number;
  reject: (error: OperationError) => void;
  resolve: (value: unknown) => void;
  sent: boolean;
  timer?: NodeJS.Timeout;
};

type PreparedRequest = Readonly<{
  frame: string;
  frameBytes: number;
  id: number;
}>;

type FastCandidate = {
  replyCode: ReplyCode;
  replyText: string | null;
  terminal: TurnOutcome | null;
};

type TerminalResult = Readonly<{
  outcome: TurnOutcome;
  replyCode: ReplyCode;
  replyText: string | null;
}>;

type WithoutResultCommon<T> = T extends unknown ? Omit<T, keyof ResultCommon> : never;
type InnerResult = WithoutResultCommon<StatelessCodexOperationResult>;

class OperationError extends Error {
  constructor(readonly code: StatelessCodexSafeErrorCode) {
    super(code);
    this.name = "StatelessCodexOperationError";
  }
}

class RpcRejectedError extends OperationError {
  constructor() {
    super("RPC_REJECTED");
    this.name = "StatelessCodexRpcRejectedError";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new OperationError("INPUT_INVALID");
  }
  return candidate;
}

function validOpaqueId(value: string, maximumLength = 256): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function validHost(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/u.test(value);
}

function validAlias(value: string, hostId: string): boolean {
  return (
    value.length <= 256 &&
    value.endsWith(`@${hostId}`) &&
    /^[a-z0-9][a-z0-9._-]*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(
      value,
    )
  );
}

function parseRouteStatus(
  value: unknown,
): "active" | "idle" | "not_loaded" | "system_error" | "waiting_approval" | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "notLoaded") return "not_loaded";
  if (value.type === "idle") return "idle";
  if (value.type === "systemError") return "system_error";
  if (value.type !== "active") return null;
  if (value.activeFlags === undefined) return "active";
  if (
    !Array.isArray(value.activeFlags) ||
    value.activeFlags.length > 32 ||
    !value.activeFlags.every(
      (flag) => typeof flag === "string" && flag.length <= 128,
    )
  ) {
    return null;
  }
  return value.activeFlags.includes("waitingOnApproval")
    ? "waiting_approval"
    : "active";
}

function parseTurn(value: unknown): { id: string; status: string } | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !validOpaqueId(value.id) ||
    typeof value.status !== "string" ||
    value.status.length > 64
  ) {
    return null;
  }
  return { id: value.id, status: value.status };
}

function normalizeOptions(
  options: StatelessCodexOperationTransportOptions,
): NormalizedOptions {
  return {
    local: { ...options.local },
    maxDeadlineMs: positiveInteger(
      options.maxDeadlineMs,
      DEFAULT_MAX_DEADLINE_MS,
    ),
    maxFrameBytes: positiveInteger(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
    ),
    maxInputBytes: positiveInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
    ),
    maxReplyBytes: positiveInteger(
      options.maxReplyBytes,
      DEFAULT_MAX_REPLY_BYTES,
    ),
    now: options.now ?? (() => new Date()),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    turnTimeoutMs: positiveInteger(
      options.turnTimeoutMs,
      DEFAULT_TURN_TIMEOUT_MS,
    ),
  };
}

function validateInput(
  input: StatelessCodexOperationInput,
  options: NormalizedOptions,
): { bodyBytes: number; deadlineAtMs: number } {
  if (
    !validOpaqueId(input.attemptId, 128) ||
    !validHost(input.route.hostId) ||
    !validAlias(input.route.alias, input.route.hostId) ||
    !validOpaqueId(input.route.threadId) ||
    (input.kind === "steer" && !validOpaqueId(input.expectedTurnId)) ||
    typeof input.text !== "string" ||
    input.text.trim().length === 0 ||
    input.text.includes("\0")
  ) {
    throw new OperationError("INPUT_INVALID");
  }
  const bodyBytes = Buffer.byteLength(input.text, "utf8");
  const nowMs = options.now().getTime();
  const deadlineAtMs = Date.parse(input.deadlineAt);
  if (
    bodyBytes === 0 ||
    bodyBytes > options.maxInputBytes ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(deadlineAtMs) ||
    new Date(deadlineAtMs).toISOString() !== input.deadlineAt ||
    deadlineAtMs <= nowMs ||
    deadlineAtMs > nowMs + options.maxDeadlineMs
  ) {
    throw new OperationError("INPUT_INVALID");
  }
  return { bodyBytes, deadlineAtMs };
}

class OperationSession {
  private nextRequestId = 1;
  private pending: PendingRequest | undefined;
  private phase: OperationPhase = "clean";
  private protocolFailure: OperationError | undefined;
  private selectedTurnId: string | undefined;
  private awaitingAuthorization = false;
  private prewriteProofValid = false;
  private readonly candidates = new Map<string, FastCandidate>();
  private terminalReject: ((error: OperationError) => void) | undefined;
  private terminalResolve: ((result: TerminalResult) => void) | undefined;
  private terminalTimer: NodeJS.Timeout | undefined;
  private transportLost = false;
  private readonly unlisten: Array<() => void> = [];

  constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly input: StatelessCodexOperationInput,
    private readonly options: NormalizedOptions,
    private readonly deadlineAtMs: number,
    private readonly bodyBytes: number,
  ) {
    this.unlisten.push(
      transport.onMessage((payload) => this.handlePayload(payload)),
      transport.onClose(() => this.handleTransportLoss()),
      transport.onError(() => this.handleTransportLoss()),
    );
  }

  dispose(): void {
    for (const remove of this.unlisten.splice(0)) remove();
    this.clearPending();
    this.clearTerminalWait();
  }

  async execute(): Promise<InnerResult> {
    try {
      await this.initialize();
      this.awaitingAuthorization = true;
      this.prewriteProofValid = true;
      const status = await this.resume();
      const held = this.prewriteDisposition(status);
      if (held !== undefined) {
        this.awaitingAuthorization = false;
        return held;
      }
      if (!this.prewriteProofValid || this.expired()) {
        this.awaitingAuthorization = false;
        return this.cleanDeferred(
          this.prewriteProofValid ? "MESSAGE_EXPIRED" : "ROUTE_BUSY",
        );
      }

      const method = this.input.kind === "start" ? "turn/start" : "turn/steer";
      const params =
        this.input.kind === "start"
          ? {
              input: [{ text: this.input.text, type: "text" }],
              threadId: this.input.route.threadId,
            }
          : {
              expectedTurnId: this.input.expectedTurnId,
              input: [{ text: this.input.text, type: "text" }],
              threadId: this.input.route.threadId,
            };
      const prepared = this.prepareRequest(method, params);
      const responsePromise = this.reservePreparedRequest(prepared);
      void responsePromise.catch(() => undefined);
      const evidence: StatelessCodexWriteEvidence = {
        attemptId: this.input.attemptId,
        bodyBytes: this.bodyBytes,
        frameBytes: prepared.frameBytes,
        kind:
          this.input.kind === "start"
            ? "codex_turn_start"
            : "codex_turn_steer",
        sha256: createHash("sha256").update(prepared.frame).digest("hex"),
      };

      let authorized: boolean;
      try {
        authorized = await this.input.authorizeWrite(evidence);
      } catch {
        this.awaitingAuthorization = false;
        this.clearPending();
        this.phase = "armed";
        return this.armedAmbiguous("WRITE_AUTHORIZATION_UNCERTAIN");
      }
      this.awaitingAuthorization = false;
      if (!authorized) {
        this.clearPending();
        return this.cleanDeferred("WRITE_AUTHORIZATION_DENIED");
      }

      // Authorization is the consent linearization point. From here until the
      // exact body-bearing send call there is deliberately no await or yield.
      this.phase = "armed";
      if (!this.prewriteProofValid || !this.markPendingSent(prepared.id)) {
        return this.armedAmbiguous("PROTOCOL_ERROR");
      }
      let writePromise: Promise<void>;
      try {
        writePromise = this.transport.send(prepared.frame);
      } catch {
        writePromise = Promise.reject(
          new OperationError("TRANSPORT_WRITE_FAILED"),
        );
      }
      void writePromise.catch(() => {
        this.rejectPending(new OperationError("TRANSPORT_WRITE_FAILED"));
      });

      let result: unknown;
      try {
        result = await responsePromise;
      } catch (error) {
        if (this.input.kind === "steer" && error instanceof RpcRejectedError) {
          return {
            phase: "armed",
            safeErrorCode: "RPC_REJECTED_NO_EFFECT",
            state: "deferred",
          };
        }
        return this.armedAmbiguous(this.errorCode(error));
      }

      if (this.input.kind === "steer") {
        if (
          !isRecord(result) ||
          Object.keys(result).length !== 1 ||
          result.turnId !== this.input.expectedTurnId
        ) {
          return this.armedAmbiguous("RESULT_SCHEMA_MISMATCH");
        }
        this.phase = "terminal";
        return {
          outcome: "delivered",
          phase: "terminal",
          replyCode: "REPLY_UNAVAILABLE",
          replyText: null,
          state: "terminal",
        };
      }

      if (!isRecord(result)) {
        return this.armedAmbiguous("RESULT_SCHEMA_MISMATCH");
      }
      const turn = parseTurn(result.turn);
      if (turn === null || turn.status !== "inProgress") {
        return this.armedAmbiguous("RESULT_SCHEMA_MISMATCH");
      }
      this.phase = "accepted";
      this.selectedTurnId = turn.id;
      for (const candidateId of [...this.candidates.keys()]) {
        if (candidateId !== turn.id) this.candidates.delete(candidateId);
      }
      const fast = this.terminalFor(turn.id);
      if (fast !== undefined) return this.terminal(fast);
      try {
        return this.terminal(await this.waitForTerminal(turn.id));
      } catch (error) {
        return this.acceptedUnconfirmed(this.errorCode(error));
      }
    } catch (error) {
      const code = this.errorCode(error);
      if (this.phase === "accepted") return this.acceptedUnconfirmed(code);
      if (this.phase === "armed") return this.armedAmbiguous(code);
      return this.cleanFailure(code);
    }
  }

  private async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: OUTPUT_NOTIFICATION_OPT_OUTS,
      },
      clientInfo: {
        name: "agent_embassy_gateway",
        title: "Embassy Gateway",
        version: "1.7.0",
      },
    });
    if (!isRecord(result)) throw new OperationError("RESULT_SCHEMA_MISMATCH");
    const initialized = JSON.stringify({ method: "initialized", params: {} });
    if (Buffer.byteLength(initialized, "utf8") > this.options.maxFrameBytes) {
      throw new OperationError("INPUT_INVALID");
    }
    try {
      await this.transport.send(initialized);
    } catch {
      throw new OperationError("TRANSPORT_WRITE_FAILED");
    }
  }

  private async resume(): Promise<ReturnType<typeof parseRouteStatus>> {
    let result: unknown;
    try {
      result = await this.request("thread/resume", {
        excludeTurns: true,
        threadId: this.input.route.threadId,
      });
    } catch (error) {
      if (error instanceof RpcRejectedError) {
        throw new OperationError("THREAD_NOT_OBSERVED");
      }
      throw error;
    }
    if (
      !isRecord(result) ||
      !isRecord(result.thread) ||
      result.thread.id !== this.input.route.threadId ||
      !Array.isArray(result.thread.turns) ||
      result.thread.turns.length !== 0
    ) {
      throw new OperationError("RESULT_SCHEMA_MISMATCH");
    }
    const status = parseRouteStatus(result.thread.status);
    if (status === null) throw new OperationError("RESULT_SCHEMA_MISMATCH");
    return status;
  }

  private prewriteDisposition(
    status: ReturnType<typeof parseRouteStatus>,
  ): InnerResult | undefined {
    if (status === "not_loaded") return this.cleanDeferred("THREAD_NOT_OBSERVED");
    if (status === "system_error") return this.cleanFailure("THREAD_NOT_OBSERVED");
    if (status === "waiting_approval") return this.cleanDeferred("APPROVAL_REQUIRED");
    if (this.input.kind === "start") {
      return status === "idle" ? undefined : this.cleanDeferred("ROUTE_BUSY");
    }
    return status === "active" ? undefined : this.cleanDeferred("ROUTE_BUSY");
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const prepared = this.prepareRequest(method, params);
    const response = this.reservePreparedRequest(prepared);
    if (!this.markPendingSent(prepared.id)) return response;
    let write: Promise<void>;
    try {
      write = this.transport.send(prepared.frame);
    } catch {
      write = Promise.reject(new OperationError("TRANSPORT_WRITE_FAILED"));
    }
    void write.catch(() => {
      this.rejectPending(new OperationError("TRANSPORT_WRITE_FAILED"));
    });
    return response;
  }

  private prepareRequest(method: string, params: JsonObject): PreparedRequest {
    if (
      method !== "initialize" &&
      method !== "thread/resume" &&
      method !== "turn/start" &&
      method !== "turn/steer"
    ) {
      throw new OperationError("PROTOCOL_ERROR");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) {
      throw new OperationError("PROTOCOL_ERROR");
    }
    const frame = JSON.stringify({ id, method, params });
    const frameBytes = Buffer.byteLength(frame, "utf8");
    if (frameBytes > this.options.maxFrameBytes) {
      throw new OperationError("INPUT_INVALID");
    }
    return { frame, frameBytes, id };
  }

  private reservePreparedRequest(prepared: PreparedRequest): Promise<unknown> {
    if (this.protocolFailure !== undefined) throw this.protocolFailure;
    if (this.pending !== undefined || this.transportLost) {
      throw new OperationError("TRANSPORT_CLOSED");
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending = { id: prepared.id, reject, resolve, sent: false };
    });
  }

  private markPendingSent(id: number): boolean {
    const pending = this.pending;
    if (pending?.id !== id || pending.sent) {
      this.protocolFault();
      return false;
    }
    pending.sent = true;
    pending.timer = setTimeout(() => {
      if (this.pending?.id !== id) return;
      this.pending = undefined;
      pending.reject(new OperationError("REQUEST_TIMEOUT"));
    }, this.options.requestTimeoutMs);
    return true;
  }

  private handlePayload(payload: string): void {
    if (Buffer.byteLength(payload, "utf8") > this.options.maxFrameBytes) {
      this.protocolFault();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.protocolFault();
      return;
    }
    if (!isRecord(parsed)) {
      this.protocolFault();
      return;
    }
    if (typeof parsed.method === "string") {
      if (parsed.id === undefined) this.handleNotification(parsed.method, parsed.params);
      else this.handleServerRequest(parsed.method, parsed.params);
      return;
    }
    if (
      typeof parsed.id !== "number" ||
      !Number.isSafeInteger(parsed.id) ||
      this.pending?.id !== parsed.id ||
      !this.pending.sent
    ) {
      this.protocolFault();
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");
    if (hasResult === hasError) {
      pending.reject(new OperationError("PROTOCOL_ERROR"));
      this.protocolFault();
      return;
    }
    if (hasError) {
      if (
        !isRecord(parsed.error) ||
        typeof parsed.error.code !== "number" ||
        !Number.isSafeInteger(parsed.error.code)
      ) {
        pending.reject(new OperationError("PROTOCOL_ERROR"));
        this.protocolFault();
        return;
      }
      pending.reject(new RpcRejectedError());
      return;
    }
    pending.resolve(parsed.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.phase === "clean") {
      this.invalidatePrewriteProof(method, params);
      return;
    }
    if (method === "turn/started") {
      if (!this.targetParams(params)) return;
      const turn = parseTurn(params.turn);
      if (turn === null || turn.status !== "inProgress") {
        this.protocolFault();
        return;
      }
      this.candidate(turn.id, true);
      return;
    }
    if (method === "item/completed") {
      this.handleCompletedItem(params);
      return;
    }
    if (method === "turn/completed") {
      if (!this.targetParams(params)) return;
      const turn = parseTurn(params.turn);
      if (
        turn === null ||
        (turn.status !== "completed" &&
          turn.status !== "failed" &&
          turn.status !== "interrupted")
      ) {
        this.protocolFault();
        return;
      }
      const candidate = this.candidate(turn.id, false);
      if (candidate === undefined || candidate.terminal !== null) return;
      candidate.terminal = turn.status;
      if (turn.id === this.selectedTurnId) {
        this.resolveTerminal(turn.id, candidate);
      }
      return;
    }
    // Settings, status, warning, output, and tool notifications are not
    // dispatch authority. They are ignored after the global frame bound.
  }

  private handleServerRequest(method: string, params: unknown): void {
    if (!APPROVAL_REQUEST_METHODS.has(method)) return;
    if (
      !isRecord(params) ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      !validOpaqueId(params.turnId)
    ) {
      this.protocolFault();
      return;
    }
    if (params.threadId !== this.input.route.threadId) return;
    if (this.awaitingAuthorization) this.prewriteProofValid = false;
    // Deliberately no JSON-RPC response. Embassy is not an approval authority.
  }

  private invalidatePrewriteProof(method: string, params: unknown): void {
    if (
      !this.awaitingAuthorization ||
      !["item/completed", "serverRequest/resolved", "thread/closed",
        "thread/status/changed", "turn/completed", "turn/started"].includes(method)
    ) return;
    if (!isRecord(params) || typeof params.threadId !== "string") {
      this.protocolFault();
      return;
    }
    if (params.threadId === this.input.route.threadId)
      this.prewriteProofValid = false;
  }

  private handleCompletedItem(params: unknown): void {
    if (!this.targetParams(params)) return;
    if (
      typeof params.turnId !== "string" ||
      !validOpaqueId(params.turnId) ||
      !isRecord(params.item) ||
      typeof params.item.type !== "string"
    ) {
      this.protocolFault();
      return;
    }
    const candidate = this.candidate(params.turnId, false);
    if (candidate === undefined || candidate.terminal !== null) return;
    if (params.item.type !== "agentMessage") return;
    if (params.item.phase !== undefined && params.item.phase !== "final_answer") {
      return;
    }
    if (
      typeof params.item.text !== "string" ||
      params.item.text.length === 0 ||
      params.item.text.includes("\0")
    ) {
      return;
    }
    if (Buffer.byteLength(params.item.text, "utf8") > this.options.maxReplyBytes) {
      candidate.replyCode = "REPLY_TOO_LARGE";
      candidate.replyText = null;
      return;
    }
    candidate.replyCode = null;
    candidate.replyText = params.item.text;
  }

  private targetParams(params: unknown): params is JsonObject {
    if (!isRecord(params) || typeof params.threadId !== "string") {
      this.protocolFault();
      return false;
    }
    return params.threadId === this.input.route.threadId;
  }

  private candidate(
    turnId: string,
    allowCreate: boolean,
  ): FastCandidate | undefined {
    const existing = this.candidates.get(turnId);
    if (existing !== undefined) return existing;
    if (
      (!allowCreate && turnId !== this.selectedTurnId) ||
      (this.selectedTurnId !== undefined && turnId !== this.selectedTurnId)
    ) {
      return undefined;
    }
    if (this.candidates.size >= MAX_FAST_TERMINAL_CANDIDATES) {
      this.protocolFault();
      return undefined;
    }
    const candidate: FastCandidate = {
      replyCode: "REPLY_UNAVAILABLE",
      replyText: null,
      terminal: null,
    };
    this.candidates.set(turnId, candidate);
    return candidate;
  }

  private terminalFor(turnId: string): TerminalResult | undefined {
    const candidate = this.candidates.get(turnId);
    if (candidate?.terminal === null || candidate === undefined) return undefined;
    return {
      outcome: candidate.terminal,
      replyCode:
        candidate.terminal === "completed"
          ? candidate.replyCode
          : "REPLY_UNAVAILABLE",
      replyText:
        candidate.terminal === "completed" ? candidate.replyText : null,
    };
  }

  private waitForTerminal(turnId: string): Promise<TerminalResult> {
    if (this.protocolFailure !== undefined) {
      return Promise.reject(this.protocolFailure);
    }
    if (this.transportLost) {
      return Promise.reject(new OperationError("TRANSPORT_CLOSED"));
    }
    const remaining = Math.min(
      this.options.turnTimeoutMs,
      this.deadlineAtMs - this.options.now().getTime(),
    );
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.reject(new OperationError("REQUEST_TIMEOUT"));
    }
    return new Promise<TerminalResult>((resolve, reject) => {
      this.terminalResolve = resolve;
      this.terminalReject = reject;
      this.terminalTimer = setTimeout(() => {
        this.clearTerminalWait();
        reject(new OperationError("REQUEST_TIMEOUT"));
      }, remaining);
      const terminal = this.terminalFor(turnId);
      if (terminal !== undefined) {
        this.clearTerminalWait();
        resolve(terminal);
      }
    });
  }

  private resolveTerminal(turnId: string, candidate: FastCandidate): void {
    if (turnId !== this.selectedTurnId || candidate.terminal === null) return;
    const terminal = this.terminalFor(turnId);
    if (terminal === undefined || this.terminalResolve === undefined) return;
    const resolve = this.terminalResolve;
    this.clearTerminalWait();
    resolve(terminal);
  }

  private protocolFault(): void {
    if (this.protocolFailure !== undefined) return;
    this.protocolFailure = new OperationError("PROTOCOL_ERROR");
    this.rejectPending(this.protocolFailure);
    const reject = this.terminalReject;
    this.clearTerminalWait();
    reject?.(this.protocolFailure);
  }

  private handleTransportLoss(): void {
    if (this.transportLost) return;
    this.transportLost = true;
    const error = new OperationError("TRANSPORT_CLOSED");
    this.rejectPending(error);
    const reject = this.terminalReject;
    this.clearTerminalWait();
    reject?.(error);
  }

  private rejectPending(error: OperationError): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private clearPending(): void {
    if (this.pending === undefined) return;
    clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  private clearTerminalWait(): void {
    if (this.terminalTimer !== undefined) clearTimeout(this.terminalTimer);
    this.terminalTimer = undefined;
    this.terminalResolve = undefined;
    this.terminalReject = undefined;
  }

  private expired(): boolean {
    const nowMs = this.options.now().getTime();
    return !Number.isFinite(nowMs) || nowMs >= this.deadlineAtMs;
  }

  private errorCode(error: unknown): StatelessCodexSafeErrorCode {
    if (error instanceof OperationError) return error.code;
    if (error instanceof LocalCodexTransportError) return error.code;
    return "PROTOCOL_ERROR";
  }

  private cleanDeferred(code: StatelessCodexSafeErrorCode): InnerResult {
    return { phase: "clean", safeErrorCode: code, state: "deferred" };
  }

  private cleanFailure(code: StatelessCodexSafeErrorCode): InnerResult {
    return { phase: "clean", safeErrorCode: code, state: "failed" };
  }

  private armedAmbiguous(code: StatelessCodexSafeErrorCode): InnerResult {
    return { phase: "armed", safeErrorCode: code, state: "ambiguous" };
  }

  private acceptedUnconfirmed(code: StatelessCodexSafeErrorCode): InnerResult {
    return { phase: "accepted", safeErrorCode: code, state: "unconfirmed" };
  }

  private terminal(result: TerminalResult): InnerResult {
    this.phase = "terminal";
    return { ...result, phase: "terminal", state: "terminal" };
  }
}

function normalizeOuterError(error: unknown): StatelessCodexSafeErrorCode {
  if (error instanceof OperationError) return error.code;
  if (error instanceof LocalCodexTransportError) return error.code;
  return "PROTOCOL_ERROR";
}

/**
 * Construct an inert stateless Codex operation runner. Construction performs
 * no provider I/O. Every execute independently re-attests the current managed
 * installation, owns one proxy/connection, and closes it before returning.
 */
export function createStatelessCodexOperationTransport(
  options: StatelessCodexOperationTransportOptions = {},
  dependencies: StatelessCodexOperationTransportDependencies = {},
): StatelessCodexOperationTransport {
  const normalized = normalizeOptions(options);
  return {
    async execute(input): Promise<StatelessCodexOperationResult> {
      let factory: LocalCodexTransportFactory | undefined;
      let owned: LocalCodexOwnedTransport | undefined;
      let session: OperationSession | undefined;
      let result: InnerResult;
      let setupCleanupFailed = false;
      try {
        const validated = validateInput(input, normalized);
        const factoryOptions = {
          ...normalized.local,
          hostId: input.route.hostId,
        };
        factory = await (dependencies.createFactory?.(factoryOptions) ??
          createLocalCodexTransportFactory(
            factoryOptions,
            dependencies.localDependencies ?? {},
          ));
        owned = await factory.connectTransport();
        session = new OperationSession(
          owned,
          input,
          normalized,
          validated.deadlineAtMs,
          validated.bodyBytes,
        );
        result = await session.execute();
      } catch (error) {
        setupCleanupFailed =
          error instanceof LocalCodexTransportError &&
          error.code === "CLEANUP_FAILED";
        result = {
          phase: "clean",
          safeErrorCode: normalizeOuterError(error),
          state: "failed",
        };
      }

      session?.dispose();
      let cleanupConfirmed = owned === undefined && !setupCleanupFailed;
      if (owned !== undefined) {
        try {
          await owned.close();
        } catch {
          // Cleanup truth is returned separately and never overwrites delivery.
        }
        cleanupConfirmed = owned.cleanupConfirmed;
      }
      if (factory !== undefined) {
        try {
          await factory.close();
        } catch {
          cleanupConfirmed = false;
        }
      }
      return { ...result, attemptId: input.attemptId, cleanupConfirmed };
    },
  };
}
