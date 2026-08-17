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
const SETUP_ABORTED = Symbol("setup-aborted");
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
  alias: string; hostId: string; registrationId: string; threadId: string;
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

export type StatelessCodexActiveSteerInput = Readonly<{
  attemptId: string; deadlineAt: string; text: string;
  authorizeWrite: (evidence: StatelessCodexWriteEvidence) => Promise<boolean>;
}>;

type ActiveSteerResultCommon = Readonly<{ attemptId: string }>;

export type StatelessCodexActiveSteerResult =
  | (ActiveSteerResultCommon & Readonly<{
      phase: "clean"; state: "deferred" | "failed";
      safeErrorCode: StatelessCodexSafeErrorCode;
    }>)
  | (ActiveSteerResultCommon & Readonly<{
      phase: "armed"; state: "ambiguous";
      safeErrorCode: StatelessCodexSafeErrorCode;
    }>)
  | (ActiveSteerResultCommon & Readonly<{
      phase: "terminal"; state: "terminal"; outcome: "delivered";
      replyCode: "REPLY_UNAVAILABLE"; replyText: null;
    }>);

export type StatelessCodexAcceptedOperation = Readonly<{
  attemptId: string;
  /** Ephemeral exact App Server evidence. Never persist or log this ID. */
  turnId: string;
  steer: (input: StatelessCodexActiveSteerInput) => Promise<StatelessCodexActiveSteerResult>;
}>;

export type StatelessCodexOperationInput = StatelessCodexOperationCommon &
  Readonly<{
    kind: "start";
    onAccepted: (accepted: StatelessCodexAcceptedOperation) => Promise<void>;
    /** Exact-operation lifecycle only; never sends an App Server interrupt. */
    signal?: AbortSignal;
  }>;

export type StatelessCodexSafeErrorCode =
  | LocalCodexTransportErrorCode
  | "ACCEPTANCE_UNCONFIRMED"
  | "APPROVAL_REQUIRED"
  | "INPUT_INVALID"
  | "MESSAGE_EXPIRED"
  | "PROTOCOL_ERROR"
  | "REQUEST_TIMEOUT"
  | "RESULT_SCHEMA_MISMATCH"
  | "ROUTE_BUSY"
  | "RPC_REJECTED"
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
        phase: "accepted"; state: "unconfirmed";
        safeErrorCode: StatelessCodexSafeErrorCode;
      }>)
  | (ResultCommon &
      Readonly<{
        phase: "terminal"; state: "terminal";
        outcome: "delivered" | TurnOutcome; replyCode: ReplyCode;
        replyText: string | null;
      }>);

export type StatelessCodexObservation = Readonly<{
  state: "idle" | "busy" | "awaiting_approval" | "unobserved";
  safeErrorCode?: "CODEX_OBSERVER_PROTOCOL_ERROR" | "CODEX_OBSERVER_UNAVAILABLE" | "THREAD_NOT_OBSERVED";
}>;

