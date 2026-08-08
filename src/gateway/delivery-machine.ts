/**
 * Pure delivery lifecycle for one accepted Embassy message.
 *
 * This module deliberately owns no timers, I/O, message bodies, provider
 * handles, or reply correlation. Callers feed it observed events and execute
 * the returned effects. That keeps the terminal decision independently
 * testable while the service remains responsible for serialization.
 * Event timestamps are trusted, normalized controller inputs; untrusted wire
 * values must be validated before they reach this reducer.
 */

export const deliveryPhases = [
  "queued",
  "dispatching",
  "transport_written",
  "awaiting_terminal",
  "terminal",
] as const;

export type DeliveryPhase = (typeof deliveryPhases)[number];

export const deliveryTerminalOutcomes = [
  "delivered",
  "unconfirmed",
  "expired",
  "failed",
  "ambiguous",
  "cancelled",
] as const;

export type DeliveryTerminalOutcome =
  (typeof deliveryTerminalOutcomes)[number];

export type DeliveryStallState = "pending" | "emitted";
export type DeliveryApprovalProgress = "none" | "held";
export type DeliveryWriteEvidence =
  | "none"
  | "transport_uncertain"
  | "transport_written";

export type NativeReceiptNotification =
  | { status: "delivered" }
  | { status: "expired"; diagnosticCode: string };

export type NativeReceiptMachine =
  | { phase: "absent" }
  | { phase: "open"; maxCleanPrewriteRetries: number }
  | {
      phase: "sending";
      notification: NativeReceiptNotification;
      attempt: number;
      maxCleanPrewriteRetries: number;
    }
  | {
      phase: "retry_wait";
      notification: NativeReceiptNotification;
      attempt: number;
      retryAt: number;
      maxCleanPrewriteRetries: number;
    }
  | {
      phase: "confirmed";
      notification: NativeReceiptNotification;
      attempts: number;
    }
  | {
      phase: "write_unconfirmed";
      notification: NativeReceiptNotification;
      attempts: number;
      reason: "ambiguous_write" | "clean_prewrite_retries_exhausted";
    };

type DeliveryCommonState = Readonly<{
  enqueuedAt: number;
  stallAt: number;
  deadlineAt: number;
  maxCleanPrewriteRetries: number;
  dispatchAttempt: number;
  dispatchRetryAt: number | null;
  writeEvidence: DeliveryWriteEvidence;
  uncertaintyCode: string | null;
  approvalProgress: DeliveryApprovalProgress;
  stall: DeliveryStallState;
  nativeReceipt: NativeReceiptMachine;
}>;

export type ActiveDeliveryMachine = DeliveryCommonState &
  Readonly<{
    phase: Exclude<DeliveryPhase, "terminal">;
  }>;

export type TerminalDeliveryMachine = DeliveryCommonState &
  Readonly<{
    phase: "terminal";
    outcome: DeliveryTerminalOutcome;
    terminalAt: number;
    safeErrorCode?: string;
  }>;

export type DeliveryMachine =
  | ActiveDeliveryMachine
  | TerminalDeliveryMachine;

export type CreateDeliveryMachineInput = Readonly<{
  enqueuedAt: number;
  stallAt: number;
  deadlineAt: number;
  maxCleanPrewriteRetries?: number;
  nativeReceipt?: boolean;
  maxNativeReceiptCleanPrewriteRetries?: number;
}>;

export const deliveryEventTypes = [
  "dispatch_requested",
  "dispatch_retry_due",
  "dispatch_clean_prewrite_failed",
  "dispatch_ambiguous",
  "transport_written",
  "await_terminal",
  "provider_held",
  "provider_released",
  "provider_denied",
  "provider_expired",
  "provider_failed",
  "provider_unconfirmed",
  "route_terminated",
  "external_settlement",
  "stall_due",
  "deadline_due",
  "cancel",
  "shutdown",
  "native_receipt_confirmed",
  "native_receipt_clean_prewrite_failed",
  "native_receipt_retry_due",
  "native_receipt_ambiguous",
] as const;

export type DeliveryEventType = (typeof deliveryEventTypes)[number];

