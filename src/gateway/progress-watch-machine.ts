export const PROGRESS_WATCH_DEFAULT_IDLE_MS = 5 * 60_000;
export const PROGRESS_WATCH_MIN_IDLE_MS = 60_000;
export const PROGRESS_WATCH_MAX_IDLE_MS = 24 * 60 * 60_000;
const PROGRESS_WATCH_NUDGE_RETRY_MS = 1_000;
export const PROGRESS_WATCH_DEFAULT_CAPACITY = 32;
export const PROGRESS_WATCH_HARD_CAPACITY = 256;
/** One process-local active watch. Settlement is represented by its absence. */
export type ProgressWatch = Readonly<{
  conversationId: string;   ownerAlias: string;
  workerAlias: string;   lastActivityAt: string;
  idleMs: number;   nudgeCount: 0 | 1 | 2;
  nextActionAt: string;
}>;
type ProgressWatchDueInspection =
  | Readonly<{ kind: "not_due" }>
  | Readonly<{ kind: "rescheduled"; watch: ProgressWatch }>
  | Readonly<{ kind: "nudge"; nudgeNumber: 1 | 2 }>
  | Readonly<{ kind: "settled"; reason: "idle_timeout" }>;
function iso(at: number): string {
  if (!Number.isFinite(at)) throw new RangeError("INVALID_PROGRESS_WATCH_TIME");
  return new Date(at).toISOString();
}
function plus(at: number, delayMs: number): string {
  return iso(at + delayMs);
}
export function createProgressWatch(input: Readonly<{
  conversationId: string;   ownerAlias: string;
  workerAlias: string;   idleMs: number;
  at: number;
}>): ProgressWatch {
  if (
    !Number.isSafeInteger(input.idleMs) ||
    input.idleMs < PROGRESS_WATCH_MIN_IDLE_MS ||
    input.idleMs > PROGRESS_WATCH_MAX_IDLE_MS
  ) {
    throw new RangeError("INVALID_PROGRESS_WATCH_IDLE_MS");
  }
  const timestamp = iso(input.at);
  return {
    conversationId: input.conversationId, ownerAlias: input.ownerAlias,
    workerAlias: input.workerAlias, lastActivityAt: timestamp,
    idleMs: input.idleMs, nudgeCount: 0,
    nextActionAt: plus(input.at, input.idleMs),
  };
}
export function recordProgressWatchActivity(
  watch: ProgressWatch, at: number,
): ProgressWatch {
  const timestamp = iso(at);
  return {
    ...watch,
    lastActivityAt: timestamp, nudgeCount: 0,
    nextActionAt: plus(at, watch.idleMs),
  };
}
export function inspectProgressWatchDue(
  watch: ProgressWatch,
  input: Readonly<{
    at: number;
    bothIdle: boolean;
  }>,
): ProgressWatchDueInspection {
  iso(input.at);
  if (input.at < Date.parse(watch.nextActionAt)) return { kind: "not_due" };
  if (!input.bothIdle) {
    return {
      kind: "rescheduled",
      watch: recordProgressWatchActivity(watch, input.at),
    };
  }
  if (watch.nudgeCount < 2) {
    return { kind: "nudge", nudgeNumber: (watch.nudgeCount + 1) as 1 | 2 };
  }
  return { kind: "settled", reason: "idle_timeout" };
}
export function commitProgressWatchNudge(
  watch: ProgressWatch, input: Readonly<{ at: number; nudgeNumber: 1 | 2 }>,
): ProgressWatch {
  iso(input.at);
  if (
    input.at < Date.parse(watch.nextActionAt) ||
    input.nudgeNumber !== watch.nudgeCount + 1
  ) {
    throw new RangeError("INVALID_PROGRESS_WATCH_NUDGE");
  }
  return {
    ...watch,
    nudgeCount: input.nudgeNumber,
    nextActionAt: plus(
      input.at,
      watch.idleMs * (input.nudgeNumber === 1 ? 1 : 2),
    ),
  };
}
export function deferProgressWatchNudge(
  watch: ProgressWatch, at: number,
): ProgressWatch {
  return {
    ...watch,
    nextActionAt: plus(at, PROGRESS_WATCH_NUDGE_RETRY_MS),
  };
}
