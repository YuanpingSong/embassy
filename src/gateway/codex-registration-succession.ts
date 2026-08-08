import { assertCodexRegistrationGeneration } from "./codex-registration-generation.js";

/**
 * Pure lifecycle for replacing one registered Codex task with another.
 *
 * The reducer owns no sockets, registry files, message bodies, conversations,
 * timers, or provider clients. A controller executes the returned effects and
 * feeds the resulting observations back as events. Listener generations are
 * deliberately opaque; this module never derives a socket path or assumes a
 * suffixed-socket naming scheme.
 *
 * Publication arming is the conservative irreversible boundary: the reducer
 * enters it before emitting any durable-journal or registry-write effect.
 * Cleanup may restore the old registration only before arming, or after a
 * controller positively proves that neither the arm nor registry write was
 * persisted. At or after any armed/published/unknown observation, the old
 * registration can never be restored by this machine.
 */

export const codexRegistrationSuccessionPhases = [
  "active_old",
  "freezing",
  "prepared_new",
  "published_new",
  "active_new",
  "offline_poisoned",
  "recovery_required",
  "resuming_old",
] as const;

export type CodexRegistrationSuccessionPhase =
  (typeof codexRegistrationSuccessionPhases)[number];

export type CodexRegistrationIdentity = Readonly<{
  alias: string;
  threadId: string;
  hostId: string;
  generation: string;
}>;

type StablePhase = "active_old" | "active_new";
type FreezingStage =
  | "barrier_pending"
  | "listener_pending"
  | "store_pending";
type PublicationBoundary =
  | "not_armed"
  | "armed_or_unknown"
  | "published";

export const codexSuccessionFailurePhases = [
  "freeze",
  "barrier",
  "listener",
  "store",
  "publication_arm",
  "registry",
  "activation",
  "retirement",
  "cleanup",
  "resume",
] as const;

export type CodexSuccessionFailurePhase =
  (typeof codexSuccessionFailurePhases)[number];

type SuccessionContext = Readonly<{
  oldRegistration: CodexRegistrationIdentity;
  newRegistration: CodexRegistrationIdentity;
  priorStablePhase: StablePhase;
}>;

export type ActiveOldSuccessionState = Readonly<{
  phase: "active_old";
  active: CodexRegistrationIdentity;
}>;

export type ActiveNewSuccessionState = Readonly<{
  phase: "active_new";
  active: CodexRegistrationIdentity;
  /** At most one prior listener generation may await confirmed retirement. */
  retired: CodexRegistrationIdentity | null;
}>;

export type FreezingSuccessionState = SuccessionContext &
  Readonly<{
    phase: "freezing";
    stage: FreezingStage;
  }>;

export type PreparedNewSuccessionState = SuccessionContext &
  Readonly<{
    phase: "prepared_new";
    /**
     * `publication_arming` begins the rollback-forbidden window before the
     * durable journal effect is executed. `registry_publishing` means the arm
     * was confirmed and the registry write may be in flight.
     */
    stage: "publication_arming" | "registry_publishing";
  }>;

export type PublishedNewSuccessionState = SuccessionContext &
  Readonly<{
    phase: "published_new";
  }>;

export type OfflinePoisonedSuccessionState = SuccessionContext &
  Readonly<{
    phase: "offline_poisoned";
    failedPhase: CodexSuccessionFailurePhase | "abort" | "barrier_busy";
    safeErrorCode: string;
    rollback: "old_allowed" | "forbidden";
    publicationBoundary: PublicationBoundary;
  }>;

export type RecoveryRequiredSuccessionState = SuccessionContext &
  Readonly<{
    phase: "recovery_required";
    failedPhase: CodexSuccessionFailurePhase | "abort" | "barrier_busy";
    safeErrorCode: string;
    rollback: "old_allowed" | "forbidden";
    publicationBoundary: PublicationBoundary;
  }>;

