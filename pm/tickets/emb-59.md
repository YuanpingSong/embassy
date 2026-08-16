---
id: emb-59
title: Bounded Codex write probe (49B): records evidence, unlocks nothing
kind: sensitive
size: 5
status: dispatched
release: v1.6
updated: 2026-08-16
---

## Binding

**Founder ruling (2026-08-16)**: the durable-artifact question was put to the founder and answered — "acceptable." One archived probe thread per Codex version may remain in history. Token consumption for probing: "immaterial" (founder, same date).

**Why**: a passing bounded write probe is the only evidence class that can legitimately cover turn/start authority (design law 3). This ticket produces and records that evidence — and deliberately does not unlock anything.

**Promises** (from emb-49 report §§1-6, which are the spec): thread/start against the Desktop App Server through the existing attach-only proxy; six machine-checked isolation assertions (fresh id, owned 0700 cwd, fence declared, fence observed, cwd unchanged, cleanup confirmed); model pin CODEX_PROBE_MODEL_PREFERENCE=["gpt-5.6-luna"] + effort minimal as reviewed source constants, verified via model/rerouted (pin requested is not pin honored); rate-limit courtesy check before spending; one attempt per (version, endpointGeneration); never-throw discipline (boot catch at service.ts:966 kills the whole broker); failures are safe codes + alerts, never failed probes; token cost recorded from thread/tokenUsage/updated.

**Budgets**: size 5, sensitive (first creating method in the allowlist: 6→9 — SECURITY.md-relevant); concepts: zero beyond emb-58's. Tests: coverage + adversarial fixtures (sensitive default).

**Non-goals**: no authority change (emb-60); nothing runs before founder ruling on the artifact question; resolve report unknowns #1/#2/#5/#7 (offline schema generation) before coding.

---

## Analysis-phase findings + pre-edit contest and rulings (2026-08-16)

**Engineer findings (offline schema generation, zero tree edits, zero tokens):** unknowns #1/#2/#5/#7
RESOLVED — pin shape is thread/start model + allowProviderModelFallback=false, turn/start repeats
model + effort=minimal (ThreadStartParams has no effort field); thread/start needs no new initialize
capability; NO journal action in this ticket (authority-transition activity belongs in emb-60 —
accepted, consistent with downgrade discipline); exact sandbox/approval wire shapes with the
permissions-conflict and collaborationMode-override cautions; correlation field spellings corrected.
Fence correction accepted: the probe-bearing connector must request item/started (ordinary routes
keep their opt-out) or interrupted tools could evade the zero-tool-activity assertion.

**Ruling 1 — allowlist 6→10 AUTHORIZED** (thread/start, thread/archive, model/list,
account/rateLimits/read). The design report said 9; the courtesy read makes it 10 and the courtesy
read stays — it is the founder's token-thrift stance applied to the user's quota, and it is a read
(grants nothing). Ledger notes the count correction.

**Ruling 2 — rate-limit predicate APPROVED as proposed**, as reviewed source constants beside the
model pin: decline before thread creation on any reached flag, spendControlReached, individual
remainingPercent<=5, or primary/secondary usedPercent>=95; prefer the codex bucket; new safe code
CODEX_WRITE_PROBE_RATE_LIMIT_CONSTRAINED (pattern-valid, alert-not-failed-probe discipline).

**Ruling 3 — option (a) ACCEPTED, with a reporting duty**: token cost is captured in-memory by the
probe runner and asserted in tests and live proof; no new persisted/public concept in this
zero-authority ticket. The promise wording is amended from "recorded" to: the measured token count
MUST appear in the completion report and will be surfaced to the founder before emb-60 lands.
Durable cost observability, if ever wanted, is its own priced ticket.

Budget unchanged. Implementation begins when emb-52 lands and the tree is clean.

## Cardinality ruling (2026-08-16) — PM interpretation of a founder sentence, flagged for morning ratification

**Contest (main)**: the founder ruling's wording ("one archived probe thread per Codex version") and
the specified bound (one attempt per (version, endpointGeneration) per broker process) are different
cardinalities — ordinary broker/App Server restarts can leave multiple archives per version, and a
literal one-per-version lifetime cap needs new persistence + history enumeration, outside budget and
against the freshness rule.

**Ruling: main's recommendation ADOPTED.** The founder sentence approves the artifact class, not a
lifetime cardinality guarantee — read with its own rationale ("token consumption immaterial, bias
toward building and shipping if no other issues"), the intent is acceptance of small durable residue,
not a negotiated cap. The shipped bound is stated honestly: **at most one probe attempt per
(version, endpointGeneration) per broker process; every created probe thread is archived and its
loaded-set cleanup confirmed; the persisted attestation + generation binding + TTL make boot-time
re-probes the exception, not the rule.** The completion report must state the observed archive count
from the live proof. **This interpretation goes to the founder in the morning summary — if a hard
one-per-version cap is wanted, that is a repriced follow-up with a different persistence design.**

## Concurrent-seam partition (2026-08-16, PM-brokered)

main (emb-59) reserves: codex-app-server.ts entirely; in providers.ts only imports/constants for
the write-probe result, LocalCodexGatewayProvider compatibility-probe state,
runCompatibilityProbes/runCompatibilityProbesFor, and an owned-cwd helper adjacent; in service.ts
only the GatewayProviderAdapter compatibility-probe interface/context and
runAutomaticCompatibilityProbesLocked. swe3 (emb-62) owns: route recovery, endpoint-transition,
dispatch, and delivery-settlement neighborhoods. Neither enters the other's symbols; any collision
stops and contests through the PM. Landing order decided by the PM at handoff time.

## Budget contest and rulings (2026-08-16, contest #11)

**Contest**: the design's ~520-source-line estimate is unattainable without dropping promises —
typechecking skeleton is +1,019/-7 (connector +667 vs ~260 predicted), with the delta itemized as
required behavior (create/turn correlation, preflight pin/rate parsing, fail-closed fences, cleanup
proofs, ambiguous-create handling, owned-cwd attestation) that the offline schema resolution and
post-design PM rulings made concrete.

**Ruling 1 — budget REVISED, promises intact.** The estimate was made before ground truth; the
promise set is what the founder ordered and appetite strips what a promise doesn't need, never what
it does. Ticket stays size 5 (5 = negotiated subsystem budget); the negotiated line budget becomes
**smallest reviewed implementation, target ≤1,050 source lines post-diet**, diet after correctness,
SLICE READY reports actual against this number. Estimation lesson recorded: line estimates made
before schema/ruling ground truth carry a multiplier — future design-pass estimates get re-priced
at implementation dispatch.

**Ruling 2 — cardinality bound APPROVED as proposed**: fixed 16-tuple process cap on the one-shot
(version, generation) maps, mirroring compatibility evidence capacity; NEVER evict (eviction would
permit a duplicate probe — the one-shot property is load-bearing); the 17th distinct tuple returns
a frozen THREAD_SETUP failure without creating a thread. No persisted or public concept.

**Acknowledged in-scope fixes**: accept schema-required non-null collaborationMode in
thread/settings/updated; preserve THREAD_SETUP (not TOOL_ACTIVITY) when mkdtemp never created a cwd.