export type DeliveryEvent =
  | { type: "dispatch_requested"; at: number }
  | { type: "dispatch_retry_due"; at: number }
  | {
      type: "dispatch_clean_prewrite_failed";
      at: number;
      retryAt: number;
      safeErrorCode: string;
    }
  | { type: "dispatch_ambiguous"; at: number; safeErrorCode: string }
  | { type: "transport_written"; observedAt: number }
  | { type: "await_terminal"; at: number }
  | { type: "provider_held"; observedAt: number }
  | { type: "provider_released"; observedAt: number }
  | {
      type: "provider_denied";
      observedAt: number;
      safeErrorCode: string;
    }
  | {
      type: "provider_expired";
      observedAt: number;
      safeErrorCode: string;
    }
  | {
      type: "provider_failed";
      observedAt: number;
      safeErrorCode: string;
    }
  | {
      type: "provider_unconfirmed";
      observedAt: number;
      safeErrorCode: string;
    }
  | {
      type: "route_terminated";
      at: number;
      unwrittenOutcome: "cancelled" | "failed";
      safeErrorCode: string;
    }
  | {
      type: "external_settlement";
      at: number;
      outcome: DeliveryTerminalOutcome;
      safeErrorCode?: string;
    }
  | { type: "stall_due"; at: number }
  | { type: "deadline_due"; at: number }
  | { type: "cancel"; at: number; safeErrorCode: string }
  | { type: "shutdown"; at: number }
  | { type: "native_receipt_confirmed"; at: number }
  | {
      type: "native_receipt_clean_prewrite_failed";
      at: number;
      retryAt: number;
    }
  | { type: "native_receipt_retry_due"; at: number }
  | { type: "native_receipt_ambiguous"; at: number };

export type DeliveryEffect =
  | { type: "dispatch"; attempt: number }
  | { type: "schedule_dispatch_retry"; attempt: number; retryAt: number }
  | {
      type: "record_progress";
      progress: "transport_written" | "transport_uncertain" | "held";
    }
  | { type: "publish_stall"; pendingForMs: number }
  | {
      type: "settle_delivery";
      outcome: DeliveryTerminalOutcome;
      terminalAt: number;
      safeErrorCode?: string;
    }
  | {
      type: "send_native_receipt";
      notification: NativeReceiptNotification;
      attempt: number;
    }
  | {
      type: "schedule_native_receipt_retry";
      attempt: number;
      retryAt: number;
    }
  | {
      type: "release_native_receipt";
      reason: "ambiguous_write" | "clean_prewrite_retries_exhausted";
    };

export type DeliveryTransition = Readonly<{
  state: DeliveryMachine;
  effects: readonly DeliveryEffect[];
}>;

export type DeadlineArbitration = "provider_terminal_wins" | "deadline_wins";

/** Provider terminal evidence must be observed strictly before the deadline. */
export function arbitrateDeliveryDeadline(
  observedAt: number,
  deadlineAt: number,
): DeadlineArbitration {
  return observedAt < deadlineAt
    ? "provider_terminal_wins"
    : "deadline_wins";
}

export function createDeliveryMachine(
  input: CreateDeliveryMachineInput,
): DeliveryMachine {
  assertFiniteTime(input.enqueuedAt, "enqueuedAt");
  assertFiniteTime(input.stallAt, "stallAt");
  assertFiniteTime(input.deadlineAt, "deadlineAt");
  if (!(input.enqueuedAt <= input.stallAt && input.stallAt < input.deadlineAt)) {
    throw new RangeError(
      "Delivery times must satisfy enqueuedAt <= stallAt < deadlineAt.",
    );
  }
  const maxCleanPrewriteRetries = nonnegativeInteger(
    input.maxCleanPrewriteRetries ?? 0,
    "maxCleanPrewriteRetries",
  );
  const maxNativeReceiptCleanPrewriteRetries = nonnegativeInteger(
    input.maxNativeReceiptCleanPrewriteRetries ?? 0,
    "maxNativeReceiptCleanPrewriteRetries",
  );
  return {
    phase: "queued",
    enqueuedAt: input.enqueuedAt,
    stallAt: input.stallAt,
    deadlineAt: input.deadlineAt,
    maxCleanPrewriteRetries,
    dispatchAttempt: 0,
    dispatchRetryAt: null,
    writeEvidence: "none",
    uncertaintyCode: null,
    approvalProgress: "none",
    stall: "pending",
    nativeReceipt:
      input.nativeReceipt === true
        ? {
            phase: "open",
            maxCleanPrewriteRetries:
              maxNativeReceiptCleanPrewriteRetries,
          }
        : { phase: "absent" },
  };
}

