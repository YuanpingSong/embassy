import assert from "node:assert/strict";
import test from "node:test";
import {
  commitProgressWatchNudge,
  createProgressWatch,
  deferProgressWatchNudge,
  inspectProgressWatchDue,
  recordProgressWatchActivity,
  type ProgressWatch,
} from "../src/gateway/progress-watch-machine.js";

const START = Date.parse("2026-08-09T12:00:00.000Z");
const IDLE = 60_000;

function initial(): ProgressWatch {
  return createProgressWatch({
    conversationId: "conv_abcdefghijklmnop",
    ownerAlias: "codex-owner@this-mac",
    workerAlias: "claude-worker@this-mac",
    idleMs: IDLE,
    at: START,
  });
}

test("active watches retain only the seven fields required for supervision", () => {
  assert.deepEqual(initial(), {
    conversationId: "conv_abcdefghijklmnop",
    ownerAlias: "codex-owner@this-mac",
    workerAlias: "claude-worker@this-mac",
    lastActivityAt: "2026-08-09T12:00:00.000Z",
    idleMs: IDLE,
    nudgeCount: 0,
    nextActionAt: "2026-08-09T12:01:00.000Z",
  });
  assert.throws(
    () => createProgressWatch({ ...initial(), idleMs: IDLE - 1, at: START }),
    /INVALID_PROGRESS_WATCH_IDLE_MS/,
  );
  assert.throws(
    () => createProgressWatch({ ...initial(), at: Number.NaN }),
    /INVALID_PROGRESS_WATCH_TIME/,
  );
});

test("due inspection and atomic commit preserve the bounded two-nudge cadence", () => {
  const original = initial();
  assert.deepEqual(
    inspectProgressWatchDue(original, {
      at: START + IDLE,
      bothIdle: true,
    }),
    { kind: "nudge", nudgeNumber: 1 },
  );
  assert.equal(original.nudgeCount, 0);

  const first = commitProgressWatchNudge(original, {
    at: START + IDLE,
    nudgeNumber: 1,
  });
  assert.equal(first.nudgeCount, 1);
  assert.equal(Date.parse(first.nextActionAt), START + IDLE * 2);
  assert.deepEqual(
    inspectProgressWatchDue(first, {
      at: START + IDLE * 2,
      bothIdle: true,
    }),
    { kind: "nudge", nudgeNumber: 2 },
  );

  const second = commitProgressWatchNudge(first, {
    at: START + IDLE * 2,
    nudgeNumber: 2,
  });
  assert.equal(second.nudgeCount, 2);
  assert.equal(Date.parse(second.nextActionAt), START + IDLE * 4);
  assert.deepEqual(
    inspectProgressWatchDue(second, {
      at: START + IDLE * 4,
      bothIdle: true,
    }),
    { kind: "settled", reason: "idle_timeout" },
  );
});

test("activity and non-idle endpoints reset one quiet episode", () => {
  const nudged = commitProgressWatchNudge(initial(), {
    at: START + IDLE,
    nudgeNumber: 1,
  });
  const active = recordProgressWatchActivity(nudged, START + IDLE + 1);
  assert.equal(active.nudgeCount, 0);
  assert.equal(Date.parse(active.lastActivityAt), START + IDLE + 1);
  assert.equal(Date.parse(active.nextActionAt), START + IDLE * 2 + 1);

  const rescheduled = inspectProgressWatchDue(nudged, {
    at: START + IDLE * 2,
    bothIdle: false,
  });
  assert.equal(rescheduled.kind, "rescheduled");
  if (rescheduled.kind === "rescheduled") {
    assert.equal(rescheduled.watch.nudgeCount, 0);
    assert.equal(Date.parse(rescheduled.watch.nextActionAt), START + IDLE * 3);
  }
});

test("not-due, deferred, and stale nudge decisions are exact", () => {
  const watch = initial();
  assert.deepEqual(
    inspectProgressWatchDue(watch, {
      at: START + IDLE - 1,
      bothIdle: true,
    }),
    { kind: "not_due" },
  );
  assert.equal(
    Date.parse(deferProgressWatchNudge(watch, START + IDLE).nextActionAt),
    START + IDLE + 1_000,
  );
  assert.throws(
    () =>
      commitProgressWatchNudge(watch, {
        at: START + IDLE - 1,
        nudgeNumber: 1,
      }),
    /INVALID_PROGRESS_WATCH_NUDGE/,
  );
  assert.throws(
    () =>
      commitProgressWatchNudge(watch, {
        at: START + IDLE,
        nudgeNumber: 2,
      }),
    /INVALID_PROGRESS_WATCH_NUDGE/,
  );
});

test("all pure operations are deterministic and nonmutating", () => {
  const watch = initial();
  const before = structuredClone(watch);
  const inspect = () =>
    inspectProgressWatchDue(watch, {
      at: START + IDLE,
      bothIdle: true,
    });
  assert.deepEqual(inspect(), inspect());
  assert.deepEqual(
    recordProgressWatchActivity(watch, START + 1),
    recordProgressWatchActivity(watch, START + 1),
  );
  assert.deepEqual(
    deferProgressWatchNudge(watch, START + 1),
    deferProgressWatchNudge(watch, START + 1),
  );
  assert.deepEqual(watch, before);
});
