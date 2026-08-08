import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCodexRegistrationSuccessionInvariant,
  codexRegistrationSuccessionPhases,
  codexSuccessionFailurePhases,
  createCodexRegistrationSuccession,
  transitionCodexRegistrationSuccession,
  type CodexRegistrationIdentity,
  type CodexRegistrationSuccessionEffect,
  type CodexRegistrationSuccessionEvent,
  type CodexRegistrationSuccessionState,
} from "../src/gateway/codex-registration-succession.js";

const OLD = {
  alias: "codex-old",
  threadId: "thread-old",
  hostId: "this-mac",
  generation: "opaque-listener-generation-old",
} satisfies CodexRegistrationIdentity;

const NEXT = {
  alias: "codex-next",
  threadId: "thread-next",
  hostId: "this-mac",
  generation: "opaque-listener-generation-next",
} satisfies CodexRegistrationIdentity;

const LATER = {
  alias: "codex-later",
  threadId: "thread-later",
  hostId: "this-mac",
  generation: "opaque-listener-generation-later",
} satisfies CodexRegistrationIdentity;

const FAILURE = "SUCCESSION_TEST_FAILURE";

function initial(): CodexRegistrationSuccessionState {
  return createCodexRegistrationSuccession(OLD);
}

function transition(
  state: CodexRegistrationSuccessionState,
  event: CodexRegistrationSuccessionEvent,
): ReturnType<typeof transitionCodexRegistrationSuccession> {
  return transitionCodexRegistrationSuccession(state, event);
}

function step(
  state: CodexRegistrationSuccessionState,
  event: CodexRegistrationSuccessionEvent,
): CodexRegistrationSuccessionState {
  return transition(state, event).state;
}

function begun(): CodexRegistrationSuccessionState {
  return step(initial(), { type: "begin", registration: NEXT });
}

function listenerPending(): CodexRegistrationSuccessionState {
  return step(begun(), {
    type: "barrier_clean",
    generation: NEXT.generation,
  });
}

function storePending(): CodexRegistrationSuccessionState {
  return step(listenerPending(), {
    type: "listener_prepared",
    generation: NEXT.generation,
  });
}

function prepared(): CodexRegistrationSuccessionState {
  return step(storePending(), {
    type: "store_prepared",
    generation: NEXT.generation,
  });
}

function publishing(): CodexRegistrationSuccessionState {
  return step(prepared(), {
    type: "publication_armed",
    generation: NEXT.generation,
  });
}

function published(): CodexRegistrationSuccessionState {
  return step(publishing(), {
    type: "registry_published",
    generation: NEXT.generation,
  });
}

function activated(): CodexRegistrationSuccessionState {
  return step(published(), {
    type: "activate",
    generation: NEXT.generation,
  });
}

function effectTypes(
  effects: readonly CodexRegistrationSuccessionEffect[],
): string[] {
  return effects.map((effect) => effect.type);
}

test("the pure machine exposes the closed v1 phase and failure vocabularies", () => {
  assert.deepEqual(codexRegistrationSuccessionPhases, [
    "active_old",
    "freezing",
    "prepared_new",
    "published_new",
    "active_new",
    "offline_poisoned",
    "recovery_required",
  ]);
  assert.deepEqual(codexSuccessionFailurePhases, [
    "freeze",
    "barrier",
    "listener",
    "store",
    "publication_arm",
    "registry",
    "activation",
    "retirement",
    "cleanup",
  ]);
});