export function isTerminalDeliveryMachine(
  state: DeliveryMachine,
): state is TerminalDeliveryMachine {
  return state.phase === "terminal";
}

export type DeliveryProjection = Readonly<{
  phase: DeliveryPhase;
  publicState:
    | Exclude<DeliveryPhase, "terminal">
    | "stalled"
    | DeliveryTerminalOutcome;
  terminal: boolean;
  stalled: boolean;
  pendingForMs?: number;
  outcome?: DeliveryTerminalOutcome;
  approvalProgress: DeliveryApprovalProgress;
  writeEvidence: DeliveryWriteEvidence;
  nativeReceiptPhase: NativeReceiptMachine["phase"];
}>;

export function projectDelivery(
  state: DeliveryMachine,
  now: number,
): DeliveryProjection {
  assertFiniteTime(now, "now");
  if (state.phase === "terminal") {
    return {
      phase: state.phase,
      publicState: state.outcome,
      terminal: true,
      stalled: state.stall === "emitted",
      outcome: state.outcome,
      approvalProgress: state.approvalProgress,
      writeEvidence: state.writeEvidence,
      nativeReceiptPhase: state.nativeReceipt.phase,
    };
  }
  return {
    phase: state.phase,
    publicState: state.stall === "emitted" ? "stalled" : state.phase,
    terminal: false,
    stalled: state.stall === "emitted",
    pendingForMs: Math.max(0, now - state.enqueuedAt),
    approvalProgress: state.approvalProgress,
    writeEvidence: state.writeEvidence,
    nativeReceiptPhase: state.nativeReceipt.phase,
  };
}

export type DeliveryWakeups = Readonly<{
  stallAt?: number;
  deadlineAt?: number;
  dispatchRetryAt?: number;
  nativeReceiptRetryAt?: number;
}>;

/** Timer projection; scheduling remains a controller responsibility. */
export function projectDeliveryWakeups(
  state: DeliveryMachine,
): DeliveryWakeups {
  const nativeReceiptRetryAt =
    state.nativeReceipt.phase === "retry_wait"
      ? state.nativeReceipt.retryAt
      : undefined;
  if (state.phase === "terminal") {
    return nativeReceiptRetryAt === undefined
      ? {}
      : { nativeReceiptRetryAt };
  }
  return {
    ...(state.stall === "pending" ? { stallAt: state.stallAt } : {}),
    deadlineAt: state.deadlineAt,
    ...(state.dispatchRetryAt === null
      ? {}
      : { dispatchRetryAt: state.dispatchRetryAt }),
    ...(nativeReceiptRetryAt === undefined ? {} : { nativeReceiptRetryAt }),
  };
}

