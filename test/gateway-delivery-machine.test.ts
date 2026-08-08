import assert from "node:assert/strict";
import { test } from "node:test";

import {
  arbitrateDeliveryDeadline,
  createDeliveryMachine,
  deliveryEventTypes,
  deliveryPhases,
  deliveryTerminalOutcomes,
  isTerminalDeliveryMachine,
  projectDelivery,
  projectDeliveryWakeups,
  transitionDelivery,
  type DeliveryEffect,
  type DeliveryEvent,
  type DeliveryMachine,
  type TerminalDeliveryMachine,
} from "../src/gateway/delivery-machine.js";

const ENQUEUED_AT = 0;
const STALL_AT = 50;
const DEADLINE_AT = 100;

function machine(
  input: Partial<Parameters<typeof createDeliveryMachine>[0]> = {},
): DeliveryMachine {
  return createDeliveryMachine({
    enqueuedAt: ENQUEUED_AT,
    stallAt: STALL_AT,
    deadlineAt: DEADLINE_AT,
    maxCleanPrewriteRetries: 1,
    maxNativeReceiptCleanPrewriteRetries: 1,
    ...input,
  });
}

function step(state: DeliveryMachine, event: DeliveryEvent): DeliveryMachine {
  return transitionDelivery(state, event).state;
}

function started(state = machine()): DeliveryMachine {
  return step(state, { type: "dispatch_requested", at: 1 });
}

function written(state = started()): DeliveryMachine {
  return step(state, { type: "transport_written", observedAt: 2 });
}

function terminal(
  state: DeliveryMachine,
  outcome: TerminalDeliveryMachine["outcome"],
): TerminalDeliveryMachine {
  assert.equal(state.phase, "terminal");
  assert.equal(state.outcome, outcome);
  return state;
}

test("the lifecycle exposes a closed five-phase, six-outcome vocabulary", () => {
  assert.deepEqual(deliveryPhases, [
    "queued",
    "dispatching",
    "transport_written",
    "awaiting_terminal",
    "terminal",
  ]);
  assert.deepEqual(deliveryTerminalOutcomes, [
    "delivered",
    "unconfirmed",
    "expired",
    "failed",
    "ambiguous",
    "cancelled",
  ]);
  assert.throws(
    () => machine({ stallAt: DEADLINE_AT }),
    /enqueuedAt <= stallAt < deadlineAt/,
  );
  assert.throws(
    () => machine({ maxCleanPrewriteRetries: -1 }),
    /non-negative safe integer/,
  );
});

test("confirmed transport without a terminal frame becomes unconfirmed at deadline", () => {
  let state = machine({
    nativeReceipt: true,
  });
  state = started(state);

  const write = transitionDelivery(state, {
    type: "transport_written",
    observedAt: DEADLINE_AT - 1,
  });
  assert.equal(write.state.phase, "transport_written");
  assert.deepEqual(write.effects, [
    { type: "record_progress", progress: "transport_written" },
  ]);

  state = step(write.state, { type: "await_terminal", at: 10 });
  assert.equal(state.phase, "awaiting_terminal");

  const result = transitionDelivery(state, {
    type: "deadline_due",
    at: DEADLINE_AT,
  });
  const settled = terminal(result.state, "unconfirmed");
  assert.equal(settled.safeErrorCode, "DELIVERY_UNCONFIRMED");
  assert.equal(settled.nativeReceipt.phase, "sending");
  assert.deepEqual(result.effects, [
    {
      type: "settle_delivery",
      outcome: "unconfirmed",
      terminalAt: DEADLINE_AT,
      safeErrorCode: "DELIVERY_UNCONFIRMED",
    },
    {
      type: "send_native_receipt",
      notification: {
        status: "expired",
        diagnosticCode: "DELIVERY_UNCONFIRMED",
      },
      attempt: 1,
    },
  ]);
});

test("a delivery with no evidence expires at its deadline", () => {
  const result = transitionDelivery(started(), {
    type: "deadline_due",
    at: DEADLINE_AT + 1,
  });
  const settled = terminal(result.state, "expired");
  assert.equal(settled.terminalAt, DEADLINE_AT);
  assert.equal(settled.safeErrorCode, "DELIVERY_DEADLINE_EXPIRED");
});