export type ResumingOldSuccessionState = SuccessionContext &
  Readonly<{
    phase: "resuming_old";
    failedPhase: CodexSuccessionFailurePhase | "abort" | "barrier_busy";
    safeErrorCode: string;
  }>;

export type CodexRegistrationSuccessionState =
  | ActiveOldSuccessionState
  | ActiveNewSuccessionState
  | FreezingSuccessionState
  | PreparedNewSuccessionState
  | PublishedNewSuccessionState
  | OfflinePoisonedSuccessionState
  | RecoveryRequiredSuccessionState
  | ResumingOldSuccessionState;

type CorrelatedEvent = Readonly<{ generation: string }>;

export type CodexRegistrationSuccessionEvent =
  | Readonly<{
      type: "begin";
      registration: CodexRegistrationIdentity;
    }>
  | (CorrelatedEvent & Readonly<{ type: "barrier_clean" }>)
  | (CorrelatedEvent &
      Readonly<{ type: "barrier_busy"; safeErrorCode: string }>)
  | (CorrelatedEvent & Readonly<{ type: "listener_prepared" }>)
  | (CorrelatedEvent & Readonly<{ type: "store_prepared" }>)
  | (CorrelatedEvent & Readonly<{ type: "publication_armed" }>)
  | (CorrelatedEvent & Readonly<{ type: "publication_absence_confirmed" }>)
  | (CorrelatedEvent & Readonly<{ type: "registry_published" }>)
  | (CorrelatedEvent & Readonly<{ type: "activate" }>)
  | (CorrelatedEvent & Readonly<{ type: "cleanup_confirmed" }>)
  | (CorrelatedEvent & Readonly<{ type: "resume_confirmed" }>)
  | (CorrelatedEvent &
      Readonly<{
        type: "abort";
        safeErrorCode: string;
      }>)
  | (CorrelatedEvent &
      Readonly<{
        type: "phase_failed";
        phase: CodexSuccessionFailurePhase;
        safeErrorCode: string;
      }>)
  | (CorrelatedEvent &
      Readonly<{
        type: "restart_evidence";
        publication: "absent" | "armed" | "published" | "unknown";
        safeErrorCode: string;
      }>);

export type CodexRegistrationSuccessionEffect =
  | Readonly<{
      type: "freeze_old_ingress";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "freeze_old_dispatch";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "quiesce_and_join_old";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "verify_full_barrier";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "create_fresh_listener_generation";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "purge_old_conversations";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "purge_old_reply_capabilities";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "prepare_new_store";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      /**
       * Persist the irreversible publication intent. The controller must
       * durably save the returned `publication_arming` machine state before
       * executing this effect.
       */
      type: "arm_publication_journal";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "publish_new_registry";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "activate_new_registration";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "retire_old_generation";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "close_old_listener";
      registration: CodexRegistrationIdentity;
      /**
       * Registry cleanup is a generation-owned compare-and-delete. It may
       * unlink only the retired record and must preserve the active record.
       */
      registryUnlink: Readonly<{
        onlyIfOwnedGeneration: string;
        protectedActiveGeneration: string;
      }>;
    }>
  | Readonly<{
      type: "cleanup_unpublished_generation";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "resume_old_ingress";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "resume_old_dispatch";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "poison_new_generation";
      registration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "take_registrations_offline";
      oldRegistration: CodexRegistrationIdentity;
      newRegistration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "cleanup_poisoned_generations";
      oldRegistration: CodexRegistrationIdentity;
      newRegistration: CodexRegistrationIdentity;
    }>
  | Readonly<{
      type: "manual_recovery_required";
      registration: CodexRegistrationIdentity;
      safeErrorCode: string;
    }>;

export type CodexRegistrationSuccessionTransition = Readonly<{
  state: CodexRegistrationSuccessionState;
  effects: readonly CodexRegistrationSuccessionEffect[];
}>;

export function createCodexRegistrationSuccession(
  active: CodexRegistrationIdentity,
): ActiveOldSuccessionState {
  const registration = copyAndValidateIdentity(active, "active");
  return { phase: "active_old", active: registration };
}

