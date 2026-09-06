import { BridgeError } from "../errors.js";
import type { Destination, WakeInput, WakeResult } from "./coordinator.js";
import type { Endpoint } from "./ledger.js";
import type {
  ClaudePeerAdapter,
  ClaudePeerDiscovery,
  ClaudePeerPreparedSend,
} from "./claude-peer.js";
import type {
  StatelessCodexAcceptedOperation,
  StatelessCodexActiveSteerResult,
  StatelessCodexOperationResult,
  StatelessCodexOperationTransport,
  StatelessCodexSafeErrorCode,
} from "./codex-stateless-transport.js";

type ClaudePeerPort = Pick<
  ClaudePeerAdapter,
  "discover" | "assertTargetWorkspaceDisjoint" | "prepareSend" | "close"
>;

const CLAUDE_CLEAN_RETRY_CODES = new Set([
  "CLAUDE_PEER_TARGET_UNKNOWN",
  "CLAUDE_PEER_WORKSPACE_UNATTESTED",
]);

const CODEX_CLEAN_RETRY_CODES = new Set<StatelessCodexSafeErrorCode>([
  "THREAD_NOT_OBSERVED",
  "ROUTE_BUSY",
  "APPROVAL_REQUIRED",
  "MANAGED_CODEX_UNAVAILABLE",
  "LOCAL_APP_SERVER_NOT_RUNNING",
  "ENDPOINT_GENERATION_CHANGED",
  "SPAWN_FAILED",
  "SPAWN_TIMEOUT",
  "TRANSPORT_CONNECT_FAILED",
  "REQUEST_TIMEOUT",
]);

function systemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

function claudePrewrite(error: unknown): WakeResult {
  if (error instanceof BridgeError && error.code === "CLAUDE_PEER_MESSAGE_EXPIRED") {
    return { outcome: "expired", code: "MESSAGE_EXPIRED", unwritten: true };
  }
  if (error instanceof BridgeError && CLAUDE_CLEAN_RETRY_CODES.has(error.code)) {
    return { outcome: "deferred", code: "ROUTE_BUSY" };
  }
  const code = systemCode(error);
  return {
    outcome: "failed",
    code: error instanceof BridgeError ? error.code
      : code === "ENOENT" ? "CLAUDE_DISPATCH_PREWRITE_PATH_MISSING"
        : code === "EACCES" || code === "EPERM" ? "CLAUDE_DISPATCH_PREWRITE_ACCESS_DENIED"
          : code === "ETIMEDOUT" ? "CLAUDE_DISPATCH_PREWRITE_TIMEOUT"
            : "CLAUDE_DISPATCH_PREWRITE_FAILED",
  };
}

function claudePostAuthorization(error: unknown): WakeResult {
  if (error instanceof BridgeError && error.code === "WRITE_AUTHORIZATION_DENIED") {
    return { outcome: "deferred", code: error.code };
  }
  if (error instanceof BridgeError && error.recoverable) {
    if (error.code === "CLAUDE_PEER_MESSAGE_EXPIRED") return { outcome: "expired", code: "MESSAGE_EXPIRED", unwritten: true };
    return {
      outcome: "failed",
      code: error.code === "CLAUDE_PEER_MESSAGE_EXPIRED" ? "MESSAGE_EXPIRED" : error.code,
    };
  }
  return {
    outcome: "ambiguous",
    code: error instanceof BridgeError && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
      ? error.code : "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS",
  };
}

function localClaudeName(target: Endpoint, host: string): string | undefined {
  if (target.provider !== "claude" || target.host !== host) return undefined;
  const suffix = `@${host}`;
  if (!target.alias.endsWith(suffix)) return undefined;
  const name = target.alias.slice(0, -suffix.length);
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : undefined;
}

export class ClaudeDestination implements Destination {
  private readonly inFlight = new Set<Promise<WakeResult>>();
  private closing = false;

  constructor(private readonly options: Readonly<{
    host: string;
    stateRoot: string;
    peer: ClaudePeerPort;
  }>) {}

  async deliver(input: WakeInput): Promise<WakeResult> {
    if (this.closing) return { outcome: "failed", code: "CLAUDE_ROUTE_UNAVAILABLE" };
    const delivery = this.deliverOnce(input);
    this.inFlight.add(delivery);
    try {
      return await delivery;
    } finally {
      this.inFlight.delete(delivery);
    }
  }