test("the happy path emits the required effects in strict controller order", () => {
  let state = initial();

  let result = transition(state, { type: "begin", registration: NEXT });
  assert.equal(result.state.phase, "freezing");
  assert.deepEqual(effectTypes(result.effects), [
    "freeze_old_ingress",
    "freeze_old_dispatch",
    "quiesce_and_join_old",
    "verify_full_barrier",
  ]);
  state = result.state;

  result = transition(state, {
    type: "barrier_clean",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "freezing");
  assert.deepEqual(effectTypes(result.effects), [
    "create_fresh_listener_generation",
  ]);
  state = result.state;

  result = transition(state, {
    type: "listener_prepared",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "freezing");
  assert.deepEqual(effectTypes(result.effects), [
    "purge_old_conversations",
    "purge_old_reply_capabilities",
    "prepare_new_store",
  ]);
  state = result.state;

  result = transition(state, {
    type: "store_prepared",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "prepared_new");
  assert.equal(
    result.state.phase === "prepared_new" ? result.state.stage : undefined,
    "publication_arming",
  );
  assert.deepEqual(effectTypes(result.effects), ["arm_publication_journal"]);
  state = result.state;

  result = transition(state, {
    type: "publication_armed",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "prepared_new");
  assert.equal(
    result.state.phase === "prepared_new" ? result.state.stage : undefined,
    "registry_publishing",
  );
  assert.deepEqual(effectTypes(result.effects), ["publish_new_registry"]);
  state = result.state;

  result = transition(state, {
    type: "registry_published",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "published_new");
  assert.deepEqual(effectTypes(result.effects), [
    "activate_new_registration",
  ]);
  state = result.state;

  result = transition(state, {
    type: "activate",
    generation: NEXT.generation,
  });
  assert.equal(result.state.phase, "active_new");
  assert.deepEqual(effectTypes(result.effects), [
    "retire_old_generation",
    "close_old_listener",
  ]);
  const close = result.effects.find(
    (effect) => effect.type === "close_old_listener",
  );
  assert.deepEqual(
    close?.type === "close_old_listener" ? close.registryUnlink : undefined,
    {
      onlyIfOwnedGeneration: OLD.generation,
      protectedActiveGeneration: NEXT.generation,
    },
  );
  assert.deepEqual(
    result.state.phase === "active_new" ? result.state.retired : undefined,
    OLD,
  );

  const cleaned = transition(result.state, {
    type: "cleanup_confirmed",
    generation: NEXT.generation,
  });
  assert.equal(cleaned.state.phase, "active_new");
  assert.equal(
    cleaned.state.phase === "active_new" ? cleaned.state.retired : undefined,
    null,
  );
  assert.deepEqual(cleaned.effects, []);
});

test("barrier busy fails fast and restores the old registration only after cleanup", () => {
  const busy = transition(begun(), {
    type: "barrier_busy",
    generation: NEXT.generation,
    safeErrorCode: "SUCCESSION_BARRIER_BUSY",
  });
  assert.equal(busy.state.phase, "recovery_required");
  assert.equal(
    busy.state.phase === "recovery_required" ? busy.state.rollback : undefined,
    "old_allowed",
  );
  assert.deepEqual(effectTypes(busy.effects), [
    "cleanup_unpublished_generation",
  ]);

  const restored = transition(busy.state, {
    type: "cleanup_confirmed",
    generation: NEXT.generation,
  });
  assert.equal(restored.state.phase, "active_old");
  assert.deepEqual(
    restored.state.phase === "active_old" ? restored.state.active : undefined,
    OLD,
  );
  assert.deepEqual(effectTypes(restored.effects), [
    "resume_old_ingress",
    "resume_old_dispatch",
  ]);
});

test("phase-specific failures recover before arming and poison once arming begins", () => {
  const cleanCases = [
    { state: begun(), phase: "freeze" },
    { state: begun(), phase: "barrier" },
    { state: listenerPending(), phase: "listener" },
    { state: storePending(), phase: "store" },
  ] as const;

  for (const candidate of cleanCases) {
    const failed = transition(candidate.state, {
      type: "phase_failed",
      generation: NEXT.generation,
      phase: candidate.phase,
      safeErrorCode: FAILURE,
    });
    assert.equal(failed.state.phase, "recovery_required", candidate.phase);
    assert.equal(
      failed.state.phase === "recovery_required"
        ? failed.state.rollback
        : undefined,
      "old_allowed",
      candidate.phase,
    );
  }

  const armFailure = transition(prepared(), {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "publication_arm",
    safeErrorCode: FAILURE,
  });
  assert.equal(armFailure.state.phase, "offline_poisoned");

  const registryFailure = transition(publishing(), {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "registry",
    safeErrorCode: "REGISTRY_WRITE_OUTCOME_UNKNOWN",
  });
  assert.equal(registryFailure.state.phase, "offline_poisoned");
  assert.equal(
    registryFailure.state.phase === "offline_poisoned"
      ? registryFailure.state.rollback
      : undefined,
    "forbidden",
  );
  assert.deepEqual(effectTypes(registryFailure.effects), [
    "poison_new_generation",
    "take_registrations_offline",
    "cleanup_poisoned_generations",
  ]);

  for (const armedState of [prepared(), publishing()]) {
    const provenAbsent = transition(armedState, {
      type: "publication_absence_confirmed",
      generation: NEXT.generation,
    });
    assert.equal(provenAbsent.state.phase, "recovery_required");
    assert.equal(
      provenAbsent.state.phase === "recovery_required"
        ? provenAbsent.state.rollback
        : undefined,
      "old_allowed",
    );
  }
});

test("abort while journal arming or registry publication is in flight never rolls back", () => {
  for (const armedState of [prepared(), publishing()]) {
    const aborted = transition(armedState, {
      type: "abort",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_ABORTED",
    });
    assert.equal(aborted.state.phase, "offline_poisoned");
    assert.equal(
      aborted.state.phase === "offline_poisoned"
        ? aborted.state.rollback
        : undefined,
      "forbidden",
    );
  }
});

test("positive durable absence can recover after an armed abort or error, but never after known publication", () => {
  const armedAbort = step(prepared(), {
    type: "abort",
    generation: NEXT.generation,
    safeErrorCode: "SUCCESSION_ABORTED",
  });
  const registryError = step(publishing(), {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "registry",
    safeErrorCode: "REGISTRY_WRITE_OUTCOME_UNKNOWN",
  });

  for (const uncertain of [armedAbort, registryError]) {
    assert.equal(uncertain.phase, "offline_poisoned");
    const provenAbsent = transition(uncertain, {
      type: "publication_absence_confirmed",
      generation: NEXT.generation,
    });
    assert.equal(provenAbsent.state.phase, "recovery_required");
    assert.equal(
      provenAbsent.state.phase === "recovery_required"
        ? provenAbsent.state.rollback
        : undefined,
      "old_allowed",
    );
    const restored = step(provenAbsent.state, {
      type: "cleanup_confirmed",
      generation: NEXT.generation,
    });
    assert.equal(restored.phase, "active_old");
  }

  const knownPublishedAbort = step(published(), {
    type: "abort",
    generation: NEXT.generation,
    safeErrorCode: "SUCCESSION_ABORTED",
  });
  const contradiction = transition(knownPublishedAbort, {
    type: "publication_absence_confirmed",
    generation: NEXT.generation,
  });
  assert.equal(contradiction.state, knownPublishedAbort);
  assert.deepEqual(contradiction.effects, []);
});

test("activation, retirement, and post-publication abort failures never roll back", () => {
  const activationFailure = transition(published(), {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "activation",
    safeErrorCode: FAILURE,
  });
  assert.equal(activationFailure.state.phase, "offline_poisoned");

  const retirementFailure = transition(activated(), {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "retirement",
    safeErrorCode: FAILURE,
  });
  assert.equal(retirementFailure.state.phase, "offline_poisoned");

  const aborted = transition(published(), {
    type: "abort",
    generation: NEXT.generation,
    safeErrorCode: "SUCCESSION_ABORTED",
  });
  assert.equal(aborted.state.phase, "offline_poisoned");

  for (const poisoned of [activationFailure.state, retirementFailure.state, aborted.state]) {
    const cleaned = transition(poisoned, {
      type: "cleanup_confirmed",
      generation: NEXT.generation,
    });
    assert.equal(cleaned.state.phase, "recovery_required");
    assert.equal(
      cleaned.state.phase === "recovery_required"
        ? cleaned.state.rollback
        : undefined,
      "forbidden",
    );
    assert.deepEqual(effectTypes(cleaned.effects), [
      "manual_recovery_required",
    ]);

    const repeated = transition(cleaned.state, {
      type: "cleanup_confirmed",
      generation: NEXT.generation,
    });
    assert.equal(repeated.state, cleaned.state);
    assert.deepEqual(repeated.effects, []);
  }
});

test("cleanup failure stays offline and preserves whether old rollback is still legal", () => {
  const recovering = step(begun(), {
    type: "abort",
    generation: NEXT.generation,
    safeErrorCode: "SUCCESSION_ABORTED",
  });
  const failedCleanup = transition(recovering, {
    type: "phase_failed",
    generation: NEXT.generation,
    phase: "cleanup",
    safeErrorCode: "SUCCESSION_CLEANUP_FAILED",
  });
  assert.equal(failedCleanup.state.phase, "offline_poisoned");
  assert.equal(
    failedCleanup.state.phase === "offline_poisoned"
      ? failedCleanup.state.rollback
      : undefined,
    "old_allowed",
  );

  const cleaned = transition(failedCleanup.state, {
    type: "cleanup_confirmed",
    generation: NEXT.generation,
  });
  assert.equal(cleaned.state.phase, "active_old");
  assert.deepEqual(
    cleaned.state.phase === "active_old" ? cleaned.state.active : undefined,
    OLD,
  );
});

test("restart evidence is fail-closed after arming and recovers only on positive absence", () => {
  const persistedArming = JSON.parse(
    JSON.stringify(prepared()),
  ) as CodexRegistrationSuccessionState;
  const persistedPublishing = JSON.parse(
    JSON.stringify(publishing()),
  ) as CodexRegistrationSuccessionState;

  for (const persisted of [persistedArming, persistedPublishing]) {
    const absent = transition(persisted, {
      type: "restart_evidence",
      generation: NEXT.generation,
      publication: "absent",
      safeErrorCode: "RESTART_PUBLICATION_ABSENT",
    });
    assert.equal(absent.state.phase, "recovery_required");
    assert.equal(
      absent.state.phase === "recovery_required"
        ? absent.state.rollback
        : undefined,
      "old_allowed",
    );

    for (const publication of ["armed", "published", "unknown"] as const) {
      const unsafe = transition(persisted, {
        type: "restart_evidence",
        generation: NEXT.generation,
        publication,
        safeErrorCode: "RESTART_PUBLICATION_NOT_ABSENT",
      });
      assert.equal(unsafe.state.phase, "offline_poisoned", publication);
      assert.equal(
        unsafe.state.phase === "offline_poisoned"
          ? unsafe.state.rollback
          : undefined,
        "forbidden",
        publication,
      );
    }
  }

  const contradictoryAbsence = transition(published(), {
    type: "restart_evidence",
    generation: NEXT.generation,
    publication: "absent",
    safeErrorCode: "RESTART_STATE_CONTRADICTION",
  });
  assert.equal(contradictoryAbsence.state.phase, "offline_poisoned");
  assert.equal(
    contradictoryAbsence.state.phase === "offline_poisoned"
      ? contradictoryAbsence.state.rollback
      : undefined,
    "forbidden",
  );

  const preArm = transition(storePending(), {
    type: "restart_evidence",
    generation: NEXT.generation,
    publication: "absent",
    safeErrorCode: "RESTART_BEFORE_ARM",
  });
  assert.equal(preArm.state.phase, "recovery_required");
  assert.equal(
    preArm.state.phase === "recovery_required" ? preArm.state.rollback : undefined,
    "old_allowed",
  );
});

test("identity validation requires a distinct alias, thread, host-local fresh generation", () => {
  const invalid = [
    { ...NEXT, alias: OLD.alias },
    { ...NEXT, threadId: OLD.threadId },
    { ...NEXT, hostId: "another-mac" },
    { ...NEXT, generation: OLD.generation },
  ] satisfies CodexRegistrationIdentity[];

  for (const registration of invalid) {
    assert.throws(() =>
      transition(initial(), { type: "begin", registration }),
    );
  }
  assert.throws(
    () => createCodexRegistrationSuccession({ ...OLD, generation: " bad" }),
    /bounded opaque generation grammar/,
  );
  for (const generation of ["with.dot", "with:colon", "x".repeat(33)]) {
    assert.throws(
      () => createCodexRegistrationSuccession({ ...OLD, generation }),
      /bounded opaque generation grammar/,
    );
  }

  const mutable = { ...NEXT };
  const result = transition(initial(), { type: "begin", registration: mutable });
  mutable.generation = "mutated-after-begin";
  assert.equal(
    result.state.phase === "freezing"
      ? result.state.newRegistration.generation
      : undefined,
    NEXT.generation,
  );
});

test("all follow-up events are fenced to the immutable exact new generation", () => {
  const state = begun();
  const staleEvents = [
    { type: "barrier_clean", generation: OLD.generation },
    {
      type: "barrier_busy",
      generation: LATER.generation,
      safeErrorCode: FAILURE,
    },
    { type: "listener_prepared", generation: OLD.generation },
    { type: "store_prepared", generation: OLD.generation },
    { type: "publication_armed", generation: OLD.generation },
    { type: "publication_absence_confirmed", generation: OLD.generation },
    { type: "registry_published", generation: OLD.generation },
    { type: "activate", generation: OLD.generation },
    { type: "cleanup_confirmed", generation: OLD.generation },
    {
      type: "abort",
      generation: OLD.generation,
      safeErrorCode: FAILURE,
    },
  ] satisfies CodexRegistrationSuccessionEvent[];

  for (const event of staleEvents) {
    const ignored = transition(state, event);
    assert.equal(ignored.state, state);
    assert.deepEqual(ignored.effects, []);
  }
});

test("one retired generation is the structural maximum", () => {
  const state = activated();
  assert.equal(state.phase, "active_new");
  assert.notEqual(state.phase === "active_new" ? state.retired : null, null);

  const blocked = transition(state, { type: "begin", registration: LATER });
  assert.equal(blocked.state, state);
  assert.deepEqual(blocked.effects, []);

  const cleaned = step(state, {
    type: "cleanup_confirmed",
    generation: NEXT.generation,
  });
  const allowed = transition(cleaned, { type: "begin", registration: LATER });
  assert.equal(allowed.state.phase, "freezing");
  assert.equal(
    allowed.state.phase === "freezing"
      ? allowed.state.oldRegistration.generation
      : undefined,
    NEXT.generation,
  );
});

test("the transition table is deterministic and every declared phase is BFS-reachable", () => {
  const events: CodexRegistrationSuccessionEvent[] = [
    { type: "begin", registration: NEXT },
    { type: "begin", registration: LATER },
    { type: "barrier_clean", generation: NEXT.generation },
    {
      type: "barrier_busy",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_BARRIER_BUSY",
    },
    { type: "listener_prepared", generation: NEXT.generation },
    { type: "store_prepared", generation: NEXT.generation },
    { type: "publication_armed", generation: NEXT.generation },
    {
      type: "publication_absence_confirmed",
      generation: NEXT.generation,
    },
    { type: "registry_published", generation: NEXT.generation },
    { type: "activate", generation: NEXT.generation },
    { type: "cleanup_confirmed", generation: NEXT.generation },
    {
      type: "abort",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_ABORTED",
    },
    {
      type: "restart_evidence",
      generation: NEXT.generation,
      publication: "absent",
      safeErrorCode: "RESTART_PUBLICATION_ABSENT",
    },
    {
      type: "restart_evidence",
      generation: NEXT.generation,
      publication: "unknown",
      safeErrorCode: "RESTART_PUBLICATION_UNKNOWN",
    },
  ];
  for (const phase of codexSuccessionFailurePhases) {
    events.push({
      type: "phase_failed",
      phase,
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    });
  }

  const queue: Array<{ state: CodexRegistrationSuccessionState; depth: number }> = [
    { state: initial(), depth: 0 },
  ];
  const seen = new Set<string>();
  const reachedPhases = new Set<string>();
  let transitionsChecked = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    assert.ok(item);
    const key = JSON.stringify(item.state);
    if (seen.has(key)) continue;
    seen.add(key);
    reachedPhases.add(item.state.phase);
    assertCodexRegistrationSuccessionInvariant(item.state);
    assert.doesNotMatch(key, /messageBody|conversationBody|replyCapability/u);

    for (const event of events) {
      let first: ReturnType<typeof transitionCodexRegistrationSuccession>;
      let second: ReturnType<typeof transitionCodexRegistrationSuccession>;
      try {
        first = transition(item.state, event);
        second = transition(item.state, event);
      } catch (firstError) {
        assert.throws(
          () => transition(item.state, event),
          (secondError: unknown) =>
            secondError instanceof Error &&
            firstError instanceof Error &&
            secondError.constructor === firstError.constructor &&
            secondError.message === firstError.message,
        );
        continue;
      }
      transitionsChecked += 1;
      assert.deepEqual(second, first);
      assertCodexRegistrationSuccessionInvariant(first.state);
      if (item.depth < 8) {
        queue.push({ state: first.state, depth: item.depth + 1 });
      }
    }
  }

  assert.ok(transitionsChecked > 100);
  assert.deepEqual(
    [...reachedPhases].sort(),
    [...codexRegistrationSuccessionPhases].sort(),
  );
});

test("BFS from registry publication cannot restore the old registration", () => {
  const events: readonly CodexRegistrationSuccessionEvent[] = [
    { type: "activate", generation: NEXT.generation },
    { type: "cleanup_confirmed", generation: NEXT.generation },
    {
      type: "abort",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_ABORTED",
    },
    {
      type: "phase_failed",
      phase: "activation",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "phase_failed",
      phase: "retirement",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "phase_failed",
      phase: "cleanup",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    { type: "begin", registration: LATER },
  ];
  const queue: Array<{ state: CodexRegistrationSuccessionState; depth: number }> = [
    { state: published(), depth: 0 },
  ];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    assert.ok(item);
    const key = JSON.stringify(item.state);
    if (seen.has(key)) continue;
    seen.add(key);

    if (item.state.phase === "active_old" || item.state.phase === "active_new") {
      assert.notEqual(item.state.active.generation, OLD.generation);
    }
    if (item.state.phase === "recovery_required") {
      assert.equal(item.state.rollback, "forbidden");
    }

    if (item.depth >= 7) continue;
    for (const event of events) {
      let next: CodexRegistrationSuccessionState;
      try {
        next = step(item.state, event);
      } catch {
        continue;
      }
      queue.push({ state: next, depth: item.depth + 1 });
    }
  }
  assert.ok(seen.size > 3);
});

test("BFS from publication arming cannot roll back without positive absence evidence", () => {
  const events: readonly CodexRegistrationSuccessionEvent[] = [
    { type: "publication_armed", generation: NEXT.generation },
    { type: "registry_published", generation: NEXT.generation },
    { type: "activate", generation: NEXT.generation },
    { type: "cleanup_confirmed", generation: NEXT.generation },
    {
      type: "abort",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_ABORTED",
    },
    {
      type: "phase_failed",
      phase: "publication_arm",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "phase_failed",
      phase: "registry",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "phase_failed",
      phase: "activation",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "phase_failed",
      phase: "retirement",
      generation: NEXT.generation,
      safeErrorCode: FAILURE,
    },
    {
      type: "restart_evidence",
      generation: NEXT.generation,
      publication: "armed",
      safeErrorCode: "RESTART_PUBLICATION_ARMED",
    },
    {
      type: "restart_evidence",
      generation: NEXT.generation,
      publication: "unknown",
      safeErrorCode: "RESTART_PUBLICATION_UNKNOWN",
    },
  ];
  const queue: Array<{ state: CodexRegistrationSuccessionState; depth: number }> = [
    { state: prepared(), depth: 0 },
  ];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    assert.ok(item);
    const key = JSON.stringify(item.state);
    if (seen.has(key)) continue;
    seen.add(key);

    if (item.state.phase === "active_old" || item.state.phase === "active_new") {
      assert.notEqual(item.state.active.generation, OLD.generation);
    }
    if (item.state.phase === "recovery_required") {
      assert.equal(item.state.rollback, "forbidden");
    }

    if (item.depth >= 8) continue;
    for (const event of events) {
      queue.push({
        state: step(item.state, event),
        depth: item.depth + 1,
      });
    }
  }
  assert.ok(seen.size > 5);
});

test("the effect vocabulary purges old capabilities and contains no transfer operation", () => {
  const effectNames = new Set<string>();
  const states = [
    initial(),
    begun(),
    listenerPending(),
    storePending(),
    prepared(),
    publishing(),
    published(),
    activated(),
  ];
  const events: readonly CodexRegistrationSuccessionEvent[] = [
    { type: "begin", registration: NEXT },
    { type: "barrier_clean", generation: NEXT.generation },
    { type: "listener_prepared", generation: NEXT.generation },
    { type: "store_prepared", generation: NEXT.generation },
    { type: "publication_armed", generation: NEXT.generation },
    { type: "registry_published", generation: NEXT.generation },
    { type: "activate", generation: NEXT.generation },
    { type: "cleanup_confirmed", generation: NEXT.generation },
    {
      type: "abort",
      generation: NEXT.generation,
      safeErrorCode: "SUCCESSION_ABORTED",
    },
  ];
  for (const state of states) {
    for (const event of events) {
      try {
        for (const effect of transition(state, event).effects) {
          effectNames.add(effect.type);
        }
      } catch {
        // Invalid cross-table begin rows are covered by identity tests.
      }
    }
  }
  assert.ok(effectNames.has("purge_old_conversations"));
  assert.ok(effectNames.has("purge_old_reply_capabilities"));
  assert.doesNotMatch([...effectNames].join(" "), /transfer|migrate|copy/u);
});