export type StatelessCodexOperationTransport = Readonly<{
  execute: (input: StatelessCodexOperationInput) => Promise<StatelessCodexOperationResult>;
  /** Independent display evidence. It never prepares or performs a semantic write. */
  observe: (route: StatelessCodexRoute, signal?: AbortSignal) => Promise<StatelessCodexObservation>;
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

type AcceptedOperationKey = Readonly<{
  attemptId: string; registrationId: string; threadId: string; turnId: string;
}>;

type SetupResource = Readonly<{ close: () => Promise<void> }>;

type WithoutResultCommon<T> = T extends unknown ? Omit<T, keyof ResultCommon> : never;
type InnerResult = WithoutResultCommon<StatelessCodexOperationResult>;
type ActiveSteerInner = StatelessCodexActiveSteerResult extends infer Result
  ? Result extends unknown ? Omit<Result, "attemptId"> : never
  : never;

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

async function awaitSetupResource<T extends SetupResource>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof SETUP_ABORTED> {
  if (signal === undefined) return await pending;
  if (signal.aborted) {
    void pending.then((resource) => resource.close()).catch(() => undefined);
    return SETUP_ABORTED;
  }
  let observeAbort!: () => void;
  const aborted = new Promise<typeof SETUP_ABORTED>((resolve) => {
    observeAbort = () => resolve(SETUP_ABORTED);
    signal.addEventListener("abort", observeAbort, { once: true });
  });
  try {
    const settled = await Promise.race([pending, aborted]);
    if (settled === SETUP_ABORTED) {
      void pending.then((resource) => resource.close()).catch(() => undefined);
    }
    return settled;
  } finally {
    signal.removeEventListener("abort", observeAbort);
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
    !validHost(input.route.hostId) ||
    !validAlias(input.route.alias, input.route.hostId) ||
    !validOpaqueId(input.route.threadId) ||
    !validOpaqueId(input.route.registrationId, 128) ||
    typeof input.onAccepted !== "function"
  ) {
    throw new OperationError("INPUT_INVALID");
  }
  return validateMessageInput(input, options);
}

function validateMessageInput(
  input: StatelessCodexActiveSteerInput | StatelessCodexOperationInput,
  options: NormalizedOptions,
): { bodyBytes: number; deadlineAtMs: number } {
  if (
    !validOpaqueId(input.attemptId, 128) ||
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
  private acceptedKey: AcceptedOperationKey | undefined;
  private sideChannelEvidenceValid = false;
  private acceptanceDurable = false;
  private activeSteerInFlight = false;
  private activeSteerCalls = 0;
  private readonly activeSteerAttemptIds = new Set<string>();
  private awaitingAuthorization = false;
  private prewriteProofValid = false;
  private readonly candidates = new Map<string, FastCandidate>();
  private terminalReject: ((error: OperationError) => void) | undefined;
  private terminalResolve: ((result: TerminalResult) => void) | undefined;
  private terminalTimer: NodeJS.Timeout | undefined;
  private transportLost = false;
  private aborted = false;
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
    this.sideChannelEvidenceValid = false;
    for (const remove of this.unlisten.splice(0)) remove();
    this.rejectPending(new OperationError("TRANSPORT_CLOSED"));
    this.clearTerminalWait();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.sideChannelEvidenceValid = false;
    if (this.awaitingAuthorization) this.prewriteProofValid = false;
    const error = new OperationError("TRANSPORT_CLOSED");
    this.rejectPending(error);
    const reject = this.terminalReject;
    this.clearTerminalWait();
    reject?.(error);
  }

  async execute(): Promise<InnerResult> {
    try {
      if (this.aborted) return this.cleanFailure("TRANSPORT_CLOSED");
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

      const prepared = this.prepareRequest("turn/start", {
        input: [{ text: this.input.text, type: "text" }],
        threadId: this.input.route.threadId,
      });
      const responsePromise = this.reservePreparedRequest(prepared);
      void responsePromise.catch(() => undefined);
      const evidence: StatelessCodexWriteEvidence = {
        attemptId: this.input.attemptId,
        bodyBytes: this.bodyBytes,
        frameBytes: prepared.frameBytes,
        kind: "codex_turn_start",
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
        if (this.aborted) return this.cleanFailure("TRANSPORT_CLOSED");
        return this.cleanDeferred("WRITE_AUTHORIZATION_DENIED");
      }

      // Authorization is the consent linearization point. From here until the
      // exact body-bearing send call there is deliberately no await or yield.
      this.phase = "armed";
      if (!this.prewriteProofValid || !this.markPendingSent(prepared.id)) {
        return this.armedAmbiguous(
          this.aborted ? "TRANSPORT_CLOSED" : "PROTOCOL_ERROR",
        );
      }
      // This monotonic latch begins before the semantic write and is never
      // restored from a later response. Synchronous post-response drift is
      // therefore preserved across the Promise continuation.
      this.sideChannelEvidenceValid = true;
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
        return this.armedAmbiguous(this.errorCode(error));
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
      const acceptedKey: AcceptedOperationKey = Object.freeze({
        attemptId: this.input.attemptId,
        registrationId: this.input.route.registrationId,
        threadId: this.input.route.threadId,
        turnId: turn.id,
      });
      this.acceptedKey = acceptedKey;
      for (const candidateId of [...this.candidates.keys()]) {
        if (candidateId !== turn.id) this.candidates.delete(candidateId);
      }
      try {
        await this.input.onAccepted({
          attemptId: this.input.attemptId,
          turnId: turn.id,
          steer: (input) => this.steerAcceptedOperation(acceptedKey, input),
        });
      } catch {
        this.sideChannelEvidenceValid = false;
        return this.acceptedUnconfirmed("ACCEPTANCE_UNCONFIRMED");
      }
      this.acceptanceDurable = true;
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

  async observe(): Promise<StatelessCodexObservation> {
    try {
      await this.initialize();
      const status = await this.resume();
      if (status === "idle") return { state: "idle" };
      if (status === "waiting_approval") return { state: "awaiting_approval" };
      if (status === "active") return { state: "busy" };
      return {
        state: "unobserved",
        safeErrorCode: status === "not_loaded"
          ? "THREAD_NOT_OBSERVED"
          : "CODEX_OBSERVER_PROTOCOL_ERROR",
      };
    } catch (error) {
      return {
        state: "unobserved",
        safeErrorCode:
          error instanceof OperationError && error.code === "THREAD_NOT_OBSERVED"
            ? "THREAD_NOT_OBSERVED"
            : "CODEX_OBSERVER_UNAVAILABLE",
      };
    }
  }

  private async steerAcceptedOperation(
    key: AcceptedOperationKey,
    input: StatelessCodexActiveSteerInput,
  ): Promise<StatelessCodexActiveSteerResult> {
    let phase: "armed" | "clean" = "clean";
    let ownsSteerSlot = false;
    let result: ActiveSteerInner | undefined;
    try {
      const validated = validateMessageInput(input, this.options);
      if (!this.acceptedOperationMatches(key)) {
        result = { phase: "clean", safeErrorCode: "ROUTE_BUSY", state: "deferred" };
      } else if (
        input.attemptId === key.attemptId ||
        this.activeSteerAttemptIds.has(input.attemptId)
      ) {
        result = { phase: "clean", safeErrorCode: "INPUT_INVALID", state: "failed" };
      } else if (this.activeSteerInFlight || this.activeSteerCalls >= 3) {
        result = { phase: "clean", safeErrorCode: "ROUTE_BUSY", state: "deferred" };
      } else {
        this.activeSteerCalls += 1;
        this.activeSteerAttemptIds.add(input.attemptId);
        this.activeSteerInFlight = true;
        ownsSteerSlot = true;
        const prepared = this.prepareRequest("turn/steer", {
          expectedTurnId: key.turnId,
          input: [{ text: input.text, type: "text" }],
          threadId: key.threadId,
        });
        const responsePromise = this.reservePreparedRequest(prepared);
        void responsePromise.catch(() => undefined);
        const evidence: StatelessCodexWriteEvidence = {
          attemptId: input.attemptId,
          bodyBytes: validated.bodyBytes,
          frameBytes: prepared.frameBytes,
          kind: "codex_turn_steer",
          sha256: createHash("sha256").update(prepared.frame).digest("hex"),
        };
        let authorized: boolean;
        try {
          authorized = await input.authorizeWrite(evidence);
        } catch {
          this.clearPending();
          phase = "armed";
          authorized = false;
          result = {
            phase: "armed",
            safeErrorCode: "WRITE_AUTHORIZATION_UNCERTAIN",
            state: "ambiguous",
          };
        }
        if (result === undefined) {
          if (!authorized) {
            this.clearPending();
            result = {
              phase: "clean",
              safeErrorCode: this.aborted
                ? "TRANSPORT_CLOSED"
                : "WRITE_AUTHORIZATION_DENIED",
              state: this.aborted ? "failed" : "deferred",
            };
          } else {
            phase = "armed";
            if (
              !this.acceptedOperationMatches(key) ||
              this.messageExpired(validated.deadlineAtMs) ||
              !this.markPendingSent(prepared.id)
            ) {
              this.clearPending();
              result = {
                phase: "armed",
                safeErrorCode: this.aborted
                  ? "TRANSPORT_CLOSED"
                  : "PROTOCOL_ERROR",
                state: "ambiguous",
              };
            } else {
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
              try {
                const response = await responsePromise;
                if (
                  !isRecord(response) ||
                  Object.keys(response).length !== 1 ||
                  response.turnId !== key.turnId
                ) {
                  throw new OperationError("RESULT_SCHEMA_MISMATCH");
                }
                result = {
                  outcome: "delivered",
                  phase: "terminal",
                  replyCode: "REPLY_UNAVAILABLE",
                  replyText: null,
                  state: "terminal",
                };
              } catch (error) {
                result = {
                  phase: "armed",
                  safeErrorCode: this.errorCode(error),
                  state: "ambiguous",
                };
              }
            }
          }
        }
      }
    } catch (error) {
      result = phase === "armed"
        ? { phase, safeErrorCode: this.errorCode(error), state: "ambiguous" }
        : { phase, safeErrorCode: this.errorCode(error), state: "failed" };
    } finally {
      if (ownsSteerSlot) this.activeSteerInFlight = false;
    }
    return { ...result!, attemptId: input.attemptId };
  }

  private acceptedOperationMatches(key: AcceptedOperationKey): boolean {
    return (
      this.sideChannelEvidenceValid &&
      this.acceptanceDurable &&
      this.acceptedKey === key &&
      this.phase === "accepted" &&
      this.selectedTurnId === key.turnId &&
      this.input.route.registrationId === key.registrationId &&
      this.input.attemptId === key.attemptId
    );
  }

  private messageExpired(deadlineAtMs: number): boolean {
    const nowMs = this.options.now().getTime();
    return !Number.isFinite(nowMs) || nowMs >= deadlineAtMs;
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
    return status === "idle" ? undefined : this.cleanDeferred("ROUTE_BUSY");
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
    if (this.pending !== undefined || this.transportLost || this.aborted) {
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
      this.sideChannelEvidenceValid = false;
      if (turn.id === this.selectedTurnId) {
        this.resolveTerminal(turn.id, candidate);
      }
      return;
    }
    if (method === "thread/closed") {
      if (this.targetParams(params)) this.protocolFault();
      return;
    }
    if (method === "thread/status/changed" && this.targetParams(params)) {
      if (parseRouteStatus(params.status) !== "active") {
        this.sideChannelEvidenceValid = false;
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
    this.sideChannelEvidenceValid = false;
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
    if (this.aborted) {
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
    this.sideChannelEvidenceValid = false;
    this.rejectPending(this.protocolFailure);
    const reject = this.terminalReject;
    this.clearTerminalWait();
    reject?.(this.protocolFailure);
  }

  private handleTransportLoss(): void {
    if (this.transportLost) return;
    this.transportLost = true;
    this.sideChannelEvidenceValid = false;
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
    this.sideChannelEvidenceValid = false;
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
      let lateCleanupUnconfirmed = false;
      let abortClose: Promise<void> | undefined;
      let removeAbortListener: (() => void) | undefined;
      try {
        const validated = validateInput(input, normalized);
        const signal = input.signal;
        if (signal?.aborted) {
          throw new OperationError("TRANSPORT_CLOSED");
        }
        const factoryOptions = {
          ...normalized.local,
          hostId: input.route.hostId,
        };
        const factoryPending = dependencies.createFactory?.(factoryOptions) ??
          createLocalCodexTransportFactory(
            factoryOptions,
            dependencies.localDependencies ?? {},
          );
        const created = await awaitSetupResource(factoryPending, signal);
        if (created === SETUP_ABORTED) {
          lateCleanupUnconfirmed = true;
          throw new OperationError("TRANSPORT_CLOSED");
        }
        factory = created;
        if (signal?.aborted) throw new OperationError("TRANSPORT_CLOSED");
        const connected = await awaitSetupResource(
          factory.connectTransport(),
          signal,
        );
        if (connected === SETUP_ABORTED) {
          lateCleanupUnconfirmed = true;
          throw new OperationError("TRANSPORT_CLOSED");
        }
        owned = connected;
        if (signal?.aborted) throw new OperationError("TRANSPORT_CLOSED");
        session = new OperationSession(
          owned,
          input,
          normalized,
          validated.deadlineAtMs,
          validated.bodyBytes,
        );
        if (signal !== undefined) {
          const abort = () => {
            session?.abort();
            if (abortClose === undefined && owned !== undefined) {
              try {
                abortClose = owned.close();
              } catch (error) {
                abortClose = Promise.reject(error);
              }
              void abortClose.catch(() => undefined);
            }
          };
          if (signal.aborted) abort();
          else {
            signal.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", abort);
          }
        }
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

      removeAbortListener?.();
      session?.dispose();
      let cleanupConfirmed =
        owned === undefined && !setupCleanupFailed && !lateCleanupUnconfirmed;
      if (owned !== undefined) {
        try {
          await (abortClose ?? owned.close());
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
    async observe(route, signal): Promise<StatelessCodexObservation> {
      let factory: LocalCodexTransportFactory | undefined;
      let owned: LocalCodexOwnedTransport | undefined;
      let session: OperationSession | undefined;
      try {
        if (
          !validHost(route.hostId) ||
          !validAlias(route.alias, route.hostId) ||
          !validOpaqueId(route.threadId) ||
          !validOpaqueId(route.registrationId, 128) ||
          signal?.aborted
        ) {
          return { state: "unobserved", safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE" };
        }
        const factoryOptions = { ...normalized.local, hostId: route.hostId };
        const created = await awaitSetupResource(
          dependencies.createFactory?.(factoryOptions) ??
            createLocalCodexTransportFactory(
              factoryOptions,
              dependencies.localDependencies ?? {},
            ),
          signal,
        );
        if (created === SETUP_ABORTED) {
          return { state: "unobserved", safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE" };
        }
        factory = created;
        const connected = await awaitSetupResource(factory.connectTransport(), signal);
        if (connected === SETUP_ABORTED) {
          return { state: "unobserved", safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE" };
        }
        owned = connected;
        const input: StatelessCodexOperationInput = {
          attemptId: "observer",
          authorizeWrite: async () => false,
          deadlineAt: new Date(normalized.now().getTime() + normalized.requestTimeoutMs).toISOString(),
          kind: "start",
          onAccepted: async () => undefined,
          route,
          text: "observer",
          ...(signal === undefined ? {} : { signal }),
        };
        session = new OperationSession(owned, input, normalized, Infinity, 0);
        if (signal !== undefined) {
          const abort = () => session?.abort();
          signal.addEventListener("abort", abort, { once: true });
          try {
            return await session.observe();
          } finally {
            signal.removeEventListener("abort", abort);
          }
        }
        return await session.observe();
      } catch {
        return { state: "unobserved", safeErrorCode: "CODEX_OBSERVER_UNAVAILABLE" };
      } finally {
        session?.dispose();
        try { await owned?.close(); } catch { /* display evidence only */ }
        try { await factory?.close(); } catch { /* display evidence only */ }
      }
    },
  };
}
