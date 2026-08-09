import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgressWatchMachine,
  progressWatchOutcomes,
  transitionProgressWatch,
  type ProgressWatchEvent,
  type ProgressWatchMachine,
} from "../src/gateway/progress-watch-machine.js";

const START = Date.parse("2026-08-09T12:00:00.000Z");
const IDLE = 60_000;

function initial(): ProgressWatchMachine {
  return createProgressWatchMachine({
    conversationId: "conv_abcdefghijklmnop",
    ownerAlias: "codex-owner@this-mac",
    workerAlias: "claude-worker@this-mac",
    ownerLease: "lease_owner",
    workerLease: "lease_worker",
    idleMs: IDLE,
    at: START,
  });
}

test("quiet watches nudge twice with bounded backoff then settle unresponsive", () => {
  const first = transitionProgressWatch(initial(), {
    type: "due",
    at: START + IDLE,
    bothIdle: true,
    endpointsPresent: true,
  });
  assert.equal(first.state?.phase, "episode");
  assert.equal(first.state?.nudgeCount, 1);
  assert.deepEqual(first.effects, [{ type: "send_nudge", nudgeNumber: 1 }]);

  const second = transitionProgressWatch(first.state!, {
    type: "due",
    at: START + IDLE * 2,
    bothIdle: true,
    endpointsPresent: true,
  });
  assert.equal(second.state?.nudgeCount, 2);
  assert.equal(
    Date.parse(second.state!.nextActionAt),
    START + IDLE * 4,
  );
  assert.deepEqual(second.effects, [{ type: "send_nudge", nudgeNumber: 2 }]);

  const terminal = transitionProgressWatch(second.state!, {
    type: "due",
    at: START + IDLE * 4,
    bothIdle: true,
    endpointsPresent: true,
  });
  assert.equal(terminal.state, null);
  assert.deepEqual(terminal.effects, [
    { type: "settled", outcome: "unresponsive" },
  ]);
});

test("conversation and route activity end an episode without ending the watch", () => {
  const episode = transitionProgressWatch(initial(), {
    type: "due",
    at: START + IDLE,
    bothIdle: true,
    endpointsPresent: true,
  }).state!;
  for (const event of [
    { type: "activity", at: START + IDLE + 1 } as const,
    { type: "route_activity", at: START + IDLE + 2 } as const,
  ]) {
    const result = transitionProgressWatch(episode, event);
    assert.equal(result.state?.phase, "quiet");
    assert.equal(result.state?.nudgeCount, 0);
    assert.notEqual(result.state, null);
  }
});

test("worker DONE is a hint while owner DONE is terminal", () => {
  const worker = transitionProgressWatch(initial(), {
    type: "activity",
    at: START + 1,
    workerReportedComplete: true,
  });
  assert.equal(worker.state?.workerReportedCompleteAt, "2026-08-09T12:00:00.001Z");
  const owner = transitionProgressWatch(worker.state!, {
    type: "owner_done",
    at: START + 2,
  });
  assert.equal(owner.state, null);
  assert.deepEqual(owner.effects, [{ type: "settled", outcome: "done" }]);
});

test("route activity postpones nudges and missing endpoints settle exactly", () => {
  const busy = transitionProgressWatch(initial(), {
    type: "due",
    at: START + IDLE,
    bothIdle: false,
    endpointsPresent: true,
  });
  assert.equal(busy.state?.phase, "quiet");
  assert.equal(Date.parse(busy.state!.nextActionAt), START + IDLE * 2);
  const retired = transitionProgressWatch(busy.state!, {
    type: "due",
    at: START + IDLE * 2,
    bothIdle: true,
    endpointsPresent: false,
  });
  assert.deepEqual(retired.effects, [
    { type: "settled", outcome: "endpoint_retired" },
  ]);
});

test("restart degradation is announced once and never invents reply capability", () => {
  const first = transitionProgressWatch(initial(), {
    type: "restart",
    at: START + 1,
    conversationCapabilityRestored: false,
  });
  assert.equal(first.state?.capability, "route");
  assert.deepEqual(first.effects, [{ type: "notify_capability_degraded" }]);
  const second = transitionProgressWatch(first.state!, {
    type: "restart",
    at: START + 2,
    conversationCapabilityRestored: false,
  });
  assert.deepEqual(second.effects, []);
});

test("the reducer is deterministic, nonmutating, and covers every terminal outcome", () => {
  const events: ProgressWatchEvent[] = [
    { type: "activity", at: START + 1 },
    { type: "route_activity", at: START + 1 },
    {
      type: "due",
      at: START + IDLE,
      bothIdle: true,
      endpointsPresent: true,
    },
    { type: "owner_done", at: START + 1 },
    { type: "endpoint_retired", at: START + 1 },
    { type: "disabled", at: START + 1 },
    {
      type: "restart",
      at: START + 1,
      conversationCapabilityRestored: false,
    },
  ];
  for (const event of events) {
    const state = initial();
    const before = structuredClone(state);
    assert.deepEqual(
      transitionProgressWatch(state, event),
      transitionProgressWatch(state, event),
    );
    assert.deepEqual(state, before);
  }
  assert.deepEqual(progressWatchOutcomes, [
    "done",
    "unresponsive",
    "endpoint_retired",
    "disabled",
  ]);
});