export function transitionDelivery(
  state: DeliveryMachine,
  event: DeliveryEvent,
): DeliveryTransition {
  if (isNativeReceiptEvent(event)) {
    return transitionDeliveryNativeReceipt(state, event);
  }
  if (state.phase === "terminal") return unchanged(state);

  switch (event.type) {
    case "dispatch_requested":
      if (
        state.phase !== "queued" ||
        state.dispatchAttempt !== 0 ||
        state.dispatchRetryAt !== null ||
        event.at >= state.deadlineAt
      ) {
        return event.at >= state.deadlineAt
          ? settleAtDeadline(state, event.at)
          : unchanged(state);
      }
      return {
        state: {
          ...state,
          phase: "dispatching",
          dispatchAttempt: 1,
        },
        effects: [{ type: "dispatch", attempt: 1 }],
      };

    case "dispatch_retry_due":
      if (
        state.phase !== "queued" ||
        state.dispatchRetryAt === null ||
        event.at < state.dispatchRetryAt
      ) {
        return event.at >= state.deadlineAt
          ? settleAtDeadline(state, event.at)
          : unchanged(state);
      }
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      return {
        state: {
          ...state,
          phase: "dispatching",
          dispatchAttempt: state.dispatchAttempt + 1,
          dispatchRetryAt: null,
        },
        effects: [
          { type: "dispatch", attempt: state.dispatchAttempt + 1 },
        ],
      };

    case "dispatch_clean_prewrite_failed": {
      if (state.phase !== "dispatching") return unchanged(state);
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      const canRetry =
        state.writeEvidence === "none" &&
        state.dispatchAttempt <= state.maxCleanPrewriteRetries &&
        event.retryAt > event.at &&
        event.retryAt < state.deadlineAt;
      if (!canRetry) {
        return terminalize(
          state,
          "failed",
          event.at,
          event.safeErrorCode,
        );
      }
      return {
        state: {
          ...state,
          phase: "queued",
          dispatchRetryAt: event.retryAt,
        },
        effects: [
          {
            type: "schedule_dispatch_retry",
            attempt: state.dispatchAttempt + 1,
            retryAt: event.retryAt,
          },
        ],
      };
    }

    case "dispatch_ambiguous": {
      if (!hasDispatchStarted(state)) return unchanged(state);
      if (state.writeEvidence === "transport_written") {
        return event.at >= state.deadlineAt
          ? settleAtDeadline(state, event.at)
          : unchanged(state);
      }
      if (
        state.writeEvidence === "transport_uncertain" &&
        event.at < state.deadlineAt
      ) {
        return unchanged(state);
      }
      const uncertain: ActiveDeliveryMachine = {
        ...state,
        phase: "awaiting_terminal",
        writeEvidence: "transport_uncertain",
        uncertaintyCode: event.safeErrorCode,
      };
      if (event.at >= state.deadlineAt) {
        return settleAtDeadline(uncertain, event.at);
      }
      return {
        state: uncertain,
        effects: [
          { type: "record_progress", progress: "transport_uncertain" },
        ],
      };
    }

    case "transport_written":
      if (!hasDispatchStarted(state)) return unchanged(state);
      if (
        arbitrateDeliveryDeadline(event.observedAt, state.deadlineAt) ===
        "deadline_wins"
      ) {
        return settleAtDeadline(state, event.observedAt);
      }
      return {
        state: {
          ...state,
          phase:
            state.phase === "awaiting_terminal"
              ? "awaiting_terminal"
              : "transport_written",
          writeEvidence: "transport_written",
          uncertaintyCode: null,
        },
        effects: [
          { type: "record_progress", progress: "transport_written" },
        ],
      };

    case "await_terminal":
      if (!hasDispatchStarted(state)) return unchanged(state);
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      if (
        state.phase !== "dispatching" &&
        state.phase !== "transport_written"
      ) {
        return unchanged(state);
      }
      return {
        state: { ...state, phase: "awaiting_terminal" },
        effects: [],
      };

    case "provider_held":
      if (!hasDispatchStarted(state)) return unchanged(state);
      if (
        arbitrateDeliveryDeadline(event.observedAt, state.deadlineAt) ===
        "deadline_wins"
      ) {
        return settleAtDeadline(state, event.observedAt);
      }
      return {
        state: {
          ...state,
          phase: "awaiting_terminal",
          writeEvidence: "transport_written",
          uncertaintyCode: null,
          approvalProgress: "held",
        },
        effects: [{ type: "record_progress", progress: "held" }],
      };

    case "provider_released":
      return providerTerminal(
        state,
        event.observedAt,
        "delivered",
      );

    case "provider_denied":
      return providerTerminal(
        state,
        event.observedAt,
        "failed",
        event.safeErrorCode,
      );

    case "provider_expired":
      return providerTerminal(
        state,
        event.observedAt,
        "expired",
        event.safeErrorCode,
      );

    case "provider_failed":
      return providerTerminal(
        state,
        event.observedAt,
        "failed",
        event.safeErrorCode,
      );

    case "provider_unconfirmed":
      if (!hasDispatchStarted(state)) return unchanged(state);
      if (event.observedAt >= state.deadlineAt) {
        return settleAtDeadline(state, event.observedAt);
      }
      return terminalize(
        {
          ...state,
          writeEvidence: "transport_written",
          uncertaintyCode: null,
        },
        "unconfirmed",
        event.observedAt,
        event.safeErrorCode,
      );

    case "route_terminated":
      if (event.at >= state.deadlineAt) {
        return settleAtDeadline(state, event.at);
      }
      if (state.writeEvidence === "transport_written") {
        return terminalize(
          state,
          "unconfirmed",
          event.at,
          "DELIVERY_UNCONFIRMED",
        );
      }
      if (state.writeEvidence === "transport_uncertain") {
        return terminalize(
          state,
          "ambiguous",
          event.at,
          state.uncertaintyCode ?? "DISPATCH_OUTCOME_AMBIGUOUS",
        );
      }
      return terminalize(
        state,
        event.unwrittenOutcome,
        event.at,
        event.safeErrorCode,
      );

    case "external_settlement":
      return terminalize(
        state,
        event.outcome,
        event.at,
        event.safeErrorCode,
      );

    case "stall_due":
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      if (state.stall === "emitted" || event.at < state.stallAt) {
        return unchanged(state);
      }
      return {
        state: { ...state, stall: "emitted" },
        effects: [
          {
            type: "publish_stall",
            pendingForMs: Math.max(0, event.at - state.enqueuedAt),
          },
        ],
      };

    case "deadline_due":
      return event.at < state.deadlineAt
        ? unchanged(state)
        : settleAtDeadline(state, event.at);

    case "cancel":
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      return terminalize(
        state,
        "cancelled",
        event.at,
        event.safeErrorCode,
      );

    case "shutdown":
      if (event.at >= state.deadlineAt) return settleAtDeadline(state, event.at);
      if (state.writeEvidence === "transport_written") {
        return terminalize(
          state,
          "unconfirmed",
          event.at,
          "DELIVERY_UNCONFIRMED",
        );
      }
      if (state.writeEvidence === "transport_uncertain") {
        return terminalize(
          state,
          "ambiguous",
          event.at,
          state.uncertaintyCode ?? "DISPATCH_OUTCOME_AMBIGUOUS",
        );
      }
      return terminalize(state, "cancelled", event.at, "GATEWAY_SHUTDOWN");

    default:
      return assertNever(event);
  }
}

