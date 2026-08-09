export const progressWatchPhases = ["quiet", "episode"] as const;
export type ProgressWatchPhase = (typeof progressWatchPhases)[number];

export const progressWatchCapabilities = ["conversation", "route"] as const;
export type ProgressWatchCapability =
  (typeof progressWatchCapabilities)[number];

export const progressWatchOutcomes = [
  "done",
  "unresponsive",
  "endpoint_retired",
  "disabled",
] as const;
export type ProgressWatchOutcome = (typeof progressWatchOutcomes)[number];

export const progressWatchJournalKinds = [
  "opened",
  "activity",
  "nudge",
  "worker_reported_complete",
  "capability_degraded",
  "done",
  "unresponsive",
  "endpoint_retired",
  "disabled",
] as const;
export type ProgressWatchJournalKind =
  (typeof progressWatchJournalKinds)[number];

export const PROGRESS_WATCH_DEFAULT_IDLE_MS = 5 * 60_000;
export const PROGRESS_WATCH_MIN_IDLE_MS = 60_000;
export const PROGRESS_WATCH_MAX_IDLE_MS = 24 * 60 * 60_000;
export const PROGRESS_WATCH_DEFAULT_CAPACITY = 32;
export const PROGRESS_WATCH_HARD_CAPACITY = 256;

/**
 * Durable, content-free liveness state. Route leases keep a watch attached to
 * the exact consent edge that opened it; they are never publicly projected.
 */
export type ProgressWatchMachine = Readonly<{
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  ownerLease: string;
  workerLease: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleMs: number;
  phase: ProgressWatchPhase;
  nudgeCount: 0 | 1 | 2;
  nextActionAt: string;
  capability: ProgressWatchCapability;
  degradedNoticeSent: boolean;
  workerReportedCompleteAt?: string;
}>;

export type ProgressWatchJournalEvent = Readonly<{
  sequence: number;
  timestamp: string;
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  kind: ProgressWatchJournalKind;
  nudgeNumber?: 1 | 2;
}>;

export type ProgressWatchEvent =
  | Readonly<{
      type: "activity";
      at: number;
      workerReportedComplete?: true;
    }>
  | Readonly<{ type: "route_activity"; at: number }>
  | Readonly<{
      type: "due";
      at: number;
      bothIdle: boolean;
      endpointsPresent: boolean;
    }>
  | Readonly<{
      type: "restart";
      at: number;
      conversationCapabilityRestored: boolean;
    }>
  | Readonly<{ type: "owner_done"; at: number }>
  | Readonly<{ type: "endpoint_retired"; at: number }>
  | Readonly<{ type: "disabled"; at: number }>;

export type ProgressWatchEffect =
  | Readonly<{ type: "send_nudge"; nudgeNumber: 1 | 2 }>
  | Readonly<{ type: "notify_capability_degraded" }>
  | Readonly<{
      type: "settled";
      outcome: ProgressWatchOutcome;
    }>;

export type ProgressWatchTransition = Readonly<{
  state: ProgressWatchMachine | null;
  effects: readonly ProgressWatchEffect[];
}>;

function iso(at: number): string {
  if (!Number.isFinite(at)) throw new RangeError("INVALID_PROGRESS_WATCH_TIME");
  return new Date(at).toISOString();
}

function plus(at: number, delayMs: number): string {
  return iso(at + delayMs);
}

function settle(
  outcome: ProgressWatchOutcome,
): ProgressWatchTransition {
  return { state: null, effects: [{ type: "settled", outcome }] };
}

export function createProgressWatchMachine(input: Readonly<{
  conversationId: string;
  ownerAlias: string;
  workerAlias: string;
  ownerLease: string;
  workerLease: string;
  idleMs: number;
  at: number;
}>): ProgressWatchMachine {
  if (
    !Number.isSafeInteger(input.idleMs) ||
    input.idleMs < PROGRESS_WATCH_MIN_IDLE_MS ||
    input.idleMs > PROGRESS_WATCH_MAX_IDLE_MS
  ) {
    throw new RangeError("INVALID_PROGRESS_WATCH_IDLE_MS");
  }
  const timestamp = iso(input.at);
  return {
    conversationId: input.conversationId,
    ownerAlias: input.ownerAlias,
    workerAlias: input.workerAlias,
    ownerLease: input.ownerLease,
    workerLease: input.workerLease,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    idleMs: input.idleMs,
    phase: "quiet",
    nudgeCount: 0,
    nextActionAt: plus(input.at, input.idleMs),
    capability: "conversation",
    degradedNoticeSent: false,
  };
}

/** Pure, deterministic owner-ended progress-watch transition function. */
export function transitionProgressWatch(
  state: ProgressWatchMachine,
  event: ProgressWatchEvent,
): ProgressWatchTransition {
  const at = event.at;
  const timestamp = iso(at);
  switch (event.type) {
    case "owner_done":
      return settle("done");
    case "endpoint_retired":
      return settle("endpoint_retired");
    case "disabled":
      return settle("disabled");
    case "activity":
    case "route_activity": {
      const workerReportedComplete =
        event.type === "activity" && event.workerReportedComplete === true;
      return {
        state: {
          ...state,
          updatedAt: timestamp,
          lastActivityAt: timestamp,
          phase: "quiet",
          nudgeCount: 0,
          nextActionAt: plus(at, state.idleMs),
          ...(workerReportedComplete
            ? { workerReportedCompleteAt: timestamp }
            : {}),
        },
        effects: [],
      };
    }
    case "restart": {
      if (event.conversationCapabilityRestored) {
        return {
          state: {
            ...state,
            updatedAt: timestamp,
            capability: "conversation",
          },
          effects: [],
        };
      }
      const notify = !state.degradedNoticeSent;
      return {
        state: {
          ...state,
          updatedAt: timestamp,
          capability: "route",
          degradedNoticeSent: true,
        },
        effects: notify ? [{ type: "notify_capability_degraded" }] : [],
      };
    }
    case "due": {
      if (at < Date.parse(state.nextActionAt)) {
        return { state, effects: [] };
      }
      if (!event.endpointsPresent) return settle("endpoint_retired");
      if (!event.bothIdle) {
        return {
          state: {
            ...state,
            updatedAt: timestamp,
            lastActivityAt: timestamp,
            phase: "quiet",
            nudgeCount: 0,
            nextActionAt: plus(at, state.idleMs),
          },
          effects: [],
        };
      }
      if (state.phase === "quiet") {
        return {
          state: {
            ...state,
            updatedAt: timestamp,
            phase: "episode",
            nudgeCount: 1,
            nextActionAt: plus(at, state.idleMs),
          },
          effects: [{ type: "send_nudge", nudgeNumber: 1 }],
        };
      }
      if (state.nudgeCount === 1) {
        return {
          state: {
            ...state,
            updatedAt: timestamp,
            nudgeCount: 2,
            nextActionAt: plus(at, state.idleMs * 2),
          },
          effects: [{ type: "send_nudge", nudgeNumber: 2 }],
        };
      }
      return settle("unresponsive");
    }
  }
}