test("native held is approval progress and released means delivered to queue", () => {
  const held = transitionDelivery(started(), {
    type: "provider_held",
    observedAt: 10,
  });
  assert.equal(held.state.phase, "awaiting_terminal");
  assert.equal(held.state.approvalProgress, "held");
  assert.equal(held.state.writeEvidence, "transport_written");
  assert.deepEqual(held.effects, [
    { type: "record_progress", progress: "held" },
  ]);

  const released = transitionDelivery(held.state, {
    type: "provider_released",
    observedAt: 20,
  });
  terminal(released.state, "delivered");
  assert.deepEqual(released.effects, [
    { type: "settle_delivery", outcome: "delivered", terminalAt: 20 },
  ]);
});

test("native denial, expiry, and provider failure have distinct terminal truth", () => {
  const cases = [
    {
      event: {
        type: "provider_denied",
        observedAt: 20,
        safeErrorCode: "NATIVE_DENIED",
      } satisfies DeliveryEvent,
      outcome: "failed",
    },
    {
      event: {
        type: "provider_expired",
        observedAt: 20,
        safeErrorCode: "NATIVE_EXPIRED",
      } satisfies DeliveryEvent,
      outcome: "expired",
    },
    {
      event: {
        type: "provider_failed",
        observedAt: 20,
        safeErrorCode: "PROVIDER_FAILED",
      } satisfies DeliveryEvent,
      outcome: "failed",
    },
  ] as const;

  for (const candidate of cases) {
    terminal(
      transitionDelivery(started(), candidate.event).state,
      candidate.outcome,
    );
  }
});

test("deadline arbitration is strict at minus one, exact, and plus one", () => {
  assert.equal(
    arbitrateDeliveryDeadline(DEADLINE_AT - 1, DEADLINE_AT),
    "provider_terminal_wins",
  );
  assert.equal(
    arbitrateDeliveryDeadline(DEADLINE_AT, DEADLINE_AT),
    "deadline_wins",
  );
  assert.equal(
    arbitrateDeliveryDeadline(DEADLINE_AT + 1, DEADLINE_AT),
    "deadline_wins",
  );

  terminal(
    step(started(), {
      type: "provider_released",
      observedAt: DEADLINE_AT - 1,
    }),
    "delivered",
  );
  terminal(
    step(started(), {
      type: "provider_released",
      observedAt: DEADLINE_AT,
    }),
    "expired",
  );
  terminal(
    step(started(), {
      type: "provider_released",
      observedAt: DEADLINE_AT + 1,
    }),
    "expired",
  );
  terminal(
    step(started(), {
      type: "dispatch_clean_prewrite_failed",
      at: DEADLINE_AT,
      retryAt: DEADLINE_AT + 1,
      safeErrorCode: "CLEAN_PREWRITE",
    }),
    "expired",
  );
  terminal(
    step(started(), {
      type: "cancel",
      at: DEADLINE_AT,
      safeErrorCode: "CANCELLED",
    }),
    "expired",
  );
});

test("only a proven clean pre-write failure is retryable", () => {
  const first = transitionDelivery(started(), {
    type: "dispatch_clean_prewrite_failed",
    at: 10,
    retryAt: 20,
    safeErrorCode: "CLEAN_PREWRITE",
  });
  assert.equal(first.state.phase, "queued");
  assert.equal(first.state.dispatchRetryAt, 20);
  assert.deepEqual(first.effects, [
    { type: "schedule_dispatch_retry", attempt: 2, retryAt: 20 },
  ]);

  assert.strictEqual(
    transitionDelivery(first.state, {
      type: "dispatch_requested",
      at: 11,
    }).state,
    first.state,
  );
  assert.strictEqual(
    transitionDelivery(first.state, {
      type: "dispatch_retry_due",
      at: 19,
    }).state,
    first.state,
  );

  const retried = transitionDelivery(first.state, {
    type: "dispatch_retry_due",
    at: 20,
  });
  assert.equal(retried.state.phase, "dispatching");
  assert.equal(retried.state.dispatchAttempt, 2);
  assert.deepEqual(retried.effects, [{ type: "dispatch", attempt: 2 }]);

  const exhausted = transitionDelivery(retried.state, {
    type: "dispatch_clean_prewrite_failed",
    at: 30,
    retryAt: 40,
    safeErrorCode: "CLEAN_PREWRITE",
  });
  terminal(exhausted.state, "failed");
  assert.equal(
    exhausted.effects.some((effect) =>
      effect.type.includes("schedule_dispatch_retry"),
    ),
    false,
  );

  const ambiguous = transitionDelivery(started(), {
    type: "dispatch_ambiguous",
    at: 10,
    safeErrorCode: "WRITE_OUTCOME_AMBIGUOUS",
  });
  assert.equal(ambiguous.state.phase, "awaiting_terminal");
  assert.equal(ambiguous.state.writeEvidence, "transport_uncertain");
  assert.equal(
    ambiguous.effects.some((effect) => effect.type.includes("retry")),
    false,
  );
  terminal(
    step(ambiguous.state, {
      type: "provider_released",
      observedAt: 20,
    }),
    "delivered",
  );
  terminal(
    step(ambiguous.state, { type: "deadline_due", at: DEADLINE_AT }),
    "ambiguous",
  );
});