export function transitionCodexRegistrationSuccession(
  state: CodexRegistrationSuccessionState,
  event: CodexRegistrationSuccessionEvent,
): CodexRegistrationSuccessionTransition {
  assertCodexRegistrationSuccessionInvariant(state);

  if (event.type === "begin") {
    return beginSuccession(state, event.registration);
  }

  const context = successionContext(state);
  if (context === null || event.generation !== context.newRegistration.generation) {
    return unchanged(state);
  }

  switch (event.type) {
    case "barrier_clean":
      if (state.phase !== "freezing" || state.stage !== "barrier_pending") {
        return unchanged(state);
      }
      return checked({
        state: { ...state, stage: "listener_pending" },
        effects: [
          {
            type: "create_fresh_listener_generation",
            registration: state.newRegistration,
          },
        ],
      });

    case "barrier_busy":
      if (state.phase !== "freezing" || state.stage !== "barrier_pending") {
        return unchanged(state);
      }
      return prepublicationRecovery(
        state,
        "barrier_busy",
        event.safeErrorCode,
      );

    case "listener_prepared":
      if (state.phase !== "freezing" || state.stage !== "listener_pending") {
        return unchanged(state);
      }
      return checked({
        state: { ...state, stage: "store_pending" },
        effects: [
          {
            type: "purge_old_conversations",
            registration: state.oldRegistration,
          },
          {
            type: "purge_old_reply_capabilities",
            registration: state.oldRegistration,
          },
          {
            type: "prepare_new_store",
            registration: state.newRegistration,
          },
        ],
      });

    case "store_prepared":
      if (state.phase !== "freezing" || state.stage !== "store_pending") {
        return unchanged(state);
      }
      return checked({
        state: preparedState("publication_arming", state),
        effects: [
          {
            type: "arm_publication_journal",
            registration: state.newRegistration,
          },
        ],
      });

    case "publication_armed":
      if (
        state.phase !== "prepared_new" ||
        state.stage !== "publication_arming"
      ) {
        return unchanged(state);
      }
      return checked({
        state: preparedState("registry_publishing", state),
        effects: [
          {
            type: "publish_new_registry",
            registration: state.newRegistration,
          },
        ],
      });

    case "publication_absence_confirmed":
      return publicationAbsenceConfirmed(state);

    case "registry_published":
      if (
        state.phase !== "prepared_new" ||
        state.stage !== "registry_publishing"
      ) {
        return unchanged(state);
      }
      return checked({
        state: contextState("published_new", state),
        effects: [
          {
            type: "activate_new_registration",
            registration: state.newRegistration,
          },
        ],
      });

    case "activate":
      if (state.phase !== "published_new") return unchanged(state);
      return checked({
        state: {
          phase: "active_new",
          active: state.newRegistration,
          retired: state.oldRegistration,
        },
        effects: [
          {
            type: "retire_old_generation",
            registration: state.oldRegistration,
          },
          {
            type: "close_old_listener",
            registration: state.oldRegistration,
            registryUnlink: {
              onlyIfOwnedGeneration: state.oldRegistration.generation,
              protectedActiveGeneration: state.newRegistration.generation,
            },
          },
        ],
      });

    case "cleanup_confirmed":
      return cleanupConfirmed(state);

    case "resume_confirmed":
      return resumeConfirmed(state);

    case "abort":
      return abortSuccession(state, event.safeErrorCode);

    case "phase_failed":
      return phaseFailed(state, event);

    case "restart_evidence":
      return restartEvidence(state, event);
  }
}

/**
 * Runtime assertion for controller boundaries and exhaustive state-machine
 * tests. It intentionally validates identities without interpreting their
 * opaque generation strings.
 */