  private async deliverOnce(input: WakeInput): Promise<WakeResult> {
    const name = localClaudeName(input.target, this.options.host);
    if (name === undefined) return { outcome: "failed", code: "CLAUDE_ROUTE_UNAVAILABLE" };
    let discovery: ClaudePeerDiscovery;
    let prepared: ClaudePeerPreparedSend;
    try {
      discovery = await this.options.peer.discover();
      const exact = discovery.peers.find((candidate) =>
        candidate.targetId === input.target.handle && candidate.alias === name &&
        (candidate.kind === "interactive" || candidate.kind === "bg"));
      if (exact === undefined) {
        throw new BridgeError(
          "CLAUDE_PEER_TARGET_UNKNOWN",
          "The exact Claude peer target is no longer discoverable.",
          true,
        );
      }
      await this.options.peer.assertTargetWorkspaceDisjoint(
        input.target.handle,
        this.options.stateRoot,
      );
      prepared = await this.options.peer.prepareSend(input.target.handle, input.text, {
        deadlineAt: input.deadline,
      });
    } catch (error) {
      return claudePrewrite(error);
    }

    try {
      // Final attestation, authorization, and the exact prepared write share
      // one continuation; retirement during preparation cannot leak a write.
      const operation = prepared.perform(async () => await input.authorize({
        bytes: prepared.frameBytes,
        sha256: prepared.sha256,
      }));
      await operation;
      return { outcome: "delivered", code: "DELIVERED" };
    } catch (error) {
      return claudePostAuthorization(error);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.options.peer.close();
    await Promise.allSettled([...this.inFlight]);
  }
}

function mapCodexClean(
  result:
    | Extract<StatelessCodexOperationResult, { phase: "clean" }>
    | Extract<StatelessCodexActiveSteerResult, { phase: "clean" }>,
): WakeResult {
  if (result.safeErrorCode === "MESSAGE_EXPIRED") {
    return { outcome: "expired", code: "MESSAGE_EXPIRED", unwritten: true };
  }
  return CODEX_CLEAN_RETRY_CODES.has(result.safeErrorCode)
    ? { outcome: "deferred", code: result.safeErrorCode }
    : { outcome: "failed", code: result.safeErrorCode };
}

function mapCodexStart(result: StatelessCodexOperationResult): WakeResult {
  if (result.phase === "clean") return mapCodexClean(result);
  if (result.phase === "armed") return { outcome: "ambiguous", code: result.safeErrorCode };
  if (result.phase === "accepted") return { outcome: "unconfirmed", code: result.safeErrorCode };
  if (result.outcome === "failed") return { outcome: "failed", code: "CODEX_TURN_FAILED" };
  if (result.outcome === "interrupted") {
    return { outcome: "cancelled", code: "CODEX_TURN_INTERRUPTED" };
  }
  return { outcome: "delivered", code: "DELIVERED" };
}

function mapCodexSteer(result: StatelessCodexActiveSteerResult): WakeResult {
  if (result.phase === "clean") return mapCodexClean(result);
  if (result.phase === "armed") return { outcome: "ambiguous", code: result.safeErrorCode };
  return { outcome: "delivered", code: "DELIVERED" };
}

type ActiveCodexTurn = Readonly<{
  attempt: string;
  target: Endpoint;
  operation: StatelessCodexAcceptedOperation;
}>;

type StartingCodexTurn = Readonly<{
  attempt: string;
  target: Endpoint;
}>;

export class CodexDestination implements Destination {
  private readonly active = new Map<string, ActiveCodexTurn>();
  private readonly starting = new Map<string, StartingCodexTurn>();
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<Promise<WakeResult>>();
  private closing = false;

  constructor(private readonly options: Readonly<{
    host: string;
    operation: StatelessCodexOperationTransport;
  }>) {}

  async deliver(input: WakeInput): Promise<WakeResult> {
    if (
      this.closing || input.target.provider !== "codex" ||
      input.target.host !== this.options.host
    ) {
      return { outcome: "failed", code: "CODEX_ROUTE_UNAVAILABLE" };
    }
    const delivery = input.steer ? this.deliverSteer(input) : this.deliverStart(input);
    this.inFlight.add(delivery);
    try {
      return await delivery;
    } finally {
      this.inFlight.delete(delivery);
    }
  }

  private async deliverSteer(input: WakeInput): Promise<WakeResult> {
    const active = this.active.get(input.target.id);
    if (active === undefined) return await this.deliverStart(input);
    if (
      active.target.host !== input.target.host ||
      active.target.handle !== input.target.handle || active.target.alias !== input.target.alias
    ) {
      return { outcome: "deferred", code: "ROUTE_BUSY" };
    }
    const result = await active.operation.steer({
      attemptId: input.attempt,
      deadlineAt: new Date(input.deadline).toISOString(),
      text: input.text,
      authorizeWrite: async (evidence) => await input.authorize({
        bytes: evidence.frameBytes,
        sha256: evidence.sha256,
      }),
    });
    return mapCodexSteer(result);
  }

  private async deliverStart(input: WakeInput): Promise<WakeResult> {
    if (this.active.has(input.target.id) || this.starting.has(input.target.id)) {
      return { outcome: "deferred", code: "ROUTE_BUSY" };
    }
    const starting: StartingCodexTurn = {
      attempt: input.attempt,
      target: { ...input.target },
    };
    this.starting.set(input.target.id, starting);
    const controller = new AbortController();
    this.controllers.add(controller);
    let accepted: StatelessCodexAcceptedOperation | undefined;
    try {
      const result = await this.options.operation.execute({
        attemptId: input.attempt,
        authorizeWrite: async (evidence) => await input.authorize({
          bytes: evidence.frameBytes,
          sha256: evidence.sha256,
        }),
        deadlineAt: new Date(input.deadline).toISOString(),
        kind: "start",
        signal: controller.signal,
        route: {
          alias: input.target.alias,
          hostId: input.target.host,
          registrationId: input.target.id,
          threadId: input.target.handle,
        },
        text: input.text,
        onAccepted: async (operation) => {
          if (
            this.closing || operation.attemptId !== input.attempt ||
            this.active.has(input.target.id)
          ) {
            throw new BridgeError(
              "ACCEPTANCE_UNCONFIRMED",
              "The exact Codex attempt cannot acquire its active-turn slot.",
            );
          }
          await input.accepted("unconfirmed");
          accepted = operation;
          this.active.set(input.target.id, {
            attempt: input.attempt,
            target: { ...input.target },
            operation,
          });
        },
      });
      return mapCodexStart(result);
    } finally {
      this.controllers.delete(controller);
      if (this.starting.get(input.target.id) === starting) {
        this.starting.delete(input.target.id);
      }
      if (accepted !== undefined && this.active.get(input.target.id)?.attempt === input.attempt) {
        this.active.delete(input.target.id);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.inFlight]);
    this.controllers.clear();
    this.starting.clear();
    this.active.clear();
  }
}