type NativeReceiptEvent = Extract<
  DeliveryEvent,
  {
    type:
      | "native_receipt_confirmed"
      | "native_receipt_clean_prewrite_failed"
      | "native_receipt_retry_due"
      | "native_receipt_ambiguous";
  }
>;

function transitionDeliveryNativeReceipt(
  state: DeliveryMachine,
  event: NativeReceiptEvent,
): DeliveryTransition {
  if (state.phase !== "terminal") return unchanged(state);
  const transition = transitionNativeReceipt(state.nativeReceipt, event);
  if (transition.state === state.nativeReceipt) return unchanged(state);
  return {
    state: { ...state, nativeReceipt: transition.state },
    effects: transition.effects,
  };
}

export type NativeReceiptTransition = Readonly<{
  state: NativeReceiptMachine;
  effects: readonly DeliveryEffect[];
}>;

/**
 * Child lifecycle for notifying a native sender about the already-decided
 * delivery outcome. It cannot alter the parent's terminal outcome.
 */
export function transitionNativeReceipt(
  state: NativeReceiptMachine,
  event: NativeReceiptEvent,
): NativeReceiptTransition {
  switch (event.type) {
    case "native_receipt_confirmed":
      if (state.phase !== "sending") return unchangedNative(state);
      return {
        state: {
          phase: "confirmed",
          notification: state.notification,
          attempts: state.attempt,
        },
        effects: [],
      };

    case "native_receipt_clean_prewrite_failed":
      if (state.phase !== "sending") return unchangedNative(state);
      if (
        state.attempt <= state.maxCleanPrewriteRetries &&
        event.retryAt > event.at
      ) {
        return {
          state: {
            phase: "retry_wait",
            notification: state.notification,
            attempt: state.attempt,
            retryAt: event.retryAt,
            maxCleanPrewriteRetries: state.maxCleanPrewriteRetries,
          },
          effects: [
            {
              type: "schedule_native_receipt_retry",
              attempt: state.attempt + 1,
              retryAt: event.retryAt,
            },
          ],
        };
      }
      return abandonNativeReceipt(
        state.notification,
        state.attempt,
        "clean_prewrite_retries_exhausted",
      );

    case "native_receipt_retry_due":
      if (
        state.phase !== "retry_wait" ||
        event.at < state.retryAt
      ) {
        return unchangedNative(state);
      }
      return {
        state: {
          phase: "sending",
          notification: state.notification,
          attempt: state.attempt + 1,
          maxCleanPrewriteRetries: state.maxCleanPrewriteRetries,
        },
        effects: [
          {
            type: "send_native_receipt",
            notification: state.notification,
            attempt: state.attempt + 1,
          },
        ],
      };

    case "native_receipt_ambiguous":
      if (state.phase !== "sending") return unchangedNative(state);
      return abandonNativeReceipt(
        state.notification,
        state.attempt,
        "ambiguous_write",
      );

    default:
      return assertNever(event);
  }
}