test("stall is orthogonal to phase and emitted once", () => {
  const state = written();
  assert.strictEqual(
    transitionDelivery(state, { type: "stall_due", at: STALL_AT - 1 })
      .state,
    state,
  );
  const stalled = transitionDelivery(state, {
    type: "stall_due",
    at: STALL_AT,
  });
  assert.equal(stalled.state.phase, "transport_written");
  assert.equal(stalled.state.stall, "emitted");
  assert.deepEqual(stalled.effects, [
    { type: "publish_stall", pendingForMs: STALL_AT },
  ]);
  assert.strictEqual(
    transitionDelivery(stalled.state, {
      type: "stall_due",
      at: STALL_AT + 1,
    }).state,
    stalled.state,
  );
  assert.equal(projectDelivery(stalled.state, 75).publicState, "stalled");
  assert.equal(projectDelivery(stalled.state, 75).pendingForMs, 75);
});

test("native receipt notification is a child machine with clean-prewrite-only retry", () => {
  const delivered = terminal(
    step(started(machine({ nativeReceipt: true })), {
      type: "provider_released",
      observedAt: 20,
    }),
    "delivered",
  );
  assert.equal(delivered.nativeReceipt.phase, "sending");

  const cleanFailure = transitionDelivery(delivered, {
    type: "native_receipt_clean_prewrite_failed",
    at: 21,
    retryAt: 30,
  });
  assert.equal(cleanFailure.state.nativeReceipt.phase, "retry_wait");
  assert.deepEqual(cleanFailure.effects, [
    { type: "schedule_native_receipt_retry", attempt: 2, retryAt: 30 },
  ]);
  assert.equal(cleanFailure.state.phase, "terminal");
  assert.equal(cleanFailure.state.outcome, "delivered");

  const retry = transitionDelivery(cleanFailure.state, {
    type: "native_receipt_retry_due",
    at: 30,
  });
  assert.equal(retry.state.nativeReceipt.phase, "sending");
  assert.deepEqual(retry.effects, [
    {
      type: "send_native_receipt",
      notification: { status: "delivered" },
      attempt: 2,
    },
  ]);

  const confirmed = transitionDelivery(retry.state, {
    type: "native_receipt_confirmed",
    at: 31,
  });
  assert.equal(confirmed.state.nativeReceipt.phase, "confirmed");
  terminal(confirmed.state, "delivered");

  const ambiguous = transitionDelivery(delivered, {
    type: "native_receipt_ambiguous",
    at: 21,
  });
  assert.equal(ambiguous.state.nativeReceipt.phase, "write_unconfirmed");
  terminal(ambiguous.state, "delivered");
  assert.deepEqual(ambiguous.effects, [
    { type: "release_native_receipt", reason: "ambiguous_write" },
  ]);
  assert.equal(
    transitionDelivery(ambiguous.state, {
      type: "native_receipt_retry_due",
      at: 30,
    }).effects.length,
    0,
  );
});