export function assertCodexRegistrationSuccessionInvariant(
  state: CodexRegistrationSuccessionState,
): void {
  switch (state.phase) {
    case "active_old":
      validateIdentity(state.active, "active");
      return;
    case "active_new":
      validateIdentity(state.active, "active");
      if (state.retired !== null) {
        validateIdentity(state.retired, "retired");
        assertSuccessor(state.retired, state.active);
      }
      return;
    case "freezing":
      if (
        state.stage !== "barrier_pending" &&
        state.stage !== "listener_pending" &&
        state.stage !== "store_pending"
      ) {
        throw new TypeError("Unknown Codex succession freezing stage.");
      }
      assertContext(state);
      return;
    case "prepared_new":
      if (
        state.stage !== "publication_arming" &&
        state.stage !== "registry_publishing"
      ) {
        throw new TypeError("Unknown Codex succession publication stage.");
      }
      assertContext(state);
      return;
    case "published_new":
      assertContext(state);
      return;
    case "offline_poisoned":
    case "recovery_required":
      assertContext(state);
      validateSafeErrorCode(state.safeErrorCode);
      if (state.rollback !== "old_allowed" && state.rollback !== "forbidden") {
        throw new TypeError("Unknown Codex succession rollback disposition.");
      }
      if (
        state.publicationBoundary !== "not_armed" &&
        state.publicationBoundary !== "armed_or_unknown" &&
        state.publicationBoundary !== "published"
      ) {
        throw new TypeError("Unknown Codex succession publication boundary.");
      }
      if (
        (state.rollback === "old_allowed") !==
        (state.publicationBoundary === "not_armed")
      ) {
        throw new TypeError(
          "Codex succession rollback must agree with publication evidence.",
        );
      }
      return;
    case "resuming_old":
      assertContext(state);
      validateSafeErrorCode(state.safeErrorCode);
      return;
  }
}

function beginSuccession(
  state: CodexRegistrationSuccessionState,
  requested: CodexRegistrationIdentity,
): CodexRegistrationSuccessionTransition {
  if (state.phase !== "active_old" && state.phase !== "active_new") {
    return unchanged(state);
  }
  if (state.phase === "active_new" && state.retired !== null) {
    // A second succession cannot create a second retired generation.
    return unchanged(state);
  }

  const newRegistration = copyAndValidateIdentity(requested, "new");
  assertSuccessor(state.active, newRegistration);
  const next: FreezingSuccessionState = {
    phase: "freezing",
    stage: "barrier_pending",
    oldRegistration: state.active,
    newRegistration,
    priorStablePhase: state.phase,
  };
  return checked({
    state: next,
    effects: [
      { type: "freeze_old_ingress", registration: state.active },
      { type: "freeze_old_dispatch", registration: state.active },
      { type: "quiesce_and_join_old", registration: state.active },
      { type: "verify_full_barrier", registration: state.active },
    ],
  });
}

function phaseFailed(
  state: CodexRegistrationSuccessionState,
  event: Extract<CodexRegistrationSuccessionEvent, { type: "phase_failed" }>,
): CodexRegistrationSuccessionTransition {
  validateSafeErrorCode(event.safeErrorCode);

  if (state.phase === "freezing") {
    const expected =
      state.stage === "barrier_pending"
        ? (["freeze", "barrier"] as const)
        : state.stage === "listener_pending"
          ? (["listener"] as const)
          : (["store"] as const);
    if (!(expected as readonly string[]).includes(event.phase)) {
      return unchanged(state);
    }
    return prepublicationRecovery(state, event.phase, event.safeErrorCode);
  }

  if (state.phase === "prepared_new") {
    const expected =
      state.stage === "publication_arming"
        ? "publication_arm"
        : "registry";
    if (event.phase !== expected) return unchanged(state);
    // Once publication arming begins, an ordinary failure cannot prove that
    // neither the durable arm nor registry write became visible.
    return poisonOffline(
      state,
      event.phase,
      event.safeErrorCode,
      "armed_or_unknown",
    );
  }

  if (state.phase === "published_new" && event.phase === "activation") {
    return poisonOffline(state, event.phase, event.safeErrorCode, "published");
  }

  if (
    state.phase === "active_new" &&
    state.retired !== null &&
    event.phase === "retirement"
  ) {
    return poisonOffline(
      {
        oldRegistration: state.retired,
        newRegistration: state.active,
        priorStablePhase: "active_new",
      },
      event.phase,
      event.safeErrorCode,
      "published",
    );
  }

  if (
    state.phase === "recovery_required" &&
    event.phase === "cleanup"
  ) {
    return poisonOffline(
      state,
      event.phase,
      event.safeErrorCode,
      state.publicationBoundary,
    );
  }

  if (state.phase === "resuming_old" && event.phase === "resume") {
    return poisonOffline(
      state,
      event.phase,
      event.safeErrorCode,
      "not_armed",
    );
  }

  return unchanged(state);
}