function providerTerminal(
  state: ActiveDeliveryMachine,
  observedAt: number,
  outcome: Extract<DeliveryTerminalOutcome, "delivered" | "expired" | "failed">,
  safeErrorCode?: string,
): DeliveryTransition {
  if (!hasDispatchStarted(state)) return unchanged(state);
  if (
    arbitrateDeliveryDeadline(observedAt, state.deadlineAt) === "deadline_wins"
  ) {
    return settleAtDeadline(state, observedAt);
  }
  return terminalize(state, outcome, observedAt, safeErrorCode);
}

function settleAtDeadline(
  state: ActiveDeliveryMachine,
  observedAt: number,
): DeliveryTransition {
  const outcome: DeliveryTerminalOutcome =
    state.writeEvidence === "transport_written"
      ? "unconfirmed"
      : state.writeEvidence === "transport_uncertain"
        ? "ambiguous"
        : "expired";
  const safeErrorCode =
    outcome === "unconfirmed"
      ? "DELIVERY_UNCONFIRMED"
      : outcome === "ambiguous"
        ? (state.uncertaintyCode ?? "DISPATCH_OUTCOME_AMBIGUOUS")
        : "DELIVERY_DEADLINE_EXPIRED";
  return terminalize(
    state,
    outcome,
    state.deadlineAt,
    safeErrorCode,
  );
}

function terminalize(
  state: ActiveDeliveryMachine,
  outcome: DeliveryTerminalOutcome,
  terminalAt: number,
  safeErrorCode?: string,
): DeliveryTransition {
  const notification = nativeNotification(outcome, safeErrorCode);
  const armed = armNativeReceipt(state.nativeReceipt, notification);
  const terminal: TerminalDeliveryMachine = {
    ...state,
    phase: "terminal",
    outcome,
    terminalAt,
    dispatchRetryAt: null,
    nativeReceipt: armed.state,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
  };
  return {
    state: terminal,
    effects: [
      {
        type: "settle_delivery",
        outcome,
        terminalAt,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      },
      ...armed.effects,
    ],
  };
}

function armNativeReceipt(
  state: NativeReceiptMachine,
  notification: NativeReceiptNotification,
): NativeReceiptTransition {
  if (state.phase !== "open") return unchangedNative(state);
  const sending: NativeReceiptMachine = {
    phase: "sending",
    notification,
    attempt: 1,
    maxCleanPrewriteRetries: state.maxCleanPrewriteRetries,
  };
  return {
    state: sending,
    effects: [
      { type: "send_native_receipt", notification, attempt: 1 },
    ],
  };
}

function nativeNotification(
  outcome: DeliveryTerminalOutcome,
  safeErrorCode?: string,
): NativeReceiptNotification {
  return outcome === "delivered"
    ? { status: "delivered" }
    : {
        status: "expired",
        diagnosticCode:
          safeErrorCode ??
          (outcome === "unconfirmed"
            ? "DELIVERY_UNCONFIRMED"
            : `DELIVERY_${outcome.toUpperCase()}`),
      };
}

function abandonNativeReceipt(
  notification: NativeReceiptNotification,
  attempts: number,
  reason: "ambiguous_write" | "clean_prewrite_retries_exhausted",
): NativeReceiptTransition {
  return {
    state: {
      phase: "write_unconfirmed",
      notification,
      attempts,
      reason,
    },
    effects: [{ type: "release_native_receipt", reason }],
  };
}

function hasDispatchStarted(state: ActiveDeliveryMachine): boolean {
  return state.dispatchAttempt > 0 && state.dispatchRetryAt === null;
}

function isNativeReceiptEvent(
  event: DeliveryEvent,
): event is NativeReceiptEvent {
  return event.type.startsWith("native_receipt_");
}

function unchanged(state: DeliveryMachine): DeliveryTransition {
  return { state, effects: [] };
}

function unchangedNative(state: NativeReceiptMachine): NativeReceiptTransition {
  return { state, effects: [] };
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number.`);
  }
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unreachable delivery event: ${JSON.stringify(value)}`);
}