test("terminal delivery truth is absorbing while its receipt child may finish", () => {
  const delivered = terminal(
    step(started(machine({ nativeReceipt: true })), {
      type: "provider_released",
      observedAt: 20,
    }),
    "delivered",
  );
  const mainEvents: DeliveryEvent[] = [
    { type: "dispatch_requested", at: 21 },
    { type: "dispatch_retry_due", at: 21 },
    {
      type: "dispatch_clean_prewrite_failed",
      at: 21,
      retryAt: 22,
      safeErrorCode: "CLEAN_PREWRITE",
    },
    {
      type: "dispatch_ambiguous",
      at: 21,
      safeErrorCode: "AMBIGUOUS",
    },
    { type: "transport_written", observedAt: 21 },
    { type: "await_terminal", at: 21 },
    { type: "provider_held", observedAt: 21 },
    { type: "provider_released", observedAt: 21 },
    {
      type: "provider_denied",
      observedAt: 21,
      safeErrorCode: "DENIED",
    },
    {
      type: "provider_expired",
      observedAt: 21,
      safeErrorCode: "EXPIRED",
    },
    {
      type: "provider_failed",
      observedAt: 21,
      safeErrorCode: "FAILED",
    },
    { type: "stall_due", at: 60 },
    { type: "deadline_due", at: 100 },
    { type: "cancel", at: 21, safeErrorCode: "CANCELLED" },
  ];

  for (const event of mainEvents) {
    const result = transitionDelivery(delivered, event);
    assert.strictEqual(result.state, delivered);
    assert.deepEqual(result.effects, []);
  }

  const receiptConfirmed = transitionDelivery(delivered, {
    type: "native_receipt_confirmed",
    at: 21,
  }).state;
  assert.equal(receiptConfirmed.phase, "terminal");
  assert.equal(receiptConfirmed.outcome, "delivered");
  assert.equal(receiptConfirmed.terminalAt, delivered.terminalAt);
  assert.equal(receiptConfirmed.nativeReceipt.phase, "confirmed");
});

test("projections expose only required wakeups and preserve terminal truth", () => {
  const initial = machine();
  assert.deepEqual(projectDeliveryWakeups(initial), {
    stallAt: STALL_AT,
    deadlineAt: DEADLINE_AT,
  });
  const view = projectDelivery(initial, 25);
  assert.deepEqual(view, {
    phase: "queued",
    publicState: "queued",
    terminal: false,
    stalled: false,
    pendingForMs: 25,
    approvalProgress: "none",
    writeEvidence: "none",
    nativeReceiptPhase: "absent",
  });

  const settled = terminal(
    step(started(), {
      type: "provider_released",
      observedAt: 20,
    }),
    "delivered",
  );
  assert.deepEqual(projectDeliveryWakeups(settled), {});
  assert.deepEqual(projectDelivery(settled, 1_000), {
    phase: "terminal",
    publicState: "delivered",
    terminal: true,
    stalled: false,
    outcome: "delivered",
    approvalProgress: "none",
    writeEvidence: "none",
    nativeReceiptPhase: "absent",
  });
});

test("closed event/state matrix is total, deterministic, and invariant-safe", () => {
  const fixtures = eventFixtures();
  assert.deepEqual(
    [...new Set(fixtures.map((event) => event.type))].sort(),
    [...deliveryEventTypes].sort(),
  );

  const queue: DeliveryMachine[] = [
    machine(),
    machine({ nativeReceipt: true }),
  ];
  const seen = new Map<string, DeliveryMachine>();

  while (queue.length > 0) {
    const current = queue.shift();
    assert.ok(current);
    const key = JSON.stringify(current);
    if (seen.has(key)) continue;
    seen.set(key, current);
    assertMachineInvariant(current);

    for (const event of fixtures) {
      const serializedBefore: string = JSON.stringify(current);
      const first = transitionDelivery(current, event);
      const second = transitionDelivery(current, event);
      assert.deepEqual(first, second);
      assert.equal(
        JSON.stringify(current),
        serializedBefore,
        "reducer mutated its input",
      );
      assertMachineInvariant(first.state);
      for (const effect of first.effects) assertEffectInvariant(effect);
      const nextKey = JSON.stringify(first.state);
      if (!seen.has(nextKey)) queue.push(first.state);
    }

    assert.ok(seen.size < 2_000, "finite state exploration did not converge");
  }

  assert.ok(seen.size > 20, "exploration should cover meaningful state variety");
  for (const outcome of deliveryTerminalOutcomes) {
    assert.ok(
      [...seen.values()].some(
        (state) => state.phase === "terminal" && state.outcome === outcome,
      ),
      `unreachable terminal outcome: ${outcome}`,
    );
  }
});