function abortSuccession(
  state: CodexRegistrationSuccessionState,
  safeErrorCode: string,
): CodexRegistrationSuccessionTransition {
  validateSafeErrorCode(safeErrorCode);
  if (state.phase === "freezing") {
    return prepublicationRecovery(state, "abort", safeErrorCode);
  }
  if (state.phase === "prepared_new") {
    return poisonOffline(state, "abort", safeErrorCode, "armed_or_unknown");
  }
  if (state.phase === "published_new") {
    return poisonOffline(state, "abort", safeErrorCode, "published");
  }
  if (state.phase === "active_new" && state.retired !== null) {
    return poisonOffline(
      {
        oldRegistration: state.retired,
        newRegistration: state.active,
        priorStablePhase: "active_new",
      },
      "abort",
      safeErrorCode,
      "published",
    );
  }
  return unchanged(state);
}

function restartEvidence(
  state: CodexRegistrationSuccessionState,
  event: Extract<
    CodexRegistrationSuccessionEvent,
    { type: "restart_evidence" }
  >,
): CodexRegistrationSuccessionTransition {
  validateSafeErrorCode(event.safeErrorCode);

  if (state.phase === "freezing") {
    return event.publication === "absent"
      ? prepublicationRecovery(state, "abort", event.safeErrorCode)
      : poisonOffline(
          state,
          "abort",
          event.safeErrorCode,
          publicationBoundaryFromEvidence(event.publication),
        );
  }

  if (state.phase === "prepared_new") {
    return event.publication === "absent"
      ? prepublicationRecovery(
          state,
          state.stage === "publication_arming"
            ? "publication_arm"
            : "registry",
          event.safeErrorCode,
        )
      : poisonOffline(
          state,
          state.stage === "publication_arming"
            ? "publication_arm"
            : "registry",
          event.safeErrorCode,
          publicationBoundaryFromEvidence(event.publication),
        );
  }

  if (state.phase === "published_new") {
    return poisonOffline(state, "activation", event.safeErrorCode, "published");
  }

  if (state.phase === "active_new" && state.retired !== null) {
    return poisonOffline(
      {
        oldRegistration: state.retired,
        newRegistration: state.active,
        priorStablePhase: "active_new",
      },
      "retirement",
      event.safeErrorCode,
      "published",
    );
  }

  if (
    state.phase === "recovery_required" ||
    state.phase === "offline_poisoned"
  ) {
    if (event.publication === "absent") {
      return publicationAbsenceConfirmed(state);
    }
    const observedBoundary = publicationBoundaryFromEvidence(event.publication);
    if (
      state.publicationBoundary === "published" ||
      state.publicationBoundary === observedBoundary
    ) {
      return unchanged(state);
    }
    return poisonOffline(
      state,
      state.failedPhase,
      event.safeErrorCode,
      observedBoundary,
    );
  }

  return unchanged(state);
}

function publicationAbsenceConfirmed(
  state: CodexRegistrationSuccessionState,
): CodexRegistrationSuccessionTransition {
  if (state.phase === "prepared_new") {
    return prepublicationRecovery(
      state,
      state.stage === "publication_arming" ? "publication_arm" : "registry",
      "PUBLICATION_ABSENCE_CONFIRMED",
    );
  }

  if (
    (state.phase === "recovery_required" ||
      state.phase === "offline_poisoned") &&
    state.publicationBoundary === "armed_or_unknown"
  ) {
    return prepublicationRecovery(
      state,
      state.failedPhase,
      "PUBLICATION_ABSENCE_CONFIRMED",
    );
  }

  return unchanged(state);
}

function cleanupConfirmed(
  state: CodexRegistrationSuccessionState,
): CodexRegistrationSuccessionTransition {
  if (state.phase === "active_new" && state.retired !== null) {
    return checked({
      state: { ...state, retired: null },
      effects: [],
    });
  }

  if (state.phase === "recovery_required") {
    if (state.rollback === "forbidden" || state.failedPhase === "resume") {
      return unchanged(state);
    }
    return checked({
      state: {
        phase: "resuming_old",
        oldRegistration: state.oldRegistration,
        newRegistration: state.newRegistration,
        priorStablePhase: state.priorStablePhase,
        failedPhase: state.failedPhase,
        safeErrorCode: state.safeErrorCode,
      },
      effects: [
        {
          type: "resume_old_ingress",
          registration: state.oldRegistration,
        },
        {
          type: "resume_old_dispatch",
          registration: state.oldRegistration,
        },
      ],
    });
  }

  if (state.phase === "offline_poisoned") {
    if (state.rollback === "old_allowed" && state.failedPhase !== "resume") {
      const recoverable: RecoveryRequiredSuccessionState = {
        ...state,
        phase: "recovery_required",
      };
      return cleanupConfirmed(recoverable);
    }
    return checked({
      state: { ...state, phase: "recovery_required" },
      effects: [
        {
          type: "manual_recovery_required",
          registration: state.newRegistration,
          safeErrorCode: state.safeErrorCode,
        },
      ],
    });
  }

  return unchanged(state);
}

function resumeConfirmed(
  state: CodexRegistrationSuccessionState,
): CodexRegistrationSuccessionTransition {
  if (state.phase !== "resuming_old") return unchanged(state);
  const restored =
    state.priorStablePhase === "active_old"
      ? ({ phase: "active_old", active: state.oldRegistration } as const)
      : ({
          phase: "active_new",
          active: state.oldRegistration,
          retired: null,
        } as const);
  return checked({ state: restored, effects: [] });
}

function prepublicationRecovery(
  context: SuccessionContext,
  failedPhase: CodexSuccessionFailurePhase | "abort" | "barrier_busy",
  safeErrorCode: string,
): CodexRegistrationSuccessionTransition {
  validateSafeErrorCode(safeErrorCode);
  return checked({
    state: {
      phase: "recovery_required",
      oldRegistration: context.oldRegistration,
      newRegistration: context.newRegistration,
      priorStablePhase: context.priorStablePhase,
      failedPhase,
      safeErrorCode,
      rollback: "old_allowed",
      publicationBoundary: "not_armed",
    },
    effects: [
      {
        type: "cleanup_unpublished_generation",
        registration: context.newRegistration,
      },
    ],
  });
}

function poisonOffline(
  context: SuccessionContext,
  failedPhase: CodexSuccessionFailurePhase | "abort" | "barrier_busy",
  safeErrorCode: string,
  publicationBoundary: PublicationBoundary,
): CodexRegistrationSuccessionTransition {
  validateSafeErrorCode(safeErrorCode);
  return checked({
    state: {
      phase: "offline_poisoned",
      oldRegistration: context.oldRegistration,
      newRegistration: context.newRegistration,
      priorStablePhase: context.priorStablePhase,
      failedPhase,
      safeErrorCode,
      rollback:
        publicationBoundary === "not_armed" ? "old_allowed" : "forbidden",
      publicationBoundary,
    },
    effects: [
      {
        type: "poison_new_generation",
        registration: context.newRegistration,
      },
      {
        type: "take_registrations_offline",
        oldRegistration: context.oldRegistration,
        newRegistration: context.newRegistration,
      },
      {
        type: "cleanup_poisoned_generations",
        oldRegistration: context.oldRegistration,
        newRegistration: context.newRegistration,
      },
    ],
  });
}