function eventFixtures(): DeliveryEvent[] {
  return [
    { type: "dispatch_requested", at: 1 },
    { type: "dispatch_requested", at: DEADLINE_AT },
    { type: "dispatch_retry_due", at: 19 },
    { type: "dispatch_retry_due", at: 20 },
    { type: "dispatch_retry_due", at: DEADLINE_AT },
    {
      type: "dispatch_clean_prewrite_failed",
      at: 10,
      retryAt: 20,
      safeErrorCode: "CLEAN_PREWRITE",
    },
    {
      type: "dispatch_clean_prewrite_failed",
      at: 10,
      retryAt: DEADLINE_AT,
      safeErrorCode: "CLEAN_PREWRITE",
    },
    {
      type: "dispatch_ambiguous",
      at: 10,
      safeErrorCode: "WRITE_OUTCOME_AMBIGUOUS",
    },
    { type: "transport_written", observedAt: DEADLINE_AT - 1 },
    { type: "transport_written", observedAt: DEADLINE_AT },
    { type: "await_terminal", at: 20 },
    { type: "await_terminal", at: DEADLINE_AT },
    { type: "provider_held", observedAt: DEADLINE_AT - 1 },
    { type: "provider_held", observedAt: DEADLINE_AT },
    { type: "provider_released", observedAt: DEADLINE_AT - 1 },
    { type: "provider_released", observedAt: DEADLINE_AT },
    {
      type: "provider_denied",
      observedAt: DEADLINE_AT - 1,
      safeErrorCode: "PROVIDER_DENIED",
    },
    {
      type: "provider_expired",
      observedAt: DEADLINE_AT - 1,
      safeErrorCode: "PROVIDER_EXPIRED",
    },
    {
      type: "provider_failed",
      observedAt: DEADLINE_AT - 1,
      safeErrorCode: "PROVIDER_FAILED",
    },
    { type: "stall_due", at: STALL_AT - 1 },
    { type: "stall_due", at: STALL_AT },
    { type: "stall_due", at: DEADLINE_AT },
    { type: "deadline_due", at: DEADLINE_AT - 1 },
    { type: "deadline_due", at: DEADLINE_AT },
    { type: "cancel", at: 25, safeErrorCode: "DELIVERY_CANCELLED" },
    { type: "native_receipt_confirmed", at: 30 },
    {
      type: "native_receipt_clean_prewrite_failed",
      at: 30,
      retryAt: 40,
    },
    {
      type: "native_receipt_clean_prewrite_failed",
      at: 30,
      retryAt: 30,
    },
    { type: "native_receipt_retry_due", at: 39 },
    { type: "native_receipt_retry_due", at: 40 },
    { type: "native_receipt_ambiguous", at: 30 },
  ];
}

function assertMachineInvariant(state: DeliveryMachine): void {
  assert.ok(state.enqueuedAt <= state.stallAt);
  assert.ok(state.stallAt < state.deadlineAt);
  assert.ok(Number.isSafeInteger(state.dispatchAttempt));
  assert.ok(state.dispatchAttempt >= 0);
  if (state.dispatchRetryAt !== null) {
    assert.equal(state.phase, "queued");
    assert.ok(state.dispatchRetryAt < state.deadlineAt);
  }
  if (state.phase === "queued" && state.dispatchAttempt === 0) {
    assert.equal(state.writeEvidence, "none");
  }
  if (state.phase === "transport_written") {
    assert.equal(state.writeEvidence, "transport_written");
  }
  if (state.phase === "terminal") {
    assert.ok(deliveryTerminalOutcomes.includes(state.outcome));
    assert.ok(Number.isFinite(state.terminalAt));
    assert.notEqual(state.nativeReceipt.phase, "open");
  } else {
    assert.ok(deliveryPhases.includes(state.phase));
    assert.ok(
      state.nativeReceipt.phase === "absent" ||
        state.nativeReceipt.phase === "open",
    );
  }
  if (
    state.nativeReceipt.phase === "sending" ||
    state.nativeReceipt.phase === "retry_wait"
  ) {
    assert.ok(state.nativeReceipt.attempt >= 1);
  }
  if (state.nativeReceipt.phase === "retry_wait") {
    assert.ok(Number.isFinite(state.nativeReceipt.retryAt));
  }
}

const effectTypes = new Set<DeliveryEffect["type"]>([
  "dispatch",
  "schedule_dispatch_retry",
  "record_progress",
  "publish_stall",
  "settle_delivery",
  "send_native_receipt",
  "schedule_native_receipt_retry",
  "release_native_receipt",
]);

function assertEffectInvariant(effect: DeliveryEffect): void {
  assert.ok(effectTypes.has(effect.type));
  if ("attempt" in effect) assert.ok(effect.attempt >= 1);
  if ("retryAt" in effect) assert.ok(Number.isFinite(effect.retryAt));
}