function preparedState(
  stage: PreparedNewSuccessionState["stage"],
  context: SuccessionContext,
): PreparedNewSuccessionState {
  return {
    phase: "prepared_new",
    stage,
    oldRegistration: context.oldRegistration,
    newRegistration: context.newRegistration,
    priorStablePhase: context.priorStablePhase,
  };
}

function contextState(
  phase: "published_new",
  context: SuccessionContext,
): PublishedNewSuccessionState {
  return {
    phase,
    oldRegistration: context.oldRegistration,
    newRegistration: context.newRegistration,
    priorStablePhase: context.priorStablePhase,
  };
}

function successionContext(
  state: CodexRegistrationSuccessionState,
): SuccessionContext | null {
  switch (state.phase) {
    case "freezing":
    case "prepared_new":
    case "published_new":
    case "offline_poisoned":
    case "recovery_required":
    case "resuming_old":
      return state;
    case "active_old":
      return null;
    case "active_new":
      return state.retired === null
        ? null
        : {
            oldRegistration: state.retired,
            newRegistration: state.active,
            priorStablePhase: "active_new",
          };
  }
}

function assertContext(context: SuccessionContext): void {
  validateIdentity(context.oldRegistration, "oldRegistration");
  validateIdentity(context.newRegistration, "newRegistration");
  assertSuccessor(context.oldRegistration, context.newRegistration);
  if (
    context.priorStablePhase !== "active_old" &&
    context.priorStablePhase !== "active_new"
  ) {
    throw new TypeError("Unknown Codex succession prior stable phase.");
  }
}

function assertSuccessor(
  oldRegistration: CodexRegistrationIdentity,
  newRegistration: CodexRegistrationIdentity,
): void {
  if (newRegistration.hostId !== oldRegistration.hostId) {
    throw new RangeError("A Codex succession must remain on the same host.");
  }
  if (newRegistration.alias === oldRegistration.alias) {
    throw new RangeError("The successor Codex alias must differ from the old alias.");
  }
  if (newRegistration.threadId === oldRegistration.threadId) {
    throw new RangeError("The successor Codex thread must differ from the old thread.");
  }
  if (newRegistration.generation === oldRegistration.generation) {
    throw new RangeError(
      "The successor Codex listener generation must be fresh.",
    );
  }
}

function copyAndValidateIdentity(
  identity: CodexRegistrationIdentity,
  label: string,
): CodexRegistrationIdentity {
  const copy = {
    alias: identity.alias,
    threadId: identity.threadId,
    hostId: identity.hostId,
    generation: identity.generation,
  };
  validateIdentity(copy, label);
  return copy;
}

function validateIdentity(
  identity: CodexRegistrationIdentity,
  label: string,
): void {
  validateToken(identity.alias, `${label}.alias`);
  validateToken(identity.threadId, `${label}.threadId`);
  validateToken(identity.hostId, `${label}.hostId`);
  assertCodexRegistrationGeneration(
    identity.generation,
    `${label}.generation`,
  );
}

function validateToken(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string.`);
  }
}

function validateSafeErrorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new TypeError("safeErrorCode must be a bounded uppercase token.");
  }
}

function publicationBoundaryFromEvidence(
  evidence: "absent" | "armed" | "published" | "unknown",
): PublicationBoundary {
  if (evidence === "absent") return "not_armed";
  return evidence === "published" ? "published" : "armed_or_unknown";
}

function checked(
  transition: CodexRegistrationSuccessionTransition,
): CodexRegistrationSuccessionTransition {
  assertCodexRegistrationSuccessionInvariant(transition.state);
  return transition;
}

function unchanged(
  state: CodexRegistrationSuccessionState,
): CodexRegistrationSuccessionTransition {
  return { state, effects: [] };
}
